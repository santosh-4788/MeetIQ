import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronDown, ChevronUp, CircleAlert, LoaderCircle, ShieldCheck, Users, X } from 'lucide-react'
import type { ConsentMemberStatus, RecordingConsentRequest, RoomRecordingState } from '../../api/recordings'
import { ConnectMark } from '../../components/brand/ConnectLogo'
import { cn } from '../../lib/cn'

type Policy = NonNullable<RoomRecordingState['policy']>

/** Recording icon: a red dot with a soft pulse ring (motion respects prefers-reduced-motion via the motion-safe variant). */
function RecIcon({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[#EF4444]/12 ring-1 ring-[#F87171]/30', className)} aria-hidden>
      <span className="absolute inset-0 rounded-full bg-[#EF4444]/25 motion-safe:animate-ping [animation-duration:1.8s]" />
      <span className="relative size-3.5 rounded-full bg-[#EF4444] shadow-[0_0_12px_2px_rgba(239,68,68,0.55)]" />
    </span>
  )
}

export type ConsentPopupPhase =
  | { kind: 'ask' }
  | { kind: 'saving'; decision: 'GRANTED' | 'DENIED' }
  | { kind: 'done'; decision: 'GRANTED' | 'DENIED' }

/**
 * The participant's recording consent prompt: Accept & Continue / Decline. Floats over the meeting (the call keeps running and the
 * control bar stays usable underneath - the dimmed backdrop does not take clicks). Closes only after the server confirmed the answer
 * (a short confirmation is shown first); a failed submission shows the error and both buttons work again for a retry.
 * The notice text is the policy's own wording, shown verbatim - never rewritten here.
 */
export function ConsentPopup({
  open,
  variant,
  requestedBy,
  recordingNow,
  policy,
  phase,
  error,
  onAccept,
  onDecline,
}: {
  open: boolean
  /** request: the host asked to start recording; notice: recording is running / mandatory for this meeting. */
  variant: 'request' | 'notice'
  requestedBy?: string | null
  recordingNow?: boolean
  policy: Policy
  phase: ConsentPopupPhase
  error: string | null
  onAccept: () => void
  onDecline: () => void
}) {
  const titleId = useId()
  const descId = useId()
  const acceptRef = useRef<HTMLButtonElement>(null)
  const busy = phase.kind !== 'ask'

  // Keyboard users land on the primary action as soon as the prompt appears.
  useEffect(() => {
    if (open && phase.kind === 'ask') window.setTimeout(() => acceptRef.current?.focus(), 60)
  }, [open, phase.kind])

  const title = variant === 'request' ? 'Recording Request' : recordingNow ? 'This meeting is being recorded' : 'This meeting may be recorded'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="oic-consent"
          className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center px-4 pb-24 pt-16"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Visual dimming only: clicks pass through to the meeting controls. */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(2,6,23,0.55),rgba(2,6,23,0.25)_70%)] backdrop-blur-[1.5px]" aria-hidden />
          <motion.section
            role="alertdialog"
            aria-modal="false"
            aria-labelledby={titleId}
            aria-describedby={descId}
            data-testid="rec-consent-popup"
            data-variant={variant}
            className="pointer-events-auto relative w-full max-w-[440px] overflow-hidden rounded-2xl border border-white/[0.09] bg-gradient-to-b from-[#141C31]/95 via-[#0F1628]/95 to-[#0B1120]/95 text-white shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.02)_inset] backdrop-blur-xl"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* Top accent */}
            <div className="h-[3px] w-full bg-gradient-to-r from-[#EF4444]/0 via-[#EF4444]/80 to-[#22D3EE]/0" aria-hidden />
            <div className="flex flex-col gap-4 p-5 sm:p-6">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
                <ConnectMark size={16} /> OneInsure Connect
              </div>
              <div className="flex items-start gap-3.5">
                <RecIcon />
                <div className="min-w-0">
                  <h2 id={titleId} className="text-[19px] font-semibold leading-tight tracking-[-0.01em]">{title}</h2>
                  <div id={descId} className="mt-1.5 flex flex-col gap-1 text-[13.5px] leading-5 text-white/75">
                    {variant === 'request' ? (
                      <>
                        <p>The host has requested to record this meeting.</p>
                        <p>Recording will begin only after all required participants have accepted.</p>
                      </>
                    ) : (
                      <p>{recordingNow ? 'Recording is in progress in this meeting. Please read the notice below and respond.' : 'Please read the recording notice below and respond.'}</p>
                    )}
                    {variant === 'request' && requestedBy && <p className="text-[12px] text-white/45">Requested by {requestedBy}</p>}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-3.5">
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/45">
                  <ShieldCheck className="size-3.5 text-cyan-300/80" aria-hidden /> Recording notice
                </div>
                {/* Participant-facing: the wording only - no confirmation status, policy or notice version (13 Nov 2026). */}
                <p className="max-h-36 overflow-y-auto whitespace-pre-wrap pr-1 text-[13px] leading-[1.55] text-white/85" data-testid="rec-notice-text">{policy.noticeText}</p>
                {policy.stopOnWithdrawal && (
                  <p className="mt-2 text-[11.5px] leading-4 text-white/40">You can withdraw your consent at any time; the recording then stops.</p>
                )}
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-[#F87171]/30 bg-[#EF4444]/10 px-3 py-2 text-[13px] text-[#FCA5A5]" role="alert" data-testid="rec-consent-error">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> <span>{error}</span>
                </div>
              )}

              {phase.kind === 'done' ? (
                <div
                  className={cn('flex items-center gap-2.5 rounded-xl px-3.5 py-3 text-[13.5px] font-medium', phase.decision === 'GRANTED' ? 'bg-emerald-500/12 text-emerald-300' : 'bg-white/[0.06] text-white/80')}
                  role="status"
                  data-testid="rec-consent-confirmed"
                >
                  <span className={cn('inline-flex size-6 items-center justify-center rounded-full', phase.decision === 'GRANTED' ? 'bg-emerald-500/20' : 'bg-white/10')}>
                    {phase.decision === 'GRANTED' ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                  </span>
                  {phase.decision === 'GRANTED' ? 'Thank you. Your acceptance has been recorded.' : 'You declined. The host has been notified; nothing will be recorded.'}
                </div>
              ) : (
                <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={onDecline}
                    disabled={busy}
                    data-testid="rec-decline"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/[0.14] bg-white/[0.04] px-5 text-[14px] font-semibold text-white/85 transition hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {phase.kind === 'saving' && phase.decision === 'DENIED' && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                    Decline
                  </button>
                  <button
                    ref={acceptRef}
                    type="button"
                    onClick={onAccept}
                    disabled={busy}
                    data-testid="rec-accept"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#0EA5E9] to-[#2563EB] px-5 text-[14px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(37,99,235,0.8)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F1628] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {phase.kind === 'saving' && phase.decision === 'GRANTED' && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                    Accept &amp; Continue
                  </button>
                </div>
              )}
              {phase.kind === 'saving' && <p className="sr-only" role="status">Saving your response…</p>}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const memberStyle: Record<ConsentMemberStatus, { label: string; dot: string; chip: string }> = {
  GRANTED: { label: 'Accepted', dot: 'bg-emerald-400', chip: 'bg-emerald-500/12 text-emerald-300' },
  PENDING: { label: 'Pending', dot: 'bg-amber-400 motion-safe:animate-pulse', chip: 'bg-amber-400/12 text-amber-300' },
  DENIED: { label: 'Declined', dot: 'bg-[#F87171]', chip: 'bg-[#EF4444]/12 text-[#FCA5A5]' },
  DISCONNECTED: { label: 'Disconnected', dot: 'bg-white/35', chip: 'bg-white/[0.07] text-white/55' },
}

/**
 * The host's live view of a pending consent request: who has accepted / is pending / declined / disconnected. Floats at the
 * top-left of the meeting (collapsible, never over the control bar or the side panels). Updates as the server pushes changes.
 */
export function ConsentRequestPanel({ request, onCancel, cancelling, onRemove }: {
  request: RecordingConsentRequest | null
  onCancel: () => void
  cancelling: boolean
  /** Take someone who has left (Disconnected) out of the request - never counted as accepted. */
  onRemove?: (identity: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const members = request?.participants ?? []
  const pct = request && request.total > 0 ? Math.round((request.accepted / request.total) * 100) : 0
  return (
    <AnimatePresence>
      {request && (
        <motion.section
          key={request.id}
          // Top-LEFT and below the side panels (z-10 < z-20): the Participants/Chat panel opens on the right (and full-width on phones),
          // and the host must always be able to use it (e.g. Admit someone) while the request is pending.
          className="fixed left-3 top-16 z-10 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0F1628]/92 text-white shadow-[0_20px_60px_-18px_rgba(0,0,0,0.8)] backdrop-blur-xl sm:left-4"
          aria-label="Recording consent status"
          data-testid="rec-consent-panel"
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <header className="flex items-center gap-3 px-4 pb-3 pt-3.5">
            <span className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-400/12" aria-hidden>
              <span className="size-2.5 rounded-full bg-amber-400 motion-safe:animate-pulse" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[14px] font-semibold leading-tight">Recording request</h2>
              <p className="text-[12px] text-white/55" data-testid="rec-consent-progress">
                {request.accepted} of {request.total} accepted
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="inline-flex size-8 items-center justify-center rounded-lg text-white/60 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Show consent status' : 'Minimise consent status'}
            >
              {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
            </button>
          </header>
          <div className="mx-4 h-1.5 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
          {!collapsed && (
            <>
              <p className="px-4 pt-3 text-[12.5px] leading-5 text-white/70" data-testid="rec-consent-waiting">
                Waiting for all required participants to accept before recording can start.
              </p>
              <ul className="mt-2 max-h-[min(280px,40vh)] overflow-y-auto px-2" aria-label="Participants' answers">
                {members.map((m) => {
                  const s = memberStyle[m.status]
                  return (
                    <li key={m.identity} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.03]" data-testid="rec-consent-member" data-status={m.status}>
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold text-white/80" aria-hidden>
                        {initials(m.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-white/90">
                        {m.name}
                        {m.type !== 'EMPLOYEE' && <span className="ml-1.5 text-[11px] text-white/40">{m.type === 'GUEST' ? 'Guest' : 'Customer'}</span>}
                      </span>
                      <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold', s.chip)}>
                        <span className={cn('size-1.5 rounded-full', s.dot)} aria-hidden />
                        {s.label}
                      </span>
                      {m.status === 'DISCONNECTED' && onRemove && (
                        <button
                          type="button"
                          onClick={() => onRemove(m.identity)}
                          data-testid="rec-consent-remove"
                          title={`${m.name} has left the meeting. Remove them from this request (they are not counted as accepted; if they return they are asked again).`}
                          aria-label={`Remove ${m.name} from the recording request`}
                          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-white/45 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              <footer className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3">
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-white/40">
                  <Users className="size-3.5" aria-hidden /> Everyone in the meeting is asked
                </span>
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={cancelling}
                  data-testid="rec-request-cancel"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold text-[#FCA5A5] hover:bg-[#EF4444]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F87171]/60 disabled:opacity-50"
                >
                  {cancelling && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
                  Cancel request
                </button>
              </footer>
            </>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  )
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
