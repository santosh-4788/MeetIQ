import '@livekit/components-styles'
import './room.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
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
  usePinnedTracks,
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
  RemoteTrackPublication,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
  type RemoteParticipant,
  type TrackPublication,
  type RoomOptions,
} from 'livekit-client'
import {
  Ellipsis, Hand, LayoutGrid, Lock, LoaderCircle, LogOut, MessageSquare, Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Presentation, Settings2, UserPlus, Users, Video, VideoOff, WifiOff, X,
} from 'lucide-react'
import type { EndTimes, MuteSource, RoomConnection, RoomMeetingInfo, WaitingEntry } from '../../api/room'
import { resolveLiveKitUrl, roomApi } from '../../api/room'
import { roomRecordingApi } from '../../api/recordings'
import { errorMessage } from '../../api/types'
import { ACTIVITY_EVENT, markInMeeting } from '../../auth/AuthContext'
import { ConnectMark } from '../../components/brand/ConnectLogo'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatTime, parseUtc, zoneLabel } from '../../lib/format'
import { initialsOf, type MediaChoices, type PreviewTracks } from './PreJoin'
import { ChatPanel, PeoplePanel, SettingsPanel, SupportLine, type ChatMessage } from './RoomPanels'
import { useRoomRecording } from './RecordingControls'
import { ShareLinkDialog } from '../meetings/MeetingLinkShare'
import { RoomUiContext, participantRole, useRoomUi, type RoomBackend, type RoomUi } from './roomUi'

export type { RoomBackend } from './roomUi'

export type RoomExit =
  | { kind: 'left' }
  | { kind: 'ended'; endedBy?: 'host' | 'auto'; endedUtc?: string }
  | { kind: 'removed' }
  | { kind: 'duplicate' }
  | { kind: 'error'; message: string }

const TOPIC_CHAT = 'oic.chat'
const TOPIC_HAND = 'oic.hand'
const TOPIC_WAITING = 'oic.waiting'
const TOPIC_HOST_TRANSFER = 'oic.host-transfer'
const TOPIC_NOTICE = 'oic.host-notice'
/** Server → everyone: { type: 'meeting-ended', endedBy: 'host' | 'auto' } (MeetingAutoEnd.MeetingEndedTopic). */
const TOPIC_MEETING = 'oic.meeting'
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
    // Not LiveKit's own handler: it disconnects on `beforeunload`, which Chrome/Edge also fire when a mailto:/tel: link
    // opens the mail app - the call dropped as soon as "E-mail" was clicked in Invite people. `pagehide` (see
    // useLeaveOnPageHide) fires only when the page really goes away.
    disconnectOnPageLeave: false,
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
      onDisconnected={(reason) => {
        const e = exitFor(reason)
        // A dropped connection may really be the end of the meeting (the "room deleted" signal was missed, e.g. a phone in
        // the background): ask the API before showing "Connection lost". Never waits longer than 5 s.
        if (e.kind !== 'error' || !backend.hasEnded) return exit(e)
        const timeout = new Promise<boolean>((r) => window.setTimeout(() => r(false), 5000))
        void Promise.race([backend.hasEnded().catch(() => false), timeout]).then((ended) => exit(ended ? { kind: 'ended', endedUtc: new Date().toISOString() } : e))
      }}
      onError={(e) => {
        // Errors while connecting end the attempt; later ones (e.g. a failed device switch) are only reported.
        toast.error(errorMessage(e, 'Something went wrong in the meeting room.'))
      }}
      onMediaDeviceFailure={(failure, kind) => notifyDevice(toast, kind === 'videoinput' ? 'camera' : 'microphone', { name: String(failure ?? '') })}
      data-lk-theme="default"
      className="oic-room fixed inset-0 z-40 flex flex-col overflow-hidden"
      data-testid="meeting-room"
    >
      <LayoutContextProvider>
        <LeaveOnPageHide />
        <RoomShell connection={connection} meeting={meeting} backend={backend} onConnectFailed={(m) => exit({ kind: 'error', message: m })}
          onEnded={(endedBy) => exit({ kind: 'ended', endedBy, endedUtc: new Date().toISOString() })} />
        {connection.canPublish && <PublishOnConnect media={connection.canPublishVideo === false ? { ...media, videoEnabled: false } : media} tracks={connection.canPublishVideo === false ? { audio: tracks.audio } : tracks} />}
      </LayoutContextProvider>
      <RoomAudioRenderer />
    </LiveKitRoom>
  )
}

