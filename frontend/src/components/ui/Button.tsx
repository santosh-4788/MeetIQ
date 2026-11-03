import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-500 text-white shadow-[0_1px_2px_rgb(16_42_67/0.12),inset_0_1px_0_rgb(255_255_255/0.15)] hover:bg-brand-700 active:bg-navy-800',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-muted',
  ghost: 'text-ink-secondary hover:text-ink hover:bg-navy-900/5',
  subtle: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  danger: 'bg-danger text-white hover:bg-[#B91C1C]',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-sm',
  md: 'h-10 px-4 text-sm gap-2 rounded-md',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-md',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
}

export function buttonClass({ variant = 'primary', size = 'md', fullWidth, className }: { variant?: Variant; size?: Size; fullWidth?: boolean; className?: string } = {}) {
  return cn(
    'group/btn relative inline-flex select-none items-center justify-center font-semibold whitespace-nowrap',
    'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.985]',
    'disabled:pointer-events-none disabled:opacity-60',
    variants[variant],
    sizes[size],
    fullWidth && 'w-full',
    className,
  )
}

/** A router link styled as a button (never nest <button> inside <a>). */
export function ButtonLink({ variant, size, fullWidth, className, leftIcon, rightIcon, children, ...rest }: LinkProps & { variant?: Variant; size?: Size; fullWidth?: boolean; leftIcon?: ReactNode; rightIcon?: ReactNode }) {
  return (
    <Link className={buttonClass({ variant, size, fullWidth, className })} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, leftIcon, rightIcon, fullWidth, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  )
})

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; badge?: number }>(
  function IconButton({ label, badge, className, children, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cn(
          'relative inline-flex size-10 items-center justify-center rounded-md text-ink-secondary transition-colors duration-150',
          'hover:bg-navy-900/5 hover:text-ink',
          className,
        )}
        {...rest}
      >
        {children}
        {!!badge && badge > 0 && (
          <span className="absolute top-1.5 right-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white ring-2 ring-surface tabular-nums">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
    )
  },
)
