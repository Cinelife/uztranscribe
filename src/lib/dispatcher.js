/**
 * v12.5 Dispatcher — timestamp-based prompt
 * v12.5.1: подробное логирование времени на каждый чанк и суммарно
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest']
const PROMPT_LEAK = /transcribe this|return only|json array|no speech|raw json|markdown/i

function fmt(ms) {
  if (ms < 1000) return `${ms}мс`
  return `${(ms/1000).toFixed(1)}с`
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
    `- Use "" only for completely silent or inaudible segments.\n\n` +
    `Output format — non-negotiable:\n` +
    `- Raw JSON array of EXACTLY ${n} strings, one per segment, in order.\n` +
    `- No skipping, no merging, no extra commentary — only the array.\n\n` +
    `Example: ${JSON.stringify(Array(Math.min(n,3)).fill('...'))}${n>3?',...':''}`
  )
}

async function callGemini(apiKey, b64wav, segments, langName, chunkDur, chunkSec, dedupWindow) {
  const prompt = buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow)
  const n      = segments.length

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
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
      if (r.status === 429) { await sleep(3000); continue }
      if (!r.ok) continue

      const d   = await r.json()
      const raw = (d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim()
      if (!raw) continue

      let parsed
      try {
        let s = raw
        if (s.includes('```')) { s = s.split('```')[1]||''; if (s.startsWith('json')) s = s.slice(4) }
        parsed = JSON.parse(s.trim())
      } catch (_) {
        const m = raw.match(/\[[\s\S]*\]/)
        if (m) try { parsed = JSON.parse(m[0]) } catch (_) { continue }
        else continue
      }
      if (!Array.isArray(parsed)) continue

      const texts = parsed
        .map(x => (typeof x === 'string' ? x : (x?.text || '')).trim())
        .map(t => PROMPT_LEAK.test(t) ? '' : t)
        .slice(0, n)

      return { texts, model }
    } catch (_) { continue }
  }
  return { texts: [], model: '?' }
}

export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang, chunkSec, dedupWindow = 12,
  onLog, onProgress, stopFlagRef,
  concurrency = 8
}) {
  const langName   = LANG_MAP[lang] || lang
  const allText    = new Map()
  const fallbackEnds = new Map()
  let done = 0

  const staggerMs  = Math.max(100, Math.floor(300 / concurrency * 3))
  const dispatchT0 = performance.now()

  // Счётчики для суммарной статистики
  const chunkTimes = []  // массив времён каждого чанка в мс

  onLog(`  ⏱ Dispatcher: ${chunks.length} чанков × ${concurrency} параллельно`, 'dm')

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

            let texts = [], usedModel = '?', attempts = 0

            const apiT0 = performance.now()
            for (let att = 1; att <= 3; att++) {
              attempts = att
              const res = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec, dedupWindow)
              texts = res.texts; usedModel = res.model
              if (texts.length === n) break
              if (att < 3) {
                if (att === 2) {
                  const fallbackSegs = [{ localStart: 0, localEnd: dur }]
                  const res2 = await callGemini(apiKey, b64, fallbackSegs, langName, dur, chunkSec, dedupWindow)
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
                    onLog(`    ✓ [${ci+1}] fallback→1сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${usedModel}`, 'wa')
                    return
                  }
                }
                await sleep(1500)
              }
            }
            const apiMs   = Math.round(performance.now() - apiT0)
            const totalMs = Math.round(performance.now() - chunkT0)
            chunkTimes.push(totalMs)

            segs.forEach((seg, i) => allText.set(seg.flagId, texts[i] || ''))
            done++
            onProgress(`⏳ Gemini: ${done}/${chunks.length}`)

            const ok = texts.filter(Boolean).length
            const attStr = attempts > 1 ? ` ×${attempts}попыток` : ''
            onLog(`    ✓ [${ci+1}] ${ok}/${n}сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)}${attStr} | ${usedModel}`, 'dm')
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
