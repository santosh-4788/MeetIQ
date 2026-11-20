import { useEffect, useState } from 'react'

const QUERY = '(max-width: 639px)'

/** True on phone-width screens: chat and calls switch to iOS phone layouts (action sheets, full-screen call). */
export function usePhone() {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches)
  useEffect(() => {
    const m = window.matchMedia?.(QUERY)
    if (!m) return
    const f = () => setOn(m.matches)
    f()
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  return on
}
