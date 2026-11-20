import { useEffect, useState } from 'react'

const QUERY = '(max-width: 767px)'

/**
 * Phones (21 Nov 2026 fix): an open conversation fills the whole screen, like iMessage / WhatsApp. The portal header and
 * the bottom tab bar are covered, and the chat is sized to the part of the screen above the keyboard (visualViewport),
 * so the message box stays visible while typing on iPhone (Safari and Chrome) and Android.
 * Sets --vvh / --vvt / --chat-sab on <html> for .oic-chat-full (chat.css) and stops the page behind from scrolling.
 */
export function useFullScreenChat(open: boolean) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches)
  useEffect(() => {
    const m = window.matchMedia?.(QUERY)
    if (!m) return
    const f = () => setNarrow(m.matches)
    f()
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  const full = open && narrow

  useEffect(() => {
    if (!full) return
    const root = document.documentElement
    const vv = window.visualViewport
    const update = () => {
      const h = vv ? vv.height : window.innerHeight
      const top = vv ? Math.max(0, vv.offsetTop) : 0
      root.style.setProperty('--vvh', `${Math.round(h)}px`)
      root.style.setProperty('--vvt', `${Math.round(top)}px`)
      // Keyboard open: no home-indicator gap under the message box.
      root.style.setProperty('--chat-sab', window.innerHeight - h > 120 ? '0px' : 'env(safe-area-inset-bottom)')
    }
    update()
    root.classList.add('oic-chat-locked')
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      root.classList.remove('oic-chat-locked')
      for (const k of ['--vvh', '--vvt', '--chat-sab']) root.style.removeProperty(k)
    }
  }, [full])

  return full
}
