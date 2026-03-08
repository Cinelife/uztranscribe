import { useEffect, useRef } from 'react'

function buildLogFilename(log) {
  const lines = log.map(e => e.msg)
  // Имя файла: ▶ [1/1] MohirDEV Test.mp3 (3:06) (Gemini)
  const fileMatch = lines.join('\n').match(/▶ \[\d+\/\d+\] (.+?)(?:\s+\([\d:]+\))?(?:\s+\(.+?\))?\s*$/)
  const rawName   = fileMatch ? fileMatch[1].replace(/\.[^.]+$/, '').trim() : 'log'
  // Провайдер
  const provMatch = lines.join('\n').match(/Провайдер: (\w+)/)
  const prov      = provMatch ? provMatch[1] : ''
  // Метод таймкода
  let method = ''
  if (lines.some(l => /Silero VAD/.test(l)))        method = 'silero'
  else if (lines.some(l => /v12.*Segmenter/.test(l))) method = 'v12seg'
  else if (lines.some(l => /Vosk/.test(l)))          method = 'vosk'
  else if (lines.some(l => /ElevenLabs/.test(l)))    method = 'el'
  // Общее время
  const timeMatch = lines.join('\n').match(/Общее время: ([\d.,]+с)/)
  const totalTime = timeMatch ? timeMatch[1].replace('.', '_') : ''
  // Собираем имя
  const parts = [rawName, prov, method, totalTime].filter(Boolean)
  return parts.join('_') + '.txt'
}

export default function ProgressCard({
  log, clearLog,
  progress, progressText, statusText,
  voskVisible, voskPct, voskText,
  running,
  onStart, onStop
}) {
  const logRef = useRef(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  function downloadLog() {
    if (log.length === 0) return
    const text     = log.map(e => e.msg).join('\n')
    const filename = buildLogFilename(log)
    const blob     = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url      = URL.createObjectURL(blob)
    const a        = document.createElement('a')
    a.href = url; a.download = filename; a.click()
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
          ? <span className="dm">// Лог будет здесь...</span>
          : log.map(entry => <div key={entry.id} className={entry.cls}>{entry.msg}</div>)
        }
      </div>

      <div className="ar">
        <button className="btn bp" onClick={onStart} disabled={running}>▶ Запустить</button>
        <button className="btn bs" onClick={onStop} disabled={!running}>⏹ Стоп</button>
        <span className="st">{statusText}</span>
        <button className="btn bx" onClick={clearLog}>Очистить лог</button>
        <button
          className="btn bx"
          onClick={downloadLog}
          disabled={log.length === 0}
          title="Скачать лог"
          style={{ padding: '0 10px', fontSize: '16px' }}
        >⬇</button>
      </div>
    </div>
  )
}
