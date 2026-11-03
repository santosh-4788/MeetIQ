import { http } from './http'
import { query, type Paged } from './types'

// In-app notification centre: /api/v1/notifications (notifications.view). Newest first.

export type NotificationType = 'INVITATION' | 'RESCHEDULED' | 'CANCELLED' | 'REMINDER' | 'RESPONSE' | (string & {})

export type AppNotification = {
  id: string
  type: NotificationType
  title: string
  body: string | null
  /** App-relative, e.g. /meetings/{id}. */
  linkPath: string | null
  isRead: boolean
  createdUtc: string
  readUtc: string | null
}

export type NotificationPage = Paged<AppNotification> & { unreadCount: number }

/** Fired on window after the user reads notifications, so the header bell refreshes its badge at once. */
export const NOTIFICATIONS_CHANGED = 'oic:notifications-changed'
export const notifyNotificationsChanged = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

export const notificationsApi = {
  list: (q: { unreadOnly?: boolean; page?: number; pageSize?: number }) =>
    http<NotificationPage>(`/notifications${query({ unreadOnly: q.unreadOnly || undefined, page: q.page, pageSize: q.pageSize })}`),
  unreadCount: () => http<{ unreadCount: number }>('/notifications/unread-count'),
  markRead: (id: string) => http<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  markAllRead: () => http<{ marked: number }>('/notifications/read-all', { method: 'POST' }),
}
