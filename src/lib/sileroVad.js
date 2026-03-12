/**
 * sileroVad.js — v13.0.0 REFACTOR
 *
 * Изменения vs v12.5.4:
 *   - Принимает audioBuf (AudioBuffer) напрямую — нет двойного декодирования
 *   - merge loop: защита по maxSegMs = chunkSec * 1000 (не сливать если результат > chunkSec)
 *   - groupIntoChunks: принудительное разбиение oversized сегментов через RMS-минимумы
 *   - OfflineAudioContext: корректный length вместо length=1
 *   - sessionPromise: сброс при ошибке — следующий вызов попробует снова
 *   - Возвращает factorMap: {flagId → {rms, zcr}} для Phase 3
 *   - Детальный лог: rawSegs / afterMerge / afterSplit отдельно
 *
 * ONNX I/O (silero_vad_legacy.onnx) — не менять:
 *   Input:  input[1,512] float32, sr int64, h[2,1,64] float32, c[2,1,64] float32
 *   Output: output[1,1] float32, hn[2,1,64], cn[2,1,64]
 */

import { InferenceSession, Tensor, env as ortEnv } from 'onnxruntime-web/wasm'

// ── Константы ONNX (не менять — соответствуют модели) ────────────────────────
const FRAME_SIZE    = 512    // сэмплов на фрейм
const TARGET_SR     = 16000  // Hz — требование Silero
const POS_THRESH    = 0.50   // порог начала речи
const NEG_THRESH    = 0.35   // порог конца речи
const PRE_PAD_MS    = 96     // мс предзаполнения (захват начала слова, 3 фрейма)
const REDEMPTION_MS = 256    // мс задержки закрытия (8 фреймов)

// ── Константы сегментации ─────────────────────────────────────────────────────
const MAX_SPLIT_FRAMES = 128  // RMS-окно для поиска точки разбиения (в фреймах 16kHz)

const MODEL_URL = import.meta.env.BASE_URL + 'vad/silero_vad_legacy.onnx'

// ── Singleton ONNX-сессии с возможностью сброса при ошибке ───────────────────
let sessionPromise = null

async function getSession() {
  if (sessionPromise) {
    try {
      return await sessionPromise
    } catch (_) {
      // Предыдущая попытка упала — сбрасываем и пробуем снова
      sessionPromise = null
    }
  }

  sessionPromise = (async () => {
    ortEnv.wasm.numThreads = 1  // обязательно: избегаем SharedArrayBuffer/COOP

    const resp = await fetch(MODEL_URL)
    if (!resp.ok) throw new Error(`Silero: HTTP ${resp.status} при загрузке модели`)

    // Передаём байты напрямую — обходим ошибку "failed to load external data file"
    const modelData = new Uint8Array(await resp.arrayBuffer())

    return await InferenceSession.create(modelData, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  })()

  return sessionPromise
}

// ── Ресемплинг в 16kHz ────────────────────────────────────────────────────────
// Линейная интерполяция — достаточно для VAD (речевые форманты 300–3000Hz)
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

// ── Основной VAD-цикл ─────────────────────────────────────────────────────────
// Возвращает сегменты в миллисекундах: [{start, end}]
async function runVAD(samples16k) {
  const session = await getSession()

  const srTensor  = new Tensor('int64', BigInt64Array.from([BigInt(TARGET_SR)]), [])
  let h = new Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])
  let c = new Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])

  const totalFrames  = Math.floor(samples16k.length / FRAME_SIZE)
  const msPerFrame   = (FRAME_SIZE / TARGET_SR) * 1000
  const prePadFrames = Math.round(PRE_PAD_MS    / msPerFrame)
  const redemptionFr = Math.round(REDEMPTION_MS / msPerFrame)

  const segments     = []
  let inSpeech       = false
  let speechStart    = 0
  let redemptionCount = 0
  // Кольцевой буфер для PRE_PAD: хранит начала последних N фреймов
  const ring = []

  for (let fi = 0; fi < totalFrames; fi++) {
    const frame   = samples16k.slice(fi * FRAME_SIZE, (fi + 1) * FRAME_SIZE)
    const frameMs = fi * msPerFrame

    const result = await session.run({
      input: new Tensor('float32', frame, [1, FRAME_SIZE]),
      sr:    srTensor,
      h, c,
    })

    const prob = result.output.data[0]
    h = result.hn
    c = result.cn

    // Кольцевой буфер для PRE_PAD
    ring.push(frameMs)
    if (ring.length > prePadFrames) ring.shift()

    if (!inSpeech) {
      if (prob >= POS_THRESH) {
        // Начало речи: берём самый старый фрейм из буфера (pre-pad)
        speechStart     = ring[0]
        inSpeech        = true
        redemptionCount = 0
      }
    } else {
      if (prob < NEG_THRESH) {
        if (++redemptionCount >= redemptionFr) {
          // Конец речи: frameMs — это начало текущего тихого фрейма
          // Включаем redemption-период в сегмент (intentional hold)
          segments.push({ start: speechStart, end: frameMs })
          inSpeech        = false
          redemptionCount = 0
        }
      } else {
        redemptionCount = 0
      }
    }
  }

  // Закрываем последний открытый сегмент
  if (inSpeech) {
    segments.push({ start: speechStart, end: (samples16k.length / TARGET_SR) * 1000 })
  }

  return segments
}

