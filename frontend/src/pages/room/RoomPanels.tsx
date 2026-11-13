import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useLocalParticipant, useMediaDeviceSelect, useParticipants } from '@livekit/components-react'
import { ConnectionQuality, supportsAudioOutputSelection, type Participant } from 'livekit-client'
import { Check, CircleAlert, Crown, Headset, DoorOpen, Hand, Lock, LockOpen, LoaderCircle, Mic, MicOff, PlayCircle, RotateCw, SendHorizontal, UserMinus, Video, VideoOff, X } from 'lucide-react'
import { CHAT_MAX_LENGTH, type WaitingEntry } from '../../api/room'
import { SUPPORT } from '../../config'
import type { RoomRecordingState } from '../../api/recordings'
import { errorMessage } from '../../api/types'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { initialsOf } from './PreJoin'
import { participantRole, useRoomUiOptional } from './roomUi'
import { playTestTone } from './testTone'

export type ChatMessage = {
  key: string
  identity: string | null
  name: string
  body: string
  sentUtc: string
  mine: boolean
  /** saving = sent live, being stored; failed = shown to everyone in the room but not stored (retry). */
  state: 'sent' | 'saving' | 'failed'
}

function PanelHeader({ title, subtitle, action, onClose }: { title: string; subtitle?: ReactNode; action?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3.5">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {subtitle && <p className="text-[12px] text-white/55">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="flex size-8 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white">
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}

// ---- Chat ---------------------------------------------------------------------------------------------------------

export function ChatPanel({
  messages,
  onSend,
  onRetry,
  historyError,
  onClose,
}: {
  messages: ChatMessage[]
  onSend: (body: string) => Promise<void>
  onRetry: (m: ChatMessage) => void
  historyError: string | null
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const tz = 'Asia/Kolkata'

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  function submit(e?: FormEvent) {
    e?.preventDefault()
    const body = text.trim()
    if (!body || body.length > CHAT_MAX_LENGTH) return
    setText('')
    void onSend(body)
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <>
      <PanelHeader title="Chat" subtitle="Messages are saved with the meeting record." onClose={onClose} />
      <ol ref={list} className="oic-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" aria-live="polite" data-testid="chat-list">
        {historyError && <li className="rounded-md bg-white/5 px-3 py-2 text-[12px] text-white/60">{historyError}</li>}
        {messages.length === 0 && !historyError && <li className="m-auto text-center text-[13px] text-white/50">No messages yet. Say hello!</li>}
        {messages.map((m) => (
          <li key={m.key} className={cn('flex max-w-[92%] flex-col', m.mine ? 'items-end self-end' : 'items-start')} data-testid="chat-message">
            <span className="mb-1 text-[11.5px] text-white/50">
              {m.mine ? 'You' : m.name} · {formatTime(m.sentUtc, tz)}
            </span>
            {/* Plain text only (never HTML): React escapes it, line breaks are kept. */}
            <p className={cn('rounded-2xl px-3.5 py-2 text-[13.5px] leading-5 break-words whitespace-pre-wrap', m.mine ? 'rounded-br-md bg-brand-500 text-white' : 'rounded-bl-md bg-white/10 text-white')}>{m.body}</p>
            {m.state === 'failed' && (
              <button type="button" onClick={() => onRetry(m)} className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#FCA5A5] hover:underline">
                <RotateCw className="size-3" aria-hidden /> Not saved. Retry
              </button>
            )}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="border-t border-white/[0.07] p-3">
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="oic-chat-input">
            Message
          </label>
          <textarea
            id="oic-chat-input"
            className="oic-input oic-scroll max-h-32 min-h-[44px] resize-none"
            rows={1}
            placeholder="Message everyone"
            value={text}
            maxLength={CHAT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            data-testid="chat-input"
          />
          <button type="submit" disabled={!text.trim()} className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40" aria-label="Send message" data-testid="chat-send">
            <SendHorizontal className="size-[18px]" />
          </button>
        </div>
        {text.length > CHAT_MAX_LENGTH - 200 && <p className="mt-1 text-right text-[11px] text-white/50">{text.length} / {CHAT_MAX_LENGTH}</p>}
      </form>
    </>
  )
}

// ---- Participants ---------------------------------------------------------------------------------------------------

const roleOrder = (p: Participant) => {
  const r = participantRole(p).role
  return r === 'HOST' ? 0 : r === 'COHOST' ? 1 : 2
}

export function PeoplePanel({
  waiting,
  onWaitingChanged,
  onClose,
  consent,
  locked,
  onToggleLocked,
}: {
  waiting: WaitingEntry[]
  onWaitingChanged: () => void
  onClose: () => void
  /** Host-only per-participant recording-consent breakdown (see `RecordingService.StateAsync`); undefined when the
      current user isn't host, there's no consent-required policy, or recording consent doesn't apply right now. */
  consent?: RoomRecordingState['consent']
  /** Whether new (never-attended) people are currently kept out. Undefined for a non-host (no lock toggle shown). */
  locked?: boolean
  onToggleLocked?: () => Promise<void> | void
}) {
  const participants = useParticipants()
  const ui = useRoomUiOptional()
  const host = ui?.backend.host
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Participant | null>(null)
  const [block, setBlock] = useState(false)
  const [transferring, setTransferring] = useState<Participant | null>(null)
  const sorted = [...participants].sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || roleOrder(a) - roleOrder(b) || (a.name ?? '').localeCompare(b.name ?? ''))
  // Only the literal host (not a co-host) can hand off host privileges - the backend exposes transferHost only then.
  const canTransferHost = !!host?.transferHost
  const consentByIdentity = new Map((consent?.decisions ?? []).map((d) => [d.identity, d.decision]))

  async function decide(entry: WaitingEntry, admit: boolean) {
    if (!host) return
    setBusy(entry.id)
    try {
      await (admit ? host.admit(entry.id) : host.reject(entry.id))
      toast.success(admit ? `${entry.name} was let in.` : `${entry.name} was not let in.`)
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Try again.'))
    } finally {
      setBusy(null)
      onWaitingChanged()
    }
  }

  async function mute(p: Participant, source: 'MICROPHONE' | 'CAMERA' = 'MICROPHONE') {
    if (!host) return
    setBusy(p.identity)
    try {
      await host.mute(p.identity, source)
      toast.success(`${p.name || 'The participant'}'s ${source === 'CAMERA' ? 'camera' : 'microphone'} was turned off.`)
    } catch (e) {
      toast.error(errorMessage(e, `The participant's ${source === 'CAMERA' ? 'camera' : 'microphone'} could not be turned off.`))
    } finally {
      setBusy(null)
    }
  }

  async function requestUnmuteOne(p: Participant) {
    if (!host) return
    setBusy(p.identity)
    try {
      await host.requestUnmute(p.identity)
      toast.success(`Asked ${p.name || 'the participant'} to unmute.`)
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Try again.'))
    } finally {
      setBusy(null)
    }
  }

  const muteable = sorted.filter((p) => !p.isLocal && p.isMicrophoneEnabled)
  const [mutingAll, setMutingAll] = useState(false)
  async function muteAll() {
    if (!host || muteable.length === 0) return
    setMutingAll(true)
    try {
      const results = await Promise.allSettled(muteable.map((p) => host.mute(p.identity, 'MICROPHONE')))
      const ok = results.filter((r) => r.status === 'fulfilled').length
      if (ok > 0) toast.success(`Muted ${ok} participant${ok === 1 ? '' : 's'}.`)
      if (ok < results.length) toast.error(`${results.length - ok} could not be muted. Try again.`)
    } finally {
      setMutingAll(false)
    }
  }

  // No browser lets a host force every muted mic back on at once either - this just nudges everyone who is muted.
  const unmuteable = sorted.filter((p) => !p.isLocal && !p.isMicrophoneEnabled)
  const [requestingAll, setRequestingAll] = useState(false)
  async function requestUnmuteAll() {
    if (!host || unmuteable.length === 0) return
    setRequestingAll(true)
    try {
      const results = await Promise.allSettled(unmuteable.map((p) => host.requestUnmute(p.identity)))
      const ok = results.filter((r) => r.status === 'fulfilled').length
      if (ok > 0) toast.success(`Asked ${ok} participant${ok === 1 ? '' : 's'} to unmute.`)
    } finally {
      setRequestingAll(false)
    }
  }

  const [togglingLock, setTogglingLock] = useState(false)
  async function toggleLocked() {
    if (!onToggleLocked) return
    setTogglingLock(true)
    try {
      await onToggleLocked()
    } catch (e) {
      toast.error(errorMessage(e, 'That did not work. Try again.'))
    } finally {
      setTogglingLock(false)
    }
  }

  return (
    <>
      <PanelHeader
        title="Participants"
        subtitle={`${participants.length} in the meeting${waiting.length ? ` · ${waiting.length} waiting` : ''}`}
        onClose={onClose}
        action={
          host && muteable.length > 0 ? (
            <button
              type="button"
              disabled={mutingAll}
              onClick={() => void muteAll()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/8 px-3 text-[12.5px] font-semibold text-white/85 hover:bg-white/15 disabled:opacity-50"
              data-testid="mute-all"
            >
              <MicOff className="size-3.5" aria-hidden /> Mute all
            </button>
          ) : undefined
        }
      />
      {host && (unmuteable.length > 0 || onToggleLocked) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
          {unmuteable.length > 0 && (
            <button
              type="button"
              disabled={requestingAll}
              onClick={() => void requestUnmuteAll()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/8 px-3 text-[12.5px] font-semibold text-white/85 hover:bg-white/15 disabled:opacity-50"
              data-testid="unmute-all"
            >
              <Mic className="size-3.5" aria-hidden /> Unmute all
            </button>
          )}
          {onToggleLocked && (
            <button
              type="button"
              disabled={togglingLock}
              onClick={() => void toggleLocked()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/8 px-3 text-[12.5px] font-semibold text-white/85 hover:bg-white/15 disabled:opacity-50"
              data-testid="toggle-lock"
              title={locked ? 'Let new people in again' : 'Keep anyone new from joining'}
            >
              {locked ? <LockOpen className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />} {locked ? 'Unlock meeting' : 'Lock meeting'}
            </button>
          )}
        </div>
      )}
      <div className="oic-scroll min-h-0 flex-1 overflow-y-auto">
        {host && waiting.length > 0 && (
          <section aria-label="Waiting room" className="border-b border-white/[0.07] px-4 py-3" data-testid="waiting-list">
            <p className="eyebrow mb-2 flex items-center gap-1.5 text-warning">
              <DoorOpen className="size-3.5" aria-hidden /> Waiting to join
            </p>
            <ul className="flex flex-col gap-2">
              {waiting.map((w) => (
                <li key={w.id} className="flex items-center gap-3 rounded-lg bg-warning/10 px-3 py-2.5" data-testid="waiting-entry">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12.5px] font-bold">{initialsOf(w.name)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold">{w.name}</p>
                    <p className="text-[11.5px] text-white/55">
                      {w.type === 'CUSTOMER' ? 'Customer' : w.type === 'EMPLOYEE' ? 'Colleague (not invited)' : 'Guest'}
                      {w.viaLink ? ' · via meeting link' : ''} · waiting since {formatTime(w.enteredUtc, 'Asia/Kolkata')}
                    </p>
                  </div>
                  <button type="button" disabled={busy === w.id} onClick={() => void decide(w, false)} className="h-8 rounded-md px-2.5 text-[12.5px] font-semibold text-white/70 hover:bg-white/10 hover:text-white" data-testid="waiting-reject">
                    Deny
                  </button>
                  <button type="button" disabled={busy === w.id} onClick={() => void decide(w, true)} className="inline-flex h-8 items-center gap-1 rounded-md bg-brand-500 px-3 text-[12.5px] font-semibold hover:bg-brand-600" data-testid="waiting-admit">
                    <Check className="size-3.5" aria-hidden /> Admit
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <ul className="flex flex-col py-2" data-testid="participant-list">
          {sorted.map((p) => (
            <PersonRow
              key={p.identity}
              p={p}
              raised={!!ui?.hands[p.identity]}
              canMute={!!host && !p.isLocal && p.isMicrophoneEnabled}
              canRequestUnmute={!!host && !p.isLocal && !p.isMicrophoneEnabled}
              canDisableCamera={!!host && !p.isLocal && p.isCameraEnabled}
              canRemove={!!host && !p.isLocal && participantRole(p).role !== 'HOST'}
              canTransferHost={canTransferHost && !p.isLocal && participantRole(p).type === 'EMPLOYEE' && participantRole(p).role !== 'HOST'}
              busy={busy === p.identity}
              onMute={() => void mute(p)}
              onRequestUnmute={() => void requestUnmuteOne(p)}
              onDisableCamera={() => void mute(p, 'CAMERA')}
              onRemove={() => (setBlock(false), setRemoving(p))}
              onTransferHost={() => setTransferring(p)}
              consent={consentByIdentity.get(p.identity)}
            />
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name || 'this participant'}?`}
        confirmLabel="Remove from meeting"
        onConfirm={async () => {
          if (!removing || !host) return
          await host.remove(removing.identity, block)
          toast.success(`${removing.name || 'The participant'} was removed${block ? ' and cannot come back' : ''}.`)
        }}
      >
        <p>They are disconnected now. Customers and guests must wait in the waiting room again if they rejoin.</p>
        <label className="mt-3 flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={block} onChange={(e) => setBlock(e.target.checked)} data-testid="remove-block" />
          <span>Do not allow them to rejoin this meeting (their personal link stops working).</span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!transferring}
        onClose={() => setTransferring(null)}
        title={`Make ${transferring?.name || 'this participant'} the host?`}
        confirmLabel="Make host"
        onConfirm={async () => {
          if (!transferring || !host?.transferHost) return
          await host.transferHost(transferring.identity)
          toast.success(`${transferring.name || 'The participant'} is now the host.`)
        }}
      >
        <p>You will lose host-only controls (admitting guests, muting or removing participants, ending the meeting) unless you are separately made co-host afterwards.</p>
      </ConfirmDialog>
    </>
  )
}

const consentBadge: Record<string, { label: string; className: string }> = {
  GRANTED: { label: 'Consented', className: 'text-success' },
  PENDING: { label: 'Awaiting consent', className: 'text-warning' },
  DENIED: { label: 'Declined', className: 'text-danger' },
  WITHDRAWN: { label: 'Withdrawn', className: 'text-danger' },
  DISCONNECTED: { label: 'Disconnected', className: 'text-white/50' },
}

function PersonRow({
  p,
  raised,
  canMute,
  canRequestUnmute,
  canDisableCamera,
  canRemove,
  canTransferHost,
  busy,
  onMute,
  onRequestUnmute,
  onDisableCamera,
  onRemove,
  onTransferHost,
  consent,
}: {
  p: Participant
  raised: boolean
  canMute: boolean
  /** Already muted - a host can only ask them to unmute, never force it back on. */
  canRequestUnmute: boolean
  canDisableCamera: boolean
  canRemove: boolean
  canTransferHost: boolean
  busy: boolean
  onMute: () => void
  onRequestUnmute: () => void
  onDisableCamera: () => void
  onRemove: () => void
  onTransferHost: () => void
  /** This participant's current recording-consent decision, when a consent-required policy is in play and the
      viewer is host (see `PeoplePanel`'s `consent` prop). Undefined otherwise - renders nothing. */
  consent?: string
}) {
  const { role, type } = participantRole(p)
  const name = p.name || p.identity
  const q = p.connectionQuality
  const qColor = q === ConnectionQuality.Excellent ? 'bg-[#22C55E]' : q === ConnectionQuality.Good ? 'bg-warning' : q === ConnectionQuality.Unknown ? 'bg-white/30' : 'bg-danger'
  const badge = consent ? consentBadge[consent] : undefined
  return (
    <li className="group flex items-center gap-3 px-4 py-2 hover:bg-white/[0.04]" data-testid="participant" data-identity={p.identity}>
      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#1769AA,#2878E5)] text-[12.5px] font-bold">
        {initialsOf(name)}
        <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-[#102A43]', qColor)} title="Connection quality" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold">
          {name}
          {p.isLocal && <span className="font-normal text-white/55"> (you)</span>}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-white/55">
          {role !== 'ATTENDEE' ? <span className="font-semibold text-cyan-400">{role === 'HOST' ? 'Host' : 'Co-host'}</span> : <span>{type === 'CUSTOMER' ? 'Customer' : type === 'GUEST' ? 'Guest' : 'Participant'}</span>}
          {raised && (
            <span className="inline-flex items-center gap-1 font-semibold text-warning">
              <Hand className="size-3" aria-hidden /> Hand raised
            </span>
          )}
          {badge && (
            <span className={cn('inline-flex items-center gap-1 font-semibold', badge.className)} data-testid="participant-consent" title="Recording consent">
              <span className="size-1.5 rounded-full bg-current" aria-hidden /> {badge.label}
            </span>
          )}
        </p>
      </div>
      <span className="flex items-center gap-1.5 text-white/60">
        {p.isMicrophoneEnabled ? <Mic className="size-4 text-[#4ADE80]" aria-label="Microphone on" /> : <MicOff className="size-4 text-[#F87171]" aria-label="Microphone off" />}
        {p.isCameraEnabled ? <Video className="size-4" aria-label="Camera on" /> : <VideoOff className="size-4" aria-label="Camera off" />}
      </span>
      {(canMute || canRequestUnmute || canDisableCamera || canRemove || canTransferHost) && (
        <span className="flex items-center gap-1">
          {canTransferHost && (
            <button type="button" disabled={busy} onClick={onTransferHost} title={`Make ${name} host`} aria-label={`Make ${name} host`} className="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-cyan-400/20 hover:text-cyan-300" data-testid="participant-make-host">
              <Crown className="size-4" />
            </button>
          )}
          {canMute && (
            <button type="button" disabled={busy} onClick={onMute} title={`Mute ${name}`} aria-label={`Mute ${name}`} className="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white" data-testid="participant-mute">
              <MicOff className="size-4" />
            </button>
          )}
          {canRequestUnmute && (
            <button type="button" disabled={busy} onClick={onRequestUnmute} title={`Ask ${name} to unmute`} aria-label={`Ask ${name} to unmute`} className="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-cyan-400/20 hover:text-cyan-300" data-testid="participant-request-unmute">
              <Mic className="size-4" />
            </button>
          )}
          {canDisableCamera && (
            <button type="button" disabled={busy} onClick={onDisableCamera} title={`Turn off ${name}'s camera`} aria-label={`Turn off ${name}'s camera`} className="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white" data-testid="participant-disable-camera">
              <VideoOff className="size-4" />
            </button>
          )}
          {canRemove && (
            <button type="button" disabled={busy} onClick={onRemove} title={`Remove ${name}`} aria-label={`Remove ${name}`} className="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-danger/30 hover:text-white" data-testid="participant-remove">
              <UserMinus className="size-4" />
            </button>
          )}
        </span>
      )}
    </li>
  )
}

// ---- Settings ------------------------------------------------------------------------------------------------------

/** `oic.device.<kind>`: the visitor's last chosen device for this browser, restored on their next meeting. */
function devicePrefKey(kind: MediaDeviceKind) {
  return `oic.device.${kind}`
}
function rememberDevice(kind: MediaDeviceKind, deviceId: string) {
  try {
    window.localStorage.setItem(devicePrefKey(kind), deviceId)
  } catch {
    /* storage unavailable (private browsing, quota): the choice just isn't remembered next time */
  }
}

function DeviceList({ kind, label, trailing }: { kind: MediaDeviceKind; label: string; trailing?: (activeDeviceId: string) => ReactNode }) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, requestPermissions: false })
  const toast = useToast()
  const list = devices.filter((d) => d.deviceId)
  const restored = useRef(false)

  // Once, when the real device list first arrives: switch to the visitor's remembered choice if it is still plugged in.
  useEffect(() => {
    if (restored.current || list.length === 0) return
    restored.current = true
    let saved: string | null = null
    try {
      saved = window.localStorage.getItem(devicePrefKey(kind))
    } catch {
      /* ignore */
    }
    if (saved && saved !== activeDeviceId && list.some((d) => d.deviceId === saved)) void setActiveMediaDevice(saved).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately only re-checked when the device list first populates
  }, [list.length])

  async function choose(deviceId: string) {
    try {
      await setActiveMediaDevice(deviceId)
      rememberDevice(kind, deviceId)
    } catch {
      toast.error(`The ${label.toLowerCase()} could not be switched. Your browser may not support changing this device.`)
    }
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold text-white/80">{label}</span>
      <div className="flex items-center gap-2">
        <select className="oic-input oic-select flex-1" value={activeDeviceId || 'default'} disabled={list.length === 0} onChange={(e) => void choose(e.target.value)}>
          {list.length === 0 && <option value="default">Not available</option>}
          {list.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${label} ${i + 1}`}
            </option>
          ))}
        </select>
        {trailing?.(activeDeviceId || 'default')}
      </div>
    </label>
  )
}

function TestSpeakerButton({ deviceId }: { deviceId: string }) {
  const toast = useToast()
  const [playing, setPlaying] = useState(false)
  async function test() {
    setPlaying(true)
    try {
      await playTestTone(deviceId === 'default' ? undefined : deviceId)
    } catch {
      toast.error('The test sound could not be played through this output.')
    } finally {
      setPlaying(false)
    }
  }
  return (
    <button
      type="button"
      onClick={() => void test()}
      disabled={playing}
      className="flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/5 px-3 text-[12.5px] font-semibold text-white/85 hover:bg-white/10 disabled:opacity-50"
      data-testid="test-speaker"
    >
      {playing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <PlayCircle className="size-4" aria-hidden />}
      Test
    </button>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { localParticipant } = useLocalParticipant()
  const outputSelectable = supportsAudioOutputSelection()
  return (
    <>
      <PanelHeader title="Settings" subtitle="Switch devices without leaving the meeting." onClose={onClose} />
      <div className="oic-scroll flex flex-col gap-4 overflow-y-auto px-4 py-4">
        <DeviceList kind="videoinput" label="Camera" />
        <DeviceList kind="audioinput" label="Microphone" />
        {outputSelectable ? (
          <DeviceList kind="audiooutput" label="Speaker / audio output" trailing={(id) => <TestSpeakerButton deviceId={id} />} />
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-white/80">Speaker / audio output</span>
            <p className="flex items-start gap-2 rounded-md bg-white/5 px-3 py-2.5 text-[12px] leading-5 text-white/60">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              This browser doesn't let a website choose which speaker to use (common on Safari and iPhone/iPad). To send meeting audio to a different output
              — a laptop speaker instead of an HDMI monitor, for example — switch it in your device's own sound settings.
            </p>
          </div>
        )}
        <p className="flex items-start gap-2 rounded-md bg-white/5 px-3 py-2.5 text-[12px] leading-5 text-white/60">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          On a weak network the video quality adapts automatically and your voice is given priority. You are connected as {localParticipant.name || 'yourself'}.
        </p>
        <SupportLine />
      </div>
    </>
  )
}

/** In-room help contact. Lives in Settings (desktop) and the More sheet (phones) - never in the control bar, where the
    sign-in layout's footer line used to show through and sit on top of the buttons. */
export function SupportLine({ className }: { className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center justify-center gap-1.5 text-center text-[12px] leading-5 text-white/60', className)} data-testid="room-support">
      <Headset className="size-3.5 shrink-0" aria-hidden /> Need help?{' '}
      <a href={`mailto:${SUPPORT.email}`} target="_blank" rel="noreferrer" className="font-medium text-white/85 hover:text-white hover:underline">
        {SUPPORT.email}
      </a>
    </p>
  )
}
