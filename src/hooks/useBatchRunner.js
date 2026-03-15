// useBatchRunner.js — v14.0.0
// Убрано: Vosk, classifierMode, useRmsTiming, useFFT
// Добавлено: метка ts (дата+время) к каждой строке лога

import { useState, useRef, useCallback } from 'react'
import { segmentAudio }        from '../lib/segmenter.js'
import { dispatchChunks }      from '../lib/dispatcher.js'
import { assemble }            from '../lib/assembler.js'
import { decodeAudio }         from '../lib/audioUtils.js'
import { downloadSrt }         from '../lib/srtUtils.js'
import { transcribeElevenLabs } from '../lib/elevenlabs.js'
import { transcribeOpenRouter } from '../lib/openrouter.js'

function nowStamp() {
  const d = new Date()
  return d.toLocaleDateString('ru-RU') + ' ' +
    d.toLocaleTimeString('ru-RU', { hour12: false })
}

function fmt(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 'с' : ms + 'мс'
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return m > 0 ? `${m}мин ${s}с` : `${s}с`
}

export function useBatchRunner() {
  const [log,          setLog]          = useState([])
  const [progress,     setProgress]     = useState(0)
  const [progressText, setProgressText] = useState('')
  const [statusText,   setStatusText]   = useState('')
  const [running,      setRunning]      = useState(false)
  const [voskVisible,  setVoskVisible]  = useState(false)
  const [voskPct,      setVoskPct]      = useState(0)
  const [voskText,     setVoskText]     = useState('')
  const [lastSrtMap,   setLastSrtMap]   = useState({})

  const stopFlagRef = useRef(false)

  function addLog(msg, type = 'dm') {
    setLog(prev => [...prev, { msg, type, ts: nowStamp() }])
  }

  const clearLog = useCallback(() => setLog([]), [])

  const startBatch = useCallback(async ({
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode,
    timingMode, dedupWindow,
    elKey, gmKey, orKey, orModel, gmModel,
    concurrency, showMusicMarker,
  }) => {
    if (!files.length) return
    stopFlagRef.current = false
    setRunning(true)
    setProgress(0)
    setProgressText('Запуск...')
    setLog([])

    const totalJobs = files.length
    const newSrtMap = {}
    const isSilero  = timingMode === 'silero'
    const isV12     = timingMode === 'v12flags' || timingMode === 'smart'
    let done = 0

    const sessionStart = nowStamp()
    addLog(`══════════════════════════════════════════`, 'dm')
    addLog(`  СЕССИЯ: ${sessionStart}`, 'dm')
    addLog(`  Файлов: ${totalJobs} | Провайдер: ${prov.toUpperCase()} | Язык: ${lang}`, 'dm')
    addLog(`══════════════════════════════════════════`, 'dm')

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file = files[fi]
      const fileT0 = performance.now()

      addLog(``, 'dm')
      addLog(`▶ [${fi + 1}/${totalJobs}] ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`, 'ok')
      addLog(`⚙ chunkSec:${chunkSec} | concurrency:${concurrency} | dedup:${dedupWindow} | lang:${lang}`, 'dm')
      addLog(`⚙ метод:${timingMode} | minPause:${minPause}мс | merge:${mergeMode}(${mergeGap}с) | chars:${maxChars}`, 'dm')

      // ── ElevenLabs ─────────────────────────────────────────────────────────
      if (prov === 'el' || prov === 'all') {
        if (!elKey) { addLog('  ✗ ElevenLabs: нет API ключа', 'er'); continue }
        try {
          const t0 = performance.now()
          addLog('  ElevenLabs: транскрипция...', 'pu')
          const srt = await transcribeElevenLabs(file, elKey, lang,
            (pct, txt) => { setProgress((fi / totalJobs + pct / 100 / totalJobs) * 100); setProgressText(txt) }
          )
          const ms  = Math.round(performance.now() - t0)
          const name = file.name.replace(/\.[^.]+$/, '') + '_el.srt'
          downloadSrt(srt, name)
          newSrtMap[name] = srt
          addLog(`  ✓ ElevenLabs | ⏱ ${fmt(ms)}`, 'ok')
        } catch (e) {
          addLog(`  ✗ ElevenLabs: ${e.message}`, 'er')
        }
        if (prov === 'el') { done++; setProgress(done / totalJobs * 100); continue }
      }

      // ── OpenRouter ─────────────────────────────────────────────────────────
      if (prov === 'or' || prov === 'all') {
        if (!orKey) { addLog('  ✗ OpenRouter: нет API ключа', 'er') }
        else {
          try {
            const t0 = performance.now()
            addLog('  OpenRouter: транскрипция...', 'pu')
            const srt = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars,
              (pct, txt) => { setProgressText(txt) }, addLog, stopFlagRef
            )
            const ms   = Math.round(performance.now() - t0)
            const name = file.name.replace(/\.[^.]+$/, '') + '_or.srt'
            downloadSrt(srt, name)
            newSrtMap[name] = srt
            addLog(`  ✓ OpenRouter | ⏱ ${fmt(ms)}`, 'ok')
          } catch (e) {
            addLog(`  ✗ OpenRouter: ${e.message}`, 'er')
          }
        }
        if (prov === 'or') { done++; setProgress(done / totalJobs * 100); continue }
      }

      // ── Gemini (v12 flags / smart silence) ────────────────────────────────
      if (prov === 'gm' || prov === 'all') {
        if (!gmKey) { addLog('  ✗ Gemini: нет API ключа', 'er'); continue }

        try {
          // Декодирование аудио
          let audioBufCached = null
          try {
            audioBufCached = await decodeAudio(file)
            addLog(`  Audio: ${audioBufCached.duration.toFixed(1)}с | ${audioBufCached.sampleRate}Hz декодировано`, 'dm')
          } catch (e) {
            addLog(`  ⚠ decodeAudio: ${e.message}`, 'wa')
          }

          // ── Phase 1: Сегментация ──────────────────────────────────────────
          addLog(`  Phase 1 — Сегментация (${timingMode})...`, 'pu')
          setVoskVisible(true)
          const p1T0 = performance.now()

          const { flagMap, chunks, totalMicroSegs } = await segmentAudio(
            file, chunkSec, minPause,
            (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') }
          )
          setVoskVisible(false)
          const p1Ms = Math.round(performance.now() - p1T0)

          // Подсчёт maxChunkDur
          const maxChunkDur = chunks.length
            ? Math.max(...chunks.map(c => c.t1 - c.t0)).toFixed(1)
            : '?'

          addLog(`  Phase 1 ✓ — ${totalMicroSegs} сег → ${chunks.length} чанков | maxChunk:${maxChunkDur}с | ⏱ ${fmt(p1Ms)}`, 'ok')
          addLog(`  Phase 1 — raw сег: ${totalMicroSegs} | чанков: ${chunks.length}`, 'dm')

          // ── Phase 2: Dispatch ─────────────────────────────────────────────
          addLog(`  Phase 2 — Dispatcher (×${concurrency} параллельно)...`, 'gm-cl')
          const p2T0   = performance.now()
          const audioBuf = audioBufCached || await decodeAudio(file)

          const { allText: textMap, fallbackEnds } = await dispatchChunks({
            audioBuf, chunks,
            apiKey: gmKey, lang, chunkSec, dedupWindow,
            onLog: addLog,
            onProgress: (pct, txt) => {
              setProgress(((fi * totalJobs) + done + 0.5) / totalJobs * 100)
              setProgressText(txt)
            },
            stopFlagRef,
            concurrency,
            gmModel,
          })
          const p2Ms = Math.round(performance.now() - p2T0)
          addLog(`  Phase 2 ✓ | ⏱ ${fmt(p2Ms)}`, 'ok')

          // ── Phase 3: Assembler ────────────────────────────────────────────
          const p3T0 = performance.now()
          addLog(`  Phase 3 — Assembler...`, 'pu')

          for (const [fid, endTime] of fallbackEnds) {
            const entry = flagMap.get(fid)
            if (entry) entry.end = endTime
          }

          const srtContent = assemble(
            flagMap, textMap,
            maxChars, mergeGap, mergeMode, dedupWindow,
            'vad',
            null, 1.5, showMusicMarker, null
          )
          const p3Ms    = Math.round(performance.now() - p3T0)
          const segCount = srtContent.split('\n\n').filter(b => b.trim()).length
          addLog(`  Phase 3 ✓ — ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'ok')

          // Сохранение
          const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
          downloadSrt(srtContent, srtName)
          newSrtMap[srtName] = srtContent
          done++
          setProgress(done / totalJobs * 100)

          const totalMs   = Math.round(performance.now() - fileT0)
          const fileDurS  = audioBufCached?.duration || 0

          addLog(``, 'dm')
          addLog(`══════════════════════════════════════════`, 'dm')
          addLog(`  ФАЙЛ: ${file.name}`, 'dm')
          addLog(`  Длительность: ${fmtDur(fileDurS)} | Размер: ${(file.size/1e6).toFixed(1)} MB`, 'dm')
          addLog(`  Метод: ${timingMode} | Модель: ${gmModel}`, 'dm')
          addLog(`  ──────────────────────────────────────`, 'dm')
          addLog(`  Phase 1 — Сегментация:`, 'dm')
          addLog(`    ${totalMicroSegs} сег → ${chunks.length} чанков`, 'dm')
          addLog(`    maxChunk: ${maxChunkDur}с | minPause: ${minPause}мс`, 'dm')
          addLog(`    ⏱ ${fmt(p1Ms)}`, 'dm')
          addLog(`  Phase 2 — Dispatch:`, 'dm')
          addLog(`    ${chunks.length} чанков × ${concurrency} параллельно`, 'dm')
          addLog(`    ⏱ ${fmt(p2Ms)}`, 'dm')
          addLog(`  Phase 3 — Assembler:`, 'dm')
          addLog(`    ${segCount} субтитров`, 'dm')
          addLog(`    ⏱ ${fmt(p3Ms)}`, 'dm')
          addLog(`  ──────────────────────────────────────`, 'dm')
          addLog(`  ⏱ ИТОГО: ${fmt(totalMs)}`, 'pu')
          addLog(`  ✓ ${srtName} — ${segCount} сег | ⏱ файл: ${fmt(totalMs)}`, 'ok')
          addLog(`══════════════════════════════════════════`, 'dm')

        } catch (e) {
          addLog(`  ✗ Gemini pipeline: ${e.message}`, 'er')
          console.error(e)
        }
      }
    }

    addLog(``, 'dm')
    addLog(`══════════════════════════════════════════`, 'dm')
    addLog(`  ГОТОВО: ${done}/${totalJobs} | ⏱ Общее время сессии`, 'ok')
    addLog(`  SRT → папка Downloads`, 'dm')
    addLog(`  💡 Можно перевести результат ниже ↓`, 'dm')
    addLog(`══════════════════════════════════════════`, 'dm')

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
