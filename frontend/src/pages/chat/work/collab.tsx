import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlarmClock, ArrowUpRight, BellRing, Check, CheckCircle2, ClipboardCheck, Download, FileText, Hand, Lock, MessageCircle, Paperclip, Plus, RotateCcw, Search,
  Send, ShieldCheck, Trash2, UserPlus, X, XCircle,
} from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi, type Activity, type Assignee, type Task, type TaskDetails } from '../../../api/work'
import { Avatar } from '../../../components/ui/Avatar'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { useChat } from '../ChatProvider'
import { isIOS, iosDownload } from '../saveFile'
import { Group, Sheet, toDateInput, whenText } from './ui'

// Task collaboration (V033): assigning, review before close, checklist, comments, proof files.

/** Overlapping round avatars (assignees). */
export function AvatarStack({ names, size = 22, max = 3 }: { names: (string | null)[]; size?: number; max?: number }) {
  const shown = names.slice(0, max)
  return (
    <span className="inline-flex items-center" aria-label={names.filter(Boolean).join(', ')}>
      {shown.map((n, i) => (
        <span key={i} className="rounded-full ring-2 ring-white" style={{ marginLeft: i ? -size * 0.32 : 0 }}><Avatar name={n ?? '?'} size={size} /></span>
      ))}
      {names.length > max && <span className="ml-1 text-[12px] font-semibold text-[var(--ios-gray)]">+{names.length - max}</span>}
    </span>
  )
}

/** Multi-select colleague picker for assigning a task or sharing a note. */
export function AssigneePicker({ title = 'Assign to', selected, onDone, onClose, testId = 'assignee-picker' }: {
  title?: string
  selected: Assignee[]
  onDone: (people: Assignee[]) => void
  onClose: () => void
  testId?: string
}) {
  const [term, setTerm] = useState('')
  const [items, setItems] = useState<Assignee[] | null>(null)
  const [picked, setPicked] = useState<Assignee[]>(selected)
  useEffect(() => {
    const t = window.setTimeout(() => workApi.assignees(term.trim()).then((r) => setItems(r.items), () => setItems([])), term ? 250 : 0)
    return () => window.clearTimeout(t)
  }, [term])
  const toggle = (p: Assignee) => setPicked((list) => (list.some((x) => x.id === p.id) ? list.filter((x) => x.id !== p.id) : [...list, p]))
  return (
    <Sheet title={title} onClose={onClose} onDone={() => onDone(picked)} doneLabel={picked.length ? `Done (${picked.length})` : 'Done'} testId={testId}>
      <label className="ios-search mt-1"><Search className="size-[17px]" /><input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search colleagues" aria-label="Search colleagues" data-testid="assignee-search" /></label>
      {picked.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <button key={p.id} type="button" onClick={() => toggle(p)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white pr-2.5 pl-1 text-[14px] shadow-xs active:opacity-60" aria-label={`Remove ${p.name}`}>
              <Avatar name={p.name} size={24} />{p.name.split(' ')[0]}<X className="size-3.5 text-[var(--ios-gray)]" />
            </button>
          ))}
        </div>
      )}
      <Group>
        {items === null && <p className="px-4 py-3 text-[15px] text-[var(--ios-gray)]">Loading…</p>}
        {items?.length === 0 && <p className="px-4 py-3 text-[15px] text-[var(--ios-gray)]">No colleagues found.</p>}
        {items?.map((p) => {
          const on = picked.some((x) => x.id === p.id)
          return (
            <button key={p.id} type="button" onClick={() => toggle(p)} className="ios-pressable flex w-full items-center gap-3 px-4 py-2 text-left" aria-pressed={on} data-testid="assignee-option">
              <Avatar name={p.name} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px]">{p.name}</span>
                <span className="block truncate text-[13px] text-[var(--ios-gray)]">{[p.designation, p.department].filter(Boolean).join(' · ') || p.code}</span>
              </span>
              <span className={cn('flex size-[24px] items-center justify-center rounded-full', on ? 'bg-[var(--ios-blue)] text-white' : 'shadow-[inset_0_0_0_1.5px_var(--ios-gray4)]')}>
                {on && <Check className="size-4" strokeWidth={3} />}
              </span>
            </button>
          )
        })}
      </Group>
      <p className="px-4 pt-2 text-[13px] text-[var(--ios-label2)]">Each person gets their own copy and is notified. Only you and they can see it.</p>
    </Sheet>
  )
}

