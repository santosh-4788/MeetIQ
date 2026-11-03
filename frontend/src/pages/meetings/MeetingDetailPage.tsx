import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import {
  ArrowLeft, BellRing, Building2, CalendarClock, CalendarX2, Check, CircleHelp, Clapperboard, Clock, DoorOpen, FileText, Hash, Link2, Pencil,
  ShieldAlert, Trash2, UserPlus, UserRound, Users, Video, X,
} from 'lucide-react'
import { bookingConflicts, meetingsApi, type Conflict, type MeetingDetail, type MeetingParticipant, type ResponseStatus } from '../../api/meetings'
import { errorMessage, fieldErrors } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Avatar } from '../../components/ui/Avatar'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { TextAreaField } from '../../components/ui/Form'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { CopyButton } from '../../components/ui/Secret'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatDateTime, formatDuration, formatRange, parseUtc, zoneLabel } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { MeetingRecordingsCard } from '../recordings/MeetingRecordingsCard'
import { ConflictDialog } from './Conflicts'
import { MeetingLinkCard } from './MeetingLinkShare'
import { CategoryBadge, ResponseBadge, StatusBadge, categoryMeta, dbCategoryLabel, recordingLabel, useTimeZone } from './meta'

/** /meetings/:id — everything about one meeting, RSVP and host actions. "Join" opens the video room (/meetings/:id/room). */
export function MeetingDetailPage() {
  const { id = '' } = useParams()
  const tz = useTimeZone()
  const meeting = useLoader(() => meetingsApi.get(id), [id], 'Unable to load the meeting.')
  const m = meeting.data

  if (!m && (meeting.error || !meeting.loading))
    return (
      <div className="flex flex-col gap-5">
        <BackLink />
        <Card>
          <ErrorState title="Unable to load the meeting" description={meeting.error ?? 'The meeting could not be loaded.'} onRetry={meeting.reload} />
        </Card>
      </div>
    )
  if (!m) return <DetailSkeleton />
  return <Detail m={m} tz={tz} reload={meeting.reload} reloading={meeting.loading} />
}

function BackLink() {
  return (
    <div>
      <ButtonLink to="/meetings" variant="ghost" size="sm" leftIcon={<ArrowLeft className="size-4" />} className="-ml-2">
        My Meetings
      </ButtonLink>
    </div>
  )
}

