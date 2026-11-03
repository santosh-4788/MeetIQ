import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { ChevronDown, CircleAlert, Search, X } from 'lucide-react'
import { cn } from '../../lib/cn'

// Form controls that complement Field.tsx (same label, border, focus and error treatment).

function FieldShell({ id, label, error, hint, children, className }: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

const boxClass = (error?: string) =>
  cn(
    'w-full rounded-sm border bg-surface text-sm text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-muted disabled:bg-surface-muted disabled:text-ink-secondary',
    error
      ? 'border-danger/70 focus:shadow-[0_0_0_3px_rgb(220_38_38/0.18)]'
      : 'border-line hover:border-line-strong focus:border-brand-500 focus:shadow-focus',
    '[&:focus-visible]:rounded-sm',
  )

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: ReactNode }

export const SelectField = forwardRef<HTMLSelectElement, SelectProps>(function SelectField({ label, error, hint, className, id, children, ...rest }, ref) {
  const autoId = useId()
  const selectId = id ?? autoId
  return (
    <FieldShell id={selectId} label={label} error={error} hint={hint} className={className}>
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          className={cn(boxClass(error), 'h-11 cursor-pointer appearance-none pr-9 pl-3')}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
      </div>
    </FieldShell>
  )
})

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: ReactNode }

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextAreaField({ label, error, hint, className, id, ...rest }, ref) {
  const autoId = useId()
  const areaId = id ?? autoId
  return (
    <FieldShell id={areaId} label={label} error={error} hint={hint} className={className}>
      <textarea
        ref={ref}
        id={areaId}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${areaId}-error` : hint ? `${areaId}-hint` : undefined}
        className={cn(boxClass(error), 'min-h-20 px-3 py-2.5 leading-[22px]')}
        {...rest}
      />
    </FieldShell>
  )
})

/** Compact filter-bar select (no visible label: pass aria-label). */
export function FilterSelect({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative', className)}>
      <select className={cn(boxClass(), 'h-10 w-full cursor-pointer appearance-none pr-9 pl-3 text-[13px]')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-muted" aria-hidden />
    </div>
  )
}

/** Search box for list pages (label via aria-label). */
export function SearchField({ value, onChange, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void }) {
  return (
    <label className={cn('flex h-10 items-center gap-2 rounded-sm border border-line bg-surface px-3 text-ink-muted transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus-within:border-brand-500 focus-within:shadow-focus', className)}>
      <Search className="size-4 shrink-0" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted [&:focus-visible]:shadow-none [&::-webkit-search-cancel-button]:hidden"
        {...rest}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="flex size-6 items-center justify-center rounded-sm hover:bg-navy-900/5 hover:text-ink">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  )
}

/** On/off switch (role="switch"). */
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-2.5 text-[13px] font-medium text-ink-secondary', disabled && 'cursor-not-allowed opacity-60', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-150', checked ? 'bg-brand-500' : 'bg-line-strong')}
      >
        <span className={cn('absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow-card transition-transform duration-150', checked && 'translate-x-4')} />
      </button>
      {label}
    </label>
  )
}
