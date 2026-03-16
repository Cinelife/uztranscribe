// ProgressCard.jsx — v14.0.0
// Стиль кнопок как в v12 (по длине текста)
// Лог: метка времени в отдельной колонке
// Кнопка скачать лог рядом с очистить

import { useEffect, useRef } from 'react'

function nowStamp() {
  const d = new Date()
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour12: false })
}

function buildLogText(log) {
  return log.map(e => `[${e.ts || ''}] ${e.msg}`).join('\n')
}

function buildLogFilename(log) {
  const lines  = log.map(e => e.msg).join('\n')
  const fMatch = lines.match(/▶ \[\d+\/\d+\] (.+?)\s+\([\d.]+\s*MB\)/)
  const name   = fMatch ? fMatch[1].replace(/\.[^.]+$/, '').trim() : 'log'
  let method   = 'gm'
  if (/метод:v12/.test(lines))          method = 'v12flags'
  else if (/Smart Silence/.test(lines)) method = 'smart'
  else if (/ElevenLabs/.test(lines))    method = 'el'
  const tMatch = lines.match(/⏱ ИТОГО: ([\d.,]+с)/)
  const total  = tMatch ? tMatch[1].replace('.','_') : ''
  const stamp  = new Date().toISOString().slice(0,10)
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

      <div className="logbox" ref={logRef}>
        {log.length === 0
          ? <span className="log-empty">Лог будет здесь...</span>
          : log.map((e, i) => (
            <div key={i} className={`log-line log-${e.cls || e.type || 'dm'}`}>
              {e.ts && (
                <span style={{ opacity: 0.4, fontSize: '0.78em', marginRight: 6, userSelect: 'none', flexShrink: 0 }}>
                  {e.ts}
                </span>
              )}
              <span>{e.msg}</span>
            </div>
          ))}
      </div>

      {/* Кнопки */}
      <div className="kr" style={{ marginTop: 10, justifyContent: 'flex-start' }}>
        {!running
          ? <button className="btn bc" onClick={onStart}>▶ Транскрибировать</button>
          : <button className="btn" onClick={onStop} style={{ borderColor: 'var(--er)', color: 'var(--er)' }}>■ Остановить</button>
        }
        <button
          onClick={clearLog}
          title="Очистить лог"
          style={{
            padding: '0 14px', border: '1px solid #7f1d1d',
            borderRadius: 7, background: '#450a0a',
            color: '#fca5a5', cursor: 'pointer',
            fontSize: 18, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: 34,
          }}
        >🗑</button>
        <button
          onClick={downloadLog}
          title="Скачать лог"
          disabled={!log.length}
          style={{
            padding: '0 14px', border: '1px solid #14532d',
            borderRadius: 7, background: log.length ? '#052e16' : 'var(--bg3)',
            color: log.length ? '#86efac' : 'var(--mu)',
            cursor: log.length ? 'pointer' : 'default',
            fontSize: 20, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: 34,
          }}
        >⬇</button>
      </div>
    </div>
  )
}