function Detail({ m, tz, reload, reloading }: { m: MeetingDetail; tz: string; reload: () => void; reloading: boolean }) {
  const toast = useToast()
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const cat = categoryMeta[m.categoryGroup] ?? categoryMeta.INTERNAL
  const start = parseUtc(m.startUtc)
  const end = parseUtc(m.endUtc)
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000)

  return (
    <div className={cn('flex flex-col gap-5 transition-opacity', reloading && 'opacity-80')}>
      <BackLink />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 border-l-4 pl-4" style={{ borderColor: cat.color }}>
          <div className="flex flex-wrap items-center gap-2">
            <CategoryBadge group={m.categoryGroup} category={m.category} />
            <StatusBadge status={m.status} />
            {m.scheduleVersion > 1 && <Badge tone="warning">Rescheduled</Badge>}
          </div>
          <h1 className={cn('mt-2 text-[24px] leading-8 font-bold tracking-[-0.015em] break-words', m.status === 'CANCELLED' ? 'text-ink-secondary line-through' : 'text-ink')}>{m.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13.5px] text-ink-secondary">
            <Clock className="size-4 shrink-0" aria-hidden />
            {formatRange(m.startUtc, m.endUtc, tz)} {zoneLabel(tz)} · {formatDuration(minutes)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {m.my.canEdit && (
            <ButtonLink to={`/meetings/${m.id}/edit`} variant="secondary" leftIcon={<Pencil className="size-4" />}>
              {m.status === 'DRAFT' ? 'Edit draft' : 'Edit / reschedule'}
            </ButtonLink>
          )}
          {m.my.canCancel && (
            <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" leftIcon={<CalendarX2 className="size-4" />} onClick={() => (setReason(''), setCancelling(true))}>
              Cancel meeting
            </Button>
          )}
        </div>
      </div>

      {m.status === 'CANCELLED' && (
        <Alert tone="danger" title="This meeting was cancelled">
          {m.cancelReason ? `Reason: ${m.cancelReason}` : 'No reason was recorded.'}
        </Alert>
      )}
      {m.status === 'DRAFT' && (
        <Alert tone="info" title="Draft">
          Only you can see this meeting. Nobody has been invited yet: edit the draft and choose "Schedule meeting" to send the invitations.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-5 xl:col-span-2">
          <DetailsCard m={m} tz={tz} />
          {(m.agenda || m.description) && (
            <Card>
              <CardHeader title="Agenda and description" />
              <div className="flex flex-col gap-4 px-5 pb-5 text-[13.5px] leading-[22px] text-ink">
                {m.agenda && (
                  <div>
                    <p className="eyebrow mb-1 text-ink-muted">Agenda</p>
                    <p className="whitespace-pre-line break-words">{m.agenda}</p>
                  </div>
                )}
                {m.description && (
                  <div>
                    <p className="eyebrow mb-1 text-ink-muted">Description</p>
                    <p className="whitespace-pre-line break-words">{m.description}</p>
                  </div>
                )}
              </div>
            </Card>
          )}
          <ParticipantsCard m={m} tz={tz} reload={reload} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {m.my.canRespond && <RsvpCard m={m} reload={reload} />}
          {m.status !== 'DRAFT' && <JoinCard m={m} tz={tz} reload={reload} />}
          {m.my.canShareLink && <MeetingLinkCard meetingId={m.id} title={m.title} />}
          {m.status !== 'DRAFT' && <RemindersCard m={m} tz={tz} />}
          {m.status !== 'DRAFT' && <MeetingRecordingsCard meetingId={m.id} tz={tz} />}
        </div>
      </div>

      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel this meeting?"
        confirmLabel="Cancel meeting"
        onConfirm={async () => {
          if (!reason.trim()) throw new Error('Give a reason for cancelling. Participants see it in the cancellation e-mail.')
          await meetingsApi.cancel(m.id, reason.trim())
          toast.success(m.status === 'SCHEDULED' ? 'Meeting cancelled. Participants have been notified.' : 'Draft cancelled.')
          reload()
        }}
      >
        <p>
          <strong className="text-ink">{m.title}</strong> on {formatRange(m.startUtc, m.endUtc, tz)} {zoneLabel(tz)}.
        </p>
        <p className="mt-1.5">Reminders stop, join links stop working{m.status === 'SCHEDULED' ? ' and everyone is e-mailed and notified' : ''}. This cannot be undone.</p>
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className="mt-3" hint="Required. Shared with the participants." />
      </ConfirmDialog>
    </div>
  )
}

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-ink-muted">{icon}</span>
      <div className="min-w-0">
        <dt className="text-[12px] text-ink-secondary">{label}</dt>
        <dd className="text-[13.5px] font-medium break-words text-ink">{children}</dd>
      </div>
    </div>
  )
}

