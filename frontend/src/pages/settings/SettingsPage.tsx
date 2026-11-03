import { useState, type FormEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Building2, IdCard, KeyRound, Laptop, Lock, LogOut, Mail, MapPin, ShieldCheck, ShieldOff, Smartphone, UserRound } from 'lucide-react'
import { accountApi, type SessionInfo, type TotpSetup } from '../../api/account'
import { ApiError } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { Avatar } from '../../components/ui/Avatar'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { PageHeader } from '../../components/ui/Data'
import { Alert, Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { Checkbox, PasswordField, TextField } from '../../components/ui/Field'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { CopyButton, RecoveryCodeList, ShownOnceNotice } from '../../components/ui/Secret'
import { useToast } from '../../components/ui/Toast'
import { DEFAULT_TIME_ZONE } from '../../config'
import { formatDate, formatDateTime } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { AvailabilityCard } from './AvailabilityCard'

const stagger = {
  container: { animate: { transition: { staggerChildren: 0.04 } } },
  item: { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } } },
}

export function SettingsPage() {
  const { can } = useAuth()
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" description="Your profile, sign-in security and availability." />
      <motion.div variants={stagger.container} initial="initial" animate="animate" className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <motion.div variants={stagger.item} className="flex flex-col gap-5">
          <ProfileCard />
          <PasswordCard />
        </motion.div>
        <motion.div variants={stagger.item} className="flex flex-col gap-5 xl:col-span-2">
          <TwoFactorCard />
          <SessionsCard />
          {can('calendar.view') && <AvailabilityCard />}
        </motion.div>
      </motion.div>
    </div>
  )
}

// ---- Profile ----------------------------------------------------------------

function ProfileCard() {
  const { user } = useAuth()
  if (!user) return null
  const rows: { icon: ReactNode; label: string; value: string }[] = [
    { icon: <Mail className="size-4" />, label: 'Official email', value: user.email },
    { icon: <IdCard className="size-4" />, label: 'Employee code', value: user.employeeCode || '—' },
    { icon: <Building2 className="size-4" />, label: 'Department', value: user.department || '—' },
    { icon: <UserRound className="size-4" />, label: 'Designation', value: user.designation || '—' },
    { icon: <MapPin className="size-4" />, label: 'Time zone', value: user.timeZone || DEFAULT_TIME_ZONE },
  ]
  return (
    <Card>
      <div className="flex items-center gap-4 border-b border-line px-5 py-5">
        <Avatar name={user.displayName} src={user.photoUrl} size={56} />
        <div className="min-w-0">
          <p className="truncate text-[17px] leading-[26px] font-semibold text-ink">{user.displayName}</p>
          <p className="truncate text-[13px] text-ink-secondary">{user.designation}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {user.roles.map((r) => (
              <Badge key={r} tone="brand">
                {r}
              </Badge>
            ))}
          </div>
        </div>
      </div>
      <dl className="flex flex-col gap-3.5 px-5 py-4">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3">
            <span className="mt-0.5 text-ink-muted">{r.icon}</span>
            <div className="min-w-0">
              <dt className="text-[12px] text-ink-secondary">{r.label}</dt>
              <dd className="text-[13.5px] font-medium break-words text-ink">{r.value}</dd>
            </div>
          </div>
        ))}
      </dl>
      <p className="border-t border-line px-5 py-3 text-[12px] text-ink-secondary">Profile details come from the employee master. Ask HR or an administrator to correct them.</p>
    </Card>
  )
}

function PasswordCard() {
  return (
    <Card>
      <CardHeader title="Password" subtitle="Changing it signs out your other sessions." />
      <div className="px-5 pb-5">
        <ButtonLink to="/change-password" variant="secondary" leftIcon={<KeyRound className="size-4" />}>
          Change password
        </ButtonLink>
      </div>
    </Card>
  )
}

// ---- Two-factor authentication ----------------------------------------------

