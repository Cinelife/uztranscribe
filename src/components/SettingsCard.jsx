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
  classifierMode,  setClassifierMode,
  showMusicMarker, setShowMusicMarker,
  useRmsTiming,    setUseRmsTiming,
  useFFT,          setUseFFT,
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

      {/* Провайдер + Язык — оригинал 12.5.3 */}
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

      {/* Gemini model select — оригинал 12.5.3 */}
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

      {/* OpenRouter model select */}
      {(prov === 'or' || prov === 'bo') && (
        <div style={{ marginTop:4 }}>
          <label>Модель OpenRouter</label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      {/* Слайдеры в r2 — оригинал 12.5.3 */}
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

        {/* Concurrency в r2 — оригинал 12.5.3 */}
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

      {/* v12 advanced — оригинал 12.5.3 */}
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

      {/* ── v12.5.4 Экспериментальные ────────────────────────────────────── */}
      {isGmPath && (
        <div style={{
          padding:'12px 14px', background:'var(--bg3)',
          border:'1px solid var(--brd)', borderRadius:'8px',
        }}>
          <div style={{
            fontSize:'0.7em', letterSpacing:'.1em', color:'var(--mu)',
            textTransform:'uppercase', marginBottom:'10px',
            display:'flex', alignItems:'center', gap:'6px'
          }}>⚗ Экспериментальные (бэта)</div>

          <div style={{marginBottom:'10px'}}>
            <div style={{fontSize:'0.75em',color:'var(--dm)',marginBottom:'5px'}}>
              Классификатор аудио (ZCR+RMS):
            </div>
            <div style={{display:'flex',gap:'6px'}}>
              {[['off','✗ выкл'],['hint','💬 hint'],['full','🎯 full']].map(([v,l]) => (
                <button key={v} className={`btn tm${classifierMode===v?' on':''}`}
                  onClick={() => setClassifierMode(v)} style={{fontSize:'0.72em',padding:'3px 10px'}}>{l}</button>
              ))}
            </div>
          </div>

          <Toggle on={showMusicMarker} onToggle={() => setShowMusicMarker(v => !v)}
            label="Показывать ♪ в субтитрах"
            hint={showMusicMarker ? 'музыкальные блоки попадут в SRT' : 'музыкальные блоки пропускаются'} />

          <div style={{marginTop:'6px'}}>
            <Toggle on={useRmsTiming} onToggle={() => setUseRmsTiming(v => !v)}
              label="RMS sub-timing" hint="точнее делит длинные сегменты по энергии" />
          </div>

          {useRmsTiming && (
            <div style={{marginLeft:'12px',marginTop:'4px',display:'flex',gap:'6px'}}>
              {[['rms','📊 RMS'],['fft','🌊 ZCR']].map(([v,l]) => (
                <button key={v} className={`btn tm${(v==='fft'?useFFT:!useFFT)?' on':''}`}
                  onClick={() => setUseFFT(v==='fft')} style={{fontSize:'0.72em',padding:'3px 10px'}}>{l}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Метод тайм-кодов — оригинал 12.5.3 */}
      {prov !== 'el' && (
        <div style={{ marginTop:4 }}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','⚡ Smart Silence'],['silero','🧠 Silero VAD'],['v12','🚀 v12 Flags'],['vosk','🔬 Vosk v11']].map(([v,l]) => (
              <button key={v} className={`btn tm tm-${v}${timingMode===v?' on':''}`}
                onClick={() => setTimingMode(v)}>{l}</button>
            ))}
          </div>
          <div className="tm-desc">{TM_DESC[timingMode]}</div>

          {timingMode === 'silero' && (
            <div style={{marginTop:'10px'}}>
              <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:'6px'}}>
                Тайм-коды внутри сегмента:
              </label>
              <div style={{display:'flex',gap:'8px'}}>
                {[['vad','📍 VAD'],['words','📏 По словам']].map(([v,l]) => (
                  <button key={v} className={`btn tm${subTiming===v?' on':''}`}
                    onClick={() => setSubTiming(v)} style={{fontSize:'0.75em',padding:'4px 10px'}}>{l}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vosk loader — оригинал 12.5.3 */}
      {timingMode === 'vosk' && prov !== 'el' && (
        <div style={{ padding:'14px', background:'var(--bg3)', borderRadius:'8px', border:'1px solid var(--brd)' }}>
          <label style={{ marginBottom:8 }}>
            🔬 Vosk модель (.zip) —{' '}
            <a href="https://alphacephei.com/vosk/models" target="_blank" rel="noreferrer"
               style={{ color:'var(--inf)' }}>alphacephei.com/vosk/models</a>
            <span style={{ color:'var(--mu)', marginLeft:6 }}>(vosk-model-small-uz рекомендован)</span>
          </label>
          <div className="kr">
            <input type="file" ref={voskFileRef} accept=".zip" disabled={voskReady} style={{ flex:1 }} />
            <button className="btn bc" onClick={handleLoadVosk} disabled={voskReady || voskStatus==='loading'}
              style={voskReady ? {color:'var(--ok)',borderColor:'var(--ok)'} : {}}>
              {voskReady ? '✓ Загружено' : voskStatus==='loading' ? '⏳...' : 'Загрузить'}
            </button>
          </div>
          {voskMsg && (
            <div style={{marginTop:'8px',padding:'6px 10px',borderRadius:'6px',fontSize:'0.78em',
              background: voskStatus==='ok' ? 'rgba(0,200,100,.1)' : voskStatus==='error' ? 'rgba(200,0,0,.1)' : 'var(--bg)'}}>
              {voskMsg}
            </div>
          )}
          {voskLog.length > 0 && (
            <div className="vosk-init-log">{voskLog.map((l,i) => <div key={i}>{l}</div>)}</div>
          )}
        </div>
      )}
    </div>
  )
}
