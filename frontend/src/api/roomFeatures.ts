import { http } from './http'

// Optional meeting features (13 Nov 2026): every one is OFF until an administrator switches it on (Administration -> Meeting
// features). With a feature off, the room shows none of its controls - the meeting looks and works exactly as before.

export type RoomFeatures = {
  reactions: boolean
  polls: boolean
  privateChat: boolean
  whiteboard: boolean
  backgroundEffects: boolean
  noiseSuppression: boolean
  cameraFlip: boolean
  /** Minutes of meeting (no AI) on the meeting page - not a room control. */
  meetingMinutes: boolean
}

export const NO_FEATURES: RoomFeatures = {
  reactions: false, polls: false, privateChat: false, whiteboard: false, backgroundEffects: false, noiseSuppression: false, cameraFlip: false,
  meetingMinutes: false,
}

export const roomFeaturesApi = {
  /** Never throws: if the server cannot be asked (older API, network), every optional feature simply stays off. */
  get: () => http<RoomFeatures>('/room-features').then((f) => ({ ...NO_FEATURES, ...f })).catch(() => NO_FEATURES),
}

export type PollAnswer = 'YES' | 'NO'
export type Poll = {
  id: string
  question: string
  createdUtc: string
  closed: boolean
  myAnswer: PollAnswer | null
  /** Hosts: live. Everyone else: only once the host closes the poll. */
  results: { yes: number; no: number; total: number } | null
}
export type PollList = { canCreate: boolean; items: Poll[] }

export type PrivateMessage = {
  id: number
  fromIdentity: string
  fromName: string
  toIdentity: string
  toName: string
  body: string
  sentUtc: string
  read: boolean
}

export type DrawMode = 'HOSTS' | 'EVERYONE' | 'SELECTED'
export type BoardState = { isOpen: boolean; drawMode: DrawMode; allowed: string[] }
export type Board = BoardState & { scene: string | null; version: number; canDraw: boolean; canManage: boolean }

/** The server calls the room's optional features need; employees use their session, guests their personal token. */
export type FeatureCalls = {
  polls: {
    list: () => Promise<PollList>
    vote: (pollId: string, answer: PollAnswer) => Promise<void>
    create?: (question: string) => Promise<{ id: string }>
    close?: (pollId: string) => Promise<void>
  }
  private: {
    list: () => Promise<{ me: string; items: PrivateMessage[] }>
    send: (toIdentity: string, body: string) => Promise<PrivateMessage>
    read: (withIdentity: string) => Promise<void>
  }
  whiteboard: {
    get: () => Promise<Board>
    saveScene: (baseVersion: number, scene: string) => Promise<{ version: number }>
    setState?: (s: Partial<BoardState> & { open?: boolean }) => Promise<void>
  }
}

const one = (id: string) => `/meetings/${encodeURIComponent(id)}/room`
const tok = (token: string) => `/join/${encodeURIComponent(token)}`

export function employeeFeatureCalls(meetingId: string): FeatureCalls {
  const b = one(meetingId)
  return {
    polls: {
      list: () => http<PollList>(`${b}/polls`),
      vote: (pollId, answer) => http<void>(`${b}/polls/${encodeURIComponent(pollId)}/vote`, { method: 'POST', body: { answer } }),
      create: (question) => http<{ id: string }>(`${b}/polls`, { method: 'POST', body: { question } }),
      close: (pollId) => http<void>(`${b}/polls/${encodeURIComponent(pollId)}/close`, { method: 'POST' }),
    },
    private: {
      list: () => http<{ me: string; items: PrivateMessage[] }>(`${b}/private`),
      send: (toIdentity, body) => http<PrivateMessage>(`${b}/private`, { method: 'POST', body: { toIdentity, body } }),
      read: (withIdentity) => http<void>(`${b}/private/read`, { method: 'POST', body: { withIdentity } }),
    },
    whiteboard: {
      get: () => http<Board>(`${b}/whiteboard`),
      saveScene: (baseVersion, scene) => http<{ version: number }>(`${b}/whiteboard/scene`, { method: 'PUT', body: { baseVersion, scene } }),
      setState: (s) => http<void>(`${b}/whiteboard/state`, { method: 'POST', body: s }),
    },
  }
}

export function guestFeatureCalls(token: string): FeatureCalls {
  const b = tok(token)
  return {
    polls: {
      list: () => http<PollList>(`${b}/polls`),
      vote: (pollId, answer) => http<void>(`${b}/polls/${encodeURIComponent(pollId)}/vote`, { method: 'POST', body: { answer } }),
    },
    private: {
      list: () => http<{ me: string; items: PrivateMessage[] }>(`${b}/private`),
      send: (toIdentity, body) => http<PrivateMessage>(`${b}/private`, { method: 'POST', body: { toIdentity, body } }),
      read: (withIdentity) => http<void>(`${b}/private/read`, { method: 'POST', body: { withIdentity } }),
    },
    whiteboard: {
      get: () => http<Board>(`${b}/whiteboard`),
      saveScene: (baseVersion, scene) => http<{ version: number }>(`${b}/whiteboard/scene`, { method: 'PUT', body: { baseVersion, scene } }),
    },
  }
}

export type FeatureSetting = { key: string; enabled: boolean; modifiedUtc: string; modifiedBy: string | null }

export const adminFeaturesApi = {
  list: () => http<{ items: FeatureSetting[] }>('/admin/features').then((r) => r.items),
  set: (key: string, enabled: boolean) => http<void>(`/admin/features/${encodeURIComponent(key)}`, { method: 'PUT', body: { enabled } }),
}
