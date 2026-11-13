import { useCallback, useEffect, useState } from 'react'
import { Check, Clock, Copy, Link2, Link2Off, Mail, MessageCircle, RefreshCw, Repeat, Send, Share2, Users } from 'lucide-react'
import { invitationEmailsApi, meetingsApi, type CustomerJoinLink, type InvitationEmailState, type MeetingLink } from '../../api/meetings'
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
          // A new browsing context: opening the mail app must never unload the page (this dialog is used inside a live call).
          target="_blank"
          rel="noopener noreferrer"
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

export function ShareLinkDialog({ open, onClose, meetingId, title, customer, guests, customerMeeting }: {
  open: boolean
  onClose: () => void
  meetingId: string
  title: string
  /** Instant customer meeting: the customer's personal join link (shown once, right after starting). */
  customer?: CustomerJoinLink | null
  /** Customer meeting: offer to create the customer's personal link when none was handed in. */
  customerMeeting?: boolean
  /** Instant PLVC meeting: the other participants' personal join links (shown once, right after starting). */
  guests?: CustomerJoinLink[]
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Invite people" description="Share this link. Everyone who uses it waits until a host lets them in." size="md">
      {(customer?.email || guests?.some((g) => g.email)) && <InvitationEmails meetingId={meetingId} active={open} />}
      {customer ? <CustomerLink customer={customer} title={title} /> : customerMeeting ? <SendToCustomer meetingId={meetingId} title={title} /> : null}
      {guests?.map((g) => <CustomerLink key={g.joinUrl} customer={g} title={title} />)}
      <LinkBody meetingId={meetingId} title={title} active={open} />
    </Dialog>
  )
}

/**
 * Instant meeting: each participant was e-mailed their own personal link when the meeting started (13 Nov 2026). Shows the
 * delivery state per address, refreshed while sending, and "Send again" for one that failed (a fresh personal link for that
 * person only - the meeting is never created again).
 */
function InvitationEmails({ meetingId, active }: { meetingId: string; active: boolean }) {
  const toast = useToast()
  const [items, setItems] = useState<InvitationEmailState[] | null>(null)
  const [resending, setResending] = useState<string | null>(null)
  const load = useCallback(() => invitationEmailsApi.status(meetingId).then(setItems).catch(() => undefined), [meetingId])
  const settled = !!items && items.every((i) => i.status === 'SENT' || i.status === 'FAILED' || i.status === 'CANCELLED')
  useEffect(() => {
    if (!active) return
    void load()
    if (settled) return
    const t = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(t)
  }, [active, load, settled])
  if (!items || items.length === 0) return null
  return (
    <div className="mb-4 rounded-md border border-line bg-surface-muted p-3" data-testid="invitation-emails">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink"><Mail className="size-3.5 text-brand-600" aria-hidden /> Invitation e-mails</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={i.email} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]" data-testid="invitation-email" data-status={i.status}>
            <span className="min-w-0 flex-1 truncate text-ink-secondary" title={i.email}>{i.email}</span>
            {i.status === 'SENT' ? <span className="font-semibold text-success">Sent</span>
              : i.status === 'FAILED' ? <span className="font-semibold text-danger">Not delivered</span>
              : i.status === 'CANCELLED' ? <span className="text-ink-secondary">Cancelled</span>
              : <span className="text-ink-secondary">Sending…</span>}
            {i.status === 'FAILED' && (
              <Button size="sm" variant="secondary" loading={resending === i.email} data-testid="invitation-resend"
                onClick={async () => {
                  setResending(i.email)
                  try {
                    await invitationEmailsApi.resend(meetingId, i.email)
                    toast.success(`The invitation was e-mailed to ${i.email} again with a new personal link.`)
                    await load()
                  } catch (e) {
                    toast.error(errorMessage(e, 'The invitation could not be sent again.'))
                  } finally {
                    setResending(null)
                  }
                }}>
                Send again
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "91" + a 10-digit Indian mobile; numbers already carrying a country code are kept. Null if it is not a usable number. */
export function whatsappNumber(mobile?: string | null) {
  const d = (mobile ?? '').replace(/\D/g, '').replace(/^0+/, '')
  if (d.length === 10) return `91${d}`
  return d.length >= 11 && d.length <= 15 ? d : null
}

/**
 * Customer meeting (GoodDay #14195): creates the customer's personal join link on request and shows it with WhatsApp /
 * E-mail / Copy. WhatsApp opens the host's own WhatsApp with the message ready - no SMS gateway or paid service.
 */
export function SendToCustomer({ meetingId, title }: { meetingId: string; title: string }) {
  const [link, setLink] = useState<CustomerJoinLink | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (link) return <CustomerLink customer={link} title={title} />
  return (
    <div className="mb-4 flex flex-col items-start gap-2 rounded-md border border-brand-200 bg-brand-50 p-3.5" data-testid="send-to-customer">
      <p className="text-[13px] font-semibold text-ink">Send the link to the customer</p>
      <p className="text-[12px] text-ink-secondary">Creates the customer's personal join link to send by WhatsApp or e-mail. The link in their invitation e-mail keeps working.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button size="sm" loading={busy} leftIcon={<Send className="size-3.5" />} data-testid="send-to-customer-button"
        onClick={async () => {
          setBusy(true)
          setError(null)
          try { setLink(await meetingsApi.customerLink(meetingId)) } catch (e) { setError(errorMessage(e, "The customer's link could not be created.")) } finally { setBusy(false) }
        }}>
        Send link to customer
      </Button>
    </div>
  )
}

/** The customer's personal link: joins as the customer (their name and record), not as an anonymous guest. */
function CustomerLink({ customer, title }: { customer: CustomerJoinLink; title: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    if (await copyText(customer.joinUrl)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }
  const text = `Dear ${customer.name},\n\n${invitationText(title, customer.joinUrl).replace('\n\nThe host lets you in from the waiting room.', '')}`
  const wa = whatsappNumber(customer.mobile)
  const action = 'inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3.5 text-[13px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-muted'
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-md border border-brand-200 bg-brand-50 p-3.5" data-testid="customer-link">
      <p className="text-[13px] font-semibold text-ink">Link for {customer.name}</p>
      <p className="text-[12px] text-ink-secondary">Personal to this customer — send it only to them. They join as the customer named in this meeting.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input readOnly value={customer.joinUrl} className="h-10 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-[13px] text-ink" onFocus={(e) => e.target.select()} data-testid="customer-link-url" aria-label={`Join link for ${customer.name}`} />
        <Button onClick={() => void copy()} leftIcon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} className="sm:w-[136px]">
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {wa && (
          <a className={action} target="_blank" rel="noopener noreferrer" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} data-testid="customer-whatsapp">
            <MessageCircle className="size-3.5 text-[#16A34A]" /> WhatsApp {customer.mobile}
          </a>
        )}
        {customer.email && (
          <a className={action} target="_blank" rel="noopener noreferrer" data-testid="customer-email"
            href={`mailto:${encodeURIComponent(customer.email)}?subject=${encodeURIComponent(`Meeting invitation: ${title}`)}&body=${encodeURIComponent(text)}`}>
            <Mail className="size-3.5" /> E-mail {customer.email}
          </a>
        )}
        {!wa && !customer.email && <p className="text-[12px] text-ink-secondary">No mobile number or e-mail on the customer record: copy the link and send it another way.</p>}
      </div>
    </div>
  )
}
