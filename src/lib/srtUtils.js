export function srtTime(s) {
  const ms = Math.round((s % 1) * 1000)
  s = Math.floor(s)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`
}

export function buildSrt(segs) {
  const validated = segs.map(s => {
    if (s.end < s.start) { const t = s.start; s.start = s.end; s.end = t }
    return s
  })
  return validated
    .map((s, i) => `${i+1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`)
    .join('\n')
}

export function parseSRT(content) {
  return content.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split(/\n\n+/).map(b => {
    const lines = b.trim().split('\n')
    if (lines.length < 3) return null
    const tc = lines[1].match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/)
    if (!tc) return null
    return { idx: parseInt(lines[0])||0, start: tc[1].replace('.',','), end: tc[2].replace('.',','), text: lines.slice(2).join('\n') }
  }).filter(Boolean)
}

export function rebuildSRT(segs) {
  return segs.map((s, i) => `${i+1}\n${s.start} --> ${s.end}\n${s.text.trim()}\n`).join('\n')
}

export function wordsToSegs(words, maxDur, maxChars) {
  const segs = []; let cur = [], start = null, chars = 0
  for (const w of words) {
    const txt = (w.text || w.word || '').trim()
    const ws  = parseFloat(w.start      != null ? w.start      : (w.start_time != null ? w.start_time : 0))
    const we  = parseFloat(w.end        != null ? w.end        : (w.end_time   != null ? w.end_time   : ws + 0.3))
    if (!txt) continue
    if (start === null) start = ws
    if (cur.length && (we - start > maxDur || chars + txt.length > maxChars)) {
      const last = cur[cur.length - 1]
      segs.push({ start, end: parseFloat(last.end ?? last.end_time ?? ws), text: cur.map(x => x.text||x.word).join(' ') })
      cur = []; start = ws; chars = 0
    }
    cur.push(w); chars += txt.length + 1
  }
  if (cur.length) {
    const last = cur[cur.length - 1]
    segs.push({ start, end: parseFloat(last.end ?? last.end_time ?? start + 1), text: cur.map(x => x.text||x.word).join(' ') })
  }
  return segs
}

export function downloadSrt(content, name) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(url)
}

/** Split long lines to maxChars, preserving timing */
export function splitLongLines(segs, maxChars) {
  const out = []
  for (const s of segs) {
    const txt = s.text.trim()
    if (txt.length <= maxChars) { out.push(s); continue }
    const words = txt.split(' '), dur = s.end - s.start
    let line = '', lineStart = s.start
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi]
      if (line && (line + ' ' + w).length > maxChars) {
        out.push({ start: lineStart, end: lineStart + dur * (wi / words.length), text: line })
        line = w; lineStart = lineStart + dur * (wi / words.length)
      } else { line = line ? line + ' ' + w : w }
    }
    if (line) out.push({ start: lineStart, end: s.end, text: line })
  }
  return out.filter(s => s.text)
}

export function deduplicateSegs(segs) {
  const seen = new Set()
  return segs.filter(s => {
    const k = s.start.toFixed(2) + '|' + s.text.trim()
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}
