import type { ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ConnectLogo } from '../../components/brand/ConnectLogo'
import { cn } from '../../lib/cn'

// Full-screen states around the video room (loading, cannot join, left, ended, waiting). No LiveKit imports here:
// these screens are also the Suspense fallback while the room chunk downloads.

/** The dark meeting canvas with the brand header. */
export function RoomCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('oic-room-canvas fixed inset-0 z-40 flex flex-col overflow-y-auto text-white', className)} style={canvasStyle}>
      <header className="flex h-16 shrink-0 items-center px-5 sm:px-8">
        <ConnectLogo tone="light" size={30} />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-10 sm:px-8">{children}</div>
    </div>
  )
}

// The canvas background is repeated inline so the fallback looks right before room.css (lazy chunk) has loaded.
const canvasStyle = {
  background:
    'radial-gradient(1200px 700px at 88% -12%, rgb(40 120 229 / 0.2), transparent 60%), radial-gradient(900px 620px at -12% 112%, rgb(32 196 216 / 0.12), transparent 55%), #0b1e31',
}

export function RoomLoading({ label = 'Preparing the meeting room…' }: { label?: string }) {
  return (
    <RoomCanvas>
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 text-center">
        <LoaderCircle className="size-9 animate-spin text-cyan-400" aria-hidden />
        <p className="text-[14px] font-medium text-white/80">{label}</p>
      </div>
    </RoomCanvas>
  )
}

/** A centred status card on the meeting canvas (cannot join, you left, the meeting ended…). */
export function RoomMessage({
  icon,
  tone = 'brand',
  title,
  children,
  actions,
}: {
  icon: ReactNode
  tone?: 'brand' | 'warning' | 'danger' | 'success'
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  const ring = { brand: 'bg-brand-500/20 text-cyan-400', warning: 'bg-warning/20 text-warning', danger: 'bg-danger/20 text-[#F87171]', success: 'bg-success/20 text-[#4ADE80]' }[tone]
  return (
    <RoomCanvas>
      <section className="w-full max-w-[520px] rounded-xl border border-white/10 bg-white/[0.04] p-7 text-center shadow-[0_24px_60px_rgb(0_0_0/0.35)] backdrop-blur-md sm:p-9 animate-fade-up">
        <div className={cn('mx-auto flex size-14 items-center justify-center rounded-full', ring)}>{icon}</div>
        <h1 className="mt-5 text-[22px] leading-8 font-bold tracking-[-0.01em]">{title}</h1>
        {children && <div className="mt-2 text-[14px] leading-6 text-white/70">{children}</div>}
        {actions && <div className="mt-7 flex flex-col-reverse justify-center gap-2.5 sm:flex-row">{actions}</div>}
      </section>
    </RoomCanvas>
  )
}

/** Buttons for the dark canvas. */
export function CanvasButton({
  children,
  onClick,
  variant = 'primary',
  disabled,
  leftIcon,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  leftIcon?: ReactNode
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-md px-5 text-[14px] font-semibold transition-[background-color,transform] duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-60',
        variant === 'primary' && 'bg-brand-500 text-white shadow-[0_8px_24px_rgb(40_120_229/0.35)] hover:bg-brand-600',
        variant === 'secondary' && 'bg-white/10 text-white hover:bg-white/15',
        variant === 'danger' && 'bg-danger text-white hover:bg-[#B91C1C]',
      )}
    >
      {leftIcon}
      {children}
    </button>
  )
}