function DetailsCard({ m, tz }: { m: MeetingDetail; tz: string }) {
  return (
    <Card>
      <CardHeader title="Details" />
      <dl className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2">
        <InfoRow icon={<Hash className="size-4" />} label="Meeting code">
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono tabular-nums">{m.meetingCode}</span>
            <CopyButton text={m.meetingCode} label="Copy" variant="subtle" className="h-7 px-2 text-[12px]" />
          </span>
        </InfoRow>
        <InfoRow icon={<CalendarClock className="size-4" />} label={`When (${zoneLabel(tz)})`}>
          {formatRange(m.startUtc, m.endUtc, tz)}
          {m.timeZoneId !== tz && <span className="block text-[12px] font-normal text-ink-secondary">Meeting zone: {m.timeZoneId}</span>}
        </InfoRow>
        <InfoRow icon={<UserRound className="size-4" />} label="Host">{m.host.name}</InfoRow>
        <InfoRow icon={<UserRound className="size-4" />} label="Organiser">{m.createdBy.name}</InfoRow>
        <InfoRow icon={<FileText className="size-4" />} label="Category">{dbCategoryLabel[m.category] ?? m.category}</InfoRow>
        {m.department && <InfoRow icon={<Building2 className="size-4" />} label="Department">{m.department}</InfoRow>}
        {m.customer && (
          <InfoRow icon={<UserRound className="size-4" />} label="Customer">
            {m.customer.name}
            {m.customer.customerRef && <span className="ml-1.5 text-[12px] font-normal text-ink-secondary">{m.customer.customerRef}</span>}
          </InfoRow>
        )}
        {m.policyNumber && <InfoRow icon={<FileText className="size-4" />} label="Policy number"><span className="tabular-nums">{m.policyNumber}</span></InfoRow>}
        {m.purpose && <InfoRow icon={<FileText className="size-4" />} label="Purpose">{m.purpose}</InfoRow>}
        <InfoRow icon={<Clapperboard className="size-4" />} label="Recording policy">
          {recordingLabel[m.recordingPolicy]}
          {m.recordingPolicy !== 'NONE' && <span className="block text-[12px] font-normal text-ink-secondary">Stored only: meetings are not recorded yet (recording module pending{m.customer ? '; customer recording pending legal approval' : ''}).</span>}
        </InfoRow>
        <InfoRow icon={<DoorOpen className="size-4" />} label="Waiting room">{m.waitingRoomEnabled ? 'On: the host admits customers and guests' : 'Off'}</InfoRow>
        {m.overrideConflictReason && (
          <InfoRow icon={<ShieldAlert className="size-4" />} label="Booked despite a conflict">{m.overrideConflictReason}</InfoRow>
        )}
        <InfoRow icon={<Clock className="size-4" />} label="Created">{formatDateTime(m.createdUtc, tz)}{m.modifiedUtc && <span className="block text-[12px] font-normal text-ink-secondary">Last changed {formatDateTime(m.modifiedUtc, tz)}</span>}</InfoRow>
      </dl>
    </Card>
  )
}

// ---- RSVP --------------------------------------------------------------------------

