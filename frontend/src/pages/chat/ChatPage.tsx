import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { AtSign, BellOff, Check, ChevronRight, Clock3, ListChecks, MessagesSquare, Moon, Pin, Search, ShieldCheck, SlidersHorizontal, SquarePen, Star, Users, X } from 'lucide-react'
import { advApi, chatApi, type Availability, type ChatMessage, type ChatPerson, type Conversation, type Favourite, type Presence } from '../../api/chat'
import { errorMessage } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { useChat } from './ChatProvider'
import { ConversationAvatar, NewChatDialog, NewGroupDialog, PresenceDot, usePeopleSearch } from './ChatParts'
import { ConversationView } from './ConversationView'
import { CallHistory } from './CallHistory'
import { useFullScreenChat } from './useFullScreenChat'
import { useCalls } from './CallProvider'
import { fullTime, listTime, presenceColor, presenceLabel, previewOf } from './chatUtils'
import { IosSegmented } from './IosSegmented'
import { ScrollChips } from './ScrollChips'
import { MentionsList, NO_FILTER, SavedList, SearchFiltersSheet, filterCount, type SearchFilter } from './advanced/Lists'
import { FollowUpPanel, QuietHoursSheet } from './advanced/Settings'
import { ScheduledListSheet } from './advanced/Scheduled'
import { isQuietNow } from './quiet'
import { NotifyPrompt } from './NotifyPrompt'
import './chat.css'

const WorkSpace = lazy(() => import('./work/WorkSpace'))

type Filter = 'all' | 'unread' | 'groups' | 'pinned' | 'archived' | 'mentions' | 'saved'
const BASE_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'groups', label: 'Groups' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'archived', label: 'Archived' },
]
// Phase 5 (CHAT_ADVANCED): messages that mention me, and my saved messages.
const ADV_FILTERS: { key: Filter; label: string }[] = [
  { key: 'mentions', label: '@ Mentions' },
  { key: 'saved', label: '★ Saved' },
]

export type Section = 'chats' | 'calls' | 'myday' | 'notes' | 'tasks'
const SECTION_LABEL: Record<Section, string> = { chats: 'Chats', calls: 'Calls', myday: 'My Day', notes: 'Notes', tasks: 'Tasks' }

function sortConversations(list: Conversation[]) {
  const t = (c: Conversation) => new Date(c.lastMessage?.createdUtc ?? c.createdUtc).getTime()
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || t(b) - t(a))
}

/** iOS-style segmented control: Chats · Calls · My Day · Notes · Tasks (only the sections that are switched on). */
export function SectionTabs({ sections, value, onChange }: { sections: Section[]; value: Section; onChange: (s: Section) => void }) {
  if (sections.length < 2) return null
  return <IosSegmented label="Chat sections" value={value} onChange={onChange} options={sections.map((k) => ({ key: k, label: SECTION_LABEL[k] }))} testIdPrefix="chat-section-" />
}

/**
 * /chat - the Chat workspace (iOS look). ?c=<id> keeps the open conversation in the address; ?tab=calls|myday|notes|tasks
 * opens another section (reminder alerts link to ?tab=tasks&task=<id> or ?tab=notes&note=<id>).
 */
