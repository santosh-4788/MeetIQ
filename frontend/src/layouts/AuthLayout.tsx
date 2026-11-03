import type { ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { motion } from 'motion/react'
import { CalendarCheck, Headset, ShieldCheck, Video } from 'lucide-react'
import { ConnectLogo } from '../components/brand/ConnectLogo'
import { ParentBrand } from '../components/brand/OneInsureLogo'
import { NetworkIllustration } from '../components/illustrations/NetworkIllustration'
import { APP_VERSION, DEMO_MODE, SUPPORT } from '../config'
import { Badge } from '../components/ui/Feedback'

/** Two-panel layout shared by login and every authentication screen. */
export function AuthLayout() {
  return (
    // Desktop: exactly one viewport high (no page scroll); the brand panel scales with the height and the form side
    // scrolls on its own only if a screen is taller than the viewport (e.g. demo credentials on a very short window).
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] lg:h-dvh lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] lg:overflow-hidden">
      <BrandPanel />
      <main className="relative flex min-h-dvh min-w-0 flex-col bg-gradient-canvas lg:h-dvh lg:min-h-0 lg:overflow-y-auto">
        {/* Mobile: product logo. Desktop: only the dev demo-mode badge, so the bar takes no space in normal builds. */}
        <div className={`flex items-center justify-between px-5 pt-5 sm:px-8 lg:justify-end ${DEMO_MODE ? '' : 'lg:hidden'}`}>
          <span className="lg:hidden">
            <ConnectLogo size={34} />
          </span>
          {DEMO_MODE && (
            <Badge tone="warning" dot>
              DEMO MODE
            </Badge>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 lg:py-10 short:lg:py-6 tiny:lg:py-4">
          <Outlet />
        </div>
        <footer className="flex flex-col items-center gap-1 px-6 pb-6 short:lg:pb-4 tiny:lg:pb-2.5 text-center text-[12px] text-ink-muted sm:flex-row sm:justify-between">
          <span className="inline-flex items-center gap-1.5">
            <Headset className="size-3.5" /> Need help?{' '}
            <a href={`mailto:${SUPPORT.email}`} className="font-medium text-brand-700 hover:underline">
              {SUPPORT.email}
            </a>
          </span>
          <span>
            © {new Date().getFullYear()} OneInsure · v{APP_VERSION}
          </span>
        </footer>
      </main>
    </div>
  )
}

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-gradient-brand bg-[length:200%_200%] animate-gradient text-white lg:flex lg:h-dvh lg:flex-col">
      {/* Decorative shapes */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute -top-32 -right-24 size-[420px] rounded-full bg-brand-500/25 blur-3xl animate-float-slow" />
        <div className="absolute -bottom-40 -left-24 size-[460px] rounded-full bg-cyan-400/15 blur-3xl animate-float-slow [animation-delay:-6s]" />
        <div className="absolute top-[18%] right-[10%] size-24 rotate-12 rounded-[28px] border border-white/10 animate-float [animation-delay:-2s] short:hidden" />
        <div className="absolute bottom-[14%] left-[46%] size-14 rounded-full border border-cyan-400/20 animate-float [animation-delay:-4s] short:hidden" />
        <svg className="absolute inset-0 size-full opacity-[0.06]">
          <defs>
            <pattern id="auth-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M32 0H0V32" fill="none" stroke="white" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#auth-grid)" />
        </svg>
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col px-10 pt-9 pb-8 xl:px-14 short:pt-7 short:pb-6 tiny:pt-5 tiny:pb-5">
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
          <ConnectLogo tone="light" size={42} showTagline />
        </motion.div>

        <motion.div
          className="mt-10 max-w-[540px] xl:mt-14 short:mt-7 short:xl:mt-8 tiny:mt-5 tiny:xl:mt-5"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="eyebrow text-cyan-400">Enterprise Video Meeting &amp; Collaboration Platform</p>
          <h1 className="mt-3 text-[clamp(28px,min(3.1vw,5.2vh),44px)] leading-[1.12] font-bold tracking-[-0.025em] tiny:mt-2">
            One Platform.
            <br />
            <span className="bg-gradient-to-r from-white via-[#BFE6FF] to-cyan-400 bg-clip-text text-transparent">Every Connection.</span>
          </h1>
          <p className="mt-4 max-w-[480px] text-[15px] leading-6 text-white/72 short:mt-3 short:text-[14px] short:leading-[22px]">
            Bring your teams and customers together through secure video meetings, intelligent scheduling and seamless collaboration.
          </p>
        </motion.div>

        {/* The illustration takes whatever height is left and keeps its aspect ratio (sized by height on short screens). */}
        <motion.div
          className="flex min-h-0 flex-1 items-center justify-center py-6 short:py-4 tiny:py-3"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex aspect-[520/420] h-full max-h-[420px] max-w-full items-center xl:max-h-[460px]">
            <NetworkIllustration />
          </div>
        </motion.div>

        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-white/75">
            <Feature icon={<Video className="size-4" />}>HD video &amp; screen sharing</Feature>
            <Feature icon={<CalendarCheck className="size-4" />}>Smart scheduling</Feature>
            <Feature icon={<ShieldCheck className="size-4" />}>Consent-based recording</Feature>
          </ul>
          <ParentBrand />
        </div>
      </div>
    </aside>
  )
}

function Feature({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-2">
      <span className="text-cyan-400">{icon}</span>
      {children}
    </li>
  )
}

/** White card used by every auth screen, with consistent entrance animation. */
export function AuthCard({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className={`w-full ${wide ? 'max-w-[480px]' : 'max-w-[440px]'} rounded-xl border border-line/80 bg-surface p-7 shadow-[0_24px_60px_-20px_rgb(16_42_67/0.22),0_2px_6px_rgb(16_42_67/0.05)] sm:p-9 short:sm:p-8 tiny:sm:p-7`}
    >
      {children}
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
