import { useEffect, useSyncExternalStore, useState } from 'react'
import { useRoomContext } from '@livekit/components-react'
import { Mic, Video } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Overlay'

/**
 * GoodDay #14222: "if the customer has not given permission to camera and microphone, clicking the icons should redirect to settings".
 * A web page cannot open the browser's or the phone's settings (browsers do not allow it), so the closest safe behaviour is:
 *  - tapping a blocked camera / microphone opens this dialog (not a toast that disappears) with the exact steps for this phone
 *    and browser;
 *  - "Try again" asks the browser again - where the browser still allows it, its own "Allow" prompt appears;
 *  - while the dialog is open, the browser's permission is watched: once the user allows it, the dialog closes and the
 *    device is turned on by itself.
 */
export type DeviceKind = 'microphone' | 'camera'

// A tiny store so every reporter (toolbar buttons, LiveKit device failures, publish-on-join) opens the same dialog.
let current: DeviceKind | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
export function openDeviceHelp(kind: DeviceKind) {
  current = kind
  emit()
}
function closeDeviceHelp() {
  current = null
  emit()
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** The browser's permission state for the device, or null when the browser cannot tell (then we simply try). */
export async function permissionState(kind: DeviceKind): Promise<PermissionState | null> {
  try {
    const s = await navigator.permissions?.query({ name: kind as PermissionName })
    return s?.state ?? null
  } catch {
    return null
  }
}

type Platform = 'android' | 'ios' | 'desktop'
function platform(): Platform {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  return 'desktop'
}
const browserName = () => (/CriOS|Chrome/i.test(navigator.userAgent) && !/Edg/i.test(navigator.userAgent) ? 'Chrome' : /Edg/i.test(navigator.userAgent) ? 'Edge' : /Firefox|FxiOS/i.test(navigator.userAgent) ? 'Firefox' : 'Safari')

export function deviceSteps(kind: DeviceKind, p: Platform = platform(), browser = browserName()): { steps: string[]; fallback?: string } {
  const Dev = kind === 'microphone' ? 'Microphone' : 'Camera'
  if (p === 'android')
    return {
      steps: ['Tap the icon at the left of the web address (a lock or settings icon).', 'Tap Permissions (or Site settings).', `Set ${Dev} to Allow.`],
      fallback: `Still blocked? Open your phone's Settings → Apps → ${browser === 'Safari' ? 'your browser' : browser} → Permissions → ${Dev} → Allow.`,
    }
  if (p === 'ios')
    return browser === 'Safari'
      ? { steps: ['Tap "aA" (or the page menu) in the address bar.', 'Tap Website Settings.', `Set ${Dev} to Allow.`], fallback: `Still blocked? Open the iPhone Settings → Apps → Safari → ${Dev} → Allow.` }
      : { steps: [`Open the iPhone Settings app.`, `Tap Apps → ${browser}.`, `Turn ${Dev} on.`], fallback: 'Then come back here and tap Try again.' }
  return { steps: ['Click the lock icon at the left of the web address.', 'Open Site settings (or Permissions).', `Set ${Dev} to Allow.`] }
}

/** Rendered once inside the LiveKit room. */
export function DeviceHelpDialog() {
  const kind = useSyncExternalStore(subscribe, () => current)
  const room = useRoomContext()
  const [trying, setTrying] = useState(false)
  const [stillBlocked, setStillBlocked] = useState(false)

  const enable = async (k: DeviceKind) => {
    const lp = room.localParticipant
    if (k === 'microphone') await lp.setMicrophoneEnabled(true)
    else await lp.setCameraEnabled(true)
  }

  // Watch the browser's permission while the dialog is open: allowed -> turn the device on and close.
  useEffect(() => {
    if (!kind) return
    setStillBlocked(false)
    let status: PermissionStatus | null = null
    let alive = true
    const onChange = () => {
      if (status?.state !== 'granted') return
      void enable(kind).then(() => alive && closeDeviceHelp()).catch(() => undefined)
    }
    navigator.permissions?.query({ name: kind as PermissionName }).then((s) => {
      if (!alive) return
      status = s
      s.addEventListener('change', onChange)
    }).catch(() => undefined)
    return () => {
      alive = false
      status?.removeEventListener('change', onChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  if (!kind) return null
  const Dev = kind === 'microphone' ? 'microphone' : 'camera'
  const { steps, fallback } = deviceSteps(kind)

  async function tryAgain() {
    setTrying(true)
    try {
      await enable(kind!)
      closeDeviceHelp()
    } catch {
      setStillBlocked(true)
    } finally {
      setTrying(false)
    }
  }

  return (
    <Dialog
      open
      onClose={closeDeviceHelp}
      size="sm"
      title={`Allow your ${Dev}`}
      footer={
        <>
          <Button variant="secondary" onClick={closeDeviceHelp} data-testid="device-help-close">Close</Button>
          <Button onClick={() => void tryAgain()} loading={trying} data-testid="device-help-retry">Try again</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13.5px] leading-[21px] text-ink-secondary" data-testid="device-help" data-kind={kind}>
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
            {kind === 'microphone' ? <Mic className="size-5" /> : <Video className="size-5" />}
          </span>
          <p>Your browser has blocked the {Dev} for this site. A website cannot open your settings itself, so please allow it there - it takes a few seconds:</p>
        </div>
        <ol className="flex flex-col gap-2" data-testid="device-help-steps">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[12px] font-bold text-white">{i + 1}</span>
              <span className="pt-0.5 text-ink">{s}</span>
            </li>
          ))}
        </ol>
        {fallback && <p className="text-[12.5px]">{fallback}</p>}
        <p className="text-[12.5px]">When you allow it, the {Dev} turns on by itself - or tap Try again.</p>
        {stillBlocked && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[12.5px] font-medium text-danger" data-testid="device-help-still-blocked">
            The {Dev} is still blocked. Follow the steps above, then tap Try again. If it still does not work, reload this page.
          </p>
        )}
      </div>
    </Dialog>
  )
}
