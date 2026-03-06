export function loadScript(url) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${url}"]`)) { res(); return }
    const s = document.createElement('script')
    s.src = url; s.onload = res
    s.onerror = () => rej(new Error('Не удалось загрузить скрипт'))
    document.head.appendChild(s)
  })
}

/**
 * Load and initialise a Vosk model from a .zip File object.
 * Returns { voskModel, voskReady }
 */
export async function initVoskModel(zipFile) {
  if (!window.Vosk) {
    await loadScript('https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js')
  }
  const url = URL.createObjectURL(zipFile)
  const model = await window.Vosk.createModel(url)
  URL.revokeObjectURL(url)
  // Sanity test
  const testRec = new model.KaldiRecognizer(16000)
  testRec.setWords(true)
  return model
}

/**
 * Fast Vosk boundary detection — processes the full buffer without real-time constraints.
 * Returns array of { t0, t1 } chunks, or null on failure / low coverage.
 */
export async function getVoskBoundaries(file, voskModel, onLog, onProgress, hideProgress, stopFlagRef) {
  return new Promise(async resolve => {
    onProgress(0, 'Vosk Pass 1 — декодирование аудио...')

    const arrayBuf = await file.arrayBuffer()
    let audioBuf
    try {
      const tmpCtx = new AudioContext({ sampleRate: 16000 })
      audioBuf = await tmpCtx.decodeAudioData(arrayBuf)
      tmpCtx.close()
    } catch (e) {
      hideProgress()
      resolve(null)
      return
    }

    const SAMPLE_RATE  = 16000
    const CHUNK_SIZE   = 131072  // ~8s per chunk (faster throughput)
    const YIELD_EVERY  = 4       // yield every ~8s of audio
    const YIELD_DELAY  = 20      // ms
    const totalSamples  = audioBuf.length
    const totalDuration = audioBuf.duration

    onLog(`    Vosk: ${totalDuration.toFixed(1)}с → обработка (чанки по 2с)...`, 'dm')

    // Mono mix
    const nc   = audioBuf.numberOfChannels
    const mono = new Float32Array(totalSamples)
    for (let c = 0; c < nc; c++) {
      const ch = audioBuf.getChannelData(c)
      for (let i = 0; i < totalSamples; i++) mono[i] += ch[i] / nc
    }

    const allWords = []
    const rec = new voskModel.KaldiRecognizer(SAMPLE_RATE)
    rec.setWords(true)
    rec.on('result', msg => {
      const words = msg?.result?.result || []
      for (const w of words) allWords.push(w)
    })
    rec.on('partialresult', () => {})

    const helperCtx = new AudioContext({ sampleRate: SAMPLE_RATE })

    for (let i = 0; i < totalSamples; i += CHUNK_SIZE) {
      if (stopFlagRef?.current) break
      const end      = Math.min(i + CHUNK_SIZE, totalSamples)
      const slice    = mono.subarray(i, end)
      const chunkIdx = Math.floor(i / CHUNK_SIZE)

      const buf = helperCtx.createBuffer(1, slice.length, SAMPLE_RATE)
      buf.copyToChannel(slice, 0)
      try { rec.acceptWaveform(buf) } catch (_) {}

      if (chunkIdx % YIELD_EVERY === 0) {
        const pct = (end / totalSamples) * 100
        onProgress(pct, `Vosk Pass 1 — ${Math.round(pct)}% · ${allWords.length} слов`)
        await new Promise(r => setTimeout(r, YIELD_DELAY))
      }
    }

    helperCtx.close()

    // Flush final result — poll until stable, max 3s
    onProgress(100, 'Vosk — финализация...')
    onLog(`    Vosk: финализация...`, 'dm')
    const prevCount = allWords.length
    await new Promise(r => setTimeout(r, 300))
    // Try to get any remaining partial results
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 200))
      if (allWords.length === prevCount && attempt > 2) break
    }

    onLog(`    Vosk: слов распознано: ${allWords.length}`, 'dm')
    hideProgress()

    if (!allWords.length) { resolve(null); return }

    const lastWordEnd = allWords[allWords.length - 1].end
    const coverage    = lastWordEnd / totalDuration
    onLog(`    Vosk: покрытие ${Math.round(coverage * 100)}% (${lastWordEnd.toFixed(1)}с из ${totalDuration.toFixed(1)}с)`, 'dm')
    if (coverage < 0.5) {
      onLog(`    Vosk: покрытие < 50% — fallback на Smart Silence`, 'wa')
      resolve(null); return
    }

    const chunks = [], GAP = 0.35, MAX = 40
    let t0 = allWords[0].start, t1 = allWords[0].end
    for (let i = 1; i < allWords.length; i++) {
      const w = allWords[i]
      if (w.start - t1 > GAP || w.end - t0 > MAX) {
        chunks.push({ t0, t1: t1 + 0.05 }); t0 = w.start
      }
      t1 = w.end
    }
    chunks.push({ t0, t1: t1 + 0.05 })
    resolve(chunks)
  })
}

