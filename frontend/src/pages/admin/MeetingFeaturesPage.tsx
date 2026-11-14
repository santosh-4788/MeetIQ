import { useState, type ReactNode } from 'react'
import { Bot, Captions, FileText, Hand, MessageSquareLock, Mic, PenTool, ShieldAlert, Smile, SwitchCamera, Vote, Wand2 } from 'lucide-react'
import { adminFeaturesApi, type FeatureSetting } from '../../api/roomFeatures'
import { errorMessage } from '../../api/types'
import { Card } from '../../components/ui/Card'
import { PageHeader } from '../../components/ui/Data'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { Switch } from '../../components/ui/Form'
import { ConfirmDialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { cn } from '../../lib/cn'
import { formatDateTime } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'

const FEATURES: { key: string; title: string; description: string; icon: ReactNode; note?: string }[] = [
  { key: 'REACTIONS', title: 'Reactions', description: 'Like, applause, heart, celebrate, thinking and thumbs-down bubbles for a few seconds. Not stored.', icon: <Smile className="size-5" /> },
  { key: 'POLLS', title: 'Yes/No polls', description: 'Hosts ask a quick Yes/No question; one answer per participant; live results for hosts, stored with the meeting.', icon: <Vote className="size-5" />, note: 'A poll answer is never treated as a customer decision or a policy approval.' },
  { key: 'PRIVATE_CHAT', title: 'Private messages', description: '1:1 messages between two participants of the same meeting. Only the two of them can read them - not the host.', icon: <MessageSquareLock className="size-5" />, note: 'Stored with the meeting record. Retention follows the meeting data.' },
  { key: 'WHITEBOARD', title: 'Whiteboard', description: 'Pen, highlighter, shapes, arrows, text and sticky notes; the host decides who may draw; late joiners see the board; PNG and PDF download.', icon: <PenTool className="size-5" /> },
  { key: 'BACKGROUND_EFFECTS', title: 'Background blur & images', description: 'Blur, four office/neutral backgrounds, or the participant’s own picture. Processed in the participant’s browser; nothing is uploaded.', icon: <Wand2 className="size-5" /> },
  { key: 'NOISE_SUPPRESSION', title: 'Noise suppression switch', description: 'Lets a participant turn the browser’s background-noise suppression off (for music) and back on. It stays on by default, as today.', icon: <Mic className="size-5" /> },
  { key: 'CAMERA_FLIP', title: 'Switch camera button', description: 'One-tap front/rear camera switch on phones (and laptop/USB camera on computers) without leaving the meeting.', icon: <SwitchCamera className="size-5" /> },
  { key: 'MEETING_MINUTES', title: 'Minutes of meeting', description: 'The host or organiser writes the minutes on the meeting page: summary, decisions, pending activities, follow-up date and action items. Draft, approval, version history and Print / Save as PDF.', icon: <FileText className="size-5" />, note: 'Written by people - no AI. Approving needs the "minutes.approve" permission (Super Admin, Admin, Department Head, Team Leader). Nothing is sent to anyone automatically.' },
]

const NOT_YET: { title: string; reason: string; icon: ReactNode }[] = [
  { title: 'AI meeting assistant (transcript, AI-drafted summary and minutes)', reason: 'Needs a measured benchmark of local speech-to-text and a local language model on the server, and your approval to install them.', icon: <Bot className="size-5" /> },
  { title: 'Live captions (English / Hindi)', reason: 'Depends on the same local speech-to-text benchmark. Browser captions would send audio to an outside service, so they are not used.', icon: <Captions className="size-5" /> },
  { title: 'Gesture recognition', reason: 'Experimental; planned after the features above have been accepted.', icon: <Hand className="size-5" /> },
]

/** Organisation -> System -> Meeting features (features.manage: Admin, Super Admin). Every switch is audited. */
export function MeetingFeaturesPage() {
  const toast = useToast()
  const { data, error, loading, reload } = useLoader(() => adminFeaturesApi.list(), [], 'The meeting features could not be loaded.')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmEmergency, setConfirmEmergency] = useState(false)
  const byKey = new Map((data ?? []).map((f) => [f.key, f]))
  const emergency = byKey.get('EMERGENCY_DISABLE')?.enabled ?? false

  async function set(key: string, enabled: boolean) {
    setBusy(key)
    try {
      await adminFeaturesApi.set(key, enabled)
      toast.success(key === 'EMERGENCY_DISABLE' ? (enabled ? 'All optional features are now switched off.' : 'Emergency switch cleared.') : `${FEATURES.find((f) => f.key === key)?.title ?? key} ${enabled ? 'switched on' : 'switched off'}. Meetings pick it up when the room is next opened.`)
      reload()
    } catch (e) {
      toast.error(errorMessage(e, 'The setting could not be changed.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="meeting-features-page">
      <PageHeader
        title="Meeting features"
        description="Optional extras for the meeting room. Each one is off until you switch it on here; the existing meeting, recording and consent behaviour is the same either way."
      />
      {loading && !data && <Skeleton className="h-72" />}
      {error && <ErrorState description={error} onRetry={reload} />}
      {data && (
        <>
          <Card className={cn('flex flex-col gap-3 p-5 sm:flex-row sm:items-center', emergency ? 'border-danger/50 bg-danger-soft' : '')}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger"><ShieldAlert className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold text-ink">Emergency switch</h2>
              <p className="text-[13px] text-ink-secondary">Turns every optional feature off at once (the individual switches below are kept for later). Meetings themselves are never interrupted.</p>
            </div>
            <Switch
              checked={emergency}
              disabled={busy !== null}
              onChange={(v) => (v ? setConfirmEmergency(true) : void set('EMERGENCY_DISABLE', false))}
              label={<span className={cn('font-semibold', emergency ? 'text-danger' : '')}>{emergency ? 'All off' : 'Not active'}</span>}
            />
          </Card>
          {emergency && <Alert tone="warning" title="Emergency switch is active">No optional feature is available in any meeting until you clear it.</Alert>}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {FEATURES.map((f) => {
              const s: FeatureSetting | undefined = byKey.get(f.key)
              const on = !!s?.enabled
              return (
                <Card key={f.key} className="flex gap-3 p-4" >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">{f.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-[14.5px] font-semibold text-ink">{f.title}</h3>
                      <span data-testid={`feature-${f.key}`}>
                        <Switch checked={on} disabled={busy !== null || !s} onChange={(v) => void set(f.key, v)} label={<span className="sr-only">{f.title}</span>} />
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] leading-5 text-ink-secondary">{f.description}</p>
                    {f.note && <p className="mt-1.5 text-[12px] leading-4 text-ink-muted">{f.note}</p>}
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-muted">
                      <Badge tone={on && !emergency ? 'success' : 'neutral'}>{on ? (emergency ? 'On (held by emergency switch)' : 'On') : 'Off'}</Badge>
                      {s?.modifiedBy && <span>Last changed by {s.modifiedBy}, {formatDateTime(s.modifiedUtc, 'Asia/Kolkata')}</span>}
                    </p>
                  </div>
                </Card>
              )
            })}
          </div>
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold text-ink">Not available yet</h2>
            <ul className="mt-3 flex flex-col gap-3">
              {NOT_YET.map((n) => (
                <li key={n.title} className="flex gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-ink-muted">{n.icon}</span>
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">{n.title}</span>
                    <span className="block text-[12.5px] leading-5 text-ink-secondary">{n.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      <ConfirmDialog open={confirmEmergency} onClose={() => setConfirmEmergency(false)} title="Switch off all optional features?" confirmLabel="Switch all off" onConfirm={() => set('EMERGENCY_DISABLE', true)}>
        <p>Reactions, polls, private messages, whiteboard, background effects and the other optional features disappear from meetings the next time a room opens. Meetings, recordings and saved data are not affected.</p>
      </ConfirmDialog>
    </div>
  )
}
