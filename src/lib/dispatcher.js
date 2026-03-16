/**
 * dispatcher.js — v14.1.0
 *
 * Два режима:
 *   1. dispatchChunks()     — v12 Flags путь (без изменений, RMS сегменты → чанки)
 *   2. dispatchMultiAudio() — Silero VAD путь (каждый micro-segment = отдельный WAV)
 *
 * Multi-audio архитектура (dispatchMultiAudio):
 *   - Каждый сегмент Silero → отдельный inline_data в одном запросе
 *   - Нет timestamp hints в промте — не нужны, физические границы WAV
 *   - Таймкод = граница Silero → дрифт физически невозможен
 *   - Пакеты до BATCH_SIZE сегментов (Gemini лимит ~20 inline_data)
 *   - Параллельная отправка пакетов
 */

import { sliceToWav, blobToBase64 } from './audioUtils.js'

// ── Список моделей ─────────────────────────────────────────────────────────────
export const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-lite',         label: 'Gemini 2.5 Flash Lite', audioIn: 0.50, textIn: 0.10, out: 0.40 },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', audioIn: 0.60, textIn: 0.25, out: 1.50 },
  { id: 'gemini-2.5-flash',              label: 'Gemini 2.5 Flash',      audioIn: 1.00, textIn: 0.30, out: 2.50 },
  { id: 'gemini-3-flash-preview',        label: 'Gemini 3 Flash',        audioIn: 1.00, textIn: 0.50, out: 3.00 },
]

export const GM_DEFAULT_MODEL = GEMINI_MODELS[0].id

// Fallback: selected(×3) → down(×3) → up(×3)
function buildFallbackChain(selectedId) {
  const idx = GEMINI_MODELS.findIndex(m => m.id === selectedId)
  if (idx === -1) return [{ id: selectedId, tries: 3 }]
  const chain = [{ id: GEMINI_MODELS[idx].id, tries: 3 }]
  if (idx > 0)                           chain.push({ id: GEMINI_MODELS[idx - 1].id, tries: 3 })
  if (idx < GEMINI_MODELS.length - 1)   chain.push({ id: GEMINI_MODELS[idx + 1].id, tries: 3 })
  return chain
}

const LANG_MAP = {
  uz: 'Uzbek', ru: 'Russian', kk: 'Kazakh', ky: 'Kyrgyz',
  tg: 'Tajik', tk: 'Turkmen', en: 'English', tr: 'Turkish',
}

