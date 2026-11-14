import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useLocalParticipant, useRoomContext } from '@livekit/components-react'
import { Room, RoomEvent, Track, type LocalAudioTrack, type LocalTrackPublication, type LocalVideoTrack } from 'livekit-client'
import { Ban, ImagePlus, LoaderCircle, SwitchCamera, Wand2 } from 'lucide-react'
import type { RoomFeatures } from '../../../api/roomFeatures'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'

// Optional camera/microphone effects (13 Nov 2026). Everything runs in the participant's own browser: the camera picture is
// never uploaded anywhere for processing. Background segmentation = MediaPipe selfie segmenter (Apache-2.0) through
// @livekit/track-processors (Apache-2.0), both self-hosted under /meet/mediapipe - no CDN at run time.

const BASE = import.meta.env.BASE_URL
const ASSETS = { tasksVisionFileSet: `${BASE}mediapipe/wasm`, modelAssetPath: `${BASE}mediapipe/selfie_segmenter.tflite` }

export const BACKGROUNDS = [
  { id: 'office', label: 'Modern office', src: `${BASE}backgrounds/modern-office.svg` },
  { id: 'blue', label: 'OneInsure blue', src: `${BASE}backgrounds/oneinsure-blue.svg` },
  { id: 'grey', label: 'Neutral grey', src: `${BASE}backgrounds/neutral-grey.svg` },
  { id: 'studio', label: 'Soft studio', src: `${BASE}backgrounds/soft-studio.svg` },
] as const

export type BackgroundChoice = { kind: 'none' } | { kind: 'blur' } | { kind: 'image'; id: string; src: string }

type Wrapper = Awaited<ReturnType<typeof loadProcessor>>
async function loadProcessor(choice: Exclude<BackgroundChoice, { kind: 'none' }>) {
  const { BackgroundProcessor } = await import('@livekit/track-processors')
  return BackgroundProcessor(choice.kind === 'blur' ? { mode: 'background-blur', blurRadius: 12, assetPaths: ASSETS } : { mode: 'virtual-background', imagePath: choice.src, assetPaths: ASSETS })
}

function backgroundSupported() {
  // Same test the library uses (WebGL2 + OffscreenCanvas or canvas capture), without loading the library up front.
  try {
    const c = document.createElement('canvas')
    return !!c.getContext('webgl2') && typeof HTMLCanvasElement.prototype.captureStream === 'function'
  } catch {
    return false
  }
}

export function useMediaEffects(features: RoomFeatures) {
  const room = useRoomContext()
  const { localParticipant } = useLocalParticipant()
  const toast = useToast()
  const [background, setBackgroundState] = useState<BackgroundChoice>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [noiseOn, setNoiseOn] = useState(true) // the room's existing default: browser noise suppression + echo cancellation + AGC
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const processor = useRef<Wrapper | null>(null)
  const wanted = useRef<BackgroundChoice>({ kind: 'none' })
  const customUrl = useRef<string | null>(null)
  const supported = features.backgroundEffects && backgroundSupported()

  const cameraTrack = useCallback(
    () => localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined,
    [localParticipant],
  )

  /** Applies the wanted effect to the current camera track. Any failure falls back to the original camera picture. */
  const apply = useCallback(async () => {
    const track = cameraTrack()
    const choice = wanted.current
    if (!track) return // camera off: applied when it is published
    setBusy(true)
    try {
      if (choice.kind === 'none') {
        if (processor.current) await track.stopProcessor()
        processor.current = null
      } else if (processor.current && track.getProcessor() === processor.current) {
        await processor.current.switchTo(choice.kind === 'blur' ? { mode: 'background-blur', blurRadius: 12 } : { mode: 'virtual-background', imagePath: choice.src })
      } else {
        const p = await loadProcessor(choice)
        await track.setProcessor(p)
        processor.current = p
      }
    } catch {
      toast.error('The background effect could not be started on this device. Your normal camera picture is used.')
      wanted.current = { kind: 'none' }
      setBackgroundState({ kind: 'none' })
      processor.current = null
      await track.stopProcessor().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }, [cameraTrack, toast])

  const setBackground = useCallback(
    (c: BackgroundChoice) => {
      wanted.current = c
      setBackgroundState(c)
      void apply()
    },
    [apply],
  )

  // Camera turned on later (or republished): re-apply the chosen effect.
  useEffect(() => {
    if (!supported) return
    const onPublished = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.Camera && wanted.current.kind !== 'none') {
        processor.current = null
        void apply()
      }
    }
    localParticipant.on('localTrackPublished', onPublished)
    return () => {
      localParticipant.off('localTrackPublished', onPublished)
    }
  }, [supported, localParticipant, apply])

  useEffect(() => () => {
    if (customUrl.current) URL.revokeObjectURL(customUrl.current)
  }, [])

  const useCustomImage = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
        toast.error('Choose a JPG or PNG picture smaller than 8 MB.')
        return
      }
      // Stays in this browser: an object URL, never uploaded.
      if (customUrl.current) URL.revokeObjectURL(customUrl.current)
      customUrl.current = URL.createObjectURL(file)
      setBackground({ kind: 'image', id: 'custom', src: customUrl.current })
    },
    [setBackground, toast],
  )

  // ---- Noise suppression (browser-native WebRTC processing; echo cancellation always stays on) ----
  const setNoise = useCallback(
    async (on: boolean) => {
      const mic = localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack as LocalAudioTrack | undefined
      setNoiseOn(on)
      if (!mic) return
      const deviceId = mic.mediaStreamTrack?.getSettings().deviceId
      try {
        await mic.restartTrack({ deviceId, echoCancellation: true, noiseSuppression: on, autoGainControl: on })
      } catch {
        toast.error('The microphone setting could not be changed. Your microphone keeps its previous setting.')
        setNoiseOn(!on)
        await mic.restartTrack({ deviceId, echoCancellation: true, noiseSuppression: !on, autoGainControl: !on }).catch(() => undefined)
      }
    },
    [localParticipant, toast],
  )

  // ---- Camera switching (front/rear on phones; laptop/USB cameras on computers) ----
  useEffect(() => {
    if (!features.cameraFlip) return
    let alive = true
    const read = () => void Room.getLocalDevices('videoinput', false).then((d) => alive && setCameras(d.filter((x) => x.deviceId))).catch(() => undefined)
    read()
    navigator.mediaDevices?.addEventListener?.('devicechange', read)
    room.on(RoomEvent.MediaDevicesChanged, read)
    return () => {
      alive = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', read)
      room.off(RoomEvent.MediaDevicesChanged, read)
    }
  }, [features.cameraFlip, room])

  const flipCamera = useCallback(async () => {
    if (cameras.length < 2) return
    const active = room.getActiveDevice('videoinput')
    const i = cameras.findIndex((c) => c.deviceId === active)
    const next = cameras[(i + 1) % cameras.length]
    try {
      // Replaces the camera track in place: the call, the recording and everyone's view continue.
      await room.switchActiveDevice('videoinput', next.deviceId)
    } catch {
      toast.error('Could not switch to the other camera. It may be in use by another app.')
    }
  }, [cameras, room, toast])

  return {
    supported,
    background,
    setBackground,
    useCustomImage,
    busy,
    noiseEnabled: features.noiseSuppression,
    noiseOn,
    setNoise,
    canFlip: features.cameraFlip && cameras.length > 1,
    flipCamera,
    backgroundEnabled: features.backgroundEffects,
  }
}

