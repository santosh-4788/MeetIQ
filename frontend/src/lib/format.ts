import { DEFAULT_TIME_ZONE } from '../config'

// Indian formats, as on the dashboard: "31 Oct 2026", "31 Oct 2026, 2:30 pm" (en-IN, Asia/Kolkata unless the user has another zone).

/** API timestamps are UTC; some arrive without an offset (SQL datetime2), so treat those as UTC too. */
export function parseUtc(iso: string) {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
}

export function formatDate(iso: string | null | undefined, tz: string = DEFAULT_TIME_ZONE) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(parseUtc(iso))
}

export function formatDateTime(iso: string | null | undefined, tz: string = DEFAULT_TIME_ZONE) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(parseUtc(iso))
}

/** Calendar dates (e.g. date of joining) carry no time zone: format the yyyy-MM-dd part as-is. */
export function formatCalendarDate(value: string | null | undefined) {
  const ymd = toYmd(value)
  if (!ymd) return '—'
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`))
}

/** "2026-10-31T00:00:00" → "2026-10-31" (the value an <input type="date"> expects). */
export function toYmd(value: string | null | undefined) {
  const m = value?.match(/^\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : ''
}

// ---- Wall-clock helpers for meetings and the calendar ----------------------------
// The browser may run in any zone; meetings are entered and shown in the user's zone (IST by default),
// so wall-clock dates ("yyyy-MM-dd") and times ("HH:mm") are converted with Intl, never with the browser's local zone.

const partsCache = new Map<string, Intl.DateTimeFormat>()
function partsFormat(tz: string) {
  let f = partsCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    partsCache.set(tz, f)
  }
  return f
}

/** The wall-clock date, time and weekday of an instant in `tz`. `dow`: 0 = Sunday. */
export function zonedParts(date: Date, tz: string = DEFAULT_TIME_ZONE) {
  const p = Object.fromEntries(partsFormat(tz).formatToParts(date).map((x) => [x.type, x.value]))
  const ymd = `${p.year}-${p.month}-${p.day}`
  const hour = Number(p.hour) % 24
  return { ymd, hm: `${String(hour).padStart(2, '0')}:${p.minute}`, minutes: hour * 60 + Number(p.minute), dow: weekday(ymd) }
}

function offsetMs(date: Date, tz: string) {
  const p = Object.fromEntries(partsFormat(tz).formatToParts(date).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second))
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** Wall-clock date ("yyyy-MM-dd") and time ("HH:mm") in `tz` → the UTC instant. */
export function zonedToUtc(ymd: string, hm: string, tz: string = DEFAULT_TIME_ZONE) {
  const [y, m, d] = ymd.split('-').map(Number)
  const [h, mi] = hm.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const first = guess - offsetMs(new Date(guess), tz)
  const second = guess - offsetMs(new Date(first), tz)
  return new Date(second)
}

/** "2026-10-31" + n days (calendar arithmetic, no zone involved). */
export function addDays(ymd: string, n: number) {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(ymd: string) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay()
}

/** Formats a calendar date (no zone) with the given Intl options, en-IN. */
export function formatYmd(ymd: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`))
}

/** "2:30 pm" in `tz`. */
export function formatTime(iso: string | Date, tz: string = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(typeof iso === 'string' ? parseUtc(iso) : iso)
}

/** "Sat, 31 Oct 2026" in `tz`. */
export function formatDayDate(iso: string | Date, tz: string = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(typeof iso === 'string' ? parseUtc(iso) : iso)
}

/** "Sat, 31 Oct 2026, 2:30 pm – 3:30 pm" (the end date is repeated only when it differs). */
export function formatRange(startIso: string, endIso: string, tz: string = DEFAULT_TIME_ZONE) {
  const s = parseUtc(startIso)
  const e = parseUtc(endIso)
  const sameDay = zonedParts(s, tz).ymd === zonedParts(e, tz).ymd
  return sameDay ? `${formatDayDate(s, tz)}, ${formatTime(s, tz)} – ${formatTime(e, tz)}` : `${formatDayDate(s, tz)}, ${formatTime(s, tz)} – ${formatDayDate(e, tz)}, ${formatTime(e, tz)}`
}

/** Short zone label: "IST" for Asia/Kolkata, otherwise Intl's short name (e.g. "GMT+4"). */
export function zoneLabel(tz: string = DEFAULT_TIME_ZONE) {
  if (tz === 'Asia/Kolkata') return 'IST'
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz
}

/** "90 min" / "1 h 30 min". */
export function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** "Just now", "5 min ago", "3 h ago", then the date. */
export function formatRelative(iso: string, tz: string = DEFAULT_TIME_ZONE, now = Date.now()) {
  const diff = Math.round((now - parseUtc(iso).getTime()) / 60_000)
  if (diff < 1) return 'Just now'
  if (diff < 60) return `${diff} min ago`
  const h = Math.round(diff / 60)
  if (h < 24) return `${h} h ago`
  return formatDateTime(iso, tz)
}
