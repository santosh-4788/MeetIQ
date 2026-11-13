import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { authApi } from '../api'
import { SESSION_ENDED } from '../api/http'
import { sessionApi, type SessionInfo } from '../api/session'
import type { UserSummary } from '../api/types'
import { DEMO_MODE } from '../config'
import { ConnectMark } from '../components/brand/ConnectLogo'

type Status = 'loading' | 'authenticated' | 'anonymous'
export type EndReason = 'expired' | 'daily'

/** Window event that counts as user activity for the idle sign-out (dispatched by the video room while connected). */
export const ACTIVITY_EVENT = 'oic:activity'

/** Last user activity in ANY tab of this browser (all tabs share one server session, so they share one idle clock). */
const LAST_ACTIVITY_KEY = 'oic:last-activity'
const readLastActivity = () => {
  try { return Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0 } catch { return 0 }
}
const writeLastActivity = (t: number) => {
  try { localStorage.setItem(LAST_ACTIVITY_KEY, String(t)) } catch { /* private mode: per-tab only */ }
}
/** Real activity slides the server's idle window too (it only counts API calls), at most this often. */
const SERVER_TOUCH_MS = 5 * 60_000

// Meeting presence: while this tab is in a meeting, an ended portal session must not navigate away (that would drop the
// call). Media does not depend on the portal session; host controls simply need a fresh sign-in.
let roomDepth = 0
const ROOM_LEFT_EVENT = 'oic:room-left'
/** Called by the meeting room on mount (true) / unmount (false). */
export function markInMeeting(on: boolean) {
  roomDepth = Math.max(0, roomDepth + (on ? 1 : -1))
  if (!on && roomDepth === 0) window.dispatchEvent(new Event(ROOM_LEFT_EVENT))
}
const inMeeting = () => roomDepth > 0

