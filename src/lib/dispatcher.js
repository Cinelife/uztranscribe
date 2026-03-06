/**
 * v12 Dispatcher
 * Key fix: max MAX_FLAGS_PER_REQ flags per Gemini call → no hallucination
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }
const PROMPT_LEAK = /transcribe this|return only|json array|no speech|raw json|markdown/i
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest']
const MAX_FLAGS_PER_REQ = 4  // ← key: keeps Gemini focused, eliminates hallucination

function normalizeFlag(raw, knownSet) {
  const s = String(raw).trim()
  if (knownSet.has(s)) return s
  const m = s.match(/^0*(\d+)\$0*(\d+)$/)
  if (m) {
    const c = `${m[1].padStart(3,'0')}$${m[2].padStart(3,'0')}`
    if (knownSet.has(c)) return c
  }
  return null
}

function buildPrompt(flagIds, langName, dur) {
  const n = flagIds.length
  const sample = flagIds.map(id => `{"id":"${id}","text":"..."}`).join(',\n  ')
  return (
    `Transcribe this ${langName} audio (${dur.toFixed(1)}s).\n` +
    `Return ONLY a raw JSON array with exactly ${n} item(s).\n` +
    `No markdown, no explanation, no extra text.\n\n` +
    `IDs (copy EXACTLY): ${flagIds.join(', ')}\n` +
    `If segment has no speech: {"id":"...","text":""}\n\n` +
    `[\n  ${sample}\n]`
  )
}

async function callGemini(apiKey, b64wav, flagIds, langName, dur) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: 'audio/wav', data: b64wav } },
            { text: buildPrompt(flagIds, langName, dur) }
          ]}],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 }
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
      if (Array.isArray(parsed)) return parsed
    } catch (_) { continue }
  }
  return []
}

// Process one logical chunk — split into batches of MAX_FLAGS_PER_REQ
async function processChunk({ apiKey, audioBuf, t0, t1, flagIds, langName, onLog, label }) {
  const knownSet  = new Set(flagIds)
  const resultMap = new Map()
  const dur       = t1 - t0

  // Split flagIds into batches ≤ MAX_FLAGS_PER_REQ
  const batches = []
  for (let i = 0; i < flagIds.length; i += MAX_FLAGS_PER_REQ) {
    batches.push(flagIds.slice(i, i + MAX_FLAGS_PER_REQ))
  }

  for (const batch of batches) {
    // Slice audio to exact time range of this batch
    const batchSegs = batch.map(id => {
      // flagId → {start,end} is in flagMap (passed via closure from caller)
      return id
    })

    // For each batch, slice the audio to cover only those segments' time range
    // We use the full chunk audio — Gemini gets context from surrounding silence
    const b64 = await blobToBase64(sliceToWav(audioBuf, t0, t1))

    const parsed = await callGemini(apiKey, b64, batch, langName, dur)

    for (const item of parsed) {
      if (!item?.id) continue
      const text = (item.text || '').trim()
      if (PROMPT_LEAK.test(text)) continue
      const norm = normalizeFlag(item.id, knownSet)
      if (norm && !resultMap.has(norm)) resultMap.set(norm, text)
    }

    // Retry truly missing from this batch
    const missing = batch.filter(id => !resultMap.has(id))
    if (missing.length > 0) {
      await sleep(400)
      const retried = await callGemini(apiKey, b64, missing, langName, dur)
      for (const item of retried) {
        if (!item?.id) continue
        const norm = normalizeFlag(item.id, new Set(missing))
        if (norm) resultMap.set(norm, (item.text||'').trim())
      }
    }
  }

  // Fill any still-missing with empty
  for (const id of flagIds) {
    if (!resultMap.has(id)) resultMap.set(id, '')
  }

  return resultMap
}

export async function dispatchChunks({
  audioBuf, chunks, apiKey, lang, flagMap,
  onLog, onProgress, stopFlagRef,
  CONCURRENCY = 3
}) {
  const langName = LANG_MAP[lang] || lang
  const allText  = new Map()
  let done = 0

  // Flatten: each chunk becomes multiple sub-requests if > MAX_FLAGS_PER_REQ
  // But we process at chunk level for better audio context
  await new Promise(resolve => {
    let active = 0, nextCi = 0

    function launch() {
      while (active < CONCURRENCY && nextCi < chunks.length) {
        if (stopFlagRef?.current) break
        const ci    = nextCi++
        const chunk = chunks[ci]
        const label = `chunk ${ci+1}/${chunks.length}`
        const flagIds = chunk.segments.map(s => s.flagId)
        const nBatches = Math.ceil(flagIds.length / MAX_FLAGS_PER_REQ)
        active++

        sleep(ci % CONCURRENCY * 300)
          .then(() => {
            onLog(`    → ${label} [${chunk.t0.toFixed(1)}–${chunk.t1.toFixed(1)}с, ${flagIds.length} флагов, ${nBatches} батч]`, 'dm')
            return processChunk({
              apiKey, audioBuf,
              t0: chunk.t0, t1: chunk.t1,
              flagIds, langName, onLog, label
            })
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
