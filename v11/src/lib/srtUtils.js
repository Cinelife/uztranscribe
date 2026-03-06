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
    segs.push({ start, end: parseFloat(last.end ?? last.end_time ?? (start + 1)), text: cur.map(x => x.text||x.word).join(' ') })
  }
  return segs
}

export function deduplicateSegs(segs) {
  if (!segs.length) return segs
  const out = [segs[0]]
  for (let i = 1; i < segs.length; i++) {
    const prev = out[out.length - 1], cur = segs[i]
    if (cur.text === prev.text && Math.abs(cur.start - prev.start) < 0.5) continue
    out.push(cur)
  }
  return out
}

export function splitLongLines(segs, maxChars) {
  const out = []
  for (const s of segs) {
    if (!s.text || s.text.length <= maxChars) { out.push(s); continue }
    const words = s.text.split(' ')
    const mid   = Math.ceil(words.length / 2)
    const dur   = (s.end - s.start) / 2
    out.push({ start: s.start,       end: s.start + dur, text: words.slice(0, mid).join(' ') })
    out.push({ start: s.start + dur, end: s.end,         text: words.slice(mid).join(' ')    })
  }
  return out
}

export function downloadSrt(content, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
  a.download = filename
  a.click()
}
