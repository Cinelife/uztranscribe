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
  const saveKey = (which, val) => {
    if (which === 'el') { setElKey(val); localStorage.setItem('uz_el', val) }
    else if (which === 'gm') { setGmKey(val); localStorage.setItem('uz_gm', val) }
    else { setOrKey(val); localStorage.setItem('uz_or', val) }
  }
  return (
    <div className="card">
      <div className="ct">API ключи</div>
      <label>ElevenLabs API Key <span style={{ color:'var(--mu)' }}>(elevenlabs.io → Profile → API Keys)</span></label>
      <div className="kr">
        <input type="password" value={elKey} placeholder="sk_xxxxxxxxxxxxxxxx" autoComplete="off"
          onChange={e => saveKey('el', e.target.value)} />
        <button className="btn bc" onClick={() => doCheck('el')}>Проверить</button>
      </div>
      <label>Google Gemini API Key <span style={{ color:'var(--mu)' }}>(aistudio.google.com → Get API Key)</span></label>
      <div className="kr">
        <input type="password" value={gmKey} placeholder="AIzaSy..." autoComplete="off"
          onChange={e => saveKey('gm', e.target.value)} />
        <button className="btn bc" onClick={() => doCheck('gm')}>Проверить</button>
      </div>
      <label>OpenRouter API Key <span style={{ color:'var(--mu)' }}>(openrouter.ai → Keys)</span></label>
      <div className="kr">
        <input type="password" value={orKey} placeholder="sk-or-v1-..." autoComplete="off"
          onChange={e => saveKey('or', e.target.value)} />
        <button className="btn bc" onClick={() => doCheck('or')}>Проверить</button>
      </div>
    </div>
  )
}
