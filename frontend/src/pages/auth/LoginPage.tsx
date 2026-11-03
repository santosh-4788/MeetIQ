import { useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Lock, ShieldCheck, UserRound } from 'lucide-react'
import { authApi } from '../../api'
import { ApiError } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { AuthCard } from '../../layouts/AuthLayout'
import { Button } from '../../components/ui/Button'
import { Checkbox, PasswordField, TextField } from '../../components/ui/Field'
import { Alert } from '../../components/ui/Feedback'
import { validateLoginId } from '../../lib/validation'
import { DEMO_MODE } from '../../config'
import { DemoCredentials } from './DemoCredentials'
import { OneInsureLogo } from '../../components/brand/OneInsureLogo'

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn } = useAuth()
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'

  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [errors, setErrors] = useState<{ login?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const loginRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const validate = () => {
    const next = { login: validateLoginId(login), password: password ? undefined : 'Enter your password.' }
    setErrors(next)
    if (next.login) loginRef.current?.focus()
    else if (next.password) passwordRef.current?.focus()
    return !next.login && !next.password
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!validate()) return
    setSubmitting(true)
    try {
      const result = await authApi.login({ login: login.trim(), password, rememberMe: remember })
      if (result.status === 'MFA_REQUIRED') {
        navigate('/mfa', { state: { mfaToken: result.mfaToken, methods: result.methods, maskedEmail: result.maskedEmail, from } })
      } else if (result.status === 'PASSWORD_CHANGE_REQUIRED') {
        signIn(result.user)
        navigate('/change-password', { replace: true, state: { forced: true } })
      } else {
        signIn(result.user)
        navigate(from, { replace: true })
      }
    } catch (err) {
      setPassword('')
      if (err instanceof ApiError && err.code === 'ACCOUNT_LOCKED') {
        navigate('/account-locked', { state: { lockedUntilUtc: err.details.lockedUntilUtc } })
        return
      }
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        const left = err.details.remainingAttempts as number | undefined
        setFormError(left !== undefined && left <= 3 ? `${err.message} ${left} attempt${left === 1 ? '' : 's'} left before the account is locked.` : err.message)
      } else if (err instanceof ApiError && err.code === 'ACCOUNT_DISABLED') {
        setFormError('Your account has been deactivated. Please contact your administrator.')
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setFormError('Too many sign-in attempts. Please wait a minute and try again.')
      } else {
        setFormError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.')
      }
      passwordRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="w-full max-w-[440px]">
      <AuthCard>
        <div className="mb-7 short:mb-6">
          <OneInsureLogo height={40} className="mb-6 -ml-1.5 short:mb-5 short:h-[36px]! tiny:mb-4 tiny:h-[32px]!" />
          <h1 className="text-[26px] leading-8 font-bold tracking-[-0.02em] text-ink">Welcome back!</h1>
          <p className="mt-1.5 text-[14px] text-ink-secondary">Sign in to your OneInsure Connect account.</p>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4.5 short:gap-4">
          {formError && <Alert tone="danger">{formError}</Alert>}
          <TextField
            ref={loginRef}
            label="Official Email / Employee ID"
            name="username"
            autoComplete="username"
            placeholder="name@oneinsure.com or OIC-1001"
            leftIcon={<UserRound className="size-[18px]" />}
            value={login}
            onChange={(e) => {
              setLogin(e.target.value)
              if (errors.login) setErrors((x) => ({ ...x, login: undefined }))
            }}
            onBlur={() => login && setErrors((x) => ({ ...x, login: validateLoginId(login) }))}
            error={errors.login}
            autoFocus
            spellCheck={false}
            autoCapitalize="none"
          />
          <PasswordField
            ref={passwordRef}
            label="Password"
            name="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            leftIcon={<Lock className="size-[18px]" />}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (errors.password) setErrors((x) => ({ ...x, password: undefined }))
            }}
            error={errors.password}
          />
          <div className="flex items-center justify-between">
            <Checkbox label="Remember me" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <Link to="/forgot-password" className="text-[13px] font-semibold text-brand-700 hover:text-brand-500 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={submitting}
            className="mt-1 bg-[linear-gradient(90deg,#1769AA,#2878E5)] hover:brightness-110 hover:bg-transparent"
            rightIcon={<ArrowRight className="size-[18px] transition-transform duration-200 group-hover/btn:translate-x-0.5" />}
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>

        <p className="mt-6 flex items-center justify-center gap-2 text-[12.5px] text-ink-secondary short:mt-5">
          <ShieldCheck className="size-4 text-success" />
          Secure Enterprise Communication Platform
        </p>
      </AuthCard>
      {DEMO_MODE && <DemoCredentials onPick={(l, p) => (setLogin(l), setPassword(p), setErrors({}), setFormError(null))} />}
    </div>
  )
}
