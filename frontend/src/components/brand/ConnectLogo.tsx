import { useId } from 'react'
import { cn } from '../../lib/cn'

type MarkProps = { size?: number; className?: string; title?: string }

/**
 * OneInsure Connect product mark: an open "C" ring (connection) carrying a play glyph (video),
 * with cyan nodes at the ring ends and a third node beyond the opening (grow).
 */
export function ConnectMark({ size = 36, className, title = 'OneInsure Connect' }: MarkProps) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={title} className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="4" y1="2" x2="38" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#102A43" />
          <stop offset="0.55" stopColor="#1769AA" />
          <stop offset="1" stopColor="#2878E5" />
        </linearGradient>
        <linearGradient id={`${id}-ring`} x1="10" y1="10" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#C7F1F6" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill={`url(#${id}-bg)`} />
      <rect x="0.5" y="0.5" width="39" height="39" rx="10.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.12" />
      <path
        d="M27.28 13.89 A9.5 9.5 0 1 0 27.28 26.11"
        fill="none"
        stroke={`url(#${id}-ring)`}
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path d="M17.7 16.4 L23.4 20 L17.7 23.6 Z" fill="#FFFFFF" stroke="#FFFFFF" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="27.28" cy="13.89" r="2.3" fill="#20C4D8" />
      <circle cx="27.28" cy="26.11" r="2.3" fill="#20C4D8" />
      <circle cx="32.6" cy="20" r="1.5" fill="#20C4D8" fillOpacity="0.85" />
    </svg>
  )
}

type LogoProps = {
  variant?: 'full' | 'mark'
  /** "dark" = for light backgrounds, "light" = for navy backgrounds */
  tone?: 'dark' | 'light'
  size?: number
  showTagline?: boolean
  className?: string
}

export function ConnectLogo({ variant = 'full', tone = 'dark', size = 36, showTagline = false, className }: LogoProps) {
  if (variant === 'mark') return <ConnectMark size={size} className={className} />
  const light = tone === 'light'
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <ConnectMark size={size} />
      <span className="flex flex-col leading-none">
        <span className="whitespace-nowrap" style={{ fontSize: size * 0.47 }}>
          <span className={cn('font-semibold tracking-[-0.01em]', light ? 'text-white' : 'text-navy-900')}>OneInsure</span>{' '}
          <span className={cn('font-bold tracking-[-0.01em]', light ? 'text-cyan-400' : 'text-gradient-accent')}>Connect</span>
        </span>
        {showTagline && (
          <span
            className={cn('mt-1 font-medium tracking-[0.02em]', light ? 'text-white/60' : 'text-ink-secondary')}
            style={{ fontSize: Math.max(11, size * 0.3) }}
          >
            Connect. Collaborate. Grow.
          </span>
        )}
      </span>
    </span>
  )
}
