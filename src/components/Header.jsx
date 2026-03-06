import VersionSwitcher from './VersionSwitcher.jsx'

export default function Header() {
  return (
    <div className="head">
      <div className="logo">🎙</div>
      <div>
        <h1>Uzbek Transcriber</h1>
        <p>ElevenLabs · Gemini · OpenRouter → SRT + Vosk 2-pass + Перевод</p>
      </div>
      <div style={{ marginLeft:'auto', display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end', alignItems:'center' }}>
        <span className="badge bb">Batch</span>
        <span className="badge bg">GitHub Pages</span>
        <span className="badge bor-badge">OpenRouter</span>
        <VersionSwitcher />
      </div>
    </div>
  )
}
