import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'motion/react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  ArrowRight, CalendarCheck, CalendarClock, CalendarDays, CalendarPlus, CircleAlert, CircleCheck, Clapperboard, Clock, Handshake,
  Hourglass, LogIn, RefreshCw, UserCheck, Users, Video, Radio,
} from 'lucide-react'
import { dashboardApi } from '../api'
import type { ActivityItem, DashboardSummary, MeetingSummary } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { Card, CardHeader, StatCard } from '../components/ui/Card'
import { AvatarStack } from '../components/ui/Avatar'
import { Badge, EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback'
import { Button, ButtonLink } from '../components/ui/Button'
import { chartTheme, colors, meetingCategoryColors } from '../design/tokens'
import { DEFAULT_TIME_ZONE } from '../config'
import { cn } from '../lib/cn'
import { categoryMeta } from './meetings/meta'
import { JoinMeetingDialog, NewMeetingDialog } from './meetings/QuickMeetingDialogs'

const JOIN_WINDOW_MS = 10 * 60_000

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function DashboardPage() {
  const { user, can } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const [data, setData] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [quick, setQuick] = useState<'new' | 'join' | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    dashboardApi
      .getSummary()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Unable to load the dashboard.'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const fmt = useFormatters(tz)
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()))
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] leading-8 font-bold tracking-[-0.015em] text-ink">
            {greeting}, {user?.displayName.split(' ')[0]} <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-secondary">
            {fmt.longDate(new Date())} · Here's what's happening across your meetings today.
          </p>
        </div>
        {/* Only links the user may open: a role without these permissions would land on Access denied. */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          {can('meetings.create') && (
            <Button onClick={() => setQuick('new')} leftIcon={<Video className="size-4" />} data-testid="new-meeting">
              New meeting
            </Button>
          )}
          {(can('meetings.view.own') || can('meetings.view.all')) && (
            <Button variant="secondary" onClick={() => setQuick('join')} leftIcon={<LogIn className="size-4" />} data-testid="join-meeting">
              Join meeting
            </Button>
          )}
          {can('meetings.create') && (
            <ButtonLink to="/schedule" variant="secondary" leftIcon={<CalendarPlus className="size-4" />}>
              Schedule
            </ButtonLink>
          )}
          {can('calendar.view') && (
            <ButtonLink to="/calendar" variant="secondary" leftIcon={<CalendarDays className="size-4" />}>
              Calendar
            </ButtonLink>
          )}
        </div>
      </div>
      <NewMeetingDialog open={quick === 'new'} onClose={() => setQuick(null)} />
      <JoinMeetingDialog open={quick === 'join'} onClose={() => setQuick(null)} />

      {error ? (
        <Card>
          <ErrorState title="Unable to load the dashboard" description={error} onRetry={load} />
        </Card>
      ) : loading && !data ? (
        <DashboardSkeleton />
      ) : data ? (
        <DashboardContent data={data} fmt={fmt} reloading={loading} onReload={load} />
      ) : null}
    </div>
  )
}

type Fmt = ReturnType<typeof useFormatters>

/** Card header link shown only when the user may open the target page. */
function PermittedLink({ permission, to, children }: { permission: string; to: string; children: ReactNode }) {
  const { can } = useAuth()
  if (!can(permission)) return null
  return <Link to={to} className="text-[13px] font-semibold text-brand-700 hover:underline">{children}</Link>
}

function useFormatters(tz: string) {
  return {
    time: (iso: string | Date) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso)),
    day: (iso: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso)),
    longDate: (d: Date) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(d),
  }
}

function relative(iso: string, now: number) {
  const diff = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (diff < 1) return 'Just now'
  if (diff < 60) return `${diff} min ago`
  const h = Math.round(diff / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

const stagger = {
  container: { animate: { transition: { staggerChildren: 0.04 } } },
  item: { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } } },
}

