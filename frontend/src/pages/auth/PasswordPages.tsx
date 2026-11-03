import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, KeyRound, Lock, MailCheck, UserRound } from 'lucide-react'
import { authApi } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import { AuthCard, AuthHeading } from '../../layouts/AuthLayout'
import { Button, ButtonLink } from '../../components/ui/Button'
import { PasswordField, TextField } from '../../components/ui/Field'
import { Alert } from '../../components/ui/Feedback'
import { cn } from '../../lib/cn'
import { passwordRules, passwordStrength, validateLoginId } from '../../lib/validation'
import { DEMO_MODE } from '../../config'
import { DEMO_RESET_TOKEN } from '../../dev/demoAuth'

function BackToLogin() {
  return (
    <Link to="/login" className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink-secondary hover:text-ink">
      <ArrowLeft className="size-4" /> Back to sign in
    </Link>
  )
}

// ---------------------------------------------------------------------------

export function ForgotPasswordPage() {
  const [login, setLogin] = useState('')
  const [error, setError] = useState<string>()
  const [formError, setFormError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const v = validateLoginId(login)
    setError(v)
    if (v) return
    setSubmitting(true)
    setFormError(null)
    try {
      await authApi.forgotPassword({ login: login.trim() })
      setSent(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setSubmitting(false)
    }
  }

  if (sent)
    return (
      <AuthCard>
        <AuthHeading
          tone="success"
          icon={<MailCheck className="size-6" />}
          title="Check your email"
          description="If an account exists for these details, we have sent a password reset link to the registered official email. The link expires in 30 minutes."
        />
        {DEMO_MODE && (
          <Alert tone="warning" title="Demo mode">
            No email is sent in demo mode.{' '}
            <Link className="font-semibold underline" to={`/reset-password?token=${DEMO_RESET_TOKEN}`}>
              Open the demo reset link
            </Link>
          </Alert>
        )}
        <BackToLogin />
      </AuthCard>
    )

  return (
    <AuthCard>
      <AuthHeading icon={<KeyRound className="size-6" />} title="Forgot your password?" description="Enter your official email or employee ID and we'll email you a secure reset link." />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <TextField
          label="Official Email / Employee ID"
          autoComplete="username"
          placeholder="name@oneinsure.com or OIC-1001"
          leftIcon={<UserRound className="size-[18px]" />}
          value={login}
          onChange={(e) => (setLogin(e.target.value), setError(undefined))}
          error={error}
          autoFocus
        />
        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Send reset link
        </Button>
      </form>
      <BackToLogin />
    </AuthCard>
  )
}

// ---------------------------------------------------------------------------

function NewPasswordFields({ value, onChange, confirm, onConfirm, errors }: {
  value: string; onChange: (v: string) => void; confirm: string; onConfirm: (v: string) => void; errors: { password?: string; confirm?: string }
}) {
  const strength = passwordStrength(value)
  const barColor = ['bg-line', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'][strength.score]
  return (
    <>
      <div>
        <PasswordField label="New password" autoComplete="new-password" leftIcon={<Lock className="size-[18px]" />} value={value} onChange={(e) => onChange(e.target.value)} error={errors.password} />
        <div className="mt-2.5 flex items-center gap-2" aria-live="polite">
          <div className="grid flex-1 grid-cols-4 gap-1">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={cn('h-1.5 rounded-full transition-colors duration-300', i <= strength.score ? barColor : 'bg-line')} />
            ))}
          </div>
          <span className="w-20 text-right text-[12px] font-semibold text-ink-secondary">{strength.label}</span>
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {passwordRules.map((r) => {
            const ok = r.test(value)
            return (
              <li key={r.id} className={cn('flex items-center gap-1.5 text-[12px] transition-colors', ok ? 'text-success' : 'text-ink-muted')}>
                <span className={cn('flex size-4 items-center justify-center rounded-full', ok ? 'bg-success text-white' : 'border border-line-strong')}>
                  {ok && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                {r.label}
              </li>
            )
          })}
        </ul>
      </div>
      <PasswordField label="Confirm new password" autoComplete="new-password" leftIcon={<Lock className="size-[18px]" />} value={confirm} onChange={(e) => onConfirm(e.target.value)} error={errors.confirm} />
    </>
  )
}

