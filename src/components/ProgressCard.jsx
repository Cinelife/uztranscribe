import { useEffect, useRef } from 'react'

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
      </div>
    </div>
  )
}
