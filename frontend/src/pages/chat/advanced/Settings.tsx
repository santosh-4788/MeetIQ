import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, AtSign, Check, Clock, Moon, Sun } from 'lucide-react'
import { chatApi, type ChatPreferences } from '../../../api/chat'
import { errorMessage } from '../../../api/types'
import { workApi, type Task } from '../../../api/work'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { parseUtc } from '../../../lib/format'
import { useChat } from '../ChatProvider'
import { IosSegmented } from '../IosSegmented'
import { isQuietNow } from '../quiet'
import { TaskEditor } from '../work/Editors'
import { CheckCircle, Group, PRIORITY, Row, Sheet, whenText } from '../work/ui'

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Quiet hours: when, which days, calls ring or stay silent, exceptions. Meeting reminders always come through. */
export function QuietHoursSheet({ onClose }: { onClose: () => void }) {
  const chat = useChat()
  const toast = useToast()
  const p = chat.preferences
  const [v, setV] = useState({
    quietEnabled: p?.quietEnabled ?? false,
    quietStart: p?.quietStart ?? '22:00',
    quietEnd: p?.quietEnd ?? '07:00',
    quietDays: p?.quietDays ?? 127,
    quietCallPolicy: p?.quietCallPolicy ?? 'SILENT',
    quietAllowMentions: p?.quietAllowMentions ?? true,
    quietAllowUrgent: p?.quietAllowUrgent ?? true,
  } as Required<Pick<ChatPreferences, 'quietEnabled' | 'quietStart' | 'quietEnd' | 'quietDays' | 'quietCallPolicy' | 'quietAllowMentions' | 'quietAllowUrgent'>>)
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      chat.setPreferences(await chatApi.preferences(v))
      toast.success(v.quietEnabled ? `Quiet hours ${v.quietStart}–${v.quietEnd}` : 'Quiet hours off')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e, 'Quiet hours could not be saved.'))
    } finally {
      setBusy(false)
    }
  }
  const nowQuiet = isQuietNow({ ...(p as ChatPreferences), ...v })
  return (
    <Sheet title="Quiet Hours" onClose={onClose} onDone={() => void save()} busy={busy} testId="quiet-sheet">
      <Group className="!mt-2">
        <Row label="Quiet hours" icon={<Moon className="size-4" />} tint="#5856d6">
          <input type="checkbox" role="switch" className="ios-switch" checked={v.quietEnabled} onChange={(e) => setV({ ...v, quietEnabled: e.target.checked })} aria-label="Quiet hours" data-testid="quiet-on" />
        </Row>
      </Group>
      {v.quietEnabled && (
        <>
          <Group title="Schedule" footer={nowQuiet ? 'Quiet hours are on now.' : `Times are in your profile time zone (${p?.timeZone ?? 'Asia/Kolkata'}).`}>
            <Row label="From" icon={<Moon className="size-4" />} tint="#5856d6">
              <input type="time" value={v.quietStart} onChange={(e) => setV({ ...v, quietStart: e.target.value })} className="w-[7rem] bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Quiet from" data-testid="quiet-start" />
            </Row>
            <Row label="To" icon={<Sun className="size-4" />} tint="var(--ios-orange)">
              <input type="time" value={v.quietEnd} onChange={(e) => setV({ ...v, quietEnd: e.target.value })} className="w-[7rem] bg-transparent text-right text-[16px] text-[var(--ios-blue)] outline-none" aria-label="Quiet until" data-testid="quiet-end" />
            </Row>
            <div className="flex justify-between gap-1 px-4 py-3" role="group" aria-label="Days">
              {DAYS.map((d, i) => {
                const on = ((v.quietDays >> i) & 1) === 1
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    aria-label={DAY_NAMES[i]}
                    onClick={() => setV({ ...v, quietDays: v.quietDays ^ (1 << i) })}
                    className={cn('flex size-10 items-center justify-center rounded-full text-[15px] font-semibold transition-colors', on ? 'bg-[#5856d6] text-white' : 'bg-[var(--ios-fill)] text-[var(--ios-label)]')}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </Group>
          <Group title="Calls during quiet hours">
            <div className="p-2">
              <IosSegmented label="Calls during quiet hours" value={v.quietCallPolicy} onChange={(x) => setV({ ...v, quietCallPolicy: x })} options={[{ key: 'SILENT', label: 'Show silently' }, { key: 'RING', label: 'Ring as usual' }]} />
            </div>
          </Group>
          <Group title="Allow" footer="Message sounds and browser alerts are held back during quiet hours. Popups, the bell and your messages are never lost. Meeting reminders always come through.">
            <Row label="@Mentions" icon={<AtSign className="size-4" />} tint="var(--ios-blue)">
              <input type="checkbox" role="switch" className="ios-switch" checked={v.quietAllowMentions} onChange={(e) => setV({ ...v, quietAllowMentions: e.target.checked })} aria-label="Allow mentions" />
            </Row>
            <Row label="Urgent task reminders" icon={<AlarmClock className="size-4" />} tint="var(--ios-red)">
              <input type="checkbox" role="switch" className="ios-switch" checked={v.quietAllowUrgent} onChange={(e) => setV({ ...v, quietAllowUrgent: e.target.checked })} aria-label="Allow urgent reminders" />
            </Row>
          </Group>
        </>
      )}
    </Sheet>
  )
}

type Panel = { overdue: Task[]; today: Task[]; week: Task[] }

/** Quick follow-up panel: overdue, due today and due this week, with one-tap complete or postpone. */
export function FollowUpPanel({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState<Panel | null>(null)
  const [editing, setEditing] = useState<Task | null>(null)
  const load = () => workApi.followupPanel().then(setData, () => setData({ overdue: [], today: [], week: [] }))
  useEffect(() => {
    void load()
  }, [])
  const done = (t: Task) =>
    workApi.setStatus(t.id, 'COMPLETED').then(
      (r) => {
        toast.success(r.next ? `Done. Next one: ${whenText(r.next.dueUtc, r.next.hasDueTime)}` : 'Done')
        void load()
      },
      (e) => toast.error(errorMessage(e, 'It could not be completed.')),
    )
  const postpone = (t: Task, days: number) => {
    const base = t.dueUtc ? parseUtc(t.dueUtc) : new Date()
    const now = new Date()
    const d = new Date(Math.max(base.getTime(), now.getTime()))
    d.setDate(d.getDate() + days)
    if (!t.hasDueTime) d.setHours(23, 59, 0, 0)
    return workApi.updateTask(t.id, { dueUtc: d.toISOString(), status: 'POSTPONED' }).then(
      () => {
        toast.success(`Moved to ${whenText(d.toISOString(), t.hasDueTime)}`)
        void load()
      },
      (e) => toast.error(errorMessage(e, 'It could not be postponed.')),
    )
  }
  const section = (title: string, items: Task[], color: string, testId: string) =>
    items.length > 0 && (
      <Group title={<span style={{ color }}>{title} · {items.length}</span>}>
        {items.map((t) => (
          <div key={t.id} className="flex items-start gap-3 px-4 py-2.5" data-testid={testId}>
            <span className="pt-0.5"><CheckCircle on={false} color={PRIORITY[t.priority].color} onClick={() => void done(t)} label={`Complete “${t.title}”`} /></span>
            <button type="button" onClick={() => setEditing(t)} className="min-w-0 flex-1 text-left">
              <span className="block text-[16px]">{t.title}</span>
              <span className={cn('block text-[13px]', t.isOverdue ? 'text-[var(--ios-red)]' : 'text-[var(--ios-gray)]')}>{t.dueUtc ? whenText(t.dueUtc, t.hasDueTime) : 'No date'}{t.message ? ` · ${t.message.senderName ?? 'message'}` : t.call ? ` · call` : ''}</span>
            </button>
            <span className="flex shrink-0 gap-1">
              <button type="button" className="ios-btn-tinted h-[30px] px-2.5 text-[13px]" onClick={() => void postpone(t, 1)} aria-label={`Postpone “${t.title}” to tomorrow`}>+1 day</button>
              <button type="button" className="ios-btn-tinted h-[30px] px-2.5 text-[13px]" onClick={() => void postpone(t, 7)} aria-label={`Postpone “${t.title}” by a week`}>+1 wk</button>
            </span>
          </div>
        ))}
      </Group>
    )
  const empty = data && data.overdue.length + data.today.length + data.week.length === 0
  return (
    <>
      <Sheet title="Follow-ups" onClose={onClose} leftLabel="Close" testId="followup-panel">
        {!data && <p className="py-8 text-center text-[15px] text-[var(--ios-gray)]">Loading…</p>}
        {empty && (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <Check className="size-10 text-[var(--ios-green)]" />
            <p className="mt-2 text-[17px] font-semibold">All caught up</p>
            <p className="mt-1 text-[15px] text-[var(--ios-label2)]">Nothing overdue or due this week.</p>
          </div>
        )}
        {data && section('Overdue', data.overdue, 'var(--ios-red)', 'fu-overdue')}
        {data && section('Today', data.today, 'var(--ios-blue)', 'fu-today')}
        {data && section('This week', data.week, 'var(--ios-label2)', 'fu-week')}
        <Group>
          <Row label="All tasks" icon={<Clock className="size-4" />} onClick={() => (onClose(), navigate('/chat?tab=tasks'))} />
        </Group>
      </Sheet>
      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} onSaved={() => void load()} onDeleted={() => void load()} />}
    </>
  )
}
