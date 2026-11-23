import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { AlarmClock, CalendarClock, Check, ClipboardCheck, Flag, ListTodo, MessageCircle, Share2, UserPlus, X } from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi } from '../../../api/work'
import { useToast } from '../../../components/ui/Toast'
import { useChat } from '../ChatProvider'
import { appNotify } from '../../room/androidBridge'
import { silenced } from '../quiet'
import { PRIORITY, whenText } from './ui'
import '../chat.css'

type TaskInfo = { title?: string; assignedBy?: string | null; dueUtc?: string | null; hasDueTime?: boolean; priority?: string | null }
type Alert = { key: string; type: string; title: string; body: string | null; link: string; taskId: string | null; task: TaskInfo | null }
type Payload = { type?: string; title?: string; body?: string | null; link?: string; taskId?: string; task?: TaskInfo }

/** One line with the task's details for the popup and phone/browser notifications (23 Nov 2026). */
function detailText(t: TaskInfo | null) {
  if (!t) return null
  const parts = [t.assignedBy && `From ${t.assignedBy}`, t.dueUtc && `Due ${whenText(t.dueUtc, !!t.hasDueTime)}`, t.priority && t.priority !== 'MEDIUM' && t.priority in PRIORITY && `${PRIORITY[t.priority as keyof typeof PRIORITY].label} priority`]
  const line = parts.filter(Boolean).join(' · ')
  return line || null
}

const META: Record<string, { label: string; tint: string; icon: typeof ListTodo }> = {
  TASK_ASSIGNED: { label: 'New task for you', tint: '#5856d6', icon: UserPlus },
  TASK_REVIEW: { label: 'Waiting for your review', tint: 'var(--ios-purple)', icon: ClipboardCheck },
  TASK_UPDATE: { label: 'Task update', tint: 'var(--ios-green)', icon: ListTodo },
  TASK_COMMENT: { label: 'Task comment', tint: 'var(--ios-blue)', icon: MessageCircle },
  TASK_DUE: { label: 'Task due', tint: 'var(--ios-red)', icon: AlarmClock },
  NOTE_SHARED: { label: 'Shared note', tint: 'var(--ios-orange)', icon: Share2 },
}

/** Short two-tone ping made in the browser (no audio file). */
function ping() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    ;[660, 990].forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'triangle'
      o.frequency.value = f
      const t = ctx.currentTime + i * 0.12
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + 0.4)
    })
    window.setTimeout(() => void ctx.close(), 1000)
  } catch {
    /* sound is optional */
  }
}

/**
 * Live task alerts on every portal page (V033): a banner with the right quick action (Accept a new task, Approve one
 * waiting for review, Open), and a browser notification while the portal is in a background tab (only if the person
 * turned browser notifications on). The bell keeps every alert anyway.
 */
