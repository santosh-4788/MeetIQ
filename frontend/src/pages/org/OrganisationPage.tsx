import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Building, Building2, IdCard, MapPin, Pencil, Plus, Power, SearchX, UserCheck, Users, UsersRound } from 'lucide-react'
import { orgApi, type Branch, type Department, type Designation, type OrgKind, type OrgResources, type Team } from '../../api/org'
import { fieldErrors } from '../../api/types'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ActiveBadge, PageHeader, Tabs, tabPanelProps, table } from '../../components/ui/Data'
import { Alert, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SearchField, SelectField, Switch, TextAreaField } from '../../components/ui/Form'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { DEFAULT_TIME_ZONE } from '../../config'
import { cn } from '../../lib/cn'
import { useLoader } from '../../lib/useLoader'
import { TeamMembersDialog } from './TeamMembersDialog'

type TabId = OrgKind
const tabs: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'departments', label: 'Departments', icon: <Building className="size-4" /> },
  { id: 'designations', label: 'Designations', icon: <IdCard className="size-4" /> },
  { id: 'branches', label: 'Branches', icon: <MapPin className="size-4" /> },
  { id: 'teams', label: 'Teams', icon: <UsersRound className="size-4" /> },
]

export function OrganisationPage() {
  const [tab, setTab] = useState<TabId>('departments')
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Department Management" description="Organisation masters: departments, designations, branches and teams." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Organisation masters" idPrefix="org" />
      <div {...tabPanelProps('org', tab)} className="outline-none">
        {tab === 'departments' && (
          <MasterTab
            kind="departments"
            noun="department"
            columns={[
              { header: 'Parent', cell: (d: Department) => d.parentCode ?? '—', muted: true },
              { header: 'Head', cell: (d: Department) => d.headName ?? '—', muted: true },
              { header: 'Employees', cell: (d: Department) => d.employeeCount.toLocaleString('en-IN'), numeric: true },
            ]}
            deactivateNote="A department can be deactivated only when it has no active employees."
            renderEditor={(item, onClose) => <DepartmentEditor item={item} onClose={onClose} />}
          />
        )}
        {tab === 'designations' && (
          <MasterTab
            kind="designations"
            noun="designation"
            columns={[
              { header: 'Level', cell: (d: Designation) => d.level ?? '—', numeric: true },
              { header: 'Employees', cell: (d: Designation) => d.employeeCount.toLocaleString('en-IN'), numeric: true },
            ]}
            deactivateNote="A designation can be deactivated only when no active employee holds it."
            renderEditor={(item, onClose) => <DesignationEditor item={item} onClose={onClose} />}
          />
        )}
        {tab === 'branches' && (
          <MasterTab
            kind="branches"
            noun="branch"
            columns={[
              { header: 'Location', cell: (b: Branch) => [b.city, b.state].filter(Boolean).join(', ') || '—', muted: true },
              { header: 'Time zone', cell: (b: Branch) => b.timeZoneId ?? DEFAULT_TIME_ZONE, muted: true },
              { header: 'Employees', cell: (b: Branch) => b.employeeCount.toLocaleString('en-IN'), numeric: true },
            ]}
            renderEditor={(item, onClose) => <BranchEditor item={item} onClose={onClose} />}
          />
        )}
        {tab === 'teams' && (
          <MasterTab
            kind="teams"
            noun="team"
            columns={[
              { header: 'Department', cell: (t: Team) => t.departmentName, muted: true },
              { header: 'Team leader', cell: (t: Team) => t.teamLeaderName ?? '—', muted: true },
              { header: 'Members', cell: (t: Team) => t.memberCount.toLocaleString('en-IN'), numeric: true },
            ]}
            renderEditor={(item, onClose) => <TeamEditor item={item} onClose={onClose} />}
            extraAction={(t: Team, reload) => <TeamMembersButton team={t} onSaved={reload} />}
          />
        )}
      </div>
    </div>
  )
}

// ---- Generic master list ------------------------------------------------------------

type Item<K extends OrgKind> = OrgResources[K]['item']
type Column<T> = { header: string; cell: (item: T) => ReactNode; muted?: boolean; numeric?: boolean }
type EditorClose = (saved?: boolean) => void

