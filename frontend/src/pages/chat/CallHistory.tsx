import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ListTodo, MessageSquare, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Search, Users, X } from 'lucide-react'
import { callsApi, type Call } from '../../api/calls'
import { errorMessage } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { cn } from '../../lib/cn'
import { parseUtc } from '../../lib/format'
import { useChat } from './ChatProvider'
import { useCalls } from './CallProvider'
import { fullTime, listTime } from './chatUtils'
import type { FollowUpSource } from './work/FollowUp'

const FollowUpSheet = lazy(() => import('./work/FollowUp'))

function duration(c: Call) {
  if (!c.answeredUtc || !c.endedUtc) return null
  const s = Math.max(0, Math.round((parseUtc(c.endedUtc).getTime() - parseUtc(c.answeredUtc).getTime()) / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

/** One line per call from my side: outgoing / incoming / missed / declined, with who, when and how long. */
function describe(c: Call, meId: string | null) {
  const mine = c.participants.find((p) => p.id === meId)
  const outgoing = c.startedBy?.id === meId
  const others = c.participants.filter((p) => p.id !== meId)
  const name = c.title ?? (others.length === 1 ? others[0].name : others.map((p) => p.name.split(' ')[0]).join(', '))
  const missed = !outgoing && (mine?.state === 'MISSED' || mine?.state === 'BUSY') && !mine?.answeredUtc
  const declined = !outgoing && mine?.state === 'DECLINED'
  const d = duration(c)
  const what = c.status === 'RINGING' || c.status === 'ACTIVE' ? 'Ongoing'
    : missed ? (mine?.state === 'BUSY' ? 'Missed (you were busy)' : 'Missed')
      : declined ? 'Declined'
        : outgoing && !c.answeredUtc ? (c.endReason === 'BUSY' ? 'Busy' : c.status === 'DECLINED' ? 'Declined' : 'No answer')
          : d ?? 'Ended'
  return { name, outgoing, missed: missed || declined, what, group: c.type === 'GROUP' || !!c.title }
}

/** Calls tab of the Chat workspace: history, search, call again, open the chat. */
export function CallHistory({ onOpenChat }: { onOpenChat: (conversationId: string) => void }) {
  const chat = useChat()
  const calls = useCalls()
  const [items, setItems] = useState<Call[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [followUp, setFollowUp] = useState<FollowUpSource | null>(null)
  const tasksOn = !!(chat.status?.enabled && chat.status.tasks)

  const load = useCallback(
    (more = false) => {
      callsApi.history({ search: search.trim() || undefined, beforeId: more ? items?.at(-1)?.id : undefined }).then(
        (r) => {
          setItems((cur) => (more && cur ? [...cur, ...r.items] : r.items))
          setHasMore(r.hasMore)
          setError(null)
        },
        (e) => setError(errorMessage(e, 'The call history could not be loaded.')),
      )
    },
    [search, items],
  )

  useEffect(() => {
    const t = window.setTimeout(() => load(false), search ? 300 : 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on search only
  }, [search])
  useEffect(() => chat.on('call.ended', () => load(false)), [chat, load])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="call-history">
      <div className="shrink-0 px-4 pt-2.5 pb-1">
        <label className="ios-search">
          <Search className="size-[17px] shrink-0" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search calls" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="flex size-[18px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white"><X className="size-3" strokeWidth={3} /></button>}
        </label>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {error && <p className="p-6 text-center text-[15px] text-[var(--ios-label2)]">{error}</p>}
        {!items && !error && <p className="p-6 text-center text-[15px] text-[var(--ios-gray)]">Loading…</p>}
        {items && items.length === 0 && (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-[var(--ios-gray6)] text-[var(--ios-gray)]"><Phone className="size-8" /></span>
            <p className="mt-3 text-[17px] font-semibold">{search ? 'No Results' : 'No Recents'}</p>
            {!search && <p className="mt-1 text-[15px] text-[var(--ios-label2)]">Open a chat and tap the phone button to call a colleague or a group.</p>}
          </div>
        )}
        <ul className="ios-list">
          {items?.map((c) => {
            const d = describe(c, chat.meId)
            const Icon = d.missed ? PhoneMissed : d.outgoing ? PhoneOutgoing : PhoneIncoming
            return (
              <li key={c.id} className="flex items-center gap-3 pl-4" data-testid="call-history-item">
                <span className="py-2">
                  {d.group ? (
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#5ac8fa] to-[#007aff] text-white"><Users className="size-5" /></span>
                  ) : (
                    <Avatar name={d.name} size={40} />
                  )}
                </span>
                <span className="ios-sep-top flex min-w-0 flex-1 items-center gap-1 self-stretch py-2 pr-2">
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-[17px] leading-[22px] md:text-[16px]', d.missed ? 'text-[var(--ios-red)]' : '')}>{d.name}</span>
                    <span className="flex items-center gap-1.5 text-[14px] text-[var(--ios-gray)]" title={fullTime(c.createdUtc)}>
                      <Icon className="size-3.5 shrink-0" aria-label={d.missed ? 'Missed' : d.outgoing ? 'Outgoing' : 'Incoming'} />
                      <span className="truncate">{d.what}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-[14px] text-[var(--ios-gray)]">{listTime(c.createdUtc)}</span>
                  {tasksOn && (
                    <button type="button" onClick={() => setFollowUp({ kind: 'call', callId: c.id, conversationId: c.conversationId, title: d.name })} aria-label={`Follow-up task for the call with ${d.name}`} title="Follow-up task" className="ios-icon-btn size-9" data-testid="call-follow-up">
                      <ListTodo className="size-[19px]" />
                    </button>
                  )}
                  {c.conversationId && (
                    <>
                      <button type="button" onClick={() => onOpenChat(c.conversationId!)} aria-label={`Open chat with ${d.name}`} title="Open chat" className="ios-icon-btn size-9">
                        <MessageSquare className="size-[19px]" />
                      </button>
                      <button type="button" onClick={() => calls.start(c.conversationId!)} disabled={!!calls.active} aria-label={`Call ${d.name} again`} title="Call again" className="ios-icon-btn size-9" data-testid="call-again">
                        <Phone className="size-[19px]" />
                      </button>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        {hasMore && (
          <div className="flex justify-center p-3">
            <button type="button" className="ios-btn-tinted" onClick={() => load(true)}>Load more</button>
          </div>
        )}
        <p className="px-4 pt-2 pb-4 text-center text-[12px] text-[var(--ios-gray)]">Calls are not recorded. Only who called whom, when and for how long is kept.</p>
      </div>
      {followUp && (
        <Suspense fallback={null}>
          <FollowUpSheet source={followUp} onClose={() => setFollowUp(null)} />
        </Suspense>
      )}
    </div>
  )
}
