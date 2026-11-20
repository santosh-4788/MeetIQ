import { useCallback, useEffect, useState } from 'react'
import { Pin, X } from 'lucide-react'
import { advApi, type PinItem } from '../../../api/chat'
import { errorMessage } from '../../../api/types'
import { useToast } from '../../../components/ui/Toast'
import { useChat } from '../ChatProvider'

/** iOS-style pinned bar under the chat header: shows a pinned message; tap jumps to it and moves to the next pin. */
export function PinnedBar({ conversationId, onJump, canUnpin }: { conversationId: string; onJump: (seq: number) => void; canUnpin: (p: PinItem) => boolean }) {
  const chat = useChat()
  const toast = useToast()
  const [pins, setPins] = useState<PinItem[]>([])
  const [i, setI] = useState(0)
  const load = useCallback(() => advApi.pins(conversationId).then(setPins, () => {}), [conversationId])
  useEffect(() => {
    void load()
    const offs = [
      chat.on<{ conversationId: string }>('pins.updated', (p) => p.conversationId === conversationId && void load()),
      chat.on('reconnected', () => void load()),
    ]
    return () => offs.forEach((o) => o())
  }, [chat, load, conversationId])
  useEffect(() => setI((x) => (pins.length ? Math.min(x, pins.length - 1) : 0)), [pins.length])
  if (pins.length === 0) return null
  const p = pins[i]
  const text = p.message.deleted ? 'Message deleted' : p.message.body ?? (p.message.file ? `📎 ${p.message.file.name}` : '')
  return (
    <div className="ios-bar ios-hairline-b relative z-[5] flex items-center gap-2 px-3 py-1.5" data-testid="pinned-bar">
      <span className="flex flex-col gap-0.5 self-stretch py-0.5" aria-hidden>
        {pins.slice(0, 4).map((x, k) => <span key={x.message.id} className={k === i % 4 ? 'w-[3px] flex-1 rounded-full bg-[var(--ios-blue)]' : 'w-[3px] flex-1 rounded-full bg-[var(--ios-gray4)]'} />)}
      </span>
      <button
        type="button"
        onClick={() => {
          onJump(p.message.seq)
          setI((x) => (x + 1) % pins.length)
        }}
        className="min-w-0 flex-1 text-left"
        aria-label={`Pinned message ${i + 1} of ${pins.length}: ${text}`}
      >
        <span className="flex items-center gap-1 text-[12px] font-semibold text-[var(--ios-blue)]">
          <Pin className="size-3" /> Pinned{pins.length > 1 ? ` · ${i + 1} of ${pins.length}` : ''}
        </span>
        <span className="block truncate text-[14px]">{text}</span>
      </button>
      {canUnpin(p) && (
        <button
          type="button"
          aria-label="Unpin this message"
          onClick={() => advApi.pinMessage(p.message.id, false).then(() => void load(), (e) => toast.error(errorMessage(e, 'It could not be unpinned.')))}
          className="ios-icon-btn size-8 text-[var(--ios-gray)]"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
