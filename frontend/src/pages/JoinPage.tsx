import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { CalendarClock, CalendarX2, Clock, DoorOpen, Hash, Link2Off, UserRound, Video } from 'lucide-react'
import { ApiError } from '../api/types'
import { joinApi } from '../api/meetings'
import { Button } from '../components/ui/Button'
import { Alert, Badge, Skeleton } from '../components/ui/Feedback'
import { DEFAULT_TIME_ZONE, SUPPORT } from '../config'
import { AuthCard, AuthHeading } from '../layouts/AuthLayout'
import { formatRange, formatTime, formatDayDate, zoneLabel } from '../lib/format'
import { useLoader } from '../lib/useLoader'
import { RoomLoading } from './room/RoomScreens'

// The video room (LiveKit) is downloaded only when the customer/guest actually joins.
const GuestRoom = lazy(() => import('./room/GuestRoom'))

/**
 * /join/:token — public page for customers and guests (no sign-in). Shows only what the API returns for a valid,
 * unexpired link. "Join meeting" opens the pre-join check, the waiting room (if on) and the video room.
 */
export function JoinPage() {
  const { token = '' } = useParams()
  const [entering, setEntering] = useState(false)
  // 404 = unknown, expired or withdrawn link: a friendly dead end, not a retryable error.
  const info = useLoader(
    () => joinApi.get(token).catch((e: unknown) => {
      // The API explains why a genuine link no longer works (rescheduled, cancelled, expired).
      if (e instanceof ApiError && e.status === 404) return { notFound: e.message } as const
      throw e
    }),
    [token],
    'Unable to open this invitation.',
  )
  const opensAt = info.data && !('notFound' in info.data) && !info.data.joinableNow ? new Date(info.data.joinOpensUtc).getTime() : 0
  const reload = info.reload
  // Opened early: refresh when joining opens, so "Join meeting" becomes available on its own.
  useEffect(() => {
    const wait = opensAt - Date.now() + 1500
    if (!opensAt || wait <= 0 || wait > 24 * 3_600_000) return
    const t = window.setTimeout(reload, wait)
    return () => window.clearTimeout(t)
  }, [opensAt, reload])

  if (info.loading && !info.data)
    return (
      <AuthCard>
        <div aria-busy="true" aria-label="Loading invitation" className="flex flex-col gap-3">
          <Skeleton className="size-12 rounded-lg" />
          <Skeleton className="h-7 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-3 h-24 w-full" />
        </div>
      </AuthCard>
    )

  if (!info.data || 'notFound' in info.data)
    return <JoinError notFound={!!info.data} message={info.data && 'notFound' in info.data ? info.data.notFound : info.error} onRetry={info.reload} />

  const m = info.data
  const canJoin = m.joinableNow && m.videoAvailable && (m.status === 'SCHEDULED' || m.status === 'LIVE')
  if (entering)
    return (
      <Suspense fallback={<RoomLoading />}>
        <GuestRoom
          token={token}
          info={m}
          onClose={() => {
            setEntering(false)
            info.reload()
          }}
        />
      </Suspense>
    )
  // Shown in IST, the zone used in the invitation e-mail (unless the meeting has another zone).
  const tz = m.timeZoneId || DEFAULT_TIME_ZONE
  const label = zoneLabel(tz)
  const status: Record<typeof m.status, ReactNode> = {
    SCHEDULED: <Badge tone="brand">Scheduled</Badge>,
    LIVE: <Badge tone="live" dot>Live now</Badge>,
    CANCELLED: <Badge tone="danger">Cancelled</Badge>,
    ENDED: <Badge tone="neutral">Ended</Badge>,
  }

  return (
    <AuthCard wide>
      <AuthHeading
        icon={m.status === 'CANCELLED' ? <CalendarX2 className="size-6" /> : <Video className="size-6" />}
        tone={m.status === 'CANCELLED' ? 'danger' : 'brand'}
        title={m.title}
        description={<>You have been invited to a OneInsure meeting. {status[m.status]}</>}
      />
      <dl className="flex flex-col gap-3 rounded-md border border-line bg-surface-muted p-4">
        <Row icon={<CalendarClock className="size-4" />} label={`When (${label})`}>{formatRange(m.startUtc, m.endUtc, tz)}</Row>
        <Row icon={<UserRound className="size-4" />} label="Organiser">{m.organiser}</Row>
        <Row icon={<Hash className="size-4" />} label="Meeting code"><span className="font-mono tabular-nums">{m.meetingCode}</span></Row>
        {m.waitingRoom && m.status !== 'CANCELLED' && m.status !== 'ENDED' && (
          <Row icon={<DoorOpen className="size-4" />} label="Waiting room">The host lets you in when the meeting starts.</Row>
        )}
      </dl>

      <div className="mt-5">
        {m.status === 'CANCELLED' ? (
          <Alert tone="danger" title="This meeting was cancelled">The organiser cancelled it. If it is rescheduled you will receive a new invitation.</Alert>
        ) : m.status === 'ENDED' ? (
          <Alert tone="info" title="This meeting has ended">Thank you. Contact the organiser if you need to meet again.</Alert>
        ) : (
          <>
            <Button
              fullWidth
              size="lg"
              disabled={!canJoin}
              leftIcon={<Video className="size-5" />}
              aria-describedby="join-note"
              onClick={() => setEntering(true)}
            >
              Join meeting
            </Button>
            <p id="join-note" className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-ink-secondary">
              <Clock className="mt-0.5 size-4 shrink-0 text-brand-500" aria-hidden />
              <span>
                {!m.videoAvailable ? (
                  <>Video meetings are temporarily unavailable. Please try again later or contact the organiser.</>
                ) : m.joinableNow ? (
                  <>You join from this browser: no app or account needed. You can check your camera and microphone first.</>
                ) : new Date(m.joinOpensUtc).getTime() > Date.now() ? (
                  <>
                    Joining opens at <strong className="text-ink">{formatTime(m.joinOpensUtc, tz)} {label}</strong> on {formatDayDate(m.joinOpensUtc, tz)}. Please keep this
                    link and come back then.
                  </>
                ) : (
                  <>The time for joining this meeting has passed.</>
                )}
              </span>
            </p>
          </>
        )}
      </div>
      <p className="mt-6 text-[12px] text-ink-muted">
        This personal link is for you only. Do not forward it. Questions? Contact the organiser or{' '}
        <a href={`mailto:${SUPPORT.email}`} className="font-medium text-brand-700 hover:underline">{SUPPORT.email}</a>.
      </p>
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

function JoinError({ notFound, message, onRetry }: { notFound: boolean; message: string | null; onRetry: () => void }) {
  return (
    <AuthCard>
      <AuthHeading
        tone={notFound ? 'warning' : 'danger'}
        icon={<Link2Off className="size-6" />}
        title={notFound ? 'This invitation link no longer works' : 'Unable to open the invitation'}
        description={
          notFound
            ? `${message ?? 'The link is invalid, has expired or was withdrawn.'} If you need help, ask the organiser to send a new invitation.`
            : message
        }
      />
      {!notFound && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
      <p className="mt-6 text-[12px] text-ink-muted">
        Need help? Contact <a href={`mailto:${SUPPORT.email}`} className="font-medium text-brand-700 hover:underline">{SUPPORT.email}</a>.
      </p>
    </AuthCard>
  )
}

