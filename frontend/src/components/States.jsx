import Icon from './Icon'
import { API_BASE, auth } from '../api/client'

export function Skeleton({ width = '100%', height = 14, style }) {
  return <span className="skeleton" style={{ width, height, ...style }} />
}

export function SkeletonRows({ rows = 6 }) {
  return (
    <div className="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={16} width={`${92 - (i % 3) * 12}%`} />
      ))}
    </div>
  )
}

export function EmptyState({ icon = 'inbox', title, children, action }) {
  return (
    <div className="state">
      <div className="state__icon">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry, title }) {
  const status = error?.status
  let heading = title ?? 'Something went wrong'
  let body = error?.message ?? 'Unexpected error.'
  let extra = null

  if (status === 0) {
    heading = 'Can’t reach the API'
    extra = (
      <p className="muted" style={{ fontSize: 13 }}>
        Start it from the backend folder with <span className="mono">uvicorn app.main:app --port 8000</span>.
      </p>
    )
  } else if (status === 401) {
    heading = 'API key required'
    extra = (
      <button type="button" className="btn btn--primary" onClick={() => auth.requestKey()}>
        <Icon name="key" size={16} /> Enter API key
      </button>
    )
  } else if (status === 404) {
    heading = title ?? 'Not found'
  }

  return (
    <div className="state state--error" role="alert">
      <div className="state__icon">
        <Icon name={status === 0 ? 'wifi' : 'alert'} size={22} />
      </div>
      <h3>{heading}</h3>
      <p>{body}</p>
      {extra}
      {onRetry && status !== 401 && (
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" size={16} /> Try again
        </button>
      )}
    </div>
  )
}
