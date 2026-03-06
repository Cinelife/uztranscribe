import { useRef, useState } from 'react'
import { OR_MODELS }       from '../lib/openrouter.js'
import { initVoskModel }   from '../lib/vosk.js'

const TM_DESC = {
  smart: 'Авто-поиск тишины в аудио — без зависимостей, работает везде',
  vosk:  'v11: Vosk per-chunk → акустические якоря → Gemini пишет только текст (точные таймкоды)',
  v12:   'v12: Energy segmenter → флаги {CCC$SSS} → Dispatcher (параллельно) → Assembler (без Vosk)'
}

export default function SettingsCard({
  prov, setProv,
  lang, setLang,
  chunkSec, setChunkSec,
  maxChars, setMaxChars,
  minPause, setMinPause,
  mergeGap, setMergeGap,
  timingMode, setTimingMode,
  orModel, setOrModel,
  voskReady, setVoskReady,
  voskModelRef
}) {
  const voskFileRef = useRef(null)
  const [voskStatus, setVoskStatus] = useState(null) // null | 'loading' | 'ok' | 'error'
  const [voskMsg,    setVoskMsg]    = useState('')
  const [voskLog,    setVoskLog]    = useState([])

  const handleLoadVosk = async () => {
    const inp = voskFileRef.current
    if (!inp?.files?.length) { alert('Выбери .zip файл модели Vosk'); return }
    if (voskReady) return

    setVoskStatus('loading')
    setVoskMsg('⏳ Инициализация vosk-browser WASM...')
    setVoskLog(['Загрузка файла модели...'])

    try {
      // progress simulation while loading
      const logSteps = [
        'Распаковка модели...',
        'Загрузка WASM модуля...',
        'Инициализация распознавателя...',
      ]
      let step = 0
      const interval = setInterval(() => {
        if (step < logSteps.length) {
          setVoskLog(prev => [...prev, logSteps[step++]])
        }
      }, 800)

      const model = await initVoskModel(inp.files[0])
      clearInterval(interval)

      voskModelRef.current = model
      setVoskReady(true)
      setVoskStatus('ok')
      setVoskMsg(`✅ Vosk готов — ${inp.files[0].name}`)
      setVoskLog(prev => [...prev, '✅ Модель загружена и готова к работе'])
    } catch (e) {
      setVoskStatus('error')
      const extra = location.protocol === 'file:' ? ' (открой через localhost/HTTPS)' : ''
      setVoskMsg('❌ Ошибка: ' + e.message + extra)
      setVoskLog(prev => [...prev, '❌ ' + e.message])
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

      {(prov === 'or' || prov === 'bo') && (
        <div style={{ marginTop:12 }}>
          <label>Модель OpenRouter</label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      <div className="r2" style={{ marginTop:12 }}>
        <div>
          <label>Размер чанка: <strong style={{color:'var(--txt)'}}>{chunkSec}с</strong></label>
          <input type="range" min="15" max="60" step="5" value={chunkSec}
            onChange={e => setChunkSec(Number(e.target.value))} />
        </div>
        <div>
          <label>Макс. символов на строку: <strong style={{color:'var(--txt)'}}>{maxChars}</strong></label>
          <input type="range" min="30" max="160" step="5" value={maxChars}
            onChange={e => setMaxChars(Number(e.target.value))} />
        </div>
        {/* v12 advanced sliders */}
        {timingMode === 'v12' && (
          <div className="sliders-row" style={{marginTop:'8px',opacity:0.9}}>
            <div>
              <label>Мин. пауза: <strong style={{color:'var(--pu)'}}>{minPause}мс</strong>
                <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>↑ меньше сег</span>
              </label>
              <input type="range" min="100" max="800" step="50" value={minPause}
                onChange={e => setMinPause(Number(e.target.value))} />
            </div>
            <div>
              <label>Слияние gap: <strong style={{color:'var(--pu)'}}>{mergeGap}с</strong>
                <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>↑ длиннее строки</span>
              </label>
              <input type="range" min="0.2" max="2.0" step="0.1" value={mergeGap}
                onChange={e => setMergeGap(Number(e.target.value))} />
            </div>
          </div>
        )}
      </div>

      {prov !== 'el' && (
        <div style={{ marginTop:12 }}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','⚡ Smart Silence'],['vosk','🔬 Vosk v11'],['v12','🚀 v12 Flags']].map(([v,l]) => (
              <button key={v}
                className={`btn tm tm-${v}${timingMode===v?' on':''}`}
                onClick={() => setTimingMode(v)}>{l}</button>
            ))}
          </div>
          <div className="tm-desc">{TM_DESC[timingMode]}</div>
        </div>
      )}

      {/* Vosk loader — only when vosk mode selected */}
      {timingMode === 'vosk' && prov !== 'el' && (
        <div style={{ marginTop:12, padding:'14px', background:'var(--bg3)', borderRadius:'8px', border:'1px solid var(--brd)' }}>
          <label style={{ marginBottom:8 }}>
            🔬 Vosk модель (.zip) —{' '}
            <a href="https://alphacephei.com/vosk/models" target="_blank" rel="noreferrer"
               style={{ color:'var(--inf)' }}>alphacephei.com/vosk/models</a>
            <span style={{ color:'var(--mu)', marginLeft:6 }}>(vosk-model-small-uz рекомендован)</span>
          </label>
          <div className="kr">
            <input type="file" ref={voskFileRef} accept=".zip" disabled={voskReady}
              style={{ flex:1 }} />
            <button className={`btn bc`} onClick={handleLoadVosk} disabled={voskReady || voskStatus==='loading'}
              style={voskReady ? {color:'var(--ok)',borderColor:'var(--ok)'} : {}}>
              {voskReady ? '✓ Загружено' : voskStatus==='loading' ? '⏳...' : 'Загрузить'}
            </button>
          </div>

          {/* Status block */}
          {voskStatus && (
            <div className={`vstt vs-${voskStatus==='loading'?'lo':voskStatus==='ok'?'ok':'er'}`}>
              {voskMsg}
            </div>
          )}

          {/* Init log */}
          {voskLog.length > 0 && (
            <div className="vosk-init-log">
              {voskLog.map((line, i) => (
                <div key={i} style={{ color: line.startsWith('✅') ? 'var(--ok)' : line.startsWith('❌') ? 'var(--er)' : 'var(--mu)' }}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
