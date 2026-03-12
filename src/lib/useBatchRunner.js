/**
 * useBatchRunner.js — v13.0.0
 *
 * Изменения vs v12.5.4:
 *   - segmentAudioSilero получает audioBufCached → нет двойного декодирования
 *   - Принимает factorMap и rawSegCount из segmentAudioSilero
 *   - factorMap передаётся в assemble() для Phase 3
 *   - Phase 1 лог: raw:X → merged:Y → N чанков | maxChunk:Zс
 *   - Phase 2 лог: детальный per-chunk с prep/api/total
 *   - Phase 3 лог: кол-во сегментов SRT
 *   - Итоговый лог: полная сводка пайплайна
 */

import { useRef, useState, useCallback } from 'react'
import { transcribeEL }          from '../lib/elevenlabs.js'
import { transcribeGemini }      from '../lib/gemini.js'
import { transcribeOpenRouter }  from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio, sleep }    from '../lib/audioUtils.js'
import { getVoskBoundaries }     from '../lib/vosk.js'
import { segmentAudio }          from '../lib/segmenter.js'
import { segmentAudioSilero }    from '../lib/sileroVad.js'
import { dispatchChunks }        from '../lib/dispatcher.js'
import { assemble }              from '../lib/assembler.js'
import { classifySegments }      from '../lib/audioClassifier.js'

