import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BookOpen, Code2, Download, KeyRound } from 'lucide-react'
import { absoluteUrl, EXT_API_BASE, OPENAPI_URL } from '../../api/integrations'
import { Card } from '../../components/ui/Card'
import { PageHeader, Tabs, tabPanelProps, table } from '../../components/ui/Data'
import { Alert, Badge, Skeleton } from '../../components/ui/Feedback'
import { CopyButton } from '../../components/ui/Secret'
import { buttonClass } from '../../components/ui/Button'
import { useAuth } from '../../auth/AuthContext'
import { IntegrationsPanel } from './IntegrationsPanel'

const SwaggerPanel = lazy(() => import('./SwaggerPanel'))

type Tab = 'guide' | 'reference' | 'integrations'

/**
 * Organisation → System → API Documentation (12 Nov 2026): how other portals integrate OneInsure Connect without their users
 * opening this portal. The endpoint list and the interactive reference are built from the server's own OpenAPI document
 * (generated from the implemented endpoints), so the documentation cannot drift from the API.
 */
export function ApiDocsPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState<Tab>('guide')
  const baseUrl = absoluteUrl(EXT_API_BASE)
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'guide', label: 'Integration guide', icon: <BookOpen className="size-4" /> },
    { id: 'reference', label: 'API reference (Swagger)', icon: <Code2 className="size-4" /> },
    ...(can('integrations.manage') ? [{ id: 'integrations' as Tab, label: 'Integrations & API keys', icon: <KeyRound className="size-4" /> }] : []),
  ]
  return (
    <div className="flex flex-col gap-5" data-testid="api-docs-page">
      <PageHeader
        title="API Documentation"
        description="Let other portals create OneInsure Connect meetings, share links, follow status, fetch the completion report and download recordings — from their own interface."
        actions={
          <>
            <a className={buttonClass({ variant: 'secondary' })} href={OPENAPI_URL} download="oneinsure-connect-openapi-v1.json" data-testid="download-openapi">
              <Download className="size-4" /> Download OpenAPI (JSON)
            </a>
            <CopyButton text={baseUrl} label="Copy base URL" size="md" />
          </>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="API documentation" idPrefix="apidocs" />
      <div {...tabPanelProps('apidocs', tab)}>
        {tab === 'guide' && <Guide baseUrl={baseUrl} />}
        {tab === 'reference' && (
          <Suspense fallback={<Skeleton className="h-96" />}>
            <SwaggerPanel url={OPENAPI_URL} />
          </Suspense>
        )}
        {tab === 'integrations' && <IntegrationsPanel />}
      </div>
    </div>
  )
}

type Operation = { method: string; path: string; summary: string; description?: string }

/** The implemented operations, read from the live OpenAPI document. */
function useOperations() {
  const [ops, setOps] = useState<Operation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetch(OPENAPI_URL, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((doc: { paths: Record<string, Record<string, { summary?: string; description?: string }>> }) => {
        if (!alive) return
        const list: Operation[] = []
        for (const [path, item] of Object.entries(doc.paths ?? {}))
          for (const [method, op] of Object.entries(item)) if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) list.push({ method: method.toUpperCase(), path, summary: op.summary ?? '', description: op.description })
        setOps(list)
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])
  return { ops, error }
}

const methodTone: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { GET: 'info', POST: 'success', PUT: 'warning', DELETE: 'danger' }

function Code({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <div className="relative">
      <pre className="scrollbar-thin overflow-x-auto rounded-md bg-[#0f1b2d] p-4 pr-24 text-[12.5px] leading-5 text-[#e6edf7]"><code>{children}</code></pre>
      {copy !== false && <CopyButton text={children} className="absolute top-2 right-2" />}
    </div>
  )
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <div data-testid={id}>
      <Card className="p-5">
        <h2 className="mb-3 text-[16px] font-bold text-ink">{title}</h2>
        <div className="flex flex-col gap-3 text-[13.5px] leading-[22px] text-ink-secondary">{children}</div>
      </Card>
    </div>
  )
}

