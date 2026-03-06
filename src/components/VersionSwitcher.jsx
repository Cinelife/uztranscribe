import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const CURRENT_VER = __APP_VERSION__

export default function VersionSwitcher() {
  const [open,     setOpen]     = useState(false)
  const [manifest, setManifest] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [pos,      setPos]      = useState({ top:0, right:0 })
  const btnRef = useRef(null)

  const base = import.meta.env.BASE_URL || './'

  // Load manifest on first open
  useEffect(() => {
    if (!open || manifest) return
    setLoading(true)
    fetch(`${base}versions/manifest.json?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(''); return r.json() })
      .then(d  => { setManifest(d); setLoading(false) })
      .catch(() => {
        setManifest({ current: CURRENT_VER, currentLabel: CURRENT_VER, currentDate: '', versions: [] })
        setLoading(false)
      })
  }, [open, manifest, base])

  // Compute popup position from button rect
  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({
        top:   r.bottom + window.scrollY + 6,
        right: window.innerWidth - r.right
      })
    }
    setOpen(o => !o)
  }

  // Outside click
  useEffect(() => {
    if (!open) return
    const h = e => { if (btnRef.current && !btnRef.current.contains(e.target)) setOpen(false) }
    const timer = setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', h) }
  }, [open])

  const isArchived = window.location.pathname.includes('/versions/')

  const allVersions = manifest ? [
    { id: manifest.current, label: manifest.currentLabel || manifest.current, date: manifest.currentDate, path: '', isCurrent: true },
    ...(manifest.versions || []).map(v => ({ ...v, isCurrent: false }))
  ] : []

  const activeId = isArchived
    ? allVersions.find(v => v.id && window.location.pathname.includes(v.id))?.id
    : (manifest?.current || CURRENT_VER)

  const switchTo = ver => {
    const url = (!ver.path || ver.id === manifest?.current) ? base : `${base}${ver.path}`
    if (url !== window.location.pathname + window.location.search) window.location.href = url
    else setOpen(false)
  }

  const popup = open && createPortal(
    <div
      className="version-popup"
      style={{ position:'absolute', top: pos.top, right: pos.right }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="version-popup-title">ВЕРСИИ ПРОЕКТА</div>
      {loading && <div className="version-popup-hint">загрузка...</div>}
      {!loading && allVersions.map(ver => {
        const isActive = ver.id === activeId
        return (
          <button key={ver.id} onClick={() => switchTo(ver)}
            className={`version-item${isActive ? ' active' : ''}`}>
            <span className="version-item-label">{ver.isCurrent ? '★ ' : ''}{ver.label}</span>
            {isActive && <span className="version-item-tag">текущая</span>}
            {ver.date && <div className="version-item-date">{ver.date}</div>}
          </button>
        )
      })}
      <div className="version-popup-footer">Хранится 3 версии · переключение мгновенное</div>
    </div>,
    document.body
  )

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        title="Переключить версию"
        className={`badge bpu${isArchived ? ' badge-archived' : ''}`}
        style={{ cursor:'pointer', border:'none', userSelect:'none', fontFamily:'inherit' }}
      >
        {isArchived ? `◀ ${activeId || '?'}` : `v${CURRENT_VER}`}
        <span style={{ opacity:.5, fontSize:9, marginLeft:3 }}>▾</span>
      </button>
      {popup}
    </>
  )
}
