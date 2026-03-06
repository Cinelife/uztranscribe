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

function buildPrompt(segments, langName, chunkDur, chunkSec) {
  const n    = segments.length
  const list = segments.map((s, i) =>
    `  ${i+1}. ${s.localStart.toFixed(2)}s – ${s.localEnd.toFixed(2)}s`
  ).join('\n')

  return (
    `Transcribe this ${langName} audio clip (total: ${chunkDur.toFixed(1)}s, chunk size: ${chunkSec}s).\n\n` +
    `It contains ${n} speech segment(s) at these exact time ranges:\n` +
    `${list}\n\n` +
    `For each segment, transcribe ONLY what is spoken in that time range.\n` +
    `Return a raw JSON array of exactly ${n} strings, in order.\n` +
    `Use "" for silent or inaudible segments.\n` +
    `No timestamps in output, no IDs, no markdown.\n\n` +
    `Example: ${JSON.stringify(Array(Math.min(n,3)).fill('transcribed text here'))}${n>3?',...':''}`
  )
}

async function callGemini(apiKey, b64wav, segments, langName, chunkDur, chunkSec) {
  const prompt = buildPrompt(segments, langName, chunkDur, chunkSec)
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
  audioBuf, chunks, apiKey, lang, chunkSec,
  onLog, onProgress, stopFlagRef,
  CONCURRENCY = 3
}) {
  const langName = LANG_MAP[lang] || lang
  const allText  = new Map()  // flagId → text
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
            let texts  = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec)

            // Retry if count mismatch
            if (texts.length !== n && texts.length > 0) {
              onLog(`    ↻ ${label}: вернулось ${texts.length}/${n} → повтор`, 'wa')
              await sleep(500)
              const r2 = await callGemini(apiKey, b64, localSegs, langName, dur, chunkSec)
              if (r2.length === n) texts = r2
              else if (r2.length > texts.length) texts = r2
            }

            // Zip texts → flagIds
            segs.forEach((seg, i) => {
              allText.set(seg.flagId, texts[i] || '')
            })

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

  return allText
}