/** Checklist steps typed while creating a task (sent with the task). */
export function ChecklistDraft({ items, setItems, allowRequired }: { items: { text: string; isRequired: boolean }[]; setItems: (v: { text: string; isRequired: boolean }[]) => void; allowRequired: boolean }) {
  const [text, setText] = useState('')
  const add = () => {
    const t = text.trim()
    if (!t || items.length >= 50) return
    setItems([...items, { text: t, isRequired: false }])
    setText('')
  }
  return (
    <Group title="Checklist" footer={allowRequired ? 'Mark a step “Required” and the task cannot be closed until it is ticked.' : undefined}>
      {items.map((it, i) => (
        <div key={i} className="flex min-h-[44px] items-center gap-3 px-4">
          <span className="size-[20px] shrink-0 rounded-[6px] shadow-[inset_0_0_0_1.5px_var(--ios-gray4)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[16px]">{it.text}</span>
          {allowRequired && (
            <button type="button" onClick={() => setItems(items.map((x, j) => (j === i ? { ...x, isRequired: !x.isRequired } : x)))} aria-pressed={it.isRequired}
              className={cn('h-[26px] rounded-full px-2.5 text-[12px] font-semibold', it.isRequired ? 'bg-[var(--ios-red)] text-white' : 'bg-[var(--ios-gray6)] text-[var(--ios-gray)]')} data-testid="draft-required">
              Required
            </button>
          )}
          <button type="button" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`Remove ${it.text}`} className="text-[var(--ios-gray2)]"><X className="size-4" /></button>
        </div>
      ))}
      <div className="flex items-center gap-2 px-4 py-1">
        <Plus className="size-[18px] text-[var(--ios-blue)]" />
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} maxLength={300} placeholder="Add a step" aria-label="Add a checklist step" className="ios-field !px-0" data-testid="draft-step" />
        {text.trim() && <button type="button" onClick={add} className="text-[15px] font-semibold text-[var(--ios-blue)]">Add</button>}
      </div>
    </Group>
  )
}

/** One-line form sheet: decline reason, new date request, send back comment, review note. */
export function PromptSheet({ title, label, placeholder, required, withDate, initialDate, doneLabel, danger, onSubmit, onClose, testId }: {
  title: string
  label: string
  placeholder: string
  required?: boolean
  withDate?: boolean
  initialDate?: string | null
  doneLabel: string
  danger?: boolean
  onSubmit: (text: string, dateIso: string | null) => Promise<void>
  onClose: () => void
  testId?: string
}) {
  const [text, setText] = useState('')
  const [date, setDate] = useState(initialDate ? toDateInput(initialDate) : '')
  const [busy, setBusy] = useState(false)
  const ok = (!required || !!text.trim()) && (!withDate || !!date)
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    try {
      await onSubmit(text.trim(), withDate && date ? new Date(`${date}T18:00`).toISOString() : null)
      onClose()
    } catch {
      /* the caller shows the error */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={title} onClose={onClose} onDone={() => void submit()} doneLabel={doneLabel} doneDisabled={!ok} busy={busy} testId={testId}>
      {withDate && (
        <Group className="!mt-2">
          <div className="flex min-h-[46px] items-center gap-3 px-4">
            <span className="flex-1 text-[17px]">New due date</span>
            <input type="date" value={date} min={toDateInput(new Date().toISOString())} onChange={(e) => setDate(e.target.value)} className="bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="New due date" data-testid="prompt-date" />
          </div>
        </Group>
      )}
      <Group className={withDate ? undefined : '!mt-2'} title={label}>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000} placeholder={placeholder} aria-label={label} className={cn('ios-field resize-none', danger && 'caret-[var(--ios-red)]')} data-testid="prompt-text" />
      </Group>
      {required && <p className="px-4 pt-1.5 text-[13px] text-[var(--ios-label2)]">Required — the other person will see it.</p>}
    </Sheet>
  )
}