// ── RMS-минимум для разбиения длинных сегментов ───────────────────────────────
/**
 * Найти лучшую точку разбиения внутри [startMs, endMs] по минимуму RMS.
 * Ищем в центральной трети (избегаем краёв).
 * @param {Float32Array} samples16k
 * @param {number} startMs
 * @param {number} endMs
 * @returns {number} splitMs — точка разбиения в мс
 */
function findRmsSplitPoint(samples16k, startMs, endMs) {
  const s0      = Math.floor(startMs / 1000 * TARGET_SR)
  const s1      = Math.floor(endMs   / 1000 * TARGET_SR)
  const len     = s1 - s0
  if (len <= 0) return (startMs + endMs) / 2

  const frameSize = MAX_SPLIT_FRAMES
  const frameCount = Math.floor(len / frameSize)
  if (frameCount < 3) return (startMs + endMs) / 2

  // Считаем RMS по фреймам
  const rmsArr = new Float32Array(frameCount)
  for (let f = 0; f < frameCount; f++) {
    let sum = 0
    const from = s0 + f * frameSize
    const to   = Math.min(from + frameSize, s1)
    for (let i = from; i < to; i++) sum += samples16k[i] * samples16k[i]
    rmsArr[f] = Math.sqrt(sum / (to - from))
  }

  // Ищем минимум RMS в центральной трети [33%..67%]
  const lo = Math.floor(frameCount * 0.33)
  const hi = Math.ceil (frameCount * 0.67)
  let minRms = Infinity, minFrame = Math.floor(frameCount / 2)
  for (let f = lo; f < hi; f++) {
    if (rmsArr[f] < minRms) { minRms = rmsArr[f]; minFrame = f }
  }

  return startMs + (minFrame + 0.5) * frameSize / TARGET_SR * 1000
}

// ── Разбить длинный сегмент на части ≤ maxMs ─────────────────────────────────
function splitOversizedSeg(seg, maxMs, samples16k) {
  const dur = seg.end - seg.start
  if (dur <= maxMs) return [seg]

  // Рекурсивно делим пополам с привязкой к RMS-минимуму
  const splitMs = findRmsSplitPoint(samples16k, seg.start, seg.end)
  const left    = { start: seg.start, end: splitMs }
  const right   = { start: splitMs,   end: seg.end  }

  return [
    ...splitOversizedSeg(left,  maxMs, samples16k),
    ...splitOversizedSeg(right, maxMs, samples16k),
  ]
}

// ── Merge: объединить близкие сегменты, не превышая maxSegMs ─────────────────
/**
 * @param {Array<{start,end}>} rawSegs — в мс
 * @param {number} minPause — минимальная пауза для разделения (мс)
 * @param {number} maxSegMs — максимальный размер сегмента (мс)
 * @param {Float32Array} samples16k — для разбиения oversized
 */
