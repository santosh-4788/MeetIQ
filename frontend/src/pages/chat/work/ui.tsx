import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { Priority, TaskStatus } from '../../../api/work'
import { cn } from '../../../lib/cn'
import { parseUtc } from '../../../lib/format'
import '../chat.css'

// Shared iOS-style pieces for notes, tasks, reminders and My Day.

export const PRIORITY: Record<Priority, { label: string; color: string; marks: string }> = {
  LOW: { label: 'Low', color: 'var(--ios-gray)', marks: '' },
  MEDIUM: { label: 'Medium', color: 'var(--ios-blue)', marks: '!' },
  HIGH: { label: 'High', color: 'var(--ios-orange)', marks: '!!' },
  URGENT: { label: 'Urgent', color: 'var(--ios-red)', marks: '!!!' },
}

export const STATUS: Record<TaskStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "Today, 4:30 pm" / "Tomorrow" / "Mon, 23 Nov, 9:00 am" in the browser's time zone. */
export function whenText(iso: string | null, withTime = true) {
  if (!iso) return ''
  const d = parseUtc(iso)
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const day = sameDay(d, now) ? 'Today' : sameDay(d, tomorrow) ? 'Tomorrow' : sameDay(d, yesterday) ? 'Yesterday'
    : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(d)
  return withTime ? `${day}, ${new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(d)}` : day
}

export const timeText = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(parseUtc(iso))

/** <input type="datetime-local"> value (local time) from a UTC ISO string, and back. */
export function toLocalInput(iso: string | null) {
  if (!iso) return ''
  const d = parseUtc(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)
export function toDateInput(iso: string | null) {
  return toLocalInput(iso).slice(0, 10)
}

/** Tomorrow at 9:00 in the browser's time zone. */
export function tomorrowAt9() {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0, 0).toISOString()
}

/** iOS modal sheet: a bottom sheet on phones, a centred card on computers. Header: Cancel · Title · Done. */
export function Sheet({
  title, onClose, onDone, doneLabel = 'Done', doneDisabled, busy, children, testId, leftLabel = 'Cancel',
}: {
  title: string
  onClose: () => void
  onDone?: () => void
  doneLabel?: string
  doneDisabled?: boolean
  busy?: boolean
  children: ReactNode
  testId?: string
  leftLabel?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, busy])
  return createPortal(
    <div className="ios fixed inset-0 z-[58] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
      <button type="button" className="ios-sheet-backdrop absolute inset-0 cursor-default" aria-label="Dismiss" tabIndex={-1} onClick={() => !busy && onClose()} />
      <div className="ios-sheet-up relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[14px] bg-[var(--ios-gray6)] shadow-[0_-10px_40px_rgb(0_0_0/0.2)] sm:max-w-[540px] sm:rounded-[16px]">
        <div className="mx-auto mt-1.5 h-[5px] w-9 rounded-full bg-[var(--ios-gray4)] sm:hidden" aria-hidden />
        <div className="grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4">
          <button type="button" onClick={onClose} disabled={busy} className="justify-self-start text-[17px] text-[var(--ios-blue)] active:opacity-50 disabled:opacity-40">{leftLabel}</button>
          <p className="max-w-[60vw] truncate text-[17px] font-semibold">{title}</p>
          {onDone ? (
            <button type="button" onClick={onDone} disabled={doneDisabled || busy} className="justify-self-end text-[17px] font-semibold text-[var(--ios-blue)] active:opacity-50 disabled:text-[var(--ios-gray2)]" data-testid="sheet-done">
              {busy ? 'Saving…' : doneLabel}
            </button>
          ) : <span />}
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-[max(1.25rem,var(--sab))]">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/** One row of an iOS inset-grouped list. */
export function Row({ label, value, onClick, children, icon, tint, testId, danger }: { label: ReactNode; value?: ReactNode; onClick?: () => void; children?: ReactNode; icon?: ReactNode; tint?: string; testId?: string; danger?: boolean }) {
  const content = (
    <>
      {icon && <span className="flex size-[29px] shrink-0 items-center justify-center rounded-[7px] text-white" style={{ background: tint ?? 'var(--ios-blue)' }}>{icon}</span>}
      <span className={cn('min-w-[4.5rem] flex-1 truncate text-left text-[17px] md:text-[16px]', danger && 'text-[var(--ios-red)]')}>{label}</span>
      {value !== undefined && <span className="max-w-[55%] truncate text-right text-[17px] text-[var(--ios-gray)] md:text-[16px]">{value}</span>}
      {children}
      {onClick && <ChevronRight className="-mr-1 size-[18px] shrink-0 text-[var(--ios-gray4)]" aria-hidden />}
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="ios-pressable flex min-h-[46px] w-full items-center gap-3 px-4 py-2" data-testid={testId}>{content}</button>
  ) : (
    <div className="flex min-h-[46px] w-full items-center gap-3 px-4 py-1.5" data-testid={testId}>{content}</div>
  )
}

export function Group({ title, footer, children, className }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-5', className)}>
      {title && <p className="ios-group-title">{title}</p>}
      <div className="ios-group">{children}</div>
      {footer && <p className="px-4 pt-1.5 text-[13px] text-[var(--ios-label2)]">{footer}</p>}
    </section>
  )
}

/** iOS round completion check (tasks). */
export function CheckCircle({ on, color, onClick, label }: { on: boolean; color?: string; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={cn('flex size-[26px] shrink-0 items-center justify-center rounded-full transition-colors active:scale-90', on && 'ios-check-pop')}
      style={on ? { background: color ?? 'var(--ios-blue)' } : { boxShadow: `inset 0 0 0 1.5px ${color && color !== 'var(--ios-gray)' ? color : 'var(--ios-gray4)'}` }}
      data-testid="task-check"
    >
      {on && <svg viewBox="0 0 24 24" className="size-[15px] text-white" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}
    </button>
  )
}

/** Small coloured pill (category, priority, link). */
export function Pill({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: `color-mix(in srgb, ${color ?? 'var(--ios-gray)'} 14%, transparent)`, color: color ?? 'var(--ios-gray)' }}>
      {children}
    </span>
  )
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-white text-[var(--ios-gray)] shadow-xs">{icon}</span>
      <p className="mt-3 text-[17px] font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-xs text-[15px] text-[var(--ios-label2)]">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
