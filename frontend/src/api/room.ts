import { API_BASE } from '../config'
import { http } from './http'
import type { DbMeetingCategory, MeetingKind, MeetingState, ParticipantRole, ParticipantType } from './meetings'
import type { MeetingCategory } from './types'

// Phase 4 — the live meeting room: /api/v1/meetings/{id}/join|chat|room/*, /api/v1/join/{token}/enter|entry|chat.
// Nothing here imports livekit-client, so this module stays in the main bundle while the room itself is lazy-loaded.

/** Everything the browser needs to connect to the LiveKit room. The token is short-lived (connect within ~10 minutes). */
export type RoomConnection = {
  url: string
  token: string
  identity: string
  name: string
  role: ParticipantRole
  participantType: ParticipantType
  isHost: boolean
  canPublish: boolean
  canScreenShare: boolean
  /** False in audio-only meetings: the video server refuses a camera track. */
  canPublishVideo?: boolean
  expiresUtc: string
}

export type RoomMeetingInfo = {
  id: string
  title: string
  meetingCode: string
  category: DbMeetingCategory
  categoryGroup: MeetingCategory
  status: MeetingState
  startUtc: string
  endUtc: string
  timeZoneId: string
  hostName: string
  waitingRoomEnabled: boolean
  kind?: MeetingKind
  audioOnly?: boolean
}

export type JoinResponse = { connection: RoomConnection; meeting: RoomMeetingInfo }

export type ChatItem = { identity: string | null; name: string; body: string; sentUtc: string; isSystem: boolean }

export type WaitingEntry = { id: string; participantId: string; type: ParticipantType; name: string; enteredUtc: string; viaLink?: boolean }

export type MuteSource = 'MICROPHONE' | 'CAMERA' | 'SCREEN_SHARE'

/** Reasons a meeting cannot be joined (409 `reason`, or `join.reason` on the meeting detail). */
export type JoinBlockReason = 'NOT_PARTICIPANT' | 'DRAFT' | 'CANCELLED' | 'ENDED' | 'TOO_EARLY' | 'TOO_LATE' | 'UNAVAILABLE'

export const CHAT_MAX_LENGTH = 2000

const one = (id: string) => `/meetings/${encodeURIComponent(id)}`

export const roomApi = {
  join: (id: string) => http<JoinResponse>(`${one(id)}/join`, { method: 'POST' }),
  chat: (id: string) => http<{ items: ChatItem[] }>(`${one(id)}/chat`).then((r) => r.items),
  postChat: (id: string, body: string) => http<ChatItem>(`${one(id)}/chat`, { method: 'POST', body: { body } }),
  waiting: (id: string) => http<{ waitingRoomEnabled: boolean; items: WaitingEntry[] }>(`${one(id)}/room/waiting`).then((r) => r.items),
  admit: (id: string, entryId: string) => http<void>(`${one(id)}/room/waiting/${encodeURIComponent(entryId)}/admit`, { method: 'POST' }),
  reject: (id: string, entryId: string) => http<void>(`${one(id)}/room/waiting/${encodeURIComponent(entryId)}/reject`, { method: 'POST' }),
  mute: (id: string, identity: string, source: MuteSource) =>
    http<void>(`${one(id)}/room/participants/${encodeURIComponent(identity)}/mute`, { method: 'POST', body: { source } }),
  /** `block`: they cannot come back to this meeting (their personal link stops working). */
  remove: (id: string, identity: string, block = false) =>
    http<void>(`${one(id)}/room/participants/${encodeURIComponent(identity)}/remove`, { method: 'POST', body: { block } }),
  end: (id: string) => http<void>(`${one(id)}/room/end`, { method: 'POST' }),
}

// ---- Customers and guests (anonymous; the invitation token is the credential) ---------------

export type GuestEnterResult =
  | { status: 'WAITING'; entryId: string; pollAfterMs: number; name: string; meeting: RoomMeetingInfo }
  | { status: 'ADMITTED'; connection: RoomConnection; meeting: RoomMeetingInfo }

export type GuestPollResult =
  | { status: 'WAITING'; pollAfterMs: number }
  | { status: 'ADMITTED'; connection: RoomConnection; meeting: RoomMeetingInfo }
  | { status: 'REJECTED' | 'LEFT' | 'ENDED'; message: string }

const tok = (token: string) => `/join/${encodeURIComponent(token)}`

export const guestRoomApi = {
  enter: (token: string, displayName?: string) => http<GuestEnterResult>(`${tok(token)}/enter`, { method: 'POST', body: { displayName } }),
  poll: (token: string, entryId: string) => http<GuestPollResult>(`${tok(token)}/entry/${encodeURIComponent(entryId)}`),
  chat: (token: string) => http<{ items: ChatItem[] }>(`${tok(token)}/chat`).then((r) => r.items),
  postChat: (token: string, body: string, name?: string) =>
    http<ChatItem>(`${tok(token)}/chat${name ? `?name=${encodeURIComponent(name)}` : ''}`, { method: 'POST', body: { body } }),
  /** Leaving the waiting room. `keepalive` lets it finish while the tab is closing. */
  leave: (token: string, entryId: string) => {
    const xsrf = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1]
    return fetch(`${API_BASE}${tok(token)}/entry/${encodeURIComponent(entryId)}/leave`, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}) },
      body: '{}',
    }).catch(() => undefined)
  },
}

/**
 * The API may return the video server address relative to the site (e.g. "/"): the browser then connects to
 * LiveKit through the same host and port it loaded the app from (the dev server/IIS forwards /rtc to LiveKit).
 * This makes the same configuration work on localhost, on the office LAN address and behind a reverse proxy.
 */
export function resolveLiveKitUrl(url: string) {
  if (!url.startsWith('/')) return url
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${url === '/' ? '' : url.replace(/\/$/, '')}`
}
