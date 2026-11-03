import { useEffect, useRef, useState, type ReactNode } from 'react'
import { animate, useReducedMotion } from 'motion/react'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { cn } from '../../lib/cn'

export function Card({ className, children, as: As = 'section' }: { className?: string; children: ReactNode; as?: 'section' | 'div' | 'article' }) {
  return <As className={cn('rounded-lg border border-line bg-surface shadow-card', className)}>{children}</As>
}

export function CardHeader({ title, subtitle, action, className }: { title: string; subtitle?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-5 pt-4.5 pb-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] leading-[22px] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-secondary">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion()
  const [display, setDisplay] = useState(reduce ? value : 0)
  const from = useRef(0)
  useEffect(() => {
    if (reduce) {
      setDisplay(value)
      return
    }
    const controls = animate(from.current, value, {
      duration: 1.1,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    })
    from.current = value
    return () => controls.stop()
  }, [value, reduce])
  return <span className={cn('tabular-nums', className)}>{display.toLocaleString('en-IN')}</span>
}

export function StatCard({
  label,
  value,
  icon,
  accent = 'brand',
  delta,
  footnote,
}: {
  label: string
  value: number
  icon: ReactNode
  accent?: 'brand' | 'cyan' | 'success' | 'warning' | 'navy' | 'violet'
  delta?: number
  footnote?: string
}) {
  const accents = {
    brand: 'bg-brand-50 text-brand-500',
    cyan: 'bg-cyan-50 text-[#0E9FB0]',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning-ink',
    navy: 'bg-navy-900/6 text-navy-900',
    violet: 'bg-[#F1ECFE] text-[#7C3AED]',
  }
  return (
    <Card as="article" className="group relative h-full overflow-hidden p-3.5 sm:p-4.5 transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-raised">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-ink-secondary">{label}</p>
        <span className={cn('flex size-9 items-center justify-center rounded-md', accents[accent])}>{icon}</span>
      </div>
      <AnimatedNumber value={value} className="mt-1 block text-[24px] sm:text-[28px] leading-9 font-bold tracking-[-0.02em] text-ink" />
      <div className="mt-1 flex items-center gap-2 text-[12px]">
        {delta !== undefined && (
          <span className={cn('inline-flex items-center gap-0.5 font-semibold', delta >= 0 ? 'text-success' : 'text-danger')}>
            {delta >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
            {Math.abs(delta)}%
          </span>
        )}
        {footnote && <span className="text-ink-muted">{footnote}</span>}
      </div>
    </Card>
  )
}
