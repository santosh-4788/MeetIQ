import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTrackVolume } from '@livekit/components-react'
import { createLocalAudioTrack, createLocalVideoTrack, type LocalAudioTrack, type LocalVideoTrack } from 'livekit-client'
import { CameraOff, CircleAlert, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { ConnectLogo } from '../../components/brand/ConnectLogo'
import { cn } from '../../lib/cn'
import { CanvasButton } from './RoomScreens'

/** What the participant chose before joining. Device ids are remembered on this browser. */
export type MediaChoices = { audioEnabled: boolean; videoEnabled: boolean; audioDeviceId: string; videoDeviceId: string }

const STORAGE_KEY = 'oic.room.devices'

function loadChoices(): MediaChoices {
  const fallback: MediaChoices = { audioEnabled: true, videoEnabled: true, audioDeviceId: '', videoDeviceId: '' }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<MediaChoices>) } : fallback
  } catch {
    return fallback
  }
}

function saveChoices(c: MediaChoices) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  } catch {
    /* private mode: not remembered */
  }
}

type MediaProblem = { kind: 'denied' | 'missing' | 'busy' | 'other'; device: 'camera' | 'microphone' }

function classify(e: unknown, device: MediaProblem['device']): MediaProblem {
  const name = e instanceof Error ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return { kind: 'denied', device }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return { kind: 'missing', device }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return { kind: 'busy', device }
  return { kind: 'other', device }
}

/** The live preview tracks, handed to the room on join so the devices are not released and re-opened (no busy-device race). */
export type PreviewTracks = { audio?: LocalAudioTrack; video?: LocalVideoTrack }

/**
 * Live preview of one device; recreated when the device or the on/off choice changes, stopped on unmount unless
 * `handOver` is set (then the room owns the track).
 */
function usePreview<T extends LocalAudioTrack | LocalVideoTrack>(enabled: boolean, deviceId: string, create: (deviceId?: string) => Promise<T>, handOver: { current: boolean }) {
  const [track, setTrack] = useState<T | null>(null)
  const [problem, setProblem] = useState<unknown>(null)
  useEffect(() => {
    if (!enabled) {
      setTrack(null)
      return
    }
    let cancelled = false
    let created: T | null = null
    const attempt = (retry: boolean): Promise<T> =>
      create(deviceId || undefined).catch(async (e: unknown) => {
        // A device that was just released by another capture can report "busy" / "timeout starting" once.
        const name = e instanceof Error ? e.name : ''
        if (!retry || cancelled || !['AbortError', 'NotReadableError', 'TrackStartError'].includes(name)) throw e
        await new Promise((r) => setTimeout(r, 900))
        return attempt(false)
      })
    // Started a moment later so React's development double-mount does not open the device twice.
    const timer = window.setTimeout(() => {
      attempt(true)
        .then((t) => {
          if (cancelled) t.stop()
          else {
            created = t
            setTrack(t)
            setProblem(null)
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setTrack(null)
            setProblem(e)
          }
        })
    }, 60)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (!handOver.current) created?.stop()
    }
    // `create` and `handOver` are stable.
  }, [enabled, deviceId, create, handOver])
  return { track, problem }
}

const createMic = (deviceId?: string) => createLocalAudioTrack({ deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true })
const createCam = (deviceId?: string) => createLocalVideoTrack({ deviceId, resolution: { width: 1280, height: 720, frameRate: 24 } })

/**
 * Pre-join: camera and microphone preview with device selection, on/off toggles and help when the browser blocks access.
 * Guests also choose the name shown to others. Joining without camera or microphone is always possible.
 */
