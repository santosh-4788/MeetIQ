import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { cn } from '../../lib/cn'

type Toast = { id: number; tone: 'success' | 'danger'; text: string }
type ToastApi = { success: (text: string) => void; error: (text: string) => void }

const ToastContext = createContext<ToastApi | null>(null)

/** Short confirmations after a save ("Employee updated"). Announced politely via role="status". */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((xs) => xs.filter((x) => x.id !== id)), [])
  const push = useCallback(
    (tone: Toast['tone'], text: string) => {
      const id = ++seq.current
      setToasts((xs) => [...xs.slice(-2), { id, tone, text }])
      window.setTimeout(() => dismiss(id), tone === 'danger' ? 7000 : 4000)
    },
    [dismiss],
  )
  const api = useMemo<ToastApi>(() => ({ success: (t) => push('success', t), error: (t) => push('danger', t) }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[70] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:items-end md:bottom-6">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-overlay"
            >
              {t.tone === 'success' ? <CircleCheck className="mt-0.5 size-[18px] shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-[18px] shrink-0 text-danger" />}
              <p className={cn('min-w-0 flex-1 text-[13px] leading-5 font-medium text-ink')}>{t.text}</p>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-mr-1 flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-navy-900/5 hover:text-ink">
                <X className="size-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
