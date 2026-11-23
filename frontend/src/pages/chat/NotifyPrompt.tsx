import { useCallback, useState } from 'react'
import { BellRing, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { appNotifyPermission, inAndroidApp } from '../room/androidBridge'

// Notification permission and the one-time prompt, shared by Chat and Tasks (moved here 23 Nov 2026 so the chat page
// does not load the task screens).

const APP_NOTIFY_KEY = 'oic.app.notify'
const readAppPerm = (): NotificationPermission => {
  try {
    return (localStorage.getItem(APP_NOTIFY_KEY) as NotificationPermission | null) ?? 'default'
  } catch {
    return 'default'
  }
}

/**
 * Notification permission, asked only when the person taps the button (never on page load): the browser's, or inside
 * the Android app (1.2.0+) the app's phone notifications. inApp tells the screens which wording to use.
 */
export function useBrowserNotifications() {
  const inApp = inAndroidApp()
  const supported = inApp || (typeof window !== 'undefined' && 'Notification' in window)
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(inApp ? readAppPerm() : supported ? Notification.permission : 'unsupported')
  const ask = useCallback(async () => {
    if (!supported) return
    if (inApp) {
      const ok = await appNotifyPermission()
      const v: NotificationPermission = ok ? 'granted' : 'denied'
      setPerm(v)
      try {
        localStorage.setItem(APP_NOTIFY_KEY, v)
      } catch {
        /* private mode */
      }
      return
    }
    try {
      setPerm(await Notification.requestPermission())
    } catch {
      /* older Safari: callback form only */
    }
  }, [supported, inApp])
  return { perm, ask, inApp }
}

const PROMPT_KEY = 'oic.tasks.notify-prompt'

function readDismissed() {
  try {
    return localStorage.getItem(PROMPT_KEY) === 'no'
  } catch {
    return false
  }
}

/** One-time, dismissible prompt to allow browser notifications (asked only when tapped, never on load). */
export function NotifyPrompt({ className }: { className?: string } = {}) {
  const { perm, ask } = useBrowserNotifications()
  const [hidden, setHidden] = useState(readDismissed)
  if (perm !== 'default' || hidden) return null
  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(PROMPT_KEY, 'no')
    } catch {
      /* private mode */
    }
  }
  return (
    <div className={cn('flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-xs', className ?? 'mx-auto mb-3 max-w-[1100px]')} data-testid="notify-prompt">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--ios-red)] text-white"><BellRing className="size-4" /></span>
      <p className="min-w-0 flex-1 text-[14px] leading-[18px]"><b>Never miss a message, call or task.</b> <span className="text-[var(--ios-label2)]">Get a notification even when the portal is in the background.</span></p>
      <button type="button" onClick={() => void ask()} className="ios-btn-filled h-[32px] shrink-0 px-3 text-[14px]" data-testid="notify-prompt-on">Turn on</button>
      <button type="button" onClick={dismiss} aria-label="Not now" className="text-[var(--ios-gray2)]"><X className="size-4" /></button>
    </div>
  )
}

