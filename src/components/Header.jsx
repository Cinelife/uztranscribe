export default function Header() {
  return (
    <div className="head">
      <div className="logo">🎙</div>
      <div>
        <h1>Uzbek Transcriber</h1>
        <p>ElevenLabs · Gemini · OpenRouter → SRT + Vosk 2-pass + Перевод</p>
      </div>
      <div style={{ marginLeft:'auto', display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end' }}>
        <span className="badge bb">Batch</span>
        <span className="badge bg">GitHub Pages</span>
        <span className="badge bor-badge">OpenRouter</span>
        <span className="badge bpu">v10</span>
      </div>
    </div>
  )
}
