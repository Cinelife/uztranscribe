/**
 * Silero VAD segmenter
 * Replaces RMS energy analysis with neural VAD model.
 * Uses NonRealTimeVAD from @ricky0123/vad-web.
 * Model + WASM files bundled in /public/vad/ — no manual download needed.
 */

import { NonRealTimeVAD } from '@ricky0123/vad-web'

// Resolve /vad/ base — works both on localhost and GitHub Pages subpath
function vadBase() {
  // public/vad/ is served at /vad/ relative to origin root
  return `${location.origin}/vad/`
}

let vadInstance = null

async function getVAD() {
  if (vadInstance) return vadInstance

  const base = vadBase()

  vadInstance = await NonRealTimeVAD.new({
    modelURL: base + 'silero_vad_legacy.onnx',
    ortConfig: (o) => {
      // Force only wasm backend — skip jsep/webgpu/webnn
      o.env.wasm.wasmPaths = base
      o.env.wasm.numThreads = 1
    },
    // Tunable sensitivity
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    preSpeechPadFrames: 3,
    redemptionFrames: 8,
  })
  return vadInstance
}

function buildFlagId(chunkIdx, segIdx) {
  return `${String(chunkIdx).padStart(3,'0')}$${String(segIdx).padStart(3,'0')}`
}

function groupIntoChunks(microSegs, chunkSec) {
  const chunks = []
  let cur = null

  for (const seg of microSegs) {
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
  onProgress && onProgress(5, 'Silero VAD: инициализация...')
  onLog && onLog('Silero VAD: загрузка модели...', 'dm')

  // Decode audio
  const arrayBuf = await file.arrayBuffer()
  const audioCtx = new OfflineAudioContext(1, 1, 16000)
  const decoded   = await audioCtx.decodeAudioData(arrayBuf)
  const samples   = decoded.getChannelData(0)
  const sampleRate = decoded.sampleRate
  const duration   = decoded.duration

  onProgress && onProgress(15, 'Silero VAD: анализ речи...')
  onLog && onLog(`Silero VAD: ${duration.toFixed(1)}с аудио → нейросетевой VAD...`, 'dm')

  const vad = await getVAD()

  // Collect speech segments from VAD
  const rawSegs = []  // {start, end} in ms
  for await (const seg of vad.run(samples, sampleRate)) {
    rawSegs.push({ start: seg.start, end: seg.end })
  }

  onLog && onLog(`Silero VAD: ${rawSegs.length} сегментов найдено`, 'dm')
  onProgress && onProgress(60, `Silero VAD: ${rawSegs.length} сегментов`)

  // Merge segments closer than minPause
  const merged = []
  for (const seg of rawSegs) {
    if (merged.length && seg.start - merged[merged.length-1].end < minPause) {
      merged[merged.length-1].end = seg.end
    } else {
      merged.push({ ...seg })
    }
  }

  // Extend first to 0 if speech starts within 3s
  if (merged.length && merged[0].start < 3000) merged[0].start = 0
  // Extend last to audio end if within 3s
  if (merged.length) {
    const lastEnd = duration * 1000
    if (lastEnd - merged[merged.length-1].end < 3000) merged[merged.length-1].end = lastEnd
  }

  onLog && onLog(`Silero VAD: после слияния ${merged.length} микро-сег`, 'dm')

  // Build flagMap + chunks (times in seconds)
  const flagMap = new Map()
  const microSegsWithFlags = merged.map((seg, si) => {
    const flagId = buildFlagId(0, si)  // temporary, reassigned per chunk below
    return { ...seg, flagId }
  })

  // Group into chunks
  const rawChunks = groupIntoChunks(microSegsWithFlags, chunkSec)

  // Reassign flagIds per chunk
  const chunks = rawChunks.map((chunk, ci) => {
    const segs = chunk.segments.map((seg, si) => {
      const flagId = buildFlagId(ci, si)
      const startS = seg.start / 1000
      const endS   = seg.end   / 1000
      flagMap.set(flagId, { start: startS, end: endS })
      return { flagId, start: startS, end: endS }
    })
    return {
      t0: chunk.t0 / 1000,
      t1: chunk.t1 / 1000,
      segments: segs
    }
  })

  onProgress && onProgress(100, `Silero VAD ✓ — ${merged.length} сег → ${chunks.length} чанков`)
  onLog && onLog(`Silero VAD ✓ — ${merged.length} микро-сег → ${chunks.length} чанков`, 'ok')

  return { flagMap, chunks, totalMicroSegs: merged.length }
}
