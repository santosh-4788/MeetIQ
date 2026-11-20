import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Camera, Check, Crown, FileText, LogOut, Pencil, Search, ShieldMinus, ShieldPlus, Trash2, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { chatApi, fileUrl, uploadFile, type ChatMember, type ChatMessage, type ChatPerson, type Conversation, type Presence } from '../../api/chat'
import { errorMessage } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { fileSize, listTime, presenceColor, presenceLabel, presenceText } from './chatUtils'

export function PresenceDot({ presence, className }: { presence: Presence | null | undefined; className?: string }) {
  if (!presence) return null
  return (
    <span
      className={cn('block size-3 rounded-full ring-2 ring-surface', presenceColor[presence.state], className)}
      title={presenceLabel[presence.state]}
      aria-label={presenceLabel[presence.state]}
      role="img"
    />
  )
}

export function ConversationAvatar({ c, size = 44 }: { c: Pick<Conversation, 'type' | 'name' | 'imageId' | 'other'>; size?: number }) {
  if (c.type === 'GROUP')
    return c.imageId ? (
      <span className="inline-flex shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
        <img src={fileUrl(c.imageId, true)} alt="" className="size-full object-cover" />
      </span>
    ) : (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#5ac8fa] to-[#007aff] text-white" style={{ width: size, height: size }}>
        <Users style={{ width: size * 0.45, height: size * 0.45 }} aria-hidden />
      </span>
    )
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={c.name || '?'} size={size} />
      <PresenceDot presence={c.other?.presence} className="absolute right-0 bottom-0" />
    </span>
  )
}

/** Debounced colleague search (name, code, department, designation). */
export function usePeopleSearch(term: string, enabled = true) {
  const [people, setPeople] = useState<ChatPerson[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    const t = window.setTimeout(() => {
      chatApi.people(term.trim()).then(
        (p) => !cancelled && setPeople(p),
        () => !cancelled && setPeople([]),
      ).finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [term, enabled])
  return { people, loading }
}

function PersonRow({ p, onClick, selected, right }: { p: ChatPerson; onClick: () => void; selected?: boolean; right?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-muted', selected && 'bg-brand-50')}
      data-testid="chat-person"
    >
      <span className="relative">
        <Avatar name={p.name} size={36} />
        <PresenceDot presence={p.presence} className="absolute -right-0.5 -bottom-0.5 size-2.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
        <span className="block truncate text-[12px] text-ink-muted">{[p.code, p.designation, p.department].filter(Boolean).join(' · ')}</span>
      </span>
      {right ?? (selected && <Check className="size-4 text-brand-600" />)}
    </button>
  )
}

function SearchBox({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 text-ink-muted focus-within:border-brand-500 focus-within:shadow-focus">
      <Search className="size-4 shrink-0" aria-hidden />
      <input autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none" />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear" className="text-ink-muted hover:text-ink">
          <X className="size-4" />
        </button>
      )}
    </label>
  )
}

export function NewChatDialog({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (c: Conversation) => void }) {
  const [term, setTerm] = useState('')
  const { people, loading } = usePeopleSearch(term, open)
  const toast = useToast()
  useEffect(() => {
    if (open) setTerm('')
  }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="New chat" description="Search a colleague by name, employee code, department or designation." size="md">
      <SearchBox value={term} onChange={setTerm} placeholder="Search colleagues" autoFocus />
      <div className="mt-3 max-h-[52vh] min-h-[200px] overflow-y-auto scrollbar-thin" aria-busy={loading}>
        {people.map((p) => (
          <PersonRow
            key={p.id}
            p={p}
            onClick={() =>
              chatApi.direct(p.id).then(
                (c) => {
                  onStarted(c)
                  onClose()
                },
                (e) => toast.error(errorMessage(e, 'The chat could not be opened.')),
              )
            }
          />
        ))}
        {!loading && people.length === 0 && <p className="py-10 text-center text-[13px] text-ink-muted">No colleagues found.</p>}
      </div>
    </Dialog>
  )
}