const SCOPES: [string, string][] = [
  ['meeting.create', 'Create instant meetings (POST /meetings)'],
  ['meeting.schedule', 'Create scheduled meetings (with meetingType SCHEDULED)'],
  ['meeting.read', 'Read and list meetings, status and links'],
  ['meeting.cancel', 'Cancel a meeting that has not started'],
  ['meeting.json.read', 'Read the meeting completion report (JSON)'],
  ['recording.read', 'Read recording metadata'],
  ['recording.download', 'Create short-lived recording download links'],
  ['webhook.manage', 'Configure and test the webhook'],
  ['meeting.plvc.unidentified', 'Create an UNIDENTIFIED Customer PLVC instant meeting (plvcIdentification: \"UNIDENTIFIED\", no prarambhMainId, no participants)'],
]
const ERRORS: [string, string, string][] = [
  ['400', 'VALIDATION', 'Invalid input; "errors" names each field (e.g. prarambhMainId, participants[0].email).'],
  ['401', 'UNAUTHORIZED / KEY_REVOKED', 'No key, an unknown key, or a revoked key.'],
  ['403', 'INSUFFICIENT_SCOPE / INTEGRATION_INACTIVE / HOST_NOT_PERMITTED', 'The key lacks the scope; the integration is deactivated; the host cannot hold customer meetings.'],
  ['404', 'NOT_FOUND', 'Not found for this integration (another portal\'s meeting is always "not found").'],
  ['409', 'CONFLICT / RECORDING_NOT_READY / RECORDING_FAILED / REQUEST_IN_PROGRESS', 'Calendar conflict; recording still processing or failed; the same Idempotency-Key is still running.'],
  ['410', 'RECORDING_DELETED', 'The recording was deleted by an authorised user.'],
  ['422', 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used before with a different body.'],
  ['429', 'RATE_LIMITED', 'Over this integration\'s per-minute limit; retry after the Retry-After seconds.'],
]
const EVENTS: [string, string][] = [
  ['meeting.created', 'A meeting was created through the API'],
  ['meeting.started', 'The host started the meeting'],
  ['participant.joined / participant.left', 'Someone joined or left (type and an opaque participantRef only)'],
  ['recording.consent_requested', 'A participant was asked to consent to recording'],
  ['recording.started / recording.stopped', 'Recording started / stopped (processing begins)'],
  ['recording.completed / recording.failed', 'The MP4 is ready to download / processing failed'],
  ['meeting.completed', 'The meeting ended'],
]

function Guide({ baseUrl }: { baseUrl: string }) {
  const { ops, error } = useOperations()
  const create = useMemo(() => JSON.stringify({
    category: 'Customer-PLVC',
    meetingType: 'Instant',
    meetingTitle: 'Customer PLVC Meeting',
    prarambhMainId: '123456789',
    host: { email: 'host.employee@oneinsure.com' },
    participants: [{ name: 'Customer Name', email: 'customer@example.com' }],
    durationMinutes: 30,
    externalReference: 'YOUR-REF-001',
  }, null, 2), [])
  return (
    <div className="flex flex-col gap-4" data-testid="api-guide">
      <Section title="Overview" id="api-overview">
        <p>
          Each external portal is an <strong className="text-ink">integration</strong> with its own Integration ID and API keys. A key only ever sees the meetings and
          recordings its own integration created — another portal's meeting is simply "not found". Meetings are hosted by an active OneInsure employee (by e-mail or
          employee code) and follow every portal rule: categories, the PLVC Prarambh Main ID, approved recording policies and calendar conflicts.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Fact label="Base URL" value={baseUrl} copy />
          <Fact label="API version" value="v1" />
          <Fact label="Format" value="JSON · times in IST (+05:30)" />
        </div>
      </Section>

      <Section title="Authentication" id="api-auth">
        <p>Send the integration's API key on every request. Keys are created, rotated and revoked by an administrator under <em>Integrations &amp; API keys</em>; a key is shown only once.</p>
        <Code>{`curl -H "Authorization: Bearer oic_live_xxxxxxxxxxxxxxxx_xxxxxxxx…" ${baseUrl}/me`}</Code>
        <p>HTTPS only. Never put the key in a browser or mobile app — call the API from your server.</p>
      </Section>

      <Section title="Sample integration workflow" id="api-workflow">
        <ol className="list-decimal space-y-2 pl-5">
          <li><strong className="text-ink">Create the meeting</strong> — <code>POST /meetings</code> (send an <code>Idempotency-Key</code> so a retry never creates a second meeting).</li>
          <li><strong className="text-ink">Share the links</strong> — each participant's <code>joinUrl</code> (instant meetings) or the <code>meetingLink</code>; the host opens <code>hostJoinUrl</code>.</li>
          <li><strong className="text-ink">Follow progress</strong> — webhooks (recommended) or <code>GET /meetings/{'{meetingId}'}</code>.</li>
          <li><strong className="text-ink">After the meeting</strong> — <code>GET /meetings/{'{meetingId}'}/report</code>: times, participants with join/leave, recording status. Meeting and recording status are independent: a Completed meeting can still have a Processing recording — call again later.</li>
          <li><strong className="text-ink">Download</strong> — <code>POST …/recordings/{'{recordingId}'}/download-link</code> returns a short-lived URL (no key needed to fetch it; supports HTTP Range).</li>
        </ol>
        <p className="font-semibold text-ink">Create a PLVC meeting</p>
        <Code>{`curl -X POST ${baseUrl}/meetings \\\n  -H "Authorization: Bearer <API key>" -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: YOUR-REF-001" \\\n  -d '${create}'`}</Code>
        <p>
          <strong className="text-ink">PLVC rules:</strong> <code>prarambhMainId</code> is mandatory, digits only (it is stored exactly as sent and the recording file name starts with it);
          the first participant becomes the customer. For other categories omit it. Categories: <code>CUSTOMER_PLVC</code>, <code>CUSTOMER_GENERAL</code>, <code>INTERNAL</code>, <code>TRAINING</code>, <code>TEAM</code>.
          Scheduled meetings need <code>meetingType: "SCHEDULED"</code> and <code>startTime</code> (ISO-8601 with offset).
        </p>
      </Section>

      <Section title="Endpoints" id="api-endpoints">
        <p>Generated from the server's OpenAPI document — exactly the endpoints that exist.</p>
        {error && <Alert tone="danger">The endpoint list could not be loaded ({error}).</Alert>}
        {!ops && !error && <Skeleton className="h-40" />}
        {ops && (
          <div className={table.wrap}>
            <table className={table.table} data-testid="api-endpoint-table">
              <thead><tr><th className={table.th}>Method</th><th className={table.th}>Path</th><th className={table.th}>Description</th><th className={table.th} /></tr></thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.method + o.path} className={table.row}>
                    <td className={table.td}><Badge tone={methodTone[o.method] ?? 'neutral'}>{o.method}</Badge></td>
                    <td className={`${table.td} font-mono text-[12.5px]`}>{o.path}</td>
                    <td className={table.td}>{o.summary}</td>
                    <td className={table.td}><CopyButton text={absoluteUrl(`${import.meta.env.BASE_URL}${o.path.replace(/^\//, '')}`)} label="Copy URL" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Scopes" id="api-scopes">
        <SimpleTable head={['Scope', 'Allows']} rows={SCOPES} />
      </Section>

      <Section title="Errors" id="api-errors">
        <p>Every error is <code>application/problem+json</code>: <code>{'{ "status": 400, "code": "VALIDATION", "detail": "…", "errors": { … } }'}</code>.</p>
        <SimpleTable head={['HTTP', 'code', 'Meaning']} rows={ERRORS} />
      </Section>

      <Section title="Rate limits and idempotency" id="api-limits">
        <p>Each integration has its own per-minute limit (set by the administrator; default 60). Over it, the API answers <code>429</code> with <code>Retry-After: 60</code>. Other portals are not affected.</p>
        <p><code>Idempotency-Key</code> (max 100 characters) on <code>POST /meetings</code>: the same key with the same body returns the original response (header <code>Idempotent-Replayed: true</code>).</p>
      </Section>

      <Section title="Webhooks" id="api-webhooks">
        <p>Configure one HTTPS endpoint per integration (<code>PUT /webhook</code> or the Integrations tab). Each event is delivered once, signed, and retried with back-off (30 s → 6 h, 8 attempts) until your endpoint answers 2xx. Payloads carry ids and statuses only — no names or e-mails.</p>
        <SimpleTable head={['Event', 'When']} rows={EVENTS} />
        <p className="font-semibold text-ink">Verify the signature</p>
        <p>Header <code>X-OIC-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code> where <code>v1 = HMAC-SHA256(secret, t + "." + rawBody)</code>. Reject old timestamps (e.g. &gt; 5 minutes) and de-duplicate by <code>X-OIC-Event-Id</code>.</p>
        <Code>{`// Node.js
const crypto = require('crypto')
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex')
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}`}</Code>
        <Code>{`{
  "eventId": "6f0d…", "eventType": "recording.completed", "occurredAt": "2026-11-12T10:36:05+05:30",
  "integrationId": "INT-…", "apiVersion": "v1",
  "data": { "meetingId": "OIC-261112-AB12", "externalReference": "YOUR-REF-001", "recordingId": "…", "status": "Completed" }
}`}</Code>
      </Section>
    </div>
  )
}

function Fact({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="rounded-md border border-line bg-surface-muted p-3">
      <p className="text-[12px] font-semibold text-ink-secondary">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={value}>{value}</span>
        {copy && <CopyButton text={value} />}
      </div>
    </div>
  )
}

function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead><tr>{head.map((h) => <th key={h} className={table.th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0] + r[1]} className={table.row}>
              {r.map((c, i) => <td key={i} className={`${table.td} ${i === 0 ? 'font-mono text-[12.5px] whitespace-nowrap' : ''}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

