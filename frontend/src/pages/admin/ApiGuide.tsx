import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, KeyRound, ShieldCheck } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { table } from '../../components/ui/Data'
import { Alert, Badge } from '../../components/ui/Feedback'
import { CopyButton } from '../../components/ui/Secret'
import { cn } from '../../lib/cn'

/**
 * The complete, self-explanatory integration guide (13 Nov 2026, owner: "anyone I give this access gets all the details on this page -
 * no need to explain anything"). Everything here matches the implemented API (ExternalApiEndpoints.cs, IntegrationCore.cs,
 * WebhookWorker.cs); the interactive Swagger tab is generated from the same code.
 */

// ---- Small building blocks ------------------------------------------------------------------------------------------------

export function Code({ children, lang }: { children: string; lang?: string }) {
  return (
    <div className="relative">
      {lang && <span className="absolute top-2 left-3 text-[10.5px] font-semibold tracking-wide text-white/40 uppercase">{lang}</span>}
      <pre className={cn('scrollbar-thin overflow-x-auto rounded-md bg-[#0f1b2d] p-4 pr-24 text-[12.5px] leading-5 text-[#e6edf7]', lang && 'pt-7')}><code>{children}</code></pre>
      <CopyButton text={children} className="absolute top-2 right-2" />
    </div>
  )
}

function Section({ id, title, children, lead }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section id={`api-${id}`} data-testid={`api-${id}`} className="scroll-mt-24">
      <Card className="p-5 sm:p-6">
        <h2 className="text-[17px] font-bold tracking-[-0.01em] text-ink">{title}</h2>
        {lead && <p className="mt-1 text-[13.5px] text-ink-secondary">{lead}</p>}
        <div className="mt-4 flex flex-col gap-3 text-[13.5px] leading-[22px] text-ink-secondary">{children}</div>
      </Card>
    </section>
  )
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-2 text-[14px] font-semibold text-ink">{children}</h3>
}

