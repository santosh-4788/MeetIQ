// ⚠ DEVELOPMENT DEMO ADAPTER — sample dashboard data for UI review only.
// Never shipped in production builds; the real numbers come from GET /api/v1/dashboard/summary (Phase 2/3).
import type { DashboardApi, DashboardSummary, MeetingSummary } from '../api/types'

function at(hoursFromNow: number, minutes = 0) {
  const d = new Date(Date.now() + hoursFromNow * 3_600_000)
  d.setMinutes(minutes, 0, 0)
  return d
}

function meeting(id: string, title: string, category: MeetingSummary['category'], start: Date, mins: number, organiser: string, participants: string[], extra: Partial<MeetingSummary> = {}): MeetingSummary {
  const end = new Date(start.getTime() + mins * 60_000)
  const now = Date.now()
  const status = end.getTime() < now ? 'COMPLETED' : start.getTime() <= now ? 'LIVE' : 'SCHEDULED'
  return { id, title, category, startUtc: start.toISOString(), endUtc: end.toISOString(), organiser, participants, status, recording: category === 'CUSTOMER', ...extra }
}

function build(): DashboardSummary {
  const today: MeetingSummary[] = [
    meeting('m1', 'Daily Service Stand-up', 'INTERNAL', at(-3, 30), 30, 'Ananya Rao', ['Ananya Rao', 'Rohit Mehta', 'Sneha Kulkarni', 'Imran Shaikh', 'Priya Nair']),
    meeting('m2', 'PLVC — Term Life Policy Verification', 'CUSTOMER', at(-1, 0), 25, 'Ananya Rao', ['Ananya Rao', 'Customer'], { customerName: 'R. Sharma' }),
    meeting('m3', 'Claims Process Review', 'REVIEW', at(1, 0), 45, 'Karan Desai', ['Karan Desai', 'Ananya Rao', 'Meera Iyer']),
    meeting('m4', 'PLVC — Health Insurance Onboarding', 'CUSTOMER', at(2, 30), 25, 'Rohit Mehta', ['Rohit Mehta', 'Customer'], { customerName: 'S. Patel' }),
    meeting('m5', 'New Joiner Product Training', 'TRAINING', at(4, 0), 60, 'Meera Iyer', ['Meera Iyer', 'Arjun Verma', 'Kavya Joshi', 'Nikhil Gupta', 'Pooja Singh', 'Rahul Bose']),
  ]
  const upcoming: MeetingSummary[] = [
    meeting('m6', 'Monthly Management Review', 'MANAGEMENT', at(22, 0), 90, 'Suresh Menon', ['Suresh Menon', 'Karan Desai', 'Meera Iyer', 'Vijay Vishwakarma']),
    meeting('m7', 'PLVC — ULIP Policy Verification', 'CUSTOMER', at(25, 30), 25, 'Ananya Rao', ['Ananya Rao', 'Customer'], { customerName: 'A. Khan' }),
    meeting('m8', 'IT Security Awareness Session', 'TRAINING', at(28, 0), 45, 'Vijay Vishwakarma', ['Vijay Vishwakarma', 'All Staff']),
    meeting('m9', 'Sales Pipeline Sync', 'INTERNAL', at(46, 0), 30, 'Imran Shaikh', ['Imran Shaikh', 'Rohit Mehta', 'Priya Nair']),
  ]
  const next = [...today, ...upcoming].find((m) => new Date(m.startUtc).getTime() > Date.now()) ?? null
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return {
    generatedUtc: new Date().toISOString(),
    kpis: {
      totalEmployees: 248,
      todaysMeetings: today.length,
      upcomingMeetings: 37,
      internalMeetings: 126,
      customerMeetings: 214,
      completedMeetings: 312,
      totalRecordings: 205,
      pendingRecordings: 3,
    },
    todaySchedule: today,
    nextMeeting: next,
    upcoming,
    recentActivity: [
      { id: 'a1', type: 'RECORDING_READY', text: 'Recording verified for PLVC — Term Life Policy Verification', actor: 'System', atUtc: at(-0.3).toISOString() },
      { id: 'a2', type: 'MEETING_COMPLETED', text: 'Daily Service Stand-up completed · 5 attended', actor: 'Ananya Rao', atUtc: at(-2.5).toISOString() },
      { id: 'a3', type: 'INVITE_ACCEPTED', text: 'Meera Iyer accepted Claims Process Review', actor: 'Meera Iyer', atUtc: at(-4).toISOString() },
      { id: 'a4', type: 'MEETING_RESCHEDULED', text: 'Sales Pipeline Sync moved to Monday 10:00 AM', actor: 'Imran Shaikh', atUtc: at(-6).toISOString() },
      { id: 'a5', type: 'RECORDING_FAILED', text: 'Recording failed verification — retry queued', actor: 'System', atUtc: at(-9).toISOString() },
    ],
    departmentMeetings: [
      { department: 'Customer Service', internal: 18, customer: 64 },
      { department: 'Sales', internal: 22, customer: 41 },
      { department: 'Claims', internal: 15, customer: 28 },
      { department: 'Underwriting', internal: 12, customer: 17 },
      { department: 'Operations', internal: 26, customer: 6 },
      { department: 'IT', internal: 19, customer: 0 },
    ],
    weeklyTrend: days.map((day, i) => ({ day, scheduled: [42, 48, 45, 53, 49, 21, 6][i], completed: [39, 45, 41, 50, 46, 19, 5][i] })),
    attendance: { attended: 86, late: 9, missed: 5 },
    recordingStatus: { completed: 198, processing: 2, pending: 3, failed: 2 },
  }
}

export const demoDashboardApi: DashboardApi = {
  async getSummary() {
    await new Promise((r) => setTimeout(r, 700))
    return build()
  },
}
