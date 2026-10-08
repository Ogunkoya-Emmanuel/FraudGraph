import { useEffect, useState } from 'react'
import { useQueryState } from './router'
import { useDebouncedValue } from './useAsync'

export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} | FraudGraph` : 'FraudGraph'
  }, [title])
}

/**
 * A text filter that lives in the URL (so it is shareable and survives reload) but is typed
 * into a local state first and written to the URL after a short pause.
 */
export function useUrlTextInput(key, delay = 350) {
  const [query, setQuery] = useQueryState()
  const urlValue = query[key] ?? ''
  const [value, setValue] = useState(urlValue)
  const debounced = useDebouncedValue(value, delay)

  useEffect(() => {
    setValue(urlValue)
  }, [urlValue])

  useEffect(() => {
    const next = debounced.trim()
    if (next !== urlValue) setQuery({ [key]: next, page: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  return [value, setValue]
}