export default function TaskAlerts() {
  const chat = useChat()
  const toast = useToast()
  const navigate = useNavigate()
  const [queue, setQueue] = useState<Alert[]>([])
  const [busy, setBusy] = useState(false)
  const prefs = useRef(chat.preferences)
  prefs.current = chat.preferences

  const push = useCallback((p: Payload) => {
    const type = p.type ?? ''
    if (!META[type] || !p.title) return
    const link = p.link && p.link.startsWith('/') && !p.link.startsWith('//') ? p.link : '/tasks'
    const a: Alert = { key: `${type}-${p.taskId ?? ''}-${Date.now()}`, type, title: p.title, body: p.body ?? null, link, taskId: p.taskId ?? null, task: p.task ?? null }
    setQueue((q) => [...q.filter((x) => !(x.taskId && x.taskId === a.taskId && x.type === a.type)), a].slice(-5))
    const quiet = silenced(prefs.current, 'reminder')
    const detail = detailText(a.task)
    const note = [p.body, detail].filter(Boolean).join('\n') || META[type].label
    if (prefs.current?.soundsOn !== false && prefs.current?.availability !== 'DND' && !quiet) ping()
    try {
      // Android app (1.2.0+): a phone notification while the app is in the background.
      if (!quiet && document.visibilityState === 'hidden' && appNotify(p.title, note, link, `task-${p.taskId ?? type}`)) return
      if (!quiet && document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(p.title, { body: note, tag: `oic-task-${p.taskId ?? type}` })
        n.onclick = () => {
          window.focus()
          navigate(link)
          n.close()
        }
      }
    } catch {
      /* notifications are optional */
    }
  }, [navigate])

  useEffect(() => chat.on<Payload>('notification.new', push), [chat, push])

  const a = queue[0]
  // Each banner stays 12 s (longer while an action is running), then the next one shows.
  useEffect(() => {
    if (!a || busy) return
    const h = window.setTimeout(() => setQueue((q) => q.slice(1)), 12_000)
    return () => window.clearTimeout(h)
  }, [a, busy])

  if (!a) return null
  const m = META[a.type]
  const Icon = m.icon
  const close = () => setQueue((q) => q.slice(1))
  const act = async (p: Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await p
      toast.success(ok)
      close()
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Open the task to try again.'))
    } finally {
      setBusy(false)
    }
  }
  const btn = 'flex h-10 flex-1 items-center justify-center gap-1 rounded-[12px] bg-black/[0.05] text-[15px] font-semibold text-[var(--ios-blue)] active:bg-black/10 disabled:opacity-40'

  return (
    <div className="flex w-full justify-center sm:justify-end" aria-live="polite">
      <AnimatePresence mode="wait">
        <motion.div
          key={a.key}
          initial={{ opacity: 0, y: -20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16 }}
          className="pointer-events-auto w-full max-w-[400px] rounded-[22px] bg-[rgb(245_245_247/0.94)] p-3.5 shadow-[0_16px_48px_rgb(0_0_0/0.22)] ring-[0.5px] ring-black/10 backdrop-blur-xl sm:w-[380px]"
          role="status"
          data-testid="task-alert"
        >
          <div className="flex items-center gap-2">
            <span className="flex size-[22px] items-center justify-center rounded-[6px] text-white" style={{ background: m.tint }}><Icon className="size-3.5" /></span>
            <span className="flex-1 text-[13px] font-medium tracking-wide text-[var(--ios-label2)] uppercase">{m.label}</span>
            <span className="text-[13px] text-[var(--ios-label2)]">now{queue.length > 1 ? ` · +${queue.length - 1}` : ''}</span>
            <button type="button" onClick={close} aria-label="Dismiss" className="ml-1 flex size-6 items-center justify-center rounded-full bg-black/[0.07] text-[var(--ios-label2)]" data-testid="task-alert-dismiss">
              <X className="size-3.5" strokeWidth={2.6} />
            </button>
          </div>
          <p className="mt-2 text-[16px] leading-[21px] font-semibold break-words" data-testid="task-alert-title">{a.title}</p>
          {a.task && (a.task.assignedBy || a.task.dueUtc || (a.task.priority && a.task.priority !== 'MEDIUM')) && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-[var(--ios-label2)]" data-testid="task-alert-details">
              {a.task.assignedBy && <span className="inline-flex items-center gap-1"><UserPlus className="size-3.5" />From <b className="font-semibold text-[var(--ios-label)]">{a.task.assignedBy}</b></span>}
              {a.task.dueUtc && <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />Due <b className="font-semibold text-[var(--ios-label)]">{whenText(a.task.dueUtc, !!a.task.hasDueTime)}</b></span>}
              {a.task.priority && a.task.priority !== 'MEDIUM' && a.task.priority in PRIORITY && (
                <span className="inline-flex items-center gap-1 font-semibold" style={{ color: PRIORITY[a.task.priority as keyof typeof PRIORITY].color }}><Flag className="size-3.5" />{PRIORITY[a.task.priority as keyof typeof PRIORITY].label}</span>
              )}
            </div>
          )}
          {a.body && <p className="mt-1 line-clamp-2 text-[14px] text-[var(--ios-label2)]">{a.body}</p>}
          <div className="mt-3 flex gap-2">
            {a.type === 'TASK_ASSIGNED' && a.taskId && (
              <button type="button" className={btn} disabled={busy} onClick={() => void act(workApi.accept(a.taskId!), 'Accepted')} data-testid="task-alert-accept"><Check className="size-4" />Accept</button>
            )}
            {a.type === 'TASK_REVIEW' && a.taskId && (
              <button type="button" className={btn} disabled={busy} onClick={() => void act(workApi.review(a.taskId!, true), 'Approved and closed')} data-testid="task-alert-approve"><Check className="size-4" />Approve</button>
            )}
            <button type="button" className={btn} disabled={busy} onClick={() => (close(), navigate(a.link))} data-testid="task-alert-open">{a.type === 'NOTE_SHARED' ? 'Open note' : a.type === 'TASK_REVIEW' ? 'Review' : 'Open task'}</button>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
