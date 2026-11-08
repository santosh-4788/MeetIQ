import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'

/**
 * Loads data for a screen with loading / error state (the API's message) and a reload function.
 * Out-of-order responses are ignored, so fast filter changes never show stale results.
 *
 * `pollMs`, when set, silently re-fetches in the background on that interval (paused while the tab is hidden) without
 * touching `loading` or `error` - used on screens where a server-computed flag like "can join now" would otherwise
 * stay frozen at whatever it was when the page loaded until the visitor manually reloads it.
 */
export function useLoader<T>(load: () => Promise<T>, deps: DependencyList, fallbackError = 'Unable to load the data.', pollMs?: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const run = useCallback(load, deps)

  const reload = useCallback(() => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    run()
      .then((d) => id === seq.current && setData(d))
      .catch((e: unknown) => id === seq.current && setError(e instanceof Error && e.message ? e.message : fallbackError))
      .finally(() => id === seq.current && setLoading(false))
  }, [run, fallbackError])

  useEffect(reload, [reload])

  useEffect(() => {
    if (!pollMs) return
    const t = window.setInterval(() => {
      if (document.hidden) return
      const id = ++seq.current
      run().then((d) => id === seq.current && setData(d)).catch(() => {
        /* a background refresh failing is not worth interrupting the screen for; the next tick tries again */
      })
    }, pollMs)
    return () => window.clearInterval(t)
  }, [run, pollMs])

  return { data, error, loading, reload, setData }
}

/** Debounces a fast-changing value (search boxes). */
export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}
