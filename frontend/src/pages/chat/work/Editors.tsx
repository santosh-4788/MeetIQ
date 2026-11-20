import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bell, CalendarDays, Clock, Flag, Folder, Link2, MessageSquare, Phone, Pin, Repeat, Search, StickyNote, Trash2, UserRound, Video, X } from 'lucide-react'
import { chatApi, type ChatPerson } from '../../../api/chat'
import { errorMessage } from '../../../api/types'
import {
  workApi, type Category, type LinkConversation, type LinkEmployee, type LinkMeeting, type Note, type NoteInput, type Priority, type RepeatRule,
  type Task, type TaskInput, type TaskStatus,
} from '../../../api/work'
import { Avatar } from '../../../components/ui/Avatar'
import { ConfirmDialog } from '../../../components/ui/Overlay'
import { useToast } from '../../../components/ui/Toast'
import { parseUtc } from '../../../lib/format'
import { IosSegmented } from '../IosSegmented'
import { Group, PRIORITY, Row, Sheet, STATUS, fromLocalInput, toLocalInput, whenText } from './ui'

// ---------------------------------------------------------------------------------------------------------------------
// Shared bits

function useCategories() {
  const [cats, setCats] = useState<Category[]>([])
  useEffect(() => {
    workApi.categories().then(setCats, () => {})
  }, [])
  return [cats, setCats] as const
}

