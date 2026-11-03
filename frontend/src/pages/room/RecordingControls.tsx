import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRoomContext } from '@livekit/components-react'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import { Circle, CircleStop, TriangleAlert } from 'lucide-react'
import type { ConsentDecision, RoomRecordingState } from '../../api/recordings'
import { errorMessage } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Feedback'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'

/** Server calls for recording in the room (employees: session; customers/guests: invitation token). Hosts also get start/stop. */
export type RecordingBackend = {
  state: () => Promise<RoomRecordingState>
  consent: (decision: ConsentDecision, noticeVersion: string) => Promise<RoomRecordingState>
  start?: (noticeVersion: string) => Promise<RoomRecordingState>
  stop?: () => Promise<RoomRecordingState>
}

const TOPIC = 'oic.recording'

/**
 * Recording in the meeting room: the policy's notice (Accept/Decline, or acknowledge for notification-only policies), the REC indicator
 * for everyone, and Start/Stop for hosts. The state comes from the API and is refreshed when the server pushes a change over LiveKit
 * (data topic "oic.recording" / room metadata), with a slow fallback poll.
 */
export function useRoomRecording(api: RecordingBackend | undefined) {
  const room = useRoomContext()
  const toast = useToast()
  const [state, setState] = useState<RoomRecordingState | null>(null)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef<string | null>(null)
  const lastStatus = useRef<string | null>(null)

  const refresh = useCallback(() => {
    if (!api) return
    api.state().then(setState).catch(() => undefined) // a slow API never disturbs the call
  }, [api])

  useEffect(() => {
    if (!api) return
    refresh()
    const t = window.setInterval(refresh, 10_000)
    const onData = (_p: Uint8Array, _who?: RemoteParticipant, _k?: unknown, topic?: string) => topic === TOPIC && refresh()
    room.on(RoomEvent.DataReceived, onData)
    room.on(RoomEvent.RoomMetadataChanged, refresh)
    return () => {
      window.clearInterval(t)
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.RoomMetadataChanged, refresh)
    }
  }, [api, room, refresh])

  // Ask once per notice version: whenever recording is possible in this meeting and this person has not answered yet.
  useEffect(() => {
    const p = state?.policy
    if (!state || !p || !state.available || state.myConsent) return
    if (p.requirement === 'DISABLED' || asked.current === p.noticeVersion) return
    asked.current = p.noticeVersion
    setNoticeOpen(true)
  }, [state])

  // Tell everyone when recording starts or stops.
  useEffect(() => {
    const s = state?.recording?.status ?? 'OFF'
    if (lastStatus.current !== null && lastStatus.current !== s) {
      if (s === 'RECORDING') toast.success('Recording has started.')
      else if (s === 'OFF' && lastStatus.current === 'RECORDING') toast.success('Recording has stopped.')
    }
    lastStatus.current = s
  }, [state, toast])

  async function decide(decision: ConsentDecision) {
    if (!api || !state?.policy) return
    setBusy(true)
    setError(null)
    try {
      setState(await api.consent(decision, state.policy.noticeVersion))
      setNoticeOpen(false)
    } catch (e) {
      setError(errorMessage(e, 'Your answer could not be saved. Please try again.'))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    if (!api?.start || !state?.policy) return
    setBusy(true)
    setError(null)
    try {
      setState(await api.start(state.policy.noticeVersion))
      setStartOpen(false)
    } catch (e) {
      setError(errorMessage(e, 'Recording could not be started.'))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!api?.stop) return
    try {
      setState(await api.stop())
    } catch (e) {
      toast.error(errorMessage(e, 'Recording could not be stopped.'))
    }
  }

  const status = state?.recording?.status
  const p = state?.policy
  const consentMode = p?.consentMode === 'CONSENT_REQUIRED'

  const indicator: ReactNode = status ? (
    <span
      role="status"
      data-testid="rec-indicator"
      data-status={status}
      className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold tracking-wide', status === 'RECORDING' ? 'bg-danger text-white' : 'bg-white/[0.12] text-white/85')}
      title={status === 'RECORDING' ? 'This meeting is being recorded' : 'Recording is starting'}
    >
      <span className={cn('size-2 rounded-full', status === 'RECORDING' ? 'animate-rec bg-white' : 'bg-white/60')} aria-hidden />
      {status === 'RECORDING' ? 'REC' : 'Starting recording…'}
    </span>
  ) : null

  // Recording switched off for this meeting type: the host still sees the control, disabled, with the reason
  // (previously it was hidden, which left hosts guessing why their meeting could not be recorded).
  const offReason = !state?.isHost || status ? null
    : !state.policy
      ? state.unavailableReason ?? 'Recording is not set up for this meeting type.'
      : state.policy.requirement === 'DISABLED'
        ? `Recording is switched off for "${state.policy.title}". An administrator can turn it on in Administration → Recording policies.`
        : null
  const control: ReactNode = offReason ? (
    <button type="button" className="oic-ctl" disabled data-testid="ctl-record" title={offReason} aria-label={`Record (unavailable): ${offReason}`}>
      <Circle className="size-5 text-white/40" /> <span className="hidden xl:inline">Record</span>
    </button>
  ) : state?.isHost && state.policy && state.policy.requirement !== 'DISABLED' ? (
    status ? (
      <button type="button" className="oic-ctl" data-on onClick={() => void stop()} disabled={!state.canStop} data-testid="ctl-record"
        title={state.canStop ? 'Stop recording' : 'Recording is mandatory for this meeting'}>
        <CircleStop className="size-5" /> <span className="hidden xl:inline">Stop recording</span>
      </button>
    ) : (
      <button type="button" className="oic-ctl" onClick={() => (setError(null), setStartOpen(true))} disabled={!state.canStart} data-testid="ctl-record"
        title={state.canStart ? 'Start recording' : state.unavailableReason ?? 'Recording is not available'}>
        <Circle className="size-5 text-[#F87171]" /> <span className="hidden xl:inline">Record</span>
      </button>
    )
  ) : null

  const withdraw = state?.myConsent === 'GRANTED' && consentMode && status ? (
    <button type="button" className="text-[12px] font-semibold text-cyan-400 hover:underline" onClick={() => setNoticeOpen(true)} data-testid="rec-change-consent">
      Recording consent
    </button>
  ) : null

  const notice = p ? (
    <div className="flex flex-col gap-3 text-[13.5px] leading-6 text-ink">
      {!p.confirmed && (
        <Alert tone="warning" title="Wording not confirmed">This notice is a placeholder pending internal confirmation of the recording policy.</Alert>
      )}
      <p className="whitespace-pre-wrap rounded-md border border-line bg-surface-muted p-3.5" data-testid="rec-notice-text">{p.noticeText}</p>
      <p className="text-[12px] text-ink-secondary">
        {p.title}{p.name ? ` · ${p.name}` : ''}{p.version ? ` v${p.version}` : ''} · Notice version {p.noticeVersion}
        {consentMode && p.stopOnWithdrawal ? ' · You can withdraw your consent at any time; the recording then stops.' : ''}
      </p>
    </div>
  ) : null

  const dialogs: ReactNode = p ? (
    <>
      <Dialog
        open={noticeOpen}
        onClose={() => setNoticeOpen(false)}
        title={status === 'RECORDING' ? 'This meeting is being recorded' : 'This meeting may be recorded'}
        size="md"
        dismissible={!busy}
        footer={
          consentMode ? (
            state?.myConsent === 'GRANTED' ? (
              <>
                <Button variant="secondary" onClick={() => setNoticeOpen(false)} disabled={busy}>Keep my consent</Button>
                <Button variant="danger" onClick={() => void decide('WITHDRAWN')} loading={busy} data-testid="rec-withdraw">Withdraw consent</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => void decide('DENIED')} disabled={busy} data-testid="rec-decline">Decline</Button>
                <Button onClick={() => void decide('GRANTED')} loading={busy} data-testid="rec-accept">Accept</Button>
              </>
            )
          ) : (
            <Button onClick={() => void decide('GRANTED')} loading={busy} data-testid="rec-accept">I understand</Button>
          )
        }
      >
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        {notice}
      </Dialog>
      <Dialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        title="Start recording?"
        description="Everyone in the meeting sees the recording indicator. By starting, you accept the notice below."
        size="md"
        dismissible={!busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => setStartOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void start()} loading={busy} data-testid="rec-start-confirm">Start recording</Button>
          </>
        }
      >
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        {state?.consent && consentMode && (
          <p className={cn('mb-3 flex items-start gap-2 text-[13px]', state.consent.ok ? 'text-success' : 'text-warning-ink')}>
            {!state.consent.ok && <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
            {state.consent.ok
              ? `Consent given by everyone required (${state.consent.granted}/${state.consent.required}).`
              : `Waiting for consent: ${[...state.consent.pending, ...state.consent.declined].join(', ') || 'participants'}${state.consent.declined.length ? ` (declined: ${state.consent.declined.join(', ')})` : ''}.`}
          </p>
        )}
        {notice}
      </Dialog>
    </>
  ) : null

  return { state, indicator, control, withdraw, dialogs }
}
