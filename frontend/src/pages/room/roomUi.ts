import { createContext, useContext } from 'react'
import type { Participant } from 'livekit-client'
import type { CustomerJoinLink } from '../../api/meetings'
import type { ChatItem, EndTimes, MuteSource, RoomConnection, WaitingEntry } from '../../api/room'
import type { RecordingBackend } from './RecordingControls'
import type { FeatureCalls } from '../../api/roomFeatures'

/** Server calls the room needs. Employees use their session; guests their invitation token. Hosts also get `host`. */
export type RoomBackend = {
  loadChat: () => Promise<ChatItem[]>
  postChat: (body: string) => Promise<ChatItem>
  /** Keeps the signed-in session alive during long meetings (failures are ignored). */
  keepAlive?: () => Promise<unknown>
  /** Recording notice/consent (everyone) and start/stop (hosts). */
  recording?: RecordingBackend
  /** Asks the API (the source of truth) whether the meeting has ended for everyone - used while reconnecting and when the
      connection drops, so an ended meeting shows "Meeting ended" instead of "Reconnecting…"/"Connection lost". */
  hasEnded?: () => Promise<boolean>
  /** Hosts/organiser: the meeting's shareable link (Invite button). `openOnStart` for a meeting just started. */
  /** Optional meeting features (polls, private messages, whiteboard). Used only for the features an administrator switched on. */
  features?: FeatureCalls
  share?: { meetingId: string; openOnStart?: boolean; customer?: CustomerJoinLink | null; customerMeeting?: boolean; /** PLVC instant: the other participants' personal links. */ guests?: CustomerJoinLink[]; /** Unidentified PLVC: no customer to send a link to. */ noCustomer?: boolean }
  host?: {
    waiting: () => Promise<WaitingEntry[]>
    admit: (entryId: string) => Promise<void>
    reject: (entryId: string) => Promise<void>
    mute: (identity: string, source: MuteSource) => Promise<void>
    /** No browser lets a host force a remote mic back on - this asks the participant to unmute themselves. */
    requestUnmute: (identity: string) => Promise<void>
    remove: (identity: string, block?: boolean) => Promise<void>
    end: () => Promise<void>
    /** Pushes the scheduled end (and the automatic end) back by `minutes`. */
    extend?: (minutes: number) => Promise<EndTimes>
    /** Present only for the literal host (not a co-host): hands host privileges to another employee participant. */
    transferHost?: (identity: string) => Promise<void>
    /** Locked: nobody who hasn't already attended can join. Never disconnects anyone already in. */
    setLocked: (locked: boolean) => Promise<void>
  }
}

export type RoomUi = {
  connection: RoomConnection
  /** Raised hands by participant identity. */
  hands: Record<string, boolean>
  backend: RoomBackend
}

export const RoomUiContext = createContext<RoomUi | null>(null)

export function useRoomUi() {
  const v = useContext(RoomUiContext)
  if (!v) throw new Error('RoomUiContext missing')
  return v
}

export function useRoomUiOptional() {
  return useContext(RoomUiContext)
}

/** Role and participant type travel in the LiveKit token metadata (set by the API, not editable by the participant). */
export function participantRole(p: Participant): { role: string; type: string } {
  try {
    const m = JSON.parse(p.metadata || '{}') as { role?: string; type?: string }
    return { role: m.role ?? 'ATTENDEE', type: m.type ?? 'EMPLOYEE' }
  } catch {
    return { role: 'ATTENDEE', type: 'EMPLOYEE' }
  }
}
