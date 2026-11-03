import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { authApi } from '../api'
import { SESSION_ENDED } from '../api/http'
import type { UserSummary } from '../api/types'
import { SESSION_IDLE_MINUTES } from '../config'
import { ConnectMark } from '../components/brand/ConnectLogo'

type Status = 'loading' | 'authenticated' | 'anonymous'

/** Window event that counts as user activity for the idle sign-out (dispatched by the video room while connected). */
export const ACTIVITY_EVENT = 'oic:activity'

type AuthContextValue = {
  user: UserSummary | null
  status: Status
  signIn: (user: UserSummary) => void
  signOut: (reason?: 'user' | 'expired') => Promise<void>
  can: (permission: string) => boolean
  /** True after the session ended without the user signing out (idle timeout or server-side expiry). */
  expired: boolean
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

  const signOut = useCallback(
    async (reason: 'user' | 'expired' = 'user') => {
      try {
        await authApi.logout()
      } finally {
        setExpired(reason === 'expired')
        setUser(null)
        setStatus('anonymous')
        navigate(reason === 'expired' ? '/session-expired' : '/login', { replace: true })
      }
    },
    [navigate],
  )

  useIdleTimeout(status === 'authenticated', () => void signOut('expired'))

  // An API call answered 401: the server-side session is gone (expired, revoked from another device, password reset,
  // account deactivated). Leave the protected pages instead of showing them as broken.
  const statusRef = useRef(status)
  statusRef.current = status
  useEffect(() => {
    const onEnded = () => {
      if (statusRef.current !== 'authenticated') return
      // RequireAuth sends the user to /session-expired (not /login) while this flag is set.
      setExpired(true)
      setUser(null)
      setStatus('anonymous')
      navigate('/session-expired', { replace: true })
    }
    window.addEventListener(SESSION_ENDED, onEnded)
    return () => window.removeEventListener(SESSION_ENDED, onEnded)
  }, [navigate])

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, signIn, signOut, can: (p) => !!user?.permissions.includes(p), expired }),
    [user, status, signIn, signOut, expired],
  )
  if (unreachable && status === 'loading') return <ServerUnavailable message={unreachable} onRetry={() => (setUnreachable(null), setAttempt((a) => a + 1))} />
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
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

function useIdleTimeout(active: boolean, onExpire: () => void) {
  const cb = useRef(onExpire)
  cb.current = onExpire
  useEffect(() => {
    if (!active) return
    let timer = 0
    let last = 0
    const reset = () => {
      const now = Date.now()
      if (now - last < 1000) return // throttle
      last = now
      window.clearTimeout(timer)
      timer = window.setTimeout(() => cb.current(), SESSION_IDLE_MINUTES * 60_000)
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    // Someone listening in a meeting is not idle: the video room signals activity while it is connected.
    window.addEventListener(ACTIVITY_EVENT, reset)
    reset()
    return () => {
      window.clearTimeout(timer)
      events.forEach((e) => window.removeEventListener(e, reset))
      window.removeEventListener(ACTIVITY_EVENT, reset)
    }
  }, [active])
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
