import { useEffect, useRef } from 'react'
import { OR_MODELS }     from '../lib/openrouter.js'
import { parseSRT }      from '../lib/srtUtils.js'
import { LANG_LABELS }   from '../hooks/useTranslation.js'

export default function TranslationCard({
  trLog, clearTrLog, trStatus, trRunning,
  trProvider, setTrProvider,
  trSrc, setTrSrc,
  trPair, setTrPair,
  orModel,
  lastSrtMap,
  onTranslate
}) {
  const logRef    = useRef(null)
  const fileRef   = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [trLog])

  const keys = Object.keys(lastSrtMap)
  const lastKey  = keys[keys.length - 1]
  const lastSegs = lastKey ? parseSRT(lastSrtMap[lastKey]).length : 0

  return (
    <div className="card card-tr">
      <div className="ct ct-pur">🌐 Перевод SRT</div>

      <div className="r2">
        {/* Source */}
        <div>
          <label>Источник субтитров</label>
          <select value={trSrc} onChange={e => setTrSrc(e.target.value)}>
            <option value="last">Последний результат транскрипции</option>
            <option value="file">Загрузить .srt файл</option>
          </select>
        </div>

        {/* Direction */}
        <div>
          <label>Направление перевода</label>
          <select value={trPair} onChange={e => setTrPair(e.target.value)}>
            <option value="uz|ru">🇺🇿 Узбекский → 🇷🇺 Русский</option>
            <option value="uz|en">🇺🇿 Узбекский → 🇬🇧 English</option>
            <option value="ru|uz">🇷🇺 Русский → 🇺🇿 Узбекский</option>
            <option value="ru|en">🇷🇺 Русский → 🇬🇧 English</option>
            <option value="en|uz">🇬🇧 English → 🇺🇿 Узбекский</option>
            <option value="en|ru">🇬🇧 English → 🇷🇺 Русский</option>
          </select>
        </div>
      </div>

      {/* Provider for translation */}
      <div style={{ marginTop:12 }}>
        <label>Провайдер перевода</label>
        <div style={{ display:'flex', gap:6 }}>
          <button className={`btn tm tm-smart${trProvider==='gm'?' on':''}`}
            onClick={() => setTrProvider('gm')}>
            Gemini
          </button>
          <button className={`btn tm tm-vosk${trProvider==='or'?' on':''}`}
            style={trProvider==='or'?{}:{}}
            onClick={() => setTrProvider('or')}>
            OpenRouter ({OR_MODELS.find(m => m.id === orModel)?.label.split(' (')[0] || 'OR'})
          </button>
        </div>
      </div>

      {/* File input */}
      {trSrc === 'file' && (
        <div style={{ marginTop:12 }}>
          <label style={{ marginTop:0 }}>SRT файл для перевода</label>
          <input type="file" ref={fileRef} accept=".srt,.vtt" />
        </div>
      )}

      {/* Hint */}
      {trSrc === 'last' && (
        <div style={{ fontSize:11, color:'var(--mu)', marginTop:8 }}>
          {lastKey
            ? <>✅ Готово к переводу: <strong style={{ color:'var(--pur)' }}>{lastKey}</strong> ({lastSegs} сегм.)</>
            : '💡 После транскрипции здесь автоматически появится последний результат'
          }
        </div>
      )}

      <div className="ar" style={{ marginTop:14 }}>
        <button className="btn bpp" disabled={trRunning}
          onClick={() => onTranslate({ trFileRef: fileRef })}>
          🌐 Перевести
        </button>
        <span className="st">{trStatus}</span>
        <button className="btn bx" onClick={clearTrLog}>Очистить лог</button>
      </div>

      <div className="logbox logbox-sm" ref={logRef} style={{ marginTop:12 }}>
        {trLog.length === 0
          ? <span className="dm">// Лог перевода...</span>
          : trLog.map(entry => (
              <div key={entry.id} className={entry.cls}>{entry.msg}</div>
            ))
        }
      </div>
    </div>
  )
}
