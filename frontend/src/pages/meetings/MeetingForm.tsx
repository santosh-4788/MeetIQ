import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CalendarCheck, CircleCheck, Info, LoaderCircle, Save, Trash2, TriangleAlert, UserPlus, X } from 'lucide-react'
import {
  bookingConflicts, meetingsApi, type Conflict, type DbMeetingCategory, type GuestInput, type MeetingCreateInput, type MeetingDetail,
  type MeetingUpdateInput, type RecordingPolicy,
} from '../../api/meetings'
import { errorMessage, fieldErrors } from '../../api/types'
import { http } from '../../api/http'
import { useAuth } from '../../auth/AuthContext'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Avatar } from '../../components/ui/Avatar'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { PageHeader } from '../../components/ui/Data'
import { Alert, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SelectField, Switch, TextAreaField } from '../../components/ui/Form'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { addDays, formatDuration, formatRange, parseUtc, zoneLabel, zonedParts, zonedToUtc } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { CustomerDialog } from '../customers/CustomerDialog'
import { CustomerPicker, type PickedCustomer } from '../customers/CustomerPicker'
import { ConflictDialog, ConflictList } from './Conflicts'
import { CUSTOMER_CATEGORIES, INTERNAL_CATEGORIES, conflictLabel, dbCategoryLabel, isCustomerCategory, useTimeZone } from './meta'
import { useAvailability, type AvailabilityState } from './useAvailability'

/** Whether a meeting category can be recorded (GET /meetings/recording-options). */
type RecordingOption = { category: string; policyCode: string; policyTitle: string; enabled: boolean; requirement: string }

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480]
const MAX_GUESTS = 20
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

type Form = {
  title: string
  category: DbMeetingCategory | ''
  date: string
  time: string
  duration: number
  agenda: string
  description: string
  recordingPolicy: RecordingPolicy
  waitingRoom: boolean
  purpose: string
  policyNumber: string
}

type GuestRow = GuestInput & { key: number }

/** Next half hour at least 15 minutes ahead, in the user's zone. */
function defaultStart(tz: string) {
  const t = new Date(Date.now() + 15 * 60_000)
  const p = zonedParts(t, tz)
  const slot = Math.ceil(p.minutes / 30) * 30
  if (slot >= 24 * 60) return { date: addDays(p.ymd, 1), time: '09:00' }
  return { date: p.ymd, time: `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}` }
}

/** Start / end as UTC ISO strings, or null while the date or time is incomplete. */
function toUtc(form: Pick<Form, 'date' | 'time' | 'duration'>, tz: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !/^\d{2}:\d{2}$/.test(form.time)) return null
  const start = zonedToUtc(form.date, form.time, tz)
  if (Number.isNaN(start.getTime())) return null
  return { startUtc: start.toISOString(), endUtc: new Date(start.getTime() + form.duration * 60_000).toISOString() }
}

// ---- Pages -----------------------------------------------------------------------

/** /schedule — new meeting (meetings.create). `?category=CUSTOMER_PLVC` preselects a category. */
export function ScheduleMeetingPage() {
  const { user } = useAuth()
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Schedule Meeting" description="Invite colleagues, a customer or guests. Availability is checked as you type." />
      {user?.employeeLinked === false ? (
        <Alert tone="warning" title="Your account is not linked to an employee record">
          Meetings are scheduled for employees, so you cannot schedule one yet. Ask an administrator to link your account in
          Administration → Users &amp; roles (action "Link to employee"), then reload this page.
        </Alert>
      ) : (
        <MeetingForm />
      )}
    </div>
  )
}

/** /meetings/:id/edit — edit or reschedule (host, organiser or meetings.view.all). */
export function EditMeetingPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const meeting = useLoader(() => meetingsApi.get(id), [id], 'Unable to load the meeting.')
  const m = meeting.data
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={m?.status === 'DRAFT' ? 'Edit draft meeting' : 'Edit or reschedule meeting'}
        description={m ? `${m.title} · ${m.meetingCode}` : undefined}
        actions={<ButtonLink to={`/meetings/${id}`} variant="secondary" leftIcon={<ArrowLeft className="size-4" />}>Back to meeting</ButtonLink>}
      />
      {meeting.error || (!m && !meeting.loading) ? (
        <Card><ErrorState title="Unable to load the meeting" description={meeting.error ?? 'The meeting could not be loaded.'} onRetry={meeting.reload} /></Card>
      ) : !m ? (
        <FormSkeleton />
      ) : !m.my.canEdit || !can('meetings.create') ? (
        <Card>
          <ErrorState title="This meeting cannot be changed" description={m.status === 'DRAFT' || m.status === 'SCHEDULED' ? 'Only the host, the organiser or an administrator can edit it.' : 'Only draft or scheduled meetings can be edited.'} />
        </Card>
      ) : (
        <MeetingForm existing={m} />
      )}
    </div>
  )
}

