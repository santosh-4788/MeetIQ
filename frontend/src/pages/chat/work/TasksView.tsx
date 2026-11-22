import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlarmClock, Bell, BellRing, CalendarClock, CheckCheck, ClipboardCheck, Flag, Inbox, ListTodo, MessageCircle, MessageSquare, Paperclip, Phone, Plus, Repeat,
  Search, Send, Settings2, ShieldCheck, Sparkles, Star, Sun, UserCheck, UserRound, Video, X,
} from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi, type Task, type TaskFilter } from '../../../api/work'
import { Avatar } from '../../../components/ui/Avatar'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { parseUtc } from '../../../lib/format'
import { useChat } from '../ChatProvider'
import { appNotifyPermission, inAndroidApp } from '../../room/androidBridge'
import { TaskEditor } from './Editors'
import { parseQuickTask } from './quickAdd'
import { CheckCircle, Empty, Group, PRIORITY, Pill, Row, STATUS, Sheet, whenText } from './ui'

type ListDef = { key: TaskFilter; label: string; icon: typeof Sun; color: string; collab?: boolean }
const LISTS: ListDef[] = [
  { key: 'today', label: 'Today', icon: Sun, color: 'var(--ios-blue)' },
  { key: 'upcoming', label: 'Scheduled', icon: CalendarClock, color: 'var(--ios-red)' },
  { key: 'overdue', label: 'Overdue', icon: AlarmClock, color: 'var(--ios-orange)' },
  { key: 'assigned', label: 'Assigned to me', icon: UserCheck, color: '#5856d6', collab: true },
  { key: 'delegated', label: 'Assigned by me', icon: Send, color: '#30b0c7', collab: true },
  { key: 'to-review', label: 'To review', icon: ClipboardCheck, color: 'var(--ios-purple)', collab: true },
  { key: 'followups', label: 'Follow-ups', icon: MessageSquare, color: '#ff2d55' },
  { key: 'all', label: 'All', icon: Inbox, color: '#1c1c1e' },
  { key: 'completed', label: 'Completed', icon: CheckCheck, color: 'var(--ios-gray)' },
]

/** iOS-style swipe on phones: right = complete / reopen, left = Top 3. Mouse and keyboard use is unchanged. */
function Swipe({ children, left, right }: { children: ReactNode; left?: { label: string; color: string; icon: ReactNode; run: () => void }; right?: { label: string; color: string; icon: ReactNode; run: () => void } }) {
  const [dx, setDx] = useState(0)
  const start = useRef<{ x: number; y: number; active: boolean } | null>(null)
  const limit = 96
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    start.current = { x: e.clientX, y: e.clientY, active: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s) return
    const x = e.clientX - s.x
    const y = e.clientY - s.y
    if (!s.active) {
      if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return void (start.current = null)
      if (Math.abs(x) < 12) return
      s.active = true
    }
    if ((x > 0 && !right) || (x < 0 && !left)) return
    setDx(Math.max(-limit, Math.min(limit, x)))
  }
  const onUp = () => {
    if (start.current?.active) {
      if (dx >= 72 && right) right.run()
      if (dx <= -72 && left) left.run()
    }
    start.current = null
    setDx(0)
  }
  return (
    <div className="relative overflow-hidden" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} style={{ touchAction: 'pan-y' }}>
      {dx > 0 && right && (
        <div className="absolute inset-y-0 left-0 flex items-center gap-1.5 pl-5 text-[14px] font-semibold text-white" style={{ width: dx, background: right.color }} aria-hidden>{dx > 56 && <>{right.icon}{right.label}</>}</div>
      )}
      {dx < 0 && left && (
        <div className="absolute inset-y-0 right-0 flex items-center justify-end gap-1.5 pr-5 text-[14px] font-semibold text-white" style={{ width: -dx, background: left.color }} aria-hidden>{-dx > 56 && <>{left.icon}{left.label}</>}</div>
      )}
      <div className="relative bg-white transition-transform duration-150" style={{ transform: dx ? `translateX(${dx}px)` : undefined, transitionDuration: start.current?.active ? '0ms' : undefined }}>{children}</div>
    </div>
  )
}

