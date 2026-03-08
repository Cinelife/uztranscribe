/**
 * v12.5.1 Dispatcher — timestamp-based prompt
 * - Основная модель выбирается пользователем (gmModel)
 * - Fallback-цепочка из GM_MODELS[selected].fallback
 * - Детальный лог каждой попытки: модель → статус/ошибка
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'
import { GM_MODELS } from './gemini.js'

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }
const PROMPT_LEAK = /transcribe this|return only|json array|no speech|raw json|markdown/i
// Галлюцинации — Gemini копирует временны́е метки из промпта вместо текста
const TIMESTAMP_HALLUC = /^[\d]{1,2}:[\d]{2}(\s+[\d]{1,2}:[\d]{2})*\s*$/

function fmt(ms) {
  if (ms < 1000) return `${ms}мс`
  return `${(ms/1000).toFixed(1)}с`
}

// Строим цепочку: выбранная модель + её fallback
function buildModelChain(primaryId) {
  const found = GM_MODELS.find(m => m.id === primaryId)
  if (!found) return [primaryId]
  return [primaryId, ...(found.fallback || [])]
}

async function callGemini(apiKey, b64wav, segments, langName, chunkDur, chunkSec, dedupWindow, primaryId) {
  const prompt = buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow)
  const n      = segments.length
  const chain  = buildModelChain(primaryId)
  const log    = []   // [{model, status, ms}]

  for (const model of chain) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    const t0  = performance.now()
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: 'audio/wav', data: b64wav } },
            { text: prompt }
          ]}],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 }
        })
      })
      const ms = Math.round(performance.now() - t0)

      if (r.status === 429) {
        log.push({ model, status: '429 квота', ms })
        await sleep(2000)
        continue
      }
      if (r.status === 503 || r.status === 504) {
        log.push({ model, status: `${r.status} перегружен`, ms })
        continue
      }
      if (!r.ok) {
        log.push({ model, status: `${r.status} ошибка`, ms })
        continue
      }

      const d   = await r.json()
      const raw = (d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim()
      if (!raw) {
        log.push({ model, status: 'пустой ответ', ms })
        continue
      }

      let parsed
      try {
        let s = raw
        if (s.includes('```')) { s = s.split('```')[1]||''; if (s.startsWith('json')) s = s.slice(4) }
        parsed = JSON.parse(s.trim())
      } catch (_) {
        const m = raw.match(/\[[\s\S]*\]/)
        if (m) try { parsed = JSON.parse(m[0]) } catch (_) { log.push({ model, status: 'JSON err', ms }); continue }
        else { log.push({ model, status: 'JSON err', ms }); continue }
      }
      if (!Array.isArray(parsed)) { log.push({ model, status: 'не массив', ms }); continue }

      const texts = parsed
        .map(x => (typeof x === 'string' ? x : (x?.text || '')).trim())
        .map(t => PROMPT_LEAK.test(t) ? '' : t)
        .map(t => TIMESTAMP_HALLUC.test(t) ? '' : t)
        .slice(0, n)

      log.push({ model, status: '✓', ms })
      return { texts, model, log }
    } catch (e) {
      const ms = Math.round(performance.now() - t0)
      log.push({ model, status: `сеть: ${e.message.slice(0,25)}`, ms })
      continue
    }
  }
  return { texts: [], model: null, log }
}

function buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow) {
  const n    = segments.length
  const list = segments.map((s, i) =>
    `  ${i+1}. ${s.localStart.toFixed(2)}s – ${s.localEnd.toFixed(2)}s`
  ).join('\n')

  return (
    `Transcribe this ${langName} audio clip (${chunkDur.toFixed(1)}s, chunk: ${chunkSec}s).\n\n` +
    `It has ${n} speech segment(s) at these time ranges:\n` +
    `${list}\n\n` +
    `Transcription rules:\n` +
    `- Use full linguistic intelligence: interpret abbreviations, names, terminology correctly.\n` +
    (dedupWindow === 0
      ? `- If audio repeats a phrase or chorus — transcribe it again. Repetition is real content, not an error.\n`
      : `- Do NOT repeat text from previous segments — transcribe only what you hear in THIS clip.\n`) +
    `- Use "" for: completely silent segments, background music, intro/outro music, sound effects, or any segment with NO clear human speech.\\n\\n` +
    `Output format — non-negotiable:\n` +
    `- Raw JSON array of EXACTLY ${n} strings, one per segment, in order.\n` +
    `- No skipping, no merging, no extra commentary — only the array.\n\n` +
    `Example: ${JSON.stringify(Array(Math.min(n,3)).fill('...'))}${n>3?',...':''}`
  )
}


export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang, chunkSec, dedupWindow = 12,
  onLog, onProgress, stopFlagRef,
  concurrency = 8,
  gmModel = 'gemini-2.0-flash'   // v12.5.1: выбранная пользователем модель
}) {
  const langName   = LANG_MAP[lang] || lang
  const allText    = new Map()
  const fallbackEnds = new Map()
  let done = 0

  const staggerMs  = Math.max(100, Math.floor(300 / concurrency * 3))
  const dispatchT0 = performance.now()

  // Счётчики для суммарной статистики
  const chunkTimes = []  // массив времён каждого чанка в мс

  const chain = buildModelChain(gmModel)
  onLog(`  ⏱ Dispatcher: ${chunks.length} чанков × ${concurrency} параллельно | основная: ${gmModel}`, 'dm')

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
          localEnd:   parseFloat((s.end   - t0).toFixed(2))
        }))

        const chunkT0 = performance.now()

        sleep(ci % concurrency * staggerMs)
          .then(async () => {
            onLog(`    ⟳ [${ci+1}/${chunks.length}] ${t0.toFixed(1)}–${chunk.t1.toFixed(1)}с (${n} сег)`, 'dm')

            const prepT0 = performance.now()
            const wav    = sliceToWav(audioBuf, t0, chunk.t1)
            const b64    = await blobToBase64(wav)
            const prepMs = Math.round(performance.now() - prepT0)

            let texts = [], usedModel = '?', attemptLog = []

            const apiT0 = performance.now()
            // Попытка 1: с правильными сегментами
            const res = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec, dedupWindow, gmModel)
            texts = res.texts; usedModel = res.model; attemptLog = res.log

            // Попытка 2 (fallback): один общий сегмент
            if (texts.length !== n) {
              const fallbackSegs = [{ localStart: 0, localEnd: dur }]
              const res2 = await callGemini(apiKey, b64, fallbackSegs, langName, dur, chunkSec, dedupWindow, gmModel)
              attemptLog.push(...res2.log)
              if (res2.texts.length > 0) {
                usedModel = res2.model
                const fullText = res2.texts[0]
                segs.forEach((seg, i) => {
                  allText.set(seg.flagId, i === 0 ? fullText : '')
                  if (i === 0) fallbackEnds.set(seg.flagId, chunk.t1)
                })
                const totalMs = Math.round(performance.now() - chunkT0)
                const apiMs   = Math.round(performance.now() - apiT0)
                chunkTimes.push(totalMs)
                done++
                onProgress(`⏳ Gemini: ${done}/${chunks.length}`)
                // Лог попыток
                const tryStr = attemptLog.map(l => `${l.model.replace('gemini-','').replace('-latest','')}→${l.status}`).join(' | ')
                onLog(`    ✓ [${ci+1}] fallback→1сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'wa')
                return
              }
            }
            const apiMs   = Math.round(performance.now() - apiT0)
            const totalMs = Math.round(performance.now() - chunkT0)
            chunkTimes.push(totalMs)

            segs.forEach((seg, i) => allText.set(seg.flagId, texts[i] || ''))
            done++
            onProgress(`⏳ Gemini: ${done}/${chunks.length}`)

            const ok = texts.filter(Boolean).length
            // Детальный лог: каждая модель и её статус
            const tryStr = attemptLog.map(l => `${l.model.replace('gemini-','').replace('-latest','')}→${l.status}`).join(' | ')
            onLog(`    ✓ [${ci+1}] ${ok}/${n}сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'dm')
          })
          .then(() => {
            active--
            if (nextCi < chunks.length && !stopFlagRef?.current) launch()
            else if (active === 0) resolve()
          })
          .catch(() => {
            active--
            done++
            if (nextCi < chunks.length && !stopFlagRef?.current) launch()
            else if (active === 0) resolve()
          })
      }
      if (active === 0) resolve()
    }
    launch()
  })

  // ── Суммарная статистика Dispatcher ──────────────────────────────────────
  const totalMs  = Math.round(performance.now() - dispatchT0)
  const avgMs    = chunkTimes.length ? Math.round(chunkTimes.reduce((a,b)=>a+b,0)/chunkTimes.length) : 0
  const minMs    = chunkTimes.length ? Math.min(...chunkTimes) : 0
  const maxMs    = chunkTimes.length ? Math.max(...chunkTimes) : 0
  const sumMs    = chunkTimes.reduce((a,b)=>a+b,0)
  onLog(`  ⏱ Dispatcher итого: ${fmt(totalMs)} стены | последовательно было бы ~${fmt(sumMs)}`, 'pu')
  onLog(`  ⏱ Чанки: avg=${fmt(avgMs)} min=${fmt(minMs)} max=${fmt(maxMs)} | ускорение ×${(sumMs/totalMs).toFixed(1)}`, 'pu')

  return { allText, fallbackEnds }
}
