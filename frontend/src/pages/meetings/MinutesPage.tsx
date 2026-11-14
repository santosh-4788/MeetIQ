import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, FileText, History, ListPlus, Printer, RotateCcw, Save, Trash2 } from 'lucide-react'
import {
  ACTION_STATUS_LABEL, PRIORITY_LABEL, VERSION_ACTION_LABEL, minutesApi,
  type ActionPriority, type ActionStatus, type MinutesContent, type MinutesInput, type MinutesVersion, type MinutesView,
} from '../../api/minutes'
import { roomFeaturesApi } from '../../api/roomFeatures'
import { ApiError, errorMessage, fieldErrors } from '../../api/types'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SelectField, TextAreaField } from '../../components/ui/Form'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { formatCalendarDate, formatDate, formatDateTime, formatTime, zoneLabel } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { dbCategoryLabel, isCustomerCategory, useTimeZone } from './meta'
import { minutesDuration, minutesPrintHtml, NOT_SPECIFIED, printHtml } from './minutesPrint'
import type { DbMeetingCategory } from '../../api/meetings'

// /meetings/:id/minutes - minutes of meeting written by people (no AI). Feature switch MEETING_MINUTES (V027).

type ItemDraft = { key: string; id: string | null; description: string; assignee: PickedEmployee | null; dueDate: string; priority: ActionPriority; status: ActionStatus }
type Draft = { discussionSummary: string; customerRequirements: string; decisions: string; pendingActivities: string; followUpDate: string; actionItems: ItemDraft[] }

const SUMMARY_MAX = 8000
const TEXT_MAX = 4000
const ITEM_MAX = 500
const ITEMS_MAX = 50

let keySeq = 0
const newKey = () => `n${++keySeq}`

function toDraft(c: MinutesContent | null): Draft {
  return {
    discussionSummary: c?.discussionSummary ?? '',
    customerRequirements: c?.customerRequirements ?? '',
    decisions: c?.decisions ?? '',
    pendingActivities: c?.pendingActivities ?? '',
    followUpDate: c?.followUpDate ?? '',
    actionItems: (c?.actionItems ?? []).map((a) => ({
      key: a.id ?? newKey(), id: a.id, description: a.description, assignee: a.assignee ? { id: a.assignee.id, displayName: a.assignee.name } : null,
      dueDate: a.dueDate ?? '', priority: a.priority, status: a.status,
    })),
  }
}

const orNull = (s: string) => (s.trim() ? s.trim() : null)

function toInput(d: Draft, baseVersion: number): MinutesInput {
  return {
    baseVersion,
    discussionSummary: orNull(d.discussionSummary),
    customerRequirements: orNull(d.customerRequirements),
    decisions: orNull(d.decisions),
    pendingActivities: orNull(d.pendingActivities),
    followUpDate: d.followUpDate || null,
    actionItems: d.actionItems.map((a) => ({ id: a.id, description: a.description.trim(), assigneeId: a.assignee?.id ?? null, dueDate: a.dueDate || null, priority: a.priority, status: a.status })),
  }
}

/** Same comparison the server would make, ignoring local-only keys. */
const fingerprint = (d: Draft) => JSON.stringify(toInput(d, 0))

export function MinutesPage() {
  const { id = '' } = useParams()
  const tz = useTimeZone()
  const features = useLoader(() => roomFeaturesApi.get(), [], '')
  const view = useLoader(() => minutesApi.get(id), [id], 'Unable to load the minutes.')

  const back = (
    <div>
      <ButtonLink to={`/meetings/${encodeURIComponent(id)}`} variant="ghost" size="sm" leftIcon={<ArrowLeft className="size-4" />} className="-ml-2">
        Back to meeting
      </ButtonLink>
    </div>
  )

  if (features.data && !features.data.meetingMinutes)
    return (
      <div className="flex flex-col gap-5">
        {back}
        <Card className="p-5"><Alert tone="info" title="Minutes of meeting are switched off">Your administrator has not switched this feature on.</Alert></Card>
      </div>
    )
  if (view.error)
    return (
      <div className="flex flex-col gap-5">
        {back}
        <Card><ErrorState title="Unable to load the minutes" description={view.error} onRetry={view.reload} /></Card>
      </div>
    )
  if (!view.data) return <div className="flex flex-col gap-5">{back}<Skeleton className="h-96" /></div>
  return (
    <div className="flex flex-col gap-5" data-testid="minutes-page">
      {back}
      <MinutesScreen meetingId={id} v={view.data} tz={tz} reload={view.reload} />
    </div>
  )
}

