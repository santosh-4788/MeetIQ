import type { LucideIcon } from 'lucide-react'
import {
  Bell, Building, CalendarDays, CalendarPlus, ChartColumn, Clapperboard, FileCode2, Handshake, IdCard, LayoutDashboard, ListTodo, MessagesSquare, ScrollText, Settings, ShieldCheck, Sparkles, StickyNote, Sun, Users, Video,
} from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  permission?: string
  /** Delivery phase for modules not yet built; drives the honest "planned" page (and the planned areas on /admin). */
  phase?: number
  planned?: string[]
  /** Shown only while this optional module is switched on (chat: CHAT; tasks: CHAT + CHAT_TASKS). */
  feature?: 'chat' | 'tasks'
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
    // 20 Nov 2026: Chat, directly below Meetings (documentation/CHAT_MODULE_PHASE1.md).
    title: 'Communication',
    items: [
      { to: '/chat', label: 'Chat', icon: MessagesSquare, permission: 'chat.use', feature: 'chat' },
      // 20 Nov 2026: Phase 4 sections also in the menu (the same Chat workspace, opened on that section).
      { to: '/my-day', label: 'My Day', icon: Sun, permission: 'chat.tasks', feature: 'tasks' },
      { to: '/tasks', label: 'Tasks', icon: ListTodo, permission: 'chat.tasks', feature: 'tasks' },
      { to: '/notes', label: 'Notes', icon: StickyNote, permission: 'chat.tasks', feature: 'tasks' },
    ],
  },
  {
    title: 'Library',
    items: [
      { to: '/recordings', label: 'Recording Library', icon: Clapperboard, permission: 'recordings.view.own' },
      { to: '/notifications', label: 'Notifications', icon: Bell, permission: 'notifications.view' },
      { to: '/reports', label: 'Reports', icon: ChartColumn, permission: 'reports.view' },
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
        planned: ['Users, roles and permission matrix', 'SMTP, meeting, recording, security and retention settings', 'System health and background service status'] },
      { to: '/audit-log', label: 'Audit Log', icon: ScrollText, permission: 'audit.view' },
      { to: '/api-docs', label: 'API Documentation', icon: FileCode2, permission: 'api.docs.view' },
      { to: '/meeting-features', label: 'Meeting Features', icon: Sparkles, permission: 'features.manage' },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
]

export const allNavItems = navigation.flatMap((s) => s.items)