/** Where an assigned task is: Assigned → Accepted → Working → Review → Done. */
export function ProgressSteps({ t }: { t: Task }) {
  if (!t.assignedBy) return null
  const steps = ['Assigned', 'Accepted', 'Working', ...(t.requiresReview ? ['Review'] : []), 'Done']
  const at = t.status === 'COMPLETED' ? steps.length - 1
    : t.status === 'IN_REVIEW' ? steps.indexOf('Review')
      : t.status === 'IN_PROGRESS' ? 2
        : t.assignState === 'ACCEPTED' ? 1 : 0
  const declined = t.assignState === 'DECLINED' || t.status === 'CANCELLED'
  return (
    <ol className="mt-3 flex items-center px-1" aria-label="Progress" data-testid="task-progress">
      {steps.map((s, i) => (
        <li key={s} className="flex flex-1 flex-col items-center gap-1 last:flex-none">
          <div className="flex w-full items-center">
            <span className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors',
              declined ? 'bg-[var(--ios-gray4)] text-white' : i <= at ? 'bg-[var(--ios-green)] text-white' : 'bg-white text-[var(--ios-gray)] shadow-[inset_0_0_0_1.5px_var(--ios-gray4)]')}>
              {!declined && i <= at ? <Check className="size-3.5" strokeWidth={3.2} /> : i + 1}
            </span>
            {i < steps.length - 1 && <span className={cn('mx-1 h-[2px] flex-1 rounded-full', !declined && i < at ? 'bg-[var(--ios-green)]' : 'bg-[var(--ios-gray5)]')} />}
          </div>
          <span className={cn('w-full text-[11px] font-medium', i === steps.length - 1 ? 'text-right' : i === 0 ? 'text-left' : 'pr-6 text-center', i <= at && !declined ? 'text-[var(--ios-label)]' : 'text-[var(--ios-gray)]')}>{s}</span>
        </li>
      ))}
    </ol>
  )
}

function Banner({ tint, icon, children, actions, testId }: { tint: string; icon: ReactNode; children: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <section className="mt-2 overflow-hidden rounded-[14px] bg-white" data-testid={testId}>
      <div className="flex gap-3 px-4 pt-3 pb-2.5">
        <span className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-full text-white" style={{ background: tint }}>{icon}</span>
        <div className="min-w-0 flex-1 text-[15px] leading-[20px]">{children}</div>
      </div>
      {actions && <div className="flex flex-wrap gap-2 px-4 pb-3">{actions}</div>}
    </section>
  )
}

const actBtn = 'inline-flex h-[34px] items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold active:opacity-60 disabled:opacity-40'

type Prompt = 'decline' | 'date' | 'return' | 'submit' | 'keep-date' | null

/**
 * The collaboration part of an open task: what is happening and what I can do now (accept, new date, decline, send for
 * review, approve, send back, remind), the checklist, proof files and the history with comments.
 */
