import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn, Video } from 'lucide-react'
import { http } from '../../api/http'
import { meetingsApi, type CustomerJoinLink, type DbMeetingCategory, type RecordingPolicy } from '../../api/meetings'
import { errorMessage } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SelectField, Switch } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { CustomerDialog } from '../customers/CustomerDialog'
import { CustomerPicker, type PickedCustomer } from '../customers/CustomerPicker'
import { CUSTOMER_CATEGORIES, dbCategoryLabel, INTERNAL_CATEGORIES, isCustomerCategory, recordingLabel } from './meta'
import { newParticipant, ParticipantRows, participantsPayload, PrarambhField, validatePlvc, type ParticipantRow } from './PlvcFields'

/** Passed to the room page (router state): pre-join defaults and "show the invite link" for a meeting just started. */
export type RoomEntryState = { video?: boolean; invite?: boolean; customer?: CustomerJoinLink | null; guests?: CustomerJoinLink[]; /** "Skip details": no customer to send a link to. */ noCustomer?: boolean }

type RecordingOption = { category: string; policyTitle: string; enabled: boolean; requirement?: 'DISABLED' | 'OPTIONAL' | 'MANDATORY'; consentMode?: 'CONSENT_REQUIRED' | 'NOTIFICATION_ONLY' }

const LENGTHS = [15, 30, 45, 60, 90, 120]

/** "Instant meeting": starts a meeting now (no calendar, no e-mails) with a shareable link, and opens the pre-join screen.
 *  Internal types, or a customer meeting (PLVC / general) with the chosen customer, who gets a personal join link. */
