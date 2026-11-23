import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Room as LkRoom } from 'livekit-client'
import { callsApi, resolveCallUrl, type Call, type CallConnection } from '../../api/calls'
import { notifyNotificationsChanged } from '../../api/notifications'
import { errorMessage } from '../../api/types'
import { useToast } from '../../components/ui/Toast'
import { useChat } from './ChatProvider'
import { appNotify, bridge } from '../room/androidBridge'
import { silenced } from './quiet'
// The call screen is its own chunk: loaded only for people who have calls.
const CallOverlay = lazy(() => import('./CallOverlay').then((m) => ({ default: m.CallOverlay })))

// Audio calls (Phase 3): one call at a time per person, connected from whichever tab answered. The LiveKit client is loaded
// only when a call actually connects. Ringing reaches every open tab; answering in one stops the ringing in the others.

export type CallPhase = 'calling' | 'connecting' | 'connected' | 'reconnecting' | 'ended'
export type ActiveCall = {
  call: Call
  phase: CallPhase
  muted: boolean
  speaking: string[]
  quality: 'excellent' | 'good' | 'poor' | 'lost' | null
  connectedAt: number | null
  micError: string | null
  endedText: string | null
}

type CallsContextValue = {
  enabled: boolean
  maxParticipants: number
  active: ActiveCall | null
  incoming: Call[]
  /** A call I am in that is connected in another tab or window (offer "Join here"). */
  elsewhere: Call | null
  start: (conversationId: string) => void
  accept: (callId: string) => void
  decline: (callId: string) => void
  hangUp: () => void
  endForAll: () => void
  toggleMute: () => void
  invite: (userIds: string[]) => Promise<void>
  devices: () => Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; input: string; output: string }>
  setInput: (deviceId: string) => void
  setOutput: (deviceId: string) => void
  joinHere: () => void
}

const CallsContext = createContext<CallsContextValue | null>(null)
const MIC_KEY = 'oic.call.mic'
const SPEAKER_KEY = 'oic.call.speaker'

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* not remembered */
  }
}

/** Identity on the audio server for a user id (matches the API: "call-u-" + id without dashes). */
const userOf = (identity: string) => identity.replace(/^call-u-/, '')
const sameUser = (userId: string, identityHex: string) => userId.replace(/-/g, '').toLowerCase() === identityHex.toLowerCase()

