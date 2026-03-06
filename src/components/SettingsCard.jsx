import { useRef } from 'react'
import { OR_MODELS }       from '../lib/openrouter.js'
import { initVoskModel }   from '../lib/vosk.js'

const TM_DESC = {
  smart: 'Авто-поиск тишины в аудио — без зависимостей, работает везде',
  vosk:  'v11: Vosk per-chunk → Gemini anchor (точные тайм-коды + качественный текст)'
}

export default function SettingsCard({
  prov, setProv, lang, setLang,
  chunkSec, setChunkSec, maxChars, setMaxChars,
  timingMode, setTimingMode, orModel, setOrModel,
  voskReady, setVoskReady, voskModelRef
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
              <button key={v} className={`btn pt pv-${v}${prov===v?' on':''}`} onClick={() => setProv(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <label>Язык аудио</label>
          <select value={lang} onChange={e => setLang(e.target.value)}>
            <option value="uz">Uzbek (uz)</option>
            <option value="ru">Russian (ru)</option>
            <option value="en">English (en)</option>
            <option value="kk">Kazakh (kk)</option>
            <option value="tg">Tajik (tg)</option>
          </select>
        </div>
      </div>
      <div className="r2" style={{ marginTop:12 }}>
        <div>
          <label>Размер чанка Gemini/OR (сек)</label>
          <select value={chunkSec} onChange={e => setChunkSec(Number(e.target.value))}>
            <option value={20}>20 сек — точнее, медленнее</option>
            <option value={30}>30 сек — баланс ✓</option>
            <option value={60}>60 сек — быстрее, менее точно</option>
          </select>
        </div>
        <div>
          <label>Символов на строку субтитра</label>
          <div className="slider-row">
            <input type="range" min={30} max={160} step={5} value={maxChars}
              onChange={e => setMaxChars(Number(e.target.value))} />
            <span className="slider-val">{maxChars}</span>
          </div>
          <div className="slider-hint">30 — короткие &nbsp;·&nbsp; 80 — стандарт &nbsp;·&nbsp; 160 — длинные</div>
        </div>
      </div>

      {(prov === 'or' || prov === 'bo') && (
        <div className="or-row">
          <label style={{ marginTop:0 }}>
            Модель OpenRouter <span style={{ color:'var(--mu)' }}>(для транскрипции и перевода)</span>
          </label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div style={{ fontSize:10, color:'var(--mu)', marginTop:6, lineHeight:1.6 }}>
            💡 Для транскрипции аудио рекомендуются модели Gemini и Llama 4 (поддерживают аудио-вход).
            Claude и Qwen VL — текст/изображения.
          </div>
        </div>
      )}

      <div className="vosk-row">
        <label style={{ marginTop:0 }}>
          Метод тайм-кодов <span style={{ color:'var(--mu)', fontSize:10 }}>(только для Gemini / OpenRouter)</span>
        </label>
        <div className="tmtabs" style={{ marginTop:6 }}>
          {[['smart','⚡ Smart Silence'],['vosk','🔬 Vosk v11']].map(([v,l]) => (
            <button key={v} className={`btn tm tm-${v}${timingMode===v?' on':''}`}
              onClick={() => setTimingMode(v)}>{l}</button>
          ))}
        </div>
        <div style={{ fontSize:10, color:'var(--mu)', marginTop:5 }}>{TM_DESC[timingMode]}</div>
        {timingMode === 'vosk' && (
          <div style={{ marginTop:12 }}>
            <label style={{ marginTop:0 }}>
              Модель Vosk <span style={{ color:'var(--mu)' }}>(vosk-model-small-uz-0.22.zip — 49 МБ, загружается один раз)</span>
            </label>
            <div className="kr">
              <input type="file" ref={voskFileRef} accept=".zip" onChange={() => !voskReady && handleLoadVosk()} />
              <button className="btn bc" ref={voskBtnRef} onClick={handleLoadVosk}>▶ Загрузить</button>
            </div>
            <div ref={voskStatusRef} className="vstt" style={{ display:'none' }} />
          </div>
        )}
      </div>
    </div>
  )
}
