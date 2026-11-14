import { http } from './http'

// Minutes of meeting (MOM) written by people - no AI (V027, 14 Nov 2026). Off until an administrator switches on
// "Minutes of meeting" in Administration -> Meeting features.

export type MinutesStatus = 'DRAFT' | 'APPROVED'
export type ActionPriority = 'LOW' | 'MEDIUM' | 'HIGH'
export type ActionStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE'

export type ActionItem = {
  id: string | null
  description: string
  assignee: { id: string; name: string } | null
  dueDate: string | null
  priority: ActionPriority
  status: ActionStatus
}

export type MinutesContent = {
  discussionSummary: string | null
  customerRequirements: string | null
  decisions: string | null
  pendingActivities: string | null
  followUpDate: string | null
  actionItems: ActionItem[]
}

export type Minutes = MinutesContent & {
  id: string
  status: MinutesStatus
  version: number
  createdBy: string | null
  createdUtc: string
  modifiedBy: string | null
  modifiedUtc: string
  approvedBy: string | null
  approvedUtc: string | null
}

export type MinutesMeeting = {
  meetingCode: string
  title: string
  category: string
  status: string
  startUtc: string
  endUtc: string
  actualStartUtc: string | null
  actualEndUtc: string | null
  timeZoneId: string
  host: string
  organiser: string
  customerName: string | null
  prarambhMainId: string | null
  participants: { name: string; type: string; role: string; attended: boolean; attendedSeconds: number | null }[]
}

export type MinutesView = {
  canCreate: boolean
  canEdit: boolean
  canApprove: boolean
  canReopen: boolean
  canSeeHistory: boolean
  draftInProgress: boolean
  writableMeeting: boolean
  meeting: MinutesMeeting
  minutes: Minutes | null
}

export type MinutesVersion = { version: number; action: 'CREATED' | 'SAVED' | 'APPROVED' | 'REOPENED'; status: MinutesStatus; note: string | null; savedUtc: string; savedBy: string | null }

export type MinutesInput = {
  baseVersion: number
  discussionSummary: string | null
  customerRequirements: string | null
  decisions: string | null
  pendingActivities: string | null
  followUpDate: string | null
  actionItems: { id: string | null; description: string; assigneeId: string | null; dueDate: string | null; priority: ActionPriority; status: ActionStatus }[]
}

const base = (id: string) => `/meetings/${encodeURIComponent(id)}/minutes`

export const minutesApi = {
  get: (id: string) => http<MinutesView>(base(id)),
  save: (id: string, body: MinutesInput) => http<{ id: string; version: number }>(base(id), { method: 'PUT', body }),
  approve: (id: string, version: number) => http<{ version: number }>(`${base(id)}/approve`, { method: 'POST', body: { version } }),
  reopen: (id: string, version: number, reason: string) => http<{ version: number }>(`${base(id)}/reopen`, { method: 'POST', body: { version, reason } }),
  versions: (id: string) => http<{ items: MinutesVersion[] }>(`${base(id)}/versions`),
  version: (id: string, version: number) => http<MinutesVersion & { content: MinutesContent }>(`${base(id)}/versions/${version}`),
}

export const PRIORITY_LABEL: Record<ActionPriority, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' }
export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', DONE: 'Done' }
export const VERSION_ACTION_LABEL: Record<MinutesVersion['action'], string> = { CREATED: 'Created', SAVED: 'Saved', APPROVED: 'Approved', REOPENED: 'Reopened' }
