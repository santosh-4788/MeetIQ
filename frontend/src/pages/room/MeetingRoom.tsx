import '@livekit/components-styles'
import './room.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CarouselLayout,
  ConnectionQualityIndicator,
  FocusLayoutContainer,
  GridLayout,
  LayoutContextProvider,
  LiveKitRoom,
  ParticipantName,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  VideoTrack,
  isTrackReference,
  useConnectionQualityIndicator,
  useConnectionState,
  useEnsureTrackRef,
  useIsMuted,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useSpeakingParticipants,
  useTrackToggle,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react'
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type RemoteParticipant,
  type RoomOptions,
} from 'livekit-client'
import {
  Ellipsis, Hand, LayoutGrid, LoaderCircle, LogOut, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Presentation, Settings2, UserPlus, Users, Video, VideoOff, WifiOff,
} from 'lucide-react'
import type { RoomConnection, RoomMeetingInfo, WaitingEntry } from '../../api/room'
import { resolveLiveKitUrl } from '../../api/room'
import { errorMessage } from '../../api/types'
import { ACTIVITY_EVENT } from '../../auth/AuthContext'
import { ConnectMark } from '../../components/brand/ConnectLogo'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatTime, zoneLabel } from '../../lib/format'
import { initialsOf, type MediaChoices, type PreviewTracks } from './PreJoin'
import { ChatPanel, PeoplePanel, SettingsPanel, type ChatMessage } from './RoomPanels'
import { useRoomRecording } from './RecordingControls'
import { ShareLinkDialog } from '../meetings/MeetingLinkShare'
import { RoomUiContext, participantRole, useRoomUi, type RoomBackend, type RoomUi } from './roomUi'

export type { RoomBackend } from './roomUi'

export type RoomExit =
  | { kind: 'left' }
  | { kind: 'ended' }
  | { kind: 'removed' }
  | { kind: 'duplicate' }
  | { kind: 'error'; message: string }

const TOPIC_CHAT = 'oic.chat'
const TOPIC_HAND = 'oic.hand'
const TOPIC_WAITING = 'oic.waiting'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Connection settings for real-world networks: simulcast + dynacast + adaptive stream (each viewer receives only the layer
 * it can show and afford), Opus DTX + RED (audio survives packet loss), and audio marked high priority / video low so a
 * constrained uplink keeps the voice. ICE servers come from LiveKit itself (no third-party STUN/TURN).
 */
function roomOptions(): RoomOptions {
  return {
    adaptiveStream: { pixelDensity: 'screen' },
    dynacast: true,
    disconnectOnPageLeave: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoEncoding: { ...VideoPresets.h720.encoding, priority: 'low' },
      screenShareEncoding: { ...ScreenSharePresets.h1080fps15.encoding, priority: 'medium' },
      audioPreset: { maxBitrate: 32_000, priority: 'high' },
      dtx: true,
      red: true,
    },
  }
}

function exitFor(reason?: DisconnectReason): RoomExit {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return { kind: 'left' }
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return { kind: 'ended' }
    case DisconnectReason.PARTICIPANT_REMOVED:
      return { kind: 'removed' }
    case DisconnectReason.DUPLICATE_IDENTITY:
      return { kind: 'duplicate' }
    default:
      return { kind: 'error', message: 'The connection to the meeting was lost and could not be restored. Check your network and rejoin.' }
  }
}

