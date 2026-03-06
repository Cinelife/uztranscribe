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
  const [elKey, setElKey] = useState(() => localStorage.getItem('uz_el') || '')
  const [gmKey, setGmKey] = useState(() => localStorage.getItem('uz_gm') || '')
  const [orKey, setOrKey] = useState(() => localStorage.getItem('uz_or') || '')

  const [prov,       setProv]       = useState('el')
  const [lang,       setLang]       = useState('uz')
  const [chunkSec,   setChunkSec]   = useState(30)
  const [maxChars,   setMaxChars]   = useState(80)
  const [minPause,   setMinPause]   = useState(200)  // ms — segmenter sensitivity
  const [mergeGap,   setMergeGap]   = useState(0.5)  // s  — assembler merge threshold
  const [timingMode, setTimingMode] = useState('smart')
  const [orModel,    setOrModel]    = useState(OR_MODELS[0].id)

  const [files,        setFiles]        = useState([])
  const [fileStatuses, setFileStatuses] = useState({})

  const [voskReady, setVoskReady] = useState(false)
  const voskModelRef              = useRef(null)

  const [trProvider, setTrProvider] = useState('gm')
  const [trSrc,      setTrSrc]      = useState('last')
  const [trPair,     setTrPair]     = useState('uz|ru')

  const {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running, startBatch, stopBatch,
    lastSrtMap
  } = useBatchRunner()

  const {
    trLog, clearTrLog, trStatus, trRunning, startTranslate
  } = useTranslation()

  const handleStart = () => startBatch({
    files, prov, lang, chunkSec, maxChars, minPause, mergeGap, timingMode,
    elKey, gmKey, orKey, orModel,
    voskReady, voskModelRef
  })

  const handleTranslate = ({ trFileRef }) => startTranslate({
    gmKey, orKey, orModel,
    trProvider, trSrc, trPair,
    lastSrtMap, trFileRef
  })

  return (
    <div className="wrap">
      <Header />

      <div className="info">
        📥 SRT → <strong>Downloads</strong> автоматически &nbsp;|&nbsp;
        💰 <strong>Gemini</strong> бесплатно до ~2 ч/день &nbsp;|&nbsp;
        <strong>ElevenLabs</strong> $0.40/час &nbsp;|&nbsp;
        🔀 <strong>OpenRouter</strong> — гибкий выбор модели &nbsp;|&nbsp;
        🔬 <strong>Vosk 2-pass</strong> &nbsp;|&nbsp;
        🌐 Перевод с культурной адаптацией
      </div>

      <ApiKeysCard
        elKey={elKey} gmKey={gmKey} orKey={orKey}
        setElKey={setElKey} setGmKey={setGmKey} setOrKey={setOrKey}
      />

      <SettingsCard
        prov={prov}           setProv={setProv}
        lang={lang}           setLang={setLang}
        chunkSec={chunkSec}   setChunkSec={setChunkSec}
        maxChars={maxChars}   setMaxChars={setMaxChars}
        minPause={minPause}   setMinPause={setMinPause}
        mergeGap={mergeGap}   setMergeGap={setMergeGap}
        timingMode={timingMode} setTimingMode={setTimingMode}
        orModel={orModel}     setOrModel={setOrModel}
        voskReady={voskReady} setVoskReady={setVoskReady}
        voskModelRef={voskModelRef}
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
