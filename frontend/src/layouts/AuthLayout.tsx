import type { ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { motion } from 'motion/react'
import { Headset, Laptop, Users, Video } from 'lucide-react'
import { ConnectMark } from '../components/brand/ConnectLogo'
import { ParentBrand } from '../components/brand/OneInsureLogo'
import { APP_VERSION, DEMO_MODE, SUPPORT } from '../config'
import { Badge } from '../components/ui/Feedback'

/** One centered card over an ambient animated backdrop, shared by every authentication screen. */
export function AuthLayout() {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-gradient-brand bg-[length:220%_220%] text-white animate-gradient">
      <AuthAmbience />
      <div className="relative z-10 flex items-center justify-end px-5 pt-5 sm:px-8">
        {DEMO_MODE && (
          <Badge tone="warning" dot>
            DEMO MODE
          </Badge>
        )}
      </div>
      <div className="relative z-10 flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <Outlet />
      </div>
      <footer className="relative z-10 flex flex-col items-center gap-1 px-6 pb-6 text-center text-[12px] text-white/55 sm:flex-row sm:justify-between">
        <span className="inline-flex items-center gap-1.5">
          <Headset className="size-3.5" /> Need help?{' '}
          <a href={`mailto:${SUPPORT.email}`} className="font-medium text-white/80 hover:text-white hover:underline">
            {SUPPORT.email}
          </a>
        </span>
        <span>
          © {new Date().getFullYear()} OneInsure · v{APP_VERSION}
        </span>
      </footer>
    </div>
  )
}

/** Drifting glow orbs, a faint dot grid and a few twinkling sparkles - decorative only, never under the card's focus order. */
function AuthAmbience() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="absolute -top-32 -left-24 size-[420px] rounded-full bg-cyan-400/20 blur-3xl animate-float-slow" />
      <div className="absolute -right-24 -bottom-40 size-[460px] rounded-full bg-brand-500/25 blur-3xl animate-float-slow [animation-delay:-6s]" />
      <div className="absolute top-[12%] right-[14%] size-28 rounded-full bg-white/10 blur-2xl animate-float [animation-delay:-3s]" />
      <svg className="absolute inset-0 size-full opacity-[0.07]">
        <defs>
          <pattern id="auth-grid" width="30" height="30" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="white" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#auth-grid)" />
      </svg>
      {/* A quiet network of connected nodes - communication and connectivity, not literal camera icons, so it reads
          as atmosphere rather than clutter behind the card. */}
      <svg className="absolute inset-0 hidden size-full sm:block" viewBox="0 0 100 100" preserveAspectRatio="none">
        {[
          [8, 18, 24, 32],
          [24, 32, 16, 58],
          [92, 14, 76, 30],
          [76, 30, 88, 56],
          [10, 82, 28, 68],
          [90, 86, 74, 74],
        ].map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeOpacity="0.14" strokeWidth="0.15" strokeDasharray="1.5 2" className="animate-dash" />
        ))}
        {[
          [8, 18],
          [24, 32],
          [16, 58],
          [92, 14],
          [76, 30],
          [88, 56],
          [10, 82],
          [28, 68],
          [90, 86],
          [74, 74],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="0.6" fill="#22D3EE" className="animate-pulse" style={{ animationDelay: `${(i % 5) * 0.4}s` }} />
        ))}
      </svg>
      {[
        { left: '20%', top: '24%', delay: '0s' },
        { left: '72%', top: '16%', delay: '1.2s' },
        { left: '82%', top: '64%', delay: '2.4s' },
        { left: '14%', top: '72%', delay: '3.3s' },
      ].map((s, i) => (
        <span key={i} className="absolute size-1 rounded-full bg-white animate-sparkle" style={{ left: s.left, top: s.top, animationDelay: s.delay }} />
      ))}
      <FloatingIconBubbles />
    </div>
  )
}

/** A few drifting glass bubbles carrying a meeting-related icon each (camera, device, people) - quiet motion around
    the card, not meant to be read as a literal illustration. Hidden below `sm`: the card alone fills a phone screen. */
function FloatingIconBubbles() {
  const bubbles: { icon: ReactNode; className: string; delay: string }[] = [
    { icon: <Video className="size-6" />, className: 'top-[16%] left-[10%] animate-float', delay: '0s' },
    { icon: <Laptop className="size-7" />, className: 'top-[46%] left-[6%] animate-float-slow', delay: '-4s' },
    { icon: <Users className="size-6" />, className: 'top-[58%] right-[9%] animate-float', delay: '-2s' },
  ]
  return (
    <div className="absolute inset-0 hidden sm:block">
      {bubbles.map((b, i) => (
        <div
          key={i}
          className={`absolute flex size-16 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white/80 shadow-[0_8px_24px_rgb(0_0_0/0.25)] backdrop-blur-md ${b.className}`}
          style={{ animationDelay: b.delay }}
        >
          {b.icon}
        </div>
      ))}
    </div>
  )
}

/** White card used by every auth screen, with the shared product brand lock-up and consistent entrance animation. */
export function AuthCard({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 22, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className={`w-full ${wide ? 'max-w-[480px]' : 'max-w-[400px]'} rounded-2xl border border-line/80 bg-surface p-6 shadow-[0_32px_70px_-24px_rgb(5_15_35/0.55)] sm:p-7 short:p-6 tiny:p-5`}
    >
      <div className="mb-5 flex flex-col items-center text-center">
        <div className="relative mb-3 flex size-14 items-center justify-center">
          <span className="absolute inset-[-8px] rounded-full bg-[conic-gradient(from_0deg,var(--color-cyan-400),var(--color-brand-500),var(--color-brand-700),var(--color-cyan-400))] opacity-55 blur-md animate-spin-slow" aria-hidden />
          <ConnectMark size={56} className="relative" />
        </div>
        <span className="text-[15px] font-extrabold tracking-[-0.01em] text-ink">
          OneInsure <span className="text-gradient-accent">Connect</span>
        </span>
      </div>
      {children}
      <div className="mt-6 flex items-center justify-center gap-2 border-t border-line pt-4">
        <ParentBrand tone="dark" compact />
      </div>
    </motion.div>
  )
}

export function AuthHeading({ icon, title, description, tone = 'brand' }: { icon?: ReactNode; title: string; description?: ReactNode; tone?: 'brand' | 'danger' | 'warning' | 'success' }) {
  const toneCls = {
    brand: 'bg-brand-50 text-brand-500',
    danger: 'bg-danger-soft text-danger',
    warning: 'bg-warning-soft text-warning-ink',
    success: 'bg-success-soft text-success',
  }[tone]
  return (
    <div className="mb-6 tiny:mb-5">
      {icon && <div className={`mb-4 tiny:mb-3 flex size-12 items-center justify-center rounded-lg ${toneCls}`}>{icon}</div>}
      <h1 className="text-[24px] leading-8 font-bold tracking-[-0.015em] text-ink">{title}</h1>
      {description && <p className="mt-1.5 text-[14px] leading-[22px] text-ink-secondary">{description}</p>}
    </div>
  )
}
