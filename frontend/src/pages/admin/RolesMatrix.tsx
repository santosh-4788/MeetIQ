import { useEffect, useMemo, useState } from 'react'
import { Check, Info, Minus, RotateCcw, Save } from 'lucide-react'
import { adminApi, type Permission, type Role } from '../../api/admin'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect } from '../../components/ui/Form'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { useLoader } from '../../lib/useLoader'
import { SUPER_ADMIN } from './UserDialogs'

/** SuperAdmin always keeps roles.manage (server guard), so that cell is locked. */
const isLocked = (role: string, perm: string) => role === SUPER_ADMIN && perm === 'roles.manage'

/**
 * Roles × permissions, grouped by module. Read-only unless the user has roles.manage; then each
 * role column is edited locally and saved on its own (PUT /admin/roles/{code}/permissions).
 */
export function RolesMatrix() {
  const { can } = useAuth()
  const editable = can('roles.manage')
  const toast = useToast()
  const { data, error, loading, reload } = useLoader(
    async () => {
      const [roles, permissions] = await Promise.all([adminApi.roles(), adminApi.permissions()])
      return { roles, permissions }
    },
    [],
    'Unable to load roles and permissions.',
  )
  const [draft, setDraft] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mobileRole, setMobileRole] = useState('')

  useEffect(() => {
    if (!data) return
    setDraft(Object.fromEntries(data.roles.map((r) => [r.code, r.permissions])))
    setMobileRole((m) => m || data.roles[0]?.code || '')
  }, [data])

  const modules = useMemo(() => {
    const groups = new Map<string, Permission[]>()
    for (const p of data?.permissions ?? []) groups.set(p.module, [...(groups.get(p.module) ?? []), p])
    return [...groups.entries()]
  }, [data])

  const isDirty = (r: Role) => {
    const d = draft[r.code] ?? []
    return d.length !== r.permissions.length || d.some((p) => !r.permissions.includes(p))
  }

  const toggle = (role: string, perm: string) => {
    if (!editable || isLocked(role, perm)) return
    setDraft((d) => {
      const cur = d[role] ?? []
      return { ...d, [role]: cur.includes(perm) ? cur.filter((x) => x !== perm) : [...cur, perm] }
    })
  }

  async function save(r: Role) {
    setSaving(r.code)
    setSaveError(null)
    try {
      await adminApi.setRolePermissions(r.code, draft[r.code] ?? [])
      toast.success(`Permissions for ${r.name} saved.`)
      reload()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'The permissions could not be saved.')
    } finally {
      setSaving(null)
    }
  }

  const reset = (r: Role) => setDraft((d) => ({ ...d, [r.code]: r.permissions }))

  const cell = (r: Role, p: Permission) => {
    const on = (draft[r.code] ?? []).includes(p.code)
    const changed = on !== r.permissions.includes(p.code)
    const label = `${r.name}: ${p.description ?? p.code}`
    if (!editable)
      return on ? (
        <Check className="mx-auto size-4 text-success" aria-label={`${label}: granted`} />
      ) : (
        <Minus className="mx-auto size-4 text-line-strong" aria-label={`${label}: not granted`} />
      )
    return (
      <input
        type="checkbox"
        checked={on}
        disabled={isLocked(r.code, p.code) || saving === r.code}
        onChange={() => toggle(r.code, p.code)}
        aria-label={label}
        title={isLocked(r.code, p.code) ? 'Super Administrator always keeps this permission' : undefined}
        className={cn('size-4 cursor-pointer accent-brand-500 disabled:cursor-not-allowed', changed && 'outline-2 outline-offset-2 outline-warning')}
      />
    )
  }

  const mRole = data?.roles.find((r) => r.code === mobileRole)

  return (
    <Card>
      <CardHeader
        title="Roles & permissions"
        subtitle={editable ? 'Tick permissions per role, then save that role. Changes apply at the users\' next request.' : 'Read-only: changing the matrix needs the manage-roles permission.'}
        action={!editable && <Badge tone="neutral">Read-only</Badge>}
      />
      {error ? (
        <ErrorState title="Unable to load roles and permissions" description={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="flex flex-col gap-2 px-5 pb-5" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      ) : data ? (
        <>
          <div className="flex flex-col gap-3 px-5 pb-4">
            {saveError && <Alert tone="danger">{saveError}</Alert>}
            <p className="flex items-start gap-2 text-[12.5px] text-ink-secondary">
              <Info className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
              Recording permissions beyond "view own recordings" stay unassigned until Compliance approves the recording access matrix.
            </p>
          </div>

          {/* md+: full matrix */}
          <div className="scrollbar-thin hidden max-h-[70dvh] overflow-auto border-t border-line md:block">
            <table className="w-full border-collapse text-[13px]">
              <thead className="sticky top-0 z-[2]">
                <tr>
                  <th className="sticky left-0 z-[3] min-w-60 border-b border-line bg-surface-muted px-5 py-2.5 text-left text-[12px] font-semibold text-ink-secondary">Permission</th>
                  {data.roles.map((r) => (
                    <th key={r.code} className="min-w-28 border-b border-l border-line bg-surface-muted px-2 py-2.5 align-bottom text-center">
                      <span className="block text-[12px] font-semibold text-ink" title={r.description ?? undefined}>{r.name}</span>
                      <span className="block text-[11px] font-medium text-ink-muted tabular-nums">{r.userCount} user{r.userCount === 1 ? '' : 's'}</span>
                      {editable && isDirty(r) && (
                        <span className="mt-1.5 flex justify-center gap-1">
                          <button type="button" onClick={() => reset(r)} disabled={saving === r.code} className="inline-flex size-7 items-center justify-center rounded-sm text-ink-secondary hover:bg-navy-900/5 hover:text-ink" aria-label={`Undo changes to ${r.name}`} title="Undo changes">
                            <RotateCcw className="size-3.5" />
                          </button>
                          <Button size="sm" className="h-7 px-2" loading={saving === r.code} onClick={() => void save(r)} leftIcon={<Save className="size-3.5" />} aria-label={`Save ${r.name}`}>
                            Save
                          </Button>
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {modules.map(([module, perms]) => (
                  <ModuleRows key={module} module={module} perms={perms} roles={data.roles} cell={cell} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: one role at a time */}
          <div className="flex flex-col gap-3 border-t border-line px-4 py-4 md:hidden">
            <FilterSelect aria-label="Role" value={mobileRole} onChange={(e) => setMobileRole(e.target.value)}>
              {data.roles.map((r) => <option key={r.code} value={r.code}>{r.name} ({r.userCount})</option>)}
            </FilterSelect>
            {mRole && (
              <>
                {modules.map(([module, perms]) => (
                  <fieldset key={module} className="rounded-md border border-line">
                    <legend className="eyebrow ml-3 px-1 text-ink-muted">{module}</legend>
                    <ul className="flex flex-col">
                      {perms.map((p) => (
                        <li key={p.code} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] text-ink">{p.description ?? p.code}</span>
                            <span className="block font-mono text-[11.5px] text-ink-muted">{p.code}</span>
                          </span>
                          {cell(mRole, p)}
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ))}
                {editable && isDirty(mRole) && (
                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={() => reset(mRole)} disabled={saving === mRole.code}>Undo</Button>
                    <Button className="flex-1" loading={saving === mRole.code} onClick={() => void save(mRole)}>Save {mRole.name}</Button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : null}
    </Card>
  )
}

function ModuleRows({ module, perms, roles, cell }: { module: string; perms: Permission[]; roles: Role[]; cell: (r: Role, p: Permission) => React.ReactNode }) {
  return (
    <>
      <tr>
        <th colSpan={roles.length + 1} scope="colgroup" className="sticky left-0 border-b border-line bg-canvas px-5 py-1.5 text-left">
          <span className="eyebrow text-ink-secondary">{module}</span>
        </th>
      </tr>
      {perms.map((p) => (
        <tr key={p.code} className="transition-colors hover:bg-surface-muted">
          <th scope="row" className="sticky left-0 z-[1] border-b border-line bg-surface px-5 py-2 text-left font-normal">
            <span className="block text-[13px] text-ink">{p.description ?? p.code}</span>
            <span className="block font-mono text-[11.5px] text-ink-muted">{p.code}</span>
          </th>
          {roles.map((r) => (
            <td key={r.code} className="border-b border-l border-line px-2 py-2 text-center">
              {cell(r, p)}
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
