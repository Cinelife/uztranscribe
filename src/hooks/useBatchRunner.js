import { useRef, useState, useCallback } from 'react'
import { transcribeEL }     from '../lib/elevenlabs.js'
import { transcribeGemini, geminiAnchoredRequest } from '../lib/gemini.js'
import { transcribeOpenRouter } from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio, buildSmartChunks, sliceToWav, blobToBase64,
         sliceToAudioBuffer, groupWordsByPauses, sleep } from '../lib/audioUtils.js'
import { getVoskBoundaries, getVoskWordsForBuffer } from '../lib/vosk.js'

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
    files, prov, lang, chunkSec, maxChars, timingMode,
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

    const total = files.length * ((prov === 'bo') ? 2 : 1)
    let done = 0
    const newSrtMap = {}

    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`Файлов: ${files.length} | Провайдер: ${prov.toUpperCase()} | Язык: ${lang}`, 'in')
    addLog(`Символов на строку: ${maxChars}`, 'dm')

    // Detect v11 mode: Gemini + Vosk 2-pass + model loaded
    const isV11 = (prov === 'gm' || prov === 'bo') && timingMode === 'vosk' && voskReady && voskModelRef?.current

    if (isV11) {
      addLog(`Vosk v11 anchor-prompt: ✓ активен`, 'pu')
    } else if (timingMode === 'vosk' && voskReady) {
      addLog(`Vosk 2-pass: ✓ активен (быстрый режим)`, 'ok')
    }
    addLog('══════════════════════════════════════════════', 'dm')

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file = files[fi]
      const providers = prov === 'bo' ? ['el', 'gm'] : [prov]

      for (const p of providers) {
        if (stopFlagRef.current) break
        addLog(`[${fi+1}/${files.length}] ${file.name} (${p === 'el' ? 'ElevenLabs' : p === 'gm' ? 'Gemini' : 'OpenRouter'})`, 'in')

        try {
          let segs = []

          if (p === 'el') {
            segs = await transcribeEL(file, elKey, lang, maxChars, addLog)

          } else if (p === 'gm') {
            if (isV11) {
              // ── v11 pipeline ──────────────────────────────────────────────
              addLog(`  Phase 1 — Vosk per-chunk: декодирование...`, 'pu')
              const ab = await decodeAudio(file)
              const chunks = buildSmartChunks(ab, chunkSec)
              addLog(`  ${ab.duration.toFixed(1)}с → ${chunks.length} чанков`, 'pu')

              // Sequential Vosk pass on each chunk
              setVoskVisible(true)
              const allAnchorSegs = [] // [{t0_abs, t1_abs}]

              for (let ci = 0; ci < chunks.length; ci++) {
                if (stopFlagRef.current) break
                const { t0, t1 } = chunks[ci]
                setVoskText(`Vosk chunk ${ci+1}/${chunks.length}`)
                setVoskPct(ci / chunks.length * 100)

                const chunkBuf = sliceToAudioBuffer(ab, t0, t1)
                let words = []
                try {
                  words = await getVoskWordsForBuffer(chunkBuf, voskModelRef.current)
                } catch (_) {}

                if (words.length > 0) {
                  const localSegs = groupWordsByPauses(words)
                  for (const s of localSegs) {
                    allAnchorSegs.push({ start: t0 + s.start, end: t0 + s.end })
                  }
                } else {
                  // Fallback: treat whole chunk as one segment
                  allAnchorSegs.push({ start: t0, end: t1 })
                }
              }

              setVoskPct(100)
              addLog(`  Phase 1 ✓ — ${allAnchorSegs.length} акустических сегментов`, 'ok')

              // Phase 2: parallel Gemini with anchor prompts, grouped by original chunk
              addLog(`  Phase 2 — Gemini anchor-prompt: ${chunks.length} запросов...`, 'gm-cl')

              const results = new Array(chunks.length)
              let gmDone = 0
              const CONCURRENCY = 3

              // Map segs back to chunks
              const chunkSegs = chunks.map(({ t0, t1 }) =>
                allAnchorSegs.filter(s => s.start >= t0 - 0.1 && s.end <= t1 + 0.1)
              )

              await new Promise(resolve => {
                let active = 0, nextCi = 0
                function launch() {
                  while (active < CONCURRENCY && nextCi < chunks.length) {
                    if (stopFlagRef.current) break
                    const ci = nextCi++
                    active++
                    const { t0, t1 } = chunks[ci]
                    const localSegs = chunkSegs[ci].map((s, idx) => ({
                      id: idx + 1,
                      start: parseFloat((s.start - t0).toFixed(3)),
                      end:   parseFloat((s.end   - t0).toFixed(3))
                    }))
                    const dur = t1 - t0

                    sleep(ci % CONCURRENCY * 400)
                      .then(() => blobToBase64(sliceToWav(ab, t0, t1)))
                      .then(b64 => {
                        if (localSegs.length === 0) return []
                        return geminiAnchoredRequest(gmKey, b64, localSegs, lang, dur, addLog)
                      })
                      .then(segTexts => {
                        results[ci] = segTexts.map(s => ({
                          start: t0 + s.start,
                          end:   t0 + s.end,
                          text:  s.text
                        }))
                        gmDone++
                        addLog(`    ✓ chunk ${ci+1} → ${results[ci].length} сег.`, 'dm')
                      })
                      .catch(() => { results[ci] = [] })
                      .finally(() => {
                        active--
                        if (nextCi < chunks.length && !stopFlagRef.current) launch()
                        else if (active === 0) resolve()
                      })
                  }
                  if (active === 0) resolve()
                }
                launch()
              })

              for (const r of results) if (r) segs.push(...r)
              segs = segs.filter(s => s.text)
              segs.sort((a, b) => a.start - b.start)

            } else {
              // ── v10 path ──────────────────────────────────────────────────
              let preChunks = null
              if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
                addLog(`  Pass 1 — Vosk: ищем границы речи...`, 'pu')
                setVoskVisible(true)
                try {
                  preChunks = await getVoskBoundaries(
                    file, voskModelRef.current,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                    addLog
                  )
                  setVoskVisible(false)
                } catch (e) {
                  addLog(`  ⚠ Vosk error: ${e.message}, fallback Smart Silence`, 'wa')
                  setVoskVisible(false)
                }
              }
              segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars, preChunks, addLog,
                t => setProgressText(t), stopFlagRef)
            }

          } else if (p === 'or') {
            let preChunks = null
            if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
              addLog(`  Pass 1 — Vosk: ищем границы...`, 'pu')
              setVoskVisible(true)
              try {
                preChunks = await getVoskBoundaries(
                  file, voskModelRef.current,
                  (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                  addLog
                )
                setVoskVisible(false)
              } catch (e) { setVoskVisible(false) }
            }
            segs = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars,
              preChunks, addLog, t => setProgressText(t), stopFlagRef)
          }

          // Clamp overlapping end times
          segs.sort((a, b) => a.start - b.start)
          for (let i = 0; i < segs.length - 1; i++) {
            if (segs[i].end > segs[i+1].start + 0.05)
              segs[i].end = Math.max(segs[i].start + 0.1, segs[i+1].start - 0.05)
          }

          const suffix = p === 'el' ? '_el' : p === 'or' ? '_or' : '_gm'
          const srtName = file.name.replace(/\.[^.]+$/, '') + suffix + '.srt'
          const srtContent = buildSrt(segs)
          downloadSrt(srtContent, srtName)
          newSrtMap[srtName] = srtContent
          done++
          setProgress(done / total * 100)
          addLog(`  ✓ ${srtName} (${segs.length} сегментов)`, 'ok')

        } catch (e) {
          addLog(`  ✗ ОШИБКА: ${e.message}`, 'er')
          done++
          setProgress(done / total * 100)
        }
      }
    }

    setLastSrtMap(prev => ({ ...prev, ...newSrtMap }))
    setProgress(100)
    setStatusText(`✓ ${done}/${total} файлов`)
    addLog('', '')
    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`  ГОТОВО: ${done}/${total}`, done === total ? 'ok' : 'wa')
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