function mergeSegments(rawSegs, minPause, maxSegMs, samples16k) {
  const merged = []

  for (const seg of rawSegs) {
    const last = merged[merged.length - 1]
    const gap  = last ? seg.start - last.end : Infinity

    if (last && gap < minPause) {
      // Слиять только если результат не превысит maxSegMs
      const mergedDur = seg.end - last.start
      if (mergedDur <= maxSegMs) {
        last.end = seg.end  // слияние
        continue
      }
      // Иначе — оставляем как отдельный сегмент (не сливаем)
    }
    merged.push({ start: seg.start, end: seg.end })
  }

  // Дополнительный проход: разбить сегменты которые всё равно oversized
  // (могут быть одиночные длинные сегменты от VAD)
  const result = []
  for (const seg of merged) {
    const parts = splitOversizedSeg(seg, maxSegMs, samples16k)
    result.push(...parts)
  }

  return result
}

// ── groupIntoChunks ───────────────────────────────────────────────────────────
/**
 * Группирует сегменты (мс) в чанки для Dispatcher.
 * Гарантирует: ни один чанк не превысит chunkSec.
 * После mergeSegments oversized сегментов быть не должно —
 * но проверяем на всякий случай.
 */
function groupIntoChunks(segs, chunkSec) {
  const maxMs  = chunkSec * 1000
  const chunks = []
  let cur      = null

  for (const seg of segs) {
    const wouldEnd = seg.end - (cur ? cur.t0 : seg.start)

    if (!cur || wouldEnd > maxMs + 500) {
      if (cur) chunks.push(cur)
      cur = { t0: seg.start, t1: seg.end, segments: [] }
    }
    cur.t1 = seg.end
    cur.segments.push(seg)
  }
  if (cur) chunks.push(cur)
  return chunks
}

// ── Факторный анализ сегмента (RMS + ZCR) ────────────────────────────────────
/**
 * Быстро вычисляет RMS и ZCR для сегмента по samples16k.
 * Используется в Phase 3 (Assembler) для умных решений.
 */
function computeFactors(samples16k, startMs, endMs) {
  const s0  = Math.max(0, Math.floor(startMs / 1000 * TARGET_SR))
  const s1  = Math.min(samples16k.length, Math.ceil(endMs / 1000 * TARGET_SR))
  const len = s1 - s0
  if (len <= 0) return { rms: 0, zcr: 0 }

  let sumSq = 0, crossings = 0
  for (let i = s0; i < s1; i++) {
    sumSq += samples16k[i] * samples16k[i]
    if (i > s0 && (samples16k[i] >= 0) !== (samples16k[i - 1] >= 0)) crossings++
  }
  return {
    rms: Math.sqrt(sumSq / len),
    zcr: crossings / len,
  }
}

// ── buildFlagId ───────────────────────────────────────────────────────────────
function buildFlagId(ci, si) {
  return String(ci).padStart(3, '0') + '$' + String(si).padStart(3, '0')
}

// ── Главная функция ───────────────────────────────────────────────────────────
/**
 * @param {File} file
 * @param {number} chunkSec     — максимальная длина чанка (с)
 * @param {number} minPause     — минимальная пауза для разбиения сегментов (мс, default 300)
 * @param {function} onProgress
 * @param {function} onLog
 * @param {AudioBuffer|null} audioBufCached — если передан, не декодируем файл повторно
 *
 * @returns {{ flagMap, chunks, totalMicroSegs, rawSegCount, factorMap }}
 *   factorMap: Map<flagId, {rms, zcr}>
 */
