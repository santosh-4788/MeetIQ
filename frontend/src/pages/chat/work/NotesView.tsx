import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, CalendarDays, ChevronLeft, ChevronRight, Lock, MessageSquare, Pin, Plus, Search, StickyNote, UserRound, Video, X } from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi, type Note, type NoteFilter } from '../../../api/work'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { parseUtc } from '../../../lib/format'
import { NoteEditor } from './Editors'
import FollowUpSheet, { type FollowUpSource } from './FollowUp'
import { ScrollChips } from '../ScrollChips'
import { Empty, Pill, whenText } from './ui'

const FILTERS: { key: NoteFilter | 'date'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'date', label: 'By date' },
  { key: 'completed', label: 'Completed' },
  { key: 'archived', label: 'Archived' },
]

function preview(n: Note) {
  return (n.body ?? '').replace(/\s+/g, ' ').trim() || 'No additional text'
}

export function NoteRow({ n, onOpen }: { n: Note; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="ios-pressable flex w-full pl-4 text-left" data-testid="note-row">
      <span className="ios-sep-top flex min-w-0 flex-1 flex-col py-2.5 pr-4">
        <span className={cn('flex items-center gap-1.5 text-[17px] leading-[22px] font-semibold md:text-[16px]', n.isCompleted && 'text-[var(--ios-gray)] line-through')}>
          {n.isPinned && <Pin className="size-3.5 shrink-0 fill-[var(--ios-orange)] text-[var(--ios-orange)]" aria-label="Pinned" />}
          <span className="truncate" data-testid="note-row-title">{n.title}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 gap-2 text-[15px] text-[var(--ios-gray)]">
          <span className="shrink-0 text-[var(--ios-label)]">{whenText(n.noteDateUtc ?? n.updatedUtc, false)}</span>
          <span className="truncate">{preview(n)}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--ios-gray)] empty:hidden">
          {n.reminderUtc && (n.reminderState === 'PENDING' || n.reminderState === 'FIRED') && (
            <span className="inline-flex items-center gap-0.5 text-[var(--ios-orange)]"><Bell className="size-3.5" aria-hidden />{whenText(n.reminderUtc)}</span>
          )}
          {n.categoryName && <Pill color={n.categoryColor ?? undefined}>{n.categoryName}</Pill>}
          {n.meeting && <span className="inline-flex items-center gap-0.5"><Video className="size-3.5" aria-hidden />{n.meeting.title}</span>}
          {n.employee && <span className="inline-flex items-center gap-0.5"><UserRound className="size-3.5" aria-hidden />{n.employee.name}</span>}
          {n.conversation && <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3.5" aria-hidden />{n.conversation.title}</span>}
        </span>
      </span>
    </button>
  )
}