/** Original ringtone / ringback, generated with Web Audio (no audio file). */
function useTone() {
  const ctx = useRef<AudioContext | null>(null)
  const timer = useRef(0)
  const stop = useCallback(() => {
    window.clearInterval(timer.current)
    timer.current = 0
  }, [])
  const play = useCallback(
    (kind: 'incoming' | 'outgoing') => {
      stop()
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return
        ctx.current ??= new Ctx()
        const c = ctx.current
        if (c.state === 'suspended') void c.resume().catch(() => {})
        const burst = () => {
          if (c.state !== 'running') return
          const now = c.currentTime
          const notes = kind === 'incoming' ? [[784, 0], [988, 0.18], [784, 0.5], [988, 0.68]] : [[440, 0], [480, 0]]
          for (const [f, t] of notes) {
            const o = c.createOscillator()
            const g = c.createGain()
            o.type = 'sine'
            o.frequency.value = f
            const len = kind === 'incoming' ? 0.16 : 1.2
            g.gain.setValueAtTime(0.0001, now + t)
            g.gain.exponentialRampToValueAtTime(kind === 'incoming' ? 0.12 : 0.035, now + t + 0.02)
            g.gain.exponentialRampToValueAtTime(0.0001, now + t + len)
            o.connect(g).connect(c.destination)
            o.start(now + t)
            o.stop(now + t + len + 0.05)
          }
        }
        burst()
        timer.current = window.setInterval(burst, kind === 'incoming' ? 2200 : 4000)
      } catch {
        /* no sound available: the popup still shows */
      }
    },
    [stop],
  )
  useEffect(() => stop, [stop])
  return { play, stop }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const chat = useChat()
  const toast = useToast()
  const [enabled, setEnabled] = useState(false)
  const [maxParticipants, setMax] = useState(10)
  const [active, setActive] = useState<ActiveCall | null>(null)
  const [incoming, setIncoming] = useState<Call[]>([])
  const [elsewhere, setElsewhere] = useState<Call | null>(null)
  const room = useRef<LkRoom | null>(null)
  const audioBox = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<ActiveCall | null>(null)
  activeRef.current = active
  const leaving = useRef(false)
  const tone = useTone()
  const meId = chat.meId
  const prefs = chat.preferences
  const ringAllowed = !!prefs?.soundsOn && prefs.availability !== 'DND' && !silenced(prefs, 'call')

  useEffect(() => {
    if (!chat.enabled) {
      setEnabled(false)
      return
    }
    callsApi.current().then(
      (r) => {
        setEnabled(r.enabled)
        setMax(r.maxParticipants)
        if (!r.enabled || !meId) return
        const mine = (c: Call) => c.participants.find((p) => p.id === meId)
        setIncoming((r.calls ?? []).filter((c) => mine(c)?.state === 'RINGING'))
        const inCall = (r.calls ?? []).find((c) => mine(c)?.state === 'ACCEPTED')
        if (inCall && !activeRef.current) setElsewhere(inCall)
      },
      () => setEnabled(false),
    )
  }, [chat.enabled, chat.connection, meId])

  // The call that was just finished: a LiveKit connect still in flight for it must not revive it (20 Nov 2026 fix).
  const finishedId = useRef<string | null>(null)
  // call.ended can arrive before my own start / accept reply (a very quick decline): remember recent ends.
  const endedCalls = useRef(new Map<string, Call>())

  const disconnectRoom = useCallback(() => {
    const r = room.current
    room.current = null
    if (r) {
      leaving.current = true
      void r.disconnect().finally(() => (leaving.current = false))
    }
    if (audioBox.current) audioBox.current.innerHTML = ''
  }, [])

  const finish = useCallback(
    (text: string | null) => {
      finishedId.current = activeRef.current?.call.id ?? null
      disconnectRoom()
      tone.stop()
      // The first reason wins (a late status update must not replace "declined" / "busy" with "you left").
      setActive((a) => (a ? { ...a, phase: 'ended', endedText: a.phase === 'ended' && a.endedText ? a.endedText : text } : a))
      window.setTimeout(() => setActive((a) => (a?.phase === 'ended' ? null : a)), 2600)
    },
    [disconnectRoom, tone],
  )

  const connect = useCallback(
    async (conn: CallConnection) => {
      const lk = await import('livekit-client')
      const mic = read(MIC_KEY)
      const r = new lk.Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(mic ? { deviceId: mic } : {}) },
        publishDefaults: { dtx: true, red: true },
      })
      room.current = r
      const box = audioBox.current
      r.on(lk.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== 'audio' || !box) return
        const el = track.attach() as HTMLAudioElement
        const speaker = read(SPEAKER_KEY)
        const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
        if (speaker && sink.setSinkId) void sink.setSinkId(speaker).catch(() => {})
        box.appendChild(el)
      })
      r.on(lk.RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
      r.on(lk.RoomEvent.ActiveSpeakersChanged, (speakers) =>
        setActive((a) => (a ? { ...a, speaking: speakers.map((s) => userOf(s.identity)) } : a)),
      )
      r.on(lk.RoomEvent.ConnectionQualityChanged, (q, participant) => {
        if (participant.identity !== r.localParticipant.identity) return
        setActive((a) => (a ? { ...a, quality: q === 'unknown' ? null : (q as ActiveCall['quality']) } : a))
      })
      r.on(lk.RoomEvent.Reconnecting, () => setActive((a) => (a && a.phase !== 'ended' ? { ...a, phase: 'reconnecting' } : a)))
      r.on(lk.RoomEvent.Reconnected, () => setActive((a) => (a && a.phase !== 'ended' ? { ...a, phase: 'connected' } : a)))
      r.on(lk.RoomEvent.Disconnected, (reason) => {
        if (leaving.current || room.current !== r) return
        room.current = null
        // Replaced by the same person joining from another tab, or dropped for good.
        // The server closed the room because the call ended: the reason (declined, busy, ended) arrives as call.ended.
        if (reason === lk.DisconnectReason.ROOM_DELETED) {
          const id = activeRef.current?.call.id
          window.setTimeout(() => activeRef.current?.call.id === id && activeRef.current?.phase !== 'ended' && finish('Call ended'), 3000)
          return
        }
        if (reason === lk.DisconnectReason.DUPLICATE_IDENTITY) {
          const a = activeRef.current
          setActive(null)
          if (a) setElsewhere(a.call)
          return
        }
        finish('The call was disconnected.')
      })
      await r.connect(resolveCallUrl(conn.url), conn.token, { autoSubscribe: true })
      // Declined, busy or ended while we were still connecting: leave quietly and keep the end reason on screen.
      if (room.current !== r) {
        void r.disconnect()
        return
      }
      setActive((a) => (a && a.phase !== 'ended' ? { ...a, phase: a.call.status === 'RINGING' ? 'calling' : 'connected', connectedAt: a.connectedAt ?? (a.call.status === 'ACTIVE' ? Date.now() : null) } : a))
      try {
        await r.localParticipant.setMicrophoneEnabled(true)
      } catch (e) {
        if (room.current !== r) return
        setActive((a) => (a && a.phase !== 'ended' ? { ...a, muted: true, micError: e instanceof Error && /denied|NotAllowed/i.test(`${e.name} ${e.message}`) ? 'Microphone blocked: allow it in the browser to be heard.' : 'Your microphone could not be started.' } : a))
      }
      void r.startAudio().catch(() => {})
    },
    [finish],
  )

  const askNotifications = () => {
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    } catch {
      /* not available */
    }
  }

  const begin = useCallback(
    async (call: Call, conn: CallConnection | null) => {
      setElsewhere(null)
      call = endedCalls.current.get(call.id) ?? call
      const ended = call.status !== 'RINGING' && call.status !== 'ACTIVE'
      setActive({ call, phase: ended ? 'ended' : call.status === 'RINGING' ? 'calling' : 'connecting', muted: false, speaking: [], quality: null, connectedAt: null, micError: null, endedText: ended ? endText(call, meId) : null })
      if (ended || !conn) {
        window.setTimeout(() => setActive((a) => (a?.call.id === call.id && a.phase === 'ended' ? null : a)), 3000)
        return
      }
      try {
        await connect(conn)
        const late = endedCalls.current.get(call.id)
        if (late && finishedId.current !== call.id) finish(endText(late, meId))
      } catch (e) {
        if (finishedId.current === call.id) return // the call ended while connecting: not an error
        toast.error(errorMessage(e, 'The call could not be connected. Check your network and try again.'))
        void callsApi.leave(call.id).catch(() => {})
        finish('The call could not be connected.')
      }
    },
    [connect, finish, toast, meId],
  )

  const start = useCallback(
    (conversationId: string) => {
      if (activeRef.current) {
        toast.error('You are already in a call.')
        return
      }
      askNotifications()
      callsApi.start(conversationId).then((r) => void begin(r.call, r.connection), (e) => toast.error(errorMessage(e, 'The call could not be started.')))
    },
    [begin, toast],
  )

  const accept = useCallback(
    (callId: string) => {
      tone.stop()
      setIncoming((list) => list.filter((c) => c.id !== callId))
      if (activeRef.current && activeRef.current.call.id !== callId) {
        toast.error('Leave your current call first.')
        return
      }
      askNotifications()
      callsApi.accept(callId).then((r) => void begin(r.call, r.connection), (e) => toast.error(errorMessage(e, 'The call could not be answered.')))
    },
    [begin, toast, tone],
  )

  const decline = useCallback(
    (callId: string) => {
      setIncoming((list) => list.filter((c) => c.id !== callId))
      void callsApi.decline(callId).catch(() => {})
    },
    [],
  )

  const hangUp = useCallback(() => {
    const a = activeRef.current
    if (!a) return
    const direct = a.call.type === 'DIRECT'
    void (direct ? callsApi.end(a.call.id) : callsApi.leave(a.call.id)).catch(() => {})
    finish(direct ? 'Call ended' : 'You left the call')
  }, [finish])

  const endForAll = useCallback(() => {
    const a = activeRef.current
    if (!a) return
    void callsApi.end(a.call.id).catch((e) => toast.error(errorMessage(e, 'The call could not be ended.')))
    finish('Call ended')
  }, [finish, toast])

  const toggleMute = useCallback(() => {
    const r = room.current
    if (!r) return
    const next = !r.localParticipant.isMicrophoneEnabled
    void r.localParticipant.setMicrophoneEnabled(next).then(
      () => setActive((a) => (a ? { ...a, muted: !next, micError: next ? null : a.micError } : a)),
      () => setActive((a) => (a ? { ...a, micError: 'Your microphone could not be started.' } : a)),
    )
  }, [])

  const invite = useCallback(async (userIds: string[]) => {
    const a = activeRef.current
    if (!a) return
    const call = await callsApi.invite(a.call.id, userIds)
    setActive((x) => (x ? { ...x, call } : x))
  }, [])

  const devices = useCallback(async () => {
    const lk = await import('livekit-client')
    const [inputs, outputs] = await Promise.all([lk.Room.getLocalDevices('audioinput').catch(() => []), lk.Room.getLocalDevices('audiooutput').catch(() => [])])
    return { inputs, outputs, input: read(MIC_KEY), output: read(SPEAKER_KEY) }
  }, [])

  const setInput = useCallback((deviceId: string) => {
    write(MIC_KEY, deviceId)
    void room.current?.switchActiveDevice('audioinput', deviceId).catch(() => toast.error('That microphone could not be used.'))
  }, [toast])

  const setOutput = useCallback((deviceId: string) => {
    write(SPEAKER_KEY, deviceId)
    void room.current?.switchActiveDevice('audiooutput', deviceId).catch(() => {})
    audioBox.current?.querySelectorAll('audio').forEach((el) => {
      const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
      if (sink.setSinkId) void sink.setSinkId(deviceId).catch(() => {})
    })
  }, [toast])

  const joinHere = useCallback(() => {
    const c = elsewhere
    if (!c) return
    callsApi.token(c.id).then((r) => void begin(r.call, r.connection), (e) => {
      setElsewhere(null)
      toast.error(errorMessage(e, 'The call is no longer going on.'))
    })
  }, [elsewhere, begin, toast])

  // Pushes from the server.
  useEffect(() => {
    if (!enabled || !meId) return
    const mine = (c: Call) => c.participants.find((p) => p.id === meId)
    const offs = [
      chat.on<Call>('call.incoming', (c) => {
        if (mine(c)?.state !== 'RINGING' || activeRef.current?.call.id === c.id) return
        setIncoming((list) => [c, ...list.filter((x) => x.id !== c.id)])
        try {
          const title = `Incoming call from ${c.startedBy?.name ?? 'a colleague'}`
          const body = c.title ? `Group audio call · ${c.title}` : 'Audio call'
          // Android app (1.2.0+) in the background: a phone notification that opens the app on the call (23 Nov 2026).
          if (document.visibilityState !== 'visible' && appNotify(title, body, '/chat', `call-${c.id}`)) return
          if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(title, { body, tag: `call-${c.id}`, requireInteraction: true })
            n.onclick = () => {
              window.focus()
              n.close()
            }
          }
        } catch {
          /* not available */
        }
      }),
      chat.on<Call>('call.updated', (c) => {
        const me = mine(c)
        setIncoming((list) => (me?.state === 'RINGING' ? list.map((x) => (x.id === c.id ? c : x)) : list.filter((x) => x.id !== c.id)))
        const a = activeRef.current
        if (c.status !== 'RINGING' && c.status !== 'ACTIVE') return // call.ended handles the end
        if (a?.call.id === c.id) {
          const wasRinging = a.call.status === 'RINGING'
          setActive((x) => (x ? { ...x, call: c, phase: x.phase === 'calling' && c.status === 'ACTIVE' ? 'connected' : x.phase, connectedAt: x.connectedAt ?? (wasRinging && c.status === 'ACTIVE' ? Date.now() : null) } : x))
          if (me && me.state !== 'ACCEPTED') finish('You left the call')
        } else if (me?.state === 'ACCEPTED' && (c.status === 'ACTIVE' || c.status === 'RINGING')) setElsewhere(c)
        else setElsewhere((e) => (e?.id === c.id ? null : e))
      }),
      chat.on<Call>('call.ended', (c) => {
        endedCalls.current.set(c.id, c)
        if (endedCalls.current.size > 20) endedCalls.current.delete(endedCalls.current.keys().next().value!)
        setIncoming((list) => list.filter((x) => x.id !== c.id))
        setElsewhere((e) => (e?.id === c.id ? null : e))
        if (activeRef.current?.call.id === c.id) {
          setActive((x) => (x ? { ...x, call: c } : x))
          finish(endText(c, meId))
        }
      }),
      chat.on('notification.new', () => notifyNotificationsChanged()),
    ]
    return () => offs.forEach((o) => o())
  }, [enabled, meId, chat, finish])

  // Inside the Android app: keep the microphone (and the call) alive while the screen is off or the app is in the
  // background, with the same foreground service the meeting room uses. Sent only when a call starts and ends.
  const inCall = !!active && active.phase !== 'ended'
  const toldAndroid = useRef(false)
  useEffect(() => {
    if (inCall === toldAndroid.current) return
    toldAndroid.current = inCall
    try {
      bridge()?.postMessage(JSON.stringify({ type: 'inMeeting', on: inCall }))
    } catch {
      /* not in the app */
    }
  }, [inCall])

  // Ringtone (incoming) and ringback (my outgoing call while it rings).
  const ringingIn = incoming.length > 0
  const ringingOut = active?.phase === 'calling'
  useEffect(() => {
    if (ringingIn && ringAllowed && !active) tone.play('incoming')
    else if (ringingOut && ringAllowed) tone.play('outgoing')
    else tone.stop()
  }, [ringingIn, ringingOut, ringAllowed, active, tone])

  // Tab title while ringing in the background.
  useEffect(() => {
    if (!ringingIn) return
    const original = document.title
    const who = incoming[0]?.startedBy?.name ?? 'a colleague'
    let on = false
    const t = window.setInterval(() => {
      on = !on
      document.title = on ? `📞 Call from ${who}` : original
    }, 1000)
    return () => {
      window.clearInterval(t)
      document.title = original
    }
  }, [ringingIn, incoming])

  // Leaving the page ends my part of the call (the server also notices within ~25 s if the browser simply vanishes).
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      const a = activeRef.current
      if (!e.persisted && a && room.current) {
        const csrf = document.cookie.split('; ').find((x) => x.startsWith('XSRF-TOKEN='))?.split('=')[1]
        void fetch(`${import.meta.env.BASE_URL}api/v1/chat/calls/${a.call.id}/leave`, {
          method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': decodeURIComponent(csrf ?? '') }, body: '{}',
        }).catch(() => {})
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  const value = useMemo<CallsContextValue>(
    () => ({ enabled: enabled && chat.enabled, maxParticipants, active, incoming, elsewhere, start, accept, decline, hangUp, endForAll, toggleMute, invite, devices, setInput, setOutput, joinHere }),
    [enabled, chat.enabled, maxParticipants, active, incoming, elsewhere, start, accept, decline, hangUp, endForAll, toggleMute, invite, devices, setInput, setOutput, joinHere],
  )

  return (
    <CallsContext.Provider value={value}>
      {children}
      <div ref={audioBox} className="hidden" aria-hidden />
      {value.enabled && (
        <Suspense fallback={null}>
          <CallOverlay />
        </Suspense>
      )}
    </CallsContext.Provider>
  )
}

/** Why a call ended, from my side. */
export function endText(c: Call, meId: string | null) {
  const others = c.participants.filter((p) => p.id !== meId)
  const name = c.title ?? others[0]?.name ?? 'Your colleague'
  if (c.status === 'ENDED') return 'Call ended'
  if (c.endReason === 'BUSY') return `${name} is busy`
  if (c.status === 'DECLINED') return `${name} declined the call`
  if (c.status === 'MISSED') return c.startedBy?.id === meId ? 'No answer' : 'Missed call'
  return 'Call ended'
}

export const matchesIdentity = sameUser

const OFF: CallsContextValue = {
  enabled: false,
  maxParticipants: 10,
  active: null,
  incoming: [],
  elsewhere: null,
  start: () => {},
  accept: () => {},
  decline: () => {},
  hangUp: () => {},
  endForAll: () => {},
  toggleMute: () => {},
  invite: async () => {},
  devices: async () => ({ inputs: [], outputs: [], input: '', output: '' }),
  setInput: () => {},
  setOutput: () => {},
  joinHere: () => {},
}

export function useCalls() {
  return useContext(CallsContext) ?? OFF
}