type AuthContextValue = {
  user: UserSummary | null
  status: Status
  signIn: (user: UserSummary) => void
  signOut: (reason?: 'user' | 'expired') => Promise<void>
  can: (permission: string) => boolean
  /** True after the session ended without the user signing out (idle timeout or server-side expiry). */
  expired: boolean
  /** Why it ended: 'daily' = the daily security reset (23:30 IST). */
  endReason: EndReason
  /** Session facts from the server (daily logout time etc.); refetch after scheduling a test. */
  session: SessionInfo | null
  refreshSession: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserSummary | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [expired, setExpired] = useState(false)
  const navigate = useNavigate()
  // The session check itself failed (server down or restarting). Showing the sign-in page would wrongly suggest the user
  // was signed out, so a retry screen is shown instead.
  const [unreachable, setUnreachable] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    authApi
      .me()
      .then((u) => {
        if (!alive) return
        setUnreachable(null)
        setUser(u)
        setStatus(u ? 'authenticated' : 'anonymous')
      })
      .catch((e: unknown) => {
        if (!alive) return
        setUnreachable(e instanceof Error && e.message ? e.message : 'Unable to reach the OneInsure Connect server.')
      })
    return () => {
      alive = false
    }
  }, [attempt])

  const signIn = useCallback((u: UserSummary) => {
    setExpired(false)
    setUser(u)
    setStatus('authenticated')
  }, [])

  const [endReason, setEndReason] = useState<EndReason>('expired')
  // The session ended while this tab is in a meeting: stay in the call, show a banner, finish the sign-out on leaving.
  const [lostInMeeting, setLostInMeeting] = useState<EndReason | null>(null)
  const [session, setSession] = useState<SessionInfo | null>(null)
  // Server clock minus this PC's clock, so the 23:30 warning fires on time even if the PC's clock is off.
  const skew = useRef(0)
  const lastTouch = useRef(0)
  const statusRef = useRef(status)
  statusRef.current = status

  const refreshSession = useCallback(() => {
    if (DEMO_MODE || statusRef.current !== 'authenticated') return
    lastTouch.current = Date.now()
    const asked = Date.now()
    sessionApi.get().then((s) => {
      skew.current = Date.parse(s.serverNowUtc) - (asked + Date.now()) / 2
      setSession(s)
    }).catch(() => undefined) // a 401 here goes through the normal session-ended path
  }, [])
  useEffect(() => {
    if (status === 'authenticated') refreshSession()
    else setSession(null)
  }, [status, refreshSession])

  const signOut = useCallback(
    async (reason: 'user' | 'expired' = 'user') => {
      try {
        await authApi.logout()
      } finally {
        setEndReason('expired')
        setExpired(reason === 'expired')
        setUser(null)
        setStatus('anonymous')
        navigate(reason === 'expired' ? '/session-expired' : '/login', { replace: true })
      }
    },
    [navigate],
  )

  /** The server-side session is over (expired, revoked, daily reset). Never drops a meeting in progress. */
  const endSession = useCallback((reason: EndReason) => {
    if (statusRef.current !== 'authenticated') return
    if (inMeeting()) {
      setLostInMeeting(reason)
      return
    }
    if (reason === 'daily') void authApi.logout().catch(() => undefined) // clears the cookie; the server already ended the session
    setEndReason(reason)
    // RequireAuth sends the user to /session-expired (not /login) while this flag is set.
    setExpired(true)
    setUser(null)
    setStatus('anonymous')
    navigate(reason === 'daily' ? '/session-expired?reason=daily' : '/session-expired', { replace: true })
  }, [navigate])

  const dailyDue = useCallback(() => {
    const at = session?.dailyLogoutUtc ? Date.parse(session.dailyLogoutUtc) : NaN
    return Number.isFinite(at) && Date.now() + skew.current >= at - 5_000
  }, [session])

  // The idle limit comes from the server (Security:SessionIdleMinutes); 0 = no idle sign-out (the 12 Nov 2026 policy - only
  // the 23:30 IST daily logout ends a session). Nothing runs until the session info has loaded.
  const idleMinutes = session?.idleMinutes ?? 0
  useIdleTimeout(
    status === 'authenticated' && idleMinutes > 0,
    idleMinutes,
    () => (inMeeting() ? undefined : void signOut('expired')),
    () => {
      if (Date.now() - lastTouch.current > SERVER_TOUCH_MS) refreshSession()
    },
  )

  // An API call answered 401: the server-side session is gone (expired, daily reset, revoked from another device, password
  // reset, account deactivated). Leave the protected pages instead of showing them as broken - unless a meeting is running.
  useEffect(() => {
    const onEnded = () => endSession(dailyDue() ? 'daily' : 'expired')
    window.addEventListener(SESSION_ENDED, onEnded)
    return () => window.removeEventListener(SESSION_ENDED, onEnded)
  }, [endSession, dailyDue])

  // Left the meeting after the session ended in it: finish the sign-out now (unless they signed in again meanwhile).
  useEffect(() => {
    const onLeft = () => setLostInMeeting((r) => {
      if (r) window.setTimeout(() => endSession(r), 0)
      return null
    })
    window.addEventListener(ROOM_LEFT_EVENT, onLeft)
    return () => window.removeEventListener(ROOM_LEFT_EVENT, onLeft)
  }, [endSession])

  // Session lost inside a meeting: notice when the user signs in again (e.g. in another tab) and restore host controls.
  useEffect(() => {
    if (!lostInMeeting) return
    const t = window.setInterval(() => {
      authApi.me().then((u) => {
        if (!u) return
        setLostInMeeting(null)
        setUser(u)
        refreshSession()
      }).catch(() => undefined)
    }, 30_000)
    return () => window.clearInterval(t)
  }, [lostInMeeting, refreshSession])

  // Daily security reset: warn ahead of time with a countdown, then end the portal session at the cutoff.
  const [warnUntil, setWarnUntil] = useState<number | null>(null)
  useEffect(() => {
    setWarnUntil(null)
    if (status !== 'authenticated' || !session?.dailyLogoutUtc) return
    const cutoff = Date.parse(session.dailyLogoutUtc) - skew.current // in this PC's clock
    const warnAt = cutoff - session.warningMinutes * 60_000
    const now = Date.now()
    const timers: number[] = []
    // setTimeout cannot hold more than ~24.8 days; the info is refreshed long before that anyway.
    const at = (t: number, fn: () => void) => { if (t - now < 2 ** 31 - 1) timers.push(window.setTimeout(fn, Math.max(0, t - now))) }
    at(warnAt, () => setWarnUntil(cutoff))
    at(cutoff, () => { setWarnUntil(null); endSession('daily') })
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [status, session, endSession])

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, signIn, signOut, can: (p) => !!user?.permissions.includes(p), expired, endReason, session, refreshSession }),
    [user, status, signIn, signOut, expired, endReason, session, refreshSession],
  )
  if (unreachable && status === 'loading') return <ServerUnavailable message={unreachable} onRetry={() => (setUnreachable(null), setAttempt((a) => a + 1))} />
  return (
    <AuthContext.Provider value={value}>
      {children}
      {warnUntil && status === 'authenticated' && <DailyLogoutWarning until={warnUntil} test={!!session?.dailyLogoutTest} utc={session?.dailyLogoutUtc ?? null} />}
      {lostInMeeting && <SessionLostInMeeting reason={lostInMeeting} />}
    </AuthContext.Provider>
  )
}

function formatIst(utc: string | null) {
  if (!utc) return '11:30 PM'
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(utc))
}

