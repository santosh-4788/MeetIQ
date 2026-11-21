import { useState } from 'react'
import { Check, ListPlus } from 'lucide-react'
import { errorMessage } from '../../../api/types'
import { workApi } from '../../../api/work'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { Group } from './ui'

// Checklists inside notes (V033): plain text lines "- [ ] step" / "- [x] step", so the note stays readable anywhere
// (e-mail, copy & paste) and nothing new is stored. A line can be turned into a task linked to the note.

const LINE = /^(\s*)- \[([ xX])\]\s?(.*)$/

export function checklistOf(body: string | null | undefined) {
  let total = 0
  let done = 0
  for (const line of (body ?? '').split('\n')) {
    const m = line.match(LINE)
    if (!m) continue
    total++
    if (m[2] !== ' ') done++
  }
  return { total, done }
}

/** Adds "- [ ] " on a new line at the cursor (or at the end). */
export function insertChecklistLine(body: string, el: HTMLTextAreaElement | null) {
  const at = el ? el.selectionEnd : body.length
  const before = body.slice(0, at)
  const after = body.slice(at)
  const prefix = before.length && !before.endsWith('\n') ? '\n' : ''
  const next = `${before}${prefix}- [ ] ${after}`
  if (el) {
    const pos = before.length + prefix.length + 6
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }
  return next
}

/** Tick-able view of the note's checklist lines, with "make a task" per line. */
export function NoteChecklist({ body, setBody, noteId }: { body: string; setBody: (v: string) => void; noteId: string | null }) {
  const toast = useToast()
  const [made, setMade] = useState<Set<number>>(new Set())
  const lines = body.split('\n')
  const items = lines.map((l, i) => ({ i, m: l.match(LINE) })).filter((x) => x.m && x.m[3].trim())
  if (items.length === 0) return null
  const toggle = (i: number) => {
    const m = lines[i].match(LINE)!
    lines[i] = `${m[1]}- [${m[2] === ' ' ? 'x' : ' '}] ${m[3]}`
    setBody(lines.join('\n'))
  }
  const toTask = (i: number, text: string) =>
    workApi.createTask({ title: text.slice(0, 200), noteId }).then(
      () => (setMade((s) => new Set(s).add(i)), toast.success('Task created from the note')),
      (e) => toast.error(errorMessage(e, 'The task could not be created.')),
    )
  const done = items.filter((x) => x.m![2] !== ' ').length
  return (
    <Group title={`Checklist · ${done}/${items.length}`} footer={noteId ? 'Tap ⊕ to turn a line into a task.' : 'Save the note to turn lines into tasks.'}>
      <div className="px-4 pt-2 pb-1"><div className="h-1.5 overflow-hidden rounded-full bg-[var(--ios-gray5)]"><div className="h-full rounded-full bg-[var(--ios-green)] transition-all" style={{ width: `${(done / items.length) * 100}%` }} /></div></div>
      {items.map(({ i, m }) => {
        const on = m![2] !== ' '
        return (
          <div key={i} className="flex min-h-[42px] items-center gap-3 px-4" data-testid="note-check-item">
            <button type="button" role="checkbox" aria-checked={on} aria-label={m![3]} onClick={() => toggle(i)}
              className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-[6px]', on ? 'bg-[var(--ios-green)] text-white' : 'shadow-[inset_0_0_0_1.5px_var(--ios-gray3)]')} data-testid="note-check-tick">
              {on && <Check className="size-3.5" strokeWidth={3.4} />}
            </button>
            <span className={cn('min-w-0 flex-1 text-[16px]', on && 'text-[var(--ios-gray)] line-through')}>{m![3]}</span>
            {noteId && !on && (
              made.has(i)
                ? <span className="text-[12px] font-semibold text-[var(--ios-green)]">Task ✓</span>
                : <button type="button" onClick={() => void toTask(i, m![3].trim())} aria-label={`Make a task: ${m![3]}`} className="text-[var(--ios-blue)]" data-testid="note-line-task"><ListPlus className="size-[18px]" /></button>
            )}
          </div>
        )
      })}
    </Group>
  )
}

export const NOTE_COLORS = ['#FDE68A', '#BBF7D0', '#BFDBFE', '#FBCFE8', '#DDD6FE', '#FED7AA']

/** Small colour dots for a note (or none). */
export function ColorDots({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return (
    <span className="flex items-center gap-1.5" role="radiogroup" aria-label="Note colour">
      <button type="button" role="radio" aria-checked={!value} aria-label="No colour" onClick={() => onChange(null)}
        className={cn('size-[22px] rounded-full bg-white shadow-[inset_0_0_0_1.5px_var(--ios-gray4)]', !value && 'ring-2 ring-[var(--ios-blue)] ring-offset-1')} />
      {NOTE_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value?.toUpperCase() === c} aria-label={`Colour ${c}`} onClick={() => onChange(c)}
          className={cn('size-[22px] rounded-full', value?.toUpperCase() === c && 'ring-2 ring-[var(--ios-blue)] ring-offset-1')} style={{ background: c }} data-testid="note-color" />
      ))}
    </span>
  )
}
