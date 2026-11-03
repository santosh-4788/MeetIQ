import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Bell, CalendarClock, CheckCheck, ChevronDown, ChevronRight, KeyRound, LoaderCircle, LogOut, Menu, Plus, Search, UserRound } from 'lucide-react'
import { NOTIFICATIONS_CHANGED, notificationsApi, type AppNotification } from '../api/notifications'
import { useAuth } from '../auth/AuthContext'
import { Avatar } from '../components/ui/Avatar'
import { ButtonLink, IconButton } from '../components/ui/Button'
import { Badge } from '../components/ui/Feedback'
import { DEFAULT_TIME_ZONE, DEMO_MODE } from '../config'
import { cn } from '../lib/cn'
import { formatRelative } from '../lib/format'
import { notificationIcon, safeLink } from '../pages/notifications/notificationMeta'
import { allNavItems } from './navigation'

function useOutsideClose<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

const dropdownMotion = {
  initial: { opacity: 0, y: -6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
  transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
}

export function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { pathname } = useLocation()
  const { can } = useAuth()
  const current = allNavItems.find((i) => pathname.startsWith(i.to))
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 sm:gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md sm:px-6">
      <IconButton label="Open menu" className="lg:hidden" onClick={onOpenMenu}>
        <Menu className="size-5" />
      </IconButton>
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-[12px] text-ink-muted sm:flex">
          <Link to="/dashboard" className="hover:text-ink">Home</Link>
          {current && current.to !== '/dashboard' && (
            <>
              <ChevronRight className="size-3" />
              <span className="text-ink-secondary">{current.label}</span>
            </>
          )}
        </nav>
        <p className="truncate text-[16px] leading-6 font-bold text-ink">{current?.label ?? 'OneInsure Connect'}</p>
      </div>
      {DEMO_MODE && (
        <span className="hidden md:block">
          <Badge tone="warning" dot>
            DEMO DATA
          </Badge>
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <GlobalSearch />
        {/* Roles without meetings.create (e.g. Compliance Auditor) would only reach Access denied. */}
        {can('meetings.create') && (
          <>
            <span className="hidden sm:block">
              <ButtonLink to="/schedule" leftIcon={<Plus className="size-4" />}>
                New Meeting
              </ButtonLink>
            </span>
            <ButtonLink to="/schedule" aria-label="New meeting" title="New meeting" className="size-10 px-0 sm:hidden">
              <Plus className="size-5" />
            </ButtonLink>
          </>
        )}
        <NotificationBell />
        <ProfileMenu />
      </div>
    </header>
  )
}

function GlobalSearch() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose<HTMLDivElement>(open, () => setOpen(false))
  const inputRef = useRef<HTMLInputElement>(null)
  // Phase 1: searches pages/modules. Phase 3 extends this to meetings, employees and customers via /api/v1/search.
  const results = useMemo(
    () => allNavItems.filter((i) => (!i.permission || can(i.permission)) && i.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6),
    [q, can],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const go = (to: string) => {
    navigate(to)
    setQ('')
    setOpen(false)
    inputRef.current?.blur()
  }
  return (
    <div ref={ref} className="relative hidden md:block">
      <label className="flex h-10 w-56 items-center gap-2 rounded-md border border-line bg-canvas px-3 text-ink-muted transition-[border-color,box-shadow,width] duration-200 focus-within:w-72 focus-within:border-brand-500 focus-within:bg-surface focus-within:shadow-focus xl:w-64">
        <Search className="size-4 shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => (setQ(e.target.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === 'Enter' && results[0] && go(results[0].to)}
          placeholder="Search pages…"
          aria-label="Global search"
          className="w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted [&:focus-visible]:shadow-none"
        />
        <kbd className="hidden whitespace-nowrap rounded border border-line bg-surface px-1.5 text-[10px] font-semibold text-ink-muted xl:block">Ctrl K</kbd>
      </label>
      <AnimatePresence>
        {open && q.trim() && (
          <motion.div {...dropdownMotion} className="absolute right-0 mt-2 w-72 overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-overlay">
            {results.length ? (
              results.map((r) => (
                <button key={r.to} onClick={() => go(r.to)} className="flex w-full items-center gap-3 rounded-sm px-2.5 py-2 text-left text-[13px] text-ink hover:bg-canvas">
                  <r.icon className="size-4 text-ink-secondary" />
                  {r.label}
                </button>
              ))
            ) : (
              <p className="px-3 py-4 text-center text-[13px] text-ink-secondary">No matching pages</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type BellItem = { id: string; title: string; time: string; read: boolean; icon?: { icon: React.ReactNode; cls: string } }

function NotificationBell() {
  const { can } = useAuth()
  // Demo mode keeps its local sample list (the demo adapters do not serve notifications). DEMO_MODE is a compile-time
  // constant, so the sample list is removed from production builds.
  if (DEMO_MODE) return <DemoNotificationBell />
  return can('notifications.view') ? <LiveNotificationBell /> : null
}

function DemoNotificationBell() {
  const [items, setItems] = useState<BellItem[]>([
    { id: '1', title: 'Claims Process Review starts in 10 minutes', time: 'Just now', read: false },
    { id: '2', title: 'Recording available: PLVC — Term Life Policy Verification', time: '18 min ago', read: false },
    { id: '3', title: 'Meera Iyer accepted your invitation', time: '4 h ago', read: true },
  ])
  return (
    <BellDropdown
      items={items}
      unread={items.filter((i) => !i.read).length}
      onItem={(n) => setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)))}
      onMarkAll={() => setItems((xs) => xs.map((x) => ({ ...x, read: true })))}
    />
  )
}

const UNREAD_POLL_MS = 60_000

/** Real notifications: unread badge polled every 60 s, latest items loaded when the menu opens. */
function LiveNotificationBell() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const tz = user?.timeZone || DEFAULT_TIME_ZONE
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<AppNotification[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refreshCount = useCallback(() => {
    notificationsApi
      .unreadCount()
      .then((r) => setUnread(r.unreadCount))
      .catch(() => {
        /* the badge keeps its last value; the next poll tries again */
      })
  }, [])

  useEffect(() => {
    refreshCount()
    const t = window.setInterval(() => !document.hidden && refreshCount(), UNREAD_POLL_MS)
    window.addEventListener(NOTIFICATIONS_CHANGED, refreshCount)
    return () => {
      window.clearInterval(t)
      window.removeEventListener(NOTIFICATIONS_CHANGED, refreshCount)
    }
  }, [refreshCount])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    notificationsApi
      .list({ page: 1, pageSize: 8 })
      .then((r) => {
        setItems(r.items)
        setUnread(r.unreadCount)
      })
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : 'Unable to load notifications.'))
      .finally(() => setLoading(false))
  }, [])

  async function openItem(id: string) {
    const n = items?.find((x) => x.id === id)
    if (!n) return
    if (!n.isRead) {
      try {
        await notificationsApi.markRead(n.id)
        setItems((xs) => xs?.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)) ?? null)
        setUnread((u) => Math.max(0, u - 1))
      } catch {
        /* still navigate; the item stays unread */
      }
    }
    const link = safeLink(n.linkPath)
    if (link) navigate(link)
  }

  async function markAll() {
    try {
      await notificationsApi.markAllRead()
      setItems((xs) => xs?.map((x) => ({ ...x, isRead: true })) ?? null)
      setUnread(0)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The notifications could not be marked as read.')
    }
  }

  return (
    <BellDropdown
      unread={unread}
      onOpen={load}
      loading={loading && !items}
      error={error}
      onRetry={load}
      items={(items ?? []).map((n) => ({ id: n.id, title: n.title, time: formatRelative(n.createdUtc, tz), read: n.isRead, icon: notificationIcon(n.type) }))}
      onItem={(n) => void openItem(n.id)}
      onMarkAll={() => void markAll()}
      closeOnItem
    />
  )
}

