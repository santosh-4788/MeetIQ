import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HubConnection } from '@microsoft/signalr'
import { API_BASE } from '../../config'
import { useAuth } from '../../auth/AuthContext'
import { chatApi, type ChatMessage, type ChatPreferences, type ChatStatus } from '../../api/chat'
import { silenced } from './quiet'

// One live connection per tab for Chat (SignalR, /api/v1/hubs/chat), mounted in the app layout so the menu badge and pushes work
// on every page. Does nothing at all unless the user has chat.use and the CHAT switch is on (the API answers enabled:false).

export type ConnectionState = 'off' | 'connecting' | 'online' | 'reconnecting' | 'offline'
type Handler = (payload: never) => void

type ChatContextValue = {
  status: ChatStatus | null
  enabled: boolean
  meId: string | null
  connection: ConnectionState
  unread: number
  preferences: ChatPreferences | null
  /** Subscribe to a server push ("message.new", "conversation.updated", "receipt", "presence", "typing", …, plus "reconnected"). */
  on: <T>(event: string, handler: (payload: T) => void) => () => void
  /** Send a hub signal (typing / delivered); silently ignored while offline. */
  signal: (method: 'Typing' | 'Delivered', ...args: unknown[]) => void
  refreshStatus: () => void
  setPreferences: (p: ChatPreferences) => void
  /** Conversation open on screen (no sound or badge bump for it). */
  setActiveConversation: (id: string | null) => void
  /** True while this conversation is open and the tab is visible (no popup for it). */
  isOnScreen: (conversationId: string) => boolean
}

const ChatContext = createContext<ChatContextValue | null>(null)

const EVENTS = ['message.new', 'message.updated', 'conversation.added', 'conversation.updated', 'conversation.removed', 'conversation.changed',
  'receipt', 'presence', 'typing', 'preferences', 'call.incoming', 'call.updated', 'call.ended', 'notification.new', 'reminder.due', 'reminder.updated',
  'scheduled.updated', 'pins.updated', 'task.changed', 'note.changed']

function readCookie(name: string) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1]
}

