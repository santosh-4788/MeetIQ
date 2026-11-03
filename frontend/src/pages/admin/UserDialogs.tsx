import { useEffect, useState, type FormEvent } from 'react'
import { CircleAlert, Mail, UserRound } from 'lucide-react'
import { adminApi, type AdminUser, type CreatedUser, type Role } from '../../api/admin'
import { fieldErrors } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Alert, Badge, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { Dialog } from '../../components/ui/Overlay'
import { OneTimePassword } from '../../components/ui/Secret'
import { cn } from '../../lib/cn'
import { useLoader } from '../../lib/useLoader'

export const SUPER_ADMIN = 'SuperAdmin'

/** Role checklist from GET /admin/roles. Granting SuperAdmin needs roles.manage (server guard), so it is disabled otherwise. */
export function RolePicker({ value, onChange, error, disabled }: { value: string[]; onChange: (roles: string[]) => void; error?: string; disabled?: boolean }) {
  const { can } = useAuth()
  const { data: roles, error: loadError, loading, reload } = useLoader(() => adminApi.roles(), [], 'Unable to load the roles.')
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((r) => r !== code) : [...value, code])

  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={error ? 'role-picker-error' : undefined}>
      <legend className="mb-1.5 text-[13px] font-semibold text-ink">Roles</legend>
      {loadError ? (
        <Alert tone="danger">
          {loadError}{' '}
          <button type="button" onClick={reload} className="font-semibold underline">Try again</button>
        </Alert>
      ) : loading && !roles ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {(roles ?? []).map((r: Role) => {
            const locked = r.code === SUPER_ADMIN && !can('roles.manage')
            const checked = value.includes(r.code)
            return (
              <label
                key={r.code}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border px-3.5 py-2.5 transition-colors',
                  checked ? 'border-brand-500/50 bg-brand-50/60' : 'border-line hover:bg-surface-muted',
                  (locked || disabled) && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked || disabled}
                  onChange={() => toggle(r.code)}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-brand-500"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink">
                    {r.name}
                    {r.isSystem && <Badge tone="neutral">System</Badge>}
                  </span>
                  {r.description && <span className="block text-[12.5px] text-ink-secondary">{r.description}</span>}
                  {locked && <span className="block text-[12px] text-warning-ink">Needs the "manage roles" permission to grant.</span>}
                </span>
              </label>
            )
          })}
        </div>
      )}
      {error && (
        <p id="role-picker-error" role="alert" className="flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </fieldset>
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * Creates a sign-in account (POST /admin/users) and shows the one-time password once.
 * With `employee` the account is linked to that employee (Employee Management); otherwise the
 * administrator picks an employee or enters an e-mail address.
 */
export function CreateUserDialog({ open, onClose, employee }: { open: boolean; onClose: (created: boolean) => void; employee?: PickedEmployee }) {
  const [mode, setMode] = useState<'employee' | 'email'>('employee')
  const [picked, setPicked] = useState<PickedEmployee | null>(null)
  const [email, setEmail] = useState('')
  const [roles, setRoles] = useState<string[]>(['Employee'])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedUser | null>(null)

  function close() {
    const done = !!created
    // The one-time password lives only in this state: clear it as soon as the dialog closes.
    setCreated(null)
    setMode('employee')
    setPicked(null)
    setEmail('')
    setRoles(['Employee'])
    setErrors({})
    setError(null)
    onClose(done)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const target = employee ?? (mode === 'employee' ? picked : null)
    const v: Record<string, string> = {}
    if (!employee && mode === 'employee' && !picked) v.employeeId = 'Choose an employee.'
    if (!employee && mode === 'email' && !EMAIL_RE.test(email.trim())) v.email = 'Enter a valid e-mail address.'
    if (!roles.length) v.roles = 'Choose at least one role.'
    setErrors(v)
    if (Object.keys(v).length) return
    setBusy(true)
    setError(null)
    try {
      setCreated(await adminApi.createUser(target ? { employeeId: target.id, roles } : { email: email.trim(), roles }))
    } catch (err) {
      const fe = fieldErrors(err)
      setErrors(fe)
      if (!Object.keys(fe).length) setError(err instanceof Error ? err.message : 'The account could not be created.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={created ? 'User account created' : 'Create user account'}
      description={!created && employee ? `Sign-in account for ${employee.displayName}` : undefined}
      dismissible={!busy && !created}
      footer={
        created ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" form="create-user" loading={busy}>Create account</Button>
          </>
        )
      }
    >
      {created ? (
        <OneTimePassword value={created.oneTimePassword} account={created.email} />
      ) : (
        <form id="create-user" onSubmit={submit} noValidate className="flex flex-col gap-5">
          {error && <Alert tone="danger">{error}</Alert>}
          {employee ? (
            <div className="flex items-center gap-3 rounded-md border border-line bg-surface-muted px-3.5 py-3">
              <Avatar name={employee.displayName} size={36} />
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-semibold text-ink">{employee.displayName}</p>
                <p className="text-[12px] text-ink-secondary">{employee.employeeCode} · signs in with the official e-mail</p>
              </div>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="Account for" className="grid grid-cols-2 gap-1 rounded-md bg-canvas p-1">
                {(['employee', 'email'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => (setMode(m), setErrors({}))}
                    className={cn(
                      'flex h-9 items-center justify-center gap-2 rounded-sm text-[13px] font-semibold transition-all duration-200',
                      mode === m ? 'bg-surface text-ink shadow-card' : 'text-ink-secondary hover:text-ink',
                    )}
                  >
                    {m === 'employee' ? <UserRound className="size-4" /> : <Mail className="size-4" />}
                    {m === 'employee' ? 'Employee' : 'E-mail only'}
                  </button>
                ))}
              </div>
              {mode === 'employee' ? (
                <EmployeePicker label="Employee" value={picked} onChange={(p) => (setPicked(p), setErrors({}))} error={errors.employeeId} hint="The account uses the employee's official e-mail." />
              ) : (
                <TextField
                  label="E-mail address"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => (setEmail(e.target.value), setErrors({}))}
                  error={errors.email}
                  placeholder="name@oneinsure.com"
                  hint="For service or external accounts that are not in the employee master."
                />
              )}
            </>
          )}
          {employee && errors.employeeId && <Alert tone="danger">{errors.employeeId}</Alert>}
          {employee && errors.email && <Alert tone="danger">{errors.email}</Alert>}
          <RolePicker value={roles} onChange={(r) => (setRoles(r), setErrors((x) => ({ ...x, roles: '' })))} error={errors.roles || undefined} />
          <p className="text-[12.5px] text-ink-secondary">A one-time password is generated. The user must change it at first sign-in.</p>
        </form>
      )}
    </Dialog>
  )
}

export function EditRolesDialog({ user, onClose }: { user: AdminUser | null; onClose: (saved: boolean) => void }) {
  const [roles, setRoles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (user) {
      setRoles(user.roles)
      setError(null)
    }
  }, [user])

  async function save() {
    if (!user) return
    if (!roles.length) return setError('Choose at least one role.')
    setBusy(true)
    setError(null)
    try {
      await adminApi.setRoles(user.id, roles)
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The roles could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!user}
      onClose={() => onClose(false)}
      title="Edit roles"
      description={user ? `${user.displayName} · ${user.email}` : undefined}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} loading={busy}>Save roles</Button>
        </>
      }
    >
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      <RolePicker value={roles} onChange={setRoles} />
    </Dialog>
  )
}

