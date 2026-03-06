/**
 * v12 Segmenter — OfflineAudioContext energy analysis
 * Flag format: "CCC$SSS" — chunkIndex$segIndex (3-digit zero-padded)
 */

const FRAME_MS  = 10   // energy resolution ms
const MIN_SEG   = 100  // ms minimum segment length

function analyzeEnergy(channelData, sr) {
  const frameSize = Math.floor(sr * FRAME_MS / 1000)
  const frames    = []
  for (let i = 0; i < channelData.length; i += frameSize) {
    let rms = 0
    const end = Math.min(i + frameSize, channelData.length)
    for (let j = i; j < end; j++) rms += channelData[j] * channelData[j]
    frames.push(Math.sqrt(rms / (end - i)))
  }
  return frames
}

function adaptiveThreshold(frames) {
  const sorted = [...frames].sort((a, b) => a - b)
  const p10 = sorted[Math.floor(sorted.length * 0.10)]
  const p90 = sorted[Math.floor(sorted.length * 0.90)]
  return p10 + (p90 - p10) * 0.15
}

function detectMicroSegs(frames, audioDuration, minPauseMs = 200) {
  const threshold  = adaptiveThreshold(frames)
  const minPauseF  = Math.ceil(minPauseMs / FRAME_MS)
  const minSegF    = Math.ceil(MIN_SEG   / FRAME_MS)
  const frameToSec = i => i * FRAME_MS / 1000

  const segs       = []
  let inSpeech     = false
  let segStart     = 0
  let silenceCount = 0

  for (let i = 0; i < frames.length; i++) {
    if (frames[i] > threshold) {
      if (!inSpeech) { segStart = i; inSpeech = true }
      silenceCount = 0
    } else if (inSpeech) {
      silenceCount++
      if (silenceCount >= minPauseF) {
        const segEnd = i - silenceCount + 1
        if (segEnd - segStart >= minSegF) {
          segs.push({ start: frameToSec(segStart), end: frameToSec(segEnd) })
        }
        inSpeech = false; silenceCount = 0
      }
    }
  }

  // Close last open segment
  if (inSpeech && frames.length - segStart >= minSegF) {
    segs.push({ start: frameToSec(segStart), end: frameToSec(frames.length) })
  }

  // ── FIX: extend first segment back to 0.0 if speech starts within 3s ──────
  // Captures words like "Ketdik aka." that start right at the beginning
  if (segs.length > 0 && segs[0].start <= 3.0) {
    segs[0] = { ...segs[0], start: 0.0 }
  }

  // ── FIX: extend last segment to audioDuration if gap < 3s ─────────────────
  if (segs.length > 0 && audioDuration - segs[segs.length-1].end <= 3.0) {
    segs[segs.length-1] = { ...segs[segs.length-1], end: audioDuration }
  }

  if (segs.length === 0) {
    segs.push({ start: 0, end: audioDuration })
  }

  return segs
}

function groupIntoChunks(microSegs, chunkSec) {
  // chunkSec from slider (default 15-30s) — controls Gemini request size
  // Smaller = more requests but faster parallel processing
  // Larger = fewer requests but more context per request (better for continuous speech)
  const chunks   = []
  let current    = []
  let chunkStart = microSegs[0].start

  for (let i = 0; i < microSegs.length; i++) {
    current.push(microSegs[i])
    const elapsed = microSegs[i].end - chunkStart
    if (elapsed >= chunkSec || i === microSegs.length - 1) {
      chunks.push({ t0: chunkStart, t1: microSegs[i].end, segs: [...current] })
      current    = []
      chunkStart = microSegs[i + 1]?.start ?? 0
    }
  }
  return chunks
}

export async function segmentAudio(file, chunkSec = 20, minPause = 200, onProgress) {
  onProgress && onProgress(5, 'Segmenter: декодирование...')

  const arrayBuf = await file.arrayBuffer()
  const offCtx   = new OfflineAudioContext(1, 1, 16000)
  const decoded  = await offCtx.decodeAudioData(arrayBuf)

  onProgress && onProgress(30, 'Segmenter: анализ энергии...')
  const frames = analyzeEnergy(decoded.getChannelData(0), decoded.sampleRate)

  onProgress && onProgress(60, 'Segmenter: поиск пауз...')
  const microSegs = detectMicroSegs(frames, decoded.duration, minPause)

  onProgress && onProgress(80, `Segmenter: ${microSegs.length} микро-сег → группировка по ${chunkSec}с...`)
  const rawChunks = groupIntoChunks(microSegs, chunkSec)

  // Assign flag IDs
  const flagMap = new Map()
  const chunks  = rawChunks.map((chunk, ci) => {
    const cStr    = String(ci + 1).padStart(3, '0')
    const segments = chunk.segs.map((seg, si) => {
      const flagId = `${cStr}$${String(si + 1).padStart(3, '0')}`
      flagMap.set(flagId, { start: seg.start, end: seg.end })
      return { flagId, start: seg.start, end: seg.end }
    })
    return { t0: chunk.t0, t1: chunk.t1, segments }
  })

  onProgress && onProgress(100, 'Segmenter: готово')
  return { flagMap, chunks, totalMicroSegs: microSegs.length }
}
