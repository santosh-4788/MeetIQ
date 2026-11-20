import type { ChatPreferences } from '../../api/chat'
import { DEFAULT_TIME_ZONE } from '../../config'

// Quiet hours (Phase 5). The server stores the setting; the browser decides sounds and popups with it.
// Never affected: bell entries (always written), meeting reminders, and the call / reminder popups themselves.

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** True while the person's quiet hours are on (in their profile time zone). Overnight windows (22:00–07:00) belong to the day they start. */
export function isQuietNow(p: ChatPreferences | null | undefined, now = new Date()): boolean {
  if (!p?.quietEnabled || !p.quietStart || !p.quietEnd) return false
  const start = toMin(p.quietStart)
  const end = toMin(p.quietEnd)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: p.timeZone || DEFAULT_TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  }
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? ''
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'))
  const mins = Number(get('hour')) * 60 + Number(get('minute'))
  const days = p.quietDays ?? 127
  const on = (d: number) => ((days >> ((d + 7) % 7)) & 1) === 1
  if (start === end) return on(day) // same start and end = the whole of each ticked day (as the server)
  if (start < end) return mins >= start && mins < end && on(day)
  if (mins >= start) return on(day)
  if (mins < end) return on(day - 1)
  return false
}

export type QuietKind = 'message' | 'mention' | 'call' | 'reminder' | 'urgent-reminder'

/** Should this alert be silent right now? (The popup still shows; only sound and browser notifications are held back.) */
export function silenced(p: ChatPreferences | null | undefined, kind: QuietKind, now = new Date()): boolean {
  if (!isQuietNow(p, now)) return false
  switch (kind) {
    case 'mention':
      return p?.quietAllowMentions === false
    case 'call':
      return (p?.quietCallPolicy ?? 'SILENT') === 'SILENT'
    case 'urgent-reminder':
      return p?.quietAllowUrgent === false
    default:
      return true
  }
}
