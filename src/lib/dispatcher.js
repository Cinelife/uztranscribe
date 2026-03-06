/**
 * v12 Dispatcher — flag-based prompt (robust vs JSON array)
 * Gemini receives: audio chunk + flag markers per segment
 * Returns: lines like [flagId] transcribed text
 * Advantage: partial returns work, count mismatch impossible
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest']
const PROMPT_LEAK = /transcribe this|return only|json array|no speech|raw json|markdown/i
const FLAG_RE = /\[([0-9]{3}\$[0-9]{3})\]\s*(.*)/

function buildPrompt(segments, flagIds, langName, chunkDur) {
  const lines = segments.map((s, i) =>
    `[${flagIds[i]}] ${s.localStart.toFixed(2)}s – ${s.localEnd.toFixed(2)}s`
  ).join('\n')

  return (
    `Transcribe this ${langName} audio (${chunkDur.toFixed(1)}s).\n\n` +
    `Speech segments with their flag IDs:\n` +
    `${lines}\n\n` +
    `Rules:\n` +
    `- Full linguistic intelligence: names, abbreviations, terminology.\n` +
    (dedupWindow === 0
      ? `- Repetition is real content — if audio repeats a phrase, transcribe it again.\n`
      : `- Do NOT repeat text from previous segments — transcribe only what you hear in THIS clip.\n`) +
    `- Empty string "" only for completely silent/inaudible segments.\n\n` +
    `Output — one line per segment, EXACTLY this format:\n` +
    segments.map((_, i) => `[${flagIds[i]}] <transcribed text>`).join('\n') + '\n\n' +
    `No other text, no commentary, no markdown. Only the flagged lines.`
  )
}

function parseFlags(raw, flagIds) {
  const result = new Map()
  for (const line of raw.split('\n')) {
    const m = line.match(FLAG_RE)
    if (m) {
      const flagId = m[1]
      const text   = m[2].trim()
      if (flagIds.includes(flagId) && !PROMPT_LEAK.test(text)) {
        result.set(flagId, text)
      }
    }
  }
  return result
}

async function callGemini(apiKey, b64wav, segments, flagIds, langName, chunkDur) {
  const prompt = buildPrompt(segments, flagIds, langName, chunkDur)

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

      const parsed = parseFlags(raw, flagIds)
      if (parsed.size > 0) return parsed
    } catch (_) { continue }
  }
  return new Map()
}

export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang, chunkSec, dedupWindow = 12,
  onLog, onProgress, stopFlagRef,
  CONCURRENCY = 3
}) {
  const langName = LANG_MAP[lang] || lang
  const allText    = new Map()  // flagId → text
  const fallbackEnds = new Map()
  let done = 0

  await new Promise(resolve => {
    let active = 0, nextCi = 0

    function launch() {
      while (active < CONCURRENCY && nextCi < chunks.length) {
        if (stopFlagRef?.current) break
        const ci    = nextCi++
        const chunk = chunks[ci]
        const label = `chunk ${ci+1}/${chunks.length}`
        const segs  = chunk.segments
        const n     = segs.length
        const t0    = chunk.t0
        const dur   = chunk.t1 - t0
        active++

        const flagIds  = segs.map(s => s.flagId)
        const localSegs = segs.map(s => ({
          localStart: parseFloat((s.start - t0).toFixed(2)),
          localEnd:   parseFloat((s.end   - t0).toFixed(2))
        }))

        sleep(ci % CONCURRENCY * 300)
          .then(async () => {
            onLog(`    → ${label} [${t0.toFixed(1)}–${chunk.t1.toFixed(1)}с, ${n} сег]`, 'dm')
            const b64 = await blobToBase64(sliceToWav(audioBuf, t0, chunk.t1))
            let parsed = await callGemini(apiKey, b64, localSegs, flagIds, langName, dur)

            // Retry if we got fewer flags than expected
            const MAX_RETRIES = 3
            let attempt = 1
            while (parsed.size < n && attempt <= MAX_RETRIES) {
              const delay = attempt * 800
              onLog(`    ↻ ${label}: ${parsed.size}/${n} флагов → повтор ${attempt}/${MAX_RETRIES}`, 'wa')
              await sleep(delay)
              const retried = await callGemini(apiKey, b64, localSegs, flagIds, langName, dur)
              if (retried.size >= parsed.size) parsed = retried
              if (parsed.size === n) break
              attempt++
            }

            // Fallback: whole chunk as one segment
            if (parsed.size === 0) {
              onLog(`    ⚠ ${label}: fallback → весь чанк`, 'wa')
              await sleep(1000)
              const fbFlags = [segs[0].flagId]
              const fbSegs  = [{ localStart: 0, localEnd: dur }]
              const fb = await callGemini(apiKey, b64, fbSegs, fbFlags, langName, dur)
              if (fb.size > 0) {
                const text = fb.get(segs[0].flagId) || ''
                allText.set(segs[0].flagId, text)
                fallbackEnds.set(segs[0].flagId, chunk.t1)
                onLog(`    ✓ ${label}: fallback → 1 сег`, 'wa')
              }
            } else {
              for (const [flagId, text] of parsed) {
                allText.set(flagId, text)
              }
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
