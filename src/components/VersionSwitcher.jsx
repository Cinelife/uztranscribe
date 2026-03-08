import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const CURRENT_VER = __APP_VERSION__

// Absolute root URL of the site (works from any nested path)
function getSiteRoot() {
  const path = window.location.pathname
  const idx  = path.indexOf('/versions/')
  if (idx !== -1) {
    return window.location.origin + path.slice(0, idx) + '/'
  }
  // strip trailing filename if any
  return window.location.origin + path.replace(/[^/]+$/, '')
}

export default function VersionSwitcher() {
  const [open,     setOpen]     = useState(false)
  const [manifest, setManifest] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [pos,      setPos]      = useState({ top: 0, right: 0 })
  const btnRef = useRef(null)

  const siteRoot = getSiteRoot()
  const isArchived = window.location.pathname.includes('/versions/')

  // Load manifest on first open
  useEffect(() => {
    if (!open || manifest) return
    setLoading(true)
    fetch(`${siteRoot}versions/manifest.json?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(''); return r.json() })
      .then(d  => { setManifest(d); setLoading(false) })
      .catch(() => {
        setManifest({ current: CURRENT_VER, currentLabel: CURRENT_VER, currentDate: '', versions: [] })
        setLoading(false)
      })
  }, [open, manifest, siteRoot])

  // Compute popup position
  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + window.scrollY + 6, right: window.innerWidth - r.right })
    }
    setOpen(o => !o)
  }

  // Outside click closes popup
  useEffect(() => {
    if (!open) return
    const h = e => { if (btnRef.current && !btnRef.current.contains(e.target)) setOpen(false) }
    const timer = setTimeout(() => document.addEventListener('mousedown', h), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', h) }
  }, [open])

  const allVersions = manifest ? [
    { id: manifest.current, label: manifest.currentLabel || manifest.current, date: manifest.currentDate, path: '', isCurrent: true },
    ...(manifest.versions || []).map(v => ({ ...v, isCurrent: false }))
  ] : []

  // Determine which version is active
  const activeId = isArchived
    ? (() => {
        const m = window.location.pathname.match(/\/versions\/([^/]+)\//)
        return m ? m[1] : null
      })()
    : CURRENT_VER

  const switchTo = ver => {
    setOpen(false)
    let url
    if (ver.isCurrent || !ver.path) {
      // Always go to absolute site root for current version
      url = siteRoot
    } else {
      url = siteRoot + ver.path
    }
    if (url !== window.location.href) window.location.href = url
  }

  // Badge label
  const badgeLabel = isArchived
    ? `◀ ${activeId || '?'}`
    : `v${CURRENT_VER}`

  const popup = open && createPortal(
    <div
      className="version-popup"
      style={{ position: 'absolute', top: pos.top, right: pos.right }}
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
        style={{ cursor: 'pointer', border: 'none', userSelect: 'none', fontFamily: 'inherit' }}
      >
        {badgeLabel}
        <span style={{ opacity: .5, fontSize: 9, marginLeft: 3 }}>▾</span>
      </button>
      {popup}
    </>
  )
}
