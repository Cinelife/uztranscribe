// useBatchRunner.js — v14.1.0
// Добавлен Silero VAD путь: segmentAudioSilero → dispatchMultiAudio → assemble
// timingMode: 'smart' | 'v12' | 'silero' | 'v12rms'

import { useRef, useState, useCallback } from 'react'
import { transcribeEL }          from '../lib/elevenlabs.js'
import { transcribeGemini }      from '../lib/gemini.js'
import { transcribeOpenRouter }  from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio }           from '../lib/audioUtils.js'
import { segmentAudio }          from '../lib/segmenter.js'
import { segmentAudioSilero }    from '../lib/sileroVad.js'
import { dispatchChunks, dispatchMultiAudio } from '../lib/dispatcher.js'
import { assemble }              from '../lib/assembler.js'

function fmt(ms) { return ms < 1000 ? `${ms}мс` : `${(ms/1000).toFixed(1)}с` }
function maxOutLabel(s) { return s >= 45 ? '4096' : s >= 25 ? '2048' : '1024' }
function nowStamp() {
  const d = new Date()
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour12: false })
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
    setLog(prev => [...prev, { id: logIdRef.current++, msg, cls, ts: nowStamp() }])
  }, [])

  const clearLog = useCallback(() => {
    setLog([{ id: logIdRef.current++, msg: '// Лог очищен', cls: 'dm', ts: nowStamp() }])
  }, [])

  const startBatch = useCallback(async ({
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode,
    timingMode, dedupWindow = 0,
    elKey, gmKey, orKey, orModel, gmModel = 'gemini-2.5-flash-lite',
    concurrency = 6, showMusicMarker = false,
  }) => {
    if (!files.length) return
    stopFlagRef.current = false
    setRunning(true); setLog([]); setProgress(0)

    const totalJobs = files.length
    const newSrtMap = {}
    let done = 0

    addLog(`══════════════════════════════════════════════`, 'dm')
    addLog(`  Сессия: ${nowStamp()} | Файлов: ${totalJobs}`, 'dm')
    addLog(`══════════════════════════════════════════════`, 'dm')

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file   = files[fi]
      const fileT0 = performance.now()
      const isSilero = timingMode === 'silero'
      const isV12    = timingMode === 'v12'
      const isV12RMS = timingMode === 'v12rms'

      addLog('', '')
      addLog(`▶ [${fi+1}/${totalJobs}] ${file.name} (${(file.size/1e6).toFixed(1)} MB)`, 'ok')

      const isGmPath = prov === 'gm' || prov === 'bo'
      if (isGmPath) {
        addLog(`⚙ chunkSec:${chunkSec} | concurrency:${concurrency} | maxOut:${maxOutLabel(chunkSec)} | dedup:${dedupWindow} | lang:${lang}`, 'dm')
        addLog(`⚙ метод:${timingMode} | merge:${mergeMode}(${mergeGap}с) | chars:${maxChars} | ♪:${showMusicMarker?'вкл':'выкл'}`, 'dm')
      }

      try {
        let audioBufCached = null
        try {
          audioBufCached = await decodeAudio(file)
          addLog(`  Audio: ${audioBufCached.duration.toFixed(1)}с | ${audioBufCached.sampleRate}Hz | ${(file.size/1e6).toFixed(1)} MB декодировано`, 'dm')
        } catch (e) { addLog(`  ⚠ decodeAudio: ${e.message}`, 'wa') }

        // ── ElevenLabs ───────────────────────────────────────────────────────
        if (prov === 'el' || prov === 'bo') {
          if (!elKey) { addLog('  ✗ ElevenLabs: нет API ключа', 'er') }
          else {
            try {
              const t0   = performance.now()
              addLog(`  ElevenLabs: транскрипция...`, 'in')
              const segs = await transcribeEL(file, elKey, lang, maxChars, addLog)
              const ms   = Math.round(performance.now() - t0)
              const name = file.name.replace(/\.[^.]+$/, '') + '_el.srt'
              const srt  = buildSrt(segs)
              downloadSrt(srt, name); newSrtMap[name] = srt
              addLog(`  ✓ ElevenLabs — ${segs.length} сег | ⏱ ${fmt(ms)}`, 'ok')
            } catch (e) { addLog(`  ✗ ElevenLabs: ${e.message}`, 'er') }
          }
          if (prov === 'el') { done++; setProgress(done/totalJobs*100); continue }
        }

        // ── OpenRouter ───────────────────────────────────────────────────────
        if (prov === 'or') {
          if (!orKey) { addLog('  ✗ OpenRouter: нет ключа', 'er') }
          else {
            try {
              const t0   = performance.now()
              addLog(`  OpenRouter (${orModel})...`, 'in')
              const segs = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars, null, addLog, txt => setProgressText(txt), stopFlagRef)
              const srt  = buildSrt(segs)
              const name = file.name.replace(/\.[^.]+$/, '') + '_or.srt'
              downloadSrt(srt, name); newSrtMap[name] = srt
              addLog(`  ✓ OpenRouter — ${segs.length} сег | ⏱ ${fmt(Math.round(performance.now()-t0))}`, 'ok')
            } catch (e) { addLog(`  ✗ OpenRouter: ${e.message}`, 'er') }
          }
          done++; setProgress(done/totalJobs*100); continue
        }

        // ── Gemini ───────────────────────────────────────────────────────────
        if (prov === 'gm' || prov === 'bo') {
          if (!gmKey) { addLog('  ✗ Gemini: нет API ключа', 'er'); continue }

          if (isSilero) {
            // ════════════════════════════════════════════════════════════════
            // Silero VAD → Multi-audio Dispatcher
            // ════════════════════════════════════════════════════════════════
            addLog(`  Phase 1 — Silero VAD...`, 'pu')
            setVoskVisible(true)
            const p1T0 = performance.now()

            const sileroInput = audioBufCached || file
            const { segments, rawCount, speechCount, musicCount } =
              await segmentAudioSilero(
                sileroInput,
                (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') },
                addLog
              )
            setVoskVisible(false)
            // Группируем в пакеты по batchSize из UI
            const speechOnly = segments.filter(s => s.type === 'speech')
            const batches = []
            for (let bi = 0; bi < speechOnly.length; bi += batchSize)
              batches.push(speechOnly.slice(bi, bi + batchSize))
            const p1Ms = Math.round(performance.now() - p1T0)
            addLog(`  Phase 1 ✓ — raw:${rawCount} | speech:${speechCount} | music:${musicCount} | пакетов:${batches.length} (×${batchSize}) | ⏱ ${fmt(p1Ms)}`, 'ok')

            if (speechCount === 0) {
              addLog(`  ⚠ Нет речевых сегментов — пропускаем`, 'wa')
              continue
            }

            addLog(`  Phase 2 — Multi-audio Dispatcher (×${concurrency})...`, 'gm-cl')
            const p2T0    = performance.now()
            const audioBuf = audioBufCached || await decodeAudio(file)

            const { textMap } = await dispatchMultiAudio({
              audioBuf,
              segments: speechOnly,
              batches,
              apiKey: gmKey, lang, gmModel, concurrency,
              onLog: addLog,
              onProgress: txt => setProgressText(txt),
              stopFlagRef,
            })
            const p2Ms = Math.round(performance.now() - p2T0)
            addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Ms)}`, 'ok')

            addLog(`  Phase 3 — Assembler...`, 'pu')
            const p3T0 = performance.now()

            // Собираем flagMap только из speech сегментов
            const flagMap = new Map()
            segments.filter(s => s.type === 'speech').forEach(seg => {
              flagMap.set(seg.flagId, { start: seg.start, end: seg.end })
            })

            const srtContent = assemble(
              flagMap, textMap,
              maxChars, mergeGap, mergeMode, dedupWindow,
              'vad', null, 1.5, showMusicMarker, null
            )
            const p3Ms     = Math.round(performance.now() - p3T0)
            const segCount = srtContent.split('\n\n').filter(b => b.trim()).length
            addLog(`  Phase 3 ✓ — ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'ok')

            const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const totalMs = Math.round(performance.now() - fileT0)
            downloadSrt(srtContent, srtName); newSrtMap[srtName] = srtContent
            done++; setProgress(done/totalJobs*100)

            addLog(``, 'dm')
            addLog(`══════════════════════════════════════════════`, 'dm')
            addLog(`  ФАЙЛ: ${file.name}`, 'dm')
            addLog(`  Длительность: ${audioBufCached?.duration?.toFixed(1)||'?'}с | ${(file.size/1e6).toFixed(1)} MB`, 'dm')
            addLog(`  Метод: Silero VAD + Multi-audio | Модель: ${gmModel}`, 'dm')
            addLog(`  Phase 1: raw:${rawCount} speech:${speechCount} music:${musicCount} | ⏱ ${fmt(p1Ms)}`, 'dm')
            addLog(`  Phase 2: ${batches.length} пакетов × ${concurrency} | ⏱ ${fmt(p2Ms)}`, 'dm')
            addLog(`  Phase 3: ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'dm')
            addLog(`  ⏱ ИТОГО: ${fmt(totalMs)}`, 'pu')
            addLog(`  ✓ ${srtName} — ${segCount} сег | ⏱ ${fmt(totalMs)}`, 'ok')
            addLog(`══════════════════════════════════════════════`, 'dm')

          } else if (isV12RMS) {
            // v12 RMS micro-segments as individual WAVs
            addLog(`  Phase 1 — v12 RMS Segmenter...`, 'pu')
            setVoskVisible(true)
            const p1T0v = performance.now()
            const { flagMap: fmRms, chunks: chRms, totalMicroSegs: nRms } = await segmentAudio(
              file, chunkSec, minPause,
              (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') }
            )
            setVoskVisible(false)
            const p1Msv = Math.round(performance.now() - p1T0v)
            addLog(`  Phase 1 ✓ — ${nRms} micro-сег | ⏱ ${fmt(p1Msv)}`, 'ok')

            const audioBufR = audioBufCached || await decodeAudio(file)
            const allMicro = chRms.flatMap(ch => ch.segments).map(s => ({
              flagId: s.flagId, start: s.start, end: s.end, type: 'speech',
            }))
            const microBatches = []
            for (let bi = 0; bi < allMicro.length; bi += batchSize)
              microBatches.push(allMicro.slice(bi, bi + batchSize))

            addLog(`  Phase 2 — Multi-audio (${nRms} сег → ${microBatches.length} пакетов ×${concurrency})...`, 'gm-cl')
            const p2T0v = performance.now()
            const { textMap: tmRms } = await dispatchMultiAudio({
              audioBuf: audioBufR, segments: allMicro, batches: microBatches,
              apiKey: gmKey, lang, gmModel, concurrency,
              onLog: addLog, onProgress: txt => setProgressText(txt), stopFlagRef,
            })
            const p2Msv = Math.round(performance.now() - p2T0v)
            addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Msv)}`, 'ok')

            addLog(`  Phase 3 — Assembler...`, 'pu')
            const p3T0v = performance.now()
            const srtRms = assemble(
              fmRms, tmRms, maxChars, mergeGap, mergeMode, dedupWindow,
              'vad', null, 1.5, showMusicMarker, null
            )
            const p3Msv   = Math.round(performance.now() - p3T0v)
            const cntRms  = srtRms.split('\n\n').filter(b => b.trim()).length
            addLog(`  Phase 3 ✓ — ${cntRms} субтитров | ⏱ ${fmt(p3Msv)}`, 'ok')

            const snRms  = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const totRms = Math.round(performance.now() - fileT0)
            downloadSrt(srtRms, snRms); newSrtMap[snRms] = srtRms
            done++; setProgress(done/totalJobs*100)
            addLog(`  ⏱ ИТОГО: ${fmt(totRms)} | ✓ ${snRms} — ${cntRms} сег`, 'ok')

          } else if (isV12) {
            // ════════════════════════════════════════════════════════════════
            // v12 Flags → dispatchChunks
            // ════════════════════════════════════════════════════════════════
            addLog(`  Phase 1 — v12 Segmenter...`, 'pu')
            setVoskVisible(true)
            const p1T0 = performance.now()
            const { flagMap, chunks, totalMicroSegs } = await segmentAudio(
              file, chunkSec, minPause,
              (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') }
            )
            setVoskVisible(false)
            const p1Ms = Math.round(performance.now() - p1T0)
            const maxChunkDur = chunks.length ? Math.max(...chunks.map(c => c.t1 - c.t0)).toFixed(1) : '?'
            addLog(`  Phase 1 ✓ — ${totalMicroSegs} сег → ${chunks.length} чанков | maxChunk:${maxChunkDur}с | ⏱ ${fmt(p1Ms)}`, 'ok')

            addLog(`  Phase 2 — Dispatcher (×${concurrency} параллельно)...`, 'gm-cl')
            const p2T0    = performance.now()
            const audioBuf = audioBufCached || await decodeAudio(file)
            const { allText: textMap, fallbackEnds } = await dispatchChunks({
              audioBuf, chunks, apiKey: gmKey, lang, chunkSec, dedupWindow,
              onLog: addLog, onProgress: txt => setProgressText(txt),
              stopFlagRef, concurrency, gmModel,
            })
            const p2Ms = Math.round(performance.now() - p2T0)
            addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Ms)}`, 'ok')

            addLog(`  Phase 3 — Assembler...`, 'pu')
            const p3T0 = performance.now()
            for (const [fid, endTime] of fallbackEnds) {
              const entry = flagMap.get(fid)
              if (entry) entry.end = endTime
            }
            const srtContent = assemble(
              flagMap, textMap, maxChars, mergeGap, mergeMode, dedupWindow,
              'vad', null, 1.5, showMusicMarker, null
            )
            const p3Ms     = Math.round(performance.now() - p3T0)
            const segCount = srtContent.split('\n\n').filter(b => b.trim()).length
            addLog(`  Phase 3 ✓ — ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'ok')

            const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const totalMs = Math.round(performance.now() - fileT0)
            downloadSrt(srtContent, srtName); newSrtMap[srtName] = srtContent
            done++; setProgress(done/totalJobs*100)

            addLog(``, 'dm')
            addLog(`══════════════════════════════════════════════`, 'dm')
            addLog(`  ФАЙЛ: ${file.name}`, 'dm')
            addLog(`  Длительность: ${audioBufCached?.duration?.toFixed(1)||'?'}с | ${(file.size/1e6).toFixed(1)} MB`, 'dm')
            addLog(`  Метод: v12 Flags | Модель: ${gmModel}`, 'dm')
            addLog(`  Phase 1: ${totalMicroSegs} сег → ${chunks.length} чанков | minPause:${minPause}мс | ⏱ ${fmt(p1Ms)}`, 'dm')
            addLog(`  Phase 2: ${chunks.length} чанков × ${concurrency} | ⏱ ${fmt(p2Ms)}`, 'dm')
            addLog(`  Phase 3: ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'dm')
            addLog(`  ⏱ ИТОГО: ${fmt(totalMs)}`, 'pu')
            addLog(`  ✓ ${srtName} — ${segCount} сег | ⏱ ${fmt(totalMs)}`, 'ok')
            addLog(`══════════════════════════════════════════════`, 'dm')

          } else {
            // Smart Silence
            addLog(`  Gemini Smart Silence...`, 'gm-cl')
            const t0   = performance.now()
            const segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars, null, addLog, txt => setProgressText(txt), stopFlagRef)
            const name = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const srt  = buildSrt(segs)
            downloadSrt(srt, name); newSrtMap[name] = srt
            done++; setProgress(done/totalJobs*100)
            addLog(`  ✓ ${name} (${segs.length} сегментов) | ⏱ ${fmt(Math.round(performance.now()-t0))}`, 'ok')
          }
        }

      } catch (e) {
        addLog(`  ✗ Ошибка: ${e.message}`, 'er')
        console.error(e)
      }
    }

    addLog(``, 'dm')
    addLog(`══════════════════════════════════════════════`, 'dm')
    addLog(`  ГОТОВО: ${done}/${totalJobs}`, 'ok')
    addLog(`  SRT → папка Downloads`, 'dm')
    addLog(`  💡 Можно перевести результат ниже ↓`, 'dm')
    addLog(`══════════════════════════════════════════════`, 'dm')

    setLastSrtMap(newSrtMap)
    setRunning(false)
    setProgressText('Готово')
    setStatusText(`✓ ${done}/${totalJobs}`)
  }, [])

  const stopBatch = useCallback(() => {
    stopFlagRef.current = true
    setRunning(false)
    setProgressText('Остановлено')
  }, [])

  return { log, clearLog, progress, progressText, statusText, voskVisible, voskPct, voskText, running, startBatch, stopBatch, lastSrtMap }
}
