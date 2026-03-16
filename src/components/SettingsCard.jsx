// SettingsCard.jsx — v14.1.0
// Лэйаут: 2 колонки как на скрине
//   Левая:  Размер чанка, Дедупликация, Режим сборки строк, ♪ кнопка
//   Правая: Макс. символов, Параллельность, Мин. пауза, Слияние gap

import { useRef, useState } from 'react'
import { OR_MODELS }    from '../lib/openrouter.js'
import { GEMINI_MODELS } from '../lib/dispatcher.js'

const TM_DESC = {
  smart:  'Авто-поиск тишины в аудио — без зависимостей, работает везде',
  v12:    'v12: Energy segmenter → флаги {CCC$SSS} → Dispatcher (параллельно) → Assembler',
  silero: 'Silero VAD: нейросеть (ONNX 1.8MB) → точные границы речи → Multi-audio → Assembler',
}

// ── ModelSelector — открывается ВВЕРХ ────────────────────────────────────────
function ModelSelector({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const selected = GEMINI_MODELS.find(m => m.id === value) || GEMINI_MODELS[0]

  function handleClickOutside(e) {
    if (ref.current && !ref.current.contains(e.target)) setOpen(false)
  }
  useState(() => {
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  })

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--bg3)', border: '1px solid var(--brd)',
          borderRadius: '8px 8px 0 0', overflow: 'hidden', marginBottom: 1,
        }}>
          {[...GEMINI_MODELS].reverse().map(m => (
            <button key={m.id} onClick={() => { onChange(m.id); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 12px', border: 'none', cursor: 'pointer',
                background: m.id === value ? 'var(--acc)' : 'transparent',
                color: m.id === value ? '#fff' : 'var(--txt)',
                fontSize: '0.82em', borderBottom: '1px solid var(--brd)',
              }}
            >
              <span style={{ fontWeight: 500 }}>{m.label}</span>
              <span style={{ float: 'right', opacity: 0.6, fontSize: '0.9em' }}>
                ♪${m.audioIn} · out${m.out}
              </span>
            </button>
          ))}
          <div style={{ padding: '5px 12px', fontSize: '0.72em', color: 'var(--mu)', background: 'var(--bg2)', lineHeight: 1.4 }}>
            ♪ = аудио-input · out = output · $ за 1 млн токенов
          </div>
        </div>
      )}
      <button onClick={() => setOpen(o => !o)} className="btn"
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '7px 12px',
          borderRadius: open ? '0 0 6px 6px' : '6px',
          fontSize: '0.82em', fontWeight: 500,
          background: 'var(--bg3)', color: 'var(--txt)',
          border: '1px solid var(--brd)', cursor: 'pointer',
        }}
      >
        <span>{selected.label}</span>
        <span style={{ fontSize: '0.85em', color: 'var(--acc)', marginLeft: 8 }}>
          ♪${selected.audioIn}/M &nbsp;{open ? '▼' : '▲'}
        </span>
      </button>
      <div style={{ fontSize: '0.72em', color: 'var(--mu)', marginTop: 3 }}>
        {value === GEMINI_MODELS[GEMINI_MODELS.length - 1].id
          ? '⭐ Рекомендуется для сложного контента'
          : value === GEMINI_MODELS[0].id
            ? '💰 Самый дешёвый — хорошо для простых файлов'
            : ''}
      </div>
    </div>
  )
}

