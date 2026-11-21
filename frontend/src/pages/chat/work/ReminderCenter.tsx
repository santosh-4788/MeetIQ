import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Bell, ChevronLeft, X } from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi, type Reminder } from '../../../api/work'
import { useToast } from '../../../components/ui/Toast'
import { parseUtc } from '../../../lib/format'
import { useChat } from '../ChatProvider'
import { appNotify } from '../../room/androidBridge'
import { silenced } from '../quiet'
import { PRIORITY, fromLocalInput, toLocalInput, tomorrowAt9, whenText } from './ui'
import '../chat.css'

const SNOOZE: { label: string; minutes?: number; tomorrow?: boolean; testId: string }[] = [
  { label: 'In 5 minutes', minutes: 5, testId: 'snooze-5' },
  { label: 'In 15 minutes', minutes: 15, testId: 'snooze-15' },
  { label: 'In 30 minutes', minutes: 30, testId: 'snooze-30' },
  { label: 'In 1 hour', minutes: 60, testId: 'snooze-60' },
  { label: 'Tomorrow at 9:00', tomorrow: true, testId: 'snooze-tomorrow' },
]

function ago(iso: string | null) {
  if (!iso) return 'now'
  const m = Math.round((Date.now() - parseUtc(iso).getTime()) / 60_000)
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : whenText(iso)
}

/** Soft two-note chime made in the browser (no audio file). */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    ;[880, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const t = ctx.currentTime + i * 0.16
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + 0.55)
    })
    window.setTimeout(() => void ctx.close(), 1200)
  } catch {
    /* sound is optional */
  }
}

/**
 * Reminder popups on every portal page (Phase 4). The server decides when a reminder is due (it fires each one exactly
 * once); this shows it: live through Chat's connection, and on load / reconnect / every minute for anything still
 * unanswered (e.g. it fired while the person was away). Complete, Snooze (5/15/30 min, 1 h, tomorrow, custom), Open.
 */
