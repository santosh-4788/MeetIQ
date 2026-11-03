import { useLocation } from 'react-router-dom'
import { Clock, Headset, LockKeyhole, LogOut, ShieldAlert } from 'lucide-react'
import { AuthCard, AuthHeading } from '../../layouts/AuthLayout'
import { Button, ButtonLink } from '../../components/ui/Button'
import { useAuth } from '../../auth/AuthContext'
import { SUPPORT } from '../../config'

function SupportNote() {
  return (
    <div className="mt-6 flex items-start gap-3 rounded-md bg-canvas p-3.5 text-[12.5px] text-ink-secondary">
      <Headset className="mt-0.5 size-4 shrink-0 text-brand-500" />
      <p>
        Contact IT Support at{' '}
        <a href={`mailto:${SUPPORT.email}`} className="font-semibold text-brand-700 hover:underline">
          {SUPPORT.email}
        </a>
        <br />
        {SUPPORT.hours}
      </p>
    </div>
  )
}

export function AccountLockedPage() {
  const until = (useLocation().state as { lockedUntilUtc?: string } | null)?.lockedUntilUtc
  const untilText = until
    ? new Date(until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : null
  return (
    <AuthCard>
      <AuthHeading
        tone="danger"
        icon={<LockKeyhole className="size-6" />}
        title="Account temporarily locked"
        description={
          <>
            Your account was locked after multiple unsuccessful sign-in attempts, to protect it from unauthorised access.
            {untilText ? <> You can try again after <strong className="text-ink">{untilText} IST</strong>, or reset your password now.</> : ' Reset your password or contact support to unlock it.'}
          </>
        }
      />
      <div className="flex flex-col gap-3">
        <ButtonLink to="/forgot-password" fullWidth size="lg">Reset password</ButtonLink>
        <ButtonLink to="/login" fullWidth size="lg" variant="secondary">Back to sign in</ButtonLink>
      </div>
      <SupportNote />
    </AuthCard>
  )
}

export function SessionExpiredPage() {
  return (
    <AuthCard>
      <AuthHeading
        tone="warning"
        icon={<Clock className="size-6" />}
        title="Your session has expired"
        description="For your security, you were signed out (after a period of inactivity, or because the session was ended on the server or from another device). Please sign in again to continue."
      />
      <ButtonLink to="/login" fullWidth size="lg">Sign in again</ButtonLink>
    </AuthCard>
  )
}

export function AccessDeniedPage() {
  const { status, can, signOut } = useAuth()
  const signedIn = status === 'authenticated'
  // Without dashboard.view (e.g. an account that has no role yet) "Back to dashboard" would loop back here.
  const home = signedIn && can('dashboard.view')
  return (
    <AuthCard>
      <AuthHeading
        tone="danger"
        icon={<ShieldAlert className="size-6" />}
        title="Access denied"
        description={
          signedIn && !home
            ? "Your account doesn't have access to OneInsure Connect yet. Ask your administrator to assign you a role, then sign in again."
            : "You don't have permission to view this page. If you believe this is a mistake, ask your administrator to review your role."
        }
      />
      <div className="flex flex-col gap-3">
        {home ? (
          <ButtonLink to="/dashboard" fullWidth size="lg">Back to dashboard</ButtonLink>
        ) : !signedIn ? (
          <ButtonLink to="/login" fullWidth size="lg">Go to sign in</ButtonLink>
        ) : null}
        {signedIn && (
          <Button fullWidth size="lg" variant={home ? 'secondary' : 'primary'} leftIcon={<LogOut className="size-[18px]" />} onClick={() => void signOut('user')}>
            Sign out
          </Button>
        )}
      </div>
      <SupportNote />
    </AuthCard>
  )
}
