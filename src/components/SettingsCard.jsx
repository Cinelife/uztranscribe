import { useRef, useState } from 'react'
import { OR_MODELS }       from '../lib/openrouter.js'
import { initVoskModel }   from '../lib/vosk.js'

const TM_DESC = {
  smart:  'Авто-поиск тишины в аудио — без зависимостей, работает везде',
  silero: 'Silero VAD: нейросеть (1.8MB, встроена) → точные паузы → флаги → Gemini текст',
  v12:    'v12: Energy segmenter → флаги {CCC$SSS} → Dispatcher (параллельно) → Assembler',
  vosk:   'v11: Vosk per-chunk → акустические якоря → Gemini пишет только текст'
}

// v12.5: Рекомендации по concurrency в зависимости от тарифа
const CONCURRENCY_HINT = (n) => {
  if (n <= 3)  return { label: '🐢 Медленно', color: '#888', tip: 'Free tier / осторожно' }
  if (n <= 6)  return { label: '⚡ Умеренно', color: '#4fc', tip: 'Free tier с биллингом' }
  if (n <= 10) return { label: '🚀 Быстро',   color: '#4f4', tip: 'Tier 1 — рекомендуется' }
  return              { label: '⚠ Агрессивно', color: '#fa4', tip: 'Только Tier 1, осторожно с лимитами' }
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
  voskReady, setVoskReady,
  voskModelRef,
  concurrency, setConcurrency   // v12.5
}) {
  const voskFileRef = useRef(null)
  const [voskStatus, setVoskStatus] = useState(null)
  const [voskMsg,    setVoskMsg]    = useState('')
  const [voskLog,    setVoskLog]    = useState([])

  const cHint = CONCURRENCY_HINT(concurrency)

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
                onClick={() => setProv(v)}>{l}
              </button>
            ))}
          </div>
        </div>

        {/* Язык */}
        <div>
          <label>Язык аудио</label>
          <div className="ptabs">
            {[['uz','UZ'],['ru','RU'],['en','EN'],['kk','KK'],['tg','TG']].map(([v,l]) => (
              <button key={v}
                className={`btn pt${lang===v?' on':''}`}
                onClick={() => setLang(v)}>{l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* OpenRouter model */}
      {(prov === 'or' || prov === 'bo') && (
        <div style={{marginTop:10}}>
          <label>OpenRouter модель</label>
          <select value={orModel} onChange={e => setOrModel(e.target.value)}
            style={{width:'100%',background:'var(--bg2)',color:'var(--fg)',border:'1px solid var(--bd)',borderRadius:6,padding:'6px 8px'}}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      {/* Основные слайдеры */}
      <div className="sliders-row" style={{marginTop:12}}>
        <div>
          <label>Размер чанка: <strong style={{color:'var(--pu)'}}>{chunkSec}с</strong>
            <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>↑ меньше запросов</span>
          </label>
          <input type="range" min="15" max="60" step="5" value={chunkSec}
            onChange={e => setChunkSec(Number(e.target.value))} />
        </div>
        <div>
          <label>Макс. символов: <strong style={{color:'var(--pu)'}}>{maxChars}</strong>
            <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>на строку SRT</span>
          </label>
          <input type="range" min="30" max="160" step="10" value={maxChars}
            onChange={e => setMaxChars(Number(e.target.value))} />
        </div>
      </div>

      {/* v12.5: Concurrency slider — показываем только для Gemini/OR */}
      {(prov === 'gm' || prov === 'or' || prov === 'bo') && (
        <div style={{marginTop:12, padding:'10px 12px', background:'var(--bg2)', borderRadius:8, border:'1px solid var(--bd)'}}>
          <label style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
            <span>
              Параллельность (Concurrency):&nbsp;
              <strong style={{color: cHint.color}}>{concurrency}</strong>
              &nbsp;
              <span style={{fontSize:'0.75em', color: cHint.color}}>{cHint.label}</span>
            </span>
            <span style={{fontSize:'0.7em', color:'var(--dm)'}} title={cHint.tip}>
              {cHint.tip}
            </span>
          </label>
          <input type="range" min="1" max="15" step="1" value={concurrency}
            onChange={e => setConcurrency(Number(e.target.value))} />
          <div style={{display:'flex', justifyContent:'space-between', fontSize:'0.65em', color:'var(--dm)', marginTop:2}}>
            <span>1 — Free tier</span>
            <span>3–6 — осторожно</span>
            <span>8–10 — Tier 1 ✓</span>
            <span>15 — max</span>
          </div>
        </div>
      )}

      {/* Дедупликация */}
      <div style={{marginTop:12}}>
        <label>
          Дедупликация: <strong style={{color:'var(--pu)'}}>{dedupWindow === 0 ? 'ВЫКЛ' : dedupWindow}</strong>
          <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>
            {dedupWindow === 0 ? 'повторы не удаляются' : '↑ шире поиск дублей'}
          </span>
        </label>
        <input type="range" min="0" max="20" step="1" value={dedupWindow}
          onChange={e => setDedupWindow(Number(e.target.value))} />
      </div>

      {/* v12 advanced sliders */}
      {timingMode === 'v12' && (
        <div className="sliders-row" style={{marginTop:8, opacity:0.9}}>
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

      {/* Режим сборки (v12) */}
      {timingMode === 'v12' && (
        <div style={{marginTop:10}}>
          <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:6}}>Режим сборки строк:</label>
          <div style={{display:'flex',gap:8}}>
            {[
              ['strict',   '✂ Строгий',    'строго maxChars'],
              ['balanced', '⚖ Балансный',  'равномерная длина'],
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

      {/* Метод тайм-кодов */}
      {prov !== 'el' && (
        <div style={{marginTop:12}}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','⚡ Smart'],['silero','🧠 Silero VAD'],['v12','🚀 v12 Flags'],['vosk','🔬 Vosk']].map(([v,l]) => (
              <button key={v}
                className={`btn tm tm-${v}${timingMode===v?' on':''}`}
                onClick={() => setTimingMode(v)}
                title={TM_DESC[v]}>
                {l}
              </button>
            ))}
          </div>
          {timingMode && <div style={{fontSize:'0.7em',color:'var(--dm)',marginTop:4}}>{TM_DESC[timingMode]}</div>}
        </div>
      )}

      {/* Silero sub-timing */}
      {timingMode === 'silero' && prov !== 'el' && (
        <div style={{marginTop:8}}>
          <label style={{fontSize:'0.75em',color:'var(--dm)'}}>Тайм-коды внутри сегмента:</label>
          <div style={{display:'flex',gap:8,marginTop:4}}>
            {[['vad','VAD границы'],['words','По словам']].map(([v,l]) => (
              <button key={v}
                className={`btn tm${subTiming===v?' on':''}`}
                onClick={() => setSubTiming(v)}
                style={{fontSize:'0.75em',padding:'4px 10px'}}>
                {l}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Vosk loader */}
      {timingMode === 'vosk' && prov !== 'el' && (
        <div style={{marginTop:12,padding:'10px 12px',background:'var(--bg2)',borderRadius:8}}>
          <label style={{fontSize:'0.8em',color:'var(--dm)'}}>Vosk модель (.zip)</label>
          <div style={{display:'flex',gap:8,marginTop:6}}>
            <input type="file" accept=".zip" ref={voskFileRef}
              style={{flex:1,fontSize:'0.8em',color:'var(--fg)'}} />
            <button className={`btn${voskReady?' ok':''}`}
              onClick={handleLoadVosk}
              disabled={voskStatus==='loading'}>
              {voskStatus==='loading' ? '⏳' : voskReady ? '✅' : 'Загрузить'}
            </button>
          </div>
          {voskMsg && <div style={{fontSize:'0.75em',marginTop:6,color:voskStatus==='ok'?'#4f4':voskStatus==='error'?'#f44':'var(--dm)'}}>{voskMsg}</div>}
          {voskLog.length > 0 && (
            <div style={{fontSize:'0.7em',color:'var(--dm)',marginTop:4,maxHeight:80,overflowY:'auto'}}>
              {voskLog.map((l,i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