export default function ReminderCenter() {
  const chat = useChat()
  const toast = useToast()
  const navigate = useNavigate()
  const [queue, setQueue] = useState<Reminder[]>([])
  const [snoozing, setSnoozing] = useState(false)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const seen = useRef(new Set<string>())
  const prefs = useRef(chat.preferences)
  prefs.current = chat.preferences

  const announce = useCallback((r: Reminder) => {
    if (seen.current.has(r.id + r.dueUtc)) return
    seen.current.add(r.id + r.dueUtc)
    const quiet = silenced(prefs.current, r.priority === 'URGENT' ? 'urgent-reminder' : 'reminder')
    if (prefs.current?.soundsOn !== false && prefs.current?.availability !== 'DND' && !quiet) chime()
    try {
      if (!quiet && document.visibilityState === 'hidden'
        && appNotify(`Reminder: ${r.title}`, r.details ?? whenText(r.dueUtc), r.kind === 'TASK' ? `/tasks?task=${r.itemId}` : `/notes?note=${r.itemId}`, `oic-reminder-${r.id}`)) return
      if (!quiet && document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted')
        new Notification(`Reminder: ${r.title}`, { body: r.details ?? whenText(r.dueUtc), tag: `oic-reminder-${r.id}` })
    } catch {
      /* notifications are optional */
    }
  }, [])

  const sync = useCallback(() => {
    workApi.dueReminders().then(
      (list) => {
        setQueue(list)
        list.forEach(announce)
      },
      () => {},
    )
  }, [announce])

  useEffect(() => {
    sync()
    const offs = [
      chat.on<Reminder>('reminder.due', (r) => {
        setQueue((q) => (q.some((x) => x.id === r.id) ? q.map((x) => (x.id === r.id ? r : x)) : [...q, r]))
        announce(r)
      }),
      // Answered in another tab (snoozed, done or dismissed): close it here too.
      chat.on<Reminder>('reminder.updated', (r) => {
        if (r.state !== 'FIRED' || r.firedUtc === null) setQueue((q) => q.filter((x) => x.id !== r.id))
      }),
      chat.on('reconnected', sync),
    ]
    const t = window.setInterval(sync, 60_000)
    const onVis = () => document.visibilityState === 'visible' && sync()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      offs.forEach((o) => o())
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [chat, sync, announce])

  const r = queue[0]
  useEffect(() => {
    setSnoozing(false)
    setCustom('')
  }, [r?.id])

  if (!r) return null

  const finish = async (p: Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await p
      setQueue((q) => q.filter((x) => x.id !== r.id))
      if (ok) toast.success(ok)
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Please try again.'))
      sync()
    } finally {
      setBusy(false)
    }
  }
  const snooze = (b: { minutes?: number; untilUtc?: string }, label: string) => void finish(workApi.snooze(r.id, b), `Reminder ${label}`)
  const open = () => {
    void finish(workApi.dismiss(r.id))
    navigate(`/chat?tab=${r.kind === 'TASK' ? 'tasks' : 'notes'}&${r.kind === 'TASK' ? 'task' : 'note'}=${r.itemId}`)
  }
  const p = r.priority ? PRIORITY[r.priority] : null
  const btn = 'flex h-11 flex-1 items-center justify-center rounded-[12px] bg-black/[0.05] text-[15px] font-semibold text-[var(--ios-blue)] active:bg-black/10 disabled:opacity-40'

  return (
    <div className="ios pointer-events-none fixed inset-x-2 top-[max(0.5rem,env(safe-area-inset-top))] z-[68] flex justify-center sm:inset-x-auto sm:right-3 sm:justify-end" aria-live="assertive">
      <AnimatePresence mode="wait">
        <motion.div
          key={r.id + r.dueUtc}
          initial={{ opacity: 0, y: -20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16 }}
          className="pointer-events-auto w-full max-w-[400px] rounded-[22px] bg-[rgb(245_245_247/0.92)] p-3.5 shadow-[0_16px_48px_rgb(0_0_0/0.22)] ring-[0.5px] ring-black/10 backdrop-blur-xl sm:w-[380px]"
          role="alertdialog"
          aria-label={`Reminder: ${r.title}`}
          data-testid="reminder-popup"
        >
          <div className="flex items-center gap-2">
            <span className="flex size-[22px] items-center justify-center rounded-[6px] bg-[var(--ios-orange)] text-white"><Bell className="size-3.5" /></span>
            <span className="flex-1 text-[13px] font-medium tracking-wide text-[var(--ios-label2)] uppercase">{r.kind === 'TASK' ? 'Task reminder' : 'Note reminder'}</span>
            <span className="text-[13px] text-[var(--ios-label2)]">{ago(r.firedUtc)}{queue.length > 1 ? ` · +${queue.length - 1}` : ''}</span>
            <button type="button" onClick={() => void finish(workApi.dismiss(r.id))} disabled={busy} aria-label="Dismiss reminder" className="ml-1 flex size-6 items-center justify-center rounded-full bg-black/[0.07] text-[var(--ios-label2)]" data-testid="reminder-dismiss">
              <X className="size-3.5" strokeWidth={2.6} />
            </button>
          </div>
          <p className="mt-2 text-[17px] leading-[22px] font-semibold break-words" data-testid="reminder-title">
            {p?.marks && <span className="mr-1" style={{ color: p.color }}>{p.marks}</span>}
            {r.title}
          </p>
          {r.details && <p className="mt-0.5 line-clamp-2 text-[15px] text-[var(--ios-label2)]">{r.details}</p>}
          <p className="mt-1 text-[13px] text-[var(--ios-gray)]">
            {r.taskDueUtc ? `Due ${whenText(r.taskDueUtc)}` : `Reminder for ${whenText(r.dueUtc)}`}
            {r.snoozeCount > 0 ? ` · snoozed ${r.snoozeCount}×` : ''}
          </p>

          {!snoozing ? (
            <div className="mt-3 flex gap-2">
              <button type="button" className={btn} disabled={busy} onClick={() => void finish(workApi.done(r.id), r.kind === 'TASK' ? 'Task completed' : 'Note marked as done')} data-testid="reminder-complete">Complete</button>
              <button type="button" className={btn} disabled={busy} onClick={() => setSnoozing(true)} data-testid="reminder-snooze">Postpone</button>
              <button type="button" className={btn} disabled={busy} onClick={open} data-testid="reminder-open">{r.kind === 'TASK' ? 'Open task' : 'Open note'}</button>
            </div>
          ) : (
            <div className="mt-3 overflow-hidden rounded-[12px] bg-white" data-testid="reminder-snooze-menu">
              <button type="button" onClick={() => setSnoozing(false)} className="flex w-full items-center gap-1 px-3 py-2.5 text-[15px] text-[var(--ios-blue)]">
                <ChevronLeft className="size-4" /> Remind me…
              </button>
              {SNOOZE.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  disabled={busy}
                  onClick={() => snooze(s.tomorrow ? { untilUtc: tomorrowAt9() } : { minutes: s.minutes }, s.tomorrow ? 'tomorrow at 9:00' : s.label.toLowerCase())}
                  className="ios-menu-item"
                  data-testid={s.testId}
                >
                  {s.label}
                </button>
              ))}
              <div className="flex items-center gap-2 px-3 py-2 shadow-[inset_0_0.5px_0_var(--ios-sep)]">
                <input type="datetime-local" value={custom} min={toLocalInput(new Date().toISOString())} onChange={(e) => setCustom(e.target.value)} className="min-w-0 flex-1 bg-transparent text-[15px] outline-none" aria-label="Custom date and time" data-testid="snooze-custom-input" />
                <button
                  type="button"
                  disabled={busy || !custom || new Date(custom).getTime() <= Date.now()}
                  onClick={() => snooze({ untilUtc: fromLocalInput(custom)! }, whenText(fromLocalInput(custom)))}
                  className="text-[15px] font-semibold text-[var(--ios-blue)] disabled:text-[var(--ios-gray2)]"
                  data-testid="snooze-custom"
                >
                  Set
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