// ── Главный компонент ─────────────────────────────────────────────────────────
export default function SettingsCard({
  prov, setProv, lang, setLang,
  chunkSec, setChunkSec,
  maxChars, setMaxChars,
  minPause, setMinPause,
  mergeGap, setMergeGap,
  mergeMode, setMergeMode,
  dedupWindow, setDedupWindow,
  timingMode, setTimingMode,
  gmModel, setGmModel,
  orModel, setOrModel,
  concurrency, setConcurrency,
  showMusicMarker, setShowMusicMarker,
}) {
  const isGmPath = prov === 'gm' || prov === 'bo'

  return (
    <div className="card">
      <div className="ct">Настройки транскрипции</div>

      {/* ── Провайдер + Язык ── */}
      <div className="r2" style={{ marginBottom: 4 }}>
        <div>
          <label>Провайдер</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {[['el','ElevenLabs'],['gm','Gemini'],['or','OpenRouter'],['bo','Все']].map(([v,l]) => (
              <button key={v} className={`btn tm${prov===v?' on':''}`}
                onClick={() => setProv(v)} style={{ flex: 1 }}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <label>Язык</label>
          <select className="sel" value={lang} onChange={e => setLang(e.target.value)}>
            {[['uz','uz Uzbek'],['ru','ru Русский'],['kk','kk Қазақша'],['ky','ky Кыргызча'],
              ['tg','tg Тоҷикӣ'],['tk','tk Türkmen'],['en','en English'],['tr','tr Türkçe'],
            ].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>

      {/* ── Модели ── */}
      {isGmPath && (
        <div style={{ marginBottom: 8 }}>
          <label>Модель Gemini</label>
          <ModelSelector value={gmModel} onChange={setGmModel} />
        </div>
      )}
      {(prov === 'or' || prov === 'bo') && (
        <div style={{ marginBottom: 8 }}>
          <label>Модель OpenRouter</label>
          <select className="sel" value={orModel} onChange={e => setOrModel(e.target.value)}>
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      {/* ── Метод тайм-кодов ── */}
      {prov !== 'el' && (
        <div style={{ marginBottom: 8 }}>
          <label>Метод тайм-кодов</label>
          <div className="tmtabs">
            {[['smart','⚡ Smart Silence'],['v12','🚀 v12 Flags'],['silero','🧠 Silero VAD']].map(([v,l]) => (
              <button key={v} className={`btn tm tm-${v}${timingMode===v?' on':''}`}
                onClick={() => setTimingMode(v)}>{l}</button>
            ))}
          </div>
          <div className="tm-desc">{TM_DESC[timingMode]}</div>
        </div>
      )}

      {/* ── Слайдеры: 2 колонки ── */}
      {/*
          Левая колонка:  Размер чанка | Дедупликация | Режим сборки | ♪
          Правая колонка: Макс. символов | Параллельность | Мин. пауза | Слияние gap
      */}
      <div className="r2" style={{ alignItems: 'start' }}>

        {/* ЛЕВАЯ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label>Размер чанка: <strong style={{color:'var(--pu)'}}>{chunkSec}с</strong></label>
            <input type="range" min="10" max="60" step="5" value={chunkSec}
              onChange={e => setChunkSec(Number(e.target.value))} />
          </div>
          <div>
            <label>Дедупликация: <strong style={{color: dedupWindow===0?'var(--er)':'var(--pu)'}}>
              {dedupWindow===0?'✗ выкл':`окно ${dedupWindow}`}
            </strong></label>
            <input type="range" min="0" max="20" step="1" value={dedupWindow}
              onChange={e => setDedupWindow(Number(e.target.value))} />
          </div>
          {(timingMode === 'v12' || timingMode === 'silero') && (
            <div>
              <label style={{fontSize:'0.75em',color:'var(--dm)',display:'block',marginBottom:'6px'}}>
                Режим сборки строк:
              </label>
              <div style={{ display:'flex', gap:'6px' }}>
                {(timingMode === 'silero'
                  ? [['vad','📍 По VAD'],['balanced','⚖ Балансный'],['sentence','📝 По фразам']]
                  : [['strict','✂ Строгий'],['balanced','⚖ Балансный'],['sentence','📝 По фразам']]
                ).map(([v,l]) => (
                  <button key={v} className={`btn tm${mergeMode===v?' on':''}`}
                    onClick={() => setMergeMode(v)}
                    style={{ fontSize:'0.72em', padding:'4px 8px', flex: 1 }}>{l}</button>
                ))}
              </div>
            </div>
          )}
          {isGmPath && (
            <div>
              <button
                className={`btn tm${showMusicMarker?' on':''}`}
                onClick={() => setShowMusicMarker(v => !v)}
                style={{ fontSize:'0.75em' }}
              >
                ♪ {showMusicMarker ? 'Показывать ♪ блоки' : 'Скрывать ♪ блоки'}
              </button>
            </div>
          )}
        </div>

        {/* ПРАВАЯ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label>Макс. символов на строку: <strong style={{color:'var(--txt)'}}>{maxChars}</strong></label>
            <input type="range" min="30" max="160" step="5" value={maxChars}
              onChange={e => setMaxChars(Number(e.target.value))} />
          </div>
          {isGmPath && (
            <div>
              <label>Параллельность: <strong style={{color:'var(--pu)'}}>{concurrency}</strong>
                <span style={{fontSize:'0.7em',color:'var(--dm)',marginLeft:'6px'}}>↑ быстрее</span>
              </label>
              <input type="range" min="1" max="12" step="1" value={concurrency}
                onChange={e => setConcurrency(Number(e.target.value))} />
            </div>
          )}
          {timingMode === 'v12' && (
            <>
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
            </>
          )}
          {timingMode === 'silero' && (
            <div style={{fontSize:'0.75em',color:'var(--mu)',padding:'8px 10px',background:'var(--bg3)',borderRadius:6,border:'1px solid var(--brd)',lineHeight:1.7}}>
              🧠 Silero VAD автоматически определяет границы речи.<br/>
              Регуляторы пауз не нужны — нейросеть делает это точнее.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
