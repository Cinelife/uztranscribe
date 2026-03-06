export function loadScript(url) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${url}"]`)) { res(); return }
    const s = document.createElement('script')
    s.src = url; s.onload = res
    s.onerror = () => rej(new Error('Не удалось загрузить скрипт'))
    document.head.appendChild(s)
  })
}

export async function initVoskModel(zipFile) {
  if (!window.Vosk) {
    await loadScript('https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js')
  }
  const url = URL.createObjectURL(zipFile)
  const model = await window.Vosk.createModel(url)
  URL.revokeObjectURL(url)
  const testRec = new model.KaldiRecognizer(16000)
  testRec.setWords(true)
  return model
}

/**
 * v11: Process a pre-sliced AudioBuffer chunk through Vosk.
 * Returns [{word, start, end}] with 0-relative timestamps.
 * Sequential (WASM CPU-bound — cannot parallelize).
 */
export async function getVoskWordsForBuffer(audioBuf, voskModel) {
  return new Promise(async resolve => {
    const SAMPLE_RATE = 16000
    const CHUNK_SIZE  = 32768   // ~2s per chunk
    const YIELD_EVERY = 4       // yield every ~8s of audio
    const YIELD_DELAY = 20      // ms

    const totalSamples = audioBuf.length
    const nc   = audioBuf.numberOfChannels
    const mono = new Float32Array(totalSamples)
    for (let c = 0; c < nc; c++) {
      const ch = audioBuf.getChannelData(c)
      for (let i = 0; i < totalSamples; i++) mono[i] += ch[i] / nc
    }

    const rec = new voskModel.KaldiRecognizer(SAMPLE_RATE)
    rec.setWords(true)

    const allWords = []
    let chunkIdx = 0

    for (let offset = 0; offset < totalSamples; offset += CHUNK_SIZE) {
      const end  = Math.min(offset + CHUNK_SIZE, totalSamples)
      const pcm  = new Float32Array(end - offset)
      for (let i = 0; i < pcm.length; i++) pcm[i] = mono[offset + i]

      const int16 = new Int16Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)))
      }

      rec.acceptWaveform(int16)
      chunkIdx++

      if (chunkIdx % YIELD_EVERY === 0) {
        await new Promise(r => setTimeout(r, YIELD_DELAY))
      }
    }

    // Flush final result
    await new Promise(r => setTimeout(r, 50))

    try {
      const partial = rec.result()
      if (partial?.result) allWords.push(...partial.result)
    } catch (_) {}

    try {
      const final = rec.finalResult()
      if (final?.result) allWords.push(...final.result)
    } catch (_) {}

    rec.free?.()

    // Deduplicate by (word, start) pairs
    const seen = new Set()
    const unique = allWords.filter(w => {
      const key = `${w.word}|${w.start}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })

    resolve(unique)
  })
}

/**
 * v10 compatibility: whole-file Vosk pass → returns [{t0, t1}] chunks.
 * Still used by OpenRouter path.
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
    const CHUNK_SIZE   = 32768
    const YIELD_EVERY  = 4
    const YIELD_DELAY  = 20
    const totalSamples  = audioBuf.length
    const totalDuration = audioBuf.duration

    onLog(`    Vosk: ${totalDuration.toFixed(1)}с → обработка (чанки по 2с)...`, 'dm')

    const nc   = audioBuf.numberOfChannels
    const mono = new Float32Array(totalSamples)
    for (let c = 0; c < nc; c++) {
      const ch = audioBuf.getChannelData(c)
      for (let i = 0; i < totalSamples; i++) mono[i] += ch[i] / nc
    }

    const rec = new voskModel.KaldiRecognizer(SAMPLE_RATE)
    rec.setWords(true)

    const allWords = []
    let chunkIdx = 0

    for (let offset = 0; offset < totalSamples; offset += CHUNK_SIZE) {
      if (stopFlagRef.current) { hideProgress(); resolve(null); return }

      const end  = Math.min(offset + CHUNK_SIZE, totalSamples)
      const pcm  = new Float32Array(end - offset)
      for (let i = 0; i < pcm.length; i++) pcm[i] = mono[offset + i]

      const int16 = new Int16Array(pcm.length)
      for (let i = 0; i < pcm.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)))
      }

      rec.acceptWaveform(int16)
      chunkIdx++

      const pct = Math.round((offset + CHUNK_SIZE) / totalSamples * 100)
      onProgress(Math.min(pct, 99), `Vosk Pass 1 — ${Math.min(pct, 99)}%`)

      if (chunkIdx % YIELD_EVERY === 0) {
        await new Promise(r => setTimeout(r, YIELD_DELAY))
      }
    }

    await new Promise(r => setTimeout(r, 50))

    try {
      const partial = rec.result()
      if (partial?.result) allWords.push(...partial.result)
    } catch (_) {}

    try {
      const final = rec.finalResult()
      if (final?.result) allWords.push(...final.result)
    } catch (_) {}

    rec.free?.()
    hideProgress()

    if (!allWords.length) { resolve(null); return }

    const sorted = allWords.sort((a, b) => a.start - b.start)
    const MIN_PAUSE = 0.3, TARGET_DUR = 25, MAX_DUR = 30
    const chunks = []
    let segStart = sorted[0].start, segEnd = sorted[0].end

    for (let i = 1; i < sorted.length; i++) {
      const w = sorted[i]
      const gap = w.start - segEnd
      const dur = segEnd - segStart
      if ((gap >= MIN_PAUSE && dur >= TARGET_DUR) || dur >= MAX_DUR) {
        chunks.push({ t0: segStart, t1: segEnd })
        segStart = w.start
      }
      segEnd = w.end
    }
    chunks.push({ t0: segStart, t1: segEnd })

    onProgress(100, 'Vosk Pass 1 — готово')
    resolve(chunks.length ? chunks : null)
  })
}
