import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, KeyRound, Mail, ShieldCheck, Smartphone } from 'lucide-react'
import { authApi } from '../../api'
import { ApiError, type MfaMethod } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { AuthCard, AuthHeading } from '../../layouts/AuthLayout'
import { Button } from '../../components/ui/Button'
import { Checkbox, TextField } from '../../components/ui/Field'
import { Alert } from '../../components/ui/Feedback'
import { cn } from '../../lib/cn'
import { DEMO_MODE } from '../../config'

type MfaState = { mfaToken: string; methods: MfaMethod[]; maskedEmail?: string; from?: string }
const LENGTH = 6
const RECOVERY_RE = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/

export function MfaPage() {
  const state = useLocation().state as MfaState | null
  if (!state?.mfaToken) return <Navigate to="/login" replace />
  return <MfaForm {...state} />
}

/** Upper-cases and inserts the hyphen as the user types: "abcde12345" → "ABCDE-12345". */
function formatRecovery(v: string) {
  const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
  return raw.length > 5 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw
}

function MfaForm({ mfaToken, methods, maskedEmail, from = '/dashboard' }: MfaState) {
  const navigate = useNavigate()
  const { signIn } = useAuth()
  // The server offers the authenticator app, plus e-mail codes when e-mail delivery is enabled;
  // single-use recovery codes are the fallback for a lost phone.
  const emailAvailable = methods.includes('EMAIL_OTP')
  const [channel, setChannel] = useState<'TOTP' | 'EMAIL_OTP'>('TOTP')
  const [cooldown, setCooldown] = useState(0)
  const [sentNotice, setSentNotice] = useState<string | null>(null)
  const [useRecovery, setUseRecovery] = useState(false)
  const [digits, setDigits] = useState<string[]>(Array(LENGTH).fill(''))
  const [recovery, setRecovery] = useState('')
  const [rememberDevice, setRememberDevice] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const recoveryInput = useRef<HTMLInputElement>(null)
  const switched = useRef(false)

  useEffect(() => {
    // Move focus only after the user switches mode (the first digit has autoFocus on load).
    if (!switched.current) return
    if (useRecovery) recoveryInput.current?.focus()
    else inputs.current[0]?.focus()
  }, [useRecovery])

  const code = digits.join('')

  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])

  async function sendEmailCode() {
    setError(null)
    setSentNotice(null)
    try {
      await authApi.resendMfa({ mfaToken, method: 'EMAIL_OTP' })
      setSentNotice(`We sent a 6-digit code to ${maskedEmail ?? 'your e-mail'}. It expires in 10 minutes.`)
      setCooldown(60)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_EXPIRED') {
        navigate('/login', { replace: true })
        return
      }
      setError(err instanceof Error ? err.message : 'The code could not be sent.')
    }
  }

  function chooseChannel(m: 'TOTP' | 'EMAIL_OTP') {
    if (m === channel) return
    switched.current = true
    setChannel(m)
    setError(null)
    setDigits(Array(LENGTH).fill(''))
    if (m === 'EMAIL_OTP' && cooldown === 0) void sendEmailCode()
    window.setTimeout(() => inputs.current[0]?.focus(), 0)
  }

  const setDigit = (i: number, v: string) => {
    const d = v.replace(/\D/g, '').slice(-1)
    setDigits((prev) => prev.map((x, j) => (j === i ? d : x)))
    setError(null)
    if (d && i < LENGTH - 1) inputs.current[i + 1]?.focus()
  }

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) inputs.current[i - 1]?.focus()
    if (e.key === 'ArrowLeft' && i > 0) inputs.current[i - 1]?.focus()
    if (e.key === 'ArrowRight' && i < LENGTH - 1) inputs.current[i + 1]?.focus()
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH)
    if (!pasted) return
    e.preventDefault()
    setDigits(Array.from({ length: LENGTH }, (_, i) => pasted[i] ?? ''))
    inputs.current[Math.min(pasted.length, LENGTH - 1)]?.focus()
  }

  function switchMode() {
    switched.current = true
    setUseRecovery((r) => !r)
    setError(null)
    setDigits(Array(LENGTH).fill(''))
    setRecovery('')
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const method: MfaMethod = useRecovery ? 'RECOVERY_CODE' : channel
    if (useRecovery ? !RECOVERY_RE.test(recovery) : code.length !== LENGTH) {
      setError(useRecovery ? 'Enter a recovery code in the format XXXXX-XXXXX.' : 'Enter the 6-digit verification code.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const user = await authApi.verifyMfa({ mfaToken, code: useRecovery ? recovery : code, method, rememberDevice })
      signIn(user)
      navigate(from, { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_EXPIRED') {
        navigate('/login', { replace: true })
        return
      }
      if (err instanceof ApiError && err.code === 'ACCOUNT_LOCKED') {
        navigate('/account-locked', { replace: true, state: { lockedUntilUtc: err.details.lockedUntilUtc } })
        return
      }
      setError(err instanceof Error ? err.message : 'Verification failed.')
      if (useRecovery) {
        recoveryInput.current?.select()
      } else {
        setDigits(Array(LENGTH).fill(''))
        inputs.current[0]?.focus()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard>
      <AuthHeading
        icon={useRecovery ? <KeyRound className="size-6" /> : <ShieldCheck className="size-6" />}
        title="Verify it's you"
        description={
          useRecovery
            ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once.'
            : channel === 'EMAIL_OTP'
              ? 'Enter the 6-digit code we sent to your e-mail.'
              : 'Enter the 6-digit code from your authenticator app.'
        }
      />

      {emailAvailable && !useRecovery && (
        <div role="tablist" aria-label="Verification method" className="mb-5 grid grid-cols-2 gap-1 rounded-md bg-canvas p-1">
          {(['TOTP', 'EMAIL_OTP'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={channel === m}
              onClick={() => chooseChannel(m)}
              className={cn(
                'inline-flex h-9 items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-semibold transition-colors duration-150',
                channel === m ? 'bg-surface text-ink shadow-card' : 'text-ink-secondary hover:text-ink',
              )}
            >
              {m === 'TOTP' ? <Smartphone className="size-4" /> : <Mail className="size-4" />}
              {m === 'TOTP' ? 'Authenticator app' : 'E-mail code'}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {sentNotice && channel === 'EMAIL_OTP' && !useRecovery && <Alert tone="info">{sentNotice}</Alert>}
        {useRecovery ? (
          <TextField
            ref={recoveryInput}
            label="Recovery code"
            value={recovery}
            onChange={(e) => (setRecovery(formatRecovery(e.target.value)), setError(null))}
            placeholder="XXXXX-XXXXX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={11}
            leftIcon={<KeyRound className="size-[18px]" />}
            className="[&_input]:font-mono [&_input]:text-[15px] [&_input]:font-semibold [&_input]:tracking-[0.12em]"
          />
        ) : (
          <fieldset>
            <legend className="sr-only">Verification code</legend>
            <div className="flex justify-between gap-2">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputs.current[i] = el
                  }}
                  value={d}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  onPaste={onPaste}
                  inputMode="numeric"
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={`Digit ${i + 1}`}
                  autoFocus={i === 0 && !switched.current}
                  maxLength={1}
                  className={cn(
                    'h-13 w-full min-w-0 rounded-md border bg-surface text-center text-[22px] font-bold text-ink tabular-nums outline-none transition-[border-color,box-shadow] duration-150',
                    error ? 'border-danger/60' : d ? 'border-brand-500/60' : 'border-line',
                    'focus:border-brand-500 focus:shadow-focus',
                  )}
                />
              ))}
            </div>
          </fieldset>
        )}
        {channel === 'EMAIL_OTP' && !useRecovery && (
          <p className="text-center text-[13px] text-ink-secondary">
            Didn't get it?{' '}
            <button type="button" disabled={cooldown > 0} onClick={() => void sendEmailCode()} className="font-semibold text-brand-700 hover:underline disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline">
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </p>
        )}
        <Checkbox label="Trust this device for 30 days" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Verify &amp; continue
        </Button>
        <p className="text-center text-[13px] text-ink-secondary">
          {useRecovery ? 'Have your phone? ' : 'Lost access to your authenticator app? '}
          <button type="button" onClick={switchMode} className="font-semibold text-brand-700 hover:underline">
            {useRecovery ? 'Use the authenticator app' : 'Use a recovery code instead'}
          </button>
        </p>
        {DEMO_MODE && !useRecovery && <p className="text-center text-[12px] text-warning-ink">Demo code: 246810</p>}
      </form>
      <Link to="/login" className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-secondary hover:text-ink">
        <ArrowLeft className="size-4" /> Back to sign in
      </Link>
    </AuthCard>
  )
}
