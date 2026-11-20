import { useEffect, useMemo, useState } from 'react'
import { useParticipants } from '@livekit/components-react'
import type { Participant } from 'livekit-client'

/**
 * The OneInsure Connect Android app (mobile/android, 19 Nov 2026). The app shows this website in a WebView and adds what a
 * phone browser cannot do: presenting the phone screen (a second, screen-only connection "<identity>.screen" - see
 * ScreenCompanion on the server) and keeping the call alive in the background.
 *
 * `window.OicAndroid` exists only inside the app, only on https://www.oneinsure.com pages (Android WebMessageListener,
 * origin-locked by the WebView itself). Messages are JSON strings; see MainActivity.kt for the protocol.
 */

import { bridge, inAndroidApp } from './androidBridge'

export { inAndroidApp }

export type AppPresentState = 'IDLE' | 'STARTING' | 'PRESENTING'
export type AppPresentEvent = { state: AppPresentState; detail?: string }


const listeners = new Set<(e: AppPresentEvent) => void>()
let wired = false
function wire() {
  const b = bridge()
  if (!b || wired) return
  wired = true
  const on = (e: { data: string }) => {
    try {
      const m = JSON.parse(e.data) as { type?: string; state?: AppPresentState; detail?: string }
      if (m.type === 'present' && m.state) listeners.forEach((l) => l({ state: m.state!, detail: m.detail }))
    } catch {
      /* not ours */
    }
  }
  if (b.addEventListener) b.addEventListener('message', on)
  else b.onmessage = on
}

function send(msg: Record<string, unknown>) {
  bridge()?.postMessage(JSON.stringify(msg))
}

export const androidApp = {
  present: (url: string, token: string, name: string) => {
    wire()
    send({ type: 'present', url, token, name })
  },
  stopPresent: () => send({ type: 'stopPresent' }),
  setInMeeting: (on: boolean) => send({ type: 'inMeeting', on }),
  onPresent: (fn: (e: AppPresentEvent) => void) => {
    wire()
    listeners.add(fn)
    return () => void listeners.delete(fn)
  },
}

/** Tells the app while the meeting page is open (keeps the microphone alive in the background, screen on). */
export function useAndroidInMeeting() {
  useEffect(() => {
    if (!inAndroidApp()) return
    androidApp.setInMeeting(true)
    return () => androidApp.setInMeeting(false)
  }, [])
}

/** The app's phone-screen state as reported by the app. */
export function useAppPresentState() {
  const [ev, setEv] = useState<AppPresentEvent>({ state: 'IDLE' })
  useEffect(() => androidApp.onPresent(setEv), [])
  return ev
}

// ---- Screen-only connections (any participant may see one) ----------------------------------------------------------

export const SCREEN_SUFFIX = '.screen'

function meta(p: Participant): { role?: string; owner?: string } {
  try {
    return JSON.parse(p.metadata || '{}') as { role?: string; owner?: string }
  } catch {
    return {}
  }
}

/** A phone screen published from the Android app: shown as "<name> is presenting", never as an extra person. */
export function isScreenCompanion(p: Participant) {
  return p.identity.endsWith(SCREEN_SUFFIX) || meta(p).role === 'SCREEN'
}

/** Whose phone screen it is. */
export function companionOwner(p: Participant) {
  return meta(p).owner ?? p.identity.slice(0, -SCREEN_SUFFIX.length)
}

/** The people in the meeting (phone-screen connections are not people: no tile, not counted, not in lists). */
export function usePeople() {
  const all = useParticipants()
  return useMemo(() => all.filter((p) => !isScreenCompanion(p)), [all])
}
