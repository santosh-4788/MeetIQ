import { Link } from 'react-router-dom'
import { Clapperboard, Play } from 'lucide-react'
import { formatSeconds, recordingsApi } from '../../api/recordings'
import { Card, CardHeader } from '../../components/ui/Card'
import { Skeleton } from '../../components/ui/Feedback'
import { formatDateTime } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { RecordingStatusBadge } from './RecordingsPage'

/** Meeting detail: the meeting's recordings the user may see (the API hides the others and says how many). */
export function MeetingRecordingsCard({ meetingId, tz }: { meetingId: string; tz: string }) {
  const data = useLoader(() => recordingsApi.forMeeting(meetingId), [meetingId], 'Unable to load recordings.')
  if (data.data && data.data.items.length === 0 && data.data.hiddenCount === 0) return null
  return (
    <Card>
      <CardHeader title="Recordings" action={<Clapperboard className="size-4 text-ink-muted" aria-hidden />} />
      <div className="flex flex-col gap-2 px-5 pb-5 text-[13px]" data-testid="meeting-recordings">
        {data.error && <p className="text-danger">{data.error}</p>}
        {!data.data && !data.error && <Skeleton className="h-10 w-full" />}
        {data.data?.items.map((r) => (
          <Link key={r.id} to={`/recordings/${r.id}`} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 hover:bg-surface-muted">
            <span className="min-w-0">
              <span className="block font-medium text-ink">{formatDateTime(r.startedUtc ?? r.createdUtc, tz)}</span>
              <span className="text-[12px] text-ink-secondary">{formatSeconds(r.durationSeconds)}</span>
            </span>
            <span className="flex items-center gap-2">
              <RecordingStatusBadge status={r.status} />
              {r.canPlay && <Play className="size-4 text-brand-700" aria-label="Play" />}
            </span>
          </Link>
        ))}
        {!!data.data?.hiddenCount && (
          <p className="text-[12px] text-ink-secondary">{data.data.hiddenCount} recording(s) you are not permitted to see.</p>
        )}
      </div>
    </Card>
  )
}
