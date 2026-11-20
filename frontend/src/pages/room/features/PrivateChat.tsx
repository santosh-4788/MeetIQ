import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useRoomContext } from '@livekit/components-react'
import { usePeople } from '../androidApp'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import { ArrowLeft, LockKeyhole, Send } from 'lucide-react'
import { CHAT_MAX_LENGTH } from '../../../api/room'
import type { FeatureCalls, PrivateMessage } from '../../../api/roomFeatures'
import { errorMessage } from '../../../api/types'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { formatTime } from '../../../lib/format'
import { initialsOf } from '../PreJoin'
import { PanelHeader } from '../RoomPanels'

/** Server -> exactly the sender and the recipient (RoomFeatureEndpoints.PrivateTopic). Only server-sent messages are trusted. */
export const TOPIC_PRIVATE = 'oic.private'

/**
 * 1:1 messages. Sending always goes through the API (it checks both people are in this meeting and stores the message);
 * the server then delivers it live to the two identities only. Nobody else - the host included - can read them.
 */
export function usePrivateChat(calls: FeatureCalls['private'] | undefined, enabled: boolean, openWith: string | null) {
  const room = useRoomContext()
  // The local identity is only known once the connection is up: track it explicitly (a value captured before connecting
  // would be empty and every incoming message would look like someone else's).
  const [me, setMe] = useState(() => room.localParticipant.identity)
  useEffect(() => {
    const update = () => setMe(room.localParticipant.identity)
    update()
    room.on(RoomEvent.SignalConnected, update)
    room.on(RoomEvent.Connected, update)
    room.on(RoomEvent.Reconnected, update)
    return () => {
      room.off(RoomEvent.SignalConnected, update)
      room.off(RoomEvent.Connected, update)
      room.off(RoomEvent.Reconnected, update)
    }
  }, [room])
  const [items, setItems] = useState<PrivateMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const openRef = useRef(openWith)
  openRef.current = openWith

  const merge = useCallback((xs: PrivateMessage[]) => {
    setItems((cur) => {
      const byId = new Map(cur.map((m) => [m.id, m]))
      for (const m of xs) byId.set(m.id, { ...byId.get(m.id), ...m })
      return [...byId.values()].sort((a, b) => a.id - b.id)
    })
  }, [])

  const load = useCallback(() => {
    if (!calls || !enabled) return
    calls
      .list()
      .then((r) => {
        merge(r.items)
        setError(null)
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Private messages could not be loaded.')))
  }, [calls, enabled, merge])

  useEffect(() => {
    if (!enabled) return
    load()
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC_PRIVATE || participant) return // server-sent only
      try {
        const self = room.localParticipant.identity
        const m = JSON.parse(new TextDecoder().decode(payload)) as PrivateMessage
        if (typeof m.id !== 'number' || (m.toIdentity !== self && m.fromIdentity !== self)) return
        merge([{ ...m, read: m.fromIdentity === self || m.fromIdentity === openRef.current }])
        if (m.toIdentity === self && m.fromIdentity === openRef.current) void calls?.read(m.fromIdentity).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    room.on(RoomEvent.Reconnected, load) // delivered while offline: fetched from the server
    return () => {
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.Reconnected, load)
    }
  }, [enabled, load, merge, room, calls])

  // Opening a conversation marks its incoming messages read (locally at once, on the server best-effort).
  useEffect(() => {
    if (!openWith || !calls) return
    if (!items.some((m) => m.fromIdentity === openWith && m.toIdentity === me && !m.read)) return
    setItems((xs) => xs.map((m) => (m.fromIdentity === openWith && m.toIdentity === me ? { ...m, read: true } : m)))
    void calls.read(openWith).catch(() => undefined)
  }, [openWith, items, me, calls])

  const unreadBy = useMemo(() => {
    const u = new Map<string, number>()
    for (const m of items) if (m.toIdentity === me && !m.read) u.set(m.fromIdentity, (u.get(m.fromIdentity) ?? 0) + 1)
    return u
  }, [items, me])
  const unread = [...unreadBy.values()].reduce((a, b) => a + b, 0)

  const send = useCallback(
    async (to: string, body: string) => {
      if (!calls) return
      const m = await calls.send(to, body)
      merge([{ ...m, read: true }])
    },
    [calls, merge],
  )

  return { items, me, unread, unreadBy, error, send }
}

export function PrivateChatPanel({
  chat,
  withIdentity,
  onWith,
  onClose,
}: {
  chat: ReturnType<typeof usePrivateChat>
  withIdentity: string | null
  onWith: (identity: string | null) => void
  onClose: () => void
}) {
  const participants = usePeople()
  const others = participants.filter((p) => p.identity !== chat.me)
  const names = new Map<string, string>()
  for (const m of chat.items) {
    names.set(m.fromIdentity, m.fromName)
    names.set(m.toIdentity, m.toName)
  }
  for (const p of others) names.set(p.identity, p.name || p.identity)
  // People in the room, plus anyone you already talked to who has left.
  const people = [...new Set([...others.map((p) => p.identity), ...chat.items.map((m) => (m.fromIdentity === chat.me ? m.toIdentity : m.fromIdentity))])]
  const present = new Set(others.map((p) => p.identity))

  if (withIdentity)
    return (
      <Conversation
        chat={chat}
        withIdentity={withIdentity}
        name={names.get(withIdentity) ?? 'Participant'}
        present={present.has(withIdentity)}
        onBack={() => onWith(null)}
        onClose={onClose}
      />
    )

  return (
    <>
      <PanelHeader title="Private messages" subtitle="Only you and the other person can read them." onClose={onClose} />
      <ul className="oic-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-3" data-testid="private-people">
        {chat.error && <li className="mx-2 rounded-md bg-white/5 px-3 py-2 text-[12px] text-white/60">{chat.error}</li>}
        {people.length === 0 && <li className="m-auto text-center text-[13px] text-white/50">Nobody else is in the meeting yet.</li>}
        {people.map((id) => {
          const n = chat.unreadBy.get(id) ?? 0
          const last = [...chat.items].reverse().find((m) => m.fromIdentity === id || m.toIdentity === id)
          return (
            <li key={id}>
              <button type="button" onClick={() => onWith(id)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.07]" data-testid="private-person">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12px] font-semibold">{initialsOf(names.get(id) ?? '?')}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{names.get(id) ?? 'Participant'}{!present.has(id) && <span className="ml-1 text-[11px] font-normal text-white/45">(left)</span>}</span>
                  {last && <span className="block truncate text-[12px] text-white/50">{last.fromIdentity === chat.me ? 'You: ' : ''}{last.body}</span>}
                </span>
                {n > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-500 px-1.5 text-[11px] font-bold text-white" data-testid="private-unread">{n}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="flex items-start gap-2 border-t border-white/[0.07] px-4 py-3 text-[11.5px] leading-4 text-white/50">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Private messages are saved with the meeting record under the company’s retention rules. The host cannot see them.
      </p>
    </>
  )
}

function Conversation({
  chat,
  withIdentity,
  name,
  present,
  onBack,
  onClose,
}: {
  chat: ReturnType<typeof usePrivateChat>
  withIdentity: string
  name: string
  present: boolean
  onBack: () => void
  onClose: () => void
}) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const thread = chat.items.filter((m) => (m.fromIdentity === withIdentity && m.toIdentity === chat.me) || (m.fromIdentity === chat.me && m.toIdentity === withIdentity))

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [thread.length])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    const body = text.trim()
    if (!body || body.length > CHAT_MAX_LENGTH || busy) return
    setBusy(true)
    try {
      await chat.send(withIdentity, body)
      setText('')
    } catch (err) {
      toast.error(errorMessage(err, 'The message could not be sent.'))
    } finally {
      setBusy(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <>
      <PanelHeader
        title={name}
        subtitle={<span className="inline-flex items-center gap-1"><LockKeyhole className="size-3" aria-hidden /> Private conversation</span>}
        action={
          <button type="button" onClick={onBack} aria-label="Back to people" className="flex size-8 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white" data-testid="private-back">
            <ArrowLeft className="size-4" />
          </button>
        }
        onClose={onClose}
      />
      <ol ref={list} className="oic-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" aria-live="polite" data-testid="private-thread">
        {thread.length === 0 && <li className="m-auto text-center text-[13px] text-white/50">Send {name} a private message.</li>}
        {thread.map((m) => {
          const mine = m.fromIdentity === chat.me
          return (
            <li key={m.id} className={cn('flex max-w-[92%] flex-col', mine ? 'items-end self-end' : 'items-start')} data-testid="private-message">
              <span className="mb-1 text-[11.5px] text-white/50">{mine ? 'You' : m.fromName} · {formatTime(m.sentUtc, 'Asia/Kolkata')}</span>
              <p className={cn('rounded-2xl px-3.5 py-2 text-[13.5px] leading-5 break-words whitespace-pre-wrap', mine ? 'rounded-br-md bg-violet-500 text-white' : 'rounded-bl-md bg-white/10 text-white')}>{m.body}</p>
            </li>
          )
        })}
      </ol>
      <form onSubmit={submit} className="border-t border-white/[0.07] p-3">
        {!present && <p className="mb-2 text-[11.5px] text-amber-200/80">{name} has left the meeting; they will see this if they rejoin.</p>}
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="oic-private-input">Private message</label>
          <textarea
            id="oic-private-input"
            className="oic-input oic-scroll max-h-32 min-h-[44px] resize-none"
            rows={1}
            placeholder={`Message ${name} privately`}
            value={text}
            maxLength={CHAT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            data-testid="private-input"
          />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send private message" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50" data-testid="private-send">
            <Send className="size-4" />
          </button>
        </div>
      </form>
    </>
  )
}
