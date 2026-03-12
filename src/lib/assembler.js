/**
 * assembler.js — v13.1.0  "last hope" clean build
 *
 * Принцип: минимум кода, максимум предсказуемости.
 * Убрано всё экспериментальное: rmsSubCut, micro-merge, MIN_PART_DUR.
 * Оставлено только то, что доказанно работает:
 *   - Dedup → Merge → hardSplitByWords (правильный порядок)
 *   - БАГ #2 исправлен: mixed-сегменты не пропускаются
 *   - Разбивка по словам, НЕ по символам
 *
 * Почему "by words" важно:
 *   hardSplitByChars в предыдущих версиях уже делал word-split,
 *   но функция переименована и задокументирована явно чтобы
 *   исключить любые сомнения и будущий регресс.
 *
 * Корень проблемы "tack dasturlash" / "sqacha tarkibi":
 *   Это НЕ assembler — это VAD-граница разрезающая слово в аудио.
 *   Фиксится в sileroVad.js: minPause 300мс → 500мс.
 */

import { buildSrt } from './srtUtils.js'

// ── Нормализация текста для dedup ─────────────────────────────────────────────
function norm(t) {
  return t.toLowerCase().replace(/[.,!?'"]/g, '').replace(/\s+/g, ' ').trim()
}

// ── ♪ маркер парсер ───────────────────────────────────────────────────────────
function parseMarker(raw) {
  const t = (raw || '').trim()
  if (!t)                                                        return { type: 'silent', text: '' }
  if (t === '♪')                                                 return { type: 'music',  text: '♪' }
  if (t.startsWith('♪') && t.endsWith('♪') && t.length > 1)    return { type: 'mixed',  text: t }
  if (t.startsWith('♪ ') || t.endsWith(' ♪') || t.endsWith('♪')) return { type: 'mixed', text: t }
  return { type: 'speech', text: t }
}

// ── Hard split по maxChars — по СЛОВАМ, не по символам ───────────────────────
/**
 * Делит сегмент на строки ≤ maxChars, разрезая только по границам слов.
 * Время делится пропорционально количеству слов в каждой части.
 *
 * Важно: никогда не разрезает слово посередине.
 * "full-stack dasturlash" при maxChars=15 → "full-stack" + "dasturlash"
 * НЕ → "full-stack das" + "turlash"
 */
function hardSplitByWords(seg, maxChars) {
  if (seg.text.length <= maxChars) return [seg]

  const words = seg.text.trim().split(/\s+/)
  if (words.length <= 1) return [seg]  // одно длинное слово — не разрезаем

  const dur  = seg.end - seg.start
  const wDur = dur / words.length  // время на слово (равномерно)

  const result = []
  let line = ''
  let lineStart = seg.start
  let lineWords = 0

  for (let wi = 0; wi < words.length; wi++) {
    const candidate = line ? line + ' ' + words[wi] : words[wi]
    if (candidate.length > maxChars && line) {
      // Фиксируем текущую строку
      result.push({
        start: lineStart,
        end:   lineStart + wDur * lineWords,
        text:  line,
        type:  seg.type,
      })
      lineStart += wDur * lineWords
      lineWords  = 1
      line       = words[wi]
    } else {
      line = candidate
      lineWords++
    }
  }

  // Последняя строка — до конца сегмента
  if (line) {
    result.push({ start: lineStart, end: seg.end, text: line, type: seg.type })
  }

  return result
}

// ── Legacy path: expandSegmentWords (subTiming='words', Vosk/Smart Silence) ───
function expandSegmentWords(seg, maxChars) {
  const words = seg.text.trim().split(/\s+/)
  const n    = words.length
  const dur  = seg.end - seg.start
  const wDur = dur / n
  const result = []
  let line = '', lineStart = seg.start, lineWords = 0
  for (let wi = 0; wi < n; wi++) {
    const candidate = line ? line + ' ' + words[wi] : words[wi]
    if (candidate.length > maxChars && line) {
      result.push({ start: lineStart, end: lineStart + wDur * lineWords, text: line, type: seg.type })
      lineStart += wDur * lineWords
      lineWords = 1
      line = words[wi]
    } else {
      line = candidate
      lineWords++
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
  // Финальный hard split для переросших строк
  const final = []
  for (const seg of out) {
    final.push(...hardSplitByWords(seg, maxChars))
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
 * @param audioBuf        (зарезервировано, не используется в v13.1)
 * @param targetDur       (зарезервировано, не используется в v13.1)
 * @param showMusicMarker включить ♪ в SRT
 * @param factorMap       (зарезервировано)
 */
export function assemble(
  flagMap,
  textMap,
  maxChars        = 80,
  mergeGap        = 0.5,
  mergeMode       = 'strict',
  dedupWindow     = 0,
  subTiming       = 'vad',
  audioBuf        = null,   // зарезервировано
  targetDur       = 1.5,    // зарезервировано
  showMusicMarker = false,
  factorMap       = null    // зарезервировано
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

    // БАГ #2 ИСПРАВЛЕН: mixed НЕ пропускается — это речь поверх музыки
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

  // ── VAD path: Dedup → Merge → hardSplitByWords ────────────────────────────
  // Порядок важен: Merge должен быть ДО hardSplitByWords
  // чтобы итоговые части не склеивались обратно.

  // ── 1. Dedup ───────────────────────────────────────────────────────────────
  let deduped
  if (dedupWindow === 0) {
    deduped = allSegs
  } else {
    deduped = [allSegs[0]]
    for (let i = 1; i < allSegs.length; i++) {
      const curr = norm(allSegs[i].text)
      if (allSegs[i].type === 'music') { deduped.push(allSegs[i]); continue }
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
      if (!isDup) deduped.push(allSegs[i])
    }
  }

  // ── 2. Merge ───────────────────────────────────────────────────────────────
  const speechSegs = deduped.filter(s => s.type !== 'music')
  const musicSegs  = deduped.filter(s => s.type === 'music')

  let merged
  if (speechSegs.length === 0) {
    merged = musicSegs
  } else {
    let mergedSpeech
    if (mergeMode === 'balanced')       mergedSpeech = mergeBalanced(speechSegs, maxChars, mergeGap)
    else if (mergeMode === 'sentence')  mergedSpeech = mergeSentence(speechSegs, maxChars, mergeGap)
    else                                mergedSpeech = mergeStrict(speechSegs, maxChars, mergeGap)

    merged = [...mergedSpeech, ...musicSegs].sort((a, b) => a.start - b.start)
  }

  // ── 3. Clamp overlaps ──────────────────────────────────────────────────────
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i].end > merged[i + 1].start - 0.05)
      merged[i].end = Math.max(merged[i].start + 0.1, merged[i + 1].start - 0.05)
  }

  // ── 4. Hard split по maxChars — только по границам слов ───────────────────
  const final = []
  for (const seg of merged) {
    final.push(...hardSplitByWords(seg, maxChars))
  }

  return buildSrt(final)
}