export default function ChatPage() {
  const chat = useChat()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const activeId = params.get('c')
  const jumpSeq = params.get('seq') ? Number(params.get('seq')) : null
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [newChat, setNewChat] = useState(false)
  const [newGroup, setNewGroup] = useState(false)
  const [messageHits, setMessageHits] = useState<ChatMessage[] | null>(null)
  const calls = useCalls()
  const status = chat.status
  const tasksOn = !!(status?.enabled && status.tasks)
  const advancedOn = !!(status?.enabled && status.advanced)
  const FILTERS = advancedOn ? [...BASE_FILTERS.slice(0, 2), ...ADV_FILTERS, ...BASE_FILTERS.slice(2)] : BASE_FILTERS
  const [searchFilter, setSearchFilter] = useState<SearchFilter>(NO_FILTER)
  const [filterSheet, setFilterSheet] = useState(false)
  const [followUps, setFollowUps] = useState(false)
  const [favourites, setFavourites] = useState<Favourite[]>([])
  const loadFavourites = useCallback(() => {
    if (advancedOn) advApi.favourites().then(setFavourites, () => {})
  }, [advancedOn])
  useEffect(() => loadFavourites(), [loadFavourites])
  const sections = useMemo<Section[]>(
    () => ['chats', ...(calls.enabled ? (['calls'] as const) : []), ...(tasksOn ? (['myday', 'notes', 'tasks'] as const) : [])],
    [calls.enabled, tasksOn],
  )
  const fromPath: Section | null = pathname.endsWith('/my-day') ? 'myday' : pathname.endsWith('/tasks') ? 'tasks' : pathname.endsWith('/notes') ? 'notes' : null
  const tab = (fromPath ?? params.get('tab')) as Section | null
  const section: Section = activeId ? 'chats' : tab && sections.includes(tab) ? tab : 'chats'
  const setSection = useCallback(
    (s: Section) => navigate(s === 'myday' ? '/my-day' : s === 'tasks' ? '/tasks' : s === 'notes' ? '/notes' : s === 'calls' ? '/chat?tab=calls' : '/chat'),
    [navigate],
  )
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const listRef = useRef<Conversation[] | null>(null)
  listRef.current = conversations

  const load = useCallback(() => {
    chatApi.conversations().then(
      (list) => {
        setConversations(sortConversations(list))
        setError(null)
      },
      (e) => setError(errorMessage(e, 'Your chats could not be loaded.')),
    )
  }, [])

  useEffect(() => {
    if (chat.enabled) load()
  }, [chat.enabled, load])

  const upsert = useCallback((c: Conversation) => setConversations((list) => (list ? sortConversations([c, ...list.filter((x) => x.id !== c.id)]) : list)), [])

  const open = useCallback(
    (id: string | null, seq?: number) => {
      const next = new URLSearchParams()
      if (id) next.set('c', id)
      if (id && seq) next.set('seq', String(seq))
      if (fromPath) navigate(`/chat${next.size ? `?${next}` : ''}`) // from My Day / Tasks / Notes
      else setParams(next, { replace: !!activeId && !!id })
    },
    [setParams, activeId, fromPath, navigate],
  )

  const openDirect = useCallback(
    (userId: string) =>
      chatApi.direct(userId).then(
        (c) => {
          upsert(c)
          open(c.id)
        },
        (e) => toast.error(errorMessage(e, 'The chat could not be opened.')),
      ),
    [upsert, open, toast],
  )

  // Live list updates.
  useEffect(() => {
    if (!chat.enabled) return
    const offs = [
      chat.on<ChatMessage>('message.new', (m) => {
        setConversations((list) => {
          if (!list) return list
          const c = list.find((x) => x.id === m.conversationId)
          if (!c) {
            window.setTimeout(load, 0) // a conversation new to me (first message of a direct chat)
            return list
          }
          const fromOther = !!m.senderId && m.senderId !== chat.meId
          const viewing = m.conversationId === activeIdRef.current && document.visibilityState === 'visible'
          const updated: Conversation = {
            ...c,
            archived: c.archived && c.muted, // a new message brings an archived chat back unless it is muted
            unread: fromOther && !viewing && m.kind !== 'SYSTEM' ? c.unread + 1 : c.unread,
            lastMessage: { id: m.id, seq: m.seq, kind: m.kind, preview: m.body, fileName: m.file?.name ?? null, deleted: m.deleted, createdUtc: m.createdUtc, senderId: m.senderId, senderName: m.senderName },
          }
          return sortConversations([updated, ...list.filter((x) => x.id !== c.id)])
        })
      }),
      chat.on<ChatMessage>('message.updated', (m) =>
        setConversations((list) =>
          list?.map((c) =>
            c.id === m.conversationId && c.lastMessage?.id === m.id
              ? { ...c, lastMessage: { ...c.lastMessage, preview: m.body, deleted: m.deleted, fileName: m.file?.name ?? null } }
              : c,
          ) ?? list,
        ),
      ),
      chat.on<Conversation>('conversation.updated', upsert),
      chat.on<Conversation>('conversation.added', upsert),
      chat.on<{ id: string }>('conversation.removed', (r) => {
        setConversations((list) => list?.filter((c) => c.id !== r.id) ?? list)
        if (r.id === activeIdRef.current) {
          toast.error('You are no longer a member of that group.')
          open(null)
        }
      }),
      chat.on<{ id: string }>('conversation.changed', (r) => chatApi.conversation(r.id).then((d) => upsert(d.conversation), () => {})),
      chat.on<{ userId: string; state: Presence['state']; lastSeenUtc: string | null }>('presence', (p) =>
        setConversations((list) =>
          list?.map((c) =>
            c.other?.id === p.userId
              ? { ...c, other: { ...c.other, presence: { state: p.state, lastSeenUtc: chat.preferences?.showLastSeen === false ? null : p.lastSeenUtc } } }
              : c,
          ) ?? list,
        ),
      ),
      chat.on('reconnected', load),
    ]
    return () => offs.forEach((o) => o())
  }, [chat, load, upsert, open, toast])

  // Opening a conversation clears its unread count locally (the view marks it read on the server).
  useEffect(() => {
    if (activeId) setConversations((list) => list?.map((c) => (c.id === activeId ? { ...c, unread: 0, markedUnread: false } : c)) ?? list)
  }, [activeId])

  // Presence of people in the list refreshes every minute (covers "in a meeting" changes, which are not pushed).
  useEffect(() => {
    if (!chat.enabled) return
    const t = window.setInterval(() => {
      const ids = (listRef.current ?? []).map((c) => c.other?.id).filter((x): x is string => !!x).slice(0, 100)
      if (ids.length === 0) return
      chatApi.presence(ids).then((rows) => {
        const map = new Map(rows.map((r) => [r.userId, r.presence]))
        setConversations((list) => list?.map((c) => (c.other && map.has(c.other.id) ? { ...c, other: { ...c.other, presence: map.get(c.other.id)! } } : c)) ?? list)
      }, () => {})
    }, 60_000)
    return () => window.clearInterval(t)
  }, [chat.enabled])

  // Message search across all my chats (2+ characters, or any filter: person, chat, dates, files).
  const filtersOn = advancedOn && filterCount(searchFilter) > 0
  useEffect(() => {
    const t = query.trim()
    if (t.length < 2 && !filtersOn) {
      setMessageHits(null)
      return
    }
    let cancelled = false
    const f = filtersOn ? searchFilter : NO_FILTER
    const h = window.setTimeout(
      () =>
        chatApi
          .search({ q: t || undefined, senderId: f.sender?.id, conversationId: f.conversationId ?? undefined, fromUtc: f.from ?? undefined, toUtc: f.to ?? undefined, files: f.files || undefined })
          .then((r) => !cancelled && setMessageHits(r.items), () => !cancelled && setMessageHits([])),
      350,
    )
    return () => {
      cancelled = true
      window.clearTimeout(h)
    }
  }, [query, searchFilter, filtersOn])
  const searching = query.trim().length > 0 || filtersOn
  const { people } = usePeopleSearch(query, searching)

  const visible = useMemo(() => {
    const list = conversations ?? []
    const t = query.trim().toLowerCase()
    if (t) return list.filter((c) => c.name.toLowerCase().includes(t) || (c.other?.code ?? '').toLowerCase().includes(t))
    switch (filter) {
      case 'unread':
        return list.filter((c) => !c.archived && (c.unread > 0 || c.markedUnread))
      case 'groups':
        return list.filter((c) => !c.archived && c.type === 'GROUP')
      case 'pinned':
        return list.filter((c) => c.pinned)
      case 'archived':
        return list.filter((c) => c.archived)
      default:
        return list.filter((c) => !c.archived)
    }
  }, [conversations, filter, query])

  const active = conversations?.find((c) => c.id === activeId) ?? null
  const fullScreen = useFullScreenChat(!!activeId && section === 'chats')


  // Opened by id but not in my list yet (e.g. just created elsewhere): load it once.
  useEffect(() => {
    if (activeId && conversations && !active)
      chatApi.conversation(activeId).then((d) => upsert(d.conversation), () => {
        toast.error('That chat is not available.')
        open(null)
      })
  }, [activeId, conversations, active, upsert, open, toast])

  if (status && !status.enabled)
    return (
      <div className="oic-chat ios flex items-center justify-center rounded-xl border border-line bg-surface p-6 text-center">
        <div className="max-w-sm">
          <MessagesSquare className="mx-auto size-10 text-[var(--ios-gray)]" />
          <p className="mt-3 text-[17px] font-semibold">Chat is not available</p>
          <p className="mt-1 text-[15px] text-[var(--ios-label2)]">
            {status.reason === 'NO_EMPLOYEE' ? 'Chat is for employees with an employee profile. Ask your administrator to link your account to your employee record.' : 'Chat is switched off by your administrator.'}
          </p>
        </div>
      </div>
    )
  if (!status?.enabled)
    return <div className="oic-chat animate-pulse rounded-xl border border-line bg-surface" aria-busy="true" aria-label="Loading Chat" />

  const limits = status.limits
  const tabs = <SectionTabs sections={sections.filter((s) => s === 'chats' || s === 'calls')} value={section} onChange={setSection} />

  if (section === 'myday' || section === 'notes' || section === 'tasks')
    return (
      <div className="oic-chat ios -mx-4 flex overflow-hidden bg-[var(--ios-gray6)] sm:mx-0 sm:rounded-2xl sm:border sm:border-line sm:shadow-xs" data-testid="chat-page">
        <Suspense fallback={<div className="m-auto size-6 animate-spin rounded-full border-2 border-[var(--ios-gray4)] border-t-[var(--ios-blue)]" aria-label="Loading" />}>
          <WorkSpace
            section={section}
            tabs={null}
            params={params}
            setParams={setParams}
            conversations={conversations ?? []}
            onOpenChat={(id) => open(id)}
            onOpenDirect={openDirect}
            onSection={setSection}
            onNewChat={() => setNewChat(true)}
            onNewGroup={() => setNewGroup(true)}
          />
        </Suspense>
        <NewChatDialog open={newChat} onClose={() => setNewChat(false)} onStarted={(c) => (upsert(c), open(c.id))} />
        <NewGroupDialog open={newGroup} onClose={() => setNewGroup(false)} onCreated={(c) => (upsert(c), open(c.id))} maxMembers={limits.maxGroupMembers} />
      </div>
    )

  const page = (
    <div className={cn('oic-chat ios -mx-4 flex overflow-hidden bg-white sm:mx-0 sm:rounded-2xl sm:border sm:border-line sm:shadow-xs', fullScreen && 'oic-chat-full')} data-testid="chat-page">
      {/* Conversation list */}
      <aside className={cn('flex h-full w-full flex-col bg-white md:w-[340px] md:shrink-0 md:shadow-[inset_-0.5px_0_0_var(--ios-sep)] lg:w-[370px]', active && 'max-md:hidden')} aria-label="Chats">
        <div className="shrink-0 px-4 pt-2.5">
          <div className="flex h-9 items-center justify-between">
            <MeMenu />
            <div className="flex items-center gap-0.5">
              {advancedOn && tasksOn && (
                <button type="button" onClick={() => setFollowUps(true)} aria-label="Follow-ups due" title="Follow-ups due" className="ios-icon-btn" data-testid="chat-followups">
                  <ListChecks className="size-[21px]" strokeWidth={1.9} />
                </button>
              )}
              <button type="button" onClick={() => setNewGroup(true)} aria-label="New group" title="New group" className="ios-icon-btn" data-testid="chat-new-group">
                <Users className="size-[21px]" strokeWidth={1.9} />
              </button>
              <button type="button" onClick={() => setNewChat(true)} aria-label="New chat" title="New chat" className="ios-icon-btn" data-testid="chat-new">
                <SquarePen className="size-[21px]" strokeWidth={1.9} />
              </button>
            </div>
          </div>
          <h1 className="ios-large-title mt-0.5">{SECTION_LABEL[section]}</h1>
          {calls.enabled && <div className="mt-2.5">{tabs}</div>}
        </div>
        {section === 'calls' && calls.enabled ? (
          <div className="ios-fade flex min-h-0 flex-1 flex-col"><CallHistory onOpenChat={(id) => open(id)} /></div>
        ) : (
        <>
        <div className="shrink-0 px-4 pt-2.5">
          <div className="flex items-center gap-2">
            <label className="ios-search flex-1">
              <Search className="size-[17px] shrink-0" aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats, people and messages" data-testid="chat-search-all" />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="flex size-[18px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white">
                  <X className="size-3" strokeWidth={3} />
                </button>
              )}
            </label>
            {advancedOn && (
              <button type="button" onClick={() => setFilterSheet(true)} aria-label={filtersOn ? `Search filters (${filterCount(searchFilter)} on)` : 'Search filters'} aria-pressed={filtersOn} className="ios-icon-btn relative" data-testid="chat-search-filters">
                <SlidersHorizontal className="size-[20px]" />
                {filtersOn && <span className="ios-pop absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-[var(--ios-blue)] text-[10px] font-bold text-white">{filterCount(searchFilter)}</span>}
              </button>
            )}
          </div>
          {!searching && (
            <ScrollChips label="Filter chats" className="mt-2.5 mb-2" testId="chat-filters">
              {FILTERS.map((f) => {
                const count = f.key === 'unread' ? (conversations ?? []).filter((c) => !c.archived && (c.unread > 0 || c.markedUnread)).length : 0
                return (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    className={cn('inline-flex h-[30px] shrink-0 items-center gap-1 rounded-full px-3.5 text-[14px] font-medium transition-colors', filter === f.key ? 'bg-[var(--ios-blue)] text-white' : 'bg-[var(--ios-fill)] text-[var(--ios-label)]')}
                  >
                    {f.label}
                    {count > 0 && <span className={cn('rounded-full px-1.5 text-[11px] font-semibold', filter === f.key ? 'bg-white/25' : 'bg-[var(--ios-blue)] text-white')}>{count}</span>}
                  </button>
                )
              })}
            </ScrollChips>
          )}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin" data-testid="chat-list">
        {!searching && <NotifyPrompt className="mx-3 mt-1 mb-2" />}
        {/* Favourites scroll away with the list, so short laptop screens still show the chats. */}
        {!searching && filter === 'all' && advancedOn && favourites.length > 0 && (
          <div className="px-4 pb-1" data-testid="chat-favourites">
            <p className="mb-1 flex items-center gap-1 text-[12px] font-semibold tracking-wide text-[var(--ios-label2)] uppercase"><Star className="size-3 fill-current text-[var(--ios-orange)]" /> Favourites</p>
            <div className="scrollbar-none -mx-4 flex gap-3.5 overflow-x-auto px-4 py-1">
              {favourites.map((p) => (
                <button key={p.id} type="button" onClick={() => void openDirect(p.id)} className="flex w-[58px] shrink-0 flex-col items-center gap-1" title={p.name} data-testid="chat-favourite-item">
                  <span className="relative">
                    <Avatar name={p.name} size={52} />
                    <PresenceDot presence={p.presence} className="absolute right-0 bottom-0.5 size-3.5 ring-[2.5px] ring-white" />
                  </span>
                  <span className="w-full truncate text-center text-[12px] text-[var(--ios-label2)]">{p.name.split(' ')[0]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
          {error && (
            <div className="p-6 text-center">
              <p className="text-[15px] text-[var(--ios-label2)]">{error}</p>
              <button type="button" className="ios-btn-tinted mt-3" onClick={load}>Try again</button>
            </div>
          )}
          {!conversations && !error && (
            <ul className="px-4 py-2" aria-busy="true">
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="flex animate-pulse items-center gap-3 py-2.5">
                  <span className="size-[52px] rounded-full bg-[var(--ios-gray5)]" />
                  <span className="flex-1 space-y-2"><span className="block h-3.5 w-2/5 rounded bg-[var(--ios-gray5)]" /><span className="block h-3 w-4/5 rounded bg-[var(--ios-gray6)]" /></span>
                </li>
              ))}
            </ul>
          )}
          {!searching && filter === 'saved' && <SavedList onOpen={(cid, seq) => open(cid, seq)} />}
          {!searching && filter === 'mentions' && <MentionsList onOpen={(cid, seq) => open(cid, seq)} />}
          {conversations && filter !== 'saved' && filter !== 'mentions' && (
            <ul className="ios-list pb-2">
              {visible.map((c) => (
                <ConversationItem key={c.id} c={c} active={c.id === activeId} meId={chat.meId} onOpen={() => open(c.id)} />
              ))}
            </ul>
          )}
          {conversations && !searching && visible.length === 0 && filter !== 'saved' && filter !== 'mentions' && (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-[var(--ios-gray6)] text-[var(--ios-gray)]"><MessagesSquare className="size-8" /></span>
              <p className="mt-3 text-[17px] font-semibold">{filter === 'all' ? 'No Chats Yet' : `No ${FILTERS.find((f) => f.key === filter)!.label} Chats`}</p>
              {filter === 'all' && (
                <>
                  <p className="mt-1 text-[15px] text-[var(--ios-label2)]">Start a conversation with a colleague or create a group.</p>
                  <div className="mt-4 flex gap-2">
                    <button type="button" className="ios-btn-tinted" onClick={() => setNewChat(true)}><SquarePen className="size-4" /> New chat</button>
                    <button type="button" className="ios-btn-tinted" onClick={() => setNewGroup(true)}><Users className="size-4" /> New group</button>
                  </div>
                </>
              )}
            </div>
          )}
          {searching && (
            <SearchResults
              people={people.filter((p) => !(conversations ?? []).some((c) => c.other?.id === p.id && c.name.toLowerCase().includes(query.trim().toLowerCase())))}
              messages={messageHits}
              conversations={conversations ?? []}
              noChats={visible.length === 0}
              onPerson={(p) => {
                setQuery('')
                void openDirect(p.id)
              }}
              onMessage={(m) => {
                setQuery('')
                open(m.conversationId, m.seq)
              }}
            />
          )}
        </div>
        </>
        )}
        <p className="hidden shrink-0 items-center justify-center gap-1.5 py-2 text-[11.5px] text-[var(--ios-gray)] ios-hairline-t md:flex">
          <ShieldCheck className="size-3.5" /> Messages and files stay on OneInsure servers
        </p>
      </aside>

      {/* Conversation */}
      <main className={cn('h-full min-w-0 flex-1', !active && 'max-md:hidden', active && 'ios-push')} key={active?.id ?? 'none'}>
        {active ? (
          <ConversationView
            key={active.id}
            conversation={active}
            conversations={conversations ?? []}
            limits={limits}
            jumpSeq={jumpSeq}
            tasksOn={tasksOn}
            advancedOn={advancedOn}
            isFavourite={!!active.other && favourites.some((x) => x.id === active.other!.id)}
            onToggleFavourite={
              active.other
                ? () => {
                    const on = favourites.some((x) => x.id === active.other!.id)
                    ;(on ? advApi.removeFavourite(active.other!.id) : advApi.addFavourite(active.other!.id)).then(
                      () => (loadFavourites(), toast.success(on ? 'Removed from Favourites' : 'Added to Favourites')),
                      (e) => toast.error(errorMessage(e, 'That did not work.')),
                    )
                  }
                : undefined
            }
            onBack={() => open(null)}
            onOpenDirect={(userId) => void openDirect(userId)}
            onRemoved={() => {
              setConversations((list) => list?.filter((c) => c.id !== active.id) ?? list)
              open(null)
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center bg-[var(--ios-gray6)] p-8 text-center">
            <span className="flex size-20 items-center justify-center rounded-[22px] bg-gradient-to-b from-[#5ac8fa] to-[var(--ios-blue)] text-white shadow-[0_12px_30px_rgb(0_122_255/0.3)]">
              <MessagesSquare className="size-10" />
            </span>
            <p className="mt-5 text-[20px] font-semibold">OneInsure Connect Chat</p>
            <p className="mt-1.5 max-w-sm text-[15px] text-[var(--ios-label2)]">Choose a chat on the left, or start a new conversation with a colleague or a group.</p>
            <div className="mt-5 flex gap-2">
              <button type="button" className="ios-btn-filled" onClick={() => setNewChat(true)}><SquarePen className="size-4" /> New chat</button>
              <button type="button" className="ios-btn-tinted h-11 rounded-xl" onClick={() => setNewGroup(true)}><Users className="size-4" /> New group</button>
            </div>
          </div>
        )}
      </main>

      <NewChatDialog open={newChat} onClose={() => setNewChat(false)} onStarted={(c) => (upsert(c), open(c.id))} />
      <NewGroupDialog open={newGroup} onClose={() => setNewGroup(false)} onCreated={(c) => (upsert(c), open(c.id))} maxMembers={limits.maxGroupMembers} />
      {filterSheet && <SearchFiltersSheet value={searchFilter} conversations={conversations ?? []} onApply={setSearchFilter} onClose={() => setFilterSheet(false)} />}
      {followUps && <FollowUpPanel onClose={() => setFollowUps(false)} />}
    </div>
  )
  // Phones: the open conversation covers the header and tab bar, so it is drawn at the page root (the animated
  // page wrapper would otherwise trap a fixed element inside it).
  return fullScreen ? createPortal(page, document.body) : page
}

function ConversationItem({ c, active, meId, onOpen }: { c: Conversation; active: boolean; meId: string | null; onOpen: () => void }) {
  const lm = c.lastMessage
  const unread = c.unread > 0 || c.markedUnread
  const prefix = lm && lm.kind !== 'SYSTEM' && !lm.deleted ? (lm.senderId === meId ? 'You: ' : c.type === 'GROUP' && lm.senderName ? `${lm.senderName.split(' ')[0]}: ` : '') : ''
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn('ios-pressable flex w-full items-center gap-3 pl-4 text-left', active && 'bg-[var(--ios-gray5)] hover:bg-[var(--ios-gray5)]')}
        data-testid="chat-item"
      >
        <span className="py-2"><ConversationAvatar c={c} size={52} /></span>
        <span className="ios-sep-top flex min-w-0 flex-1 items-center gap-2 self-stretch py-2.5 pr-4">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={cn('min-w-0 flex-1 truncate text-[16px] leading-[21px]', unread ? 'font-bold' : 'font-semibold')} data-testid="chat-item-name">{c.name}</span>
              {lm && (
                <span className={cn('shrink-0 text-[14px]', unread ? 'text-[var(--ios-blue)]' : 'text-[var(--ios-gray)]')} title={fullTime(lm.createdUtc)}>
                  {listTime(lm.createdUtc)}
                </span>
              )}
              <ChevronRight className="-mr-1 size-4 shrink-0 text-[var(--ios-gray4)]" aria-hidden />
            </span>
            <span className="mt-0.5 flex items-start gap-1.5">
              <span className={cn('line-clamp-2 min-w-0 flex-1 text-[15px] leading-[20px]', unread ? 'text-[var(--ios-label)]' : 'text-[var(--ios-gray)]')}>
                {lm ? prefix + previewOf(lm.kind, lm.preview, lm.fileName, lm.deleted) : c.type === 'GROUP' ? `${c.memberCount} members` : 'Say hello 👋'}
              </span>
              {(c.mentionsUnread ?? 0) > 0 && (
                <span className="ios-pop mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white" aria-label={`${c.mentionsUnread} unread mentions`} data-testid="chat-item-mention">
                  <AtSign className="size-3" strokeWidth={2.6} />
                </span>
              )}
              {c.muted && <BellOff className="mt-0.5 size-4 shrink-0 text-[var(--ios-gray2)]" aria-label="Muted" />}
              {c.pinned && <Pin className="mt-0.5 size-4 shrink-0 text-[var(--ios-gray2)]" aria-label="Pinned" />}
              {unread && (
                <span className={cn('ios-pop mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[12px] font-semibold text-white', c.muted ? 'bg-[var(--ios-gray2)]' : 'bg-[var(--ios-blue)]')} data-testid="chat-item-unread">
                  {c.unread > 0 ? (c.unread >= 100 ? '99+' : c.unread) : ''}
                </span>
              )}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="mt-3 mb-1 px-4 text-[13px] font-semibold tracking-[0.01em] text-[var(--ios-label2)] uppercase">{children}</p>
}

function SearchResults({
  people, messages, conversations, noChats, onPerson, onMessage,
}: {
  people: ChatPerson[]
  messages: ChatMessage[] | null
  conversations: Conversation[]
  noChats: boolean
  onPerson: (p: ChatPerson) => void
  onMessage: (m: ChatMessage) => void
}) {
  const names = new Map(conversations.map((c) => [c.id, c.name]))
  return (
    <div className="pb-3">
      {people.length > 0 && (
        <>
          <SectionTitle>People</SectionTitle>
          <ul className="ios-list">
            {people.slice(0, 8).map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onPerson(p)} className="ios-pressable flex w-full items-center gap-3 pl-4 text-left" data-testid="chat-search-person">
                  <span className="relative py-2">
                    <Avatar name={p.name} size={40} />
                    <PresenceDot presence={p.presence} className="absolute right-0 bottom-2 size-3 ring-2 ring-white" />
                  </span>
                  <span className="ios-sep-top min-w-0 flex-1 self-stretch py-2.5 pr-4">
                    <span className="block truncate text-[16px] font-semibold">{p.name}</span>
                    <span className="block truncate text-[14px] text-[var(--ios-gray)]">{[p.code, p.designation, p.department].filter(Boolean).join(' · ')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {messages && messages.length > 0 && (
        <>
          <SectionTitle>Messages</SectionTitle>
          <ul className="ios-list">
            {messages.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onMessage(m)} className="ios-pressable flex w-full pl-4 text-left" data-testid="chat-search-message">
                  <span className="ios-sep-top flex min-w-0 flex-1 flex-col py-2.5 pr-4">
                    <span className="flex justify-between gap-2 text-[13px] text-[var(--ios-gray)]">
                      <span className="truncate font-semibold text-[var(--ios-label)]">{names.get(m.conversationId) ?? 'Chat'} · {m.senderName}</span>
                      <span className="shrink-0">{listTime(m.createdUtc)}</span>
                    </span>
                    <span className="line-clamp-2 text-[15px] text-[var(--ios-label2)]">{m.body ?? (m.file ? `📎 ${m.file.name}` : '')}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {noChats && people.length === 0 && messages?.length === 0 && <p className="py-10 text-center text-[15px] text-[var(--ios-gray)]">No Results</p>}
    </div>
  )
}

const AVAILABILITY: { key: Availability; hint: string }[] = [
  { key: 'AVAILABLE', hint: 'Shown as online while you use the portal' },
  { key: 'BUSY', hint: 'Colleagues see that you are busy' },
  { key: 'DND', hint: 'Colleagues see "Do not disturb"; no chat sounds' },
  { key: 'AWAY', hint: 'Colleagues see that you are away' },
]

/** My avatar with availability (Available / Busy / Do not disturb / Away), last-seen privacy and sounds. */
function MeMenu() {
  const chat = useChat()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [quietSheet, setQuietSheet] = useState(false)
  const [scheduledSheet, setScheduledSheet] = useState(false)
  const prefs = chat.preferences
  const name = chat.status?.enabled ? chat.status.me.name : ''
  const advancedOn = !!(chat.status?.enabled && chat.status.advanced)
  const quiet = advancedOn && isQuietNow(prefs)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  if (!prefs) return <span />
  const save = (p: Partial<typeof prefs>) =>
    chatApi.preferences(p).then(chat.setPreferences, (e) => toast.error(errorMessage(e, 'Your setting could not be saved.')))
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={`Your status: ${presenceLabel[prefs.availability]}`} aria-expanded={open} className="flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 active:opacity-60" data-testid="chat-me">
        <span className="relative">
          <Avatar name={name || '?'} size={30} />
          <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-white', presenceColor[prefs.availability])} />
        </span>
        <span className="text-[15px] text-[var(--ios-blue)]">{presenceLabel[prefs.availability]}</span>
        {quiet && <Moon className="size-4 fill-[#5856d6] text-[#5856d6]" aria-label="Quiet hours on" data-testid="quiet-indicator" />}
      </button>
      {quietSheet && <QuietHoursSheet onClose={() => setQuietSheet(false)} />}
      {scheduledSheet && <ScheduledListSheet onClose={() => setScheduledSheet(false)} />}
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div role="menu" className="ios-menu absolute top-10 left-0 z-30 w-[290px]" data-testid="chat-me-menu">
            <p className="px-4 pt-3 pb-2 text-[13px] text-[var(--ios-label2)]">{name}</p>
            {AVAILABILITY.map((a) => (
              <button
                key={a.key}
                role="menuitemradio"
                aria-checked={prefs.availability === a.key}
                type="button"
                onClick={() => (void save({ availability: a.key }), setOpen(false))}
                className="ios-menu-item"
              >
                <span className="flex items-start gap-2.5">
                  <span className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', presenceColor[a.key])} />
                  <span>
                    <span className="block">{presenceLabel[a.key]}</span>
                    <span className="block text-[12.5px] text-[var(--ios-label2)]">{a.hint}</span>
                  </span>
                </span>
                {prefs.availability === a.key && <Check className="size-4 shrink-0 text-[var(--ios-blue)]" />}
              </button>
            ))}
            <div className="h-2 bg-black/[0.04]" />
            <label className="ios-menu-item cursor-pointer">
              <span>
                Show my last seen
                <span className="block text-[12.5px] text-[var(--ios-label2)]">If off, you also won't see others' last seen</span>
              </span>
              <input type="checkbox" role="switch" checked={prefs.showLastSeen} onChange={(e) => void save({ showLastSeen: e.target.checked })} className="ios-switch" />
            </label>
            {advancedOn && (
              <>
                <button type="button" className="ios-menu-item" onClick={() => (setOpen(false), setQuietSheet(true))} data-testid="chat-quiet-hours">
                  <span>
                    Quiet hours
                    <span className="block text-[12.5px] text-[var(--ios-label2)]">{prefs.quietEnabled ? `${prefs.quietStart}–${prefs.quietEnd}${quiet ? ' · on now' : ''}` : 'Off'}</span>
                  </span>
                  <Moon className="size-[18px] text-[#5856d6]" />
                </button>
                <button type="button" className="ios-menu-item" onClick={() => (setOpen(false), setScheduledSheet(true))} data-testid="chat-all-scheduled">
                  Scheduled messages <Clock3 className="size-[18px]" />
                </button>
              </>
            )}
            <label className="ios-menu-item cursor-pointer">
              New message sound
              <input type="checkbox" role="switch" checked={prefs.soundsOn} onChange={(e) => void save({ soundsOn: e.target.checked })} className="ios-switch" />
            </label>
          </div>
        </>
      )}
    </div>
  )
}
