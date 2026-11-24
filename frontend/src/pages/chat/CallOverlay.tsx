import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check, ChevronDown, Mic, MicOff, Minimize2, Phone, PhoneOff, Signal, SignalLow, SignalZero, UserPlus, Users, Volume1, Volume2, Wifi, X,
} from 'lucide-react'
import { appSpeaker } from '../room/androidBridge'
import type { Call } from '../../api/calls'
import { errorMessage } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { useChat } from './ChatProvider'
import { matchesIdentity, useCalls, type ActiveCall } from './CallProvider'
import { PresenceDot, usePeopleSearch } from './ChatParts'
import { usePhone } from './usePhone'
import './chat.css'

const stateLabel: Record<string, string> = {
  RINGING: 'Ringing…',
  DECLINED: 'Declined',
  MISSED: 'No answer',
  BUSY: 'Busy',
  LEFT: 'Left',
  CANCELLED: 'Cancelled',
}

function callName(c: Call, meId: string | null) {
  if (c.title) return c.title
  const others = c.participants.filter((p) => p.id !== meId)
  return others.length === 1 ? others[0].name : others.map((p) => p.name.split(' ')[0]).join(', ')
}

function Timer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  return <span className="tabular-nums">{h ? `${h}:` : ''}{mm}:{String(s % 60).padStart(2, '0')}</span>
}

/**
 * Incoming-call screens, the in-call screen and the "call in another window" bar, in the iPhone look.
 * Phones: full-screen incoming and in-call screens (the call can be minimised to a green pill to keep using the portal).
 * Computers: compact dark cards at the top right / bottom right. Never blocks navigation on computers.
 */