export function MeetingRoom({
  connection,
  meeting,
  media,
  tracks,
  backend,
  onExit,
}: {
  connection: RoomConnection
  meeting: RoomMeetingInfo
  media: MediaChoices
  /** The pre-join preview tracks: published as they are (the devices are never released and re-opened). */
  tracks: PreviewTracks
  backend: RoomBackend
  onExit: (exit: RoomExit) => void
}) {
  // Fixed for the lifetime of the room: changing them would reconnect.
  const options = useMemo(roomOptions, [])
  const toast = useToast()
  const exited = useRef(false)
  const exit = useCallback(
    (e: RoomExit) => {
      if (exited.current) return
      exited.current = true
      // Leaving releases the camera and microphone in every case (LiveKit stops published tracks itself; this also covers
      // tracks that were never published). Stop is idempotent.
      tracks.audio?.stop()
      tracks.video?.stop()
      onExit(e)
    },
    [onExit, tracks],
  )

  return (
    <LiveKitRoom
      serverUrl={resolveLiveKitUrl(connection.url)}
      token={connection.token}
      connect
      audio={false}
      video={false}
      options={options}
      onDisconnected={(reason) => exit(exitFor(reason))}
      onError={(e) => {
        // Errors while connecting end the attempt; later ones (e.g. a failed device switch) are only reported.
        toast.error(errorMessage(e, 'Something went wrong in the meeting room.'))
      }}
      onMediaDeviceFailure={(_failure, kind) =>
        toast.error(kind === 'videoinput' ? 'Your camera could not be started. Check that no other app is using it.' : 'Your microphone could not be started. Check the device and browser permissions.')
      }
      data-lk-theme="default"
      className="oic-room fixed inset-0 z-40 flex flex-col overflow-hidden"
      data-testid="meeting-room"
    >
      <LayoutContextProvider>
        <RoomShell connection={connection} meeting={meeting} backend={backend} onConnectFailed={(m) => exit({ kind: 'error', message: m })} />
        {connection.canPublish && <PublishOnConnect media={connection.canPublishVideo === false ? { ...media, videoEnabled: false } : media} tracks={connection.canPublishVideo === false ? { audio: tracks.audio } : tracks} />}
      </LayoutContextProvider>
      <RoomAudioRenderer />
    </LiveKitRoom>
  )
}

/**
 * Once connected: publishes the preview tracks (camera + microphone already running), or — when a preview was not
 * available — opens the chosen device, retrying once (some webcams need a moment after another capture stopped).
 */
function PublishOnConnect({ media, tracks }: { media: MediaChoices; tracks: PreviewTracks }) {
  const room = useRoomContext()
  const state = useConnectionState()
  const toast = useToast()
  const done = useRef(false)
  useEffect(() => {
    if (state !== ConnectionState.Connected || done.current) return
    done.current = true
    const lp = room.localParticipant
    const retry = async (enable: () => Promise<unknown>) => {
      try {
        await enable()
      } catch {
        await new Promise((r) => setTimeout(r, 1200))
        await enable()
      }
    }
    void (async () => {
      try {
        if (tracks.audio) await lp.publishTrack(tracks.audio, { source: Track.Source.Microphone })
        else if (media.audioEnabled) await retry(() => lp.setMicrophoneEnabled(true, { deviceId: media.audioDeviceId || undefined }))
      } catch {
        toast.error('Your microphone could not be started. Use the microphone button to try again.')
      }
      try {
        if (tracks.video) await lp.publishTrack(tracks.video, { source: Track.Source.Camera })
        else if (media.videoEnabled) await retry(() => lp.setCameraEnabled(true, { deviceId: media.videoDeviceId || undefined, resolution: VideoPresets.h720.resolution }))
      } catch {
        toast.error('Your camera could not be started. Check that no other app is using it, then use the camera button.')
      }
    })()
  }, [state, room, media, tracks, toast])
  return null
}

// ---- Shared room state --------------------------------------------------------------------------------------------

