import { useEffect, useState } from 'react'
import { AtSign, Search, Star, X } from 'lucide-react'
import { advApi, type ChatMessage, type ChatPerson, type Conversation, type SavedItem } from '../../../api/chat'
import { errorMessage } from '../../../api/types'
import { Avatar } from '../../../components/ui/Avatar'
import { useToast } from '../../../components/ui/Toast'
import { listTime } from '../chatUtils'
import { PersonPicker } from '../work/Editors'
import { Group, Row, Sheet, fromLocalInput, toDateInput } from '../work/ui'

function excerpt(m: ChatMessage) {
  return m.deleted ? 'Message deleted' : m.body ?? (m.file ? `📎 ${m.file.name}` : '')
}

/** Saved (starred) messages across all my chats, with search; tap opens the message in its chat. */
export function SavedList({ onOpen }: { onOpen: (conversationId: string, seq: number) => void }) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<SavedItem[] | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => advApi.saved({ search: search.trim() || undefined }).then((r) => setItems(r.items), () => setItems([])), search ? 300 : 0)
    return () => window.clearTimeout(t)
  }, [search])
  return (
    <div className="ios-fade pb-3" data-testid="saved-list">
      <div className="px-4 pt-1 pb-2">
        <label className="ios-search">
          <Search className="size-[17px] shrink-0" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search saved messages" aria-label="Search saved messages" data-testid="saved-search" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="flex size-[18px] items-center justify-center rounded-full bg-[var(--ios-gray2)] text-white"><X className="size-3" strokeWidth={3} /></button>}
        </label>
      </div>
      {items === null && <p className="py-8 text-center text-[15px] text-[var(--ios-gray)]">Loading…</p>}
      {items?.length === 0 && (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <Star className="size-10 text-[var(--ios-gray2)]" />
          <p className="mt-2 text-[17px] font-semibold">{search ? 'No Results' : 'No Saved Messages'}</p>
          {!search && <p className="mt-1 text-[15px] text-[var(--ios-label2)]">Tap a message and choose Save to keep it here.</p>}
        </div>
      )}
      <ul className="ios-list">
        {items?.map((s) => (
          <li key={s.message.id} className="flex items-stretch pl-4">
            <button type="button" onClick={() => onOpen(s.conversationId, s.message.seq)} className="ios-pressable ios-sep-top flex min-w-0 flex-1 flex-col py-2.5 pr-2 text-left" data-testid="saved-item">
              <span className="flex justify-between gap-2 text-[13px] text-[var(--ios-gray)]">
                <span className="truncate font-semibold text-[var(--ios-label)]">{s.conversationTitle} · {s.message.senderName}</span>
                <span className="shrink-0">{listTime(s.message.createdUtc)}</span>
              </span>
              <span className="line-clamp-2 text-[15px] text-[var(--ios-label2)]">{excerpt(s.message)}</span>
            </button>
            <button
              type="button"
              aria-label="Remove from saved"
              onClick={() => advApi.save(s.message.id, false).then(() => setItems((l) => l?.filter((x) => x.message.id !== s.message.id) ?? l), (e) => toast.error(errorMessage(e, 'That did not work.')))}
              className="ios-sep-top flex items-center px-3 text-[var(--ios-orange)]"
            >
              <Star className="size-[18px] fill-current" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Recent messages that mention me. */
export function MentionsList({ onOpen }: { onOpen: (conversationId: string, seq: number) => void }) {
  const [items, setItems] = useState<(ChatMessage & { conversationTitle: string })[] | null>(null)
  useEffect(() => {
    advApi.mentions().then((r) => setItems(r.items), () => setItems([]))
  }, [])
  return (
    <div className="ios-fade pb-3" data-testid="mentions-list">
      {items === null && <p className="py-8 text-center text-[15px] text-[var(--ios-gray)]">Loading…</p>}
      {items?.length === 0 && (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <AtSign className="size-10 text-[var(--ios-gray2)]" />
          <p className="mt-2 text-[17px] font-semibold">No Mentions</p>
          <p className="mt-1 text-[15px] text-[var(--ios-label2)]">When someone writes @ and your name in a group, it shows here.</p>
        </div>
      )}
      <ul className="ios-list">
        {items?.map((m) => (
          <li key={m.id} className="pl-4">
            <button type="button" onClick={() => onOpen(m.conversationId, m.seq)} className="ios-pressable flex w-full items-center gap-3 text-left" data-testid="mention-item">
              <span className="py-2"><Avatar name={m.senderName ?? '?'} userId={m.senderId} size={40} /></span>
              <span className="ios-sep-top flex min-w-0 flex-1 flex-col self-stretch py-2.5 pr-4">
                <span className="flex justify-between gap-2 text-[13px] text-[var(--ios-gray)]">
                  <span className="truncate font-semibold text-[var(--ios-label)]">{m.senderName} · {m.conversationTitle}</span>
                  <span className="shrink-0">{listTime(m.createdUtc)}</span>
                </span>
                <span className="line-clamp-2 text-[15px] text-[var(--ios-label2)]">{excerpt(m)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export type SearchFilter = { sender: ChatPerson | null; conversationId: string | null; from: string | null; to: string | null; files: boolean }
export const NO_FILTER: SearchFilter = { sender: null, conversationId: null, from: null, to: null, files: false }
export const filterCount = (f: SearchFilter) => [f.sender, f.conversationId, f.from, f.to, f.files || null].filter(Boolean).length

/** Search filters: from a person, in a chat, date range, files only. */
export function SearchFiltersSheet({ value, conversations, onApply, onClose }: { value: SearchFilter; conversations: Conversation[]; onApply: (f: SearchFilter) => void; onClose: () => void }) {
  const [f, setF] = useState<SearchFilter>(value)
  const [picking, setPicking] = useState(false)
  return (
    <>
      <Sheet title="Filters" onClose={onClose} onDone={() => (onApply(f), onClose())} doneLabel="Apply" testId="search-filters">
        <Group className="!mt-2">
          <Row label="From" value={f.sender?.name ?? 'Anyone'} onClick={() => setPicking(true)} testId="filter-from" />
          <Row label="In chat">
            <select value={f.conversationId ?? ''} onChange={(e) => setF({ ...f, conversationId: e.target.value || null })} className="max-w-[60%] appearance-none bg-transparent text-right text-[16px] text-[var(--ios-gray)] outline-none" aria-label="In chat" data-testid="filter-chat">
              <option value="">All chats</option>
              {conversations.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Row>
        </Group>
        <Group title="Date">
          <Row label="From date">
            <input type="date" value={toDateInput(f.from)} onChange={(e) => setF({ ...f, from: e.target.value ? fromLocalInput(`${e.target.value}T00:00`) : null })} className="w-[9.5rem] bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="From date" data-testid="filter-date-from" />
          </Row>
          <Row label="To date">
            <input type="date" value={toDateInput(f.to)} onChange={(e) => setF({ ...f, to: e.target.value ? fromLocalInput(`${e.target.value}T23:59`) : null })} className="w-[9.5rem] bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="To date" data-testid="filter-date-to" />
          </Row>
        </Group>
        <Group>
          <Row label="Files only">
            <input type="checkbox" role="switch" className="ios-switch" checked={f.files} onChange={(e) => setF({ ...f, files: e.target.checked })} aria-label="Files only" data-testid="filter-files" />
          </Row>
          {filterCount(f) > 0 && <Row label="Clear filters" danger onClick={() => setF(NO_FILTER)} />}
        </Group>
        <p className="px-4 pt-1.5 text-[13px] text-[var(--ios-label2)]">Searches only the chats you are in.</p>
      </Sheet>
      {picking && <PersonPicker onClose={() => setPicking(false)} onPick={(p) => (setF({ ...f, sender: p }), setPicking(false))} />}
    </>
  )
}
