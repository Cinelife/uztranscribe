/**
 * sileroVad.js — v14.1.0
 *
 * Возвращён как основной нейро-сегментатор.
 * Добавлено: Spectral Flatness фильтр музыки (flatness < SF_MUSIC_THRESH → тип 'music')
 *
 * ONNX I/O (silero_vad_legacy.onnx):
 *   Input:  input[1,512] float32, sr int64, h[2,1,64] float32, c[2,1,64] float32
 *   Output: output[1,1] float32, hn[2,1,64], cn[2,1,64]
 */

import { InferenceSession, Tensor, env as ortEnv } from 'onnxruntime-web/wasm'

// ── ONNX константы ────────────────────────────────────────────────────────────
const FRAME_SIZE    = 512
const TARGET_SR     = 16000
const POS_THRESH    = 0.50
const NEG_THRESH    = 0.35
const PRE_PAD_MS    = 96
const REDEMPTION_MS = 256
const MODEL_URL     = import.meta.env.BASE_URL + 'vad/silero_vad_legacy.onnx'

// ── Spectral Flatness: порог music/speech ─────────────────────────────────────
// Python: музыка=0.045, речь=0.012 → граница 0.025
// Если flatness < SF_MUSIC_THRESH → тональный сигнал (музыка без слов)
const SF_MUSIC_THRESH = 0.025
// Минимальная длина сегмента для классификации (короткие = шум, не фильтруем)
const SF_MIN_DUR_MS   = 500

// ── Singleton ONNX ────────────────────────────────────────────────────────────
let sessionPromise = null

async function getSession() {
  if (sessionPromise) {
    try { return await sessionPromise } catch (_) { sessionPromise = null }
  }
  sessionPromise = (async () => {
    ortEnv.wasm.numThreads = 1
    const resp = await fetch(MODEL_URL)
    if (!resp.ok) throw new Error(`Silero: HTTP ${resp.status}`)
    const modelData = new Uint8Array(await resp.arrayBuffer())
    return await InferenceSession.create(modelData, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  })()
  return sessionPromise
}

// ── Ресемплинг → 16kHz ────────────────────────────────────────────────────────
function resampleTo16k(samples, srcRate) {
  if (srcRate === TARGET_SR) return samples
  const ratio  = TARGET_SR / srcRate
  const outLen = Math.round(samples.length * ratio)
  const out    = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio
    const lo  = Math.floor(pos)
    const hi  = Math.min(lo + 1, samples.length - 1)
    out[i]    = samples[lo] * (1 - (pos - lo)) + samples[hi] * (pos - lo)
  }
  return out
}

// ── Spectral Flatness для сегмента ───────────────────────────────────────────
/**
 * Вычисляет Spectral Flatness (мера тональности) для отрезка аудио.
 * flatness = geometric_mean(|X[k]|) / arithmetic_mean(|X[k]|)
 * Музыка (тональная): ~0.04–0.08
 * Речь/шум (плоская): ~0.01–0.02
 *
 * @param {Float32Array} samples16k — весь аудиобуфер 16kHz
 * @param {number} startMs
 * @param {number} endMs
 * @returns {number} flatness 0..1
 */
function spectralFlatness(samples16k, startMs, endMs) {
  const s0      = Math.floor(startMs / 1000 * TARGET_SR)
  const s1      = Math.min(Math.floor(endMs / 1000 * TARGET_SR), samples16k.length)
  const len     = s1 - s0
  if (len < 256) return 1.0  // слишком коротко → не фильтруем

  // FFT через ручной DFT на первых 1024 сэмплах (достаточно для flatness)
  const N    = Math.min(1024, len)
  const half = N >> 1
  const mag  = new Float32Array(half)

  for (let k = 0; k < half; k++) {
    let re = 0, im = 0
    for (let n = 0; n < N; n++) {
      const angle = -2 * Math.PI * k * n / N
      re += samples16k[s0 + n] * Math.cos(angle)
      im += samples16k[s0 + n] * Math.sin(angle)
    }
    mag[k] = Math.sqrt(re * re + im * im) + 1e-10
  }

  // Geometric mean / Arithmetic mean
  let logSum = 0, linSum = 0
  for (let k = 1; k < half; k++) {  // k=0 — DC, пропускаем
    logSum += Math.log(mag[k])
    linSum += mag[k]
  }
  const n   = half - 1
  const geo = Math.exp(logSum / n)
  const ari = linSum / n
  return ari > 0 ? geo / ari : 1.0
}