function useChat(backend: RoomBackend, open: boolean) {
  const room = useRoomContext()
  const { localParticipant } = useLocalParticipant()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [unread, setUnread] = useState(0)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  const add = useCallback((m: ChatMessage) => {
    setMessages((xs) => {
      // The same message can arrive live and in the persisted history: keep one.
      const dup = xs.some(
        (x) => x.key === m.key || (x.identity === m.identity && x.body === m.body && Math.abs(Date.parse(x.sentUtc) - Date.parse(m.sentUtc)) < 15_000),
      )
      return dup ? xs : [...xs, m].sort((a, b) => Date.parse(a.sentUtc) - Date.parse(b.sentUtc))
    })
  }, [])

  // History (decision D8: chat is persisted). A failure only hides older messages; the live chat keeps working.
  useEffect(() => {
    let alive = true
    backend
      .loadChat()
      .then((items) => {
        if (!alive) return
        items.forEach((c, i) =>
          add({ key: `h${i}-${c.sentUtc}`, identity: c.identity, name: c.name, body: c.body, sentUtc: c.sentUtc, mine: c.identity === localParticipant.identity, state: 'sent' }),
        )
      })
      .catch((e: unknown) => alive && setHistoryError(errorMessage(e, 'Earlier messages could not be loaded.')))
    return () => {
      alive = false
    }
  }, [backend, add, localParticipant.identity])

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC_CHAT || !participant) return
      try {
        const d = JSON.parse(decoder.decode(payload)) as { id?: string; body?: string; sentUtc?: string }
        if (!d.body || typeof d.body !== 'string') return
        add({ key: d.id ?? newId(), identity: participant.identity, name: participant.name || participant.identity, body: d.body.slice(0, 2000), sentUtc: d.sentUtc ?? new Date().toISOString(), mine: false, state: 'sent' })
        if (!openRef.current) setUnread((n) => n + 1)
      } catch {
        /* not ours */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, add])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  const persist = useCallback(
    (key: string, body: string) => {
      setMessages((xs) => xs.map((x) => (x.key === key ? { ...x, state: 'saving' } : x)))
      backend
        .postChat(body)
        .then(() => setMessages((xs) => xs.map((x) => (x.key === key ? { ...x, state: 'sent' } : x))))
        .catch(() => setMessages((xs) => xs.map((x) => (x.key === key ? { ...x, state: 'failed' } : x))))
    },
    [backend],
  )

  const send = useCallback(
    async (body: string) => {
      const key = newId()
      const sentUtc = new Date().toISOString()
      add({ key, identity: localParticipant.identity, name: localParticipant.name || 'You', body, sentUtc, mine: true, state: 'saving' })
      // Live delivery over LiveKit (works even if the API is slow); persistence in parallel.
      await localParticipant.publishData(encoder.encode(JSON.stringify({ id: key, body, sentUtc })), { reliable: true, topic: TOPIC_CHAT }).catch(() => undefined)
      persist(key, body)
    },
    [add, localParticipant, persist],
  )

  return { messages, unread, send, retry: (m: ChatMessage) => persist(m.key, m.body), historyError }
}

function useHands() {
  const room = useRoomContext()
  const { localParticipant } = useLocalParticipant()
  const [hands, setHands] = useState<Record<string, boolean>>({})
  const mine = !!hands[localParticipant.identity]
  const mineRef = useRef(mine)
  mineRef.current = mine

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC_HAND || !participant) return
      try {
        const d = JSON.parse(decoder.decode(payload)) as { raised?: boolean }
        setHands((h) => ({ ...h, [participant.identity]: !!d.raised }))
      } catch {
        /* ignore */
      }
    }
    // Late joiners learn about a raised hand.
    const onJoined = (p: RemoteParticipant) => {
      if (mineRef.current)
        void room.localParticipant.publishData(encoder.encode(JSON.stringify({ raised: true })), { reliable: true, topic: TOPIC_HAND, destinationIdentities: [p.identity] }).catch(() => undefined)
    }
    const onLeft = (p: RemoteParticipant) => setHands((h) => ({ ...h, [p.identity]: false }))
    room.on(RoomEvent.DataReceived, onData)
    room.on(RoomEvent.ParticipantConnected, onJoined)
    room.on(RoomEvent.ParticipantDisconnected, onLeft)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.ParticipantConnected, onJoined)
      room.off(RoomEvent.ParticipantDisconnected, onLeft)
    }
  }, [room])

  const toggle = useCallback(() => {
    const raised = !mineRef.current
    setHands((h) => ({ ...h, [room.localParticipant.identity]: raised }))
    void room.localParticipant.publishData(encoder.encode(JSON.stringify({ raised })), { reliable: true, topic: TOPIC_HAND }).catch(() => undefined)
  }, [room])

  return { hands, mine, toggle }
}

