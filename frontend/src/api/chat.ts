import { API_BASE } from '../config'
import { http } from './http'
import { ApiError } from './types'

// Chat (V028, documentation/CHAT_MODULE_PHASE1.md). Ids are the server's public ids; `seq` orders messages within a conversation.

export type PresenceState = 'OFFLINE' | 'AVAILABLE' | 'BUSY' | 'DND' | 'AWAY' | 'IN_MEETING' | 'IN_CALL'
export type Presence = { state: PresenceState; lastSeenUtc: string | null }
export type Availability = 'AVAILABLE' | 'BUSY' | 'DND' | 'AWAY'

export type ChatPerson = { id: string; name: string; code: string | null; department: string | null; designation: string | null; presence: Presence | null }

export type ChatPreferences = {
  availability: Availability
  showLastSeen: boolean
  soundsOn: boolean
  // Phase 5 quiet hours (present when the server has V031; edited only while CHAT_ADVANCED is on).
  quietEnabled?: boolean
  quietStart?: string
  quietEnd?: string
  /** Bit 0 = Monday … bit 6 = Sunday. */
  quietDays?: number
  quietCallPolicy?: 'RING' | 'SILENT'
  quietAllowMentions?: boolean
  quietAllowUrgent?: boolean
  timeZone?: string
  quietNow?: boolean
}

export type ChatStatus =
  | { enabled: false; reason: 'DISABLED' | 'NO_EMPLOYEE' }
  | {
      enabled: true
      me: { id: string; name: string }
      unread: { conversations: number; messages: number }
      preferences: ChatPreferences
      limits: { bodyMax: number; maxUploadMb: number; editMinutes: number; deleteMinutes: number; maxGroupMembers: number }
      /** Phase 4: notes, tasks, reminders and My Day (switch CHAT_TASKS). */
      tasks?: boolean
      /** Phase 5: scheduled, saved and pinned messages, mentions, quiet hours, favourites (switch CHAT_ADVANCED). */
      advanced?: boolean
    }

export type LastMessage = {
  id: string
  seq: number
  kind: MessageKind
  preview: string | null
  fileName: string | null
  deleted: boolean
  createdUtc: string
  senderId: string | null
  senderName: string | null
}

export type Conversation = {
  id: string
  type: 'DIRECT' | 'GROUP'
  name: string
  description: string | null
  imageId: string | null
  createdUtc: string
  role: 'ADMIN' | 'MEMBER'
  pinned: boolean
  muted: boolean
  mutedUntilUtc: string | null
  archived: boolean
  markedUnread: boolean
  unread: number
  readSeq: number
  memberCount: number
  other: ChatPerson | null
  otherActive: boolean
  lastMessage: LastMessage | null
  /** Phase 5: unread messages that mention me. */
  mentionsUnread?: number
}

export type ChatMember = ChatPerson & { role: 'ADMIN' | 'MEMBER'; readSeq: number; deliveredSeq: number; visibleFromSeq: number; joinedUtc: string; me: boolean }

export type MessageKind = 'TEXT' | 'FILE' | 'SYSTEM'
export type FileStatus = 'PENDING' | 'CLEAN' | 'BLOCKED' | 'ERROR' | 'REMOVED'
export type ChatFile = { id: string; name: string; size: number; extension: string; category: string; status: FileStatus; inline: boolean }
export type Reaction = { emoji: string; userIds: string[]; names: string[] }
export type ReplyRef = { id: string; seq: number; kind: MessageKind; preview: string | null; deleted: boolean; senderName: string | null; fileName: string | null }

export type ChatMessage = {
  id: string
  seq: number
  conversationId: string
  clientMessageId: string | null
  kind: MessageKind
  body: string | null
  createdUtc: string
  editedUtc: string | null
  deleted: boolean
  forwarded: boolean
  senderId: string | null
  senderName: string | null
  replyTo: ReplyRef | null
  file: ChatFile | null
  reactions: Reaction[]
  // Phase 5
  saved?: boolean
  pinned?: boolean
  mentions?: { id: string; name: string }[]
  mentionAll?: boolean
  mentionsMe?: boolean
}