export type MediaEffects = ReturnType<typeof useMediaEffects>

/** The extra section shown in the room's Settings panel (only the parts that are switched on). */
export function EffectsSettings({ fx }: { fx: MediaEffects }) {
  const file = useRef<HTMLInputElement>(null)
  if (!fx.backgroundEnabled && !fx.noiseEnabled && !fx.canFlip) return null
  const isBg = (id: string) => fx.background.kind === 'image' && fx.background.id === id
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) fx.useCustomImage(f)
    e.target.value = ''
  }
  return (
    <div className="flex flex-col gap-4" data-testid="effects-settings">
      {fx.canFlip && (
        <button type="button" onClick={() => void fx.flipCamera()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white/[0.08] text-[13px] font-semibold hover:bg-white/[0.14]" data-testid="flip-camera">
          <SwitchCamera className="size-4" aria-hidden /> Switch camera
        </button>
      )}
      {fx.backgroundEnabled && (
        <section className="flex flex-col gap-2" aria-label="Background effects">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-white/80">Background</span>
            {fx.busy && <LoaderCircle className="size-4 animate-spin text-cyan-300" aria-label="Applying" />}
          </div>
          {!fx.supported ? (
            <p className="rounded-md bg-white/5 px-3 py-2.5 text-[12px] leading-5 text-white/60">This browser or device can’t run background effects. Your normal camera picture is used.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <EffectTile label="None" active={fx.background.kind === 'none'} onClick={() => fx.setBackground({ kind: 'none' })} testId="bg-none">
                  <Ban className="size-5 text-white/70" />
                </EffectTile>
                <EffectTile label="Blur" active={fx.background.kind === 'blur'} onClick={() => fx.setBackground({ kind: 'blur' })} testId="bg-blur">
                  <Wand2 className="size-5 text-white/70" />
                </EffectTile>
                <EffectTile label="Your picture" active={isBg('custom')} onClick={() => file.current?.click()} testId="bg-custom">
                  <ImagePlus className="size-5 text-white/70" />
                </EffectTile>
                {BACKGROUNDS.map((b) => (
                  <EffectTile key={b.id} label={b.label} active={isBg(b.id)} onClick={() => fx.setBackground({ kind: 'image', id: b.id, src: b.src })} testId={`bg-${b.id}`} image={b.src} />
                ))}
              </div>
              <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onFile} data-testid="bg-file" />
              <p className="text-[11.5px] leading-4 text-white/50">Processed on your device only. On slower devices the picture may be less smooth - choose “None” to switch it off.</p>
            </>
          )}
        </section>
      )}
      {fx.noiseEnabled && (
        <label className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.05] px-3 py-2.5">
          <span>
            <span className="block text-[12.5px] font-semibold text-white/85">Background noise suppression</span>
            <span className="block text-[11.5px] leading-4 text-white/50">Reduces fans, traffic and typing. Turn off to play music or for a very quiet room. Echo cancellation always stays on.</span>
          </span>
          <input type="checkbox" className="mt-1 size-4 accent-cyan-400" checked={fx.noiseOn} onChange={(e) => void fx.setNoise(e.target.checked)} data-testid="noise-toggle" />
        </label>
      )}
    </div>
  )
}

function EffectTile({ label, active, onClick, children, image, testId }: { label: string; active: boolean; onClick: () => void; children?: React.ReactNode; image?: string; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn('relative flex aspect-video flex-col items-center justify-center gap-1 overflow-hidden rounded-lg bg-white/[0.07] text-[10.5px] text-white/75 ring-2 transition', active ? 'ring-cyan-400' : 'ring-transparent hover:bg-white/[0.12]')}
      data-testid={testId}
    >
      {image ? <img src={image} alt="" className="absolute inset-0 size-full object-cover" /> : children}
      <span className={cn('relative', image && 'mt-auto w-full bg-black/45 py-0.5')}>{label}</span>
    </button>
  )
}
