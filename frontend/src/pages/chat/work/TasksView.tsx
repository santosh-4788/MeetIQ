import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlarmClock, Bell, CalendarClock, CheckCheck, Inbox, ListTodo, MessageSquare, Phone, Plus, Repeat, Search, Sun, UserRound, Video, X } from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi, type Task, type TaskFilter } from '../../../api/work'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { parseUtc } from '../../../lib/format'
import { TaskEditor } from './Editors'
import { CheckCircle, Empty, PRIORITY, Pill, STATUS, whenText } from './ui'

const LISTS: { key: TaskFilter; label: string; icon: typeof Sun; color: string }[] = [
  { key: 'today', label: 'Today', icon: Sun, color: 'var(--ios-blue)' },
  { key: 'upcoming', label: 'Scheduled', icon: CalendarClock, color: 'var(--ios-red)' },
  { key: 'overdue', label: 'Overdue', icon: AlarmClock, color: 'var(--ios-orange)' },
  { key: 'followups', label: 'Follow-ups', icon: MessageSquare, color: 'var(--ios-purple)' },
  { key: 'all', label: 'All', icon: Inbox, color: '#1c1c1e' },
  { key: 'completed', label: 'Completed', icon: CheckCheck, color: 'var(--ios-gray)' },
]

export function TaskRow({ t, onToggle, onOpen, compact }: { t: Task; onToggle: () => void; onOpen: () => void; compact?: boolean }) {
  const done = t.status === 'COMPLETED'
  const p = PRIORITY[t.priority]
  const overdue = t.isOverdue && !done
  return (
    <div className={cn('flex items-start gap-3 pl-4 transition-opacity', done && 'opacity-60')} data-testid="task-row">
      <span className="pt-[11px]"><CheckCircle on={done} color={p.color} onClick={onToggle} label={done ? `Mark “${t.title}” as not done` : `Complete “${t.title}”`} /></span>
      <button type="button" onClick={onOpen} className="ios-sep-top flex min-w-0 flex-1 flex-col items-start py-2.5 pr-4 text-left">
        <span className={cn('flex w-full items-baseline gap-1.5 text-[17px] leading-[22px] md:text-[16px]', done && 'text-[var(--ios-gray)] line-through decoration-[var(--ios-gray2)]')}>
          {p.marks && <span className="font-bold" style={{ color: p.color }} aria-label={`${p.label} priority`}>{p.marks}</span>}
          <span className="min-w-0 flex-1 break-words" data-testid="task-row-title">{t.title}</span>
        </span>
        {!compact && t.description && <span className="mt-0.5 line-clamp-2 text-[14px] text-[var(--ios-gray)]">{t.description}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--ios-gray)]">
          {t.dueUtc && <span className={cn(overdue && 'font-medium text-[var(--ios-red)]')}>{whenText(t.dueUtc, t.hasDueTime)}</span>}
          {t.repeatRule !== 'NONE' && <Repeat className="size-3.5" aria-label="Repeats" />}
          {t.reminderUtc && (t.reminderState === 'PENDING' || t.reminderState === 'FIRED') && (
            <span className="inline-flex items-center gap-0.5"><Bell className="size-3.5" aria-hidden />{whenText(t.reminderUtc)}</span>
          )}
          {t.status !== 'PENDING' && !done && <Pill color="var(--ios-purple)">{STATUS[t.status]}</Pill>}
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

/** Tasks: iOS Reminders-style smart lists (Today, Scheduled, Overdue, Follow-ups, All, Completed), search, add. */
export function TasksView({ params, setParams }: { params: URLSearchParams; setParams: (p: URLSearchParams) => void }) {
  const toast = useToast()
  const filter = (params.get('filter') as TaskFilter | null) ?? 'today'
  const [items, setItems] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [counts, setCounts] = useState<Partial<Record<TaskFilter, number>>>({})
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
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
    workApi.myDay().then((d) => setCounts({ today: d.counts.todayTasks, overdue: d.counts.overdue, followups: d.counts.followUps }), () => {})
  }, [filter, search])

  useEffect(() => {
    setItems(null)
    const t = window.setTimeout(load, search ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [load, search])

  // Opened from a reminder or the bell: ?task=<id>.
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

  // Completed items leave the open lists a moment after they are ticked (as in iOS).
  useEffect(() => {
    if (filter === 'completed' || !items?.some((t) => t.status === 'COMPLETED' || t.status === 'CANCELLED')) return
    const h = window.setTimeout(() => setItems((list) => list?.filter((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED') ?? list), 1400)
    return () => window.clearTimeout(h)
  }, [items, filter])

  const current = LISTS.find((l) => l.key === filter) ?? LISTS[0]
  const grouped = useMemo(() => {
    if (!items) return []
    if (filter !== 'upcoming' && filter !== 'all') return [{ key: 'all', title: null as string | null, items }]
    const map = new Map<string, Task[]>()
    for (const t of items) {
      const k = t.dueUtc ? whenText(t.dueUtc, false) : 'No date'
      map.set(k, [...(map.get(k) ?? []), t])
    }
    return [...map.entries()].map(([k, v]) => ({ key: k, title: k, items: v }))
  }, [items, filter])

  return (
    <div className="mx-auto w-full max-w-[860px]" data-testid="tasks-view">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {LISTS.map((l) => {
          const Icon = l.icon
          const on = l.key === filter
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => setFilter(l.key)}
              aria-pressed={on}
              className={cn('flex flex-col rounded-[12px] p-2.5 text-left transition-colors active:opacity-70', on ? 'text-white' : 'bg-white')}
              style={on ? { background: l.color } : undefined}
              data-testid={'task-list-' + l.key}
            >
              <span className="flex items-start justify-between">
                <span className="flex size-8 items-center justify-center rounded-full" style={{ background: on ? 'rgb(255 255 255 / 0.25)' : l.color }}>
                  <Icon className="size-[18px] text-white" />
                </span>
                <span className="text-[24px] leading-7 font-bold">{l.key === filter && items ? items.filter((t) => filter === 'completed' || t.status !== 'COMPLETED').length : counts[l.key] ?? ''}</span>
              </span>
              <span className={cn('mt-1.5 text-[15px] font-semibold', on ? 'text-white' : 'text-[var(--ios-label2)]')}>{l.label}</span>
            </button>
          )
        })}
      </div>

      <label className="ios-search mt-4 bg-white">
        <Search className="size-[17px] shrink-0" aria-hidden />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" data-testid="task-search" />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="flex size-[18px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white"><X className="size-3" strokeWidth={3} /></button>}
      </label>

      <h2 className="mt-5 mb-1.5 px-1 text-[22px] font-bold" style={{ color: current.color === '#1c1c1e' ? undefined : current.color }}>{current.label}</h2>

      {error && (
        <div className="py-8 text-center">
          <p className="text-[15px] text-[var(--ios-label2)]">{error}</p>
          <button type="button" className="ios-btn-tinted mt-3" onClick={load}>Try again</button>
        </div>
      )}
      {!items && !error && <div className="h-40 animate-pulse rounded-[12px] bg-white/70" aria-busy="true" />}
      {items && items.length === 0 && (
        <Empty
          icon={<ListTodo className="size-8" />}
          title={search ? 'No Results' : filter === 'completed' ? 'Nothing completed yet' : filter === 'overdue' ? 'Nothing overdue' : 'No Tasks'}
          text={search ? undefined : filter === 'followups' ? 'Tap a chat message, a call or a note and choose “Create task or reminder”.' : 'Add a task with a due date and a reminder so nothing is missed.'}
        />
      )}
      {grouped.map((g) => (
        <section key={g.key} className="mb-3">
          {g.title && <p className="ios-group-title mt-3">{g.title}</p>}
          <div className="ios-group ios-list">
            {g.items.map((t) => (
              <TaskRow key={t.id} t={t} onToggle={() => toggle(t)} onOpen={() => setEditing(t)} />
            ))}
          </div>
        </section>
      ))}

      {filter !== 'completed' && (
        <button type="button" onClick={() => setEditing('new')} className="mt-3 flex items-center gap-2 px-1 py-2 text-[17px] font-semibold text-[var(--ios-blue)] active:opacity-50" data-testid="task-new">
          <span className="flex size-6 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white"><Plus className="size-4" strokeWidth={3} /></span>
          New Task
        </button>
      )}

      {editing && (
        <TaskEditor
          task={editing === 'new' ? null : editing}
          seed={editing === 'new' && filter === 'today' ? { dueUtc: new Date(new Date().setHours(23, 59, 0, 0)).toISOString(), hasDueTime: false } : undefined}
          onClose={closeEditor}
          onSaved={(t, next) => {
            replace(t, next ?? null)
            if (editing === 'new') load()
          }}
          onDeleted={(id) => setItems((list) => list?.filter((x) => x.id !== id) ?? list)}
        />
      )}
    </div>
  )
}

export const isOverdue = (t: Task) => !!t.dueUtc && parseUtc(t.dueUtc).getTime() < Date.now() && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
