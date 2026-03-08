import { useState, useRef }  from 'react'
import Header                from './components/Header.jsx'
import ApiKeysCard           from './components/ApiKeysCard.jsx'
import SettingsCard          from './components/SettingsCard.jsx'
import FilesCard             from './components/FilesCard.jsx'
import ProgressCard          from './components/ProgressCard.jsx'
import TranslationCard       from './components/TranslationCard.jsx'
import { useBatchRunner }    from './hooks/useBatchRunner.js'
import { useTranslation }    from './hooks/useTranslation.js'
import { OR_MODELS }         from './lib/openrouter.js'

export default function App() {
  // ── API ключи — НИКОГДА не хардкодить значения по умолчанию ──────────────
  // localStorage.getItem вернёт null если ключ не сохранён → fallback ''
  // Если старый коммит содержал ключ: удали из localStorage вручную:
  //   localStorage.removeItem('uz_el'); localStorage.removeItem('uz_gm'); localStorage.removeItem('uz_or')
  const [elKey, setElKey] = useState(() => localStorage.getItem('uz_el') || '')
  const [gmKey, setGmKey] = useState(() => localStorage.getItem('uz_gm') || '')
  const [orKey, setOrKey] = useState(() => localStorage.getItem('uz_or') || '')

  // ── Настройки транскрипции ────────────────────────────────────────────────
  const [prov,        setProv]        = useState('el')
  const [lang,        setLang]        = useState('uz')
  const [chunkSec,    setChunkSec]    = useState(30)
  const [maxChars,    setMaxChars]    = useState(80)
  const [minPause,    setMinPause]    = useState(200)
  const [mergeGap,    setMergeGap]    = useState(0.5)
  const [mergeMode,   setMergeMode]   = useState('strict')
  const [dedupWindow, setDedupWindow] = useState(12)
  const [subTiming,   setSubTiming]   = useState('vad')
  const [timingMode,  setTimingMode]  = useState('smart')
  const [orModel,     setOrModel]     = useState(OR_MODELS[0]?.id || '')

  // ── v12.5: Concurrency — параллельность запросов к Gemini ────────────────
  // Дефолт 8. Tier1 = 1000 RPM → 8 параллельно безопасно.
  // Для Free tier рекомендуется 2-3.
  const [concurrency, setConcurrency] = useState(8)

  // ── Vosk (legacy) ─────────────────────────────────────────────────────────
  const [voskReady, setVoskReady] = useState(false)
  const voskModelRef = useRef(null)

  const {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, lastSrtMap, files, setFiles, fileStatuses,
    handleStart, stopBatch
  } = useBatchRunner({
    elKey, gmKey, orKey,
    prov, lang, chunkSec, maxChars, minPause,
    mergeGap, mergeMode, dedupWindow, subTiming, timingMode,
    orModel, voskReady, voskModelRef,
    concurrency   // v12.5
  })

  const {
    trLog, clearTrLog, trStatus, trRunning,
    trProvider, setTrProvider,
    trSrc, setTrSrc,
    trPair, setTrPair,
    handleTranslate
  } = useTranslation({ gmKey, orKey, orModel, lastSrtMap })

  return (
    <div className="app">
      <Header />

      <ApiKeysCard
        elKey={elKey} setElKey={setElKey}
        gmKey={gmKey} setGmKey={setGmKey}
        orKey={orKey} setOrKey={setOrKey}
      />

      <SettingsCard
        prov={prov}             setProv={setProv}
        lang={lang}             setLang={setLang}
        chunkSec={chunkSec}     setChunkSec={setChunkSec}
        maxChars={maxChars}     setMaxChars={setMaxChars}
        minPause={minPause}     setMinPause={setMinPause}
        mergeGap={mergeGap}     setMergeGap={setMergeGap}
        mergeMode={mergeMode}   setMergeMode={setMergeMode}
        dedupWindow={dedupWindow} setDedupWindow={setDedupWindow}
        subTiming={subTiming}   setSubTiming={setSubTiming}
        timingMode={timingMode} setTimingMode={setTimingMode}
        orModel={orModel}       setOrModel={setOrModel}
        voskReady={voskReady}   setVoskReady={setVoskReady}
        voskModelRef={voskModelRef}
        concurrency={concurrency} setConcurrency={setConcurrency}  // v12.5
      />

      <FilesCard
        files={files} setFiles={setFiles}
        fileStatuses={fileStatuses}
      />

      <ProgressCard
        log={log}               clearLog={clearLog}
        progress={progress}     progressText={progressText}
        statusText={statusText}
        voskVisible={voskVisible} voskPct={voskPct} voskText={voskText}
        running={running}
        onStart={handleStart}   onStop={stopBatch}
      />

      <TranslationCard
        trLog={trLog}           clearTrLog={clearTrLog}
        trStatus={trStatus}     trRunning={trRunning}
        trProvider={trProvider} setTrProvider={setTrProvider}
        trSrc={trSrc}           setTrSrc={setTrSrc}
        trPair={trPair}         setTrPair={setTrPair}
        orModel={orModel}
        lastSrtMap={lastSrtMap}
        onTranslate={handleTranslate}
      />
    </div>
  )
}
