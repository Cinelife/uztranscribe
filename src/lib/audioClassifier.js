/**
 * v12.5.4 Audio Classifier
 * Classifies audio segments as: speech / music / silent / mixed
 * Methods: ZCR (zero-crossing rate) + RMS (energy)
 *
 * ZCR logic:
 *   low ZCR  → smooth waveform → music / sustained tones
 *   high ZCR → noisy waveform  → speech (consonants, fricatives)
 *
 * Thresholds calibrated for Uzbek speech + typical podcast intros
 */

const SILENT_RMS_THRESHOLD = 0.004   // below = silence (very quiet)
const MUSIC_ZCR_MAX        = 0.045   // below = likely music
const SPEECH_ZCR_MIN       = 0.085   // above = likely speech
// between MUSIC_ZCR_MAX and SPEECH_ZCR_MIN = mixed / ambiguous

/**
 * Classify a single time range within an AudioBuffer
 * @param {AudioBuffer} audioBuf
 * @param {number} t0 - start time in seconds
 * @param {number} t1 - end time in seconds
 * @returns {{ type: 'speech'|'music'|'silent'|'mixed', rms: number, zcr: number }}
 */
export function classifySegment(audioBuf, t0, t1) {
  const sr  = audioBuf.sampleRate
  const s0  = Math.max(0, Math.floor(t0 * sr))
  const s1  = Math.min(audioBuf.length, Math.ceil(t1 * sr))
  const nc  = audioBuf.numberOfChannels
  const len = s1 - s0

  if (len <= 0) return { type: 'silent', rms: 0, zcr: 0 }

  // Mix to mono
  const mono = new Float32Array(len)
  for (let c = 0; c < nc; c++) {
    const ch = audioBuf.getChannelData(c)
    for (let i = 0; i < len; i++) mono[i] += ch[s0 + i] / nc
  }

  // RMS energy
  let sum = 0
  for (let i = 0; i < len; i++) sum += mono[i] * mono[i]
  const rms = Math.sqrt(sum / len)

  if (rms < SILENT_RMS_THRESHOLD) return { type: 'silent', rms, zcr: 0 }

  // Zero crossing rate
  let crossings = 0
  for (let i = 1; i < len; i++) {
    if ((mono[i] >= 0) !== (mono[i - 1] >= 0)) crossings++
  }
  const zcr = crossings / len

  // Classify by ZCR
  let type
  if (zcr < MUSIC_ZCR_MAX) {
    type = 'music'
  } else if (zcr > SPEECH_ZCR_MIN) {
    type = 'speech'
  } else {
    type = 'mixed'
  }

  return { type, rms, zcr }
}

/**
 * Classify all segments (from flagMap or chunk segments array)
 * @param {AudioBuffer} audioBuf
 * @param {Array<{flagId, start, end}>} segments
 * @returns {Map<string, {type, rms, zcr}>}
 */
export function classifySegments(audioBuf, segments) {
  const result = new Map()
  for (const seg of segments) {
    result.set(seg.flagId, classifySegment(audioBuf, seg.start, seg.end))
  }
  return result
}

/**
 * Get hint string for prompt based on classifier result
 * @param {{ type: string }} info
 * @returns {string|null}
 */
export function getClassifierHint(info) {
  if (!info) return null
  if (info.type === 'music')  return 'music?'
  if (info.type === 'mixed')  return 'music+speech?'
  if (info.type === 'silent') return 'silent?'
  return null // speech = no hint needed
}
