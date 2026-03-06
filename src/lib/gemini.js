import { sliceToWav, blobToBase64, buildSmartChunks, sleep, decodeAudio, sliceToAudioBuffer, groupWordsByPauses } from './audioUtils.js'
import { deduplicateSegs, splitLongLines } from './srtUtils.js'
import { getVoskWordsForBuffer } from './vosk.js'

export const GM_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash-latest'
]

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }

// ── v10 free prompt ────────────────────────────────────────────────────────────
function buildPrompt(dur, langName, maxChars) {
  return (
    `Transcribe this audio in ${langName}. Duration: ${dur.toFixed(1)} seconds.\n` +
    `Return ONLY a JSON array. Each item: {"start": float, "end": float, "text": string}\n` +
    `STRICT RULES:\n` +
    `- Timestamps: 0.0 to ${dur.toFixed(1)} seconds\n` +
    `- MAXIMUM ${maxChars} characters per text segment — split if longer\n` +
    `- Each segment 1–7 seconds duration\n` +
    `- IMPORTANT: Transcribe EVERYTHING including repeated phrases — do NOT skip any speech\n` +
    `- Do NOT translate — keep original ${langName}\n` +
    `- No speech → return []\n` +
    `Raw JSON only, no markdown, no explanation.`
  )
}

function buildFallbackPrompt(dur, langName) {
  return (
    `Listen to this ${langName} audio (${dur.toFixed(1)} seconds) and write down all spoken words.\n` +
    `Return JSON array: [{"start": 0.0, "end": 2.5, "text": "words here"}, ...]\n` +
    `Timestamps must be between 0.0 and ${dur.toFixed(1)}. Raw JSON only.`
  )
}

// ── v11 anchor prompt ──────────────────────────────────────────────────────────
function buildAnchorPrompt(segsWithId, langName, dur) {
  const anchors = segsWithId.map(s =>
    `{"id":${s.id},"start":${s.start.toFixed(2)},"end":${s.end.toFixed(2)}}`
  ).join(',\n')
  return (
    `Transcribe this ${langName} audio. Duration: ${dur.toFixed(1)}s.\n` +
    `I already know the EXACT timestamps from acoustic analysis. Your job is ONLY to write the text.\n\n` +
    `Time segments (DO NOT CHANGE start/end values):\n[${anchors}]\n\n` +
    `Return ONLY a JSON array: [{"id": N, "text": "transcribed text"}, ...]\n` +
    `- Include every id from the list above\n` +
    `- If a segment has no speech → {"id": N, "text": ""}\n` +
    `- Do NOT translate — keep original ${langName}\n` +
    `- Do NOT modify start/end — only write text\n` +
    `Raw JSON only, no markdown.`
  )
}

function toArray(val) {
  if (Array.isArray(val)) return val
  if (val && typeof val === 'object' && 'text' in val) return [val]
  return []
}

function parseGeminiJSON(raw) {
  if (!raw || raw.trim() === '[]') return []
  if (raw.startsWith('```')) {
    raw = raw.split('```')[1]
    if (raw.startsWith('json')) raw = raw.slice(4)
  }
  raw = raw.trim()
  try { return toArray(JSON.parse(raw)) }
  catch (_) {
    const m = raw.match(/\[[\s\S]*\]/)
    if (m) { try { return toArray(JSON.parse(m[0])) } catch (_) {} }
    const objs = Array.from(raw.matchAll(/{[^{}]+}/g))
    if (objs.length) { try { return objs.map(o => JSON.parse(o[0])).filter(o => 'text' in o || 'id' in o) } catch (_) {} }
    throw new Error('JSON parse error: ' + raw.slice(0, 100))
  }
}

// ── Core Gemini API call ───────────────────────────────────────────────────────
export async function geminiGenerateChunk(key, b64, dur, langName, maxChars, onLog, customPrompt) {
  const prompt = customPrompt || buildPrompt(dur, langName, maxChars)
  for (const model of GM_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: 'audio/wav', data: b64 } },
            { text: prompt }
          ] }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096 }
        })
      }
    )
    if (r.status === 429) throw new Error('Gemini 429: Квота исчерпана. Подожди час или включи биллинг.')
    if (r.status === 503 || r.status === 504) { onLog(`    ⚠ ${model} → ${r.status}, пробую следующую...`, 'wa'); continue }
    if (!r.ok) { onLog(`    ⚠ ${model} → ${r.status}, пробую следующую...`, 'wa'); continue }
    const d = await r.json()
    const cand = d.candidates?.[0]
    if (!cand) throw new Error('Gemini: пустой ответ')
    const raw = (cand.content?.parts || []).map(p => p.text || '').join('').trim()
    return parseGeminiJSON(raw)
  }
  throw new Error('Все модели Gemini недоступны')
}