/** Monday-start week strip for the "By date" view. */
function WeekStrip({ day, onDay }: { day: Date; onDay: (d: Date) => void }) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7))
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  const today = new Date()
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const shift = (n: number) => onDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + n))
  return (
    <div className="mt-3 rounded-[12px] bg-white p-2.5">
      <div className="flex items-center justify-between px-1">
        <p className="text-[15px] font-semibold">{new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(day)}</p>
        <span className="flex items-center gap-1">
          <button type="button" onClick={() => shift(-7)} aria-label="Previous week" className="ios-icon-btn size-8"><ChevronLeft className="size-5" /></button>
          <button type="button" onClick={() => onDay(new Date())} className="px-1 text-[15px] text-[var(--ios-blue)]">Today</button>
          <button type="button" onClick={() => shift(7)} aria-label="Next week" className="ios-icon-btn size-8"><ChevronRight className="size-5" /></button>
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-7 gap-1 text-center">
        {days.map((d) => {
          const on = same(d, day)
          const isToday = same(d, today)
          return (
            <button key={d.toISOString()} type="button" onClick={() => onDay(d)} aria-pressed={on} aria-label={d.toDateString()} className="flex flex-col items-center gap-1 py-1">
              <span className="text-[11px] font-semibold text-[var(--ios-gray)] uppercase">{new Intl.DateTimeFormat('en-IN', { weekday: 'short' }).format(d).slice(0, 3)}</span>
              <span className={cn('flex size-9 items-center justify-center rounded-full text-[17px]', on ? (isToday ? 'bg-[var(--ios-red)] font-semibold text-white' : 'bg-[#1c1c1e] font-semibold text-white') : isToday ? 'font-semibold text-[var(--ios-red)]' : '')}>{d.getDate()}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Notes: iOS Notes-style list (Pinned first), filters, search, a week view, private to the owner. */
export function NotesView({ params, setParams }: { params: URLSearchParams; setParams: (p: URLSearchParams) => void }) {
  const toast = useToast()
  const filter = (params.get('filter') as NoteFilter | 'date' | null) ?? 'all'
  const [items, setItems] = useState<Note[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [day, setDay] = useState(() => new Date())
  const [editing, setEditing] = useState<Note | 'new' | null>(null)
  const [followUp, setFollowUp] = useState<FollowUpSource | null>(null)
  const openNoteId = params.get('note')

  const setFilter = (f: string) => {
    const next = new URLSearchParams(params)
    next.set('filter', f)
    next.delete('note')
    setParams(next)
  }

  const load = useCallback(() => {
    const range = filter === 'date'
      ? { from: new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString(), to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString() }
      : {}
    workApi.notes({ filter: filter === 'date' ? 'all' : filter, search: search.trim() || undefined, ...range }).then(
      (r) => {
        setItems(r.items)
        setError(null)
      },
      (e) => setError(errorMessage(e, 'Your notes could not be loaded.')),
    )
  }, [filter, search, day])

  useEffect(() => {
    setItems(null)
    const t = window.setTimeout(load, search ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [load, search])

  useEffect(() => {
    if (!openNoteId) return
    workApi.note(openNoteId).then((n) => setEditing(n), () => toast.error('That note is not available.'))
  }, [openNoteId, toast])

  const closeEditor = () => {
    setEditing(null)
    if (openNoteId) {
      const next = new URLSearchParams(params)
      next.delete('note')
      setParams(next)
    }
  }

  const pinned = useMemo(() => (items ?? []).filter((n) => n.isPinned && filter === 'all'), [items, filter])
  const rest = useMemo(() => (items ?? []).filter((n) => !(n.isPinned && filter === 'all')), [items, filter])

  return (
    <div className="mx-auto w-full max-w-[860px]" data-testid="notes-view">
      <label className="ios-search bg-white">
        <Search className="size-[17px] shrink-0" aria-hidden />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notes" aria-label="Search notes" data-testid="note-search" />
        {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="flex size-[18px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white"><X className="size-3" strokeWidth={3} /></button>}
      </label>
      <ScrollChips label="Filter notes" className="mt-2.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn('inline-flex h-[30px] shrink-0 items-center gap-1 rounded-full px-3.5 text-[14px] font-medium', filter === f.key ? 'bg-[#1c1c1e] text-white' : 'bg-white text-[var(--ios-label)]')}
            data-testid={'note-filter-' + f.key}
          >
            {f.key === 'date' && <CalendarDays className="size-3.5" />}
            {f.label}
          </button>
        ))}
      </ScrollChips>
      {filter === 'date' && <WeekStrip day={day} onDay={setDay} />}

      {error && (
        <div className="py-8 text-center">
          <p className="text-[15px] text-[var(--ios-label2)]">{error}</p>
          <button type="button" className="ios-btn-tinted mt-3" onClick={load}>Try again</button>
        </div>
      )}
      {!items && !error && <div className="mt-4 h-40 animate-pulse rounded-[12px] bg-white/70" aria-busy="true" />}
      {items && items.length === 0 && (
        <Empty
          icon={<StickyNote className="size-8" />}
          title={search ? 'No Results' : 'No Notes'}
          text={search ? undefined : 'Meeting preparation, customer follow-ups, daily work: notes are private to you.'}
        />
      )}
      {pinned.length > 0 && (
        <section>
          <p className="ios-group-title mt-5">Pinned</p>
          <div className="ios-group ios-list">{pinned.map((n) => <NoteRow key={n.id} n={n} onOpen={() => setEditing(n)} />)}</div>
        </section>
      )}
      {rest.length > 0 && (
        <section>
          <p className="ios-group-title mt-5">{filter === 'date' ? whenText(day.toISOString(), false) : pinned.length ? 'Notes' : FILTERS.find((f) => f.key === filter)?.label}</p>
          <div className="ios-group ios-list">{rest.map((n) => <NoteRow key={n.id} n={n} onOpen={() => setEditing(n)} />)}</div>
        </section>
      )}
      {items && items.length > 0 && <p className="mt-2 text-center text-[13px] text-[var(--ios-gray)]">{items.length} {items.length === 1 ? 'Note' : 'Notes'}</p>}
      <p className="mt-3 flex items-center justify-center gap-1 text-[12px] text-[var(--ios-gray)]"><Lock className="size-3" /> Notes are private: no one else can see them.</p>

      <button type="button" onClick={() => setEditing('new')} className="mt-3 flex items-center gap-2 px-1 py-2 text-[17px] font-semibold text-[var(--ios-blue)] active:opacity-50" data-testid="note-new">
        <span className="flex size-6 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white"><Plus className="size-4" strokeWidth={3} /></span>
        New Note
      </button>

      {editing && (
        <NoteEditor
          note={editing === 'new' ? null : editing}
          seed={editing === 'new' && filter === 'date' ? { noteDateUtc: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).toISOString() } : editing === 'new' && filter === 'pinned' ? { isPinned: true } : undefined}
          onClose={closeEditor}
          onSaved={() => load()}
          onDeleted={(id) => setItems((list) => list?.filter((x) => x.id !== id) ?? list)}
          onMakeTask={(n) => (closeEditor(), setFollowUp({ kind: 'note', noteId: n.id, title: n.title }))}
        />
      )}
      {followUp && <FollowUpSheet source={followUp} onClose={() => setFollowUp(null)} />}
    </div>
  )
}

export const noteTime = (n: Note) => parseUtc(n.noteDateUtc ?? n.updatedUtc).getTime()
