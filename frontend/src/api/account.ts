import { http } from './http'

// The signed-in user's own security settings: /api/v1/account (Settings page).

export type MfaStatus = { enabled: boolean; methods: string[]; recoveryCodesRemaining: number; enabledUtc: string | null }
export type TotpSetup = { secret: string; otpAuthUri: string; qrCodeDataUrl: string }
/** Shown once and never stored. */
export type RecoveryCodes = { recoveryCodes: string[] }
export type SessionInfo = { id: string; createdUtc: string; lastSeenUtc: string; ipAddress: string | null; userAgent: string | null; current: boolean }

export const accountApi = {
  mfaStatus: () => http<MfaStatus>('/account/mfa'),
  setupTotp: (currentPassword: string) => http<TotpSetup>('/account/mfa/totp/setup', { method: 'POST', body: { currentPassword } }),
  confirmTotp: (code: string) => http<RecoveryCodes>('/account/mfa/totp/confirm', { method: 'POST', body: { code } }),
  regenerateRecoveryCodes: (code: string) => http<RecoveryCodes>('/account/mfa/recovery-codes', { method: 'POST', body: { code } }),
  disableMfa: (req: { currentPassword: string; code: string }) => http<void>('/account/mfa/disable', { method: 'POST', body: req }),
  sessions: () => http<SessionInfo[]>('/account/sessions'),
  revokeSession: (id: string) => http<void>(`/account/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
}
