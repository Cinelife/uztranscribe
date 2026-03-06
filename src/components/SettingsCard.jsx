import { useRef } from 'react'
import { OR_MODELS }       from '../lib/openrouter.js'
import { initVoskModel }   from '../lib/vosk.js'

const TM_DESC = {
  smart: 'Авто-поиск тишины в аудио — без зависимостей, работает везде',
  vosk:  'Pass 1: Vosk определяет границы речи → Pass 2: транскрибирует (быстрее реального времени)'
}

export default function SettingsCard({
  prov, setProv,
  lang, setLang,
  chunkSec, setChunkSec,
  maxChars, setMaxChars,
  timingMode, setTimingMode,
  orModel, setOrModel,
  voskReady, setVoskReady,
  voskModelRef
}) {
  const voskFileRef   = useRef(null)
  const voskStatusRef = useRef(null)
  const voskBtnRef    = useRef(null)

  const handleLoadVosk = async () => {
    const inp  = voskFileRef.current
    const stat = voskStatusRef.current
    const btn  = voskBtnRef.current
    if (!inp?.files?.length) { alert('Выбери .zip файл модели Vosk'); return }
    if (voskReady) return
    stat.style.display = 'block'
    stat.className = 'vstt vs-lo'
    stat.textContent = '⏳ Загружаю vosk-browser...'
    btn.disabled = true
    try {
      const model = await initVoskModel(inp.files[0])
      voskModelRef.current = model
      setVoskReady(true)
      stat.className   = 'vstt vs-ok'
      stat.textContent = '✅ Vosk готов: ' + inp.files[0].name
      btn.textContent  = '✓ Загружено'
    } catch (e) {
      stat.className   = 'vstt vs-er'
      stat.textContent = '❌ ' + e.message + (location.protocol === 'file:' ? ' — открой через localhost' : '')
      btn.disabled     = false
    }
  }

  return (
    <div className="card">
      <div className="ct">Настройки транскрипции</div>
      <div className="r2">
        <div>
          <label>Провайдер</label>
          <div className="ptabs">
            {[['el','ElevenLabs'],['gm','Gemini'],['or','OpenRouter'],['bo','Все']].map(([v,l]) => (
              <button key={v}
                className={`btn pt pv-${v}${prov===v?' on':''}`}
                onClick={() => setProv(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <label>Язык</label>
          <select value={lang} onChange={e => setLang(e.target.value)}>
            <option value="uz">🇺🇿 Uzbek</option>
            <option value="ru">🇷🇺 Russian</option>
            <option value="en">🇬🇧 English</option>
            <option value="kk">🇰🇿 Kazakh</option>
            <option value="tg">🇹🇯 Tajik</option>
          </select>
        </div>
      </div>

      {/* OpenRouter model selector */}
      {(prov === 'or' || prov === 'bo') && (
        <div style={{ marginTop: 12 }}>
          <label>Модель OpenRouter</label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      <div className="r2" style={{ marginTop: 12 }}>
        <div>
          <label>Размер чанка: {chunkSec}с</label>
          <input type="range" min="15" max="60" step="5" value={chunkSec}
            onChange={e => setChunkSec(Number(e.target.value))} />
        </div>
        <div>
          <label>Макс. символов на строку: {maxChars}</label>
          <input type="range" min="30" max="160" step="5" value={maxChars}
            onChange={e => setMaxChars(Number(e.target.value))} />
        </div>
      </div>

      {/* Timing mode — only for Gemini/OpenRouter */}
      {prov !== 'el' && (
        <div style={{ marginTop: 12 }}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','🔇 Smart Silence'],['vosk','🔬 Vosk 2-pass']].map(([v,l]) => (
              <button key={v}
                className={`btn tm tm-${v}${timingMode===v?' on':''}`}
                onClick={() => setTimingMode(v)}>{l}</button>
            ))}
          </div>
          <div className="tm-desc">{TM_DESC[timingMode]}</div>
        </div>
      )}

      {/* Vosk model loader */}
      {timingMode === 'vosk' && prov !== 'el' && (
        <div className="vosk-loader" style={{ marginTop: 12 }}>
          <label>Vosk модель (.zip) — <a href="https://alphacephei.com/vosk/models" target="_blank" rel="noreferrer">alphacephei.com/vosk/models</a></label>
          <div className="kr">
            <input type="file" ref={voskFileRef} accept=".zip" disabled={voskReady} />
            <button ref={voskBtnRef} className="btn bc" onClick={handleLoadVosk} disabled={voskReady}>
              {voskReady ? '✓ Загружено' : 'Загрузить'}
            </button>
          </div>
          <div ref={voskStatusRef} className="vstt" style={{ display: 'none' }} />
        </div>
      )}
    </div>
  )
}
