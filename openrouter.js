import { sliceToWav, blobToBase64, buildSmartChunks, sleep, decodeAudio } from './audioUtils.js'
import { deduplicateSegs, splitLongLines } from './srtUtils.js'

// Models confirmed to support audio/multimodal input on OpenRouter
export const OR_MODELS = [
  { id: 'google/gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash (Google)' },
  { id: 'google/gemini-2.0-flash-001',           label: 'Gemini 2.0 Flash (Google)' },
  { id: 'google/gemini-2.0-flash-lite-001',      label: 'Gemini 2.0 Flash Lite (Google)' },
  { id: 'anthropic/claude-haiku-4-5-20251001',   label: 'Claude Haiku 4.5 (Anthropic)' },
  { id: 'anthropic/claude-sonnet-4-5',           label: 'Claude Sonnet 4.5 (Anthropic)' },
  { id: 'qwen/qwen2.5-vl-72b-instruct',          label: 'Qwen2.5 VL 72B (Alibaba)' },
  { id: 'qwen/qwen2.5-vl-7b-instruct',           label: 'Qwen2.5 VL 7B (Alibaba)' },
  { id: 'meta-llama/llama-4-scout',              label: 'Llama 4 Scout (Meta)' },
  { id: 'meta-llama/llama-4-maverick',           label: 'Llama 4 Maverick (Meta)' },
  { id: 'mistralai/pixtral-large-2411',          label: 'Pixtral Large (Mistral)' },
]

const LANG_MAP = { uz: 'Uzbek', ru: 'Russian', en: 'English', kk: 'Kazakh', tg: 'Tajik' }

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

function parseJSON(raw) {
  if (!raw || raw.trim() === '[]') return []
  let s = raw.trim()
  if (s.startsWith('```')) { s = s.split('```')[1]; if (s.startsWith('json')) s = s.slice(4) }
  s = s.trim()
  try { return JSON.parse(s) }
  catch (_) {
    const m = s.match(/\[[\s\S]*\]/)
    if (m) { try { return JSON.parse(m[0]) } catch (_) {} }
    throw new Error('JSON parse error: ' + s.slice(0, 100))
  }
}

/**
 * Send one audio chunk to OpenRouter.
 * Uses OpenAI-compatible multimodal format; OpenRouter forwards to the model's native API.
 */
