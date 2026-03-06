import { useState, useEffect, useRef } from 'react'

/**
 * VersionSwitcher — нажать на бейдж версии → попап со списком версий.
 * Каждая версия — это просто подпапка в gh-pages. Переключение = редирект.
 * manifest.json создаётся автоматически GitHub Actions при каждом деплое.
 */
export default function VersionSwitcher() {
  const [open,     setOpen]     = useState(false)
  const [manifest, setManifest] = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const popupRef = useRef(null)

  const basePath = import.meta.env.BASE_URL || './'

  // Load manifest on first open
  useEffect(() => {
    if (!open || manifest) return
    setLoading(true); setError(null)
    fetch(`${basePath}versions/manifest.json?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error('manifest.json not found'); return r.json() })
      .then(d  => { setManifest(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [open, manifest, basePath])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const h = e => { if (popupRef.current && !popupRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const isArchived = window.location.pathname.includes('/versions/')
  const currentLabel = manifest?.currentLabel || manifest?.current || '11'

  const switchTo = (ver) => {
    let url
    if (!ver.path || ver.id === manifest?.current) url = basePath
    else url = `${basePath}${ver.path}`
    window.location.href = url
  }

  const allVersions = manifest ? [
    { id: manifest.current, label: manifest.currentLabel || manifest.current, date: manifest.currentDate, path: '', isCurrent: true },
    ...(manifest.versions || []).map(v => ({ ...v, isCurrent: false }))
  ] : []

  const activeId = isArchived
    ? allVersions.find(v => v.id && window.location.pathname.includes(v.id))?.id
    : manifest?.current

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Переключить версию"
        className={`badge bpu${isArchived ? ' badge-archived' : ''}`}
        style={{ cursor: 'pointer', border: 'none', userSelect: 'none', gap: 4 }}
      >
        {isArchived ? `◀ ${activeId || '?'}` : `v${currentLabel}`}
        <span style={{ opacity: 0.5, fontSize: 9, marginLeft: 3 }}>▾</span>
      </button>

      {open && (
        <div ref={popupRef} className="version-popup">
          <div className="version-popup-title">ВЕРСИИ ПРОЕКТА</div>

          {loading && <div className="version-popup-hint">загрузка...</div>}
          {error   && <div style={{ color: 'var(--err)', fontSize: 12 }}>⚠ {error}</div>}

          {!loading && !error && allVersions.map((ver, i) => {
            const isActive = ver.id === activeId
            return (
              <button key={ver.id} onClick={() => switchTo(ver)}
                className={`version-item${isActive ? ' active' : ''}`}
              >
                <span className="version-item-label">
                  {ver.isCurrent ? '★ ' : ''}{ver.label}
                </span>
                {isActive && <span className="version-item-tag">текущая</span>}
                {ver.date && <div className="version-item-date">{ver.date}</div>}
              </button>
            )
          })}

          {!loading && !error && allVersions.length === 0 && (
            <div className="version-popup-hint">Только текущая версия</div>
          )}

          <div className="version-popup-footer">
            Хранится 3 версии · переключение мгновенное
          </div>
        </div>
      )}
    </div>
  )
}