/** Host: the waiting list. Refreshed when the server signals a change over LiveKit, with a slow fallback poll. */
function useWaiting(host: RoomBackend['host']) {
  const room = useRoomContext()
  const toast = useToast()
  const [items, setItems] = useState<WaitingEntry[]>([])
  const known = useRef(new Set<string>())

  const refresh = useCallback(() => {
    if (!host) return
    host
      .waiting()
      .then((list) => {
        list.filter((x) => !known.current.has(x.id)).forEach((x) => toast.success(`${x.name} is waiting to join.`))
        known.current = new Set(list.map((x) => x.id))
        setItems(list)
      })
      .catch(() => undefined) // a slow API never disturbs the call
  }, [host, toast])

  useEffect(() => {
    if (!host) return
    refresh()
    const t = window.setInterval(refresh, 15_000)
    const onData = (_p: Uint8Array, _participant?: RemoteParticipant, _kind?: unknown, topic?: string) => topic === TOPIC_WAITING && refresh()
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      window.clearInterval(t)
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [host, refresh, room])

  return { items, refresh }
}

// ---- Shell ----------------------------------------------------------------------------------------------------------

type Panel = 'chat' | 'people' | 'settings' | null

function RoomShell({
  connection,
  meeting,
  backend,
  onConnectFailed,
}: {
  connection: RoomConnection
  meeting: RoomMeetingInfo
  backend: RoomBackend
  onConnectFailed: (message: string) => void
}) {
  const room = useRoomContext()
  const state = useConnectionState()
  const [panel, setPanel] = useState<Panel>(null)
  const [layout, setLayout] = useState<'grid' | 'speaker'>('grid')
  const [ending, setEnding] = useState(false)
  // A meeting just started from "New meeting" opens with the invite link on screen.
  const [inviting, setInviting] = useState(!!backend.share?.openOnStart)
  const chat = useChat(backend, panel === 'chat')
  const hands = useHands()
  const waiting = useWaiting(backend.host)
  const recording = useRoomRecording(backend.recording)
  const everConnected = useRef(false)

  if (state === ConnectionState.Connected) everConnected.current = true

  // Could not connect at all (wrong URL, LiveKit down, token expired): leave with an explanation.
  useEffect(() => {
    if (state !== ConnectionState.Disconnected || everConnected.current) return
    const t = window.setTimeout(() => {
      if (!everConnected.current && room.state === ConnectionState.Disconnected)
        onConnectFailed('Could not connect to the video service. Check your network connection and try again.')
    }, 15_000)
    return () => window.clearTimeout(t)
  }, [state, room, onConnectFailed])

  // While connected: count as activity (no idle sign-out mid-call) and keep the session alive. Media never depends on this.
  useEffect(() => {
    if (state !== ConnectionState.Connected) return
    const a = window.setInterval(() => window.dispatchEvent(new Event(ACTIVITY_EVENT)), 60_000)
    const k = backend.keepAlive ? window.setInterval(() => void backend.keepAlive?.().catch(() => undefined), 10 * 60_000) : 0
    return () => {
      window.clearInterval(a)
      if (k) window.clearInterval(k)
    }
  }, [state, backend])

  const ui = useMemo<RoomUi>(() => ({ connection, hands: hands.hands, backend }), [connection, hands.hands, backend])
  const toggle = (p: Exclude<Panel, null>) => setPanel((x) => (x === p ? null : p))

  return (
    <RoomUiContext.Provider value={ui}>
      <RoomHeader
        meeting={meeting}
        extra={
          <>
            {recording.withdraw}
            {recording.indicator}
            {backend.share && (
              <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.1] px-3 text-[12px] font-semibold text-white hover:bg-white/[0.16]" onClick={() => setInviting(true)} data-testid="ctl-invite">
                <UserPlus className="size-3.5" aria-hidden /> <span className="hidden sm:inline">Invite</span>
                <span className="sr-only sm:hidden">Invite people</span>
              </button>
            )}
          </>
        }
      />
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-1 sm:px-4">
        <main className="relative min-w-0 flex-1" aria-label="Participants' video">
          {state === ConnectionState.Connecting && !everConnected.current ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-white/75" role="status">
              <LoaderCircle className="size-8 animate-spin text-cyan-400" aria-hidden />
              Connecting to the meeting…
            </div>
          ) : (
            <Stage layout={layout} />
          )}
          <StartAudio label="Click to turn on meeting audio" className="!absolute top-3 left-1/2 z-10 -translate-x-1/2" />
        </main>
        {panel && (
          <aside
            className="oic-panel fixed inset-x-2 top-16 bottom-24 z-20 flex flex-col overflow-hidden rounded-xl sm:static sm:inset-auto sm:z-auto sm:w-[360px] sm:shrink-0"
            aria-label={panel === 'chat' ? 'Chat' : panel === 'people' ? 'Participants' : 'Settings'}
          >
            {panel === 'chat' && <ChatPanel messages={chat.messages} onSend={chat.send} onRetry={chat.retry} historyError={chat.historyError} onClose={() => setPanel(null)} />}
            {panel === 'people' && <PeoplePanel waiting={waiting.items} onWaitingChanged={waiting.refresh} onClose={() => setPanel(null)} />}
            {panel === 'settings' && <SettingsPanel onClose={() => setPanel(null)} />}
          </aside>
        )}
      </div>
      <ControlBar
        layout={layout}
        onLayout={() => setLayout((l) => (l === 'grid' ? 'speaker' : 'grid'))}
        panel={panel}
        onPanel={toggle}
        unread={chat.unread}
        waitingCount={waiting.items.length}
        handRaised={hands.mine}
        onHand={hands.toggle}
        onLeave={() => void room.disconnect()}
        onEndForAll={backend.host ? () => setEnding(true) : undefined}
        extra={recording.control}
      />
      {recording.dialogs}
      {backend.share && <ShareLinkDialog open={inviting} onClose={() => setInviting(false)} meetingId={backend.share.meetingId} title={meeting.title} />}
      {backend.host && (
        <ConfirmDialog
          open={ending}
          onClose={() => setEnding(false)}
          title="End the meeting for everyone?"
          confirmLabel="End for all"
          onConfirm={async () => {
            await backend.host!.end()
          }}
        >
          <p>Everyone is disconnected and the meeting is marked as completed. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </RoomUiContext.Provider>
  )
}

function useElapsed() {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - start) / 1000))
  const hh = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
}

