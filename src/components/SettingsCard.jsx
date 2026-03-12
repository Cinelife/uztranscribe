import { useRef, useState } from 'react'
import { OR_MODELS }       from '../lib/openrouter.js'
import { GM_MODELS }       from '../lib/gemini.js'
import { initVoskModel }   from '../lib/vosk.js'

const TM_DESC = {
  smart:  'Авто-поиск тишины в аудио — без зависимостей, работает везде',
  silero: 'Silero VAD: нейросеть (1.8MB, встроена) → точные паузы → флаги → Gemini текст',
  v12:    'v12: Energy segmenter → флаги {CCC$SSS} → Dispatcher (параллельно) → Assembler (без Vosk)',
  vosk:   'v11: Vosk per-chunk → акустические якоря → Gemini пишет только текст (точные таймкоды)'
}

function Toggle({ on, onToggle, label, hint }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'4px' }}>
      <button onClick={onToggle} style={{
        width:'36px', height:'20px', borderRadius:'10px', border:'none', cursor:'pointer',
        background: on ? 'var(--pu)' : 'var(--brd)', position:'relative', flexShrink:0, transition:'background .2s'
      }}>
        <span style={{
          position:'absolute', top:'3px', left: on ? '18px' : '3px',
          width:'14px', height:'14px', borderRadius:'50%', background:'#fff', transition:'left .2s'
        }} />
      </button>
      <span style={{ fontSize:'0.8em', color: on ? 'var(--txt)' : 'var(--mu)' }}>{label}</span>
      {hint && <span style={{ fontSize:'0.7em', color:'var(--dm)', marginLeft:'2px' }}>{hint}</span>}
    </div>
  )
}

