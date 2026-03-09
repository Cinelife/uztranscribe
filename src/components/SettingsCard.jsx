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

// Inline toggle helper — no extra CSS classes needed
function Toggle({ on, onToggle, label, hint }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'4px' }}>
      <button
        onClick={onToggle}
        style={{
          width:'36px', height:'20px', borderRadius:'10px', border:'none', cursor:'pointer',
          background: on ? 'var(--pu)' : 'var(--brd)',
          position:'relative', flexShrink:0, transition:'background .2s'
        }}
      >
        <span style={{
          position:'absolute', top:'3px',
          left: on ? '18px' : '3px',
          width:'14px', height:'14px', borderRadius:'50%',
          background:'#fff', transition:'left .2s'
        }} />
      </button>
      <span style={{ fontSize:'0.8em', color: on ? 'var(--txt)' : 'var(--mu)' }}>{label}</span>
      {hint && <span style={{ fontSize:'0.7em', color:'var(--dm)' }}>{hint}</span>}
    </div>
  )
}

export default function SettingsCard({
  prov, setProv,
  lang, setLang,
  chunkSec, setChunkSec,
  maxChars, setMaxChars,
  minPause, setMinPause,
  mergeGap, setMergeGap,
  mergeMode, setMergeMode,
  dedupWindow, setDedupWindow,
  subTiming, setSubTiming,
  timingMode, setTimingMode,
  orModel, setOrModel,
  gmModel, setGmModel,
  voskReady, setVoskReady,
  voskModelRef,
  concurrency, setConcurrency,
  // v12.5.4 experimental
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
    setVoskStatus('loading')
    setVoskMsg('⏳ Инициализация vosk-browser WASM...')
    setVoskLog(['Загрузка файла модели...'])
    try {
      const logSteps = ['Распаковка модели...', 'Загрузка WASM модуля...', 'Инициализация распознавателя...']
      let step = 0
      const interval = setInterval(() => {
        if (step < logSteps.length) setVoskLog(prev => [...prev, logSteps[step++]])
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

  const isGmPath = prov === 'gm' || prov === 'or' || prov === 'bo'

  return (
    <div className="card">
      <div className="ct">Настройки транскрипции</div>
      <div className="r2">
        {/* Провайдер */}
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

        {/* Язык */}
        <div>
          <label>Язык аудио</label>
          <div className="ptabs">
            {[['uz','🇺🇿 UZ'],['ru','🇷🇺 RU'],['en','🇬🇧 EN'],['kk','🇰🇿 KK'],['tg','🇹🇯 TG']].map(([v,l]) => (
              <button key={v}
                className={`btn pt${lang===v?' on':''}`}
                onClick={() => setLang(v)}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Gemini model */}
      {(prov === 'gm' || prov === 'bo') && (
        <div style={{marginTop:'10px'}}>
          <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:'6px'}}>
            Модель Gemini:
          </label>
          <div style={{display:'flex',gap:'6px',flexWrap:'wrap'}}>
            {GM_MODELS.map(m => (
              <button key={m.id}
                className={`btn tm${gmModel===m.id?' on':''}`}
                onClick={() => setGmModel(m.id)}
                style={{fontSize:'0.72em',padding:'3px 8px'}}>
                {m.label || m.id.replace('gemini-','')}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* OpenRouter model */}
      {prov === 'or' && (
        <div style={{marginTop:'10px'}}>
          <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:'6px'}}>
            OpenRouter модель:
          </label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}
            style={{width:'100%',padding:'6px',background:'var(--bg3)',color:'var(--txt)',border:'1px solid var(--brd)',borderRadius:'6px'}}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      {/* Sliders */}
      <div style={{marginTop:'12px'}}>
        <div>
          <label>Размер чанка: <strong style={{color:'var(--pu)'}}>{chunkSec}с</strong>
            <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>
              → maxOut: {chunkSec >= 45 ? '4096' : chunkSec >= 25 ? '2048' : '1024'} токенов
            </span>
          </label>
          <input type="range" min="10" max="60" step="5" value={chunkSec}
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

        {/* ── v12.5.4 Экспериментальные настройки ──────────────────────────── */}
        {isGmPath && (
          <div style={{
            marginTop:'14px',
            padding:'12px 14px',
            background:'var(--bg3)',
            border:'1px solid var(--brd)',
            borderRadius:'8px',
          }}>
            <div style={{
              fontSize:'0.7em', letterSpacing:'.1em', color:'var(--mu)',
              textTransform:'uppercase', marginBottom:'10px',
              display:'flex', alignItems:'center', gap:'6px'
            }}>
              <span>⚗</span> Экспериментальные (бэта)
            </div>

            {/* Классификатор аудио */}
            <div style={{marginBottom:'10px'}}>
              <div style={{fontSize:'0.75em',color:'var(--dm)',marginBottom:'6px'}}>
                Классификатор аудио (ZCR+RMS):
              </div>
              <div style={{display:'flex',gap:'6px'}}>
                {[
                  ['off',  '✗ выкл',  'классификатор отключён'],
                  ['hint', '💬 hint', 'добавит подсказку в промпт'],
                  ['full', '🎯 full', 'изменит промпт для музыкальных сегментов'],
                ].map(([v, label, title]) => (
                  <button key={v} title={title}
                    className={`btn tm${classifierMode===v?' on':''}`}
                    onClick={() => setClassifierMode(v)}
                    style={{fontSize:'0.72em',padding:'3px 10px'}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Показывать ♪ */}
            <Toggle
              on={showMusicMarker}
              onToggle={() => setShowMusicMarker(v => !v)}
              label="Показывать ♪ в субтитрах"
              hint={showMusicMarker ? 'музыкальные блоки попадут в SRT' : 'музыкальные блоки пропускаются'}
            />

            {/* RMS sub-timing */}
            <div style={{marginTop:'8px'}}>
              <Toggle
                on={useRmsTiming}
                onToggle={() => setUseRmsTiming(v => !v)}
                label="RMS sub-timing"
                hint="точнее делит длинные сегменты по энергии"
              />
            </div>

            {/* FFT (только если RMS включён) */}
            {useRmsTiming && (
              <div style={{marginLeft:'12px', marginTop:'4px'}}>
                <div style={{fontSize:'0.72em',color:'var(--dm)',marginBottom:'4px'}}>
                  Метод sub-timing:
                </div>
                <div style={{display:'flex',gap:'6px'}}>
                  {[
                    ['rms', '📊 RMS', 'деление по энергии сигнала'],
                    ['fft', '🌊 ZCR', 'деление по речевой плотности (ZCR)'],
                  ].map(([v, label, title]) => {
                    const isOn = v === 'fft' ? useFFT : !useFFT
                    return (
                      <button key={v} title={title}
                        className={`btn tm${isOn?' on':''}`}
                        onClick={() => setUseFFT(v === 'fft')}
                        style={{fontSize:'0.72em',padding:'3px 10px'}}>
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

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
        {timingMode === 'v12' && (
          <div style={{marginTop:'10px'}}>
            <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:'6px'}}>
              Режим сборки строк:
            </label>
            <div style={{display:'flex',gap:'8px'}}>
              {[
                ['strict',   '✂ Строгий',    'строго maxChars, резать где угодно'],
                ['balanced', '⚖ Балансный',  'равномерная длина строк'],
                ['sentence', '📝 По фразам', 'рвать только после . ! ?'],
              ].map(([v, label, hint]) => (
                <button key={v} title={hint}
                  className={`btn tm${mergeMode===v?' on':''}`}
                  onClick={() => setMergeMode(v)}
                  style={{fontSize:'0.75em',padding:'4px 10px'}}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Метод тайм-кодов */}
      {prov !== 'el' && (
        <div style={{ marginTop:12 }}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','⚡ Smart Silence'],['silero','🧠 Silero VAD'],['v12','🚀 v12 Flags'],['vosk','🔬 Vosk v11']].map(([v,l]) => (
              <button key={v}
                className={`btn tm tm-${v}${timingMode===v?' on':''}`}
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
                {[
                  ['vad',   '📍 VAD',       'использовать границы Silero VAD как есть'],
                  ['words', '📏 По словам', 'делить время пропорционально словам'],
                ].map(([v, label, hint]) => (
                  <button key={v} title={hint}
                    className={`btn tm${subTiming===v?' on':''}`}
                    onClick={() => setSubTiming(v)}
                    style={{fontSize:'0.75em',padding:'4px 10px'}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vosk loader */}
      {timingMode === 'vosk' && prov !== 'el' && (
        <div style={{ marginTop:12, padding:'14px', background:'var(--bg3)', borderRadius:'8px', border:'1px solid var(--brd)' }}>
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
            <div className={`vs-badge vs-${voskStatus || 'ok'}`} style={{marginTop:'8px',padding:'6px 10px',borderRadius:'6px',fontSize:'0.78em'}}>
              {voskMsg}
            </div>
          )}
          {voskLog.length > 0 && (
            <div className="vosk-init-log">
              {voskLog.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