const qualityLabel: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: 'Excellent connection',
  [ConnectionQuality.Good]: 'Good connection',
  [ConnectionQuality.Poor]: 'Weak connection',
  [ConnectionQuality.Lost]: 'Connection lost',
  [ConnectionQuality.Unknown]: 'Checking connection…',
}

function RoomHeader({ meeting, extra }: { meeting: RoomMeetingInfo; extra?: ReactNode }) {
  const elapsed = useElapsed()
  const participants = useParticipants()
  const { localParticipant } = useLocalParticipant()
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant })
  const tz = meeting.timeZoneId || 'Asia/Kolkata'
  const dot = quality === ConnectionQuality.Excellent ? 'bg-[#22C55E]' : quality === ConnectionQuality.Good ? 'bg-warning' : quality === ConnectionQuality.Unknown ? 'bg-white/40' : 'bg-danger'
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 px-3 sm:px-5 [@media(max-height:500px)]:h-12">
      <ConnectMark size={32} />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] leading-5 font-semibold" title={meeting.title}>
          {meeting.title}
        </h1>
        <p className="truncate text-[12px] text-white/55">
          <span className="font-mono tabular-nums">{meeting.meetingCode}</span> · Host {meeting.hostName} · Ends {formatTime(meeting.endUtc, tz)} {zoneLabel(tz)}
        </p>
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <span className="inline-flex h-8 items-center gap-2 rounded-full bg-white/[0.07] px-3 text-[12px] font-medium text-white/80" title={qualityLabel[quality]} data-testid="network-quality">
          <span className={cn('size-2 rounded-full', dot)} aria-hidden />
          {qualityLabel[quality]}
        </span>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.07] px-3 text-[12px] font-medium text-white/80">
          <Users className="size-3.5" aria-hidden /> {participants.length}
        </span>
      </div>
      {extra}
      <span className="inline-flex h-8 items-center rounded-full bg-white/[0.07] px-3 font-mono text-[12.5px] text-white/85 tabular-nums" aria-label="Time in meeting">
        {elapsed}
      </span>
    </header>
  )
}

