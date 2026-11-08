import { useState } from 'react'
import { CalendarCheck, Clapperboard, Download, Handshake, Hourglass, Users, XCircle } from 'lucide-react'
import { reportsApi, type ReportFilters } from '../../api/reports'
import type { MeetingState } from '../../api/meetings'
import { Card, CardHeader, StatCard } from '../../components/ui/Card'
import { DateField } from '../../components/ui/DateTimeField'
import { PageHeader, Pagination } from '../../components/ui/Data'
import { Button } from '../../components/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect, SearchField } from '../../components/ui/Form'
import { CategoryBadge, StatusBadge } from '../meetings/meta'
import { useLoader } from '../../lib/useLoader'
import { addDays, formatDate, formatDuration, formatTime, zonedToUtc } from '../../lib/format'
import { DEFAULT_TIME_ZONE } from '../../config'

const PAGE_SIZE = 25

export function ReportsPage() {
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(today)
  const [category, setCategory] = useState<ReportFilters['category'] | ''>('')
  const [department, setDepartment] = useState('')
  const [status, setStatus] = useState<MeetingState | ''>('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const departments = useLoader(() => reportsApi.departments(), [], 'Departments could not be loaded.')

  const filters: ReportFilters = {
    from: zonedToUtc(from, '00:00', DEFAULT_TIME_ZONE).toISOString(),
    to: zonedToUtc(to, '23:59', DEFAULT_TIME_ZONE).toISOString(),
    category: category || undefined,
    department: department || undefined,
    status: status || undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  }
  const report = useLoader(
    () => reportsApi.meetings(filters),
    [from, to, category, department, status, search, page], // eslint-disable-line react-hooks/exhaustive-deps -- filters is derived fresh from these every render
    'The report could not be loaded.',
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
        title="Reports"
        description="Meeting activity across the organisation, for the selected date range and filters."
        actions={
          <Button variant="secondary" leftIcon={<Download className="size-4" />} onClick={() => window.open(reportsApi.exportUrl(filters), '_blank')}>
            Export CSV
          </Button>
        }
      />

      <Card>
        <CardHeader title="Filters" />
        <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-6">
          <DateField label="From" value={from} onChange={resetPage(setFrom)} max={to} />
          <DateField label="To" value={to} onChange={resetPage(setTo)} min={from} />
          <FilterSelect aria-label="Category" value={category} onChange={(e) => resetPage(setCategory)(e.target.value as ReportFilters['category'] | '')} className="self-end">
            <option value="">All categories</option>
            <option value="INTERNAL">Internal</option>
            <option value="CUSTOMER">Customer</option>
          </FilterSelect>
          <FilterSelect aria-label="Department" value={department} onChange={(e) => resetPage(setDepartment)(e.target.value)} className="self-end" disabled={departments.loading}>
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Status" value={status} onChange={(e) => resetPage(setStatus)(e.target.value as MeetingState | '')} className="self-end">
            <option value="">Any status</option>
            {(['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'INCOMPLETE'] satisfies MeetingState[]).map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </FilterSelect>
          <SearchField value={search} onChange={resetPage(setSearch)} placeholder="Title or meeting code" aria-label="Search" className="self-end" />
        </div>
      </Card>

      {report.error && !report.data ? (
        <ErrorState description={report.error ?? undefined} onRetry={report.reload} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {report.data ? (
              <>
                <StatCard label="Meetings" value={report.data.summary.total} icon={<CalendarCheck className="size-[18px]" />} accent="brand" />
                <StatCard label="Completed" value={report.data.summary.completed} icon={<CalendarCheck className="size-[18px]" />} accent="success" />
                <StatCard label="Cancelled / expired" value={report.data.summary.cancelled} icon={<XCircle className="size-[18px]" />} accent="warning" />
                <StatCard label="Customer meetings" value={report.data.summary.customerMeetings} icon={<Handshake className="size-[18px]" />} accent="cyan" />
                <StatCard label="Scheduled hours" value={Math.round(report.data.summary.totalHours)} icon={<Hourglass className="size-[18px]" />} accent="navy" />
                <StatCard label="With recording" value={report.data.summary.withRecording} icon={<Clapperboard className="size-[18px]" />} accent="violet" />
              </>
            ) : (
              Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)
            )}
          </div>

          <Card>
            <CardHeader title="Meetings" subtitle={report.data ? `${report.data.page.total.toLocaleString('en-IN')} matching the filters above` : undefined} />
            {!report.data ? (
              <div className="flex flex-col gap-2 p-5">
                {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14 rounded-md" />)}
              </div>
            ) : report.data.page.items.length === 0 ? (
              <EmptyState icon={<Users className="size-6" />} title="No meetings match these filters" description="Try a wider date range or fewer filters." />
            ) : (
              <>
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full min-w-[920px] border-collapse text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-[11.5px] font-semibold tracking-wide text-ink-muted uppercase">
                        <th className="px-5 py-2.5">Meeting</th>
                        <th className="px-3 py-2.5">Category</th>
                        <th className="px-3 py-2.5">Host</th>
                        <th className="px-3 py-2.5">Department</th>
                        <th className="px-3 py-2.5">Scheduled</th>
                        <th className="px-3 py-2.5">Duration</th>
                        <th className="px-3 py-2.5">Participants</th>
                        <th className="px-3 py-2.5">Status</th>
                        <th className="px-5 py-2.5">Recording</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.data.page.items.map((m) => (
                        <tr key={m.id} className="border-b border-line last:border-0 hover:bg-surface-muted">
                          <td className="px-5 py-3">
                            <p className="font-semibold text-ink">{m.title}</p>
                            <p className="font-mono text-[11.5px] text-ink-muted">{m.meetingCode}</p>
                          </td>
                          <td className="px-3 py-3">
                            <CategoryBadge group={m.categoryGroup} category={m.category} />
                          </td>
                          <td className="px-3 py-3 text-ink-secondary">{m.hostName}</td>
                          <td className="px-3 py-3 text-ink-secondary">{m.department ?? '—'}</td>
                          <td className="px-3 py-3 whitespace-nowrap text-ink-secondary">
                            {formatDate(m.startUtc)} · {formatTime(m.startUtc)}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-ink-secondary">
                            {formatDuration(Math.round((new Date(m.endUtc).getTime() - new Date(m.startUtc).getTime()) / 60_000))}
                          </td>
                          <td className="px-3 py-3 tabular-nums text-ink-secondary">{m.participantCount}</td>
                          <td className="px-3 py-3">
                            <StatusBadge status={m.status} />
                          </td>
                          <td className="px-5 py-3 text-ink-secondary">{m.recordingPolicy === 'NONE' ? '—' : (m.recordingStatus ?? 'Not recorded')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageSize={PAGE_SIZE} total={report.data.page.total} onPage={setPage} disabled={report.loading} />
              </>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