function MasterTab<K extends OrgKind>({
  kind,
  noun,
  columns,
  deactivateNote,
  renderEditor,
  extraAction,
}: {
  kind: K
  noun: string
  columns: Column<Item<K>>[]
  deactivateNote?: string
  renderEditor: (item: Item<K> | 'new' | null, onClose: EditorClose) => ReactNode
  extraAction?: (item: Item<K>, reload: () => void) => ReactNode
}) {
  const toast = useToast()
  const [includeInactive, setIncludeInactive] = useState(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Item<K> | 'new' | null>(null)
  const [toggling, setToggling] = useState<Item<K> | null>(null)
  const { data, error, loading, reload } = useLoader(() => orgApi.list(kind, includeInactive), [kind, includeInactive], `Unable to load ${noun} list.`)

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data ?? []).filter((i) => !q || i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q))
  }, [data, search])

  const cap = noun[0].toUpperCase() + noun.slice(1)
  const plural = noun === 'branch' ? 'branches' : `${noun}s`

  const actions = (i: Item<K>) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {extraAction?.(i, reload)}
      <Button variant="ghost" size="sm" leftIcon={<Pencil className="size-3.5" />} onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`}>
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={i.isActive ? 'text-danger hover:bg-danger-soft hover:text-danger' : undefined}
        leftIcon={i.isActive ? <Power className="size-3.5" /> : <UserCheck className="size-3.5" />}
        onClick={() => setToggling(i)}
        aria-label={`${i.isActive ? 'Deactivate' : 'Activate'} ${i.name}`}
      >
        {i.isActive ? 'Deactivate' : 'Activate'}
      </Button>
    </div>
  )

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:px-5">
        <SearchField value={search} onChange={setSearch} placeholder={`Search ${plural} by name or code`} aria-label={`Search ${plural}`} className="sm:w-80" />
        <Switch checked={includeInactive} onChange={setIncludeInactive} label="Show inactive" />
        <Button className="sm:ml-auto" leftIcon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          Add {noun}
        </Button>
      </div>

      {error ? (
        <ErrorState title={`Unable to load ${plural}`} description={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="flex flex-col gap-3 p-5" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : !rows.length ? (
        search ? (
          <EmptyState icon={<SearchX className="size-6" />} title={`No matching ${plural}`} description="Try a different name or code." />
        ) : (
          <EmptyState icon={<Building2 className="size-6" />} title={`No ${plural} yet`} action={<Button size="sm" onClick={() => setEditing('new')}>Add {noun}</Button>} />
        )
      ) : (
        <div className={cn('transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <div className={cn(table.wrap, 'hidden md:block')}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>{cap}</th>
                  <th className={table.th}>Code</th>
                  {columns.map((c) => (
                    <th key={c.header} className={cn(table.th, c.numeric && 'text-right')}>{c.header}</th>
                  ))}
                  <th className={table.th}>Status</th>
                  <th className={cn(table.th, 'text-right')}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.code} className={table.row}>
                    <td className={cn(table.td, 'font-semibold')}>{i.name}</td>
                    <td className={cn(table.td, 'whitespace-nowrap text-ink-secondary tabular-nums')}>{i.code}</td>
                    {columns.map((c) => (
                      <td key={c.header} className={cn(table.td, c.muted && 'text-ink-secondary', c.numeric && 'text-right tabular-nums')}>{c.cell(i)}</td>
                    ))}
                    <td className={table.td}><ActiveBadge active={i.isActive} /></td>
                    <td className={table.td}>{actions(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col md:hidden">
            {rows.map((i) => (
              <li key={i.code} className="flex flex-col gap-2 border-b border-line px-4 py-3.5 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-ink">{i.name}</p>
                    <p className="text-[12px] text-ink-secondary">{i.code}</p>
                  </div>
                  <ActiveBadge active={i.isActive} />
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                  {columns.map((c) => (
                    <div key={c.header} className="min-w-0">
                      <dt className="text-ink-muted">{c.header}</dt>
                      <dd className="truncate text-ink">{c.cell(i)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="-mx-2">{actions(i)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {renderEditor(editing, (saved) => {
        const wasNew = editing === 'new'
        setEditing(null)
        if (saved) {
          toast.success(`${cap} ${wasNew ? 'added' : 'updated'}.`)
          reload()
        }
      })}

      <ConfirmDialog
        open={!!toggling}
        onClose={() => setToggling(null)}
        title={`${toggling?.isActive ? 'Deactivate' : 'Activate'} ${toggling?.name ?? noun}?`}
        confirmLabel={toggling?.isActive ? `Deactivate ${noun}` : `Activate ${noun}`}
        tone={toggling?.isActive ? 'danger' : 'primary'}
        onConfirm={async () => {
          if (!toggling) return
          await orgApi.setActive(kind, toggling.code, !toggling.isActive)
          toast.success(`${cap} ${toggling.isActive ? 'deactivated' : 'activated'}.`)
          reload()
        }}
      >
        {toggling?.isActive ? (
          <p>
            The {noun} will no longer be offered for new assignments. Existing records keep their history.
            {deactivateNote && <> {deactivateNote}</>}
          </p>
        ) : (
          <p>The {noun} becomes available again for new assignments.</p>
        )}
      </ConfirmDialog>
    </Card>
  )
}

// ---- Editors ------------------------------------------------------------------------

/** Shared create/update handling: POST on create, PUT on edit (code immutable), VALIDATION errors per field. */
function useMasterSave<K extends OrgKind>(kind: K, item: Item<K> | 'new' | null, onClose: EditorClose) {
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setErrors({})
    setError(null)
  }, [item])

  async function save(body: OrgResources[K]['input'], clientErrors: Record<string, string>) {
    setErrors(clientErrors)
    if (Object.keys(clientErrors).length) return
    setBusy(true)
    setError(null)
    try {
      if (item && item !== 'new') await orgApi.update(kind, item.code, body)
      else await orgApi.create(kind, body)
      onClose(true)
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(err instanceof Error ? err.message : 'The changes could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  const clear = (field: string) => setErrors((e) => ({ ...e, [field]: '' }))
  return { busy, errors, error, save, clear }
}

function EditorDialog({ open, editing, noun, busy, error, onClose, onSubmit, children }: {
  open: boolean; editing: boolean; noun: string; busy: boolean; error: string | null; onClose: () => void; onSubmit: (e: FormEvent) => void; children: ReactNode
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${noun}` : `Add ${noun}`}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="master-form" loading={busy}>{editing ? 'Save changes' : `Add ${noun}`}</Button>
        </>
      }
    >
      <form id="master-form" onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {children}
      </form>
    </Dialog>
  )
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_/-]*$/

