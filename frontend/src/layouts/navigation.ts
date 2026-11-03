import type { LucideIcon } from 'lucide-react'
import {
  Bell, Building, CalendarDays, CalendarPlus, ChartColumn, Clapperboard, Handshake, IdCard, LayoutDashboard, Settings, ShieldCheck, Users, Video,
} from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  permission?: string
  /** Delivery phase for modules not yet built; drives the honest "planned" page (and the planned areas on /admin). */
  phase?: number
  planned?: string[]
}

export type NavSection = { title: string; items: NavItem[] }

export const navigation: NavSection[] = [
  {
    title: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.view' }],
  },
  {
    title: 'Meetings',
    items: [
      { to: '/meetings', label: 'My Meetings', icon: Video, permission: 'meetings.view.own' },
      { to: '/calendar', label: 'Meeting Calendar', icon: CalendarDays, permission: 'calendar.view' },
      { to: '/schedule', label: 'Schedule Meeting', icon: CalendarPlus, permission: 'meetings.create' },
      { to: '/internal', label: 'Internal Meetings', icon: Users, permission: 'meetings.view.own' },
      { to: '/customer-meetings', label: 'Customer Meetings', icon: Handshake, permission: 'customer.meetings.view' },
    ],
  },
  {
    title: 'Library',
    items: [
      { to: '/recordings', label: 'Recording Library', icon: Clapperboard, permission: 'recordings.view.own' },
      { to: '/notifications', label: 'Notifications', icon: Bell, permission: 'notifications.view' },
      { to: '/reports', label: 'Reports', icon: ChartColumn, permission: 'reports.view', phase: 5,
        planned: ['Daily, monthly, employee and department reports', 'Internal vs customer meetings', 'Attendance, recording and failed-recording reports', 'Reminder delivery report', 'CSV / Excel export'] },
    ],
  },
  {
    title: 'Organisation',
    items: [
      { to: '/employees', label: 'Employee Management', icon: IdCard, permission: 'employees.manage' },
      { to: '/organisation', label: 'Department Management', icon: Building, permission: 'org.manage' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: '/admin', label: 'Administration', icon: ShieldCheck, permission: 'admin.settings', phase: 5,
        planned: ['Users, roles and permission matrix', 'SMTP, meeting, recording, security and retention settings', 'System health and background service status', 'Audit log viewer'] },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

export const allNavItems = navigation.flatMap((s) => s.items)
