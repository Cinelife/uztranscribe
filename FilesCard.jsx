import { useRef, useState } from 'react'

const ALLOWED = new Set(['mp3','wav','m4a','ogg','flac','aac','mp4','mov','mkv','avi','webm'])

export default function FilesCard({ files, setFiles, fileStatuses }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  const addFiles = (list) => {
    setFiles(prev => {
      const next = [...prev]
      Array.from(list).forEach(f => {
        const ext = f.name.split('.').pop().toLowerCase()
        if (ALLOWED.has(ext) && !next.find(x => x.name === f.name && x.size === f.size)) {
          next.push(f)
        }
      })
      return next
    })
  }

  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i))
  const clearFiles = () => setFiles([])

  return (
    <div className="card">
      <div className="ct">Аудио / Видео файлы</div>

      <div
        className={`drop${dragging ? ' dv' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
      >
        <input ref={inputRef} type="file" multiple
          accept=".mp3,.wav,.m4a,.ogg,.flac,.aac,.mp4,.mov,.mkv,.avi,.webm"
          onChange={e => { addFiles(e.target.files); e.target.value = '' }}
          style={{ display:'none' }}
        />
        <div className="di">📂</div>
        <div className="dt">
          <strong>Кликни</strong> или перетащи файлы<br/>
          MP3, WAV, M4A, OGG, FLAC, MP4, MOV, MKV...
        </div>
      </div>

      {files.length > 0 && (
        <div className="fl">
          {files.map((f, i) => {
            const ext = f.name.split('.').pop().toUpperCase()
            return (
              <div className="fi" key={`${f.name}-${f.size}`}>
                <span className="fe">{ext}</span>
                <span className="fn">{f.name}</span>
                <span className="fs">{(f.size/1e6).toFixed(1)} MB</span>
                <span className="fst">{fileStatuses[i] || ''}</span>
                <span className="frm" onClick={() => removeFile(i)}>✕</span>
              </div>
            )
          })}
        </div>
      )}

      {files.length > 0 && (
        <div style={{ marginTop:8 }}>
          <button className="btn bx" onClick={clearFiles} style={{ fontSize:10, padding:'4px 10px' }}>
            Очистить все
          </button>
        </div>
      )}
    </div>
  )
}
