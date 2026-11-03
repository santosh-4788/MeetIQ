import { http } from './http'
import { query, type MeetingCategory, type Paged } from './types'

// Phase 5 — recording management: /api/v1/recordings, /api/v1/meetings/{id}/recording(s), /api/v1/join/{token}/recording,
// /api/v1/admin/recording-policies, /api/v1/admin/recording/health.

export type RecordingStatus = 'PENDING' | 'RECORDING' | 'PROCESSING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'PURGED'
export type ApprovalStatus = 'PENDING_CONFIRMATION' | 'EXISTING_BUSINESS_POLICY' | 'APPROVED'
export type Requirement = 'DISABLED' | 'OPTIONAL' | 'MANDATORY'
export type ConsentMode = 'CONSENT_REQUIRED' | 'NOTIFICATION_ONLY'
export type ExpiryAction = 'REVIEW_ONLY' | 'ARCHIVE' | 'DELETE'
export type ConsentDecision = 'GRANTED' | 'DENIED' | 'WITHDRAWN'

// ---- Room ------------------------------------------------------------------------------------------------------------

export type RoomRecordingState = {
  available: boolean
  unavailableReason?: string | null
  unavailableCode?: string | null
  policy: {
    code: string
    title: string
    name: string | null
    version: string | null
    confirmed: boolean
    requirement: Requirement
    consentMode: ConsentMode
    noticeText: string
    noticeVersion: string
    consentFromAll: boolean
    stopOnWithdrawal: boolean
  } | null
  recording: { id: string; status: RecordingStatus; startedUtc: string | null; createdUtc: string } | null
  lastRecording?: { id: string; status: RecordingStatus; reason: string | null } | null
  myConsent?: ConsentDecision | null
  isHost?: boolean
  canStart?: boolean
  canStop?: boolean
  consent?: { ok: boolean; required: number; granted: number; pending: string[]; declined: string[] } | null
}

const meeting = (id: string) => `/meetings/${encodeURIComponent(id)}/recording`
const guest = (token: string) => `/join/${encodeURIComponent(token)}/recording`

export const roomRecordingApi = {
  state: (id: string) => http<RoomRecordingState>(meeting(id)),
  consent: (id: string, decision: ConsentDecision, noticeVersion: string) =>
    http<RoomRecordingState>(`${meeting(id)}/consent`, { method: 'POST', body: { decision, noticeVersion } }),
  start: (id: string, noticeVersion: string) => http<RoomRecordingState>(`${meeting(id)}/start`, { method: 'POST', body: { acceptNotice: true, noticeVersion } }),
  stop: (id: string) => http<RoomRecordingState>(`${meeting(id)}/stop`, { method: 'POST' }),
}

export const guestRecordingApi = {
  state: (token: string) => http<RoomRecordingState>(guest(token)),
  consent: (token: string, decision: ConsentDecision, noticeVersion: string) =>
    http<RoomRecordingState>(`${guest(token)}/consent`, { method: 'POST', body: { decision, noticeVersion } }),
}

// ---- Library ---------------------------------------------------------------------------------------------------------

export type RecordingItem = {
  id: string
  status: RecordingStatus
  createdUtc: string
  startedUtc: string | null
  endedUtc: string | null
  durationSeconds: number | null
  fileSizeBytes: number | null
  legalHold: boolean
  retainUntilUtc: string | null
  storageTier: 'PRIMARY' | 'ARCHIVE'
  meeting: { id: string; title: string; meetingCode: string; category: string; categoryGroup: MeetingCategory }
  owner: { id: string; name: string; employeeCode: string | null; department: string | null }
  customer: { name: string; reference: string | null } | null
  policy: { code: string; title: string } | null
  canPlay: boolean
  canDownload: boolean
  access: string
}

export type AccessEntry = { action: 'VIEW_DETAILS' | 'PLAY' | 'DOWNLOAD' | 'DENIED'; utc: string; user: string; ipAddress: string | null; linkExpiresUtc: string | null }

export type RecordingDetail = {
  recording: RecordingItem
  sha256: string | null
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  verifiedUtc: string | null
  verification: Record<string, unknown> | null
  failureReason: string | null
  stopReason: string | null
  startedBy: string | null
  policyVersion: string | null
  archivedUtc: string | null
  retentionReviewUtc: string | null
  purgedUtc: string | null
  consents: { name: string; participantType: string; decision: ConsentDecision; noticeVersion: string; decisionUtc: string }[]
  canSetLegalHold: boolean
  canRetry: boolean
  canSeeAccessHistory: boolean
  accessHistory: AccessEntry[] | null
}

export type RecordingFilters = {
  from?: string
  to?: string
  employee?: string
  department?: string
  category?: string
  status?: string
  customerRef?: string
  meeting?: string
  search?: string
  page?: number
  pageSize?: number
}

export type EmployeeRecordingSummary = {
  employee: { id: string; name: string; employeeCode: string | null; department: string | null }
  recordings: number
  completed: number
  failed: number
  totalSeconds: number
  totalBytes: number
  lastUtc: string | null
}

