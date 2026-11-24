import { Fragment, type ReactNode } from 'react'
import { Users } from 'lucide-react'
import type { ChatMember } from '../../../api/chat'
import { Avatar } from '../../../components/ui/Avatar'
import { cn } from '../../../lib/cn'

/** The "@word" being typed just before the caret, or null. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before)
  return m ? { query: m[2], start: before.length - m[2].length - 1 } : null
}

export type MentionOption = { id: string; name: string; all?: boolean; designation?: string | null }

/** Members matching what is typed after "@" (and "@all" for group admins). */
export function mentionOptions(members: ChatMember[], query: string, canAll: boolean): MentionOption[] {
  const q = query.toLowerCase()
  const out: MentionOption[] = members
    .filter((m) => !m.me && (m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || m.name.toLowerCase().startsWith(q)))
    .slice(0, 6)
    .map((m) => ({ id: m.id, name: m.name, designation: m.designation }))
  if (canAll && 'all'.startsWith(q)) out.unshift({ id: 'all', name: 'all', all: true })
  return out
}

export function MentionPicker({ options, onPick, active }: { options: MentionOption[]; onPick: (o: MentionOption) => void; active: number }) {
  if (options.length === 0) return null
  return (
    <div className="ios-menu absolute inset-x-2 bottom-full z-30 mb-2 max-h-[45vh] overflow-y-auto sm:right-auto sm:w-80" role="listbox" aria-label="Mention someone" data-testid="mention-picker">
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(o)}
          className={cn('ios-menu-item !justify-start', i === active && 'bg-black/5')}
          data-testid="mention-option"
        >
          {o.all ? (
            <span className="flex size-8 items-center justify-center rounded-full bg-[var(--ios-blue)] text-white"><Users className="size-4" /></span>
          ) : (
            <Avatar name={o.name} userId={o.id} size={32} />
          )}
          <span className="min-w-0 text-left">
            <span className="block truncate text-[15px] font-medium">{o.all ? '@all' : o.name}</span>
            <span className="block truncate text-[12.5px] text-[var(--ios-label2)]">{o.all ? 'Notify everyone in this group' : o.designation ?? ''}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Highlights "@Name" (people mentioned) and "@all" inside a piece of message text. */
export function highlightMentions(text: string, names: string[], all: boolean, mine: boolean, meName: string | null): ReactNode {
  const tokens = [...names.map((n) => `@${n}`), ...(all ? ['@all'] : [])].filter(Boolean)
  if (tokens.length === 0) return text
  const re = new RegExp(`(${tokens.sort((a, b) => b.length - a.length).map(esc).join('|')})`, 'gi')
  return text.split(re).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
    const isMe = !!meName && (part.toLowerCase() === `@${meName.toLowerCase()}` || part.toLowerCase() === '@all')
    return (
      <span key={i} className={cn('font-semibold', mine ? 'text-white underline decoration-white/60 underline-offset-2' : isMe ? 'rounded bg-[var(--ios-orange)]/15 px-0.5 text-[#c45a00]' : 'text-[var(--ios-blue)]')} data-testid="chat-mention">
        {part}
      </span>
    )
  })
}
