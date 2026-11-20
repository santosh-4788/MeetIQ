import type { MediaChoices } from './PreJoin'

// 19 Nov 2026: refreshing the page during a meeting (Chrome, Safari or the Android app) used to drop the person back to the
// "Join now" screen. Now a refresh rejoins straight away, with the same camera/microphone choices.
//
// While someone is in a meeting (or its waiting room), a marker for this page is kept in sessionStorage. sessionStorage
// belongs to this tab only: it survives a reload but not a new tab. The marker is refreshed when the page unloads, and
// the reloaded page uses it only if it is less than two minutes old. Leaving on purpose, being removed, the meeting ending
// or being turned away clears it, so those still show their normal screens. It holds the device choices and, for a guest,
// the name they typed. No tokens and nothing secret are stored.

type Marker = { path: string; at: number; media: MediaChoices; name?: string }

const KEY = 'oic.rejoin'
const MAX_AGE_MS = 2 * 60_000

function read(): Marker | null {
  try {
    const m = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as Marker | null
    return m && typeof m.path === 'string' && typeof m.at === 'number' && m.media ? m : null
  } catch {
    return null
  }
}

function write(m: Marker) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* storage blocked (private mode): a refresh shows "Join now" as before */
  }
}

function remove() {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

// Read once when the app starts (the reloaded page), then removed from storage, so a failed rejoin never loops.
let pending: Marker | null = typeof window === 'undefined' ? null : read()
if (pending) remove()

// The page is going away: leaving the room on unload must not clear the marker (that is the refresh we want to survive).
// Registered when the app starts, so it runs before the room's own pagehide handler disconnects.
let unloading = false
let current: Marker | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    unloading = true
    const m = current
    if (m) write({ ...m, at: Date.now() })
  })
  window.addEventListener('pageshow', () => {
    unloading = false
  })
}

/** The rejoin details for this page if it was just reloaded during a meeting, else null. Does not consume them. */
export function pendingRejoin(): { media: MediaChoices; name?: string } | null {
  const m = pending
  if (!m || m.path !== window.location.pathname || Date.now() - m.at > MAX_AGE_MS) return null
  return { media: m.media, name: m.name }
}

/** The automatic rejoin was used (or failed): later visits to the page start normally. */
export function dropRejoin() {
  pending = null
}

/** In the meeting or its waiting room: a refresh of this page rejoins. */
export function markInMeeting(media: MediaChoices, name?: string) {
  current = { path: window.location.pathname, at: Date.now(), media, ...(name ? { name } : {}) }
  write(current)
}

/** Left on purpose, removed, ended or turned away: a refresh shows the normal screen. Ignored while the page unloads. */
export function clearRejoin() {
  if (unloading) return
  current = null
  remove()
}
