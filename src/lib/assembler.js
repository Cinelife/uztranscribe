/**
 * v12 Assembler — three merge modes
 * strict:   never exceed maxChars, split anywhere
 * balanced: try to make segments roughly equal length
 * sentence: prefer breaking at punctuation (. , ! ?)
 */

import { buildSrt } from './srtUtils.js'

function norm(t) {
  return t.toLowerCase().replace(/[.,!?'"]/g,'').replace(/\s+/g,' ').trim()
}

// ── Merge helpers ─────────────────────────────────────────────────────────────
function mergeStrict(segs, maxChars, mergeGap) {
  const out = []
  let cur = { ...segs[0] }
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap = next.start - cur.end
    if (combined.length <= maxChars && gap < mergeGap) {
      cur = { start: cur.start, end: next.end, text: combined }
    } else {
      out.push(cur); cur = { ...next }
    }
  }
  out.push(cur)
  return out
}

function mergeBalanced(segs, maxChars, mergeGap) {
  // Target: ~75% of maxChars per segment
  const target = Math.floor(maxChars * 0.75)
  const out = []
  let cur = { ...segs[0] }
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap = next.start - cur.end
    // Merge if: fits AND (current is short OR gap is tiny)
    if (combined.length <= maxChars && gap < mergeGap &&
        (cur.text.length < target || gap < 0.2)) {
      cur = { start: cur.start, end: next.end, text: combined }
    } else {
      out.push(cur); cur = { ...next }
    }
  }
  out.push(cur)
  return out
}

function mergeSentence(segs, maxChars, mergeGap) {
  const BREAK = /[.!?](\s|$)/  // sentence-ending punctuation
  const out = []
  let cur = { ...segs[0] }
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap = next.start - cur.end
    const endsAtBreak = BREAK.test(cur.text.trim())
    // Merge if: fits maxChars AND gap small AND current doesn't end a sentence
    if (combined.length <= maxChars && gap < mergeGap && !endsAtBreak) {
      cur = { start: cur.start, end: next.end, text: combined }
    } else {
      out.push(cur); cur = { ...next }
    }
  }
  out.push(cur)
  // Hard split: any segment still over maxChars gets split at word boundary
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
        lineStart = lineStart + dur * ratio
        line = words[wi]
      } else { line = candidate }
    }
    if (line) final.push({ start: lineStart, end: seg.end, text: line })
  }
  return final
}

// ── Main export ───────────────────────────────────────────────────────────────
// dedupWindow: 0 = dedup off, 1-20 = sliding window size (default 12)
// subTiming:   'vad' = use VAD bounds | 'words' = proportional split by word count (Silero mode)
export function assemble(flagMap, textMap, maxChars = 80, mergeGap = 0.5, mergeMode = 'strict', dedupWindow = 12, subTiming = 'vad') {
  // Collect segments with text
  const segs = []
  for (const [flagId, times] of flagMap) {
    const text = (textMap.get(flagId) || '').trim()
    if (!text) continue
    segs.push({ start: times.start, end: times.end, text })
  }

  segs.sort((a, b) => a.start - b.start)
  if (segs.length === 0) return ''

  // ── Sub-timing: word-proportional split (Silero 'words' mode) ───────────────
  if (subTiming === 'words') {
    const expanded = []
    for (const seg of segs) {
      const words = seg.text.trim().split(/\s+/)
      const dur   = seg.end - seg.start
      const wDur  = dur / words.length
      let line = '', lineStart = seg.start
      for (let wi = 0; wi < words.length; wi++) {
        const candidate = line ? line + ' ' + words[wi] : words[wi]
        if (candidate.length > maxChars && line) {
          expanded.push({ start: lineStart, end: lineStart + wDur * line.split(' ').length, text: line })
          lineStart += wDur * line.split(' ').length
          line = words[wi]
        } else { line = candidate }
      }
      if (line) expanded.push({ start: lineStart, end: seg.end, text: line })
    }
    for (let i = 0; i < expanded.length - 1; i++) {
      if (expanded[i].end > expanded[i+1].start - 0.05)
        expanded[i].end = Math.max(expanded[i].start + 0.1, expanded[i+1].start - 0.05)
    }
    return buildSrt(expanded)
  }

  // ── Dedup: sliding window ────────────────────────────────────────────────────
  let deduped
  if (dedupWindow === 0) {
    deduped = segs
  } else {
    deduped = [segs[0]]
    for (let i = 1; i < segs.length; i++) {
      const curr = norm(segs[i].text)
      const windowStart = Math.max(0, deduped.length - dedupWindow)
      const isDup = deduped.slice(windowStart).some(prev => {
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

  // Merge by mode
  let merged
  if (mergeMode === 'balanced') merged = mergeBalanced(deduped, maxChars, mergeGap)
  else if (mergeMode === 'sentence') merged = mergeSentence(deduped, maxChars, mergeGap)
  else merged = mergeStrict(deduped, maxChars, mergeGap)

  // Clamp overlaps
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i].end > merged[i+1].start - 0.05)
      merged[i].end = Math.max(merged[i].start + 0.1, merged[i+1].start - 0.05)
  }

  // Hard split: enforce maxChars at word boundary for any oversized segment
  const final = []
  for (const seg of merged) {
    if (seg.text.length <= maxChars) { final.push(seg); continue }
    const words = seg.text.split(' ')
    const dur   = (seg.end - seg.start) / words.length
    let line = '', lineStart = seg.start
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (candidate.length > maxChars && line) {
        final.push({ start: lineStart, end: lineStart + dur * line.split(' ').length, text: line })
        lineStart += dur * line.split(' ').length
        line = word
      } else { line = candidate }
    }
    if (line) final.push({ start: lineStart, end: seg.end, text: line })
  }

  return buildSrt(final)
}
