import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { CalendarDays, ChevronLeft, ChevronRight, CircleAlert, Clock } from 'lucide-react'
import { cn } from '../../lib/cn'
import { addDays, formatYmd, weekday } from '../../lib/format'

// Replaces the plain browser <input type="date"/time"> used across Schedule Meeting, recording-library filters, etc.
// with a styled popover that matches the rest of the design system, while keeping the same "YYYY-MM-DD" / "HH:mm"
// string values those call sites already pass around (no change needed to the surrounding form logic or validation).

const ease = [0.22, 1, 0.36, 1] as [number, number, number, number]

function todayYmd() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthStart(ym: string) {
  return `${ym}-01`
}

function addMonths(ym: string, n: number) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

type Pos = { top?: number; bottom?: number; left: number; width: number }

function usePopoverPosition(open: boolean, trigger: RefObject<HTMLButtonElement | null>, width: number) {
  const [pos, setPos] = useState<Pos | null>(null)
  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const update = () => {
      const r = trigger.current?.getBoundingClientRect()
      if (!r) return
      const w = Math.max(r.width, width)
      const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
      const spaceBelow = window.innerHeight - r.bottom
      const below = spaceBelow > 340 || spaceBelow > r.top
      setPos(below ? { top: r.bottom + 6, left, width: w } : { bottom: window.innerHeight - r.top + 6, left, width: w })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, trigger, width])
  return pos
}

function useOutsideClose(open: boolean, refs: RefObject<HTMLElement | null>[], onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, refs, onClose])
}

function FieldShell({
  label,
  error,
  open,
  icon,
  display,
  placeholder,
  triggerRef,
  onToggle,
  describedBy,
  inputId,
}: {
  label: string
  error?: string
  open: boolean
  icon: React.ReactNode
  display: string | null
  placeholder: string
  triggerRef: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  describedBy?: string
  inputId: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <button
        ref={triggerRef}
        id={inputId}
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={!!error || undefined}
        aria-describedby={describedBy}
        className={cn(
          'flex h-11 items-center gap-2 rounded-sm border bg-surface px-3 text-left text-sm transition-[border-color,box-shadow] duration-150',
          error ? 'border-danger/70' : open ? 'border-brand-500 shadow-focus' : 'border-line hover:border-line-strong',
        )}
      >
        <span className={cn('shrink-0', error ? 'text-danger' : 'text-ink-muted')}>{icon}</span>
        <span className={cn('min-w-0 flex-1 truncate', display ? 'text-ink' : 'text-ink-muted')}>{display ?? placeholder}</span>
      </button>
      {error && (
        <p id={describedBy} role="alert" className="flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  )
}

function Popover({ open, pos, panelRef, children }: { open: boolean; pos: Pos | null; panelRef: RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  return createPortal(
    <AnimatePresence>
      {open && pos && (
        <motion.div
          ref={panelRef}
          role="dialog"
          className="fixed z-[70] overflow-hidden rounded-lg border border-line bg-surface shadow-overlay"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.14, ease }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

// ---- DateField -------------------------------------------------------------------------------------------------

export function DateField({
  label,
  value,
  onChange,
  error,
  min,
  max,
}: {
  label: string
  /** "YYYY-MM-DD", or "" for not set. */
  value: string
  onChange: (value: string) => void
  error?: string
  min?: string
  max?: string
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => (value || todayYmd()).slice(0, 7))
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pos = usePopoverPosition(open, trigger, 300)
  useOutsideClose(open, [trigger, panel], () => setOpen(false))
  const id = useId()
  const errorId = error ? `${id}-error` : undefined

  useEffect(() => {
    if (open) setMonth((value || todayYmd()).slice(0, 7))
  }, [open, value])

  const first = monthStart(month)
  const leadingBlanks = weekday(first)
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  const cells: (string | null)[] = [...Array(leadingBlanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => addDays(first, i))]
  const today = todayYmd()

  return (
    <div className="flex flex-col gap-1.5">
      <FieldShell
        label={label}
        error={error}
        open={open}
        icon={<CalendarDays className="size-[18px]" aria-hidden />}
        display={value ? formatYmd(value, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : null}
        placeholder="Select a date"
        triggerRef={trigger}
        onToggle={() => setOpen((o) => !o)}
        describedBy={errorId}
        inputId={id}
      />
      <Popover open={open} pos={pos} panelRef={panel}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <button type="button" onClick={() => setMonth((m) => addMonths(m, -1))} aria-label="Previous month" className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-navy-900/5 hover:text-ink">
            <ChevronLeft className="size-4" />
          </button>
          <p className="text-[13px] font-semibold text-ink">{formatYmd(first, { month: 'long', year: 'numeric' })}</p>
          <button type="button" onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month" className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-navy-900/5 hover:text-ink">
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 px-2.5 pt-2.5 pb-1 text-center text-[11px] font-semibold text-ink-muted">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 px-2.5 pb-3">
          {cells.map((ymd, i) => {
            if (!ymd) return <span key={i} />
            const disabled = (!!min && ymd < min) || (!!max && ymd > max)
            const selected = ymd === value
            const isToday = ymd === today
            return (
              <button
                key={ymd}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onChange(ymd)
                  setOpen(false)
                }}
                className={cn(
                  'm-auto flex size-8 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors',
                  disabled
                    ? 'cursor-not-allowed text-ink-muted/50'
                    : selected
                      ? 'bg-brand-500 font-semibold text-white'
                      : isToday
                        ? 'font-semibold text-brand-700 ring-1 ring-inset ring-brand-300 hover:bg-brand-50'
                        : 'text-ink hover:bg-navy-900/5',
                )}
              >
                {Number(ymd.slice(8))}
              </button>
            )
          })}
        </div>
      </Popover>
    </div>
  )
}

// ---- TimeField -------------------------------------------------------------------------------------------------

export function TimeField({
  label,
  value,
  onChange,
  error,
  stepMinutes = 30,
}: {
  label: string
  /** "HH:mm" (24-hour), or "" for not set. */
  value: string
  onChange: (value: string) => void
  error?: string
  stepMinutes?: number
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const pos = usePopoverPosition(open, trigger, 160)
  useOutsideClose(open, [trigger, panel], () => setOpen(false))
  const id = useId()
  const errorId = error ? `${id}-error` : undefined

  const options = Array.from({ length: (24 * 60) / stepMinutes }, (_, i) => {
    const total = i * stepMinutes
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  })

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      list.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])

  const display = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    const period = h < 12 ? 'am' : 'pm'
    const h12 = h % 12 === 0 ? 12 : h % 12
    return `${h12}:${String(m).padStart(2, '0')} ${period}`
  }

  return (
    <div className="flex flex-col gap-1.5">
      <FieldShell
        label={label}
        error={error}
        open={open}
        icon={<Clock className="size-[18px]" aria-hidden />}
        display={value ? display(value) : null}
        placeholder="Select a time"
        triggerRef={trigger}
        onToggle={() => setOpen((o) => !o)}
        describedBy={errorId}
        inputId={id}
      />
      <Popover open={open} pos={pos} panelRef={panel}>
        <div ref={list} className="scrollbar-thin max-h-64 overflow-y-auto py-1.5" role="listbox" aria-label={label}>
          {options.map((o) => {
            const selected = o === value
            return (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                onClick={() => {
                  onChange(o)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center px-3.5 py-2 text-left text-[13px] tabular-nums transition-colors',
                  selected ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink hover:bg-navy-900/5',
                )}
              >
                {display(o)}
              </button>
            )
          })}
        </div>
      </Popover>
    </div>
  )
}
