import { createPortal } from 'react-dom'
import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, Ban, Bell, BellOff, Check, CheckCheck, Clock, Copy, CornerUpLeft, Download, ExternalLink, File as FileIcon, FileSpreadsheet,
  ChevronLeft, FileText, Forward, Image as ImageIcon, Info, ListTodo, LoaderCircle, MailWarning, MoreHorizontal, Paperclip, Pencil, Phone, Pin, PinOff, Plus, Presentation, RotateCw, Search,
  ShieldAlert, Smile, SmilePlus, Star, StarOff, Trash2, X, CalendarClock, Clock3,
} from 'lucide-react'
import {
  chatApi, fileUrl, newClientId, uploadFile, type ChatMember, type ChatMessage, type ChatStatus, type Conversation, type Presence, type ReplyRef,
} from '../../api/chat'
import { errorMessage } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { parseUtc } from '../../lib/format'
import { useChat } from './ChatProvider'
import { useCalls } from './CallProvider'
import { ConversationAvatar, ForwardDialog, InfoPanel } from './ChatParts'
import { dayKey, dayLabel, fileSize, fullTime, linkify, presenceText, tickFor, timeOf, type Tick } from './chatUtils'
import { EmojiPicker, QUICK_REACTIONS, rememberEmoji } from './EmojiPicker'
import type { FollowUpSource } from './work/FollowUp'
import { advApi, type PinItem } from '../../api/chat'
import { highlightMentions, mentionOptions, mentionQuery, MentionPicker, type MentionOption } from './advanced/Mentions'
import { PinnedBar } from './advanced/PinnedBar'
import { ScheduleSheet, ScheduledListSheet } from './advanced/Scheduled'
import { usePhone } from './usePhone'

const FollowUpSheet = lazy(() => import('./work/FollowUp'))

type ViewMessage = ChatMessage & { local?: 'pending' | 'failed'; localError?: string }
type Upload = { key: string; name: string; progress: number; error?: string }
type Limits = Extract<ChatStatus, { enabled: true }>['limits']

const PAGE = 50
const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches



function sortMessages(list: ViewMessage[]) {
  return [...list].sort((a, b) => (a.local ? 1 : 0) - (b.local ? 1 : 0) || a.seq - b.seq)
}

/** Adds or replaces messages (by id, or by the client id of my own optimistic copy). */
function merge(list: ViewMessage[], incoming: ChatMessage[]) {
  const out = [...list]
  for (const m of incoming) {
    const i = out.findIndex((x) => x.id === m.id || (!!m.clientMessageId && x.clientMessageId === m.clientMessageId))
    if (i >= 0) out[i] = m
    else out.push(m)
  }
  return sortMessages(out)
}

