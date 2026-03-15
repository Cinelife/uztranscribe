// App.jsx — v14.0.0
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
import { GEMINI_MODELS }     from './lib/dispatcher.js'

export default function App() {
  const [elKey, setElKey] = useState(() => localStorage.getItem('uz_el') || '')
  const [gmKey, setGmKey] = useState(() => localStorage.getItem('uz_gm') || '')
  const [orKey, setOrKey] = useState(() => localStorage.getItem('uz_or') || '')

  const [prov,        setProv]        = useState('gm')
  const [lang,        setLang]        = useState('uz')
  const [chunkSec,    setChunkSec]    = useState(25)
  const [maxChars,    setMaxChars]    = useState(45)
  const [minPause,    setMinPause]    = useState(250)
  const [mergeGap,    setMergeGap]    = useState(0.6)
  const [mergeMode,   setMergeMode]   = useState('balanced')
  const [dedupWindow, setDedupWindow] = useState(0)
  const [timingMode,  setTimingMode]  = useState('v12')
  const [orModel,     setOrModel]     = useState(OR_MODELS[0].id)
  const [gmModel,     setGmModel]     = useState(GEMINI_MODELS[0].id)
  const [concurrency, setConcurrency] = useState(6)
  const [showMusicMarker, setShowMusicMarker] = useState(false)

  const [files,        setFiles]        = useState([])
  const [fileStatuses, setFileStatuses] = useState({})

  const {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, startBatch, stopBatch,
    lastSrtMap,
  } = useBatchRunner()

  const {
    trLog, clearTrLog, trStatus, trRunning,
    trProvider, setTrProvider,
    trSrc, setTrSrc,
    trPair, setTrPair,
    handleTranslate,
  } = useTranslation()

  const handleStart = () => startBatch({
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode,
    timingMode, dedupWindow,
    elKey, gmKey, orKey, orModel, gmModel,
    concurrency, showMusicMarker,
  })

  return (
    <div className="wrap">
      <Header />
      <ApiKeysCard
        elKey={elKey} setElKey={setElKey}
        gmKey={gmKey} setGmKey={setGmKey}
        orKey={orKey} setOrKey={setOrKey}
        prov={prov}
      />
      <SettingsCard
        prov={prov}           setProv={setProv}
        lang={lang}           setLang={setLang}
        chunkSec={chunkSec}   setChunkSec={setChunkSec}
        maxChars={maxChars}   setMaxChars={setMaxChars}
        minPause={minPause}   setMinPause={setMinPause}
        mergeGap={mergeGap}   setMergeGap={setMergeGap}
        mergeMode={mergeMode} setMergeMode={setMergeMode}
        dedupWindow={dedupWindow} setDedupWindow={setDedupWindow}
        timingMode={timingMode}   setTimingMode={setTimingMode}
        orModel={orModel}     setOrModel={setOrModel}
        gmModel={gmModel}     setGmModel={setGmModel}
        concurrency={concurrency} setConcurrency={setConcurrency}
        showMusicMarker={showMusicMarker} setShowMusicMarker={setShowMusicMarker}
      />
      <FilesCard files={files} setFiles={setFiles} fileStatuses={fileStatuses} />
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
