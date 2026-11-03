import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarPlus, ChevronRight, Clock, SearchX, Users, Video } from 'lucide-react'
import { meetingsApi, type DbMeetingCategory, type MeetingListItem, type MeetingQuery, type MeetingScope } from '../../api/meetings'
import { useAuth } from '../../auth/AuthContext'
import { AvatarStack } from '../../components/ui/Avatar'
import { ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Pagination, Tabs, tabPanelProps } from '../../components/ui/Data'
import { Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect, SearchField } from '../../components/ui/Form'
import { cn } from '../../lib/cn'
import { addDays, formatDuration, formatTime, formatYmd, parseUtc, zonedParts, zonedToUtc } from '../../lib/format'
import { useDebounced, useLoader } from '../../lib/useLoader'
import { CUSTOMER_CATEGORIES, CategoryBadge, INTERNAL_CATEGORIES, ResponseBadge, StatusBadge, categoryMeta, dbCategoryLabel, useTimeZone } from './meta'

type Tab = 'upcoming' | 'today' | 'hosting' | 'attending' | 'drafts' | 'past' | 'cancelled'

const tabs: { id: Tab; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'today', label: 'Today' },
  { id: 'hosting', label: 'Hosting' },
  { id: 'attending', label: 'Attending' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'past', label: 'Past' },
  { id: 'cancelled', label: 'Cancelled' },
]

const emptyText: Record<Tab, string> = {
  upcoming: 'No upcoming meetings',
  today: 'Nothing scheduled today',
  hosting: 'You are not hosting any upcoming meetings',
  attending: 'No upcoming invitations',
  drafts: 'No draft meetings',
  past: 'No past meetings',
  cancelled: 'No cancelled meetings',
}

const PAGE_SIZE = 20

/** The tab's query: time window, status, scope and order. Computed when loading so "now" is always current. */
function tabQuery(tab: Tab, tz: string, all: boolean): MeetingQuery {
  const now = new Date()
  const scope: MeetingScope = all ? 'all' : 'mine'
  switch (tab) {
    case 'upcoming':
      return { scope, status: 'SCHEDULED', from: now.toISOString(), sort: 'asc' }
    case 'today': {
      const ymd = zonedParts(now, tz).ymd
      return { scope, from: zonedToUtc(ymd, '00:00', tz).toISOString(), to: zonedToUtc(addDays(ymd, 1), '00:00', tz).toISOString(), sort: 'asc' }
    }
    case 'hosting':
      return { scope: 'hosting', from: now.toISOString(), sort: 'asc' }
    case 'attending':
      return { scope: 'attending', from: now.toISOString(), sort: 'asc' }
    case 'drafts':
      return { scope, status: 'DRAFT', sort: 'desc' }
    case 'past':
      return { scope, to: now.toISOString(), sort: 'desc' }
    case 'cancelled':
      return { scope, status: 'CANCELLED', sort: 'desc' }
  }
}

/**
 * Meeting list with tabs, category filter, search and paging. `group` pre-filters to the internal or customer family
 * (Internal Meetings / Customer Meetings pages); without it every meeting the user may see is listed (My Meetings).
 */
