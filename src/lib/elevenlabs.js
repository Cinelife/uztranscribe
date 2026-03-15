import { wordsToSegs } from './srtUtils.js'
export async function transcribeEL(file, key, lang, maxChars, onLog) {
  onLog(`    EL: отправка ${(file.size/1e6).toFixed(1)} MB...`, 'in')
  const form = new FormData()
  form.append('file', file); form.append('model_id', 'scribe_v1')
  form.append('language_code', lang); form.append('timestamps_granularity', 'word')
  form.append('diarize', 'false')
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': key }, body: form
  })
  if (!r.ok) throw new Error('ElevenLabs ' + r.status + ': ' + (await r.text()).slice(0, 200))
  const d = await r.json()
  const words = d.words || []
  if (words.length) return wordsToSegs(words, 6, maxChars)
  return [{ start: 0, end: d.audio_duration || 0, text: d.text || '' }]
}
