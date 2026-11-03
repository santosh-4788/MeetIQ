import { useState, type ReactNode } from 'react'
import { Building2, CalendarDays, IdCard, Link2, Mail, MapPin, Pencil, Phone, Power, ShieldCheck, UserCheck, UserPlus, UserRound, Users } from 'lucide-react'
import { adminApi } from '../../api/admin'
import { employeesApi, type Employee, type EmployeeDetail } from '../../api/employees'
import { useAuth } from '../../auth/AuthContext'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { ActiveBadge } from '../../components/ui/Data'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { DEFAULT_TIME_ZONE } from '../../config'
import { formatCalendarDate, formatDateTime } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'

function rolesOf(r: string | string[] | null | undefined) {
  if (!r) return []
  return Array.isArray(r) ? r : r.split(',').filter(Boolean)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="eyebrow text-ink-muted">{title}</h3>
      {children}
    </section>
  )
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-ink-muted">{icon}</span>
      <div className="min-w-0">
        <dt className="text-[12px] text-ink-secondary">{label}</dt>
        <dd className="text-[13.5px] font-medium break-words text-ink">{children}</dd>
      </div>
    </div>
  )
}

/** Employee details drawer: employment, contact, teams, direct reports and the linked user account. */
export function EmployeeDetailDrawer({
  employeeId,
  version,
  onClose,
  onEdit,
  onToggleActive,
  onCreateAccount,
}: {
  employeeId: string | null
  /** Bumped by the parent after a change so the drawer reloads. */
  version: number
  onClose: () => void
  onEdit: (e: Employee) => void
  onToggleActive: (e: Employee) => void
  onCreateAccount: (e: Employee) => void
}) {
  const { user, can } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const toast = useToast()
  const { data, error, loading, reload } = useLoader<EmployeeDetail | null>(
    () => (employeeId ? employeesApi.get(employeeId) : Promise.resolve(null)),
    [employeeId, version],
    'Unable to load the employee.',
  )
  const e = data?.employee
  const account = data?.userAccount
  const matching = data?.matchingAccount
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  /** An account with the employee's e-mail already exists (e.g. the first SuperAdmin): link it instead of creating another. */
  async function linkExisting() {
    if (!e || !matching) return
    setLinking(true)
    setLinkError(null)
    try {
      await adminApi.linkEmployee(matching.id, e.id)
      toast.success(`Account ${matching.email} linked to ${e.displayName}.`)
      reload()
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'The account could not be linked.')
    } finally {
      setLinking(false)
    }
  }

  return (
    <Dialog
      open={!!employeeId}
      onClose={onClose}
      variant="drawer"
      title="Employee details"
      footer={
        e && (
          <>
            <Button
              variant="ghost"
              className={e.isActive ? 'text-danger hover:bg-danger-soft hover:text-danger' : undefined}
              leftIcon={e.isActive ? <Power className="size-4" /> : <UserCheck className="size-4" />}
              onClick={() => onToggleActive(e)}
            >
              {e.isActive ? 'Deactivate' : 'Activate'}
            </Button>
            <Button variant="secondary" leftIcon={<Pencil className="size-4" />} onClick={() => onEdit(e)}>
              Edit
            </Button>
          </>
        )
      }
    >
      {error ? (
        <ErrorState title="Unable to load the employee" description={error} onRetry={reload} />
      ) : (loading && !data) || !e || !data ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <div className="flex items-center gap-3">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-4">
            <Avatar name={e.displayName} size={56} />
            <div className="min-w-0">
              <p className="text-[18px] leading-[26px] font-semibold text-ink">{e.displayName}</p>
              <p className="text-[13px] text-ink-secondary">{e.designation} · {e.department}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone="neutral">{e.employeeCode}</Badge>
                <ActiveBadge active={e.isActive} />
              </div>
            </div>
          </div>

          <Section title="Employment">
            <dl className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Row icon={<Building2 className="size-4" />} label="Department">{e.department}</Row>
              <Row icon={<IdCard className="size-4" />} label="Designation">{e.designation}</Row>
              <Row icon={<MapPin className="size-4" />} label="Branch">{e.branch ?? '—'}</Row>
              <Row icon={<UserRound className="size-4" />} label="Reporting manager">{e.reportingManagerName ?? '—'}</Row>
              <Row icon={<CalendarDays className="size-4" />} label="Date of joining">{formatCalendarDate(e.dateOfJoining)}</Row>
              <Row icon={<Users className="size-4" />} label="Direct reports">{data.directReports.toLocaleString('en-IN')} active</Row>
            </dl>
          </Section>

          <Section title="Contact">
            <dl className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Row icon={<Mail className="size-4" />} label="Official e-mail">{e.officialEmail}</Row>
              <Row icon={<Phone className="size-4" />} label="Mobile">{e.mobile ?? '—'}</Row>
            </dl>
          </Section>

          <Section title="Teams">
            {data.teams.length ? (
              <div className="flex flex-wrap gap-1.5">
                {data.teams.map((t) => (
                  <Badge key={t.code} tone="brand">{t.name}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-secondary">Not a member of any team.</p>
            )}
          </Section>

          <Section title="User account">
            {account ? (
              <div className="rounded-md border border-line bg-surface-muted p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ActiveBadge active={account.isActive} />
                  {account.mfaEnabled ? (
                    <Badge tone="success"><ShieldCheck className="size-3" /> MFA on</Badge>
                  ) : (
                    <Badge tone="warning">MFA off</Badge>
                  )}
                  {rolesOf(account.roles).map((r) => (
                    <Badge key={r} tone="brand">{r}</Badge>
                  ))}
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Row icon={<Mail className="size-4" />} label="Sign-in e-mail">{account.email}</Row>
                  <Row icon={<CalendarDays className="size-4" />} label="Last sign-in">{account.lastLoginUtc ? formatDateTime(account.lastLoginUtc, tz) : 'Never'}</Row>
                </dl>
                {!account.isActive && e.isActive && (
                  <p className="mt-3 text-[12.5px] text-ink-secondary">The account is disabled. Re-enable it under Administration → Users &amp; roles.</p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong p-4">
                {matching ? (
                  <>
                    <p className="text-[13px] text-ink-secondary">
                      This employee is not linked to a user account, but the account <strong className="text-ink">{matching.email}</strong> uses the same e-mail
                      {matching.linkedEmployeeName ? ` and is linked to ${matching.linkedEmployeeName}` : ''}.
                    </p>
                    {linkError && <Alert tone="danger">{linkError}</Alert>}
                    {can('users.manage') && e.isActive && !matching.linkedEmployeeName && (
                      <Button size="sm" variant="subtle" leftIcon={<Link2 className="size-4" />} loading={linking} onClick={() => void linkExisting()}>
                        Link existing account {matching.email}
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-[13px] text-ink-secondary">This employee cannot sign in yet: there is no user account.</p>
                    {can('users.manage') && e.isActive && (
                      <Button size="sm" variant="subtle" leftIcon={<UserPlus className="size-4" />} onClick={() => onCreateAccount(e)}>
                        Create user account
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </Section>
        </div>
      )}
    </Dialog>
  )
}