export function MeetingsList({ group, idPrefix }: { group?: 'INTERNAL' | 'CUSTOMER'; idPrefix: string }) {
  const { can } = useAuth()
  const tz = useTimeZone()
  const [tab, setTab] = useState<Tab>('upcoming')
  const [category, setCategory] = useState<DbMeetingCategory | ''>('')
  const [search, setSearch] = useState('')
  const [all, setAll] = useState(false)
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim(), 300)
  const viewAll = can('meetings.view.all')
  const showCustomer = can('customer.meetings.view')

  useEffect(() => setPage(1), [tab, category, term, all])

  const list = useLoader(
    () => meetingsApi.list({ ...tabQuery(tab, tz, all && viewAll), category: category || group || '', search: term, page, pageSize: PAGE_SIZE }),
    [tab, tz, all, viewAll, category, group, term, page],
    'Unable to load meetings.',
  )

  const categories = group === 'INTERNAL' ? INTERNAL_CATEGORIES : group === 'CUSTOMER' ? CUSTOMER_CATEGORIES : [...INTERNAL_CATEGORIES, ...(showCustomer ? CUSTOMER_CATEGORIES : [])]
  const fixedScope = tab === 'hosting' || tab === 'attending'
  const data = list.data
  const filtered = !!(term || category)
  const scheduleHref = group === 'CUSTOMER' ? '/schedule?category=CUSTOMER_PLVC' : '/schedule'

  return (
    <div className="flex flex-col gap-4">
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Meeting lists" idPrefix={idPrefix} />
      <Card>
        <div {...tabPanelProps(idPrefix, tab)} className="outline-none">
          <div className="grid grid-cols-1 gap-2.5 border-b border-line p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <SearchField value={search} onChange={setSearch} placeholder="Search title or meeting code" aria-label="Search meetings" className="sm:col-span-2 lg:col-span-1" />
            <FilterSelect aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as DbMeetingCategory | '')}>
              <option value="">{group === 'CUSTOMER' ? 'All customer categories' : group === 'INTERNAL' ? 'All internal categories' : 'All categories'}</option>
              {categories.map((c) => (
                <option key={c} value={c}>{dbCategoryLabel[c]}</option>
              ))}
            </FilterSelect>
            {viewAll && (
              <FilterSelect aria-label="Whose meetings" value={all && !fixedScope ? 'all' : 'mine'} onChange={(e) => setAll(e.target.value === 'all')} disabled={fixedScope} title={fixedScope ? 'Hosting and Attending always show your own meetings' : undefined}>
                <option value="mine">My meetings</option>
                <option value="all">All employees' meetings</option>
              </FilterSelect>
            )}
          </div>

          {list.error ? (
            <ErrorState title="Unable to load meetings" description={list.error} onRetry={list.reload} />
          ) : list.loading && !data ? (
            <ListSkeleton />
          ) : !data?.items.length ? (
            filtered ? (
              <EmptyState icon={<SearchX className="size-6" />} title="No matching meetings" description="Try a different search or category." />
            ) : (
              <EmptyState
                icon={<Video className="size-6" />}
                title={emptyText[tab]}
                description={tab === 'upcoming' || tab === 'today' ? 'Meetings you organise or are invited to appear here.' : undefined}
                action={can('meetings.create') && (tab === 'upcoming' || tab === 'today' || tab === 'hosting') ? <ButtonLink to={scheduleHref} size="sm" leftIcon={<CalendarPlus className="size-4" />}>Schedule meeting</ButtonLink> : undefined}
              />
            )
          ) : (
            <div className={cn('transition-opacity', list.loading && 'opacity-60')} aria-busy={list.loading}>
              <ul className="divide-y divide-line">
                {data.items.map((m) => (
                  <MeetingRow key={m.id} m={m} tz={tz} />
                ))}
              </ul>
              <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} disabled={list.loading} />
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

function MeetingRow({ m, tz }: { m: MeetingListItem; tz: string }) {
  const start = parseUtc(m.startUtc)
  const end = parseUtc(m.endUtc)
  const ymd = zonedParts(start, tz).ymd
  const cat = categoryMeta[m.categoryGroup] ?? categoryMeta.INTERNAL
  const inactive = m.status === 'CANCELLED' || m.status === 'DRAFT'
  return (
    <li>
      <Link to={`/meetings/${m.id}`} className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-surface-muted sm:gap-4 sm:px-5">
        <div className={cn('flex size-12 shrink-0 flex-col items-center justify-center rounded-md', inactive ? 'bg-canvas text-ink-secondary' : 'bg-brand-50 text-brand-700')}>
          <span className="text-[10px] font-bold uppercase">{formatYmd(ymd, { month: 'short' })}</span>
          <span className="text-[17px] leading-5 font-bold tabular-nums">{formatYmd(ymd, { day: 'numeric' })}</span>
        </div>
        <div className="min-w-0 flex-1 border-l-[3px] pl-3" style={{ borderColor: cat.color }}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className={cn('min-w-0 truncate text-[14px] font-semibold', m.status === 'CANCELLED' ? 'text-ink-secondary line-through' : 'text-ink group-hover:text-brand-700')}>{m.title}</p>
            <CategoryBadge group={m.categoryGroup} category={m.category} />
            {m.kind === 'INSTANT' && <Badge tone="info">Instant</Badge>}
            {m.status !== 'SCHEDULED' && <StatusBadge status={m.status} />}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-secondary">
            <Clock className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular-nums">
              {formatYmd(ymd, { weekday: 'short' })}, {formatTime(start, tz)} – {formatTime(end, tz)}
            </span>
            <span aria-hidden>·</span>
            <span>{formatDuration(Math.round((end.getTime() - start.getTime()) / 60_000))}</span>
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
            Organiser: <span className="text-ink">{m.organiser}</span>
            {m.customerName && <> · Customer: <span className="text-ink">{m.customerName}</span></>}
            <span className="ml-1 font-mono text-[11.5px] text-ink-muted">{m.meetingCode}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {m.myResponse && m.myRole !== 'HOST' && <ResponseBadge response={m.myResponse} prefix="You: " />}
            {m.myRole === 'HOST' && <Badge tone="brand">You host</Badge>}
            {m.recording && <Badge tone="neutral">Recording {m.recordingPolicy.toLowerCase()}</Badge>}
          </div>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
          <AvatarStack names={m.participants} max={3} size={26} />
          <span className="inline-flex items-center gap-1 text-[12px] text-ink-secondary">
            <Users className="size-3.5" aria-hidden /> {m.participantCount}
          </span>
        </div>
        <ChevronRight className="mt-4 size-4 shrink-0 text-ink-muted" aria-hidden />
      </Link>
    </li>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-label="Loading meetings">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-line px-5 py-4 last:border-b-0">
          <Skeleton className="size-12 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="hidden h-7 w-20 rounded-full sm:block" />
        </div>
      ))}
    </div>
  )
}
