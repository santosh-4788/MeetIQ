import { DEMO_MODE } from '../config'
import { demoAuthApi } from '../dev/demoAuth'
import { demoDashboardApi } from '../dev/demoDashboard'
import { http } from './http'
import { ApiError, type AuthApi, type DashboardApi, type LoginResult, type UserSummary } from './types'

const httpAuthApi: AuthApi = {
  async me() {
    try {
      return await http<UserSummary>('/auth/me')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  login: (req) => http<LoginResult>('/auth/login', { method: 'POST', body: req }),
  verifyMfa: (req) => http<UserSummary>('/auth/mfa/verify', { method: 'POST', body: req }),
  resendMfa: (req) => http<void>('/auth/mfa/resend', { method: 'POST', body: req }),
  forgotPassword: (req) => http<void>('/auth/forgot-password', { method: 'POST', body: req }),
  resetPassword: (req) => http<void>('/auth/reset-password', { method: 'POST', body: req }),
  changePassword: (req) => http<void>('/auth/change-password', { method: 'POST', body: req }),
  logout: () => http<void>('/auth/logout', { method: 'POST' }),
}

const httpDashboardApi: DashboardApi = {
  getSummary: () => http('/dashboard/summary'),
}

// DEMO_MODE is a compile-time constant (false in production builds), so the demo adapters are
// removed from the production bundle by dead-code elimination.
export const authApi: AuthApi = DEMO_MODE ? demoAuthApi : httpAuthApi
export const dashboardApi: DashboardApi = DEMO_MODE ? demoDashboardApi : httpDashboardApi