function RsvpCard({ m, reload }: { m: MeetingDetail; reload: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<ResponseStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = m.my.responseStatus
  const isHost = m.my.role === 'HOST'

  async function respond(r: Exclude<ResponseStatus, 'PENDING'>) {
    setBusy(r)
    setError(null)
    try {
      await meetingsApi.respond(m.id, r)
      toast.success(r === 'ACCEPTED' ? 'You accepted the invitation.' : r === 'DECLINED' ? 'You declined the invitation.' : 'You replied tentatively.')
      reload()
    } catch (e) {
      setError(errorMessage(e, 'Your reply could not be saved.'))
    } finally {
      setBusy(null)
    }
  }

  const options: { r: Exclude<ResponseStatus, 'PENDING'>; label: string; done: string; icon: ReactNode }[] = [
    { r: 'ACCEPTED', label: 'Accept', done: 'Accepted', icon: <Check className="size-4" /> },
    { r: 'TENTATIVE', label: 'Tentative', done: 'Tentative', icon: <CircleHelp className="size-4" /> },
    { r: 'DECLINED', label: 'Decline', done: 'Declined', icon: <X className="size-4" /> },
  ]

  // Hosts always attend: there is nothing to answer, so show a statement instead of buttons that cannot change anything.
  if (isHost)
    return (
      <Card>
        <CardHeader title="Your response" action={current ? <ResponseBadge response={current} /> : undefined} />
        <p className="px-5 pb-5 text-[13px] text-ink-secondary">You are hosting this meeting, so you are attending. To call it off, use Cancel meeting.</p>
      </Card>
    )

  return (
    <Card>
      <CardHeader title="Your response" action={current ? <ResponseBadge response={current} /> : undefined} />
      <div className="flex flex-col gap-3 px-5 pb-5">
        <div role="group" aria-label="Reply to the invitation" className="grid grid-cols-3 gap-2">
          {options.map((o) => {
            const selected = current === o.r
            const disabled = !!busy
            return (
              <Button
                key={o.r}
                size="sm"
                variant={selected ? (o.r === 'DECLINED' ? 'danger' : 'primary') : 'secondary'}
                aria-pressed={selected}
                loading={busy === o.r}
                disabled={disabled}
                leftIcon={o.icon}
                onClick={() => !selected && void respond(o.r)}
                title={selected ? 'This is your current reply' : undefined}
                className={selected ? 'cursor-default' : undefined}
              >
                {selected ? o.done : o.label}
              </Button>
            )
          })}
        </div>
        <p className="text-[12px] text-ink-secondary">{current && current !== 'PENDING' ? 'You can change your reply at any time before the meeting.' : 'Let the organiser know whether you will attend.'}</p>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Card>
  )
}

function JoinCard({ m, tz, reload }: { m: MeetingDetail; tz: string; reload: () => void }) {
  const j = m.join
  // Opened before the room opens: refresh at the opening time so "Join" becomes available without a manual reload.
  useEffect(() => {
    if (j.reason !== 'TOO_EARLY') return
    const wait = parseUtc(j.opensUtc).getTime() - Date.now() + 1500
    if (wait <= 0 || wait > 24 * 3_600_000) return
    const t = window.setTimeout(reload, wait)
    return () => window.clearTimeout(t)
  }, [j.reason, j.opensUtc, reload])
  const note = j.joinable
    ? m.status === 'LIVE'
      ? 'The meeting is in progress.'
      : m.my.canHostRoom
        ? 'You are a host: joining starts the meeting. Customers and guests wait until you admit them.'
        : 'The room is open. The meeting starts when the host joins.'
    : j.reason === 'TOO_EARLY'
      ? `The room opens at ${formatDateTime(j.opensUtc, tz)} (${zoneLabel(tz)}).`
      : (j.message ?? 'This meeting cannot be joined.')
  return (
    <Card>
      <CardHeader title="Join" action={m.status === 'LIVE' ? <Badge tone="live" dot>Live</Badge> : undefined} />
      <div className="flex flex-col gap-3 px-5 pb-5">
        {j.joinable ? (
          <ButtonLink to={`/meetings/${m.id}/room`} fullWidth leftIcon={<Video className="size-4" />} aria-describedby={`join-note-${m.id}`}>
            {m.status !== 'LIVE' && m.my.canHostRoom ? 'Start meeting' : 'Join meeting'}
          </ButtonLink>
        ) : (
          <Button fullWidth disabled leftIcon={<Video className="size-4" />} aria-describedby={`join-note-${m.id}`}>
            Join meeting
          </Button>
        )}
        <p id={`join-note-${m.id}`} className="text-[12.5px] text-ink-secondary">
          {note} Meeting code <span className="font-mono text-ink">{m.meetingCode}</span>.
        </p>
      </div>
    </Card>
  )
}

function RemindersCard({ m, tz }: { m: MeetingDetail; tz: string }) {
  const r = m.reminders
  const rows = [
    { label: 'Pending', value: r.pending },
    { label: 'Sent', value: r.sent },
    { label: 'Failed', value: r.failed },
    { label: 'Cancelled', value: r.cancelled },
  ]
  return (
    <Card>
      <CardHeader title="Reminders" subtitle="In-app and e-mail, for the current schedule." action={<BellRing className="size-4 text-ink-muted" aria-hidden />} />
      <div className="px-5 pb-5">
        <dl className="grid grid-cols-4 gap-2">
          {rows.map((x) => (
            <div key={x.label} className="rounded-md bg-canvas px-2 py-2 text-center">
              <dt className="text-[11.5px] text-ink-secondary">{x.label}</dt>
              <dd className={cn('text-[17px] font-bold tabular-nums', x.label === 'Failed' && x.value > 0 ? 'text-danger' : 'text-ink')}>{x.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[12.5px] text-ink-secondary">{r.nextDueUtc ? `Next reminder: ${formatDateTime(r.nextDueUtc, tz)}` : 'No reminders pending.'}</p>
      </div>
    </Card>
  )
}

// ---- Participants --------------------------------------------------------------------

const typeLabel: Record<MeetingParticipant['type'], string> = { EMPLOYEE: 'Employee', CUSTOMER: 'Customer', GUEST: 'Guest' }

function InvitationBadge({ p, m }: { p: MeetingParticipant; m: MeetingDetail }) {
  if (p.type === 'EMPLOYEE' || !m.my.canEdit) return null
  if (!p.invitation) return <Badge tone="neutral">{m.status === 'DRAFT' ? 'Link not sent yet' : 'No join link (no e-mail)'}</Badge>
  const inv = p.invitation
  const tone = inv.status === 'ACTIVE' ? 'success' : inv.status === 'REVOKED' ? 'danger' : 'neutral'
  const label = inv.status === 'ACTIVE' ? 'Link active' : inv.status === 'REVOKED' ? 'Link withdrawn' : 'Link expired'
  return (
    <Badge tone={tone}>
      <Link2 className="size-3" aria-hidden /> {label}
      {inv.useCount > 0 && ` · opened ${inv.useCount}×`}
    </Badge>
  )
}

function ParticipantsCard({ m, tz, reload }: { m: MeetingDetail; tz: string; reload: () => void }) {
  const toast = useToast()
  const [removing, setRemoving] = useState<MeetingParticipant | null>(null)
  const [adding, setAdding] = useState(false)
  const editable = m.my.canEdit && (m.status === 'DRAFT' || parseUtc(m.endUtc).getTime() > Date.now())
  const counts = m.participants.reduce<Record<ResponseStatus, number>>((acc, p) => ({ ...acc, [p.responseStatus]: (acc[p.responseStatus] ?? 0) + 1 }), { PENDING: 0, ACCEPTED: 0, TENTATIVE: 0, DECLINED: 0 })

  return (
    <Card>
      <CardHeader
        title="Participants"
        subtitle={`${m.participants.length} invited · ${counts.ACCEPTED} accepted · ${counts.TENTATIVE} tentative · ${counts.DECLINED} declined · ${counts.PENDING} awaiting reply`}
        action={editable ? <Button size="sm" variant="subtle" leftIcon={<UserPlus className="size-3.5" />} onClick={() => setAdding(true)}>Add</Button> : <Users className="size-4 text-ink-muted" aria-hidden />}
      />
      <ul className="divide-y divide-line border-t border-line">
        {m.participants.map((p) => {
          const removable = editable && p.role !== 'HOST' && p.type !== 'CUSTOMER'
          return (
            <li key={p.id} className="flex items-start gap-3 px-5 py-3">
              <Avatar name={p.name} size={34} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold text-ink">
                  {p.name}
                  {p.id === m.my.participantId && <span className="ml-1 font-normal text-ink-secondary">(you)</span>}
                </p>
                <p className="truncate text-[12px] text-ink-secondary">
                  {typeLabel[p.type]}
                  {p.department && ` · ${p.department}`}
                  {p.email && ` · ${p.email}`}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {p.role !== 'ATTENDEE' && <Badge tone="brand">{p.role === 'HOST' ? 'Host' : 'Co-host'}</Badge>}
                  <ResponseBadge response={p.responseStatus} />
                  <InvitationBadge p={p} m={m} />
                </div>
                {p.invitation && m.my.canEdit && (
                  <p className="mt-1 text-[11.5px] text-ink-muted">
                    Link expires {formatDateTime(p.invitation.expiresUtc, tz)}
                    {p.invitation.lastUsedUtc && ` · last opened ${formatDateTime(p.invitation.lastUsedUtc, tz)}`}
                  </p>
                )}
              </div>
              {removable && (
                <button type="button" onClick={() => setRemoving(p)} aria-label={`Remove ${p.name}`} title={`Remove ${p.name}`} className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-danger-soft hover:text-danger">
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          )
        })}
      </ul>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        confirmLabel="Remove participant"
        onConfirm={async () => {
          if (!removing) return
          await meetingsApi.removeParticipant(m.id, removing.id)
          toast.success(`${removing.name} was removed.`)
          reload()
        }}
      >
        <p>
          {m.status === 'SCHEDULED' ? 'They are told by e-mail and notification, their reminders stop' : 'Their reminders stop'}
          {removing?.type === 'GUEST' ? ' and their join link stops working.' : '.'}
        </p>
      </ConfirmDialog>

      <AddParticipantsDialog
        open={adding}
        m={m}
        tz={tz}
        onClose={(added) => {
          setAdding(false)
          if (added) reload()
        }}
      />
    </Card>
  )
}

type GuestRow = { key: number; name: string; email: string }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function AddParticipantsDialog({ open, m, tz, onClose }: { open: boolean; m: MeetingDetail; tz: string; onClose: (added: boolean) => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const [people, setPeople] = useState<PickedEmployee[]>([])
  const [guests, setGuests] = useState<GuestRow[]>([])
  const [seq, setSeq] = useState(1)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)

  useEffect(() => {
    if (!open) return
    setPeople([])
    setGuests([])
    setErrors({})
    setError(null)
  }, [open])

  const existing = m.participants.map((p) => p.employeeId).filter((x): x is string => !!x)

  async function send(override?: string) {
    const r = await meetingsApi.addParticipants(m.id, {
      employeeIds: people.map((p) => p.id),
      guests: guests.map((g) => ({ name: g.name.trim(), email: g.email.trim() })),
      overrideConflicts: override ? true : undefined,
      overrideReason: override,
    })
    const outside = [...new Set(r.warnings.filter((w) => w.type === 'OUTSIDE_WORKING_HOURS').map((w) => w.employeeName))]
    toast.success(`${r.added} participant${r.added === 1 ? '' : 's'} added.${outside.length ? ` Note: outside working hours for ${outside.join(', ')}.` : ''}`)
    onClose(true)
  }

  async function submit() {
    const v: Record<string, string> = {}
    guests.forEach((g, i) => {
      if (!g.name.trim()) v[`guests[${i}].name`] = 'Guest name is required.'
      if (!EMAIL_RE.test(g.email.trim())) v[`guests[${i}].email`] = 'Enter a valid e-mail address.'
    })
    setErrors(v)
    if (Object.keys(v).length) return
    if (!people.length && !guests.length) {
      setError('Choose at least one colleague or add a guest.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await send()
    } catch (e) {
      const list = bookingConflicts(e)
      if (list.length) setConflicts(list)
      else {
        setErrors(fieldErrors(e))
        setError(errorMessage(e, 'The participants could not be added.'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={() => onClose(false)}
        title="Add participants"
        description={m.status === 'SCHEDULED' ? 'New colleagues are checked for conflicts. Everyone added is invited at once.' : 'They are invited when the draft is scheduled.'}
        size="lg"
        dismissible={!busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
            <Button loading={busy} onClick={() => void submit()} leftIcon={<UserPlus className="size-4" />}>Add participants</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <EmployeePicker
            label="Colleagues"
            clearOnSelect
            onChange={(p) => p && setPeople((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p]))}
            excludeIds={[...existing, ...people.map((p) => p.id)]}
            error={errors.employeeIds || undefined}
          />
          {people.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {people.map((p) => (
                <li key={p.id} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-1.5 text-[13px] text-ink">
                  <Avatar name={p.displayName} size={22} />
                  {p.displayName}
                  <button type="button" onClick={() => setPeople((xs) => xs.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.displayName}`} className="flex size-6 items-center justify-center rounded-full text-ink-muted hover:bg-navy-900/5 hover:text-ink">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line pt-4">
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-semibold text-ink">External guests</p>
              <Button size="sm" variant="subtle" leftIcon={<UserPlus className="size-3.5" />} onClick={() => (setGuests((g) => [...g, { key: seq, name: '', email: '' }]), setSeq((s) => s + 1))}>
                Add guest
              </Button>
            </div>
            <ul className="mt-3 flex flex-col gap-3">
              {guests.map((g, i) => (
                <li key={g.key} className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <TextField label={`Guest ${i + 1} name`} value={g.name} onChange={(e) => setGuests((xs) => xs.map((x) => (x.key === g.key ? { ...x, name: e.target.value } : x)))} error={errors[`guests[${i}].name`]} autoComplete="off" />
                  <TextField label={`Guest ${i + 1} e-mail`} type="email" value={g.email} onChange={(e) => setGuests((xs) => xs.map((x) => (x.key === g.key ? { ...x, email: e.target.value } : x)))} error={errors[`guests[${i}].email`]} autoComplete="off" />
                  <Button variant="ghost" className="sm:mt-[26px]" aria-label={`Remove guest ${i + 1}`} leftIcon={<Trash2 className="size-4" />} onClick={() => setGuests((xs) => xs.filter((x) => x.key !== g.key))}>
                    <span className="sm:hidden">Remove</span>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Dialog>
      <ConflictDialog
        conflicts={conflicts}
        tz={tz}
        canOverride={can('meetings.override.conflict')}
        onClose={() => setConflicts(null)}
        onOverride={async (reason) => {
          await send(reason)
          setConflicts(null)
        }}
      />
    </>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading meeting">
      <Skeleton className="h-6 w-32" />
      <div>
        <Skeleton className="h-6 w-40 rounded-full" />
        <Skeleton className="mt-3 h-8 w-2/3" />
        <Skeleton className="mt-2 h-4 w-1/2" />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mb-3 h-10 w-full" />)}
        </Card>
        <Card className="p-5">
          <Skeleton className="h-24 w-full" />
        </Card>
      </div>
    </div>
  )
}