/** Picks several colleagues (chips + search). */
function PeoplePicker({ selected, onChange, exclude = [], max }: { selected: ChatPerson[]; onChange: (p: ChatPerson[]) => void; exclude?: string[]; max: number }) {
  const [term, setTerm] = useState('')
  const { people, loading } = usePeopleSearch(term)
  const ids = new Set(selected.map((s) => s.id))
  const toggle = (p: ChatPerson) => (ids.has(p.id) ? onChange(selected.filter((s) => s.id !== p.id)) : selected.length < max && onChange([...selected, p]))
  return (
    <div>
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 py-1 pr-1.5 pl-2.5 text-[12.5px] font-medium text-brand-700">
              {s.name}
              <button type="button" onClick={() => toggle(s)} aria-label={`Remove ${s.name}`} className="rounded-full p-0.5 hover:bg-brand-100">
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchBox value={term} onChange={setTerm} placeholder="Search colleagues to add" />
      <div className="mt-2 max-h-[36vh] min-h-[160px] overflow-y-auto scrollbar-thin" aria-busy={loading}>
        {people.filter((p) => !exclude.includes(p.id)).map((p) => (
          <PersonRow key={p.id} p={p} selected={ids.has(p.id)} onClick={() => toggle(p)} />
        ))}
        {!loading && people.length === 0 && <p className="py-8 text-center text-[13px] text-ink-muted">No colleagues found.</p>}
      </div>
    </div>
  )
}

