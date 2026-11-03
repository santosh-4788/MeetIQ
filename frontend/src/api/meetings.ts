import { http } from './http'
import { ApiError, query, type MeetingCategory, type Paged } from './types'

// Meetings, availability, calendar and the public join page: /api/v1/meetings, /calendar, /account/availability, /join.
// All times are UTC ISO strings in and out; the screens show them in the user's zone (IST by default).

/** Database categories. `categoryGroup` (the dashboard's MeetingCategory) groups them for colours. */
export type DbMeetingCategory =
  | 'INTERNAL_1_1'
  | 'GROUP'
  | 'TEAM'
  | 'DEPARTMENT'
  | 'MANAGEMENT'
  | 'TRAINING'
  | 'REVIEW'
  | 'CUSTOMER_PLVC'
  | 'CUSTOMER_GENERAL'

export type MeetingState = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'INCOMPLETE'
export type RecordingPolicy = 'NONE' | 'OPTIONAL' | 'REQUIRED'
export type ResponseStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'
export type ParticipantRole = 'HOST' | 'COHOST' | 'ATTENDEE'
export type ParticipantType = 'EMPLOYEE' | 'CUSTOMER' | 'GUEST'
export type MeetingKind = 'SCHEDULED' | 'INSTANT'

export type MeetingListItem = {
  id: string
  meetingCode: string
  title: string
  category: DbMeetingCategory
  categoryGroup: MeetingCategory
  status: MeetingState
  startUtc: string
  endUtc: string
  timeZoneId: string
  organiser: string
  hostId: string
  /** First 10 names. */
  participants: string[]
  participantCount: number
  recording: boolean
  recordingPolicy: RecordingPolicy
  customerName: string | null
  myRole: ParticipantRole | null
  myResponse: ResponseStatus | null
  /** INSTANT = started at once from "New meeting"; SCHEDULED = from the calendar. */
  kind: MeetingKind
}

export type Invitation = { status: 'ACTIVE' | 'REVOKED' | 'EXPIRED'; createdUtc: string; expiresUtc: string; useCount: number; lastUsedUtc: string | null }

export type MeetingParticipant = {
  /** Opaque participant id (used to remove the participant). */
  id: string
  type: ParticipantType
  employeeId: string | null
  name: string
  department: string | null
  /** Guests only, and only for people who can edit the meeting. */
  email: string | null
  role: ParticipantRole
  responseStatus: ResponseStatus
  isRequired: boolean
  /** Customers and guests, editors only. */
  invitation: Invitation | null
}

export type MeetingDetail = {
  id: string
  meetingCode: string
  title: string
  description: string | null
  agenda: string | null
  category: DbMeetingCategory
  categoryGroup: MeetingCategory
  status: MeetingState
  startUtc: string
  endUtc: string
  timeZoneId: string
  actualStartUtc: string | null
  actualEndUtc: string | null
  recordingPolicy: RecordingPolicy
  waitingRoomEnabled: boolean
  scheduleVersion: number
  cancelReason: string | null
  overrideConflictReason: string | null
  purpose: string | null
  policyNumber: string | null
  department: string | null
  host: { id: string; name: string }
  createdBy: { id: string; name: string }
  customer: { id: string; name: string; customerRef: string | null } | null
  createdUtc: string
  modifiedUtc: string | null
  participants: MeetingParticipant[]
  kind: MeetingKind
  /** Nobody can publish a camera (enforced by the video server). */
  audioOnly: boolean
  reminders: { pending: number; sent: number; failed: number; cancelled: number; nextDueUtc: string | null }
  my: {
    participantId: string | null
    role: ParticipantRole | null
    responseStatus: ResponseStatus | null
    isHost: boolean
    isOrganiser: boolean
    canEdit: boolean
    canCancel: boolean
    canRespond: boolean
    /** Phase 4: the video room is open for me now. */
    canJoin: boolean
    /** Host or co-host: admits from the waiting room, mutes, removes, ends for everyone. */
    canHostRoom: boolean
    /** Host, co-host or organiser of a scheduled/live meeting: may copy, replace or withdraw the meeting link. */
    canShareLink: boolean
  }
  /** Phase 4: when the video room can be joined. `reason` explains why not (null when joinable). */
  join: {
    joinable: boolean
    reason: 'NOT_PARTICIPANT' | 'DRAFT' | 'CANCELLED' | 'ENDED' | 'TOO_EARLY' | 'TOO_LATE' | 'UNAVAILABLE' | null
    message: string | null
    opensUtc: string
    closesUtc: string
  }
}

export type GuestInput = { name: string; email: string }