const PROMPT_LEAK      = /transcribe this|return only|json array|no speech|raw json|markdown/i
const TIMESTAMP_HALLUC = /^\s*\[?\d{1,2}:\d{2}/

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function fmt(ms)   { return ms >= 1000 ? (ms / 1000).toFixed(1) + 'с' : ms + 'мс' }

function getMaxOutputTokens(n) {
  // n = кол-во сегментов в пакете
  if (n <= 5)  return 512
  if (n <= 10) return 1024
  if (n <= 18) return 2048
  return 4096
}

// ── Промт для v12 Flags (с временными метками) ───────────────────────────────
function buildV12Prompt(segments, langName, chunkDur, chunkSec, dedupWindow, lang) {
  const n    = segments.length
  const list = segments.map((s, i) =>
    `  ${i + 1}. ${s.localStart.toFixed(2)}s – ${s.localEnd.toFixed(2)}s`
  ).join('\n')
  const dedupRule = dedupWindow > 0
    ? '- If audio repeats a phrase — transcribe it again. Repetition is real content, not an error.\n'
    : '- Do NOT repeat text from previous segments — transcribe only what you hear in THIS clip.\n'

  return (
    `Transcribe this ${langName} audio clip (${chunkDur.toFixed(1)}s).\n\n` +
    `It has ${n} speech segment(s) at these time ranges:\n` +
    list + '\n\n' +
    `Transcription rules:\n` +
    `- Use full linguistic intelligence: interpret abbreviations, names, terminology correctly.\n` +
    dedupRule +
    (lang === 'uz' ? '- Script: Latin Uzbek only (not Cyrillic).\n' : '') +
    `- Use "" only for completely silent or inaudible segments.\n\n` +
    `Output format — non-negotiable:\n` +
    `- Raw JSON array of EXACTLY ${n} strings, one per segment, in order.\n` +
    `- No skipping, no merging, no extra commentary — only the array.\n\n` +
    `Example: ${JSON.stringify(Array(Math.min(n, 3)).fill('...'))}${n > 3 ? ',...' : ''}`
  )
}

// ── Промт для Multi-audio (без timestamp hints) ───────────────────────────────
function buildMultiAudioPrompt(n, langName, lang) {
  return (
    `You have received ${n} separate ${langName} audio file${n > 1 ? 's' : ''}, numbered in order.\n` +
    `Transcribe each audio file SEPARATELY.\n\n` +
    `Rules:\n` +
    `- Use full linguistic intelligence: names, abbreviations, terminology.\n` +
    (lang === 'uz' ? '- Script: Latin Uzbek only (not Cyrillic).\n' : '') +
    `- If a file contains only music or silence — return "".\n\n` +
    `Return ONLY a raw JSON array of EXACTLY ${n} strings, one per file, in order.\n` +
    `No timestamps, no explanation, no markdown.\n\n` +
    `Example: ${JSON.stringify(Array(Math.min(n, 3)).fill('...'))}${n > 3 ? ',...' : ''}`
  )
}

// ── Один вызов API ────────────────────────────────────────────────────────────
async function tryOnce(apiKey, modelId, parts, maxOutputTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`
  const r   = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, maxOutputTokens },
    }),
  })

  if (r.status === 429)                     return { ok: false, status: '429 квота' }
  if (r.status === 503 || r.status === 504) return { ok: false, status: `${r.status} перегружен` }
  if (!r.ok)                                return { ok: false, status: `${r.status} ошибка` }

  const d   = await r.json()
  const raw = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim()
  if (!raw) return { ok: false, status: 'пустой ответ' }

  let parsed
  try {
    let s = raw
    if (s.includes('```')) { s = s.split('```')[1] || ''; if (s.startsWith('json')) s = s.slice(4) }
    parsed = JSON.parse(s.trim())
  } catch (_) {
    const m = raw.match(/\[[\s\S]*\]/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch (_) { return { ok: false, status: 'JSON err' } } }
    else return { ok: false, status: 'JSON err' }
  }
  if (!Array.isArray(parsed)) return { ok: false, status: 'не массив' }
  return { ok: true, parsed }
}

// ── callWithFallback — selected → down → up ───────────────────────────────────
async function callWithFallback(apiKey, selectedId, parts, maxOutputTokens) {
  const chain      = buildFallbackChain(selectedId)
  const attemptLog = []

  for (const { id: modelId, tries } of chain) {
    for (let attempt = 0; attempt < tries; attempt++) {
      const t0 = performance.now()
      try {
        const res = await tryOnce(apiKey, modelId, parts, maxOutputTokens)
        const ms  = Math.round(performance.now() - t0)
        if (!res.ok) {
          attemptLog.push({ model: modelId, status: res.status, ms })
          if (res.status === '429 квота') await sleep(2000)
          continue
        }
        attemptLog.push({ model: modelId, status: '✓', ms })
        return { parsed: res.parsed, model: modelId, log: attemptLog }
      } catch (e) {
        attemptLog.push({ model: modelId, status: `сеть: ${e.message.slice(0, 25)}`, ms: 0 })
      }
    }
  }
  return { parsed: null, model: null, log: attemptLog }
}

// ════════════════════════════════════════════════════════════════════════════
// ── dispatchMultiAudio — Silero VAD путь ─────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
/**
 * Каждый Silero micro-segment → отдельный WAV inline_data в одном запросе.
 * Пакеты по batchSize сегментов (≤20 для стабильности Gemini).
 *
 * @param {Object} params
 * @param {AudioBuffer} params.audioBuf
 * @param {Array<{flagId, start, end, type}>} params.segments — только speech
 * @param {Array<Array>} params.batches — сгруппированные пакеты
 * @param {string} params.apiKey
 * @param {string} params.lang
 * @param {string} params.gmModel
 * @param {number} params.concurrency
 * @param {function} params.onLog
 * @param {function} params.onProgress
 * @param {Object} params.stopFlagRef
 * @returns {{ textMap: Map<flagId, string> }}
 */
export async function dispatchMultiAudio({
  audioBuf, segments, batches,
  apiKey, lang, gmModel = GM_DEFAULT_MODEL,
  concurrency = 6,
  onLog, onProgress, stopFlagRef,
}) {
  const langName = LANG_MAP[lang] || lang
  const textMap  = new Map()
  let done = 0

  const modelLabel = GEMINI_MODELS.find(m => m.id === gmModel)?.label || gmModel
  onLog(`  ⏱ Dispatcher multi-audio: ${segments.length} сег → ${batches.length} пакетов × ${concurrency} | ${modelLabel}`, 'dm')

  const dispatchT0 = performance.now()
  const batchTimes = []

  await new Promise(resolve => {
    let active = 0, nextBi = 0

    function launch() {
      while (active < concurrency && nextBi < batches.length) {
        if (stopFlagRef?.current) break
        const bi    = nextBi++
        const batch = batches[bi]
        const n     = batch.length
        active++

        ;(async () => {
          const batchT0 = performance.now()
          onLog(`    ⟳ [пакет ${bi + 1}/${batches.length}] ${n} сег | ${batch[0].start.toFixed(1)}–${batch[n-1].end.toFixed(1)}с`, 'dm')

          // 1. Нарезаем WAV для каждого сегмента
          const prepT0 = performance.now()
          const wavParts = []
          for (const seg of batch) {
            const wav = sliceToWav(audioBuf, seg.start, seg.end)
            const b64 = await blobToBase64(wav)
            wavParts.push({ inline_data: { mime_type: 'audio/wav', data: b64 } })
          }
          const prepMs = Math.round(performance.now() - prepT0)

          // 2. Промт + parts = [wav1, wav2, ..., wavN, text]
          const prompt = buildMultiAudioPrompt(n, langName, lang)
          const parts  = [...wavParts, { text: prompt }]
          const maxOut = getMaxOutputTokens(n)

          // 3. Отправляем
          const apiT0 = performance.now()
          const res   = await callWithFallback(apiKey, gmModel, parts, maxOut)
          const apiMs = Math.round(performance.now() - apiT0)
          const totalMs = Math.round(performance.now() - batchT0)
          batchTimes.push(totalMs)

          const tryStr = res.log.map(l =>
            `${l.model.replace('gemini-','').replace('-preview','')}→${l.status}`
          ).join(' ')

          if (!res.parsed) {
            onLog(`    ✗ [пакет ${bi + 1}] FAILED | prep:${fmt(prepMs)} api:${fmt(apiMs)} | ${tryStr}`, 'er')
            // Пустые строки для всех сегментов пакета
            batch.forEach(seg => textMap.set(seg.flagId, ''))
          } else {
            // Zip parsed[i] → batch[i].flagId
            batch.forEach((seg, i) => {
              const raw  = res.parsed[i]
              const text = (typeof raw === 'string' ? raw : (raw?.text || '')).trim()
              const clean = PROMPT_LEAK.test(text) ? '' : (TIMESTAMP_HALLUC.test(text) ? '' : text)
              textMap.set(seg.flagId, clean)
            })
            const ok = res.parsed.filter(Boolean).length
            onLog(`    ✓ [пакет ${bi + 1}] ${ok}/${n}сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'dm')
          }

          done++
          onProgress && onProgress(`⏳ Silero dispatch: ${done}/${batches.length}`)
        })()
          .then(() => { active--; if (nextBi < batches.length && !stopFlagRef?.current) launch(); else if (active === 0) resolve() })
          .catch(err => {
            onLog(`    ✗ [пакет ${bi + 1}] ОШИБКА: ${err?.message || err}`, 'er')
            batches[bi].forEach(seg => textMap.set(seg.flagId, ''))
            active--; done++
            if (nextBi < batches.length && !stopFlagRef?.current) launch(); else if (active === 0) resolve()
          })
      }
      if (active === 0) resolve()
    }
    launch()
  })

  const totalMs = Math.round(performance.now() - dispatchT0)
  const avgMs   = batchTimes.length ? Math.round(batchTimes.reduce((a,b)=>a+b,0)/batchTimes.length) : 0
  onLog(`  ⏱ Multi-audio итого: ${fmt(totalMs)} | пакетов:${batches.length} avg:${fmt(avgMs)}`, 'pu')

  return { textMap }
}