export type ScheduledMessage = {
  id: string
  conversationId: string
  conversationTitle: string
  body: string
  replyToId: string | null
  sendAtUtc: string
  state: 'PENDING' | 'SENDING' | 'SENT' | 'CANCELLED' | 'FAILED'
  sentMessageId: string | null
  sentSeq: number | null
  failureReason: string | null
  createdUtc: string
  updatedUtc: string
}
export type SavedItem = { savedUtc: string; conversationId: string; conversationTitle: string; isGroup: boolean; message: ChatMessage }
export type PinItem = { pinnedUtc: string; pinnedBy: { id: string; name: string }; message: ChatMessage }
export type Favourite = ChatPerson & { sortOrder: number }

export type MessagePage = { items: ChatMessage[]; hasOlder: boolean; hasNewer: boolean }

const q = (params: Record<string, string | number | boolean | null | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const t = s.toString()
  return t ? `?${t}` : ''
}

export const chatApi = {
  status: () => http<ChatStatus>('/chat/status'),
  people: (search: string) => http<ChatPerson[]>(`/chat/people${q({ search })}`),
  presence: (ids: string[]) => http<{ userId: string; presence: Presence }[]>(`/chat/presence${q({ ids: ids.join(',') })}`),
  preferences: (p: Partial<ChatPreferences>) => http<ChatPreferences>('/chat/me/preferences', { method: 'PUT', body: p }),

  conversations: () => http<Conversation[]>('/chat/conversations'),
  conversation: (id: string) => http<{ conversation: Conversation; members: ChatMember[] }>(`/chat/conversations/${id}`),
  direct: (userId: string) => http<Conversation>('/chat/direct', { method: 'POST', body: { userId } }),
  createGroup: (name: string, description: string, memberIds: string[]) => http<Conversation>('/chat/groups', { method: 'POST', body: { name, description, memberIds } }),
  updateGroup: (id: string, name: string, description: string) => http<Conversation>(`/chat/conversations/${id}`, { method: 'PUT', body: { name, description } }),
  pin: (id: string, on: boolean) => http<Conversation>(`/chat/conversations/${id}/pin`, { method: 'POST', body: { on } }),
  archive: (id: string, on: boolean) => http<Conversation>(`/chat/conversations/${id}/archive`, { method: 'POST', body: { on } }),
  mute: (id: string, body: { minutes?: number; forever?: boolean }) => http<Conversation>(`/chat/conversations/${id}/mute`, { method: 'POST', body }),
  read: (id: string, seq: number) => http<void>(`/chat/conversations/${id}/read`, { method: 'POST', body: { seq } }),
  markUnread: (id: string) => http<Conversation>(`/chat/conversations/${id}/mark-unread`, { method: 'POST', body: {} }),
  deliveredAll: () => http<void>('/chat/delivered', { method: 'POST', body: {} }),

  addMembers: (id: string, userIds: string[]) => http<void>(`/chat/conversations/${id}/members`, { method: 'POST', body: { userIds } }),
  removeMember: (id: string, userId: string) => http<void>(`/chat/conversations/${id}/members/${userId}`, { method: 'DELETE' }),
  setRole: (id: string, userId: string, role: 'ADMIN' | 'MEMBER') => http<void>(`/chat/conversations/${id}/members/${userId}/role`, { method: 'PUT', body: { role } }),
  removeImage: (id: string) => http<void>(`/chat/conversations/${id}/image`, { method: 'DELETE' }),

  messages: (id: string, p: { before?: number; after?: number; around?: number; limit?: number } = {}) => http<MessagePage>(`/chat/conversations/${id}/messages${q(p)}`),
  send: (id: string, body: string, clientMessageId: string, replyToId?: string | null, mentions?: { ids: string[]; all: boolean }) =>
    http<ChatMessage>(`/chat/conversations/${id}/messages`, {
      method: 'POST',
      body: { body, clientMessageId, replyToId: replyToId ?? null, ...(mentions && (mentions.ids.length || mentions.all) ? { mentionIds: mentions.ids, mentionAll: mentions.all } : {}) },
    }),
  edit: (messageId: string, body: string) => http<ChatMessage>(`/chat/messages/${messageId}`, { method: 'PUT', body: { body } }),
  remove: (messageId: string) => http<void>(`/chat/messages/${messageId}`, { method: 'DELETE' }),
  react: (messageId: string, emoji: string) => http<ChatMessage>(`/chat/messages/${messageId}/reactions`, { method: 'POST', body: { emoji } }),
  forward: (messageId: string, conversationIds: string[]) => http<ChatMessage[]>(`/chat/messages/${messageId}/forward`, { method: 'POST', body: { conversationIds } }),
  search: (p: { q?: string; conversationId?: string; senderId?: string; fromUtc?: string; toUtc?: string; files?: boolean; beforeSeq?: number }) =>
    http<{ items: ChatMessage[]; hasMore: boolean }>(`/chat/search${q(p)}`),
}

