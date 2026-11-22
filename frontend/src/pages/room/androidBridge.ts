// The Android app's page bridge (window.OicAndroid), without any meeting-room code: safe to import from any page.
// (20 Nov 2026: split out of androidApp.ts so the public download page no longer pulls the video library into the main bundle.)

export type Bridge = {
  postMessage: (data: string) => void
  addEventListener?: (type: 'message', fn: (e: { data: string }) => void) => void
  onmessage?: ((e: { data: string }) => void) | null
}

export const bridge = (): Bridge | null => {
  if (typeof window === 'undefined') return null
  const b = (window as unknown as { OicAndroid?: Bridge }).OicAndroid
  return b && typeof b.postMessage === 'function' ? b : null
}

/** True inside the OneInsure Connect Android app. */
export const inAndroidApp = () => bridge() !== null

/**
 * Phone notification through the app (Android app 1.2.0+; older apps ignore the message). link: an app path such as
 * "/tasks?task=…", turned into the full portal address here. Returns false outside the app.
 */
export function appNotify(title: string, body: string, link: string, tag: string) {
  const b = bridge()
  if (!b) return false
  const base = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`
  try {
    b.postMessage(JSON.stringify({ type: 'notify', title, body, link: base + (link.startsWith('/') ? link : '/' + link), tag }))
    return true
  } catch {
    return false
  }
}

/** Asks the app for the notification permission; resolves with the answer (false on older apps after 4 s). */
export function appNotifyPermission(): Promise<boolean> {
  const b = bridge()
  if (!b) return Promise.resolve(false)
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      window.clearTimeout(t)
      resolve(v)
    }
    const t = window.setTimeout(() => resolve(false), 4000)
    const prev = b.onmessage
    b.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data)
        if (m.type === 'notifyPermission') {
          b.onmessage = prev ?? null
          return done(!!m.granted)
        }
      } catch {
        /* not JSON */
      }
      prev?.(e)
    }
    b.postMessage(JSON.stringify({ type: 'notifyPermission' }))
  })
}

/**
 * Loudspeaker switch in the Android app (1.2.2+). on: true = loudspeaker, false = earpiece, undefined = only ask.
 * Resolves with the phone's actual state afterwards, or null outside the app / on older apps (after 1.5 s).
 */
export function appSpeaker(on?: boolean): Promise<boolean | null> {
  const b = bridge()
  if (!b) return Promise.resolve(null)
  return new Promise((resolve) => {
    const prev = b.onmessage
    const finish = (v: boolean | null) => {
      window.clearTimeout(t)
      if (b.onmessage === handler) b.onmessage = prev ?? null
      resolve(v)
    }
    const t = window.setTimeout(() => finish(null), 1500)
    const handler = (e: { data: string }) => {
      try {
        const m = JSON.parse(e.data)
        if (m.type === 'speaker') return finish(m.supported ? !!m.on : null)
      } catch {
        /* not JSON */
      }
      prev?.(e)
    }
    b.onmessage = handler
    b.postMessage(JSON.stringify(on === undefined ? { type: 'speaker' } : { type: 'speaker', on }))
  })
}
