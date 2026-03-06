import { useRef, useState, useCallback } from 'react'
import { translateBatch }    from '../lib/gemini.js'
import { translateBatchOR }  from '../lib/openrouter.js'
import { parseSRT, rebuildSRT, downloadSrt } from '../lib/srtUtils.js'
import { sleep }             from '../lib/audioUtils.js'

export const LANG_LABELS = { uz: 'Узбекский', ru: 'Русский', en: 'English' }

export function useTranslation() {
  const [trLog,     setTrLog]     = useState([])
  const [trStatus,  setTrStatus]  = useState('')
  const [trRunning, setTrRunning] = useState(false)
  const logIdRef = useRef(0)

  const addTrLog = useCallback((msg, cls = '') => {
    const id = logIdRef.current++
    setTrLog(prev => [...prev, { id, msg, cls }])
  }, [])

  const clearTrLog = useCallback(() => {
    setTrLog([{ id: logIdRef.current++, msg: '// Лог очищен', cls: 'dm' }])
  }, [])

  const startTranslate = useCallback(async ({
    gmKey, orKey, orModel,
    trProvider,   // 'gm' | 'or'
    trSrc,        // 'last' | 'file'
    trPair,
    lastSrtMap,
    trFileRef
  }) => {
    const key = trProvider === 'or' ? orKey : gmKey
    if (!key) { alert(trProvider === 'or' ? 'Введи OpenRouter API Key' : 'Введи Gemini API Key'); return }

    let srtContent = '', srtFilename = 'subtitles'
    if (trSrc === 'last') {
      const keys = Object.keys(lastSrtMap)
      if (!keys.length) { alert('Нет результатов транскрипции.\nСначала запусти транскрипцию или выбери "Загрузить .srt файл".'); return }
      srtFilename = keys[keys.length - 1]
      srtContent  = lastSrtMap[srtFilename]
    } else {
      const fi = trFileRef.current
      if (!fi?.files?.length) { alert('Выбери .srt файл'); return }
      srtFilename = fi.files[0].name
      srtContent  = await fi.files[0].text()
    }

    const segs = parseSRT(srtContent)
    if (!segs.length) { alert('Не удалось разобрать SRT файл'); return }

    setTrRunning(true)
    setTrLog([])
    const parts = trPair.split('|')
    addTrLog(`── ${LANG_LABELS[parts[0]]||parts[0]} → ${LANG_LABELS[parts[1]]||parts[1]}`, 'pu')
    addTrLog(`── ${srtFilename}  |  ${segs.length} сегментов`, 'dm')

    const BATCH = 25
    const batches = []
    for (let i = 0; i < segs.length; i += BATCH) batches.push(segs.slice(i, i + BATCH))
    addTrLog(`── Батчей: ${batches.length}`, 'dm')

    const translated = []; let ok = true
    for (let bi = 0; bi < batches.length; bi++) {
      addTrLog(`   Батч ${bi+1}/${batches.length}...`, 'dm')
      setTrStatus(`${bi+1}/${batches.length}`)
      try {
        const res = trProvider === 'or'
          ? await translateBatchOR(batches[bi], trPair, orKey, orModel)
          : await translateBatch(batches[bi], trPair, gmKey)
        translated.push(...res)
        addTrLog(`   ✓ Батч ${bi+1}: ${res.length} сегм.`, 'ok')
      } catch (e) {
        addTrLog(`   ✗ Батч ${bi+1}: ${e.message}`, 'er')
        translated.push(...batches[bi]); ok = false
      }
      if (bi < batches.length - 1) await sleep(700)
    }

    const outName = srtFilename.replace(/\.[^.]+$/, '') + '_' + parts[1] + '.srt'
    downloadSrt(rebuildSRT(translated), outName)
    addTrLog(`✅ Сохранено → ${outName}`, 'ok')
    setTrStatus(ok ? `✓ ${segs.length} сегм.` : '⚠ частично')
    setTrRunning(false)
  }, [addTrLog])

  return { trLog, clearTrLog, trStatus, trRunning, startTranslate }
}
