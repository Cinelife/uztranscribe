/**
 * Silero VAD — прямой ONNX без @ricky0123/vad-web
 *
 * Модель: silero_vad_legacy.onnx (1.8MB, в /public/vad/)
 * Runtime: onnxruntime-web/wasm — Vite сам копирует .wasm в /assets/
 *
 * I/O: input[1,512] float32 + sr int64 + h[2,1,64] + c[2,1,64]
 *    → output[1,1] float32 + hn[2,1,64] + cn[2,1,64]
 */

import { InferenceSession, Tensor, env as ortEnv } from 'onnxruntime-web/wasm'

const FRAME_SIZE    = 512
const TARGET_SR     = 16000
const POS_THRESH    = 0.50
const NEG_THRESH    = 0.35
const PRE_PAD_MS    = 96
const REDEMPTION_MS = 256

// Base URL для ONNX-модели (в /public/vad/ → /vad/ на prod)
function modelBase() {
  return (typeof location !== 'undefined' ? location.origin : '') + '/vad/'
}

let sessionPromise = null

async function getSession() {
  if (sessionPromise) return sessionPromise
  sessionPromise = (async () => {
    // numThreads=1: без SharedArrayBuffer/COOP headers
    // executionProviders=['wasm']: явно только wasm, никакого jsep/webgpu
    // НЕ переопределяем wasmPaths — Vite уже поместил wasm в /assets/ с правильным URL
    ortEnv.wasm.numThreads = 1

    const session = await InferenceSession.create(
      modelBase() + 'silero_vad_legacy.onnx',
      {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      }
    )
    return session
  })()
  return sessionPromise
}

function resampleTo16k(samples, srcRate) {
  if (srcRate === TARGET_SR) return samples
  const ratio  = TARGET_SR / srcRate
  const outLen = Math.round(samples.length * ratio)
  const out    = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio
    const lo  = Math.floor(pos)
    const hi  = Math.min(lo + 1, samples.length - 1)
    out[i]    = samples[lo] * (1 - pos + lo) + samples[hi] * (pos - lo)
  }
  return out
}

async function runVAD(samples16k) {
  const session = await getSession()

  const srTensor  = new Tensor('int64', BigInt64Array.from([BigInt(TARGET_SR)]), [])
  let h = new Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])
  let c = new Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])

  const totalFrames  = Math.floor(samples16k.length / FRAME_SIZE)
  const msPerFrame   = (FRAME_SIZE / TARGET_SR) * 1000  // 32ms
  const prePadFrames = Math.round(PRE_PAD_MS    / msPerFrame)
  const redemptionFr = Math.round(REDEMPTION_MS / msPerFrame)

  const segments  = []
  let inSpeech    = false
  let speechStart = 0
  let redemptionCount = 0
  const ring = []

  for (let fi = 0; fi < totalFrames; fi++) {
    const frame  = samples16k.slice(fi * FRAME_SIZE, (fi + 1) * FRAME_SIZE)
    const frameMs = fi * msPerFrame

    const result = await session.run({
      input: new Tensor('float32', frame, [1, FRAME_SIZE]),
      sr: srTensor,
      h, c
    })

    const prob = result.output.data[0]
    h = result.hn
    c = result.cn

    ring.push(frameMs)
    if (ring.length > prePadFrames) ring.shift()

    if (!inSpeech) {
      if (prob >= POS_THRESH) {
        speechStart = ring[0]
        inSpeech = true
        redemptionCount = 0
      }
    } else {
      if (prob < NEG_THRESH) {
        if (++redemptionCount >= redemptionFr) {
          segments.push({ start: speechStart, end: frameMs })
          inSpeech = false
          redemptionCount = 0
        }
      } else {
        redemptionCount = 0
      }
    }
  }

  if (inSpeech) {
    segments.push({ start: speechStart, end: (samples16k.length / TARGET_SR) * 1000 })
  }

  return segments
}

// ─────────────────────────────────────────────────────────────

function buildFlagId(ci, si) {
  return `${String(ci).padStart(3,'0')}$${String(si).padStart(3,'0')}`
}

function groupIntoChunks(segs, chunkSec) {
  const chunks = []
  let cur = null
  for (const seg of segs) {
    if (!cur || (seg.end - cur.t0) > chunkSec * 1000 + 500) {
      if (cur) chunks.push(cur)
      cur = { t0: seg.start, t1: seg.end, segments: [] }
    }
    cur.t1 = seg.end
    cur.segments.push(seg)
  }
  if (cur) chunks.push(cur)
  return chunks
}

export async function segmentAudioSilero(file, chunkSec = 25, minPause = 500, onProgress, onLog) {
  onProgress?.(5,  'Silero VAD: инициализация...')
  onLog?.('Silero VAD: загрузка модели...', 'dm')

  const arrayBuf = await file.arrayBuffer()
  const audioCtx = new OfflineAudioContext(1, 1, 16000)
  const decoded  = await audioCtx.decodeAudioData(arrayBuf)
  const samples  = resampleTo16k(decoded.getChannelData(0), decoded.sampleRate)
  const duration = samples.length / TARGET_SR

  onProgress?.(15, 'Silero VAD: анализ речи...')
  onLog?.(`Silero VAD: ${duration.toFixed(1)}с → ONNX wasm...`, 'dm')

  const rawSegs = await runVAD(samples)
  onLog?.(`Silero VAD: ${rawSegs.length} сегментов`, 'dm')
  onProgress?.(60, `Silero VAD: ${rawSegs.length} сег`)

  // Merge close segments
  const merged = []
  for (const seg of rawSegs) {
    if (merged.length && seg.start - merged.at(-1).end < minPause) {
      merged.at(-1).end = seg.end
    } else {
      merged.push({ ...seg })
    }
  }

  // Extend to audio boundaries if within 3s
  if (merged.length && merged[0].start < 3000) merged[0].start = 0
  if (merged.length) {
    const lastMs = duration * 1000
    if (lastMs - merged.at(-1).end < 3000) merged.at(-1).end = lastMs
  }

  onLog?.(`Silero VAD: после слияния ${merged.length} сег`, 'dm')

  const flagMap   = new Map()
  const rawChunks = groupIntoChunks(merged, chunkSec)

  const chunks = rawChunks.map((chunk, ci) => {
    const segs = chunk.segments.map((seg, si) => {
      const flagId = buildFlagId(ci, si)
      const startS = seg.start / 1000
      const endS   = seg.end   / 1000
      flagMap.set(flagId, { start: startS, end: endS })
      return { flagId, start: startS, end: endS }
    })
    return { t0: chunk.t0 / 1000, t1: chunk.t1 / 1000, segments: segs }
  })

  onProgress?.(100, `Silero VAD ✓ — ${merged.length} сег → ${chunks.length} чанков`)
  onLog?.(`Silero VAD ✓ — ${merged.length} → ${chunks.length} чанков`, 'ok')

  return { flagMap, chunks, totalMicroSegs: merged.length }
}