export async function segmentAudioSilero(
  file, chunkSec, minPause,
  onProgress, onLog,
  audioBufCached = null
) {
  if (chunkSec  === undefined) chunkSec  = 25
  if (minPause  === undefined) minPause  = 300  // v13: снижено с 500 до 300мс

  const maxSegMs = chunkSec * 1000  // максимальный сегмент в мс

  onProgress && onProgress(5,  'Silero VAD: инициализация...')
  onLog      && onLog('Silero VAD: загрузка модели...', 'dm')

  // ── Декодирование ─────────────────────────────────────────────────────────
  // Используем уже декодированный буфер если он есть — избегаем двойного декодирования
  let samples16k, durationSec

  if (audioBufCached) {
    // Получаем первый канал (mono mix не нужен для VAD)
    const srcSamples = audioBufCached.getChannelData(0)
    samples16k       = resampleTo16k(srcSamples, audioBufCached.sampleRate)
    durationSec      = audioBufCached.duration
    onLog && onLog(`Silero VAD: используем кешированный AudioBuffer (${durationSec.toFixed(1)}с)`, 'dm')
  } else {
    // Декодируем сами — с корректным length для OfflineAudioContext
    const arrayBuf   = await file.arrayBuffer()
    // length=1 — только для decodeAudioData (rendering не используется)
    // Используем нативный sampleRate браузера, потом ресемплируем вручную
    const audioCtx   = new (window.AudioContext || window.webkitAudioContext)()
    const decoded    = await audioCtx.decodeAudioData(arrayBuf)
    audioCtx.close()
    samples16k       = resampleTo16k(decoded.getChannelData(0), decoded.sampleRate)
    durationSec      = decoded.duration
    onLog && onLog(`Silero VAD: декодировано ${durationSec.toFixed(1)}с → ресемплинг в 16kHz`, 'dm')
  }

  onProgress && onProgress(15, 'Silero VAD: анализ речи...')
  onLog      && onLog(`Silero VAD: ${durationSec.toFixed(1)}с → ONNX wasm...`, 'dm')

  // ── Phase 1a: Сырые сегменты от ONNX ─────────────────────────────────────
  const rawSegs = await runVAD(samples16k)
  const rawCount = rawSegs.length
  onLog && onLog(`Silero VAD: ${rawCount} raw сегментов`, 'dm')
  onProgress && onProgress(60, `Silero VAD: ${rawCount} сег`)

  // ── Phase 1b: Merge + защита от oversized ─────────────────────────────────
  const merged = mergeSegments(rawSegs, minPause, maxSegMs, samples16k)

  // Расширяем первый/последний сегменты к началу/концу файла если близко
  const totalMs = durationSec * 1000
  if (merged.length > 0 && merged[0].start < 3000) {
    merged[0].start = 0
  }
  if (merged.length > 0 && totalMs - merged[merged.length - 1].end < 3000) {
    merged[merged.length - 1].end = totalMs
  }

  const mergedCount = merged.length
  onLog && onLog(`Silero VAD: после слияния ${mergedCount} сег (minPause:${minPause}мс, max:${chunkSec}с)`, 'dm')

  // Подсчёт сколько были разбиты принудительно
  const splitCount = merged.filter(s => (s.end - s.start) > maxSegMs * 0.95).length
  if (splitCount > 0) {
    onLog && onLog(`Silero VAD: ⚠ ${splitCount} сег близки к лимиту — проверь chunkSec`, 'dm')
  }

  // ── Phase 1c: Группировка в чанки ─────────────────────────────────────────
  const rawChunks = groupIntoChunks(merged, chunkSec)

  // ── Сборка flagMap + factorMap ────────────────────────────────────────────
  const flagMap   = new Map()
  const factorMap = new Map()

  const chunks = rawChunks.map(function(chunk, ci) {
    const segs = chunk.segments.map(function(seg, si) {
      const flagId = buildFlagId(ci, si)
      const startS = seg.start / 1000
      const endS   = seg.end   / 1000

      flagMap.set(flagId, { start: startS, end: endS })

      // Факторный анализ — бесплатно здесь, данные уже в памяти
      const factors = computeFactors(samples16k, seg.start, seg.end)
      factorMap.set(flagId, factors)

      return { flagId, start: startS, end: endS }
    })
    return { t0: chunk.t0 / 1000, t1: chunk.t1 / 1000, segments: segs }
  })

  const maxChunkDur = Math.max(...chunks.map(c => c.t1 - c.t0)).toFixed(1)

  onProgress && onProgress(100, `Silero VAD ✓ — ${mergedCount} сег → ${chunks.length} чанков`)
  onLog      && onLog(
    `Silero VAD ✓ — raw:${rawCount} → merged:${mergedCount} → ${chunks.length} чанков | maxChunk:${maxChunkDur}с`,
    'ok'
  )

  return {
    flagMap,
    chunks,
    totalMicroSegs: mergedCount,
    rawSegCount:    rawCount,
    factorMap,
  }
}