// ── v11: anchored Gemini request ───────────────────────────────────────────────
async function geminiAnchoredRequest(key, b64, segsWithId, langName, dur, onLog) {
  const prompt = buildAnchorPrompt(segsWithId, langName, dur)
  for (const model of GM_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: 'audio/wav', data: b64 } },
            { text: prompt }
          ] }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096 }
        })
      }
    )
    if (r.status === 429) throw new Error('Gemini 429: Квота исчерпана.')
    if (r.status === 503 || r.status === 504) { onLog(`    ⚠ ${model} → ${r.status}`, 'wa'); continue }
    if (!r.ok) { onLog(`    ⚠ ${model} → ${r.status}`, 'wa'); continue }
    const d = await r.json()
    const cand = d.candidates?.[0]
    if (!cand) throw new Error('Gemini: пустой ответ')
    const raw = (cand.content?.parts || []).map(p => p.text || '').join('').trim()
    const parsed = parseGeminiJSON(raw)
    // Merge anchor timestamps with Gemini text
    return segsWithId.map(anchor => {
      const found = parsed.find(x => x.id === anchor.id)
      return { start: anchor.start, end: anchor.end, text: (found?.text || '').trim() }
    }).filter(s => s.text)
  }
  throw new Error('Все модели Gemini недоступны')
}

