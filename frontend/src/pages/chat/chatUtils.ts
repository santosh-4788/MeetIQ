import type { ChatMember, ChatMessage, Presence, PresenceState } from '../../api/chat'
import { DEFAULT_TIME_ZONE } from '../../config'
import { parseUtc } from '../../lib/format'

const tz = DEFAULT_TIME_ZONE

function ymd(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function timeOf(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(parseUtc(iso))
}

/** Conversation list: "4:05 pm" today, "Yesterday", weekday this week, else "12 Nov". */
export function listTime(iso: string, now = new Date()) {
  const d = parseUtc(iso)
  const today = ymd(now)
  if (ymd(d) === today) return timeOf(iso)
  const y = new Date(now.getTime() - 86_400_000)
  if (ymd(d) === ymd(y)) return 'Yesterday'
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: tz }).format(d)
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}), timeZone: tz }).format(d)
}

/** Day separator in a conversation: "Today", "Yesterday", "Monday, 16 November". */
export function dayLabel(iso: string, now = new Date()) {
  const d = parseUtc(iso)
  if (ymd(d) === ymd(now)) return 'Today'
  if (ymd(d) === ymd(new Date(now.getTime() - 86_400_000))) return 'Yesterday'
  return new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}), timeZone: tz }).format(d)
}

export const dayKey = (iso: string) => ymd(parseUtc(iso))

export function fullTime(iso: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(parseUtc(iso))
}

export const presenceLabel: Record<PresenceState, string> = {
  AVAILABLE: 'Available',
  BUSY: 'Busy',
  DND: 'Do not disturb',
  AWAY: 'Away',
  IN_MEETING: 'In a meeting',
  IN_CALL: 'In a call',
  OFFLINE: 'Offline',
}

export const presenceColor: Record<PresenceState, string> = {
  AVAILABLE: 'bg-success',
  BUSY: 'bg-danger',
  DND: 'bg-danger',
  AWAY: 'bg-warning',
  IN_MEETING: 'bg-brand-500',
  IN_CALL: 'bg-brand-500',
  OFFLINE: 'bg-ink-muted/50',
}

/** "Online", "In a meeting", "Last seen today at 4:05 pm", "Offline". */
export function presenceText(p: Presence | null | undefined, now = new Date()) {
  if (!p) return ''
  if (p.state !== 'OFFLINE') return p.state === 'AVAILABLE' ? 'Online' : presenceLabel[p.state]
  if (!p.lastSeenUtc) return 'Offline'
  const d = parseUtc(p.lastSeenUtc)
  if (now.getTime() - d.getTime() < 60_000) return 'Last seen just now'
  if (ymd(d) === ymd(now)) return `Last seen today at ${timeOf(p.lastSeenUtc)}`
  if (ymd(d) === ymd(new Date(now.getTime() - 86_400_000))) return `Last seen yesterday at ${timeOf(p.lastSeenUtc)}`
  return `Last seen ${new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: tz }).format(d)}`
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export type Tick = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/** My message's tick from the other members' read/delivered marks (all of them for groups; members added later are ignored). */
export function tickFor(m: ChatMessage, members: ChatMember[]): Tick {
  const others = members.filter((x) => !x.me && x.visibleFromSeq < m.seq)
  if (others.length === 0) return 'sent'
  if (others.every((x) => x.readSeq >= m.seq)) return 'read'
  if (others.every((x) => x.deliveredSeq >= m.seq || x.readSeq >= m.seq)) return 'delivered'
  return 'sent'
}

export const URL_RE = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi

/** Splits text into plain parts and http(s) links (rendered as text nodes and <a rel=noopener>; never HTML). */
export function linkify(text: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i) })
    out.push({ text: m[0], href: m[0] })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Preview line in the conversation list. */
export function previewOf(kind: string, preview: string | null, fileName: string | null, deleted: boolean) {
  if (deleted) return 'Message deleted'
  if (kind === 'FILE') return `📎 ${preview && preview !== fileName ? preview : fileName ?? 'File'}`
  return preview ?? ''
}

export function isImage(category: string) {
  return category === 'IMAGE'
}
