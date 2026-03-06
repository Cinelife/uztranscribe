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
    // Merge if: fits AND gap is small AND current doesn't end a sentence
    if (combined.length <= maxChars && gap < mergeGap && !endsAtBreak) {
      cur = { start: cur.start, end: next.end, text: combined }
    } else {
      out.push(cur); cur = { ...next }
    }
  }
  out.push(cur)
  return out
}

// ── Main export ───────────────────────────────────────────────────────────────
export function assemble(flagMap, textMap, maxChars = 80, mergeGap = 0.5, mergeMode = 'strict') {
  // Collect segments with text
  const segs = []
  for (const [flagId, times] of flagMap) {
    const text = (textMap.get(flagId) || '').trim()
    if (!text) continue
    segs.push({ start: times.start, end: times.end, text })
  }

  segs.sort((a, b) => a.start - b.start)
  if (segs.length === 0) return ''

  // Dedup consecutive identical segments
  const deduped = [segs[0]]
  for (let i = 1; i < segs.length; i++) {
    const prev = norm(deduped[deduped.length-1].text)
    const curr = norm(segs[i].text)
    if (curr !== prev && !prev.includes(curr) && !curr.includes(prev)) {
      deduped.push(segs[i])
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

  return buildSrt(merged)
}