export async function orGenerateChunk(key, model, b64, dur, langName, maxChars, onLog) {
  const prompt = buildPrompt(dur, langName, maxChars)

  // Build content array — try input_audio (OpenAI format, works for Gemini/Llama via OR)
  const content = [
    {
      type: 'input_audio',
      input_audio: { data: b64, format: 'wav' }
    },
    { type: 'text', text: prompt }
  ]

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${key}`,
      'Content-Type':   'application/json',
      'HTTP-Referer':   'https://cinelife.github.io/uztranscribe',
      'X-Title':        'Uzbek Transcriber'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: 4096
    })
  })

  if (r.status === 402) throw new Error('OpenRouter 402: Недостаточно кредитов.')
  if (r.status === 429) throw new Error('OpenRouter 429: Rate limit. Подожди немного.')
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 200)
    throw new Error(`OpenRouter ${r.status}: ${txt}`)
  }

  const d = await r.json()

  // Handle error field in response
  if (d.error) throw new Error(`OpenRouter error: ${d.error.message || JSON.stringify(d.error)}`)

  const raw = d.choices?.[0]?.message?.content || ''
  if (!raw.trim()) {
    onLog(`    ⚠ OR: пустой ответ от ${model}`, 'wa')
    return []
  }
  return parseJSON(raw)
}

export async function transcribeOpenRouter(file, key, model, lang, chunkSec, maxChars, preChunks, onLog, onProgress, stopFlagRef) {
  const langName = LANG_MAP[lang] || lang
  const modelLabel = OR_MODELS.find(m => m.id === model)?.label || model

  onLog(`    OR [${modelLabel}]: декодирование ${(file.size/1e6).toFixed(1)} MB...`, 'or-cl')

  const ab = await decodeAudio(file)

  let chunks
  if (preChunks) {
    chunks = preChunks
    onLog(`    OR: ${ab.duration.toFixed(1)}с → ${chunks.length} чанков [Vosk-границы]`, 'ok')
  } else {
    onLog(`    OR: поиск тихих мест для разрезки...`, 'or-cl')
    chunks = buildSmartChunks(ab, chunkSec)
    onLog(`    OR: ${ab.duration.toFixed(1)}с → ${chunks.length} чанков [Smart Silence]`, 'or-cl')
  }

  const allSegs = []
  for (let ci = 0; ci < chunks.length; ci++) {
    if (stopFlagRef.current) break
    const { t0, t1 } = chunks[ci], dur = t1 - t0
    onLog(`    OR: чанк ${ci+1}/${chunks.length} [${t0.toFixed(1)}–${t1.toFixed(1)}s  ${dur.toFixed(1)}с]`, 'dm')
    onProgress(`⏳ OR чанк ${ci+1}/${chunks.length}`)

    const b64 = await blobToBase64(sliceToWav(ab, t0, t1))
    let segs = []
    for (let att = 1; att <= 2; att++) {
      try {
        segs = await orGenerateChunk(key, model, b64, dur, langName, maxChars, onLog)
        break
      } catch (e) {
        if (e.message.includes('429') || e.message.includes('402')) throw e
        if (att === 2) onLog(`    ⚠ OR чанк ${ci+1} пропущен: ${e.message}`, 'wa')
        else { onLog(`    ↻ повтор...`, 'dm'); await sleep(2000) }
      }
    }

    for (const seg of segs) {
      const s = Math.max(0, Math.min(parseFloat(seg.start), dur - 0.1))
      const e = Math.max(s + 0.05, Math.min(parseFloat(seg.end), dur))
      allSegs.push({ start: t0 + s, end: t0 + e, text: (seg.text || '').trim() })
    }

    if ((ci + 1) % 10 === 0 && ci < chunks.length - 1) {
      onLog(`    ⏸ пауза 1с (охлаждение OR)...`, 'wa')
      await sleep(1000)
    } else if (ci < chunks.length - 1) {
      await sleep(700)
    }
  }

  return splitLongLines(deduplicateSegs(allSegs), maxChars)
}

// ── Translation via OpenRouter ──
export async function translateBatchOR(segs, pair, key, model) {
  const TR_SYS = {
    'uz|ru': 'Ты профессиональный переводчик субтитров с узбекского на русский. Адаптируй культурно, сохраняй разговорный стиль, не переводи имена собственные и топонимы.',
    'uz|en': 'You are a professional subtitle translator from Uzbek to English. Cultural adaptation, colloquial tone, do not translate proper names.',
    'ru|uz': "Siz rus tilidan o'zbek tiliga professional tarjimon. Madaniy moslashtiring.",
    'ru|en': 'You are a professional subtitle translator from Russian to English. Cultural adaptation.',
    'en|uz': "Siz ingliz tilidan o'zbek tiliga professional tarjimon.",
    'en|ru': 'Ты профессиональный переводчик субтитров с английского на русский. Адаптируй культурно.'
  }
  const sys    = TR_SYS[pair] || ('Translate subtitles: ' + pair)
  const prompt = sys + '\n\nПереведи субтитры. Верни ТОЛЬКО JSON-массив: [{"i":номер,"t":"перевод"}]\n- Сохраняй \\n если есть\n- Raw JSON без markdown\n\nСубтитры:\n' +
    JSON.stringify(segs.map((s, i) => ({ i, t: s.text })))

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'HTTP-Referer':  'https://cinelife.github.io/uztranscribe',
      'X-Title':       'Uzbek Transcriber'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 8192
    })
  })
  if (r.status === 429) throw new Error('OpenRouter 429: Rate limit.')
  if (!r.ok) throw new Error('OpenRouter ' + r.status)
  const d   = await r.json()
  if (d.error) throw new Error('OpenRouter: ' + d.error.message)
  let raw   = d.choices?.[0]?.message?.content || ''
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
    throw new Error('OR: парсинг ответа не удался')
  }
}
