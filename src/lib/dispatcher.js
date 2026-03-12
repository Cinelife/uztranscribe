/**
 * dispatcher.js — v13.0.0
 *
 * Изменения vs v12.5.4:
 *
 * ПРОМТ:
 *   - Убрана инструкция "Names, brands — Uzbek orthography" (путала модель, confirmed тестами)
 *   - Убраны временны́е подсказки ("Audio 1: 0s–8s") — не нужны при N отдельных WAV
 *   - mixed-сегменты: хинт изменён с [music+speech?] на [sfx] —
 *     явно говорим "фон есть, но транскрибируй речь"
 *   - Добавлена явная инструкция: транскрибировать речь ДАЖЕ при фоновом звуке/музыке
 *
 * FALLBACK-ЛОГИКА (3 попытки вместо 2):
 *   Попытка 1: N сегментов + хинты классификатора
 *   Попытка 2: N сегментов БЕЗ хинтов (если вернул неверное кол-во — хинты путали)
 *   Попытка 3: 1 сегмент (весь чанк) без хинтов (последний resort)
 *   Это решает потерю слов в зоне speech+SFX
 *
 * МОДЕЛИ:
 *   - Убраны мёртвые модели из fallback (2.0-flash, 2.0-flash-lite — 404 на "new user" аккаунтах)
 *   - Актуальный fallback: 2.5-flash ↔ 2.5-flash-lite
 *
 * ВЫВОД:
 *   - dispatchChunks возвращает chunkTimings[] для Phase 2 сводки в useBatchRunner
 *   - Лог попытки 2 (no-hint retry) помечается как 'wa' (предупреждение)
 */

import { sliceToWav, blobToBase64, sleep } from './audioUtils.js'
import { GM_MODELS }                        from './gemini.js'
import { getClassifierHint }               from './audioClassifier.js'

const LANG_MAP = {
  uz: 'Uzbek', ru: 'Russian', en: 'English', kk: 'Kazakh', tg: 'Tajik'
}

// Фильтры "утечки промта" в ответе
const PROMPT_LEAK     = /transcribe this|return only|json array|no speech|raw json|markdown/i
const TIMESTAMP_HALLUC = /^[\d]{1,2}:[\d]{2}(\s+[\d]{1,2}:[\d]{2})*\s*$/

// Алфавитные правила — только скрипт, ничего лишнего
const SCRIPT_RULE = {
  uz: 'Write in Uzbek Latin script. No Cyrillic.',
  ru: 'Write in Russian Cyrillic. No Latin.',
  kk: 'Write in Kazakh Cyrillic. No Latin.',
  tg: 'Write in Tajik Cyrillic. No Latin.',
  en: '',  // en — без ограничений
}

// v13: только рабочие модели
const LIVE_FALLBACK = {
  'gemini-2.5-flash':      ['gemini-2.5-flash-lite'],
  'gemini-2.5-flash-lite': ['gemini-2.5-flash'],
}

