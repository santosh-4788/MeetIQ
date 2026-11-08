import { useCallback, useEffect, useState } from 'react'
import { Check, Clock, Copy, Link2, Link2Off, Mail, RefreshCw, Repeat, Share2, Users } from 'lucide-react'
import { meetingsApi, type MeetingLink } from '../../api/meetings'
import { errorMessage } from '../../api/types'
import { Card, CardHeader } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Alert, Skeleton } from '../../components/ui/Feedback'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { formatDateTime } from '../../lib/format'
import { useTimeZone } from './meta'

/** Copies text; falls back to a hidden textarea where the Clipboard API is unavailable (plain-http LAN tests). */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

function invitationText(title: string, url: string) {
  return `You are invited to a OneInsure Connect meeting: ${title}\n\nJoin from your browser (no app or account needed):\n${url}\n\nThe host lets you in from the waiting room.`
}

/** The link with Copy, E-mail and (where the device supports it) Share; optional Replace / Withdraw for hosts. */
export function LinkShareBox({ link, title, isRecurring, onReplace, onWithdraw }: { link: MeetingLink; title: string; isRecurring?: boolean; onReplace?: () => void; onWithdraw?: () => void }) {
  const toast = useToast()
  const tz = useTimeZone()
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  async function copy() {
    if (await copyText(link.url)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } else toast.error('The link could not be copied. Select it and copy it manually.')
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-gradient-to-br from-brand-50 to-cyan-50/40 p-3 ring-1 ring-brand-100">
        <div className="flex items-center gap-2 px-1 pb-2 text-[11.5px] font-semibold tracking-wide text-brand-700 uppercase">
          <Link2 className="size-3.5" /> Meeting link
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={link.url}
            aria-label="Meeting link"
            onFocus={(e) => e.currentTarget.select()}
            className="h-11 min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-3.5 font-mono text-[12.5px] text-ink shadow-[0_1px_2px_rgba(16,42,67,0.04)]"
            data-testid="meeting-link"
          />
          <Button onClick={() => void copy()} leftIcon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} data-testid="copy-link" className="sm:w-[136px]">
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3.5 text-[13px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-muted"
          href={`mailto:?subject=${encodeURIComponent(`Meeting invitation: ${title}`)}&body=${encodeURIComponent(invitationText(title, link.url))}`}
        >
          <Mail className="size-3.5" /> E-mail
        </a>
        {canShare && (
          <Button size="sm" variant="secondary" leftIcon={<Share2 className="size-3.5" />}
            onClick={() => void navigator.share({ title, text: invitationText(title, link.url), url: link.url }).catch(() => undefined)}>
            Share…
          </Button>
        )}
        {onReplace && <Button size="sm" variant="ghost" leftIcon={<RefreshCw className="size-3.5" />} onClick={onReplace}>New link</Button>}
        {onWithdraw && <Button size="sm" variant="ghost" leftIcon={<Link2Off className="size-3.5" />} onClick={onWithdraw}>Withdraw</Button>}
      </div>
      <div className="flex flex-col gap-1.5 rounded-md bg-surface-muted px-3.5 py-3 text-[12px] leading-5 text-ink-secondary">
        {isRecurring && (
          <p className="flex items-start gap-2 font-medium text-brand-700">
            <Repeat className="mt-0.5 size-3.5 shrink-0" />
            One link for the whole series — it takes people to whichever occurrence is happening or coming up next, every day.
          </p>
        )}
        <p className="flex items-start gap-2">
          <Users className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
          Anyone with this link can <strong className="text-ink">ask</strong> to join — a host admits them from the waiting room.
        </p>
        <p className="flex items-start gap-2">
          <Clock className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
          Valid until {formatDateTime(link.expiresUtc, tz)} · used {link.useCount} time{link.useCount === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  )
}

/** Loads the meeting's link and offers copy / replace / withdraw. Used on the meeting page and inside the room. */
function useMeetingLink(meetingId: string, active: boolean) {
  const [link, setLink] = useState<MeetingLink | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [withdrawn, setWithdrawn] = useState(false)
  const load = useCallback(() => {
    setError(null)
    meetingsApi.link(meetingId).then((l) => (setLink(l), setWithdrawn(false))).catch((e: unknown) => setError(errorMessage(e, 'The meeting link could not be loaded.')))
  }, [meetingId])
  useEffect(() => {
    if (active) load()
  }, [active, load])
  return { link, error, withdrawn, load, setLink, setWithdrawn }
}

function LinkBody({ meetingId, title, active, isRecurring }: { meetingId: string; title: string; active: boolean; isRecurring?: boolean }) {
  const toast = useToast()
  const s = useMeetingLink(meetingId, active)
  const [confirm, setConfirm] = useState<'replace' | 'withdraw' | null>(null)
  return (
    <>
      {s.error ? (
        <Alert tone="danger">{s.error}</Alert>
      ) : s.withdrawn ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[13px] text-ink-secondary">The link was withdrawn. Nobody can ask to join through it any more.</p>
          <Button size="sm" leftIcon={<Link2 className="size-3.5" />} onClick={s.load}>Create a new link</Button>
        </div>
      ) : s.link ? (
        <LinkShareBox link={s.link} title={title} isRecurring={isRecurring} onReplace={() => setConfirm('replace')} onWithdraw={() => setConfirm('withdraw')} />
      ) : (
        <Skeleton className="h-10 w-full" />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'replace' ? 'Replace the meeting link?' : 'Withdraw the meeting link?'}
        confirmLabel={confirm === 'replace' ? 'Create new link' : 'Withdraw link'}
        onConfirm={async () => {
          if (confirm === 'replace') {
            s.setLink(await meetingsApi.regenerateLink(meetingId))
            toast.success('A new link was created. The old link no longer works.')
          } else {
            await meetingsApi.revokeLink(meetingId)
            s.setLink(null)
            s.setWithdrawn(true)
            toast.success('The meeting link was withdrawn.')
          }
        }}
      >
        <p>
          {confirm === 'replace'
            ? 'The current link stops working at once. Send the new link to anyone who still needs to join. Personal invitation links are not affected.'
            : 'Nobody can ask to join through the shared link any more. People already in the meeting stay. Personal invitation links are not affected.'}
        </p>
      </ConfirmDialog>
    </>
  )
}

export function MeetingLinkCard({ meetingId, title, isRecurring }: { meetingId: string; title: string; isRecurring?: boolean }) {
  return (
    <Card>
      <CardHeader
        title="Meeting link"
        subtitle={isRecurring ? 'One link for every occurrence of this recurring meeting: guests need no account.' : 'Share it with anyone who should join: guests need no account.'}
      />
      <div className="px-5 pb-5">
        <LinkBody meetingId={meetingId} title={title} active isRecurring={isRecurring} />
      </div>
    </Card>
  )
}

export function ShareLinkDialog({ open, onClose, meetingId, title }: { open: boolean; onClose: () => void; meetingId: string; title: string }) {
  return (
    <Dialog open={open} onClose={onClose} title="Invite people" description="Share this link. Everyone who uses it waits until a host lets them in." size="md">
      <LinkBody meetingId={meetingId} title={title} active={open} />
    </Dialog>
  )
}