function TwoFactorCard() {
  const { user } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const toast = useToast()
  const { data: status, error, loading, reload } = useLoader(() => accountApi.mfaStatus(), [], 'Unable to load your two-factor settings.')
  const [dialog, setDialog] = useState<'enable' | 'regenerate' | 'disable' | null>(null)

  return (
    <Card>
      <CardHeader
        title="Two-factor authentication"
        subtitle="A code from an authenticator app (Microsoft or Google Authenticator) is required at sign-in."
        action={status && <Badge tone={status.enabled ? 'success' : 'neutral'} dot>{status.enabled ? 'On' : 'Off'}</Badge>}
      />
      <div className="px-5 pb-5">
        {error ? (
          <ErrorState title="Unable to load two-factor settings" description={error} onRetry={reload} />
        ) : loading && !status ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-48" />
          </div>
        ) : status?.enabled ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-md border border-success/20 bg-success-soft px-4 py-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
              <div className="text-[13px] leading-5 text-[#166534]">
                <p className="font-semibold">Authenticator app is on{status.enabledUtc ? ` since ${formatDate(status.enabledUtc, tz)}` : ''}.</p>
                <p className="opacity-90">
                  {status.recoveryCodesRemaining} of 10 recovery codes left. Each one signs you in once if you lose your phone.
                </p>
              </div>
            </div>
            {status.recoveryCodesRemaining <= 3 && (
              <Alert tone="warning" title="Running low on recovery codes">
                Generate a new set so you are not locked out if you lose your phone.
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" leftIcon={<KeyRound className="size-4" />} onClick={() => setDialog('regenerate')}>
                New recovery codes
              </Button>
              <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" leftIcon={<ShieldOff className="size-4" />} onClick={() => setDialog('disable')}>
                Turn off
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[13.5px] text-ink-secondary">
              Two-factor authentication is <strong className="text-ink">off</strong>. Turn it on to protect your account even if your password is stolen.
            </p>
            <div>
              <Button leftIcon={<Smartphone className="size-4" />} onClick={() => setDialog('enable')}>
                Set up authenticator app
              </Button>
            </div>
          </div>
        )}
      </div>

      <EnableMfaDialog
        open={dialog === 'enable'}
        onClose={(enabled) => {
          setDialog(null)
          if (enabled) {
            toast.success('Two-factor authentication is on.')
            reload()
          }
        }}
      />
      <RegenerateCodesDialog
        open={dialog === 'regenerate'}
        onClose={(done) => {
          setDialog(null)
          if (done) reload()
        }}
      />
      <DisableMfaDialog
        open={dialog === 'disable'}
        onClose={(done) => {
          setDialog(null)
          if (done) {
            toast.success('Two-factor authentication is off.')
            reload()
          }
        }}
      />
    </Card>
  )
}

const onlyDigits = (v: string) => v.replace(/\D/g, '').slice(0, 6)

function CodeField({ value, onChange, error, label = 'Verification code', autoFocus }: { value: string; onChange: (v: string) => void; error?: string; label?: string; autoFocus?: boolean }) {
  return (
    <TextField
      label={label}
      value={value}
      onChange={(e) => onChange(onlyDigits(e.target.value))}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="6-digit code"
      maxLength={6}
      error={error}
      data-autofocus={autoFocus || undefined}
      className="[&_input]:font-semibold [&_input]:tracking-[0.3em] [&_input]:tabular-nums"
    />
  )
}

/** Groups the base32 secret in fours for manual entry ("ABCD EFGH …"). */
const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim()