export type MeetingCreateInput = {
  title: string
  description?: string | null
  agenda?: string | null
  category: DbMeetingCategory
  startUtc: string
  endUtc: string
  timeZoneId?: string
  hostEmployeeId?: string
  employeeIds: string[]
  customerId?: string | null
  guests?: GuestInput[]
  recordingPolicy: RecordingPolicy
  waitingRoomEnabled?: boolean
  status: 'DRAFT' | 'SCHEDULED'
  purpose?: string | null
  policyNumber?: string | null
  overrideConflicts?: boolean
  overrideReason?: string | null
}

export type MeetingUpdateInput = {
  title: string
  description?: string | null
  agenda?: string | null
  category?: DbMeetingCategory
  startUtc: string
  endUtc: string
  timeZoneId?: string
  recordingPolicy?: RecordingPolicy
  waitingRoomEnabled?: boolean
  /** DRAFT → SCHEDULED only. */
  status?: 'DRAFT' | 'SCHEDULED'
  purpose?: string | null
  policyNumber?: string | null
  overrideConflicts?: boolean
  overrideReason?: string | null
}

export type ConflictType = 'MEETING' | 'LEAVE' | 'BLOCKED' | 'OUTSIDE_WORKING_HOURS'
/** A blocking conflict (MEETING / LEAVE / BLOCKED) or a non-blocking warning (OUTSIDE_WORKING_HOURS). No titles or reasons. */
export type Conflict = { employeeId: string; employeeName: string; type: ConflictType; startUtc: string; endUtc: string }

export type AvailabilityResult = { available: boolean; conflicts: Conflict[]; warnings: Conflict[] }

