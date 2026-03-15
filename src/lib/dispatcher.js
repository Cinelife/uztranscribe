/**
 * dispatcher.js — v14.0.0
 *
 * Изменения vs v12.5.4:
 *   - Новый список моделей: 2.5-flash-lite / 3.1-flash-lite / 2.5-flash / 3-flash
 *   - Новая fallback-логика: selected(×3) → down(×3) → up(×3) → стоп
 *   - Убран classifier (доказано не помогает)
 *   - Упрощён промт: без timestamp-подсказок, без classifier hints
 */

import { sliceToWav, blobToBase64 } from './audioUtils.js'

// ── Список моделей (порядок: дешёвая → дорогая) ──────────────────────────────
export const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-lite',         label: 'Gemini 2.5 Flash Lite', audioIn: 0.50, textIn: 0.10, out: 0.40 },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', audioIn: 0.60, textIn: 0.25, out: 1.50 },
  { id: 'gemini-2.5-flash',              label: 'Gemini 2.5 Flash',      audioIn: 1.00, textIn: 0.30, out: 2.50 },
  { id: 'gemini-3-flash-preview',        label: 'Gemini 3 Flash',        audioIn: 1.00, textIn: 0.50, out: 3.00 },
]

export const GM_DEFAULT_MODEL = GEMINI_MODELS[0].id

/**
 * Fallback цепочка: [selected, down, up]
 * selected → шаг вниз (дешевле) → шаг вверх от selected (дороже)
 * Каждый получает 3 попытки.
 */
function buildFallbackChain(selectedId) {
  const idx = GEMINI_MODELS.findIndex(m => m.id === selectedId)
  if (idx === -1) return [{ id: selectedId, tries: 3 }]
  const chain = [{ id: GEMINI_MODELS[idx].id, tries: 3 }]
  if (idx > 0)                            chain.push({ id: GEMINI_MODELS[idx - 1].id, tries: 3 })
  if (idx < GEMINI_MODELS.length - 1)    chain.push({ id: GEMINI_MODELS[idx + 1].id, tries: 3 })
  return chain
}

const LANG_MAP = {
  uz: 'Uzbek', ru: 'Russian', kk: 'Kazakh', ky: 'Kyrgyz',
  tg: 'Tajik', tk: 'Turkmen', en: 'English', tr: 'Turkish',
}

const PROMPT_LEAK      = /transcribe|segment|json|array|output format|strictly/i
const TIMESTAMP_HALLUC = /^\s*\[?\d{1,2}:\d{2}/

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function fmt(ms)   { return ms >= 1000 ? (ms / 1000).toFixed(1) + 'с' : ms + 'мс' }

function getMaxOutputTokens(chunkSec) {
  if (chunkSec <= 15) return 512
  if (chunkSec <= 25) return 1024
  if (chunkSec <= 40) return 2048
  return 4096
}

function buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow, lang) {
  const n         = segments.length
  const scriptRule = lang === 'uz' ? '- Script: Latin Uzbek only (not Cyrillic).\n' : ''
  const dedupRule  = dedupWindow > 0
    ? '- Repetition is real content, not an error.\n'
    : '- Do NOT repeat text from previous segments.\n'

  return (
    `This ${langName} audio clip contains ${n} speech segment${n > 1 ? 's' : ''}.\n` +
    `Transcribe each segment. Names and proper nouns: write as a native ${langName} speaker would.\n\n` +
    `Rules:\n` +
    scriptRule + dedupRule +
    `- If a segment has any human voice — ALWAYS transcribe the words.\n` +
    `- Silent or music only — return empty string "".\n` +
    `- Output: raw JSON array of EXACTLY ${n} strings, one per segment, in order.\n` +
    `- No timestamps, no markdown, no commentary.\n\n` +
    `Example: ${JSON.stringify(Array(Math.min(n, 3)).fill('...'))}${n > 3 ? ',...' : ''}`
  )
}