function EnableMfaDialog({ open, onClose }: { open: boolean; onClose: (enabled: boolean) => void }) {
  const [step, setStep] = useState<'password' | 'scan' | 'codes'>('password')
  const [password, setPassword] = useState('')
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string>()
  const [error, setError] = useState<string | null>(null)

  function close() {
    const enabled = step === 'codes'
    // Secrets live only in this component: wipe them as soon as the dialog closes.
    setStep('password')
    setPassword('')
    setSetup(null)
    setCode('')
    setCodes([])
    setSaved(false)
    setFieldError(undefined)
    setError(null)
    onClose(enabled)
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault()
    if (!password) return setFieldError('Enter your current password.')
    setBusy(true)
    setError(null)
    setFieldError(undefined)
    try {
      setSetup(await accountApi.setupTotp(password))
      setPassword('')
      setStep('scan')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setFieldError(err.message)
      else setError(err instanceof Error ? err.message : 'Could not start the set-up.')
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault()
    if (code.length !== 6) return setFieldError('Enter the 6-digit code from the app.')
    setBusy(true)
    setError(null)
    setFieldError(undefined)
    try {
      const r = await accountApi.confirmTotp(code)
      setCodes(r.recoveryCodes)
      setSetup(null)
      setStep('codes')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_MFA_CODE') setFieldError(err.message)
      else setError(err instanceof Error ? err.message : 'Could not verify the code.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const titles = { password: 'Set up authenticator app', scan: 'Scan the QR code', codes: 'Save your recovery codes' }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={titles[step]}
      description={`Step ${step === 'password' ? 1 : step === 'scan' ? 2 : 3} of 3`}
      dismissible={!busy && step !== 'codes'}
      size="md"
      footer={
        step === 'password' ? (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" form="mfa-password" loading={busy}>Continue</Button>
          </>
        ) : step === 'scan' ? (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" form="mfa-confirm" loading={busy}>Verify &amp; turn on</Button>
          </>
        ) : (
          <Button onClick={close} disabled={!saved}>Done</Button>
        )
      }
    >
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {step === 'password' && (
        <form id="mfa-password" onSubmit={submitPassword} noValidate className="flex flex-col gap-4">
          <p className="text-[13.5px] text-ink-secondary">Confirm it's you before changing your sign-in security.</p>
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            leftIcon={<Lock className="size-[18px]" />}
            value={password}
            onChange={(e) => (setPassword(e.target.value), setFieldError(undefined))}
            error={fieldError}
            data-autofocus
          />
        </form>
      )}
      {step === 'scan' && setup && (
        <form id="mfa-confirm" onSubmit={submitCode} noValidate className="flex flex-col gap-5">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13.5px] text-ink-secondary marker:font-semibold marker:text-ink">
            <li>Open Microsoft Authenticator or Google Authenticator on your phone.</li>
            <li>Add an account and scan this QR code.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <div className="flex flex-col items-center gap-4 rounded-md border border-line bg-surface-muted p-4 sm:flex-row sm:items-start">
            <img src={setup.qrCodeDataUrl} alt="QR code to add OneInsure Connect to your authenticator app" className="size-44 shrink-0 rounded-sm border border-line bg-white p-2" />
            <div className="min-w-0 text-center sm:text-left">
              <p className="text-[13px] font-semibold text-ink">Can't scan it?</p>
              <p className="mt-0.5 text-[12.5px] text-ink-secondary">Choose "Enter a setup key" in the app, type this key and select time-based.</p>
              <code className="mt-2 block font-mono text-[14px] font-semibold tracking-wide break-all text-ink select-all" aria-label="Setup key">
                {groupSecret(setup.secret)}
              </code>
              <CopyButton text={setup.secret} label="Copy key" className="mt-2" />
            </div>
          </div>
          <CodeField value={code} onChange={(v) => (setCode(v), setFieldError(undefined))} error={fieldError} autoFocus />
        </form>
      )}
      {step === 'codes' && (
        <div className="flex flex-col gap-4">
          <ShownOnceNotice>
            <strong className="font-semibold">Store these codes safely. They are shown only once.</strong> If you lose your phone, each code signs you in one time. Keep them in a password manager or a printed copy, not on the phone itself.
          </ShownOnceNotice>
          <RecoveryCodeList codes={codes} />
          <Checkbox label="I have saved my recovery codes somewhere safe" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        </div>
      )}
    </Dialog>
  )
}

function RegenerateCodesDialog({ open, onClose }: { open: boolean; onClose: (done: boolean) => void }) {
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string>()
  const [error, setError] = useState<string | null>(null)

  function close() {
    const done = !!codes
    setCode('')
    setCodes(null)
    setSaved(false)
    setFieldError(undefined)
    setError(null)
    onClose(done)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (code.length !== 6) return setFieldError('Enter the 6-digit code from your authenticator app.')
    setBusy(true)
    setError(null)
    try {
      setCodes((await accountApi.regenerateRecoveryCodes(code)).recoveryCodes)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_MFA_CODE') setFieldError(err.message)
      else setError(err instanceof Error ? err.message : 'Could not create new codes.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New recovery codes"
      dismissible={!busy && !codes}
      footer={
        codes ? (
          <Button onClick={close} disabled={!saved}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" form="mfa-regenerate" loading={busy}>Generate new codes</Button>
          </>
        )
      }
    >
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {codes ? (
        <div className="flex flex-col gap-4">
          <ShownOnceNotice>
            <strong className="font-semibold">Store these codes safely. They are shown only once.</strong> Your previous recovery codes no longer work.
          </ShownOnceNotice>
          <RecoveryCodeList codes={codes} />
          <Checkbox label="I have saved my recovery codes somewhere safe" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        </div>
      ) : (
        <form id="mfa-regenerate" onSubmit={submit} noValidate className="flex flex-col gap-4">
          <p className="text-[13.5px] text-ink-secondary">This replaces all your existing recovery codes. Enter a current code from your authenticator app to continue.</p>
          <CodeField value={code} onChange={(v) => (setCode(v), setFieldError(undefined))} error={fieldError} autoFocus />
        </form>
      )}
    </Dialog>
  )
}

function DisableMfaDialog({ open, onClose }: { open: boolean; onClose: (done: boolean) => void }) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [errors, setErrors] = useState<{ password?: string; code?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function close(done = false) {
    setPassword('')
    setCode('')
    setErrors({})
    setError(null)
    onClose(done)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = { password: password ? undefined : 'Enter your current password.', code: code.trim() ? undefined : 'Enter a code from your app or a recovery code.' }
    setErrors(v)
    if (v.password || v.code) return
    setBusy(true)
    setError(null)
    try {
      await accountApi.disableMfa({ currentPassword: password, code: code.trim() })
      close(true)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') setErrors({ password: err.message })
      else if (err instanceof ApiError && err.code === 'INVALID_MFA_CODE') setErrors({ code: err.message })
      else setError(err instanceof Error ? err.message : 'Could not turn off two-factor authentication.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => close()}
      title="Turn off two-factor authentication?"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => close()} disabled={busy}>Cancel</Button>
          <Button variant="danger" type="submit" form="mfa-disable" loading={busy}>Turn off</Button>
        </>
      }
    >
      <form id="mfa-disable" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Alert tone="warning">Your account will be protected by your password only. Your recovery codes will stop working.</Alert>
        {error && <Alert tone="danger">{error}</Alert>}
        <PasswordField
          label="Current password"
          autoComplete="current-password"
          leftIcon={<Lock className="size-[18px]" />}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          data-autofocus
        />
        <TextField
          label="Authenticator code or recovery code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 11))}
          autoComplete="one-time-code"
          placeholder="123456 or XXXXX-XXXXX"
          error={errors.code}
        />
      </form>
    </Dialog>
  )
}

// ---- Sessions -----------------------------------------------------------------

function describeAgent(ua: string | null) {
  if (!ua) return { name: 'Unknown device', mobile: false }
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return { name: os ? `${browser} on ${os}` : browser, mobile: /Mobile|Android|iPhone|iPad/.test(ua) }
}

function SessionsCard() {
  const { user } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const toast = useToast()
  const { data, error, loading, reload } = useLoader(() => accountApi.sessions(), [], 'Unable to load your active sessions.')
  const [revoke, setRevoke] = useState<SessionInfo | 'others' | null>(null)
  const others = (data ?? []).filter((s) => !s.current)

  return (
    <Card>
      <CardHeader
        title="Active sessions"
        subtitle="Browsers and devices currently signed in to your account."
        action={
          others.length > 0 && (
            <Button variant="secondary" size="sm" leftIcon={<LogOut className="size-3.5" />} onClick={() => setRevoke('others')}>
              <span className="hidden sm:inline">Sign out all others</span>
              <span className="sm:hidden">Sign out others</span>
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState title="Unable to load sessions" description={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="flex flex-col gap-3 px-5 pb-5" aria-busy="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : !data?.length ? (
        <EmptyState icon={<Laptop className="size-6" />} title="No active sessions" />
      ) : (
        <ul className="border-t border-line">
          {data.map((s) => {
            const d = describeAgent(s.userAgent)
            return (
              <li key={s.id} className="flex flex-col gap-3 border-b border-line px-5 py-3.5 last:border-b-0 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-500">
                    {d.mobile ? <Smartphone className="size-5" /> : <Laptop className="size-5" />}
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">
                      {d.name}
                      {s.current && <Badge tone="success" dot>This device</Badge>}
                    </p>
                    <p className="text-[12px] text-ink-secondary">
                      {s.ipAddress ?? 'Unknown IP'} · Signed in {formatDateTime(s.createdUtc, tz)} · Last active {formatDateTime(s.lastSeenUtc, tz)}
                    </p>
                  </div>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="sm" className="self-start text-danger hover:bg-danger-soft hover:text-danger sm:self-center" onClick={() => setRevoke(s)}>
                    Sign out
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <ConfirmDialog
        open={revoke !== null}
        onClose={() => setRevoke(null)}
        title={revoke === 'others' ? 'Sign out all other sessions?' : 'Sign out this session?'}
        confirmLabel="Sign out"
        onConfirm={async () => {
          const targets = revoke === 'others' ? others : revoke ? [revoke] : []
          for (const s of targets) await accountApi.revokeSession(s.id)
          toast.success(targets.length > 1 ? `${targets.length} sessions signed out.` : 'Session signed out.')
          reload()
        }}
      >
        {revoke === 'others'
          ? `Every other browser and device (${others.length}) will be signed out immediately. This device stays signed in.`
          : revoke
            ? `${describeAgent(revoke.userAgent).name} (${revoke.ipAddress ?? 'unknown IP'}) will be signed out immediately.`
            : null}
      </ConfirmDialog>
    </Card>
  )
}
