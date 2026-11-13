import { http } from './http'

/** GET /auth/session: when the portal session ends and the server's clock (see DailyLogout.cs). */
export type SessionInfo = {
  serverNowUtc: string
  idleMinutes: number
  idleExpiresUtc: string | null
  absoluteExpiryUtc: string | null
  /** Next daily security reset (e.g. 23:30 IST); a pending administrator test cutoff when dailyLogoutTest. */
  dailyLogoutUtc: string | null
  dailyLogoutTest: boolean
  dailyLogoutDescription: string
  warningMinutes: number
}

export const sessionApi = {
  get: () => http<SessionInfo>('/auth/session'),
  /** Administrators (admin.ops): end THEIR OWN sessions in N minutes to try the warning and the logout. */
  scheduleTest: (minutes: number) => http<{ testLogoutUtc: string }>('/admin/ops/daily-logout/test', { method: 'POST', body: { minutes } }),
  cancelTest: () => http<{ cancelled: boolean }>('/admin/ops/daily-logout/test', { method: 'DELETE' }),
}
