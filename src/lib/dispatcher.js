/**
 * v12 Dispatcher — parallel Gemini workers with flag-based prompts
 * Validator layer: retries missing flags, normalizes ID typos
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }
const PROMPT_LEAK = /transcribe this|return only|json array|no speech|raw json|markdown/i
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest']

function normalizeFlag(raw, knownSet) {
  const s = String(raw).trim()
  if (knownSet.has(s)) return s
  const m = s.match(/^0*(\d+)\$0*(\d+)$/)
  if (m) {
    const candidate = `${m[1].padStart(3,'0')}$${m[2].padStart(3,'0')}`
    if (knownSet.has(candidate)) return candidate
  }
  return null
}

function buildPrompt(flagIds, langName, dur) {
  const sample = flagIds.slice(0,2).map(id => `{"id":"${id}","text":"..."}`).join(',')
  return (
    `Transcribe this ${langName} audio clip (${dur.toFixed(1)}s).\n` +
    `It contains ${flagIds.length} pre-detected speech segment(s).\n` +
    `Return ONLY a raw JSON array — no markdown, no explanation.\n\n` +
    `Use EXACTLY these IDs: ${flagIds.join(', ')}\n` +
    `If a segment has no speech return {"id":"...","text":""}.\n\n` +
    `Format: [${sample}${flagIds.length > 2 ? ',...' : ''}]`
  )
}

async function callGemini(apiKey, b64wav, flagIds, langName, dur) {
  const prompt = buildPrompt(flagIds, langName, dur)
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
      const raw = (d.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim()
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
      return parsed
    } catch (_) { continue }
  }
  return []
}

async function processChunk({ apiKey, audioBuf, t0, t1, flagIds, langName, onLog, label }) {
  const knownSet  = new Set(flagIds)
  const resultMap = new Map()
  const b64 = await blobToBase64(sliceToWav(audioBuf, t0, t1))
  const dur  = t1 - t0

  const parsed = await callGemini(apiKey, b64, flagIds, langName, dur)
  for (const item of parsed) {
    if (!item?.id) continue
    const text = (item.text||'').trim()
    if (PROMPT_LEAK.test(text)) continue
    const norm = normalizeFlag(item.id, knownSet)
    if (norm) resultMap.set(norm, text)
  }

  const missing = flagIds.filter(id => !resultMap.has(id))
  if (missing.length > 0 && missing.length < flagIds.length) {
    onLog(`    ↻ ${label}: ${missing.length} флагов пропущено → повтор`, 'wa')
    const retried = await callGemini(apiKey, b64, missing, langName, dur)
    for (const item of retried) {
      if (!item?.id) continue
      const norm = normalizeFlag(item.id, new Set(missing))
      if (norm) resultMap.set(norm, (item.text||'').trim())
    }
  }

  for (const id of flagIds) {
    if (!resultMap.has(id)) resultMap.set(id, '')
  }

  return resultMap
}

export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang,
  onLog, onProgress, stopFlagRef,
  CONCURRENCY = 3
}) {
  const langName = LANG_MAP[lang] || lang
  const allText  = new Map()
  let done = 0

  await new Promise(resolve => {
    let active = 0, nextCi = 0
    function launch() {
      while (active < CONCURRENCY && nextCi < chunks.length) {
        if (stopFlagRef?.current) break
        const ci    = nextCi++
        const chunk = chunks[ci]
        const label = `chunk ${ci+1}/${chunks.length}`
        const flagIds = chunk.segments.map(s => s.flagId)
        active++
        sleep(ci % CONCURRENCY * 300)
          .then(() => {
            onLog(`    → ${label} [${chunk.t0.toFixed(1)}–${chunk.t1.toFixed(1)}с, ${flagIds.length} флагов]`, 'dm')
            return processChunk({ apiKey, audioBuf, t0:chunk.t0, t1:chunk.t1, flagIds, langName, onLog, label })
          })
          .then(resultMap => {
            for (const [k,v] of resultMap) allText.set(k, v)
            done++
            const filled = flagIds.filter(id => resultMap.get(id)).length
            onLog(`    ✓ ${label} → ${filled}/${flagIds.length} сег`, 'dm')
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