// ── Основной VAD цикл ─────────────────────────────────────────────────────────
async function runVAD(samples16k) {
  const session = await getSession()
  const segments = []

  let h = new Float32Array(2 * 1 * 64)
  let c = new Float32Array(2 * 1 * 64)
  let inSpeech     = false
  let speechStart  = 0
  let redemptionCount = 0
  const prePadSamples  = Math.floor(PRE_PAD_MS    / 1000 * TARGET_SR)
  const redemptionFrames = Math.ceil(REDEMPTION_MS / 1000 * TARGET_SR / FRAME_SIZE)

  for (let offset = 0; offset + FRAME_SIZE <= samples16k.length; offset += FRAME_SIZE) {
    const frame   = samples16k.slice(offset, offset + FRAME_SIZE)
    const frameMs = (offset + FRAME_SIZE) / TARGET_SR * 1000

    const input = new Tensor('float32', frame, [1, FRAME_SIZE])
    const sr    = new Tensor('int64', BigInt64Array.from([BigInt(TARGET_SR)]), [])
    const hTens = new Tensor('float32', h, [2, 1, 64])
    const cTens = new Tensor('float32', c, [2, 1, 64])

    const out = await session.run({ input, sr, h: hTens, c: cTens })
    const prob = out.output.data[0]
    h = out.hn.data
    c = out.cn.data

    if (!inSpeech && prob >= POS_THRESH) {
      inSpeech    = true
      speechStart = Math.max(0, offset - prePadSamples) / TARGET_SR * 1000
      redemptionCount = 0
    } else if (inSpeech) {
      if (prob < NEG_THRESH) {
        redemptionCount++
        if (redemptionCount >= redemptionFrames) {
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
    segments.push({ start: speechStart, end: samples16k.length / TARGET_SR * 1000 })
  }
  return segments
}

// ── groupIntoChunks для multi-audio (макс BATCH_SIZE сегментов в пакете) ──────
const BATCH_SIZE = 10  // оптимум: меньше WAV → модель держит контекст

function groupIntoBatches(segments) {
  const batches = []
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    batches.push(segments.slice(i, i + BATCH_SIZE))
  }
  return batches
}

// ── Главная функция ───────────────────────────────────────────────────────────
/**
 * @param {File|AudioBuffer} input — файл или уже декодированный AudioBuffer
 * @param {function} onProgress
 * @param {function} onLog
 * @returns {{
 *   segments: Array<{flagId, start, end, type}>,  // type: 'speech'|'music'
 *   batches:  Array<Array<{flagId, start, end}>>,  // только speech, для dispatcher
 *   rawCount: number,
 *   speechCount: number,
 *   musicCount: number,
 * }}
 */
export async function segmentAudioSilero(input, onProgress, onLog) {
  onProgress && onProgress(5, 'Silero VAD: инициализация...')
  onLog && onLog('Silero VAD: загрузка модели...', 'dm')

  // Декодирование
  let samples16k, durationMs

  if (input instanceof AudioBuffer) {
    const src  = input.getChannelData(0)
    samples16k = resampleTo16k(src, input.sampleRate)
    durationMs = input.duration * 1000
    onLog && onLog(`Silero VAD: AudioBuffer ${(durationMs/1000).toFixed(1)}с → ресемплинг`, 'dm')
  } else {
    const ab   = await input.arrayBuffer()
    const ctx  = new (window.AudioContext || window.webkitAudioContext)()
    const buf  = await ctx.decodeAudioData(ab)
    ctx.close()
    samples16k = resampleTo16k(buf.getChannelData(0), buf.sampleRate)
    durationMs = buf.duration * 1000
    onLog && onLog(`Silero VAD: ${(durationMs/1000).toFixed(1)}с → ONNX wasm...`, 'dm')
  }

  onProgress && onProgress(15, 'Silero VAD: анализ речи...')

  // VAD
  const rawSegs  = await runVAD(samples16k)
  const rawCount = rawSegs.length
  onLog && onLog(`Silero VAD: ${rawCount} raw сегментов`, 'dm')
  onProgress && onProgress(70, `Silero VAD: классификация ${rawCount} сег...`)

  // Spectral Flatness классификация
  let speechCount = 0, musicCount = 0
  const classified = rawSegs.map((seg, i) => {
    const dur  = seg.end - seg.start
    let type   = 'speech'

    if (dur >= SF_MIN_DUR_MS) {
      const sf = spectralFlatness(samples16k, seg.start, seg.end)
      if (sf < SF_MUSIC_THRESH) {
        type = 'music'
        musicCount++
      } else {
        speechCount++
      }
    } else {
      speechCount++
    }

    return {
      flagId: String(i).padStart(4, '0'),
      start:  seg.start / 1000,  // → секунды
      end:    seg.end   / 1000,
      type,
    }
  })

  onLog && onLog(
    `Silero VAD ✓ — raw:${rawCount} | speech:${speechCount} | music:${musicCount}`,
    'ok'
  )

  // Только speech сегменты для dispatcher
  const speechSegs = classified.filter(s => s.type === 'speech')
  const batches    = groupIntoBatches(speechSegs)

  onProgress && onProgress(100, `Silero VAD ✓ — ${speechCount} речевых сег → ${batches.length} пакетов`)

  return {
    segments:    classified,   // все (включая music) для assembler
    batches,                   // только speech, для dispatcher
    rawCount,
    speechCount,
    musicCount,
  }
}