export type DeletionRequest = {
  id: string
  recordingId: string
  meetingTitle: string
  meetingCode: string
  owner: string
  source: 'RETENTION' | 'MANUAL'
  reason: string
  requiredApprovals: number
  status: 'PENDING' | 'EXECUTED' | 'REJECTED' | 'CANCELLED' | 'FAILED'
  requestedUtc: string
  firstApprover: string | null
  firstApprovedUtc: string | null
  secondApprover: string | null
  notes: string | null
  executedUtc: string | null
  canDecide: boolean
}

export type SignedLink = { url: string; expiresUtc: string }

const one = (id: string) => `/recordings/${encodeURIComponent(id)}`

export const recordingsApi = {
  list: (f: RecordingFilters) => http<Paged<RecordingItem>>(`/recordings${query(f)}`),
  byEmployee: (f: RecordingFilters) => http<EmployeeRecordingSummary[]>(`/recordings/by-employee${query(f)}`),
  forMeeting: (meetingId: string) => http<{ items: RecordingItem[]; hiddenCount: number }>(`/meetings/${encodeURIComponent(meetingId)}/recordings`),
  get: (id: string) => http<RecordingDetail>(one(id)),
  accessLog: (id: string) => http<AccessEntry[]>(`${one(id)}/access-log`),
  play: (id: string) => http<SignedLink>(`${one(id)}/play`, { method: 'POST' }),
  download: (id: string) => http<SignedLink>(`${one(id)}/download`, { method: 'POST' }),
  setLegalHold: (id: string, hold: boolean, reason: string) => http<void>(`${one(id)}/legal-hold`, { method: 'PUT', body: { hold, reason } }),
  retry: (id: string) => http<void>(`${one(id)}/retry`, { method: 'POST' }),
  retention: () => http<{ review: RecordingItem[]; deletions: DeletionRequest[]; canApproveFor: string[] }>('/recordings/retention'),
  approveDeletion: (id: string, note?: string) =>
    http<{ status: string; approvals: number; required: number }>(`/recordings/deletions/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { note } }),
  rejectDeletion: (id: string, note?: string) => http<void>(`/recordings/deletions/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { note } }),
}

// ---- Administration ------------------------------------------------------------------------------------------------------

export type RecordingPolicy = {
  code: string
  title: string
  appliesTo: string
  policyName: string | null
  policyVersion: string | null
  effectiveFrom: string | null
  approvalStatus: ApprovalStatus
  policyReference: string | null
  approvedBy: string | null
  approvedOn: string | null
  isEnabled: boolean
  requirement: Requirement
  consentMode: ConsentMode
  noticeText: string
  noticeVersion: string
  consentFromAll: boolean
  stopOnWithdrawal: boolean
  retentionDays: number | null
  expiryAction: ExpiryAction
  archiveLocation: string | null
  legalHoldEnabled: boolean
  dualApprovalForDeletion: boolean
  deletionApproverRoles: string[]
  playbackRoles: string[]
  downloadRoles: string[]
  ownerCanPlay: boolean
  ownerCanDownload: boolean
  teamLeaderCanPlay: boolean
  departmentHeadCanPlay: boolean
  signedUrlTtlSeconds: number
  modifiedUtc: string | null
  modifiedBy: string | null
  rowVersion: string
  confirmed: boolean
  hasPlaceholders: boolean
  pending: string[]
  configurationOnly: boolean
}

export type PolicyInput = Omit<RecordingPolicy, 'code' | 'title' | 'appliesTo' | 'modifiedUtc' | 'modifiedBy' | 'confirmed' | 'hasPlaceholders' | 'pending' | 'configurationOnly'>

export type RecorderHealth = {
  available: boolean
  environment: string
  recorder: string
  items: { name: string; ok: boolean; detail: string }[]
  activeJobs: number
  queuedJobs: number
  failedLast24h: number
}

export const recordingAdminApi = {
  policies: () =>
    http<{ items: RecordingPolicy[]; roles: { code: string; name: string }[]; categories: { category: string; policyCode: string }[] }>('/admin/recording-policies'),
  update: (code: string, body: PolicyInput) => http<RecordingPolicy>(`/admin/recording-policies/${encodeURIComponent(code)}`, { method: 'PUT', body }),
  setCategories: (items: { category: string; policyCode: string }[]) =>
    http<{ category: string; policyCode: string }[]>('/admin/recording-policies/categories', { method: 'PUT', body: { items } }),
  health: () => http<RecorderHealth>('/admin/recording/health'),
}

// ---- Labels ----------------------------------------------------------------------------------------------------------------

export const recordingStatusLabel: Record<RecordingStatus, string> = {
  PENDING: 'Starting',
  RECORDING: 'Recording',
  PROCESSING: 'Processing',
  VERIFYING: 'Verifying',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  PURGED: 'Deleted (retention)',
}

export const approvalLabel: Record<ApprovalStatus, string> = {
  PENDING_CONFIRMATION: 'Pending confirmation',
  EXISTING_BUSINESS_POLICY: 'Existing business policy',
  APPROVED: 'Approved for this platform',
}

export function formatBytes(n: number | null | undefined) {
  if (n == null) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatSeconds(s: number | null | undefined) {
  if (s == null) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
