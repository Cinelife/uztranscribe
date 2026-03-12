/**
 * assembler.js — v13.0.0
 *
 * Изменения vs v12.5.4:
 *
 * НОВОЕ — rmsSubCut():
 *   Заменяет useRmsTiming/useFFT/expandSegment для длинных VAD-сегментов.
 *   Находит реальные RMS-минимумы (паузы) внутри сегмента и режет там.
 *   Текст делится пропорционально длительности получившихся частей.
 *   Старый подход делил слова по энергии → MAE 1.23с (хуже чем без него 0.53с).
 *   Новый подход ищет РЕАЛЬНЫЕ паузы → ожидается MAE < 0.53с.
 *
 * ПАРАМЕТР targetDur (новый, из UI):
 *   Целевая длина субтитра в секундах (1.0 / 1.5 / 2.0 / 2.5 / 3.0).
 *   Сегмент длиннее targetDur × 1.4 → кандидат на разрезку.
 *   Дефолт: 1.5с (близко к manual avg=1.49с).
 *
 * УБРАНО:
 *   - useRmsTiming (доказано вредит по тестам)
 *   - useFFT / ZCR-weighted timing (то же)
 *   - expandSegment() — заменён rmsSubCut()
 *   - rmsIntegralBoundaries() / zcrIntegralBoundaries() — убраны
 *
 * ИСПРАВЛЕНО:
 *   - БАГ #2 (v12.5.4): mixed-сегменты НЕ пропускаются при showMusicMarker=false
 *     mixed = речь поверх музыки → выводится как обычный субтитр
 *
 * СОХРАНЕНО:
 *   - subTiming='words' legacy path (для Vosk/Smart Silence)
 *   - Dedup, mergeStrict/Balanced/Sentence
 *   - factorMap принимается но пока не используется (зарезервировано для P4)
 */

import { buildSrt } from './srtUtils.js'

