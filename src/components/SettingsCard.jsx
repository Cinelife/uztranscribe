/**
 * SettingsCard.jsx — v14.0.0
 *
 * Структура:
 *   Провайдер + Язык
 *   ── ФАЗА 1 — Сегментация ──
 *   ── ФАЗА 2 — Dispatch ──
 *   ── ФАЗА 3 — Assembler ──
 *
 * Изменения vs v12.5.4:
 *   - Vosk убран полностью
 *   - ModelSelector (Gemini) с раскрытием вверх
 *   - Цены под списком моделей
 *   - Дедупликация перенесена в Фазу 3
 *   - Classifier убран
 */

import { useState, useRef, useEffect } from 'react'
import { OR_MODELS }    from '../lib/openrouter.js'
import { GEMINI_MODELS } from '../lib/dispatcher.js'

const LANGS = [
  { id: 'uz', label: 'uz Uzbek' },
  { id: 'ru', label: 'ru Русский' },
  { id: 'kk', label: 'kk Қазақша' },
  { id: 'ky', label: 'ky Кыргызча' },
  { id: 'tg', label: 'tg Тоҷикӣ' },
  { id: 'tk', label: 'tk Türkmen' },
  { id: 'en', label: 'en English' },
  { id: 'tr', label: 'tr Türkçe' },
]

// ── Компонент выбора модели Gemini (раскрывается вверх) ───────────────────────
function ModelSelector({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const selected = GEMINI_MODELS.find(m => m.id === value) || GEMINI_MODELS[0]

  useEffect(() => {
    function onClickOutside(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Открытый список — рендерится выше кнопки */}
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, right: 0,
          background: 'var(--c-bg2)', border: '1px solid var(--c-brd)',
          borderRadius: '8px 8px 0 0', overflow: 'hidden',
          boxShadow: '0 -4px 12px rgba(0,0,0,.3)', zIndex: 100,
          marginBottom: 1,
        }}>
          {[...GEMINI_MODELS].reverse().map(m => (
            <button
              key={m.id}
              onClick={() => { onChange(m.id); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 14px', border: 'none', cursor: 'pointer',
                background: m.id === value ? 'var(--c-acc)' : 'transparent',
                color: m.id === value ? '#fff' : 'var(--c-txt)',
                fontSize: 13,
                borderBottom: '1px solid var(--c-brd)',
              }}
            >
              <span style={{ fontWeight: 500 }}>{m.label}</span>
              <span style={{ float: 'right', fontSize: 11, opacity: 0.7 }}>
                ♪${m.audioIn} · T${m.out}
              </span>
            </button>
          ))}
          {/* Пояснение цен */}
          <div style={{ padding: '7px 14px', fontSize: 10, color: 'var(--c-dim)', lineHeight: 1.5, background: 'var(--c-bg1)' }}>
            ♪ = аудио-input &nbsp;·&nbsp; T = output &nbsp;·&nbsp; цены в $ за 1 млн токенов
          </div>
        </div>
      )}

      {/* Кнопка-триггер */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px', border: '1px solid var(--c-brd)',
          borderRadius: open ? '0 0 8px 8px' : 8,
          background: 'var(--c-bg2)', color: 'var(--c-txt)',
          cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}
      >
        <span>{selected.label}</span>
        <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>
          ♪${selected.audioIn}/M &nbsp; {open ? '▼' : '▲'}
        </span>
      </button>

      {/* Рекомендация */}
      <div style={{ fontSize: 10, color: 'var(--c-dim)', marginTop: 4, paddingLeft: 2 }}>
        {value === GEMINI_MODELS[GEMINI_MODELS.length - 1].id
          ? '⭐ Рекомендуется для сложного контента'
          : value === GEMINI_MODELS[0].id
            ? '💰 Самый дешёвый — хорошо для простых файлов'
            : ''}
      </div>
    </div>
  )
}

// ── Вспомогательные компоненты ────────────────────────────────────────────────
function SectionHead({ title, phase }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      margin: '18px 0 10px', borderTop: '1px solid var(--c-brd)', paddingTop: 14,
    }}>
      {phase && (
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
          background: 'var(--c-acc)', color: '#fff',
          borderRadius: 4, padding: '2px 7px',
        }}>{phase}</span>
      )}
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {title}
      </span>
    </div>
  )
}

function SliderRow({ label, value, min, max, step = 1, fmt, onChange, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
        <span style={{ color: 'var(--c-txt)' }}>{label}</span>
        <span style={{ color: 'var(--c-acc)', fontWeight: 500 }}>{fmt ? fmt(value) : value}</span>
      </div>
      {hint && <div style={{ fontSize: 10, color: 'var(--c-dim)', marginBottom: 4 }}>{hint}</div>}
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  )
}

