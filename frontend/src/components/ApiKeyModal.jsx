import { useEffect, useRef, useState } from 'react'
import { auth } from '../api/client'
import Icon from './Icon'

export default function ApiKeyModal({ open, onClose }) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    setValue(auth.getKey())
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const save = (e) => {
    e.preventDefault()
    auth.setKey(value)
    onClose()
  }

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <form className="modal" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="key-title">
        <div className="modal__body">
          <div>
            <h2 id="key-title">API key</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              If the backend has <span className="mono">API_KEY</span> set, every request must carry it. Paste the same
              value here. It is sent in the <span className="mono">X-API-Key</span> header and kept for this browser tab
              only.
            </p>
          </div>
          <div className="field">
            <label htmlFor="api-key">Key</label>
            <input
              id="api-key"
              ref={inputRef}
              className="input mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste your API key"
            />
          </div>
        </div>
        <div className="modal__foot">
          {auth.hasKey() && (
            <button
              type="button"
              className="btn btn--ghost"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                auth.clearKey()
                onClose()
              }}
            >
              Remove key
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!value.trim()}>
            <Icon name="check" size={16} /> Save key
          </button>
        </div>
      </form>
    </>
  )
}
