/**
 * v12.5.4 Assembler
 * Changes vs v12.5.3:
 *   - ♪ marker parsing (music/silent/mixed/speech types)
 *   - showMusicMarker toggle
 *   - RMS integral sub-timing (audioBuf required)
 *   - FFT (ZCR-weighted) sub-timing
 */

import { buildSrt } from './srtUtils.js'

// ── Text normalisation ────────────────────────────────────────────────────────
function norm(t) {
  return t.toLowerCase().replace(/[.,!?'"]/g,'').replace(/\s+/g,' ').trim()
}

// ── ♪ marker parser ───────────────────────────────────────────────────────────
/**
 * Classify segment text by ♪ markers
 * Returns { type: 'speech'|'music'|'silent'|'mixed', text: cleaned }
 */
function parseMarker(raw) {
  const t = (raw || '').trim()
  if (!t || t === '')           return { type: 'silent', text: '' }
  if (t === '♪')                return { type: 'music',  text: '♪' }
  if (t.startsWith('♪') && t.endsWith('♪') && t.length > 1)
                                 return { type: 'mixed',  text: t }
  if (t.startsWith('♪ '))       return { type: 'mixed',  text: t }
  if (t.endsWith(' ♪'))         return { type: 'mixed',  text: t }
  if (t.endsWith('♪'))          return { type: 'mixed',  text: t }
  return { type: 'speech', text: t }
}

// ── RMS integral sub-timing ───────────────────────────────────────────────────
/**
 * Split segment into N word slots using cumulative RMS energy as weight
 * More energy at t → word boundary lands closer to t
 * @param {AudioBuffer} audioBuf
 * @param {number} t0 - segment start (seconds)
 * @param {number} t1 - segment end (seconds)
 * @param {number} n  - number of word slots
 * @returns {number[]} array of n+1 boundary times (t0...t1)
 */
function rmsIntegralBoundaries(audioBuf, t0, t1, n) {
  const sr     = audioBuf.sampleRate
  const s0     = Math.max(0, Math.floor(t0 * sr))
  const s1     = Math.min(audioBuf.length, Math.ceil(t1 * sr))
  const nc     = audioBuf.numberOfChannels
  const len    = s1 - s0
  const FRAME  = Math.max(1, Math.floor(sr * 0.02)) // 20ms frames

  if (len <= 0) return Array.from({length: n+1}, (_, i) => t0 + (t1-t0)*i/n)

  // Mono mix + frame RMS
  const frameCount = Math.ceil(len / FRAME)
  const energy = new Float32Array(frameCount)
  for (let f = 0; f < frameCount; f++) {
    let sum = 0, cnt = 0
    for (let c = 0; c < nc; c++) {
      const ch = audioBuf.getChannelData(c)
      for (let i = f*FRAME; i < Math.min((f+1)*FRAME, len); i++) {
        sum += ch[s0+i] * ch[s0+i]; cnt++
      }
    }
    energy[f] = cnt > 0 ? Math.sqrt(sum/cnt) : 0
  }

  // Cumulative sum
  const cumulative = new Float32Array(frameCount + 1)
  for (let f = 0; f < frameCount; f++) cumulative[f+1] = cumulative[f] + energy[f]
  const total = cumulative[frameCount]

  if (total < 1e-9) {
    // Uniform fallback if no energy
    return Array.from({length: n+1}, (_, i) => t0 + (t1-t0)*i/n)
  }

  // Find boundaries where cumulative = k/n * total
  const boundaries = [t0]
  for (let k = 1; k < n; k++) {
    const target = (k / n) * total
    let f = 0
    while (f < frameCount && cumulative[f+1] < target) f++
    const frameTime = t0 + (f / frameCount) * (t1 - t0)
    boundaries.push(Math.max(t0, Math.min(t1, frameTime)))
  }
  boundaries.push(t1)
  return boundaries
}

/**
 * FFT-like sub-timing using ZCR per frame as speech-density weight
 * High ZCR frame = high speech density = more words here
 */
function zcrIntegralBoundaries(audioBuf, t0, t1, n) {
  const sr     = audioBuf.sampleRate
  const s0     = Math.max(0, Math.floor(t0 * sr))
  const s1     = Math.min(audioBuf.length, Math.ceil(t1 * sr))
  const nc     = audioBuf.numberOfChannels
  const len    = s1 - s0
  const FRAME  = Math.max(1, Math.floor(sr * 0.02))

  if (len <= 0) return Array.from({length: n+1}, (_, i) => t0 + (t1-t0)*i/n)

  // Mono
  const mono = new Float32Array(len)
  for (let c = 0; c < nc; c++) {
    const ch = audioBuf.getChannelData(c)
    for (let i = 0; i < len; i++) mono[i] += ch[s0+i] / nc
  }

  // Per-frame ZCR
  const frameCount = Math.ceil(len / FRAME)
  const zcr = new Float32Array(frameCount)
  for (let f = 0; f < frameCount; f++) {
    let crossings = 0
    const start = f * FRAME
    const end   = Math.min(start + FRAME, len)
    for (let i = start + 1; i < end; i++) {
      if ((mono[i] >= 0) !== (mono[i-1] >= 0)) crossings++
    }
    zcr[f] = crossings / (end - start)
  }

  // Cumulative ZCR
  const cumulative = new Float32Array(frameCount + 1)
  for (let f = 0; f < frameCount; f++) cumulative[f+1] = cumulative[f] + zcr[f]
  const total = cumulative[frameCount]

  if (total < 1e-9) {
    return Array.from({length: n+1}, (_, i) => t0 + (t1-t0)*i/n)
  }

  const boundaries = [t0]
  for (let k = 1; k < n; k++) {
    const target = (k / n) * total
    let f = 0
    while (f < frameCount && cumulative[f+1] < target) f++
    const frameTime = t0 + (f / frameCount) * (t1 - t0)
    boundaries.push(Math.max(t0, Math.min(t1, frameTime)))
  }
  boundaries.push(t1)
  return boundaries
}

// ── Sub-timing: expand single segment into word-level lines ──────────────────
function expandSegment(seg, maxChars, subTiming, audioBuf, useRmsTiming, useFFT) {
  const words   = seg.text.trim().split(/\s+/)
  const n       = words.length
  const dur     = seg.end - seg.start

  if (n === 1) return [seg]

  // Choose boundary method
  let boundaries
  if (useRmsTiming && audioBuf && dur > 4 && n > 3) {
    boundaries = useFFT
      ? zcrIntegralBoundaries(audioBuf, seg.start, seg.end, n)
      : rmsIntegralBoundaries(audioBuf, seg.start, seg.end, n)
  } else {
    // Proportional by word count (existing behaviour)
    const wDur = dur / n
    boundaries = Array.from({length: n+1}, (_, i) => seg.start + i * wDur)
  }

  // Group words into lines respecting maxChars
  const result = []
  let line = '', lineStart = boundaries[0], lineEnd = boundaries[1]
  for (let wi = 0; wi < n; wi++) {
    const candidate = line ? line + ' ' + words[wi] : words[wi]
    lineEnd = boundaries[wi + 1]
    if (candidate.length > maxChars && line) {
      result.push({ start: lineStart, end: boundaries[wi], text: line })
      lineStart = boundaries[wi]
      line = words[wi]
    } else {
      line = candidate
    }
  }
  if (line) result.push({ start: lineStart, end: lineEnd, text: line })
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
      cur = { start: cur.start, end: next.end, text: combined }
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
      cur = { start: cur.start, end: next.end, text: combined }
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
      cur = { start: cur.start, end: next.end, text: combined }
    } else { out.push(cur); cur = { ...next } }
  }
  out.push(cur)
  const final = []
  for (const seg of out) {
    if (seg.text.length <= maxChars) { final.push(seg); continue }
    const words = seg.text.split(' ')
    const dur   = seg.end - seg.start
    let line = '', lineStart = seg.start
    for (let wi = 0; wi < words.length; wi++) {
      const candidate = line ? line + ' ' + words[wi] : words[wi]
      if (candidate.length > maxChars && line) {
        const ratio = line.split(' ').length / words.length
        final.push({ start: lineStart, end: lineStart + dur * ratio, text: line })
        lineStart = lineStart + dur * ratio; line = words[wi]
      } else { line = candidate }
    }
    if (line) final.push({ start: lineStart, end: seg.end, text: line })
  }
  return final
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param flagMap        - Map<flagId, {start,end}>
 * @param textMap        - Map<flagId, string>
 * @param maxChars       - max chars per subtitle line
 * @param mergeGap       - max gap to merge segments
 * @param mergeMode      - 'strict'|'balanced'|'sentence'
 * @param dedupWindow    - 0=off, 1-20=sliding window
 * @param subTiming      - 'vad'|'words' (legacy)
 * @param audioBuf       - AudioBuffer for RMS/FFT timing (v12.5.4, optional)
 * @param useRmsTiming   - enable RMS integral sub-timing (v12.5.4)
 * @param useFFT         - use ZCR-weighted timing instead of RMS (v12.5.4)
 * @param showMusicMarker - include ♪ segments in SRT output (v12.5.4)
 */
export function assemble(
  flagMap, textMap,
  maxChars       = 80,
  mergeGap       = 0.5,
  mergeMode      = 'strict',
  dedupWindow    = 12,
  subTiming      = 'vad',
  audioBuf       = null,
  useRmsTiming   = false,
  useFFT         = false,
  showMusicMarker = false
) {
  // ── Collect + parse ♪ markers ───────────────────────────────────────────────
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

    if (parsed.type === 'mixed') {
      allSegs.push({ start: times.start, end: times.end, text: parsed.text, type: 'mixed' })
      continue
    }

    // speech
    allSegs.push({ start: times.start, end: times.end, text: parsed.text, type: 'speech' })
  }

  allSegs.sort((a, b) => a.start - b.start)
  if (allSegs.length === 0) return ''

  // ── Sub-timing: words mode (legacy Silero) ──────────────────────────────────
  if (subTiming === 'words') {
    const expanded = []
    for (const seg of allSegs) {
      if (seg.type === 'music') { expanded.push(seg); continue }
      const parts = expandSegment(seg, maxChars, subTiming, audioBuf, useRmsTiming, useFFT)
      expanded.push(...parts)
    }
    for (let i = 0; i < expanded.length - 1; i++) {
      if (expanded[i].end > expanded[i+1].start - 0.05)
        expanded[i].end = Math.max(expanded[i].start + 0.1, expanded[i+1].start - 0.05)
    }
    return buildSrt(expanded)
  }

  // ── RMS / FFT sub-timing for long VAD segments ──────────────────────────────
  let segs = allSegs
  if (useRmsTiming && audioBuf) {
    const expanded = []
    for (const seg of allSegs) {
      if (seg.type === 'music') { expanded.push(seg); continue }
      const words = seg.text.trim().split(/\s+/)
      const dur   = seg.end - seg.start
      if (dur > 4 && words.length > 3) {
        const parts = expandSegment(seg, maxChars, subTiming, audioBuf, useRmsTiming, useFFT)
        expanded.push(...parts)
      } else {
        expanded.push(seg)
      }
    }
    segs = expanded
  }

  // ── Dedup ────────────────────────────────────────────────────────────────────
  let deduped
  if (dedupWindow === 0) {
    deduped = segs
  } else {
    deduped = [segs[0]]
    for (let i = 1; i < segs.length; i++) {
      const curr = norm(segs[i].text)
      // Never dedup music markers
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

  // ── Merge ─────────────────────────────────────────────────────────────────────
  // Music markers are pass-through, not merged with speech
  const speechSegs = deduped.filter(s => s.type !== 'music')
  const musicSegs  = deduped.filter(s => s.type === 'music')

  let merged
  if (speechSegs.length === 0) {
    merged = musicSegs
  } else {
    let mergedSpeech
    if (mergeMode === 'balanced') mergedSpeech = mergeBalanced(speechSegs, maxChars, mergeGap)
    else if (mergeMode === 'sentence') mergedSpeech = mergeSentence(speechSegs, maxChars, mergeGap)
    else mergedSpeech = mergeStrict(speechSegs, maxChars, mergeGap)

    // Re-interleave music markers by time
    merged = [...mergedSpeech, ...musicSegs].sort((a,b) => a.start - b.start)
  }

  // ── Clamp overlaps ────────────────────────────────────────────────────────────
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i].end > merged[i+1].start - 0.05)
      merged[i].end = Math.max(merged[i].start + 0.1, merged[i+1].start - 0.05)
  }

  // ── Hard split oversized speech segments ─────────────────────────────────────
  const final = []
  for (const seg of merged) {
    if (seg.type === 'music' || seg.text.length <= maxChars) { final.push(seg); continue }
    const words = seg.text.split(' ')
    const dur   = (seg.end - seg.start) / words.length
    let line = '', lineStart = seg.start
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (candidate.length > maxChars && line) {
        final.push({ start: lineStart, end: lineStart + dur * line.split(' ').length, text: line })
        lineStart += dur * line.split(' ').length; line = word
      } else { line = candidate }
    }
    if (line) final.push({ start: lineStart, end: seg.end, text: line })
  }

  return buildSrt(final)
}