function BtnGroup({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {options.map(o => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            flex: 1, padding: '6px 4px', borderRadius: 6, border: '1px solid',
            borderColor: value === o.id ? 'var(--c-acc)' : 'var(--c-brd)',
            background: value === o.id ? 'var(--c-acc)' : 'transparent',
            color: value === o.id ? '#fff' : 'var(--c-txt)',
            fontSize: 12, cursor: 'pointer', fontWeight: value === o.id ? 600 : 400,
          }}
        >{o.label}</button>
      ))}
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
  const isGemini = prov === 'gm' || prov === 'all'
  const isOR     = prov === 'or' || prov === 'all'

  return (
    <div className="card">
      <div className="ct">Настройки транскрипции</div>

      {/* ── Провайдер + Язык ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--c-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Провайдер</div>
          <BtnGroup
            options={[
              { id: 'el',  label: 'ElevenLabs' },
              { id: 'gm',  label: 'Gemini' },
              { id: 'or',  label: 'OpenRouter' },
              { id: 'all', label: 'Все' },
            ]}
            value={prov} onChange={setProv}
          />
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--c-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Язык</div>
          <select
            value={lang} onChange={e => setLang(e.target.value)}
            style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--c-brd)', background: 'var(--c-bg2)', color: 'var(--c-txt)', fontSize: 13 }}
          >
            {LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
      </div>

      {/* ── ФАЗА 1 — Сегментация ── */}
      <SectionHead phase="ФАЗА 1" title="Сегментация" />

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--c-dim)', marginBottom: 6 }}>Метод тайм-кодов</div>
        <BtnGroup
          options={[
            { id: 'smart',  label: '⚡ Smart Silence' },
            { id: 'v12flags', label: '🚩 v12 Flags' },
          ]}
          value={timingMode} onChange={setTimingMode}
        />
        <div style={{ fontSize: 10, color: 'var(--c-dim)', marginTop: 4 }}>
          {timingMode === 'v12flags'
            ? 'v12: Energy segmenter → флаги {CCC$SSS} → Dispatcher (параллельно)'
            : 'Smart Silence: RMS поиск тишины → чанки → Gemini'}
        </div>
      </div>

      <SliderRow
        label="Размер чанка" value={chunkSec} min={10} max={60} step={5}
        fmt={v => v + 'с'} onChange={setChunkSec}
        hint="Длина одного запроса к Gemini"
      />
      <SliderRow
        label="Мин. пауза" value={minPause} min={100} max={800} step={50}
        fmt={v => v + 'мс'} onChange={setMinPause}
        hint="< 400мс → VAD режет слова. Рекомендуется 250–400мс"
      />

      {/* ── ФАЗА 2 — Dispatch ── */}
      <SectionHead phase="ФАЗА 2" title="Dispatch → Gemini" />

      {(isGemini) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--c-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Модель Gemini</div>
          <ModelSelector value={gmModel} onChange={setGmModel} />
        </div>
      )}

      {isOR && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--c-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>Модель OpenRouter</div>
          <select
            value={orModel} onChange={e => setOrModel(e.target.value)}
            style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--c-brd)', background: 'var(--c-bg2)', color: 'var(--c-txt)', fontSize: 13 }}
          >
            {OR_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      )}

      <SliderRow
        label="Параллельность" value={concurrency} min={1} max={12} step={1}
        fmt={v => '×' + v} onChange={setConcurrency}
        hint="Количество одновременных запросов"
      />

      {/* ── ФАЗА 3 — Assembler ── */}
      <SectionHead phase="ФАЗА 3" title="Assembler → SRT" />

      <SliderRow
        label="Макс. символов на строку" value={maxChars} min={20} max={120} step={5}
        fmt={v => v + ' симв.'} onChange={setMaxChars}
      />

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--c-dim)', marginBottom: 6 }}>Режим сборки строк</div>
        <BtnGroup
          options={[
            { id: 'strict',   label: '⚡ Строгий' },
            { id: 'balanced', label: '⚖ Балансный' },
            { id: 'sentence', label: '✦ По фразам' },
          ]}
          value={mergeMode} onChange={setMergeMode}
        />
      </div>

      <SliderRow
        label="Слияние gap" value={mergeGap} min={0.1} max={2.0} step={0.1}
        fmt={v => v.toFixed(1) + 'с'} onChange={setMergeGap}
        hint="Макс. зазор между сегментами для склейки"
      />

      <SliderRow
        label="Дедупликация" value={dedupWindow} min={0} max={20} step={1}
        fmt={v => v === 0 ? 'выкл' : 'окно ' + v} onChange={setDedupWindow}
        hint="Скользящее окно для удаления повторов. 0 = выкл"
      />

      {/* ── Дополнительно ── */}
      <SectionHead title="Дополнительно" />
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox" checked={showMusicMarker}
          onChange={e => setShowMusicMarker(e.target.checked)}
        />
        ♪ Показывать музыкальные блоки в SRT
      </label>
    </div>
  )
}