export type MeetingScope = 'mine' | 'hosting' | 'attending' | 'all'
export type MeetingQuery = {
  scope?: MeetingScope
  status?: MeetingState | ''
  /** A database category, or the family: CUSTOMER / INTERNAL. */
  category?: DbMeetingCategory | 'CUSTOMER' | 'INTERNAL' | ''
  from?: string
  to?: string
  search?: string
  sort?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

/** The `conflicts` of a 409 CONFLICT from a booking call (empty for any other error). */
export function bookingConflicts(e: unknown): Conflict[] {
  if (!(e instanceof ApiError) || e.code !== 'CONFLICT') return []
  const raw = e.details.conflicts
  return Array.isArray(raw) ? (raw as Conflict[]) : []
}

const one = (id: string) => `/meetings/${encodeURIComponent(id)}`

export const meetingsApi = {
  list: (q: MeetingQuery) => http<Paged<MeetingListItem>>(`/meetings${query(q)}`),
  get: (id: string) => http<MeetingDetail>(one(id)),
  create: (body: MeetingCreateInput) =>
    http<{ id: string; meetingCode: string; status: string; warnings: Conflict[]; overriddenConflicts: number }>('/meetings', { method: 'POST', body }),
  update: (id: string, body: MeetingUpdateInput) =>
    http<{ id: string; status: string; rescheduled: boolean; warnings: Conflict[]; overriddenConflicts: number }>(one(id), { method: 'PUT', body }),
  cancel: (id: string, reason: string) => http<void>(`${one(id)}/cancel`, { method: 'POST', body: { reason } }),
  respond: (id: string, response: Exclude<ResponseStatus, 'PENDING'>) => http<void>(`${one(id)}/respond`, { method: 'POST', body: { response } }),
  addParticipants: (id: string, body: { employeeIds: string[]; guests: GuestInput[]; overrideConflicts?: boolean; overrideReason?: string | null }) =>
    http<{ added: number; warnings: Conflict[]; overriddenConflicts: number }>(`${one(id)}/participants`, { method: 'POST', body }),
  removeParticipant: (id: string, participantId: string) =>
    http<void>(`${one(id)}/participants/${encodeURIComponent(participantId)}`, { method: 'DELETE' }),
  /** Start a meeting now (no calendar check, no e-mails). The response carries the shareable link. */
  instant: (body: InstantMeetingInput) => http<{ id: string; meetingCode: string; kind: 'INSTANT'; link: MeetingLink }>('/meetings/instant', { method: 'POST', body }),
  /** "Join meeting" by code: only meetings the signed-in user can already see. */
  byCode: (code: string) => http<{ id: string }>(`/meetings/by-code/${encodeURIComponent(code)}`),
  /** The meeting's shareable link (created on first request). Hosts, co-hosts and the organiser. */
  link: (id: string) => http<MeetingLink>(`${one(id)}/link`),
  regenerateLink: (id: string) => http<MeetingLink>(`${one(id)}/link/regenerate`, { method: 'POST' }),
  revokeLink: (id: string) => http<void>(`${one(id)}/link/revoke`, { method: 'POST' }),
  /** Live form check; `employeeIds` empty = the signed-in user. */
  availability: (body: { employeeIds: string[]; startUtc: string; endUtc: string; excludeMeetingId?: string }) =>
    http<AvailabilityResult>('/meetings/availability', { method: 'POST', body }),
}

// ---- Calendar ----------------------------------------------------------------

export type CalendarMeeting = {
  kind: 'MEETING'
  id: string
  meetingCode: string
  title: string
  category: DbMeetingCategory
  categoryGroup: MeetingCategory
  status: MeetingState
  startUtc: string
  endUtc: string
  timeZoneId: string
  isCustomerMeeting: boolean
  recording: boolean
  employeeId: string
  employeeName: string
  role: ParticipantRole
  responseStatus: ResponseStatus
}

export type CalendarBlock = {
  kind: 'LEAVE' | 'BLOCKED'
  id: string
  title: string
  startUtc: string
  endUtc: string
  /** Own entries only. */
  reason: string | null
  employeeId: string
  employeeName: string
}

export type CalendarItem = CalendarMeeting | CalendarBlock
export type CalendarResult = { fromUtc: string; toUtc: string; self?: boolean; items: CalendarItem[] }

/** The API serves at most this many days per request. */
export const MAX_CALENDAR_DAYS = 62

export const calendarApi = {
  get: (q: { from: string; to: string; employeeId?: string; department?: string; category?: string; includeCancelled?: boolean }) =>
    http<CalendarResult>(`/calendar${query(q)}`),
}

// ---- My availability -----------------------------------------------------------

export type WorkingHours = { id: string; dayOfWeek: number; startLocalTime: string; endLocalTime: string }
export type AvailabilityPeriod = { id: string; type: 'LEAVE' | 'BLOCKED'; startUtc: string; endUtc: string; reason: string | null }
export type MyAvailability = { timeZoneId: string; workingHours: WorkingHours[]; periods: AvailabilityPeriod[] }

export type AvailabilityInput =
  | { type: 'WORKING_HOURS'; dayOfWeek: number; startLocalTime: string; endLocalTime: string }
  | { type: 'LEAVE' | 'BLOCKED'; startUtc: string; endUtc: string; reason?: string | null }

const entry = (id: string) => `/account/availability/${encodeURIComponent(id)}`

export const availabilityApi = {
  get: (from?: string) => http<MyAvailability>(`/account/availability${query({ from })}`),
  create: (body: AvailabilityInput) => http<{ id: string }>('/account/availability', { method: 'POST', body }),
  update: (id: string, body: AvailabilityInput) => http<void>(entry(id), { method: 'PUT', body }),
  remove: (id: string) => http<void>(entry(id), { method: 'DELETE' }),
}

// ---- Public join page (anonymous) ----------------------------------------------

export type JoinInfo = {
  title: string
  organiser: string
  startUtc: string
  endUtc: string
  timeZoneId: string
  status: 'SCHEDULED' | 'LIVE' | 'CANCELLED' | 'ENDED'
  meetingCode: string
  waitingRoom: boolean
  joinableNow: boolean
  joinOpensUtc: string
  /** Phase 4. */
  joinClosesUtc: string
  /** False when the server has no video service configured. */
  videoAvailable: boolean
  participantType: 'CUSTOMER' | 'GUEST' | 'EMPLOYEE'
  /** The invited name (guests may change the name shown in the room). */
  displayName: string | null
}

export const joinApi = {
  get: (token: string) => http<JoinInfo>(`/join/${encodeURIComponent(token)}`),
}

// ---- Instant meetings and shareable links (anonymous link page: /m/:token) ------------

export type InstantMeetingInput = {
  title?: string
  category?: DbMeetingCategory
  durationMinutes?: number
  audioOnly?: boolean
  waitingRoomEnabled?: boolean
  recordingPolicy?: RecordingPolicy
}

export type MeetingLink = { url: string; path: string; createdUtc: string; expiresUtc: string; useCount: number; lastUsedUtc: string | null }

/** What the link page shows. Same shape as the invitation page (JoinInfo), plus who is asking. */
export type LinkInfo = Omit<JoinInfo, 'participantType'> & {
  participantType: 'GUEST' | 'EMPLOYEE'
  locked: boolean
  audioOnly: boolean
  kind: MeetingKind
  /** Set when the signed-in user is already a participant: open the normal meeting room instead. */
  meetingId: string | null
}

export const linkApi = {
  get: (token: string) => http<LinkInfo>(`/m/${encodeURIComponent(token)}`),
  /** Creates the asker's place in the waiting room; returns a personal token for /join/{token}, or the meeting to open directly. */
  request: (token: string, displayName?: string) =>
    http<{ joinToken: string; participantType: 'GUEST' | 'EMPLOYEE'; displayName: string } | { meetingId: string; joinToken?: undefined }>(
      `/m/${encodeURIComponent(token)}/request`,
      { method: 'POST', body: { displayName } },
    ),
}
