import { useEffect, useState, type FormEvent } from 'react'
import { CalendarOff, Clock, Pencil, Plus, Trash2 } from 'lucide-react'
import { availabilityApi, type AvailabilityPeriod, type WorkingHours } from '../../api/meetings'
import { errorMessage, fieldErrors } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SelectField, Switch, TextAreaField } from '../../components/ui/Form'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { addDays, formatRange, formatYmd, parseUtc, zoneLabel, zonedParts, zonedToUtc } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'

// Monday first, as on the calendar. dayOfWeek: 0 = Sunday … 6 = Saturday (API).
const DAYS = [1, 2, 3, 4, 5, 6, 0]
const dayName = (d: number) => formatYmd(addDays('2026-01-04', d), { weekday: 'long' }) // 2026-01-04 is a Sunday

/** "09:30" → "9:30 am". */
function formatLocal(hm: string) {
  const [h, m] = hm.split(':').map(Number)
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 1, h, m)))
}

type Editing<T> = T | 'new' | null

/** Settings card: working hours per weekday and leave / blocked periods (GET/POST/PUT/DELETE /account/availability). */
export function AvailabilityCard() {
  const toast = useToast()
  const av = useLoader(() => availabilityApi.get(), [], 'Unable to load your availability.')
  const [hours, setHours] = useState<Editing<WorkingHours>>(null)
  const [period, setPeriod] = useState<Editing<AvailabilityPeriod>>(null)
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null)
  const data = av.data
  const tz = data?.timeZoneId ?? 'Asia/Kolkata'
  const now = Date.now()
  const upcoming = data?.periods.filter((p) => parseUtc(p.endUtc).getTime() > now) ?? []
  const past = data?.periods.filter((p) => parseUtc(p.endUtc).getTime() <= now) ?? []

  return (
    <Card>
      <CardHeader
        title="My availability"
        subtitle={`Working hours, leave and blocked time. Used for conflict checks when meetings are scheduled.${data ? ` Times in ${zoneLabel(tz)}.` : ''}`}
      />
      <div className="px-5 pb-5">
        {av.error ? (
          <ErrorState title="Unable to load your availability" description={av.error} onRetry={av.reload} />
        ) : !data ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading availability">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section aria-labelledby="wh-title">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 id="wh-title" className="text-[13.5px] font-semibold text-ink">Working hours</h3>
                <Button size="sm" variant="subtle" leftIcon={<Plus className="size-3.5" />} onClick={() => setHours('new')}>Add hours</Button>
              </div>
              {data.workingHours.length === 0 && (
                <p className="mb-2 text-[12.5px] text-ink-secondary">No working hours set, so no "outside working hours" warnings are shown for you.</p>
              )}
              <ul className="divide-y divide-line rounded-md border border-line">
                {DAYS.map((d) => {
                  const blocks = data.workingHours.filter((h) => h.dayOfWeek === d)
                  return (
                    <li key={d} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                      <span className="w-24 shrink-0 text-[13px] font-medium text-ink">{dayName(d)}</span>
                      {blocks.length === 0 ? (
                        <span className="text-[12.5px] text-ink-muted">Not working</span>
                      ) : (
                        <span className="flex flex-wrap gap-1.5">
                          {blocks.map((h) => (
                            <span key={h.id} className="inline-flex items-center gap-0.5 rounded-full bg-brand-50 py-0.5 pr-0.5 pl-2.5 text-[12px] font-semibold text-brand-700 tabular-nums">
                              {formatLocal(h.startLocalTime)} – {formatLocal(h.endLocalTime)}
                              <button type="button" onClick={() => setHours(h)} aria-label={`Edit ${dayName(d)} ${h.startLocalTime} to ${h.endLocalTime}`} className="flex size-6 items-center justify-center rounded-full hover:bg-brand-100">
                                <Pencil className="size-3" />
                              </button>
                              <button type="button" onClick={() => setDeleting({ id: h.id, label: `${dayName(d)}, ${formatLocal(h.startLocalTime)} – ${formatLocal(h.endLocalTime)}` })} aria-label={`Delete ${dayName(d)} ${h.startLocalTime} to ${h.endLocalTime}`} className="flex size-6 items-center justify-center rounded-full hover:bg-danger-soft hover:text-danger">
                                <Trash2 className="size-3" />
                              </button>
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>

            <section aria-labelledby="leave-title">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 id="leave-title" className="text-[13.5px] font-semibold text-ink">Leave and blocked time</h3>
                <Button size="sm" variant="subtle" leftIcon={<Plus className="size-3.5" />} onClick={() => setPeriod('new')}>Add</Button>
              </div>
              {upcoming.length === 0 && past.length === 0 ? (
                <div className="flex flex-col items-center rounded-md border border-dashed border-line px-4 py-6 text-center">
                  <CalendarOff className="size-5 text-ink-muted" aria-hidden />
                  <p className="mt-1.5 text-[12.5px] text-ink-secondary">No leave or blocked time. Add it so nobody books you while you are away.</p>
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {[...upcoming, ...past].map((p) => {
                    const done = parseUtc(p.endUtc).getTime() <= now
                    return (
                      <li key={p.id} className="flex items-start gap-3 rounded-md border border-line px-3 py-2.5">
                        <span className="mt-0.5 text-ink-muted">{p.type === 'LEAVE' ? <CalendarOff className="size-4" /> : <Clock className="size-4" />}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={p.type === 'LEAVE' ? 'warning' : 'neutral'}>{p.type === 'LEAVE' ? 'Leave' : 'Blocked'}</Badge>
                            {done && <Badge tone="neutral">Past</Badge>}
                          </div>
                          <p className="mt-1 text-[12.5px] text-ink tabular-nums">{periodText(p, tz)}</p>
                          {p.reason && <p className="truncate text-[12px] text-ink-secondary">{p.reason}</p>}
                        </div>
                        <div className="flex shrink-0">
                          <button type="button" onClick={() => setPeriod(p)} aria-label="Edit period" title="Edit" className="flex size-8 items-center justify-center rounded-sm text-ink-muted hover:bg-navy-900/5 hover:text-ink">
                            <Pencil className="size-3.5" />
                          </button>
                          <button type="button" onClick={() => setDeleting({ id: p.id, label: `${p.type === 'LEAVE' ? 'Leave' : 'Blocked time'}: ${periodText(p, tz)}` })} aria-label="Delete period" title="Delete" className="flex size-8 items-center justify-center rounded-sm text-ink-muted hover:bg-danger-soft hover:text-danger">
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="mt-2 text-[12px] text-ink-secondary">Periods that ended more than 30 days ago are not shown.</p>
            </section>
          </div>
        )}
      </div>

      <HoursDialog
        value={hours}
        onClose={(saved) => {
          setHours(null)
          if (saved) {
            toast.success('Working hours saved.')
            av.reload()
          }
        }}
      />
      <PeriodDialog
        value={period}
        tz={tz}
        onClose={(saved) => {
          setPeriod(null)
          if (saved) {
            toast.success('Saved.')
            av.reload()
          }
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this entry?"
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleting) return
          await availabilityApi.remove(deleting.id)
          toast.success('Deleted.')
          av.reload()
        }}
      >
        <p>{deleting?.label}</p>
      </ConfirmDialog>
    </Card>
  )
}

/** All-day periods (local midnight to midnight) read as dates only. */
function allDayRange(p: AvailabilityPeriod, tz: string) {
  const s = zonedParts(parseUtc(p.startUtc), tz)
  const e = zonedParts(parseUtc(p.endUtc), tz)
  return s.hm === '00:00' && e.hm === '00:00' ? { from: s.ymd, to: addDays(e.ymd, -1) } : null
}

function periodText(p: AvailabilityPeriod, tz: string) {
  const all = allDayRange(p, tz)
  if (all) {
    const f = (ymd: string) => formatYmd(ymd, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    return all.from === all.to ? `${f(all.from)} (all day)` : `${f(all.from)} – ${f(all.to)} (all day)`
  }
  return formatRange(p.startUtc, p.endUtc, tz)
}

function HoursDialog({ value, onClose }: { value: Editing<WorkingHours>; onClose: (saved?: boolean) => void }) {
  const editing = value && value !== 'new' ? value : null
  const [day, setDay] = useState(1)
  const [start, setStart] = useState('09:30')
  const [end, setEnd] = useState('18:30')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!value) return
    setDay(editing?.dayOfWeek ?? 1)
    setStart(editing?.startLocalTime ?? '09:30')
    setEnd(editing?.endLocalTime ?? '18:30')
    setErrors({})
    setError(null)
  }, [value, editing])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!start || !end || end <= start) {
      setErrors({ endLocalTime: 'Working hours must end after they start.' })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const body = { type: 'WORKING_HOURS' as const, dayOfWeek: day, startLocalTime: start, endLocalTime: end }
      if (editing) await availabilityApi.update(editing.id, body)
      else await availabilityApi.create(body)
      onClose(true)
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err, 'The working hours could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!value}
      onClose={() => onClose()}
      title={editing ? 'Edit working hours' : 'Add working hours'}
      description="Several blocks per day are allowed (e.g. a split shift)."
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose()} disabled={busy}>Cancel</Button>
          <Button type="submit" form="hours-form" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="hours-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <SelectField label="Day" value={String(day)} onChange={(e) => setDay(Number(e.target.value))} error={errors.dayOfWeek} data-autofocus>
          {DAYS.map((d) => <option key={d} value={d}>{dayName(d)}</option>)}
        </SelectField>
        <div className="grid grid-cols-2 gap-4">
          <TextField label="From" type="time" step={300} value={start} onChange={(e) => (setStart(e.target.value), setErrors({}))} error={errors.startLocalTime} />
          <TextField label="To" type="time" step={300} value={end} onChange={(e) => (setEnd(e.target.value), setErrors({}))} error={errors.endLocalTime} />
        </div>
      </form>
    </Dialog>
  )
}

function PeriodDialog({ value, tz, onClose }: { value: Editing<AvailabilityPeriod>; tz: string; onClose: (saved?: boolean) => void }) {
  const editing = value && value !== 'new' ? value : null
  const [type, setType] = useState<'LEAVE' | 'BLOCKED'>('LEAVE')
  const [allDay, setAllDay] = useState(true)
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('09:30')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('18:30')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!value) return
    setErrors({})
    setError(null)
    if (editing) {
      const all = allDayRange(editing, tz)
      const s = zonedParts(parseUtc(editing.startUtc), tz)
      const e = zonedParts(parseUtc(editing.endUtc), tz)
      setType(editing.type)
      setAllDay(!!all)
      setStartDate(all?.from ?? s.ymd)
      setEndDate(all?.to ?? e.ymd)
      setStartTime(all ? '09:30' : s.hm)
      setEndTime(all ? '18:30' : e.hm)
      setReason(editing.reason ?? '')
    } else {
      const today = zonedParts(new Date(), tz).ymd
      setType('LEAVE')
      setAllDay(true)
      setStartDate(today)
      setEndDate(today)
      setStartTime('09:30')
      setEndTime('18:30')
      setReason('')
    }
  }, [value, editing, tz])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v: Record<string, string> = {}
    if (!startDate) v.startUtc = 'Choose the start date.'
    if (!endDate) v.endUtc = 'Choose the end date.'
    if (!allDay && (!startTime || !endTime)) v.endUtc = 'Choose the start and end times.'
    let s: Date | null = null
    let en: Date | null = null
    if (!Object.keys(v).length) {
      s = zonedToUtc(startDate, allDay ? '00:00' : startTime, tz)
      en = allDay ? zonedToUtc(addDays(endDate, 1), '00:00', tz) : zonedToUtc(endDate, endTime, tz)
      if (en <= s) v.endUtc = 'The period must end after it starts.'
    }
    setErrors(v)
    if (Object.keys(v).length || !s || !en) return
    setBusy(true)
    setError(null)
    try {
      const body = { type, startUtc: s.toISOString(), endUtc: en.toISOString(), reason: reason.trim() || null }
      if (editing) await availabilityApi.update(editing.id, body)
      else await availabilityApi.create(body)
      onClose(true)
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err, 'The period could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!value}
      onClose={() => onClose()}
      title={editing ? 'Edit leave or blocked time' : 'Add leave or blocked time'}
      description={`Nobody can book you during this time without an override. Times in ${zoneLabel(tz)}.`}
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose()} disabled={busy}>Cancel</Button>
          <Button type="submit" form="period-form" loading={busy}>Save</Button>
        </>
      }
    >
      <form id="period-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <SelectField label="Type" value={type} onChange={(e) => setType(e.target.value as 'LEAVE' | 'BLOCKED')} error={errors.type} data-autofocus>
          <option value="LEAVE">Leave</option>
          <option value="BLOCKED">Blocked time (busy)</option>
        </SelectField>
        <Switch checked={allDay} onChange={setAllDay} label="All day" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label={allDay ? 'From date' : 'Start date'} type="date" value={startDate} onChange={(e) => (setStartDate(e.target.value), setErrors({}))} error={errors.startUtc} />
          {!allDay && <TextField label="Start time" type="time" step={300} value={startTime} onChange={(e) => (setStartTime(e.target.value), setErrors({}))} />}
          <TextField label={allDay ? 'To date (inclusive)' : 'End date'} type="date" value={endDate} onChange={(e) => (setEndDate(e.target.value), setErrors({}))} error={errors.endUtc} />
          {!allDay && <TextField label="End time" type="time" step={300} value={endTime} onChange={(e) => (setEndTime(e.target.value), setErrors({}))} />}
        </div>
        <TextAreaField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} maxLength={400} rows={2} hint="Only you see the reason. Others see “On leave” or “Busy”." />
      </form>
    </Dialog>
  )
}
