import { API_BASE } from '../config'
import { http } from './http'
import { query, type Paged } from './types'
import type { MeetingCategory } from './types'
import type { DbMeetingCategory, MeetingState, RecordingPolicy } from './meetings'

export type ReportFilters = {
  from?: string
  to?: string
  category?: 'CUSTOMER' | 'INTERNAL' | DbMeetingCategory | 'CUSTOMER_PLVC_IDENTIFIED' | 'CUSTOMER_PLVC_UNIDENTIFIED'
  department?: string
  status?: MeetingState
  search?: string
  page?: number
  pageSize?: number
}

export type ReportMeetingRow = {
  id: string
  meetingCode: string
  title: string
  category: DbMeetingCategory
  categoryGroup: MeetingCategory
  status: MeetingState
  startUtc: string
  endUtc: string
  actualStartUtc: string | null
  actualEndUtc: string | null
  hostName: string
  department: string | null
  customerName: string | null
  /** Customer – PLVC: the Prarambh Main ID it was created with (null otherwise). */
  prarambhMainId?: string | null
  plvcIdentification?: 'IDENTIFIED' | 'UNIDENTIFIED' | null
  participantCount: number
  recordingPolicy: RecordingPolicy
  recordingStatus: string | null
}

export type ReportSummary = {
  total: number
  completed: number
  cancelled: number
  liveOrScheduled: number
  customerMeetings: number
  internalMeetings: number
  totalHours: number
  withRecording: number
}

export type Department = { id: string; name: string }

const base = (f: ReportFilters) =>
  query({ from: f.from, to: f.to, category: f.category, department: f.department, status: f.status, search: f.search, page: f.page, pageSize: f.pageSize })

export const reportsApi = {
  departments: () => http<Department[]>('/reports/departments'),
  meetings: (f: ReportFilters) => http<{ summary: ReportSummary; page: Paged<ReportMeetingRow> }>(`/reports/meetings${base(f)}`),
  /** Returns the CSV download URL (opened in a new tab / assigned to location, not fetched as JSON). */
  exportUrl: (f: ReportFilters) => `${API_BASE}/reports/meetings/export${base(f)}`,
}
