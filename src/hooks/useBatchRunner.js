// useBatchRunner.js — v14.0.0
// Восстановлены все пути: smart/vosk → transcribeGemini, v12 → segmentAudio+dispatch
// Убраны: silero, classifierMode, useRmsTiming, useFFT
// Добавлено: ts метка в каждой строке лога, детальный лог по фазам

import { useRef, useState, useCallback } from 'react'
import { transcribeEL }         from '../lib/elevenlabs.js'
import { transcribeGemini }     from '../lib/gemini.js'
import { transcribeOpenRouter } from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio }          from '../lib/audioUtils.js'
import { segmentAudio }         from '../lib/segmenter.js'
import { dispatchChunks }       from '../lib/dispatcher.js'
import { assemble }             from '../lib/assembler.js'

function fmt(ms) { return ms < 1000 ? `${ms}мс` : `${(ms/1000).toFixed(1)}с` }
function maxOutLabel(chunkSec) {
  if (chunkSec >= 45) return '4096'
  if (chunkSec >= 25) return '2048'
  return '1024'
}
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
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode, timingMode,
    dedupWindow    = 0,
    elKey, gmKey, orKey, orModel,
    gmModel        = 'gemini-2.5-flash-lite',
    concurrency    = 6,
    showMusicMarker = false,
  }) => {
    if (!files.length) { alert('Добавь файлы'); return }

    stopFlagRef.current = false
    setRunning(true)
    setLog([])
    setProgress(0)
    setVoskVisible(false)

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

      addLog('', '')
      addLog(`▶ [${fi+1}/${totalJobs}] ${file.name} (${(file.size/1e6).toFixed(1)} MB)`, 'ok')

      const isGmPath = prov === 'gm' || prov === 'bo'
      const isV12    = timingMode === 'v12'
      const isSmart  = timingMode === 'smart'

      if (isGmPath) {
        addLog(
          `⚙ chunkSec:${chunkSec} | concurrency:${concurrency} | maxOut:${maxOutLabel(chunkSec)} | dedup:${dedupWindow} | lang:${lang}`,
          'dm'
        )
        addLog(
          `⚙ метод:${timingMode} | minPause:${minPause}мс | merge:${mergeMode}(${mergeGap}с) | chars:${maxChars} | ♪:${showMusicMarker?'вкл':'выкл'}`,
          'dm'
        )
      }

      try {
        // ── Кеш AudioBuffer ──────────────────────────────────────────────────
        let audioBufCached = null
        try {
          audioBufCached = await decodeAudio(file)
          addLog(`  Audio: ${audioBufCached.duration.toFixed(1)}с | ${audioBufCached.sampleRate}Hz декодировано`, 'dm')
        } catch (e) {
          addLog(`  ⚠ decodeAudio: ${e.message}`, 'wa')
        }

        // ── ElevenLabs ───────────────────────────────────────────────────────
        if (prov === 'el' || prov === 'bo') {
          if (!elKey) { addLog('  ✗ ElevenLabs: нет API ключа', 'er') }
          else {
            try {
              addLog(`  ElevenLabs: транскрипция...`, 'in')
              const t0   = performance.now()
              const segs = await transcribeEL(file, elKey, lang, maxChars, addLog)
              const ms   = Math.round(performance.now() - t0)
              const name = file.name.replace(/\.[^.]+$/, '') + '_el.srt'
              const content = buildSrt(segs)
              downloadSrt(content, name)
              newSrtMap[name] = content
              addLog(`  ✓ ElevenLabs — ${segs.length} сег | ⏱ ${fmt(ms)}`, 'ok')
            } catch (e) { addLog(`  ✗ ElevenLabs: ${e.message}`, 'er') }
          }
          if (prov === 'el') { done++; setProgress(done/totalJobs*100); continue }
        }

        // ── OpenRouter ───────────────────────────────────────────────────────
        if (prov === 'or') {
          if (!orKey) { addLog('  ✗ OpenRouter: нет API ключа', 'er') }
          else {
            try {
              const t0   = performance.now()
              addLog(`  OpenRouter (${orModel}): транскрипция...`, 'in')
              const segs = await transcribeOpenRouter(
                file, orKey, orModel, lang, chunkSec, maxChars,
                null, addLog, txt => setProgressText(txt), stopFlagRef
              )
              const srtOR = buildSrt(segs)
              const ms    = Math.round(performance.now() - t0)
              const name  = file.name.replace(/\.[^.]+$/, '') + '_or.srt'
              downloadSrt(srtOR, name)
              newSrtMap[name] = srtOR
              addLog(`  ✓ OpenRouter — ${segs.length} сег | ⏱ ${fmt(ms)}`, 'ok')
            } catch (e) { addLog(`  ✗ OpenRouter: ${e.message}`, 'er') }
          }
          done++; setProgress(done/totalJobs*100); continue
        }

        // ── Gemini ───────────────────────────────────────────────────────────
        if (prov === 'gm' || prov === 'bo') {
          if (!gmKey) { addLog('  ✗ Gemini: нет API ключа', 'er'); continue }

          if (isV12) {
            // ── v12 Flags: Phase 1 → Phase 2 → Phase 3 ─────────────────────
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
              audioBuf, chunks,
              apiKey: gmKey, lang, chunkSec, dedupWindow,
              onLog: addLog,
              onProgress: txt => setProgressText(txt),
              stopFlagRef, concurrency, gmModel,
            })
            const p2Ms = Math.round(performance.now() - p2T0)
            addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Ms)}`, 'ok')

            const p3T0 = performance.now()
            addLog(`  Phase 3 — Assembler...`, 'pu')
            for (const [fid, endTime] of fallbackEnds) {
              const entry = flagMap.get(fid)
              if (entry) entry.end = endTime
            }
            const srtContent = assemble(
              flagMap, textMap,
              maxChars, mergeGap, mergeMode, dedupWindow,
              'vad', null, 1.5, showMusicMarker, null
            )
            const p3Ms     = Math.round(performance.now() - p3T0)
            const segCount = srtContent.split('\n\n').filter(b => b.trim()).length
            addLog(`  Phase 3 ✓ — ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'ok')

            const srtName  = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const totalMs  = Math.round(performance.now() - fileT0)
            downloadSrt(srtContent, srtName)
            newSrtMap[srtName] = srtContent
            done++; setProgress(done/totalJobs*100)

            addLog(``, 'dm')
            addLog(`══════════════════════════════════════════════`, 'dm')
            addLog(`  ФАЙЛ: ${file.name}`, 'dm')
            addLog(`  Длительность: ${audioBufCached?.duration?.toFixed(1)||'?'}с | Размер: ${(file.size/1e6).toFixed(1)} MB`, 'dm')
            addLog(`  Метод: v12 Flags | Модель: ${gmModel}`, 'dm')
            addLog(`  ──────────────────────────────────────────`, 'dm')
            addLog(`  Phase 1 — v12 Segmenter:`, 'dm')
            addLog(`    ${totalMicroSegs} сег → ${chunks.length} чанков | maxChunk:${maxChunkDur}с`, 'dm')
            addLog(`    minPause: ${minPause}мс | ⏱ ${fmt(p1Ms)}`, 'dm')
            addLog(`  Phase 2 — Dispatch:`, 'dm')
            addLog(`    ${chunks.length} чанков × ${concurrency} параллельно | ⏱ ${fmt(p2Ms)}`, 'dm')
            addLog(`  Phase 3 — Assembler:`, 'dm')
            addLog(`    ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'dm')
            addLog(`  ──────────────────────────────────────────`, 'dm')
            addLog(`  ⏱ ИТОГО: ${fmt(totalMs)}`, 'pu')
            addLog(`  ✓ ${srtName} — ${segCount} сег | ⏱ файл: ${fmt(totalMs)}`, 'ok')
            addLog(`══════════════════════════════════════════════`, 'dm')

          } else {
            // ── Smart Silence (legacy transcribeGemini) ─────────────────────
            addLog(`  Gemini Smart Silence...`, 'gm-cl')
            const t0   = performance.now()
            const segs = await transcribeGemini(
              file, gmKey, lang, chunkSec, maxChars, null,
              addLog, txt => setProgressText(txt), stopFlagRef
            )
            const ms      = Math.round(performance.now() - t0)
            const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const content = buildSrt(segs)
            downloadSrt(content, srtName)
            newSrtMap[srtName] = content
            done++; setProgress(done/totalJobs*100)
            addLog(`  ✓ ${srtName} (${segs.length} сегментов)`, 'ok')
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

  return {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, startBatch, stopBatch,
    lastSrtMap,
  }
}
