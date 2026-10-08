import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import Icon from './Icon'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(1)

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), [])

  const toast = useCallback(
    ({ title, body, tone = 'success', action, duration = 6000 }) => {
      const id = nextId.current++
      setToasts((list) => [...list, { id, title, body, tone, action }])
      if (duration) setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-tone={t.tone}>
            <span className="toast__icon">
              <Icon name={t.tone === 'error' ? 'x' : 'check'} size={13} strokeWidth={2.6} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast__title">{t.title}</div>
              {t.body && <div className="toast__body">{t.body}</div>}
              {t.action}
            </div>
            <button
              type="button"
              className="iconbtn"
              style={{ width: 24, height: 24, background: 'transparent', border: 0, color: '#8ea1b4' }}
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx.toast
}
