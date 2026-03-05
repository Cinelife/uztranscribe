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
    `- NO duplicate segments\n` +
    `- Do NOT translate — keep original ${langName}\n` +
    `- No speech → return []\n` +
    `Raw JSON only, no markdown, no explanation.`
  )
}

function parseGeminiJSON(raw) {
  if (!raw || raw === '[]') return []
  if (raw.startsWith('```')) {
    raw = raw.split('```')[1]
    if (raw.startsWith('json')) raw = raw.slice(4)
  }
  raw = raw.trim()
  try { return JSON.parse(raw) }
  catch (_) {
    const m = raw.match(/\[[\s\S]*\]/)
    if (m) { try { return JSON.parse(m[0]) } catch (_) {} }
    const objs = Array.from(raw.matchAll(/\{[^{}]+\}/g))
    if (objs.length) { try { return objs.map(o => JSON.parse(o[0])).filter(o => 'text' in o) } catch (_) {} }
    throw new Error('JSON parse error: ' + raw.slice(0, 100))
  }
}

export async function geminiGenerateChunk(key, b64, dur, langName, maxChars, onLog) {
  const prompt = buildPrompt(dur, langName, maxChars)
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

  const allSegs = []
  for (let ci = 0; ci < chunks.length; ci++) {
    if (stopFlagRef.current) break
    const { t0, t1 } = chunks[ci], dur = t1 - t0
    onLog(`    GM: чанк ${ci+1}/${chunks.length} [${t0.toFixed(1)}–${t1.toFixed(1)}s  ${dur.toFixed(1)}с]`, 'dm')
    onProgress(`⏳ Gemini чанк ${ci+1}/${chunks.length}`)

    const b64 = await blobToBase64(sliceToWav(ab, t0, t1))
    let segs = []
    for (let att = 1; att <= 2; att++) {
      try { segs = await geminiGenerateChunk(key, b64, dur, langName, maxChars, onLog); break }
      catch (e) {
        if (e.message.includes('429')) throw e
        if (att === 2) onLog(`    ⚠ чанк ${ci+1} пропущен: ${e.message}`, 'wa')
        else { onLog(`    ↻ повтор...`, 'dm'); await sleep(2000) }
      }
    }
    for (const seg of segs) {
      const s = Math.max(0, Math.min(parseFloat(seg.start), dur - 0.1))
      const e = Math.max(s + 0.05, Math.min(parseFloat(seg.end), dur))
      allSegs.push({ start: t0 + s, end: t0 + e, text: (seg.text || '').trim() })
    }

    if ((ci + 1) % 10 === 0 && ci < chunks.length - 1) {
      onLog(`    ⏸ пауза 1с (охлаждение API)...`, 'wa')
      await sleep(1000)
    } else if (ci < chunks.length - 1) {
      await sleep(600)
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