export function NewMeetingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, can } = useAuth()
  const navigate = useNavigate()
  const canCustomer = can('customer.meetings.view')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<DbMeetingCategory>('GROUP')
  const [customer, setCustomer] = useState<PickedCustomer | null>(null)
  const [addingCustomer, setAddingCustomer] = useState(false)
  const customerMeeting = isCustomerCategory(category)
  // Customer – PLVC: Prarambh Main ID + participant rows instead of picking a customer record (12 Nov 2026).
  const plvc = category === 'CUSTOMER_PLVC'
  const [prarambh, setPrarambh] = useState('')
  const [rows, setRows] = useState<ParticipantRow[]>([newParticipant(0)])
  const [rowSeq, setRowSeq] = useState(1)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [minutes, setMinutes] = useState(60)
  const [video, setVideo] = useState(true)
  const [audioOnly, setAudioOnly] = useState(false)
  const [waitingRoom, setWaitingRoom] = useState(true)
  const [recording, setRecording] = useState<RecordingPolicy>('NONE')
  const [options, setOptions] = useState<RecordingOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    let alive = true
    http<RecordingOption[]>('/meetings/recording-options').then((o) => alive && setOptions(o)).catch(() => alive && setOptions([]))
    return () => {
      alive = false
    }
  }, [open])

  const option = options?.find((o) => o.category === category)
  const recordingOff = !option?.enabled
  // Mandatory policy (e.g. PLVC calls): recording starts automatically - nothing to choose.
  const mandatory = !recordingOff && option?.requirement === 'MANDATORY'
  useEffect(() => {
    if (recordingOff) setRecording('NONE')
    else if (mandatory) setRecording('REQUIRED')
  }, [recordingOff, mandatory])
  useEffect(() => {
    if (!customerMeeting) setCustomer(null)
  }, [customerMeeting])

  async function start(e: FormEvent) {
    e.preventDefault()
    await once(doStart)
  }

  // Enter/click again while the first request is running: never create a second meeting. A ref, not just `busy` (state),
  // so two submits in the same tick (double tap) cannot both get through before React re-renders.
  async function once(fn: () => Promise<void>) {
    if (busy || submitting.current) return
    submitting.current = true
    try {
      await fn()
    } finally {
      submitting.current = false
    }
  }

  /** "Skip details & start meeting" (PLVC): an UNIDENTIFIED meeting - nothing typed in the PLVC block is used, no e-mails;
   *  the host shares the meeting link and admits people from the waiting room. Recorded as normal. */
  async function doSkip() {
    setFieldErrors({})
    setBusy(true)
    setError(null)
    try {
      const r = await meetingsApi.instant({
        title: title.trim() || undefined, category, durationMinutes: minutes, audioOnly, waitingRoomEnabled: waitingRoom, recordingPolicy: recording, skipPlvcDetails: true,
      })
      const state: RoomEntryState = { video: video && !audioOnly, invite: true, customer: null, guests: [], noCustomer: true }
      navigate(`/meetings/${r.id}/room`, { state })
    } catch (err) {
      setError(errorMessage(err, 'The meeting could not be started.'))
      setBusy(false)
    }
  }

  async function doStart() {
    if (plvc) {
      const errs = validatePlvc(prarambh, rows)
      setFieldErrors(errs)
      if (Object.keys(errs).length) {
        setError('Please correct the highlighted fields.')
        return
      }
    } else if (customerMeeting && !customer) {
      setError('Select the customer for a customer meeting.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await meetingsApi.instant({
        title: title.trim() || undefined, category, durationMinutes: minutes, audioOnly, waitingRoomEnabled: waitingRoom, recordingPolicy: recording,
        customerId: customerMeeting && !plvc ? customer?.id : undefined,
        prarambhMainId: plvc ? prarambh.trim() : undefined,
        participants: plvc ? participantsPayload(rows) : undefined,
      })
      const state: RoomEntryState = { video: video && !audioOnly, invite: true, customer: r.customer, guests: (r.participants ?? []).filter((p) => p.type === 'GUEST') }
      navigate(`/meetings/${r.id}/room`, { state })
    } catch (err) {
      setError(errorMessage(err, 'The meeting could not be started.'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Start an instant meeting"
      description="No scheduling needed. You get a link to share; everyone who uses it waits until you let them in."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="new-meeting" loading={busy} leftIcon={<Video className="size-4" />} data-testid="start-instant">Start meeting</Button>
        </>
      }
    >
      <form id="new-meeting" onSubmit={start} className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField label="Title (optional)" value={title} maxLength={200} placeholder={`${user?.displayName ?? 'My'}'s meeting`} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Type" value={category} onChange={(e) => setCategory(e.target.value as DbMeetingCategory)} data-testid="instant-type">
            <optgroup label="Internal">
              {INTERNAL_CATEGORIES.map((c) => <option key={c} value={c}>{dbCategoryLabel[c]}</option>)}
            </optgroup>
            {canCustomer && (
              <optgroup label="Customer">
                {CUSTOMER_CATEGORIES.map((c) => <option key={c} value={c}>{dbCategoryLabel[c]}</option>)}
              </optgroup>
            )}
          </SelectField>
          <SelectField label="Length" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} hint="You can end it earlier.">
            {LENGTHS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
          </SelectField>
        </div>
        {!customerMeeting && canCustomer && (
          // GoodDay #14206: a customer call started as an internal meeting asks the customer to accept recording (internal
          // recording policy). PLVC records with a notice only - nobody is asked.
          <p className="-mt-1 rounded-md bg-brand-50 px-3 py-2 text-[12.5px] text-ink-secondary" data-testid="instant-customer-hint">
            Calling a customer? Choose <strong className="text-ink">Customer PLVC</strong> — recording starts automatically and the customer is not asked to accept. Internal types ask everyone, including guests, before recording.
          </p>
        )}
        {plvc && (
          <div className="flex flex-col gap-4 rounded-md border border-line p-3.5" data-testid="plvc-fields">
            <PrarambhField value={prarambh} onChange={(v) => { setPrarambh(v); setFieldErrors((x) => ({ ...x, prarambhMainId: '' })) }} error={fieldErrors.prarambhMainId || undefined} />
            <ParticipantRows rows={rows} onChange={(r) => { setRows(r); setFieldErrors({}) }} errors={fieldErrors} nextKey={() => { setRowSeq((n) => n + 1); return rowSeq }}
              hint="The first participant is the customer. When you start, each participant is e-mailed their own personal join link; you also get the links to share." />
            <div className="flex flex-col gap-1.5 border-t border-line pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[12px] leading-4 text-ink-secondary">No customer details yet? Start without them and share the meeting link. The meeting is marked <strong className="text-ink">Unidentified PLVC</strong>; you can add the Prarambh Main ID later.</p>
              <Button type="button" variant="secondary" size="sm" className="shrink-0" disabled={busy} onClick={() => void once(doSkip)} data-testid="skip-plvc-details">
                Skip details &amp; start meeting
              </Button>
            </div>
          </div>
        )}
        {customerMeeting && !plvc && (
          <CustomerPicker
            label="Customer"
            value={customer}
            onChange={(c) => {
              setCustomer(c)
              setError(null)
            }}
            onAddNew={() => setAddingCustomer(true)}
            hint="After starting, you get the customer's personal join link to share with them."
          />
        )}
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-muted p-3.5">
          <Switch checked={video && !audioOnly} disabled={audioOnly} onChange={setVideo} label="Start with my camera on" />
          <Switch checked={audioOnly} onChange={setAudioOnly} label="Audio-only meeting (nobody can turn on a camera)" />
          <Switch checked={waitingRoom} onChange={setWaitingRoom} label="Waiting room for invited colleagues too" />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-semibold text-ink">Recording</legend>
          {mandatory ? (
            <div className="flex items-start gap-2.5 rounded-md border border-danger/25 bg-danger/[0.06] px-3 py-2.5 text-[13px] text-ink" data-testid="instant-recording-mandatory">
              <span className="mt-1 size-2.5 shrink-0 rounded-full bg-danger" aria-hidden />
              <span>
                <strong>Recording starts automatically</strong> when the meeting starts — mandatory for this meeting type.{' '}
                {option?.consentMode === 'NOTIFICATION_ONLY'
                  ? 'Everyone is shown the recording notice and the REC indicator; no acceptance is needed.'
                  : 'Each participant is asked to accept the recording notice.'}
              </span>
            </div>
          ) : (
          <div className="flex flex-wrap gap-4">
            {(['NONE', 'OPTIONAL', 'REQUIRED'] as RecordingPolicy[]).map((p) => (
              <label key={p} className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
                <input type="radio" name="instant-recording" value={p} checked={recording === p} disabled={p !== 'NONE' && recordingOff} onChange={() => setRecording(p)} />
                {recordingLabel[p]}
              </label>
            ))}
          </div>
          )}
          <p className="text-[12px] text-ink-secondary">
            {options === null ? 'Checking the recording policy…'
              : recordingOff ? `Recording is switched off for this meeting type${option ? ` ("${option.policyTitle}")` : ''}. An administrator can turn it on in Administration → Recording policies.`
              : `Recording follows the "${option!.policyTitle}" policy.`}
          </p>
        </fieldset>
      </form>
      <CustomerDialog
        customerId={addingCustomer ? null : undefined}
        onClose={(saved) => {
          setAddingCustomer(false)
          if (saved) setCustomer({ id: saved.id, fullName: saved.fullName, customerRef: saved.customerRef })
        }}
      />
    </Dialog>
  )
}