export function TaskRow({ t, onToggle, onOpen, compact, onFocus }: { t: Task; onToggle: () => void; onOpen: () => void; compact?: boolean; onFocus?: () => void }) {
  const done = t.status === 'COMPLETED'
  const p = PRIORITY[t.priority]
  const overdue = t.isOverdue && !done
  const assigner = t.role === 'assigner'
  // Tasks that need a review (or that I gave to someone) are not ticked here: the check opens the task instead.
  const canTick = done ? t.role !== 'assigner' && !(t.assignedBy && t.requiresReview) : t.canComplete !== false && !assigner
  const tick = canTick ? onToggle : onOpen
  const row = (
    <div className={cn('flex items-start gap-3 pl-4 transition-opacity', (done || t.status === 'CANCELLED') && 'opacity-60')} data-testid="task-row">
      <span className="pt-[11px]">
        {assigner ? (
          <button type="button" onClick={onOpen} aria-label={`Open ${t.title}`} className="block rounded-full"><Avatar name={t.owner.name ?? '?'} size={26} /></button>
        ) : t.status === 'IN_REVIEW' ? (
          <button type="button" onClick={onOpen} aria-label={`${t.title}: waiting for review`} className="flex size-[26px] items-center justify-center rounded-full bg-[var(--ios-purple)]/12 text-[var(--ios-purple)]"><ShieldCheck className="size-[15px]" /></button>
        ) : (
          <CheckCircle on={done} color={p.color} onClick={tick} label={done ? `Mark “${t.title}” as not done` : canTick ? `Complete “${t.title}”` : `Open “${t.title}” to send it for review`} />
        )}
      </span>
      <button type="button" onClick={onOpen} className="ios-sep-top flex min-w-0 flex-1 flex-col items-start py-2.5 pr-4 text-left">
        <span className={cn('flex w-full items-baseline gap-1.5 text-[17px] leading-[22px] md:text-[16px]', done && 'text-[var(--ios-gray)] line-through decoration-[var(--ios-gray2)]')}>
          {p.marks && <span className="font-bold" style={{ color: p.color }} aria-label={`${p.label} priority`}>{p.marks}</span>}
          <span className="min-w-0 flex-1 break-words" data-testid="task-row-title">{t.title}</span>
          {t.focusUtc && !done && <Star className="size-4 shrink-0 self-center fill-[var(--ios-orange)] text-[var(--ios-orange)]" aria-label="In your Top 3 today" />}
        </span>
        {!compact && t.description && <span className="mt-0.5 line-clamp-2 text-[14px] text-[var(--ios-gray)]">{t.description}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--ios-gray)]">
          {t.assignState === 'PENDING' && t.role === 'assignee' && <Pill color="var(--ios-blue)">New</Pill>}
          {t.status === 'IN_REVIEW' && <Pill color="var(--ios-purple)">{assigner ? 'Review now' : 'In review'}</Pill>}
          {t.assignState === 'DECLINED' && <Pill color="var(--ios-red)">Declined</Pill>}
          {t.requestedDueUtc && <Pill color="var(--ios-orange)">New date asked</Pill>}
          {assigner && <span className="font-medium text-[var(--ios-label2)]">{t.owner.name}</span>}
          {t.role === 'assignee' && t.assignedBy && <span className="inline-flex items-center gap-0.5"><UserRound className="size-3.5" aria-hidden />From {t.assignedBy.name?.split(' ')[0]}</span>}
          {t.dueUtc && <span className={cn(overdue && 'font-medium text-[var(--ios-red)]')}>{whenText(t.dueUtc, t.hasDueTime)}</span>}
          {t.repeatRule !== 'NONE' && <Repeat className="size-3.5" aria-label="Repeats" />}
          {t.reminderUtc && (t.reminderState === 'PENDING' || t.reminderState === 'FIRED') && (
            <span className="inline-flex items-center gap-0.5"><Bell className="size-3.5" aria-hidden />{whenText(t.reminderUtc)}</span>
          )}
          {t.status !== 'PENDING' && t.status !== 'IN_REVIEW' && t.status !== 'CANCELLED' && !done && <Pill color="var(--ios-purple)">{STATUS[t.status]}</Pill>}
          {t.checklist?.total > 0 && (
            <span className={cn('inline-flex items-center gap-0.5', t.checklist.requiredOpen > 0 && 'text-[var(--ios-red)]')}><CheckCheck className="size-3.5" aria-hidden />{t.checklist.done}/{t.checklist.total}</span>
          )}
          {t.commentCount > 0 && <span className="inline-flex items-center gap-0.5"><MessageCircle className="size-3.5" aria-hidden />{t.commentCount}</span>}
          {t.fileCount > 0 && <span className="inline-flex items-center gap-0.5"><Paperclip className="size-3.5" aria-hidden />{t.fileCount}</span>}
          {t.requiresReview && !assigner && t.status !== 'IN_REVIEW' && !done && <span className="inline-flex items-center gap-0.5" title="Needs a review before it is closed"><ShieldCheck className="size-3.5" aria-hidden />Review</span>}
          {t.categoryName && <Pill color={t.categoryColor ?? undefined}>{t.categoryName}</Pill>}
          {t.message && <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3.5" aria-hidden />{t.message.senderName ?? 'Message'}</span>}
          {!t.message && t.conversation && <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3.5" aria-hidden />{t.conversation.title}</span>}
          {t.call && <span className="inline-flex items-center gap-0.5"><Phone className="size-3.5" aria-hidden />{t.call.otherName ?? 'Call'}</span>}
          {t.meeting && <span className="inline-flex items-center gap-0.5"><Video className="size-3.5" aria-hidden />{t.meeting.title}</span>}
          {t.employee && <span className="inline-flex items-center gap-0.5"><UserRound className="size-3.5" aria-hidden />{t.employee.name}</span>}
        </span>
      </button>
    </div>
  )
  const closed = done || t.status === 'CANCELLED'
  return (
    <Swipe
      right={canTick ? { label: done ? 'Reopen' : 'Done', color: done ? 'var(--ios-gray)' : 'var(--ios-green)', icon: <CheckCheck className="size-4" />, run: onToggle } : undefined}
      left={onFocus && !assigner && !closed ? { label: t.focusUtc ? 'Remove' : 'Top 3', color: 'var(--ios-orange)', icon: <Star className="size-4" />, run: onFocus } : undefined}
    >
      {row}
    </Swipe>
  )
}

/** Shared "complete / reopen" with the repeat-next message. */
export function useTaskToggle(onChanged: (t: Task, next: Task | null) => void) {
  const toast = useToast()
  return useCallback(
    (t: Task) => {
      const to = t.status === 'COMPLETED' ? 'PENDING' : 'COMPLETED'
      onChanged({ ...t, status: to, isOverdue: to === 'COMPLETED' ? false : t.isOverdue }, null)
      workApi.setStatus(t.id, to).then(
        (r) => {
          onChanged(r.task, r.next)
          if (r.next) toast.success(`Done. Next one: ${whenText(r.next.dueUtc, r.next.hasDueTime)}`)
          else if (to === 'COMPLETED' && t.assignedBy) toast.success(`Done. ${t.assignedBy.name?.split(' ')[0] ?? 'They'} has been told.`)
        },
        (e) => {
          onChanged(t, null)
          toast.error(errorMessage(e, 'The task could not be updated.'))
        },
      )
    },
    [onChanged, toast],
  )
}

/** Top 3 for today: add / remove with the server's limit. */
export function useFocusToggle(onChanged: (t: Task) => void) {
  const toast = useToast()
  return useCallback((t: Task) => {
    workApi.focus(t.id, !t.focusUtc).then(
      (r) => (onChanged(r), toast.success(r.focusUtc ? 'Added to your Top 3 for today' : 'Removed from your Top 3')),
      (e) => toast.error(errorMessage(e, 'That did not work.')),
    )
  }, [onChanged, toast])
}

const APP_NOTIFY_KEY = 'oic.app.notify'
const readAppPerm = (): NotificationPermission => {
  try {
    return (localStorage.getItem(APP_NOTIFY_KEY) as NotificationPermission | null) ?? 'default'
  } catch {
    return 'default'
  }
}

/**
 * Notification permission, asked only when the person taps the button (never on page load): the browser's, or inside
 * the Android app (1.2.0+) the app's phone notifications. inApp tells the screens which wording to use.
 */
export function useBrowserNotifications() {
  const inApp = inAndroidApp()
  const supported = inApp || (typeof window !== 'undefined' && 'Notification' in window)
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(inApp ? readAppPerm() : supported ? Notification.permission : 'unsupported')
  const ask = useCallback(async () => {
    if (!supported) return
    if (inApp) {
      const ok = await appNotifyPermission()
      const v: NotificationPermission = ok ? 'granted' : 'denied'
      setPerm(v)
      try {
        localStorage.setItem(APP_NOTIFY_KEY, v)
      } catch {
        /* private mode */
      }
      return
    }
    try {
      setPerm(await Notification.requestPermission())
    } catch {
      /* older Safari: callback form only */
    }
  }, [supported, inApp])
  return { perm, ask, inApp }
}

export function TaskSettingsSheet({ onClose }: { onClose: () => void }) {
  const { perm, ask, inApp } = useBrowserNotifications()
  return (
    <Sheet title="Task settings" onClose={onClose} leftLabel="Close" testId="task-settings">
      <Group title="Notifications" footer={inApp ? 'In-app alerts and the bell are always on. Phone notifications appear while the app is open or in the background.' : 'In-app alerts and the bell are always on. Browser notifications appear while the portal is open in any tab.'}>
        <Row label={inApp ? 'Phone notifications' : 'Browser notifications'} icon={<BellRing className="size-4" />} tint="var(--ios-red)">
          {perm === 'granted' ? <span className="text-[16px] text-[var(--ios-green)]">On</span>
            : perm === 'denied' ? (inApp ? <button type="button" onClick={() => void ask()} className="text-[14px] text-[var(--ios-blue)]">Off — tap to allow</button> : <span className="text-[14px] text-[var(--ios-gray)]">Blocked in browser settings</span>)
              : perm === 'unsupported' ? <span className="text-[14px] text-[var(--ios-gray)]">Not supported here</span>
                : <button type="button" onClick={() => void ask()} className="ios-btn-tinted h-[30px] px-3 text-[14px]" data-testid="enable-notifications">Turn on</button>}
        </Row>
      </Group>
      {/* 22 Nov 2026: task e-mails are switched off company-wide (only meeting and sign-in e-mails are sent), so no e-mail switch here. */}
    </Sheet>
  )
}

/** Quick add in plain words with a live preview of what was understood. */
function QuickAdd({ filter, onAdded }: { filter: TaskFilter; onAdded: (t: Task) => void }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = useMemo(() => (text.trim() ? parseQuickTask(text) : null), [text])
  const add = async () => {
    if (!parsed || busy) return
    setBusy(true)
    const todayEnd = new Date(new Date().setHours(23, 59, 0, 0)).toISOString()
    try {
      const t = await workApi.createTask({
        title: parsed.title,
        priority: parsed.priority ?? 'MEDIUM',
        dueUtc: parsed.dueUtc ?? (filter === 'today' ? todayEnd : null),
        hasDueTime: parsed.hasDueTime,
        reminderUtc: parsed.hasDueTime && parsed.dueUtc && parseUtc(parsed.dueUtc).getTime() - 15 * 60_000 > Date.now() ? new Date(parseUtc(parsed.dueUtc).getTime() - 15 * 60_000).toISOString() : null,
      })
      onAdded(t)
      setText('')
      toast.success(t.dueUtc ? `Added · ${whenText(t.dueUtc, t.hasDueTime)}${t.reminderUtc ? ' · reminder 15 min before' : ''}` : 'Task added')
    } catch (e) {
      toast.error(errorMessage(e, 'The task could not be added.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 rounded-[12px] bg-white px-3 py-2 shadow-xs" data-testid="quick-add">
      <div className="flex items-center gap-2">
        <Sparkles className="size-[18px] shrink-0 text-[var(--ios-blue)]" aria-hidden />
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void add())} maxLength={200}
          placeholder="Quick add: “Call Ramesh tomorrow 4pm urgent”" aria-label="Quick add a task" className="min-w-0 flex-1 bg-transparent py-1 text-[16px] outline-none placeholder:text-[var(--ios-gray2)]" data-testid="quick-add-input" />
        {text.trim() && <button type="button" onClick={() => void add()} disabled={busy} className="flex size-8 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white disabled:opacity-50" aria-label="Add task" data-testid="quick-add-go"><Plus className="size-5" strokeWidth={2.6} /></button>}
      </div>
      {parsed && (parsed.dueUtc || parsed.priority) && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 pl-[26px] text-[12px] text-[var(--ios-gray)]" data-testid="quick-add-preview">
          <span className="font-medium text-[var(--ios-label)]">{parsed.title}</span>
          {parsed.dueUtc && <Pill color="var(--ios-red)"><CalendarClock className="size-3" />{whenText(parsed.dueUtc, parsed.hasDueTime)}</Pill>}
          {parsed.priority && <Pill color={PRIORITY[parsed.priority].color}><Flag className="size-3" />{PRIORITY[parsed.priority].label}</Pill>}
        </p>
      )}
    </div>
  )
}

const DELEGATED_GROUPS: { key: string; title: string; test: (t: Task) => boolean }[] = [
  { key: 'review', title: 'Waiting for your review', test: (t) => t.status === 'IN_REVIEW' },
  { key: 'date', title: 'New date asked', test: (t) => !!t.requestedDueUtc && t.status !== 'COMPLETED' && t.status !== 'CANCELLED' },
  { key: 'late', title: 'Overdue', test: (t) => t.isOverdue },
  { key: 'new', title: 'Not answered yet', test: (t) => t.assignState === 'PENDING' && t.status !== 'CANCELLED' },
  { key: 'working', title: 'In progress', test: (t) => t.status === 'IN_PROGRESS' || t.status === 'POSTPONED' },
  { key: 'accepted', title: 'Accepted, not started', test: (t) => t.status === 'PENDING' },
  { key: 'done', title: 'Done (last 14 days)', test: (t) => t.status === 'COMPLETED' },
  { key: 'declined', title: 'Declined or withdrawn', test: (t) => t.status === 'CANCELLED' },
]

/** Tasks: iOS Reminders-style smart lists, assigned to me / by me / to review, quick add, search, swipe actions. */
export function TasksView({ params, setParams }: { params: URLSearchParams; setParams: (p: URLSearchParams) => void }) {
  const toast = useToast()
  const chat = useChat()
  const collab = !!(chat.status?.enabled && chat.status.taskCollab)
  const lists = useMemo(() => LISTS.filter((l) => !l.collab || collab), [collab])
  const filter = (params.get('filter') as TaskFilter | null) ?? 'today'
  const [items, setItems] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [counts, setCounts] = useState<Partial<Record<TaskFilter, number>>>({})
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const [settings, setSettings] = useState(false)
  const openTaskId = params.get('task')

  const setFilter = (f: TaskFilter) => {
    const next = new URLSearchParams(params)
    next.set('filter', f)
    next.delete('task')
    setParams(next)
  }

  const load = useCallback(() => {
    workApi.tasks({ filter, search: search.trim() || undefined }).then(
      (r) => {
        setItems(r.items)
        setError(null)
      },
      (e) => setError(errorMessage(e, 'Your tasks could not be loaded.')),
    )
    workApi.myDay().then((d) => setCounts({
      today: d.counts.todayTasks, overdue: d.counts.overdue, followups: d.counts.followUps,
      'to-review': d.counts.toReview ?? 0, delegated: d.counts.waitingOnOthers ?? 0, assigned: d.newAssigned?.length ?? 0,
    }), () => {})
  }, [filter, search])

  useEffect(() => {
    setItems(null)
    const t = window.setTimeout(load, search ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [load, search])

  // Live: the other person accepted, sent for review, commented … (debounced).
  useEffect(() => {
    let h = 0
    const later = () => (window.clearTimeout(h), (h = window.setTimeout(load, 600)))
    const offs = [chat.on('task.changed', later), chat.on('reconnected', later)]
    return () => (offs.forEach((o) => o()), window.clearTimeout(h))
  }, [chat, load])

  // Opened from a reminder, the bell or an e-mail: ?task=<id>.
  useEffect(() => {
    if (!openTaskId) return
    workApi.task(openTaskId).then(
      (t) => setEditing(t),
      () => toast.error('That task is not available.'),
    )
  }, [openTaskId, toast])

  const closeEditor = () => {
    setEditing(null)
    if (openTaskId) {
      const next = new URLSearchParams(params)
      next.delete('task')
      setParams(next)
    }
  }

  const replace = useCallback((t: Task, next: Task | null) => {
    setItems((list) => {
      if (!list) return list
      const hasIt = list.some((x) => x.id === t.id)
      let out = hasIt ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list]
      if (next && !out.some((x) => x.id === next.id)) out = [...out, next]
      return out
    })
  }, [])
  const toggle = useTaskToggle(replace)
  const focus = useFocusToggle((t) => replace(t, null))

  // Completed items leave the open lists a moment after they are ticked (as in iOS). "Assigned by me" keeps them.
  useEffect(() => {
    if (filter === 'completed' || filter === 'delegated' || !items?.some((t) => t.status === 'COMPLETED' || t.status === 'CANCELLED')) return
    const h = window.setTimeout(() => setItems((list) => list?.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED') ?? list), 1400)
    return () => window.clearTimeout(h)
  }, [items, filter])

  const current = lists.find((l) => l.key === filter) ?? lists[0]
  const grouped = useMemo(() => {
    if (!items) return []
    if (filter === 'delegated') {
      const left = [...items]
      return DELEGATED_GROUPS.map((g) => {
        const mine = left.filter(g.test)
        mine.forEach((t) => left.splice(left.indexOf(t), 1))
        return { key: g.key, title: g.title as string | null, items: mine }
      }).filter((g) => g.items.length)
    }
    if (filter !== 'upcoming' && filter !== 'all') return [{ key: 'all', title: null as string | null, items }]
    const map = new Map<string, Task[]>()
    for (const t of items) {
      const k = t.dueUtc ? whenText(t.dueUtc, false) : 'No date'
      map.set(k, [...(map.get(k) ?? []), t])
    }
    return [...map.entries()].map(([k, v]) => ({ key: k, title: k, items: v }))
  }, [items, filter])

  const openCount = (l: ListDef) => (l.key === filter && items ? items.filter((t) => filter === 'completed' || filter === 'delegated' ? true : t.status !== 'COMPLETED').length : counts[l.key] ?? '')

  return (
    <div className="mx-auto w-full max-w-[860px]" data-testid="tasks-view">
      <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
        {lists.map((l) => {
          const Icon = l.icon
          const on = l.key === filter
          const n = openCount(l)
          const alert = !on && (l.key === 'to-review' || l.key === 'assigned') && typeof n === 'number' && n > 0
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => setFilter(l.key)}
              aria-pressed={on}
              className={cn('relative flex min-w-0 flex-col rounded-[12px] p-2 text-left sm:p-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-all active:scale-[0.98] active:opacity-80', on ? 'text-white shadow-[0_6px_16px_rgb(0_0_0/0.12)]' : 'bg-white')}
              style={on ? { background: l.color } : undefined}
              data-testid={'task-list-' + l.key}
            >
              <span className="flex items-start justify-between">
                <span className="flex size-7 items-center justify-center rounded-full sm:size-8" style={{ background: on ? 'rgb(255 255 255 / 0.25)' : l.color }}>
                  <Icon className="size-4 text-white sm:size-[18px]" />
                </span>
                <span className="text-[20px] leading-7 font-bold sm:text-[24px]">{n}</span>
              </span>
              <span className={cn('mt-1 truncate text-[13px] leading-[17px] font-semibold sm:mt-1.5 sm:text-[15px]', on ? 'text-white' : 'text-[var(--ios-label2)]')}>{l.label}</span>
              {alert && <span className="absolute top-2 right-2 size-2 rounded-full bg-[var(--ios-red)]" aria-label="Needs attention" />}
            </button>
          )
        })}
      </div>

      {filter !== 'completed' && filter !== 'delegated' && filter !== 'to-review' && <QuickAdd filter={filter} onAdded={(t) => (replace(t, null), load())} />}

      <label className="ios-search mt-3 bg-white">
        <Search className="size-[17px] shrink-0" aria-hidden />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" data-testid="task-search" />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="flex size-[18px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white"><X className="size-3" strokeWidth={3} /></button>}
      </label>

      <div className="mt-5 mb-1.5 flex items-center gap-2 px-1">
        <h2 className="flex-1 text-[22px] font-bold" style={{ color: current.color === '#1c1c1e' ? undefined : current.color }}>{current.label}</h2>
        <button type="button" onClick={() => setSettings(true)} className="ios-icon-btn size-9" aria-label="Task settings" data-testid="task-settings-open"><Settings2 className="size-[20px]" /></button>
      </div>

      {error && (
        <div className="py-8 text-center">
          <p className="text-[15px] text-[var(--ios-label2)]">{error}</p>
          <button type="button" className="ios-btn-tinted mt-3" onClick={load}>Try again</button>
        </div>
      )}
      {!items && !error && <div className="h-40 animate-pulse rounded-[12px] bg-white/70" aria-busy="true" />}
      {items && items.length === 0 && (
        <Empty
          icon={filter === 'to-review' ? <ClipboardCheck className="size-8" /> : filter === 'delegated' ? <Send className="size-8" /> : <ListTodo className="size-8" />}
          title={search ? 'No Results' : filter === 'completed' ? 'Nothing completed yet' : filter === 'overdue' ? 'Nothing overdue' : filter === 'to-review' ? 'Nothing to review' : filter === 'delegated' ? 'You have not assigned any tasks' : filter === 'assigned' ? 'Nobody has assigned you a task' : 'No Tasks'}
          text={search ? undefined
            : filter === 'followups' ? 'Tap a chat message, a call or a note and choose “Create task or reminder”.'
              : filter === 'delegated' ? 'Create a task and choose “Assign to” to give it to a colleague. Tick “Needs my review” to check the work before it is closed.'
                : filter === 'to-review' ? 'Tasks that colleagues send you for review appear here.'
                  : 'Add a task with a due date and a reminder so nothing is missed.'}
        />
      )}
      {grouped.map((g) => (
        <section key={g.key} className="mb-3">
          {g.title && <p className="ios-group-title mt-3">{g.title}{filter === 'delegated' ? ` · ${g.items.length}` : ''}</p>}
          <div className="ios-group ios-list">
            {g.items.map((t) => (
              <TaskRow key={t.id} t={t} onToggle={() => toggle(t)} onOpen={() => setEditing(t)} onFocus={() => focus(t)} />
            ))}
          </div>
        </section>
      ))}

      {filter !== 'completed' && filter !== 'to-review' && (
        <button type="button" onClick={() => setEditing('new')} className="mt-3 flex items-center gap-2 px-1 py-2 text-[17px] font-semibold text-[var(--ios-blue)] active:opacity-50" data-testid="task-new">
          <span className="flex size-6 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white"><Plus className="size-4" strokeWidth={3} /></span>
          {filter === 'delegated' ? 'Assign a Task' : 'New Task'}
        </button>
      )}

      {editing && (
        <TaskEditor
          task={editing === 'new' ? null : editing}
          seed={editing === 'new' && filter === 'today' ? { dueUtc: new Date(new Date().setHours(23, 59, 0, 0)).toISOString(), hasDueTime: false } : editing === 'new' && filter === 'delegated' ? { requiresReview: true } : undefined}
          onClose={closeEditor}
          onSaved={(t, next) => {
            replace(t, next ?? null)
            if (editing === 'new') load()
          }}
          onDeleted={(id) => (filter === 'delegated' ? load() : setItems((list) => list?.filter((x) => x.id !== id) ?? list))}
        />
      )}
      {settings && <TaskSettingsSheet onClose={() => setSettings(false)} />}
    </div>
  )
}

export const isOverdue = (t: Task) => !!t.dueUtc && parseUtc(t.dueUtc).getTime() < Date.now() && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