export function CallOverlay() {
  const calls = useCalls()
  const chat = useChat()
  const phone = usePhone()
  const meId = chat.meId
  const ringing = calls.incoming
  return (
    <>
      {phone && ringing.length > 0 ? (
        <IncomingPhone c={ringing[0]} more={ringing.length - 1} />
      ) : (
        <div className="ios pointer-events-none fixed top-3 right-3 left-3 z-[70] flex flex-col items-end gap-2 sm:left-auto" aria-live="assertive">
          <AnimatePresence>
            {ringing.map((c) => (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, y: -16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -12 }}
                className="ios-call-bg pointer-events-auto w-full overflow-hidden rounded-[22px] shadow-[0_18px_48px_rgb(0_0_0/0.4)] ring-1 ring-white/10 sm:w-[370px]"
                role="alertdialog"
                aria-label={`Incoming call from ${c.startedBy?.name}`}
                data-testid="call-incoming"
              >
                <div className="flex items-center gap-3 p-3.5">
                  <span className="relative flex size-[52px] shrink-0 items-center justify-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-white/15" />
                    <Avatar name={c.startedBy?.name ?? '?'} userId={c.startedBy?.id} size={52} className="ring-2 ring-white/30" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-white/65">{c.type === 'GROUP' || c.title ? 'Group audio call' : 'OneInsure audio call'}</p>
                    <p className="truncate text-[17px] font-semibold" data-testid="call-incoming-name">{c.startedBy?.name}</p>
                    <p className="truncate text-[13px] text-white/60">{c.title ? c.title : c.startedBy?.code ? `Employee code ${c.startedBy.code}` : 'is calling you'}</p>
                  </div>
                  <button type="button" onClick={() => calls.decline(c.id)} aria-label="Decline" title="Decline" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#ff3b30] active:brightness-90" data-testid="call-decline">
                    <PhoneOff className="size-5" />
                  </button>
                  <button type="button" onClick={() => calls.accept(c.id)} aria-label="Accept" title="Accept" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#34c759] active:brightness-90" data-testid="call-accept" autoFocus>
                    <Phone className="size-5" />
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {calls.elsewhere && !calls.active && (
        <div className="ios fixed right-3 bottom-[calc(4.75rem+var(--sab))] left-3 z-[65] flex items-center gap-3 rounded-[18px] bg-[#1c1c1e]/95 px-4 py-2.5 text-white shadow-[0_10px_30px_rgb(0_0_0/0.3)] backdrop-blur sm:left-auto md:bottom-4" data-testid="call-elsewhere">
          <span className="size-2.5 animate-pulse rounded-full bg-[#34c759]" />
          <span className="min-w-0 flex-1 truncate text-[14px]">In a call with {callName(calls.elsewhere, meId)} in another window</span>
          <Button size="sm" onClick={calls.joinHere}>Join here</Button>
        </div>
      )}

      <AnimatePresence>{calls.active && <ActivePanel key={calls.active.call.id} a={calls.active} meId={meId} phone={phone} />}</AnimatePresence>
    </>
  )
}

/** Phones: the iPhone-style full-screen incoming call. */
function IncomingPhone({ c, more }: { c: Call; more: number }) {
  const calls = useCalls()
  return (
    <motion.div
      initial={false}
      className="ios ios-call-bg fixed inset-0 z-[70] flex flex-col items-center px-6 pt-[max(3.5rem,env(safe-area-inset-top))] pb-[max(3rem,var(--sab))] text-center"
      role="alertdialog"
      aria-label={`Incoming call from ${c.startedBy?.name}`}
      aria-live="assertive"
      data-testid="call-incoming"
    >
      <p className="text-[15px] text-white/70">{c.type === 'GROUP' || c.title ? 'Group audio call' : 'OneInsure audio call'}</p>
      <p className="mt-1 max-w-full truncate text-[32px] leading-[40px] font-normal tracking-[-0.02em]" data-testid="call-incoming-name">{c.startedBy?.name}</p>
      <p className="mt-0.5 max-w-full truncate text-[15px] text-white/60">{c.title ? c.title : c.startedBy?.code ? `Employee code ${c.startedBy.code}` : 'is calling you'}</p>
      <span className="relative mt-10 flex size-[112px] items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-white/10" />
        <Avatar name={c.startedBy?.name ?? '?'} userId={c.startedBy?.id} size={112} className="ring-4 ring-white/15" />
      </span>
      {more > 0 && <p className="mt-6 text-[13px] text-white/60">+{more} more call{more > 1 ? 's' : ''} waiting</p>}
      <div className="flex-1" />
      <div className="flex w-full max-w-[300px] items-start justify-between">
        <span className="flex flex-col items-center gap-2">
          <button type="button" onClick={() => calls.decline(c.id)} aria-label="Decline" className="flex size-[76px] items-center justify-center rounded-full bg-[#ff3b30] shadow-[0_8px_24px_rgb(255_59_48/0.4)] active:brightness-90" data-testid="call-decline">
            <PhoneOff className="size-8" />
          </button>
          <span className="ios-call-label">Decline</span>
        </span>
        <span className="flex flex-col items-center gap-2">
          <button type="button" onClick={() => calls.accept(c.id)} aria-label="Accept" className="flex size-[76px] items-center justify-center rounded-full bg-[#34c759] shadow-[0_8px_24px_rgb(52_199_89/0.4)] active:brightness-90" data-testid="call-accept" autoFocus>
            <Phone className="size-8" />
          </button>
          <span className="ios-call-label">Accept</span>
        </span>
      </div>
    </motion.div>
  )
}

function ActivePanel({ a, meId, phone }: { a: ActiveCall; meId: string | null; phone: boolean }) {
  const calls = useCalls()
  const [small, setSmall] = useState(false)
  const [adding, setAdding] = useState(false)
  const [settings, setSettings] = useState(false)
  // Android app 1.2.2+: real loudspeaker / earpiece switch. null = no switch here (computers, browsers, older apps): the
  // button opens the Microphone and speaker chooser instead.
  const [speaker, setSpeaker] = useState<boolean | null>(null)
  useEffect(() => {
    if (a.phase === 'connected') void appSpeaker().then(setSpeaker)
  }, [a.phase])
  const speakerLabel = speaker === null ? 'Microphone and speaker' : speaker ? 'Speaker on' : 'Speaker off'
  const onSpeaker = () => (speaker === null ? setSettings(true) : void appSpeaker(!speaker).then((v) => setSpeaker(v ?? speaker)))
  const c = a.call
  const iStarted = c.startedBy?.id === meId
  const people = c.participants.filter((p) => p.id !== meId)
  const group = !!c.title || people.length > 1
  const status =
    a.phase === 'ended' ? a.endedText ?? 'Call ended'
      : a.phase === 'calling' ? (people.some((p) => p.state === 'RINGING') ? 'Ringing…' : 'Calling…')
        : a.phase === 'connecting' ? 'Connecting…'
          : a.phase === 'reconnecting' ? 'Reconnecting…'
            : null
  const QualityIcon = a.quality === 'excellent' ? Signal : a.quality === 'good' ? Wifi : a.quality === 'poor' ? SignalLow : a.quality === 'lost' ? SignalZero : null
  const open = c.participants.filter((p) => p.state === 'ACCEPTED' || p.state === 'RINGING').length
  const statusLine = (
    <span className="inline-flex items-center gap-1.5" data-testid="call-status">
      {status ?? (a.connectedAt ? <Timer since={a.connectedAt} /> : 'Connected')}
      {QualityIcon && a.phase === 'connected' && <QualityIcon className={cn('size-3.5', a.quality === 'poor' || a.quality === 'lost' ? 'text-[#ffcc00]' : 'text-white/60')} aria-label={`Connection ${a.quality}`} />}
    </span>
  )
  const dialogs = (
    <>
      <AddPeopleDialog open={adding} onClose={() => setAdding(false)} exclude={c.participants.filter((p) => p.state === 'ACCEPTED' || p.state === 'RINGING').map((p) => p.id)} room={Math.max(0, calls.maxParticipants - open)} />
      <DeviceDialog open={settings} onClose={() => setSettings(false)} />
    </>
  )
  const hangLabel = c.type === 'DIRECT' ? 'End call' : 'Leave call'

  const participantList = (
    <ul className={cn('overflow-y-auto', phone ? 'mt-6 flex max-h-[30vh] w-full flex-wrap justify-center gap-x-5 gap-y-3' : 'max-h-[34vh] px-2 pb-1')}>
      {c.participants.map((p) => {
        const speaking = a.speaking.some((s) => matchesIdentity(p.id, s))
        const me = p.id === meId
        const state = p.state === 'ACCEPTED' ? (me && a.muted ? 'Muted' : p.connected || me ? (speaking ? 'Speaking' : '') : 'Joining…') : stateLabel[p.state] ?? ''
        return phone ? (
          <li key={p.id} className="flex w-[72px] flex-col items-center gap-1">
            <span className={cn('rounded-full ring-[3px] transition-[box-shadow]', speaking ? 'ring-[#34c759] shadow-[0_0_0_6px_rgb(52_199_89/0.25)]' : 'ring-transparent')}>
              <Avatar name={p.name} userId={p.id} size={52} className="ring-1 ring-white/25" />
            </span>
            <span className="w-full truncate text-[12px]">{me ? 'You' : p.name.split(' ')[0]}</span>
            <span className="h-3.5 text-[11px] text-white/55">{state}</span>
          </li>
        ) : (
          <li key={p.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className={cn('rounded-full ring-2 transition-[box-shadow]', speaking ? 'ring-[#34c759] shadow-[0_0_0_4px_rgb(52_199_89/0.25)]' : 'ring-transparent')}>
              <Avatar name={p.name} userId={p.id} size={30} className="ring-1 ring-white/25" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px]">{me ? 'You' : p.name}</span>
            <span className="shrink-0 text-[12px] text-white/60">{state}</span>
            {me && a.muted && <MicOff className="size-3.5 text-white/60" />}
          </li>
        )
      })}
    </ul>
  )

  // Phones: full-screen in-call screen, or a green pill at the top while minimised.
  if (phone)
    return small ? (
      <motion.section
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        className="ios fixed top-[max(0.5rem,env(safe-area-inset-top))] left-1/2 z-[66] flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#34c759] py-1.5 pr-1.5 pl-4 text-white shadow-[0_8px_24px_rgb(0_0_0/0.25)]"
        aria-label="Audio call"
        data-testid="call-panel"
      >
        <button type="button" onClick={() => setSmall(false)} className="flex items-center gap-2 text-[14px] font-semibold" aria-label="Return to the call">
          <Phone className="size-4" />
          <span className="max-w-[120px] truncate" data-testid="call-title">{callName(c, meId)}</span>
          {statusLine}
        </button>
        <button type="button" onClick={calls.hangUp} aria-label={hangLabel} className="flex size-8 items-center justify-center rounded-full bg-[#ff3b30]" data-testid="call-hangup">
          <PhoneOff className="size-4" />
        </button>
        {dialogs}
      </motion.section>
    ) : (
      <motion.section
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 40 }}
        className="ios ios-call-bg fixed inset-0 z-[66] flex flex-col items-center px-6 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(2.5rem,var(--sab))] text-center"
        aria-label="Audio call"
        data-testid="call-panel"
      >
        <div className="flex w-full justify-start">
          <button type="button" onClick={() => setSmall(true)} aria-label="Minimise the call" title="Minimise" className="ios-call-btn size-10">
            <Minimize2 className="size-[18px]" />
          </button>
        </div>
        <span className="mt-4">
          {group ? (
            <span className="flex size-[96px] items-center justify-center rounded-full bg-white/15"><Users className="size-11" /></span>
          ) : (
            <Avatar name={people[0]?.name ?? '?'} userId={people.length === 1 ? people[0]?.id : null} size={96} className="ring-4 ring-white/15" />
          )}
        </span>
        <p className="mt-4 max-w-full truncate text-[30px] leading-[38px] font-normal tracking-[-0.02em]" data-testid="call-title">{callName(c, meId)}</p>
        <p className={cn('mt-1 text-[17px]', a.phase === 'reconnecting' ? 'text-[#ffcc00]' : 'text-white/70')}>{statusLine}</p>
        {(group || c.participants.length > 2) && participantList}
        {a.micError && <p className="mt-4 rounded-xl bg-[#ffcc00]/15 px-3 py-2 text-[13px] text-[#ffe680]" role="alert">{a.micError}</p>}
        <div className="flex-1" />
        {a.phase !== 'ended' && (
          <>
            <div className="grid w-full max-w-[320px] grid-cols-3 gap-y-6">
              <CallKey label={a.muted ? 'Unmute' : 'Mute'} caption="mute" onClick={calls.toggleMute} active={a.muted} testId="call-mute">
                {a.muted ? <MicOff className="size-7" /> : <Mic className="size-7" />}
              </CallKey>
              <CallKey label={speakerLabel} caption="speaker" onClick={onSpeaker} active={!!speaker} testId="call-speaker">
                {speaker === false ? <Volume1 className="size-7" /> : <Volume2 className="size-7" />}
              </CallKey>
              <CallKey label="Add people" caption="add" onClick={() => setAdding(true)} disabled={open >= calls.maxParticipants} testId="call-add">
                <UserPlus className="size-7" />
              </CallKey>
            </div>
            <button type="button" onClick={calls.hangUp} aria-label={hangLabel} title={hangLabel} className="mt-9 flex size-[76px] items-center justify-center rounded-full bg-[#ff3b30] shadow-[0_8px_24px_rgb(255_59_48/0.4)] active:brightness-90" data-testid="call-hangup">
              <PhoneOff className="size-8" />
            </button>
            {c.type === 'GROUP' && iStarted && (
              <button type="button" onClick={calls.endForAll} className="mt-4 text-[14px] font-medium text-white/70 active:text-white" data-testid="call-end-all">
                End call for everyone
              </button>
            )}
          </>
        )}
        {dialogs}
      </motion.section>
    )

  // Computers: compact dark card at the bottom right.
  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      className="ios ios-call-bg fixed right-3 bottom-[calc(4.75rem+var(--sab))] left-3 z-[66] overflow-hidden rounded-[22px] shadow-[0_18px_48px_rgb(0_0_0/0.4)] ring-1 ring-white/10 sm:left-auto sm:w-[370px] md:bottom-4"
      aria-label="Audio call"
      data-testid="call-panel"
    >
      <header className="flex items-center gap-3 px-4 pt-3.5 pb-2">
        {group ? (
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/15"><Users className="size-5" /></span>
        ) : (
          <Avatar name={people[0]?.name ?? '?'} userId={people.length === 1 ? people[0]?.id : null} size={44} className="ring-2 ring-white/20" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold" data-testid="call-title">{callName(c, meId)}</p>
          <p className={cn('text-[13px]', a.phase === 'ended' ? 'text-white/80' : a.phase === 'reconnecting' ? 'text-[#ffcc00]' : 'text-white/70')}>{statusLine}</p>
        </div>
        <button type="button" onClick={() => setSmall((v) => !v)} aria-label={small ? 'Show call details' : 'Make the call panel smaller'} className="ios-call-btn size-8">
          <ChevronDown className={cn('size-4 transition-transform', small && 'rotate-180')} />
        </button>
      </header>

      {!small && participantList}

      {a.micError && <p className="mx-4 mb-1 rounded-lg bg-[#ffcc00]/15 px-2.5 py-1.5 text-[12px] text-[#ffe680]" role="alert">{a.micError}</p>}

      {a.phase !== 'ended' && (
        <div className="flex items-center justify-center gap-4 px-4 pt-2 pb-4">
          <RoundButton label={a.muted ? 'Unmute' : 'Mute'} onClick={calls.toggleMute} active={a.muted} testId="call-mute">
            {a.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </RoundButton>
          <RoundButton label={speakerLabel} onClick={onSpeaker} active={!!speaker} testId="call-speaker">
            {speaker === false ? <Volume1 className="size-5" /> : <Volume2 className="size-5" />}
          </RoundButton>
          <RoundButton label="Add people" onClick={() => setAdding(true)} disabled={open >= calls.maxParticipants} testId="call-add">
            <UserPlus className="size-5" />
          </RoundButton>
          <button
            type="button"
            onClick={calls.hangUp}
            aria-label={hangLabel}
            title={hangLabel}
            className="flex size-[52px] items-center justify-center rounded-full bg-[#ff3b30] text-white shadow-[0_6px_16px_rgb(255_59_48/0.45)] active:brightness-90"
            data-testid="call-hangup"
          >
            <PhoneOff className="size-5" />
          </button>
        </div>
      )}
      {a.phase !== 'ended' && c.type === 'GROUP' && iStarted && (
        <button type="button" onClick={calls.endForAll} className="mb-3 w-full text-center text-[13px] font-medium text-white/65 hover:text-white" data-testid="call-end-all">
          End call for everyone
        </button>
      )}
      {dialogs}
    </motion.section>
  )
}

/** Phone in-call key: 76 px translucent circle with a caption underneath (white when on). */
function CallKey({ label, caption, onClick, active, disabled, testId, children }: { label: string; caption: string; onClick: () => void; active?: boolean; disabled?: boolean; testId?: string; children: ReactNode }) {
  return (
    <span className="flex flex-col items-center gap-2">
      <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={active} className="ios-call-btn size-[76px]" data-testid={testId}>
        {children}
      </button>
      <span className="ios-call-label">{caption}</span>
    </span>
  )
}

function RoundButton({ label, onClick, active, disabled, testId, children }: { label: string; onClick: () => void; active?: boolean; disabled?: boolean; testId?: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={active} className="ios-call-btn size-[52px]" data-testid={testId}>
      {children}
    </button>
  )
}

function AddPeopleDialog({ open, onClose, exclude, room }: { open: boolean; onClose: () => void; exclude: string[]; room: number }) {
  const calls = useCalls()
  const toast = useToast()
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const { people } = usePeopleSearch(term, open)
  useEffect(() => {
    if (open) {
      setTerm('')
      setPicked([])
    }
  }, [open])
  return (
    <Dialog
      layer="z-[69]"
      open={open}
      onClose={onClose}
      title="Add people to the call"
      description={`They will be called now. Room for ${room} more.`}
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            loading={busy}
            disabled={picked.length === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await calls.invite(picked)
                onClose()
              } catch (e) {
                toast.error(errorMessage(e, 'They could not be added.'))
              } finally {
                setBusy(false)
              }
            }}
            data-testid="call-add-confirm"
          >
            Call {picked.length || ''}
          </Button>
        </>
      }
    >
      <label className="flex h-10 items-center gap-2 rounded-md border border-line px-3 focus-within:border-brand-500">
        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search colleagues" aria-label="Search colleagues" className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none" />
        {term && <button type="button" onClick={() => setTerm('')} aria-label="Clear"><X className="size-4 text-ink-muted" /></button>}
      </label>
      <div className="mt-2 max-h-[44vh] overflow-y-auto">
        {people.filter((p) => !exclude.includes(p.id)).map((p) => {
          const on = picked.includes(p.id)
          const unavailable = p.presence?.state === 'IN_CALL' || p.presence?.state === 'IN_MEETING'
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPicked(on ? picked.filter((x) => x !== p.id) : picked.length < room ? [...picked, p.id] : picked)}
              className={cn('flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-muted', on && 'bg-brand-50')}
              data-testid="call-add-person"
            >
              <span className="relative">
                <Avatar name={p.name} userId={p.id} size={34} />
                <PresenceDot presence={p.presence} className="absolute -right-0.5 -bottom-0.5 size-2.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
                <span className="block truncate text-[12px] text-ink-muted">{unavailable ? (p.presence?.state === 'IN_CALL' ? 'In a call' : 'In a meeting') : [p.code, p.designation].filter(Boolean).join(' · ')}</span>
              </span>
              {on && <Check className="size-4 text-brand-600" />}
            </button>
          )
        })}
      </div>
    </Dialog>
  )
}

