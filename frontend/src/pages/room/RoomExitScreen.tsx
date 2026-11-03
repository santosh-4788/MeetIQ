import type { ReactNode } from 'react'
import { CircleCheck, DoorClosed, Laptop, UserX, WifiOff } from 'lucide-react'
import type { RoomExit } from './MeetingRoom'
import { RoomMessage } from './RoomScreens'

/** What happened when the participant is out of the room again, with the right next step. */
export function RoomExitScreen({ exit, title, rejoin, back }: { exit: RoomExit; title: string; rejoin?: ReactNode; back?: ReactNode }) {
  switch (exit.kind) {
    case 'left':
      return (
        <RoomMessage icon={<CircleCheck className="size-7" />} tone="success" title="You left the meeting" actions={<>{back}{rejoin}</>}>
          <p>
            You left <strong className="text-white">{title}</strong>. The meeting continues for the others: you can rejoin while it is running.
          </p>
        </RoomMessage>
      )
    case 'ended':
      return (
        <RoomMessage icon={<DoorClosed className="size-7" />} title="The meeting has ended" actions={back}>
          <p>The host ended <strong className="text-white">{title}</strong> for everyone. Thank you for joining.</p>
        </RoomMessage>
      )
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
