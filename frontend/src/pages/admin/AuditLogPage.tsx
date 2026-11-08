import { useState } from 'react'
import { ChevronDown, ScrollText, ShieldAlert } from 'lucide-react'
import { auditApi, type AuditEntry } from '../../api/audit'
import { useAuth } from '../../auth/AuthContext'
import { Card, CardHeader } from '../../components/ui/Card'
import { DateField } from '../../components/ui/DateTimeField'
import { PageHeader, Pagination } from '../../components/ui/Data'
import { Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect, SearchField, Switch } from '../../components/ui/Form'
import { DEFAULT_TIME_ZONE } from '../../config'
import { cn } from '../../lib/cn'
import { addDays, formatDateTime, zonedToUtc } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'

const PAGE_SIZE = 25

/** Title-cases an UPPER_SNAKE action/entity code for display, e.g. "PASSWORD_RESET" -> "Password reset". */
function humanize(code: string) {
  const words = code.toLowerCase().split('_')
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ') : '')
}

export function AuditLogPage() {
  const { user } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(today)
  const [action, setAction] = useState('')
  const [entityType, setEntityType] = useState('')
  const [privilegedOnly, setPrivilegedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  const filterOptions = useLoader(() => auditApi.filters(), [], 'Filter options could not be loaded.')

  const query = {
    from: zonedToUtc(from, '00:00', tz).toISOString(),
    to: zonedToUtc(to, '23:59', tz).toISOString(),
    action: action || undefined,
    entityType: entityType || undefined,
    privilegedOnly: privilegedOnly || undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  }
  const log = useLoader(
    () => auditApi.list(query),
    [from, to, action, entityType, privilegedOnly, search, page], // eslint-disable-line react-hooks/exhaustive-deps -- query is derived fresh from these every render
    'The audit log could not be loaded.',
  )

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setPage(1)
    }
  }

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        title="Audit Log"
        description="A read-only, tamper-evident record of sign-ins, administrative changes and other security-relevant actions. Entries cannot be edited or deleted, by anyone, including administrators."
      />

      <Card>
        <CardHeader title="Filters" />
        <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-6">
          <DateField label="From" value={from} onChange={resetPage(setFrom)} max={to} />
          <DateField label="To" value={to} onChange={resetPage(setTo)} min={from} />
          <FilterSelect aria-label="Action" value={action} onChange={(e) => resetPage(setAction)(e.target.value)} className="self-end" disabled={filterOptions.loading}>
            <option value="">Any action</option>
            {(filterOptions.data?.actions ?? []).map((a) => (
              <option key={a} value={a}>{humanize(a)}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Entity type" value={entityType} onChange={(e) => resetPage(setEntityType)(e.target.value)} className="self-end" disabled={filterOptions.loading}>
            <option value="">Any entity type</option>
            {(filterOptions.data?.entityTypes ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </FilterSelect>
          <SearchField value={search} onChange={resetPage(setSearch)} placeholder="Actor, entity ID or summary" aria-label="Search" className="self-end" />
          <Switch checked={privilegedOnly} onChange={resetPage(setPrivilegedOnly)} label="Privileged only" className="self-end justify-self-start sm:self-center" />
        </div>
      </Card>

      {log.error && !log.data ? (
        <ErrorState description={log.error ?? undefined} onRetry={log.reload} />
      ) : (
        <Card>
          <CardHeader title="Entries" subtitle={log.data ? `${log.data.total.toLocaleString('en-IN')} matching the filters above` : undefined} />
          {!log.data ? (
            <div className="flex flex-col gap-2 p-5">
              {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14 rounded-md" />)}
            </div>
          ) : log.data.items.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-6" />} title="No audit entries match these filters" description="Try a wider date range or fewer filters." />
          ) : (
            <>
              <ul className="divide-y divide-line">
                {log.data.items.map((e) => (
                  <AuditRow key={e.id} entry={e} tz={tz} open={expanded === e.id} onToggle={() => setExpanded((cur) => (cur === e.id ? null : e.id))} />
                ))}
              </ul>
              <Pagination page={page} pageSize={PAGE_SIZE} total={log.data.total} onPage={setPage} disabled={log.loading} />
            </>
          )}
        </Card>
      )}
    </div>
  )
}

function AuditRow({ entry: e, tz, open, onToggle }: { entry: AuditEntry; tz: string; open: boolean; onToggle: () => void }) {
  const hasDetail = !!(e.oldValuesJson || e.newValuesJson)
  return (
    <li>
      <button
        type="button"
        onClick={hasDetail ? onToggle : undefined}
        className={cn('flex w-full flex-col gap-2 px-5 py-3.5 text-left sm:flex-row sm:items-center sm:gap-4', hasDetail && 'cursor-pointer hover:bg-surface-muted')}
      >
        <div className="w-[160px] shrink-0 text-[12px] whitespace-nowrap text-ink-secondary">{formatDateTime(e.utc, tz)}</div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-ink">
            {humanize(e.action)}
            {e.isPrivileged && <Badge tone="warning"><ShieldAlert className="size-3" /> Privileged</Badge>}
          </p>
          <p className="truncate text-[12px] text-ink-secondary">{e.summary ?? `${e.entityType}${e.entityId ? ` · ${e.entityId}` : ''}`}</p>
        </div>
        <div className="shrink-0 text-right text-[12px] text-ink-secondary sm:w-48">
          <p className="truncate font-medium text-ink">{e.actorName ?? (e.actorType === 'SYSTEM' ? 'System' : 'Unknown')}</p>
          <p className="truncate">{e.actorEmail ?? e.actorType}{e.ipAddress ? ` · ${e.ipAddress}` : ''}</p>
        </div>
        {hasDetail && <ChevronDown className={cn('size-4 shrink-0 text-ink-muted transition-transform duration-150', open && 'rotate-180')} />}
      </button>
      {hasDetail && open && (
        <div className="grid grid-cols-1 gap-3 bg-surface-muted px-5 pt-1 pb-4 sm:grid-cols-2">
          {e.oldValuesJson && <JsonBlock label="Before" json={e.oldValuesJson} />}
          {e.newValuesJson && <JsonBlock label="After" json={e.newValuesJson} />}
        </div>
      )}
    </li>
  )
}

function JsonBlock({ label, json }: { label: string; json: string }) {
  let pretty = json
  try {
    pretty = JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    /* not valid JSON (shouldn't happen - the column has an ISJSON check): show as-is */
  }
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">{label}</p>
      <pre className="scrollbar-thin max-h-48 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-[11.5px] leading-5 text-ink-secondary">{pretty}</pre>
    </div>
  )
}