function codeAndName(code: string, name: string, editing: boolean) {
  const e: Record<string, string> = {}
  if (!editing) {
    if (!code.trim()) e.code = 'Code is required.'
    else if (!CODE_RE.test(code.trim())) e.code = "Use letters, digits, '-', '_' and '/' only."
  }
  if (!name.trim()) e.name = 'Name is required.'
  return e
}

function CodeNameFields({ code, name, setCode, setName, editing, errors }: {
  code: string; name: string; setCode: (v: string) => void; setName: (v: string) => void; editing: boolean; errors: Record<string, string>
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <TextField
        label="Code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        disabled={editing}
        error={errors.code || undefined}
        hint={editing ? 'Cannot be changed.' : 'Permanent; cannot be changed later.'}
        autoComplete="off"
        maxLength={20}
        data-autofocus={!editing || undefined}
      />
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name || undefined} autoComplete="off" maxLength={100} data-autofocus={editing || undefined} />
    </div>
  )
}

const opt = (s: string) => s.trim() || null

function useDepartments(open: boolean) {
  return useLoader(() => (open ? orgApi.list('departments') : Promise.resolve([] as Department[])), [open], 'Unable to load departments.')
}

function DepartmentEditor({ item, onClose }: { item: Department | 'new' | null; onClose: EditorClose }) {
  const editing = item && item !== 'new' ? item : null
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [head, setHead] = useState<PickedEmployee | null>(null)
  const s = useMasterSave('departments', item, onClose)
  const depts = useDepartments(!!item)
  useEffect(() => {
    setCode(editing?.code ?? '')
    setName(editing?.name ?? '')
    setParent(editing?.parentCode ?? '')
    setHead(editing?.headEmployeeId ? { id: editing.headEmployeeId, displayName: editing.headName ?? 'Department head' } : null)
  }, [item])

  return (
    <EditorDialog
      open={!!item}
      editing={!!editing}
      noun="department"
      busy={s.busy}
      error={s.error}
      onClose={() => onClose()}
      onSubmit={(e) => {
        e.preventDefault()
        void s.save({ code: code.trim(), name: name.trim(), parentCode: opt(parent), headEmployeeId: head?.id ?? null }, codeAndName(code, name, !!editing))
      }}
    >
      <CodeNameFields code={code} name={name} setCode={(v) => (setCode(v), s.clear('code'))} setName={(v) => (setName(v), s.clear('name'))} editing={!!editing} errors={s.errors} />
      <SelectField label="Parent department (optional)" value={parent} onChange={(e) => (setParent(e.target.value), s.clear('parentCode'))} error={s.errors.parentCode || undefined} disabled={depts.loading} hint={depts.error ?? undefined}>
        <option value="">None (top level)</option>
        {(depts.data ?? []).filter((d) => d.code !== editing?.code).map((d) => (
          <option key={d.code} value={d.code}>{d.name}</option>
        ))}
        {parent && !(depts.data ?? []).some((d) => d.code === parent) && <option value={parent}>{parent}</option>}
      </SelectField>
      <EmployeePicker label="Department head (optional)" value={head} onChange={(p) => (setHead(p), s.clear('headEmployeeId'))} error={s.errors.headEmployeeId || undefined} />
    </EditorDialog>
  )
}

