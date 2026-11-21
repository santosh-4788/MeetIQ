import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlarmClock, Bell, BellRing, CalendarPlus, Check, ChevronRight, ClipboardCheck, Hand, ListPlus, MessageSquare, MessageSquarePlus, Phone, PhoneIncoming, PhoneMissed,
  PhoneOutgoing, Search, Star, StickyNote, Sun, UserPlus, Users, Video,
} from 'lucide-react'
import { chatApi } from '../../../api/chat'
import type { Call } from '../../../api/calls'
import { errorMessage } from '../../../api/types'
import { workApi, type MyDay as MyDayData, type Reminder, type Task } from '../../../api/work'
import { Avatar } from '../../../components/ui/Avatar'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { useChat } from '../ChatProvider'
import { useCalls } from '../CallProvider'
import { listTime } from '../chatUtils'
import type { Section } from '../ChatPage'
import { NoteEditor, PersonPicker, TaskEditor, type TaskSeed } from './Editors'
import FollowUpSheet, { type FollowUpSource } from './FollowUp'
import { NoteRow } from './NotesView'
import { TaskRow, useFocusToggle, useTaskToggle } from './TasksView'
import { PRIORITY, timeText, tomorrowAt9, whenText } from './ui'

/** Apple-Fitness-style ring: today's progress (done / planned). */
function Ring({ done, total, size = 76 }: { done: number; total: number; size?: number }) {
  const r = (size - 10) / 2
  const c = 2 * Math.PI * r
  const f = total ? Math.min(1, done / total) : 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${done} of ${total} done today`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.25)" strokeWidth={9} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeWidth={9} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - f)} style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(.2,.8,.2,1)' }} />
    </svg>
  )
}

function Card({ title, icon, tint, count, action, children, testId }: { title: string; icon: ReactNode; tint: string; count?: number; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="overflow-hidden rounded-[14px] bg-white" data-testid={testId}>
      <header className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <span className="flex size-[26px] items-center justify-center rounded-[7px] text-white" style={{ background: tint }}>{icon}</span>
        <h3 className="flex-1 text-[17px] font-semibold">{title}</h3>
        {count !== undefined && count > 0 && <span className="text-[15px] text-[var(--ios-gray)]">{count}</span>}
        {action}
      </header>
      <div className="ios-list pb-1">{children}</div>
    </section>
  )
}

function Line({ children }: { children: ReactNode }) {
  return <p className="px-4 pb-3 text-[15px] text-[var(--ios-gray)]">{children}</p>
}

function QuickAction({ label, icon, tint, onClick, testId }: { label: string; icon: ReactNode; tint: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-1.5 active:opacity-60" data-testid={testId}>
      <span className="flex size-[52px] items-center justify-center rounded-[14px] text-white shadow-[0_2px_6px_rgb(0_0_0/0.12)]" style={{ background: tint }}>{icon}</span>
      <span className="text-center text-[12px] leading-[14px] text-[var(--ios-label)]">{label}</span>
    </button>
  )
}

function ReminderLine({ r, missed, onChanged }: { r: Reminder; missed?: boolean; onChanged: () => void }) {
  const toast = useToast()
  const navigate = useNavigate()
  const act = (p: Promise<unknown>, ok: string) => p.then(() => (toast.success(ok), onChanged()), (e) => toast.error(errorMessage(e, 'That did not work.')))
  return (
    <div className="flex items-start gap-3 pl-4" data-testid={missed ? 'myday-missed' : 'myday-reminder'}>
      <span className={cn('mt-3 flex size-[26px] shrink-0 items-center justify-center rounded-full', missed ? 'bg-[var(--ios-red)]/12 text-[var(--ios-red)]' : 'bg-[var(--ios-orange)]/12 text-[var(--ios-orange)]')}>
        {missed ? <BellRing className="size-[15px]" /> : <Bell className="size-[15px]" />}
      </span>
      <div className="ios-sep-top min-w-0 flex-1 py-2.5 pr-3">
        <button type="button" onClick={() => navigate(`/chat?tab=${r.kind === 'TASK' ? 'tasks' : 'notes'}&${r.kind === 'TASK' ? 'task' : 'note'}=${r.itemId}`)} className="block w-full text-left">
          <span className="block truncate text-[16px]">{r.title}</span>
          <span className={cn('block text-[13px]', missed ? 'text-[var(--ios-red)]' : 'text-[var(--ios-gray)]')}>{missed ? `Was due ${whenText(r.dueUtc)}` : whenText(r.dueUtc)}{r.kind === 'NOTE' ? ' · Note' : ''}</span>
        </button>
        {missed && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" className="ios-btn-tinted h-[30px] px-3 text-[14px]" onClick={() => act(workApi.done(r.id), r.kind === 'TASK' ? 'Task completed' : 'Marked as done')}>Complete</button>
            <button type="button" className="ios-btn-tinted h-[30px] px-3 text-[14px]" onClick={() => act(workApi.snooze(r.id, { minutes: 60 }), 'Reminder in 1 hour')}>In 1 hour</button>
            <button type="button" className="ios-btn-tinted h-[30px] px-3 text-[14px]" onClick={() => act(workApi.snooze(r.id, { untilUtc: tomorrowAt9() }), 'Reminder tomorrow at 9:00')}>Tomorrow</button>
            <button type="button" className="h-[30px] px-2 text-[14px] text-[var(--ios-gray)]" onClick={() => act(workApi.dismiss(r.id), 'Dismissed')}>Dismiss</button>
          </span>
        )}
      </div>
    </div>
  )
}

function callLine(c: Call, meId: string | null) {
  const outgoing = c.startedBy?.id === meId
  const mine = c.participants.find((p) => p.id === meId)
  const others = c.participants.filter((p) => p.id !== meId)
  const name = c.title ?? (others.length === 1 ? others[0].name : others.map((p) => p.name.split(' ')[0]).join(', '))
  const missed = !outgoing && (mine?.state === 'MISSED' || mine?.state === 'BUSY' || mine?.state === 'DECLINED')
  return { name, outgoing, missed }
}

/** My Day: everything for today in one compact page, with quick actions. */
export function MyDay({ onSection, onOpenChat, onNewChat, onNewGroup }: {
  onSection: (s: Section) => void
  onOpenChat: (id: string) => void
  onNewChat: () => void
  onNewGroup: () => void
}) {
  const chat = useChat()
  const calls = useCalls()
  const navigate = useNavigate()
  const toast = useToast()
  const [data, setData] = useState<MyDayData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newTask, setNewTask] = useState<TaskSeed | null>(null)
  const [newNote, setNewNote] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [picker, setPicker] = useState<'call' | null>(null)
  const [followUp, setFollowUp] = useState<FollowUpSource | null>(null)

  const load = useCallback(() => {
    workApi.myDay().then(
      (d) => {
        setData(d)
        setError(null)
      },
      (e) => setError(errorMessage(e, 'My Day could not be loaded.')),
    )
  }, [])
  useEffect(() => {
    load()
    let h = 0
    const later = () => (window.clearTimeout(h), (h = window.setTimeout(load, 600)))
    const offs = [chat.on('reminder.due', load), chat.on('reconnected', load), chat.on('call.ended', load), chat.on('task.changed', later)]
    const t = window.setInterval(load, 120_000)
    return () => {
      offs.forEach((o) => o())
      window.clearInterval(t)
      window.clearTimeout(h)
    }
  }, [chat, load])

  const replaceTask = useCallback((t: Task) => {
    setData((d) => d && {
      ...d,
      todayTasks: d.todayTasks.map((x) => (x.id === t.id ? t : x)),
      overdueTasks: d.overdueTasks.map((x) => (x.id === t.id ? t : x)),
      followUps: d.followUps.map((x) => (x.id === t.id ? t : x)),
      focus: d.focus?.map((x) => (x.id === t.id ? t : x)),
      newAssigned: d.newAssigned?.map((x) => (x.id === t.id ? t : x)),
    })
  }, [])
  const focusToggle = useFocusToggle(() => load())
  const toggle = useTaskToggle((t) => {
    replaceTask(t)
    if (t.status === 'COMPLETED') window.setTimeout(load, 1400)
  })

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const first = (chat.status?.enabled ? chat.status.me.name : '').split(' ')[0]

  const counts = data?.counts
  const tiles: { key: string; label: string; value: number; tint: string; icon: ReactNode; go: () => void }[] = data
    ? [
        { key: 'today', label: 'Today', value: counts!.todayTasks, tint: 'var(--ios-blue)', icon: <Sun className="size-[18px]" />, go: () => navigate('/chat?tab=tasks&filter=today') },
        { key: 'overdue', label: 'Overdue', value: counts!.overdue, tint: 'var(--ios-orange)', icon: <AlarmClock className="size-[18px]" />, go: () => navigate('/chat?tab=tasks&filter=overdue') },
        { key: 'missed', label: 'Missed reminders', value: counts!.missed, tint: 'var(--ios-red)', icon: <BellRing className="size-[18px]" />, go: () => document.getElementById('myday-missed')?.scrollIntoView({ behavior: 'smooth' }) },
        { key: 'followups', label: 'Follow-ups', value: counts!.followUps, tint: 'var(--ios-purple)', icon: <MessageSquare className="size-[18px]" />, go: () => navigate('/chat?tab=tasks&filter=followups') },
      ]
    : []

  return (
    <div className="mx-auto w-full max-w-[1100px]" data-testid="myday-view">
      {(() => {
        const doneToday = data?.counts.completedToday ?? 0
        const planned = doneToday + (data?.counts.todayTasks ?? 0) + (data?.counts.overdue ?? 0)
        const left = planned - doneToday
        return (
          <section className="relative overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#0a84ff_0%,#5e5ce6_55%,#bf5af2_100%)] px-4 py-4 text-white shadow-[0_10px_30px_rgb(94_92_230/0.28)] sm:px-5" data-testid="myday-hero">
            <span className="pointer-events-none absolute -top-10 -right-8 size-40 rounded-full bg-white/10" aria-hidden />
            <div className="relative flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold tracking-wide text-white/80 uppercase">{new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(now)}</p>
                <p className="mt-0.5 text-[22px] leading-[28px] font-bold">{greeting}{first ? `, ${first}` : ''}</p>
                <p className="mt-1 text-[14px] text-white/90">
                  {!data ? 'Getting your day ready…' : planned === 0 ? 'Nothing due today. Plan your Top 3 below.' : left === 0 ? `All ${planned} done today. Great work!` : `${doneToday} of ${planned} done · ${left} to go${data.counts.overdue ? ` (${data.counts.overdue} overdue)` : ''}`}
                </p>
              </div>
              <div className="relative">
                <Ring done={doneToday} total={planned} />
                <span className="absolute inset-0 flex flex-col items-center justify-center text-center leading-none">
                  <span className="text-[20px] font-bold">{planned ? Math.round((doneToday / planned) * 100) : 0}%</span>
                  <span className="mt-0.5 text-[10px] text-white/80">today</span>
                </span>
              </div>
            </div>
          </section>
        )
      })()}

      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(74px,1fr))] gap-y-3 pb-1" role="toolbar" aria-label="Quick actions">
        <QuickAction label="Add task" icon={<ListPlus className="size-6" />} tint="var(--ios-blue)" onClick={() => setNewTask({})} testId="qa-task" />
        <QuickAction label="Add note" icon={<StickyNote className="size-6" />} tint="var(--ios-yellow)" onClick={() => setNewNote(true)} testId="qa-note" />
        <QuickAction label="Reminder" icon={<Bell className="size-6" />} tint="var(--ios-orange)" onClick={() => setNewTask({ title: '', reminderUtc: new Date(Date.now() + 60 * 60_000).toISOString() })} testId="qa-reminder" />
        <QuickAction label="New chat" icon={<MessageSquarePlus className="size-6" />} tint="var(--ios-green)" onClick={onNewChat} />
        {calls.enabled && <QuickAction label="Audio call" icon={<Phone className="size-6" />} tint="#30b0c7" onClick={() => setPicker('call')} testId="qa-call" />}
        <QuickAction label="New group" icon={<Users className="size-6" />} tint="var(--ios-purple)" onClick={onNewGroup} />
        <QuickAction label="Meetings" icon={<Video className="size-6" />} tint="#5856d6" onClick={() => navigate('/meetings')} />
        <QuickAction label="Schedule" icon={<CalendarPlus className="size-6" />} tint="var(--ios-red)" onClick={() => navigate('/schedule')} />
        <QuickAction label="Find people" icon={<Search className="size-6" />} tint="var(--ios-gray)" onClick={onNewChat} />
      </div>

      {error && (
        <div className="py-8 text-center">
          <p className="text-[15px] text-[var(--ios-label2)]">{error}</p>
          <button type="button" className="ios-btn-tinted mt-3" onClick={load}>Try again</button>
        </div>
      )}
      {!data && !error && <div className="mt-4 grid gap-3 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-36 animate-pulse rounded-[14px] bg-white/70" />)}</div>}

      {data && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {tiles.map((t) => (
              <button key={t.key} type="button" onClick={t.go} className="flex flex-col rounded-[12px] bg-white p-2.5 text-left active:opacity-70" data-testid={'myday-count-' + t.key}>
                <span className="flex items-start justify-between">
                  <span className="flex size-8 items-center justify-center rounded-full text-white" style={{ background: t.tint }}>{t.icon}</span>
                  <span className="text-[24px] leading-7 font-bold">{t.value}</span>
                </span>
                <span className="mt-1.5 text-[15px] font-semibold text-[var(--ios-label2)]">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="mt-4 grid items-start gap-3 lg:grid-cols-2">
            <div className="grid gap-3">
              <Card title="Top 3 for today" icon={<Star className="size-4" />} tint="var(--ios-orange)" count={data.focus?.length} testId="myday-focus">
                {(data.focus?.length ?? 0) === 0 ? (
                  <>
                    <Line>Pick the three things that matter most today. Swipe a task left on your phone, or use ☆ below.</Line>
                    {[...data.overdueTasks, ...data.todayTasks].filter((t) => t.role !== 'assigner').sort((a, b) => ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].indexOf(a.priority) - ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].indexOf(b.priority)).slice(0, 3).map((t) => (
                      <div key={t.id} className="flex items-center gap-3 pl-4">
                        <span className="text-[13px] font-semibold" style={{ color: PRIORITY[t.priority].color }}>{PRIORITY[t.priority].marks || '·'}</span>
                        <button type="button" onClick={() => setEditTask(t)} className="ios-sep-top min-w-0 flex-1 truncate py-2.5 text-left text-[15px]">{t.title}</button>
                        <button type="button" onClick={() => focusToggle(t)} className="ios-sep-top self-stretch pr-4 pl-1 text-[14px] font-semibold text-[var(--ios-orange)]" aria-label={`Add ${t.title} to Top 3`} data-testid="focus-suggest">☆ Add</button>
                      </div>
                    ))}
                  </>
                ) : (
                  data.focus!.map((t, i) => (
                    <div key={t.id} className="flex items-center">
                      <span className="w-8 shrink-0 pl-4 text-[15px] font-bold text-[var(--ios-orange)]">{i + 1}</span>
                      <div className="min-w-0 flex-1"><TaskRow t={t} compact onToggle={() => toggle(t)} onOpen={() => setEditTask(t)} onFocus={() => focusToggle(t)} /></div>
                    </div>
                  ))
                )}
              </Card>
              {(data.newAssigned?.length ?? 0) > 0 && (
                <Card title="Assigned to you" icon={<UserPlus className="size-4" />} tint="#5856d6" count={data.newAssigned!.length} testId="myday-new-assigned">
                  {data.newAssigned!.map((t) => (
                    <div key={t.id} className="flex items-center">
                      <div className="min-w-0 flex-1"><TaskRow t={t} compact onToggle={() => toggle(t)} onOpen={() => setEditTask(t)} /></div>
                      <button type="button" className="ios-sep-top flex items-center gap-1 self-stretch pr-4 pl-1 text-[14px] font-semibold text-[var(--ios-blue)]" data-testid="myday-accept"
                        onClick={() => workApi.accept(t.id).then(() => (toast.success('Accepted'), load()), (e) => toast.error(errorMessage(e, 'That did not work.')))}>
                        <Check className="size-4" />Accept
                      </button>
                    </div>
                  ))}
                </Card>
              )}
              {(data.toReview?.length ?? 0) > 0 && (
                <Card title="Waiting for your review" icon={<ClipboardCheck className="size-4" />} tint="var(--ios-purple)" count={data.counts.toReview} testId="myday-to-review"
                  action={<button type="button" onClick={() => navigate('/tasks?filter=to-review')} className="flex items-center text-[15px] text-[var(--ios-blue)]">All <ChevronRight className="size-4" /></button>}>
                  {data.toReview!.map((t) => <TaskRow key={t.id} t={t} compact onToggle={() => setEditTask(t)} onOpen={() => setEditTask(t)} />)}
                </Card>
              )}
              {data.missedReminders.length > 0 && (
                <div id="myday-missed">
                  <Card title="Missed reminders" icon={<BellRing className="size-4" />} tint="var(--ios-red)" count={data.missedReminders.length}>
                    {data.missedReminders.map((r) => <ReminderLine key={r.id} r={r} missed onChanged={load} />)}
                  </Card>
                </div>
              )}
              {data.overdueTasks.length > 0 && (
                <Card title="Overdue" icon={<AlarmClock className="size-4" />} tint="var(--ios-orange)" count={data.overdueTasks.length} testId="myday-overdue">
                  {data.overdueTasks.map((t) => <TaskRow key={t.id} t={t} compact onToggle={() => toggle(t)} onOpen={() => setEditTask(t)} onFocus={() => focusToggle(t)} />)}
                </Card>
              )}
              <Card
                title="Today's tasks"
                icon={<Sun className="size-4" />}
                tint="var(--ios-blue)"
                count={data.todayTasks.length}
                testId="myday-today"
                action={<button type="button" onClick={() => setNewTask({ dueUtc: new Date(new Date().setHours(23, 59, 0, 0)).toISOString(), hasDueTime: false })} className="text-[15px] text-[var(--ios-blue)]">Add</button>}
              >
                {data.todayTasks.length === 0 ? <Line>Nothing due today.</Line> : data.todayTasks.map((t) => <TaskRow key={t.id} t={t} compact onToggle={() => toggle(t)} onOpen={() => setEditTask(t)} onFocus={() => focusToggle(t)} />)}
              </Card>
              <Card title="Meetings today" icon={<Video className="size-4" />} tint="#5856d6" count={data.meetings.length} testId="myday-meetings">
                {data.meetings.length === 0 ? (
                  <Line>No meetings today.</Line>
                ) : (
                  data.meetings.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 pl-4">
                      <span className="w-[58px] shrink-0 text-[14px] font-semibold tabular-nums text-[var(--ios-label2)]">{timeText(m.startUtc)}</span>
                      <button type="button" onClick={() => navigate(m.joinPath ?? '/meetings')} className="ios-sep-top min-w-0 flex-1 py-2.5 text-left">
                        <span className="block truncate text-[16px]">{m.title}</span>
                        <span className="block text-[13px] text-[var(--ios-gray)]">{[m.kind, m.status === 'LIVE' ? 'Live now' : m.status === 'COMPLETED' ? 'Ended' : null, m.endUtc ? `until ${timeText(m.endUtc)}` : null].filter(Boolean).join(' · ')}</span>
                      </button>
                      <button type="button" onClick={() => setFollowUp({ kind: 'meeting', meetingId: m.id, title: m.title })} className="ios-sep-top self-stretch pr-4 pl-1 text-[14px] text-[var(--ios-blue)]" aria-label={`Follow-up task for ${m.title}`}>Follow up</button>
                    </div>
                  ))
                )}
              </Card>
              <Card title="Upcoming reminders" icon={<Bell className="size-4" />} tint="var(--ios-orange)" count={data.upcomingReminders.length} testId="myday-upcoming">
                {data.upcomingReminders.length === 0 ? <Line>No reminders in the next 7 days.</Line> : data.upcomingReminders.map((r) => <ReminderLine key={r.id} r={r} onChanged={load} />)}
              </Card>
            </div>

            <div className="grid gap-3">
              {(data.waitingOnOthers?.length ?? 0) > 0 && (
                <Card title="Waiting on others" icon={<Hand className="size-4" />} tint="#30b0c7" count={data.counts.waitingOnOthers} testId="myday-waiting"
                  action={<button type="button" onClick={() => navigate('/tasks?filter=delegated')} className="flex items-center text-[15px] text-[var(--ios-blue)]">All <ChevronRight className="size-4" /></button>}>
                  {data.waitingOnOthers!.map((t) => <TaskRow key={t.id} t={t} compact onToggle={() => setEditTask(t)} onOpen={() => setEditTask(t)} />)}
                </Card>
              )}
              <Card title="Pending follow-ups" icon={<MessageSquare className="size-4" />} tint="var(--ios-purple)" count={data.followUps.length} testId="myday-followups">
                {data.followUps.length === 0 ? <Line>Turn a chat message, call or meeting into a follow-up and it appears here.</Line> : data.followUps.map((t) => <TaskRow key={t.id} t={t} compact onToggle={() => toggle(t)} onOpen={() => setEditTask(t)} onFocus={() => focusToggle(t)} />)}
              </Card>
              <Card
                title="Notes"
                icon={<StickyNote className="size-4" />}
                tint="var(--ios-yellow)"
                testId="myday-notes"
                action={<button type="button" onClick={() => onSection('notes')} className="flex items-center text-[15px] text-[var(--ios-blue)]">All <ChevronRight className="size-4" /></button>}
              >
                {data.notes.length === 0 ? <Line>Pinned notes and today's notes show here.</Line> : data.notes.map((n) => <NoteRow key={n.id} n={n} onOpen={() => navigate(`/chat?tab=notes&note=${n.id}`)} />)}
              </Card>
              <Card title="Important chats" icon={<MessageSquare className="size-4" />} tint="var(--ios-green)" testId="myday-chats">
                {data.importantChats.length === 0 ? (
                  <Line>Pinned and unread chats show here.</Line>
                ) : (
                  data.importantChats.map((c) => (
                    <button key={c.id} type="button" onClick={() => onOpenChat(c.id)} className="ios-pressable flex w-full items-center gap-3 pl-4 text-left">
                      <span className="py-2"><Avatar name={c.title} size={38} /></span>
                      <span className="ios-sep-top flex min-w-0 flex-1 items-center gap-2 self-stretch py-2.5 pr-4">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[16px] font-semibold">{c.title}</span>
                          <span className="block truncate text-[14px] text-[var(--ios-gray)]">{c.lastMessageExcerpt ?? (c.isGroup ? 'Group' : '')}</span>
                        </span>
                        {c.lastMessageUtc && <span className="shrink-0 text-[13px] text-[var(--ios-gray)]">{listTime(c.lastMessageUtc)}</span>}
                        {c.unread > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ios-blue)] px-1.5 text-[12px] font-semibold text-white">{c.unread}</span>}
                      </span>
                    </button>
                  ))
                )}
              </Card>
              {calls.enabled && (
                <Card title="Recent calls" icon={<Phone className="size-4" />} tint="#30b0c7" testId="myday-calls" action={<button type="button" onClick={() => onSection('calls')} className="flex items-center text-[15px] text-[var(--ios-blue)]">All <ChevronRight className="size-4" /></button>}>
                  {data.recentCalls.length === 0 ? (
                    <Line>No calls yet.</Line>
                  ) : (
                    data.recentCalls.map((c) => {
                      const d = callLine(c, chat.meId)
                      const Icon = d.missed ? PhoneMissed : d.outgoing ? PhoneOutgoing : PhoneIncoming
                      return (
                        <div key={c.id} className="flex items-center gap-3 pl-4">
                          <Icon className={cn('size-4 shrink-0', d.missed ? 'text-[var(--ios-red)]' : 'text-[var(--ios-gray)]')} aria-label={d.missed ? 'Missed' : d.outgoing ? 'Outgoing' : 'Incoming'} />
                          <button type="button" onClick={() => c.conversationId && onOpenChat(c.conversationId)} className="ios-sep-top min-w-0 flex-1 py-2.5 text-left">
                            <span className={cn('block truncate text-[16px]', d.missed && 'text-[var(--ios-red)]')}>{d.name}</span>
                            <span className="block text-[13px] text-[var(--ios-gray)]">{listTime(c.createdUtc)}</span>
                          </button>
                          <button type="button" onClick={() => setFollowUp({ kind: 'call', callId: c.id, conversationId: c.conversationId, title: d.name })} className="ios-sep-top self-stretch pr-4 pl-1 text-[14px] text-[var(--ios-blue)]">Follow up</button>
                        </div>
                      )
                    })
                  )}
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      {newTask && <TaskEditor seed={newTask} onClose={() => setNewTask(null)} onSaved={load} />}
      {editTask && <TaskEditor task={editTask} onClose={() => setEditTask(null)} onSaved={load} onDeleted={load} />}
      {newNote && <NoteEditor onClose={() => setNewNote(false)} onSaved={load} />}
      {followUp && <FollowUpSheet source={followUp} onClose={() => setFollowUp(null)} onSaved={load} />}
      {picker === 'call' && (
        <PersonPicker
          onClose={() => setPicker(null)}
          onPick={(p) => {
            setPicker(null)
            chatApi.direct(p.id).then(
              (c) => calls.start(c.id),
              (e) => toast.error(errorMessage(e, 'The call could not be started.')),
            )
          }}
        />
      )}
    </div>
  )
}
