import { sliceToWav, blobToBase64, buildSmartChunks, sleep, decodeAudio } from './audioUtils.js'
import { deduplicateSegs, splitLongLines } from './srtUtils.js'

export const GM_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash-latest'
]

const LANG_MAP = { uz:'Uzbek', ru:'Russian', en:'English', kk:'Kazakh', tg:'Tajik' }

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
    const m = raw.match(/[sS]*]/)
    if (m) { try { return toArray(JSON.parse(m[0])) } catch (_) {} }
    const objs = Array.from(raw.matchAll(/{[^{}]+}/g))
    if (objs.length) { try { return objs.map(o => JSON.parse(o[0])).filter(o => 'text' in o) } catch (_) {} }
    throw new Error('JSON parse error: ' + raw.slice(0, 100))
  }
}

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

export async function transcribeGemini(file, key, lang, chunkSec, maxChars, preChunks, onLog, onProgress, stopFlagRef) {
  const langName = LANG_MAP[lang] || lang
  onLog(`    GM: декодирование ${(file.size/1e6).toFixed(1)} MB...`, 'in')

  const ab = await decodeAudio(file)

  let chunks
  if (preChunks) {
    chunks = preChunks
    onLog(`    GM: ${ab.duration.toFixed(1)}с → ${chunks.length} чанков [Vosk-границы]`, 'ok')
  } else {
    onLog(`    GM: поиск тихих мест для разрезки...`, 'in')
    chunks = buildSmartChunks(ab, chunkSec)
    onLog(`    GM: ${ab.duration.toFixed(1)}с → ${chunks.length} чанков [Smart Silence]`, 'in')
  }

  const CONCURRENCY = 3
  const allSegs = []
  const results = new Array(chunks.length)
  let active = 0, nextChunk = 0, done = 0

  async function processChunk(ci) {
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
        segs = Array.isArray(r) ? r : (r && typeof r === "object" && "text" in r ? [r] : [])
        segs = segs.filter(s => parseFloat(s.start) >= -0.5 && parseFloat(s.start) < dur + 0.5)
        // Filter prompt leaks — Gemini sometimes echoes the prompt back as a segment
        const PROMPT_LEAK = /transcribe|return only|json array|no speech|raw json|markdown|duration:/i
        segs = segs.filter(s => !PROMPT_LEAK.test(s.text || ''))
        if (segs.length > 0) break
        if (att < 3) { onLog(`    ↻ чанк ${ci+1} пуст, повтор (попытка ${att+1})...`, 'wa'); await sleep(1500) }
      } catch (e) {
        if (e.message.includes('429')) throw e
        if (att === 3) onLog(`    ⚠ чанк ${ci+1} пропущен: ${e.message}`, 'wa')
        else { onLog(`    ↻ повтор...`, 'dm'); await sleep(2000) }
      }
    }
    if (segs.length === 0) onLog(`    ⚠ чанк ${ci+1} → 0 сегментов`, 'wa')
    results[ci] = segs.map(seg => {
      const s = Math.max(0, Math.min(parseFloat(seg.start), dur - 0.1))
      const e = Math.max(s + 0.05, Math.min(parseFloat(seg.end), dur))
      return { start: t0 + s, end: t0 + e, text: (seg.text || '').trim() }
    })
    done++
    onProgress(`⏳ Gemini: ${done}/${chunks.length} готово`)
    onLog(`    ✓ чанк ${ci+1} → ${results[ci].length} сег.`, 'dm')
  }

  // Parallel pool: CONCURRENCY workers, each picks next available chunk
  await new Promise((resolve) => {
    function launchNext() {
      while (active < CONCURRENCY && nextChunk < chunks.length) {
        if (stopFlagRef.current) break
        const ci = nextChunk++
        active++
        // Stagger start times to avoid simultaneous requests
        sleep(ci % CONCURRENCY * 400).then(() => processChunk(ci)).then(() => {
          active--
          if (nextChunk < chunks.length && !stopFlagRef.current) launchNext()
          else if (active === 0) resolve()
        })
      }
      if (active === 0) resolve()
    }
    launchNext()
  })

  for (const r of results) if (r) allSegs.push(...r)

  // Sort by start time (Gemini may return out-of-order across chunks)
  allSegs.sort((a, b) => a.start - b.start)
  // Clamp overlapping end times
  for (let i = 0; i < allSegs.length - 1; i++) {
    if (allSegs[i].end > allSegs[i+1].start + 0.05) {
      allSegs[i].end = Math.max(allSegs[i].start + 0.1, allSegs[i+1].start - 0.05)
    }
  }
  return splitLongLines(deduplicateSegs(allSegs), maxChars)
}

// ── Translation ──
export const TR_SYS = {
  'uz|ru': 'Ты профессиональный переводчик субтитров с узбекского на русский. Адаптируй культурно, сохраняй разговорный стиль, не переводи имена собственные и топонимы.',
  'uz|en': 'You are a professional subtitle translator from Uzbek to English. Cultural adaptation, colloquial tone, do not translate proper names.',
  'ru|uz': "Siz rus tilidan o'zbek tiliga professional tarjimon. Madaniy moslashtiring, rasmiy Siz shaklidan foydalaning.",
  'ru|en': 'You are a professional subtitle translator from Russian to English. Cultural adaptation, colloquial tone.',
  'en|uz': "Siz ingliz tilidan o'zbek tiliga professional tarjimon. Rasmiy Siz shaklidan foydalaning.",
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
    const d = await r.json()
    let raw = (d.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim()
    if (raw.startsWith('```')) { raw = raw.split('```')[1]; if (raw.startsWith('json')) raw = raw.slice(4) }
    raw = raw.trim()
    const tryP = txt => {
      const p = JSON.parse(txt)
      return segs.map((seg, idx) => {
        const f = p.find(x => x.i === idx)
        return { ...seg, text: f ? f.t : seg.text }
      })
    }
    try { return tryP(raw) }
    catch (_) {
      const m = raw.match(/\[[\s\S]*\]/)
      if (m) { try { return tryP(m[0]) } catch (_) {} }
      throw new Error('Парсинг ответа не удался')
    }
  }
  throw new Error('Все модели Gemini недоступны')
}