/** Where a pasted link or typed code leads (null = treat as a meeting code). */
export function routeForJoinInput(raw: string): string | null {
  const text = raw.trim()
  const m = /\/(m|join)\/([A-Za-z0-9_-]{16,200})/.exec(text)
  if (m) return `/${m[1]}/${m[2]}`
  const id = /\/meetings\/([0-9a-fA-F-]{36})/.exec(text)
  if (id) return `/meetings/${id[1]}/room`
  return null
}

/** "Join meeting": paste a link or type a meeting code (codes open only meetings you can already see). */
export function JoinMeetingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  async function join(e: FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if (!text) {
      setError('Paste the meeting link or type the meeting code.')
      return
    }
    const route = routeForJoinInput(text)
    if (route) {
      navigate(route)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await meetingsApi.byCode(text.replace(/\s+/g, ''))
      navigate(`/meetings/${r.id}/room`)
    } catch (err) {
      setError(errorMessage(err, 'No meeting was found for this code.'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Join a meeting"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="join-meeting" loading={busy} leftIcon={<LogIn className="size-4" />}>Join</Button>
        </>
      }
    >
      <form id="join-meeting" onSubmit={join} className="flex flex-col gap-3">
        <TextField
          label="Meeting link or code"
          value={value}
          autoFocus
          placeholder="https://…/m/…  or  OIC-261102-AB12"
          onChange={(e) => setValue(e.target.value)}
          error={error ?? undefined}
          data-testid="join-input"
        />
        <p className="text-[12px] text-ink-secondary">A code opens meetings you are invited to. For other meetings, use the link the host shared.</p>
      </form>
    </Dialog>
  )
}
