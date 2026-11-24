import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { MessageCircle, Paperclip, X } from 'lucide-react'
import { chatApi, type ChatMessage } from '../../api/chat'
import { Avatar } from '../../components/ui/Avatar'
import { useChat } from './ChatProvider'
import { appNotify } from '../room/androidBridge'
import { silenced } from './quiet'
import './chat.css'

type Info = { name: string; group: boolean; muted: boolean; at: number }
type Banner = { key: string; conversationId: string; senderId: string | null; sender: string; group: string | null; text: string; file: boolean; count: number }

/** What the banner says about a message (text, or the file's name). */
function preview(m: ChatMessage) {
  if (m.file) return { text: m.body?.trim() || m.file.name || 'File', file: true }
  return { text: (m.body ?? '').replace(/\s+/g, ' ').trim() || 'New message', file: false }
}

/**
 * Live chat-message popups on every portal page (23 Nov 2026): a banner with the sender, the group and the message, which
 * opens the chat; while the portal is in the background a phone notification (Android app) or a browser notification
 * instead. Nothing is shown for the chat that is open on screen, for muted chats (unless I am mentioned), during Do not
 * disturb (unless mentioned) or during quiet hours (as the person set them). Sound stays with the chat provider.
 */
export default function MessageAlerts() {
  const chat = useChat()
  const navigate = useNavigate()
  const location = useLocation()
  // The chat list is on screen (Chat page, chats section; on phones only while no conversation fills the screen): it already
  // shows the new message, so no banner there (it would cover the header buttons).
  const listShown = useRef(false)
  const q = new URLSearchParams(location.search)
  listShown.current = location.pathname === '/chat' && !q.get('tab') && (window.innerWidth >= 768 || !q.get('c'))
  const [queue, setQueue] = useState<Banner[]>([])
  const cache = useRef(new Map<string, Info>())
  const prefs = useRef(chat.preferences)
  prefs.current = chat.preferences
  const meId = chat.meId

  const info = useCallback(async (id: string): Promise<Info | null> => {
    const hit = cache.current.get(id)
    if (hit && Date.now() - hit.at < 60_000) return hit
    try {
      const r = await chatApi.conversation(id)
      const muted = r.conversation.muted && (!r.conversation.mutedUntilUtc || Date.parse(r.conversation.mutedUntilUtc) > Date.now())
      const v: Info = { name: r.conversation.name, group: r.conversation.type === 'GROUP', muted, at: Date.now() }
      cache.current.set(id, v)
      return v
    } catch {
      return hit ?? null
    }
  }, [])

  useEffect(() => {
    const forget = (c: { id?: string } | null) => c?.id && cache.current.delete(c.id)
    const offs = [
      chat.on<ChatMessage>('message.new', (m) => {
        if (!m.senderId || m.senderId === meId || m.kind === 'SYSTEM' || m.deleted) return
        if (chat.isOnScreen(m.conversationId)) return
        if (listShown.current && document.visibilityState === 'visible') return
        const mentioned = !!m.mentionsMe || !!m.mentionAll || !!m.mentions?.some((x) => x.id === meId)
        const p = prefs.current
        if (silenced(p, mentioned ? 'mention' : 'message')) return
        if (p?.availability === 'DND' && !mentioned) return
        void info(m.conversationId).then((c) => {
          if (c?.muted && !mentioned) return
          // The person may have opened that chat meanwhile.
          if (chat.isOnScreen(m.conversationId)) return
          const sender = m.senderName ?? 'New message'
          const group = c?.group ? c.name : null
          const { text, file } = preview(m)
          const link = `/chat?c=${encodeURIComponent(m.conversationId)}`
          if (document.visibilityState === 'hidden') {
            const title = group ? `${sender} · ${group}` : sender
            const body = (file ? '📎 ' : '') + text
            try {
              if (appNotify(title, body, link, `chat-${m.conversationId}`)) return
              if ('Notification' in window && Notification.permission === 'granted') {
                const n = new Notification(title, { body, tag: `oic-chat-${m.conversationId}` })
                n.onclick = () => {
                  window.focus()
                  navigate(link)
                  n.close()
                }
                return
              }
            } catch {
              /* notifications are optional: fall back to the banner */
            }
          }
          setQueue((q) => {
            // One banner per chat: a newer message replaces the older one and counts it.
            const prev = q.find((b) => b.conversationId === m.conversationId)
            const b: Banner = { key: `${m.conversationId}-${m.id}`, conversationId: m.conversationId, senderId: m.senderId, sender, group, text, file, count: (prev?.count ?? 0) + 1 }
            return [b, ...q.filter((x) => x.conversationId !== m.conversationId)].slice(0, 3)
          })
        })
      }),
      chat.on<{ id?: string }>('conversation.updated', forget),
      chat.on<{ id?: string }>('conversation.changed', forget),
    ]
    return () => offs.forEach((o) => o())
  }, [chat, meId, info, navigate])

  const top = queue[0]
  useEffect(() => {
    if (!top) return
    const h = window.setTimeout(() => setQueue((q) => q.filter((b) => b.key !== top.key)), 7_000)
    return () => window.clearTimeout(h)
  }, [top])

  if (!top) return null
  const open = () => {
    setQueue((q) => q.filter((b) => b.conversationId !== top.conversationId))
    navigate(`/chat?c=${encodeURIComponent(top.conversationId)}`)
  }
  return (
    <div className="flex w-full justify-center sm:justify-end" aria-live="polite">
      <AnimatePresence mode="wait">
        <motion.div
          key={top.key}
          initial={{ opacity: 0, y: -20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16 }}
          className="pointer-events-auto w-full max-w-[400px] rounded-[22px] bg-[rgb(245_245_247/0.94)] shadow-[0_16px_48px_rgb(0_0_0/0.22)] ring-[0.5px] ring-black/10 backdrop-blur-xl sm:w-[380px]"
          role="status"
          data-testid="message-alert"
        >
          <div className="flex items-start gap-3 p-3.5">
            <button type="button" onClick={open} className="flex min-w-0 flex-1 items-start gap-3 text-left" data-testid="message-alert-open" aria-label={`Open chat with ${top.sender}`}>
              <Avatar name={top.sender} userId={top.senderId} size={40} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[12px] font-medium tracking-wide text-[var(--ios-label2)] uppercase">
                  <MessageCircle className="size-3.5 text-[var(--ios-green)]" />
                  <span className="truncate">{top.group ?? 'Message'}</span>
                  <span className="ml-auto shrink-0 normal-case">now{top.count > 1 ? ` · ${top.count} new` : ''}</span>
                </span>
                <span className="mt-0.5 block truncate text-[16px] leading-[21px] font-semibold text-[var(--ios-label)]" data-testid="message-alert-sender">{top.sender}</span>
                <span className="mt-0.5 line-clamp-2 text-[14px] leading-[19px] break-words text-[var(--ios-label2)]" data-testid="message-alert-text">
                  {top.file && <Paperclip className="mr-1 inline size-3.5 align-[-2px]" />}
                  {top.text}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setQueue((q) => q.filter((b) => b.key !== top.key))}
              aria-label="Dismiss"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-black/[0.07] text-[var(--ios-label2)]"
              data-testid="message-alert-dismiss"
            >
              <X className="size-3.5" strokeWidth={2.6} />
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
