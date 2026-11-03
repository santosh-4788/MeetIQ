import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { CalendarClock, Clock, DoorOpen, Headphones, Link2Off, Lock, UserRound, Video } from 'lucide-react'
import { linkApi, type LinkInfo } from '../api/meetings'
import { ApiError } from '../api/types'
import { Button } from '../components/ui/Button'
import { Alert, Badge, Skeleton } from '../components/ui/Feedback'
import { DEFAULT_TIME_ZONE, SUPPORT } from '../config'
import { AuthCard, AuthHeading } from '../layouts/AuthLayout'
import { formatDayDate, formatRange, formatTime, zoneLabel } from '../lib/format'
import { useLoader } from '../lib/useLoader'
import { RoomLoading } from './room/RoomScreens'

const GuestRoom = lazy(() => import('./room/GuestRoom'))

/**
 * /m/:token — the shareable meeting link. Anyone with it can ask to join (name + device check), then waits until a host admits
 * them. Signed-in colleagues who are already participants go straight to their normal meeting room. Nothing about the other
 * participants is shown before admission.
 */
export function LinkJoinPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [entering, setEntering] = useState(false)
  // One waiting-room place per visit: asking again after leaving reuses the personal token instead of creating a new guest.
  const issued = useRef<string | null>(null)
  // The name typed by a guest is kept for this visit (asking again after leaving starts from it).
  const typedName = useRef<string | null>(null)
  const info = useLoader(
    () => linkApi.get(token).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return { notFound: e.message } as const
      throw e
    }),
    [token],
    'Unable to open this meeting link.',
  )
  const opensAt = info.data && !('notFound' in info.data) && !info.data.joinableNow ? new Date(info.data.joinOpensUtc).getTime() : 0
  const reload = info.reload
  useEffect(() => {
    const wait = opensAt - Date.now() + 1500
    if (!opensAt || wait <= 0 || wait > 24 * 3_600_000) return
    const t = window.setTimeout(reload, wait)
    return () => window.clearTimeout(t)
  }, [opensAt, reload])

  if (info.loading && !info.data)
    return (
      <AuthCard>
        <div aria-busy="true" aria-label="Loading the meeting" className="flex flex-col gap-3">
          <Skeleton className="size-12 rounded-lg" />
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="mt-3 h-24 w-full" />
        </div>
      </AuthCard>
    )

  if (!info.data || 'notFound' in info.data)
    return (
      <AuthCard>
        <AuthHeading
          tone={info.data ? 'warning' : 'danger'}
          icon={<Link2Off className="size-6" />}
          title={info.data ? 'This meeting link no longer works' : 'Unable to open the meeting link'}
          description={info.data && 'notFound' in info.data ? info.data.notFound : info.error}
        />
        {!info.data && <Button variant="secondary" onClick={info.reload}>Try again</Button>}
        <p className="mt-6 text-[12px] text-ink-muted">
          Need help? Contact the person who sent you the link or <a href={`mailto:${SUPPORT.email}`} className="font-medium text-brand-700 hover:underline">{SUPPORT.email}</a>.
        </p>
      </AuthCard>
    )

  const m: LinkInfo = info.data
  // Already invited (signed in): their own room page, no waiting room.
  if (m.meetingId) return <Navigate to={`/meetings/${m.meetingId}/room`} replace />

  if (entering)
    return (
      <Suspense fallback={<RoomLoading />}>
        <GuestRoom
          token={issued.current ?? ''}
          info={{ ...m, participantType: m.participantType === 'EMPLOYEE' ? 'EMPLOYEE' : 'GUEST', displayName: typedName.current ?? m.displayName }}
          audioOnly={m.audioOnly}
          backLabel="Back"
          footnote="The host lets you in from the waiting room. Your camera and microphone are used only while you are in the meeting."
          getToken={async (name) => {
            if (m.participantType === 'GUEST') typedName.current = name
            if (issued.current) return issued.current
            const r = await linkApi.request(token, m.participantType === 'GUEST' ? name : undefined)
            if (r.joinToken === undefined) {
              navigate(`/meetings/${r.meetingId}/room`, { replace: true })
              return null
            }
            issued.current = r.joinToken
            return r.joinToken
          }}
          onClose={() => {
            setEntering(false)
            info.reload()
          }}
        />
      </Suspense>
    )

  const tz = m.timeZoneId || DEFAULT_TIME_ZONE
  const label = zoneLabel(tz)
  const open = m.status === 'SCHEDULED' || m.status === 'LIVE'
  const canJoin = open && m.joinableNow && m.videoAvailable && !m.locked

  return (
    <AuthCard wide>
      <AuthHeading
        icon={<Video className="size-6" />}
        tone="brand"
        title={m.title}
        description={
          <>
            You have been invited to a OneInsure Connect meeting.{' '}
            {m.status === 'LIVE' ? <Badge tone="live" dot>Live now</Badge> : m.status === 'SCHEDULED' ? <Badge tone="brand">{m.kind === 'INSTANT' ? 'Instant meeting' : 'Scheduled'}</Badge> : null}
          </>
        }
      />
      <dl className="flex flex-col gap-3 rounded-md border border-line bg-surface-muted p-4">
        <Row icon={<CalendarClock className="size-4" />} label={`When (${label})`}>{formatRange(m.startUtc, m.endUtc, tz)}</Row>
        <Row icon={<UserRound className="size-4" />} label="Organiser">{m.organiser}</Row>
        <Row icon={<DoorOpen className="size-4" />} label="Waiting room">The host lets you in. Please wait on the next screen until they do.</Row>
        {m.audioOnly && <Row icon={<Headphones className="size-4" />} label="Audio only">Cameras are not used in this meeting.</Row>}
      </dl>

      <div className="mt-5">
        {m.status === 'CANCELLED' ? (
          <Alert tone="danger" title="This meeting was cancelled">Contact the organiser if you still need to meet.</Alert>
        ) : m.status === 'ENDED' ? (
          <Alert tone="info" title="This meeting has ended">Thank you. Contact the organiser if you need to meet again.</Alert>
        ) : m.locked ? (
          <Alert tone="warning" title="The meeting is locked"><span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" /> The host is not letting anyone new in right now.</span></Alert>
        ) : (
          <>
            <Button fullWidth size="lg" disabled={!canJoin} leftIcon={<Video className="size-5" />} onClick={() => setEntering(true)} data-testid="link-join">
              {m.participantType === 'EMPLOYEE' ? `Continue as ${m.displayName ?? 'yourself'}` : 'Join meeting'}
            </Button>
            <p className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-ink-secondary">
              <Clock className="mt-0.5 size-4 shrink-0 text-brand-500" aria-hidden />
              <span>
                {!m.videoAvailable ? (
                  <>Video meetings are temporarily unavailable. Please try again later.</>
                ) : m.joinableNow ? (
                  <>You join from this browser: no app or account needed. You can check your camera and microphone first.</>
                ) : new Date(m.joinOpensUtc).getTime() > Date.now() ? (
                  <>
                    Joining opens at <strong className="text-ink">{formatTime(m.joinOpensUtc, tz)} {label}</strong> on {formatDayDate(m.joinOpensUtc, tz)}.
                  </>
                ) : (
                  <>The time for joining this meeting has passed.</>
                )}
              </span>
            </p>
          </>
        )}
      </div>
    </AuthCard>
  )
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-ink-muted">{icon}</span>
      <div className="min-w-0">
        <dt className="text-[12px] text-ink-secondary">{label}</dt>
        <dd className="text-[14px] font-medium break-words text-ink">{children}</dd>
      </div>
    </div>
  )
}