/**
 * Links an existing account to its employee record (PUT /admin/users/{id}/employee), changes the link or removes it.
 * Meetings, the calendar and availability work only for accounts linked to an employee.
 */
export function LinkEmployeeDialog({ user, onClose }: { user: AdminUser | null; onClose: (saved: boolean) => void }) {
  const [picked, setPicked] = useState<PickedEmployee | null>(null)
  const [fieldError, setFieldError] = useState<string>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null)
  useEffect(() => {
    if (!user) return
    setPicked(null)
    setFieldError(undefined)
    setError(null)
  }, [user])

  const linked = !!user?.employeeId

  async function save(employeeId: string | null) {
    if (!user) return
    if (employeeId === null && !linked) return
    setBusy(employeeId ? 'link' : 'unlink')
    setError(null)
    setFieldError(undefined)
    try {
      await adminApi.linkEmployee(user.id, employeeId)
      onClose(true)
    } catch (err) {
      const fe = fieldErrors(err)
      if (fe.employeeId) setFieldError(fe.employeeId)
      else setError(err instanceof Error ? err.message : 'The link could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={!!user}
      onClose={() => onClose(false)}
      title={linked ? 'Change linked employee' : 'Link to employee'}
      description={user ? user.email : undefined}
      dismissible={!busy}
      footer={
        <>
          {linked && (
            <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger sm:mr-auto" onClick={() => void save(null)} loading={busy === 'unlink'} disabled={!!busy}>
              Unlink
            </Button>
          )}
          <Button variant="secondary" onClick={() => onClose(false)} disabled={!!busy}>Cancel</Button>
          <Button
            onClick={() => (picked ? void save(picked.id) : setFieldError('Choose an employee.'))}
            loading={busy === 'link'}
            disabled={!!busy}
          >
            {linked ? 'Change link' : 'Link account'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="rounded-md border border-line bg-surface-muted px-3.5 py-3 text-[13px]">
          <p className="text-[12px] text-ink-secondary">Currently linked employee</p>
          {linked ? (
            <p className="font-semibold text-ink">
              {user?.displayName}
              {user?.employeeCode && <span className="ml-1.5 font-medium text-ink-secondary">{user.employeeCode}</span>}
              {user?.department && <span className="ml-1.5 font-medium text-ink-secondary">· {user.department}</span>}
            </p>
          ) : (
            <p className="font-semibold text-warning-ink">Not linked: this account cannot schedule meetings or use the calendar.</p>
          )}
        </div>
        <EmployeePicker
          label={linked ? 'New employee' : 'Employee'}
          value={picked}
          onChange={(p) => (setPicked(p), setFieldError(undefined))}
          excludeIds={user?.employeeId ? [user.employeeId] : []}
          error={fieldError}
          hint="An employee can be linked to one account only. Its employee code becomes this account's sign-in code."
        />
      </div>
    </Dialog>
  )
}

/** Confirm → POST reset-password → show the one-time password once. */
export function ResetPasswordDialog({ user, onClose }: { user: Pick<AdminUser, 'id' | 'displayName' | 'email'> | null; onClose: (done: boolean) => void }) {
  const [password, setPassword] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function close() {
    const done = !!password
    setPassword(null)
    setError(null)
    onClose(done)
  }

  async function reset() {
    if (!user) return
    setBusy(true)
    setError(null)
    try {
      setPassword((await adminApi.resetPassword(user.id)).oneTimePassword)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The password could not be reset.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!user}
      onClose={close}
      title={password ? 'Password reset' : 'Reset password?'}
      size="sm"
      dismissible={!busy && !password}
      footer={
        password ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={() => void reset()} loading={busy} data-autofocus>Reset password</Button>
          </>
        )
      }
    >
      {password ? (
        <OneTimePassword value={password} account={user?.email} />
      ) : (
        <div className="flex flex-col gap-4 text-[13.5px] leading-[22px] text-ink-secondary">
          <p>
            A new one-time password will be generated for <strong className="text-ink">{user?.displayName}</strong>. Their current password stops working and all their
            sessions are signed out. They must choose a new password at the next sign-in.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  )
}
