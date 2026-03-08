/**
 * ApiKeysCard.jsx — v12.5
 * ВАЖНО: ключи хранятся ТОЛЬКО в localStorage браузера пользователя.
 * Никогда не записывай реальные ключи в этот файл!
 * Если ключ случайно попал в git — смени его немедленно.
 */
import { useRef } from 'react'

async function checkEL(key) {
  const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key } })
  if (r.ok) { const d = await r.json(); return '✅ ElevenLabs OK\nПлан: ' + (d.subscription?.tier || '?') }
  return '❌ ElevenLabs: ошибка ' + r.status
}

async function checkGM(key) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key)
  if (r.ok) {
    const d = await r.json()
    const cnt = (d.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).length
    return '✅ Gemini OK\nМоделей: ' + cnt
  }
  return '❌ Gemini: ошибка ' + r.status
}

async function checkOR(key) {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': 'Bearer ' + key }
  })
  if (r.ok) { const d = await r.json(); return '✅ OpenRouter OK\nМоделей: ' + (d.data?.length || '?') }
  return '❌ OpenRouter: ошибка ' + r.status
}

export default function ApiKeysCard({ elKey, gmKey, orKey, setElKey, setGmKey, setOrKey }) {
  const doCheck = async (which) => {
    try {
      let msg
      if (which === 'el') msg = await checkEL(elKey)
      else if (which === 'gm') msg = await checkGM(gmKey)
      else msg = await checkOR(orKey)
      alert(msg)
    } catch (e) { alert('❌ ' + e.message) }
  }

  // Сохраняем ключ в localStorage — НЕ в код!
  const saveKey = (which, val) => {
    // Защита: не сохраняем явные плейсхолдеры
    const isPlaceholder = /^(your|test|demo|example|sk_xxx|AIza_xxx)/i.test(val)
    if (isPlaceholder) {
      alert('⚠ Введи реальный ключ, не плейсхолдер')
      return
    }
    if (which === 'el') { setElKey(val); localStorage.setItem('uz_el', val) }
    else if (which === 'gm') { setGmKey(val); localStorage.setItem('uz_gm', val) }
    else { setOrKey(val); localStorage.setItem('uz_or', val) }
  }

  const clearKey = (which) => {
    if (which === 'el') { setElKey(''); localStorage.removeItem('uz_el') }
    else if (which === 'gm') { setGmKey(''); localStorage.removeItem('uz_gm') }
    else { setOrKey(''); localStorage.removeItem('uz_or') }
  }

  return (
    <div className="card">
      <div className="ct">API ключи
        <span style={{fontSize:'0.65em', color:'var(--dm)', fontWeight:400, marginLeft:8}}>
          хранятся в браузере (localStorage), не в коде
        </span>
      </div>

      <label>
        ElevenLabs API Key&nbsp;
        <span style={{color:'var(--mu)'}}>(elevenlabs.io → Profile → API Keys)</span>
      </label>
      <div className="kr">
        <input type="password" value={elKey} placeholder="sk_xxxxxxxxxxxxxxxx" autoComplete="off"
          onChange={e => saveKey('el', e.target.value)} />
        <button className="btn bc" onClick={() => doCheck('el')}>Проверить</button>
        {elKey && <button className="btn" onClick={() => clearKey('el')} title="Очистить ключ"
          style={{padding:'0 8px', opacity:0.6}}>✕</button>}
      </div>

      <label>
        Google Gemini API Key&nbsp;
        <span style={{color:'var(--mu)'}}>(aistudio.google.com → Get API Key)</span>
      </label>
      <div className="kr">
        <input type="password" value={gmKey} placeholder="AIzaSy..." autoComplete="off"
          onChange={e => saveKey('gm', e.target.value)} />
        <button className="btn bc" onClick={() => doCheck('gm')}>Проверить</button>
        {gmKey && <button className="btn" onClick={() => clearKey('gm')} title="Очистить ключ"
          style={{padding:'0 8px', opacity:0.6}}>✕</button>}
      </div>

      <label>
        OpenRouter API Key&nbsp;
        <span style={{color:'var(--mu)'}}>(openrouter.ai → Keys)</span>
      </label>
      <div className="kr">
        <input type="password" value={orKey} placeholder="sk-or-v1-..." autoComplete="off"
          onChange={e => saveKey('or', e.target.value)} />
        <button className="btn bc" onClick={() => doCheck('or')}>Проверить</button>
        {orKey && <button className="btn" onClick={() => clearKey('or')} title="Очистить ключ"
          style={{padding:'0 8px', opacity:0.6}}>✕</button>}
      </div>
    </div>
  )
}
