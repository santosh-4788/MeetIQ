import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { CalendarPlus, ChevronLeft, ChevronRight, CalendarRange } from 'lucide-react'
import { calendarApi, MAX_CALENDAR_DAYS, type CalendarBlock, type CalendarItem, type CalendarMeeting } from '../../api/meetings'
import { useAuth } from '../../auth/AuthContext'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { PageHeader, Tabs, tabPanelProps } from '../../components/ui/Data'
import { Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { FilterSelect, Switch } from '../../components/ui/Form'
import { cn } from '../../lib/cn'
import { addDays, formatTime, formatYmd, parseUtc, weekday, zoneLabel, zonedParts, zonedToUtc } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { CUSTOMER_CATEGORIES, INTERNAL_CATEGORIES, categoryMeta, dbCategoryLabel, useTimeZone } from '../meetings/meta'

type View = 'month' | 'week' | 'day' | 'agenda'
const views: { id: View; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'day', label: 'Day' },
  { id: 'agenda', label: 'Agenda' },
]
const AGENDA_DAYS = 31
const HOUR_PX = 48

/** Weeks start on Monday. */
const mondayOf = (ymd: string) => addDays(ymd, -((weekday(ymd) + 6) % 7))

function addMonths(ymd: string, n: number) {
  const [y, m] = ymd.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 10)
}

function visibleRange(view: View, anchor: string) {
  switch (view) {
    case 'month':
      return { start: mondayOf(`${anchor.slice(0, 8)}01`), days: 42 }
    case 'week':
      return { start: mondayOf(anchor), days: 7 }
    case 'day':
      return { start: anchor, days: 1 }
    case 'agenda':
      return { start: anchor, days: AGENDA_DAYS }
  }
}

function step(view: View, anchor: string, dir: 1 | -1) {
  if (view === 'month') return addMonths(`${anchor.slice(0, 8)}01`, dir)
  return addDays(anchor, dir * (view === 'week' ? 7 : view === 'day' ? 1 : AGENDA_DAYS))
}

