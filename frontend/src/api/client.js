/**
 * FraudGraph API client.
 *
 * Every function below maps to exactly one route of the backend (app/routers/*.py) and returns the
 * JSON shape declared in app/schemas.py. Nothing here is mocked or invented.
 *
 * Auth: if the backend has API_KEY set, every /api/v1 request must carry it in an `X-API-Key` header.
 * The key is typed in by the analyst (see ApiKeyModal) and kept in sessionStorage only.
 */

const RAW_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'
export const API_BASE = String(RAW_BASE).replace(/\/+$/, '')
const API_PREFIX = '/api/v1'
const KEY_STORAGE = 'fraudgraph.apiKey'

/* ------------------------------------------------------------------ */
/* API key store (tiny external store so React can subscribe to it)    */
/* ------------------------------------------------------------------ */

function readStoredKey() {
  try {
    return window.sessionStorage.getItem(KEY_STORAGE) || ''
  } catch {
    return ''
  }
}

let apiKey = readStoredKey()
let authVersion = 0
const authListeners = new Set()
const emitAuth = () => authListeners.forEach((fn) => fn())

export const auth = {
  getKey: () => apiKey,
  hasKey: () => Boolean(apiKey),
  /** Bumps whenever the key changes, so data hooks can refetch. */
  getVersion: () => authVersion,
  subscribe(fn) {
    authListeners.add(fn)
    return () => authListeners.delete(fn)
  },
  setKey(key) {
    apiKey = (key || '').trim()
    try {
      if (apiKey) window.sessionStorage.setItem(KEY_STORAGE, apiKey)
      else window.sessionStorage.removeItem(KEY_STORAGE)
    } catch {
      /* storage unavailable: the key just lives in memory for this tab */
    }
    authVersion += 1
    emitAuth()
  },
  clearKey() {
    auth.setKey('')
  },
  /** Asks the UI to open the "API key required" dialog. */
  requestKey() {
    window.dispatchEvent(new CustomEvent('fraudgraph:auth-required'))
  },
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message)
    this.name = 'ApiError'
    this.status = status // 0 = could not reach the server at all
    this.detail = detail
  }
}

/** FastAPI sends `detail` as a string (HTTPException) or a list of validation errors (422). */
function messageFromDetail(detail, fallback) {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d) => {
        const where = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'query' && p !== 'body').join('.') : ''
        return where ? `${where}: ${d.msg}` : d.msg
      })
      .join('; ')
  }
  return fallback
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function buildUrl(path, params) {
  const url = new URL(API_BASE + path, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, typeof value === 'boolean' ? String(value) : String(value))
    }
  }
  return url.toString()
}

async function request(path, { method = 'GET', params, body, signal, protectedRoute = true } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (apiKey) headers['X-API-Key'] = apiKey

  let response
  try {
    response = await fetch(buildUrl(path, params), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError(
      0,
      `Can't reach the FraudGraph API at ${API_BASE}. Check that the backend is running and that this site's origin is listed in CORS_ORIGINS.`,
    )
  }

  let payload = null
  const text = await response.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    if (response.status === 401 && protectedRoute) auth.requestKey()
    const fallback =
      response.status === 401
        ? 'This API requires a key. Enter it to continue.'
        : `Request failed (${response.status})`
    throw new ApiError(response.status, messageFromDetail(payload?.detail, fallback), payload?.detail)
  }
  return payload
}

const enc = encodeURIComponent
const get = (path, params, signal) => request(`${API_PREFIX}${path}`, { params, signal })

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  /** GET /health  (outside /api/v1, never needs a key) */
  health: (signal) => request('/health', { signal, protectedRoute: false }),

  /** GET /api/v1/dashboard/summary */
  dashboardSummary: (signal) => get('/dashboard/summary', undefined, signal),

  /** GET /api/v1/accounts  {search, risk_level, city, page, page_size} */
  listAccounts: (params, signal) => get('/accounts', params, signal),
  /** GET /api/v1/accounts/{id} */
  getAccount: (id, signal) => get(`/accounts/${enc(id)}`, undefined, signal),
  /** GET /api/v1/accounts/{id}/network?depth=1..3 */
  getAccountNetwork: (id, depth, signal) => get(`/accounts/${enc(id)}/network`, { depth }, signal),

  /**
   * GET /api/v1/transactions
   * {account_id, device_id, ip_address, min_amount, max_amount, date_from, date_to,
   *  status, flagged, page, page_size}
   */
  listTransactions: (params, signal) => get('/transactions', params, signal),
  /** GET /api/v1/transactions/{id} */
  getTransaction: (id, signal) => get(`/transactions/${enc(id)}`, undefined, signal),

  /** GET /api/v1/alerts  {severity, status, pattern, entity_id, limit, offset} */
  listAlerts: (params, signal) => get('/alerts', params, signal),
  /** GET /api/v1/alerts/{id} */
  getAlert: (id, signal) => get(`/alerts/${enc(id)}`, undefined, signal),
  /** PATCH /api/v1/alerts/{id}/feedback  body {feedback} */
  setAlertFeedback: (id, feedback) =>
    request(`${API_PREFIX}/alerts/${enc(id)}/feedback`, { method: 'PATCH', body: { feedback } }),

  /** GET /api/v1/cases  {status} */
  listCases: (params, signal) => get('/cases', params, signal),
  /** GET /api/v1/cases/{id} */
  getCase: (id, signal) => get(`/cases/${enc(id)}`, undefined, signal),
  /** POST /api/v1/cases  body {alert_id, notes} */
  createCase: (alertId, notes = '') =>
    request(`${API_PREFIX}/cases`, { method: 'POST', body: { alert_id: alertId, notes } }),
  /** PATCH /api/v1/cases/{id}  body {status?, notes?} */
  updateCase: (id, patch) => request(`${API_PREFIX}/cases/${enc(id)}`, { method: 'PATCH', body: patch }),
}