function DesignationEditor({ item, onClose }: { item: Designation | 'new' | null; onClose: EditorClose }) {
  const editing = item && item !== 'new' ? item : null
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [level, setLevel] = useState('')
  const s = useMasterSave('designations', item, onClose)
  useEffect(() => {
    setCode(editing?.code ?? '')
    setName(editing?.name ?? '')
    setLevel(editing?.level != null ? String(editing.level) : '')
  }, [item])

  return (
    <EditorDialog
      open={!!item}
      editing={!!editing}
      noun="designation"
      busy={s.busy}
      error={s.error}
      onClose={() => onClose()}
      onSubmit={(e) => {
        e.preventDefault()
        const v = codeAndName(code, name, !!editing)
        const n = level.trim() === '' ? null : Number(level)
        if (n !== null && (!Number.isInteger(n) || n < 0 || n > 100)) v.level = 'Level must be a whole number from 0 to 100.'
        void s.save({ code: code.trim(), name: name.trim(), level: n }, v)
      }}
    >
      <CodeNameFields code={code} name={name} setCode={(v) => (setCode(v), s.clear('code'))} setName={(v) => (setName(v), s.clear('name'))} editing={!!editing} errors={s.errors} />
      <TextField
        label="Level (optional)"
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        value={level}
        onChange={(e) => (setLevel(e.target.value), s.clear('level'))}
        error={s.errors.level || undefined}
        hint="0–100. Used to order designations by seniority."
      />
    </EditorDialog>
  )
}

const TIME_ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC']

