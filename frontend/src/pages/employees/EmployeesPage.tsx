import { useEffect, useState } from 'react'
import { ChevronRight, FileUp, IdCard, SearchX, UserPlus } from 'lucide-react'
import { employeesApi, type Employee, type EmployeeSort, type EmployeeStatus } from '../../api/employees'
import { useAuth } from '../../auth/AuthContext'
import { type PickedEmployee } from '../../components/EmployeePicker'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ActiveBadge, PageHeader, Pagination, SortHeader, table } from '../../components/ui/Data'
import { Alert, Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect, SearchField } from '../../components/ui/Form'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatCalendarDate } from '../../lib/format'
import { useDebounced, useLoader } from '../../lib/useLoader'
import { CreateUserDialog } from '../admin/UserDialogs'
import { EmployeeDetailDrawer } from './EmployeeDetail'
import { EmployeeFormDrawer } from './EmployeeForm'
import { EmployeeImportDialog } from './EmployeeImport'
import { useMasters } from './useMasters'

const PAGE_SIZE = 25

export function EmployeesPage() {
  const { can } = useAuth()
  const toast = useToast()
  const masters = useMasters()

  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState('')
  const [designation, setDesignation] = useState('')
  const [branch, setBranch] = useState('')
  const [status, setStatus] = useState<EmployeeStatus>('active')
  const [sort, setSort] = useState<EmployeeSort>('name')
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim(), 300)

  // Any filter change goes back to the first page.
  useEffect(() => setPage(1), [term, department, designation, branch, status, sort])

  const list = useLoader(
    () => employeesApi.list({ search: term, department, designation, branch, status, sort, page, pageSize: PAGE_SIZE }),
    [term, department, designation, branch, status, sort, page],
    'Unable to load employees.',
  )

  const [viewing, setViewing] = useState<string | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const [editing, setEditing] = useState<Employee | 'new' | null>(null)
  const [toggling, setToggling] = useState<Employee | null>(null)
  const [accountFor, setAccountFor] = useState<PickedEmployee | null>(null)
  const [importing, setImporting] = useState(false)

  const refresh = () => {
    list.reload()
    setDetailVersion((v) => v + 1)
  }

  const filtered = !!(term || department || designation || branch || status !== 'active')
  const clearFilters = () => {
    setSearch('')
    setDepartment('')
    setDesignation('')
    setBranch('')
    setStatus('active')
  }

  const data = list.data
  const m = masters.data

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Employee Management"
        description="The employee master: people, reporting lines and their sign-in accounts."
        actions={
          <>
            <Button variant="secondary" leftIcon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
            <Button leftIcon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>
              Add employee
            </Button>
          </>
        }
      />

      {masters.error && (
        <Alert tone="warning" title="Filters unavailable">
          {masters.error}{' '}
          <button type="button" onClick={masters.reload} className="font-semibold underline">Try again</button>
        </Alert>
      )}

      <Card>
        <div className="grid grid-cols-1 gap-2.5 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] sm:px-5">
          <SearchField value={search} onChange={setSearch} placeholder="Search name, code, e-mail or mobile" aria-label="Search employees" className="sm:col-span-2 lg:col-span-1" />
          <FilterSelect aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)} disabled={!m}>
            <option value="">All departments</option>
            {m?.departments.map((d) => <option key={d.code} value={d.code}>{d.name}{d.isActive ? '' : ' (inactive)'}</option>)}
          </FilterSelect>
          <FilterSelect aria-label="Designation" value={designation} onChange={(e) => setDesignation(e.target.value)} disabled={!m}>
            <option value="">All designations</option>
            {m?.designations.map((d) => <option key={d.code} value={d.code}>{d.name}{d.isActive ? '' : ' (inactive)'}</option>)}
          </FilterSelect>
          <FilterSelect aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!m}>
            <option value="">All branches</option>
            {m?.branches.map((b) => <option key={b.code} value={b.code}>{b.name}{b.isActive ? '' : ' (inactive)'}</option>)}
          </FilterSelect>
          <FilterSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as EmployeeStatus)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All statuses</option>
          </FilterSelect>
          {/* Sorting on small screens (the table headers sort on larger ones). */}
          <FilterSelect aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as EmployeeSort)} className="md:hidden">
            <option value="name">Sort: Name</option>
            <option value="code">Sort: Employee code</option>
            <option value="department">Sort: Department</option>
            <option value="joined">Sort: Newest joiners</option>
          </FilterSelect>
        </div>

        {list.error ? (
          <ErrorState title="Unable to load employees" description={list.error} onRetry={list.reload} />
        ) : list.loading && !data ? (
          <ListSkeleton />
        ) : !data?.items.length ? (
          filtered ? (
            <EmptyState icon={<SearchX className="size-6" />} title="No matching employees" description="Try a different search or clear the filters." action={<Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={<IdCard className="size-6" />} title="No employees yet" description="Add employees one by one or import them from a CSV file." action={<Button size="sm" onClick={() => setEditing('new')}>Add employee</Button>} />
          )
        ) : (
          <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
            {/* Desktop / tablet: table */}
            <div className={cn(table.wrap, 'hidden md:block')}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <SortHeader label="Employee" active={sort === 'name'} onSort={() => setSort('name')} />
                    <SortHeader label="Code" active={sort === 'code'} onSort={() => setSort('code')} />
                    <SortHeader label="Department" active={sort === 'department'} onSort={() => setSort('department')} />
                    <th className={table.th}>Branch</th>
                    <th className={table.th}>Reporting manager</th>
                    <SortHeader label="Joined" active={sort === 'joined'} direction="descending" onSort={() => setSort('joined')} />
                    <th className={table.th}>Status</th>
                    <th className={table.th}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id} className={cn(table.row, 'cursor-pointer')} onClick={() => setViewing(e.id)}>
                      <td className={table.td}>
                        <div className="flex items-center gap-3">
                          <Avatar name={e.displayName} size={34} />
                          <div className="min-w-0">
                            <button type="button" onClick={(ev) => (ev.stopPropagation(), setViewing(e.id))} className="block max-w-56 truncate text-left font-semibold text-ink hover:text-brand-700 hover:underline">
                              {e.displayName}
                            </button>
                            <p className="max-w-56 truncate text-[12px] text-ink-secondary">{e.designation}</p>
                          </div>
                        </div>
                      </td>
                      <td className={cn(table.td, 'whitespace-nowrap tabular-nums')}>{e.employeeCode}</td>
                      <td className={table.td}>{e.department}</td>
                      <td className={cn(table.td, 'text-ink-secondary')}>{e.branch ?? '—'}</td>
                      <td className={cn(table.td, 'text-ink-secondary')}>{e.reportingManagerName ?? '—'}</td>
                      <td className={cn(table.td, 'whitespace-nowrap text-ink-secondary')}>{formatCalendarDate(e.dateOfJoining)}</td>
                      <td className={table.td}>
                        <div className="flex flex-wrap gap-1">
                          <ActiveBadge active={e.isActive} />
                          {!e.hasUserAccount && <Badge tone="warning">No login</Badge>}
                        </div>
                      </td>
                      <td className={cn(table.td, 'text-right')}>
                        <ChevronRight className="ml-auto size-4 text-ink-muted" aria-hidden />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile: cards */}
            <ul className="flex flex-col md:hidden">
              {data.items.map((e) => (
                <li key={e.id} className="border-b border-line last:border-b-0">
                  <button type="button" onClick={() => setViewing(e.id)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-muted">
                    <Avatar name={e.displayName} size={38} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-ink">{e.displayName}</span>
                      <span className="block truncate text-[12px] text-ink-secondary">{e.employeeCode} · {e.designation}</span>
                      <span className="block truncate text-[12px] text-ink-secondary">{e.department}{e.branch ? ` · ${e.branch}` : ''}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        <ActiveBadge active={e.isActive} />
                        {!e.hasUserAccount && <Badge tone="warning">No login</Badge>}
                      </span>
                    </span>
                    <ChevronRight className="mt-2 size-4 shrink-0 text-ink-muted" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} disabled={list.loading} />
          </div>
        )}
      </Card>

      <EmployeeDetailDrawer
        employeeId={viewing}
        version={detailVersion}
        onClose={() => setViewing(null)}
        onEdit={setEditing}
        onToggleActive={setToggling}
        onCreateAccount={(e) => setAccountFor({ id: e.id, displayName: e.displayName, employeeCode: e.employeeCode })}
      />

      <EmployeeFormDrawer
        employee={editing}
        masters={m}
        onClose={(savedId) => {
          const wasNew = editing === 'new'
          setEditing(null)
          if (savedId) {
            toast.success(wasNew ? 'Employee added.' : 'Employee updated.')
            refresh()
            if (wasNew) setViewing(savedId)
          }
        }}
      />

      <ConfirmDialog
        open={!!toggling}
        onClose={() => setToggling(null)}
        title={toggling?.isActive ? `Deactivate ${toggling.displayName}?` : `Activate ${toggling?.displayName ?? ''}?`}
        confirmLabel={toggling?.isActive ? 'Deactivate employee' : 'Activate employee'}
        tone={toggling?.isActive ? 'danger' : 'primary'}
        onConfirm={async () => {
          if (!toggling) return
          await employeesApi.setActive(toggling.id, !toggling.isActive)
          toast.success(toggling.isActive ? 'Employee deactivated.' : 'Employee activated.')
          refresh()
        }}
      >
        {toggling?.isActive ? (
          <>
            <p>Deactivating this employee also:</p>
            <ul className="mt-1.5 list-disc pl-5">
              <li>disables their user account and <strong className="text-ink">signs them out</strong> of every session,</li>
              <li>ends their team memberships.</li>
            </ul>
            <p className="mt-2">You can activate the employee again later, but the user account stays disabled until an administrator re-enables it.</p>
          </>
        ) : (
          <p>The employee becomes active again. Their user account, if any, stays disabled until an administrator re-enables it under Administration.</p>
        )}
      </ConfirmDialog>

      {can('users.manage') && (
        <CreateUserDialog
          open={!!accountFor}
          employee={accountFor ?? undefined}
          onClose={(created) => {
            setAccountFor(null)
            if (created) {
              toast.success('User account created.')
              refresh()
            }
          }}
        />
      )}

      <EmployeeImportDialog
        open={importing}
        onClose={(applied) => {
          setImporting(false)
          if (applied) {
            toast.success('Employee import applied.')
            refresh()
            void masters.reload()
          }
        }}
      />
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading employees">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="hidden h-4 w-24 md:block" />
          <Skeleton className="hidden h-6 w-16 rounded-full md:block" />
        </div>
      ))}
    </div>
  )
}
