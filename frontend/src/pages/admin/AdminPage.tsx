import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Construction, EllipsisVertical, IdCard, KeyRound, LockOpen, Power, ShieldCheck, ShieldOff, ShieldX, UserCheck, UserCog, UserPlus, UsersRound } from 'lucide-react'
import { adminApi, type AdminUser, type UserStatus } from '../../api/admin'
import { useAuth } from '../../auth/AuthContext'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { PageHeader, Pagination, table } from '../../components/ui/Data'
import { Alert, Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect, SearchField } from '../../components/ui/Form'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { DEFAULT_TIME_ZONE } from '../../config'
import { cn } from '../../lib/cn'
import { formatDateTime } from '../../lib/format'
import { useDebounced, useLoader } from '../../lib/useLoader'
import { RecorderHealthCard, RecordingPoliciesCard } from './RecordingPolicies'
import { RolesMatrix } from './RolesMatrix'
import { CreateUserDialog, EditRolesDialog, LinkEmployeeDialog, ResetPasswordDialog, SUPER_ADMIN } from './UserDialogs'

const PAGE_SIZE = 25

// Administration areas that are not built yet (shown honestly, not faked).
const plannedAreas = [
  'SMTP and e-mail delivery settings',
  'Meeting and security settings',
  'System health of the other background services',
  'Audit log viewer',
]

export function AdminPage() {
  const { can } = useAuth()
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Administration" description="Users, roles and permissions for OneInsure Connect." />
      {can('users.manage') ? (
        <>
          <UsersCard />
          <RolesMatrix />
        </>
      ) : (
        <Alert tone="info" title="Users & roles">
          Your role does not include user management. Ask a Super Administrator if you need it.
        </Alert>
      )}
      {(can('recordings.policy.manage') || can('admin.settings') || can('audit.view')) && <RecordingPoliciesCard />}
      {(can('admin.ops') || can('admin.settings') || can('recordings.policy.manage')) && <RecorderHealthCard />}
      <PlannedCard />
    </div>
  )
}

