import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LocalVideoTrack } from 'livekit-client'
import { ArrowLeft, CircleAlert, DoorOpen, RotateCw, ShieldX } from 'lucide-react'
import type { JoinInfo } from '../../api/meetings'
import { guestRecordingApi } from '../../api/recordings'
import { guestRoomApi, type RoomConnection, type RoomMeetingInfo } from '../../api/room'
import { ApiError, errorMessage } from '../../api/types'
import { formatRange, zoneLabel } from '../../lib/format'
import { MeetingRoom, type RoomExit } from './MeetingRoom'
import { PreJoin, type MediaChoices, type PreviewTracks } from './PreJoin'
import { RoomExitScreen } from './RoomExitScreen'
import { CanvasButton, RoomCanvas, RoomMessage } from './RoomScreens'
import type { RoomBackend } from './roomUi'

type Phase =
  | { name: 'prejoin' }
  | { name: 'waiting'; entryId: string; pollAfterMs: number }
  | { name: 'room'; connection: RoomConnection; meeting: RoomMeetingInfo }
  | { name: 'refused'; title: string; message: string }
  | { name: 'exit'; exit: RoomExit }

/**
 * Customers and guests from their e-mailed link (/join/:token): pre-join (name, devices) → waiting room until the host admits
 * them → meeting room. Lazy-loaded by JoinPage. The invitation token is the only credential; no account is needed.
 * From a shared meeting link (/m/:token) there is no personal token yet: `getToken` asks the API for one when the person
 * clicks "Ask to join" (null = handled elsewhere, e.g. a signed-in participant sent to their room).
 */
