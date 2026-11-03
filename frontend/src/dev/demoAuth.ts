// ⚠ DEVELOPMENT DEMO ADAPTER — not used in production builds (see src/config.ts DEMO_MODE).
// Simulates the Phase 2 auth API so the login flows can be reviewed before the backend exists.
// These are fictitious demo identities, not real accounts or credentials.
import { ApiError, type AuthApi, type UserSummary } from '../api/types'

export const DEMO_PASSWORD = 'Demo@2026!'
export const DEMO_MFA_CODE = '246810'
export const DEMO_RESET_TOKEN = 'demo-reset-token'

export const DEMO_ACCOUNTS = [
  { login: 'demo.admin@oneinsure.com', note: 'Administrator, signs in directly' },
  { login: 'OIC-1002', note: 'Employee ID, MFA required (code 246810)' },
  { login: 'locked.user@oneinsure.com', note: 'Shows the account-locked flow' },
] as const

const ALL_PERMISSIONS = [
  'dashboard.view', 'meetings.view.own', 'meetings.create', 'calendar.view', 'customer.meetings.view',
  'recordings.view.own', 'notifications.view', 'reports.view', 'employees.manage', 'org.manage',
  'admin.security', 'admin.settings', 'admin.ops', 'audit.view',
]

const users: Record<string, UserSummary & { mfa: boolean; locked?: boolean }> = {
  'demo.admin@oneinsure.com': {
    id: 'demo-u-1', displayName: 'Vijay Vishwakarma', email: 'demo.admin@oneinsure.com', employeeCode: 'OIC-1001',
    department: 'Information Technology', designation: 'Platform Administrator', roles: ['Admin'],
    permissions: ALL_PERMISSIONS, timeZone: 'Asia/Kolkata', mfa: false,
  },
  'oic-1002': {
    id: 'demo-u-2', displayName: 'Ananya Rao', email: 'ananya.rao@oneinsure.com', employeeCode: 'OIC-1002',
    department: 'Customer Service', designation: 'Senior Relationship Manager', roles: ['Employee'],
    permissions: ['dashboard.view', 'meetings.view.own', 'meetings.create', 'calendar.view', 'customer.meetings.view', 'recordings.view.own', 'notifications.view'],
    timeZone: 'Asia/Kolkata', mfa: true,
  },
  'locked.user@oneinsure.com': {
    id: 'demo-u-3', displayName: 'Locked User', email: 'locked.user@oneinsure.com', employeeCode: 'OIC-1003',
    department: 'Operations', designation: 'Executive', roles: ['Employee'], permissions: [], timeZone: 'Asia/Kolkata',
    mfa: false, locked: true,
  },
}

const MAX_ATTEMPTS = 5
const failures = new Map<string, number>()
const SESSION_KEY = 'oic.demo.session'
let pendingMfa: { token: string; key: string; remember: boolean } | null = null

const wait = (ms = 650) => new Promise((r) => setTimeout(r, ms))
const lockedError = () =>
  new ApiError(423, 'ACCOUNT_LOCKED', 'This account is temporarily locked.', {
    lockedUntilUtc: new Date(Date.now() + 15 * 60_000).toISOString(),
  })

function startSession(key: string, remember: boolean) {
  const store = remember ? localStorage : sessionStorage
  store.setItem(SESSION_KEY, key)
}

function publicUser(key: string): UserSummary {
  const { mfa: _mfa, locked: _locked, ...u } = users[key]
  return u
}

export const demoAuthApi: AuthApi = {
  async me() {
    await wait(200)
    const key = sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY)
    return key && users[key] ? publicUser(key) : null
  },

  async login({ login, password, rememberMe }) {
    await wait()
    const key = login.trim().toLowerCase()
    const user = users[key] ?? Object.values(users).find((u) => u.employeeCode.toLowerCase() === key)
    const userKey = user ? (Object.keys(users).find((k) => users[k] === user) as string) : key
    if (user?.locked || (failures.get(userKey) ?? 0) >= MAX_ATTEMPTS) throw lockedError()
    if (!user || password !== DEMO_PASSWORD) {
      const count = (failures.get(userKey) ?? 0) + 1
      failures.set(userKey, count)
      if (count >= MAX_ATTEMPTS) throw lockedError()
      // Same message for unknown user and wrong password (no account enumeration).
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'The email/employee ID or password is incorrect.', {
        remainingAttempts: user ? MAX_ATTEMPTS - count : undefined,
      })
    }
    failures.delete(userKey)
    if (user.mfa) {
      pendingMfa = { token: `demo-mfa-${Date.now()}`, key: userKey, remember: rememberMe }
      return { status: 'MFA_REQUIRED', mfaToken: pendingMfa.token, methods: ['TOTP', 'EMAIL_OTP'], maskedEmail: 'an****@oneinsure.com' }
    }
    startSession(userKey, rememberMe)
    return { status: 'SUCCESS', user: publicUser(userKey) }
  },

  async verifyMfa({ mfaToken, code }) {
    await wait()
    if (!pendingMfa || pendingMfa.token !== mfaToken) throw new ApiError(401, 'MFA_EXPIRED', 'Your verification session has expired. Please sign in again.')
    if (code !== DEMO_MFA_CODE) throw new ApiError(400, 'INVALID_MFA_CODE', 'That code is incorrect or has expired.')
    startSession(pendingMfa.key, pendingMfa.remember)
    const u = publicUser(pendingMfa.key)
    pendingMfa = null
    return u
  },

  async resendMfa() {
    await wait(400)
  },

  async forgotPassword() {
    await wait()
  },

  async resetPassword({ token }) {
    await wait()
    if (token !== DEMO_RESET_TOKEN) throw new ApiError(400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.')
  },

  async changePassword({ currentPassword }) {
    await wait()
    if (currentPassword !== DEMO_PASSWORD) throw new ApiError(400, 'INVALID_CREDENTIALS', 'Your current password is incorrect.')
  },

  async logout() {
    await wait(200)
    sessionStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(SESSION_KEY)
  },
}