function BellDropdown({ items, unread, onItem, onMarkAll, onOpen, loading, error, onRetry, closeOnItem }: {
  items: BellItem[]
  unread: number
  onItem: (n: BellItem) => void
  onMarkAll: () => void
  onOpen?: () => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  closeOnItem?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose<HTMLDivElement>(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <IconButton
        label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        badge={unread}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen((o) => !o)
        }}
        aria-expanded={open}
      >
        <Bell className="size-5" />
      </IconButton>
      <AnimatePresence>
        {open && (
          <motion.div {...dropdownMotion} className="absolute right-0 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-overlay">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <p className="text-[14px] font-semibold">Notifications</p>
              <button
                disabled={!unread}
                onClick={onMarkAll}
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-700 hover:underline disabled:text-ink-muted disabled:no-underline"
              >
                <CheckCheck className="size-3.5" /> Mark all read
              </button>
            </div>
            {error ? (
              <div className="px-4 py-6 text-center text-[13px] text-danger" role="alert">
                <p>{error}</p>
                {onRetry && (
                  <button type="button" onClick={onRetry} className="mt-2 font-semibold text-brand-700 hover:underline">
                    Try again
                  </button>
                )}
              </div>
            ) : loading ? (
              <p className="flex items-center justify-center gap-2 px-4 py-8 text-[13px] text-ink-secondary" role="status">
                <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading notifications…
              </p>
            ) : items.length ? (
              <ul className="max-h-80 overflow-y-auto">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => {
                        onItem(n)
                        if (closeOnItem) setOpen(false)
                      }}
                      className={cn('flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas', !n.read && 'bg-brand-50/50')}
                    >
                      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', n.icon?.cls ?? 'bg-brand-50 text-brand-500')}>
                        {n.icon?.icon ?? <CalendarClock className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-[13px] leading-5', n.read ? 'text-ink-secondary' : 'font-semibold text-ink')}>{n.title}</span>
                        <span className="text-[11.5px] text-ink-muted">{n.time}</span>
                      </span>
                      {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-[13px] text-ink-secondary">You're all caught up.</p>
            )}
            <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-[13px] font-semibold text-brand-700 hover:bg-canvas">
              View all notifications
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ProfileMenu() {
  const { user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose<HTMLDivElement>(open, () => setOpen(false))
  if (!user) return null
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2.5 rounded-md py-1 pr-1.5 pl-1 transition-colors hover:bg-navy-900/5 sm:pr-2"
      >
        <Avatar name={user.displayName} src={user.photoUrl} size={34} />
        <span className="hidden min-w-0 text-left lg:block">
          <span className="block max-w-36 truncate text-[13px] leading-[18px] font-semibold text-ink">{user.displayName}</span>
          <span className="block max-w-36 truncate text-[11.5px] leading-4 text-ink-secondary">{user.department}</span>
        </span>
        <ChevronDown className={cn('hidden size-4 text-ink-muted transition-transform duration-200 lg:block', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...dropdownMotion} role="menu" className="absolute right-0 mt-2 w-64 overflow-hidden rounded-lg border border-line bg-surface shadow-overlay">
            <div className="flex items-center gap-3 border-b border-line p-4">
              <Avatar name={user.displayName} size={40} />
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-semibold">{user.displayName}</p>
                <p className="truncate text-[12px] text-ink-secondary">{user.designation}</p>
                <p className="truncate text-[11.5px] text-ink-muted">{user.employeeCode} · {user.email}</p>
              </div>
            </div>
            <div className="p-1.5">
              <MenuLink to="/settings" icon={<UserRound className="size-4" />} onClick={() => setOpen(false)}>My profile &amp; settings</MenuLink>
              <MenuLink to="/change-password" icon={<KeyRound className="size-4" />} onClick={() => setOpen(false)}>Change password</MenuLink>
            </div>
            <div className="border-t border-line p-1.5">
              <button role="menuitem" onClick={() => void signOut('user')} className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] font-medium text-danger hover:bg-danger-soft">
                <LogOut className="size-4" /> Logout
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MenuLink({ to, icon, children, onClick }: { to: string; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <Link role="menuitem" to={to} onClick={onClick} className="flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] font-medium text-ink hover:bg-canvas">
      <span className="text-ink-secondary">{icon}</span>
      {children}
    </Link>
  )
}