// ── v11: get ALL words from whole file (reuses already-loaded model) ────────
export async function getVoskAllWords(file, voskModel, onProgress, onLog) {
  const arrayBuf = await file.arrayBuffer()
  const tmpCtx = new AudioContext({ sampleRate: 16000 })
  const audioBuf = await tmpCtx.decodeAudioData(arrayBuf)
  tmpCtx.close()

  const SAMPLE_RATE = 16000
  const CHUNK_SIZE  = 32768   // ~2s chunks — matches working getVoskBoundaries
  const YIELD_EVERY = 4       // yield every ~8s of audio
  const YIELD_DELAY = 20      // ms — same as getVoskBoundaries
  const totalSamples  = audioBuf.length
  const totalDuration = audioBuf.duration

  // Mono mix
  const nc   = audioBuf.numberOfChannels
  const mono = new Float32Array(totalSamples)
  for (let c = 0; c < nc; c++) {
    const ch = audioBuf.getChannelData(c)
    for (let i = 0; i < totalSamples; i++) mono[i] += ch[i] / nc
  }

  const allWords = []
  const rec = new voskModel.KaldiRecognizer(SAMPLE_RATE)
  rec.setWords(true)
  rec.on('result', msg => {
    for (const w of (msg?.result?.result || [])) allWords.push(w)
  })
  rec.on('partialresult', () => {})

  const helperCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
  let chunkIdx = 0
  for (let i = 0; i < totalSamples; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, totalSamples)
    const buf = helperCtx.createBuffer(1, end - i, SAMPLE_RATE)
    buf.copyToChannel(mono.subarray(i, end), 0)
    try { rec.acceptWaveform(buf) } catch (_) {}
    if (chunkIdx++ % YIELD_EVERY === 0) {
      const pct = end / totalSamples * 100
      onProgress && onProgress(pct, `Vosk: ${Math.round(pct)}% · ${allWords.length} слов`)
      await new Promise(r => setTimeout(r, YIELD_DELAY))
    }
  }
  helperCtx.close()

  // WASM fires result events async — must wait proportional to audio duration
  // Same formula as getVoskBoundaries which is proven to work
  const finalWait = Math.max(totalDuration * 75, 5000)
  const waitSec   = (finalWait / 1000).toFixed(1)
  onLog && onLog(`    Vosk: финализация (~${waitSec}с)...`, 'dm')
  const step = 500
  let elapsed = 0
  while (elapsed < finalWait) {
    await new Promise(r => setTimeout(r, step))
    elapsed += step
    onProgress && onProgress(
      90 + (elapsed / finalWait) * 10,
      `Vosk: финализация ${(elapsed/1000).toFixed(0)}/${waitSec}с...`
    )
  }

  onLog && onLog(`    Vosk: ${allWords.length} слов (${totalDuration.toFixed(0)}с аудио)`, 'ok')
  return allWords.map(w => ({ word: w.word, start: w.start, end: w.end }))
}
