import { useRef, type ReactNode } from 'react'
import { ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Badge } from './Feedback'

// Page and data-display building blocks for list/administration screens.

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[24px] leading-8 font-bold tracking-[-0.015em] text-ink">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-ink-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <Badge tone={active ? 'success' : 'neutral'} dot>
      {active ? 'Active' : 'Inactive'}
    </Badge>
  )
}

/** Accessible tabs (arrow keys move between tabs). The caller renders the active panel with `tabPanelProps`. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix }: { tabs: { id: T; label: string; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; idPrefix: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    e.preventDefault()
    const j = (next + tabs.length) % tabs.length
    onChange(tabs[j].id)
    refs.current[j]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className="scrollbar-thin flex gap-1 overflow-x-auto rounded-md border border-line bg-surface p-1 shadow-card">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          id={`${idPrefix}-tab-${t.id}`}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={cn(
            'flex h-9 shrink-0 items-center gap-2 rounded-sm px-3.5 text-[13px] font-semibold transition-colors duration-150',
            value === t.id ? 'bg-brand-50 text-brand-700' : 'text-ink-secondary hover:bg-canvas hover:text-ink',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function tabPanelProps(idPrefix: string, id: string) {
  return { id: `${idPrefix}-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `${idPrefix}-tab-${id}`, tabIndex: 0 } as const
}

export function Pagination({ page, pageSize, total, onPage, disabled }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; disabled?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const btn = 'inline-flex h-8 items-center gap-1 rounded-sm border border-line bg-surface px-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-50'
  return (
    <nav aria-label="Pagination" className="flex flex-col items-center justify-between gap-3 border-t border-line px-4 py-3 sm:flex-row sm:px-5">
      <p className="text-[12.5px] text-ink-secondary tabular-nums">
        {total === 0 ? 'No results' : <>Showing <strong className="text-ink">{from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')}</strong> of <strong className="text-ink">{total.toLocaleString('en-IN')}</strong></>}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={disabled || page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="size-4" /> <span className="hidden sm:inline">Previous</span>
        </button>
        <span className="text-[12.5px] text-ink-secondary tabular-nums" aria-current="page">
          Page {page} of {pages}
        </span>
        <button type="button" className={btn} disabled={disabled || page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <span className="hidden sm:inline">Next</span> <ChevronRight className="size-4" />
        </button>
      </div>
    </nav>
  )
}

/** Shared table styles: a plain <table> on md+ screens (cards are rendered separately on mobile). */
export const table = {
  // relative: absolutely positioned children (sr-only labels) stay inside the scroll area instead of widening the page.
  wrap: 'scrollbar-thin relative overflow-x-auto',
  table: 'w-full min-w-[720px] border-collapse text-left text-[13px]',
  th: 'border-b border-line bg-surface-muted px-4 py-2.5 text-[12px] font-semibold whitespace-nowrap text-ink-secondary first:pl-5 last:pr-5',
  td: 'border-b border-line px-4 py-3 align-middle text-ink first:pl-5 last:pr-5',
  row: 'transition-colors hover:bg-surface-muted',
}

/** Column header that sorts the list (aria-sort on the <th>). */
export function SortHeader({ label, active, onSort, direction = 'ascending', className }: { label: string; active: boolean; onSort: () => void; direction?: 'ascending' | 'descending'; className?: string }) {
  return (
    <th className={cn(table.th, className)} aria-sort={active ? direction : 'none'}>
      <button type="button" onClick={onSort} className={cn('inline-flex items-center gap-1 rounded-sm hover:text-ink', active && 'text-ink')}>
        {label}
        <ArrowDown className={cn('size-3.5 transition-opacity', active ? 'opacity-100' : 'opacity-0', direction === 'ascending' && 'rotate-180')} aria-hidden />
      </button>
    </th>
  )
}
