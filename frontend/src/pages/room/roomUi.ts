import { createContext, useContext } from 'react'
import type { Participant } from 'livekit-client'
import type { ChatItem, MuteSource, RoomConnection, WaitingEntry } from '../../api/room'
import type { RecordingBackend } from './RecordingControls'

/** Server calls the room needs. Employees use their session; guests their invitation token. Hosts also get `host`. */
export type RoomBackend = {
  loadChat: () => Promise<ChatItem[]>
  postChat: (body: string) => Promise<ChatItem>
  /** Keeps the signed-in session alive during long meetings (failures are ignored). */
  keepAlive?: () => Promise<unknown>
  /** Recording notice/consent (everyone) and start/stop (hosts). */
  recording?: RecordingBackend
  /** Hosts/organiser: the meeting's shareable link (Invite button). `openOnStart` for a meeting just started. */
  share?: { meetingId: string; openOnStart?: boolean }
  host?: {
    waiting: () => Promise<WaitingEntry[]>
    admit: (entryId: string) => Promise<void>
    reject: (entryId: string) => Promise<void>
    mute: (identity: string, source: MuteSource) => Promise<void>
    remove: (identity: string, block?: boolean) => Promise<void>
    end: () => Promise<void>
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
