import { useEffect, useState } from 'react'
import { ChevronRight, Contact, SearchX, UserPlus } from 'lucide-react'
import { customersApi } from '../../api/customers'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ActiveBadge, Pagination, table } from '../../components/ui/Data'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { SearchField, Switch } from '../../components/ui/Form'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { useDebounced, useLoader } from '../../lib/useLoader'
import { CustomerDialog } from './CustomerDialog'

const PAGE_SIZE = 25

/** Customers tab of Customer Meetings. Lists show masked e-mail / mobile; the edit dialog loads the full record. */
export function CustomersPanel() {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [mine, setMine] = useState(false)
  const [inactive, setInactive] = useState(false)
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim(), 300)
  useEffect(() => setPage(1), [term, mine, inactive])

  const list = useLoader(
    () => customersApi.list({ search: term, assignedToMe: mine, includeInactive: inactive, page, pageSize: PAGE_SIZE }),
    [term, mine, inactive, page],
    'Unable to load customers.',
  )
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
  const data = list.data
  const filtered = !!(term || mine || inactive)

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:px-5 lg:flex-row lg:items-center">
        <SearchField value={search} onChange={setSearch} placeholder="Search name, reference, policy no. or exact e-mail / mobile" aria-label="Search customers" className="lg:max-w-md lg:flex-1" />
        <div className="flex flex-wrap items-center gap-4">
          <Switch checked={mine} onChange={setMine} label="Assigned to me" />
          <Switch checked={inactive} onChange={setInactive} label="Include inactive" />
        </div>
        <Button className="lg:ml-auto" leftIcon={<UserPlus className="size-4" />} onClick={() => setEditing(null)}>
          Add customer
        </Button>
      </div>

      {list.error ? (
        <ErrorState title="Unable to load customers" description={list.error} onRetry={list.reload} />
      ) : list.loading && !data ? (
        <div className="flex flex-col" aria-busy="true" aria-label="Loading customers">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : !data?.items.length ? (
        filtered ? (
          <EmptyState icon={<SearchX className="size-6" />} title="No matching customers" description="Search matches name, reference, policy or reference number, or an exact e-mail address or mobile number." />
        ) : (
          <EmptyState icon={<Contact className="size-6" />} title="No customers yet" description="Add a customer to schedule PLVC and other customer meetings." action={<Button size="sm" onClick={() => setEditing(null)}>Add customer</Button>} />
        )
      ) : (
        <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
          <div className={cn(table.wrap, 'hidden md:block')}>
            <table className={table.table}>
              <thead>
                <tr>
                  <th className={table.th}>Customer</th>
                  <th className={table.th}>Reference</th>
                  <th className={table.th}>Contact</th>
                  <th className={table.th}>Policy / reference no.</th>
                  <th className={table.th}>Assigned to</th>
                  <th className={table.th}>Status</th>
                  <th className={table.th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className={cn(table.row, 'cursor-pointer')} onClick={() => setEditing(c.id)}>
                    <td className={table.td}>
                      <div className="flex items-center gap-3">
                        <Avatar name={c.fullName} size={32} />
                        <button type="button" onClick={(ev) => (ev.stopPropagation(), setEditing(c.id))} className="max-w-56 truncate text-left font-semibold text-ink hover:text-brand-700 hover:underline">
                          {c.fullName}
                        </button>
                      </div>
                    </td>
                    <td className={cn(table.td, 'whitespace-nowrap tabular-nums')}>{c.customerRef}</td>
                    <td className={cn(table.td, 'text-ink-secondary')}>
                      <span className="block">{c.email ?? '—'}</span>
                      {c.mobile && <span className="block text-[12px] tabular-nums">{c.mobile}</span>}
                    </td>
                    <td className={cn(table.td, 'text-ink-secondary tabular-nums')}>
                      {c.policyNumber ?? '—'}
                      {c.referenceNumber && <span className="block text-[12px]">Ref {c.referenceNumber}</span>}
                    </td>
                    <td className={cn(table.td, 'text-ink-secondary')}>{c.assignedEmployeeName ?? '—'}</td>
                    <td className={table.td}><ActiveBadge active={c.isActive} /></td>
                    <td className={cn(table.td, 'text-right')}><ChevronRight className="ml-auto size-4 text-ink-muted" aria-hidden /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col md:hidden">
            {data.items.map((c) => (
              <li key={c.id} className="border-b border-line last:border-b-0">
                <button type="button" onClick={() => setEditing(c.id)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-muted">
                  <Avatar name={c.fullName} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-ink">{c.fullName}</span>
                    <span className="block truncate text-[12px] text-ink-secondary">{c.customerRef}{c.policyNumber ? ` · Policy ${c.policyNumber}` : ''}</span>
                    <span className="block truncate text-[12px] text-ink-secondary">{[c.email, c.mobile].filter(Boolean).join(' · ') || '—'}</span>
                    <span className="mt-1.5 flex"><ActiveBadge active={c.isActive} /></span>
                  </span>
                  <ChevronRight className="mt-2 size-4 shrink-0 text-ink-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} disabled={list.loading} />
        </div>
      )}

      <CustomerDialog
        customerId={editing}
        onClose={(saved) => {
          const wasNew = editing === null
          setEditing(undefined)
          if (saved) {
            toast.success(wasNew ? 'Customer added.' : 'Customer updated.')
            list.reload()
          }
        }}
      />
    </Card>
  )
}