export function ConversationView({
  conversation,
  conversations,
  limits,
  onBack,
  onOpenDirect,
  onRemoved,
  jumpSeq,
  tasksOn = false,
  advancedOn = false,
  isFavourite = false,
  onToggleFavourite,
}: {
  conversation: Conversation
  conversations: Conversation[]
  limits: Limits
  onBack: () => void
  onOpenDirect: (userId: string) => void
  onRemoved: () => void
  jumpSeq: number | null
  tasksOn?: boolean
  advancedOn?: boolean
  isFavourite?: boolean
  onToggleFavourite?: () => void
}) {
  const chat = useChat()
  const calls = useCalls()
  const toast = useToast()
  const meId = chat.meId!
  const id = conversation.id
  const [members, setMembers] = useState<ChatMember[]>([])
  const [messages, setMessages] = useState<ViewMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasOlder, setHasOlder] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({})
  const [replyTo, setReplyTo] = useState<ViewMessage | null>(null)
  const [editing, setEditing] = useState<ViewMessage | null>(null)
  const [text, setText] = useState('')
  const [uploads, setUploads] = useState<Upload[]>([])
  const [showInfo, setShowInfo] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [highlight, setHighlight] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [reactingTo, setReactingTo] = useState<string | null>(null)
  const [composerEmoji, setComposerEmoji] = useState(false)
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null)
  const [deleting, setDeleting] = useState<ChatMessage | null>(null)
  const [lightbox, setLightbox] = useState<ChatMessage | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newBelow, setNewBelow] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [followUp, setFollowUp] = useState<FollowUpSource | null>(null)
  // Phase 5: @mentions being typed, scheduling, scheduled count.
  const [mentionAt, setMentionAt] = useState<{ query: string; start: number } | null>(null)
  const [mentionActive, setMentionActive] = useState(0)
  const mentionPicks = useRef<MentionOption[]>([])
  const [plusMenu, setPlusMenu] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [scheduledList, setScheduledList] = useState(false)
  const [scheduledCount, setScheduledCount] = useState(0)
  const phone = usePhone()
  // Phones and tablets (touch, no hover): message actions open the iOS action sheet.
  const touch = phone || coarse
  const isGroup = conversation.type === 'GROUP'
  const canMentionAll = isGroup && conversation.role === 'ADMIN'
  const mentionOpts = advancedOn && isGroup && mentionAt ? mentionOptions(members, mentionAt.query, canMentionAll) : []
  const refreshScheduled = useCallback(() => {
    if (!advancedOn) return
    advApi.scheduled({ conversationId: conversation.id }).then((r) => setScheduledCount(r.items.length), () => {})
  }, [advancedOn, conversation.id])
  useEffect(() => {
    refreshScheduled()
    if (!advancedOn) return
    return chat.on('scheduled.updated', refreshScheduled)
  }, [refreshScheduled, advancedOn, chat])
  // Messages that arrive after the chat was opened pop in (iOS); the history on screen does not animate.
  const openedAt = useRef(Date.now())
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const keepScroll = useRef<number | null>(null)
  const stickBottom = useRef(true)
  const lastRead = useRef(conversation.readSeq)
  const firstUnread = useRef<number | null>(null)
  const lastTypingSent = useRef(0)
  const membersKey = useRef('')

  const loadDetail = useCallback(() => {
    chatApi.conversation(id).then(
      (d) => {
        setMembers(d.members)
        membersKey.current = `${d.conversation.memberCount}|${d.conversation.role}|${d.conversation.name}|${d.conversation.imageId}`
      },
      (e) => {
        if ((e as { status?: number }).status === 404) onRemoved()
      },
    )
  }, [id, onRemoved])

  // Open: details + the newest page (or the page around a search result).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setMessages([])
    setReplyTo(null)
    setEditing(null)
    setText('')
    setShowSearch(false)
    setShowInfo(false)
    setTyping({})
    setNewBelow(0)
    lastRead.current = conversation.readSeq
    firstUnread.current = null
    stickBottom.current = true
    loadDetail()
    chatApi.messages(id, jumpSeq ? { around: jumpSeq, limit: PAGE } : { limit: PAGE }).then(
      (p) => {
        if (cancelled) return
        firstUnread.current = p.items.find((m) => m.seq > conversation.readSeq && m.senderId !== meId && m.kind !== 'SYSTEM')?.seq ?? null
        setMessages(sortMessages(p.items))
        setHasOlder(p.hasOlder)
        setHasNewer(p.hasNewer)
        setLoading(false)
        if (jumpSeq) {
          stickBottom.current = false
          setHighlight(jumpSeq)
        }
      },
      (e) => {
        if (cancelled) return
        setLoading(false)
        setLoadError(errorMessage(e, 'The conversation could not be loaded.'))
      },
    )
    chat.setActiveConversation(id)
    return () => {
      cancelled = true
      chat.setActiveConversation(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reopen only when the conversation (or the jump target) changes
  }, [id, jumpSeq])

  // Live updates for this conversation.
  useEffect(() => {
    const offs = [
      chat.on<ChatMessage>('message.new', (m) => {
        if (m.conversationId !== id) return
        setTyping((t) => {
          if (!m.senderId || !t[m.senderId]) return t
          const rest = { ...t }
          delete rest[m.senderId]
          return rest
        })
        if (hasNewerRef.current) {
          if (m.senderId !== meId) setNewBelow((n) => n + 1)
          return
        }
        setMessages((list) => merge(list, [m]))
        if (m.senderId !== meId && !stickBottom.current) setNewBelow((n) => n + 1)
        if (m.senderId === meId) stickBottom.current = true
      }),
      chat.on<ChatMessage>('message.updated', (m) => m.conversationId === id && setMessages((list) => (list.some((x) => x.id === m.id) ? merge(list, [m]) : list))),
      chat.on<{ conversationId: string; userId: string; readSeq: number | null; deliveredSeq: number | null }>('receipt', (r) => {
        if (r.conversationId !== id) return
        setMembers((ms) =>
          ms.map((x) =>
            x.id === r.userId
              ? { ...x, readSeq: Math.max(x.readSeq, r.readSeq ?? 0), deliveredSeq: Math.max(x.deliveredSeq, r.deliveredSeq ?? 0, r.readSeq ?? 0) }
              : x,
          ),
        )
      }),
      chat.on<{ conversationId: string; userId: string; name: string }>('typing', (t) => {
        if (t.conversationId !== id || t.userId === meId) return
        setTyping((cur) => ({ ...cur, [t.userId]: { name: t.name, until: Date.now() + 4500 } }))
      }),
      chat.on<{ userId: string; state: Presence['state']; lastSeenUtc: string | null }>('presence', (p) =>
        setMembers((ms) => ms.map((x) => (x.id === p.userId ? { ...x, presence: { state: p.state, lastSeenUtc: chat.preferences?.showLastSeen === false ? null : p.lastSeenUtc } } : x))),
      ),
      chat.on<Conversation>('conversation.updated', (c) => {
        if (c.id !== id) return
        const key = `${c.memberCount}|${c.role}|${c.name}|${c.imageId}`
        if (key !== membersKey.current) loadDetail()
      }),
      chat.on<{ id: string }>('conversation.changed', (c) => c.id === id && loadDetail()),
      chat.on('reconnected', () => {
        loadDetail()
        if (hasNewerRef.current) return
        const last = lastSeqRef.current
        if (last > 0)
          chatApi.messages(id, { after: last, limit: 100 }).then((p) => {
            setMessages((list) => merge(list, p.items))
            if (p.hasNewer) setHasNewer(true)
          }, () => {})
      }),
    ]
    return () => offs.forEach((o) => o())
  }, [chat, id, meId, loadDetail])

  const hasNewerRef = useRef(hasNewer)
  hasNewerRef.current = hasNewer
  const lastSeqRef = useRef(0)
  lastSeqRef.current = messages.filter((m) => !m.local).at(-1)?.seq ?? 0

  // Typing indicators expire.
  useEffect(() => {
    if (Object.keys(typing).length === 0) return
    const t = window.setInterval(() => {
      const now = Date.now()
      setTyping((cur) => {
        const next = Object.fromEntries(Object.entries(cur).filter(([, v]) => v.until > now))
        return Object.keys(next).length === Object.keys(cur).length ? cur : next
      })
    }, 1000)
    return () => window.clearInterval(t)
  }, [typing])

  // Scrolling: keep the position when older messages are added on top; follow new ones while at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (keepScroll.current !== null) {
      el.scrollTop = el.scrollHeight - keepScroll.current
      keepScroll.current = null
      return
    }
    if (highlight !== null) {
      const target = el.querySelector<HTMLElement>(`[data-seq="${highlight}"]`)
      if (target) {
        target.scrollIntoView({ block: 'center' })
        const t = window.setTimeout(() => setHighlight(null), 2200)
        return () => window.clearTimeout(t)
      }
    }
    if (stickBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, uploads.length, highlight, typing])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickBottom.current = bottom && !hasNewer
    setAtBottom(bottom)
    if (bottom) setNewBelow(0)
    if (el.scrollTop < 120 && hasOlder && !loadingOlder) void loadOlder()
  }

  async function loadOlder() {
    const first = messages.find((m) => !m.local)
    if (!first) return
    setLoadingOlder(true)
    try {
      const p = await chatApi.messages(id, { before: first.seq, limit: PAGE })
      keepScroll.current = (scroller.current?.scrollHeight ?? 0) - (scroller.current?.scrollTop ?? 0)
      setMessages((list) => merge(list, p.items))
      setHasOlder(p.hasOlder)
    } catch {
      /* the next scroll tries again */
    } finally {
      setLoadingOlder(false)
    }
  }

  const jumpTo = useCallback(
    async (seq: number) => {
      setShowSearch(false)
      if (messages.some((m) => m.seq === seq)) {
        stickBottom.current = false
        setHighlight(seq)
        return
      }
      try {
        const p = await chatApi.messages(id, { around: seq, limit: PAGE })
        stickBottom.current = false
        setMessages(sortMessages(p.items))
        setHasOlder(p.hasOlder)
        setHasNewer(p.hasNewer)
        setHighlight(seq)
      } catch (e) {
        toast.error(errorMessage(e, 'That message could not be found.'))
      }
    },
    [id, messages, toast],
  )

  async function jumpToLatest() {
    setNewBelow(0)
    if (!hasNewer) {
      stickBottom.current = true
      const el = scroller.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      return
    }
    const p = await chatApi.messages(id, { limit: PAGE })
    stickBottom.current = true
    setMessages(sortMessages(p.items))
    setHasOlder(p.hasOlder)
    setHasNewer(false)
  }

  // Read marks: everything on screen is read while the tab is visible and the newest messages are in view.
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== 'visible' || !atBottom || hasNewer) return
      const latest = [...messages].reverse().find((m) => !m.local)?.seq ?? 0
      if (latest > lastRead.current) {
        lastRead.current = latest
        void chatApi.read(id, latest).catch(() => {})
      }
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [messages, atBottom, hasNewer, id])

  // ---- Sending ---------------------------------------------------------------------------------------------------------

  const canSend = conversation.otherActive
  const sendText = useCallback(
    async (body: string, reply: ViewMessage | null, clientId = newClientId(), mentions?: { ids: string[]; all: boolean; names: { id: string; name: string }[] }) => {
      const optimistic: ViewMessage = {
        id: `local-${clientId}`,
        seq: Number.MAX_SAFE_INTEGER,
        conversationId: id,
        clientMessageId: clientId,
        kind: 'TEXT',
        body,
        createdUtc: new Date().toISOString(),
        editedUtc: null,
        deleted: false,
        forwarded: false,
        senderId: meId,
        senderName: null,
        replyTo: reply ? { id: reply.id, seq: reply.seq, kind: reply.kind, preview: reply.body, deleted: reply.deleted, senderName: reply.senderName, fileName: reply.file?.name ?? null } : null,
        file: null,
        reactions: [],
        mentions: mentions?.names ?? [],
        mentionAll: mentions?.all ?? false,
        local: 'pending',
      }
      stickBottom.current = true
      setMessages((list) => sortMessages([...list.filter((m) => m.clientMessageId !== clientId), optimistic]))
      try {
        const saved = await chatApi.send(id, body, clientId, reply?.id, mentions ? { ids: mentions.ids, all: mentions.all } : undefined)
        setMessages((list) => merge(list, [saved]))
      } catch (e) {
        setMessages((list) => list.map((m) => (m.clientMessageId === clientId ? { ...m, local: 'failed', localError: errorMessage(e, 'Not sent') } : m)))
      }
    },
    [id, meId],
  )

  async function submit() {
    const body = text.trim()
    if (!body) return
    if (body.length > limits.bodyMax) {
      toast.error(`A message can be at most ${limits.bodyMax} characters.`)
      return
    }
    if (editing) {
      const target = editing
      setEditing(null)
      setText('')
      try {
        const saved = await chatApi.edit(target.id, body)
        setMessages((list) => merge(list, [saved]))
      } catch (e) {
        toast.error(errorMessage(e, 'The message could not be edited.'))
      }
      return
    }
    const reply = replyTo
    // Mentions still present in the text (a name the person deleted again is not mentioned).
    const picks = mentionPicks.current.filter((p) => !p.all && body.includes('@' + p.name))
    const all = canMentionAll && /(^|\s)@all\b/i.test(body)
    mentionPicks.current = []
    setMentionAt(null)
    setText('')
    setReplyTo(null)
    void sendText(body, reply, undefined, advancedOn && (picks.length || all) ? { ids: [...new Set(picks.map((p) => p.id))], all, names: picks.map((p) => ({ id: p.id, name: p.name })) } : undefined)
    input.current?.focus()
  }

  function pickMention(o: MentionOption) {
    if (!mentionAt) return
    const el = input.current
    const caret = el?.selectionStart ?? text.length
    const insert = '@' + o.name + ' '
    const next = text.slice(0, mentionAt.start) + insert + text.slice(caret)
    mentionPicks.current = [...mentionPicks.current, o]
    setText(next)
    setMentionAt(null)
    window.setTimeout(() => {
      el?.focus()
      const pos = mentionAt.start + insert.length
      el?.setSelectionRange(pos, pos)
    }, 0)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpts.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setMentionActive((i) => (i + (e.key === 'ArrowDown' ? 1 : mentionOpts.length - 1)) % mentionOpts.length)
      return
    }
    if (mentionOpts.length > 0 && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault()
      pickMention(mentionOpts[Math.min(mentionActive, mentionOpts.length - 1)])
      return
    }
    if (mentionOpts.length > 0 && e.key === 'Escape') {
      setMentionAt(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarse) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      if (editing) {
        setEditing(null)
        setText('')
      } else if (replyTo) setReplyTo(null)
    } else if (e.key === 'ArrowUp' && !text) {
      const mine = [...messages].reverse().find((m) => m.senderId === meId && m.kind === 'TEXT' && !m.deleted && !m.local && canEdit(m))
      if (mine) {
        e.preventDefault()
        startEdit(mine)
      }
    }
  }

  function onType(v: string) {
    setText(v)
    if (advancedOn && isGroup) {
      const caret = input.current?.selectionStart ?? v.length
      setMentionAt(mentionQuery(v, caret))
      setMentionActive(0)
    }
    if (v && Date.now() - lastTypingSent.current > 3000) {
      lastTypingSent.current = Date.now()
      chat.signal('Typing', id)
    }
  }

  const canEdit = (m: ChatMessage) => m.senderId === meId && m.kind === 'TEXT' && !m.deleted && Date.now() - parseUtc(m.createdUtc).getTime() < limits.editMinutes * 60_000
  const canDelete = (m: ChatMessage) => m.senderId === meId && m.kind !== 'SYSTEM' && !m.deleted && Date.now() - parseUtc(m.createdUtc).getTime() < limits.deleteMinutes * 60_000

  function startEdit(m: ViewMessage) {
    setReplyTo(null)
    setEditing(m)
    setText(m.body ?? '')
    window.setTimeout(() => input.current?.focus(), 0)
  }

  function sendFiles(files: FileList | File[]) {
    for (const f of Array.from(files).slice(0, 10)) {
      const key = newClientId()
      if (f.size > limits.maxUploadMb * 1024 * 1024) {
        setUploads((u) => [...u, { key, name: f.name, progress: 0, error: `Larger than ${limits.maxUploadMb} MB` }])
        continue
      }
      const reply = replyTo
      setReplyTo(null)
      setUploads((u) => [...u, { key, name: f.name, progress: 0 }])
      stickBottom.current = true
      uploadFile(`/chat/conversations/${id}/files`, f, { clientMessageId: key, ...(reply ? { replyToId: reply.id } : {}) }, (p) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
      ).then(
        (m) => {
          setUploads((u) => u.filter((x) => x.key !== key))
          if (m) setMessages((list) => merge(list, [m]))
        },
        (e) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: errorMessage(e, 'Not sent') } : x))),
      )
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files)
    if (files.length) {
      e.preventDefault()
      sendFiles(files)
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (canSend && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files)
  }

  async function react(m: ChatMessage, emoji: string) {
    setReactingTo(null)
    setSelected(null)
    rememberEmoji(emoji)
    try {
      const saved = await chatApi.react(m.id, emoji)
      setMessages((list) => merge(list, [saved]))
    } catch (e) {
      toast.error(errorMessage(e, 'The reaction could not be saved.'))
    }
  }

  function insertEmoji(e: string) {
    const el = input.current
    if (!el) return setText((t) => t + e)
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    const next = text.slice(0, start) + e + text.slice(end)
    setText(next)
    window.setTimeout(() => {
      el.focus()
      el.setSelectionRange(start + e.length, start + e.length)
    }, 0)
  }

  // ---- Header data -----------------------------------------------------------------------------------------------------

  const typingNames = Object.values(typing).map((t) => t.name.split(' ')[0])
  const typingText = typingNames.length === 0 ? null : typingNames.length === 1 ? `${typingNames[0]} is typing…` : `${typingNames.slice(0, 2).join(' and ')} are typing…`
  const otherMember = members.find((m) => !m.me)
  const subtitle =
    typingText ??
    (conversation.type === 'DIRECT'
      ? conversation.otherActive
        ? presenceText(otherMember?.presence ?? conversation.other?.presence)
        : 'No longer active'
      : members.length
        ? members.map((m) => (m.me ? 'You' : m.name.split(' ')[0])).join(', ')
        : `${conversation.memberCount} members`)

  // Read receipt under my newest message.
  const receipt = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.senderId === meId && !m.local && m.kind !== 'SYSTEM' && !m.deleted)
    if (!last) return null
    const others = members.filter((x) => !x.me && x.visibleFromSeq < last.seq)
    if (others.length === 0) return null
    const readers = others.filter((x) => x.readSeq >= last.seq).length
    const delivered = others.filter((x) => x.deliveredSeq >= last.seq || x.readSeq >= last.seq).length
    const group = conversation.type === 'GROUP'
    if (readers === others.length) return { id: last.id, tone: 'read' as const, text: group ? 'Read by everyone' : 'Read' }
    if (group && readers > 0) return { id: last.id, tone: 'read' as const, text: `Read by ${readers} of ${others.length}` }
    if (delivered === others.length) return { id: last.id, tone: 'delivered' as const, text: 'Delivered' }
    return { id: last.id, tone: 'sent' as const, text: 'Sent' }
  }, [messages, members, meId, conversation.type])

  const grouped = useMemo(() => {
    const out: { day: string; label: string; items: ViewMessage[] }[] = []
    for (const m of messages) {
      const k = dayKey(m.createdUtc)
      if (out.at(-1)?.day !== k) out.push({ day: k, label: dayLabel(m.createdUtc), items: [] })
      out.at(-1)!.items.push(m)
    }
    return out
  }, [messages])

  return (
    <div className="flex h-full min-w-0">
      <section
        className="relative flex h-full min-w-0 flex-1 flex-col bg-white"
        onDragOver={(e) => {
          if (!canSend || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={onDrop}
        aria-label={`Conversation with ${conversation.name}`}
        data-testid="chat-view"
      >
        {/* Header */}
        <header className="ios-bar ios-hairline-b relative z-10 flex h-[60px] shrink-0 items-center gap-1 px-1.5 max-md:h-[74px] sm:px-3">
          <button type="button" onClick={onBack} aria-label="Back to chats" className="flex h-11 shrink-0 items-center pr-1 text-[17px] text-[var(--ios-blue)] active:opacity-50 md:hidden" data-testid="chat-back">
            <ChevronLeft className="size-[30px]" strokeWidth={2.2} /> <span className="-ml-1 max-[380px]:hidden">Chats</span>
          </button>
          <button type="button" onClick={() => setShowInfo((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 text-left active:opacity-60 max-md:flex-col max-md:gap-0.5 max-md:text-center">
            <ConversationAvatar c={{ ...conversation, other: conversation.other ? { ...conversation.other, presence: otherMember?.presence ?? conversation.other.presence } : null }} size={phone ? 30 : 40} />
            <span className="min-w-0 max-md:w-full">
              <span className="block truncate text-[16px] font-semibold max-md:text-[13px] max-md:font-medium" data-testid="chat-title">{conversation.name}</span>
              <span className={cn('block truncate text-[13px] max-md:text-[11px]', typingText ? 'text-[var(--ios-blue)]' : 'text-[var(--ios-gray)]')} data-testid="chat-subtitle">{subtitle}</span>
            </span>
          </button>
          {calls.enabled && canSend && (
            <HeaderButton label={conversation.type === 'GROUP' ? 'Start a group audio call' : 'Audio call'} onClick={() => calls.start(id)} disabled={!!calls.active}>
              <Phone className="size-[21px]" strokeWidth={1.9} />
            </HeaderButton>
          )}
          {!phone && <HeaderButton label="Search in this chat" onClick={() => setShowSearch((v) => !v)} active={showSearch}><Search className="size-[21px]" strokeWidth={1.9} /></HeaderButton>}
          <HeaderButton label={showInfo ? 'Hide info' : conversation.type === 'GROUP' ? 'Group info' : 'Contact info'} onClick={() => setShowInfo((v) => !v)} active={showInfo}><Info className="size-[21px]" strokeWidth={1.9} /></HeaderButton>
          <div className="relative">
            <HeaderButton label="More options" onClick={() => setMenuOpen((v) => !v)} active={menuOpen}><MoreHorizontal className="size-[22px]" strokeWidth={1.9} /></HeaderButton>
            {menuOpen && (
              <ConversationMenu
                c={conversation}
                onClose={() => setMenuOpen(false)}
                onLeaveView={onBack}
                onSearch={phone ? () => setShowSearch(true) : undefined}
                onFollowUp={tasksOn ? () => setFollowUp({ kind: 'conversation', conversationId: id, title: conversation.name }) : undefined}
                favourite={advancedOn && conversation.type === 'DIRECT' && onToggleFavourite ? { on: isFavourite, toggle: onToggleFavourite } : undefined}
                onScheduled={advancedOn ? () => setScheduledList(true) : undefined}
              />
            )}
          </div>
        </header>

        {chat.connection !== 'online' && chat.connection !== 'off' && (
          <div role="status" className="flex items-center justify-center gap-2 bg-warning-soft px-3 py-1 text-[12px] font-medium text-warning-ink">
            <LoaderCircle className="size-3.5 animate-spin" /> {chat.connection === 'offline' ? 'Offline. Messages will send when the connection is back.' : 'Reconnecting…'}
          </div>
        )}

        {showSearch && <InChatSearch conversationId={id} onPick={(seq) => void jumpTo(seq)} onClose={() => setShowSearch(false)} />}
        {advancedOn && <PinnedBar conversationId={id} onJump={(seq) => void jumpTo(seq)} canUnpin={(p: PinItem) => p.pinnedBy.id === meId || conversation.type === 'DIRECT' || conversation.role === 'ADMIN'} />}

        {/* Messages */}
        <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 scrollbar-thin sm:px-6" data-testid="chat-messages" role="log" aria-live="polite" aria-relevant="additions">
          {loading && (
            <div className="flex h-full items-center justify-center text-ink-muted">
              <LoaderCircle className="size-6 animate-spin" aria-label="Loading messages" />
            </div>
          )}
          {loadError && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-[13.5px] text-ink-secondary">{loadError}</p>
              <button type="button" onClick={() => window.location.reload()} className="text-[13px] font-semibold text-brand-600 hover:underline">Try again</button>
            </div>
          )}
          {!loading && !loadError && hasOlder && (
            <div className="flex justify-center py-2">
              <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="rounded-full bg-surface px-3 py-1 text-[12px] font-medium text-ink-secondary shadow-xs hover:text-ink">
                {loadingOlder ? 'Loading…' : 'Load earlier messages'}
              </button>
            </div>
          )}
          {!loading && !loadError && messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <ConversationAvatar c={conversation} size={64} />
              <p className="mt-2 text-[15px] font-semibold text-ink">{conversation.name}</p>
              <p className="max-w-[320px] text-[13px] text-ink-muted">No messages yet. Say hello 👋</p>
            </div>
          )}
          {grouped.map((g) => (
            <Fragment key={g.day}>
              <div className="sticky top-0 z-[2] my-2 flex justify-center">
                <span className="rounded-full bg-white/85 px-2.5 py-0.5 text-[12px] font-medium text-[var(--ios-gray)] backdrop-blur">{g.label}</span>
              </div>
              {g.items.map((m, i) => {
                const prev = g.items[i - 1]
                const next = g.items[i + 1]
                const grouped = !!prev && prev.kind !== 'SYSTEM' && m.kind !== 'SYSTEM' && prev.senderId === m.senderId && parseUtc(m.createdUtc).getTime() - parseUtc(prev.createdUtc).getTime() < 5 * 60_000
                const groupedNext = !!next && next.kind !== 'SYSTEM' && m.kind !== 'SYSTEM' && next.senderId === m.senderId && parseUtc(next.createdUtc).getTime() - parseUtc(m.createdUtc).getTime() < 5 * 60_000
                return (
                  <Fragment key={m.clientMessageId ?? m.id}>
                    {firstUnread.current === m.seq && (
                      <div className="my-3 flex items-center gap-3" data-testid="chat-new-divider">
                        <span className="h-px flex-1 bg-[var(--ios-blue)]/25" />
                        <span className="text-[12px] font-semibold text-[var(--ios-blue)]">New Messages</span>
                        <span className="h-px flex-1 bg-[var(--ios-blue)]/25" />
                      </div>
                    )}
                    <MessageRow
                      m={m}
                      mine={m.senderId === meId}
                      isGroup={conversation.type === 'GROUP'}
                      groupedWithPrev={grouped}
                      groupedWithNext={groupedNext}
                      receipt={receipt?.id === m.id ? receipt : null}
                      fresh={parseUtc(m.createdUtc).getTime() > openedAt.current}
                      phone={touch}
                      tick={m.local === 'pending' ? 'pending' : m.local === 'failed' ? 'failed' : m.senderId === meId ? tickFor(m, members) : null}
                      highlighted={highlight === m.seq}
                      selected={selected === m.id}
                      reacting={reactingTo === m.id}
                      meId={meId}
                      onSelect={() => setSelected((s) => (s === m.id ? null : m.id))}
                      onReact={(e) => void react(m, e)}
                      onOpenReactions={() => setReactingTo((r) => (r === m.id ? null : m.id))}
                      onCloseReactions={() => setReactingTo(null)}
                      onReply={() => {
                        setEditing(null)
                        setReplyTo(m)
                        setSelected(null)
                        input.current?.focus()
                      }}
                      onCopy={() => {
                        void navigator.clipboard?.writeText(m.body ?? '').then(() => toast.success('Copied'), () => toast.error('Copy is not available here'))
                        setSelected(null)
                      }}
                      onForward={() => (setForwarding(m), setSelected(null))}
                      onEdit={canEdit(m) && !m.local ? () => (startEdit(m), setSelected(null)) : undefined}
                      onDelete={canDelete(m) && !m.local ? () => (setDeleting(m), setSelected(null)) : undefined}
                      onRetry={m.local === 'failed' ? () => void sendText(m.body ?? '', null, m.clientMessageId ?? undefined) : undefined}
                      onDiscard={m.local === 'failed' ? () => setMessages((list) => list.filter((x) => x.id !== m.id)) : undefined}
                      onJumpToReply={(r) => void jumpTo(r.seq)}
                      onOpenImage={() => setLightbox(m)}
                      meName={chat.status?.enabled ? chat.status.me.name : null}
                      onSave={advancedOn && !m.local && !m.deleted && m.kind !== 'SYSTEM' ? () => (setSelected(null), void advApi.save(m.id, !m.saved).then((x) => setMessages((list) => merge(list, [{ ...x, saved: !m.saved }])), (e) => toast.error(errorMessage(e, 'That did not work.')))) : undefined}
                      onPin={advancedOn && !m.local && !m.deleted && m.kind !== 'SYSTEM' ? () => (setSelected(null), void advApi.pinMessage(m.id, !m.pinned).then((x) => setMessages((list) => merge(list, [{ ...x, pinned: !m.pinned, saved: m.saved }])), (e) => toast.error(errorMessage(e, 'That did not work.')))) : undefined}
                      onFollowUp={tasksOn && !m.local && !m.deleted ? () => (setSelected(null), setFollowUp({ kind: 'message', messageId: m.id, conversationId: id, title: m.body ?? m.file?.name ?? 'Message', senderName: m.senderId === meId ? 'You' : m.senderName })) : undefined}
                    />
                  </Fragment>
                )
              })}
            </Fragment>
          ))}
          {uploads.map((u) => (
            <div key={u.key} className="my-1 flex justify-end">
              <div className="w-[260px] max-w-[85%] rounded-[18px] bg-[var(--ios-blue)]/10 px-3 py-2 text-[13px]" data-testid="chat-upload">
                <div className="flex items-center gap-2">
                  <FileIcon className="size-4 shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{u.name}</span>
                  {u.error && (
                    <button type="button" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label="Dismiss" className="text-ink-muted hover:text-ink">
                      <X className="size-4" />
                    </button>
                  )}
                </div>
                {u.error ? (
                  <p className="mt-1 text-danger" role="alert">{u.error}</p>
                ) : (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-brand-500/15" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${u.name}`}>
                    <div className="h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${Math.max(4, u.progress * 100)}%` }} />
                  </div>
                )}
              </div>
            </div>
          ))}
          {typingText && conversation.type === 'GROUP' && (
            <p className="mt-1.5 flex items-center gap-2 px-1 text-[13px] text-[var(--ios-gray)]" data-testid="chat-typing">
              <span className="inline-flex h-[30px] items-center gap-1 rounded-[18px] bg-[var(--ios-bubble-in)] px-3" aria-hidden>
                {[0, 1, 2].map((d) => <span key={d} className="size-2 animate-bounce rounded-full bg-[var(--ios-gray)]" style={{ animationDelay: `${d * 0.15}s` }} />)}
              </span>
              {typingText}
            </p>
          )}
        </div>

        {(newBelow > 0 || !atBottom || hasNewer) && !loading && (
          <button
            type="button"
            onClick={() => void jumpToLatest()}
            className="absolute right-4 bottom-24 z-10 flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full bg-white/95 px-2.5 text-[13px] font-semibold text-[var(--ios-blue)] shadow-[0_4px_16px_rgb(0_0_0/0.15)] backdrop-blur"
            aria-label="Jump to latest messages"
            data-testid="chat-jump-latest"
          >
            <ArrowDown className="size-4" />
            {newBelow > 0 && <span className="rounded-full bg-[var(--ios-blue)] px-1.5 text-[11px] text-white">{newBelow}</span>}
          </button>
        )}

        {/* Composer */}
        {canSend ? (
          <div className="ios-bar ios-hairline-t relative shrink-0 px-2 pt-2 pb-[max(0.5rem,var(--sab))] sm:px-4">
            {/* Touch screens: the emoji picker spans the message bar so it never runs off a small phone. */}
            {composerEmoji && touch && <EmojiPicker className="absolute inset-x-2 bottom-full mb-2 !w-auto !max-w-none" onPick={insertEmoji} onClose={() => setComposerEmoji(false)} />}
            {mentionOpts.length > 0 && <MentionPicker options={mentionOpts} active={Math.min(mentionActive, mentionOpts.length - 1)} onPick={pickMention} />}
            {advancedOn && scheduledCount > 0 && !editing && (
              <button type="button" onClick={() => setScheduledList(true)} className="mb-2 flex w-full items-center gap-2 rounded-xl bg-[var(--ios-blue)]/10 px-3 py-1.5 text-left text-[14px] font-medium text-[var(--ios-blue)]" data-testid="scheduled-banner">
                <Clock3 className="size-4" /> {scheduledCount} scheduled {scheduledCount === 1 ? 'message' : 'messages'}
              </button>
            )}
            {(replyTo || editing) && (
              <div className="mb-2 flex items-start gap-2 rounded-xl bg-[var(--ios-fill)] px-3 py-2" data-testid={editing ? 'chat-editing' : 'chat-replying'}>
                <span className="w-[3px] self-stretch rounded-full bg-[var(--ios-blue)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-[var(--ios-blue)]">{editing ? 'Editing message' : `Replying to ${replyTo!.senderId === meId ? 'yourself' : replyTo!.senderName}`}</p>
                  <p className="truncate text-[14px] text-[var(--ios-label2)]">{(editing ?? replyTo)!.body ?? (editing ?? replyTo)!.file?.name}</p>
                </div>
                <button type="button" onClick={() => (editing ? (setEditing(null), setText('')) : setReplyTo(null))} aria-label="Cancel" className="flex size-[22px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white">
                  <X className="size-3.5" strokeWidth={3} />
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              {!editing && !advancedOn && (
                <ComposerButton label="Attach files" onClick={() => fileInput.current?.click()}><Plus className="size-[22px]" strokeWidth={2.2} /></ComposerButton>
              )}
              {!editing && advancedOn && (
                <span className="relative">
                  <ComposerButton label="More: attach or schedule" onClick={() => setPlusMenu((v) => !v)} active={plusMenu}><Plus className={cn('size-[22px] transition-transform', plusMenu && 'rotate-45')} strokeWidth={2.2} /></ComposerButton>
                  {plusMenu && (
                    <>
                      <span className="fixed inset-0 z-20" onClick={() => setPlusMenu(false)} />
                      <span className="ios-menu ios-pop ios-pop-left absolute bottom-12 left-0 z-30 w-60" role="menu" data-testid="composer-menu">
                        <button type="button" role="menuitem" className="ios-menu-item" onClick={() => (setPlusMenu(false), fileInput.current?.click())}>Photo or file <Paperclip className="size-[18px]" /></button>
                        <button type="button" role="menuitem" className="ios-menu-item" onClick={() => (setPlusMenu(false), setScheduling(true))} data-testid="composer-schedule">Schedule message <CalendarClock className="size-[18px]" /></button>
                      </span>
                    </>
                  )}
                </span>
              )}
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                onChange={(e) => {
                  if (e.target.files) sendFiles(e.target.files)
                  e.target.value = ''
                }}
                data-testid="chat-file-input"
              />
              <div className="relative flex min-w-0 flex-1 items-end rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--ios-gray4)]">
                <AutoTextarea
                  ref={input}
                  value={text}
                  onChange={onType}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                  maxLength={limits.bodyMax}
                  placeholder={editing ? 'Edit message' : 'Message'}
                />
                <span className="relative">
                  <button type="button" onClick={() => setComposerEmoji((v) => !v)} aria-label="Emoji" title="Emoji" className={cn('mb-[3px] flex size-[32px] items-center justify-center rounded-full text-[var(--ios-gray)] active:opacity-50', composerEmoji && 'text-[var(--ios-blue)]')}>
                    <Smile className="size-[21px]" />
                  </button>
                  {composerEmoji && !touch && <EmojiPicker className="absolute right-0 bottom-11" onPick={insertEmoji} onClose={() => setComposerEmoji(false)} />}
                </span>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!text.trim()}
                  aria-label={editing ? 'Save edit' : 'Send'}
                  className="m-[3px] flex size-[30px] shrink-0 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white transition-[opacity,transform] active:scale-90 disabled:bg-[var(--ios-gray4)]"
                  data-testid="chat-send"
                >
                  {editing ? <Check className="size-[18px]" strokeWidth={3} /> : <ArrowUp className="size-[19px]" strokeWidth={2.8} />}
                </button>
              </div>
            </div>
            {text.length > limits.bodyMax - 200 && <p className="mt-1 text-right text-[11px] text-[var(--ios-gray)]">{text.length}/{limits.bodyMax}</p>}
          </div>
        ) : (
          <div className="ios-bar ios-hairline-t shrink-0 px-4 py-3 text-center text-[14px] text-[var(--ios-gray)]">
            This colleague is no longer active. You can read the conversation but not send messages.
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-brand-500/10 backdrop-blur-[1px]">
            <div className="rounded-xl border-2 border-dashed border-brand-500 bg-surface px-8 py-6 text-center shadow-overlay">
              <Paperclip className="mx-auto size-7 text-brand-600" />
              <p className="mt-2 text-[14px] font-semibold text-ink">Drop files to send</p>
              <p className="text-[12px] text-ink-muted">Up to {limits.maxUploadMb} MB each</p>
            </div>
          </div>
        )}
      </section>

      {showInfo && (
        <div className="fixed inset-0 z-40 bg-surface lg:static lg:z-auto lg:w-[340px] lg:shrink-0 lg:border-l lg:border-line">
          <InfoPanel
            conversation={conversation}
            members={members}
            onClose={() => setShowInfo(false)}
            onChanged={loadDetail}
            onOpenDirect={onOpenDirect}
            onJump={(seq) => {
              if (window.innerWidth < 1024) setShowInfo(false)
              void jumpTo(seq)
            }}
            maxMembers={limits.maxGroupMembers}
          />
        </div>
      )}

      <ForwardDialog message={forwarding} conversations={conversations} onClose={() => setForwarding(null)} />
      {scheduling && (
        <ScheduleSheet
          conversationId={id}
          initialText={text}
          replyToId={replyTo?.id ?? null}
          onClose={() => setScheduling(false)}
          onSaved={() => {
            setText('')
            setReplyTo(null)
            mentionPicks.current = []
            refreshScheduled()
          }}
        />
      )}
      {scheduledList && <ScheduledListSheet conversationId={id} onClose={() => setScheduledList(false)} onChanged={refreshScheduled} />}
      {followUp && (
        <Suspense fallback={null}>
          <FollowUpSheet source={followUp} onClose={() => setFollowUp(null)} />
        </Suspense>
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete for everyone?"
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting) await chatApi.remove(deleting.id)
        }}
      >
        <p className="text-[13.5px] text-ink-secondary">The message{deleting?.file ? ' and its file are' : ' is'} removed for everyone in this chat. This cannot be undone.</p>
      </ConfirmDialog>
      <Dialog open={!!lightbox} onClose={() => setLightbox(null)} title={lightbox?.file?.name ?? 'Image'} size="xl">
        {lightbox?.file && (
          <div className="flex flex-col items-center gap-3">
            <img src={fileUrl(lightbox.file.id, true)} alt={lightbox.file.name} className="max-h-[70vh] max-w-full rounded-md object-contain" />
            <a href={fileUrl(lightbox.file.id)} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-600 hover:underline">
              <Download className="size-4" /> Download ({fileSize(lightbox.file.size)})
            </a>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function HeaderButton({ label, onClick, active, disabled, children }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={active} className="ios-icon-btn size-10 shrink-0" data-testid={label === 'Audio call' || label.startsWith('Start a group') ? 'chat-call' : undefined}>
      {children}
    </button>
  )
}

function ComposerButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={active} className="mb-[3px] flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[var(--ios-fill)] text-[var(--ios-gray)] active:opacity-50">
      {children}
    </button>
  )
}

const AutoTextarea = ({
  ref,
  value,
  onChange,
  onKeyDown,
  onPaste,
  maxLength,
  placeholder,
}: {
  ref: Ref<HTMLTextAreaElement>
  value: string
  onChange: (v: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  maxLength: number
  placeholder: string
}) => {
  const local = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = local.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`
  }, [value])
  return (
    <textarea
      ref={(el) => {
        local.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) (ref as RefObject<HTMLTextAreaElement | null>).current = el
      }}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label="Message"
      className="ios-noring max-h-36 min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-[7px] pr-1 pl-3.5 text-[16px] leading-[22px] text-[var(--ios-label)] outline-none placeholder:text-[var(--ios-gray2)] md:text-[15px]"
      data-testid="chat-input"
    />
  )
}

function TickIcon({ tick }: { tick: Tick }) {
  switch (tick) {
    case 'pending':
      return <Clock className="size-3.5" aria-label="Sending" />
    case 'failed':
      return <MailWarning className="size-3.5 text-[#ffd0cc]" aria-label="Not sent" />
    case 'sent':
      return <Check className="size-3.5 opacity-80" aria-label="Sent" />
    case 'delivered':
      return <CheckCheck className="size-3.5 opacity-80" aria-label="Delivered" />
    case 'read':
      return <CheckCheck className="size-[15px] text-[#86f7b5] drop-shadow-[0_0_1px_rgb(0_60_30/0.5)]" strokeWidth={2.8} aria-label="Read" />
  }
}

function fileIcon(category: string) {
  switch (category) {
    case 'IMAGE':
      return <ImageIcon className="size-5" />
    case 'EXCEL':
    case 'CSV':
      return <FileSpreadsheet className="size-5" />
    case 'POWERPOINT':
      return <Presentation className="size-5" />
    case 'PDF':
    case 'WORD':
    case 'TEXT':
      return <FileText className="size-5" />
    default:
      return <FileIcon className="size-5" />
  }
}

function MessageRow({
  m, mine, isGroup, groupedWithPrev, groupedWithNext, phone, fresh, tick, highlighted, selected, reacting, meId,
  onSelect, onReact, onOpenReactions, onCloseReactions, onReply, onCopy, onForward, onEdit, onDelete, onRetry, onDiscard, onJumpToReply, onOpenImage, onFollowUp, onSave, onPin, meName, receipt,
}: {
  m: ViewMessage
  mine: boolean
  isGroup: boolean
  groupedWithPrev: boolean
  groupedWithNext: boolean
  phone: boolean
  fresh?: boolean
  tick: Tick | null
  highlighted: boolean
  selected: boolean
  reacting: boolean
  meId: string
  onSelect: () => void
  onReact: (emoji: string) => void
  onOpenReactions: () => void
  onCloseReactions: () => void
  onReply: () => void
  onCopy: () => void
  onForward: () => void
  onEdit?: () => void
  onDelete?: () => void
  onRetry?: () => void
  onDiscard?: () => void
  onJumpToReply: (r: ReplyRef) => void
  onOpenImage: () => void
  onFollowUp?: () => void
  onSave?: () => void
  onPin?: () => void
  meName?: string | null
  receipt?: { tone: 'read' | 'delivered' | 'sent'; text: string } | null
}) {
  const [morePicker, setMorePicker] = useState(false)
  if (m.kind === 'SYSTEM')
    return (
      <div className="my-2.5 flex justify-center" data-seq={m.seq}>
        <span className="max-w-[85%] text-center text-[12.5px] font-medium text-[var(--ios-gray)]" data-testid="chat-system">{m.body}</span>
      </div>
    )
  const f = m.file
  const showActions = !m.deleted && !m.local
  const imageOnly = !!f && f.category === 'IMAGE' && f.status === 'CLEAN' && !m.body && !m.replyTo && !m.forwarded && !m.deleted
  const tail = !groupedWithNext && !imageOnly
  const hasReactions = m.reactions.length > 0
  return (
    <div
      className={cn('group/msg relative flex', mine ? 'justify-end' : 'justify-start', groupedWithPrev ? 'mt-[3px]' : 'mt-2.5', hasReactions && 'mt-5', mine ? 'pr-1.5' : 'pl-1.5')}
      data-seq={m.seq}
      data-testid="chat-message"
      data-mine={mine || undefined}
    >
      {!mine && isGroup && (
        <span className="mr-2 w-7 shrink-0 self-end">{!groupedWithNext && <Avatar name={m.senderName ?? '?'} size={28} />}</span>
      )}
      <div className={cn('relative flex max-w-[min(76%,560px)] flex-col', mine ? 'items-end' : 'items-start')}>
        {!mine && isGroup && !groupedWithPrev && <p className="mb-0.5 ml-3 text-[12px] text-[var(--ios-gray)]">{m.senderName}</p>}
        <div
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a,button')) return
            onSelect()
          }}
          className={cn(
            'ios-bubble transition-[box-shadow,transform] duration-200',
            fresh && (mine ? 'ios-pop ios-pop-right' : 'ios-pop ios-pop-left'),
            mine ? 'ios-bubble-out' : 'ios-bubble-in',
            tail && 'ios-tail',
            imageOnly && 'overflow-hidden !bg-transparent !p-0',
            highlighted && 'ring-4 ring-cyan-400/60',
            selected && (phone ? 'scale-[1.02]' : 'ring-2 ring-[var(--ios-blue)]/35'),
            m.local === 'failed' && 'opacity-80',
          )}
        >
          {m.forwarded && !m.deleted && (
            <p className={cn('mb-0.5 flex items-center gap-1 text-[12px] italic', mine ? 'text-white/75' : 'text-[var(--ios-gray)]')}>
              <Forward className="size-3" /> Forwarded
            </p>
          )}
          {m.replyTo && !m.deleted && (
            <button
              type="button"
              onClick={() => onJumpToReply(m.replyTo!)}
              className={cn('-mx-1 mt-0.5 mb-1 flex w-[calc(100%+0.5rem)] gap-2 rounded-xl px-2 py-1.5 text-left text-[13.5px] leading-[18px]', mine ? 'bg-white/20 text-white/90' : 'bg-black/[0.06] text-[var(--ios-label2)]')}
            >
              <span className={cn('w-[3px] shrink-0 rounded-full', mine ? 'bg-white/80' : 'bg-[var(--ios-blue)]')} />
              <span className="min-w-0">
                <span className={cn('block font-semibold', mine ? 'text-white' : 'text-[var(--ios-blue)]')}>{m.replyTo.senderName}</span>
                <span className="line-clamp-2">{m.replyTo.deleted ? 'Message deleted' : m.replyTo.preview ?? (m.replyTo.fileName ? `📎 ${m.replyTo.fileName}` : '')}</span>
              </span>
            </button>
          )}
          {m.deleted ? (
            <p className={cn('flex items-center gap-1.5 italic', mine ? 'text-white/80' : 'text-[var(--ios-gray)]')}>
              <Ban className="size-3.5" /> {mine ? 'You deleted this message' : 'This message was deleted'}
            </p>
          ) : (
            <>
              {f && <FileBlock f={f} mine={mine} onOpenImage={onOpenImage} imageOnly={imageOnly} />}
              {m.body && (
                <p className="break-words whitespace-pre-wrap" data-testid="chat-body">
                  {linkify(m.body).map((p, i) =>
                    p.href ? (
                      <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className={cn('underline underline-offset-2', mine ? 'text-white' : 'text-[var(--ios-blue)]')}>
                        {p.text}
                      </a>
                    ) : (
                      <Fragment key={i}>{(m.mentions?.length || m.mentionAll) ? highlightMentions(p.text, (m.mentions ?? []).map((x) => x.name), !!m.mentionAll, mine, meName ?? null) : p.text}</Fragment>
                    ),
                  )}
                </p>
              )}
            </>
          )}
          <span
            className={cn('-mb-0.5 flex items-center justify-end gap-1 text-[11px] leading-4 select-none', imageOnly ? 'absolute right-2 bottom-2 rounded-full bg-black/45 px-1.5 text-white' : mine ? 'text-white/70' : 'text-[var(--ios-gray)]')}
            title={fullTime(m.createdUtc)}
          >
            {m.pinned && <Pin className="size-3" aria-label="Pinned" />}
            {m.saved && <Star className="size-3 fill-current" aria-label="Saved" />}
            {m.editedUtc && !m.deleted && <span>Edited</span>}
            {timeOf(m.createdUtc)}
            {tick && <TickIcon tick={tick} />}
          </span>
        </div>

        {hasReactions && (
          <div className={cn('absolute -top-4 z-[3] flex gap-0.5', mine ? '-left-3' : '-right-3')}>
            {m.reactions.map((r) => {
              const minePicked = r.userIds.includes(meId)
              return (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => onReact(r.emoji)}
                  title={r.names.join(', ')}
                  aria-label={`${r.emoji} ${r.userIds.length}: ${r.names.join(', ')}${minePicked ? ' (remove yours)' : ''}`}
                  className={cn('ios-pop inline-flex h-[26px] items-center gap-0.5 rounded-full px-1.5 text-[14px] shadow-[0_1px_3px_rgb(0_0_0/0.18)] ring-2 ring-white', minePicked ? 'bg-[var(--ios-blue)] text-white' : 'bg-[var(--ios-bubble-in)]')}
                  data-testid="chat-reaction"
                >
                  <span>{r.emoji}</span>
                  {r.userIds.length > 1 && <span className={cn('text-[11px] font-semibold', minePicked ? 'text-white' : 'text-[var(--ios-label2)]')}>{r.userIds.length}</span>}
                </button>
              )
            })}
          </div>
        )}

        {receipt && mine && (
          <p className={cn('ios-fade mt-0.5 mr-1 flex items-center justify-end gap-1 text-[11.5px] font-medium', receipt.tone === 'read' ? 'text-[var(--ios-blue)]' : 'text-[var(--ios-gray)]')} data-testid="chat-receipt" aria-live="polite">
            {receipt.tone === 'read' ? <CheckCheck className="size-3.5" strokeWidth={2.6} aria-hidden /> : receipt.tone === 'delivered' ? <CheckCheck className="size-3.5" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
            {receipt.text}
          </p>
        )}
        {m.local === 'failed' && (
          <p className="mt-0.5 flex items-center justify-end gap-2 text-[12px] text-[var(--ios-red)]" role="alert">
            {m.localError ?? 'Not Delivered'}
            <button type="button" onClick={onRetry} className="inline-flex items-center gap-0.5 font-semibold"><RotateCw className="size-3" /> Retry</button>
            <button type="button" onClick={onDiscard} className="font-semibold">Discard</button>
          </p>
        )}

        {/* Actions: hover toolbar on computers; an iOS action sheet on phones. */}
        {showActions && !phone && (
          <div
            className={cn(
              'ios-menu absolute top-0 z-10 flex items-center gap-0.5 !rounded-full p-0.5 transition-opacity',
              mine ? 'right-full mr-2' : 'left-full ml-2',
              selected || reacting ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
            )}
          >
            <ActionButton label="React" onClick={onOpenReactions}><SmilePlus className="size-4" /></ActionButton>
            <ActionButton label="Reply" onClick={onReply}><CornerUpLeft className="size-4" /></ActionButton>
            {m.body && <ActionButton label="Copy" onClick={onCopy}><Copy className="size-4" /></ActionButton>}
            <ActionButton label="Forward" onClick={onForward}><Forward className="size-4" /></ActionButton>
            {onSave && <ActionButton label={m.saved ? 'Unsave' : 'Save'} onClick={onSave}>{m.saved ? <StarOff className="size-4" /> : <Star className="size-4" />}</ActionButton>}
            {onPin && <ActionButton label={m.pinned ? 'Unpin' : 'Pin'} onClick={onPin}>{m.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}</ActionButton>}
            {onFollowUp && <ActionButton label="Create task or reminder" onClick={onFollowUp}><ListTodo className="size-4" /></ActionButton>}
            {onEdit && <ActionButton label="Edit" onClick={onEdit}><Pencil className="size-4" /></ActionButton>}
            {onDelete && <ActionButton label="Delete for everyone" onClick={onDelete} danger><Trash2 className="size-4" /></ActionButton>}
          </div>
        )}
        {reacting && !phone && (
          <div className={cn('ios-menu absolute z-20 flex items-center gap-0.5 !rounded-full p-1', mine ? 'right-0' : 'left-0', '-top-12')} data-testid="chat-quick-reactions">
            {QUICK_REACTIONS.map((e) => (
              <button key={e} type="button" onClick={() => onReact(e)} aria-label={`React ${e}`} className="flex size-9 items-center justify-center rounded-full text-[21px] transition-transform hover:scale-125">
                {e}
              </button>
            ))}
            <button type="button" onClick={() => setMorePicker(true)} aria-label="More emoji" className="flex size-9 items-center justify-center rounded-full text-[var(--ios-gray)] hover:bg-black/5">
              <SmilePlus className="size-[18px]" />
            </button>
            <button type="button" onClick={onCloseReactions} aria-label="Close" className="flex size-9 items-center justify-center rounded-full text-[var(--ios-gray)] hover:bg-black/5">
              <X className="size-4" />
            </button>
            {morePicker && (
              <EmojiPicker
                className={cn('absolute top-12', mine ? 'right-0' : 'left-0')}
                onPick={(e) => {
                  setMorePicker(false)
                  onReact(e)
                }}
                onClose={() => setMorePicker(false)}
              />
            )}
          </div>
        )}
        {showActions && phone && selected &&
          createPortal(
            <div className="ios fixed inset-0 z-[58] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Message actions" data-testid="chat-action-sheet">
              <button type="button" className="ios-sheet-backdrop absolute inset-0 cursor-default" aria-label="Close" onClick={onSelect} />
              <div className="ios-sheet-up relative space-y-2 px-2 pb-[max(0.5rem,var(--sab))]">
                <div className="mx-auto flex w-max max-w-full items-center gap-0.5 rounded-full bg-white p-1.5 shadow-[0_8px_30px_rgb(0_0_0/0.2)]" data-testid="chat-quick-reactions">
                  {QUICK_REACTIONS.map((e) => (
                    <button key={e} type="button" onClick={() => onReact(e)} aria-label={`React ${e}`} className="flex size-10 items-center justify-center rounded-full text-[24px] active:scale-125 active:bg-black/5">
                      {e}
                    </button>
                  ))}
                  <button type="button" onClick={() => setMorePicker((v) => !v)} aria-label="More emoji" className="flex size-10 items-center justify-center rounded-full bg-[var(--ios-fill)] text-[var(--ios-gray)]">
                    <SmilePlus className="size-5" />
                  </button>
                </div>
                {morePicker && (
                  <div className="flex justify-center">
                    <EmojiPicker
                      className="relative"
                      onPick={(e) => {
                        setMorePicker(false)
                        onReact(e)
                      }}
                      onClose={() => setMorePicker(false)}
                    />
                  </div>
                )}
                <div className="ios-sheet-group">
                  <p className="line-clamp-3 px-4 py-3 text-[14px] text-[var(--ios-label2)]">{m.body ?? (f ? `📎 ${f.name}` : '')}</p>
                  <SheetItem label="Reply" icon={<CornerUpLeft className="size-5" />} onClick={onReply} />
                  {m.body && <SheetItem label="Copy" icon={<Copy className="size-5" />} onClick={onCopy} />}
                  <SheetItem label="Forward" icon={<Forward className="size-5" />} onClick={onForward} />
                  {onSave && <SheetItem label={m.saved ? 'Unsave' : 'Save'} icon={m.saved ? <StarOff className="size-5" /> : <Star className="size-5" />} onClick={onSave} />}
                  {onPin && <SheetItem label={m.pinned ? 'Unpin' : 'Pin'} icon={m.pinned ? <PinOff className="size-5" /> : <Pin className="size-5" />} onClick={onPin} />}
                  {onFollowUp && <SheetItem label="Create task or reminder" icon={<ListTodo className="size-5" />} onClick={onFollowUp} />}
                  {onEdit && <SheetItem label="Edit" icon={<Pencil className="size-5" />} onClick={onEdit} />}
                  {onDelete && <SheetItem label="Delete for everyone" icon={<Trash2 className="size-5" />} onClick={onDelete} danger />}
                </div>
                <div className="ios-sheet-group">
                  <button type="button" onClick={onSelect} className="ios-sheet-item justify-center font-semibold text-[var(--ios-blue)]">Cancel</button>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
  )
}

function SheetItem({ label, icon, onClick, danger }: { label: string; icon: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={cn('ios-sheet-item', danger && 'text-[var(--ios-red)]')}>
      {label}
      <span className={danger ? 'text-[var(--ios-red)]' : 'text-[var(--ios-label)]'}>{icon}</span>
    </button>
  )
}

function ActionButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cn('flex size-8 items-center justify-center rounded-full hover:bg-black/5', danger ? 'text-[var(--ios-red)]' : 'text-[var(--ios-blue)]')}>
      {children}
    </button>
  )
}

function FileBlock({ f, mine, onOpenImage, imageOnly }: { f: NonNullable<ChatMessage['file']>; mine: boolean; onOpenImage: () => void; imageOnly?: boolean }) {
  if (f.status === 'PENDING')
    return (
      <div className={cn('mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2', mine ? 'bg-white/20' : 'bg-white/70')} data-testid="chat-file-pending">
        <LoaderCircle className="size-5 shrink-0 animate-spin" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{f.name}</span>
          <span className={cn('block text-[11.5px]', mine ? 'text-white/75' : 'text-[var(--ios-gray)]')}>Checking for viruses… · {fileSize(f.size)}</span>
        </span>
      </div>
    )
  if (f.status === 'BLOCKED' || f.status === 'ERROR' || f.status === 'REMOVED')
    return (
      <div className={cn('mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2', mine ? 'bg-white/15' : 'bg-danger/5')} data-testid="chat-file-blocked">
        <ShieldAlert className={cn('size-5 shrink-0', mine ? 'text-white' : 'text-danger')} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium line-through decoration-1">{f.name}</span>
          <span className={cn('block text-[11.5px]', mine ? 'text-white/80' : 'text-danger')}>
            {f.status === 'BLOCKED' ? 'Blocked by the antivirus' : f.status === 'REMOVED' ? 'File removed' : 'Could not be checked, so it is not available'}
          </span>
        </span>
      </div>
    )
  if (f.category === 'IMAGE')
    return (
      <button type="button" onClick={onOpenImage} className={cn('block overflow-hidden', imageOnly ? 'rounded-[18px]' : '-mx-1.5 mt-0.5 mb-1 rounded-[14px]')} aria-label={`Open image ${f.name}`}>
        <img src={fileUrl(f.id, true)} alt={f.name} loading="lazy" className="max-h-[300px] max-w-[min(260px,100%)] object-cover" data-testid="chat-image" />
      </button>
    )
  return (
    <div className={cn('mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2', mine ? 'bg-white/20' : 'bg-white/70')} data-testid="chat-file">
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-md', mine ? 'bg-white/25 text-white' : 'bg-[var(--ios-blue)]/10 text-[var(--ios-blue)]')}>{fileIcon(f.category)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{f.name}</span>
        <span className={cn('block text-[11.5px]', mine ? 'text-white/75' : 'text-[var(--ios-gray)]')}>{f.extension.toUpperCase()} · {fileSize(f.size)}</span>
      </span>
      {f.inline && (
        <a href={fileUrl(f.id, true)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${f.name}`} title="Open" className={cn('flex size-8 items-center justify-center rounded-full', mine ? 'hover:bg-white/20' : 'hover:bg-surface')}>
          <ExternalLink className="size-4" />
        </a>
      )}
      <a href={fileUrl(f.id)} aria-label={`Download ${f.name}`} title="Download" className={cn('flex size-8 items-center justify-center rounded-full', mine ? 'hover:bg-white/20' : 'hover:bg-surface')} data-testid="chat-file-download">
        <Download className="size-4" />
      </a>
    </div>
  )
}

function InChatSearch({ conversationId, onPick, onClose }: { conversationId: string; onPick: (seq: number) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<ChatMessage[] | null>(null)
  useEffect(() => {
    const t = q.trim()
    if (t.length < 2) {
      setItems(null)
      return
    }
    let cancelled = false
    const h = window.setTimeout(() => chatApi.search({ q: t, conversationId }).then((r) => !cancelled && setItems(r.items), () => !cancelled && setItems([])), 300)
    return () => {
      cancelled = true
      window.clearTimeout(h)
    }
  }, [q, conversationId])
  return (
    <div className="ios-bar ios-hairline-b relative z-10 px-3 py-2 sm:px-4" data-testid="chat-search">
      <div className="flex items-center gap-2">
        <label className="ios-search flex-1">
          <Search className="size-[17px] shrink-0" aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} placeholder="Search in this chat" aria-label="Search in this chat" />
        </label>
        <button type="button" onClick={onClose} aria-label="Close search" className="text-[16px] text-[var(--ios-blue)] active:opacity-50">Cancel</button>
      </div>
      {items && (
        <ul className="mt-2 max-h-[40vh] overflow-y-auto scrollbar-thin">
          {items.length === 0 && <li className="py-3 text-center text-[12.5px] text-ink-muted">No messages found.</li>}
          {items.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onPick(m.seq)} className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-muted" data-testid="chat-search-result">
                <span className="flex justify-between gap-2 text-[11.5px] text-ink-muted">
                  <span className="truncate font-semibold text-ink-secondary">{m.senderName}</span>
                  <span className="shrink-0">{fullTime(m.createdUtc)}</span>
                </span>
                <span className="line-clamp-2 text-[13px] text-ink">{m.body ?? (m.file ? `📎 ${m.file.name}` : '')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ConversationMenu({ c, onClose, onLeaveView, onSearch, onFollowUp, favourite, onScheduled }: {
  c: Conversation
  onClose: () => void
  onLeaveView: () => void
  onSearch?: () => void
  onFollowUp?: () => void
  favourite?: { on: boolean; toggle: () => void }
  onScheduled?: () => void
}) {
  const toast = useToast()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const run = (p: Promise<unknown>, after?: () => void) => {
    onClose()
    p.then(() => after?.(), (e) => toast.error(errorMessage(e, 'That did not work. Please try again.')))
  }
  const icon = 'size-[18px] shrink-0 text-[var(--ios-label)]'
  return (
    <div ref={ref} role="menu" className="ios-menu absolute top-11 right-0 z-30 w-64" data-testid="chat-menu">
      {onSearch && (
        <button role="menuitem" type="button" className="ios-menu-item" onClick={() => (onClose(), onSearch())}>
          Search in chat <Search className={icon} />
        </button>
      )}
      {favourite && (
        <button role="menuitem" type="button" className="ios-menu-item" onClick={() => (onClose(), favourite.toggle())} data-testid="chat-favourite">
          {favourite.on ? 'Remove from Favourites' : 'Add to Favourites'} {favourite.on ? <StarOff className={icon} /> : <Star className={icon} />}
        </button>
      )}
      {onScheduled && (
        <button role="menuitem" type="button" className="ios-menu-item" onClick={() => (onClose(), onScheduled())} data-testid="chat-scheduled">
          Scheduled messages <Clock3 className={icon} />
        </button>
      )}
      {onFollowUp && (
        <button role="menuitem" type="button" className="ios-menu-item" onClick={() => (onClose(), onFollowUp())} data-testid="chat-follow-up">
          Follow-up task <ListTodo className={icon} />
        </button>
      )}
      <button role="menuitem" type="button" className="ios-menu-item" onClick={() => run(chatApi.pin(c.id, !c.pinned))}>
        {c.pinned ? 'Unpin chat' : 'Pin chat'} {c.pinned ? <PinOff className={icon} /> : <Pin className={icon} />}
      </button>
      {c.muted ? (
        <button role="menuitem" type="button" className="ios-menu-item" onClick={() => run(chatApi.mute(c.id, { minutes: 0 }))}>
          Unmute <Bell className={icon} />
        </button>
      ) : (
        <>
          <p className="bg-black/[0.04] px-4 pt-2 pb-1 text-[12px] text-[var(--ios-label2)]">Mute notifications</p>
          {[['For 8 hours', 480], ['For 1 week', 10_080]].map(([label, minutes]) => (
            <button key={label} role="menuitem" type="button" className="ios-menu-item" onClick={() => run(chatApi.mute(c.id, { minutes: minutes as number }))}>
              {label} <BellOff className={icon} />
            </button>
          ))}
          <button role="menuitem" type="button" className="ios-menu-item" onClick={() => run(chatApi.mute(c.id, { forever: true }))}>
            Always <BellOff className={icon} />
          </button>
        </>
      )}
      <div className="h-2 bg-black/[0.04]" />
      <button role="menuitem" type="button" className="ios-menu-item" onClick={() => run(chatApi.markUnread(c.id), onLeaveView)} data-testid="chat-mark-unread">
        Mark as unread <MailWarning className={icon} />
      </button>
      <button role="menuitem" type="button" className="ios-menu-item" onClick={() => run(chatApi.archive(c.id, !c.archived), c.archived ? undefined : onLeaveView)}>
        {c.archived ? 'Unarchive' : 'Archive chat'} {c.archived ? <ArchiveRestore className={icon} /> : <Archive className={icon} />}
      </button>
    </div>
  )
}
