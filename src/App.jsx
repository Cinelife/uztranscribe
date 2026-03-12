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
import { GM_MODELS }         from './lib/gemini.js'

export default function App() {
  const [elKey, setElKey] = useState(() => localStorage.getItem('uz_el') || '')
  const [gmKey, setGmKey] = useState(() => localStorage.getItem('uz_gm') || '')
  const [orKey, setOrKey] = useState(() => localStorage.getItem('uz_or') || '')

  const [prov,        setProv]        = useState('el')
  const [lang,        setLang]        = useState('uz')
  const [chunkSec,    setChunkSec]    = useState(30)
  const [maxChars,    setMaxChars]    = useState(80)
  const [minPause,    setMinPause]    = useState(200)
  const [mergeGap,    setMergeGap]    = useState(0.5)
  const [mergeMode,   setMergeMode]   = useState('strict')
  const [dedupWindow, setDedupWindow] = useState(0)
  const [subTiming,   setSubTiming]   = useState('vad')
  const [timingMode,  setTimingMode]  = useState('smart')
  const [orModel,     setOrModel]     = useState(OR_MODELS[0].id)
  const [gmModel,     setGmModel]     = useState(GM_MODELS[0].id)
  const [concurrency, setConcurrency] = useState(6)

  // v13
  const [showMusicMarker, setShowMusicMarker] = useState(false)
  const [targetDur,       setTargetDur]       = useState(1.5)

  const [files,        setFiles]        = useState([])
  const [fileStatuses, setFileStatuses] = useState({})

  const voskModelRef = useRef(null)
  const [voskReady,  setVoskReady]  = useState(false)

  const {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, startBatch, stopBatch,
    lastSrtMap
  } = useBatchRunner()

  const {
    trLog, clearTrLog, trStatus, trRunning,
    trProvider, setTrProvider,
    trSrc, setTrSrc,
    trPair, setTrPair,
    handleTranslate
  } = useTranslation()

  const handleStart = () => startBatch({
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, mergeMode, timingMode,
    dedupWindow, subTiming,
    elKey, gmKey, orKey, orModel, gmModel,
    voskReady, voskModelRef,
    concurrency,
    showMusicMarker,
    targetDur,
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
        mergeMode={mergeMode}  setMergeMode={setMergeMode}
        dedupWindow={dedupWindow} setDedupWindow={setDedupWindow}
        subTiming={subTiming}  setSubTiming={setSubTiming}
        timingMode={timingMode} setTimingMode={setTimingMode}
        orModel={orModel}     setOrModel={setOrModel}
        gmModel={gmModel}     setGmModel={setGmModel}
        voskReady={voskReady} setVoskReady={setVoskReady}
        voskModelRef={voskModelRef}
        concurrency={concurrency} setConcurrency={setConcurrency}
        showMusicMarker={showMusicMarker} setShowMusicMarker={setShowMusicMarker}
        targetDur={targetDur}             setTargetDur={setTargetDur}
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
