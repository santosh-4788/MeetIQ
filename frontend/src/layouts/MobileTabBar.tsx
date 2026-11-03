import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Bell, CalendarDays, LayoutDashboard, Plus, Video } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { cn } from '../lib/cn'
import { NewMeetingDialog } from '../pages/meetings/QuickMeetingDialogs'

/**
 * Phones (Android / iOS): bottom tab bar with the most used places and a central "New meeting" button, like a native app.
 * Only destinations the user may open are shown; everything else stays in the menu (top left).
 */
export function MobileTabBar() {
  const { can } = useAuth()
  const [starting, setStarting] = useState(false)
  const tabs = [
    can('dashboard.view') && { to: '/dashboard', label: 'Home', icon: LayoutDashboard },
    can('meetings.view.own') && { to: '/meetings', label: 'Meetings', icon: Video },
    can('meetings.create') && { to: '', label: 'New', icon: Plus },
    can('calendar.view') && { to: '/calendar', label: 'Calendar', icon: CalendarDays },
    can('notifications.view') && { to: '/notifications', label: 'Alerts', icon: Bell },
  ].filter((t): t is { to: string; label: string; icon: typeof Plus } => !!t)
  if (tabs.length < 2) return null

  return (
    <>
      <nav aria-label="Quick navigation" className="oic-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur md:hidden" data-testid="mobile-tabbar">
        <ul className="mx-auto flex max-w-[560px] items-stretch justify-around">
          {tabs.map(({ to, label, icon: Icon }) =>
            to ? (
              <li key={to} className="flex-1">
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    cn('flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors', isActive ? 'text-brand-600' : 'text-ink-muted')
                  }
                >
                  <Icon className="size-[22px]" aria-hidden />
                  {label}
                </NavLink>
              </li>
            ) : (
              <li key="new" className="flex flex-1 justify-center">
                <button
                  type="button"
                  onClick={() => setStarting(true)}
                  className="-mt-4 flex size-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-[0_8px_20px_rgb(40_120_229/0.45)] active:scale-95"
                  aria-label="Start a new meeting"
                  data-testid="tab-new-meeting"
                >
                  <Plus className="size-7" />
                </button>
              </li>
            ),
          )}
        </ul>
      </nav>
      <NewMeetingDialog open={starting} onClose={() => setStarting(false)} />
    </>
  )
}