function MinutesScreen({ meetingId, v, tz, reload }: { meetingId: string; v: MinutesView; tz: string; reload: () => void }) {
  const toast = useToast()
  const editing = v.canCreate || v.canEdit
  const m = v.minutes
  const serverKey = `${m?.id ?? 'new'}:${m?.version ?? 0}`
  const initial = useMemo(() => toDraft(m), [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Draft>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [approving, setApproving] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [history, setHistory] = useState(false)
  useEffect(() => { setDraft(initial); setErrors({}); setStale(false) }, [initial])
  const dirty = editing && fingerprint(draft) !== fingerprint(initial)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const customer = isCustomerCategory(v.meeting.category)
  const set = <K extends keyof Draft>(k: K, value: Draft[K]) => setDraft((d) => ({ ...d, [k]: value }))
  const setItem = (key: string, patch: Partial<ItemDraft>) => setDraft((d) => ({ ...d, actionItems: d.actionItems.map((a) => (a.key === key ? { ...a, ...patch } : a)) }))

  async function save() {
    setBusy(true)
    setErrors({})
    try {
      await minutesApi.save(meetingId, toInput(draft, m?.version ?? 0))
      toast.success(m ? 'Minutes saved as a new version.' : 'Minutes created as a draft.')
      reload()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') setStale(true)
      setErrors(fieldErrors(e))
      toast.error(errorMessage(e, 'The minutes could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = !m ? 'Not written yet' : m.status === 'APPROVED' ? 'Approved' : 'Draft – pending approval'
  const statusDetail = !m ? '' : m.status === 'APPROVED'
    ? `Approved by ${m.approvedBy ?? 'unknown'} on ${formatDateTime(m.approvedUtc, tz)} · version ${m.version}`
    : `Last saved by ${m.modifiedBy ?? 'unknown'} on ${formatDateTime(m.modifiedUtc, tz)} · version ${m.version}`

  function print() {
    const content: MinutesContent = editing ? { ...toInput(draft, 0), actionItems: draft.actionItems.map((a) => ({ id: a.id, description: a.description, assignee: a.assignee ? { id: a.assignee.id, name: a.assignee.displayName } : null, dueDate: a.dueDate || null, priority: a.priority, status: a.status })) } : m!
    printHtml(minutesPrintHtml(v, content, tz, { status: dirty ? 'Draft – unsaved changes' : m?.status === 'APPROVED' ? 'Approved' : 'Draft – pending approval', detail: dirty ? '' : statusDetail }))
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold leading-7 text-ink">Minutes of meeting</h1>
          <p className="mt-1 break-words text-[13.5px] text-ink-secondary">{v.meeting.title} · {v.meeting.meetingCode}</p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-secondary" data-testid="minutes-status">
            <Badge tone={m?.status === 'APPROVED' ? 'success' : m ? 'warning' : 'neutral'}>{statusLabel}</Badge>
            {statusDetail && <span>{statusDetail}</span>}
            {dirty && <Badge tone="info">Unsaved changes</Badge>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(m || editing) && <Button variant="secondary" size="sm" leftIcon={<Printer className="size-4" />} onClick={print} data-testid="minutes-print">Print / Save as PDF</Button>}
          {v.canSeeHistory && <Button variant="secondary" size="sm" leftIcon={<History className="size-4" />} onClick={() => setHistory(true)} data-testid="minutes-history">History</Button>}
          {v.canReopen && <Button variant="secondary" size="sm" leftIcon={<RotateCcw className="size-4" />} onClick={() => setReopening(true)} data-testid="minutes-reopen">Reopen</Button>}
        </div>
      </div>

      {v.draftInProgress && <Alert tone="info" title="Minutes are being written">The host is preparing the minutes. You can read them here once they are approved.</Alert>}
      {!m && !v.canCreate && !v.draftInProgress && (
        <Alert tone="info" title="No minutes yet">
          {v.writableMeeting ? 'The host or the organiser has not written the minutes of this meeting.' : 'Minutes can be written once the meeting has started.'}
        </Alert>
      )}
      {stale && (
        <Alert tone="warning" title="Someone else saved these minutes">
          Your changes were not saved. Copy anything you need, then <button type="button" className="font-semibold underline" onClick={reload}>reload the latest version</button>.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-5 xl:col-span-2">
          {editing ? (
            <Card>
              <CardHeader title={m ? 'Edit the minutes' : 'Write the minutes'} subtitle="Write what was discussed and agreed. Leave a box empty if it was not covered; it prints as “Not specified”." />
              <div className="flex flex-col gap-4 px-5 pb-5" data-testid="minutes-form">
                <TextAreaField label="Discussion summary" rows={6} maxLength={SUMMARY_MAX} value={draft.discussionSummary} onChange={(e) => set('discussionSummary', e.target.value)}
                  error={errors.discussionSummary} hint={`${draft.discussionSummary.length} / ${SUMMARY_MAX}`} data-testid="mom-summary" />
                {(customer || draft.customerRequirements) && (
                  <TextAreaField label="Customer requirements" rows={3} maxLength={TEXT_MAX} value={draft.customerRequirements} onChange={(e) => set('customerRequirements', e.target.value)}
                    error={errors.customerRequirements} data-testid="mom-requirements" />
                )}
                <TextAreaField label="Decisions" rows={3} maxLength={TEXT_MAX} value={draft.decisions} onChange={(e) => set('decisions', e.target.value)} error={errors.decisions} data-testid="mom-decisions" />
                <TextAreaField label="Pending activities" rows={3} maxLength={TEXT_MAX} value={draft.pendingActivities} onChange={(e) => set('pendingActivities', e.target.value)} error={errors.pendingActivities} data-testid="mom-pending" />
                <TextField label="Follow-up date" type="date" value={draft.followUpDate} onChange={(e) => set('followUpDate', e.target.value)} error={errors.followUpDate} className="sm:max-w-60" data-testid="mom-followup" />
              </div>
            </Card>
          ) : m ? (
            <Card>
              <CardHeader title="Minutes" />
              <div className="px-5 pb-5"><ContentView c={m} customer={customer} /></div>
            </Card>
          ) : null}

          {editing ? (
            <Card>
              <CardHeader title="Action items" subtitle="Who does what, by when." />
              <div className="flex flex-col gap-3 px-5 pb-5" data-testid="mom-items">
                {draft.actionItems.length === 0 && <p className="text-[13px] text-ink-secondary">No action items yet.</p>}
                {draft.actionItems.map((a, i) => (
                  <div key={a.key} className="flex flex-col gap-3 rounded-md border border-line p-3" data-testid="mom-item">
                    <div className="flex items-start gap-2">
                      <span className="mt-8 w-5 shrink-0 text-[12px] font-semibold text-ink-muted">{i + 1}.</span>
                      <TextAreaField label="Action" rows={2} maxLength={ITEM_MAX} className="min-w-0 flex-1" value={a.description} onChange={(e) => setItem(a.key, { description: e.target.value })}
                        error={errors[`actionItems[${i}].description`]} data-testid="mom-item-desc" />
                      <button type="button" className="mt-7 rounded p-1.5 text-ink-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remove action item ${i + 1}`}
                        onClick={() => setDraft((d) => ({ ...d, actionItems: d.actionItems.filter((x) => x.key !== a.key) }))}>
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 sm:pl-7">
                      <div className="sm:col-span-2" data-testid="mom-item-assignee">
                        <EmployeePicker label="Assigned to" value={a.assignee} onChange={(e) => setItem(a.key, { assignee: e })} error={errors[`actionItems[${i}].assigneeId`]} placeholder="Search employee" />
                      </div>
                      <TextField label="Due date" type="date" value={a.dueDate} onChange={(e) => setItem(a.key, { dueDate: e.target.value })} error={errors[`actionItems[${i}].dueDate`]} data-testid="mom-item-due" />
                      <SelectField label="Priority" value={a.priority} onChange={(e) => setItem(a.key, { priority: e.target.value as ActionPriority })} data-testid="mom-item-priority">
                        {(Object.keys(PRIORITY_LABEL) as ActionPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                      </SelectField>
                      <SelectField label="Status" value={a.status} onChange={(e) => setItem(a.key, { status: e.target.value as ActionStatus })} data-testid="mom-item-status">
                        {(Object.keys(ACTION_STATUS_LABEL) as ActionStatus[]).map((s) => <option key={s} value={s}>{ACTION_STATUS_LABEL[s]}</option>)}
                      </SelectField>
                    </div>
                  </div>
                ))}
                {errors.actionItems && <p className="text-[12.5px] text-danger">{errors.actionItems}</p>}
                <div>
                  <Button variant="subtle" size="sm" leftIcon={<ListPlus className="size-4" />} disabled={draft.actionItems.length >= ITEMS_MAX}
                    onClick={() => setDraft((d) => ({ ...d, actionItems: [...d.actionItems, { key: newKey(), id: null, description: '', assignee: null, dueDate: '', priority: 'MEDIUM', status: 'OPEN' }] }))}
                    data-testid="mom-add-item">
                    Add action item
                  </Button>
                </div>
              </div>
            </Card>
          ) : m ? (
            <Card>
              <CardHeader title="Action items" />
              <div className="px-5 pb-5"><ItemsView c={m} /></div>
            </Card>
          ) : null}

          {editing && (
            <div className="sticky bottom-[calc(5rem+var(--sab))] z-10 flex md:bottom-3 flex-col gap-2 rounded-lg border border-line bg-surface p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[12.5px] text-ink-secondary">{dirty ? 'You have unsaved changes.' : m ? 'All changes saved.' : 'Nothing saved yet.'} Every save is kept as a version.</p>
              <div className="flex flex-wrap gap-2">
                {v.canApprove && (
                  <Button variant="secondary" leftIcon={<CheckCircle2 className="size-4" />} disabled={busy || dirty} title={dirty ? 'Save your changes first' : undefined}
                    onClick={() => setApproving(true)} data-testid="minutes-approve">
                    Approve
                  </Button>
                )}
                <Button leftIcon={<Save className="size-4" />} loading={busy} disabled={busy || (!dirty && !!m) || stale} onClick={save} data-testid="minutes-save">
                  {m ? 'Save draft' : 'Create draft'}
                </Button>
              </div>
            </div>
          )}
          {!editing && v.canApprove && m?.status === 'DRAFT' && (
            <div className="flex justify-end">
              <Button leftIcon={<CheckCircle2 className="size-4" />} onClick={() => setApproving(true)} data-testid="minutes-approve">Approve</Button>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <MeetingFacts v={v} tz={tz} />
        </div>
      </div>

      <ConfirmDialog open={approving} onClose={() => setApproving(false)} title="Approve these minutes?" confirmLabel="Approve" tone="primary"
        onConfirm={async () => {
          try {
            await minutesApi.approve(meetingId, m!.version)
            toast.success('Minutes approved. They are now read-only.')
            reload()
          } catch (e) {
            if (e instanceof ApiError && e.code === 'CONFLICT') setStale(true)
            toast.error(errorMessage(e, 'The minutes could not be approved.'))
          }
        }}>
        <p>Approved minutes become read-only for everyone and can be read by every employee who can see this meeting. Nothing is sent to anyone automatically. To change them later, someone has to reopen them with a reason.</p>
      </ConfirmDialog>
      {m && <ReopenDialog open={reopening} onClose={() => setReopening(false)} meetingId={meetingId} version={m.version} onDone={reload} onStale={() => setStale(true)} />}
      {history && <HistoryDrawer meetingId={meetingId} customer={customer} tz={tz} onClose={() => setHistory(false)} />}
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-[13.5px] text-ink">{children}</dd>
    </div>
  )
}

function MeetingFacts({ v, tz }: { v: MinutesView; tz: string }) {
  const m = v.meeting
  const customer = isCustomerCategory(m.category)
  return (
    <Card>
      <CardHeader title="Meeting details" subtitle="Filled in from the meeting record." action={<FileText className="size-4 text-ink-muted" aria-hidden />} />
      <dl className="flex flex-col gap-3 px-5 pb-5" data-testid="minutes-facts">
        <Field label="Meeting ID">{m.meetingCode}</Field>
        <Field label="Category">{dbCategoryLabel[m.category as DbMeetingCategory] ?? m.category}</Field>
        <Field label="Date">{formatDate(m.actualStartUtc ?? m.startUtc, tz)}</Field>
        <Field label="Scheduled">{formatTime(m.startUtc, tz)} – {formatTime(m.endUtc, tz)} {zoneLabel(tz)}</Field>
        <Field label="Actual">
          {m.actualStartUtc ? `${formatTime(m.actualStartUtc, tz)} – ${m.actualEndUtc ? formatTime(m.actualEndUtc, tz) : 'not ended'}` : <Muted />}
          {m.actualStartUtc && minutesDuration(m.actualStartUtc, m.actualEndUtc) && <span className="text-ink-secondary"> ({minutesDuration(m.actualStartUtc, m.actualEndUtc)})</span>}
        </Field>
        <Field label="Host">{m.host}</Field>
        <Field label="Organiser">{m.organiser}</Field>
        {customer && <Field label="Customer">{m.customerName ?? <Muted />}</Field>}
        {customer && <Field label="Prarambh Main ID">{m.prarambhMainId ?? <Muted />}</Field>}
        <Field label={`Participants (${m.participants.length})`}>
          <ul className="mt-1 flex flex-col gap-1">
            {m.participants.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="min-w-0 truncate">{p.name}{p.role !== 'ATTENDEE' && <span className="text-ink-muted"> · {p.role === 'HOST' ? 'host' : 'co-host'}</span>}</span>
                <Badge tone={p.attended ? 'success' : 'neutral'}>{p.attended ? 'Attended' : 'Did not join'}</Badge>
              </li>
            ))}
          </ul>
        </Field>
      </dl>
    </Card>
  )
}

const Muted = () => <span className="italic text-ink-muted">{NOT_SPECIFIED}</span>

function Block({ title, value }: { title: string; value: string | null }) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      {value ? <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] leading-[22px] text-ink">{value}</p> : <p className="mt-1 text-[13px]"><Muted /></p>}
    </div>
  )
}

function ContentView({ c, customer }: { c: MinutesContent; customer: boolean }) {
  return (
    <div className="flex flex-col gap-4" data-testid="minutes-view">
      <Block title="Discussion summary" value={c.discussionSummary} />
      {(customer || c.customerRequirements) && <Block title="Customer requirements" value={c.customerRequirements} />}
      <Block title="Decisions" value={c.decisions} />
      <Block title="Pending activities" value={c.pendingActivities} />
      <Block title="Follow-up date" value={c.followUpDate ? formatCalendarDate(c.followUpDate) : null} />
    </div>
  )
}

function ItemsView({ c }: { c: MinutesContent }) {
  if (c.actionItems.length === 0) return <p className="text-[13px] text-ink-secondary">No action items.</p>
  return (
    <ol className="flex flex-col gap-2" data-testid="minutes-items-view">
      {c.actionItems.map((a, i) => (
        <li key={a.id ?? i} className="rounded-md border border-line p-3 text-[13px]">
          <p className="whitespace-pre-wrap break-words font-medium text-ink">{i + 1}. {a.description}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-secondary">
            <span>Assigned to: {a.assignee?.name ?? <Muted />}</span>
            <span>Due: {a.dueDate ? formatCalendarDate(a.dueDate) : <Muted />}</span>
            <Badge tone={a.priority === 'HIGH' ? 'danger' : a.priority === 'MEDIUM' ? 'warning' : 'neutral'}>{PRIORITY_LABEL[a.priority]}</Badge>
            <Badge tone={a.status === 'DONE' ? 'success' : a.status === 'IN_PROGRESS' ? 'info' : 'neutral'}>{ACTION_STATUS_LABEL[a.status]}</Badge>
          </p>
        </li>
      ))}
    </ol>
  )
}

function ReopenDialog({ open, onClose, meetingId, version, onDone, onStale }: { open: boolean; onClose: () => void; meetingId: string; version: number; onDone: () => void; onStale: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!reason.trim()) return setError('Enter the reason for reopening.')
    setBusy(true)
    try {
      await minutesApi.reopen(meetingId, version, reason.trim())
      toast.success('Minutes reopened as a draft. They need to be approved again.')
      setReason('')
      onClose()
      onDone()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') onStale()
      setError(fieldErrors(e).reason ?? errorMessage(e, 'The minutes could not be reopened.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Reopen approved minutes?" dismissible={!busy}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} data-testid="minutes-reopen-confirm">Reopen</Button></>}>
      <div className="flex flex-col gap-3">
        <p className="text-[13.5px] text-ink-secondary">The minutes become a draft again and must be approved again. The approved version stays in the history.</p>
        <TextAreaField label="Reason" rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setError(undefined) }} error={error} data-testid="minutes-reopen-reason" />
      </div>
    </Dialog>
  )
}

function HistoryDrawer({ meetingId, customer, tz, onClose }: { meetingId: string; customer: boolean; tz: string; onClose: () => void }) {
  const list = useLoader(() => minutesApi.versions(meetingId), [meetingId], 'Unable to load the history.')
  const [selected, setSelected] = useState<number | null>(null)
  const detail = useLoader(() => (selected ? minutesApi.version(meetingId, selected) : Promise.resolve(null)), [meetingId, selected], 'Unable to load this version.')
  return (
    <Dialog open onClose={onClose} title="Version history" description="Every save, approval and reopen is kept." variant="drawer">
      <div className="flex flex-col gap-4" data-testid="minutes-history-list">
        {list.error && <p className="text-[13px] text-danger">{list.error}</p>}
        {!list.data && !list.error && <Skeleton className="h-40" />}
        <ul className="flex flex-col gap-1.5">
          {list.data?.items.map((h: MinutesVersion) => (
            <li key={h.version}>
              <button type="button" onClick={() => setSelected(h.version)}
                className={`flex w-full items-start justify-between gap-2 rounded-md border px-3 py-2 text-left text-[13px] hover:bg-surface-muted ${selected === h.version ? 'border-brand-500 bg-brand-50' : 'border-line'}`}>
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">Version {h.version} · {VERSION_ACTION_LABEL[h.action]}</span>
                  <span className="block text-[12px] text-ink-secondary">{h.savedBy ?? 'unknown'} · {formatDateTime(h.savedUtc, tz)}</span>
                  {h.note && <span className="mt-0.5 block break-words text-[12px] text-ink-secondary">Reason: {h.note}</span>}
                </span>
                <Badge tone={h.status === 'APPROVED' ? 'success' : 'warning'}>{h.status === 'APPROVED' ? 'Approved' : 'Draft'}</Badge>
              </button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className="rounded-md border border-line p-4" data-testid="minutes-history-version">
            {detail.error && <p className="text-[13px] text-danger">{detail.error}</p>}
            {!detail.data && !detail.error && <Skeleton className="h-40" />}
            {detail.data && (
              <div className="flex flex-col gap-4">
                <ContentView c={detail.data.content} customer={customer} />
                <div><h3 className="mb-2 text-[13px] font-semibold text-ink">Action items</h3><ItemsView c={detail.data.content} /></div>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** Meeting detail page card: shows the minutes' status and opens the minutes page. Renders nothing while the feature is off. */
export function MinutesCard({ meetingId, tz }: { meetingId: string; tz: string }) {
  const [on, setOn] = useState(false)
  useEffect(() => { let alive = true; void roomFeaturesApi.get().then((f) => alive && setOn(f.meetingMinutes)); return () => { alive = false } }, [])
  if (!on) return null
  return <MinutesCardBody meetingId={meetingId} tz={tz} />
}

function MinutesCardBody({ meetingId, tz }: { meetingId: string; tz: string }) {
  const data = useLoader(() => minutesApi.get(meetingId), [meetingId], 'Unable to load the minutes.')
  const v = data.data
  // No access (customer meetings without permission) or nothing to show to this user: no card.
  if (data.error) return null
  if (v && !v.minutes && !v.canCreate && !v.draftInProgress) return null
  const to = `/meetings/${encodeURIComponent(meetingId)}/minutes`
  const m = v?.minutes
  return (
    <Card>
      <CardHeader title="Minutes of meeting" action={<FileText className="size-4 text-ink-muted" aria-hidden />} />
      <div className="flex flex-col gap-3 px-5 pb-5 text-[13px]" data-testid="minutes-card">
        {!v && <Skeleton className="h-10 w-full" />}
        {v && !m && v.draftInProgress && <p className="text-ink-secondary">The host is preparing the minutes. You can read them once they are approved.</p>}
        {v && !m && v.canCreate && <p className="text-ink-secondary">No minutes yet. Write the discussion, decisions and action items while they are fresh.</p>}
        {m && (
          <>
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={m.status === 'APPROVED' ? 'success' : 'warning'}>{m.status === 'APPROVED' ? 'Approved' : 'Draft – pending approval'}</Badge>
              <span className="text-ink-secondary">{m.actionItems.length} action item(s)</span>
            </p>
            <p className="text-[12px] text-ink-secondary">
              {m.status === 'APPROVED' ? `Approved by ${m.approvedBy ?? 'unknown'}, ${formatDateTime(m.approvedUtc, tz)}` : `Last saved by ${m.modifiedBy ?? 'unknown'}, ${formatDateTime(m.modifiedUtc, tz)}`}
            </p>
          </>
        )}
        {v && (m || v.canCreate) && (
          <div>
            <ButtonLink to={to} size="sm" variant={m ? 'secondary' : 'primary'} data-testid="minutes-open">
              {m ? (v.canEdit ? 'Open and edit' : 'Open minutes') : 'Write minutes'}
            </ButtonLink>
          </div>
        )}
      </div>
    </Card>
  )
}
