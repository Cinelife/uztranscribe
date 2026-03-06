/**
 * v12 Assembler
 * flagMap: Map<flagId, {start,end}>  ← from Segmenter
 * textMap: Map<flagId, text>         ← from Dispatcher
 * maxChars: merge adjacent segs until char limit
 */

import { buildSrt } from './srtUtils.js'

export function assemble(flagMap, textMap, maxChars = 80) {
  // Collect segments with text
  const segs = []
  for (const [flagId, times] of flagMap) {
    const text = textMap.get(flagId)
    if (!text) continue
    segs.push({ start: times.start, end: times.end, text })
  }

  segs.sort((a, b) => a.start - b.start)
  if (segs.length === 0) return ''

  // Merge adjacent segments respecting maxChars and gap < 0.5s
  const merged = []
  let cur = { ...segs[0] }

  for (let i = 1; i < segs.length; i++) {
    const next     = segs[i]
    const combined = cur.text + ' ' + next.text
    const gap      = next.start - cur.end

    if (combined.length <= maxChars && gap < 0.5) {
      cur = { start: cur.start, end: next.end, text: combined }
    } else {
      merged.push(cur)
      cur = { ...next }
    }
  }
  merged.push(cur)

  // Clamp overlaps
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i].end > merged[i+1].start - 0.05) {
      merged[i].end = Math.max(merged[i].start + 0.1, merged[i+1].start - 0.05)
    }
  }

  return buildSrt(merged)
}
