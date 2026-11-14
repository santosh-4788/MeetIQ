// GoodDay #14224: one live connection per person per browser. When the meeting link is opened again (e.g. tapped once more
// in WhatsApp on an iPhone, which opens a new Safari tab), the older tab used to keep retrying in the background; each of
// its "resume" attempts made the server close the NEW connection ("unable to resume due to missing published tracks"),
// so the person was dropped again and again. Now the newest tab owns the identity: older tabs stop retrying and show
// "You joined from another window". The claim lives in localStorage (shared by the browser's tabs, read before every
// retry) and is announced over a BroadcastChannel (instant when both tabs are running).
import { DefaultReconnectPolicy, type ReconnectContext, type ReconnectPolicy } from 'livekit-client'

export type Claim = { id: string; startedAt: number }

const key = (identity: string) => `oic-room:${identity}`

export function newClaim(): Claim {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return { id, startedAt: Date.now() }
}

function readClaim(identity: string): Claim | null {
  try {
    return JSON.parse(localStorage.getItem(key(identity)) ?? 'null') as Claim | null
  } catch {
    return null
  }
}

/** True when a newer tab of the same person has joined this meeting since this one did. */
export function supersededBy(identity: string | undefined, me: Claim): boolean {
  if (!identity) return false
  const c = readClaim(identity)
  return !!c && c.id !== me.id && c.startedAt > me.startedAt
}

export function writeClaim(identity: string, me: Claim) {
  try {
    localStorage.setItem(key(identity), JSON.stringify(me))
  } catch {
    /* storage blocked (private mode): the BroadcastChannel still works */
  }
}

export function releaseClaim(identity: string, me: Claim) {
  try {
    if (readClaim(identity)?.id === me.id) localStorage.removeItem(key(identity))
  } catch {
    /* ignore */
  }
}

/** LiveKit's own retry schedule, except that a replaced tab stops retrying at once (null = give up). */
export function guardedReconnectPolicy(superseded: () => boolean): ReconnectPolicy {
  const base = new DefaultReconnectPolicy()
  return { nextRetryDelayInMs: (ctx: ReconnectContext) => (superseded() ? null : base.nextRetryDelayInMs(ctx)) }
}

export const CHANNEL = 'oic-room'