// ── Нормализация текста для dedup ─────────────────────────────────────────────
function norm(t) {
  return t.toLowerCase().replace(/[.,!?'"]/g, '').replace(/\s+/g, ' ').trim()
}

// ── ♪ маркер парсер ───────────────────────────────────────────────────────────
function parseMarker(raw) {
  const t = (raw || '').trim()
  if (!t)                                              return { type: 'silent', text: '' }
  if (t === '♪')                                       return { type: 'music',  text: '♪' }
  if (t.startsWith('♪') && t.endsWith('♪') && t.length > 1) return { type: 'mixed', text: t }
  if (t.startsWith('♪ ') || t.endsWith(' ♪') || t.endsWith('♪')) return { type: 'mixed', text: t }
  return { type: 'speech', text: t }
}

// ── RMS sub-cut — главная новая функция ──────────────────────────────────────
/**
 * Разрезает длинный VAD-сегмент по реальным RMS-минимумам (паузам).
 *
 * Алгоритм:
 *   1. Вычисляем RMS в 20мс фреймах по всей длине сегмента
 *   2. Определяем сколько разрезов нужно: nCuts = floor(dur / targetDur) - 1
 *   3. Для каждого разреза i: идеальное время = start + (i+1) * targetDur
 *      Окно поиска: ±40% targetDur вокруг идеального времени
 *      Берём фрейм с минимальным RMS в этом окне → реальная пауза
 *   4. Делим текст пропорционально длительности каждой части (по символам)
 *
 * @param {AudioBuffer} audioBuf
 * @param {{start, end, text, type}} seg
 * @param {number} targetDur  — целевая длина субтитра (секунды)
 * @param {number} maxChars   — макс. символов на строку
 * @returns {Array<{start, end, text, type}>}
 */
function rmsSubCut(audioBuf, seg, targetDur, maxChars) {
  const dur = seg.end - seg.start
  // Не режем если: короткий, мало текста, нет буфера
  if (!audioBuf || dur <= targetDur * 1.4 || seg.text.trim().split(/\s+/).length < 4) {
    return [seg]
  }

  const sr     = audioBuf.sampleRate
  const nc     = audioBuf.numberOfChannels
  const s0     = Math.max(0, Math.floor(seg.start * sr))
  const s1     = Math.min(audioBuf.length, Math.ceil(seg.end * sr))
  const len    = s1 - s0
  const FRAME  = Math.max(1, Math.floor(sr * 0.02)) // 20мс фреймы
  const nFrames = Math.ceil(len / FRAME)

  if (nFrames < 4) return [seg]

  // 1. Вычисляем RMS по фреймам
  const rms = new Float32Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    let sum = 0, cnt = 0
    for (let c = 0; c < nc; c++) {
      const ch = audioBuf.getChannelData(c)
      for (let i = f * FRAME; i < Math.min((f + 1) * FRAME, len); i++) {
        sum += ch[s0 + i] * ch[s0 + i]; cnt++
      }
    }
    rms[f] = cnt > 0 ? Math.sqrt(sum / cnt) : 0
  }

  // Лёгкое сглаживание (3-фрейм скользящее среднее) — убирает артефакты
  const smoothed = new Float32Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    const lo = Math.max(0, f - 1), hi = Math.min(nFrames - 1, f + 1)
    let s = 0, cnt = 0
    for (let k = lo; k <= hi; k++) { s += rms[k]; cnt++ }
    smoothed[f] = s / cnt
  }

  // 2. Сколько разрезов нужно
  const nCuts = Math.max(1, Math.floor(dur / targetDur) - 1)

  // Минимальный зазор между разрезами (40% targetDur в фреймах)
  const minGapFrames = Math.floor(targetDur * 0.4 * sr / FRAME)

  // 3. Ищем минимальный RMS в окне вокруг каждого идеального времени
  const cutTimes = []
  const searchHalf = Math.floor(targetDur * 0.4 * sr / FRAME) // ±40%

  for (let ci = 1; ci <= nCuts; ci++) {
    const idealSec   = seg.start + ci * (dur / (nCuts + 1))
    const idealFrame = Math.floor((idealSec - seg.start) * sr / FRAME)
    const loF = Math.max(1, idealFrame - searchHalf)
    const hiF = Math.min(nFrames - 2, idealFrame + searchHalf)

    let bestFrame = idealFrame, bestRms = Infinity
    for (let f = loF; f <= hiF; f++) {
      // Не ближе minGapFrames к предыдущему разрезу
      const prevCutFrame = cutTimes.length > 0
        ? Math.floor((cutTimes[cutTimes.length - 1] - seg.start) * sr / FRAME)
        : 0
      if (f - prevCutFrame < minGapFrames) continue

      if (smoothed[f] < bestRms) {
        bestRms = smoothed[f]
        bestFrame = f
      }
    }
    const cutTime = seg.start + bestFrame * FRAME / sr
    // Не добавляем если слишком близко к началу или концу
    if (cutTime > seg.start + 0.2 && cutTime < seg.end - 0.2) {
      cutTimes.push(cutTime)
    }
  }

  if (cutTimes.length === 0) return [seg]

  // 4. Разрезаем: делим текст по СЛОВАМ пропорционально длительности частей
  const boundaries = [seg.start, ...cutTimes, seg.end]
  const words = seg.text.trim().split(/\s+/)
  const nWords = words.length
  const parts = []

  let wordOffset = 0
  for (let pi = 0; pi < boundaries.length - 1; pi++) {
    const partStart = boundaries[pi]
    const partEnd   = boundaries[pi + 1]
    const partDur   = partEnd - partStart
    const isLast    = pi === boundaries.length - 2

    // Кол-во слов для этой части = пропорция длительности × всего слов
    const partWords = isLast
      ? nWords - wordOffset  // последняя часть — все оставшиеся слова
      : Math.max(1, Math.round(nWords * (partDur / dur)))

    const slice = words.slice(wordOffset, wordOffset + partWords)
    wordOffset += partWords

    const partText = slice.join(' ')
    if (partText) {
      parts.push({
        start: partStart,
        end:   partEnd,
        text:  partText,
        type:  seg.type,
      })
    }
  }

  return parts.length > 0 ? parts : [seg]
}