// ── Main transcribe function ───────────────────────────────────────────────────
export async function transcribeGemini(
  file, key, lang, chunkSec, maxChars,
  preChunks,     // v10: Vosk boundaries (whole-file pass) or null
  onLog, onProgress, stopFlagRef,
  voskModel,     // v11: Vosk model for per-chunk word extraction
  onVoskProgress, hideVoskProgress
) {
  const langName = LANG_MAP[lang] || lang
  onLog(`    GM: декодирование ${(file.size/1e6).toFixed(1)} MB...`, 'in')

  const ab = await decodeAudio(file)

  let chunks
  if (preChunks) {
    chunks = preChunks
    onLog(`    GM: ${ab.duration.toFixed(1)}с → ${chunks.length} чанков [Vosk-границы v10]`, 'ok')
  } else {
    onLog(`    GM: поиск тихих мест для разрезки...`, 'in')
    chunks = buildSmartChunks(ab, chunkSec)
    onLog(`    GM: ${ab.duration.toFixed(1)}с → ${chunks.length} чанков [Smart Silence]`, 'in')
  }

  // ── v11 path: per-chunk Vosk → anchor prompt ──────────────────────────────
  const useV11 = !!voskModel && !preChunks

  if (useV11) {
    onLog(`    GM v11: Vosk per-chunk → Gemini anchor mode`, 'ok')

    // Phase 1: Sequential Vosk pass on each chunk
    const chunkAnchors = [] // [{chunkIdx, segs: [{id, start, end}]}]
    for (let ci = 0; ci < chunks.length; ci++) {
      if (stopFlagRef.current) break
      const { t0, t1 } = chunks[ci]
      if (onVoskProgress) onVoskProgress(Math.round(ci / chunks.length * 100), `Vosk: чанк ${ci+1}/${chunks.length}`)

      try {
        const sliced = sliceToAudioBuffer(ab, t0, t1)
        const words  = await getVoskWordsForBuffer(sliced, voskModel)

        if (words.length === 0) {
          chunkAnchors.push({ chunkIdx: ci, segs: [] })
          onLog(`    Vosk чанк ${ci+1}: нет слов → fallback к свободному промпту`, 'wa')
          continue
        }

        const localSegs = groupWordsByPauses(words)
        let idCounter = ci * 1000 // unique IDs per chunk
        const segsWithId = localSegs.map(s => ({
          id:    idCounter++,
          start: s.start, // chunk-local time
          end:   s.end
        }))
        chunkAnchors.push({ chunkIdx: ci, segs: segsWithId, t0 })
        onLog(`    Vosk чанк ${ci+1}: ${words.length} слов → ${segsWithId.length} якорей`, 'dm')
      } catch (e) {
        onLog(`    ⚠ Vosk чанк ${ci+1}: ${e.message} → fallback`, 'wa')
        chunkAnchors.push({ chunkIdx: ci, segs: [] })
      }
    }

    if (hideVoskProgress) hideVoskProgress()

    // Phase 2: Parallel Gemini pool (CONCURRENCY=3, staggered start)
    const CONCURRENCY = 3
    const allSegs = []
    const results  = new Array(chunks.length)
    let nextChunk  = 0, done = 0

    async function processChunk(ci) {
      if (stopFlagRef.current) return
      const { t0, t1 } = chunks[ci], dur = t1 - t0
      onLog(`    GM: чанк ${ci+1}/${chunks.length} [${t0.toFixed(1)}–${t1.toFixed(1)}s]`, 'dm')
      onProgress(`⏳ Gemini: ${done}/${chunks.length} готово`)

      const b64       = await blobToBase64(sliceToWav(ab, t0, t1))
      const anchInfo  = chunkAnchors.find(a => a.chunkIdx === ci)
      const hasAnchors = anchInfo?.segs?.length > 0

      let segs = []
      for (let att = 1; att <= 3; att++) {
        try {
          if (hasAnchors && att <= 2) {
            segs = await geminiAnchoredRequest(key, b64, anchInfo.segs, langName, dur, onLog)
          } else {
            const prompt = att <= 2
              ? buildPrompt(dur, langName, maxChars)
              : buildFallbackPrompt(dur, langName)
            const r = await geminiGenerateChunk(key, b64, dur, langName, maxChars, onLog, prompt)
            segs = Array.isArray(r) ? r : toArray(r)
          }
          break
        } catch (e) {
          if (e.message.includes('429')) throw e
          if (att < 3) { onLog(`    ↻ повтор ${att+1}...`, 'dm'); await sleep(2000) }
          else onLog(`    ⚠ чанк ${ci+1} пропущен: ${e.message}`, 'wa')
        }
      }

      // Convert chunk-local timestamps to absolute
      results[ci] = segs.map(s => ({
        start: t0 + Math.max(0, Math.min(parseFloat(s.start), dur - 0.1)),
        end:   t0 + Math.max(0.05, Math.min(parseFloat(s.end), dur)),
        text:  (s.text || '').trim()
      })).filter(s => s.text)

      done++
      onProgress(`⏳ Gemini: ${done}/${chunks.length} готово`)
    }

    // Pool runner
    const queue = []
    for (let ci = 0; ci < chunks.length; ci++) queue.push(ci)

    async function worker() {
      while (queue.length > 0) {
        const ci = queue.shift()
        await processChunk(ci)
        if (ci < chunks.length - 1) await sleep(300)
      }
    }

    const workers = []
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(sleep(i * 500).then(worker))
    }
    await Promise.all(workers)

    for (const r of results) if (r) allSegs.push(...r)
    allSegs.sort((a, b) => a.start - b.start)

    // Fix overlaps
    for (let i = 0; i < allSegs.length - 1; i++) {
      if (allSegs[i].end > allSegs[i+1].start + 0.05) {
        allSegs[i].end = Math.max(allSegs[i].start + 0.1, allSegs[i+1].start - 0.05)
      }
    }

    return splitLongLines(deduplicateSegs(allSegs), maxChars)
  }

  // ── v10 path (Smart Silence or whole-file Vosk boundaries) ────────────────
  const CONCURRENCY = 3
  const allSegs = []
  const results  = new Array(chunks.length)
  let done = 0

  async function processChunkV10(ci) {
    if (stopFlagRef.current) return
    const { t0, t1 } = chunks[ci], dur = t1 - t0
    onLog(`    GM: чанк ${ci+1}/${chunks.length} [→${t0.toFixed(1)}–${t1.toFixed(1)}s ${dur.toFixed(1)}с]`, 'dm')
    onProgress(`⏳ Gemini: ${done}/${chunks.length} готово`)
    const b64 = await blobToBase64(sliceToWav(ab, t0, t1))
    let segs = []
    for (let att = 1; att <= 3; att++) {
      try {
        const r = att <= 2
          ? await geminiGenerateChunk(key, b64, dur, langName, maxChars, onLog)
          : await geminiGenerateChunk(key, b64, dur, langName, maxChars, onLog, buildFallbackPrompt(dur, langName))
        segs = Array.isArray(r) ? r : toArray(r)
        break
      } catch (e) {
        if (e.message.includes('429')) throw e
        if (att < 3) { onLog(`    ↻ повтор ${att+1}...`, 'dm'); await sleep(2000) }
        else onLog(`    ⚠ чанк ${ci+1} пропущен: ${e.message}`, 'wa')
      }
    }
    results[ci] = segs.map(s => {
      const s_ = Math.max(0, Math.min(parseFloat(s.start), dur - 0.1))
      const e_ = Math.max(s_ + 0.05, Math.min(parseFloat(s.end), dur))
      return { start: t0 + s_, end: t0 + e_, text: (s.text || '').trim() }
    }).filter(s => s.text)
    done++
    onProgress(`⏳ Gemini: ${done}/${chunks.length} готово`)
  }

  const queueV10 = []
  for (let ci = 0; ci < chunks.length; ci++) queueV10.push(ci)

  async function workerV10() {
    while (queueV10.length > 0) {
      const ci = queueV10.shift()
      await processChunkV10(ci)
      if (ci < chunks.length - 1) await sleep(300)
    }
  }

  const workersV10 = []
  for (let i = 0; i < CONCURRENCY; i++) workersV10.push(sleep(i * 500).then(workerV10))
  await Promise.all(workersV10)

  for (const r of results) if (r) allSegs.push(...r)
  allSegs.sort((a, b) => a.start - b.start)
  for (let i = 0; i < allSegs.length - 1; i++) {
    if (allSegs[i].end > allSegs[i+1].start + 0.05) {
      allSegs[i].end = Math.max(allSegs[i].start + 0.1, allSegs[i+1].start - 0.05)
    }
  }
  return splitLongLines(deduplicateSegs(allSegs), maxChars)
}