export function PreJoin({
  title,
  details,
  name,
  onNameChange,
  nameEditable,
  canPublish = true,
  cameraAllowed = true,
  initialVideo,
  joinLabel,
  busy,
  error,
  onJoin,
  onCancel,
  cancelLabel = 'Back',
  footnote,
}: {
  title: string
  details: ReactNode
  name: string
  onNameChange?: (name: string) => void
  nameEditable?: boolean
  canPublish?: boolean
  /** False in audio-only meetings: no camera preview or choice. */
  cameraAllowed?: boolean
  /** Overrides the remembered camera choice for this join (e.g. "start with my camera off"). */
  initialVideo?: boolean
  joinLabel: string
  busy: boolean
  error: string | null
  /** Resolves true when the room opens (the preview tracks then belong to it), false to stay on this screen. */
  onJoin: (choices: MediaChoices, tracks: PreviewTracks) => Promise<boolean>
  onCancel?: () => void
  cancelLabel?: string
  footnote?: ReactNode
}) {
  const [choices, setChoices] = useState<MediaChoices>(() => {
    const c = loadChoices()
    return initialVideo === undefined ? c : { ...c, videoEnabled: initialVideo }
  })
  const handOver = useRef(false)
  const camOk = canPublish && cameraAllowed
  const mic = usePreview(canPublish && choices.audioEnabled, choices.audioDeviceId, createMic, handOver)
  const cam = usePreview(camOk && choices.videoEnabled, choices.videoDeviceId, createCam, handOver)
  // Enumerated without opening the devices again (labels are available once the preview has permission).
  const devices = useDeviceList(!!mic.track || !!cam.track)
  const mics = devices.filter((d) => d.kind === 'audioinput')
  const cams = devices.filter((d) => d.kind === 'videoinput')
  const level = useTrackVolume(mic.track ?? undefined)
  const video = useRef<HTMLVideoElement>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => {
    const el = video.current
    if (!cam.track || !el) return
    cam.track.attach(el)
    return () => {
      cam.track?.detach(el)
    }
  }, [cam.track])

  const set = (patch: Partial<MediaChoices>) =>
    setChoices((c) => {
      const next = { ...c, ...patch }
      saveChoices(next)
      return next
    })

  const problems = [mic.problem ? classify(mic.problem, 'microphone') : null, cam.problem ? classify(cam.problem, 'camera') : null].filter(
    (p): p is MediaProblem => !!p,
  )

  function submit(e: FormEvent) {
    e.preventDefault()
    if (nameEditable && !name.trim()) {
      setNameError('Enter your name so the host knows who you are.')
      return
    }
    setNameError(null)
    // A device that failed joins switched off (the participant can turn it on later in the room).
    const final = { ...choices, audioEnabled: choices.audioEnabled && !mic.problem && canPublish, videoEnabled: choices.videoEnabled && !cam.problem && camOk }
    const tracks: PreviewTracks = { audio: final.audioEnabled ? (mic.track ?? undefined) : undefined, video: final.videoEnabled ? (cam.track ?? undefined) : undefined }
    // Hand the running tracks over before the screen can unmount; take them back if joining fails.
    handOver.current = true
    void onJoin(final, tracks).then(
      (joined) => {
        if (!joined) handOver.current = false
      },
      () => {
        handOver.current = false
      },
    )
  }

  return (
    <div className="oic-room-canvas fixed inset-0 z-40 flex flex-col overflow-y-auto text-white">
      <header className="flex h-16 shrink-0 items-center justify-between px-5 sm:px-8">
        <ConnectLogo tone="light" size={30} />
        <span className="hidden text-[12.5px] text-white/55 sm:inline">Check your camera and microphone before joining</span>
      </header>
      <form onSubmit={submit} className="mx-auto grid w-full max-w-[1120px] flex-1 grid-cols-1 items-center gap-6 px-4 pb-10 sm:px-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-10">
        {/* Preview */}
        <section aria-label="Camera preview" className="animate-fade-up">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-white/10 bg-[linear-gradient(160deg,#17385A,#102A43)] shadow-[0_24px_60px_rgb(0_0_0/0.35)]">
            <video ref={video} muted playsInline autoPlay data-testid="prejoin-preview" className={cn('size-full -scale-x-100 object-cover', !cam.track && 'hidden')} />
            {!cam.track && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70">
                <span className="oic-tile-avatar !w-24">{initialsOf(name)}</span>
                <p className="text-[13px]">{!canPublish ? 'You join as a listener' : !cameraAllowed ? 'Audio-only meeting' : choices.videoEnabled ? (cam.problem ? 'Camera unavailable' : 'Starting camera…') : 'Camera is off'}</p>
              </div>
            )}
            {canPublish && (
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-gradient-to-t from-black/50 to-transparent p-4">
                <button
                  type="button"
                  className="oic-ctl"
                  data-off={!choices.audioEnabled || undefined}
                  aria-pressed={choices.audioEnabled}
                  aria-label={choices.audioEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                  title={choices.audioEnabled ? 'Turn microphone off' : 'Turn microphone on'}
                  onClick={() => set({ audioEnabled: !choices.audioEnabled })}
                >
                  {choices.audioEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
                </button>
                {cameraAllowed && <button
                  type="button"
                  className="oic-ctl"
                  data-off={!choices.videoEnabled || undefined}
                  aria-pressed={choices.videoEnabled}
                  aria-label={choices.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
                  title={choices.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
                  onClick={() => set({ videoEnabled: !choices.videoEnabled })}
                >
                  {choices.videoEnabled ? <Video className="size-5" /> : <VideoOff className="size-5" />}
                </button>}
              </div>
            )}
            {mic.track && (
              <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/40 px-3 py-1.5 text-[12px] backdrop-blur" aria-hidden>
                <Mic className="size-3.5 text-cyan-400" />
                <span className="flex h-2 w-20 overflow-hidden rounded-full bg-white/15">
                  <span className="h-full rounded-full bg-cyan-400 transition-[width] duration-100" style={{ width: `${Math.min(100, Math.round(level * 180))}%` }} />
                </span>
              </div>
            )}
          </div>
          {problems.length > 0 && <MediaHelp problems={problems} />}
        </section>

        {/* Details and join */}
        <section className="animate-fade-up rounded-xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-md sm:p-7">
          <p className="eyebrow text-cyan-400">Ready to join?</p>
          <h1 className="mt-2 text-[22px] leading-8 font-bold tracking-[-0.01em] break-words">{title}</h1>
          <div className="mt-1.5 text-[13.5px] leading-6 text-white/65">{details}</div>

          <div className="mt-6 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold text-white/80">Your name</span>
              {nameEditable ? (
                <input
                  className="oic-input"
                  value={name}
                  maxLength={80}
                  autoComplete="name"
                  onChange={(e) => onNameChange?.(e.target.value)}
                  aria-invalid={!!nameError || undefined}
                  data-testid="prejoin-name"
                />
              ) : (
                <span className="oic-input !bg-white/[0.03] text-white/85">{name}</span>
              )}
              {nameError && <span role="alert" className="text-[12.5px] font-medium text-[#FCA5A5]">{nameError}</span>}
            </label>
            {canPublish && (
              <>
                {cameraAllowed && <DeviceSelect label="Camera" devices={cams} value={choices.videoDeviceId} onChange={(id) => set({ videoDeviceId: id })} disabled={!choices.videoEnabled} />}
                <DeviceSelect label="Microphone" devices={mics} value={choices.audioDeviceId} onChange={(id) => set({ audioDeviceId: id })} disabled={!choices.audioEnabled} />
              </>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-5 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/15 px-3.5 py-3 text-[13px] text-[#FECACA]">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            {onCancel && (
              <CanvasButton variant="secondary" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </CanvasButton>
            )}
            <CanvasButton type="submit" disabled={busy} leftIcon={busy ? <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : <Video className="size-4" />}>
              {joinLabel}
            </CanvasButton>
          </div>
          {footnote && <p className="mt-5 text-[12px] leading-5 text-white/50">{footnote}</p>}
        </section>
      </form>
    </div>
  )
}

/** Cameras and microphones, refreshed when permission arrives and when devices are plugged in or out. */
function useDeviceList(permitted: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) return
    let alive = true
    const load = () =>
      md
        .enumerateDevices()
        .then((list) => alive && setDevices(list))
        .catch(() => undefined)
    void load()
    md.addEventListener('devicechange', load)
    return () => {
      alive = false
      md.removeEventListener('devicechange', load)
    }
  }, [permitted])
  return devices
}

function DeviceSelect({ label, devices, value, onChange, disabled }: { label: string; devices: MediaDeviceInfo[]; value: string; onChange: (id: string) => void; disabled: boolean }) {
  const list = devices.filter((d) => d.deviceId)
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold text-white/80">{label}</span>
      <select className="oic-input oic-select disabled:opacity-50" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || list.length === 0}>
        <option value="">{list.length === 0 ? `No ${label.toLowerCase()} found` : 'System default'}</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  )
}

