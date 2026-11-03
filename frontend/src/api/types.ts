// API contracts shared by the real HTTP client and the dev-only demo adapter.
// These shapes are the contract the ASP.NET Core API implements in Phase 2 (see documentation/API_DOCUMENTATION.md).

export type MfaMethod = 'TOTP' | 'EMAIL_OTP' | 'RECOVERY_CODE'

export type UserSummary = {
  id: string
  displayName: string
  email: string
  employeeCode: string
  department: string
  designation: string
  roles: string[]
  permissions: string[]
  photoUrl?: string
  timeZone: string
  /** Set by the server until a forced password change is done; every other screen redirects to /change-password. */
  mustChangePassword?: boolean
  /** False when the account is not linked to an employee record (no meetings, calendar or availability until linked). */
  employeeLinked?: boolean
}

export type LoginRequest = { login: string; password: string; rememberMe: boolean }

export type LoginResult =
  | { status: 'SUCCESS'; user: UserSummary }
  | { status: 'MFA_REQUIRED'; mfaToken: string; methods: MfaMethod[]; maskedEmail?: string }
  | { status: 'PASSWORD_CHANGE_REQUIRED'; user: UserSummary }

export type ApiErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_DISABLED'
  | 'INVALID_MFA_CODE'
  | 'MFA_EXPIRED'
  | 'INVALID_RESET_TOKEN'
  | 'PASSWORD_POLICY'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'SERVER'
  | 'SERVICE_UNAVAILABLE'

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly details: Record<string, unknown>
  constructor(status: number, code: ApiErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Field errors of a VALIDATION problem (`errors: {field: message}`), keyed by the request body's field names. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION') return {}
  const raw = e.details.errors
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((x): x is [string, string] => typeof x[1] === 'string'))
}

/** The API's own message where there is one, otherwise the given fallback. */
export function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback
}

export interface AuthApi {
  me(): Promise<UserSummary | null>
  login(req: LoginRequest): Promise<LoginResult>
  verifyMfa(req: { mfaToken: string; code: string; method: MfaMethod; rememberDevice: boolean }): Promise<UserSummary>
  resendMfa(req: { mfaToken: string; method: MfaMethod }): Promise<void>
  forgotPassword(req: { login: string }): Promise<void>
  resetPassword(req: { token: string; newPassword: string }): Promise<void>
  changePassword(req: { currentPassword: string; newPassword: string }): Promise<void>
  logout(): Promise<void>
}

// ---- Dashboard -------------------------------------------------------------

export type MeetingCategory = 'INTERNAL' | 'CUSTOMER' | 'TRAINING' | 'REVIEW' | 'MANAGEMENT'
export type MeetingStatus = 'SCHEDULED' | 'LIVE' | 'COMPLETED' | 'CANCELLED'

export type MeetingSummary = {
  id: string
  title: string
  category: MeetingCategory
  startUtc: string
  endUtc: string
  organiser: string
  participants: string[]
  status: MeetingStatus
  recording: boolean
  customerName?: string
  /** Phase 4: I am a participant and the video room is open now. */
  joinable?: boolean
  joinOpensUtc?: string
}

export type ActivityItem = {
  id: string
  type: 'MEETING_COMPLETED' | 'RECORDING_READY' | 'RECORDING_FAILED' | 'INVITE_ACCEPTED' | 'MEETING_RESCHEDULED' | 'MEETING_CANCELLED'
  text: string
  actor: string
  atUtc: string
}

export type DashboardSummary = {
  generatedUtc: string
  kpis: {
    totalEmployees: number
    todaysMeetings: number
    upcomingMeetings: number
    internalMeetings: number
    customerMeetings: number
    completedMeetings: number
    totalRecordings: number
    pendingRecordings: number
  }
  todaySchedule: MeetingSummary[]
  nextMeeting: MeetingSummary | null
  upcoming: MeetingSummary[]
  recentActivity: ActivityItem[]
  departmentMeetings: { department: string; internal: number; customer: number }[]
  weeklyTrend: { day: string; scheduled: number; completed: number }[]
  attendance: { attended: number; late: number; missed: number }
  recordingStatus: { completed: number; processing: number; pending: number; failed: number }
}

export interface DashboardApi {
  getSummary(): Promise<DashboardSummary>
}

// ---- Shared ----------------------------------------------------------------

/** `?page=1&pageSize=25` → paged list. */
export type Paged<T> = { items: T[]; total: number; pageNumber: number; pageSize: number }

/** Builds a query string, skipping empty values. */
export function query(params: Record<string, string | number | boolean | undefined | null>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}