function validateNew(password: string, confirm: string) {
  return {
    password: passwordStrength(password).valid ? undefined : 'Password does not meet all the requirements.',
    confirm: !confirm ? 'Confirm your new password.' : confirm !== password ? 'Passwords do not match.' : undefined,
  }
}

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  if (!token)
    return (
      <AuthCard>
        <AuthHeading tone="danger" icon={<KeyRound className="size-6" />} title="Invalid reset link" description="This password reset link is missing or malformed. Request a new link to continue." />
        <ButtonLink to="/forgot-password" fullWidth size="lg">Request a new link</ButtonLink>
        <BackToLogin />
      </AuthCard>
    )

  if (done)
    return (
      <AuthCard>
        <AuthHeading tone="success" icon={<Check className="size-6" />} title="Password updated" description="Your password has been reset and all other sessions were signed out. You can now sign in with your new password." />
        <ButtonLink to="/login" fullWidth size="lg">Go to sign in</ButtonLink>
      </AuthCard>
    )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const v = validateNew(password, confirm)
    setErrors(v)
    if (v.password || v.confirm) return
    setSubmitting(true)
    setFormError(null)
    try {
      await authApi.resetPassword({ token: token!, newPassword: password })
      setDone(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Reset failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard>
      <AuthHeading icon={<KeyRound className="size-6" />} title="Set a new password" description="Choose a strong password you haven't used before." />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {formError && (
          <Alert tone="danger">
            {formError}{' '}
            <Link to="/forgot-password" className="font-semibold underline">
              Request a new link
            </Link>
          </Alert>
        )}
        <NewPasswordFields value={password} onChange={setPassword} confirm={confirm} onConfirm={setConfirm} errors={errors} />
        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Reset password
        </Button>
      </form>
      <BackToLogin />
    </AuthCard>
  )
}

// ---------------------------------------------------------------------------

export function ChangePasswordPage() {
  const navigate = useNavigate()
  const { status, user, signIn } = useAuth()
  const forced = !!(useLocation().state as { forced?: boolean } | null)?.forced || !!user?.mustChangePassword
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ current?: string; password?: string; confirm?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  if (status === 'loading') return null
  if (status === 'anonymous')
    return (
      <AuthCard>
        <AuthHeading tone="warning" icon={<Lock className="size-6" />} title="Sign in required" description="Sign in first to change your password." />
        <ButtonLink to="/login" fullWidth size="lg">Go to sign in</ButtonLink>
      </AuthCard>
    )

  if (done)
    return (
      <AuthCard>
        <AuthHeading tone="success" icon={<Check className="size-6" />} title="Password changed" description="Your password was changed successfully. Other active sessions have been signed out." />
        <Button fullWidth size="lg" onClick={() => navigate('/dashboard', { replace: true })}>
          Continue to dashboard
        </Button>
      </AuthCard>
    )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const v = { current: current ? undefined : 'Enter your current password.', ...validateNew(password, confirm) }
    if (!v.password && password === current) v.password = 'New password must be different from the current password.'
    setErrors(v)
    if (v.current || v.password || v.confirm) return
    setSubmitting(true)
    setFormError(null)
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: password })
      if (user) signIn({ ...user, mustChangePassword: false })
      setDone(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Password change failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthCard wide>
      <AuthHeading
        icon={<KeyRound className="size-6" />}
        title="Change password"
        description={forced ? 'Your password must be changed before you continue.' : 'Update the password you use to sign in to OneInsure Connect.'}
      />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <PasswordField label="Current password" autoComplete="current-password" leftIcon={<Lock className="size-[18px]" />} value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} />
        <NewPasswordFields value={password} onChange={setPassword} confirm={confirm} onConfirm={setConfirm} errors={errors} />
        <div className="flex flex-col-reverse gap-3 sm:flex-row">
          {!forced && (
            <Button variant="secondary" size="lg" className="sm:flex-1" onClick={() => navigate(-1)}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="lg" className="sm:flex-1" loading={submitting}>
            Update password
          </Button>
        </div>
      </form>
    </AuthCard>
  )
}