/** Chrome, Edge and Firefox on computers can send the call to a chosen speaker; Safari and phone browsers cannot. */
const canPickSpeaker = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** Where to change the speaker when the page cannot (said plainly for each kind of device). */
function speakerHelp() {
  const ua = navigator.userAgent
  const iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  if (iOS) return 'On iPhone and iPad, Apple chooses where call sound plays. To change it, open Control Center and tap the audio output (AirPlay) button, or connect headphones.'
  if (/Android/i.test(ua)) return 'Phone browsers play calls through the phone’s own speaker choice. For a Speaker on/off switch, use the OneInsure Connect Android app (version 1.2.2 or later), or connect headphones.'
  if (/Macintosh/.test(ua)) return 'Safari plays calls through the Mac’s current sound output. Change it from the Sound icon in the menu bar or System Settings → Sound, or use Chrome or Edge to choose a speaker here.'
  return 'This browser plays calls through the computer’s current sound output. Change it in the system sound settings, or use Chrome or Edge to choose a speaker here.'
}

function DeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const calls = useCalls()
  const [d, setD] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; input: string; output: string } | null>(null)
  useEffect(() => {
    if (open) void calls.devices().then(setD)
  }, [open, calls])
  const select = 'h-10 w-full rounded-md border border-line bg-surface px-3 text-[13.5px] outline-none focus:border-brand-500'
  return (
    <Dialog layer="z-[69]" open={open} onClose={onClose} title="Microphone and speaker" size="sm" footer={<Button onClick={onClose}>Done</Button>}>
      {!d ? (
        <p className="text-[13px] text-ink-muted">Loading devices…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
            Microphone
            <select className={select} value={d.input} onChange={(e) => (calls.setInput(e.target.value), setD({ ...d, input: e.target.value }))}>
              <option value="">Default</option>
              {d.inputs.map((x) => <option key={x.deviceId} value={x.deviceId}>{x.label || 'Microphone'}</option>)}
            </select>
          </label>
          {d.outputs.length > 0 && canPickSpeaker() ? (
            <label className="flex flex-col gap-1 text-[13px] font-medium text-ink">
              Speaker
              <select className={select} value={d.output} onChange={(e) => (calls.setOutput(e.target.value), setD({ ...d, output: e.target.value }))}>
                <option value="">Default</option>
                {d.outputs.map((x) => <option key={x.deviceId} value={x.deviceId}>{x.label || 'Speaker'}</option>)}
              </select>
            </label>
          ) : (
            <p className="text-[12.5px] leading-[18px] text-ink-muted" data-testid="call-speaker-help">{speakerHelp()}</p>
          )}
        </div>
      )}
    </Dialog>
  )
}