function PlannedCard() {
  return (
    <Card>
      <CardHeader title="Other administration areas" subtitle="Scheduled for Phase 5 of the delivery roadmap." action={<Badge tone="warning" dot>Not yet implemented</Badge>} />
      <ul className="grid gap-2.5 px-5 pb-5 sm:grid-cols-2">
        {plannedAreas.map((p) => (
          <li key={p} className="flex items-start gap-2.5 rounded-md border border-line bg-surface-muted px-3.5 py-2.5 text-[13px] text-ink">
            <Construction className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
            {p}
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ---- Users ------------------------------------------------------------------------

type Pending = { kind: 'unlock' | 'reset-mfa' | 'deactivate' | 'activate'; user: AdminUser }

function UsersCard() {
  const { user: me, can } = useAuth()
  const tz = me?.timeZone ?? DEFAULT_TIME_ZONE
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<UserStatus>('active')
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim(), 300)
  useEffect(() => setPage(1), [term, status])
  const list = useLoader(() => adminApi.users({ search: term, status, page, pageSize: PAGE_SIZE }), [term, status, page], 'Unable to load users.')

  const [creating, setCreating] = useState(false)
  const [editingRoles, setEditingRoles] = useState<AdminUser | null>(null)
  const [resetting, setResetting] = useState<AdminUser | null>(null)
  const [linking, setLinking] = useState<AdminUser | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  /** Acting on a SuperAdmin's account needs roles.manage (server guard), so those actions are hidden otherwise. */
  const protectedUser = (u: AdminUser) => u.roles.includes(SUPER_ADMIN) && !can('roles.manage')

  const actionsFor = (u: AdminUser): MenuAction[] => {
    if (protectedUser(u)) return []
    const self = u.id === me?.id
    const acts: MenuAction[] = [
      { label: 'Edit roles', icon: <UserCog className="size-4" />, onSelect: () => setEditingRoles(u) },
      { label: 'Reset password', icon: <KeyRound className="size-4" />, onSelect: () => setResetting(u) },
      { label: u.employeeId ? 'Change linked employee' : 'Link to employee', icon: <IdCard className="size-4" />, onSelect: () => setLinking(u) },
    ]
    if (u.isLocked) acts.push({ label: 'Unlock account', icon: <LockOpen className="size-4" />, onSelect: () => setPending({ kind: 'unlock', user: u }) })
    if (u.mfaEnabled) acts.push({ label: 'Reset MFA', icon: <ShieldX className="size-4" />, danger: true, onSelect: () => setPending({ kind: 'reset-mfa', user: u }) })
    if (u.isActive && !self) acts.push({ label: 'Deactivate', icon: <Power className="size-4" />, danger: true, onSelect: () => setPending({ kind: 'deactivate', user: u }) })
    if (!u.isActive) acts.push({ label: 'Activate', icon: <UserCheck className="size-4" />, onSelect: () => setPending({ kind: 'activate', user: u }) })
    return acts
  }

  const confirmCopy: Record<Pending['kind'], { title: string; label: string; tone: 'danger' | 'primary'; body: (u: AdminUser) => string; done: string }> = {
    unlock: { title: 'Unlock account?', label: 'Unlock', tone: 'primary', done: 'Account unlocked.', body: (u) => `${u.displayName} can sign in again straight away. Failed sign-in attempts are reset.` },
    'reset-mfa': {
      title: 'Reset two-factor authentication?', label: 'Reset MFA', tone: 'danger', done: 'Two-factor authentication reset.',
      body: (u) => `${u.displayName}'s authenticator app and recovery codes stop working. They sign in with the password only until they set up two-factor authentication again in Settings. Do this only after verifying their identity.`,
    },
    deactivate: { title: 'Deactivate user?', label: 'Deactivate', tone: 'danger', done: 'User deactivated.', body: (u) => `${u.displayName} can no longer sign in and is signed out of every session immediately. The employee record is not changed.` },
    activate: { title: 'Activate user?', label: 'Activate', tone: 'primary', done: 'User activated.', body: (u) => `${u.displayName} can sign in again. If the linked employee is inactive, activate the employee first.` },
  }

  const data = list.data
  const statusBadges = (u: AdminUser) => (
    <div className="flex flex-wrap gap-1">
      <Badge tone={u.isActive ? 'success' : 'neutral'} dot>{u.isActive ? 'Active' : 'Inactive'}</Badge>
      {u.isLocked && <Badge tone="danger">Locked</Badge>}
      {u.mfaEnabled ? <Badge tone="info"><ShieldCheck className="size-3" /> MFA on</Badge> : <Badge tone="neutral"><ShieldOff className="size-3" /> MFA off</Badge>}
      {u.mustChangePassword && <Badge tone="warning">Must change password</Badge>}
      {!u.employeeId && <Badge tone="warning">No employee link</Badge>}
    </div>
  )

  return (
    <Card>
      <CardHeader
        title="Users & roles"
        subtitle="Sign-in accounts, their roles and security state."
        action={
          <Button size="sm" leftIcon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
            <span className="hidden sm:inline">Create user</span>
            <span className="sm:hidden">Create</span>
          </Button>
        }
      />
      <div className="flex flex-col gap-2.5 border-y border-line p-4 sm:flex-row sm:px-5">
        <SearchField value={search} onChange={setSearch} placeholder="Search name, e-mail or employee code" aria-label="Search users" className="sm:w-96" />
        <FilterSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus)} className="sm:w-44">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="locked">Locked</option>
          <option value="all">All users</option>
        </FilterSelect>
      </div>

      {list.error ? (
        <ErrorState title="Unable to load users" description={list.error} onRetry={list.reload} />
      ) : list.loading && !data ? (
        <div className="flex flex-col gap-3 p-5" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      ) : !data?.items.length ? (
        <EmptyState icon={<UsersRound className="size-6" />} title={term || status !== 'active' ? 'No matching users' : 'No users yet'} description={term ? 'Try a different search or status.' : undefined} />
      ) : (
        <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
          <div className={cn(table.wrap, 'hidden lg:block')}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>User</th>
                  <th className={table.th}>Department</th>
                  <th className={table.th}>Roles</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}>Last sign-in</th>
                  <th className={table.th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.id} className={table.row}>
                    <td className={table.td}>
                      <div className="flex items-center gap-3">
                        <Avatar name={u.displayName} size={34} />
                        <div className="min-w-0">
                          <p className="max-w-60 truncate font-semibold text-ink">
                            {u.displayName}
                            {u.id === me?.id && <span className="ml-1.5 text-[12px] font-medium text-ink-secondary">(you)</span>}
                          </p>
                          <p className="max-w-60 truncate text-[12px] text-ink-secondary">{u.email}{u.employeeCode ? ` · ${u.employeeCode}` : ''}</p>
                        </div>
                      </div>
                    </td>
                    <td className={cn(table.td, 'text-ink-secondary')}>{u.department ?? '—'}</td>
                    <td className={table.td}>
                      <div className="flex max-w-56 flex-wrap gap-1">
                        {u.roles.length ? u.roles.map((r) => <Badge key={r} tone="brand">{r}</Badge>) : <span className="text-ink-muted">None</span>}
                      </div>
                    </td>
                    <td className={table.td}>{statusBadges(u)}</td>
                    <td className={cn(table.td, 'whitespace-nowrap text-ink-secondary')}>{u.lastLoginUtc ? formatDateTime(u.lastLoginUtc, tz) : 'Never'}</td>
                    <td className={cn(table.td, 'text-right')}>
                      <UserActions user={u} actions={actionsFor(u)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col lg:hidden">
            {data.items.map((u) => (
              <li key={u.id} className="flex items-start gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
                <Avatar name={u.displayName} size={38} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">
                    {u.displayName}
                    {u.id === me?.id && <span className="ml-1.5 text-[12px] font-medium text-ink-secondary">(you)</span>}
                  </p>
                  <p className="truncate text-[12px] text-ink-secondary">{u.email}</p>
                  <p className="truncate text-[12px] text-ink-secondary">
                    {[u.employeeCode, u.department].filter(Boolean).join(' · ') || 'Not linked to an employee'} · Last sign-in {u.lastLoginUtc ? formatDateTime(u.lastLoginUtc, tz) : 'never'}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {u.roles.map((r) => <Badge key={r} tone="brand">{r}</Badge>)}
                  </div>
                  <div className="mt-1">{statusBadges(u)}</div>
                </div>
                <UserActions user={u} actions={actionsFor(u)} />
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} disabled={list.loading} />
        </div>
      )}

      <CreateUserDialog
        open={creating}
        onClose={(created) => {
          setCreating(false)
          if (created) {
            toast.success('User account created.')
            list.reload()
          }
        }}
      />
      <EditRolesDialog
        user={editingRoles}
        onClose={(saved) => {
          setEditingRoles(null)
          if (saved) {
            toast.success('Roles updated.')
            list.reload()
          }
        }}
      />
      <LinkEmployeeDialog
        user={linking}
        onClose={(saved) => {
          setLinking(null)
          if (saved) {
            toast.success('Employee link saved.')
            list.reload()
          }
        }}
      />
      <ResetPasswordDialog
        user={resetting}
        onClose={(done) => {
          setResetting(null)
          if (done) list.reload()
        }}
      />
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? confirmCopy[pending.kind].title : ''}
        confirmLabel={pending ? confirmCopy[pending.kind].label : ''}
        tone={pending ? confirmCopy[pending.kind].tone : 'danger'}
        onConfirm={async () => {
          if (!pending) return
          const { kind, user: u } = pending
          if (kind === 'unlock') await adminApi.unlock(u.id)
          else if (kind === 'reset-mfa') await adminApi.resetMfa(u.id)
          else await adminApi.setActive(u.id, kind === 'activate')
          toast.success(confirmCopy[kind].done)
          list.reload()
        }}
      >
        {pending && <p>{confirmCopy[pending.kind].body(pending.user)}</p>}
      </ConfirmDialog>
    </Card>
  )
}

type MenuAction = { label: string; icon: React.ReactNode; onSelect: () => void; danger?: boolean }

/**
 * Per-user "more actions" menu. Rendered in a portal with fixed positioning so the table's
 * scroll container never clips it. Escape / outside click / scroll closes; arrow keys move.
 */
function UserActions({ user, actions }: { user: AdminUser; actions: MenuAction[] }) {
  const [pos, setPos] = useState<CSSProperties | null>(null)
  const open = pos !== null
  const menu = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    items.current[0]?.focus()
    const close = () => setPos(null)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) close()
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  if (!actions.length)
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-ink-muted" title="Managing a Super Administrator needs the manage-roles permission">
        <ShieldCheck className="size-3.5" /> Protected
      </span>
    )

  function toggle() {
    if (open) return setPos(null)
    const r = trigger.current?.getBoundingClientRect()
    if (!r) return
    const right = Math.max(8, window.innerWidth - r.right)
    const below = window.innerHeight - r.bottom > actions.length * 40 + 24
    setPos(below ? { top: r.bottom + 4, right } : { bottom: window.innerHeight - r.top + 4, right })
  }

  const onKey = (e: React.KeyboardEvent) => {
    const i = items.current.findIndex((x) => x === document.activeElement)
    if (e.key === 'Escape') {
      e.stopPropagation()
      setPos(null)
      trigger.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = actions.length
      items.current[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      setPos(null)
      trigger.current?.focus()
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${user.displayName}`}
        title="Actions"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-navy-900/5 hover:text-ink"
      >
        <EllipsisVertical className="size-[18px]" />
      </button>
      {createPortal(
        <AnimatePresence>
          {pos && (
            <motion.div
              ref={menu}
              role="menu"
              aria-label={`Actions for ${user.displayName}`}
              onKeyDown={onKey}
              style={pos}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              className="fixed z-[55] w-52 overflow-hidden rounded-lg border border-line bg-surface p-1.5 text-left shadow-overlay"
            >
              {actions.map((a, i) => (
                <button
                  key={a.label}
                  ref={(el) => {
                    items.current[i] = el
                  }}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setPos(null)
                    a.onSelect()
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13px] font-medium',
                    a.danger ? 'text-danger hover:bg-danger-soft focus:bg-danger-soft' : 'text-ink hover:bg-canvas focus:bg-canvas',
                  )}
                >
                  <span className={a.danger ? '' : 'text-ink-secondary'}>{a.icon}</span>
                  {a.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