function BranchEditor({ item, onClose }: { item: Branch | 'new' | null; onClose: EditorClose }) {
  const editing = item && item !== 'new' ? item : null
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [tz, setTz] = useState(DEFAULT_TIME_ZONE)
  const [address, setAddress] = useState('')
  const s = useMasterSave('branches', item, onClose)
  useEffect(() => {
    setCode(editing?.code ?? '')
    setName(editing?.name ?? '')
    setCity(editing?.city ?? '')
    setState(editing?.state ?? '')
    setTz(editing?.timeZoneId ?? DEFAULT_TIME_ZONE)
    setAddress(editing?.address ?? '')
  }, [item])
  const zones = TIME_ZONES.includes(tz) ? TIME_ZONES : [tz, ...TIME_ZONES]

  return (
    <EditorDialog
      open={!!item}
      editing={!!editing}
      noun="branch"
      busy={s.busy}
      error={s.error}
      onClose={() => onClose()}
      onSubmit={(e) => {
        e.preventDefault()
        void s.save({ code: code.trim(), name: name.trim(), city: opt(city), state: opt(state), timeZoneId: tz, address: opt(address) }, codeAndName(code, name, !!editing))
      }}
    >
      <CodeNameFields code={code} name={name} setCode={(v) => (setCode(v), s.clear('code'))} setName={(v) => (setName(v), s.clear('name'))} editing={!!editing} errors={s.errors} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="City (optional)" value={city} onChange={(e) => (setCity(e.target.value), s.clear('city'))} error={s.errors.city || undefined} autoComplete="off" />
        <TextField label="State (optional)" value={state} onChange={(e) => (setState(e.target.value), s.clear('state'))} error={s.errors.state || undefined} autoComplete="off" />
      </div>
      <SelectField label="Time zone" value={tz} onChange={(e) => (setTz(e.target.value), s.clear('timeZoneId'))} error={s.errors.timeZoneId || undefined}>
        {zones.map((z) => <option key={z} value={z}>{z === 'Asia/Kolkata' ? 'Asia/Kolkata (IST)' : z}</option>)}
      </SelectField>
      <TextAreaField label="Address (optional)" value={address} onChange={(e) => (setAddress(e.target.value), s.clear('address'))} error={s.errors.address || undefined} rows={3} />
    </EditorDialog>
  )
}

function TeamEditor({ item, onClose }: { item: Team | 'new' | null; onClose: EditorClose }) {
  const editing = item && item !== 'new' ? item : null
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [dept, setDept] = useState('')
  const [leader, setLeader] = useState<PickedEmployee | null>(null)
  const s = useMasterSave('teams', item, onClose)
  const depts = useDepartments(!!item)
  useEffect(() => {
    setCode(editing?.code ?? '')
    setName(editing?.name ?? '')
    setDept(editing?.departmentCode ?? '')
    setLeader(editing?.teamLeaderId ? { id: editing.teamLeaderId, displayName: editing.teamLeaderName ?? 'Team leader' } : null)
  }, [item])

  return (
    <EditorDialog
      open={!!item}
      editing={!!editing}
      noun="team"
      busy={s.busy}
      error={s.error}
      onClose={() => onClose()}
      onSubmit={(e) => {
        e.preventDefault()
        const v = codeAndName(code, name, !!editing)
        if (!dept) v.departmentCode = 'Choose a department.'
        void s.save({ code: code.trim(), name: name.trim(), departmentCode: dept, teamLeaderId: leader?.id ?? null }, v)
      }}
    >
      <CodeNameFields code={code} name={name} setCode={(v) => (setCode(v), s.clear('code'))} setName={(v) => (setName(v), s.clear('name'))} editing={!!editing} errors={s.errors} />
      <SelectField label="Department" value={dept} onChange={(e) => (setDept(e.target.value), s.clear('departmentCode'))} error={s.errors.departmentCode || undefined} disabled={depts.loading} hint={depts.error ?? undefined}>
        <option value="">Select department</option>
        {(depts.data ?? []).map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
        {dept && !(depts.data ?? []).some((d) => d.code === dept) && <option value={dept}>{editing?.departmentName ?? dept}</option>}
      </SelectField>
      <EmployeePicker label="Team leader (optional)" value={leader} onChange={(p) => (setLeader(p), s.clear('teamLeaderId'))} error={s.errors.teamLeaderId || undefined} />
    </EditorDialog>
  )
}

function TeamMembersButton({ team, onSaved }: { team: Team; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="sm" leftIcon={<Users className="size-3.5" />} onClick={() => setOpen(true)} aria-label={`Members of ${team.name}`} disabled={!team.isActive} title={team.isActive ? undefined : 'Activate the team to manage members'}>
        Members
      </Button>
      <TeamMembersDialog team={open ? team : null} onClose={(saved) => {
        setOpen(false)
        if (saved) onSaved()
      }} />
    </>
  )
}
