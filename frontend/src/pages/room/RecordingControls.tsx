import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRoomContext } from '@livekit/components-react'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import { AnimatePresence, motion } from 'motion/react'
import { Circle, CircleStop, TriangleAlert, X } from 'lucide-react'
import { SUPPORT } from '../../config'
import type { ConsentDecision, RoomRecordingState } from '../../api/recordings'
import { errorMessage } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Feedback'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { ConsentPopup, ConsentRequestPanel, type ConsentPopupPhase } from './RecordingConsentUi'

/** Server calls for recording in the room (employees: session; customers/guests: invitation token). Hosts also get start/stop. */
export type RecordingBackend = {
  state: () => Promise<RoomRecordingState>
  consent: (decision: ConsentDecision, noticeVersion: string) => Promise<RoomRecordingState>
  start?: (noticeVersion: string) => Promise<RoomRecordingState>
  stop?: () => Promise<RoomRecordingState>
  removeFromRequest?: (identity: string) => Promise<RoomRecordingState>
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
  const [stopOpen, setStopOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef<string | null>(null)
  const lastStatus = useRef<string | null>(null)
  // Responses can arrive out of order (poll + push + button); only the newest request may set the state, so an older
  // "RECORDING" answer can never bring back a REC indicator the server has already cleared.
  const seq = useRef(0)
  const apply = useCallback((s: RoomRecordingState, n: number) => {
    if (n >= seq.current) setState(s)
  }, [])

  const refresh = useCallback(() => {
    if (!api) return
    const n = ++seq.current
    api.state().then((s) => apply(s, n)).catch(() => undefined) // a slow API never disturbs the call
  }, [api, apply])

  // Every server message on the recording topic (recording-changed, consent-requested, consent-changed, consent-request-closed)
  // means "read the state again". The consent popup is driven by that state (state.request), never by the message itself: a message
  // can be missed (joining, reconnecting, a dropped data channel), the state cannot - and the 10 s poll and the room-metadata event
  // (which carries the open request's id) are independent fallbacks. Reconnecting re-reads it at once.
  useEffect(() => {
    if (!api) return
    refresh()
    const t = window.setInterval(refresh, 10_000)
    const onData = (_payload: Uint8Array, _who?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic === TOPIC) refresh()
    }
    room.on(RoomEvent.DataReceived, onData)
    room.on(RoomEvent.RoomMetadataChanged, refresh)
    room.on(RoomEvent.Reconnected, refresh)
    return () => {
      window.clearInterval(t)
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.RoomMetadataChanged, refresh)
      room.off(RoomEvent.Reconnected, refresh)
    }
  }, [api, room, refresh])

  const [bannerOpen, setBannerOpen] = useState(false)

  // Ask once per notice version. Mandatory recording starts on its own, so advance notice is needed the moment
  // someone joins; an optional meeting may never be recorded at all, so there nothing interrupts the call until
  // a host actually starts recording (or it is already running) - not proactively for a call nobody is recording.
  // A policy that only requires notification (not an individual consent decision) never blocks with a modal: the
  // notice is shown as a dismissible banner and acknowledgement is recorded automatically, not on a forced click.
  useEffect(() => {
    const p = state?.policy
    if (!state || !p || !state.available || state.myConsent) return
    if (p.requirement === 'DISABLED' || asked.current === p.noticeVersion) return
    const recordingNowOrSoon = state.recording?.status === 'RECORDING' || state.recording?.status === 'PENDING'
    if (p.requirement !== 'MANDATORY' && !recordingNowOrSoon) return
    asked.current = p.noticeVersion
    if (p.consentMode === 'CONSENT_REQUIRED') setNoticeOpen(true)
    else {
      setBannerOpen(true)
      void api?.consent('GRANTED', p.noticeVersion).then(setState).catch(() => undefined)
    }
  }, [state, api])

  // The host's consent request was closed: tell people why (the host's status panel and the participants' popups disappear).
  const prevRequest = useRef<string | null>(null)
  const myAnswer = useRef<{ id: string; decision: 'GRANTED' | 'DENIED' } | null>(null)
  useEffect(() => {
    if (!state) return
    const id = state.request?.id ?? null
    const prev = prevRequest.current
    const last = state.lastRequest
    if (prev && !id && last?.id === prev) {
      const iDeclined = myAnswer.current?.id === prev && myAnswer.current.decision === 'DENIED'
      if (last.status === 'DECLINED' && !iDeclined)
        toast.error(state.isHost ? `${last.reason ?? 'A participant declined recording.'} The recording request was cancelled.` : 'A participant declined, so this meeting will not be recorded.')
      else if (last.status === 'EXPIRED') toast.error(`The recording request expired. ${last.reason ?? ''}`.trim())
      else if (last.status === 'FAILED') toast.error(`Recording could not be started${last.reason ? `: ${last.reason}` : '.'}`)
      else if (last.status === 'CANCELLED' && !state.isHost) toast.success('The host withdrew the recording request. Nothing was recorded.')
      else if (last.status === 'CANCELLED') toast.success('Recording request cancelled.')
    }
    prevRequest.current = id
  }, [state, toast])

  // While the host's start dialog is open, follow the consent answers live, so it turns ready as soon as everyone has agreed.
  useEffect(() => {
    if (!startOpen) return
    const t = window.setInterval(refresh, 3_000)
    return () => window.clearInterval(t)
  }, [startOpen, refresh])
  useEffect(() => {
    if (startOpen && state?.consent?.ok) setError(null)
  }, [startOpen, state])

  // Tell everyone when recording starts or stops - always from the server's state, never optimistically.
  useEffect(() => {
    const s = state?.recording?.status ?? 'OFF'
    const prev = lastStatus.current
    if (prev !== null && prev !== s) {
      if (s === 'RECORDING') toast.success('Recording has started.')
      else if (s === 'OFF' && (prev === 'RECORDING' || prev === 'STOPPING')) {
        if (state?.lastRecording?.status === 'FAILED') toast.error(`Recording failed${state.lastRecording.reason ? `: ${state.lastRecording.reason}` : '.'}`)
        else toast.success('Recording stopped successfully. It will appear in the Recording Library once the file is verified.')
      } else if (s === 'OFF' && prev === 'PENDING' && state?.lastRecording?.status === 'FAILED')
        toast.error(`Recording could not be started${state.lastRecording.reason ? `: ${state.lastRecording.reason}` : '.'}`)
    }
    lastStatus.current = s
  }, [state, toast])

  // Accept/Decline in the consent popup: buttons lock while saving, a short confirmation is shown once the SERVER confirmed, then the
  // popup closes. On failure (network drop, server error) the error is shown and both buttons work again - nothing is assumed saved.
  const [phase, setPhase] = useState<ConsentPopupPhase>({ kind: 'ask' })
  const [answerError, setAnswerError] = useState<string | null>(null)
  async function answer(decision: 'GRANTED' | 'DENIED') {
    if (!api || !state?.policy || phase.kind !== 'ask') return
    const requestId = state.request?.id ?? null
    setPhase({ kind: 'saving', decision })
    setAnswerError(null)
    try {
      const n = ++seq.current
      const s = await api.consent(decision, state.policy.noticeVersion)
      if (requestId) myAnswer.current = { id: requestId, decision }
      setPhase({ kind: 'done', decision })
      apply(s, n)
      window.setTimeout(() => {
        setPhase({ kind: 'ask' })
        setNoticeOpen(false)
      }, 1600)
    } catch (e) {
      setAnswerError(errorMessage(e, 'Your response could not be saved. Please check your connection and try again.'))
      setPhase({ kind: 'ask' })
      refresh()
    }
  }

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

  async function removeFromRequest(identity: string) {
    if (!api?.removeFromRequest) return
    try {
      const n = ++seq.current
      apply(await api.removeFromRequest(identity), n)
    } catch (e) {
      toast.error(errorMessage(e, 'This person could not be removed from the request.'))
      refresh()
    }
  }

  const [cancelling, setCancelling] = useState(false)
  async function cancelRequest() {
    if (!api?.stop) return
    setCancelling(true)
    try {
      const n = ++seq.current
      apply(await api.stop(), n)
    } catch (e) {
      toast.error(errorMessage(e, 'The recording request could not be cancelled. Please try again.'))
      refresh()
    } finally {
      setCancelling(false)
    }
  }

  async function start() {
    if (!api?.start || !state?.policy) return
    setBusy(true)
    setError(null)
    try {
      const n = ++seq.current
      apply(await api.start(state.policy.noticeVersion), n)
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
    setBusy(true)
    try {
      const n = ++seq.current
      apply(await api.stop(), n)
    } catch (e) {
      toast.error(errorMessage(e, 'Recording could not be stopped. Please try again.'))
      refresh() // show the server's actual state (it may well have stopped)
    } finally {
      setStopOpen(false)
      setBusy(false)
    }
  }

  const status = state?.recording?.status
  const stopping = status === 'STOPPING'
  const p = state?.policy
  const consentMode = p?.consentMode === 'CONSENT_REQUIRED'

  // Who is asked: everyone in the open request except the host who made it, until they have answered it. A disconnected or
  // reconnecting participant is asked again as soon as their state is read (the request is the server's, not this page's).
  const req = state?.request?.status === 'OPEN' ? state.request : null
  const askRequest = !!req && consentMode && !req.isRequester && !req.myDecision
  const askNotice = noticeOpen && consentMode && state?.myConsent !== 'GRANTED'
  const popupVariant = useRef<'request' | 'notice'>('request')
  if (askRequest) popupVariant.current = 'request'
  else if (askNotice) popupVariant.current = 'notice'
  const popupOpen = askRequest || askNotice || phase.kind !== 'ask'

  const requestChip: ReactNode = req && !status ? (
    <span role="status" data-testid="rec-request-indicator" className="inline-flex h-8 items-center gap-1.5 rounded-full bg-amber-400/15 px-3 text-[12px] font-semibold text-amber-200"
      title="The host has asked to record this meeting. Recording starts only after everyone has accepted.">
      <span className="size-2 rounded-full bg-amber-400 motion-safe:animate-pulse" aria-hidden />
      <span className="hidden sm:inline">Recording requested · </span>{req.accepted}/{req.total}
    </span>
  ) : null

  const indicator: ReactNode = status ? (
    <span
      role="status"
      data-testid="rec-indicator"
      data-status={status}
      className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold tracking-wide', status === 'RECORDING' ? 'bg-danger text-white' : 'bg-white/[0.12] text-white/85')}
      title={status === 'RECORDING' ? 'This meeting is being recorded' : stopping ? 'Recording is stopping' : 'Recording is starting'}
    >
      <span className={cn('size-2 rounded-full', status === 'RECORDING' ? 'animate-rec bg-white' : 'bg-white/60')} aria-hidden />
      {status === 'RECORDING' ? 'REC' : stopping ? 'Stopping recording…' : 'Starting recording…'}
    </span>
  ) : requestChip

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
      <button type="button" className="oic-ctl" data-on onClick={() => setStopOpen(true)} disabled={!state.canStop || busy} data-testid="ctl-record"
        title={stopping ? 'Recording is stopping' : state.canStop ? 'Stop recording' : 'Recording is mandatory for this meeting'}>
        <CircleStop className="size-5" /> <span className="hidden xl:inline">{stopping ? 'Stopping…' : 'Stop recording'}</span>
      </button>
    ) : req ? (
      <button type="button" className="oic-ctl" onClick={() => void cancelRequest()} disabled={!state.canCancelRequest || cancelling} data-testid="ctl-record"
        title="Waiting for everyone to accept - click to cancel the recording request">
        <Circle className="size-5 text-amber-300" /> <span className="hidden xl:inline">Cancel request</span>
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
      {/* Internal note for staff only - a customer or guest must not be told about our pending policy work (GoodDay I39JOD). */}
      {!p.confirmed && state?.isHost && (
        <Alert tone="warning" title="Wording not confirmed">This notice is a placeholder pending internal confirmation of the recording policy.</Alert>
      )}
      <p className="whitespace-pre-wrap rounded-md border border-line bg-surface-muted p-3.5" data-testid="rec-notice-text">{p.noticeText}</p>
      {/* Policy/version details are internal: hosts only. Participants see just the wording (and their withdrawal right). */}
      {(state?.isHost || (consentMode && p.stopOnWithdrawal)) && (
        <p className="text-[12px] text-ink-secondary">
          {state?.isHost && <>{p.title}{p.name ? ` · ${p.name}` : ''}{p.version ? ` v${p.version}` : ''} · Notice version {p.noticeVersion}</>}
          {state?.isHost && consentMode && p.stopOnWithdrawal ? ' · ' : ''}
          {consentMode && p.stopOnWithdrawal ? 'You can withdraw your consent at any time; the recording then stops.' : ''}
        </p>
      )}
    </div>
  ) : null

  // Informational only - nothing to accept, nothing blocks the meeting; the acknowledgement is recorded when it is shown
  // (the effect above - unchanged). Only ever shown for a policy that does not require an individual consent decision.
  // Customer-facing (13 Nov 2026 redesign): one title, the policy's own wording, the support address and ONE button - no
  // placeholder/version/policy details. The "not confirmed" configuration note is for hosts only. A floating card over the
  // video (never pushes the call down), safe-area aware, height-capped, 44 px touch targets (GoodDay I39JOD).
  const banner: ReactNode = (
    <AnimatePresence>
      {bannerOpen && p && (
        <motion.div
          key="rec-notice"
          role="dialog"
          aria-modal="false"
          aria-labelledby="rec-notice-title"
          data-testid="rec-notice-banner"
          className="oic-rec-notice"
          initial={{ opacity: 0, scale: 0.96, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -6 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[#FEE2E2]" aria-hidden>
              <span className="size-3 rounded-full bg-[#EF4444] shadow-[0_0_0_3px_rgb(239_68_68/0.18)]" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="rec-notice-title" className="text-[15px] leading-5 font-semibold tracking-[-0.01em] text-[#0F172A]">Meeting Recording Notice</h2>
              <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-[1.45] text-[#334155]" data-testid="rec-notice-text">{p.noticeText}</p>
              <p className="mt-2 text-[12.5px] text-[#64748B]">
                For assistance: <a className="font-medium text-[#2563EB] hover:underline" href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</a>
              </p>
              {!p.confirmed && state?.isHost && (
                <p className="mt-2 rounded-lg bg-[#FEF3C7] px-2.5 py-1.5 text-[11.5px] leading-4 text-[#92400E]" data-testid="rec-notice-internal">
                  Visible to hosts only: this wording is not confirmed yet (Administration → Recording policies).
                </p>
              )}
            </div>
            <button type="button" onClick={() => setBannerOpen(false)} aria-label="Close the recording notice" data-testid="rec-notice-close"
              className="-mr-2 -mt-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-[#94A3B8] hover:bg-black/[0.05] hover:text-[#334155]">
              <X className="size-[18px]" />
            </button>
          </div>
          <button type="button" onClick={() => setBannerOpen(false)} data-testid="rec-notice-ok"
            className="mt-3.5 flex min-h-11 w-full items-center justify-center rounded-xl bg-[#2563EB] px-4 text-[14.5px] font-semibold text-white shadow-[0_6px_16px_-6px_rgb(37_99_235/0.7)] transition hover:bg-[#1D4ED8] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-2">
            OK, got it
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )

  const dialogs: ReactNode = p ? (
    <>
      {/* Accept / Decline (host's request, or recording running / mandatory): the consent popup. */}
      <ConsentPopup
        open={popupOpen}
        variant={popupVariant.current}
        requestedBy={req?.requestedBy}
        recordingNow={status === 'RECORDING'}
        policy={p}
        phase={phase}
        error={answerError}
        onAccept={() => void answer('GRANTED')}
        onDecline={() => void answer('DENIED')}
      />
      {/* The host's live view of who has answered. */}
      {state?.isHost && (
        <ConsentRequestPanel request={req} onCancel={() => void cancelRequest()} cancelling={cancelling}
          onRemove={api?.removeFromRequest ? (identity) => void removeFromRequest(identity) : undefined} />
      )}
      {/* Withdrawing consent that was given, or acknowledging a notification-only notice. */}
      <Dialog
        open={noticeOpen && !askNotice && phase.kind === 'ask'}
        onClose={() => setNoticeOpen(false)}
        title={status === 'RECORDING' ? 'This meeting is being recorded' : 'This meeting may be recorded'}
        size="md"
        dismissible={!busy}
        footer={
          consentMode ? (
            <>
              <Button variant="secondary" onClick={() => setNoticeOpen(false)} disabled={busy}>Keep my consent</Button>
              <Button variant="danger" onClick={() => void decide('WITHDRAWN')} loading={busy} data-testid="rec-withdraw">Withdraw consent</Button>
            </>
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
            <Button onClick={() => void start()} loading={busy} data-testid="rec-start-confirm">
              {consentMode && state?.consent && !state.consent.ok ? 'Request recording' : 'Start recording'}
            </Button>
          </>
        }
      >
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        {state?.consent && consentMode && (
          <p className={cn('mb-3 flex items-start gap-2 text-[13px]', state.consent.ok ? 'text-success' : 'text-warning-ink')} data-testid="rec-start-consent">
            {!state.consent.ok && <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
            {state.consent.ok
              ? `Consent given by everyone required (${state.consent.granted}/${state.consent.required}). Recording starts right away.`
              : 'Everyone in the meeting will be asked to accept. Recording begins only after all required participants have accepted; you will see each person\'s answer live.'}
          </p>
        )}
        {notice}
      </Dialog>
      <Dialog
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        title="Are you sure you want to stop recording?"
        size="sm"
        dismissible={!busy}
        footer={
          <>
            <Button variant="secondary" onClick={() => setStopOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="danger" onClick={() => void stop()} loading={busy} data-testid="rec-stop-confirm">Yes, stop recording</Button>
          </>
        }
      >
        <p className="text-[13.5px] leading-6 text-ink-secondary">
          Once stopped, recording will not continue unless an authorised host starts it again, subject to the applicable recording policy.
        </p>
      </Dialog>
    </>
  ) : null

  return { state, indicator, control, withdraw, dialogs, banner }
}
