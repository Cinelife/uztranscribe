import { useRef, useState, useCallback } from 'react'
import { transcribeEL }        from '../lib/elevenlabs.js'
import { transcribeGemini }    from '../lib/gemini.js'
import { transcribeOpenRouter } from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio, sleep }  from '../lib/audioUtils.js'
import { getVoskBoundaries }   from '../lib/vosk.js'
import { segmentAudio }        from '../lib/segmenter.js'
import { segmentAudioSilero }  from '../lib/sileroVad.js'
import { dispatchChunks }      from '../lib/dispatcher.js'
import { assemble }            from '../lib/assembler.js'

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
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode, subTiming = 'vad', timingMode,
    elKey, gmKey, orKey, orModel,
    voskReady, voskModelRef
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

    const totalJobs = files.length * (prov === 'bo' ? 2 : 1)
    let done = 0
    const newSrtMap = {}

    const isV12 = (prov === 'gm' || prov === 'bo') && timingMode === 'v12'
    // silero uses same pipeline as v12

    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`Файлов: ${files.length} | Провайдер: ${prov.toUpperCase()} | Язык: ${lang}`, 'in')
    addLog(`Символов на строку: ${maxChars} | Чанк: ${chunkSec}с`, 'dm')
    if (timingMode === 'silero')
      addLog(`Silero VAD: ✓ активен (нейросеть → флаги → Gemini)`, 'pu')
    else if (isV12)
      addLog(`v12 Flag-Segmenter: ✓ активен (OfflineAudioContext → флаги → Gemini)`, 'pu')
    else if (timingMode === 'vosk' && voskReady)
      addLog(`Vosk 2-pass: ✓ активен`, 'ok')
    addLog('══════════════════════════════════════════════', 'dm')

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file      = files[fi]
      const providers = prov === 'bo' ? ['el', 'gm'] : [prov]

      for (const p of providers) {
        if (stopFlagRef.current) break
        const provName = p==='el'?'ElevenLabs':p==='gm'?'Gemini':'OpenRouter'
        addLog(`[${fi+1}/${files.length}] ${file.name} (${provName})`, 'in')

        try {
          let segs = []

          if (p === 'el') {
            segs = await transcribeEL(file, elKey, lang, maxChars, addLog)

          } else if (p === 'gm') {

            const isSilero = timingMode === 'silero'
            if (isV12 || isSilero) {
              // ── v12 / Silero pipeline ────────────────────────────────────

              // Phase 1: Segment
              const segLabel = isSilero ? 'Silero VAD' : 'Segmenter'
              addLog(`  Phase 1 — ${segLabel}: анализ аудио...`, 'pu')
              setVoskVisible(true)

              const { flagMap, chunks, totalMicroSegs } = isSilero
                ? await segmentAudioSilero(file, chunkSec, minPause,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') },
                    addLog)
                : await segmentAudio(file, chunkSec, minPause,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt) }
                  )
              setVoskVisible(false)
              addLog(`  Phase 1 ✓ — ${totalMicroSegs} микро-сег → ${chunks.length} чанков`, 'ok')

              // Phase 2: Dispatch
              addLog(`  Phase 2 — Dispatcher: ${chunks.length} запросов...`, 'gm-cl')
              const audioBuf = await decodeAudio(file)

              const { allText: textMap, fallbackEnds } = await dispatchChunks({
                audioBuf, chunks,
                apiKey: gmKey, lang, chunkSec,
                onLog: addLog,
                onProgress: (pct, txt) => {
                  setProgress(((fi * totalJobs) + done + pct/100) / totalJobs * 100)
                  setProgressText(txt)
                },
                stopFlagRef
              })

              // Phase 3: Assemble
              addLog(`  Phase 3 — Assembler...`, 'pu')
              // Apply fallback end times to flagMap
              for (const [fid, endTime] of fallbackEnds) {
                const entry = flagMap.get(fid)
                if (entry) entry.end = endTime
              }
              const srtContent = assemble(flagMap, textMap, maxChars, mergeGap, mergeMode, subTiming)
              const segCount   = (srtContent.match(/^\d+$/mg) || []).length
              addLog(`  Phase 3 ✓ — ${segCount} сегментов`, 'ok')

              // Convert SRT → segs for unified download below
              segs = parseSrt(srtContent)

            } else {
              // ── v10 path ──────────────────────────────────────────────────
              let preChunks = null
              if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
                addLog(`  Pass 1 — Vosk: ищем границы...`, 'pu')
                setVoskVisible(true)
                try {
                  preChunks = await getVoskBoundaries(
                    file, voskModelRef.current, addLog,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                    () => setVoskVisible(false),
                    stopFlagRef
                  )
                } catch (e) {
                  addLog(`  ⚠ Vosk: ${e.message}`, 'wa')
                  setVoskVisible(false)
                }
              }
              segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars,
                preChunks, addLog, t => setProgressText(t), stopFlagRef)
            }

          } else if (p === 'or') {
            let preChunks = null
            if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
              setVoskVisible(true)
              try {
                preChunks = await getVoskBoundaries(
                  file, voskModelRef.current, addLog,
                  (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                  () => setVoskVisible(false),
                  stopFlagRef
                )
              } catch (_) { setVoskVisible(false) }
            }
            segs = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars,
              preChunks, addLog, t => setProgressText(t), stopFlagRef)
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
          addLog(`  ✓ ${srtName} (${segs.length} сегментов)`, 'ok')

        } catch (e) {
          addLog(`  ✗ ОШИБКА: ${e.message}`, 'er')
          done++
          setProgress(done / totalJobs * 100)
        }
      }
    }

    setLastSrtMap(prev => ({ ...prev, ...newSrtMap }))
    setProgress(100)
    setStatusText(`✓ ${done}/${totalJobs} файлов`)
    addLog('', '')
    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`  ГОТОВО: ${done}/${totalJobs}`, done===totalJobs?'ok':'wa')
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
