import { useRef, useState, useCallback } from 'react'
import { transcribeEL }         from '../lib/elevenlabs.js'
import { transcribeGemini }     from '../lib/gemini.js'
import { transcribeOpenRouter } from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio, sleep }   from '../lib/audioUtils.js'
import { getVoskBoundaries }    from '../lib/vosk.js'
import { segmentAudio }         from '../lib/segmenter.js'
import { segmentAudioSilero }   from '../lib/sileroVad.js'
import { dispatchChunks }       from '../lib/dispatcher.js'
import { assemble }             from '../lib/assembler.js'

function fmt(ms) {
  if (ms < 1000) return `${ms}мс`
  return `${(ms/1000).toFixed(1)}с`
}

export function useBatchRunner() {
  const [log,          setLog]          = useState([])
  const [progress,     setProgress]     = useState(0)
  const [progressText, setProgressText] = useState('Готов к запуску')
  const [statusText,   setStatusText]   = useState('')
  const [voskVisible,  setVoskVisible]  = useState(false)
  const [voskPct,      setVoskPct]      = useState(0)
  const [voskText,     setVoskText]     = useState('')
  const [running,      setRunning]      = useState(false)
  const [lastSrtMap,   setLastSrtMap]   = useState({})

  const stopFlagRef = useRef(false)
  const logIdRef    = useRef(0)

  const addLog = useCallback((msg, cls = '') => {
    setLog(prev => [...prev, { id: logIdRef.current++, msg, cls }])
  }, [])

  const clearLog = useCallback(() => {
    setLog([{ id: logIdRef.current++, msg: '// Лог очищен', cls: 'dm' }])
  }, [])

  const startBatch = useCallback(async ({
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode, timingMode,
    dedupWindow = 12, subTiming = 'vad',
    elKey, gmKey, orKey, orModel, gmModel = 'gemini-2.0-flash',
    voskReady, voskModelRef,
    concurrency = 8
  }) => {
    if (!files.length) { alert('Добавь файлы'); return }
    if (prov === 'el' && !elKey) { alert('Нет ElevenLabs API Key'); return }
    if ((prov === 'gm' || prov === 'bo') && !gmKey) { alert('Нет Gemini API Key'); return }
    if ((prov === 'or' || prov === 'bo') && !orKey) { alert('Нет OpenRouter API Key'); return }

    stopFlagRef.current = false
    setRunning(true)
    setLog([])
    setProgress(0)
    setVoskVisible(false)

    const totalJobs   = files.length * (prov === 'bo' ? 2 : 1)
    let done = 0
    const newSrtMap   = {}

    const isV12    = (prov === 'gm' || prov === 'bo') && timingMode === 'v12'
    const isSilero = (prov === 'gm' || prov === 'bo') && timingMode === 'silero'

    const batchT0 = performance.now()

    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`Файлов: ${files.length} | Провайдер: ${prov.toUpperCase()} | Язык: ${lang}`, 'in')
    addLog(`Символов: ${maxChars} | Чанк: ${chunkSec}с | Concurrency: ${concurrency}`, 'dm')
    if (isSilero) addLog(`Silero VAD ✓`, 'pu')
    else if (isV12) addLog(`v12 Flag-Segmenter ✓`, 'pu')
    else if (timingMode === 'vosk' && voskReady) addLog(`Vosk 2-pass ✓`, 'ok')
    addLog('══════════════════════════════════════════════', 'dm')

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file      = files[fi]
      const providers = prov === 'bo' ? ['el', 'gm'] : [prov]

      for (const p of providers) {
        if (stopFlagRef.current) break
        const provName = p==='el'?'ElevenLabs':p==='gm'?'Gemini':'OpenRouter'
        const fileT0   = performance.now()

        // Длительность файла — для всех провайдеров
        let fileDurStr = ''
        let audioBufCached = null
        try {
          // Быстрый способ — Audio элемент (не требует полного декодирования)
          const url = URL.createObjectURL(file)
          const totalSec = await new Promise((res, rej) => {
            const a = new Audio()
            a.onloadedmetadata = () => { URL.revokeObjectURL(url); res(a.duration) }
            a.onerror = rej
            a.src = url
          })
          const mm = Math.floor(totalSec / 60)
          const ss = Math.floor(totalSec % 60).toString().padStart(2, '0')
          fileDurStr = ` (${mm}:${ss})`
        } catch (_) {}

        addLog(``, 'dm')
        addLog(`▶ [${fi+1}/${files.length}] ${file.name}${fileDurStr}  (${provName})`, 'in')

        try {
          let segs = []

          if (p === 'el') {
            const t0 = performance.now()
            segs = await transcribeEL(file, elKey, lang, maxChars, addLog)
            addLog(`  ⏱ ElevenLabs: ${fmt(Math.round(performance.now()-t0))}`, 'pu')

          } else if (p === 'gm') {

            if (isV12 || isSilero) {
              // ── Phase 1: Segment ──────────────────────────────────────────
              const segLabel = isSilero ? 'Silero VAD' : 'v12 Segmenter'
              addLog(`  Phase 1 — ${segLabel}...`, 'pu')
              setVoskVisible(true)
              const p1T0 = performance.now()

              const { flagMap, chunks, totalMicroSegs } = isSilero
                ? await segmentAudioSilero(file, chunkSec, minPause,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') }, addLog)
                : await segmentAudio(file, chunkSec, minPause,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt) })
              setVoskVisible(false)
              const p1Ms = Math.round(performance.now() - p1T0)
              addLog(`  Phase 1 ✓ — ${totalMicroSegs} микро-сег → ${chunks.length} чанков | ⏱ ${fmt(p1Ms)}`, 'ok')

              // ── Phase 2: Dispatch ─────────────────────────────────────────
              addLog(`  Phase 2 — Dispatcher (×${concurrency} параллельно)...`, 'gm-cl')
              const p2T0     = performance.now()
              const audioBuf = audioBufCached || await decodeAudio(file)

              const { allText: textMap, fallbackEnds } = await dispatchChunks({
                audioBuf, chunks,
                apiKey: gmKey, lang, chunkSec, dedupWindow,
                onLog: addLog,
                onProgress: (pct, txt) => {
                  setProgress(((fi * totalJobs) + done + pct/100) / totalJobs * 100)
                  setProgressText(txt)
                },
                stopFlagRef,
                concurrency,
                gmModel
              })
              const p2Ms = Math.round(performance.now() - p2T0)
              addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Ms)}`, 'ok')

              // ── Phase 3: Assemble ─────────────────────────────────────────
              const p3T0 = performance.now()
              addLog(`  Phase 3 — Assembler...`, 'pu')
              for (const [fid, endTime] of fallbackEnds) {
                const entry = flagMap.get(fid)
                if (entry) entry.end = endTime
              }
              const srtContent = assemble(flagMap, textMap, maxChars, mergeGap, mergeMode, dedupWindow, isSilero ? subTiming : 'vad')
              const segCount   = (srtContent.match(/^\d+$/mg) || []).length
              const p3Ms       = Math.round(performance.now() - p3T0)
              addLog(`  Phase 3 ✓ — ${segCount} сегментов | ⏱ ${fmt(p3Ms)}`, 'ok')

              const totalFileMs = Math.round(performance.now() - fileT0)
              addLog(`  ⏱ ИТОГО файл: Phase1=${fmt(p1Ms)} + Phase2=${fmt(p2Ms)} + Phase3=${fmt(p3Ms)} = ${fmt(totalFileMs)}`, 'pu')

              segs = parseSrt(srtContent)

            } else {
              // ── Smart / Vosk path ─────────────────────────────────────────
              let preChunks = null
              if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
                addLog(`  Pass 1 — Vosk...`, 'pu')
                setVoskVisible(true)
                const vT0 = performance.now()
                try {
                  preChunks = await getVoskBoundaries(
                    file, voskModelRef.current, addLog,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                    () => setVoskVisible(false),
                    stopFlagRef
                  )
                  addLog(`  Vosk ✓ | ⏱ ${fmt(Math.round(performance.now()-vT0))}`, 'ok')
                } catch (e) {
                  addLog(`  ⚠ Vosk: ${e.message}`, 'wa')
                  setVoskVisible(false)
                }
              }
              const gmT0 = performance.now()
              segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars,
                preChunks, addLog, t => setProgressText(t), stopFlagRef)
              addLog(`  ⏱ Gemini (smart): ${fmt(Math.round(performance.now()-gmT0))}`, 'pu')
            }

          } else if (p === 'or') {
            let preChunks = null
            if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
              setVoskVisible(true)
              try {
                preChunks = await getVoskBoundaries(
                  file, voskModelRef.current, addLog,
                  (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                  () => setVoskVisible(false), stopFlagRef
                )
              } catch (_) { setVoskVisible(false) }
            }
            const orT0 = performance.now()
            segs = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars,
              preChunks, addLog, t => setProgressText(t), stopFlagRef)
            addLog(`  ⏱ OpenRouter: ${fmt(Math.round(performance.now()-orT0))}`, 'pu')
          }

          // Clamp overlaps
          segs.sort((a, b) => a.start - b.start)
          for (let i = 0; i < segs.length - 1; i++) {
            if (segs[i].end > segs[i+1].start + 0.05)
              segs[i].end = Math.max(segs[i].start + 0.1, segs[i+1].start - 0.05)
          }

          const suffix  = p==='el'?'_el':p==='or'?'_or':'_gm'
          const srtName = file.name.replace(/\.[^.]+$/, '') + suffix + '.srt'
          const content = buildSrt(segs)
          downloadSrt(content, srtName)
          newSrtMap[srtName] = content
          done++
          setProgress(done / totalJobs * 100)

          const fileTotalMs = Math.round(performance.now() - fileT0)
          addLog(`  ✓ ${srtName} — ${segs.length} сег | ⏱ файл: ${fmt(fileTotalMs)}`, 'ok')

        } catch (e) {
          addLog(`  ✗ ОШИБКА: ${e.message}`, 'er')
          done++
          setProgress(done / totalJobs * 100)
        }
      }
    }

    const batchMs = Math.round(performance.now() - batchT0)
    setLastSrtMap(prev => ({ ...prev, ...newSrtMap }))
    setProgress(100)
    setStatusText(`✓ ${done}/${totalJobs} файлов`)
    addLog('', '')
    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`  ГОТОВО: ${done}/${totalJobs} | ⏱ Общее время: ${fmt(batchMs)}`, done===totalJobs?'ok':'wa')
    addLog('  SRT → папка Downloads', 'ok')
    if (done) addLog('  💡 Можно перевести результат ниже ↓', 'pu')
    addLog('══════════════════════════════════════════════', 'dm')
    setRunning(false)
    setVoskVisible(false)
  }, [addLog])

  const stopBatch = useCallback(() => {
    stopFlagRef.current = true
    setStatusText('⏹ Остановлено')
    setRunning(false)
    setVoskVisible(false)
  }, [])

  return {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, startBatch, stopBatch,
    lastSrtMap
  }
}

function parseSrt(srt) {
  const segs = []
  for (const block of srt.trim().split('\n\n')) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue
    const tc = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/)
    if (!tc) continue
    const toS = t => { const [h,m,s,ms] = t.split(/[:,]/); return +h*3600 + +m*60 + +s + +ms/1000 }
    segs.push({ start: toS(tc[1]), end: toS(tc[2]), text: lines.slice(2).join(' ') })
  }
  return segs
}
