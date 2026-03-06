import { useRef, useState, useCallback } from 'react'
import { transcribeEL }     from '../lib/elevenlabs.js'
import { transcribeGemini, geminiAnchoredRequest } from '../lib/gemini.js'
import { transcribeOpenRouter } from '../lib/openrouter.js'
import { buildSrt, downloadSrt } from '../lib/srtUtils.js'
import { decodeAudio, buildSmartChunks, sliceToWav, blobToBase64,
         groupWordsByPauses, sleep } from '../lib/audioUtils.js'
import { getVoskBoundaries, getVoskAllWords } from '../lib/vosk.js'

// ── In-memory cache: file fingerprint → allWords array ───────────────────────
const voskWordCache = new Map()
function cacheKey(file) { return `${file.name}::${file.size}::${file.lastModified}` }

// Vosk is ~real-time in WASM. Warn user for long files.
const VOSK_WARN_SECONDS = 20 * 60 // 20 min

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

    const isV11 = (prov === 'gm' || prov === 'bo') && timingMode === 'vosk'
                  && voskReady && voskModelRef?.current

    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`Файлов: ${files.length} | Провайдер: ${prov.toUpperCase()} | Язык: ${lang}`, 'in')
    addLog(`Символов на строку: ${maxChars}`, 'dm')
    if (isV11) addLog(`Vosk v11 anchor-prompt: ✓ активен`, 'pu')
    else if (timingMode === 'vosk' && voskReady) addLog(`Vosk 2-pass: ✓ активен`, 'ok')
    addLog('══════════════════════════════════════════════', 'dm')

    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlagRef.current) break
      const file = files[fi]
      const providers = prov === 'bo' ? ['el', 'gm'] : [prov]

      for (const p of providers) {
        if (stopFlagRef.current) break
        addLog(`[${fi+1}/${files.length}] ${file.name} (${p==='el'?'ElevenLabs':p==='gm'?'Gemini':'OpenRouter'})`, 'in')

        try {
          let segs = []

          if (p === 'el') {
            segs = await transcribeEL(file, elKey, lang, maxChars, addLog)

          } else if (p === 'gm') {
            if (isV11) {
              // ── v11 pipeline ──────────────────────────────────────────────
              const ab = await decodeAudio(file)
              const fileDuration = ab.duration
              const chunks = buildSmartChunks(ab, chunkSec)

              // Check cache first
              const ck = cacheKey(file)
              let allWords = voskWordCache.get(ck) || null

              if (allWords) {
                addLog(`  Vosk: кеш ✓ (${allWords.length} слов, повторное декодирование не нужно)`, 'ok')
              } else {
                // Warn for long files
                if (fileDuration > VOSK_WARN_SECONDS) {
                  const mins = Math.round(fileDuration / 60)
                  addLog(`  ⚠ Vosk для ${mins}-мин файла займёт ~${mins} мин (WASM реалтайм)`, 'wa')
                  addLog(`  💡 Для длинных файлов рекомендуется Smart Silence (без Vosk)`, 'wa')
                }

                addLog(`  Phase 1 — Vosk: весь файл → слова...`, 'pu')
                setVoskVisible(true)

                try {
                  allWords = await getVoskAllWords(
                    file, voskModelRef.current,
                    (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                    addLog
                  )
                  if (allWords.length > 0) {
                    voskWordCache.set(ck, allWords) // ← кешируем!
                    addLog(`  Phase 1 ✓ — ${allWords.length} слов (сохранено в кеш)`, 'ok')
                  } else {
                    addLog(`  ⚠ Vosk: 0 слов — fallback на Smart Silence`, 'wa')
                  }
                } catch (e) {
                  addLog(`  ⚠ Vosk ошибка: ${e.message} — fallback`, 'wa')
                  allWords = []
                }
                setVoskVisible(false)
              }

              // Map words → per-chunk anchor segments
              const chunkAnchors = chunks.map(({ t0, t1 }) => {
                const chunkWords = allWords.filter(w => w.start >= t0 - 0.1 && w.end <= t1 + 0.1)
                if (chunkWords.length > 0) {
                  return groupWordsByPauses(chunkWords, 0.3, 7.0)
                    .map(s => ({ start: s.start, end: s.end }))
                }
                // Fallback: split into ~5s pieces
                const pieces = []
                for (let t = t0; t < t1; t += 5)
                  pieces.push({ start: t, end: Math.min(t + 5, t1) })
                return pieces
              })

              const totalAnchors = chunkAnchors.reduce((s, a) => s + a.length, 0)
              addLog(`  Phase 2 — Gemini anchor: ${chunks.length} запросов, ${totalAnchors} якорей...`, 'gm-cl')

              const results = new Array(chunks.length)
              const CONCURRENCY = 3

              await new Promise(resolve => {
                let active = 0, nextCi = 0
                function launch() {
                  while (active < CONCURRENCY && nextCi < chunks.length) {
                    if (stopFlagRef.current) break
                    const ci = nextCi++
                    active++
                    const { t0, t1 } = chunks[ci]
                    const dur = t1 - t0
                    const localAnchors = chunkAnchors[ci].map((s, idx) => ({
                      id:    idx + 1,
                      start: parseFloat((s.start - t0).toFixed(3)),
                      end:   parseFloat((s.end   - t0).toFixed(3))
                    }))
                    sleep(ci % CONCURRENCY * 400)
                      .then(() => blobToBase64(sliceToWav(ab, t0, t1)))
                      .then(b64 => geminiAnchoredRequest(gmKey, b64, localAnchors, lang, dur, addLog))
                      .then(segTexts => {
                        results[ci] = segTexts.map(s => ({
                          start: t0 + s.start, end: t0 + s.end, text: s.text
                        }))
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
              segs = await transcribeGemini(file, gmKey, lang, chunkSec, maxChars, preChunks,
                addLog, t => setProgressText(t), stopFlagRef)
            }

          } else if (p === 'or') {
            let preChunks = null
            if (timingMode === 'vosk' && voskReady && voskModelRef?.current) {
              addLog(`  Pass 1 — Vosk: ищем границы...`, 'pu')
              setVoskVisible(true)
              try {
                preChunks = await getVoskBoundaries(
                  file, voskModelRef.current, addLog,
                  (pct, txt) => { setVoskPct(pct); setVoskText(txt) },
                  () => setVoskVisible(false), stopFlagRef
                )
              } catch (e) { setVoskVisible(false) }
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

          const suffix = p==='el'?'_el':p==='or'?'_or':'_gm'
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
    addLog(`  ГОТОВО: ${done}/${total}`, done===total?'ok':'wa')
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
