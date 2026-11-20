import { useEffect } from 'react'

/**
 * Host alerts for the meeting's scheduled end (GoodDay #14230 / 16 Nov 2026: hosts "did not get" the extend prompt).
 * The Extend popup lives inside the meeting page, so a host who is presenting another window, on another tab or app, or has
 * minimised the browser never sees it. These helpers reach them anyway - all optional, all fail silently:
 *  - a system notification (only if the host allowed notifications for this site),
 *  - a short chime,
 *  - a flashing tab title while the page is hidden.
 * Nothing here is sent to a server or a third party.
 */

let audio: AudioContext | null = null

/**
 * Call from the host's own click on "Start meeting" / "Join now": browsers only allow the notification question and audio
 * playback after a user gesture. Asks once (never again after Allow or Block).
 */
export function prepareHostAlerts() {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => undefined)
  } catch {
    /* not supported (e.g. iPhone Safari outside an installed app) */
  }
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AC && !audio) audio = new AC()
    void audio?.resume().catch(() => undefined)
  } catch {
    /* no Web Audio */
  }
}

/** Two soft tones (about half a second). */
export function chime() {
  try {
    const ctx = audio
    if (!ctx) return
    void ctx.resume().catch(() => undefined)
    const t0 = ctx.currentTime + 0.02
    ;[880, 660].forEach((freq, i) => {
      const start = t0 + i * 0.25
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.25)
    })
  } catch {
    /* ignore */
  }
}

/** A system notification, if allowed. Clicking it brings the meeting tab back. */
export function systemNotify(title: string, body: string) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const options: NotificationOptions = { body, tag: 'oic-meeting-end', requireInteraction: true, icon: `${import.meta.env.BASE_URL}favicon.svg` }
    try {
      const n = new Notification(title, options)
      n.onclick = () => {
        window.focus()
        n.close()
      }
    } catch {
      // Android Chrome only shows notifications through a service worker; use one if the site has it, otherwise skip.
      void navigator.serviceWorker?.getRegistration().then((r) => r?.showNotification(title, options)).catch(() => undefined)
    }
  } catch {
    /* ignore */
  }
}

/** While `message` is set and the page is hidden, the tab title alternates with it; the normal title comes back at once. */
export function useAttentionTitle(message: string | null) {
  useEffect(() => {
    if (!message) return
    const original = document.title
    let timer: number | undefined
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      document.title = original
    }
    const start = () => {
      if (timer !== undefined) return
      let flip = false
      timer = window.setInterval(() => {
        flip = !flip
        document.title = flip ? message : original
      }, 1000)
    }
    const onVisibility = () => (document.hidden ? start() : stop())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [message])
}
