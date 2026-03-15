export async function decodeAudio(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
  const buf = await file.arrayBuffer()
  try { return await ctx.decodeAudioData(buf) }
  catch (e) { throw new Error('Не удалось декодировать: ' + e.message) }
}

export function sliceToWav(ab, t0, t1) {
  const sr = ab.sampleRate
  const s0 = Math.floor(t0 * sr)
  const s1 = Math.min(Math.floor(t1 * sr), ab.length)
  const samples = s1 - s0
  const out = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(out)
  let off = 0
  const ws = s => { for (let i = 0; i < s.length; i++) v.setUint8(off++, s.charCodeAt(i)) }
  ws('RIFF'); v.setUint32(4, 36 + samples * 2, true); off = 8
  ws('WAVE'); ws('fmt '); v.setUint32(16, 16, true); off += 4
  v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  off = 36; ws('data'); v.setUint32(40, samples * 2, true); off = 44
  const nc = ab.numberOfChannels
  for (let i = 0; i < samples; i++) {
    let val = 0
    for (let c = 0; c < nc; c++) val += ab.getChannelData(c)[s0 + i] / nc
    val = Math.max(-1, Math.min(1, val))
    v.setInt16(off, val < 0 ? val * 0x8000 : val * 0x7FFF, true); off += 2
  }
  return new Blob([out], { type: 'audio/wav' })
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result.split(',')[1])
    r.onerror = () => rej(new Error('base64 error'))
    r.readAsDataURL(blob)
  })
}

export function findSilentCut(ab, target, win = 10, frame = 0.05) {
  const sr = ab.sampleRate, total = ab.duration, nc = ab.numberOfChannels
  const mono = new Float32Array(ab.length)
  for (let c = 0; c < nc; c++) {
    const ch = ab.getChannelData(c)
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / nc
  }
  const fl = Math.floor(frame * sr)
  const ss = Math.max(0, target - win), se = Math.min(total, target + win)
  let best = target, bestR = Infinity
  for (let t = ss; t < se - frame; t += frame) {
    const s0 = Math.floor(t * sr), s1 = Math.min(s0 + fl, mono.length)
    let sum = 0
    for (let i = s0; i < s1; i++) sum += mono[i] * mono[i]
    const rms = Math.sqrt(sum / (s1 - s0))
    if (rms < bestR) { bestR = rms; best = t + frame / 2 }
  }
  return best
}

export function buildSmartChunks(ab, targetSec) {
  const total = ab.duration, chunks = []
  let cursor = 0
  while (cursor < total - 1) {
    const rawEnd = cursor + targetSec
    if (rawEnd >= total) { chunks.push({ t0: cursor, t1: total }); break }
    const end = findSilentCut(ab, rawEnd, 10)
    chunks.push({ t0: cursor, t1: end }); cursor = end
  }
  return chunks
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── v11: slice AudioBuffer without re-decoding ──────────────────────────────
export function sliceToAudioBuffer(ab, t0, t1) {
  const sr = ab.sampleRate
  const s0 = Math.max(0, Math.floor(t0 * sr))
  const s1 = Math.min(ab.length, Math.ceil(t1 * sr))
  const len = s1 - s0
  const ctx = new OfflineAudioContext(1, len, sr)
  const out = ctx.createBuffer(1, len, sr)
  const src = ab.getChannelData(0)
  out.getChannelData(0).set(src.subarray(s0, s1))
  return out
}

// ── v11: group Vosk words into segments by pause gaps ──────────────────────
export function groupWordsByPauses(words, minPause = 0.3, maxSegDur = 7.0) {
  if (!words || words.length === 0) return []
  const segs = []
  let segStart = words[0].start
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const next = words[i + 1]
    const pause = next ? next.start - w.end : 999
    const dur = w.end - segStart
    if (pause >= minPause || dur >= maxSegDur || !next) {
      segs.push({ start: segStart, end: w.end })
      if (next) segStart = next.start
    }
  }
  return segs
}