function DashboardContent({ data, fmt, reloading, onReload }: { data: DashboardSummary; fmt: Fmt; reloading: boolean; onReload: () => void }) {
  const k = data.kpis
  const kpis: { label: string; value: number; icon: ReactNode; accent: Parameters<typeof StatCard>[0]['accent']; footnote: string }[] = [
    { label: 'Total Employees', value: k.totalEmployees, icon: <Users className="size-[18px]" />, accent: 'navy', footnote: 'Active employees' },
    { label: "Today's Meetings", value: k.todaysMeetings, icon: <CalendarCheck className="size-[18px]" />, accent: 'brand', footnote: 'Scheduled today' },
    { label: 'Upcoming Meetings', value: k.upcomingMeetings, icon: <CalendarClock className="size-[18px]" />, accent: 'cyan', footnote: 'Next 7 days' },
    { label: 'Internal Meetings', value: k.internalMeetings, icon: <Video className="size-[18px]" />, accent: 'brand', footnote: 'This month' },
    { label: 'Customer Meetings', value: k.customerMeetings, icon: <Handshake className="size-[18px]" />, accent: 'success', footnote: 'This month' },
    { label: 'Completed Meetings', value: k.completedMeetings, icon: <CircleCheck className="size-[18px]" />, accent: 'success', footnote: 'This month' },
    { label: 'Total Recordings', value: k.totalRecordings, icon: <Clapperboard className="size-[18px]" />, accent: 'violet', footnote: 'Verified' },
    { label: 'Pending Recordings', value: k.pendingRecordings, icon: <Hourglass className="size-[18px]" />, accent: 'warning', footnote: 'Processing / queued' },
  ]

  return (
    <motion.div variants={stagger.container} initial="initial" animate="animate" className="flex flex-col gap-5">
      <motion.div variants={stagger.container} className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <motion.div key={kpi.label} variants={stagger.item}>
            <StatCard {...kpi} />
          </motion.div>
        ))}
      </motion.div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <motion.div variants={stagger.item}>
          <NextMeetingCard meeting={data.nextMeeting} fmt={fmt} />
        </motion.div>
        <motion.div variants={stagger.item} className="xl:col-span-2">
          <TodaySchedule meetings={data.todaySchedule} fmt={fmt} />
        </motion.div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <motion.div variants={stagger.item} className="xl:col-span-2">
          <WeeklyTrend data={data.weeklyTrend} />
        </motion.div>
        <motion.div variants={stagger.item}>
          <RecordingStatus data={data.recordingStatus} />
        </motion.div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <motion.div variants={stagger.item} className="xl:col-span-2">
          <DepartmentChart data={data.departmentMeetings} />
        </motion.div>
        <motion.div variants={stagger.item}>
          <AttendanceCard data={data.attendance} />
        </motion.div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <motion.div variants={stagger.item} className="xl:col-span-2">
          <UpcomingList meetings={data.upcoming} fmt={fmt} />
        </motion.div>
        <motion.div variants={stagger.item}>
          <RecentActivity items={data.recentActivity} />
        </motion.div>
      </div>

      <p className="flex items-center justify-end gap-2 text-[12px] text-ink-muted">
        Updated {fmt.time(data.generatedUtc)}
        <button onClick={onReload} disabled={reloading} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline disabled:opacity-60">
          <RefreshCw className={cn('size-3.5', reloading && 'animate-spin')} /> Refresh
        </button>
      </p>
    </motion.div>
  )
}

// ---- Next meeting -----------------------------------------------------------