export function TaskCollabPanel({ task, onTask, onClosed }: { task: Task; onTask: (t: Task) => void; onClosed?: () => void }) {
  const toast = useToast()
  const chat = useChat()
  const collab = !!(chat.status?.enabled && chat.status.taskCollab)
  const [d, setD] = useState<TaskDetails | null>(null)
  const [prompt, setPrompt] = useState<Prompt>(null)
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [step, setStep] = useState('')
  const [uploading, setUploading] = useState<number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const t = task

  const loadDetails = useCallback(() => workApi.details(t.id).then(setD, () => {}), [t.id])
  const reloadTask = useCallback(() => workApi.task(t.id).then(onTask, () => {}), [t.id, onTask])
  useEffect(() => {
    void loadDetails()
    return chat.on<{ id: string }>('task.changed', (p) => {
      if (p.id !== t.id) return
      void loadDetails()
      void reloadTask()
    })
  }, [chat, t.id, loadDetails, reloadTask])

  const run = async (p: Promise<Task | void>, ok?: string) => {
    setBusy(true)
    try {
      const r = await p
      if (r) onTask(r)
      if (ok) toast.success(ok)
      void loadDetails()
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Please try again.'))
      throw e
    } finally {
      setBusy(false)
    }
  }
  const runDetails = async (p: Promise<TaskDetails>) => {
    try {
      setD(await p)
      void reloadTask()
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Please try again.'))
    }
  }

  const assigned = !!t.assignedBy
  const ownerFirst = (t.owner.name ?? 'They').split(' ')[0]
  const assignerFirst = (t.assignedBy?.name ?? 'They').split(' ')[0]
  const closed = t.status === 'COMPLETED' || t.status === 'CANCELLED'

  const upload = async (f: File) => {
    setUploading(0)
    try {
      setD(await workApi.uploadFile(t.id, f, setUploading))
      toast.success('File added. It can be opened once the antivirus check is done.')
      void reloadTask()
    } catch (e) {
      toast.error(errorMessage(e, 'The file could not be added.'))
    } finally {
      setUploading(null)
    }
  }

  return (
    <>
      {/* ---- What is happening, and what I can do */}
      {assigned && t.role === 'assignee' && t.assignState === 'PENDING' && !closed && (
        <Banner tint="var(--ios-blue)" icon={<UserPlus className="size-4" />} testId="banner-new"
          actions={collab && <>
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-blue)] text-white')} onClick={() => void run(workApi.accept(t.id), 'Accepted').catch(() => {})} data-testid="task-accept"><Check className="size-4" />Accept</button>
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-blue)]')} onClick={() => setPrompt('date')} data-testid="task-ask-date"><AlarmClock className="size-4" />New date</button>
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-red)]')} onClick={() => setPrompt('decline')} data-testid="task-decline"><XCircle className="size-4" />Decline</button>
          </>}>
          <p><b>{t.assignedBy!.name}</b> assigned this to you{t.requiresReview ? ' and will review it before it is closed' : ''}.</p>
        </Banner>
      )}
      {assigned && t.role === 'assignee' && t.assignState !== 'PENDING' && !closed && t.status !== 'IN_REVIEW' && (
        <Banner tint={t.requiresReview ? 'var(--ios-purple)' : 'var(--ios-green)'} icon={t.requiresReview ? <ShieldCheck className="size-4" /> : <CheckCircle2 className="size-4" />} testId="banner-working"
          actions={collab && <>
            {t.canSubmit && <button type="button" disabled={busy || t.checklist.requiredOpen > 0} className={cn(actBtn, 'bg-[var(--ios-purple)] text-white')} onClick={() => setPrompt('submit')} data-testid="task-submit"><Send className="size-4" />Send for review</button>}
            {!t.requestedDueUtc && <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-blue)]')} onClick={() => setPrompt('date')} data-testid="task-ask-date"><AlarmClock className="size-4" />New date</button>}
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-red)]')} onClick={() => setPrompt('decline')} data-testid="task-decline"><XCircle className="size-4" />Decline</button>
          </>}>
          <p>From <b>{t.assignedBy!.name}</b>. {t.requiresReview ? `${assignerFirst} reviews it before it is closed: send it for review when you are done.` : 'Tick it when you are done; they are told.'}</p>
          {t.checklist.requiredOpen > 0 && <p className="mt-1 text-[13px] text-[var(--ios-red)]">{t.checklist.requiredOpen} required {t.checklist.requiredOpen === 1 ? 'step' : 'steps'} left.</p>}
          {t.requestedDueUtc && <p className="mt-1 text-[13px] text-[var(--ios-orange)]">You asked for {whenText(t.requestedDueUtc, false)} — waiting for {assignerFirst}.</p>}
        </Banner>
      )}
      {assigned && t.status === 'IN_REVIEW' && (
        <Banner tint="var(--ios-purple)" icon={<ClipboardCheck className="size-4" />} testId="banner-review"
          actions={t.canReview && collab && <>
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-green)] text-white')} onClick={() => void run(workApi.review(t.id, true), 'Approved and closed').catch(() => {})} data-testid="task-approve"><Check className="size-4" />Approve &amp; close</button>
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-orange)]')} onClick={() => setPrompt('return')} data-testid="task-return"><RotateCcw className="size-4" />Send back</button>
          </>}>
          {t.role === 'assigner'
            ? <p><b>{t.owner.name}</b> finished and sent it for your review{t.submittedUtc ? ` · ${whenText(t.submittedUtc)}` : ''}.</p>
            : <p>Sent to <b>{t.assignedBy!.name}</b> for review. You will be told when it is approved or sent back.</p>}
        </Banner>
      )}
      {assigned && t.role === 'assigner' && !closed && t.status !== 'IN_REVIEW' && (
        <Banner tint="var(--ios-orange)" icon={<Hand className="size-4" />} testId="banner-assigner"
          actions={collab && <>
            {t.requestedDueUtc && <>
              <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-blue)] text-white')} onClick={() => void run(workApi.answerDate(t.id, true), 'New date approved').catch(() => {})} data-testid="date-approve"><Check className="size-4" />Approve {whenText(t.requestedDueUtc, false)}</button>
              <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-label)]')} onClick={() => setPrompt('keep-date')} data-testid="date-reject">Keep the date</button>
            </>}
            <button type="button" disabled={busy} className={cn(actBtn, 'bg-[var(--ios-gray6)] text-[var(--ios-blue)]')} onClick={() => void run(workApi.nudge(t.id), `Reminder sent to ${ownerFirst}`).catch(() => {})} data-testid="task-nudge"><BellRing className="size-4" />Remind {ownerFirst}</button>
          </>}>
          <p>Assigned to <b>{t.owner.name}</b> · {t.assignState === 'PENDING' ? 'not answered yet' : t.status === 'IN_PROGRESS' ? 'working on it' : t.status === 'POSTPONED' ? 'postponed' : 'accepted, not started'}.</p>
          {t.requestedDueUtc && <p className="mt-1 text-[14px]"><b>{ownerFirst}</b> asks for <b>{whenText(t.requestedDueUtc, false)}</b>{t.requestReason ? `: “${t.requestReason}”` : ''}</p>}
        </Banner>
      )}
      {assigned && closed && (
        <Banner tint={t.status === 'COMPLETED' ? 'var(--ios-green)' : 'var(--ios-gray)'} icon={t.status === 'COMPLETED' ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />} testId="banner-closed">
          <p>{t.status === 'COMPLETED' ? (t.reviewedUtc ? `Approved by ${t.assignedBy!.name}` : `Completed by ${t.owner.name}`) : t.assignState === 'DECLINED' ? `Declined by ${t.owner.name}` : 'Withdrawn'}{t.completedUtc ? ` · ${whenText(t.completedUtc)}` : ''}</p>
        </Banner>
      )}
      <ProgressSteps t={t} />

      {/* ---- Checklist */}
      {d && (d.checklist.length > 0 || !closed) && (
        <Group title={`Checklist${d.checklist.length ? ` · ${d.checklist.filter((i) => i.isDone).length}/${d.checklist.length}` : ''}`} footer={d.checklist.some((i) => i.isRequired) ? 'Required steps must be ticked before the task can be closed.' : undefined}>
          {d.checklist.map((it) => (
            <div key={it.id} className="flex min-h-[44px] items-center gap-3 px-4" data-testid="checklist-item">
              <button type="button" role="checkbox" aria-checked={it.isDone} aria-label={it.text} disabled={!it.canTick || closed}
                onClick={() => void runDetails(workApi.updateStep(t.id, it.id, { isDone: !it.isDone }))}
                className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-[6px] transition-colors disabled:opacity-60', it.isDone ? 'bg-[var(--ios-green)] text-white' : 'shadow-[inset_0_0_0_1.5px_var(--ios-gray3)]')} data-testid="checklist-tick">
                {it.isDone && <Check className="size-3.5" strokeWidth={3.4} />}
              </button>
              <span className={cn('min-w-0 flex-1 text-[16px]', it.isDone && 'text-[var(--ios-gray)] line-through')}>{it.text}</span>
              {it.isRequired && <span className="rounded-full bg-[var(--ios-red)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--ios-red)]">Required</span>}
              {it.canEdit && !closed && <button type="button" onClick={() => void runDetails(workApi.removeStep(t.id, it.id))} aria-label={`Remove ${it.text}`} className="text-[var(--ios-gray3)]"><X className="size-4" /></button>}
            </div>
          ))}
          {!closed && (
            <div className="flex items-center gap-2 px-4 py-1">
              <Plus className="size-[18px] text-[var(--ios-blue)]" />
              <input value={step} onChange={(e) => setStep(e.target.value)} maxLength={300} placeholder="Add a step" aria-label="Add a checklist step" className="ios-field !px-0" data-testid="checklist-new"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !step.trim()) return
                  e.preventDefault()
                  void runDetails(workApi.addStep(t.id, step.trim()))
                  setStep('')
                }} />
              {step.trim() && <button type="button" className="text-[15px] font-semibold text-[var(--ios-blue)]" onClick={() => (void runDetails(workApi.addStep(t.id, step.trim())), setStep(''))}>Add</button>}
              {step.trim() && d.canAddRequired && <button type="button" className="text-[13px] font-semibold text-[var(--ios-red)]" onClick={() => (void runDetails(workApi.addStep(t.id, step.trim(), true)), setStep(''))} data-testid="checklist-add-required">+ Required</button>}
            </div>
          )}
        </Group>
      )}

      {/* ---- Files (proof) */}
      {d && collab && (d.files.length > 0 || !closed) && (
        <Group title="Files">
          {d.files.map((f) => (
            <div key={f.id} className="flex min-h-[48px] items-center gap-3 px-4" data-testid="task-file">
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--ios-blue)]/10 text-[var(--ios-blue)]"><FileText className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]" title={f.name}>{f.name}</span>
                <span className="block text-[12px] text-[var(--ios-gray)]">{f.uploadedBy.name} · {Math.max(1, Math.round(f.sizeBytes / 1024))} KB{f.scanStatus === 'PENDING' ? ' · checking…' : f.scanStatus !== 'CLEAN' ? ' · blocked by antivirus' : ''}</span>
              </span>
              {f.scanStatus === 'CLEAN' && (
                <a href={workApi.fileUrl(f.id)} download={f.name} onClick={isIOS() ? iosDownload(f.id, f.name, toast, (x) => workApi.fileUrl(x)) : undefined} className="flex size-8 items-center justify-center rounded-full text-[var(--ios-blue)] active:bg-black/5" aria-label={`Download ${f.name}`} data-testid="task-file-download"><Download className="size-[18px]" /></a>
              )}
              {f.canDelete && !closed && <button type="button" onClick={() => workApi.removeFile(f.id).then(loadDetails, (e) => toast.error(errorMessage(e, 'The file could not be removed.')))} aria-label={`Remove ${f.name}`} className="text-[var(--ios-gray3)]"><Trash2 className="size-4" /></button>}
            </div>
          ))}
          {!closed && (
            <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading !== null} className="ios-pressable flex min-h-[44px] w-full items-center gap-2 px-4 text-[16px] text-[var(--ios-blue)] disabled:opacity-50" data-testid="task-file-add">
              <Paperclip className="size-[18px]" />{uploading !== null ? `Uploading… ${Math.round(uploading * 100)}%` : 'Attach a file'}
            </button>
          )}
          <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} data-testid="task-file-input" />
        </Group>
      )}

      {/* ---- History and comments */}
      {d && (assigned || d.activity.length > 0 || collab) && (
        <Group title="Activity">
          <div className="px-4 py-2">
            {d.activity.length === 0 && <p className="py-1 text-[14px] text-[var(--ios-gray)]">No comments yet.</p>}
            <ol className="space-y-2.5" data-testid="task-activity">
              {d.activity.map((a) => <ActivityLine key={a.id} a={a} />)}
            </ol>
            <div ref={endRef} />
          </div>
          {collab && (
            <div className="flex items-end gap-2 px-3 pt-1 pb-2.5 shadow-[inset_0_0.5px_0_var(--ios-sep)]">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={1} maxLength={2000} placeholder={assigned ? `Message ${t.role === 'assigner' ? ownerFirst : assignerFirst}…` : 'Add a comment'} aria-label="Comment"
                className="max-h-28 min-h-[36px] flex-1 resize-none rounded-[18px] bg-[var(--ios-gray6)] px-3.5 py-[7px] text-[16px] outline-none" data-testid="task-comment" />
              <button type="button" disabled={!comment.trim()} aria-label="Send comment" data-testid="task-comment-send"
                onClick={() => {
                  const body = comment.trim()
                  setComment('')
                  workApi.comment(t.id, body).then((x) => (setD(x), window.setTimeout(() => endRef.current?.scrollIntoView({ block: 'nearest' }), 50)), (e) => (setComment(body), toast.error(errorMessage(e, 'The comment could not be sent.'))))
                }}
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white disabled:bg-[var(--ios-gray4)]">
                <ArrowUpRight className="size-[18px] -rotate-45" strokeWidth={2.6} />
              </button>
            </div>
          )}
        </Group>
      )}
      {!collab && assigned && <p className="mt-2 flex items-center gap-1 px-4 text-[12px] text-[var(--ios-gray)]"><Lock className="size-3" /> Reviews and comments are switched off by your administrator.</p>}

      {prompt === 'decline' && <PromptSheet title="Decline task" label="Reason" placeholder={`Tell ${assignerFirst} why`} required doneLabel="Decline" danger testId="prompt-decline"
        onSubmit={async (r) => { await run(workApi.decline(t.id, r), 'Declined'); onClosed?.() }} onClose={() => setPrompt(null)} />}
      {prompt === 'date' && <PromptSheet title="Ask for a new date" label="Reason" placeholder="Why you need more time" required withDate initialDate={t.dueUtc} doneLabel="Send" testId="prompt-date"
        onSubmit={async (r, date) => run(workApi.requestDate(t.id, date!, r), `Asked ${assignerFirst} for ${whenText(date, false)}`)} onClose={() => setPrompt(null)} />}
      {prompt === 'submit' && <PromptSheet title="Send for review" label="Note (optional)" placeholder={`Anything ${assignerFirst} should know`} doneLabel="Send" testId="prompt-submit"
        onSubmit={async (n) => run(workApi.submit(t.id, n), `Sent to ${assignerFirst} for review`)} onClose={() => setPrompt(null)} />}
      {prompt === 'return' && <PromptSheet title="Send back" label="What needs to change" placeholder={`Tell ${ownerFirst} what to fix`} required doneLabel="Send back" testId="prompt-return"
        onSubmit={async (c) => run(workApi.review(t.id, false, c), `Sent back to ${ownerFirst}`)} onClose={() => setPrompt(null)} />}
      {prompt === 'keep-date' && <PromptSheet title="Keep the current date" label="Reason (optional)" placeholder="Why the date stays" doneLabel="Send" testId="prompt-keep-date"
        onSubmit={async (r) => run(workApi.answerDate(t.id, false, r), 'The date stays')} onClose={() => setPrompt(null)} />}
    </>
  )
}