// ════════════════════════════════════════════════════════════════════════════
// ── dispatchChunks — v12 Flags путь (без изменений) ──────────────────────────
// ════════════════════════════════════════════════════════════════════════════
export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang, chunkSec, dedupWindow = 0,
  onLog, onProgress, stopFlagRef,
  concurrency = 6,
  gmModel     = GM_DEFAULT_MODEL,
}) {
  const langName     = LANG_MAP[lang] || lang
  const allText      = new Map()
  const fallbackEnds = new Map()
  let done = 0

  const staggerMs  = Math.max(100, Math.floor(300 / concurrency * 3))
  const dispatchT0 = performance.now()
  const chunkTimes = []
  const maxOut     = chunkSec >= 25 ? 1024 : 512
  const modelLabel = GEMINI_MODELS.find(m => m.id === gmModel)?.label || gmModel

  onLog(`  ⏱ Dispatcher: ${chunks.length} чанков × ${concurrency} | модель: ${modelLabel} | maxOut:${maxOut}`, 'dm')

  await new Promise(resolve => {
    let active = 0, nextCi = 0
    function launch() {
      while (active < concurrency && nextCi < chunks.length) {
        if (stopFlagRef?.current) break
        const ci    = nextCi++
        const chunk = chunks[ci]
        const segs  = chunk.segments
        const n     = segs.length
        const t0    = chunk.t0
        const dur   = chunk.t1 - t0
        active++

        const localSegs = segs.map(s => ({
          localStart: parseFloat((s.start - t0).toFixed(2)),
          localEnd:   parseFloat((s.end   - t0).toFixed(2)),
        }))

        sleep(ci % concurrency * staggerMs)
          .then(async () => {
            const chunkT0 = performance.now()
            onLog(`    ⟳ [${ci + 1}/${chunks.length}] ${t0.toFixed(1)}–${chunk.t1.toFixed(1)}с (${n} сег)`, 'dm')

            const prepT0 = performance.now()
            const wav    = sliceToWav(audioBuf, t0, chunk.t1)
            const b64    = await blobToBase64(wav)
            const prepMs = Math.round(performance.now() - prepT0)

            const prompt  = buildV12Prompt(localSegs, langName, dur, chunkSec, dedupWindow, lang)
            const parts   = [
              { inline_data: { mime_type: 'audio/wav', data: b64 } },
              { text: prompt },
            ]
            const apiT0 = performance.now()
            const res   = await callWithFallback(apiKey, gmModel, parts, maxOut)
            let { parsed, model: usedModel, log: attemptLog } = res
            let texts = parsed
              ? parsed.map(x => (typeof x === 'string' ? x : (x?.text || '')).trim())
                  .map(t => PROMPT_LEAK.test(t) ? '' : t)
                  .map(t => TIMESTAMP_HALLUC.test(t) ? '' : t)
                  .slice(0, n)
              : []

            // Fallback: неверное кол-во
            if (texts.length !== n) {
              const fallbackParts = [
                { inline_data: { mime_type: 'audio/wav', data: b64 } },
                { text: buildV12Prompt([{ localStart: 0, localEnd: dur }], langName, dur, chunkSec, dedupWindow, lang) },
              ]
              const res2 = await callWithFallback(apiKey, gmModel, fallbackParts, maxOut)
              attemptLog.push(...res2.log)
              if (res2.parsed?.length > 0) {
                usedModel = res2.model
                segs.forEach((seg, i) => {
                  allText.set(seg.flagId, i === 0 ? (res2.parsed[0] || '') : '')
                  if (i === 0) fallbackEnds.set(seg.flagId, chunk.t1)
                })
                const totalMs = Math.round(performance.now() - chunkT0)
                const apiMs   = Math.round(performance.now() - apiT0)
                chunkTimes.push(totalMs)
                done++
                onProgress && onProgress(`⏳ Gemini: ${done}/${chunks.length}`)
                const tryStr = attemptLog.map(l => `${l.model.replace('gemini-','').replace('-preview','')}→${l.status}`).join(' ')
                onLog(`    ✓ [${ci + 1}] fallback→1сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'wa')
                return
              }
            }

            const apiMs   = Math.round(performance.now() - apiT0)
            const totalMs = Math.round(performance.now() - chunkT0)
            chunkTimes.push(totalMs)
            segs.forEach((seg, i) => allText.set(seg.flagId, texts[i] || ''))
            done++
            onProgress && onProgress(`⏳ Gemini: ${done}/${chunks.length}`)
            const ok     = texts.filter(Boolean).length
            const tryStr = attemptLog.map(l => `${l.model.replace('gemini-','').replace('-preview','')}→${l.status}`).join(' ')
            onLog(`    ✓ [${ci + 1}] ${ok}/${n}сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'dm')
          })
          .then(() => { active--; if (nextCi < chunks.length && !stopFlagRef?.current) launch(); else if (active === 0) resolve() })
          .catch(err => {
            onLog(`    ✗ [${ci + 1}] ОШИБКА dispatcher: ${err?.message || err}`, 'er')
            active--; done++
            if (nextCi < chunks.length && !stopFlagRef?.current) launch(); else if (active === 0) resolve()
          })
      }
      if (active === 0) resolve()
    }
    launch()
  })

  const totalMs = Math.round(performance.now() - dispatchT0)
  const avgMs   = chunkTimes.length ? Math.round(chunkTimes.reduce((a,b)=>a+b,0)/chunkTimes.length) : 0
  const minMs   = chunkTimes.length ? Math.min(...chunkTimes) : 0
  const maxMs   = chunkTimes.length ? Math.max(...chunkTimes) : 0
  const sumMs   = chunkTimes.reduce((a,b)=>a+b,0)
  onLog(`  ⏱ Dispatcher итого: ${fmt(totalMs)} стены | последовательно: ~${fmt(sumMs)}`, 'pu')
  onLog(`  ⏱ Чанки: avg=${fmt(avgMs)} min=${fmt(minMs)} max=${fmt(maxMs)} | ускорение ×${sumMs > 0 ? (sumMs/totalMs).toFixed(1) : '?'}`, 'pu')

  return { allText, fallbackEnds }
}