/** "Your OneInsure Connect session will end at 11:30 PM for daily security reset." with a live countdown. */
function DailyLogoutWarning({ until, test, utc }: { until: number; test: boolean; utc: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  const mm = String(Math.floor(left / 60)).padStart(1, '0')
  const ss = String(left % 60).padStart(2, '0')
  return (
    <div role="alert" data-testid="daily-logout-warning"
      className="fixed inset-x-3 top-3 z-[1000] mx-auto max-w-xl rounded-lg border border-warning/40 bg-surface px-4 py-3 text-[13.5px] leading-5 text-ink shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]">
      <p className="font-semibold">
        Your OneInsure Connect session will end at {formatIst(utc)} for daily security reset.{test ? ' (test)' : ''}
      </p>
      <p className="mt-0.5 text-ink-secondary">
        Signing out in <span className="font-semibold tabular-nums text-ink">{mm}:{ss}</span>. Please save your work.
        {inMeeting() ? ' You will stay connected to your meeting; sign in again afterwards to use host controls.' : ''}
      </p>
    </div>
  )
}

/** Shown over the meeting room when the portal session ended mid-call: the call goes on, host controls need a new sign-in. */
function SessionLostInMeeting({ reason }: { reason: EndReason }) {
  const login = `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}login`
  return (
    <div role="alert" data-testid="session-lost-in-meeting"
      className="fixed inset-x-3 top-3 z-[1000] mx-auto max-w-xl rounded-lg border border-warning/40 bg-surface px-4 py-3 text-[13.5px] leading-5 text-ink shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]">
      <p className="font-semibold">
        {reason === 'daily' ? 'Your daily session has ended.' : 'Your session has ended.'} You are still connected to this meeting.
      </p>
      <p className="mt-0.5 text-ink-secondary">
        Host controls, chat and recording controls need you to{' '}
        <a href={login} target="_blank" rel="noopener" className="font-semibold text-brand-600 underline">sign in again</a>{' '}
        (opens a new tab). They come back here automatically once you have signed in.
      </p>
    </div>
  )
}

function ServerUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-gradient-canvas px-6 text-center" role="alert">
      <ConnectMark size={52} />
      <div>
        <p className="text-[17px] font-semibold text-ink">OneInsure Connect is not reachable</p>
        <p className="mt-1 max-w-md text-[13.5px] text-ink-secondary">{message}</p>
      </div>
      <button type="button" onClick={onRetry} className="inline-flex h-10 items-center rounded-md bg-brand-500 px-5 text-[14px] font-semibold text-white hover:bg-brand-700">
        Retry
      </button>
    </div>
  )
}

/**
 * Idle sign-out shared by every tab: all tabs use ONE server session, so a forgotten background tab must not sign out the
 * tab the user is working in (previously each tab ran its own 30-minute timer and its POST /auth/logout ended the shared
 * session - the main cause of "logged out while working"). Activity in any tab is written to localStorage; a tab whose
 * timer fires first checks that shared timestamp and only signs out when the whole browser has really been idle.
 */
function useIdleTimeout(active: boolean, minutes: number, onExpire: () => void, onActivity: () => void) {
  const cb = useRef(onExpire)
  cb.current = onExpire
  const act = useRef(onActivity)
  act.current = onActivity
  useEffect(() => {
    if (!active) return
    const idleMs = minutes * 60_000
    let timer = 0
    let last = 0
    const schedule = (delay: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(check, delay)
    }
    const check = () => {
      const remaining = readLastActivity() + idleMs - Date.now()
      if (remaining > 1000) schedule(remaining) // another tab was active meanwhile
      else cb.current()
    }
    const reset = () => {
      const now = Date.now()
      if (now - last < 1000) return // throttle
      last = now
      writeLastActivity(now)
      act.current()
      schedule(idleMs)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_ACTIVITY_KEY) schedule(idleMs)
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    // Someone listening in a meeting is not idle: the video room signals activity while it is connected.
    window.addEventListener(ACTIVITY_EVENT, reset)
    window.addEventListener('storage', onStorage)
    // A tab woken from the background re-checks at once instead of trusting a timer that fired late.
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    reset()
    return () => {
      window.clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, reset))
      window.removeEventListener(ACTIVITY_EVENT, reset)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, minutes])
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function FullScreenLoader() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-gradient-canvas" role="status" aria-label="Loading">
      <div className="relative">
        <span className="absolute inset-0 rounded-[14px] bg-brand-500/30 animate-pulse-ring" aria-hidden />
        <ConnectMark size={52} />
      </div>
      <p className="text-[13px] font-medium text-ink-secondary">Loading OneInsure Connect…</p>
    </div>
  )
}

export function RequireAuth() {
  const { status, user, expired } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullScreenLoader />
  if (status === 'anonymous') return <Navigate to={expired ? '/session-expired' : '/login'} replace state={{ from: location.pathname }} />
  // Survives reloads and new tabs: the server reports the flag on every /auth/me (and refuses other APIs meanwhile).
  if (user?.mustChangePassword) return <Navigate to="/change-password" replace state={{ forced: true }} />
  return <Outlet />
}

export function RequirePermission({ permission, children }: { permission?: string; children: ReactNode }) {
  const { can } = useAuth()
  if (permission && !can(permission)) return <Navigate to="/access-denied" replace />
  return <>{children}</>
}

/** Keeps signed-in users away from the login screens. */
export function RedirectIfAuthenticated() {
  const { status } = useAuth()
  if (status === 'loading') return <FullScreenLoader />
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />
  return <Outlet />
}