const KIND_TEXT: Record<string, string> = {
  CREATED: 'created the task', ASSIGNED: 'assigned the task', ACCEPTED: 'accepted', DECLINED: 'declined', DATE_REQUESTED: 'asked for a new date',
  DATE_APPROVED: 'approved the new date', DATE_REJECTED: 'kept the original date', EDITED: 'changed the task', STARTED: 'started working',
  SUBMITTED: 'sent it for review', APPROVED: 'approved and closed it', RETURNED: 'sent it back', COMPLETED: 'completed it', REOPENED: 'reopened it',
  CANCELLED: 'withdrew the task', FILE: 'added a file', OVERDUE: 'The task became overdue', NUDGED: 'sent a reminder',
}

function ActivityLine({ a }: { a: Activity }) {
  if (a.kind === 'COMMENT')
    return (
      <li className={cn('flex gap-2', a.actor?.isMe && 'flex-row-reverse')} data-testid="activity-comment">
        <Avatar name={a.actor?.name ?? '?'} size={26} />
        <div className={cn('max-w-[80%] rounded-[16px] px-3 py-1.5', a.actor?.isMe ? 'bg-[var(--ios-blue)] text-white' : 'bg-[var(--ios-gray6)]')}>
          {!a.actor?.isMe && <p className="text-[12px] font-semibold text-[var(--ios-label2)]">{a.actor?.name}</p>}
          <p className="text-[15px] leading-[20px] break-words whitespace-pre-wrap">{a.body}</p>
          <p className={cn('mt-0.5 text-right text-[11px]', a.actor?.isMe ? 'text-white/75' : 'text-[var(--ios-gray)]')}>{whenText(a.createdUtc)}</p>
        </div>
      </li>
    )
  const icon = a.kind === 'APPROVED' || a.kind === 'COMPLETED' ? <CheckCircle2 className="size-3.5 text-[var(--ios-green)]" />
    : a.kind === 'RETURNED' || a.kind === 'DECLINED' ? <RotateCcw className="size-3.5 text-[var(--ios-orange)]" />
      : a.kind === 'OVERDUE' ? <AlarmClock className="size-3.5 text-[var(--ios-red)]" />
        : a.kind === 'SUBMITTED' ? <Send className="size-3.5 text-[var(--ios-purple)]" />
          : a.kind === 'FILE' ? <Paperclip className="size-3.5 text-[var(--ios-blue)]" />
            : <MessageCircle className="size-3.5 text-[var(--ios-gray)]" />
  return (
    <li className="flex items-start gap-2 text-[13px] text-[var(--ios-label2)]" data-testid="activity-event">
      <span className="mt-[3px]">{icon}</span>
      <span className="min-w-0 flex-1">
        {a.actor ? <b className="font-semibold text-[var(--ios-label)]">{a.actor.isMe ? 'You' : a.actor.name}</b> : null} {KIND_TEXT[a.kind] ?? a.kind.toLowerCase()}
        {a.dueUtc && (a.kind === 'DATE_REQUESTED' || a.kind === 'DATE_APPROVED' || a.kind === 'EDITED') ? ` · ${whenText(a.dueUtc, false)}` : ''}
        {a.body && a.kind !== 'FILE' ? <span className="block text-[14px] text-[var(--ios-label)]">“{a.body}”</span> : a.body ? <span className="block truncate text-[14px] text-[var(--ios-label)]">{a.body}</span> : null}
        <span className="block text-[11px] text-[var(--ios-gray)]">{whenText(a.createdUtc)}</span>
      </span>
    </li>
  )
}