// Phase 5 (CHAT_ADVANCED)
export const advApi = {
  scheduled: (p: { conversationId?: string; state?: 'all' } = {}) => http<{ items: ScheduledMessage[] }>(`/chat/scheduled${q(p)}`),
  schedule: (conversationId: string, body: string, sendAtUtc: string, replyToId?: string | null) =>
    http<ScheduledMessage>(`/chat/conversations/${conversationId}/scheduled`, { method: 'POST', body: { body, sendAtUtc, replyToId: replyToId ?? null } }),
  updateScheduled: (id: string, b: { body?: string; sendAtUtc?: string }) => http<ScheduledMessage>(`/chat/scheduled/${id}`, { method: 'PATCH', body: b }),
  cancelScheduled: (id: string) => http<ScheduledMessage>(`/chat/scheduled/${id}`, { method: 'DELETE' }),
  save: (messageId: string, on: boolean) => http<ChatMessage>(`/chat/messages/${messageId}/save`, { method: on ? 'POST' : 'DELETE', ...(on ? { body: {} } : {}) }),
  saved: (p: { search?: string; before?: string } = {}) => http<{ items: SavedItem[]; hasMore: boolean; next?: string | null }>(`/chat/saved${q(p)}`),
  pinMessage: (messageId: string, on: boolean) => http<ChatMessage>(`/chat/messages/${messageId}/pin`, { method: on ? 'POST' : 'DELETE', ...(on ? { body: {} } : {}) }),
  pins: (conversationId: string) => http<PinItem[]>(`/chat/conversations/${conversationId}/pins`),
  mentions: () => http<{ items: (ChatMessage & { conversationTitle: string })[]; hasMore: boolean }>('/chat/mentions'),
  favourites: () => http<Favourite[]>('/chat/favourites'),
  addFavourite: (userId: string) => http<void>(`/chat/favourites/${userId}`, { method: 'PUT', body: {} }),
  removeFavourite: (userId: string) => http<void>(`/chat/favourites/${userId}`, { method: 'DELETE' }),
  orderFavourites: (ids: string[]) => http<void>('/chat/favourites/order', { method: 'POST', body: { ids } }),
}

export const fileUrl = (id: string, inline = false) => `${API_BASE}/chat/files/${id}${inline ? '?inline=1' : ''}`

function readCookie(name: string) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1]
}

/** Multipart upload with progress (fetch has no upload progress). Resolves with the saved message. */
export function uploadFile(
  path: string,
  file: File,
  fields: Record<string, string>,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ChatMessage | undefined> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}${path}`)
    xhr.withCredentials = true
    const xsrf = readCookie('XSRF-TOKEN')
    if (xsrf) xhr.setRequestHeader('X-XSRF-TOKEN', decodeURIComponent(xsrf))
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Unable to reach the OneInsure Connect server. Check your connection and try again.'))
    xhr.onabort = () => reject(new ApiError(0, 'NETWORK', 'Upload cancelled.'))
    xhr.onload = () => {
      let data: { detail?: string; title?: string; code?: string; errors?: Record<string, string> } | ChatMessage | null = null
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve((data as ChatMessage) ?? undefined)
      const p = (data ?? {}) as { detail?: string; title?: string; code?: string; errors?: Record<string, string> }
      const fieldError = p.errors ? Object.values(p.errors)[0] : undefined
      reject(new ApiError(xhr.status, (p.code as never) ?? 'SERVER', fieldError ?? p.detail ?? p.title ?? 'The file could not be sent.', (data as never) ?? {}))
    }
    signal?.addEventListener('abort', () => xhr.abort())
    const form = new FormData()
    form.append('file', file)
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    xhr.send(form)
  })
}

export const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