export function NewGroupDialog({ open, onClose, onCreated, maxMembers }: { open: boolean; onClose: () => void; onCreated: (c: Conversation) => void; maxMembers: number }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [members, setMembers] = useState<ChatPerson[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
      setMembers([])
      setError(null)
    }
  }, [open])
  async function create() {
    setBusy(true)
    setError(null)
    try {
      const c = await chatApi.createGroup(name.trim(), description.trim(), members.map((m) => m.id))
      onCreated(c)
      onClose()
    } catch (e) {
      setError(errorMessage(e, 'The group could not be created.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New group"
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={create} loading={busy} disabled={!name.trim() || members.length === 0} data-testid="group-create">Create group</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Group name
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="h-10 rounded-md border border-line px-3 text-[14px] font-normal outline-none focus:border-brand-500 focus:shadow-focus" data-testid="group-name" />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
          Description <span className="font-normal text-ink-muted">(optional)</span>
          <textarea value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} className="resize-none rounded-md border border-line px-3 py-2 text-[14px] font-normal outline-none focus:border-brand-500 focus:shadow-focus" />
        </label>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">Members <span className="font-normal text-ink-muted">({members.length} selected)</span></p>
          <PeoplePicker selected={members} onChange={setMembers} max={maxMembers - 1} />
        </div>
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      </div>
    </Dialog>
  )
}

export function ForwardDialog({ message, conversations, onClose }: { message: ChatMessage | null; conversations: Conversation[]; onClose: () => void }) {
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  useEffect(() => {
    if (message) {
      setTerm('')
      setPicked([])
    }
  }, [message])
  const list = conversations.filter((c) => !c.archived || picked.includes(c.id)).filter((c) => c.name.toLowerCase().includes(term.trim().toLowerCase()))
  async function send() {
    if (!message) return
    setBusy(true)
    try {
      await chatApi.forward(message.id, picked)
      toast.success(picked.length === 1 ? 'Forwarded' : `Forwarded to ${picked.length} chats`)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e, 'The message could not be forwarded.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!message}
      onClose={onClose}
      title="Forward to…"
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={send} loading={busy} disabled={picked.length === 0} data-testid="forward-send">Forward{picked.length > 1 ? ` (${picked.length})` : ''}</Button>
        </>
      }
    >
      <SearchBox value={term} onChange={setTerm} placeholder="Search chats" autoFocus />
      <div className="mt-2 max-h-[46vh] overflow-y-auto scrollbar-thin">
        {list.map((c) => {
          const on = picked.includes(c.id)
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setPicked(on ? picked.filter((x) => x !== c.id) : picked.length < 10 ? [...picked, c.id] : picked)}
              className={cn('flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-muted', on && 'bg-brand-50')}
            >
              <ConversationAvatar c={c} size={34} />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{c.name}</span>
              {on && <Check className="size-4 text-brand-600" />}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[12px] text-ink-muted">Up to 10 chats. The message is marked "Forwarded".</p>
    </Dialog>
  )
}

/** Right-hand panel: the person, or the group (details, picture, members, roles, files, leave). */
export function InfoPanel({
  conversation,
  members,
  onClose,
  onChanged,
  onOpenDirect,
  onJump,
  maxMembers,
}: {
  conversation: Conversation
  members: ChatMember[]
  onClose: () => void
  onChanged: () => void
  onOpenDirect: (userId: string) => void
  onJump: (seq: number) => void
  maxMembers: number
}) {
  const toast = useToast()
  const isGroup = conversation.type === 'GROUP'
  const admin = isGroup && conversation.role === 'ADMIN'
  const me = members.find((m) => m.me)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(conversation.name)
  const [description, setDescription] = useState(conversation.description ?? '')
  const [adding, setAdding] = useState(false)
  const [toAdd, setToAdd] = useState<ChatPerson[]>([])
  const [confirm, setConfirm] = useState<{ kind: 'remove' | 'leave'; member?: ChatMember } | null>(null)
  const [files, setFiles] = useState<ChatMessage[] | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const other = conversation.other

  useEffect(() => {
    setName(conversation.name)
    setDescription(conversation.description ?? '')
  }, [conversation.name, conversation.description])
  useEffect(() => {
    let cancelled = false
    chatApi.search({ conversationId: conversation.id, files: true }).then((r) => !cancelled && setFiles(r.items), () => !cancelled && setFiles([]))
    return () => {
      cancelled = true
    }
  }, [conversation.id, conversation.lastMessage?.seq])

  const sorted = useMemo(() => [...members].sort((a, b) => (a.me ? -1 : b.me ? 1 : 0)), [members])
  const act = (p: Promise<unknown>, ok?: string) =>
    p.then(
      () => {
        if (ok) toast.success(ok)
        onChanged()
      },
      (e) => toast.error(errorMessage(e, 'That did not work. Please try again.')),
    )

  return (
    <aside className="ios flex h-full w-full flex-col bg-[var(--ios-gray6)]" aria-label={isGroup ? 'Group info' : 'Contact info'} data-testid="chat-info">
      <div className="ios-bar ios-hairline-b flex h-[60px] shrink-0 items-center gap-2 px-4">
        <p className="flex-1 text-[17px] font-semibold">{isGroup ? 'Group info' : 'Contact info'}</p>
        <button type="button" onClick={onClose} aria-label="Close info" className="flex size-9 items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted hover:text-ink">
          <X className="size-5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="flex flex-col items-center gap-2 px-5 pt-6 pb-5 text-center">
          <div className="relative">
            <ConversationAvatar c={conversation} size={88} />
            {admin && (
              <>
                <button
                  type="button"
                  onClick={() => imageInput.current?.click()}
                  aria-label="Change group picture"
                  className="absolute -right-1 -bottom-1 flex size-8 items-center justify-center rounded-full bg-brand-500 text-white shadow ring-2 ring-surface hover:bg-brand-700"
                >
                  <Camera className="size-4" />
                </button>
                <input
                  ref={imageInput}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (f) act(uploadFile(`/chat/conversations/${conversation.id}/image`, f, {}), 'Group picture updated. It shows after the antivirus check.')
                  }}
                />
              </>
            )}
          </div>
          {editing ? (
            <div className="flex w-full flex-col gap-2">
              <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Group name" className="h-9 rounded-md border border-line px-3 text-[14px] outline-none focus:border-brand-500" />
              <textarea value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} aria-label="Description" className="resize-none rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus:border-brand-500" />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
                <Button size="sm" disabled={!name.trim()} onClick={() => act(chatApi.updateGroup(conversation.id, name.trim(), description.trim()), 'Group updated').then(() => setEditing(false))}>Save</Button>
              </div>
            </div>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-[17px] font-semibold text-ink">
                {conversation.name}
                {admin && (
                  <button type="button" onClick={() => setEditing(true)} aria-label="Edit group name and description" className="text-ink-muted hover:text-brand-600">
                    <Pencil className="size-4" />
                  </button>
                )}
              </p>
              {isGroup ? (
                <p className="text-[12.5px] text-ink-muted">Group · {conversation.memberCount} members</p>
              ) : (
                <p className="text-[12.5px] text-ink-muted">{presenceText(other?.presence)}</p>
              )}
              {isGroup && conversation.description && <p className="mt-1 text-[13px] whitespace-pre-wrap text-ink-secondary">{conversation.description}</p>}
              {!isGroup && other && (
                <dl className="mt-2 w-full rounded-md bg-surface-muted p-3 text-left text-[13px]">
                  {[['Employee code', other.code], ['Designation', other.designation], ['Department', other.department]].map(([k, v]) =>
                    v ? (
                      <div key={k} className="flex justify-between gap-3 py-0.5">
                        <dt className="text-ink-muted">{k}</dt>
                        <dd className="text-right font-medium text-ink">{v}</dd>
                      </div>
                    ) : null,
                  )}
                </dl>
              )}
            </>
          )}
        </div>

        {isGroup && (
          <section className="mx-4 mb-4 rounded-xl bg-white px-2 py-2">
            <div className="mb-1 flex items-center justify-between px-2">
              <p className="text-[13px] tracking-[0.01em] text-[var(--ios-label2)] uppercase">{members.length} members</p>
              {admin && (
                <button type="button" onClick={() => (setToAdd([]), setAdding(true))} className="inline-flex items-center gap-1 text-[15px] text-[var(--ios-blue)]" data-testid="group-add-members">
                  <UserPlus className="size-4" /> Add
                </button>
              )}
            </div>
            <ul>
              {sorted.map((m) => (
                <li key={m.id} className="group/m flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-muted">
                  <button type="button" className="relative" onClick={() => !m.me && onOpenDirect(m.id)} aria-label={m.me ? 'You' : `Message ${m.name}`}>
                    <Avatar name={m.name} size={34} />
                    <PresenceDot presence={m.presence} className="absolute -right-0.5 -bottom-0.5 size-2.5" />
                  </button>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate text-[13.5px] font-semibold text-ink">
                      {m.me ? 'You' : m.name}
                      {m.role === 'ADMIN' && <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-50 px-1.5 py-px text-[10.5px] font-semibold text-brand-700"><Crown className="size-3" /> Admin</span>}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-muted">{presenceText(m.presence) || m.designation}</span>
                  </span>
                  {admin && !m.me && (
                    <span className="flex gap-0.5 opacity-100 sm:opacity-0 sm:group-hover/m:opacity-100 sm:focus-within:opacity-100">
                      <button
                        type="button"
                        title={m.role === 'ADMIN' ? 'Remove as admin' : 'Make admin'}
                        aria-label={m.role === 'ADMIN' ? `Remove ${m.name} as admin` : `Make ${m.name} an admin`}
                        onClick={() => act(chatApi.setRole(conversation.id, m.id, m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'))}
                        className="flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface hover:text-brand-600"
                      >
                        {m.role === 'ADMIN' ? <ShieldMinus className="size-4" /> : <ShieldPlus className="size-4" />}
                      </button>
                      <button type="button" title="Remove" aria-label={`Remove ${m.name}`} onClick={() => setConfirm({ kind: 'remove', member: m })} className="flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface hover:text-danger">
                        <UserMinus className="size-4" />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mx-4 mb-4 rounded-xl bg-white px-2 py-2">
          <p className="mb-1 px-2 text-[13px] tracking-[0.01em] text-[var(--ios-label2)] uppercase">Files</p>
          {files === null ? (
            <p className="px-2 py-2 text-[12.5px] text-ink-muted">Loading…</p>
          ) : files.length === 0 ? (
            <p className="px-2 py-2 text-[12.5px] text-ink-muted">No files shared yet.</p>
          ) : (
            <ul>
              {files.slice(0, 12).map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => onJump(f.seq)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-muted">
                    <FileText className="size-4 shrink-0 text-brand-600" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{f.file?.name}</span>
                      <span className="block text-[11.5px] text-ink-muted">{f.file ? fileSize(f.file.size) : ''} · {f.senderName} · {listTime(f.createdUtc)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {isGroup && me && (
          <section className="border-t border-line p-3">
            {admin && conversation.imageId && (
              <button type="button" onClick={() => act(chatApi.removeImage(conversation.id))} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[13.5px] text-ink-secondary hover:bg-surface-muted">
                <Trash2 className="size-4" /> Remove group picture
              </button>
            )}
            <button type="button" onClick={() => setConfirm({ kind: 'leave' })} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[13.5px] font-semibold text-danger hover:bg-danger/5" data-testid="group-leave">
              <LogOut className="size-4" /> Leave group
            </button>
          </section>
        )}
      </div>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add people"
        description="They will see messages from now on, not the earlier history."
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
            <Button disabled={toAdd.length === 0} onClick={() => act(chatApi.addMembers(conversation.id, toAdd.map((p) => p.id)), 'Added').then(() => setAdding(false))} data-testid="group-add-confirm">
              Add {toAdd.length || ''}
            </Button>
          </>
        }
      >
        <PeoplePicker selected={toAdd} onChange={setToAdd} exclude={members.map((m) => m.id)} max={Math.max(0, maxMembers - members.length)} />
      </Dialog>
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'leave' ? 'Leave this group?' : `Remove ${confirm?.member?.name}?`}
        confirmLabel={confirm?.kind === 'leave' ? 'Leave group' : 'Remove'}
        onConfirm={async () => {
          if (confirm?.kind === 'leave' && me) await chatApi.removeMember(conversation.id, me.id)
          else if (confirm?.member) await chatApi.removeMember(conversation.id, confirm.member.id)
          onChanged()
        }}
      >
        <p className="text-[13.5px] text-ink-secondary">
          {confirm?.kind === 'leave'
            ? 'You will no longer receive messages from this group or see its history.'
            : 'They will no longer receive messages from this group or see its history.'}
        </p>
      </ConfirmDialog>
    </aside>
  )
}
