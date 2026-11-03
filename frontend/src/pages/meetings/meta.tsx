import type { MeetingCategory } from '../../api/types'
import type { ConflictType, DbMeetingCategory, MeetingState, RecordingPolicy, ResponseStatus } from '../../api/meetings'
import { useAuth } from '../../auth/AuthContext'
import { Badge, type BadgeTone } from '../../components/ui/Feedback'
import { DEFAULT_TIME_ZONE } from '../../config'
import { meetingCategoryColors } from '../../design/tokens'

// Shared labels, colours and badges for the meeting screens (and the dashboard).

/** Category families as on the dashboard: colour (calendar, borders) and badge tone. */
export const categoryMeta: Record<MeetingCategory, { label: string; color: string; tone: BadgeTone }> = {
  INTERNAL: { label: 'Internal', color: meetingCategoryColors.internal, tone: 'brand' },
  CUSTOMER: { label: 'Customer', color: meetingCategoryColors.customer, tone: 'success' },
  TRAINING: { label: 'Training', color: meetingCategoryColors.training, tone: 'neutral' },
  REVIEW: { label: 'Review', color: meetingCategoryColors.review, tone: 'warning' },
  MANAGEMENT: { label: 'Management', color: meetingCategoryColors.management, tone: 'neutral' },
}

export const dbCategoryLabel: Record<DbMeetingCategory, string> = {
  INTERNAL_1_1: 'One-to-one',
  GROUP: 'Group meeting',
  TEAM: 'Team meeting',
  DEPARTMENT: 'Department meeting',
  MANAGEMENT: 'Management meeting',
  TRAINING: 'Training',
  REVIEW: 'Review',
  CUSTOMER_PLVC: 'Customer — PLVC',
  CUSTOMER_GENERAL: 'Customer — general',
}

export const INTERNAL_CATEGORIES: DbMeetingCategory[] = ['INTERNAL_1_1', 'GROUP', 'TEAM', 'DEPARTMENT', 'MANAGEMENT', 'TRAINING', 'REVIEW']
export const CUSTOMER_CATEGORIES: DbMeetingCategory[] = ['CUSTOMER_PLVC', 'CUSTOMER_GENERAL']
export const isCustomerCategory = (c: string) => c === 'CUSTOMER_PLVC' || c === 'CUSTOMER_GENERAL'

const statusMeta: Record<MeetingState, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SCHEDULED: { label: 'Scheduled', tone: 'brand' },
  LIVE: { label: 'Live', tone: 'live' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  INCOMPLETE: { label: 'Incomplete', tone: 'warning' },
}

const responseMeta: Record<ResponseStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Awaiting reply', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  TENTATIVE: { label: 'Tentative', tone: 'info' },
  DECLINED: { label: 'Declined', tone: 'danger' },
}

export const recordingLabel: Record<RecordingPolicy, string> = {
  NONE: 'No recording',
  OPTIONAL: 'Optional',
  REQUIRED: 'Required',
}

export const conflictLabel: Record<ConflictType, string> = {
  MEETING: 'Busy in another meeting',
  LEAVE: 'On leave',
  BLOCKED: 'Blocked time',
  OUTSIDE_WORKING_HOURS: 'Outside working hours',
}

export function StatusBadge({ status }: { status: MeetingState }) {
  const s = statusMeta[status] ?? { label: status, tone: 'neutral' as const }
  return (
    <Badge tone={s.tone} dot={status === 'LIVE'}>
      {s.label}
    </Badge>
  )
}

export function CategoryBadge({ group, category }: { group: MeetingCategory; category?: DbMeetingCategory }) {
  const g = categoryMeta[group] ?? categoryMeta.INTERNAL
  return <Badge tone={g.tone}>{category ? dbCategoryLabel[category] ?? g.label : g.label}</Badge>
}

export function ResponseBadge({ response, prefix }: { response: ResponseStatus; prefix?: string }) {
  const r = responseMeta[response] ?? { label: response, tone: 'neutral' as const }
  return (
    <Badge tone={r.tone}>
      {prefix}
      {r.label}
    </Badge>
  )
}

/** The signed-in user's display zone (IST unless their account says otherwise). */
export function useTimeZone() {
  const { user } = useAuth()
  return user?.timeZone || DEFAULT_TIME_ZONE
}