// ── Hard split по maxChars (финальный проход) ─────────────────────────────────
function hardSplitByChars(seg, maxChars) {
  if (seg.text.length <= maxChars) return [seg]
  const words = seg.text.split(' ')
  const dur   = seg.end - seg.start
  const wDur  = dur / words.length
  const result = []
  let line = '', lineStart = seg.start
  for (let wi = 0; wi < words.length; wi++) {
    const candidate = line ? line + ' ' + words[wi] : words[wi]
    if (candidate.length > maxChars && line) {
      result.push({ start: lineStart, end: lineStart + wDur * line.split(' ').length, text: line, type: seg.type })
      lineStart += wDur * line.split(' ').length
      line = words[wi]
    } else {
      line = candidate
    }
  }
  if (line) result.push({ start: lineStart, end: seg.end, text: line, type: seg.type })
  return result
}

// ── Legacy: expandSegment для subTiming='words' (Vosk/Smart Silence) ─────────
function expandSegmentWords(seg, maxChars) {
  const words = seg.text.trim().split(/\s+/)
  const n     = words.length
  const dur   = seg.end - seg.start
  const wDur  = dur / n
  const result = []
  let line = '', lineStart = seg.start
  for (let wi = 0; wi < n; wi++) {
    const candidate = line ? line + ' ' + words[wi] : words[wi]
    if (candidate.length > maxChars && line) {
      result.push({ start: lineStart, end: lineStart + wDur * line.split(' ').length, text: line, type: seg.type })
      lineStart += wDur * line.split(' ').length
      line = words[wi]
    } else {
      line = candidate
    }
  }
  if (line) result.push({ start: lineStart, end: seg.end, text: line, type: seg.type })
  return result
}

// ── Merge modes ───────────────────────────────────────────────────────────────
function mergeStrict(segs, maxChars, mergeGap) {
  const out = []; let cur = { ...segs[0] }
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap = next.start - cur.end
    if (combined.length <= maxChars && gap < mergeGap) {
      cur = { start: cur.start, end: next.end, text: combined, type: cur.type }
    } else { out.push(cur); cur = { ...next } }
  }
  out.push(cur); return out
}

function mergeBalanced(segs, maxChars, mergeGap) {
  const target = Math.floor(maxChars * 0.75)
  const out = []; let cur = { ...segs[0] }
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap = next.start - cur.end
    if (combined.length <= maxChars && gap < mergeGap &&
        (cur.text.length < target || gap < 0.2)) {
      cur = { start: cur.start, end: next.end, text: combined, type: cur.type }
    } else { out.push(cur); cur = { ...next } }
  }
  out.push(cur); return out
}

function mergeSentence(segs, maxChars, mergeGap) {
  const BREAK = /[.!?](\s|$)/
  const out = []; let cur = { ...segs[0] }
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap = next.start - cur.end
    const endsAtBreak = BREAK.test(cur.text.trim())
    if (combined.length <= maxChars && gap < mergeGap && !endsAtBreak) {
      cur = { start: cur.start, end: next.end, text: combined, type: cur.type }
    } else { out.push(cur); cur = { ...next } }
  }
  out.push(cur)
  const final = []
  for (const seg of out) {
    if (seg.text.length <= maxChars) { final.push(seg); continue }
    final.push(...hardSplitByChars(seg, maxChars))
  }
  return final
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param flagMap         Map<flagId, {start, end}>
 * @param textMap         Map<flagId, string>
 * @param maxChars        макс. символов на строку субтитра
 * @param mergeGap        макс. зазор для слияния сегментов (сек)
 * @param mergeMode       'strict'|'balanced'|'sentence'
 * @param dedupWindow     0=выкл, 1–20=скользящее окно
 * @param subTiming       'vad'|'words' (words — legacy Vosk/Smart Silence)
 * @param audioBuf        AudioBuffer для RMS sub-cut (null = пропустить)
 * @param targetDur       v13: целевая длина субтитра (сек), из UI
 * @param showMusicMarker включить ♪ в SRT
 * @param factorMap       зарезервировано (будущий P4)
 */