function rangeLabel(view: View, anchor: string, start: string, days: number) {
  if (view === 'month') return formatYmd(anchor, { month: 'long', year: 'numeric' })
  if (view === 'day') return formatYmd(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const end = addDays(start, days - 1)
  return `${formatYmd(start, { day: 'numeric', month: 'short' })} – ${formatYmd(end, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

type Timed<T> = T & { s: number; e: number }
type Day = { ymd: string; s: number; e: number }

const isMeeting = (i: CalendarItem): i is CalendarMeeting => i.kind === 'MEETING'
const overlaps = (x: { s: number; e: number }, d: Day) => x.s < d.e && x.e > d.s

function meetingStyle(m: CalendarMeeting): CSSProperties {
  const color = (categoryMeta[m.categoryGroup] ?? categoryMeta.INTERNAL).color
  return { borderLeftColor: color, backgroundColor: `color-mix(in srgb, ${color} 11%, var(--color-surface))` }
}

const blockShade: Record<CalendarBlock['kind'], string> = {
  LEAVE: 'bg-[repeating-linear-gradient(135deg,var(--color-warning-soft)_0_6px,var(--color-surface)_6px_12px)]',
  BLOCKED: 'bg-[repeating-linear-gradient(135deg,var(--color-canvas)_0_6px,var(--color-surface)_6px_12px)]',
}

/** /calendar — month, week, day and agenda views of the user's (or, with meetings.view.all, another employee's) calendar. */
export function CalendarPage() {
  const { can } = useAuth()
  const tz = useTimeZone()
  const today = zonedParts(new Date(), tz).ymd
  const [view, setView] = useState<View>('month')
  const [anchor, setAnchor] = useState(today)
  const [employee, setEmployee] = useState<PickedEmployee | null>(null)
  const [category, setCategory] = useState('')
  const [cancelled, setCancelled] = useState(false)
  const viewAll = can('meetings.view.all')
  const showCustomer = can('customer.meetings.view')

  const { start, days } = visibleRange(view, anchor)
  const dayList = useMemo<Day[]>(
    () => Array.from({ length: days }, (_, i) => {
      const ymd = addDays(start, i)
      return { ymd, s: zonedToUtc(ymd, '00:00', tz).getTime(), e: zonedToUtc(addDays(ymd, 1), '00:00', tz).getTime() }
    }),
    [start, days, tz],
  )
  const from = new Date(dayList[0].s).toISOString()
  const to = new Date(dayList[dayList.length - 1].e).toISOString()

  const cal = useLoader(
    () => calendarApi.get({ from, to, employeeId: employee?.id, category, includeCancelled: cancelled || undefined }),
    [from, to, employee?.id, category, cancelled],
    'Unable to load the calendar.',
  )

  const { meetings, blocks } = useMemo(() => {
    const items = cal.data?.items ?? []
    const timed = items.map((i) => ({ ...i, s: parseUtc(i.startUtc).getTime(), e: parseUtc(i.endUtc).getTime() }))
    return {
      meetings: timed.filter((i): i is Timed<CalendarMeeting> => isMeeting(i)),
      blocks: timed.filter((i): i is Timed<CalendarBlock> => !isMeeting(i)),
    }
  }, [cal.data])

  const openDay = (ymd: string) => {
    setAnchor(ymd)
    setView('day')
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Meeting Calendar"
        description={`${employee ? `${employee.displayName}'s calendar` : 'Your meetings, leave and blocked time'}. Times in ${zoneLabel(tz)}.`}
        actions={can('meetings.create') ? <ButtonLink to="/schedule" leftIcon={<CalendarPlus className="size-4" />}>Schedule meeting</ButtonLink> : undefined}
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAnchor(today)}>Today</Button>
              <div className="flex">
                <button type="button" onClick={() => setAnchor((a) => step(view, a, -1))} aria-label="Previous" title="Previous" className="flex size-8 items-center justify-center rounded-sm text-ink-secondary hover:bg-navy-900/5 hover:text-ink">
                  <ChevronLeft className="size-5" />
                </button>
                <button type="button" onClick={() => setAnchor((a) => step(view, a, 1))} aria-label="Next" title="Next" className="flex size-8 items-center justify-center rounded-sm text-ink-secondary hover:bg-navy-900/5 hover:text-ink">
                  <ChevronRight className="size-5" />
                </button>
              </div>
              <h2 className="text-[16px] leading-6 font-semibold text-ink" aria-live="polite">{rangeLabel(view, anchor, start, days)}</h2>
            </div>
            <Tabs tabs={views} value={view} onChange={setView} label="Calendar view" idPrefix="calendar-view" />
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] lg:items-end">
            {viewAll ? (
              <EmployeePicker label="View another employee" value={employee} onChange={(p) => setEmployee(p)} placeholder="Your calendar: search an employee" />
            ) : (
              <span className="hidden lg:block" />
            )}
            <FilterSelect aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              <option value="INTERNAL">All internal</option>
              {showCustomer && <option value="CUSTOMER">All customer</option>}
              {[...INTERNAL_CATEGORIES, ...(showCustomer ? CUSTOMER_CATEGORIES : [])].map((c) => <option key={c} value={c}>{dbCategoryLabel[c]}</option>)}
            </FilterSelect>
            <Switch checked={cancelled} onChange={setCancelled} label="Show cancelled" className="h-10" />
          </div>
          <Legend />
        </div>

        <div {...tabPanelProps('calendar-view', view)} className={cn('outline-none transition-opacity', cal.loading && cal.data && 'opacity-60')} aria-busy={cal.loading}>
          {cal.error ? (
            <ErrorState title="Unable to load the calendar" description={cal.error} onRetry={cal.reload} />
          ) : !cal.data && cal.loading ? (
            <div className="grid grid-cols-7 gap-px p-4" aria-label="Loading calendar">
              {Array.from({ length: 21 }, (_, i) => <Skeleton key={i} className="h-20" />)}
            </div>
          ) : view === 'month' ? (
            <MonthView days={dayList} anchor={anchor} today={today} meetings={meetings} blocks={blocks} tz={tz} onOpenDay={openDay} />
          ) : view === 'agenda' ? (
            <AgendaView days={dayList} meetings={meetings} blocks={blocks} tz={tz} />
          ) : (
            <TimeGrid days={dayList} today={today} meetings={meetings} blocks={blocks} tz={tz} onOpenDay={openDay} />
          )}
        </div>
      </Card>
      <p className="text-[12px] text-ink-muted">The calendar loads at most {MAX_CALENDAR_DAYS} days at a time. Drafts are shown only to their host.</p>
    </div>
  )
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Legend">
      {Object.values(categoryMeta).map((c) => (
        <li key={c.label} className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <span className="size-2.5 rounded-[3px]" style={{ background: c.color }} aria-hidden />
          {c.label}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <span className={cn('size-2.5 rounded-[3px] border border-warning/40', blockShade.LEAVE)} aria-hidden /> On leave
      </li>
      <li className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <span className={cn('size-2.5 rounded-[3px] border border-line-strong', blockShade.BLOCKED)} aria-hidden /> Blocked
      </li>
    </ul>
  )
}

function eventLabel(m: CalendarMeeting, tz: string) {
  return `${m.title}, ${formatTime(m.startUtc, tz)} to ${formatTime(m.endUtc, tz)}, ${(categoryMeta[m.categoryGroup] ?? categoryMeta.INTERNAL).label}${m.status === 'CANCELLED' ? ', cancelled' : m.status === 'DRAFT' ? ', draft' : ''}`
}

// ---- Month -------------------------------------------------------------------------

function MonthView({ days, anchor, today, meetings, blocks, tz, onOpenDay }: {
  days: Day[]; anchor: string; today: string; meetings: Timed<CalendarMeeting>[]; blocks: Timed<CalendarBlock>[]; tz: string; onOpenDay: (ymd: string) => void
}) {
  const month = anchor.slice(0, 7)
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-line bg-surface-muted" aria-hidden>
        {days.slice(0, 7).map((d) => (
          <div key={d.ymd} className="px-2 py-2 text-center text-[11.5px] font-semibold text-ink-secondary sm:text-left">
            <span className="sm:hidden">{formatYmd(d.ymd, { weekday: 'narrow' })}</span>
            <span className="hidden sm:inline">{formatYmd(d.ymd, { weekday: 'short' })}</span>
          </div>
        ))}
      </div>
      <ol className="grid grid-cols-7">
        {days.map((d) => {
          const dayMeetings = meetings.filter((m) => overlaps(m, d))
          const dayBlocks = blocks.filter((b) => overlaps(b, d))
          const leave = dayBlocks.find((b) => b.kind === 'LEAVE')
          const shade = leave ? blockShade.LEAVE : dayBlocks.length ? blockShade.BLOCKED : ''
          const outside = d.ymd.slice(0, 7) !== month
          const label = formatYmd(d.ymd, { weekday: 'long', day: 'numeric', month: 'long' })
          return (
            <li key={d.ymd} className={cn('min-h-[72px] border-r border-b border-line p-1 sm:min-h-[112px] sm:p-1.5 [&:nth-child(7n)]:border-r-0', shade, outside && !shade && 'bg-surface-muted')}>
              <button
                type="button"
                onClick={() => onOpenDay(d.ymd)}
                aria-label={`${label}: ${dayMeetings.length} meeting${dayMeetings.length === 1 ? '' : 's'}${leave ? ', on leave' : dayBlocks.length ? ', blocked time' : ''}. Open day view`}
                className={cn(
                  'flex size-7 items-center justify-center rounded-full text-[12.5px] font-semibold tabular-nums transition-colors hover:bg-brand-50',
                  d.ymd === today ? 'bg-brand-500 text-white hover:bg-brand-700' : outside ? 'text-ink-muted' : 'text-ink',
                )}
              >
                {Number(d.ymd.slice(8))}
              </button>
              {dayBlocks.length > 0 && (
                <p className={cn('mt-0.5 hidden truncate px-1 text-[11px] font-semibold sm:block', leave ? 'text-warning-ink' : 'text-ink-secondary')}>
                  {leave ? 'On leave' : 'Blocked'}
                </p>
              )}
              {/* Small screens: coloured dots; larger: event chips. */}
              {dayMeetings.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-0.5 px-0.5 sm:hidden" aria-hidden>
                  {dayMeetings.slice(0, 4).map((m) => (
                    <span key={m.id} className="size-1.5 rounded-full" style={{ background: (categoryMeta[m.categoryGroup] ?? categoryMeta.INTERNAL).color }} />
                  ))}
                </div>
              )}
              <ul className="mt-1 hidden flex-col gap-0.5 sm:flex">
                {dayMeetings.slice(0, 3).map((m) => (
                  <li key={m.id}>
                    <Link
                      to={`/meetings/${m.id}`}
                      aria-label={eventLabel(m, tz)}
                      style={meetingStyle(m)}
                      className={cn('block truncate rounded-[5px] border-l-[3px] px-1.5 py-0.5 text-[11.5px] leading-4 text-ink hover:shadow-card', m.status === 'CANCELLED' && 'line-through opacity-60', m.status === 'DRAFT' && 'border-dashed')}
                    >
                      <span className="font-semibold tabular-nums">{formatTime(m.startUtc, tz)}</span> {m.title}
                    </Link>
                  </li>
                ))}
                {dayMeetings.length > 3 && (
                  <li>
                    <button type="button" onClick={() => onOpenDay(d.ymd)} className="px-1.5 text-[11.5px] font-semibold text-brand-700 hover:underline">
                      +{dayMeetings.length - 3} more
                    </button>
                  </li>
                )}
              </ul>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---- Week / day time grid ------------------------------------------------------------

type Placed = { m: Timed<CalendarMeeting>; top: number; height: number; lane: number; lanes: number }

/** Side-by-side lanes for overlapping meetings within a day column. */
function place(list: Timed<CalendarMeeting>[], day: Day): Placed[] {
  const segs = list
    .filter((m) => overlaps(m, day))
    .map((m) => ({ m, s: Math.max(m.s, day.s), e: Math.min(m.e, day.e) }))
    .sort((a, b) => a.s - b.s || b.e - a.e)
  const out: Placed[] = []
  let cluster: Placed[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    cluster.forEach((p) => (p.lanes = laneEnds.length))
    cluster = []
    laneEnds = []
  }
  for (const seg of segs) {
    if (seg.s >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= seg.s)
    if (lane === -1) lane = laneEnds.push(seg.e) - 1
    else laneEnds[lane] = seg.e
    clusterEnd = Math.max(clusterEnd, seg.e)
    const top = ((seg.s - day.s) / 3_600_000) * HOUR_PX
    const p: Placed = { m: seg.m, top, height: Math.max(20, ((seg.e - seg.s) / 3_600_000) * HOUR_PX - 2), lane, lanes: 1 }
    cluster.push(p)
    out.push(p)
  }
  flush()
  return out
}

function TimeGrid({ days, today, meetings, blocks, tz, onOpenDay }: {
  days: Day[]; today: string; meetings: Timed<CalendarMeeting>[]; blocks: Timed<CalendarBlock>[]; tz: string; onOpenDay: (ymd: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  // Open at 08:00, where the working day starts.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 8 * HOUR_PX - 8
  }, [days.length])

  const hours = Array.from({ length: 24 }, (_, h) => h)
  const week = days.length > 1
  const cols = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }

  return (
    <div className="scrollbar-thin relative overflow-x-auto">
      <div className={cn(week && 'min-w-[760px]')}>
        <div className="grid border-b border-line bg-surface-muted" style={cols}>
          <div className="px-2 py-2 text-[11px] text-ink-muted">{zoneLabel(tz)}</div>
          {days.map((d) => {
            const dayBlocks = blocks.filter((b) => overlaps(b, d))
            return (
              <div key={d.ymd} className="border-l border-line px-2 py-1.5">
                <button type="button" onClick={() => onOpenDay(d.ymd)} disabled={!week} className="flex items-center gap-1.5 rounded-sm text-left enabled:hover:text-brand-700">
                  <span className="text-[11.5px] font-semibold text-ink-secondary">{formatYmd(d.ymd, { weekday: 'short' })}</span>
                  <span className={cn('flex size-7 items-center justify-center rounded-full text-[13px] font-bold tabular-nums', d.ymd === today ? 'bg-brand-500 text-white' : 'text-ink')}>
                    {Number(d.ymd.slice(8))}
                  </span>
                </button>
                {dayBlocks.map((b) => (
                  <p key={b.id} className={cn('truncate text-[11px] font-semibold', b.kind === 'LEAVE' ? 'text-warning-ink' : 'text-ink-secondary')} title={b.reason ?? undefined}>
                    {b.kind === 'LEAVE' ? 'On leave' : 'Blocked'}{b.s > d.s || b.e < d.e ? ` ${formatTime(new Date(Math.max(b.s, d.s)), tz)}–${formatTime(new Date(Math.min(b.e, d.e)), tz)}` : ''}
                  </p>
                ))}
              </div>
            )
          })}
        </div>
        <div ref={scroller} className="scrollbar-thin max-h-[640px] overflow-y-auto">
          <div className="relative grid" style={{ ...cols, height: 24 * HOUR_PX }}>
            <div className="relative">
              {hours.map((h) => (
                <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-ink-muted tabular-nums" style={{ top: h * HOUR_PX }}>
                  {h === 0 ? '' : formatTime(zonedToUtc(days[0].ymd, `${String(h).padStart(2, '0')}:00`, tz), tz)}
                </span>
              ))}
            </div>
            {days.map((d) => {
              const placed = place(meetings, d)
              const dayBlocks = blocks.filter((b) => overlaps(b, d))
              const nowTop = now >= d.s && now < d.e ? ((now - d.s) / 3_600_000) * HOUR_PX : null
              return (
                <div key={d.ymd} className="relative border-l border-line bg-[linear-gradient(to_bottom,var(--color-line)_1px,transparent_1px)] bg-[length:100%_48px]">
                  {dayBlocks.map((b) => {
                    const top = ((Math.max(b.s, d.s) - d.s) / 3_600_000) * HOUR_PX
                    const height = ((Math.min(b.e, d.e) - Math.max(b.s, d.s)) / 3_600_000) * HOUR_PX
                    return <div key={b.id} className={cn('absolute inset-x-0 opacity-90', blockShade[b.kind])} style={{ top, height }} title={b.kind === 'LEAVE' ? 'On leave' : 'Blocked'} aria-hidden />
                  })}
                  {placed.map((p) => (
                    <Link
                      key={p.m.id}
                      to={`/meetings/${p.m.id}`}
                      aria-label={eventLabel(p.m, tz)}
                      className={cn(
                        'absolute overflow-hidden rounded-[6px] border-l-[3px] px-1.5 py-0.5 text-[11.5px] leading-4 text-ink shadow-card transition-shadow hover:z-10 hover:shadow-raised',
                        p.m.status === 'CANCELLED' && 'line-through opacity-60',
                        p.m.status === 'DRAFT' && 'border-dashed',
                      )}
                      style={{ ...meetingStyle(p.m), top: p.top + 1, height: p.height, left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`, width: `calc(${100 / p.lanes}% - 4px)` }}
                    >
                      <span className="block truncate font-semibold">{p.m.title}</span>
                      {p.height >= 34 && (
                        <span className="block truncate text-ink-secondary tabular-nums">
                          {formatTime(p.m.startUtc, tz)} – {formatTime(p.m.endUtc, tz)}
                        </span>
                      )}
                    </Link>
                  ))}
                  {nowTop !== null && (
                    <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }} aria-hidden>
                      <span className="-ml-1 size-2 rounded-full bg-danger" />
                      <span className="h-px flex-1 bg-danger" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Agenda --------------------------------------------------------------------------

