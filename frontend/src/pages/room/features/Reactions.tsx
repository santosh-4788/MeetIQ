import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRoomContext } from '@livekit/components-react'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'

/** Peer-to-peer over LiveKit (nothing stored): a reaction lasts a few seconds and never touches the video. */
export const TOPIC_REACTION = 'oic.reaction'

export const REACTIONS = [
  { kind: 'like', emoji: '👍', label: 'Like' },
  { kind: 'applause', emoji: '👏', label: 'Applause' },
  { kind: 'heart', emoji: '❤️', label: 'Heart' },
  { kind: 'celebrate', emoji: '🎉', label: 'Celebrate' },
  { kind: 'thinking', emoji: '🤔', label: 'Thinking' },
  { kind: 'dislike', emoji: '👎', label: 'Thumbs down' },
] as const
export type ReactionKind = (typeof REACTIONS)[number]['kind']

type Floating = { id: number; emoji: string; name: string; left: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const SHOW_MS = 4000
const MIN_GAP_MS = 600 // one reaction every 0.6 s per sender: no flooding the room

let seq = 0

export function useReactions(enabled: boolean) {
  const room = useRoomContext()
  const [items, setItems] = useState<Floating[]>([])
  const last = useRef(0)
  const lastFrom = useRef(new Map<string, number>())

  const show = useCallback((kind: string, name: string) => {
    const r = REACTIONS.find((x) => x.kind === kind)
    if (!r) return // only the six known reactions are ever shown
    const id = ++seq
    setItems((xs) => [...xs.slice(-11), { id, emoji: r.emoji, name, left: 6 + Math.random() * 22 }])
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), SHOW_MS)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC_REACTION || !participant) return
      const now = Date.now()
      if (now - (lastFrom.current.get(participant.identity) ?? 0) < MIN_GAP_MS / 2) return
      lastFrom.current.set(participant.identity, now)
      try {
        const d = JSON.parse(decoder.decode(payload)) as { kind?: string }
        if (typeof d.kind === 'string') show(d.kind, participant.name || 'Someone')
      } catch {
        /* not ours */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [enabled, room, show])

  const send = useCallback(
    (kind: ReactionKind) => {
      const now = Date.now()
      if (now - last.current < MIN_GAP_MS) return
      last.current = now
      show(kind, 'You')
      // Lossy is fine for a reaction; a failure never disturbs the call.
      void room.localParticipant.publishData(encoder.encode(JSON.stringify({ kind })), { reliable: false, topic: TOPIC_REACTION }).catch(() => undefined)
    },
    [room, show],
  )

  return { items, send }
}

export function ReactionOverlay({ items }: { items: Floating[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-live="polite" data-testid="reaction-overlay">
      <AnimatePresence>
        {items.map((r) => (
          <motion.div
            key={r.id}
            className="absolute bottom-4 flex flex-col items-center gap-1"
            style={{ left: `${r.left}%` }}
            initial={{ opacity: 0, y: 20, scale: 0.6 }}
            animate={{ opacity: [0, 1, 1, 0], y: -220, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: SHOW_MS / 1000, ease: 'easeOut' }}
            data-testid="reaction-bubble"
          >
            <span className="text-[34px] leading-none drop-shadow-lg" aria-hidden>{r.emoji}</span>
            <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white">{r.name}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function ReactionPicker({ onPick }: { onPick: (k: ReactionKind) => void }) {
  return (
    <div className="flex items-center justify-between gap-1" role="group" aria-label="Send a reaction">
      {REACTIONS.map((r) => (
        <button
          key={r.kind}
          type="button"
          onClick={() => onPick(r.kind)}
          title={r.label}
          aria-label={r.label}
          className="flex size-10 items-center justify-center rounded-full text-[22px] transition hover:scale-110 hover:bg-white/10 active:scale-95"
          data-testid={`reaction-${r.kind}`}
        >
          <span aria-hidden>{r.emoji}</span>
        </button>
      ))}
    </div>
  )
}
