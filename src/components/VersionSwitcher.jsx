import { useState, useEffect, useRef } from 'react'

export default function VersionSwitcher() {
  const [open,     setOpen]     = useState(false)
  const [manifest, setManifest] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const containerRef = useRef(null)  // wraps BOTH button + popup

  const base = import.meta.env.BASE_URL || './'

  // Load manifest on first open
  useEffect(() => {
    if (!open || manifest) return
    setLoading(true); setError(null)
    fetch(`${base}versions/manifest.json?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error('manifest.json not found'); return r.json() })
      .then(d  => { setManifest(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [open, manifest, base])

  // Outside-click closes popup — but ONLY when clicking outside entire container
  useEffect(() => {
    if (!open) return
    const h = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    // Use timeout so this listener doesn't catch the opening click
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
    : manifest?.current

  const switchTo = (ver) => {
    const url = (!ver.path || ver.id === manifest?.current) ? base : `${base}${ver.path}`
    if (url !== window.location.pathname + window.location.search) window.location.href = url
    else setOpen(false)
  }

  const currentLabel = manifest?.currentLabel || manifest?.current || '10'

  return (
    <div ref={containerRef} style={{ position:'relative', display:'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Переключить версию"
        className={`badge bpu${isArchived ? ' badge-archived' : ''}`}
        style={{ cursor:'pointer', border:'none', userSelect:'none', fontFamily:'inherit' }}
      >
        {isArchived ? `◀ ${activeId || '?'}` : `v${currentLabel}`}
        <span style={{ opacity:.5, fontSize:9, marginLeft:3 }}>▾</span>
      </button>

      {open && (
        <div className="version-popup">
          <div className="version-popup-title">ВЕРСИИ ПРОЕКТА</div>
          {loading && <div className="version-popup-hint">загрузка...</div>}
          {error   && <div className="version-popup-hint" style={{ color:'var(--wa)' }}>⚠ Только текущая версия</div>}
          {!loading && !error && allVersions.map(ver => {
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
          {!loading && !error && allVersions.length === 0 && (
            <div className="version-popup-hint">Только текущая версия</div>
          )}
          <div className="version-popup-footer">Хранится 3 версии · переключение мгновенное</div>
        </div>
      )}
    </div>
  )
}