function NextMeetingCard({ meeting, fmt }: { meeting: MeetingSummary | null; fmt: Fmt }) {
  const { can } = useAuth()
  const now = useNow(15_000)
  if (!meeting)
    return (
      <Card className="h-full">
        <EmptyState icon={<CalendarCheck className="size-6" />} title="No upcoming meetings" description={can('meetings.create') ? "You're free for now. Schedule a meeting to get started." : "You're free for now."} action={can('meetings.create') ? <ButtonLink to="/schedule" size="sm">Schedule meeting</ButtonLink> : undefined} />
      </Card>
    )
  const start = new Date(meeting.startUtc).getTime()
  const mins = Math.max(0, Math.round((start - now) / 60_000))
  // The API decides (participant + room open); the demo adapter has no flag and keeps the old 10-minute rule.
  const canJoin = meeting.joinable ?? (start - now <= JOIN_WINDOW_MS && new Date(meeting.endUtc).getTime() > now)
  const cat = categoryMeta[meeting.category]
  return (
    <section className="relative flex h-full min-h-[260px] flex-col overflow-hidden rounded-lg bg-gradient-brand p-5 text-white shadow-raised">
      <div className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-cyan-400/15 blur-2xl" aria-hidden />
      <div className="pointer-events-none absolute right-5 bottom-5 opacity-[0.08]" aria-hidden>
        <Video className="size-28" />
      </div>
      <div className="relative flex items-center justify-between">
        <p className="eyebrow text-cyan-400">Next meeting</p>
        <span className="rounded-full bg-white/12 px-2.5 py-1 text-[11.5px] font-semibold ring-1 ring-white/15">{cat.label}</span>
      </div>
      <h2 className="relative mt-3 text-[19px] leading-7 font-bold">{meeting.title}</h2>
      <p className="relative mt-1.5 flex items-center gap-1.5 text-[13px] text-white/75">
        <Clock className="size-3.5" />
        {fmt.day(meeting.startUtc)} · {fmt.time(meeting.startUtc)} – {fmt.time(meeting.endUtc)}
      </p>
      <p className="relative mt-1 text-[13px] text-white/75">Organiser: {meeting.organiser}</p>
      <div className="relative mt-auto flex items-end justify-between gap-3 pt-5">
        <div>
          <p className="text-[12px] text-white/60">Starts in</p>
          <p className="text-[26px] leading-8 font-bold tabular-nums">
            {mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`}
          </p>
        </div>
        {canJoin ? (
          <ButtonLink to={`/meetings/${meeting.id}/room`} className="!bg-white !text-navy-900 hover:!bg-cyan-50" rightIcon={<ArrowRight className="size-4" />}>
            Join now
          </ButtonLink>
        ) : (
          <span className="text-right text-[12px] text-white/60">
            Join opens
            <br />
            {meeting.joinOpensUtc ? `at ${fmt.time(meeting.joinOpensUtc)}` : '10 min before start'}
          </span>
        )}
      </div>
    </section>
  )
}

// ---- Today's schedule -------------------------------------------------------

function TodaySchedule({ meetings, fmt }: { meetings: MeetingSummary[]; fmt: Fmt }) {
  const now = useNow()
  return (
    <Card className="h-full">
      <CardHeader title="Today's schedule" subtitle={`${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`} action={<PermittedLink permission="calendar.view" to="/calendar">Open calendar</PermittedLink>} />
      {meetings.length === 0 ? (
        <EmptyState title="Nothing scheduled today" description="Meetings you organise or are invited to will appear here." />
      ) : (
        <ol className="relative px-5 pb-4">
          {meetings.map((m, i) => {
            const start = new Date(m.startUtc).getTime()
            const end = new Date(m.endUtc).getTime()
            // The meeting's real status decides: LIVE only while the room is actually running; ended, completed or
            // cancelled meetings are never shown as live, even inside their scheduled slot.
            const finished = m.status === 'COMPLETED' || m.status === 'CANCELLED'
            const live = m.status === 'LIVE'
            const done = finished || (!live && end <= now)
            const canJoin = m.joinable ?? (!done && start - now <= JOIN_WINDOW_MS)
            const cat = categoryMeta[m.category]
            return (
              <li key={m.id} className="group relative flex gap-4 py-2.5">
                <div className="w-[68px] shrink-0 pt-0.5 text-right">
                  <p className={cn('text-[13px] font-semibold tabular-nums', done ? 'text-ink-muted' : 'text-ink')}>{fmt.time(m.startUtc)}</p>
                  <p className="text-[11.5px] text-ink-muted tabular-nums">{Math.round((end - start) / 60_000)} min</p>
                </div>
                <div className="relative flex flex-col items-center">
                  <span className={cn('z-10 mt-1.5 size-2.5 rounded-full ring-4 ring-surface', live && 'animate-rec')} style={{ background: done ? colors.inkMuted : cat.color }} />
                  {i < meetings.length - 1 && <span className="absolute top-3 bottom-[-14px] w-px bg-line" />}
                </div>
                <div
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-2 rounded-md border px-3.5 py-2.5 transition-[border-color,box-shadow] duration-150 sm:flex-row sm:items-center',
                    live ? 'border-danger/25 bg-danger-soft/40' : 'border-line group-hover:border-line-strong group-hover:shadow-card',
                    done && 'opacity-70',
                  )}
                  style={{ borderLeft: `3px solid ${cat.color}` }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-[13.5px] font-semibold text-ink">{m.title}</p>
                      {live && <Badge tone="live" dot>LIVE</Badge>}
                      {m.status === 'COMPLETED' && <Badge tone="neutral">Ended</Badge>}
                      {m.status === 'CANCELLED' && <Badge tone="neutral">Cancelled</Badge>}
                      {m.recording && !done && <Badge tone="neutral">Recording on</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-ink-secondary">
                      {cat.label} · {m.organiser}
                      {m.customerName && ` · Customer: ${m.customerName}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <AvatarStack names={m.participants} max={3} size={26} />
                    {done ? (
                      <Badge tone="success">Completed</Badge>
                    ) : canJoin ? (
                      <ButtonLink to={`/meetings/${m.id}/room`} size="sm" leftIcon={<Video className="size-3.5" />}>Join</ButtonLink>
                    ) : (
                      <ButtonLink to={`/meetings/${m.id}`} size="sm" variant="secondary">Details</ButtonLink>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}

// ---- Charts -----------------------------------------------------------------

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-[12px] shadow-overlay">
      {label && <p className="mb-1 font-semibold text-ink">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-ink-secondary">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-semibold text-ink tabular-nums">{p.value}</span>
        </p>
      ))}
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <span className="size-2.5 rounded-[3px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

const axisProps = { stroke: chartTheme.axis, fontSize: chartTheme.fontSize, tickLine: false, axisLine: false } as const

function WeeklyTrend({ data }: { data: DashboardSummary['weeklyTrend'] }) {
  return (
    <Card className="h-full">
      <CardHeader title="Weekly meeting trend" subtitle="Scheduled vs completed, this week" action={<Legend items={[{ label: 'Scheduled', color: colors.brand500 }, { label: 'Completed', color: colors.cyan400 }]} />} />
      <div className="h-[260px] px-2 pb-3">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="g-sched" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={colors.brand500} stopOpacity={0.22} />
                <stop offset="1" stopColor={colors.brand500} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="g-comp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={colors.cyan400} stopOpacity={0.22} />
                <stop offset="1" stopColor={colors.cyan400} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="day" {...axisProps} />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: colors.line }} />
            <Area type="monotone" dataKey="scheduled" name="Scheduled" stroke={colors.brand500} strokeWidth={2.4} fill="url(#g-sched)" animationDuration={900} />
            <Area type="monotone" dataKey="completed" name="Completed" stroke={colors.cyan400} strokeWidth={2.4} fill="url(#g-comp)" animationDuration={900} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

function DepartmentChart({ data }: { data: DashboardSummary['departmentMeetings'] }) {
  return (
    <Card className="h-full">
      <CardHeader title="Department-wise meetings" subtitle="This month" action={<Legend items={[{ label: 'Internal', color: meetingCategoryColors.internal }, { label: 'Customer', color: meetingCategoryColors.customer }]} />} />
      <div className="h-[280px] px-2 pb-3">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 16, left: -12, bottom: 0 }} barGap={4}>
            <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="department" {...axisProps} interval={0} tick={{ fontSize: 11 }} />
            <YAxis {...axisProps} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: '#F1F5FB' }} />
            <Bar dataKey="internal" name="Internal" fill={meetingCategoryColors.internal} radius={[5, 5, 0, 0]} maxBarSize={22} animationDuration={900} />
            <Bar dataKey="customer" name="Customer" fill={meetingCategoryColors.customer} radius={[5, 5, 0, 0]} maxBarSize={22} animationDuration={900} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

function RecordingStatus({ data }: { data: DashboardSummary['recordingStatus'] }) {
  const rows = [
    { label: 'Completed', value: data.completed, color: colors.success },
    { label: 'Processing', value: data.processing, color: colors.brand500 },
    { label: 'Pending', value: data.pending, color: colors.warning },
    { label: 'Failed', value: data.failed, color: colors.danger },
  ]
  const total = rows.reduce((s, r) => s + r.value, 0)
  return (
    <Card className="h-full">
      <CardHeader title="Recording status" subtitle="Last 30 days" action={<PermittedLink permission="recordings.view.own" to="/recordings">Library</PermittedLink>} />
      <div className="flex flex-col items-center gap-4 px-5 pb-5 sm:flex-row xl:flex-col 2xl:flex-row">
        <div className="relative size-[150px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows} dataKey="value" nameKey="label" innerRadius={52} outerRadius={70} paddingAngle={2} stroke="none" animationDuration={900}>
                {rows.map((r) => (
                  <Cell key={r.label} fill={r.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[22px] leading-7 font-bold tabular-nums">{total}</span>
            <span className="text-[11px] text-ink-muted">recordings</span>
          </div>
        </div>
        <ul className="flex w-full flex-col gap-2.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-2.5 text-[13px]">
              <span className="size-2.5 rounded-full" style={{ background: r.color }} />
              <span className="flex-1 text-ink-secondary">{r.label}</span>
              <span className="font-semibold tabular-nums">{r.value}</span>
              <span className="w-10 text-right text-[12px] text-ink-muted tabular-nums">{total ? Math.round((r.value / total) * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

function AttendanceCard({ data }: { data: DashboardSummary['attendance'] }) {
  const total = data.attended + data.late + data.missed
  const pct = (v: number) => (total ? Math.round((v / total) * 100) : 0)
  const rows = [
    { label: 'On time', value: data.attended, color: colors.success },
    { label: 'Joined late', value: data.late, color: colors.warning },
    { label: 'Missed', value: data.missed, color: colors.danger },
  ]
  return (
    <Card className="h-full">
      <CardHeader title="Meeting attendance" subtitle="Participants, this month" />
      <div className="px-5 pb-5">
        <div className="flex items-end gap-2">
          <span className="text-[34px] leading-10 font-bold tracking-[-0.02em] tabular-nums">{pct(data.attended + data.late)}%</span>
          <span className="mb-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-secondary">
            <UserCheck className="size-4 text-success" /> attendance rate
          </span>
        </div>
        <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-canvas">
          {rows.map((r) => (
            <motion.span key={r.label} initial={{ width: 0 }} animate={{ width: `${pct(r.value)}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} style={{ background: r.color }} />
          ))}
        </div>
        <ul className="mt-5 flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-2.5 text-[13px]">
              <span className="size-2.5 rounded-full" style={{ background: r.color }} />
              <span className="flex-1 text-ink-secondary">{r.label}</span>
              <span className="font-semibold tabular-nums">{pct(r.value)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

// ---- Lists ------------------------------------------------------------------

function UpcomingList({ meetings, fmt }: { meetings: MeetingSummary[]; fmt: Fmt }) {
  return (
    <Card className="h-full">
      <CardHeader title="Upcoming meetings" subtitle="Next 7 days" action={<PermittedLink permission="meetings.view.own" to="/meetings">View all</PermittedLink>} />
      {meetings.length === 0 ? (
        <EmptyState title="No upcoming meetings" />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {meetings.map((m) => {
            const cat = categoryMeta[m.category]
            const d = new Date(m.startUtc)
            return (
              <li key={m.id}>
                <Link to={`/meetings/${m.id}`} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-muted">
                  <div className="flex size-12 shrink-0 flex-col items-center justify-center rounded-md bg-brand-50 text-brand-700">
                    <span className="text-[10px] font-bold uppercase">{fmt.day(m.startUtc).split(' ')[0].replace(',', '')}</span>
                    <span className="text-[17px] leading-5 font-bold tabular-nums">{d.toLocaleDateString('en-IN', { day: 'numeric', timeZone: DEFAULT_TIME_ZONE })}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-ink">{m.title}</p>
                    <p className="truncate text-[12px] text-ink-secondary">
                      {fmt.time(m.startUtc)} – {fmt.time(m.endUtc)} · {m.organiser}
                    </p>
                  </div>
                  <Badge tone={cat.tone} className="hidden sm:inline-flex">{cat.label}</Badge>
                  <AvatarStack names={m.participants} max={3} size={26} />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

const activityIcon: Record<ActivityItem['type'], { icon: ReactNode; cls: string }> = {
  MEETING_COMPLETED: { icon: <CircleCheck className="size-4" />, cls: 'bg-success-soft text-success' },
  RECORDING_READY: { icon: <Clapperboard className="size-4" />, cls: 'bg-[#F1ECFE] text-[#7C3AED]' },
  RECORDING_FAILED: { icon: <CircleAlert className="size-4" />, cls: 'bg-danger-soft text-danger' },
  INVITE_ACCEPTED: { icon: <UserCheck className="size-4" />, cls: 'bg-brand-50 text-brand-500' },
  MEETING_RESCHEDULED: { icon: <CalendarClock className="size-4" />, cls: 'bg-warning-soft text-warning-ink' },
  MEETING_CANCELLED: { icon: <Radio className="size-4" />, cls: 'bg-danger-soft text-danger' },
}

function RecentActivity({ items }: { items: ActivityItem[] }) {
  const now = useNow(60_000)
  return (
    <Card className="h-full">
      <CardHeader title="Recent activity" />
      {items.length === 0 ? (
        <EmptyState title="No recent activity" />
      ) : (
        <ul className="flex flex-col gap-1 px-3 pb-3">
          {items.map((a) => (
            <li key={a.id} className="flex gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-surface-muted">
              <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', activityIcon[a.type].cls)}>{activityIcon[a.type].icon}</span>
              <div className="min-w-0">
                <p className="text-[13px] leading-5 text-ink">{a.text}</p>
                <p className="text-[11.5px] text-ink-muted">
                  {a.actor} · {relative(a.atUtc, now)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="p-4.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-3 h-8 w-16" />
            <Skeleton className="mt-2 h-3 w-20" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Skeleton className="h-[260px] rounded-lg" />
        <Card className="p-5 xl:col-span-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="mb-3 h-12 w-full" />
          ))}
        </Card>
      </div>
    </div>
  )
}