async function tryOnce(apiKey, modelId, b64wav, prompt, maxOutputTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`
  const r   = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'audio/wav', data: b64wav } },
        { text: prompt },
      ]}],
      generationConfig: { temperature: 0, maxOutputTokens },
    }),
  })

  if (r.status === 429)                    return { ok: false, status: '429 квота' }
  if (r.status === 503 || r.status === 504) return { ok: false, status: `${r.status} перегружен` }
  if (!r.ok)                               return { ok: false, status: `${r.status} ошибка` }

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

async function callGemini(apiKey, b64wav, segments, langName, chunkDur, chunkSec, dedupWindow, selectedId, lang) {
  const prompt          = buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow, lang)
  const n               = segments.length
  const maxOutputTokens = getMaxOutputTokens(chunkSec)
  const chain           = buildFallbackChain(selectedId)
  const attemptLog      = []

  for (const { id: modelId, tries } of chain) {
    for (let attempt = 0; attempt < tries; attempt++) {
      const t0 = performance.now()
      try {
        const res = await tryOnce(apiKey, modelId, b64wav, prompt, maxOutputTokens)
        const ms  = Math.round(performance.now() - t0)
        if (!res.ok) {
          attemptLog.push({ model: modelId, status: res.status, ms })
          if (res.status === '429 квота') await sleep(2000)
          continue
        }
        const texts = res.parsed
          .map(x => (typeof x === 'string' ? x : (x?.text || '')).trim())
          .map(t => PROMPT_LEAK.test(t) ? '' : t)
          .map(t => TIMESTAMP_HALLUC.test(t) ? '' : t)
          .slice(0, n)
        attemptLog.push({ model: modelId, status: '✓', ms })
        return { texts, model: modelId, log: attemptLog }
      } catch (e) {
        attemptLog.push({ model: modelId, status: `сеть: ${e.message.slice(0, 25)}`, ms: 0 })
      }
    }
  }
  return { texts: [], model: null, log: attemptLog }
}

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
  const maxOut     = getMaxOutputTokens(chunkSec)
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
            const apiT0  = performance.now()

            const res = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec, dedupWindow, gmModel, lang)
            let { texts, model: usedModel, log: attemptLog } = res

            // Fallback: неверное кол-во сегментов → один большой сегмент
            if (texts.length !== n) {
              const res2 = await callGemini(
                apiKey, b64, [{ localStart: 0, localEnd: dur }],
                langName, dur, chunkSec, dedupWindow, gmModel, lang
              )
              attemptLog.push(...res2.log)
              if (res2.texts.length > 0) {
                usedModel = res2.model
                segs.forEach((seg, i) => {
                  allText.set(seg.flagId, i === 0 ? res2.texts[0] : '')
                  if (i === 0) fallbackEnds.set(seg.flagId, chunk.t1)
                })
                const totalMs = Math.round(performance.now() - chunkT0)
                const apiMs   = Math.round(performance.now() - apiT0)
                chunkTimes.push(totalMs)
                done++
                onProgress(`⏳ Gemini: ${done}/${chunks.length}`)
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
            onProgress(`⏳ Gemini: ${done}/${chunks.length}`)
            const ok     = texts.filter(Boolean).length
            const tryStr = attemptLog.map(l => `${l.model.replace('gemini-','').replace('-preview','')}→${l.status}`).join(' ')
            onLog(`    ✓ [${ci + 1}] ${ok}/${n}сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'dm')
          })
          .then(() => { active--; if (nextCi < chunks.length && !stopFlagRef?.current) launch(); else if (active === 0) resolve() })
          .catch(err => {
            onLog(`    ✗ [${ci + 1}] ОШИБКА: ${err?.message || err}`, 'er')
            active--; done++
            if (nextCi < chunks.length && !stopFlagRef?.current) launch(); else if (active === 0) resolve()
          })
      }
      if (active === 0) resolve()
    }
    launch()
  })

  const totalMs = Math.round(performance.now() - dispatchT0)
  const avgMs   = chunkTimes.length ? Math.round(chunkTimes.reduce((a,b) => a+b, 0) / chunkTimes.length) : 0
  const minMs   = chunkTimes.length ? Math.min(...chunkTimes) : 0
  const maxMs   = chunkTimes.length ? Math.max(...chunkTimes) : 0
  const sumMs   = chunkTimes.reduce((a,b) => a+b, 0)
  onLog(`  ⏱ Dispatcher итого: ${fmt(totalMs)} стены | последовательно: ~${fmt(sumMs)}`, 'pu')
  onLog(`  ⏱ Чанки: avg=${fmt(avgMs)} min=${fmt(minMs)} max=${fmt(maxMs)} | ускорение ×${(sumMs/totalMs).toFixed(1)}`, 'pu')

  return { allText, fallbackEnds }
}