export function assemble(
  flagMap,
  textMap,
  maxChars        = 80,
  mergeGap        = 0.5,
  mergeMode       = 'strict',
  dedupWindow     = 0,
  subTiming       = 'vad',
  audioBuf        = null,
  targetDur       = 1.5,   // v13: новый параметр
  showMusicMarker = false,
  factorMap       = null   // зарезервировано
) {
  // ── Collect + parse ♪ markers ──────────────────────────────────────────────
  const allSegs = []
  for (const [flagId, times] of flagMap) {
    const raw    = (textMap.get(flagId) || '').trim()
    const parsed = parseMarker(raw)

    if (parsed.type === 'silent') continue

    if (parsed.type === 'music') {
      if (showMusicMarker) {
        allSegs.push({ start: times.start, end: times.end, text: '♪', type: 'music' })
      }
      continue
    }

    // v13 БАГ #2 ИСПРАВЛЕН: mixed НЕ пропускается — это речь поверх музыки
    // Было: if (!showMusicMarker && (seg.type === 'music' || seg.type === 'mixed')) continue
    // Теперь: mixed всегда добавляется как обычный субтитр
    allSegs.push({ start: times.start, end: times.end, text: parsed.text, type: parsed.type })
  }

  allSegs.sort((a, b) => a.start - b.start)
  if (allSegs.length === 0) return ''

  // ── Legacy: subTiming='words' (Vosk/Smart Silence path) ───────────────────
  if (subTiming === 'words') {
    const expanded = []
    for (const seg of allSegs) {
      if (seg.type === 'music') { expanded.push(seg); continue }
      expanded.push(...expandSegmentWords(seg, maxChars))
    }
    for (let i = 0; i < expanded.length - 1; i++) {
      if (expanded[i].end > expanded[i + 1].start - 0.05)
        expanded[i].end = Math.max(expanded[i].start + 0.1, expanded[i + 1].start - 0.05)
    }
    return buildSrt(expanded)
  }

  // ── v13: RMS sub-cut для длинных VAD-сегментов ────────────────────────────
  // Всегда активен если есть audioBuf (не экспериментальный, а основной путь)
  let segs = allSegs
  if (audioBuf) {
    const expanded = []
    for (const seg of allSegs) {
      if (seg.type === 'music') { expanded.push(seg); continue }
      expanded.push(...rmsSubCut(audioBuf, seg, targetDur, maxChars))
    }
    segs = expanded
  }

  // ── Dedup ──────────────────────────────────────────────────────────────────
  let deduped
  if (dedupWindow === 0) {
    deduped = segs
  } else {
    deduped = [segs[0]]
    for (let i = 1; i < segs.length; i++) {
      const curr = norm(segs[i].text)
      if (segs[i].type === 'music') { deduped.push(segs[i]); continue }
      const windowStart = Math.max(0, deduped.length - dedupWindow)
      const isDup = deduped.slice(windowStart).some(prev => {
        if (prev.type === 'music') return false
        const p = norm(prev.text)
        if (p === curr && curr.length > 4) return true
        const cw = curr.split(' ').length, pw = p.split(' ').length
        if (Math.min(cw, pw) >= 3 && (p.includes(curr) || curr.includes(p))) return true
        const pwSet = new Set(p.split(' ').filter(w => w.length > 3))
        const cwArr = curr.split(' ').filter(w => w.length > 3)
        if (pwSet.size < 4 || cwArr.length < 4) return false
        return cwArr.filter(w => pwSet.has(w)).length / Math.max(pwSet.size, cwArr.length) > 0.75
      })
      if (!isDup) deduped.push(segs[i])
    }
  }

  // ── Merge ──────────────────────────────────────────────────────────────────
  const speechSegs = deduped.filter(s => s.type !== 'music')
  const musicSegs  = deduped.filter(s => s.type === 'music')

  let merged
  if (speechSegs.length === 0) {
    merged = musicSegs
  } else {
    let mergedSpeech
    if (mergeMode === 'balanced')  mergedSpeech = mergeBalanced(speechSegs, maxChars, mergeGap)
    else if (mergeMode === 'sentence') mergedSpeech = mergeSentence(speechSegs, maxChars, mergeGap)
    else                           mergedSpeech = mergeStrict(speechSegs, maxChars, mergeGap)

    merged = [...mergedSpeech, ...musicSegs].sort((a, b) => a.start - b.start)
  }

  // ── Clamp overlaps ─────────────────────────────────────────────────────────
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i].end > merged[i + 1].start - 0.05)
      merged[i].end = Math.max(merged[i].start + 0.1, merged[i + 1].start - 0.05)
  }

  // ── Hard split по maxChars ─────────────────────────────────────────────────
  const final = []
  for (const seg of merged) {
    final.push(...hardSplitByChars(seg, maxChars))
  }

  return buildSrt(final)
}