const COLORS = ['#007aff', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#5ac8fa', '#ff2d55', '#8e8e93']

function CategorySelect({ value, onChange, cats, setCats }: { value: string | null; onChange: (id: string | null) => void; cats: Category[]; setCats: (c: Category[]) => void }) {
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const current = cats.find((c) => c.id === value)
  if (adding)
    return (
      <div className="flex items-center gap-2 px-4 py-1.5">
        <input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="New category" className="ios-field !px-0" aria-label="New category name" />
        <button
          type="button"
          className="text-[16px] font-semibold text-[var(--ios-blue)] disabled:text-[var(--ios-gray2)]"
          disabled={!name.trim()}
          onClick={() =>
            workApi.addCategory(name.trim(), COLORS[cats.length % COLORS.length]).then(
              (c) => {
                setCats([...cats, c])
                onChange(c.id)
                setAdding(false)
                setName('')
              },
              (e) => toast.error(errorMessage(e, 'The category could not be added.')),
            )
          }
        >
          Add
        </button>
        <button type="button" className="text-[16px] text-[var(--ios-blue)]" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    )
  return (
    <Row label="Category" icon={<Folder className="size-4" />} tint={current?.color ?? 'var(--ios-gray)'}>
      <select
        value={value ?? ''}
        onChange={(e) => (e.target.value === '__new' ? setAdding(true) : onChange(e.target.value || null))}
        className="max-w-[60%] appearance-none bg-transparent text-right text-[17px] text-[var(--ios-gray)] outline-none md:text-[16px]"
        aria-label="Category"
        data-testid="field-category"
      >
        <option value="">None</option>
        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="__new">New category…</option>
      </select>
    </Row>
  )
}

/** Due date + optional time as two iOS switches. Date-only tasks are due at the end of that day. */
function DueRows({ dueUtc, hasTime, onChange }: { dueUtc: string | null; hasTime: boolean; onChange: (dueUtc: string | null, hasTime: boolean) => void }) {
  const local = toLocalInput(dueUtc)
  const date = local.slice(0, 10)
  const time = hasTime ? local.slice(11, 16) : ''
  const set = (d: string, t: string | null) => {
    if (!d) return onChange(null, false)
    onChange(new Date(`${d}T${t ?? '23:59'}`).toISOString(), !!t)
  }
  const today = () => {
    const n = new Date()
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
  }
  return (
    <>
      <Row label="Date" icon={<CalendarDays className="size-4" />} tint="var(--ios-red)">
        {dueUtc && <input type="date" value={date} onChange={(e) => set(e.target.value, hasTime ? time : null)} className="w-[9.5rem] min-w-0 bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Due date" data-testid="field-due-date" />}
        <input type="checkbox" role="switch" className="ios-switch" checked={!!dueUtc} onChange={(e) => (e.target.checked ? set(today(), null) : onChange(null, false))} aria-label="Has a due date" data-testid="field-due-on" />
      </Row>
      {dueUtc && (
        <Row label="Time" icon={<Clock className="size-4" />} tint="var(--ios-blue)">
          {hasTime && <input type="time" value={time} onChange={(e) => set(date, e.target.value || null)} className="w-[9.5rem] min-w-0 bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Due time" data-testid="field-due-time" />}
          <input type="checkbox" role="switch" className="ios-switch" checked={hasTime} onChange={(e) => set(date, e.target.checked ? '09:00' : null)} aria-label="Has a due time" data-testid="field-time-on" />
        </Row>
      )}
    </>
  )
}

const OFFSETS: { key: string; label: string; minutes: number }[] = [
  { key: 'at', label: 'At time of due', minutes: 0 },
  { key: '5', label: '5 minutes before', minutes: 5 },
  { key: '15', label: '15 minutes before', minutes: 15 },
  { key: '30', label: '30 minutes before', minutes: 30 },
  { key: '60', label: '1 hour before', minutes: 60 },
  { key: '1440', label: '1 day before', minutes: 1440 },
]

/** Reminder: None, relative to the due time, or a custom date and time. */
function ReminderRow({ reminderUtc, dueUtc, hasDueTime, onChange }: { reminderUtc: string | null; dueUtc: string | null; hasDueTime: boolean; onChange: (v: string | null) => void }) {
  const due = dueUtc && hasDueTime ? parseUtc(dueUtc).getTime() : null
  const offsetKey = useMemo(() => {
    if (!reminderUtc) return 'none'
    if (due !== null) {
      const diff = Math.round((due - parseUtc(reminderUtc).getTime()) / 60_000)
      const o = OFFSETS.find((x) => x.minutes === diff)
      if (o) return o.key
    }
    return 'custom'
  }, [reminderUtc, due])
  const [custom, setCustom] = useState(offsetKey === 'custom')
  useEffect(() => setCustom(offsetKey === 'custom'), [offsetKey])
  const pick = (k: string) => {
    if (k === 'none') return (setCustom(false), onChange(null))
    if (k === 'custom') {
      setCustom(true)
      const base = reminderUtc ?? new Date(Date.now() + 60 * 60_000).toISOString()
      return onChange(base)
    }
    setCustom(false)
    const o = OFFSETS.find((x) => x.key === k)!
    onChange(new Date(due! - o.minutes * 60_000).toISOString())
  }
  return (
    <>
      <Row label="Remind me" icon={<Bell className="size-4" />} tint="var(--ios-orange)">
        <select value={custom ? 'custom' : offsetKey} onChange={(e) => pick(e.target.value)} className="max-w-[62%] appearance-none bg-transparent text-right text-[17px] text-[var(--ios-gray)] outline-none md:text-[16px]" aria-label="Reminder" data-testid="field-reminder">
          <option value="none">None</option>
          {due !== null && OFFSETS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          <option value="custom">Custom date and time…</option>
        </select>
      </Row>
      {(custom || (offsetKey === 'custom' && reminderUtc)) && (
        <Row label="Reminder at">
          <input type="datetime-local" value={toLocalInput(reminderUtc)} onChange={(e) => onChange(fromLocalInput(e.target.value))} className="w-[9.5rem] min-w-0 bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Reminder date and time" data-testid="field-reminder-at" />
        </Row>
      )}
      {reminderUtc && parseUtc(reminderUtc).getTime() < Date.now() - 60_000 && (
        <p className="px-4 py-1.5 text-[13px] text-[var(--ios-orange)]">This time has passed; the reminder will show straight away.</p>
      )}
    </>
  )
}

function Segmented<T extends string>(p: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return <IosSegmented {...p} />
}

/** Picker sheet: search my meetings (upcoming first, then the last 30 days). */
export function MeetingPicker({ onPick, onClose }: { onPick: (m: LinkMeeting) => void; onClose: () => void }) {
  const [term, setTerm] = useState('')
  const [items, setItems] = useState<LinkMeeting[] | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => workApi.meetings(term.trim()).then(setItems, () => setItems([])), term ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [term])
  return (
    <Sheet title="Related meeting" onClose={onClose} testId="meeting-picker">
      <label className="ios-search mt-1"><Search className="size-[17px]" /><input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search meetings" aria-label="Search meetings" /></label>
      <Group>
        {items === null && <p className="px-4 py-3 text-[15px] text-[var(--ios-gray)]">Loading…</p>}
        {items?.length === 0 && <p className="px-4 py-3 text-[15px] text-[var(--ios-gray)]">No meetings found.</p>}
        {items?.map((m) => (
          <button key={m.id} type="button" onClick={() => onPick(m)} className="ios-pressable flex w-full flex-col items-start px-4 py-2.5 text-left" data-testid="meeting-option">
            <span className="text-[16px]">{m.title}</span>
            <span className="text-[13px] text-[var(--ios-gray)]">{whenText(m.startUtc)}</span>
          </button>
        ))}
      </Group>
    </Sheet>
  )
}

/** Picker sheet: search colleagues (same directory as Chat). */
export function PersonPicker({ onPick, onClose }: { onPick: (p: ChatPerson) => void; onClose: () => void }) {
  const [term, setTerm] = useState('')
  const [items, setItems] = useState<ChatPerson[] | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => chatApi.people(term.trim()).then(setItems, () => setItems([])), term ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [term])
  return (
    <Sheet title="Related employee" onClose={onClose} testId="person-picker">
      <label className="ios-search mt-1"><Search className="size-[17px]" /><input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search colleagues" aria-label="Search colleagues" /></label>
      <Group>
        {items === null && <p className="px-4 py-3 text-[15px] text-[var(--ios-gray)]">Loading…</p>}
        {items?.length === 0 && <p className="px-4 py-3 text-[15px] text-[var(--ios-gray)]">No colleagues found.</p>}
        {items?.slice(0, 30).map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(p)} className="ios-pressable flex w-full items-center gap-3 px-4 py-2 text-left" data-testid="person-option">
            <Avatar name={p.name} size={34} />
            <span className="min-w-0">
              <span className="block truncate text-[16px]">{p.name}</span>
              <span className="block truncate text-[13px] text-[var(--ios-gray)]">{[p.code, p.designation].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
        ))}
      </Group>
    </Sheet>
  )
}