/** Short soft two-note tone (Web Audio, generated here: no audio file). Plays only when the browser allows sound. */
function ping() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    if (ctx.state === 'suspended') {
      void ctx.close()
      return
    }
    const now = ctx.currentTime
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, now + i * 0.11)
      g.gain.exponentialRampToValueAtTime(0.08, now + i * 0.11 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.18)
      o.connect(g).connect(ctx.destination)
      o.start(now + i * 0.11)
      o.stop(now + i * 0.11 + 0.2)
    }
    window.setTimeout(() => void ctx.close(), 600)
  } catch {
    /* no sound available */
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth()
  const allowed = !!user && can('chat.use')
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('off')
  const handlers = useRef(new Map<string, Set<Handler>>())
  const hub = useRef<HubConnection | null>(null)
  const active = useRef<string | null>(null)
  const statusTimer = useRef(0)
  const enabled = status?.enabled === true
  const meId = status?.enabled ? status.me.id : null
  // No sound while the person chose Do not disturb.
  const soundsOn = status?.enabled ? status.preferences.soundsOn && status.preferences.availability !== 'DND' : false
  const soundsRef = useRef(soundsOn)
  soundsRef.current = soundsOn
  const prefsRef = useRef(status?.enabled ? status.preferences : null)
  prefsRef.current = status?.enabled ? status.preferences : null

  const loadStatus = useCallback(() => {
    if (!allowed) return
    chatApi.status().then(setStatus, () => {
      /* keep the last known status (network blip) */
    })
  }, [allowed])

  const refreshStatus = useCallback(() => {
    window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(loadStatus, 400)
  }, [loadStatus])

  useEffect(() => {
    if (!allowed) {
      setStatus(null)
      return
    }
    loadStatus()
    // The administrator may switch Chat on or off at any time: look again every few minutes and when the tab comes back.
    const t = window.setInterval(loadStatus, 5 * 60_000)
    const onVisible = () => document.visibilityState === 'visible' && loadStatus()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [allowed, loadStatus])

  const emit = useCallback((event: string, payload: unknown) => {
    handlers.current.get(event)?.forEach((h) => {
      try {
        ;(h as (p: unknown) => void)(payload)
      } catch (e) {
        console.error(e)
      }
    })
  }, [])

  useEffect(() => {
    if (!enabled || !meId) {
      setConnection('off')
      return
    }
    let stopped = false
    let c: HubConnection | null = null
    // The SignalR client is loaded only when Chat is on for this person (not part of the main site bundle).
    void import('@microsoft/signalr').then(({ HubConnectionBuilder, LogLevel }) => {
      if (stopped) return
      c = new HubConnectionBuilder()
        .withUrl(`${API_BASE}/hubs/chat`, {
          withCredentials: true,
          // The negotiate request is a POST: it carries the same CSRF header as every other change request.
          headers: { 'X-XSRF-TOKEN': decodeURIComponent(readCookie('XSRF-TOKEN') ?? '') },
        })
        .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => [0, 2000, 5000, 10_000, 20_000][ctx.previousRetryCount] ?? 30_000 })
        .configureLogging(LogLevel.None)
        .build()
      wire(c)
    }, () => setConnection('offline'))
    const wire = (c: HubConnection) => {
    hub.current = c
    for (const evt of EVENTS) c.on(evt, (payload: unknown) => emit(evt, payload))
    c.onreconnecting(() => setConnection('reconnecting'))
    c.onreconnected(() => {
      setConnection('online')
      emit('reconnected', null)
      loadStatus()
      void chatApi.deliveredAll().catch(() => {})
    })
    c.onclose(() => {
      if (stopped) return
      setConnection('offline')
      // Closed for good (server restart, session check): try again a little later with a fresh connection.
      window.setTimeout(() => !stopped && start(), 15_000)
    })
    const start = () => {
      if (stopped || c.state !== 'Disconnected') return
      setConnection('connecting')
      c.start().then(
        () => {
          setConnection('online')
          emit('reconnected', null)
          void chatApi.deliveredAll().catch(() => {})
        },
        () => {
          setConnection('offline')
          window.setTimeout(() => !stopped && start(), 15_000)
        },
      )
    }
    start()
    }
    return () => {
      stopped = true
      hub.current = null
      void c?.stop()
    }
  }, [enabled, meId, emit, loadStatus])

  // Badge + sound: a new message from someone else in a conversation that is not on screen.
  useEffect(() => {
    if (!enabled) return
    const offs = [
      onEvent<ChatMessage>(handlers.current, 'message.new', (m) => {
        if (m.senderId && m.senderId !== meId) {
          hub.current?.state === 'Connected' && void hub.current.invoke('Delivered', m.conversationId, m.seq).catch(() => {})
          const onScreen = active.current === m.conversationId && document.visibilityState === 'visible'
          const mentioned = !!m.mentionsMe || (!!m.mentionAll && m.senderId !== meId) || !!m.mentions?.some((x) => x.id === meId)
          if (!onScreen && soundsRef.current && m.kind !== 'SYSTEM' && !silenced(prefsRef.current, mentioned ? 'mention' : 'message')) ping()
        }
        refreshStatus()
      }),
      onEvent(handlers.current, 'conversation.updated', refreshStatus),
      onEvent(handlers.current, 'conversation.added', refreshStatus),
      onEvent(handlers.current, 'conversation.removed', refreshStatus),
      onEvent(handlers.current, 'message.updated', refreshStatus),
      onEvent<ChatPreferences>(handlers.current, 'preferences', (p) => setStatus((s) => (s?.enabled ? { ...s, preferences: p } : s))),
    ]
    return () => offs.forEach((o) => o())
  }, [enabled, meId, refreshStatus])

  const on = useCallback(<T,>(event: string, handler: (payload: T) => void) => onEvent(handlers.current, event, handler), [])
  const signal = useCallback((method: 'Typing' | 'Delivered', ...args: unknown[]) => {
    const c = hub.current
    if (c?.state === 'Connected') void c.invoke(method, ...args).catch(() => {})
  }, [])
  const setPreferences = useCallback((p: ChatPreferences) => setStatus((s) => (s?.enabled ? { ...s, preferences: p } : s)), [])
  const setActiveConversation = useCallback((id: string | null) => {
    active.current = id
  }, [])
  const isOnScreen = useCallback((id: string) => active.current === id && document.visibilityState === 'visible', [])

  const value = useMemo<ChatContextValue>(
    () => ({
      status,
      enabled,
      meId,
      connection,
      unread: status?.enabled ? status.unread.conversations : 0,
      preferences: status?.enabled ? status.preferences : null,
      on,
      signal,
      refreshStatus,
      setPreferences,
      setActiveConversation,
      isOnScreen,
    }),
    [status, enabled, meId, connection, on, signal, refreshStatus, setPreferences, setActiveConversation, isOnScreen],
  )
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

function onEvent<T>(map: Map<string, Set<Handler>>, event: string, handler: (payload: T) => void) {
  let set = map.get(event)
  if (!set) map.set(event, (set = new Set()))
  set.add(handler as Handler)
  return () => {
    set.delete(handler as Handler)
  }
}

const OFF: ChatContextValue = {
  status: null,
  enabled: false,
  meId: null,
  connection: 'off',
  unread: 0,
  preferences: null,
  on: () => () => {},
  signal: () => {},
  refreshStatus: () => {},
  setPreferences: () => {},
  setActiveConversation: () => {},
  isOnScreen: () => false,
}

/** Chat state for any component (outside the provider: Chat is simply off). */
export function useChat() {
  return useContext(ChatContext) ?? OFF
}