export default function GuestRoom({
  token: given,
  info,
  onClose,
  getToken,
  audioOnly = false,
  footnote = 'This personal link is for you only. Your camera and microphone are used only while you are in the meeting.',
  backLabel = 'Back to the invitation',
}: {
  token: string
  info: JoinInfo
  onClose: () => void
  getToken?: (name: string) => Promise<string | null>
  audioOnly?: boolean
  footnote?: string
  backLabel?: string
}) {
  const [token, setToken] = useState(given)
  const [phase, setPhase] = useState<Phase>({ name: 'prejoin' })
  const [name, setName] = useState(info.displayName ?? '')
  const [media, setMedia] = useState<MediaChoices | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tracksRef = useRef<PreviewTracks>({})
  const tz = info.timeZoneId || 'Asia/Kolkata'
  const isGuest = info.participantType === 'GUEST'

  const backend = useMemo<RoomBackend>(
    () => ({
      loadChat: () => guestRoomApi.chat(token),
      postChat: (body) => guestRoomApi.postChat(token, body, isGuest ? name.trim() : undefined),
      recording: {
        state: () => guestRecordingApi.state(token),
        consent: (decision, version) => guestRecordingApi.consent(token, decision, version),
      },
    }),
    // Recomputed when the room opens: the name is fixed from then on.
    [token, isGuest, phase.name === 'room'], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const onExit = useCallback((exit: RoomExit) => setPhase({ name: 'exit', exit }), [])
  const back = <CanvasButton variant="secondary" leftIcon={<ArrowLeft className="size-4" />} onClick={onClose}>{backLabel}</CanvasButton>

  // The preview tracks stay alive through the waiting room (shown there) and are published in the room.
  const releaseTracks = useCallback(() => {
    tracksRef.current.audio?.stop()
    tracksRef.current.video?.stop()
    tracksRef.current = {}
  }, [])

  async function enter(choices: MediaChoices, previews: PreviewTracks) {
    setBusy(true)
    setError(null)
    try {
      let t = token
      if (!t && getToken) {
        const issued = await getToken(name.trim())
        if (!issued) return false
        t = issued
        setToken(issued)
      }
      const r = await guestRoomApi.enter(t, isGuest ? name.trim() : undefined)
      setMedia(choices)
      tracksRef.current = previews
      if (r.status === 'ADMITTED') setPhase({ name: 'room', connection: r.connection, meeting: r.meeting })
      else setPhase({ name: 'waiting', entryId: r.entryId, pollAfterMs: r.pollAfterMs })
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setPhase({ name: 'refused', title: 'The host has not let you in', message: e.message })
        tracksRef.current = previews
        releaseTracks()
        return true
      }
      setError(errorMessage(e, 'You could not be connected to the meeting. Please try again.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  switch (phase.name) {
    case 'waiting':
      return (
        <WaitingRoom
          token={token}
          entryId={phase.entryId}
          pollAfterMs={phase.pollAfterMs}
          title={info.title}
          organiser={info.organiser}
          preview={tracksRef.current.video}
          onAdmitted={(connection, meeting) => setPhase({ name: 'room', connection, meeting })}
          onRefused={(title, message) => {
            releaseTracks()
            setPhase({ name: 'refused', title, message })
          }}
          onLeave={() => {
            releaseTracks()
            setPhase({ name: 'prejoin' })
          }}
        />
      )
    case 'room':
      return <MeetingRoom connection={phase.connection} meeting={phase.meeting} media={media!} tracks={tracksRef.current} backend={backend} onExit={onExit} />
    case 'refused':
      return (
        <RoomMessage icon={<ShieldX className="size-7" />} tone="warning" title={phase.title} actions={back}>
          <p>{phase.message}</p>
        </RoomMessage>
      )
    case 'exit':
      return (
        <RoomExitScreen
          exit={phase.exit}
          title={info.title}
          back={back}
          rejoin={<CanvasButton leftIcon={<RotateCw className="size-4" />} onClick={() => setPhase({ name: 'prejoin' })}>Rejoin</CanvasButton>}
        />
      )
    default:
      return (
        <PreJoin
          title={info.title}
          details={
            <>
              {formatRange(info.startUtc, info.endUtc, tz)} {zoneLabel(tz)}
              <br />
              Organiser: {info.organiser}
              {info.waitingRoom && <><br /><span className="text-cyan-400">The host lets you in from the waiting room.</span></>}
            </>
          }
          name={name}
          onNameChange={setName}
          nameEditable={isGuest}
          joinLabel={info.waitingRoom ? 'Ask to join' : 'Join now'}
          cameraAllowed={!audioOnly}
          busy={busy}
          error={error}
          onJoin={enter}
          onCancel={onClose}
          footnote={footnote}
        />
      )
  }
}

/** Waits for the host's decision (polls every few seconds; the API rate limit allows it). Leaving tells the host at once. */
function WaitingRoom({
  token,
  entryId,
  pollAfterMs,
  title,
  organiser,
  preview,
  onAdmitted,
  onRefused,
  onLeave,
}: {
  token: string
  entryId: string
  pollAfterMs: number
  title: string
  organiser: string
  preview?: LocalVideoTrack
  onAdmitted: (c: RoomConnection, m: RoomMeetingInfo) => void
  onRefused: (title: string, message: string) => void
  onLeave: () => void
}) {
  const [trouble, setTrouble] = useState(false)
  const done = useRef(false)
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = video.current
    if (!preview || !el) return
    preview.attach(el)
    return () => {
      preview.detach(el)
    }
  }, [preview])

  useEffect(() => {
    let timer = 0
    let delay = Math.max(1500, pollAfterMs)
    const poll = async () => {
      try {
        const r = await guestRoomApi.poll(token, entryId)
        setTrouble(false)
        delay = Math.max(1500, pollAfterMs)
        if (r.status === 'ADMITTED') {
          done.current = true
          onAdmitted(r.connection, r.meeting)
          return
        }
        if (r.status !== 'WAITING') {
          done.current = true
          onRefused(r.status === 'REJECTED' ? 'The host has not let you in' : r.status === 'ENDED' ? 'The meeting is not available' : 'You left the waiting room', r.message)
          return
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          done.current = true
          onRefused('This invitation link no longer works', e.message)
          return
        }
        // Network trouble or rate limiting: keep waiting, back off.
        setTrouble(true)
        delay = Math.min(delay * 2, 15_000)
      }
      timer = window.setTimeout(() => void poll(), delay)
    }
    timer = window.setTimeout(() => void poll(), delay)
    const onHide = () => {
      if (!done.current) void guestRoomApi.leave(token, entryId)
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pagehide', onHide)
    }
  }, [token, entryId, pollAfterMs, onAdmitted, onRefused])

  return (
    <RoomCanvas>
      <section className="w-full max-w-[520px] text-center animate-fade-up" data-testid="waiting-room" aria-live="polite">
        <div className="relative mx-auto flex size-24 items-center justify-center">
          <span className="oic-pulse" aria-hidden />
          <span className="oic-pulse delay" aria-hidden />
          <span className="relative flex size-20 items-center justify-center rounded-full bg-[linear-gradient(135deg,#1769AA,#2878E5_60%,#20C4D8)] shadow-[0_12px_40px_rgb(40_120_229/0.45)]">
            <DoorOpen className="size-9" aria-hidden />
          </span>
        </div>
        <p className="eyebrow mt-8 text-cyan-400">Waiting room</p>
        <h1 className="mt-2 text-[24px] leading-8 font-bold tracking-[-0.01em]">Please wait, the host will let you in soon</h1>
        <p className="mt-2 text-[14px] leading-6 text-white/70">
          <strong className="text-white">{title}</strong> · organised by {organiser}. Keep this page open; you join automatically once admitted.
        </p>
        {preview && (
          <div className="mx-auto mt-6 aspect-video w-full max-w-[320px] overflow-hidden rounded-lg border border-white/10 bg-navy-900">
            <video ref={video} muted playsInline autoPlay className="size-full -scale-x-100 object-cover" aria-label="Your camera" />
          </div>
        )}
        {trouble && (
          <p role="status" className="mx-auto mt-5 inline-flex items-center gap-2 rounded-md bg-warning/15 px-3 py-2 text-[12.5px] text-[#FDE68A]">
            <CircleAlert className="size-4" aria-hidden /> Having trouble reaching the server, still trying…
          </p>
        )}
        <div className="mt-8">
          <CanvasButton
            variant="secondary"
            onClick={() => {
              done.current = true
              void guestRoomApi.leave(token, entryId)
              onLeave()
            }}
          >
            Leave the waiting room
          </CanvasButton>
        </div>
      </section>
    </RoomCanvas>
  )
}
