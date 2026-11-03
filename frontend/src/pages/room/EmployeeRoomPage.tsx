import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CalendarClock, CircleAlert, RotateCw } from 'lucide-react'
import { authApi } from '../../api'
import { meetingsApi, type MeetingDetail } from '../../api/meetings'
import { roomRecordingApi } from '../../api/recordings'
import { roomApi, type JoinResponse } from '../../api/room'
import { ApiError, errorMessage } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { formatDayDate, formatRange, formatTime, zoneLabel } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import type { RoomEntryState } from '../meetings/QuickMeetingDialogs'
import { MeetingRoom, type RoomExit } from './MeetingRoom'
import { PreJoin, type MediaChoices, type PreviewTracks } from './PreJoin'
import { RoomExitScreen } from './RoomExitScreen'
import { CanvasButton, RoomLoading, RoomMessage } from './RoomScreens'
import type { RoomBackend } from './roomUi'

/** /meetings/:id/room — signed-in employees: pre-join → room → exit screen. Lazy-loaded (LiveKit is not in the main bundle). */
export default function EmployeeRoomPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const meeting = useLoader(() => meetingsApi.get(id), [id], 'Unable to load the meeting.')
  const back = <CanvasButton variant="secondary" leftIcon={<ArrowLeft className="size-4" />} onClick={() => navigate(`/meetings/${id}`)}>Meeting details</CanvasButton>

  if (!meeting.data && meeting.loading) return <RoomLoading label="Loading the meeting…" />
  if (!meeting.data)
    return (
      <RoomMessage icon={<CircleAlert className="size-7" />} tone="danger" title="Unable to open the meeting" actions={<>{back}<CanvasButton leftIcon={<RotateCw className="size-4" />} onClick={meeting.reload}>Try again</CanvasButton></>}>
        <p>{meeting.error}</p>
      </RoomMessage>
    )
  return <Flow m={meeting.data} back={back} reload={meeting.reload} />
}

function Flow({ m, back, reload }: { m: MeetingDetail; back: ReactNode; reload: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const entry = (useLocation().state ?? {}) as RoomEntryState
  const [phase, setPhase] = useState<'prejoin' | 'room' | 'exit'>('prejoin')
  const [joined, setJoined] = useState<JoinResponse | null>(null)
  const [media, setMedia] = useState<MediaChoices | null>(null)
  const [tracks, setTracks] = useState<PreviewTracks>({})
  const [exit, setExit] = useState<RoomExit | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tz = m.timeZoneId || 'Asia/Kolkata'

  const backend = useMemo<RoomBackend | null>(() => {
    if (!joined) return null
    const b: RoomBackend = {
      loadChat: () => roomApi.chat(m.id),
      postChat: (body) => roomApi.postChat(m.id, body),
      keepAlive: () => authApi.me(),
      recording: {
        state: () => roomRecordingApi.state(m.id),
        consent: (decision, version) => roomRecordingApi.consent(m.id, decision, version),
        ...(joined.connection.isHost ? { start: (version: string) => roomRecordingApi.start(m.id, version), stop: () => roomRecordingApi.stop(m.id) } : {}),
      },
      ...(m.my.canShareLink ? { share: { meetingId: m.id, openOnStart: !!entry.invite } } : {}),
    }
    if (joined.connection.isHost)
      b.host = {
        waiting: () => roomApi.waiting(m.id),
        admit: (e) => roomApi.admit(m.id, e),
        reject: (e) => roomApi.reject(m.id, e),
        mute: (identity, source) => roomApi.mute(m.id, identity, source),
        remove: (identity, block) => roomApi.remove(m.id, identity, block),
        end: () => roomApi.end(m.id),
      }
    return b
  }, [joined, m.id, m.my.canShareLink]) // eslint-disable-line react-hooks/exhaustive-deps -- `entry` is fixed for this visit

  const onExit = useCallback((x: RoomExit) => {
    setExit(x)
    setPhase('exit')
  }, [])

  if (phase === 'room' && joined && media && backend)
    return <MeetingRoom connection={joined.connection} meeting={joined.meeting} media={media} tracks={tracks} backend={backend} onExit={onExit} />

  if (phase === 'exit' && exit)
    return (
      <RoomExitScreen
        exit={exit}
        title={m.title}
        back={back}
        rejoin={<CanvasButton leftIcon={<RotateCw className="size-4" />} onClick={() => (setError(null), setPhase('prejoin'), reload())}>Rejoin</CanvasButton>}
      />
    )

  if (!m.join.joinable) {
    const early = m.join.reason === 'TOO_EARLY'
    return (
      <RoomMessage icon={early ? <CalendarClock className="size-7" /> : <CircleAlert className="size-7" />} tone={early ? 'brand' : 'warning'} title={early ? 'The meeting room is not open yet' : 'This meeting cannot be joined'} actions={back}>
        <p>
          {early ? (
            <>
              <strong className="text-white">{m.title}</strong> starts {formatRange(m.startUtc, m.endUtc, tz)} {zoneLabel(tz)}. The room opens at{' '}
              <strong className="text-white">{formatTime(m.join.opensUtc, tz)} {zoneLabel(tz)}</strong> on {formatDayDate(m.join.opensUtc, tz)}.
            </>
          ) : (
            m.join.message
          )}
        </p>
      </RoomMessage>
    )
  }

  async function join(choices: MediaChoices, previews: PreviewTracks) {
    setBusy(true)
    setError(null)
    try {
      const r = await roomApi.join(m.id)
      setJoined(r)
      setMedia(choices)
      setTracks(previews)
      setPhase('room')
      return true
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'SERVICE_UNAVAILABLE' ? e.message : errorMessage(e, 'You could not be connected to the meeting.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <PreJoin
      title={m.title}
      details={
        <>
          {formatRange(m.startUtc, m.endUtc, tz)} {zoneLabel(tz)}
          <br />
          Host: {m.host.name} · <span className="font-mono">{m.meetingCode}</span>
          {m.kind === 'INSTANT' && ' · Instant meeting'}
          {m.audioOnly && ' · Audio only'}
          {m.my.canHostRoom && <><br /><span className="text-cyan-400">You are a host: you admit guests, can mute or remove participants and end the meeting.</span></>}
        </>
      }
      name={user?.displayName ?? ''}
      cameraAllowed={!m.audioOnly}
      initialVideo={entry.video}
      joinLabel={m.status === 'LIVE' ? 'Join now' : m.my.canHostRoom ? 'Start meeting' : 'Join now'}
      busy={busy}
      error={error}
      onJoin={join}
      onCancel={() => navigate(`/meetings/${m.id}`)}
      footnote="Your camera and microphone are used only while you are in the meeting."
    />
  )
}
