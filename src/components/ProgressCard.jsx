// ProgressCard.jsx — v14.0.0
// Добавлено: метка даты/времени в каждой строке лога, кнопка скачивания

import { useEffect, useRef } from 'react'

function nowStamp() {
  const d = new Date()
  return d.toLocaleDateString('ru-RU') + ' ' +
    d.toLocaleTimeString('ru-RU', { hour12: false })
}

function buildLogText(log) {
  return log.map(e => `[${e.ts || ''}] ${e.msg}`).join('\n')
}

function buildLogFilename(log) {
  const lines  = log.map(e => e.msg).join('\n')
  const fMatch = lines.match(/▶ \[\d+\/\d+\] (.+?)(?:\s+\(.+?\))*\s*$/)
  const name   = fMatch ? fMatch[1].replace(/\.[^.]+$/, '').trim() : 'log'
  let method   = 'gm'
  if (/v12.*Segmenter|v12flags/.test(lines)) method = 'v12flags'
  else if (/Silero/.test(lines))             method = 'silero'
  else if (/ElevenLabs/.test(lines))         method = 'el'
  const tMatch  = lines.match(/⏱ ИТОГО: ([\d.,]+с)/)
  const total   = tMatch ? tMatch[1].replace('.', '_') : ''
  const stamp   = new Date().toISOString().slice(0,10)
  return [name, method, total, stamp].filter(Boolean).join('_') + '.txt'
}

export default function ProgressCard({
  log, clearLog,
  progress, progressText, statusText,
  voskVisible, voskPct, voskText,
  running,
  onStart, onStop,
}) {
  const logRef = useRef(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  function downloadLog() {
    if (!log.length) return
    const text = buildLogText(log)
    const name = buildLogFilename(log)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="card">
      <div className="ct">Прогресс транскрипции</div>

      {/* Прогресс-бар */}
      <div className="pw">
        <div className="pl">
          <span>{progressText}</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="pb">
          <div className="pf" style={{ width: progress + '%' }} />
        </div>
        <div className={`vpw${voskVisible ? ' show' : ''}`}>
          <div className="vpl">
            <span>{voskText}</span>
            <span>{Math.round(voskPct)}%</span>
          </div>
          <div className="vpb">
            <div className="vpf" style={{ width: voskPct + '%' }} />
          </div>
        </div>
      </div>

      {/* Лог */}
      <div className="logbox" ref={logRef}>
        {log.length === 0
          ? <span className="log-empty">Лог будет здесь...</span>
          : log.map((e, i) => (
            <div key={i} className={`log-line log-${e.type || 'dm'}`}>
              <span style={{ opacity: 0.45, fontSize: 10, marginRight: 6, userSelect: 'none' }}>{e.ts}</span>
              {e.msg}
            </div>
          ))}
      </div>

      {/* Кнопки */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {!running
          ? <button className="btn-start" onClick={onStart} style={{ flex: 1 }}>▶ Транскрибировать</button>
          : <button className="btn-stop"  onClick={onStop}  style={{ flex: 1 }}>■ Остановить</button>
        }
        <button
          onClick={clearLog}
          title="Очистить лог"
          style={{ padding: '0 14px', borderRadius: 8, border: '1px solid var(--c-brd)', background: 'transparent', color: 'var(--c-dim)', cursor: 'pointer', fontSize: 14 }}
        >🗑</button>
        <button
          onClick={downloadLog}
          title="Скачать лог"
          disabled={log.length === 0}
          style={{
            padding: '0 14px', borderRadius: 8, border: '1px solid var(--c-brd)',
            background: 'transparent', color: log.length ? 'var(--c-acc)' : 'var(--c-dim)',
            cursor: log.length ? 'pointer' : 'default', fontSize: 14,
          }}
        >⬇</button>
      </div>
    </div>
  )
}
