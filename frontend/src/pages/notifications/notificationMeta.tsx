import type { ReactNode } from 'react'
import { BellRing, CalendarClock, CalendarPlus, CalendarX2, UserCheck } from 'lucide-react'
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
    case 'RESPONSE':
      return { icon: <UserCheck className="size-4" />, cls: 'bg-success-soft text-success' }
    default:
      return { icon: <BellRing className="size-4" />, cls: 'bg-cyan-50 text-[#0E9FB0]' }
  }
}

/** Only app-relative links are followed (never an absolute URL from data). */
export const safeLink = (path: string | null) => (path && path.startsWith('/') && !path.startsWith('//') ? path : null)
