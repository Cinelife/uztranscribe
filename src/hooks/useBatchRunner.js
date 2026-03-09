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
import { classifySegments }     from '../lib/audioClassifier.js'

function fmt(ms) {
  if (ms < 1000) return `${ms}мс`
  return `${(ms/1000).toFixed(1)}с`
}

// v12.5.4: maxOutputTokens label for log
function maxOutLabel(chunkSec) {
  if (chunkSec >= 45) return '4096'
  if (chunkSec >= 25) return '2048'
  return '1024'
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
    dedupWindow    = 12,
    subTiming      = 'vad',
    elKey, gmKey, orKey, orModel,
    gmModel        = 'gemini-2.0-flash',
    voskReady, voskModelRef,
    concurrency    = 8,
    // v12.5.4 experimental
    classifierMode  = 'off',   // 'off'|'hint'|'full'
    showMusicMarker = false,
    useRmsTiming    = false,
    useFFT          = false,
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

    const batchT0  = performance.now()
    const newSrtMap = {}

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file = files[fi]

      try {
        addLog('', '')
        addLog(`▶ [${fi+1}/${files.length}] ${file.name} (${(file.size/1e6).toFixed(1)} MB)`, 'ok')

        // ── v12.5.4: Лог настроек ────────────────────────────────────────────
        const isGmPath = prov === 'gm' || prov === 'bo' || prov === 'or'
        if (isGmPath) {
          addLog(
            `⚙ chunkSec:${chunkSec} | concurrency:${concurrency} | maxOut:${maxOutLabel(chunkSec)} | dedup:${dedupWindow} | lang:${lang}`,
            'dm'
          )
          addLog(
            `⚙ classifier:${classifierMode} | ♪:${showMusicMarker?'вкл':'выкл'} | rms-timing:${useRmsTiming?'вкл':'выкл'} | fft:${useFFT&&useRmsTiming?'вкл':'выкл'}`,
            'dm'
          )
        }

        const fileT0 = performance.now()

        // ── Кешируем AudioBuffer один раз ────────────────────────────────────
        let audioBufCached = null
        try {
          audioBufCached = await decodeAudio(file)
          addLog(`  Audio: ${audioBufCached.duration.toFixed(1)}с декодировано`, 'dm')
        } catch (_) {
          // Fallback: Audio element for duration only
          try {
            const url = URL.createObjectURL(file)
            const audio = new Audio(url)
            await new Promise(r => { audio.onloadedmetadata = r; audio.onerror = r })
            URL.revokeObjectURL(url)
          } catch (_) {}
        }

        // ── ElevenLabs ───────────────────────────────────────────────────────
        if (prov === 'el' || prov === 'bo') {
          addLog(`  ElevenLabs...`, 'in')
          const segs = await transcribeEL(file, elKey, lang, maxChars, null, addLog, p => setProgressText(p), stopFlagRef)
          const srtName = file.name.replace(/\.[^.]+$/, '') + '_el.srt'
          const content = buildSrt(segs)
          downloadSrt(content, srtName)
          newSrtMap[srtName] = content
          done++
          setProgress(done / totalJobs * 100)
          addLog(`  ✓ ${srtName} — ${segs.length} сег`, 'ok')
        }

        // ── Gemini / OpenRouter ───────────────────────────────────────────────
        if ((prov === 'gm' || prov === 'or' || prov === 'bo') && !stopFlagRef.current) {
          const isSilero = timingMode === 'silero'
          const isV12    = timingMode === 'v12'
          const useDispatcher = isSilero || isV12

          if (useDispatcher) {
            // ── Phase 1: Segmentation ─────────────────────────────────────────
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

            // ── v12.5.4: Audio Classifier ─────────────────────────────────────
            let classMap = null
            if (classifierMode !== 'off' && audioBufCached) {
              const classT0   = performance.now()
              const allSegs   = chunks.flatMap(c => c.segments)
              classMap        = classifySegments(audioBufCached, allSegs)
              const classMs   = Math.round(performance.now() - classT0)
              const musicCount  = [...classMap.values()].filter(v => v.type === 'music').length
              const speechCount = [...classMap.values()].filter(v => v.type === 'speech').length
              const mixedCount  = [...classMap.values()].filter(v => v.type === 'mixed').length
              const silentCount = [...classMap.values()].filter(v => v.type === 'silent').length
              addLog(
                `  Classifier ✓ — speech:${speechCount} music:${musicCount} mixed:${mixedCount} silent:${silentCount} | ⏱ ${fmt(classMs)}`,
                'dm'
              )
            }

            // ── Phase 2: Dispatch ─────────────────────────────────────────────
            addLog(`  Phase 2 — Dispatcher (×${concurrency} параллельно)...`, 'gm-cl')
            const p2T0    = performance.now()
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
              gmModel,
              classMap,
              classifierMode,
            })
            const p2Ms = Math.round(performance.now() - p2T0)
            addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Ms)}`, 'ok')

            // ── Phase 3: Assemble ─────────────────────────────────────────────
            const p3T0 = performance.now()
            addLog(`  Phase 3 — Assembler...`, 'pu')
            for (const [fid, endTime] of fallbackEnds) {
              const entry = flagMap.get(fid)
              if (entry) entry.end = endTime
            }
            const srtContent = assemble(
              flagMap, textMap,
              maxChars, mergeGap, mergeMode, dedupWindow,
              isSilero ? subTiming : 'vad',
              audioBufCached,   // v12.5.4
              useRmsTiming,     // v12.5.4
              useFFT,           // v12.5.4
              showMusicMarker   // v12.5.4
            )
            const p3Ms = Math.round(performance.now() - p3T0)
            addLog(`  Phase 3 ✓ | ⏱ ${fmt(p3Ms)}`, 'ok')

            const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            downloadSrt(srtContent, srtName)
            newSrtMap[srtName] = srtContent
            done++
            setProgress(done / totalJobs * 100)
            const segCount = srtContent.split('\n\n').filter(b => b.trim()).length
            const fileTotalMs = Math.round(performance.now() - fileT0)
            addLog(`  ✓ ${srtName} — ${segCount} сег | ⏱ файл: ${fmt(fileTotalMs)}`, 'ok')

          } else {
            // ── Smart Silence / Vosk legacy path ─────────────────────────────
            let preChunks = null
            if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
              addLog(`  Vosk Pass 1...`, 'pu')
              setVoskVisible(true)
              preChunks = await getVoskBoundaries(
                file, voskModelRef.current, addLog,
                (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                () => setVoskVisible(false),
                stopFlagRef
              )
              setVoskVisible(false)
            }

            addLog(`  Gemini Smart Silence...`, 'gm-cl')
            const segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars, preChunks, addLog, p => setProgressText(p), stopFlagRef)
            const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const content = buildSrt(segs)
            downloadSrt(content, srtName)
            newSrtMap[srtName] = content
            done++
            setProgress(done / totalJobs * 100)
            addLog(`  ✓ ${srtName} — ${segs.length} сег`, 'ok')
          }
        }

        // OpenRouter path
        if (prov === 'or' && !stopFlagRef.current) {
          addLog(`  OpenRouter (${orModel})...`, 'in')
          const segs = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars, addLog, p => setProgressText(p), stopFlagRef)
          const srtName = file.name.replace(/\.[^.]+$/, '') + '_or.srt'
          const content = buildSrt(segs)
          downloadSrt(content, srtName)
          newSrtMap[srtName] = content
          done++
          setProgress(done / totalJobs * 100)
          addLog(`  ✓ ${srtName} — ${segs.length} сег`, 'ok')
        }

      } catch (e) {
        addLog(`  ✗ ОШИБКА: ${e.message}`, 'er')
        done++
        setProgress(done / totalJobs * 100)
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
