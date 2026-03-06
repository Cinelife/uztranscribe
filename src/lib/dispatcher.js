/**
 * v12 Dispatcher — timestamp-based prompt
 * Gemini receives: audio chunk + exact time ranges per segment
 * Returns: array of strings, one per segment
 * No hallucination: Gemini listens to specific time window, not guessing
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest']
const PROMPT_LEAK = /transcribe this|return only|json array|no speech|raw json|markdown/i

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
          generationConfig: { temperature: 0, maxOutputTokens: 2048 }
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

      // Normalize: strings only, filter prompt leaks
      const texts = parsed
        .map(x => (typeof x === 'string' ? x : (x?.text || '')).trim())
        .map(t => PROMPT_LEAK.test(t) ? '' : t)
        .slice(0, n)

      return texts
    } catch (_) { continue }
  }
  return []
}

export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang, chunkSec, dedupWindow = 12,
  onLog, onProgress, stopFlagRef,
  CONCURRENCY = 3
}) {
  const langName = LANG_MAP[lang] || lang
  const allText    = new Map()  // flagId → text
  const fallbackEnds = new Map()  // flagId → overridden end time
  let done = 0

  await new Promise(resolve => {
    let active = 0, nextCi = 0

    function launch() {
      while (active < CONCURRENCY && nextCi < chunks.length) {
        if (stopFlagRef?.current) break
        const ci    = nextCi++
        const chunk = chunks[ci]
        const label = `chunk ${ci+1}/${chunks.length}`
        const segs  = chunk.segments  // [{flagId, start, end}]
        const n     = segs.length
        const t0    = chunk.t0
        const dur   = chunk.t1 - t0
        active++

        // Build local (relative) time ranges for prompt
        const localSegs = segs.map(s => ({
          localStart: parseFloat((s.start - t0).toFixed(2)),
          localEnd:   parseFloat((s.end   - t0).toFixed(2))
        }))

        sleep(ci % CONCURRENCY * 300)
          .then(async () => {
            onLog(`    → ${label} [${t0.toFixed(1)}–${chunk.t1.toFixed(1)}с, ${n} сег]`, 'dm')
            const b64  = await blobToBase64(sliceToWav(audioBuf, t0, chunk.t1))
            let texts  = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec, dedupWindow)

            // Retry loop: up to 3 attempts with increasing delay
            const MAX_RETRIES = 3
            let attempt = 1
            while ((texts.length === 0 || texts.length !== n) && attempt <= MAX_RETRIES) {
              const delay = attempt * 800
              onLog(`    ↻ ${label}: вернулось ${texts.length}/${n} → повтор ${attempt}/${MAX_RETRIES} (${delay}мс)`, 'wa')
              await sleep(delay)
              const retried = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec, dedupWindow)
              if (retried.length === n) { texts = retried; break }
              if (retried.length > texts.length) texts = retried
              attempt++
            }

            // Fallback: if still 0 results — send whole chunk without segments, get single text block
            if (texts.length === 0) {
              onLog(`    ⚠ ${label}: fallback → транскрипция без сегментов`, 'wa')
              await sleep(1000)
              const fallbackTexts = await callGemini(apiKey, b64, [{localStart:0, localEnd:dur}], langName, dur, chunkSec, dedupWindow)
              if (fallbackTexts.length > 0 && fallbackTexts[0]) {
                allText.set(segs[0].flagId, fallbackTexts[0])
                fallbackEnds.set(segs[0].flagId, chunk.t1)
                onLog(`    ✓ ${label}: fallback → 1 сег (весь чанк ${t0.toFixed(1)}–${chunk.t1.toFixed(1)}с)`, 'wa')
              }
            } else {
              // Zip texts → flagIds
              segs.forEach((seg, i) => {
                allText.set(seg.flagId, texts[i] || '')
              })
            }

            done++
            const filled = segs.filter(s => allText.get(s.flagId)).length
            onLog(`    ✓ ${label} → ${filled}/${n} сег`, 'dm')
            onProgress && onProgress(done / chunks.length * 100, `Gemini: ${done}/${chunks.length}`)
          })
          .catch(e => { onLog(`    ✗ ${label}: ${e.message}`, 'wa'); done++ })
          .finally(() => {
            active--
            if (nextCi < chunks.length && !stopFlagRef?.current) launch()
            else if (active === 0) resolve()
          })
      }
      if (active === 0) resolve()
    }
    launch()
  })

  return { allText, fallbackEnds }
}