function MediaHelp({ problems }: { problems: MediaProblem[] }) {
  const denied = problems.some((p) => p.kind === 'denied')
  const what = problems.map((p) => p.device).join(' and ')
  return (
    <div role="alert" className="mt-4 flex gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3.5 text-[13px] leading-5 text-[#FDE68A]">
      <CameraOff className="mt-0.5 size-[18px] shrink-0 text-warning" aria-hidden />
      <div>
        {denied ? (
          <>
            <p className="font-semibold text-white">The browser is blocking your {what}</p>
            <p className="mt-1 text-white/75">
              Click the camera icon or the padlock at the left of the address bar, choose <strong className="text-white">Allow</strong> for camera and
              microphone, then reload this page. In Windows, also check <em>Settings → Privacy &amp; security → Camera / Microphone</em>. You can still join
              and listen without them.
            </p>
          </>
        ) : problems.some((p) => p.kind === 'busy') ? (
          <>
            <p className="font-semibold text-white">Your {what} is in use by another application</p>
            <p className="mt-1 text-white/75">Close other video apps (Teams, Zoom, the Camera app) or choose another device, then try again.</p>
          </>
        ) : (
          <>
            <p className="font-semibold text-white">No working {what} found</p>
            <p className="mt-1 text-white/75">Connect a device or pick another one in the list. You can still join without it.</p>
          </>
        )}
      </div>
    </div>
  )
}

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