/** Leaves the room when the page is really closed or navigated away (not when a mailto: link opens the mail app). */
function LeaveOnPageHide() {
  const room = useRoomContext()
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) void room.disconnect()
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [room])
  return null
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
      } catch (e) {
        notifyDevice(toast, 'microphone', e)
      }
      try {
        if (tracks.video) await lp.publishTrack(tracks.video, { source: Track.Source.Camera })
        else if (media.videoEnabled) await retry(() => lp.setCameraEnabled(true, { deviceId: media.videoDeviceId || undefined, resolution: VideoPresets.h720.resolution }))
      } catch (e) {
        notifyDevice(toast, 'camera', e)
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
  onEnded,
}: {
  connection: RoomConnection
  meeting: RoomMeetingInfo
  backend: RoomBackend
  onConnectFailed: (message: string) => void
  /** Called as soon as our own "end for all" API call succeeds - don't wait for LiveKit's own disconnect signal,
      which can show a "Reconnecting…" banner first before it gives up, leaving the host stuck looking at a dead call. */
  onEnded: (endedBy?: 'host' | 'auto') => void
}) {
  const room = useRoomContext()
  const state = useConnectionState()
  const toast = useToast()

  // Host ended the meeting for everyone (or it ended automatically): the server says so in-band just before it closes the
  // room. Leave at once - no "Reconnecting…", no retries - and release camera, microphone and screen share (disconnect
  // unpublishes and stops every local track).
  const endedRef = useRef(false)
  const finish = useCallback((endedBy?: 'host' | 'auto') => {
    if (endedRef.current) return
    endedRef.current = true
    onEnded(endedBy)
    void room.disconnect()
  }, [onEnded, room])
  useEffect(() => {
    const onData = (payload: Uint8Array, _p?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC_MEETING) return
      try {
        const d = JSON.parse(decoder.decode(payload)) as { type?: string; endedBy?: string }
        if (d.type === 'meeting-ended') finish(d.endedBy === 'auto' ? 'auto' : 'host')
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, finish])
  // Reconnecting: the API is the source of truth. If the meeting has ended meanwhile, stop reconnecting and show it.
  useEffect(() => {
    if (!backend.hasEnded || (state !== ConnectionState.Reconnecting && state !== ConnectionState.SignalReconnecting)) return
    let alive = true
    const check = () => void backend.hasEnded!().then((ended) => { if (alive && ended) finish() }).catch(() => undefined)
    const first = window.setTimeout(check, 1500)
    const t = window.setInterval(check, 4000)
    return () => {
      alive = false
      window.clearTimeout(first)
      window.clearInterval(t)
    }
  }, [state, backend, finish])
  const [panel, setPanel] = useState<Panel>(null)
  const [layout, setLayout] = useState<'grid' | 'speaker'>('grid')
  const [ending, setEnding] = useState(false)
  const [ends, setEnds] = useEndTimes(meeting)
  // A meeting just started from "New meeting" opens with the invite link on screen.
  const [inviting, setInviting] = useState(!!backend.share?.openOnStart)


  // Host transfer: `backend` is built once, at join time, from the role the caller had then. A participant who becomes
  // (or stops being) host mid-meeting needs their host-only capabilities to appear (or disappear) without reconnecting -
  // LiveKit already pushes the role-badge change live via participant metadata (see roomUi.participantRole); this override
  // covers the capability objects themselves (room admin actions, recording start/stop).
  const [hostOverride, setHostOverride] = useState<boolean | null>(null)
  useEffect(() => {
    const onData = (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC_HOST_TRANSFER) return
      try {
        const d = JSON.parse(decoder.decode(payload)) as { previousIdentity?: string; newIdentity?: string }
        const me = room.localParticipant.identity
        if (d.newIdentity === me) {
          setHostOverride(true)
          toast.success('You are now the host.')
        } else if (d.previousIdentity === me) {
          setHostOverride(false)
          toast.success('Host privileges were transferred to someone else.')
        }
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, toast])

  // Host notices that don't change recording/waiting/host state: a forced mute, a request to unmute, or the meeting
  // being locked/unlocked - all one-off, so a toast is enough (the lock state itself also needs to stick around, for
  // the header chip and the Participants-panel toggle, so that part is kept in state rather than just shown once).
  const [locked, setLockedFromServer] = useState(!!meeting.locked)
  useEffect(() => {
    const onData = (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== TOPIC_NOTICE) return
      try {
        const d = JSON.parse(decoder.decode(payload)) as { type?: string; source?: string; locked?: boolean }
        if (d.type === 'muted') toast.success(`The host turned off your ${(d.source ?? 'microphone').toLowerCase().replace('_', ' ')}.`)
        else if (d.type === 'unmute-requested') toast.success('The host is asking you to unmute.')
        else if (d.type === 'lock-changed') {
          setLockedFromServer(!!d.locked)
          toast.success(d.locked ? 'The meeting has been locked. No one new can join.' : 'The meeting has been unlocked.')
        }
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, toast])

  const effectiveBackend = useMemo<RoomBackend>(() => {
    if (hostOverride === null) return backend
    if (hostOverride === false) {
      if (!backend.host && !backend.recording?.start) return backend
      return {
        ...backend,
        host: undefined,
        recording: backend.recording && { state: backend.recording.state, consent: backend.recording.consent }, // no start/stop/remove once host is lost
      }
    }
    // hostOverride === true: gained host. Keep whatever was already there (e.g. was already co-host), otherwise build it.
    return {
      ...backend,
      host: backend.host ?? {
        waiting: () => roomApi.waiting(meeting.id),
        admit: (e) => roomApi.admit(meeting.id, e),
        reject: (e) => roomApi.reject(meeting.id, e),
        mute: (identity, source: MuteSource) => roomApi.mute(meeting.id, identity, source),
        requestUnmute: (identity) => roomApi.requestUnmute(meeting.id, identity),
        remove: (identity, block) => roomApi.remove(meeting.id, identity, block),
        end: () => roomApi.end(meeting.id),
        extend: (minutes) => roomApi.extend(meeting.id, minutes),
        setLocked: (locked) => roomApi.setLocked(meeting.id, locked).then(() => undefined),
        transferHost: (identity) => roomApi.transferHost(meeting.id, identity),
      },
      recording: backend.recording && {
        ...backend.recording,
        start: backend.recording.start ?? ((version: string) => roomRecordingApi.start(meeting.id, version)),
        stop: backend.recording.stop ?? (() => roomRecordingApi.stop(meeting.id)),
        removeFromRequest: backend.recording.removeFromRequest ?? ((identity: string) => roomRecordingApi.removeFromRequest(meeting.id, identity)),
      },
    }
  }, [backend, hostOverride, meeting.id])

  const chat = useChat(backend, panel === 'chat')
  const hands = useHands()
  const waiting = useWaiting(effectiveBackend.host)
  const recording = useRoomRecording(effectiveBackend.recording)
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

  // In a meeting: an ended portal session (expiry, daily 23:30 reset) must not navigate away and drop the call.
  useEffect(() => {
    markInMeeting(true)
    return () => markInMeeting(false)
  }, [])

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

  const ui = useMemo<RoomUi>(() => ({ connection, hands: hands.hands, backend: effectiveBackend }), [connection, hands.hands, effectiveBackend])
  const toggle = (p: Exclude<Panel, null>) => setPanel((x) => (x === p ? null : p))

  return (
    <RoomUiContext.Provider value={ui}>
      <RoomHeader
        meeting={{ ...meeting, endUtc: ends.endUtc }}
        extra={
          <>
            {locked && (
              <span className="oic-chip" title="No one new can join while the meeting is locked" data-testid="meeting-locked-chip">
                <Lock className="size-3.5" aria-hidden /> Locked
              </span>
            )}
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
      <EndTimeBanner ends={ends} setEnds={setEnds} tz={meeting.timeZoneId || 'Asia/Kolkata'} extend={effectiveBackend.host?.extend} onEndNow={effectiveBackend.host ? () => setEnding(true) : undefined} />
      {recording.banner}
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
          <StartAudio label="Click to turn on meeting audio" className="oic-start-audio" />
        </main>
        <AnimatePresence>
          {panel && (
            <motion.aside
              key={panel}
              className="oic-panel fixed inset-x-2 top-16 bottom-24 z-20 flex flex-col overflow-hidden rounded-xl sm:static sm:inset-auto sm:z-auto sm:w-[360px] sm:shrink-0"
              aria-label={panel === 'chat' ? 'Chat' : panel === 'people' ? 'Participants' : 'Settings'}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              {panel === 'chat' && <ChatPanel messages={chat.messages} onSend={chat.send} onRetry={chat.retry} historyError={chat.historyError} onClose={() => setPanel(null)} />}
              {panel === 'people' && (
                <PeoplePanel
                  waiting={waiting.items}
                  onWaitingChanged={waiting.refresh}
                  onClose={() => setPanel(null)}
                  consent={recording.state?.consent}
                  locked={locked}
                  onToggleLocked={
                    effectiveBackend.host
                      ? async () => {
                          await effectiveBackend.host!.setLocked(!locked)
                          setLockedFromServer(!locked)
                        }
                      : undefined
                  }
                />
              )}
              {panel === 'settings' && <SettingsPanel onClose={() => setPanel(null)} />}
            </motion.aside>
          )}
        </AnimatePresence>
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
        onEndForAll={effectiveBackend.host ? () => setEnding(true) : undefined}
        extra={recording.control}
      />
      {recording.dialogs}
      {backend.share && <ShareLinkDialog open={inviting} onClose={() => setInviting(false)} meetingId={backend.share.meetingId} title={meeting.title} customer={backend.share.customer} guests={backend.share.guests} customerMeeting={meeting.categoryGroup === 'CUSTOMER' && !backend.share.noCustomer} />}
      {effectiveBackend.host && (
        <ConfirmDialog
          open={ending}
          onClose={() => setEnding(false)}
          title="End the meeting for everyone?"
          confirmLabel="End for all"
          onConfirm={async () => {
            await effectiveBackend.host!.end()
            finish('host')
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
        <h1 className="truncate text-[16px] leading-5 font-bold tracking-[-0.01em]" title={meeting.title}>
          {meeting.title}
        </h1>
        <p className="truncate text-[12px] font-medium text-white/50">
          <span className="font-mono tracking-wide text-white/65 tabular-nums">{meeting.meetingCode}</span> · Host {meeting.hostName} · Ends {formatTime(meeting.endUtc, tz)} {zoneLabel(tz)}
        </p>
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <span className="oic-chip" title={qualityLabel[quality]} data-testid="network-quality">
          <span className={cn('size-2 rounded-full shadow-[0_0_6px_currentColor]', dot)} aria-hidden />
          {qualityLabel[quality]}
        </span>
        <span className="oic-chip">
          <Users className="size-3.5 text-cyan-400" aria-hidden /> {participants.length}
        </span>
      </div>
      {extra}
      <span className="oic-chip font-mono tabular-nums" aria-label="Time in meeting">
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

// ---- Scheduled end (GoodDay #14208) ----------------------------------------------------------------------------------

/** The meeting's scheduled end and automatic end, kept current when a host extends it (data message "end-changed"). */
function useEndTimes(meeting: RoomMeetingInfo) {
  const room = useRoomContext()
  const toast = useToast()
  const [ends, setEnds] = useState<EndTimes>({ endUtc: meeting.endUtc, autoEndUtc: meeting.autoEndUtc ?? null })
  useEffect(() => {
    const onData = (payload: Uint8Array, _p?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC_NOTICE) return
      try {
        const d = JSON.parse(decoder.decode(payload)) as { type?: string; endUtc?: string; autoEndUtc?: string | null; minutes?: number }
        if (d.type !== 'end-changed' || !d.endUtc) return
        setEnds({ endUtc: d.endUtc, autoEndUtc: d.autoEndUtc ?? null })
        toast.success(d.minutes ? `The meeting was extended by ${d.minutes} min.` : 'The meeting was extended.')
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [room, toast])
  return [ends, setEnds] as const
}

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const END_WARNING_MS = 5 * 60_000

/**
 * From 5 minutes before the scheduled end: "Meeting ends in m:ss". After it: "Scheduled time is up - the meeting ends
 * automatically in m:ss" (when the server will end it) with Extend / End now for hosts. Nobody is cut off without warning.
 */
function EndTimeBanner({ ends, setEnds, extend, onEndNow, tz }: {
  ends: EndTimes
  setEnds: (e: EndTimes) => void
  extend?: (minutes: number) => Promise<EndTimes>
  onEndNow?: () => void
  tz: string
}) {
  const toast = useToast()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const end = parseUtc(ends.endUtc).getTime()
  const auto = ends.autoEndUtc ? parseUtc(ends.autoEndUtc).getTime() : null
  const show = now >= end - END_WARNING_MS
  useEffect(() => {
    // Tick every second only while the banner is (nearly) on screen; otherwise wake up shortly before it is due.
    const wait = end - END_WARNING_MS - Date.now()
    const t = wait > 1000 ? window.setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1)) : window.setInterval(() => setNow(Date.now()), 1000)
    return () => (wait > 1000 ? window.clearTimeout(t) : window.clearInterval(t))
  }, [end, show])
  if (!show) return null
  const over = now >= end
  const doExtend = async (minutes: number) => {
    if (!extend) return
    setBusy(true)
    try {
      setEnds(await extend(minutes)) // everyone, the host included, also gets the "end-changed" notice (one toast)
    } catch (e) {
      toast.error(errorMessage(e, 'The meeting could not be extended.'))
    } finally {
      setBusy(false)
    }
  }
  const text = !over
    ? `This meeting is scheduled to end at ${formatTime(ends.endUtc, tz)} (in ${mmss(end - now)}).`
    : auto
      ? `Scheduled time is up. The meeting ends automatically in ${mmss(auto - now)}${extend ? ' unless you extend it' : ' unless the host extends it'}.`
      : "This meeting's scheduled time is up. The call keeps going until a host ends it."
  return (
    <div role="status" className={cn('mx-3 mb-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-lg px-4 py-2 text-[13px] text-white sm:mx-4', over ? 'bg-[#B45309]' : 'bg-white/10')} data-testid="end-time-banner" data-over={over || undefined}>
      <span className="tabular-nums">{text}</span>
      {extend && (
        <span className="flex items-center gap-2">
          <button type="button" disabled={busy} className="rounded-full bg-white/15 px-3 py-1 text-[12.5px] font-semibold hover:bg-white/25 disabled:opacity-60" onClick={() => void doExtend(15)} data-testid="extend-15">Extend 15 min</button>
          <button type="button" disabled={busy} className="rounded-full bg-white/15 px-3 py-1 text-[12.5px] font-semibold hover:bg-white/25 disabled:opacity-60" onClick={() => void doExtend(30)} data-testid="extend-30">30 min</button>
          {over && onEndNow && <button type="button" className="rounded-full bg-[#DC2626] px-3 py-1 text-[12.5px] font-semibold hover:brightness-110" onClick={onEndNow} data-testid="end-now">End now</button>}
        </span>
      )}
    </div>
  )
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
  // The tile's expand button (LiveKit FocusToggle) pins a track in the layout context: the pinned tile takes the stage
  // until the same button is pressed again. Ignored once that participant/track has gone.
  const pinned = usePinnedTracks()[0]
  const pinnedLive = pinned && tracks.find((t) => t.participant.identity === pinned.participant.identity && t.source === pinned.source)
  let focus: TrackReferenceOrPlaceholder | undefined = pinnedLive ?? screen
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
  const videoEl = useRef<HTMLVideoElement>(null)
  useScreenShareRecovery(screen && !p.isLocal && isTrackReference(trackRef) ? trackRef.publication : undefined, videoEl)

  return (
    <ParticipantTile trackRef={trackRef} data-testid={screen ? 'tile-screen' : 'tile'} data-identity={p.identity}>
      {showVideo ? (
        <VideoTrack ref={videoEl} trackRef={trackRef} data-testid={screen ? 'video-screen' : 'video-camera'} />
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

/**
 * A remote screen share that shows no picture (13 Nov 2026, live log: an iPhone/Safari that joined while someone was already
 * presenting was subscribed to the share by the server but never showed it). Every 2 s while no frame has arrived: make
 * sure it is subscribed and the element is playing (Safari can leave a newly attached video paused); after ~6 s without a
 * frame, re-subscribe (fresh negotiation + keyframe from the SFU) - at most 3 times. Never touches a share that is
 * rendering, never restarts the presenter's share, never creates a second track.
 */
function useScreenShareRecovery(pub: TrackPublication | undefined, el: React.RefObject<HTMLVideoElement | null>) {
  useEffect(() => {
    if (!(pub instanceof RemoteTrackPublication)) return
    let ticks = 0
    let resubscribes = 0
    const t = window.setInterval(() => {
      const v = el.current
      if (v && v.videoWidth > 0) {
        if (v.paused) void v.play().catch(() => undefined)
        ticks = 0
        return
      }
      if (!pub.isSubscribed) {
        pub.setSubscribed(true)
        return
      }
      if (v?.paused) void v.play().catch(() => undefined)
      if (++ticks >= 3 && resubscribes < 3) {
        ticks = 0
        resubscribes++
        console.warn(`[oic] screen share ${pub.trackSid} shows no picture - re-subscribing (${resubscribes}/3)`)
        pub.setSubscribed(false)
        window.setTimeout(() => pub.setSubscribed(true), 500)
      }
    }, 2000)
    return () => window.clearInterval(t)
  }, [pub, el])
}

/**
 * One clear message per camera/microphone failure (GoodDay #14220: a customer on Android Chrome got three identical "Your microphone
 * could not be started" toasts and no way forward - the browser had blocked the site's microphone). The reason decides the text,
 * with the steps to fix it; the same message is not repeated within 8 s (the toggle and LiveKit both report one failure).
 */
const lastDeviceNotice = new Map<string, number>()
type DeviceKind = 'microphone' | 'camera'
function deviceReason(e: unknown): 'denied' | 'busy' | 'missing' | 'other' {
  const name = (e as { name?: string } | null)?.name ?? String(e ?? '')
  if (/NotAllowed|PermissionDenied|Security/i.test(name)) return 'denied'
  if (/NotReadable|TrackStart|DeviceInUse|Abort/i.test(name)) return 'busy'
  if (/NotFound|DevicesNotFound|Overconstrained/i.test(name)) return 'missing'
  return 'other'
}
export function deviceMessage(kind: DeviceKind, reason: ReturnType<typeof deviceReason>) {
  const Dev = kind === 'microphone' ? 'Microphone' : 'Camera'
  if (reason === 'denied')
    return `${Dev} access is blocked for this site. Tap the lock icon next to the web address → Permissions → ${Dev} → Allow, then tap the ${kind} button again. On Android also check Settings → Apps → Chrome → Permissions.`
  if (reason === 'busy') return `Your ${kind} is being used by another app (for example a phone or WhatsApp call). Close that app, then tap the ${kind} button again.`
  if (reason === 'missing') return `No ${kind} was found on this device.`
  return `Your ${kind} could not be started. Check that the browser may use it, then tap the ${kind} button again.`
}
function notifyDevice(toast: { error: (t: string) => void }, kind: DeviceKind, e: unknown) {
  const reason = deviceReason(e)
  const key = `${kind}:${reason}`
  const now = Date.now()
  if (now - (lastDeviceNotice.get(key) ?? 0) < 8000) return
  lastDeviceNotice.set(key, now)
  toast.error(deviceMessage(kind, reason))
}

// ---- Controls --------------------------------------------------------------------------------------------------------

function MediaToggle({ source, labelOn, labelOff, iconOn, iconOff, testId }: { source: Track.Source.Microphone | Track.Source.Camera; labelOn: string; labelOff: string; iconOn: ReactNode; iconOff: ReactNode; testId: string }) {
  const toast = useToast()
  const { enabled, pending, toggle } = useTrackToggle({
    source,
    onDeviceError: (e) => notifyDevice(toast, source === Track.Source.Camera ? 'camera' : 'microphone', e),
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
  const toast = useToast()
  const [more, setMore] = useState(false)
  const camera = connection.canPublish && connection.canPublishVideo !== false
  // The participant is allowed to present, but this browser/OS can't capture a screen at all (getDisplayMedia
  // missing - common on phones). Say so rather than silently hiding the control with no explanation.
  const presentUnsupported = connection.canScreenShare && !canShareScreen && (
    <button
      type="button"
      className="oic-ctl opacity-60"
      onClick={() => toast.error('Screen sharing is not supported on this browser or device. Try a desktop browser such as Chrome or Edge.')}
      title="Screen sharing is not supported on this browser or device"
      aria-label="Screen sharing is not supported on this browser or device"
      data-testid="ctl-present-unsupported"
    >
      <MonitorX className="size-5" />
    </button>
  )
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
    <nav aria-label="Meeting controls" className="oic-controls flex shrink-0 items-center justify-between gap-2 px-2 sm:h-[68px] sm:px-5 [@media(max-height:500px)]:h-14" data-compact={compact || undefined}>
      {!compact && <div className="hidden w-48 lg:block" />}
      <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2.5">
        {connection.canPublish && (
          <MediaToggle source={Track.Source.Microphone} labelOn="Mute microphone" labelOff="Unmute microphone" iconOn={<Mic className="size-5" />} iconOff={<MicOff className="size-5" />} testId="ctl-mic" />
        )}
        {camera && (
          <MediaToggle source={Track.Source.Camera} labelOn="Turn camera off" labelOff="Turn camera on" iconOn={<Video className="size-5" />} iconOff={<VideoOff className="size-5" />} testId="ctl-cam" />
        )}
        {!compact && (connection.canScreenShare && canShareScreen ? <ScreenShareToggle /> : presentUnsupported) && <div className="oic-ctl-divider" aria-hidden />}
        {!compact && connection.canScreenShare && canShareScreen && <ScreenShareToggle />}
        {!compact && presentUnsupported}
        {!compact && hand}
        <button type="button" className="oic-ctl" data-on={panel === 'chat' || undefined} aria-pressed={panel === 'chat'} onClick={() => onPanel('chat')} title="Chat" data-testid="ctl-chat">
          <MessageSquare className="size-5" />
          {unread > 0 && <span className="oic-ctl-badge">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button type="button" className="oic-ctl" data-on={panel === 'people' || undefined} aria-pressed={panel === 'people'} onClick={() => onPanel('people')} title={waitingCount ? `Participants (${waitingCount} waiting)` : 'Participants'} data-testid="ctl-people">
          <Users className="size-5" />
          {waitingCount > 0 && <span className="oic-ctl-badge" data-testid="waiting-badge">{waitingCount}</span>}
        </button>
        {!compact && <div className="oic-ctl-divider" aria-hidden />}
        {!compact && layoutBtn}
        {!compact && settings}
        {!compact && extra}
        {compact && (
          <button type="button" className="oic-ctl" data-on={more || handRaised || undefined} aria-expanded={more} onClick={() => setMore(true)} title="More options" data-testid="ctl-more">
            <Ellipsis className="size-5" />
          </button>
        )}
        {!compact && <div className="oic-ctl-divider" aria-hidden />}
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
          {presentUnsupported && <SheetItem label="Present">{presentUnsupported}</SheetItem>}
          {end && <SheetItem label="End for all">{end}</SheetItem>}
        </MoreSheet>
      )}
    </nav>
  )
}

/**
 * Bottom sheet with the less frequent controls on phones. Closed by its Close button, a tap anywhere outside it, Escape,
 * or using any control. Rendered through a portal into the room element: the toolbar has backdrop-filter, which makes it
 * the containing block of "position: fixed" children, so inside it the "full-screen" backdrop only covered the toolbar
 * and tapping the video did nothing - on an iPhone there was no way to close the sheet (GoodDay MaXW9q, reopened 13 Nov).
 */
function MoreSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const target = (typeof document !== 'undefined' && document.querySelector<HTMLElement>('.oic-room')) || document.body
  return createPortal(
    <div className="fixed inset-0 z-40" data-testid="more-sheet">
      <button type="button" aria-label="Close more options" className="absolute inset-0 bg-black/40" onClick={onClose} data-testid="more-sheet-backdrop" />
      <div
        role="dialog"
        aria-label="More options"
        className="oic-panel oic-sheet absolute inset-x-2 bottom-2 rounded-2xl px-4 pb-4 pt-2"
        onClickCapture={(e) => (e.target as HTMLElement).closest('button') && window.setTimeout(onClose, 0)}
      >
        <div className="relative mb-2 flex h-11 items-center justify-center">
          <div className="h-1 w-10 rounded-full bg-white/25" aria-hidden />
          <button type="button" onClick={onClose} aria-label="Close" data-testid="more-sheet-close"
            className="absolute right-0 top-0 inline-flex size-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
            <X className="size-5" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">{children}</div>
        <SupportLine className="mt-4 border-t border-white/10 pt-3" />
      </div>
    </div>,
    target,
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