// ---- Form ------------------------------------------------------------------------

function MeetingForm({ existing }: { existing?: MeetingDetail }) {
  const { can } = useAuth()
  const tz = useTimeZone()
  const toast = useToast()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const canCustomer = can('customer.meetings.view')
  const canOverride = can('meetings.override.conflict')

  const [form, setForm] = useState<Form>(() => {
    if (existing) {
      const s = parseUtc(existing.startUtc)
      const p = zonedParts(s, tz)
      return {
        title: existing.title,
        category: existing.category,
        date: p.ymd,
        time: p.hm,
        duration: Math.round((parseUtc(existing.endUtc).getTime() - s.getTime()) / 60_000),
        agenda: existing.agenda ?? '',
        description: existing.description ?? '',
        recordingPolicy: existing.recordingPolicy,
        waitingRoom: existing.waitingRoomEnabled,
        purpose: existing.purpose ?? '',
        policyNumber: existing.policyNumber ?? '',
      }
    }
    const wanted = params.get('category') as DbMeetingCategory | null
    const category = wanted && (INTERNAL_CATEGORIES.includes(wanted) || (canCustomer && CUSTOMER_CATEGORIES.includes(wanted))) ? wanted : ''
    return { title: '', category, ...defaultStart(tz), duration: 30, agenda: '', description: '', recordingPolicy: 'NONE', waitingRoom: true, purpose: '', policyNumber: '' }
  })
  const [people, setPeople] = useState<PickedEmployee[]>([])
  const [guests, setGuests] = useState<GuestRow[]>([])
  const [customer, setCustomer] = useState<PickedCustomer | null>(null)
  const [addingCustomer, setAddingCustomer] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'DRAFT' | 'SCHEDULED' | 'SAVE' | null>(null)
  const [conflicts, setConflicts] = useState<{ list: Conflict[]; status: 'DRAFT' | 'SCHEDULED' | 'SAVE' } | null>(null)

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  // Which meeting types can be recorded at all (Administration → Recording policies). If this type's policy is
  // switched off, the recording choices are disabled with an explanation instead of silently doing nothing later.
  const [recordingOptions, setRecordingOptions] = useState<RecordingOption[] | null>(null)
  useEffect(() => {
    let alive = true
    http<RecordingOption[]>('/meetings/recording-options').then((o) => alive && setRecordingOptions(o)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const recordingOption = recordingOptions?.find((o) => o.category === form.category)
  const recordingOff = !!recordingOption && !recordingOption.enabled
  useEffect(() => {
    if (recordingOff && form.recordingPolicy !== 'NONE') setForm((f) => ({ ...f, recordingPolicy: 'NONE' }))
  }, [recordingOff, form.recordingPolicy])

  const customerMeeting = isCustomerCategory(form.category)
  const times = toUtc(form, tz)
  const editable = !existing || existing.status === 'DRAFT' || existing.status === 'SCHEDULED'

  // Edit: every employee participant who has not declined; create: me + the people picked.
  const existingIds = useMemo(
    () => existing?.participants.filter((p) => p.type === 'EMPLOYEE' && p.employeeId && p.responseStatus !== 'DECLINED').map((p) => p.employeeId as string) ?? [],
    [existing],
  )
  const availability = useAvailability({
    employeeIds: existing ? existingIds : people.map((p) => p.id),
    startUtc: times?.startUtc ?? null,
    endUtc: times?.endUtc ?? null,
    includeMe: !existing,
    excludeMeetingId: existing?.id,
    enabled: can('meetings.create') && editable,
  })

  const durations = DURATIONS.includes(form.duration) ? DURATIONS : [...DURATIONS, form.duration].sort((a, b) => a - b)
  const categoryFamilies = existing ? (isCustomerCategory(existing.category) ? CUSTOMER_CATEGORIES : INTERNAL_CATEGORIES) : INTERNAL_CATEGORIES

  function validate(status: 'DRAFT' | 'SCHEDULED' | 'SAVE') {
    const v: Record<string, string> = {}
    if (!form.title.trim()) v.title = 'Title is required.'
    if (!form.category) v.category = 'Choose a category.'
    if (!times) v.startUtc = 'Enter a valid date and start time.'
    else if (status !== 'DRAFT' && (existing?.status !== 'SCHEDULED' || times.startUtc !== parseUtc(existing.startUtc).toISOString()) && parseUtc(times.startUtc).getTime() < Date.now() - 60_000)
      v.startUtc = 'The start time is in the past. Choose a future time.'
    if (!existing && customerMeeting && !customer) v.customerId = 'Select the customer for a customer meeting.'
    guests.forEach((g, i) => {
      if (!g.name.trim()) v[`guests[${i}].name`] = 'Guest name is required.'
      if (!EMAIL_RE.test(g.email.trim())) v[`guests[${i}].email`] = 'Enter a valid e-mail address.'
    })
    const emails = guests.map((g) => g.email.trim().toLowerCase())
    emails.forEach((e, i) => {
      if (e && emails.indexOf(e) !== i) v[`guests[${i}].email`] = 'This guest is listed twice.'
    })
    return v
  }

  async function save(status: 'DRAFT' | 'SCHEDULED' | 'SAVE', override?: string) {
    if (!times || !form.category) return
    const opt = (s: string) => s.trim() || null
    const common = {
      title: form.title.trim(),
      description: opt(form.description),
      agenda: opt(form.agenda),
      category: form.category,
      startUtc: times.startUtc,
      endUtc: times.endUtc,
      recordingPolicy: form.recordingPolicy,
      waitingRoomEnabled: form.waitingRoom,
      purpose: isCustomerCategory(form.category) ? opt(form.purpose) : null,
      policyNumber: isCustomerCategory(form.category) ? opt(form.policyNumber) : null,
      overrideConflicts: override ? true : undefined,
      overrideReason: override ?? undefined,
    }
    if (existing) {
      const body: MeetingUpdateInput = { ...common, timeZoneId: existing.timeZoneId, status: status === 'SAVE' ? undefined : status }
      const r = await meetingsApi.update(existing.id, body)
      finish(existing.id, r.warnings, r.rescheduled ? 'Meeting rescheduled. Participants have been notified.' : r.status === 'SCHEDULED' && existing.status === 'DRAFT' ? 'Meeting scheduled. Invitations are on their way.' : 'Meeting updated.')
    } else {
      const body: MeetingCreateInput = {
        ...common,
        timeZoneId: tz,
        status: status === 'DRAFT' ? 'DRAFT' : 'SCHEDULED',
        employeeIds: people.map((p) => p.id),
        customerId: isCustomerCategory(form.category) ? customer?.id ?? null : null,
        guests: guests.map((g) => ({ name: g.name.trim(), email: g.email.trim() })),
      }
      const r = await meetingsApi.create(body)
      finish(r.id, r.warnings, status === 'DRAFT' ? `Draft saved (${r.meetingCode}).` : `Meeting ${r.meetingCode} scheduled. Invitations are on their way.`)
    }
  }

  function finish(id: string, warnings: Conflict[], message: string) {
    const outside = [...new Set(warnings.filter((w) => w.type === 'OUTSIDE_WORKING_HOURS').map((w) => w.employeeName))]
    toast.success(outside.length ? `${message} Note: outside working hours for ${outside.join(', ')}.` : message)
    navigate(`/meetings/${id}`)
  }

  async function submit(status: 'DRAFT' | 'SCHEDULED' | 'SAVE') {
    const v = validate(status)
    setErrors(v)
    if (Object.keys(v).length) {
      setError('Check the highlighted fields.')
      return
    }
    setBusy(status)
    setError(null)
    try {
      await save(status)
    } catch (e) {
      const list = bookingConflicts(e)
      if (list.length) setConflicts({ list, status })
      else {
        setErrors(fieldErrors(e))
        setError(errorMessage(e, 'The meeting could not be saved.'))
      }
    } finally {
      setBusy(null)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    // React submit events bubble through portals: ignore the inline "Add customer" dialog's own form.
    if (e.target !== e.currentTarget) return
    void submit(existing ? 'SAVE' : 'SCHEDULED')
  }

  // Enter in a text box (e.g. the people search) must never schedule the meeting by accident: use the buttons.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    const t = e.target
    if (e.key === 'Enter' && t instanceof HTMLInputElement && e.currentTarget.contains(t)) e.preventDefault()
  }

  const rescheduling = existing?.status === 'SCHEDULED' && times && (times.startUtc !== parseUtc(existing.startUtc).toISOString() || times.endUtc !== parseUtc(existing.endUtc).toISOString())

  return (
    <form onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-5 xl:col-span-2">
        {error && <Alert tone="danger">{error}</Alert>}

        <Card>
          <CardHeader title="Meeting details" />
          <div className="flex flex-col gap-4 px-5 pb-5">
            <TextField label="Title" value={form.title} onChange={(e) => set('title', e.target.value)} error={errors.title} maxLength={200} autoComplete="off" placeholder="e.g. Weekly claims review" data-autofocus />
            <SelectField label="Category" value={form.category} onChange={(e) => (set('category', e.target.value as DbMeetingCategory), setErrors((x) => ({ ...x, customerId: '' })))} error={errors.category}
              hint={existing ? 'A customer meeting cannot become an internal meeting, or the other way round.' : undefined}>
              <option value="">Select category</option>
              {(existing ? categoryFamilies === INTERNAL_CATEGORIES : true) && (
                <optgroup label="Internal">
                  {INTERNAL_CATEGORIES.map((c) => <option key={c} value={c}>{dbCategoryLabel[c]}</option>)}
                </optgroup>
              )}
              {(existing ? categoryFamilies === CUSTOMER_CATEGORIES : canCustomer) && (
                <optgroup label="Customer">
                  {CUSTOMER_CATEGORIES.map((c) => <option key={c} value={c}>{dbCategoryLabel[c]}</option>)}
                </optgroup>
              )}
            </SelectField>

            {customerMeeting && (
              <div className="flex flex-col gap-4 rounded-md border border-line bg-surface-muted p-4">
                {existing ? (
                  <div>
                    <p className="text-[13px] font-semibold text-ink">Customer</p>
                    <p className="mt-1 text-[13.5px] text-ink">{existing.customer?.name ?? '—'}{existing.customer?.customerRef && <span className="ml-1.5 text-[12px] text-ink-secondary">{existing.customer.customerRef}</span>}</p>
                    <p className="text-[12px] text-ink-secondary">The customer of a meeting cannot be changed.</p>
                  </div>
                ) : (
                  <CustomerPicker
                    label="Customer"
                    value={customer}
                    onChange={(c) => {
                      setCustomer(c)
                      setErrors((x) => ({ ...x, customerId: '' }))
                      if (c?.policyNumber && !form.policyNumber) set('policyNumber', c.policyNumber)
                    }}
                    onAddNew={() => setAddingCustomer(true)}
                    error={errors.customerId}
                    hint="The customer gets a personal, expiring join link by e-mail."
                  />
                )}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField label="Purpose (optional)" value={form.purpose} onChange={(e) => set('purpose', e.target.value)} error={errors.purpose} maxLength={200} autoComplete="off" />
                  <TextField label="Policy number (optional)" value={form.policyNumber} onChange={(e) => set('policyNumber', e.target.value)} error={errors.policyNumber} maxLength={50} autoComplete="off" hint="Defaults to the customer's policy number." />
                </div>
              </div>
            )}

            <TextAreaField label="Agenda (optional)" value={form.agenda} onChange={(e) => set('agenda', e.target.value)} error={errors.agenda} maxLength={4000} rows={4} placeholder="Topics to cover, one per line" />
            <TextAreaField label="Description (optional)" value={form.description} onChange={(e) => set('description', e.target.value)} error={errors.description} maxLength={2000} rows={3} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Date and time" subtitle={`Times are in ${zoneLabel(tz)} (${tz}).`} />
          <div className="flex flex-col gap-4 px-5 pb-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <TextField label="Date" type="date" value={form.date} onChange={(e) => (set('date', e.target.value), setErrors((x) => ({ ...x, startUtc: '' })))} error={errors.startUtc} />
              <TextField label={`Start time (${zoneLabel(tz)})`} type="time" step={300} value={form.time} onChange={(e) => (set('time', e.target.value), setErrors((x) => ({ ...x, startUtc: '' })))} />
              <SelectField label="Duration" value={String(form.duration)} onChange={(e) => (set('duration', Number(e.target.value)), setErrors((x) => ({ ...x, endUtc: '' })))} error={errors.endUtc}>
                {durations.map((d) => <option key={d} value={d}>{formatDuration(d)}</option>)}
              </SelectField>
            </div>
            {times && (
              <p className="flex items-center gap-2 rounded-md bg-canvas px-3.5 py-2.5 text-[13px] text-ink">
                <CalendarCheck className="size-4 shrink-0 text-brand-500" aria-hidden />
                {formatRange(times.startUtc, times.endUtc, tz)} {zoneLabel(tz)}
              </p>
            )}
            {rescheduling && (
              <Alert tone="warning" title="This reschedules the meeting">
                Attendees' replies are reset, reminders are re-created, customer and guest links are re-issued, and everyone is notified.
              </Alert>
            )}
          </div>
        </Card>

        {existing ? (
          <Card>
            <CardHeader title="Participants" subtitle={`${existing.participants.length} people`} />
            <p className="px-5 pb-5 text-[13px] text-ink-secondary">Add or remove participants on the meeting page.</p>
          </Card>
        ) : (
          <ParticipantsCard
            people={people}
            setPeople={setPeople}
            guests={guests}
            setGuests={setGuests}
            errors={errors}
            setErrors={setErrors}
            availability={availability}
          />
        )}

        <Card>
          <CardHeader title="Recording and access" />
          <div className="flex flex-col gap-4 px-5 pb-5">
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold text-ink">Recording policy</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(['NONE', 'OPTIONAL', 'REQUIRED'] as RecordingPolicy[]).map((p) => {
                  const off = p !== 'NONE' && recordingOff
                  return (
                    <label key={p} className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors', off ? 'cursor-not-allowed opacity-55' : 'cursor-pointer', form.recordingPolicy === p ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-line-strong')}>
                      <input type="radio" name="recordingPolicy" value={p} checked={form.recordingPolicy === p} disabled={off} onChange={() => set('recordingPolicy', p)} className="mt-0.5 size-4 accent-brand-500" />
                      <span>
                        <span className="block text-[13px] font-semibold text-ink">{p === 'NONE' ? 'No recording' : p === 'OPTIONAL' ? 'Optional' : 'Required'}</span>
                        <span className="block text-[12px] text-ink-secondary">{p === 'NONE' ? 'The meeting is not recorded.' : p === 'OPTIONAL' ? 'The host may record, with consent.' : 'Recorded, with consent.'}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
              <p className={cn('mt-2 flex items-start gap-1.5 text-[12.5px]', recordingOff ? 'text-warning-ink' : 'text-ink-secondary')}>
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {recordingOff
                    ? <>Recording is switched off for <strong className="font-semibold">{recordingOption?.policyTitle}</strong>, the recording policy used by this meeting type. An administrator can turn it on in Administration → Recording policies.</>
                    : recordingOption
                      ? <>Recording follows the <strong className="font-semibold">{recordingOption.policyTitle}</strong> policy: participants see the recording notice in the meeting, and the host starts and stops recording.</>
                      : 'Participants see the recording notice in the meeting, and the host starts and stops recording.'}
                </span>
              </p>
            </fieldset>
            <Switch checked={form.waitingRoom} onChange={(v) => set('waitingRoom', v)} label="Waiting room: the host admits customers and guests" />
          </div>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-5 xl:sticky xl:top-[88px]">
          <AvailabilityCard availability={availability} tz={tz} draft={existing?.status === 'DRAFT'} />
          <Card>
            <div className="flex flex-col gap-2 p-5">
              {existing ? (
                existing.status === 'DRAFT' ? (
                  <>
                    <Button type="button" fullWidth loading={busy === 'SCHEDULED'} disabled={!!busy} leftIcon={<CalendarCheck className="size-4" />} onClick={() => void submit('SCHEDULED')}>Schedule meeting</Button>
                    <Button type="button" variant="secondary" fullWidth loading={busy === 'DRAFT'} disabled={!!busy} leftIcon={<Save className="size-4" />} onClick={() => void submit('DRAFT')}>Save draft</Button>
                  </>
                ) : (
                  <Button type="submit" fullWidth loading={busy === 'SAVE'} disabled={!!busy} leftIcon={<Save className="size-4" />}>{rescheduling ? 'Reschedule meeting' : 'Save changes'}</Button>
                )
              ) : (
                <>
                  <Button type="submit" fullWidth loading={busy === 'SCHEDULED'} disabled={!!busy} leftIcon={<CalendarCheck className="size-4" />}>Schedule meeting</Button>
                  <Button type="button" variant="secondary" fullWidth loading={busy === 'DRAFT'} disabled={!!busy} leftIcon={<Save className="size-4" />} onClick={() => void submit('DRAFT')}>Save as draft</Button>
                </>
              )}
              <p className="mt-1 text-[12px] text-ink-secondary">
                {existing?.status === 'SCHEDULED' ? 'Participants are e-mailed and notified about changes to the time.' : 'Scheduling e-mails the invitations and sets up reminders. Drafts are visible only to you and are not checked for conflicts.'}
              </p>
            </div>
          </Card>
        </div>
      </div>

      <CustomerDialog
        customerId={addingCustomer ? null : undefined}
        onClose={(saved) => {
          setAddingCustomer(false)
          if (saved) {
            setCustomer({ id: saved.id, fullName: saved.fullName, customerRef: saved.customerRef })
            setErrors((x) => ({ ...x, customerId: '' }))
            toast.success('Customer added.')
          }
        }}
      />

      <ConflictDialog
        conflicts={conflicts?.list ?? null}
        tz={tz}
        canOverride={canOverride}
        onClose={() => setConflicts(null)}
        onOverride={async (reason) => {
          if (!conflicts) return
          await save(conflicts.status, reason)
          setConflicts(null)
        }}
      />
    </form>
  )
}

// ---- Participants ------------------------------------------------------------------

function ParticipantsCard({
  people, setPeople, guests, setGuests, errors, setErrors, availability,
}: {
  people: PickedEmployee[]
  setPeople: (fn: (p: PickedEmployee[]) => PickedEmployee[]) => void
  guests: GuestRow[]
  setGuests: (fn: (g: GuestRow[]) => GuestRow[]) => void
  errors: Record<string, string>
  setErrors: (fn: (e: Record<string, string>) => Record<string, string>) => void
  availability: AvailabilityState
}) {
  const { user } = useAuth()
  const [seq, setSeq] = useState(1)
  const meIssues = availability.me ? [...availability.me.conflicts, ...availability.me.warnings] : []
  return (
    <Card>
      <CardHeader title="Participants" subtitle="You are the host. Invite colleagues and external guests." />
      <div className="flex flex-col gap-4 px-5 pb-5">
        <EmployeePicker
          label="Add colleagues"
          clearOnSelect
          onChange={(p) => p && setPeople((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p]))}
          excludeIds={people.map((p) => p.id)}
          error={errors.employeeIds || undefined}
          hint="Search by name or employee code. Up to 100 colleagues."
        />
        <ul className="flex flex-col gap-1.5">
          {user && (
            <PersonRow name={`${user.displayName} (you)`} detail="Host" status={<PersonStatus issues={meIssues} checked={!!availability.me} checking={availability.checking} />} />
          )}
          {people.map((p) => {
            const issues = [...(availability.others?.conflicts ?? []), ...(availability.others?.warnings ?? [])].filter((c) => c.employeeId === p.id)
            return (
              <PersonRow
                key={p.id}
                name={p.displayName}
                detail={p.employeeCode}
                status={<PersonStatus issues={issues} checked={!!availability.others} checking={availability.checking} />}
                onRemove={() => setPeople((xs) => xs.filter((x) => x.id !== p.id))}
              />
            )
          })}
        </ul>

        <div className="border-t border-line pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink">External guests</p>
            <Button
              size="sm"
              variant="subtle"
              leftIcon={<UserPlus className="size-3.5" />}
              disabled={guests.length >= MAX_GUESTS}
              onClick={() => {
                setGuests((g) => [...g, { key: seq, name: '', email: '' }])
                setSeq((s) => s + 1)
              }}
            >
              Add guest
            </Button>
          </div>
          {errors.guests && <p role="alert" className="mt-1 text-[12.5px] font-medium text-danger">{errors.guests}</p>}
          {guests.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-ink-secondary">Guests get a personal join link by e-mail. No account is needed.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {guests.map((g, i) => {
                const update = (k: 'name' | 'email', v: string) => {
                  setGuests((xs) => xs.map((x) => (x.key === g.key ? { ...x, [k]: v } : x)))
                  setErrors((x) => ({ ...x, [`guests[${i}].${k}`]: '' }))
                }
                return (
                  <li key={g.key} className="grid grid-cols-1 items-start gap-2 rounded-md border border-line p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:border-0 sm:p-0">
                    <TextField label={`Guest ${i + 1} name`} value={g.name} onChange={(e) => update('name', e.target.value)} error={errors[`guests[${i}].name`]} maxLength={200} autoComplete="off" />
                    <TextField label={`Guest ${i + 1} e-mail`} type="email" value={g.email} onChange={(e) => update('email', e.target.value)} error={errors[`guests[${i}].email`]} autoComplete="off" />
                    <Button variant="ghost" className="sm:mt-[26px]" aria-label={`Remove guest ${i + 1}`} leftIcon={<Trash2 className="size-4" />} onClick={() => setGuests((xs) => xs.filter((x) => x.key !== g.key))}>
                      <span className="sm:hidden">Remove</span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}

function PersonRow({ name, detail, status, onRemove }: { name: string; detail?: string; status: ReactNode; onRemove?: () => void }) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
      <Avatar name={name} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-ink">{name}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-secondary">
          {detail}
          {status}
        </span>
      </span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-navy-900/5 hover:text-ink">
          <X className="size-4" />
        </button>
      )}
    </li>
  )
}

