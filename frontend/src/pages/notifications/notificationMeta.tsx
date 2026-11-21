import type { ReactNode } from 'react'
import { AlarmClock, AtSign, BellRing, CalendarClock, CalendarPlus, CalendarX2, ClipboardCheck, ListTodo, MessageCircle, PhoneMissed, Share2, StickyNote, UserCheck, UserPlus, UsersRound } from 'lucide-react'
import type { NotificationType } from '../../api/notifications'

/** Icon and tint per notification type (unknown future types fall back to the bell). */
export function notificationIcon(type: NotificationType): { icon: ReactNode; cls: string } {
  switch (type) {
    case 'INVITATION':
      return { icon: <CalendarPlus className="size-4" />, cls: 'bg-brand-50 text-brand-500' }
    case 'RESCHEDULED':
      return { icon: <CalendarClock className="size-4" />, cls: 'bg-warning-soft text-warning-ink' }
    case 'CANCELLED':
      return { icon: <CalendarX2 className="size-4" />, cls: 'bg-danger-soft text-danger' }
    case 'MISSED_CALL':
      return { icon: <PhoneMissed className="size-4" />, cls: 'bg-danger-soft text-danger' }
    case 'CHAT_MENTION':
      return { icon: <AtSign className="size-4" />, cls: 'bg-brand-50 text-brand-500' }
    case 'GROUP_ADDED':
      return { icon: <UsersRound className="size-4" />, cls: 'bg-success-soft text-success' }
    case 'TASK_REMINDER':
      return { icon: <ListTodo className="size-4" />, cls: 'bg-warning-soft text-warning-ink' }
    case 'NOTE_REMINDER':
      return { icon: <StickyNote className="size-4" />, cls: 'bg-warning-soft text-warning-ink' }
    case 'TASK_ASSIGNED':
      return { icon: <UserPlus className="size-4" />, cls: 'bg-brand-50 text-brand-500' }
    case 'TASK_REVIEW':
      return { icon: <ClipboardCheck className="size-4" />, cls: 'bg-[#f3e8ff] text-[#9333ea]' }
    case 'TASK_UPDATE':
      return { icon: <ListTodo className="size-4" />, cls: 'bg-success-soft text-success' }
    case 'TASK_COMMENT':
      return { icon: <MessageCircle className="size-4" />, cls: 'bg-brand-50 text-brand-500' }
    case 'TASK_DUE':
      return { icon: <AlarmClock className="size-4" />, cls: 'bg-danger-soft text-danger' }
    case 'NOTE_SHARED':
      return { icon: <Share2 className="size-4" />, cls: 'bg-warning-soft text-warning-ink' }
    case 'RESPONSE':
      return { icon: <UserCheck className="size-4" />, cls: 'bg-success-soft text-success' }
    default:
      return { icon: <BellRing className="size-4" />, cls: 'bg-cyan-50 text-[#0E9FB0]' }
  }
}

/** Only app-relative links are followed (never an absolute URL from data). */
export const safeLink = (path: string | null) => (path && path.startsWith('/') && !path.startsWith('//') ? path : null)