function LinkRow({ icon, tint, label, value, onClear, onClick }: { icon: ReactNode; tint: string; label: string; value: string; onClear?: () => void; onClick?: () => void }) {
  return (
    <Row label={label} icon={icon} tint={tint} onClick={onClick}>
      <span className="max-w-[55%] truncate text-right text-[16px] text-[var(--ios-gray)]">{value}</span>
      {onClear && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Remove ${label.toLowerCase()}`}
          onClick={(e) => (e.stopPropagation(), onClear())}
          onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), onClear())}
          className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--ios-gray4)] text-white"
        >
          <X className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </Row>
  )
}

/**
 * The reminder to send: a time in the past means "now" (the server fires it on its next pass; it refuses times more
 * than a minute old). When editing, an unchanged reminder is left out so the server keeps it as it is.
 */
function reminderField(value: string | null, original: string | null, isNew: boolean): { reminderUtc?: string | null } {
  if (!isNew && value === original) return {}
  if (value && parseUtc(value).getTime() < Date.now()) return { reminderUtc: new Date().toISOString() }
  return { reminderUtc: value }
}

// ---------------------------------------------------------------------------------------------------------------------
// Task editor

/** What a new task starts with when it is a follow-up (from a message, chat, call, meeting or note). */
export type TaskSeed = TaskInput & {
  messageExcerpt?: string | null
  messageSender?: string | null
  conversationTitle?: string | null
  callLabel?: string | null
  meetingTitle?: string | null
  noteTitle?: string | null
  employeeName?: string | null
}

export function TaskEditor({ task, seed, onClose, onSaved, onDeleted }: { task?: Task | null; seed?: TaskSeed; onClose: () => void; onSaved: (t: Task, next?: Task | null) => void; onDeleted?: (id: string) => void }) {
  const toast = useToast()
  const [cats, setCats] = useCategories()
  const [title, setTitle] = useState(task?.title ?? seed?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? seed?.description ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? seed?.priority ?? 'MEDIUM')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'PENDING')
  const [dueUtc, setDueUtc] = useState<string | null>(task?.dueUtc ?? seed?.dueUtc ?? null)
  const [hasDueTime, setHasDueTime] = useState(task?.hasDueTime ?? seed?.hasDueTime ?? false)
  const [reminderUtc, setReminderUtc] = useState<string | null>(task?.reminderState === 'PENDING' || task?.reminderState === 'FIRED' ? task.reminderUtc : seed?.reminderUtc ?? null)
  const [categoryId, setCategoryId] = useState<string | null>(task?.categoryId ?? seed?.categoryId ?? null)
  const [repeatRule, setRepeatRule] = useState<RepeatRule>(task?.repeatRule ?? 'NONE')
  const [meeting, setMeeting] = useState<LinkMeeting | null>(task?.meeting ?? (seed?.meetingId ? { id: seed.meetingId, title: seed.meetingTitle ?? 'Meeting', startUtc: '' } : null))
  const [employee, setEmployee] = useState<LinkEmployee | null>(task?.employee ?? (seed?.employeeId ? { id: seed.employeeId, name: seed.employeeName ?? 'Employee', code: null } : null))
  const [conversation, setConversation] = useState<LinkConversation | null>(task?.conversation ?? (seed?.conversationId ? { id: seed.conversationId, title: seed.conversationTitle ?? 'Chat', isGroup: false } : null))
  const [picker, setPicker] = useState<'meeting' | 'person' | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isNew = !task

  async function save() {
    if (!title.trim()) return
    setBusy(true)
    const body: TaskInput = {
      title: title.trim(),
      description: description.trim() || null,
      notes: notes.trim() || null,
      priority,
      dueUtc,
      hasDueTime: !!dueUtc && hasDueTime,
      categoryId,
      repeatRule: dueUtc ? repeatRule : 'NONE',
      ...reminderField(reminderUtc, task?.reminderState === 'PENDING' || task?.reminderState === 'FIRED' ? task.reminderUtc : null, isNew),
      meetingId: meeting?.id ?? null,
      employeeId: employee?.id ?? null,
      conversationId: conversation?.id ?? null,
    }
    try {
      if (isNew) {
        const created = await workApi.createTask({ ...body, sourceMessageId: seed?.sourceMessageId ?? null, sourceCallId: seed?.sourceCallId ?? null, noteId: seed?.noteId ?? null })
        onSaved(created)
        toast.success(reminderUtc ? `Task added · reminder ${whenText(reminderUtc)}` : 'Task added')
      } else {
        const statusChanged = status !== task.status
        let saved = await workApi.updateTask(task.id, body)
        let next: Task | null = null
        if (statusChanged) {
          const r = await workApi.setStatus(task.id, status)
          saved = r.task
          next = r.next
        }
        onSaved(saved, next)
      }
      onClose()
    } catch (e) {
      toast.error(errorMessage(e, 'The task could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Sheet title={isNew ? (seed?.sourceMessageId || seed?.sourceCallId || seed?.conversationId || seed?.meetingId || seed?.noteId ? 'Follow-up' : 'New Task') : 'Details'} onClose={onClose} onDone={() => void save()} doneLabel={isNew ? 'Add' : 'Done'} doneDisabled={!title.trim()} busy={busy} testId="task-editor">
        <Group className="!mt-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Title" aria-label="Title" className="ios-field" autoFocus={isNew && !title} data-testid="task-title" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} rows={2} placeholder="Description" aria-label="Description" className="ios-field resize-none" data-testid="task-description" />
        </Group>

        {(seed?.messageExcerpt || task?.message) && (
          <Group title="From a message">
            <div className="flex gap-3 px-4 py-2.5">
              <MessageSquare className="mt-0.5 size-4 shrink-0 text-[var(--ios-blue)]" />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-[var(--ios-label2)]">{task?.message?.senderName ?? seed?.messageSender ?? ''}{(task?.message?.sentUtc) ? ` · ${whenText(task.message.sentUtc)}` : ''}</p>
                <p className="line-clamp-3 text-[15px]">{task?.message?.excerpt ?? seed?.messageExcerpt}</p>
              </div>
            </div>
          </Group>
        )}
        {(seed?.callLabel || task?.call) && (
          <Group title="From a call">
            <Row label={task?.call ? `${task.call.otherName ?? 'Call'} · ${whenText(task.call.startedUtc)}` : seed!.callLabel!} icon={<Phone className="size-4" />} tint="var(--ios-green)" />
          </Group>
        )}

        <Group title="Date and reminder">
          <DueRows dueUtc={dueUtc} hasTime={hasDueTime} onChange={(d, t) => (setDueUtc(d), setHasDueTime(t))} />
          <ReminderRow reminderUtc={reminderUtc} dueUtc={dueUtc} hasDueTime={hasDueTime} onChange={setReminderUtc} />
          {dueUtc && (
            <Row label="Repeat" icon={<Repeat className="size-4" />} tint="var(--ios-gray)">
              <select value={repeatRule} onChange={(e) => setRepeatRule(e.target.value as RepeatRule)} className="appearance-none bg-transparent text-right text-[17px] text-[var(--ios-gray)] outline-none md:text-[16px]" aria-label="Repeat" data-testid="field-repeat">
                <option value="NONE">Never</option>
                <option value="DAILY">Daily</option>
                <option value="WEEKDAYS">Weekdays</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </Row>
          )}
        </Group>

        <Group title="Priority">
          <div className="p-2">
            <Segmented label="Priority" value={priority} onChange={setPriority} options={(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as Priority[]).map((k) => ({ key: k, label: PRIORITY[k].label }))} />
          </div>
        </Group>

        <Group>
          {!isNew && (
            <Row label="Status" icon={<Flag className="size-4" />} tint="var(--ios-purple)">
              <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} className="appearance-none bg-transparent text-right text-[17px] text-[var(--ios-gray)] outline-none md:text-[16px]" aria-label="Status" data-testid="field-status">
                {(Object.keys(STATUS) as TaskStatus[]).map((k) => <option key={k} value={k}>{STATUS[k]}</option>)}
              </select>
            </Row>
          )}
          <CategorySelect value={categoryId} onChange={setCategoryId} cats={cats} setCats={setCats} />
        </Group>

        <Group title="Related to">
          <LinkRow icon={<Video className="size-4" />} tint="#5856d6" label="Meeting" value={meeting?.title ?? 'None'} onClick={() => setPicker('meeting')} onClear={meeting ? () => setMeeting(null) : undefined} />
          <LinkRow icon={<UserRound className="size-4" />} tint="var(--ios-green)" label="Employee" value={employee?.name ?? 'None'} onClick={() => setPicker('person')} onClear={employee ? () => setEmployee(null) : undefined} />
          {conversation && <LinkRow icon={<MessageSquare className="size-4" />} tint="var(--ios-blue)" label="Chat" value={conversation.title} onClear={seed?.sourceMessageId ? undefined : () => setConversation(null)} />}
          {(task?.note || seed?.noteTitle) && <LinkRow icon={<StickyNote className="size-4" />} tint="var(--ios-yellow)" label="Note" value={task?.note?.title ?? seed!.noteTitle!} />}
        </Group>

        <Group title="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={8000} rows={3} placeholder="Add notes" aria-label="Notes" className="ios-field resize-none" />
        </Group>

        {!isNew && (
          <Group>
            <Row label="Delete Task" danger onClick={() => setConfirmDelete(true)} testId="task-delete" icon={<Trash2 className="size-4" />} tint="var(--ios-red)" />
          </Group>
        )}
      </Sheet>
      {picker === 'meeting' && <MeetingPicker onClose={() => setPicker(null)} onPick={(m) => (setMeeting(m), setPicker(null))} />}
      {picker === 'person' && <PersonPicker onClose={() => setPicker(null)} onPick={(p) => (setEmployee({ id: p.id, name: p.name, code: p.code }), setPicker(null))} />}
      {task && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title="Delete this task?"
          confirmLabel="Delete"
          onConfirm={async () => {
            await workApi.deleteTask(task.id)
            onDeleted?.(task.id)
            onClose()
          }}
        >
          <p className="text-[14px] text-ink-secondary">“{task.title}” and its reminder are removed.</p>
        </ConfirmDialog>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Note editor

export type NoteSeed = NoteInput & { meetingTitle?: string | null; conversationTitle?: string | null; employeeName?: string | null }

export function NoteEditor({ note, seed, onClose, onSaved, onDeleted, onMakeTask }: { note?: Note | null; seed?: NoteSeed; onClose: () => void; onSaved: (n: Note) => void; onDeleted?: (id: string) => void; onMakeTask?: (n: Note) => void }) {
  const toast = useToast()
  const [cats, setCats] = useCategories()
  const [title, setTitle] = useState(note?.title ?? seed?.title ?? '')
  const [body, setBody] = useState(note?.body ?? seed?.body ?? '')
  const [categoryId, setCategoryId] = useState<string | null>(note?.categoryId ?? seed?.categoryId ?? null)
  const [isPinned, setPinned] = useState(note?.isPinned ?? seed?.isPinned ?? false)
  const [isCompleted, setCompleted] = useState(note?.isCompleted ?? false)
  const [isArchived, setArchived] = useState(note?.isArchived ?? false)
  const [noteDateUtc, setNoteDate] = useState<string | null>(note?.noteDateUtc ?? seed?.noteDateUtc ?? null)
  const [reminderUtc, setReminderUtc] = useState<string | null>(note?.reminderState === 'PENDING' || note?.reminderState === 'FIRED' ? note.reminderUtc : seed?.reminderUtc ?? null)
  const [meeting, setMeeting] = useState<LinkMeeting | null>(note?.meeting ?? (seed?.meetingId ? { id: seed.meetingId, title: seed.meetingTitle ?? 'Meeting', startUtc: '' } : null))
  const [employee, setEmployee] = useState<LinkEmployee | null>(note?.employee ?? (seed?.employeeId ? { id: seed.employeeId, name: seed.employeeName ?? 'Employee', code: null } : null))
  const [conversation, setConversation] = useState<LinkConversation | null>(note?.conversation ?? (seed?.conversationId ? { id: seed.conversationId, title: seed.conversationTitle ?? 'Chat', isGroup: false } : null))
  const [picker, setPicker] = useState<'meeting' | 'person' | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isNew = !note

  async function save() {
    if (!title.trim()) return
    setBusy(true)
    const input: NoteInput = {
      title: title.trim(),
      body: body.trim() || null,
      categoryId,
      isPinned,
      noteDateUtc,
      ...reminderField(reminderUtc, note?.reminderState === 'PENDING' || note?.reminderState === 'FIRED' ? note.reminderUtc : null, isNew),
      meetingId: meeting?.id ?? null,
      employeeId: employee?.id ?? null,
      conversationId: conversation?.id ?? null,
      ...(isNew ? {} : { isCompleted, isArchived }),
    }
    try {
      const saved = isNew ? await workApi.createNote(input) : await workApi.updateNote(note.id, input)
      onSaved(saved)
      if (isNew) toast.success(reminderUtc ? `Note saved · reminder ${whenText(reminderUtc)}` : 'Note saved')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e, 'The note could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  const dateValue = noteDateUtc ? toLocalInput(noteDateUtc).slice(0, 10) : ''
  return (
    <>
      <Sheet title={isNew ? 'New Note' : 'Note'} onClose={onClose} onDone={() => void save()} doneLabel={isNew ? 'Save' : 'Done'} doneDisabled={!title.trim()} busy={busy} testId="note-editor">
        <Group className="!mt-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Title" aria-label="Title" className="ios-field text-[19px] font-semibold" autoFocus={isNew && !title} data-testid="note-title" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} rows={7} placeholder="Write your note…" aria-label="Note" className="ios-field resize-y leading-[22px]" data-testid="note-body" />
        </Group>
        <p className="px-4 pt-1.5 text-[13px] text-[var(--ios-label2)]">Only you can see your notes.</p>

        <Group title="Date and reminder">
          <Row label="Date" icon={<CalendarDays className="size-4" />} tint="var(--ios-red)">
            {noteDateUtc && <input type="date" value={dateValue} onChange={(e) => setNoteDate(e.target.value ? new Date(`${e.target.value}T09:00`).toISOString() : null)} className="w-[9.5rem] min-w-0 bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Note date" />}
            <input type="checkbox" role="switch" className="ios-switch" checked={!!noteDateUtc} onChange={(e) => setNoteDate(e.target.checked ? new Date(new Date().setHours(9, 0, 0, 0)).toISOString() : null)} aria-label="Has a date" />
          </Row>
          <ReminderRow reminderUtc={reminderUtc} dueUtc={null} hasDueTime={false} onChange={setReminderUtc} />
        </Group>

        <Group>
          <Row label="Pin" icon={<Pin className="size-4" />} tint="var(--ios-orange)">
            <input type="checkbox" role="switch" className="ios-switch" checked={isPinned} onChange={(e) => setPinned(e.target.checked)} aria-label="Pin note" data-testid="note-pin" />
          </Row>
          <CategorySelect value={categoryId} onChange={setCategoryId} cats={cats} setCats={setCats} />
          {!isNew && (
            <>
              <Row label="Completed">
                <input type="checkbox" role="switch" className="ios-switch" checked={isCompleted} onChange={(e) => setCompleted(e.target.checked)} aria-label="Completed" data-testid="note-completed" />
              </Row>
              <Row label="Archived">
                <input type="checkbox" role="switch" className="ios-switch" checked={isArchived} onChange={(e) => setArchived(e.target.checked)} aria-label="Archived" data-testid="note-archived" />
              </Row>
            </>
          )}
        </Group>

        <Group title="Related to">
          <LinkRow icon={<Video className="size-4" />} tint="#5856d6" label="Meeting" value={meeting?.title ?? 'None'} onClick={() => setPicker('meeting')} onClear={meeting ? () => setMeeting(null) : undefined} />
          <LinkRow icon={<UserRound className="size-4" />} tint="var(--ios-green)" label="Employee" value={employee?.name ?? 'None'} onClick={() => setPicker('person')} onClear={employee ? () => setEmployee(null) : undefined} />
          {conversation && <LinkRow icon={<MessageSquare className="size-4" />} tint="var(--ios-blue)" label="Chat" value={conversation.title} onClear={() => setConversation(null)} />}
          {note?.task && <LinkRow icon={<Link2 className="size-4" />} tint="var(--ios-purple)" label="Task" value={note.task.title} />}
        </Group>

        {!isNew && (
          <Group>
            {onMakeTask && <Row label="Create follow-up task" onClick={() => onMakeTask(note)} testId="note-make-task" />}
            <Row label="Delete Note" danger onClick={() => setConfirmDelete(true)} testId="note-delete" icon={<Trash2 className="size-4" />} tint="var(--ios-red)" />
          </Group>
        )}
      </Sheet>
      {picker === 'meeting' && <MeetingPicker onClose={() => setPicker(null)} onPick={(m) => (setMeeting(m), setPicker(null))} />}
      {picker === 'person' && <PersonPicker onClose={() => setPicker(null)} onPick={(p) => (setEmployee({ id: p.id, name: p.name, code: p.code }), setPicker(null))} />}
      {note && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title="Delete this note?"
          confirmLabel="Delete"
          onConfirm={async () => {
            await workApi.deleteNote(note.id)
            onDeleted?.(note.id)
            onClose()
          }}
        >
          <p className="text-[14px] text-ink-secondary">“{note.title}” and its reminder are removed.</p>
        </ConfirmDialog>
      )}
    </>
  )
}