function PersonStatus({ issues, checked, checking }: { issues: Conflict[]; checked: boolean; checking: boolean }) {
  if (checking) return <span className="inline-flex items-center gap-1 text-ink-muted"><LoaderCircle className="size-3 animate-spin" aria-hidden /> Checking…</span>
  if (!checked) return null
  const blocking = issues.filter((c) => c.type !== 'OUTSIDE_WORKING_HOURS')
  if (blocking.length) return <span className="inline-flex items-center gap-1 font-medium text-danger"><TriangleAlert className="size-3" aria-hidden /> {[...new Set(blocking.map((c) => conflictLabel[c.type]))].join(', ')}</span>
  if (issues.length) return <span className="inline-flex items-center gap-1 font-medium text-warning-ink"><Info className="size-3" aria-hidden /> Outside working hours</span>
  return <span className="inline-flex items-center gap-1 font-medium text-success"><CircleCheck className="size-3" aria-hidden /> Available</span>
}

function AvailabilityCard({ availability, tz, draft }: { availability: AvailabilityState; tz: string; draft?: boolean }) {
  const { conflicts, warnings, checking, error, me, others } = availability
  const checked = !!me || !!others
  return (
    <Card>
      <CardHeader title="Availability" subtitle="Checked live against meetings, leave and blocked time." action={checking ? <LoaderCircle className="size-4 animate-spin text-ink-muted" aria-label="Checking availability" /> : undefined} />
      <div className="flex flex-col gap-3 px-5 pb-5" aria-live="polite">
        {error ? (
          <Alert tone="warning" title="Availability could not be checked">{error}</Alert>
        ) : !checked ? (
          <p className="text-[13px] text-ink-secondary">{checking ? 'Checking availability…' : 'Enter a date and time to check availability.'}</p>
        ) : (
          <>
            {conflicts.length === 0 ? (
              <Alert tone="success" title="Everyone is available">No conflicting meetings, leave or blocked time.</Alert>
            ) : (
              <>
                <Alert tone="danger" title={`${new Set(conflicts.map((c) => c.employeeId)).size} ${new Set(conflicts.map((c) => c.employeeId)).size === 1 ? 'person is' : 'people are'} not available`}>
                  {draft ? 'Scheduling this draft will be refused unless the time changes.' : 'Scheduling will be refused unless you change the time or the participants.'}
                </Alert>
                <ConflictList conflicts={conflicts} tz={tz} />
              </>
            )}
            {warnings.length > 0 && (
              <Alert tone="warning" title="Outside working hours">
                {[...new Set(warnings.map((w) => w.employeeName))].join(', ')}. This does not block the booking.
              </Alert>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function FormSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3" aria-busy="true" aria-label="Loading meeting">
      <Card className="p-5 xl:col-span-2">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mb-4 h-11 w-full" />)}
      </Card>
      <Card className="p-5">
        <Skeleton className="h-24 w-full" />
      </Card>
    </div>
  )
}

