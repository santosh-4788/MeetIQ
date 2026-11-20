import { useEffect, useState } from 'react'
import { CalendarClock, Clock, Trash2 } from 'lucide-react'
import { advApi, type ScheduledMessage } from '../../../api/chat'
import { errorMessage } from '../../../api/types'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { parseUtc } from '../../../lib/format'
import { useChat } from '../ChatProvider'
import { Group, Row, Sheet, fromLocalInput, toLocalInput, whenText } from '../work/ui'

function at(day: number, h: number) {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + day, h, 0, 0)
}
function nextMonday9() {
  const n = new Date()
  const add = ((8 - n.getDay()) % 7) || 7
  return at(add, 9)
}
const QUICK: { label: string; when: () => Date }[] = [
  { label: 'In 1 hour', when: () => new Date(Date.now() + 60 * 60_000) },
  { label: 'This evening, 6:00 pm', when: () => at(0, 18) },
  { label: 'Tomorrow, 9:00 am', when: () => at(1, 9) },
  { label: 'Monday, 9:00 am', when: () => nextMonday9() },
]

/** Schedule a message (new) or change one (edit): text + an iOS-style time choice. */
export function ScheduleSheet({ conversationId, initialText = '', item, replyToId, onClose, onSaved }: {
  conversationId: string
  initialText?: string
  item?: ScheduledMessage | null
  replyToId?: string | null
  onClose: () => void
  onSaved: (s: ScheduledMessage) => void
}) {
  const toast = useToast()
  const [text, setText] = useState(item?.body ?? initialText)
  const [when, setWhen] = useState<string>(item ? toLocalInput(item.sendAtUtc) : toLocalInput(at(1, 9).toISOString()))
  const [busy, setBusy] = useState(false)
  const sendAt = when ? new Date(when) : null
  const tooSoon = !sendAt || sendAt.getTime() < Date.now() + 60_000
  async function save() {
    if (!text.trim() || tooSoon) return
    setBusy(true)
    try {
      const iso = fromLocalInput(when)!
      const saved = item ? await advApi.updateScheduled(item.id, { body: text.trim(), sendAtUtc: iso }) : await advApi.schedule(conversationId, text.trim(), iso, replyToId)
      onSaved(saved)
      toast.success(`Scheduled for ${whenText(iso)}`)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e, 'The message could not be scheduled.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={item ? 'Scheduled Message' : 'Schedule Message'} onClose={onClose} onDone={() => void save()} doneLabel={item ? 'Save' : 'Schedule'} doneDisabled={!text.trim() || tooSoon} busy={busy} testId="schedule-sheet">
      <Group className="!mt-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={4} placeholder="Message" aria-label="Message to schedule" className="ios-field resize-none" autoFocus={!text} data-testid="schedule-text" />
      </Group>
      <Group title="Send">
        {QUICK.map((q) => {
          const d = q.when()
          const on = when === toLocalInput(d.toISOString())
          return (
            <Row key={q.label} label={q.label} onClick={() => setWhen(toLocalInput(d.toISOString()))} icon={<Clock className="size-4" />} tint={on ? 'var(--ios-blue)' : 'var(--ios-gray)'}>
              {on && <span className="text-[17px] text-[var(--ios-blue)]">✓</span>}
            </Row>
          )
        })}
        <Row label="Date and time" icon={<CalendarClock className="size-4" />} tint="var(--ios-orange)">
          <input type="datetime-local" value={when} min={toLocalInput(new Date(Date.now() + 60_000).toISOString())} onChange={(e) => setWhen(e.target.value)} className="w-[12.5rem] min-w-0 bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Send at" data-testid="schedule-at" />
        </Row>
      </Group>
      <p className={cn('px-4 pt-1.5 text-[13px]', tooSoon ? 'text-[var(--ios-red)]' : 'text-[var(--ios-label2)]')}>
        {tooSoon ? 'Choose a time at least a minute from now.' : `Sends ${whenText(fromLocalInput(when))}, even if you are offline. You can change or cancel it until then.`}
      </p>
    </Sheet>
  )
}

/** The scheduled messages of one chat (or all chats): change the time or text, or cancel. */
export function ScheduledListSheet({ conversationId, onClose, onChanged }: { conversationId?: string; onClose: () => void; onChanged?: () => void }) {
  const chat = useChat()
  const toast = useToast()
  const [items, setItems] = useState<ScheduledMessage[] | null>(null)
  const [editing, setEditing] = useState<ScheduledMessage | null>(null)
  const load = () => advApi.scheduled({ conversationId }).then((r) => setItems(r.items), () => setItems([]))
  useEffect(() => {
    void load()
    return chat.on('scheduled.updated', () => void load())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, chat])
  return (
    <>
      <Sheet title="Scheduled" onClose={onClose} leftLabel="Close" testId="scheduled-list">
        {items === null && <p className="px-4 py-6 text-center text-[15px] text-[var(--ios-gray)]">Loading…</p>}
        {items?.length === 0 && <p className="px-4 py-10 text-center text-[15px] text-[var(--ios-gray)]">No scheduled messages.</p>}
        {items && items.length > 0 && (
          <Group className="!mt-2">
            {items.map((s) => (
              <div key={s.id} className="flex items-start gap-3 px-4 py-3" data-testid="scheduled-item">
                <Clock className="mt-0.5 size-5 shrink-0 text-[var(--ios-blue)]" />
                <button type="button" onClick={() => setEditing(s)} className="min-w-0 flex-1 text-left">
                  <span className="block text-[13px] font-semibold text-[var(--ios-blue)]">{whenText(s.sendAtUtc)}{conversationId ? '' : ` · ${s.conversationTitle}`}</span>
                  <span className="line-clamp-3 text-[16px]">{s.body}</span>
                </button>
                <button
                  type="button"
                  aria-label="Cancel scheduled message"
                  onClick={() =>
                    advApi.cancelScheduled(s.id).then(
                      () => {
                        setItems((l) => l?.filter((x) => x.id !== s.id) ?? l)
                        onChanged?.()
                        toast.success('Scheduled message cancelled')
                      },
                      (e) => toast.error(errorMessage(e, 'It could not be cancelled.')),
                    )
                  }
                  className="ios-icon-btn size-9 text-[var(--ios-red)]"
                  data-testid="scheduled-cancel"
                >
                  <Trash2 className="size-[18px]" />
                </button>
              </div>
            ))}
          </Group>
        )}
      </Sheet>
      {editing && (
        <ScheduleSheet
          conversationId={editing.conversationId}
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            setItems((l) => l?.map((x) => (x.id === s.id ? s : x)) ?? l)
            onChanged?.()
          }}
        />
      )}
    </>
  )
}

export const scheduledSoon = (s: ScheduledMessage) => parseUtc(s.sendAtUtc).getTime() - Date.now() < 60 * 60_000
