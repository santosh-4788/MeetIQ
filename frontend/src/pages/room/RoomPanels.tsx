import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useLocalParticipant, useMediaDeviceSelect, useParticipants } from '@livekit/components-react'
import { ConnectionQuality, type Participant } from 'livekit-client'
import { Check, CircleAlert, DoorOpen, Hand, Mic, MicOff, RotateCw, SendHorizontal, UserMinus, Video, VideoOff, X } from 'lucide-react'
import { CHAT_MAX_LENGTH, type WaitingEntry } from '../../api/room'
import { errorMessage } from '../../api/types'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { initialsOf } from './PreJoin'
import { participantRole, useRoomUiOptional } from './roomUi'

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

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3.5">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {subtitle && <p className="text-[12px] text-white/55">{subtitle}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="-mr-1.5 flex size-8 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white">
        <X className="size-4" />
      </button>
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

export function PeoplePanel({ waiting, onWaitingChanged, onClose }: { waiting: WaitingEntry[]; onWaitingChanged: () => void; onClose: () => void }) {
  const participants = useParticipants()
  const ui = useRoomUiOptional()
  const host = ui?.backend.host
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Participant | null>(null)
  const [block, setBlock] = useState(false)
  const sorted = [...participants].sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || roleOrder(a) - roleOrder(b) || (a.name ?? '').localeCompare(b.name ?? ''))

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

  async function mute(p: Participant) {
    if (!host) return
    setBusy(p.identity)
    try {
      await host.mute(p.identity, 'MICROPHONE')
      toast.success(`${p.name || 'The participant'} was muted.`)
    } catch (e) {
      toast.error(errorMessage(e, 'The participant could not be muted.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PanelHeader title="Participants" subtitle={`${participants.length} in the meeting${waiting.length ? ` · ${waiting.length} waiting` : ''}`} onClose={onClose} />
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
              canRemove={!!host && !p.isLocal && participantRole(p).role !== 'HOST'}
              busy={busy === p.identity}
              onMute={() => void mute(p)}
              onRemove={() => (setBlock(false), setRemoving(p))}
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
    </>
  )
}

function PersonRow({ p, raised, canMute, canRemove, busy, onMute, onRemove }: { p: Participant; raised: boolean; canMute: boolean; canRemove: boolean; busy: boolean; onMute: () => void; onRemove: () => void }) {
  const { role, type } = participantRole(p)
  const name = p.name || p.identity
  const q = p.connectionQuality
  const qColor = q === ConnectionQuality.Excellent ? 'bg-[#22C55E]' : q === ConnectionQuality.Good ? 'bg-warning' : q === ConnectionQuality.Unknown ? 'bg-white/30' : 'bg-danger'
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
        </p>
      </div>
      <span className="flex items-center gap-1.5 text-white/60">
        {p.isMicrophoneEnabled ? <Mic className="size-4 text-[#4ADE80]" aria-label="Microphone on" /> : <MicOff className="size-4 text-[#F87171]" aria-label="Microphone off" />}
        {p.isCameraEnabled ? <Video className="size-4" aria-label="Camera on" /> : <VideoOff className="size-4" aria-label="Camera off" />}
      </span>
      {(canMute || canRemove) && (
        <span className="flex items-center gap-1">
          {canMute && (
            <button type="button" disabled={busy} onClick={onMute} title={`Mute ${name}`} aria-label={`Mute ${name}`} className="flex size-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white" data-testid="participant-mute">
              <MicOff className="size-4" />
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

function DeviceList({ kind, label }: { kind: MediaDeviceKind; label: string }) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, requestPermissions: false })
  const toast = useToast()
  const list = devices.filter((d) => d.deviceId)
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold text-white/80">{label}</span>
      <select
        className="oic-input oic-select"
        value={activeDeviceId || 'default'}
        disabled={list.length === 0}
        onChange={(e) => void setActiveMediaDevice(e.target.value).catch(() => toast.error(`The ${label.toLowerCase()} could not be switched.`))}
      >
        {list.length === 0 && <option value="default">Not available</option>}
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { localParticipant } = useLocalParticipant()
  return (
    <>
      <PanelHeader title="Settings" subtitle="Switch devices without leaving the meeting." onClose={onClose} />
      <div className="oic-scroll flex flex-col gap-4 overflow-y-auto px-4 py-4">
        <DeviceList kind="videoinput" label="Camera" />
        <DeviceList kind="audioinput" label="Microphone" />
        <DeviceList kind="audiooutput" label="Speaker" />
        <p className="flex items-start gap-2 rounded-md bg-white/5 px-3 py-2.5 text-[12px] leading-5 text-white/60">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          On a weak network the video quality adapts automatically and your voice is given priority. You are connected as {localParticipant.name || 'yourself'}.
        </p>
      </div>
    </>
  )
}