// ── Translation ───────────────────────────────────────────────────────────────
const TR_SYS = {
  'uz|ru': 'Ты профессиональный переводчик субтитров с узбекского на русский. Адаптируй культурно, сохраняй разговорный стиль, не переводи имена собственные и топонимы.',
  'uz|en': 'You are a professional subtitle translator from Uzbek to English. Cultural adaptation, colloquial tone, do not translate proper names.',
  'ru|uz': "Siz rus tilidan o'zbek tiliga professional tarjimon. Madaniy moslashtiring.",
  'ru|en': 'You are a professional subtitle translator from Russian to English. Cultural adaptation.',
  'en|uz': "Siz ingliz tilidan o'zbek tiliga professional tarjimon.",
  'en|ru': 'Ты профессиональный переводчик субтитров с английского на русский. Адаптируй культурно.'
}

export async function translateBatch(segs, pair, key) {
  const sys    = TR_SYS[pair] || ('Translate subtitles: ' + pair)
  const prompt = sys + '\n\nПереведи субтитры. Верни ТОЛЬКО JSON-массив: [{"i":номер,"t":"перевод"}]\n- Сохраняй \\n если есть\n- Raw JSON без markdown\n\nСубтитры:\n' +
    JSON.stringify(segs.map((s, i) => ({ i, t: s.text })))

  for (const model of GM_MODELS) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
        })
      }
    )
    if (r.status === 429) throw new Error('Gemini 429: Квота исчерпана.')
    if (!r.ok) continue
    const d   = await r.json()
    const raw = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim()
    let cleaned = raw
    if (cleaned.startsWith('```')) { cleaned = cleaned.split('```')[1]; if (cleaned.startsWith('json')) cleaned = cleaned.slice(4) }
    cleaned = cleaned.trim()
    const tryP = txt => {
      const p = JSON.parse(txt)
      return segs.map((seg, idx) => {
        const f = p.find(x => x.i === idx)
        return { ...seg, text: f ? f.t : seg.text }
      })
    }
    try { return tryP(cleaned) }
    catch (_) {
      const m = cleaned.match(/\[[\s\S]*\]/)
      if (m) { try { return tryP(m[0]) } catch (_) {} }
    }
  }
  throw new Error('Перевод Gemini не удался')
}
