/**
 * useBatchRunner.js — v12.5
 * Изменения: принимает concurrency, передаёт в dispatchChunks
 */
import { useState, useRef, useCallback } from 'react'
import { transcribeEL }           from '../lib/elevenlabs.js'
import { transcribeGemini }       from '../lib/gemini.js'
import { transcribeOR }           from '../lib/openrouter.js'
import { dispatchChunks }         from '../lib/dispatcher.js'
import { segmentAudio }           from '../lib/segmenter.js'
import { segmentAudioSilero }     from '../lib/sileroVad.js'
import { assemble }               from '../lib/assembler.js'
import { downloadSrt }            from '../lib/srtUtils.js'
import { decodeAudio }            from '../lib/audioUtils.js'

export function useBatchRunner({
  elKey, gmKey, orKey,
  prov, lang, chunkSec, maxChars, minPause,
  mergeGap, mergeMode, dedupWindow, subTiming, timingMode,
  orModel, voskReady, voskModelRef,
  concurrency = 8    // v12.5: параметр параллельности
}) {
  const [log,          setLog]          = useState([])
  const [progress,     setProgress]     = useState(0)
  const [progressText, setProgressText] = useState('')
  const [statusText,   setStatusText]   = useState('')
  const [running,      setRunning]      = useState(false)
  const [lastSrtMap,   setLastSrtMap]   = useState({})
  const [files,        setFiles]        = useState([])
  const [fileStatuses, setFileStatuses] = useState({})
  const [voskVisible,  setVoskVisible]  = useState(false)
  const [voskPct,      setVoskPct]      = useState(0)
  const [voskText,     setVoskText]     = useState('')

  const stopFlagRef = useRef(false)

  const addLog = useCallback((msg, cls = '') => {
    setLog(prev => [...prev, { msg, cls, ts: Date.now() }])
  }, [])

  const clearLog = useCallback(() => setLog([]), [])

  const stopBatch = useCallback(() => {
    stopFlagRef.current = true
    setRunning(false)
    setStatusText('⏹ Остановлено')
  }, [])

  const handleStart = useCallback(async () => {
    if (!files.length) { alert('Добавь файлы'); return }
    if ((prov === 'el' || prov === 'bo') && !elKey) { alert('Нужен ElevenLabs ключ'); return }
    if ((prov === 'gm' || prov === 'bo') && !gmKey) { alert('Нужен Gemini ключ'); return }
    if (prov === 'or' && !orKey) { alert('Нужен OpenRouter ключ'); return }

    stopFlagRef.current = false
    setRunning(true)
    setProgress(0)
    setLog([])
    setStatusText('🚀 Запуск...')

    const isV12    = (prov === 'gm' || prov === 'bo') && timingMode === 'v12'
    const isSilero = (prov === 'gm' || prov === 'bo') && timingMode === 'silero'
    const totalJobs = files.length * (prov === 'bo' ? 2 : 1)
    let done = 0
    const newSrtMap = {}

    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`Файлов: ${files.length} | Провайдер: ${prov.toUpperCase()} | Язык: ${lang}`, 'in')
    addLog(`Символов: ${maxChars} | Чанк: ${chunkSec}с | Concurrency: ${concurrency}`, 'dm')  // v12.5
    if (isSilero) addLog(`Silero VAD: ✓ активен`, 'pu')
    else if (isV12) addLog(`v12 Flag-Segmenter: ✓ активен`, 'pu')
    addLog('══════════════════════════════════════════════', 'dm')

    try {
      for (let fi = 0; fi < files.length; fi++) {
        if (stopFlagRef.current) break
        const file      = files[fi]
        const providers = prov === 'bo' ? ['el', 'gm'] : [prov]

        for (const p of providers) {
          if (stopFlagRef.current) break
          const provName = p==='el'?'ElevenLabs':p==='gm'?'Gemini':'OpenRouter'
          addLog(`[${fi+1}/${files.length}] ${file.name} (${provName})`, 'in')

          setFileStatuses(prev => ({ ...prev, [`${fi}_${p}`]: 'running' }))

          try {
            let segs = []

            if (p === 'el') {
              segs = await transcribeEL(file, elKey, lang, maxChars, addLog)

            } else if (p === 'gm') {

              if (isV12 || isSilero) {
                // ── v12 / Silero pipeline ─────────────────────────────────
                const segLabel = isSilero ? 'Silero VAD' : 'Segmenter'
                addLog(`  Phase 1 — ${segLabel}: анализ аудио...`, 'pu')
                setVoskVisible(true)

                const { flagMap, chunks, totalMicroSegs } = isSilero
                  ? await segmentAudioSilero(file, chunkSec, minPause,
                      (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') },
                      addLog)
                  : await segmentAudio(file, chunkSec, minPause,
                      (pct, txt) => { setVoskPct(pct); setVoskText(txt) })

                setVoskVisible(false)
                addLog(`  Phase 1 ✓ — ${totalMicroSegs} микро-сег → ${chunks.length} чанков`, 'ok')

                // Phase 2: Dispatch — v12.5 передаём concurrency
                addLog(`  Phase 2 — Dispatcher: ${chunks.length} запросов (x${concurrency} параллельно)...`, 'gm-cl')
                const audioBuf = await decodeAudio(file)

                const { allText: textMap, fallbackEnds } = await dispatchChunks({
                  audioBuf, chunks,
                  apiKey: gmKey, lang, chunkSec, dedupWindow,
                  onLog: addLog,
                  onProgress: (txt) => {
                    setProgress(((fi * totalJobs) + done) / totalJobs * 100)
                    setProgressText(txt)
                  },
                  stopFlagRef,
                  concurrency   // v12.5 ← передаём сюда
                })

                // Phase 3: Assemble
                addLog(`  Phase 3 — Assembler...`, 'pu')
                for (const [fid, endTime] of fallbackEnds) {
                  const entry = flagMap.get(fid)
                  if (entry) entry.end = endTime
                }
                const srtContent = assemble(flagMap, textMap, maxChars, mergeGap, mergeMode, dedupWindow, isSilero ? subTiming : 'vad')
                segs = []  // assemble returns SRT string directly
                const baseName = file.name.replace(/\.[^.]+$/, '')
                const suffix   = p === 'el' ? '_el' : '_gm'
                newSrtMap[baseName + suffix] = srtContent
                downloadSrt(srtContent, baseName + suffix + '.srt')
                addLog(`  ✅ ${baseName}${suffix}.srt скачан`, 'ok')

              } else {
                // Smart Silence path
                segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars, null, addLog,
                  (txt) => setProgressText(txt), stopFlagRef)
              }

            } else if (p === 'or') {
              segs = await transcribeOR(file, orKey, orModel, lang, chunkSec, maxChars, addLog,
                (txt) => setProgressText(txt), stopFlagRef)
            }

            // Для EL / Smart Silence / OR — собираем SRT из segs
            if (segs.length > 0) {
              const { buildSrt, downloadSrt: dl } = await import('../lib/srtUtils.js')
              const srtContent = buildSrt(segs, maxChars)
              const baseName = file.name.replace(/\.[^.]+$/, '')
              const suffix   = p === 'el' ? '_el' : p === 'gm' ? '_gm' : '_or'
              newSrtMap[baseName + suffix] = srtContent
              dl(srtContent, baseName + suffix + '.srt')
              addLog(`  ✅ ${baseName}${suffix}.srt скачан`, 'ok')
            }

            setFileStatuses(prev => ({ ...prev, [`${fi}_${p}`]: 'ok' }))
          } catch (e) {
            addLog(`  ❌ ${e.message}`, 'er')
            setFileStatuses(prev => ({ ...prev, [`${fi}_${p}`]: 'error' }))
          }

          done++
          setProgress(done / totalJobs * 100)
        }
      }
    } finally {
      setLastSrtMap(newSrtMap)
      setRunning(false)
      setStatusText(stopFlagRef.current ? '⏹ Остановлено' : '✅ Готово')
      setProgress(100)
    }
  }, [
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode,
    dedupWindow, subTiming, timingMode, orModel, voskReady, voskModelRef,
    elKey, gmKey, orKey, concurrency, addLog  // v12.5: concurrency в deps
  ])

  return {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, lastSrtMap, files, setFiles, fileStatuses,
    handleStart, stopBatch
  }
}