export function SimpleTable({ head, rows, mono = [0] }: { head: string[]; rows: ReactNode[][]; mono?: number[] }) {
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead><tr>{head.map((h) => <th key={h} className={table.th}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, n) => (
            <tr key={n} className={table.row}>
              {r.map((c, i) => <td key={i} className={cn(table.td, 'align-top', mono.includes(i) && 'font-mono text-[12.5px] whitespace-nowrap')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Fact({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
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

const methodTone: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { GET: 'info', POST: 'success', PUT: 'warning', DELETE: 'danger' }
const c = (s: string) => <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[12.5px] text-ink">{s}</code>

// ---- Reference data (matches the implemented API) -------------------------------------------------------------------------

const SCOPES: [string, string, string][] = [
  ['meeting.create', 'Create instant meetings', 'POST /meetings'],
  ['meeting.schedule', 'Create scheduled meetings (also needs meeting.create)', 'POST /meetings with meetingType SCHEDULED'],
  ['meeting.read', 'Read and list meetings, status and links', 'GET /meetings, GET /meetings/{meetingId}'],
  ['meeting.cancel', 'Cancel a meeting that has not started', 'POST /meetings/{meetingId}/cancel'],
  ['meeting.json.read', 'Read the meeting completion report', 'GET /meetings/{meetingId}/report'],
  ['recording.read', 'Read recording metadata', 'GET /meetings/{meetingId}/recordings'],
  ['recording.download', 'Create short-lived download links', 'POST …/recordings/{recordingId}/download-link'],
  ['webhook.manage', 'Configure, read, disable and test the webhook', 'GET / PUT / DELETE /webhook, POST /webhook/test'],
  ['meeting.plvc.unidentified', 'Create an UNIDENTIFIED Customer PLVC instant meeting (also needs meeting.create)', 'POST /meetings with plvcIdentification UNIDENTIFIED'],
]

const ERRORS: [string, string, string][] = [
  ['400', 'VALIDATION', 'Invalid input. "errors" names each field, e.g. prarambhMainId, participants[1].email, host, startTime.'],
  ['401', 'UNAUTHORIZED', 'No API key, or an unknown key.'],
  ['401', 'KEY_REVOKED', 'The key was revoked by an administrator. Ask for a new key.'],
  ['403', 'INSUFFICIENT_SCOPE', 'The key lacks the scope. The response names it in "requiredScope".'],
  ['403', 'INTEGRATION_INACTIVE', 'The administrator deactivated the integration.'],
  ['403', 'HOST_NOT_PERMITTED', 'The host employee may not hold customer meetings.'],
  ['404', 'NOT_FOUND', 'Not found for this integration. Another portal\'s meeting or recording is always "not found".'],
  ['409', 'CONFLICT', 'Calendar conflict for the host, or the meeting already started (cancel).'],
  ['409', 'RECORDING_NOT_READY', 'The recording is still being processed. Try again later or wait for recording.completed.'],
  ['409', 'RECORDING_FAILED', 'The recording failed and cannot be downloaded.'],
  ['409', 'REQUEST_IN_PROGRESS', 'The same Idempotency-Key is still being processed.'],
  ['410', 'RECORDING_DELETED', 'The recording was deleted by an authorised user.'],
  ['411', '(web server)', 'A POST without a body must send Content-Length: 0 (normal HTTP clients do this).'],
  ['422', 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used before with a different body.'],
  ['429', 'RATE_LIMITED', 'Over the integration\'s per-minute limit. Wait Retry-After (60) seconds.'],
]

const EVENTS: [string, string, string][] = [
  ['meeting.created', 'A meeting was created through the API', 'meetingId, externalReference, category, meetingType, status, startTime, endTime, prarambhMainId, plvcIdentification'],
  ['meeting.started', 'The host started the meeting', 'meetingId, externalReference, status (Live), startTime'],
  ['participant.joined', 'Someone joined the video room', 'meetingId, externalReference, participant { type, participantRef (opaque) }, joinedAt'],
  ['participant.left', 'Someone left the video room', 'meetingId, externalReference, participant { type, participantRef }, leftAt'],
  ['recording.consent_requested', 'Participants were asked to consent to recording', 'meetingId, externalReference, requestId'],
  ['recording.started', 'Recording started', 'meetingId, externalReference, recordingId, status (Recording)'],
  ['recording.stopped', 'Recording stopped; processing begins', 'meetingId, externalReference, recordingId, status'],
  ['recording.completed', 'The MP4 is verified and ready to download', 'meetingId, externalReference, recordingId, status (Completed)'],
  ['recording.failed', 'Processing failed', 'meetingId, externalReference, recordingId, status (Failed)'],
  ['meeting.completed', 'The meeting ended', 'meetingId, externalReference, status, endTime'],
]

const MEETING_STATUS: [string, string][] = [
  ['Scheduled', 'Created; nobody has started it yet (instant meetings start as Scheduled until the host opens the room).'],
  ['Live', 'The host started it.'],
  ['Completed', 'Ended by the host or automatically after its end time.'],
  ['Cancelled', 'Cancelled before it started.'],
  ['Expired / Incomplete', 'Never held / not finished normally.'],
]
const RECORDING_STATUS: [string, string][] = [
  ['NotStarted', 'No recording yet.'],
  ['ConsentPending', 'Waiting for participants to accept (consent-based categories).'],
  ['Starting', 'The recorder is joining.'],
  ['Recording', 'Recording now.'],
  ['Processing', 'The MP4 is being built and verified.'],
  ['Completed', 'Ready. Ask for a download link.'],
  ['Failed', 'Processing failed.'],
  ['Deleted', 'Deleted by an authorised user.'],
]

type Param = [name: string, type: string, required: string, rules: ReactNode]
type Endpoint = {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  scope: string
  summary: string
  notes?: ReactNode
  params?: Param[]
  body?: Param[]
  request: (base: string) => string
  response?: string
  status: string
  errors: string
}

const KEY = '<YOUR_API_KEY>'

const ENDPOINTS: Endpoint[] = [
  {
    id: 'me', method: 'GET', path: '/me', scope: 'any valid key', status: '200',
    summary: 'Check your key: returns your integration, its scopes and rate limit. Use it first to confirm the key works.',
    request: (b) => `curl -H "Authorization: Bearer ${KEY}" \\\n  ${b}/me`,
    response: `{
  "success": true,
  "integrationId": "INT-1A2B3C4D5E",
  "name": "Prarambh portal",
  "scopes": ["meeting.create", "meeting.read", "meeting.json.read", "recording.read", "recording.download", "webhook.manage"],
  "rateLimitPerMinute": 60,
  "apiVersion": "v1"
}`,
    errors: '401 UNAUTHORIZED / KEY_REVOKED, 403 INTEGRATION_INACTIVE',
  },
  {
    id: 'create', method: 'POST', path: '/meetings', scope: 'meeting.create (+ meeting.schedule for SCHEDULED, + meeting.plvc.unidentified for UNIDENTIFIED)', status: '201',
    summary: 'Create an instant or scheduled meeting. Returns the meeting ID, the personal join link of every participant (instant), the shareable meeting link and the host link.',
    notes: <>Send an {c('Idempotency-Key')} header (max 100 characters, e.g. your own reference): a retry with the same key and body returns the original response (header {c('Idempotent-Replayed: true')}) and never creates a second meeting.</>,
    body: [
      ['category', 'string', 'Yes', <>{c('CUSTOMER_PLVC')} (also {c('Customer-PLVC')}, {c('PLVC')}), {c('CUSTOMER_GENERAL')}, {c('INTERNAL')}, {c('TRAINING')}, {c('TEAM')}</>],
      ['meetingType', 'string', 'No', <>{c('INSTANT')} (default, starts now) or {c('SCHEDULED')}</>],
      ['meetingTitle', 'string', 'No', 'Max 200. Default "<host name>\'s meeting".'],
      ['prarambhMainId', 'string', 'PLVC', <><strong className="text-ink">Required for Customer PLVC</strong>: digits only, 1–30 digits, stored exactly as sent (leading zeros kept); the recording file name starts with it. Refused for other categories.</>],
      ['plvcIdentification', 'string', 'No', <>Omit for a normal PLVC call. {c('UNIDENTIFIED')} = instant PLVC meeting <em>without</em> prarambhMainId and participants (needs scope meeting.plvc.unidentified). Recorded as normal; no ID is ever generated.</>],
      ['host', 'object', 'No', <>{c('{ "email": "…" }')} or {c('{ "employeeCode": "…" }')} of an active OneInsure employee with a portal login. Omitted = the integration's default host. For customer categories the host must be allowed to hold customer meetings.</>],
      ['participants', 'array', 'PLVC', <>{c('[{ "name": "…", "email": "…" }]')}, max 20, no duplicate e-mails. For customer meetings the <strong className="text-ink">first participant is the customer</strong> (an existing customer with that e-mail is reused); the others are guests.</>],
      ['startTime', 'string', 'SCHEDULED', 'ISO-8601 with offset, e.g. 2026-11-14T11:00:00+05:30.'],
      ['durationMinutes', 'number', 'No', '5 up to the configured maximum. Default 30.'],
      ['recordingPolicy', 'string', 'No', <>{c('NONE')}, {c('OPTIONAL')} or {c('REQUIRED')}. The category's recording policy always applies: Customer PLVC is recorded automatically, with a notice and no acceptance step.</>],
      ['audioOnly', 'boolean', 'No', 'Nobody can turn on a camera.'],
      ['waitingRoomEnabled', 'boolean', 'No', 'Default true: the host admits people.'],
      ['purpose, description', 'string', 'No', 'Shown on the meeting.'],
      ['externalReference', 'string', 'No', 'Your own reference (max 100). Returned in every response and webhook; you can list meetings by it.'],
    ],
    request: (b) => `curl -X POST ${b}/meetings \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: YOUR-REF-001" \\
  -d '{
    "category": "CUSTOMER_PLVC",
    "meetingType": "INSTANT",
    "meetingTitle": "Customer PLVC Meeting",
    "prarambhMainId": "123456789",
    "host": { "email": "host.employee@oneinsure.com" },
    "participants": [ { "name": "Customer Name", "email": "customer@example.com" } ],
    "durationMinutes": 30,
    "externalReference": "YOUR-REF-001"
  }'`,
    response: `{
  "success": true,
  "meetingId": "OIC-261113-AB12",
  "id": "8d6f1c2e-…",
  "integrationId": "INT-1A2B3C4D5E",
  "externalReference": "YOUR-REF-001",
  "title": "Customer PLVC Meeting",
  "category": "CUSTOMER_PLVC",
  "meetingType": "INSTANT",
  "prarambhMainId": "123456789",
  "plvcIdentification": "IDENTIFIED",
  "status": "Scheduled",
  "startTime": "2026-11-13T10:00:00+05:30",
  "endTime": "2026-11-13T10:30:00+05:30",
  "meetingLink": "https://www.oneinsure.com/meet/m/…",
  "hostJoinUrl": "https://www.oneinsure.com/meet/meetings/8d6f1c2e-…/room",
  "host": { "name": "Host Name", "email": "host.employee@oneinsure.com", "employeeCode": "E1234" },
  "participants": [
    { "name": "Host Name", "email": null, "type": "EMPLOYEE", "role": "HOST", "joinUrl": null },
    { "name": "Customer Name", "email": "customer@example.com", "type": "CUSTOMER", "role": "ATTENDEE",
      "joinUrl": "https://www.oneinsure.com/meet/join/…" }
  ]
}`,
    errors: '400 VALIDATION, 403 INSUFFICIENT_SCOPE / HOST_NOT_PERMITTED, 409 CONFLICT / REQUEST_IN_PROGRESS, 422 IDEMPOTENCY_KEY_REUSED',
  },
  {
    id: 'list', method: 'GET', path: '/meetings', scope: 'meeting.read', status: '200',
    summary: 'List your integration\'s meetings, newest first.',
    params: [
      ['externalReference', 'query', 'No', 'Only meetings with this reference.'],
      ['status', 'query', 'No', <>{c('SCHEDULED')}, {c('LIVE')}, {c('COMPLETED')}, {c('CANCELLED')}, {c('EXPIRED')}, {c('INCOMPLETE')}</>],
      ['page', 'query', 'No', 'Default 1.'],
      ['pageSize', 'query', 'No', 'Default 50, max 200.'],
    ],
    request: (b) => `curl -H "Authorization: Bearer ${KEY}" \\\n  "${b}/meetings?externalReference=YOUR-REF-001&page=1&pageSize=50"`,
    response: `{
  "success": true, "page": 1, "pageSize": 50, "total": 1,
  "meetings": [
    { "meetingId": "OIC-261113-AB12", "id": "8d6f1c2e-…", "externalReference": "YOUR-REF-001", "title": "Customer PLVC Meeting",
      "category": "CUSTOMER_PLVC", "meetingType": "INSTANT", "prarambhMainId": "123456789", "status": "Completed",
      "startTime": "2026-11-13T10:00:00+05:30", "endTime": "2026-11-13T10:30:00+05:30" }
  ]
}`,
    errors: '403 INSUFFICIENT_SCOPE',
  },
  {
    id: 'get', method: 'GET', path: '/meetings/{meetingId}', scope: 'meeting.read', status: '200',
    summary: 'One meeting: details, current status, participants and the shareable meeting link.',
    notes: <>{c('meetingId')} is the meeting code returned at creation (e.g. {c('OIC-261113-AB12')}). Personal {c('joinUrl')}s are <strong className="text-ink">not</strong> returned again — store them from the create response.</>,
    request: (b) => `curl -H "Authorization: Bearer ${KEY}" \\\n  ${b}/meetings/OIC-261113-AB12`,
    response: '(same shape as the create response; joinUrl is null)',
    errors: '404 NOT_FOUND',
  },
  {
    id: 'cancel', method: 'POST', path: '/meetings/{meetingId}/cancel', scope: 'meeting.cancel', status: '204 (no body)',
    summary: 'Cancel a meeting that has not started. Participants are notified.',
    body: [['reason', 'string', 'Yes', 'Max 500. Shown to participants and stored for audit.']],
    request: (b) => `curl -X POST ${b}/meetings/OIC-261113-AB12/cancel \\\n  -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\\n  -d '{ "reason": "Customer asked to reschedule" }'`,
    errors: '400 VALIDATION (reason), 404 NOT_FOUND, 409 CONFLICT (already started or ended)',
  },
  {
    id: 'report', method: 'GET', path: '/meetings/{meetingId}/report', scope: 'meeting.json.read', status: '200',
    summary: 'The meeting completion report: real stored data only — times, every participant\'s join/leave sessions and attended seconds, and the recording status. Nothing is estimated.',
    notes: <>Meeting and recording status are <strong className="text-ink">independent</strong>: a {c('Completed')} meeting can still have a {c('Processing')} recording. Call again later, or wait for the {c('recording.completed')} webhook. {c('summary.available')} is {c('false')} (minutes of meeting are not part of v1).</>,
    request: (b) => `curl -H "Authorization: Bearer ${KEY}" \\\n  ${b}/meetings/OIC-261113-AB12/report`,
    response: `{
  "success": true,
  "meeting": {
    "meetingId": "OIC-261113-AB12", "id": "8d6f1c2e-…", "integrationId": "INT-1A2B3C4D5E", "externalReference": "YOUR-REF-001",
    "title": "Customer PLVC Meeting", "category": "CUSTOMER_PLVC", "meetingType": "INSTANT", "prarambhMainId": "123456789",
    "status": "Completed", "completed": true,
    "scheduledStart": "2026-11-13T10:00:00+05:30", "scheduledEnd": "2026-11-13T10:30:00+05:30",
    "startTime": "2026-11-13T10:01:12+05:30", "endTime": "2026-11-13T10:24:40+05:30", "durationMinutes": 23
  },
  "host": { "name": "Host Name", "email": "host.employee@oneinsure.com", "employeeCode": "E1234" },
  "participants": [
    { "name": "Customer Name", "email": "customer@example.com", "type": "CUSTOMER", "role": "ATTENDEE",
      "joinedAt": "2026-11-13T10:02:05+05:30", "leftAt": "2026-11-13T10:24:40+05:30", "attendedSeconds": 1355,
      "sessions": [ { "joinedAt": "2026-11-13T10:02:05+05:30", "leftAt": "2026-11-13T10:24:40+05:30", "seconds": 1355 } ] }
  ],
  "recording": { "recordingId": "…", "status": "Completed", "available": true, "downloadAvailable": true,
    "startTime": "2026-11-13T10:01:20+05:30", "endTime": "2026-11-13T10:24:40+05:30", "durationSeconds": 1400,
    "fileSizeBytes": 48211234, "fileName": "123456789-OIC-261113-AB12-REC42.mp4", "prarambhMainId": "123456789" },
  "recordings": [ { "…": "every recording of the meeting, same shape" } ],
  "summary": { "available": false, "reference": null }
}`,
    errors: '404 NOT_FOUND',
  },
  {
    id: 'recordings', method: 'GET', path: '/meetings/{meetingId}/recordings', scope: 'recording.read', status: '200',
    summary: 'Every recording of the meeting with its status, duration, size and file name.',
    request: (b) => `curl -H "Authorization: Bearer ${KEY}" \\\n  ${b}/meetings/OIC-261113-AB12/recordings`,
    response: `{
  "success": true, "meetingId": "OIC-261113-AB12",
  "recordings": [
    { "recordingId": "…", "status": "Completed", "available": true, "downloadAvailable": true,
      "startTime": "2026-11-13T10:01:20+05:30", "endTime": "2026-11-13T10:24:40+05:30", "durationSeconds": 1400,
      "fileSizeBytes": 48211234, "fileName": "123456789-OIC-261113-AB12-REC42.mp4", "prarambhMainId": "123456789" }
  ]
}`,
    errors: '404 NOT_FOUND',
  },
  {
    id: 'download', method: 'POST', path: '/meetings/{meetingId}/recordings/{recordingId}/download-link', scope: 'recording.download', status: '200',
    summary: 'A short-lived, signed download URL for a completed recording (valid 5 minutes by default). Fetching the URL needs no API key, so you can hand it to a browser; it supports HTTP Range for large MP4s.',
    notes: <>No body: send {c('Content-Length: 0')} (curl does this with {c('-d ""')}). Every link issued and every download is audited. Recordings are never public and server paths are never returned.</>,
    request: (b) => `curl -X POST -d "" -H "Authorization: Bearer ${KEY}" \\\n  ${b}/meetings/OIC-261113-AB12/recordings/<recordingId>/download-link`,
    response: `{
  "success": true,
  "recordingId": "…",
  "url": "https://www.oneinsure.com/meet/api/ext/v1/recordings/media/<signed-token>",
  "expiresAt": "2026-11-13T10:40:00+05:30",
  "fileName": "123456789-OIC-261113-AB12-REC42.mp4"
}`,
    errors: '404 NOT_FOUND, 409 RECORDING_NOT_READY / RECORDING_FAILED, 410 RECORDING_DELETED',
  },
  {
    id: 'media', method: 'GET', path: '/recordings/media/{token}', scope: 'none — the signed token is the permission', status: '200 / 206 (video/mp4)',
    summary: 'Streams the MP4. Use the url from download-link exactly as returned; it stops working at expiresAt.',
    request: () => `curl -o recording.mp4 "<url from download-link>"`,
    errors: '403 (expired or invalid token), 404',
  },
  {
    id: 'webhook-get', method: 'GET', path: '/webhook', scope: 'webhook.manage', status: '200',
    summary: 'Your webhook subscription (URL, events, active). The secret is never returned here.',
    request: (b) => `curl -H "Authorization: Bearer ${KEY}" ${b}/webhook`,
    response: `{ "success": true, "url": "https://your-portal.example.com/oic/webhook", "events": ["meeting.completed", "recording.completed"],
  "active": true, "createdAt": "2026-11-13T09:00:00+05:30", "secret": null }`,
    errors: '404 NOT_FOUND (no subscription yet)',
  },
  {
    id: 'webhook-put', method: 'PUT', path: '/webhook', scope: 'webhook.manage', status: '200',
    summary: 'Create or change the webhook subscription. The signing secret (whsec_…) is returned ONLY when the subscription is created or when you rotate it — store it.',
    body: [
      ['url', 'string', 'Yes', 'Public HTTPS URL (max 500). Private, loopback and link-local addresses are refused; redirects are not followed.'],
      ['events', 'array', 'No', 'Event names from the Webhooks section. Omitted or empty = all events.'],
      ['active', 'boolean', 'No', 'Default true.'],
      ['rotateSecret', 'boolean', 'No', 'true = issue a new secret (returned once); the old one stops being used.'],
    ],
    request: (b) => `curl -X PUT ${b}/webhook \\\n  -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\\n  -d '{ "url": "https://your-portal.example.com/oic/webhook", "events": ["meeting.completed", "recording.completed"] }'`,
    response: `{ "success": true, "url": "https://your-portal.example.com/oic/webhook", "events": ["meeting.completed", "recording.completed"],
  "active": true, "createdAt": "2026-11-13T09:00:00+05:30", "secret": "whsec_…" }`,
    errors: '400 VALIDATION (url, events)',
  },
  {
    id: 'webhook-delete', method: 'DELETE', path: '/webhook', scope: 'webhook.manage', status: '204',
    summary: 'Stop webhook deliveries.',
    request: (b) => `curl -X DELETE -H "Authorization: Bearer ${KEY}" ${b}/webhook`,
    errors: '—',
  },
  {
    id: 'webhook-test', method: 'POST', path: '/webhook/test', scope: 'webhook.manage', status: '200',
    summary: 'Queue a signed "webhook.test" event to your endpoint, to check your receiver and signature check.',
    request: (b) => `curl -X POST -d "" -H "Authorization: Bearer ${KEY}" ${b}/webhook/test`,
    response: `{ "success": true, "eventId": "6f0d…", "status": "Queued" }`,
    errors: '404 NOT_FOUND (no subscription)',
  },
]

const TOC: [string, string][] = [
  ['start', 'Quick start'], ['connection', 'Connection details'], ['keys', 'API keys'], ['scopes', 'Scopes'], ['endpoints', 'Endpoints'],
  ['plvc', 'Categories & PLVC rules'], ['statuses', 'Statuses'], ['errors', 'Errors'], ['limits', 'Rate limits & idempotency'], ['webhooks', 'Webhooks'],
  ['postman', 'Postman / OpenAPI'], ['checklist', 'Go-live checklist'],
]

// ---- The guide --------------------------------------------------------------------------------------------------------------

export function ApiGuide({ baseUrl, openApiUrl, canManageKeys, onOpenKeys }: { baseUrl: string; openApiUrl: string; canManageKeys: boolean; onOpenKeys: () => void }) {
  const jump = (id: string) => document.getElementById(`api-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[200px_minmax(0,1fr)]" data-testid="api-guide">
      <nav aria-label="On this page" className="hidden xl:block">
        <div className="sticky top-[88px] flex flex-col gap-0.5 text-[13px]">
          <p className="mb-1 px-2 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">On this page</p>
          {TOC.map(([id, label]) => (
            <button key={id} type="button" onClick={() => jump(id)} className="rounded-md px-2 py-1.5 text-left text-ink-secondary hover:bg-surface-muted hover:text-ink">{label}</button>
          ))}
        </div>
      </nav>
      <div className="flex min-w-0 flex-col gap-4">
        <Section id="start" title="Quick start" lead="Your portal creates OneInsure Connect meetings and gets the results — your users never need to open this portal.">
          <ol className="flex flex-col gap-3">
            {[
              ['Get an API key', <>A OneInsure administrator creates an <strong className="text-ink">integration</strong> for your portal and gives you its <strong className="text-ink">API key</strong> (see API keys below).</>],
              ['Check the key', <>Call {c('GET /me')}. A {c('200')} with your Integration ID and scopes means you are connected.</>],
              ['Create a meeting', <>{c('POST /meetings')} returns the meeting ID ({c('OIC-…')}), each participant's personal join link and the host link. Store them.</>],
              ['Share the links', <>Send each participant their own {c('joinUrl')}; the host opens {c('hostJoinUrl')} (after signing in to OneInsure Connect).</>],
              ['Follow the meeting', <>Receive webhooks (recommended) or call {c('GET /meetings/{meetingId}')}.</>],
              ['Collect the results', <>{c('GET /meetings/{meetingId}/report')} for times, attendance and recording status; then {c('download-link')} for the MP4.</>],
            ].map(([t, d], i) => (
              <li key={i} className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[13px] font-bold text-white">{i + 1}</span>
                <span><strong className="text-ink">{t}</strong> — {d}</span>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="connection" title="Connection details">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Fact label="Base URL (all endpoints below are relative to it)" value={baseUrl} />
            <Fact label="Authentication header" value={`Authorization: Bearer ${KEY}`} />
            <Fact label="OpenAPI 3.1 document" value={openApiUrl} />
            <Fact label="Content type" value="application/json; charset=utf-8" copy={false} />
            <Fact label="Times" value="ISO-8601, India Standard Time (+05:30)" copy={false} />
            <Fact label="Version" value="v1 (in the path)" copy={false} />
          </div>
          <p>HTTPS only. Call the API <strong className="text-ink">from your server</strong> — never from a browser or mobile app, because the key would be exposed.</p>
        </Section>

        <Section id="keys" title="API keys" lead="The key identifies your portal (the integration) and decides what it may do (its scopes).">
          {canManageKeys ? (
            <Alert tone="info" title="You can manage integrations">
              Create an integration and its key under <button type="button" onClick={onOpenKeys} className="font-semibold text-brand-700 underline" data-testid="api-open-keys">Integrations &amp; API keys</button>. The key is shown only once — send it to the portal team over a secure channel.
            </Alert>
          ) : (
            <Alert tone="info" title="Getting your key">Ask a OneInsure administrator to create an integration for your portal. You receive an Integration ID and an API key. Keys are never shown on this page.</Alert>
          )}
          <SimpleTable head={['Item', 'Details']} mono={[]} rows={[
            [<strong className="text-ink">Integration ID</strong>, <>{c('INT-XXXXXXXXXX')} — your portal's identity; it appears in every response and webhook.</>],
            [<strong className="text-ink">API key format</strong>, <>{c('oic_live_<16 characters>_<secret>')}. Only a SHA-256 hash is stored, so a lost key cannot be shown again — the administrator issues a new one.</>],
            [<strong className="text-ink">How to send it</strong>, <>{c(`Authorization: Bearer ${KEY}`)} on every request ({c('X-Api-Key: <key>')} is also accepted).</>],
            [<strong className="text-ink">Rotation</strong>, 'The administrator can issue a new key and revoke the old ones at once ("Rotate"). Update your server, then confirm with GET /me.'],
            [<strong className="text-ink">Revocation</strong>, <>A revoked key stops working immediately ({c('401 KEY_REVOKED')}). A deactivated integration answers {c('403 INTEGRATION_INACTIVE')}.</>],
            [<strong className="text-ink">Isolation</strong>, 'A key only ever sees meetings and recordings created by its own integration. Anything else is "404 NOT_FOUND", even with a valid id.'],
            [<strong className="text-ink">Portal access</strong>, 'A key never signs anyone in to the OneInsure portal, and a portal sign-in grants nothing on the API.'],
            [<strong className="text-ink">Audit</strong>, 'Every request is logged (method, path, status, duration, IP) and visible to the administrator. Every key change is audited.'],
          ]} />
          <H3>Test your key</H3>
          <Code lang="bash">{`curl -H "Authorization: Bearer ${KEY}" ${baseUrl}/me`}</Code>
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-[13px] text-ink">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />
            Keep the key in your server's secret store (environment variable, vault). Never commit it to source control, log it, or put it in a URL.
          </div>
        </Section>

        <Section id="scopes" title="Scopes" lead="The administrator grants scopes per integration. A call without the needed scope returns 403 INSUFFICIENT_SCOPE with the missing scope in requiredScope.">
          <SimpleTable head={['Scope', 'Allows', 'Endpoints']} mono={[0]} rows={SCOPES} />
        </Section>

        <Section id="endpoints" title="Endpoints" lead={`${ENDPOINTS.length} endpoints. Click one to see its parameters, an example request and the response.`}>
          <div className="flex flex-col gap-2">
            {ENDPOINTS.map((e) => <EndpointCard key={e.id} e={e} baseUrl={baseUrl} />)}
          </div>
        </Section>

        <Section id="plvc" title="Categories & Customer PLVC rules">
          <SimpleTable head={['category', 'Meaning']} rows={[
            ['CUSTOMER_PLVC', 'Customer PLVC call: Prarambh Main ID + participants required (identified); recorded automatically with a notice.'],
            ['CUSTOMER_GENERAL', 'Other customer meeting; recording follows the customer-meeting policy (participants accept).'],
            ['INTERNAL', 'Internal meeting (group).'],
            ['TRAINING', 'Training / team session.'],
            ['TEAM', 'Team meeting.'],
          ]} />
          <SimpleTable head={['', 'Identified PLVC (default)', 'Unidentified PLVC']} mono={[]} rows={[
            [<strong className="text-ink">Request</strong>, 'prarambhMainId + participants', <>{c('"plvcIdentification": "UNIDENTIFIED"')}, instant only, no prarambhMainId, no participants</>],
            [<strong className="text-ink">Scope</strong>, 'meeting.create', 'meeting.create + meeting.plvc.unidentified'],
            [<strong className="text-ink">Prarambh Main ID</strong>, 'Digits only, stored exactly as sent', 'None — never generated'],
            [<strong className="text-ink">Recording file</strong>, '123456789-OIC-261113-AB12-REC42.mp4', 'OIC-261113-AB12-REC42.mp4'],
            [<strong className="text-ink">Response field</strong>, 'plvcIdentification: "IDENTIFIED"', 'plvcIdentification: "UNIDENTIFIED"'],
          ]} />
          <p>Links: <strong className="text-ink">instant</strong> meetings return each participant's personal {c('joinUrl')} once (store them); <strong className="text-ink">scheduled</strong> meetings e-mail each participant a personal, expiring link and return the shareable {c('meetingLink')} (whoever opens it waits until the host admits them).</p>
        </Section>

        <Section id="statuses" title="Statuses">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div><H3>Meeting status</H3><SimpleTable head={['status', 'Meaning']} rows={MEETING_STATUS} /></div>
            <div><H3>Recording status</H3><SimpleTable head={['status', 'Meaning']} rows={RECORDING_STATUS} /></div>
          </div>
          <p>Participant {c('type')}: {c('EMPLOYEE')}, {c('CUSTOMER')}, {c('GUEST')}. {c('role')}: {c('HOST')}, {c('COHOST')}, {c('ATTENDEE')}.</p>
        </Section>

        <Section id="errors" title="Errors" lead="Every error is application/problem+json with a stable code you can program against.">
          <Code lang="json">{`{
  "status": 400,
  "code": "VALIDATION",
  "detail": "Please correct the highlighted fields.",
  "errors": { "prarambhMainId": "Prarambh Main ID must contain digits only (0–9), at most 30 digits." }
}`}</Code>
          <SimpleTable head={['HTTP', 'code', 'Meaning / what to do']} mono={[0, 1]} rows={ERRORS} />
        </Section>

        <Section id="limits" title="Rate limits & idempotency">
          <p><strong className="text-ink">Rate limit:</strong> each integration has its own per-minute limit (see {c('rateLimitPerMinute')} in {c('GET /me')}; default 60). Over it you get {c('429 RATE_LIMITED')} with {c('Retry-After: 60')}. Other portals are never affected.</p>
          <p><strong className="text-ink">Idempotency</strong> on {c('POST /meetings')}: send {c('Idempotency-Key')} (max 100). Same key + same body → the original response ({c('Idempotent-Replayed: true')}); same key + different body → {c('422 IDEMPOTENCY_KEY_REUSED')}; while the first call is still running → {c('409 REQUEST_IN_PROGRESS')}. Safe to retry on timeouts.</p>
        </Section>

        <Section id="webhooks" title="Webhooks" lead="We call your HTTPS endpoint when something happens, so you do not have to poll.">
          <p>Set it up with {c('PUT /webhook')} (or ask the administrator). Each event is a signed {c('POST')}, delivered once; a non-2xx answer or a timeout (10 s) is retried after 30 s, 2 min, 10 min, 30 min, 2 h, then 6 h (8 attempts). Payloads carry ids and statuses only — never names or e-mails.</p>
          <SimpleTable head={['Event', 'When', 'data fields']} mono={[0]} rows={EVENTS} />
          <H3>Headers</H3>
          <SimpleTable head={['Header', 'Value']} rows={[
            ['X-OIC-Event', 'The event type, e.g. recording.completed'],
            ['X-OIC-Event-Id', 'Unique id — de-duplicate on it (a retry carries the same id)'],
            ['X-OIC-Timestamp', 'Unix seconds when it was signed'],
            ['X-OIC-Signature', 't=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>'],
          ]} />
          <H3>Payload</H3>
          <Code lang="json">{`{
  "eventId": "6f0d…",
  "eventType": "recording.completed",
  "occurredAt": "2026-11-13T10:36:05+05:30",
  "integrationId": "INT-1A2B3C4D5E",
  "apiVersion": "v1",
  "data": { "meetingId": "OIC-261113-AB12", "externalReference": "YOUR-REF-001", "recordingId": "…", "status": "Completed" }
}`}</Code>
          <H3>Verify the signature</H3>
          <p>Use the <em>raw</em> request body, reject timestamps older than 5 minutes, then answer {c('2xx')} quickly and do the work afterwards.</p>
          <Code lang="node.js">{`const crypto = require('crypto')
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')))
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody).digest('hex')
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}`}</Code>
          <Code lang="c#">{`static bool Verify(string rawBody, string header, string secret)
{
    var parts = header.Split(',').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
    var t = parts["t"];
    using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    var expected = Convert.ToHexStringLower(h.ComputeHash(Encoding.UTF8.GetBytes(t + "." + rawBody)));
    var fresh = Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - long.Parse(t)) < 300;
    return fresh && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(parts["v1"]));
}`}</Code>
          <Code lang="python">{`import hmac, hashlib, time
def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split('=', 1) for p in header.split(','))
    expected = hmac.new(secret.encode(), (parts['t'] + '.').encode() + raw_body, hashlib.sha256).hexdigest()
    return abs(time.time() - int(parts['t'])) < 300 and hmac.compare_digest(expected, parts['v1'])`}</Code>
        </Section>

        <Section id="postman" title="Postman / OpenAPI">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Click <strong className="text-ink">Download OpenAPI (JSON)</strong> at the top of this page.</li>
            <li>In Postman: <em>Import</em> → choose the file → <em>OpenAPI 3.1</em>.</li>
            <li>On the collection: <em>Authorization</em> → <em>Bearer Token</em> → paste your API key; set the base URL to {c(baseUrl)}.</li>
          </ol>
          <p>The <strong className="text-ink">API reference (Swagger)</strong> tab shows the same document interactively.</p>
        </Section>

        <Section id="checklist" title="Go-live checklist">
          <ul className="flex flex-col gap-1.5">
            {[
              'GET /me returns 200 with the scopes you need.',
              'The key is stored server-side only (never in a browser, app, log or URL).',
              'POST /meetings sends an Idempotency-Key; you store meetingId, every joinUrl and hostJoinUrl.',
              'PLVC calls send a digits-only prarambhMainId and the customer as the first participant.',
              'Your webhook endpoint verifies X-OIC-Signature, de-duplicates by X-OIC-Event-Id and answers 2xx within 10 s.',
              'You treat meeting status and recording status separately (call the report again until the recording is Completed).',
              'You handle 401/403/404/409/429 as described under Errors.',
            ].map((t) => (
              <li key={t} className="flex items-start gap-2"><KeyRound className="mt-1 size-3.5 shrink-0 text-brand-600" aria-hidden />{t}</li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  )
}

function EndpointCard({ e, baseUrl }: { e: Endpoint; baseUrl: string }) {
  const [open, setOpen] = useState(false)
  const request = useMemo(() => e.request(baseUrl), [e, baseUrl])
  return (
    <div className="rounded-lg border border-line" data-testid={`endpoint-${e.id}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-surface-muted">
        <span className="w-16 shrink-0"><Badge tone={methodTone[e.method]}>{e.method}</Badge></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px] font-semibold text-ink">{e.path}</span>
          <span className="block text-[12.5px] leading-5 text-ink-secondary">{e.summary}</span>
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3.5 py-3.5 text-[13px]">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <MiniFact label="Full URL" value={`${baseUrl}${e.path}`} />
            <MiniFact label="Scope" value={e.scope} />
            <MiniFact label="Success" value={e.status} />
          </div>
          {e.notes && <p>{e.notes}</p>}
          {e.params && <><H3>Query parameters</H3><SimpleTable head={['Name', 'In', 'Required', 'Rules']} rows={e.params} /></>}
          {e.body && <><H3>Request body (JSON)</H3><SimpleTable head={['Field', 'Type', 'Required', 'Rules']} rows={e.body} /></>}
          <H3>Example request</H3>
          <Code lang="bash">{request}</Code>
          {e.response && <><H3>Example response</H3><Code lang="json">{e.response}</Code></>}
          <p><strong className="text-ink">Errors:</strong> {e.errors} — see Errors.</p>
        </div>
      )}
    </div>
  )
}

function MiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-muted px-2.5 py-2">
      <p className="text-[11px] font-semibold text-ink-muted">{label}</p>
      <p className="truncate font-mono text-[12px] text-ink" title={value}>{value}</p>
    </div>
  )
}