function fmt(ms) {
  if (ms < 1000) return `${ms}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

function getMaxOutputTokens(chunkSec) {
  if (chunkSec >= 45) return 4096
  if (chunkSec >= 25) return 2048
  return 1024
}

function buildModelChain(primaryId) {
  // Сначала пробуем через GM_MODELS (для совместимости с gemini.js)
  const found = GM_MODELS.find(m => m.id === primaryId)
  if (found && found.fallback?.length) {
    // Фильтруем мёртвые модели
    const liveFallback = (found.fallback || []).filter(id =>
      id.includes('2.5-flash')
    )
    return [primaryId, ...liveFallback]
  }
  // v13 явный fallback
  return [primaryId, ...(LIVE_FALLBACK[primaryId] || [])]
}

// ── Хинт классификатора → строка для промта ──────────────────────────────────
// v13: mixed = [sfx] вместо [music+speech?] — не путает Gemini
function formatHint(info) {
  if (!info) return null
  if (info.type === 'music')  return '[music-only]'   // только музыка, нет речи
  if (info.type === 'mixed')  return '[sfx]'           // фоновый звук, но речь есть — транскрибируй
  if (info.type === 'silent') return '[silent]'
  return null // speech = без хинта
}

// ── Построение промта ─────────────────────────────────────────────────────────
/**
 * @param {Array<{localStart, localEnd}>} segments
 * @param {string} langName
 * @param {number} chunkDur
 * @param {number} chunkSec
 * @param {number} dedupWindow
 * @param {string} lang
 * @param {Array<string|null>} classHints  — null = не использовать хинты
 */
function buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow, lang, classHints = null) {
  const n          = segments.length
  const scriptRule = SCRIPT_RULE[lang] || ''

  const list = segments.map((s, i) => {
    let line = `  ${i + 1}. ${s.localStart.toFixed(2)}s–${s.localEnd.toFixed(2)}s`
    if (classHints && classHints[i]) line += ` ${classHints[i]}`
    return line
  }).join('\n')

  const hasSfx   = classHints && classHints.some(h => h === '[sfx]')
  const hasMusic = classHints && classHints.some(h => h === '[music-only]')

  return (
    `Transcribe ${langName} speech from this ${chunkDur.toFixed(1)}s audio.\n` +
    (scriptRule ? `${scriptRule}\n` : '') +
    `\n${n} segment(s):\n${list}\n\n` +
    `Rules:\n` +
    `- Transcribe all speech, even over background sound or music.\n` +
    (hasSfx   ? `- [sfx] = background noise, speech is present — transcribe it.\n` : '') +
    (hasMusic ? `- [music-only] = no speech — return "♪".\n` : '') +
    `- No speech / silence: return "".\n` +
    (dedupWindow === 0
      ? `- Repeated speech is real — transcribe it.\n`
      : `- Do not repeat text from previous segments.\n`) +
    `\nReturn ONLY a raw JSON array of exactly ${n} string(s). No timestamps, no comments.\n` +
    `Example: ${n > 2 ? '["...", "...", ...]' : JSON.stringify(Array(n).fill('...'))}`
  )
}

// ── Один API вызов к Gemini ───────────────────────────────────────────────────
async function callGemini(apiKey, b64wav, segments, langName, chunkDur, chunkSec, dedupWindow, primaryId, lang, classHints) {
  const prompt          = buildPrompt(segments, langName, chunkDur, chunkSec, dedupWindow, lang, classHints)
  const n               = segments.length
  const chain           = buildModelChain(primaryId)
  const maxOutputTokens = getMaxOutputTokens(chunkSec)
  const log             = []

  for (const model of chain) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    const t0  = performance.now()
    try {
      const r = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: 'audio/wav', data: b64wav } },
            { text: prompt }
          ]}],
          generationConfig: { temperature: 0, maxOutputTokens }
        })
      })
      const ms = Math.round(performance.now() - t0)

      if (r.status === 429) {
        log.push({ model, status: '429 квота', ms })
        await sleep(2000)
        continue
      }
      if (r.status === 503 || r.status === 504) {
        log.push({ model, status: `${r.status} перегружен`, ms })
        continue
      }
      if (!r.ok) {
        log.push({ model, status: `${r.status} ошибка`, ms })
        continue
      }

      const d   = await r.json()
      const raw = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim()
      if (!raw) { log.push({ model, status: 'пустой ответ', ms }); continue }

      let parsed
      try {
        let s = raw
        if (s.includes('```')) { s = s.split('```')[1] || ''; if (s.startsWith('json')) s = s.slice(4) }
        parsed = JSON.parse(s.trim())
      } catch (_) {
        const m = raw.match(/\[[\s\S]*\]/)
        if (m) try { parsed = JSON.parse(m[0]) } catch (_) { log.push({ model, status: 'JSON err', ms }); continue }
        else { log.push({ model, status: 'JSON err', ms }); continue }
      }
      if (!Array.isArray(parsed)) { log.push({ model, status: 'не массив', ms }); continue }

      const texts = parsed
        .map(x => (typeof x === 'string' ? x : (x?.text || '')).trim())
        .map(t => PROMPT_LEAK.test(t) ? '' : t)
        .map(t => TIMESTAMP_HALLUC.test(t) ? '' : t)
        .slice(0, n)

      log.push({ model, status: '✓', ms })
      return { texts, model, log }

    } catch (e) {
      const ms = Math.round(performance.now() - t0)
      log.push({ model, status: `сеть: ${e.message.slice(0, 30)}`, ms })
      continue
    }
  }
  return { texts: [], model: null, log }
}

// ── Главный экспорт ───────────────────────────────────────────────────────────
export async function dispatchChunks({
  audioBuf, chunks,
  apiKey, lang, chunkSec, dedupWindow = 12,
  onLog, onProgress, stopFlagRef,
  concurrency    = 6,
  gmModel        = 'gemini-2.5-flash-lite',
  classMap       = null,
  classifierMode = 'off',
}) {
  const langName  = LANG_MAP[lang] || lang
  const allText   = new Map()
  const fallbackEnds = new Map()
  let done = 0

  const staggerMs  = Math.max(100, Math.floor(300 / concurrency * 3))
  const dispatchT0 = performance.now()
  const chunkTimes = []   // время каждого чанка — возвращаем в useBatchRunner
  const maxOut     = getMaxOutputTokens(chunkSec)

  onLog(`  ⏱ Dispatcher: ${chunks.length} чанков × ${concurrency} | модель: ${gmModel} | maxOut:${maxOut}`, 'dm')

  await new Promise(resolve => {
    let active = 0, nextCi = 0

    function launch() {
      while (active < concurrency && nextCi < chunks.length) {
        if (stopFlagRef?.current) break
        const ci    = nextCi++
        const chunk = chunks[ci]
        const segs  = chunk.segments
        const n     = segs.length
        const t0    = chunk.t0
        const dur   = chunk.t1 - t0
        active++

        const localSegs = segs.map(s => ({
          localStart: parseFloat((s.start - t0).toFixed(2)),
          localEnd:   parseFloat((s.end   - t0).toFixed(2))
        }))

        // v13: используем новый formatHint вместо getClassifierHint
        const classHints = (classMap && classifierMode !== 'off')
          ? segs.map(s => formatHint(classMap.get(s.flagId)))
          : null   // null = хинты отключены полностью

        const chunkT0 = performance.now()

        sleep(ci % concurrency * staggerMs)
          .then(async () => {
            onLog(`    ⟳ [${ci + 1}/${chunks.length}] ${t0.toFixed(1)}–${chunk.t1.toFixed(1)}с (${n} сег)`, 'dm')

            const prepT0 = performance.now()
            const wav    = sliceToWav(audioBuf, t0, chunk.t1)
            const b64    = await blobToBase64(wav)
            const prepMs = Math.round(performance.now() - prepT0)

            let texts = [], usedModel = '?', attemptLog = []
            const apiT0 = performance.now()

            // ── Попытка 1: с хинтами классификатора ──────────────────────────
            const res1 = await callGemini(
              apiKey, b64, localSegs, langName, dur, chunkSec,
              dedupWindow, gmModel, lang, classHints
            )
            texts = res1.texts; usedModel = res1.model; attemptLog = res1.log

            // ── Попытка 2: БЕЗ хинтов (хинты могли путать модель) ─────────────
            // v13: это решает потерю слов в зоне speech+SFX
            if (texts.length !== n && classHints) {
              onLog(`    ↻ [${ci + 1}] retry без хинтов...`, 'wa')
              const res2 = await callGemini(
                apiKey, b64, localSegs, langName, dur, chunkSec,
                dedupWindow, gmModel, lang, null   // null = без хинтов
              )
              attemptLog.push(...res2.log)
              if (res2.texts.length === n) {
                texts = res2.texts; usedModel = res2.model
              }
            }

            // ── Попытка 3: 1 сегмент (весь чанк) ─────────────────────────────
            if (texts.length !== n) {
              const fallbackSegs = [{ localStart: 0, localEnd: dur }]
              const res3 = await callGemini(
                apiKey, b64, fallbackSegs, langName, dur, chunkSec,
                dedupWindow, gmModel, lang, null
              )
              attemptLog.push(...res3.log)

              if (res3.texts.length > 0) {
                usedModel = res3.model
                const fullText = res3.texts[0]
                // Текст целого чанка → первому сегменту, остальные пустые
                segs.forEach((seg, i) => {
                  allText.set(seg.flagId, i === 0 ? fullText : '')
                  if (i === 0) fallbackEnds.set(seg.flagId, chunk.t1)
                })
                const totalMs = Math.round(performance.now() - chunkT0)
                const apiMs   = Math.round(performance.now() - apiT0)
                chunkTimes.push(totalMs)
                done++
                onProgress && onProgress(done / chunks.length, `⏳ Gemini: ${done}/${chunks.length}`)
                const tryStr = attemptLog
                  .map(l => `${l.model.replace('gemini-', '').replace('-latest', '')}→${l.status}`)
                  .join(' ')
                onLog(`    ⚠ [${ci + 1}] fallback→1сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, 'wa')
                return
              }
            }

            // ── Успех (попытка 1 или 2) ───────────────────────────────────────
            const apiMs   = Math.round(performance.now() - apiT0)
            const totalMs = Math.round(performance.now() - chunkT0)
            chunkTimes.push(totalMs)

            segs.forEach((seg, i) => allText.set(seg.flagId, texts[i] || ''))
            done++
            onProgress && onProgress(done / chunks.length, `⏳ Gemini: ${done}/${chunks.length}`)

            const ok     = texts.filter(Boolean).length
            const tryStr = attemptLog
              .map(l => `${l.model.replace('gemini-', '').replace('-latest', '')}→${l.status}`)
              .join(' ')
            const cls = ok < n ? 'wa' : 'dm'
            onLog(`    ✓ [${ci + 1}] ${ok}/${n}сег | prep:${fmt(prepMs)} api:${fmt(apiMs)} итого:${fmt(totalMs)} | ${tryStr}`, cls)
          })
          .then(() => {
            active--
            if (nextCi < chunks.length && !stopFlagRef?.current) launch()
            else if (active === 0) resolve()
          })
          .catch(err => {
            onLog(`    ✗ [${ci + 1}] ОШИБКА: ${err?.message || err}`, 'er')
            segs.forEach(seg => allText.set(seg.flagId, ''))
            active--
            done++
            if (nextCi < chunks.length && !stopFlagRef?.current) launch()
            else if (active === 0) resolve()
          })
      }
      if (active === 0) resolve()
    }
    launch()
  })

  // ── Итоговая статистика ───────────────────────────────────────────────────
  const totalMs = Math.round(performance.now() - dispatchT0)
  const sumMs   = chunkTimes.reduce((a, b) => a + b, 0)
  const avgMs   = chunkTimes.length ? Math.round(sumMs / chunkTimes.length) : 0
  const minMs   = chunkTimes.length ? Math.min(...chunkTimes) : 0
  const maxMs   = chunkTimes.length ? Math.max(...chunkTimes) : 0
  const speedup = sumMs > 0 ? (sumMs / totalMs).toFixed(1) : '?'

  onLog(`  ⏱ Dispatcher итого: ${fmt(totalMs)} стены | последовательно: ~${fmt(sumMs)}`, 'pu')
  onLog(`  ⏱ Чанки: avg=${fmt(avgMs)} min=${fmt(minMs)} max=${fmt(maxMs)} | ускорение ×${speedup}`, 'pu')

  return {
    allText,
    fallbackEnds,
    chunkTimings: chunkTimes,   // v13: для Phase 2 сводки в useBatchRunner
  }
}
