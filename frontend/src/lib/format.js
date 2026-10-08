const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

export const fmtInt = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'))

export function fmtPercent(part, whole) {
  if (!whole) return '0%'
  const p = (part / whole) * 100
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
}

/** ₦1,234.50 — the backend's own explanations use the naira sign too. */
export function fmtNaira(value, { compact = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '–'
  const n = Number(value)
  if (compact) {
    const abs = Math.abs(n)
    if (abs >= 1e9) return `₦${(n / 1e9).toFixed(2)}B`
    if (abs >= 1e6) return `₦${(n / 1e6).toFixed(2)}M`
    if (abs >= 1e4) return `₦${(n / 1e3).toFixed(1)}K`
  }
  return `₦${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * The backend stores and returns NAIVE UTC timestamps ("2026-08-31T09:56:44", no zone).
 * A bare `new Date(s)` would read that as local time, so we pin it to UTC explicitly and
 * display every time as UTC. That is also what the transaction date filters expect.
 */
export function parseTs(value) {
  if (!value) return null
  const s = String(value)
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) && s.includes('T')
  const d = new Date(hasZone ? s : `${s}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

export function fmtDateTime(value, { seconds = false } = {}) {
  const d = parseTs(value)
  if (!d) return '–'
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return seconds ? `${base}:${pad(d.getUTCSeconds())}` : base
}

export function fmtDate(value) {
  const d = parseTs(value)
  if (!d) return '–'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** datetime-local input value ("2026-08-01T00:00", read as UTC) -> value the API accepts. */
export function toApiDateTime(localValue) {
  if (!localValue) return undefined
  return localValue.length === 16 ? `${localValue}:00Z` : `${localValue}Z`
}

export function prettify(value) {
  if (!value) return '–'
  const s = String(value).replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const toInt = (value, fallback) => {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Account ids start with ACC, device ids with DEV (see data/*.csv). Used only to pick a link target. */
export const isDeviceId = (id) => typeof id === 'string' && id.startsWith('DEV')
