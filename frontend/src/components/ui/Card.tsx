import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { animate, useReducedMotion } from 'motion/react'
import { ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
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
  to,
  onClick,
}: {
  label: string
  value: number
  icon: ReactNode
  accent?: 'brand' | 'cyan' | 'success' | 'warning' | 'navy' | 'violet'
  delta?: number
  footnote?: string
  /** Makes the whole card a link (e.g. to the page that explains this number). */
  to?: string
  /** Makes the whole card a button (e.g. opens a list), when there is no page to link to. */
  onClick?: () => void
}) {
  const accents = {
    brand: 'bg-brand-50 text-brand-500',
    cyan: 'bg-cyan-50 text-[#0E9FB0]',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning-ink',
    navy: 'bg-navy-900/6 text-navy-900',
    violet: 'bg-[#F1ECFE] text-[#7C3AED]',
  }
  const bars = {
    brand: 'from-brand-500 to-brand-200',
    cyan: 'from-cyan-400 to-cyan-100',
    success: 'from-success to-success-soft',
    warning: 'from-warning to-warning-soft',
    navy: 'from-navy-900 to-navy-900/20',
    violet: 'from-[#7C3AED] to-[#F1ECFE]',
  }
  const glows = {
    brand: 'group-hover:shadow-[0_22px_40px_-20px_rgb(40_120_229/0.35)]',
    cyan: 'group-hover:shadow-[0_22px_40px_-20px_rgb(32_196_216/0.4)]',
    success: 'group-hover:shadow-[0_22px_40px_-20px_rgb(22_163_74/0.35)]',
    warning: 'group-hover:shadow-[0_22px_40px_-20px_rgb(245_158_11/0.35)]',
    navy: 'group-hover:shadow-[0_22px_40px_-20px_rgb(16_42_67/0.3)]',
    violet: 'group-hover:shadow-[0_22px_40px_-20px_rgb(124_58_237/0.35)]',
  }
  const content = (
    <>
      <span className={cn('absolute inset-x-0 top-0 h-[3px] scale-x-0 bg-gradient-to-r opacity-0 transition-[transform,opacity] duration-300 group-hover:scale-x-100 group-hover:opacity-100', bars[accent])} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-ink-secondary">{label}</p>
        <span className={cn('relative flex size-9 items-center justify-center overflow-hidden rounded-full ring-1 ring-inset ring-black/[0.03] transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6', accents[accent])}>
          <span className="pointer-events-none absolute -inset-y-3 -left-2 w-3 rotate-[25deg] bg-white/55" aria-hidden />
          <span className="relative">{icon}</span>
        </span>
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
        {(to || onClick) && <ChevronRight className="ml-auto size-3.5 translate-x-0 text-ink-muted opacity-0 transition-[transform,opacity] duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />}
      </div>
    </>
  )
  const className = cn(
    'group relative block h-full overflow-hidden rounded-2xl p-3.5 sm:p-4.5 transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5',
    glows[accent],
    (to || onClick) && 'cursor-pointer active:scale-[0.98] active:duration-75',
  )
  return to ? (
    <Link to={to} className={cn(className, 'border border-line bg-surface shadow-card focus-visible:shadow-focus')}>
      {content}
    </Link>
  ) : onClick ? (
    <button type="button" onClick={onClick} className={cn(className, 'w-full border border-line bg-surface text-left shadow-card focus-visible:shadow-focus')}>
      {content}
    </button>
  ) : (
    <Card as="article" className={className}>
      {content}
    </Card>
  )
}
