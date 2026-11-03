import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, RefreshCw, TriangleAlert, Inbox } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'

type Tone = 'info' | 'success' | 'warning' | 'danger'

const alertTone: Record<Tone, { box: string; icon: ReactNode }> = {
  info: { box: 'bg-info-soft border-info/20 text-[#075985]', icon: <Info className="size-[18px] text-info" /> },
  success: { box: 'bg-success-soft border-success/20 text-[#166534]', icon: <CircleCheck className="size-[18px] text-success" /> },
  warning: { box: 'bg-warning-soft border-warning/30 text-warning-ink', icon: <TriangleAlert className="size-[18px] text-warning" /> },
  danger: { box: 'bg-danger-soft border-danger/20 text-[#991B1B]', icon: <CircleAlert className="size-[18px] text-danger" /> },
}

export function Alert({ tone = 'info', title, children, className }: { tone?: Tone; title?: string; children?: ReactNode; className?: string }) {
  const t = alertTone[tone]
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-md border px-3.5 py-3 text-[13px] animate-fade-in', t.box, className)}>
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'leading-5 opacity-90')}>{children}</div>}
      </div>
    </div>
  )
}

const badgeTone = {
  neutral: 'bg-navy-900/5 text-ink-secondary',
  brand: 'bg-brand-50 text-brand-700',
  info: 'bg-info-soft text-info',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning-ink',
  danger: 'bg-danger-soft text-danger',
  live: 'bg-danger text-white',
} as const

export type BadgeTone = keyof typeof badgeTone

export function Badge({ tone = 'neutral', dot, children, className }: { tone?: BadgeTone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold whitespace-nowrap', badgeTone[tone], className)}>
      {dot && <span className={cn('size-1.5 rounded-full bg-current', tone === 'live' && 'animate-rec')} aria-hidden />}
      {children}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-sm bg-[linear-gradient(90deg,#EDF1F7,#F5F8FC,#EDF1F7)]', className)} />
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-500">{icon ?? <Inbox className="size-6" />}</div>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-ink-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({ title = 'Something went wrong', description, onRetry }: { title?: string; description?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <CircleAlert className="size-6" />
      </div>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-[13px] text-ink-secondary">{description}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" leftIcon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
