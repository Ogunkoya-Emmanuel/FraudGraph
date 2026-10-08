import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * A deliberately tiny hash router (#/alerts/ALT-00001?status=new).
 * Hash routing means the app works on any static host without server rewrite rules,
 * and every filter / selection is a shareable, back-button-friendly URL.
 */

function readLocation() {
  const raw = window.location.hash.slice(1) || '/'
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const search = q === -1 ? '' : raw.slice(q + 1)
  const query = {}
  new URLSearchParams(search).forEach((v, k) => {
    query[k] = v
  })
  return { path: path.startsWith('/') ? path : `/${path}`, query }
}

export function buildHref(path, query) {
  const sp = new URLSearchParams()
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  })
  const qs = sp.toString()
  return qs ? `${path}?${qs}` : path
}

const RouterContext = createContext(null)

export function Router({ children }) {
  const [location, setLocation] = useState(readLocation)

  useEffect(() => {
    const onChange = () => setLocation(readLocation())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((to, { replace = false } = {}) => {
    if (replace) {
      const url = new URL(window.location.href)
      url.hash = to
      window.location.replace(url.toString())
    } else {
      window.location.hash = to
    }
  }, [])

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRoute() {
  const ctx = useContext(RouterContext)
  if (!ctx) throw new Error('useRoute must be used inside <Router>')
  return ctx
}

export function useNavigate() {
  return useRoute().navigate
}

/** [query, setQuery(patch, {replace})]: patch merges into the current query; empty values are removed. */
export function useQueryState() {
  const { path, query, navigate } = useRoute()
  const setQuery = useCallback(
    (patch, { replace = true } = {}) => {
      navigate(buildHref(path, { ...query, ...patch }), { replace })
    },
    [path, query, navigate],
  )
  return [query, setQuery]
}

/** Href (without the leading #) for the current page with some query keys changed. */
export function useHrefWith() {
  const { path, query } = useRoute()
  return useCallback((patch) => buildHref(path, { ...query, ...patch }), [path, query])
}

export function Link({ to, children, ...rest }) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  )
}

export function NavLink({ to, children, className = '', activeClassName = 'is-active', ...rest }) {
  const { path } = useRoute()
  const active = to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)
  return (
    <a
      href={`#${to}`}
      className={`${className} ${active ? activeClassName : ''}`.trim()}
      aria-current={active ? 'page' : undefined}
      {...rest}
    >
      {children}
    </a>
  )
}

/** Matches '/accounts/:id' style patterns. Returns params object or null. */
export function matchPath(pattern, path) {
  const a = pattern.split('/').filter(Boolean)
  const b = path.split('/').filter(Boolean)
  if (a.length !== b.length) return null
  const params = {}
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i])
    else if (a[i] !== b[i]) return null
  }
  return params
}
