import { useRef, useState, useCallback } from 'react'
import { transcribeEL }          from '../lib/elevenlabs.js'
import { transcribeGemini }       from '../lib/gemini.js'
import { transcribeOpenRouter }   from '../lib/openrouter.js'
import { getVoskBoundaries }      from '../lib/vosk.js'
import { buildSrt, downloadSrt }  from '../lib/srtUtils.js'
import { sleep }                  from '../lib/audioUtils.js'

export function useBatchRunner() {
  const [log,          setLog]          = useState([])
  const [progress,     setProgress]     = useState(0)
  const [progressText, setProgressText] = useState('Готов к запуску')
  const [statusText,   setStatusText]   = useState('')
  const [running,      setRunning]      = useState(false)
  const [lastSrtMap,   setLastSrtMap]   = useState({})

  const [voskVisible, setVoskVisible] = useState(false)
  const [voskPct,     setVoskPct]     = useState(0)
  const [voskText,    setVoskText]    = useState('Vosk — анализ речи...')

  const stopFlagRef = useRef(false)
  const logIdRef    = useRef(0)

  const addLog = useCallback((msg, cls = '') => {
    const id = logIdRef.current++
    setLog(prev => [...prev, { id, msg, cls }])
  }, [])

  const clearLog = useCallback(() => {
    setLog([{ id: logIdRef.current++, msg: '// Лог очищен', cls: 'dm' }])
  }, [])

  const stopBatch = useCallback(() => {
    stopFlagRef.current = true
    addLog('⏹  Остановка после текущего чанка...', 'wa')
  }, [addLog])

  const startBatch = useCallback(async ({
    files, prov, lang, chunkSec, maxChars, timingMode,
    elKey, gmKey, orKey, orModel,
    voskReady, voskModelRef
  }) => {
    if (!files.length) { alert('Добавь файлы!'); return }
    if (prov !== 'gm' && prov !== 'or' && prov !== 'bo' && !elKey) { alert('Введи ElevenLabs API Key'); return }
    if ((prov === 'gm' || prov === 'bo') && !gmKey) { alert('Введи Gemini API Key'); return }
    if ((prov === 'or' || prov === 'bo') && !orKey) { alert('Введи OpenRouter API Key'); return }

    setRunning(true)
    stopFlagRef.current = false
    setLog([])
    setProgress(0)
    setProgressText('Старт...')
    setStatusText('')

    // v11: Gemini + Vosk loaded
    const useVoskV11 = timingMode === 'vosk' && voskReady && !!voskModelRef?.current && prov !== 'or'
    // v10: Vosk whole-file (OR path or fallback)
    const useVoskV10 = timingMode === 'vosk' && voskReady && !!voskModelRef?.current

    const onVoskProgress = (pct, text) => {
      setVoskVisible(true)
      setVoskPct(pct)
      setVoskText(text || 'Vosk — анализ речи...')
    }
    const hideVoskProgress = () => setVoskVisible(false)
    const onProgress = (text) => setProgressText(text)

    let provs
    if (prov === 'bo') provs = ['el','gm','or'].filter(p => (p==='el'&&elKey)||(p==='gm'&&gmKey)||(p==='or'&&orKey))
    else if (prov === 'el') provs = ['el']
    else if (prov === 'gm') provs = ['gm']
    else provs = ['or']

    const total   = files.length * provs.length
    let done = 0, success = 0
    const failed  = []
    const newSrtMap = {}

    addLog('')
    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`  Файлов: ${files.length}  |  Провайдер: ${prov.toUpperCase()}  |  Язык: ${lang}`, 'in')
    addLog(`  Символов на строку: ${maxChars}`, 'dm')
    if (useVoskV11) addLog('  Vosk v11: per-chunk anchor mode ✓', 'ok')
    else if (useVoskV10) addLog('  Vosk 2-pass: ✓ активен', 'ok')
    else if (timingMode === 'vosk') addLog('  ⚠ Vosk выбран, но модель не загружена → Smart Silence', 'wa')
    if (prov === 'or' || prov === 'bo') addLog(`  OpenRouter модель: ${orModel}`, 'or-cl')
    addLog('══════════════════════════════════════════════', 'dm')

    for (let fi = 0; fi < files.length && !stopFlagRef.current; fi++) {
      const file = files[fi]
      for (const p of provs) {
        if (stopFlagRef.current) break
        done++
        setProgress((done - 1) / total * 100)
        setProgressText(`[${done}/${total}] ${file.name}`)

        const pLabel = p === 'el' ? 'ElevenLabs' : p === 'gm' ? 'Gemini' : 'OpenRouter'
        addLog('')
        addLog(`[${done}/${total}] ${file.name}  (${pLabel})`, 'in')

        try {
          let segs

          if (p === 'el') {
            segs = await transcribeEL(file, elKey, lang, maxChars, addLog)
          }
          else if (p === 'gm') {
            if (useVoskV11) {
              // v11: pass voskModel directly, gemini.js handles per-chunk Vosk internally
              addLog('    v11: Vosk per-chunk → Gemini anchor mode...', 'in')
              segs = await transcribeGemini(
                file, gmKey, lang, chunkSec, maxChars,
                null,               // preChunks = null → triggers v11 path
                addLog, onProgress, stopFlagRef,
                voskModelRef.current, onVoskProgress, hideVoskProgress
              )
            } else {
              // v10: whole-file Vosk boundaries
              let preChunks = null
              if (useVoskV10) {
                addLog('    Pass 1 — Vosk: ищем границы речи...', 'in')
                try {
                  preChunks = await getVoskBoundaries(file, voskModelRef.current, addLog, onVoskProgress, hideVoskProgress, stopFlagRef)
                  if (preChunks?.length) addLog(`    Vosk: ${preChunks.length} границ ✓`, 'ok')
                  else { addLog('    Vosk: речь не найдена → fallback Smart Silence', 'wa'); preChunks = null }
                } catch (ve) {
                  addLog(`    ⚠ Vosk: ${ve.message} → fallback Smart Silence`, 'wa')
                  preChunks = null
                }
                if (preChunks) addLog('    Pass 2 — Gemini: транскрибируем по Vosk-границам...', 'in')
              }
              segs = await transcribeGemini(
                file, gmKey, lang, chunkSec, maxChars,
                preChunks, addLog, onProgress, stopFlagRef
              )
            }
          }
          else { // or — v10 Vosk path (no per-chunk v11 for OR yet)
            let preChunks = null
            if (useVoskV10) {
              addLog('    Pass 1 — Vosk: ищем границы речи...', 'in')
              try {
                preChunks = await getVoskBoundaries(file, voskModelRef.current, addLog, onVoskProgress, hideVoskProgress, stopFlagRef)
                if (preChunks?.length) addLog(`    Vosk: ${preChunks.length} границ ✓`, 'ok')
                else { addLog('    Vosk: речь не найдена → fallback Smart Silence', 'wa'); preChunks = null }
              } catch (ve) {
                addLog(`    ⚠ Vosk: ${ve.message} → fallback Smart Silence`, 'wa')
                preChunks = null
              }
              if (preChunks) addLog('    Pass 2 — OR: транскрибируем по Vosk-границам...', 'or-cl')
            }
            segs = await transcribeOpenRouter(file, orKey, orModel, lang, chunkSec, maxChars, preChunks, addLog, onProgress, stopFlagRef)
          }

          if (!segs.length) throw new Error('Нет сегментов — аудио тихое или пустое')

          const suffix   = p === 'el' ? '_el' : p === 'gm' ? '_gm' : '_or'
          const srtName  = file.name.replace(/\.[^.]+$/, '') + suffix + '.srt'
          const srtContent = buildSrt(segs)
          downloadSrt(srtContent, srtName)
          newSrtMap[srtName] = srtContent
          success++
          addLog(`  ✓ ${srtName}  (${segs.length} сегментов)`, 'ok')
        } catch (e) {
          addLog(`  ✗ ОШИБКА: ${e.message}`, 'er')
          failed.push(`${file.name} (${p})`)
        }

        setProgress((done / total) * 100)
        if (done < total) await sleep(200)
      }
    }

    setLastSrtMap(prev => ({ ...prev, ...newSrtMap }))
    setProgress(100)
    setProgressText(`Готово: ${success}/${total}`)
    setStatusText(`✓ ${success}/${total} файлов`)
    addLog('')
    addLog('══════════════════════════════════════════════', 'dm')
    addLog(`  ГОТОВО: ${success}/${total}`, success === total ? 'ok' : 'wa')
    if (failed.length) failed.forEach(f => addLog(`  ✗ ${f}`, 'er'))
    addLog('  SRT → папка Downloads', 'ok')
    if (success) addLog('  💡 Можно перевести результат ниже ↓', 'pu')
    addLog('══════════════════════════════════════════════', 'dm')

    setRunning(false)
  }, [addLog])

  return {
    log, clearLog,
    progress, progressText, statusText,
    voskVisible, voskPct, voskText,
    running,
    startBatch, stopBatch,
    lastSrtMap
  }
}
