/**
 * v12 Assembler
 * Deduplication: removes consecutive segments with identical normalized text
 */

import { buildSrt } from './srtUtils.js'

function normalize(text) {
  return text.toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim()
}

export function assemble(flagMap, textMap, maxChars = 80) {
  const segs = []
  for (const [flagId, times] of flagMap) {
    const text = (textMap.get(flagId) || '').trim()
    if (!text) continue
    segs.push({ start: times.start, end: times.end, text })
  }

  segs.sort((a, b) => a.start - b.start)
  if (segs.length === 0) return ''

  // Dedup: remove segment if text is substring/duplicate of prev
  const deduped = [segs[0]]
  for (let i = 1; i < segs.length; i++) {
    const prev = deduped[deduped.length - 1]
    const curr = segs[i]
    const pn = normalize(prev.text)
    const cn = normalize(curr.text)
    // Skip if identical or current is contained in previous
    if (cn === pn || pn.includes(cn) || cn.includes(pn)) continue
    deduped.push(curr)
  }

  // Merge adjacent segments respecting maxChars and gap < 0.5s
  const merged = []
  let cur = { ...deduped[0] }

  for (let i = 1; i < deduped.length; i++) {
    const next     = deduped[i]
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
    if (merged[i].end > merged[i+1].start - 0.05)
      merged[i].end = Math.max(merged[i].start + 0.1, merged[i+1].start - 0.05)
  }

  return buildSrt(merged)
}
