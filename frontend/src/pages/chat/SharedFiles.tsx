import { useEffect, useMemo, useState } from 'react'
import { FileText, Image as ImageIcon, Search, ShieldAlert } from 'lucide-react'
import { chatApi, fileUrl, type ChatMessage } from '../../api/chat'
import { cn } from '../../lib/cn'
import { fileSize, listTime } from './chatUtils'

const isImage = (m: ChatMessage) => m.file?.category === 'IMAGE'

/**
 * Shared media and documents of one conversation (24 Nov 2026), in the info panel: a picture grid ("Media") and a file
 * list ("Files") with search, loaded page by page from the existing search (files only). A tap jumps to the message.
 */
export function SharedFiles({ conversationId, refreshKey, onJump }: { conversationId: string; refreshKey: unknown; onJump: (seq: number) => void }) {
  const [tab, setTab] = useState<'media' | 'files'>('media')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<ChatMessage[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [more, setMore] = useState(false)

  // First page (again when the search text settles or a new message arrives).
  useEffect(() => {
    let cancelled = false
    const t = window.setTimeout(() => {
      chatApi.search({ conversationId, files: true, ...(q.trim().length >= 2 ? { q: q.trim() } : {}) }).then(
        (r) => {
          if (cancelled) return
          setItems(r.items)
          setHasMore(r.hasMore)
        },
        () => !cancelled && (setItems([]), setHasMore(false)),
      )
    }, q ? 300 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [conversationId, refreshKey, q])

  const loadMore = async () => {
    if (!items?.length) return
    setMore(true)
    try {
      const r = await chatApi.search({ conversationId, files: true, beforeSeq: Math.min(...items.map((m) => m.seq)), ...(q.trim().length >= 2 ? { q: q.trim() } : {}) })
      setItems((list) => [...(list ?? []), ...r.items.filter((m) => !list?.some((x) => x.id === m.id))])
      setHasMore(r.hasMore)
    } finally {
      setMore(false)
    }
  }

  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () => (items ?? []).filter((m) => (tab === 'media' ? isImage(m) : !isImage(m)) && (!needle || (m.file?.name ?? '').toLowerCase().includes(needle) || (m.body ?? '').toLowerCase().includes(needle))),
    [items, tab, needle],
  )
  const counts = { media: (items ?? []).filter(isImage).length, files: (items ?? []).filter((m) => !isImage(m)).length }

  return (
    <section className="mx-4 mb-4 rounded-xl bg-white px-2 py-2" data-testid="shared-files">
      <div className="mb-2 flex items-center gap-1 rounded-lg bg-[var(--ios-fill)] p-0.5" role="tablist">
        {(['media', 'files'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn('flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[13px] font-semibold', tab === k ? 'bg-white text-[var(--ios-label)] shadow-sm' : 'text-[var(--ios-label2)]')}
            data-testid={`shared-tab-${k}`}
          >
            {k === 'media' ? <ImageIcon className="size-3.5" /> : <FileText className="size-3.5" />}
            {k === 'media' ? 'Media' : 'Files'}
            {items !== null && <span className="text-[11.5px] font-medium text-[var(--ios-gray)]">{counts[k]}{hasMore ? '+' : ''}</span>}
          </button>
        ))}
      </div>
      <label className="mb-2 flex h-8 items-center gap-1.5 rounded-lg bg-[var(--ios-fill)] px-2.5">
        <Search className="size-3.5 text-[var(--ios-gray)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'media' ? 'Search pictures' : 'Search documents'} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" aria-label="Search shared files" data-testid="shared-search" />
      </label>

      {items === null ? (
        <p className="px-2 py-2 text-[12.5px] text-ink-muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="px-2 py-2 text-[12.5px] text-ink-muted">{needle ? 'Nothing matches.' : tab === 'media' ? 'No pictures shared yet.' : 'No documents shared yet.'}</p>
      ) : tab === 'media' ? (
        <ul className="grid grid-cols-3 gap-1" data-testid="shared-media">
          {shown.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onJump(m.seq)} className="relative block aspect-square w-full overflow-hidden rounded-md bg-[var(--ios-gray6)]" title={`${m.file?.name} · ${m.senderName ?? ''}`}>
                {m.file && m.file.status === 'CLEAN' ? (
                  <img src={fileUrl(m.file.id, true)} alt={m.file.name} loading="lazy" className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-[var(--ios-gray)]"><ShieldAlert className="size-5" /></span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul data-testid="shared-documents">
          {shown.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => onJump(f.seq)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-muted">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-50 text-[10px] font-bold text-brand-700 uppercase">{f.file?.extension?.slice(0, 4) || <FileText className="size-4" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{f.file?.name}</span>
                  <span className="block text-[11.5px] text-ink-muted">{f.file ? fileSize(f.file.size) : ''} · {f.senderName} · {listTime(f.createdUtc)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && items !== null && (
        <button type="button" onClick={() => void loadMore()} disabled={more} className="mt-1 w-full rounded-md py-1.5 text-[12.5px] font-semibold text-[var(--ios-blue)] hover:bg-surface-muted" data-testid="shared-more">
          {more ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