function AgendaView({ days, meetings, blocks, tz }: { days: Day[]; meetings: Timed<CalendarMeeting>[]; blocks: Timed<CalendarBlock>[]; tz: string }) {
  const groups = days
    .map((d) => ({ d, ms: meetings.filter((m) => overlaps(m, d)), bs: blocks.filter((b) => overlaps(b, d)) }))
    .filter((g) => g.ms.length || g.bs.length)
  if (!groups.length)
    return <EmptyState icon={<CalendarRange className="size-6" />} title="Nothing in the next 31 days" description="Meetings, leave and blocked time in this period appear here." />
  return (
    <ol className="divide-y divide-line">
      {groups.map(({ d, ms, bs }) => (
        <li key={d.ymd} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:gap-6 sm:px-5">
          <p className="w-40 shrink-0 text-[13px] font-semibold text-ink">{formatYmd(d.ymd, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</p>
          <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
            {bs.map((b) => (
              <li key={b.id} className={cn('flex items-center gap-3 rounded-md border border-line px-3 py-2 text-[13px]', blockShade[b.kind])}>
                <Badge tone={b.kind === 'LEAVE' ? 'warning' : 'neutral'}>{b.kind === 'LEAVE' ? 'On leave' : 'Blocked'}</Badge>
                <span className="text-ink-secondary tabular-nums">
                  {b.s <= d.s && b.e >= d.e ? 'All day' : `${formatTime(new Date(Math.max(b.s, d.s)), tz)} – ${formatTime(new Date(Math.min(b.e, d.e)), tz)}`}
                </span>
                {b.reason && <span className="truncate text-ink">{b.reason}</span>}
              </li>
            ))}
            {ms.map((m) => (
              <li key={m.id}>
                <Link to={`/meetings/${m.id}`} style={meetingStyle(m)} className="flex flex-col gap-0.5 rounded-md border-l-[3px] px-3 py-2 transition-shadow hover:shadow-card sm:flex-row sm:items-center sm:gap-3">
                  <span className="w-36 shrink-0 text-[12.5px] font-semibold text-ink tabular-nums">{formatTime(m.startUtc, tz)} – {formatTime(m.endUtc, tz)}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink', m.status === 'CANCELLED' && 'line-through opacity-70')}>{m.title}</span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone={(categoryMeta[m.categoryGroup] ?? categoryMeta.INTERNAL).tone}>{dbCategoryLabel[m.category] ?? m.category}</Badge>
                    {m.status === 'CANCELLED' && <Badge tone="danger">Cancelled</Badge>}
                    {m.status === 'DRAFT' && <Badge tone="neutral">Draft</Badge>}
                    {m.role === 'HOST' ? <Badge tone="brand">Host</Badge> : m.responseStatus === 'PENDING' ? <Badge tone="warning">Awaiting reply</Badge> : m.responseStatus === 'TENTATIVE' ? <Badge tone="info">Tentative</Badge> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}