export default function SettingsCard({
  prov, setProv, lang, setLang,
  chunkSec, setChunkSec, maxChars, setMaxChars,
  minPause, setMinPause, mergeGap, setMergeGap, mergeMode, setMergeMode,
  dedupWindow, setDedupWindow, subTiming, setSubTiming, timingMode, setTimingMode,
  orModel, setOrModel, gmModel, setGmModel,
  voskReady, setVoskReady, voskModelRef,
  concurrency, setConcurrency,
  showMusicMarker, setShowMusicMarker,
  targetDur, setTargetDur,
}) {
  const voskFileRef = useRef(null)
  const [voskStatus, setVoskStatus] = useState(null)
  const [voskMsg,    setVoskMsg]    = useState('')
  const [voskLog,    setVoskLog]    = useState([])

  const handleLoadVosk = async () => {
    const inp = voskFileRef.current
    if (!inp?.files?.length) { alert('Выбери .zip файл модели Vosk'); return }
    if (voskReady) return
    setVoskStatus('loading'); setVoskMsg('⏳ Инициализация...'); setVoskLog(['Загрузка...'])
    try {
      const steps = ['Распаковка...', 'Загрузка WASM...', 'Инициализация...']
      let s = 0
      const iv = setInterval(() => { if (s < steps.length) setVoskLog(p => [...p, steps[s++]]) }, 800)
      const model = await initVoskModel(inp.files[0])
      clearInterval(iv)
      voskModelRef.current = model; setVoskReady(true); setVoskStatus('ok')
      setVoskMsg(`✅ Vosk готов — ${inp.files[0].name}`)
      setVoskLog(p => [...p, '✅ Готово'])
    } catch (e) {
      setVoskStatus('error')
      setVoskMsg('❌ ' + e.message + (location.protocol === 'file:' ? ' (нужен HTTPS)' : ''))
      setVoskLog(p => [...p, '❌ ' + e.message])
    }
  }

  const isGmPath = prov === 'gm' || prov === 'or' || prov === 'bo'

  return (
    <div className="card">
      <div className="ct">Настройки транскрипции</div>

      {/* Провайдер + Язык */}
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

      {/* Gemini model */}
      {prov === 'gm' && (
        <div style={{ marginTop:4 }}>
          <label>Модель Gemini
            <span style={{fontSize:'0.75em', color:'var(--dm)', marginLeft:8}}>
              {GM_MODELS.find(m => m.id === gmModel)?.priceHr}/ч · {GM_MODELS.find(m => m.id === gmModel)?.note}
            </span>
          </label>
          <select value={gmModel} onChange={e => setGmModel(e.target.value)}>
            {GM_MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}  —  {m.priceHr}/ч  ·  Free {m.freeRpm} RPM</option>
            ))}
          </select>
        </div>
      )}

      {/* OpenRouter model */}
      {(prov === 'or' || prov === 'bo') && (
        <div style={{ marginTop:4 }}>
          <label>Модель OpenRouter</label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      {/* Слайдеры */}
      <div className="r2" style={{ marginTop:4 }}>
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
        <div>
          <label>Дедупликация: <strong style={{color: dedupWindow === 0 ? 'var(--er)' : 'var(--pu)'}}>
            {dedupWindow === 0 ? '✗ выкл' : `окно ${dedupWindow}`}
          </strong>
            <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>
              {dedupWindow === 0 ? 'повторы не удаляются' : '↑ шире поиск дублей'}
            </span>
          </label>
          <input type="range" min="0" max="20" step="1" value={dedupWindow}
            onChange={e => setDedupWindow(Number(e.target.value))} />
        </div>

        {/* Concurrency */}
        {isGmPath && (
          <div>
            <label>Параллельность (Concurrency): <strong style={{color:'var(--pu)'}}>{concurrency}</strong>
              <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>↑ быстрее (Tier 1 = 8+)</span>
            </label>
            <input type="range" min="1" max="15" step="1" value={concurrency}
              onChange={e => setConcurrency(Number(e.target.value))} />
          </div>
        )}
      </div>

      {/* v12 advanced */}
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
      {timingMode === 'v12' && (
        <div style={{marginTop:'10px'}}>
          <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:'6px'}}>
            Режим сборки строк:
          </label>
          <div style={{display:'flex',gap:'8px'}}>
            {[['strict','✂ Строгий'],['balanced','⚖ Балансный'],['sentence','📝 По фразам']].map(([v,l]) => (
              <button key={v} className={`btn tm${mergeMode===v?' on':''}`}
                onClick={() => setMergeMode(v)} style={{fontSize:'0.75em',padding:'4px 10px'}}>{l}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── v13: Дополнительно ────────────────────────────────────────────── */}
      {isGmPath && (
        <div style={{
          padding:'12px 14px', background:'var(--bg3)',
          border:'1px solid var(--brd)', borderRadius:'8px',
        }}>
          <div style={{
            fontSize:'0.7em', letterSpacing:'.1em', color:'var(--mu)',
            textTransform:'uppercase', marginBottom:'10px',
          }}>Дополнительно</div>

          {/* targetDur — целевая длина субтитра */}
          <div style={{marginBottom:'10px'}}>
            <div style={{fontSize:'0.75em', color:'var(--dm)', marginBottom:'5px'}}>
              Длина субтитра:{' '}
              <strong style={{color:'var(--pu)'}}>{targetDur}с</strong>
              <span style={{fontSize:'0.85em', color:'var(--mu)', marginLeft:'6px'}}>
                {targetDur <= 1.0 ? '← быстрый монтаж' : targetDur >= 2.5 ? 'длинные строки →' : 'стандарт'}
              </span>
            </div>
            <div style={{display:'flex', gap:'5px'}}>
              {[1.0, 1.5, 2.0, 2.5, 3.0].map(v => (
                <button key={v}
                  className={`btn tm${targetDur === v ? ' on' : ''}`}
                  onClick={() => setTargetDur(v)}
                  style={{fontSize:'0.72em', padding:'3px 10px'}}
                >{v}с</button>
              ))}
            </div>
          </div>

          {/* showMusicMarker */}
          <Toggle on={showMusicMarker} onToggle={() => setShowMusicMarker(v => !v)}
            label="Показывать ♪ в субтитрах"
            hint={showMusicMarker ? 'музыкальные блоки → SRT' : 'музыкальные блоки пропускаются'} />
        </div>
      )}

      {/* Метод тайм-кодов */}
      {prov !== 'el' && (
        <div style={{ marginTop:4 }}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','⚡ Smart Silence'],['silero','🧠 Silero VAD'],['v12','🚀 v12 Flags'],['vosk','🔬 Vosk v11']].map(([v,l]) => (
              <button key={v} className={`btn tm tm-${v}${timingMode===v?' on':''}`}
                onClick={() => setTimingMode(v)}>{l}</button>
            ))}
          </div>
          <div style={{fontSize:'0.72em',color:'var(--dm)',marginTop:'5px',lineHeight:1.4}}>
            {TM_DESC[timingMode]}
          </div>
        </div>
      )}

      {/* Vosk loader */}
      {timingMode === 'vosk' && (
        <div style={{marginTop:'8px',padding:'10px 12px',background:'var(--bg3)',borderRadius:'8px',border:'1px solid var(--brd)'}}>
          <div style={{fontSize:'0.75em',color:'var(--dm)',marginBottom:'6px'}}>
            Vosk модель (.zip): <a href="https://alphacephei.com/vosk/models" target="_blank" rel="noreferrer"
              style={{color:'var(--pu)'}}>alphacephei.com/vosk/models</a>
          </div>
          <div style={{display:'flex',gap:'8px',alignItems:'center',flexWrap:'wrap'}}>
            <input ref={voskFileRef} type="file" accept=".zip"
              style={{fontSize:'0.75em',flex:1,minWidth:0}} disabled={voskReady} />
            <button className={`btn${voskStatus==='ok'?' ok':''}`}
              onClick={handleLoadVosk} disabled={voskReady}
              style={{fontSize:'0.75em',padding:'4px 12px',whiteSpace:'nowrap'}}>
              {voskStatus === 'ok' ? '✅ Загружено' : voskStatus === 'loading' ? '⏳...' : 'Загрузить'}
            </button>
          </div>
          {voskMsg && (
            <div style={{fontSize:'0.72em',marginTop:'6px',color:voskStatus==='error'?'var(--er)':'var(--ok)'}}>
              {voskMsg}
            </div>
          )}
          {voskLog.length > 0 && (
            <div style={{fontSize:'0.68em',color:'var(--dm)',marginTop:'4px'}}>
              {voskLog.map((l,i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
