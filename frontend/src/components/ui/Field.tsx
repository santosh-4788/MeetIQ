import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { CircleAlert, Eye, EyeOff } from 'lucide-react'
import { cn } from '../../lib/cn'

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string
  hint?: ReactNode
  leftIcon?: ReactNode
  rightSlot?: ReactNode
  labelAction?: ReactNode
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, error, hint, leftIcon, rightSlot, labelAction, className, id, ...rest },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between">
        <label htmlFor={inputId} className="text-[13px] font-semibold text-ink">
          {label}
        </label>
        {labelAction}
      </div>
      <div
        className={cn(
          'group flex h-11 items-center rounded-sm border bg-surface transition-[border-color,box-shadow] duration-150',
          error
            ? 'border-danger/70 focus-within:shadow-[0_0_0_3px_rgb(220_38_38/0.18)]'
            : 'border-line hover:border-line-strong focus-within:border-brand-500 focus-within:shadow-focus',
        )}
      >
        {leftIcon && (
          <span className={cn('pl-3 transition-colors', error ? 'text-danger' : 'text-ink-muted group-focus-within:text-brand-500')}>
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
          className="h-full w-full min-w-0 flex-1 bg-transparent px-3 text-sm text-ink outline-none placeholder:text-ink-muted [&:focus-visible]:shadow-none"
          {...rest}
        />
        {rightSlot}
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-[12.5px] text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
})

export const PasswordField = forwardRef<HTMLInputElement, Omit<FieldProps, 'type' | 'rightSlot'>>(function PasswordField(props, ref) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)
  return (
    <TextField
      ref={ref}
      {...props}
      type={visible ? 'text' : 'password'}
      onKeyDown={(e) => {
        onKey(e)
        props.onKeyDown?.(e)
      }}
      onKeyUp={onKey}
      hint={props.hint ?? (capsLock ? <span className="font-medium text-warning-ink">Caps Lock is on</span> : undefined)}
      rightSlot={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="mr-1.5 flex size-8 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-navy-900/5 hover:text-ink"
        >
          {visible ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
      }
    />
  )
})

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-ink-secondary', className)}>
      <input
        type="checkbox"
        className="peer size-4 cursor-pointer appearance-none rounded-[5px] border border-line-strong bg-surface transition-colors checked:border-brand-500 checked:bg-brand-500 bg-center bg-no-repeat checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><path d=%22M4 8.5l2.5 2.5L12 5.5%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>')]"
        {...rest}
      />
      <span className="peer-checked:text-ink">{label}</span>
    </label>
  )
}