/** "Reconnecting…" while LiveKit restores the media path on its own; a hint when the uplink is weak. */
function ConnectionBanner() {
  const state = useConnectionState()
  const room = useRoomContext()
  const { localParticipant } = useLocalParticipant()
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant })
  const [weakSince, setWeakSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [recovered, setRecovered] = useState(false)
  const wasReconnecting = useRef(false)

  useEffect(() => {
    if (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) setWeakSince((s) => s ?? Date.now())
    else setWeakSince(null)
  }, [quality])
  useEffect(() => {
    if (weakSince === null) return
    const t = window.setInterval(() => setNow(Date.now()), 2000)
    return () => window.clearInterval(t)
  }, [weakSince])
  useEffect(() => {
    const reconnecting = state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting
    if (reconnecting) wasReconnecting.current = true
    else if (state === ConnectionState.Connected && wasReconnecting.current) {
      wasReconnecting.current = false
      setRecovered(true)
      const t = window.setTimeout(() => setRecovered(false), 4000)
      return () => window.clearTimeout(t)
    }
  }, [state])

  if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting)
    return (
      <div role="status" aria-live="assertive" className="mx-3 mb-2 flex items-center justify-center gap-2.5 rounded-lg bg-warning px-4 py-2 text-[13px] font-semibold text-navy-950 sm:mx-4" data-testid="reconnecting-banner">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Reconnecting… your call will resume automatically.
      </div>
    )
  if (recovered)
    return (
      <div role="status" className="mx-3 mb-2 flex items-center justify-center rounded-lg bg-success px-4 py-2 text-[13px] font-semibold text-white sm:mx-4">
        Reconnected.
      </div>
    )
  const camOn = localParticipant.isCameraEnabled
  if (weakSince !== null && now - weakSince > 8000 && camOn)
    return (
      <div role="status" className="mx-3 mb-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg bg-white/10 px-4 py-2 text-[13px] text-white sm:mx-4">
        <WifiOff className="size-4 text-warning" aria-hidden />
        Your connection is weak. Turning your camera off keeps your voice clear.
        <button type="button" className="font-semibold text-cyan-400 hover:underline" onClick={() => void room.localParticipant.setCameraEnabled(false)}>
          Turn camera off
        </button>
      </div>
    )
  return null
}

// ---- Stage and tiles -------------------------------------------------------------------------------------------------

function Stage({ layout }: { layout: 'grid' | 'speaker' }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  )
  const speakers = useSpeakingParticipants()
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null)
  useEffect(() => {
    const s = speakers.find((p) => !p.isLocal) ?? speakers[0]
    if (s) setLastSpeaker(s.identity)
  }, [speakers])

  const screen = tracks.find((t) => isTrackReference(t) && t.source === Track.Source.ScreenShare)
  let focus: TrackReferenceOrPlaceholder | undefined = screen
  if (!focus && layout === 'speaker' && tracks.length > 1) {
    const cams = tracks.filter((t) => t.source === Track.Source.Camera)
    focus = cams.find((t) => t.participant.identity === lastSpeaker) ?? cams.find((t) => !t.participant.isLocal) ?? cams[0]
  }

  if (focus) {
    const others = tracks.filter((t) => t !== focus)
    return (
      <FocusLayoutContainer className="h-full">
        <CarouselLayout tracks={others}>
          <Tile />
        </CarouselLayout>
        <Tile trackRef={focus} />
      </FocusLayoutContainer>
    )
  }
  return (
    <GridLayout tracks={tracks} className="h-full">
      <Tile />
    </GridLayout>
  )
}

function Tile({ trackRef: given }: { trackRef?: TrackReferenceOrPlaceholder }) {
  const trackRef = useEnsureTrackRef(given)
  const { hands } = useRoomUi()
  const p = trackRef.participant
  const screen = trackRef.source === Track.Source.ScreenShare
  const videoMuted = useIsMuted(trackRef)
  const micMuted = useIsMuted({ participant: p, source: Track.Source.Microphone })
  const showVideo = isTrackReference(trackRef) && !videoMuted
  const { role, type } = participantRole(p)
  const name = p.name || p.identity

  return (
    <ParticipantTile trackRef={trackRef} data-testid={screen ? 'tile-screen' : 'tile'} data-identity={p.identity}>
      {showVideo ? (
        <VideoTrack trackRef={trackRef} data-testid={screen ? 'video-screen' : 'video-camera'} />
      ) : (
        <div className="oic-tile-placeholder">
          <span className="oic-tile-avatar">{initialsOf(name)}</span>
        </div>
      )}
      {!screen && hands[p.identity] && (
        <span className="oic-tile-hand">
          <Hand className="size-4" aria-hidden /> Hand raised
        </span>
      )}
      <div className="oic-tile-meta">
        <span className="oic-tile-chip">
          {screen ? (
            <MonitorUp className="size-3.5 shrink-0 text-cyan-400" aria-hidden />
          ) : micMuted ? (
            <MicOff className="size-3.5 shrink-0 text-[#F87171]" aria-label="Microphone off" />
          ) : (
            <Mic className="size-3.5 shrink-0 text-[#4ADE80]" aria-label="Microphone on" />
          )}
          <ParticipantName />
          {screen && <span className="font-normal text-white/70">is presenting</span>}
          {p.isLocal && !screen && <span className="font-normal text-white/60">(you)</span>}
          {!screen && role !== 'ATTENDEE' && <span className="rounded-full bg-brand-500 px-1.5 text-[10.5px] font-bold">{role === 'HOST' ? 'HOST' : 'CO-HOST'}</span>}
          {!screen && type !== 'EMPLOYEE' && <span className="rounded-full bg-white/15 px-1.5 text-[10.5px] font-semibold">{type === 'CUSTOMER' ? 'Customer' : 'Guest'}</span>}
        </span>
        <span className="ml-auto">
          <ConnectionQualityIndicator />
        </span>
      </div>
    </ParticipantTile>
  )
}

