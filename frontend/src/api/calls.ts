import { http } from './http'

// Chat audio calls (Phase 3, V029). Audio only, on our own LiveKit server; never recorded.

export type CallStatus = 'RINGING' | 'ACTIVE' | 'ENDED' | 'MISSED' | 'DECLINED' | 'FAILED'
export type CallPartState = 'RINGING' | 'ACCEPTED' | 'DECLINED' | 'MISSED' | 'BUSY' | 'LEFT' | 'CANCELLED'

export type CallParticipant = {
  id: string
  name: string
  code: string | null
  state: CallPartState
  invitedUtc: string
  answeredUtc: string | null
  leftUtc: string | null
  connected: boolean
}

export type Call = {
  id: string
  type: 'DIRECT' | 'GROUP'
  status: CallStatus
  conversationId: string | null
  conversationType: 'DIRECT' | 'GROUP'
  title: string | null
  startedBy: { id: string; name: string; code: string | null } | null
  createdUtc: string
  answeredUtc: string | null
  endedUtc: string | null
  endReason: string | null
  serverUtc: string
  participants: CallParticipant[]
}

export type CallConnection = { url: string; token: string; identity: string; expiresUtc: string }
export type CallWithConnection = { call: Call; connection: CallConnection | null }

export const callsApi = {
  current: () => http<{ enabled: boolean; maxParticipants: number; calls?: Call[] }>('/chat/calls/current'),
  history: (p: { beforeId?: string; search?: string } = {}) => {
    const s = new URLSearchParams()
    if (p.beforeId) s.set('beforeId', p.beforeId)
    if (p.search) s.set('search', p.search)
    return http<{ items: Call[]; hasMore: boolean }>(`/chat/calls${s.toString() ? `?${s}` : ''}`)
  },
  start: (conversationId: string) => http<CallWithConnection>('/chat/calls', { method: 'POST', body: { conversationId } }),
  accept: (id: string) => http<CallWithConnection>(`/chat/calls/${id}/accept`, { method: 'POST', body: {} }),
  decline: (id: string) => http<void>(`/chat/calls/${id}/decline`, { method: 'POST', body: {} }),
  leave: (id: string) => http<void>(`/chat/calls/${id}/leave`, { method: 'POST', body: {} }),
  end: (id: string) => http<void>(`/chat/calls/${id}/end`, { method: 'POST', body: {} }),
  invite: (id: string, userIds: string[]) => http<Call>(`/chat/calls/${id}/invite`, { method: 'POST', body: { userIds } }),
  token: (id: string) => http<CallWithConnection>(`/chat/calls/${id}/token`, { method: 'POST', body: {} }),
}

/** The API may give the video server as a site-relative path ("/meet/"): make it a ws(s):// address on this host. */
export function resolveCallUrl(url: string) {
  if (!url.startsWith('/')) return url
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}${url === '/' ? '' : url.replace(/\/$/, '')}`
}
