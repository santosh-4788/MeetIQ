import type { Priority } from '../../../api/work'

/**
 * Quick add in plain words (runs in the browser, nothing is sent anywhere until the task is saved):
 *   "Call Ramesh tomorrow 4pm urgent"   → title "Call Ramesh", due tomorrow 16:00, priority URGENT
 *   "Send quote fri !high"              → due next Friday (end of day), priority HIGH
 *   "Renewal list 25 nov 11:30"          → due 25 November 11:30
 *   "Pay bill in 3 days"                 → due in 3 days
 * Recognised: today, tonight, tomorrow/tmrw, day names (mon … sunday), "next week", "in N days/hours", "25 nov", "nov 25",
 * "25/11", times like 4pm, 4:30 pm, 16:30, "at 5"; priorities !, !!, !!!, urgent, high, low, important.
 */
export type QuickTask = { title: string; dueUtc: string | null; hasDueTime: boolean; priority: Priority | null; tokens: string[] }

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function parseQuickTask(input: string, now = new Date()): QuickTask {
  let text = ` ${input.replace(/\s+/g, ' ').trim()} `
  const tokens: string[] = []
  let day: Date | null = null
  let hour: number | null = null
  let minute = 0
  let priority: Priority | null = null
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean | void) => {
    const m = text.match(re)
    if (!m) return false
    if (fn(m) === false) return false
    tokens.push(m[0].trim())
    text = text.replace(m[0], ' ')
    return true
  }
  const base = () => new Date(now.getFullYear(), now.getMonth(), now.getDate())

  // Priority
  take(/\s(!!!|urgent|asap)(?=\s)/i, () => void (priority = 'URGENT')) ||
    take(/\s(!!|high|important)(?=\s)/i, () => void (priority = 'HIGH')) ||
    take(/\s(!|medium)(?=\s)/i, () => void (priority = 'MEDIUM')) ||
    take(/\s(low)(?=\s)/i, () => void (priority = 'LOW'))

  // Time: 4pm, 4:30 pm, 16:30, at 5
  take(/\s(?:at\s)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?=\s)/i, (m) => {
    let h = Number(m[1]) % 12
    if (m[3].toLowerCase() === 'pm') h += 12
    hour = h
    minute = m[2] ? Number(m[2]) : 0
  }) ||
    take(/\s(?:at\s)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m) => {
      hour = Number(m[1])
      minute = Number(m[2])
    }) ||
    take(/\sat\s(\d{1,2})(?=\s)/i, (m) => {
      const h = Number(m[1])
      if (h > 23) return false
      hour = h < 8 ? h + 12 : h   // "at 5" during office hours means 17:00
    })
  if (take(/\s(tonight)(?=\s)/i, () => void (day = base())) && hour === null) hour = 20

  // Day
  take(/\s(today)(?=\s)/i, () => void (day = base())) ||
    take(/\s(tomorrow|tmrw|tmr)(?=\s)/i, () => void (day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) ||
    take(/\s(next week)(?=\s)/i, () => {
      const b = base()
      day = new Date(b.getFullYear(), b.getMonth(), b.getDate() + ((8 - b.getDay()) % 7 || 7))   // next Monday
    }) ||
    take(/\sin\s(\d{1,3})\s(days?|hours?|hrs?|weeks?)(?=\s)/i, (m) => {
      const n = Number(m[1])
      const unit = m[2].toLowerCase()
      if (unit.startsWith('h')) {
        const t = new Date(now.getTime() + n * 3_600_000)
        day = new Date(t.getFullYear(), t.getMonth(), t.getDate())
        hour = t.getHours()
        minute = t.getMinutes()
      } else day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n * (unit.startsWith('w') ? 7 : 1))
    }) ||
    take(/\s(\d{1,2})\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?=\s)/i, (m) => {
      day = nextDate(now, MONTHS.indexOf(m[2].toLowerCase()), Number(m[1]))
      if (!day) return false
    }) ||
    take(/\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s(\d{1,2})(?=\s)/i, (m) => {
      day = nextDate(now, MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]))
      if (!day) return false
    }) ||
    take(/\s(\d{1,2})\/(\d{1,2})(?=\s)/, (m) => {
      day = nextDate(now, Number(m[2]) - 1, Number(m[1]))   // dd/mm (India)
      if (!day) return false
    }) ||
    take(/\s(?:on\s)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|urday|sday)?(?=\s)/i, (m) => {
      const want = DAYS.findIndex((d) => d.startsWith(m[1].toLowerCase().slice(0, 3)))
      const b = base()
      const diff = (want - b.getDay() + 7) % 7 || 7
      day = new Date(b.getFullYear(), b.getMonth(), b.getDate() + diff)
    })

  if (hour !== null && !day) {
    day = base()
    if (hour < now.getHours() || (hour === now.getHours() && minute <= now.getMinutes())) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  let dueUtc: string | null = null
  if (day) {
    const d = day as Date
    dueUtc = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour ?? 23, hour === null ? 59 : minute, 0).toISOString()
  }
  const title = text.replace(/\s+/g, ' ').replace(/\s(on|at|by)$/i, '').trim()
  return { title: title || input.trim(), dueUtc, hasDueTime: hour !== null, priority, tokens }
}

function nextDate(now: Date, month: number, date: number): Date | null {
  if (month < 0 || month > 11 || date < 1 || date > 31) return null
  let d = new Date(now.getFullYear(), month, date)
  if (d.getMonth() !== month) return null
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(now.getFullYear() + 1, month, date)
  return d
}