function fmt(ms) {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

function maxOutLabel(chunkSec) {
  if (chunkSec >= 45) return '4096'
  if (chunkSec >= 25) return '2048'
  return '1024'
}

// ── Форматирование итоговой сводки ────────────────────────────────────────────
function buildPipelineSummary(stats) {
  const lines = []
  lines.push('══════════════════════════════════════════════')
  lines.push(`  ФАЙЛ: ${stats.fileName}`)
  lines.push(`  Длительность: ${stats.duration.toFixed(1)}с | Размер: ${stats.sizeMb.toFixed(1)} MB`)
  lines.push(`  Метод: ${stats.method} | Модель: ${stats.model}`)
  lines.push('  ──────────────────────────────────────────')
  lines.push(`  Phase 1 — Сегментация:`)
  if (stats.rawSegCount !== undefined) {
    lines.push(`    raw: ${stats.rawSegCount} → merged: ${stats.mergedSegCount} → ${stats.chunkCount} чанков`)
    lines.push(`    maxChunk: ${stats.maxChunkDur}с | minPause: ${stats.minPause}мс`)
  } else {
    lines.push(`    ${stats.mergedSegCount} сег → ${stats.chunkCount} чанков`)
  }
  lines.push(`    ⏱ ${fmt(stats.p1Ms)}`)
  if (stats.classifierSummary) {
    lines.push(`  Classifier: ${stats.classifierSummary} | ⏱ ${fmt(stats.classMs)}`)
  }
  lines.push(`  Phase 2 — Dispatch:`)
  lines.push(`    ${stats.chunkCount} чанков × ${stats.concurrency} параллельно`)
  lines.push(`    avg: ${fmt(stats.p2AvgMs)} | min: ${fmt(stats.p2MinMs)} | max: ${fmt(stats.p2MaxMs)}`)
  lines.push(`    ускорение: ×${stats.p2Speedup}`)
  lines.push(`    ⏱ ${fmt(stats.p2Ms)}`)
  lines.push(`  Phase 3 — Assembler:`)
  lines.push(`    ${stats.srtSegCount} субтитров`)
  lines.push(`    ⏱ ${fmt(stats.p3Ms)}`)
  lines.push('  ──────────────────────────────────────────')
  lines.push(`  ⏱ ИТОГО: ${fmt(stats.totalMs)}`)
  return lines
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
    dedupWindow     = 12,
    subTiming       = 'vad',
    elKey, gmKey, orKey, orModel,
    gmModel         = 'gemini-2.5-flash-lite',
    voskReady, voskModelRef,
    concurrency     = 6,
    classifierMode  = 'off',
    showMusicMarker = false,
    targetDur       = 1.5,   // v13: целевая длина субтитра (сек)
  }) => {
    if (!files.length)                              { alert('Добавь файлы');             return }
    if (prov === 'el' && !elKey)                    { alert('Нет ElevenLabs API Key');   return }
    if ((prov === 'gm' || prov === 'bo') && !gmKey) { alert('Нет Gemini API Key');       return }
    if ((prov === 'or' || prov === 'bo') && !orKey) { alert('Нет OpenRouter API Key');   return }

    stopFlagRef.current = false
    setRunning(true)
    setLog([])
    setProgress(0)
    setVoskVisible(false)

    const totalJobs = files.length * (prov === 'bo' ? 2 : 1)
    let done = 0

    const batchT0   = performance.now()
    const newSrtMap = {}

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file = files[fi]

      try {
        addLog('', '')
        addLog(`▶ [${fi + 1}/${files.length}] ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`, 'ok')

        // ── Лог настроек ─────────────────────────────────────────────────────
        const isGmPath = prov === 'gm' || prov === 'bo' || prov === 'or'
        if (isGmPath) {
          addLog(
            `⚙ chunkSec:${chunkSec} | concurrency:${concurrency} | maxOut:${maxOutLabel(chunkSec)} | dedup:${dedupWindow} | lang:${lang}`,
            'dm'
          )
          addLog(
            `⚙ classifier:${classifierMode} | ♪:${showMusicMarker ? 'вкл' : 'выкл'} | targetDur:${targetDur}с`,
            'dm'
          )
        }

        const fileT0 = performance.now()

        // ── Декодируем AudioBuffer ОДИН РАЗ — используем везде ───────────────
        let audioBufCached = null
        try {
          audioBufCached = await decodeAudio(file)
          addLog(`  Audio: ${audioBufCached.duration.toFixed(1)}с | ${audioBufCached.sampleRate}Hz декодировано`, 'dm')
        } catch (decErr) {
          addLog(`  ⚠ decodeAudio: ${decErr.message} — fallback на Audio element`, 'wa')
          try {
            const url   = URL.createObjectURL(file)
            const audio = new Audio(url)
            await new Promise(r => { audio.onloadedmetadata = r; audio.onerror = r })
            URL.revokeObjectURL(url)
          } catch (_) {}
        }

        // ── ElevenLabs ───────────────────────────────────────────────────────
        if (prov === 'el' || prov === 'bo') {
          addLog(`  ElevenLabs...`, 'in')
          const segs = await transcribeEL(
            file, elKey, lang, maxChars, null,
            addLog, p => setProgressText(p), stopFlagRef
          )
          const srtName = file.name.replace(/\.[^.]+$/, '') + '_el.srt'
          const content = buildSrt(segs)
          downloadSrt(content, srtName)
          newSrtMap[srtName] = content
          done++
          setProgress(done / totalJobs * 100)
          addLog(`  ✓ ${srtName} — ${segs.length} сег`, 'ok')
        }

        // ── Gemini / OpenRouter — Dispatcher path ─────────────────────────────
        if ((prov === 'gm' || prov === 'or' || prov === 'bo') && !stopFlagRef.current) {
          const isSilero      = timingMode === 'silero'
          const isV12         = timingMode === 'v12'
          const useDispatcher = isSilero || isV12

          if (useDispatcher) {

            // ─────────────────────────────────────────────────────────────────
            // PHASE 1 — Сегментация
            // ─────────────────────────────────────────────────────────────────
            const segLabel = isSilero ? 'Silero VAD' : 'v12 Segmenter'
            addLog(`  Phase 1 — ${segLabel}...`, 'pu')
            setVoskVisible(true)
            const p1T0 = performance.now()

            // v13: передаём audioBufCached — Silero больше не декодирует файл повторно
            // v13: получаем factorMap (RMS+ZCR per segment) и rawSegCount для лога
            let flagMap, chunks, totalMicroSegs, factorMap, rawSegCount

            if (isSilero) {
              const result = await segmentAudioSilero(
                file, chunkSec, minPause,
                (pct, txt) => { setVoskPct(pct); setVoskText(txt || '') },
                addLog,
                audioBufCached  // v13: передаём кешированный буфер
              )
              flagMap        = result.flagMap
              chunks         = result.chunks
              totalMicroSegs = result.totalMicroSegs
              factorMap      = result.factorMap      // v13: новое
              rawSegCount    = result.rawSegCount    // v13: новое
            } else {
              const result = await segmentAudio(
                file, chunkSec, minPause,
                (pct, txt) => { setVoskPct(pct); setVoskText(txt) }
              )
              flagMap        = result.flagMap
              chunks         = result.chunks
              totalMicroSegs = result.totalMicroSegs
              factorMap      = null
              rawSegCount    = undefined
            }

            setVoskVisible(false)
            const p1Ms = Math.round(performance.now() - p1T0)

            // Детальный Phase 1 лог
            const maxChunkDur = chunks.length
              ? Math.max(...chunks.map(c => c.t1 - c.t0)).toFixed(1)
              : '?'
            if (isSilero && rawSegCount !== undefined) {
              addLog(
                `  Phase 1 ✓ — raw:${rawSegCount} → merged:${totalMicroSegs} → ${chunks.length} чанков | maxChunk:${maxChunkDur}с | ⏱ ${fmt(p1Ms)}`,
                'ok'
              )
            } else {
              addLog(
                `  Phase 1 ✓ — ${totalMicroSegs} микро-сег → ${chunks.length} чанков | maxChunk:${maxChunkDur}с | ⏱ ${fmt(p1Ms)}`,
                'ok'
              )
            }

            // ─────────────────────────────────────────────────────────────────
            // Classifier (v12.5.4 experimental)
            // ─────────────────────────────────────────────────────────────────
            let classMap  = null
            let classMs   = 0
            let classSummary = null
            if (classifierMode !== 'off' && audioBufCached) {
              const classT0    = performance.now()
              const allSegs    = chunks.flatMap(c => c.segments)
              classMap         = classifySegments(audioBufCached, allSegs)
              classMs          = Math.round(performance.now() - classT0)
              const speechCount = [...classMap.values()].filter(v => v.type === 'speech').length
              const musicCount  = [...classMap.values()].filter(v => v.type === 'music').length
              const mixedCount  = [...classMap.values()].filter(v => v.type === 'mixed').length
              const silentCount = [...classMap.values()].filter(v => v.type === 'silent').length
              classSummary = `speech:${speechCount} music:${musicCount} mixed:${mixedCount} silent:${silentCount}`
              addLog(`  Classifier ✓ — ${classSummary} | ⏱ ${fmt(classMs)}`, 'dm')
            }

            // ─────────────────────────────────────────────────────────────────
            // PHASE 2 — Dispatch
            // ─────────────────────────────────────────────────────────────────
            addLog(`  Phase 2 — Dispatcher (×${concurrency} параллельно)...`, 'gm-cl')
            const p2T0     = performance.now()
            const audioBuf = audioBufCached || await decodeAudio(file)

            const { allText: textMap, fallbackEnds, chunkTimings } = await dispatchChunks({
              audioBuf, chunks,
              apiKey: gmKey, lang, chunkSec, dedupWindow,
              onLog: addLog,
              onProgress: (pct, txt) => {
                setProgress(((fi * totalJobs) + done + pct / 100) / totalJobs * 100)
                setProgressText(txt)
              },
              stopFlagRef,
              concurrency,
              gmModel,
              classMap,
              classifierMode,
            })
            const p2Ms = Math.round(performance.now() - p2T0)

            // Phase 2 timing stats
            const timings   = chunkTimings || []
            const p2AvgMs   = timings.length ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : p2Ms
            const p2MinMs   = timings.length ? Math.min(...timings) : 0
            const p2MaxMs   = timings.length ? Math.max(...timings) : p2Ms
            const seqMs     = timings.reduce((a, b) => a + b, 0)
            const speedup   = seqMs > 0 ? (seqMs / p2Ms).toFixed(1) : '?'

            addLog(`  Phase 2 ✓ | avg:${fmt(p2AvgMs)} min:${fmt(p2MinMs)} max:${fmt(p2MaxMs)} ×${speedup} | ⏱ ${fmt(p2Ms)}`, 'ok')

            // ─────────────────────────────────────────────────────────────────
            // PHASE 3 — Assemble
            // ─────────────────────────────────────────────────────────────────
            const p3T0 = performance.now()
            addLog(`  Phase 3 — Assembler...`, 'pu')

            // Обновляем fallback-концы в flagMap
            for (const [fid, endTime] of fallbackEnds) {
              const entry = flagMap.get(fid)
              if (entry) entry.end = endTime
            }

            const srtContent = assemble(
              flagMap, textMap,
              maxChars, mergeGap, mergeMode, dedupWindow,
              isSilero ? subTiming : 'vad',
              audioBufCached,   // AudioBuffer для RMS sub-cut
              targetDur,        // v13: целевая длина субтитра
              showMusicMarker,
              factorMap         // зарезервировано
            )
            const p3Ms    = Math.round(performance.now() - p3T0)
            const segCount = srtContent.split('\n\n').filter(b => b.trim()).length
            addLog(`  Phase 3 ✓ — ${segCount} субтитров | ⏱ ${fmt(p3Ms)}`, 'ok')

            // ─────────────────────────────────────────────────────────────────
            // Сохранение + итоговый лог
            // ─────────────────────────────────────────────────────────────────
            const srtName    = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            downloadSrt(srtContent, srtName)
            newSrtMap[srtName] = srtContent
            done++
            setProgress(done / totalJobs * 100)
            const totalMs = Math.round(performance.now() - fileT0)

            // Полная сводка пайплайна
            const summaryLines = buildPipelineSummary({
              fileName:       file.name,
              duration:       audioBufCached?.duration || 0,
              sizeMb:         file.size / 1e6,
              method:         segLabel,
              model:          gmModel,
              rawSegCount,
              mergedSegCount: totalMicroSegs,
              chunkCount:     chunks.length,
              maxChunkDur,
              minPause,
              p1Ms,
              classifierSummary: classSummary,
              classMs,
              concurrency,
              p2Ms, p2AvgMs, p2MinMs, p2MaxMs, p2Speedup: speedup,
              p3Ms,
              srtSegCount: segCount,
              totalMs,
            })
            summaryLines.forEach((line, i) => {
              if (i === 0 || i === summaryLines.length - 1) addLog(line, 'dm')
              else if (line.includes('⏱ ИТОГО')) addLog(line, 'ok')
              else if (line.includes('✗') || line.includes('⚠')) addLog(line, 'wa')
              else addLog(line, 'dm')
            })
            addLog(`  ✓ ${srtName} — ${segCount} сег | ⏱ файл: ${fmt(totalMs)}`, 'ok')

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
            const segs = await transcribeGemini(
              file, gmKey, lang, chunkSec, maxChars,
              preChunks, addLog, p => setProgressText(p), stopFlagRef
            )
            const srtName = file.name.replace(/\.[^.]+$/, '') + '_gm.srt'
            const content = buildSrt(segs)
            downloadSrt(content, srtName)
            newSrtMap[srtName] = content
            done++
            setProgress(done / totalJobs * 100)
            addLog(`  ✓ ${srtName} — ${segs.length} сег`, 'ok')
          }
        }

        // ── OpenRouter path ───────────────────────────────────────────────────
        if (prov === 'or' && !stopFlagRef.current) {
          addLog(`  OpenRouter (${orModel})...`, 'in')
          const segs = await transcribeOpenRouter(
            file, orKey, orModel, lang, chunkSec, maxChars,
            addLog, p => setProgressText(p), stopFlagRef
          )
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
    } // end files loop

    const batchMs = Math.round(performance.now() - batchT0)
    setLastSrtMap(prev => ({ ...prev, ...newSrtMap }))
    setProgress(100)
    setStatusText(`✓ ${done}/${totalJobs} файлов`)
    addLog('', '')
    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`  ГОТОВО: ${done}/${totalJobs} | ⏱ Общее время: ${fmt(batchMs)}`, done === totalJobs ? 'ok' : 'wa')
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
    lastSrtMap,
  }
}

function parseSrt(srt) {
  const segs = []
  for (const block of srt.trim().split('\n\n')) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue
    const tc = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/)
    if (!tc) continue
    const toS = t => { const [h, m, s, ms] = t.split(/[:,]/); return +h * 3600 + +m * 60 + +s + +ms / 1000 }
    segs.push({ start: toS(tc[1]), end: toS(tc[2]), text: lines.slice(2).join(' ') })
  }
  return segs
}
