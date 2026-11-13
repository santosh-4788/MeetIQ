import type { ReactNode } from 'react'
import { CircleCheck, DoorClosed, Laptop, UserX, WifiOff } from 'lucide-react'
import type { RoomExit } from './MeetingRoom'
import { RoomMessage } from './RoomScreens'
import { DEFAULT_TIME_ZONE } from '../../config'
import { formatTime, zoneLabel } from '../../lib/format'

/** What happened when the participant is out of the room again, with the right next step. */
export function RoomExitScreen({ exit, title, meetingCode, timeZoneId, rejoin, back }: {
  exit: RoomExit
  title: string
  meetingCode?: string
  timeZoneId?: string
  rejoin?: ReactNode
  back?: ReactNode
}) {
  switch (exit.kind) {
    case 'left':
      return (
        <RoomMessage icon={<CircleCheck className="size-7" />} tone="success" title="You left the meeting" actions={<>{back}{rejoin}</>}>
          <p>
            You left <strong className="text-white">{title}</strong>. The meeting continues for the others: you can rejoin while it is running.
          </p>
        </RoomMessage>
      )
    case 'ended': {
      const tz = timeZoneId || DEFAULT_TIME_ZONE
      return (
        <RoomMessage icon={<DoorClosed className="size-7" />} title="Meeting Ended" actions={back}>
          {/* The host ended it for everyone, or it reached its scheduled end + grace without an extension (MeetingAutoEndWorker). */}
          <div data-testid="meeting-ended" data-ended-by={exit.endedBy ?? ''}>
            <p>
              {exit.endedBy === 'auto' ? 'This meeting reached its scheduled end time.' : 'The host has ended this meeting.'} Thank you for joining.
            </p>
            <dl className="mx-auto mt-5 grid max-w-[360px] grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left text-[13px]">
              <dt className="text-white/50">Meeting</dt>
              <dd className="truncate font-semibold text-white" title={title}>{title}</dd>
              {meetingCode && (<><dt className="text-white/50">Meeting ID</dt><dd className="font-mono tracking-wide text-white/85">{meetingCode}</dd></>)}
              {exit.endedUtc && (<><dt className="text-white/50">Ended at</dt><dd className="text-white/85">{formatTime(exit.endedUtc, tz)} {zoneLabel(tz)}</dd></>)}
            </dl>
          </div>
        </RoomMessage>
      )
    }
    case 'removed':
      return (
        <RoomMessage icon={<UserX className="size-7" />} tone="warning" title="You were removed from the meeting" actions={back}>
          <p>The host removed you from this meeting. Contact the organiser if you think this was a mistake.</p>
        </RoomMessage>
      )
    case 'duplicate':
      return (
        <RoomMessage icon={<Laptop className="size-7" />} tone="warning" title="You joined from another window" actions={<>{back}{rejoin}</>}>
          <p>This meeting is now open in another tab or on another device. Only one connection per person is kept.</p>
        </RoomMessage>
      )
    default:
      return (
        <RoomMessage icon={<WifiOff className="size-7" />} tone="danger" title="Connection lost" actions={<>{back}{rejoin}</>}>
          <p>{exit.message}</p>
        </RoomMessage>
      )
  }
}
