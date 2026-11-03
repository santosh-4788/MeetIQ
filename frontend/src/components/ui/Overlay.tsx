import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { Alert } from './Feedback'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const ease = [0.22, 1, 0.36, 1] as [number, number, number, number]

/** Initial focus, Tab focus trap, Escape to close, focus restore and body scroll lock for modal surfaces. */
function useDialogBehaviour(open: boolean, panel: React.RefObject<HTMLDivElement | null>, onClose: () => void, dismissible: boolean) {
  const close = useRef(onClose)
  close.current = onClose
  const canDismiss = useRef(dismissible)
  canDismiss.current = dismissible

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const t = window.setTimeout(() => {
      const el = panel.current
      if (!el) return
      const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el
      target.focus()
    }, 30)
    const onKey = (e: KeyboardEvent) => {
      const el = panel.current
      if (!el) return
      // Only the top-most dialog reacts (a confirmation can open over a drawer).
      const dialogs = document.querySelectorAll('[data-oic-dialog]')
      if (dialogs[dialogs.length - 1] !== el) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (canDismiss.current) close.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null)
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [open, panel])
}

type DialogProps = {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Width of a centred modal; drawers are always max 560 px. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  variant?: 'modal' | 'drawer'
  /** False while a request is running, or while a one-time secret must be acknowledged. */
  dismissible?: boolean
}

const widths = { sm: 'sm:max-w-[420px]', md: 'sm:max-w-[520px]', lg: 'sm:max-w-[680px]', xl: 'sm:max-w-[960px]' }

/** Accessible modal dialog / side drawer (role="dialog", aria-modal, labelled by its title). */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', variant = 'modal', dismissible = true }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useDialogBehaviour(open, panel, onClose, dismissible)
  const drawer = variant === 'drawer'

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={cn('fixed inset-0 z-[60] flex', drawer ? 'justify-end' : 'items-end justify-center p-0 sm:items-center sm:p-6')}>
          <motion.div
            className="absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => dismissible && onClose()}
            aria-hidden
          />
          <motion.div
            ref={panel}
            data-oic-dialog
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={cn(
              'relative flex w-full flex-col bg-surface shadow-overlay outline-none',
              drawer ? 'h-dvh max-w-[560px]' : cn('max-h-[92dvh] rounded-t-xl sm:rounded-xl', widths[size]),
            )}
            initial={drawer ? { x: '100%' } : { opacity: 0, y: 16, scale: 0.98 }}
            animate={drawer ? { x: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={drawer ? { x: '100%' } : { opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: drawer ? 0.26 : 0.22, ease }}
          >
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <h2 id={titleId} className="text-[17px] leading-[26px] font-semibold text-ink">
                  {title}
                </h2>
                {description && (
                  <div id={descId} className="mt-0.5 text-[13px] text-ink-secondary">
                    {description}
                  </div>
                )}
              </div>
              {dismissible && (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  title="Close"
                  className="-mr-2 flex size-10 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-navy-900/5 hover:text-ink"
                >
                  <X className="size-5" />
                </button>
              )}
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
            {footer && <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3.5 sm:flex-row sm:justify-end sm:px-6">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * Confirmation for destructive or security-relevant actions. `onConfirm` may throw: its message
 * is shown in the dialog (e.g. the API's 409 explanation) and the dialog stays open.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  tone = 'danger',
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'primary'
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) setError(null)
  }, [open])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The action could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {tone === 'danger' && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
            <TriangleAlert className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1 text-[13.5px] leading-[22px] text-ink-secondary">{children}</div>
      </div>
      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}
    </Dialog>
  )
}
