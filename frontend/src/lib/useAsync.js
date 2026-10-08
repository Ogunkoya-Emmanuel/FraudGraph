import { useEffect, useState, useSyncExternalStore, useCallback } from 'react'
import { auth } from '../api/client'

export function useAuthVersion() {
  return useSyncExternalStore(auth.subscribe, auth.getVersion)
}

/**
 * Runs `fn(signal)` whenever `deps` change (or reload() is called), aborting superseded requests.
 * Keeps the previous data on screen while a refetch is in flight so filters feel instant.
 */
export function useAsync(fn, deps, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled })
  const [tick, setTick] = useState(0)
  const authVersion = useAuthVersion()

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false })
      return undefined
    }
    const controller = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.resolve(fn(controller.signal))
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false })
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return
        setState({ data: null, error, loading: false })
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, authVersion, enabled])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