// ---- Controls --------------------------------------------------------------------------------------------------------

function MediaToggle({ source, labelOn, labelOff, iconOn, iconOff, testId }: { source: Track.Source.Microphone | Track.Source.Camera; labelOn: string; labelOff: string; iconOn: ReactNode; iconOff: ReactNode; testId: string }) {
  const toast = useToast()
  const { enabled, pending, toggle } = useTrackToggle({
    source,
    onDeviceError: () => toast.error(source === Track.Source.Camera ? 'Your camera could not be started. Check that no other app is using it.' : 'Your microphone could not be started.'),
  })
  return (
    <button type="button" className="oic-ctl" data-off={!enabled || undefined} aria-pressed={enabled} disabled={pending} onClick={() => void toggle()} aria-label={enabled ? labelOn : labelOff} title={enabled ? labelOn : labelOff} data-testid={testId}>
      {enabled ? iconOn : iconOff}
    </button>
  )
}

/** Phones and tablets: Android and iOS browsers cannot share the screen (no getDisplayMedia), so the control is not offered. */
const canShareScreen = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'

/** Narrow screens (phones): the toolbar keeps the essentials and moves the rest into "More". */
function useCompact() {
  const query = '(max-width: 639px)'
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setCompact(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return compact
}

function ScreenShareToggle() {
  const toast = useToast()
  const { enabled, pending, toggle } = useTrackToggle({
    source: Track.Source.ScreenShare,
    captureOptions: { audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' },
    onDeviceError: (e) => {
      if (e?.name !== 'NotAllowedError') toast.error('Screen sharing could not be started.')
    },
  })
  return (
    <button type="button" className="oic-ctl" data-on={enabled || undefined} aria-pressed={enabled} disabled={pending} onClick={() => void toggle()} title={enabled ? 'Stop presenting' : 'Present your screen'} data-testid="ctl-screen">
      {enabled ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}
      <span className="hidden xl:inline">{enabled ? 'Stop presenting' : 'Present'}</span>
    </button>
  )
}

function ControlBar({
  layout,
  onLayout,
  panel,
  onPanel,
  unread,
  waitingCount,
  handRaised,
  onHand,
  onLeave,
  onEndForAll,
  extra,
}: {
  layout: 'grid' | 'speaker'
  onLayout: () => void
  panel: Panel
  onPanel: (p: Exclude<Panel, null>) => void
  unread: number
  waitingCount: number
  handRaised: boolean
  onHand: () => void
  onLeave: () => void
  onEndForAll?: () => void
  extra?: ReactNode
}) {
  const { connection } = useRoomUi()
  const compact = useCompact()
  const [more, setMore] = useState(false)
  const camera = connection.canPublish && connection.canPublishVideo !== false
  const hand = (
    <button type="button" className="oic-ctl" data-on={handRaised || undefined} aria-pressed={handRaised} onClick={onHand} title={handRaised ? 'Lower hand' : 'Raise hand'} data-testid="ctl-hand">
      <Hand className="size-5" />
    </button>
  )
  const layoutBtn = (
    <button type="button" className="oic-ctl" onClick={onLayout} title={layout === 'grid' ? 'Speaker view' : 'Grid view'} data-testid="ctl-layout">
      {layout === 'grid' ? <Presentation className="size-5" /> : <LayoutGrid className="size-5" />}
    </button>
  )
  const settings = (
    <button type="button" className="oic-ctl" data-on={panel === 'settings' || undefined} onClick={() => onPanel('settings')} title="Audio and video settings">
      <Settings2 className="size-5" />
    </button>
  )
  const end = onEndForAll && (
    <button type="button" className="oic-ctl" data-variant="leave" onClick={onEndForAll} title="End the meeting for everyone" data-testid="ctl-end">
      <PhoneOff className="size-5" />
      <span className="hidden md:inline">End for all</span>
    </button>
  )
  return (
    <nav aria-label="Meeting controls" className="oic-controls flex shrink-0 items-center justify-between gap-2 px-2 sm:h-20 sm:px-5 [@media(max-height:500px)]:h-16" data-compact={compact || undefined}>
      {!compact && <div className="hidden w-48 lg:block" />}
      <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2.5">
        {connection.canPublish && (
          <MediaToggle source={Track.Source.Microphone} labelOn="Mute microphone" labelOff="Unmute microphone" iconOn={<Mic className="size-5" />} iconOff={<MicOff className="size-5" />} testId="ctl-mic" />
        )}
        {camera && (
          <MediaToggle source={Track.Source.Camera} labelOn="Turn camera off" labelOff="Turn camera on" iconOn={<Video className="size-5" />} iconOff={<VideoOff className="size-5" />} testId="ctl-cam" />
        )}
        {!compact && connection.canScreenShare && canShareScreen && <ScreenShareToggle />}
        {!compact && hand}
        <button type="button" className="oic-ctl" data-on={panel === 'chat' || undefined} aria-pressed={panel === 'chat'} onClick={() => onPanel('chat')} title="Chat" data-testid="ctl-chat">
          <MessageSquare className="size-5" />
          {unread > 0 && <span className="oic-ctl-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button type="button" className="oic-ctl" data-on={panel === 'people' || undefined} aria-pressed={panel === 'people'} onClick={() => onPanel('people')} title={waitingCount ? `Participants (${waitingCount} waiting)` : 'Participants'} data-testid="ctl-people">
          <Users className="size-5" />
          {waitingCount > 0 && <span className="oic-ctl-badge" data-testid="waiting-badge">{waitingCount}</span>}
        </button>
        {!compact && layoutBtn}
        {!compact && settings}
        {!compact && extra}
        {compact && (
          <button type="button" className="oic-ctl" data-on={more || handRaised || undefined} aria-expanded={more} onClick={() => setMore(true)} title="More options" data-testid="ctl-more">
            <Ellipsis className="size-5" />
          </button>
        )}
        <button type="button" className="oic-ctl sm:ml-1" data-variant="leave" onClick={onLeave} title="Leave the meeting" aria-label="Leave the meeting" data-testid="ctl-leave">
          <LogOut className="size-5" />
          {!compact && <span>Leave</span>}
        </button>
      </div>
      {!compact && <div className="flex justify-end lg:w-48">{end}</div>}
      {compact && more && (
        <MoreSheet onClose={() => setMore(false)}>
          <SheetItem label={handRaised ? 'Lower hand' : 'Raise hand'}>{hand}</SheetItem>
          <SheetItem label={layout === 'grid' ? 'Speaker view' : 'Grid view'}>{layoutBtn}</SheetItem>
          <SheetItem label="Audio & video">{settings}</SheetItem>
          {extra && <SheetItem label="Recording">{extra}</SheetItem>}
          {connection.canScreenShare && canShareScreen && <SheetItem label="Present"><ScreenShareToggle /></SheetItem>}
          {end && <SheetItem label="End for all">{end}</SheetItem>}
        </MoreSheet>
      )}
    </nav>
  )
}

/** Bottom sheet with the less frequent controls on phones. Using any control closes it. */
function MoreSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-30" data-testid="more-sheet">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-label="More options"
        className="oic-panel oic-sheet absolute inset-x-2 bottom-2 rounded-2xl p-4"
        onClickCapture={(e) => (e.target as HTMLElement).closest('button') && window.setTimeout(onClose, 0)}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/25" aria-hidden />
        <div className="grid grid-cols-3 gap-3">{children}</div>
      </div>
    </div>
  )
}

function SheetItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center text-[11.5px] leading-4 text-white/75">
      {children}
      <span>{label}</span>
    </div>
  )
}
