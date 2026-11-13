// Endpoint-by-endpoint status of the external integration API (/api/ext/v1) and the integration admin API (/api/v1/admin/integrations).
// Isolated environment ONLY: API https://localhost:7192 (LocalDB OneInsureVideoMeetingDB_Rec, started with Integrations__AllowPrivateWebhookTargets=true).
// Run:  cd tests\e2e; node api\api-smoke.mjs
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // local self-signed development certificate only
const API = process.env.API_BASE ?? 'https://localhost:7192'
const DB = 'OneInsureVideoMeetingDB_Rec'
if (!/^https:\/\/localhost:/.test(API)) throw new Error('Local API only.')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const LIBRARY = path.join(ROOT, 'recording/e2e/library')
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sqlExec = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q', q], { encoding: 'utf8' })
const sqlScalar = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${q}`], { encoding: 'utf8' }).trim()

const rows = []
function record(area, method, pathText, expected, actual, note = '') {
  const ok = Array.isArray(expected) ? expected.includes(actual) : expected === actual
  rows.push({ area, endpoint: `${method} ${pathText}`, expected: Array.isArray(expected) ? expected.join('/') : expected, actual, result: ok ? 'PASS' : 'FAIL', note })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${method.padEnd(6)} ${pathText.padEnd(62)} ${String(actual).padEnd(4)} ${note}`)
  return ok
}

async function call(method, url, { key, body, headers = {}, cookies, xsrf, raw } = {}) {
  const h = { ...headers }
  if (key) h.Authorization = `Bearer ${key}`
  if (body !== undefined) h['Content-Type'] = 'application/json'
  if (cookies) h.Cookie = cookies
  if (xsrf) h['X-XSRF-TOKEN'] = xsrf
  const r = await fetch(`${API}${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
  if (raw) return r
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body: json, headers: r.headers, text }
}

async function login(email) {
  const jar = {}
  const take = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1) } }
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  take(await fetch(`${API}/api/v1/health`)) // issues the XSRF-TOKEN cookie (double-submit CSRF protection applies to the login too)
  const r = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(), 'X-XSRF-TOKEN': decodeURIComponent(jar['XSRF-TOKEN'] ?? '') },
    body: JSON.stringify({ login: email, password: PASSWORD }) })
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`)
  take(r)
  return { cookies: cookie(), xsrf: decodeURIComponent(jar['XSRF-TOKEN'] ?? '') }
}

// Webhook receiver on localhost.
const received = []
const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ event: req.headers['x-oic-event'], sig: req.headers['x-oic-signature'], body: b }); res.writeHead(200).end() }) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const hookUrl = `http://localhost:${server.address().port}/hook`

const stamp = Date.now().toString(36)
const admin = await login('superadmin@rec.oneinsure.test')
const employee = await login('ravi.employee@rec.oneinsure.test')
const A = (method, url, body) => call(method, `/api/v1/admin/integrations${url}`, { ...admin, body })

// ---- Admin: integration management (session + XSRF, permission integrations.manage) ----------------------------------
record('Admin', 'GET', '/api/v1/admin/integrations (no session)', 401, (await call('GET', '/api/v1/admin/integrations')).status)
record('Admin', 'GET', '/api/v1/admin/integrations (employee)', 403, (await call('GET', '/api/v1/admin/integrations', employee)).status)
let r = await A('GET', '')
record('Admin', 'GET', '/api/v1/admin/integrations', 200, r.status, `${r.body?.items?.length} integration(s), ${r.body?.scopes?.length} scopes, ${r.body?.events?.length} events`)
r = await A('POST', '', { name: `Smoke Portal ${stamp}`, portalName: 'Smoke test portal', scopes: ['meeting.create', 'meeting.read', 'meeting.schedule', 'meeting.cancel', 'meeting.json.read', 'recording.read', 'recording.download', 'webhook.manage'], rateLimitPerMinute: 500 })
record('Admin', 'POST', '/api/v1/admin/integrations', 201, r.status, `id ${r.body?.integration?.integrationId}, key shown once (${r.body?.apiKey?.slice(0, 13)}…)`)
const intId = r.body.integration.id
const code = r.body.integration.integrationId
let key = r.body.apiKey
r = await A('POST', '', { name: `Smoke Portal ${stamp}`, portalName: 'dup', scopes: [] })
record('Admin', 'POST', '/api/v1/admin/integrations (duplicate name)', 409, r.status)
r = await A('POST', '', { name: '', portalName: '', scopes: ['bad.scope'] })
record('Admin', 'POST', '/api/v1/admin/integrations (invalid)', 400, r.status, Object.keys(r.body?.errors ?? {}).join(', '))
r = await A('GET', `/${intId}`)
record('Admin', 'GET', '/api/v1/admin/integrations/{id}', 200, r.status, `${r.body?.keys?.length} key(s)`)
r = await A('PUT', `/${intId}`, { description: 'updated by smoke test', rateLimitPerMinute: 400 })
record('Admin', 'PUT', '/api/v1/admin/integrations/{id}', 200, r.status, `rate ${r.body?.integration?.rateLimitPerMinute}`)
r = await A('POST', `/${intId}/keys`)
record('Admin', 'POST', '/api/v1/admin/integrations/{id}/keys', 201, r.status, 'second key issued')
const secondKey = r.body.apiKey
const keys = (await A('GET', `/${intId}`)).body.keys
const secondKeyId = keys.find((k) => secondKey.startsWith(k.prefix.replace('_…', '')))?.id
r = await A('POST', `/${intId}/keys/${secondKeyId}/revoke`, { reason: '' })
record('Admin', 'POST', '/api/v1/admin/integrations/{id}/keys/{keyId}/revoke (no reason)', 400, r.status)
r = await A('POST', `/${intId}/keys/${secondKeyId}/revoke`, { reason: 'smoke test' })
record('Admin', 'POST', '/api/v1/admin/integrations/{id}/keys/{keyId}/revoke', 204, r.status)
record('External', 'GET', '/api/ext/v1/me (revoked key)', 401, (await call('GET', '/api/ext/v1/me', { key: secondKey })).status, (await call('GET', '/api/ext/v1/me', { key: secondKey })).body?.code)
r = await A('POST', `/${intId}/keys/rotate`)
record('Admin', 'POST', '/api/v1/admin/integrations/{id}/keys/rotate', 201, r.status, `revoked ${r.body?.revokedKeys} old key(s)`)
record('External', 'GET', '/api/ext/v1/me (key replaced by rotation)', 401, (await call('GET', '/api/ext/v1/me', { key })).status)
key = r.body.apiKey

// ---- External: auth & discovery ------------------------------------------------------------------------------------
r = await call('GET', '/api/ext/openapi/ext-v1.json')
record('External', 'GET', '/api/ext/openapi/ext-v1.json', 200, r.status, `OpenAPI ${r.body?.openapi}, ${Object.keys(r.body?.paths ?? {}).length} paths`)
record('External', 'GET', '/api/ext/v1/me (no key)', 401, (await call('GET', '/api/ext/v1/me')).status)
record('External', 'GET', '/api/ext/v1/me (invalid key)', 401, (await call('GET', '/api/ext/v1/me', { key: 'oic_live_0123456789abcdef_' + 'x'.repeat(43) })).status)
r = await call('GET', '/api/ext/v1/me', { key })
record('External', 'GET', '/api/ext/v1/me', 200, r.status, `${r.body?.integrationId}, ${r.body?.scopes?.length} scopes`)
r = await call('GET', '/api/ext/v1/me', { headers: { 'X-Api-Key': key } })
record('External', 'GET', '/api/ext/v1/me (X-Api-Key header)', 200, r.status)

// ---- External: meetings ---------------------------------------------------------------------------------------------
const plvc = (prarambh, extra = {}) => ({
  category: 'Customer-PLVC', meetingType: 'Instant', meetingTitle: 'Smoke PLVC', prarambhMainId: prarambh, host: { email: 'rekha.host@rec.oneinsure.test' },
  participants: [{ name: 'Kavita Customer', email: 'kavita.customer@rec.oneinsure.test' }, { name: 'Smoke Guest', email: `guest.${stamp}@example.test` }], durationMinutes: 15, externalReference: `SMOKE-${stamp}`, ...extra,
})
r = await call('POST', '/api/ext/v1/meetings', { key, body: plvc(undefined) })
record('External', 'POST', '/api/ext/v1/meetings (PLVC without Prarambh ID)', 400, r.status, Object.keys(r.body?.errors ?? {}).join(', '))
r = await call('POST', '/api/ext/v1/meetings', { key, body: plvc('12AB') })
record('External', 'POST', '/api/ext/v1/meetings (Prarambh ID not digits)', 400, r.status)
r = await call('POST', '/api/ext/v1/meetings', { key, body: { category: 'INTERNAL', meetingType: 'Instant', prarambhMainId: '1', host: { email: 'rekha.host@rec.oneinsure.test' } } })
record('External', 'POST', '/api/ext/v1/meetings (Prarambh ID on non-PLVC)', 400, r.status)
r = await call('POST', '/api/ext/v1/meetings', { key, body: plvc('1', { host: { email: 'nobody@example.test' } }) })
record('External', 'POST', '/api/ext/v1/meetings (unknown host)', 400, r.status)
const prarambh = String(800000000 + Math.floor(Math.random() * 99999999))
r = await call('POST', '/api/ext/v1/meetings', { key, body: plvc(prarambh), headers: { 'Idempotency-Key': `smoke-${stamp}` } })
record('External', 'POST', '/api/ext/v1/meetings (instant PLVC)', 201, r.status, `${r.body?.meetingId}; ${r.body?.participants?.filter((p) => p.joinUrl).length} personal join links; meetingLink ${r.body?.meetingLink ? 'yes' : 'no'}`)
const meeting = r.body
r = await call('POST', '/api/ext/v1/meetings', { key, body: plvc(prarambh), headers: { 'Idempotency-Key': `smoke-${stamp}` } })
record('External', 'POST', '/api/ext/v1/meetings (same Idempotency-Key)', 201, r.status, `replayed=${r.headers.get('idempotent-replayed')}, same meeting=${r.body?.meetingId === meeting.meetingId}`)
r = await call('POST', '/api/ext/v1/meetings', { key, body: plvc('5'), headers: { 'Idempotency-Key': `smoke-${stamp}` } })
record('External', 'POST', '/api/ext/v1/meetings (key reused, other body)', 422, r.status)
const start = new Date(Date.now() + 5 * 86400_000); start.setUTCHours(6, 0, 0, 0)
r = await call('POST', '/api/ext/v1/meetings', { key, body: { category: 'TRAINING', meetingType: 'Scheduled', meetingTitle: 'Smoke training', host: { email: 'rekha.host@rec.oneinsure.test' },
  participants: [{ name: 'Trainee One', email: `trainee.${stamp}@example.test` }], startTime: start.toISOString(), durationMinutes: 30, externalReference: `SMOKE-${stamp}` } })
record('External', 'POST', '/api/ext/v1/meetings (scheduled)', 201, r.status, `${r.body?.meetingId} at ${r.body?.startTime}`)
const scheduled = r.body
r = await call('GET', `/api/ext/v1/meetings?externalReference=SMOKE-${stamp}`, { key })
record('External', 'GET', '/api/ext/v1/meetings?externalReference=…', 200, r.status, `${r.body?.total} meeting(s)`)
r = await call('GET', `/api/ext/v1/meetings/${meeting.meetingId}`, { key })
record('External', 'GET', '/api/ext/v1/meetings/{meetingId}', 200, r.status, `status ${r.body?.status}, Prarambh ${r.body?.prarambhMainId}`)
r = await call('GET', `/api/ext/v1/meetings/${meeting.id}`, { key })
record('External', 'GET', '/api/ext/v1/meetings/{id (GUID)}', 200, r.status)
record('External', 'GET', '/api/ext/v1/meetings/{unknown}', 404, (await call('GET', '/api/ext/v1/meetings/OIC-000000-ZZZZ', { key })).status)
r = await call('POST', `/api/ext/v1/meetings/${scheduled.meetingId}/cancel`, { key, body: { reason: '' } })
record('External', 'POST', '/api/ext/v1/meetings/{meetingId}/cancel (no reason)', 400, r.status)
r = await call('POST', `/api/ext/v1/meetings/${scheduled.meetingId}/cancel`, { key, body: { reason: 'Smoke test' } })
record('External', 'POST', '/api/ext/v1/meetings/{meetingId}/cancel', 204, r.status)
r = await call('POST', `/api/ext/v1/meetings/${scheduled.meetingId}/cancel`, { key, body: { reason: 'again' } })
record('External', 'POST', '/api/ext/v1/meetings/{meetingId}/cancel (already cancelled)', 409, r.status)

// ---- External: report & recordings -----------------------------------------------------------------------------------
r = await call('GET', `/api/ext/v1/meetings/${meeting.meetingId}/report`, { key })
record('External', 'GET', '/api/ext/v1/meetings/{meetingId}/report (before start)', 200, r.status, `meeting ${r.body?.meeting?.status}, recording ${r.body?.recording?.status}`)
// Simulate a finished meeting with a finished recording (a real file in the isolated library).
const bytes = Buffer.from('SMOKE-MP4-'.repeat(2000))
const storageKey = `smoke/${prarambh}-${meeting.meetingId}-REC1-${stamp}.mp4`
fs.mkdirSync(path.join(LIBRARY, 'smoke'), { recursive: true })
fs.writeFileSync(path.join(LIBRARY, storageKey), bytes)
const sha = crypto.createHash('sha256').update(bytes).digest('hex')
sqlExec(`DECLARE @m BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = '${meeting.meetingId}');
  UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualStartUtc = DATEADD(MINUTE, -20, SYSUTCDATETIME()), ActualEndUtc = SYSUTCDATETIME() WHERE MeetingId = @m;
  INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, LeftUtc) SELECT @m, ParticipantId, DATEADD(MINUTE, -19, SYSUTCDATETIME()), DATEADD(MINUTE, -1, SYSUTCDATETIME()) FROM mtg.MeetingParticipants WHERE MeetingId = @m;
  INSERT rec.MeetingRecordings (MeetingId, OwnerEmployeeId, [Status], StartedUtc, EndedUtc, DurationSeconds, FileSizeBytes, StorageKey, Sha256, VerifiedUtc, PrarambhMainId)
  SELECT MeetingId, CreatedByEmployeeId, 'COMPLETED', DATEADD(MINUTE, -19, SYSUTCDATETIME()), DATEADD(MINUTE, -1, SYSUTCDATETIME()), 1080, ${bytes.length}, '${storageKey}', 0x${sha}, SYSUTCDATETIME(), PrarambhMainId FROM mtg.Meetings WHERE MeetingId = @m;`)
r = await call('GET', `/api/ext/v1/meetings/${meeting.meetingId}/report`, { key })
record('External', 'GET', '/api/ext/v1/meetings/{meetingId}/report (completed)', 200, r.status,
  `meeting ${r.body?.meeting?.status} ${r.body?.meeting?.durationMinutes} min; ${r.body?.participants?.length} participants (attended ${r.body?.participants?.[0]?.attendedSeconds}s); recording ${r.body?.recording?.status}`)
r = await call('GET', `/api/ext/v1/meetings/${meeting.meetingId}/recordings`, { key })
record('External', 'GET', '/api/ext/v1/meetings/{meetingId}/recordings', 200, r.status, `${r.body?.recordings?.length} recording(s): ${r.body?.recordings?.[0]?.status}, ${r.body?.recordings?.[0]?.fileName}`)
const recId = r.body.recordings[0].recordingId
r = await call('POST', `/api/ext/v1/meetings/${meeting.meetingId}/recordings/${recId}/download-link`, { key })
record('External', 'POST', '/api/ext/v1/meetings/{id}/recordings/{rid}/download-link', 200, r.status, `expires ${r.body?.expiresAt}`)
const mediaPath = new URL(r.body.url).pathname
const media = await call('GET', mediaPath, { raw: true })
const got = Buffer.from(await media.arrayBuffer())
record('External', 'GET', '/api/ext/v1/recordings/media/{token}', 200, media.status, `${media.headers.get('content-type')}, ${got.length} bytes, identical=${got.equals(bytes)}`)
const ranged = await call('GET', mediaPath, { raw: true, headers: { Range: 'bytes=0-99' } })
record('External', 'GET', '/api/ext/v1/recordings/media/{token} (Range)', 206, ranged.status, `${(await ranged.arrayBuffer()).byteLength} bytes`)
record('External', 'GET', '/api/ext/v1/recordings/media/{tampered token}', 403, (await call('GET', mediaPath.slice(0, -4) + 'AAAA')).status)
sqlExec(`UPDATE rec.MeetingRecordings SET [Status] = 'PURGED', PurgedUtc = SYSUTCDATETIME() WHERE PublicId = '${recId}'`)
record('External', 'POST', '/api/ext/v1/…/download-link (deleted recording)', 410, (await call('POST', `/api/ext/v1/meetings/${meeting.meetingId}/recordings/${recId}/download-link`, { key })).status)

// ---- External: webhooks ----------------------------------------------------------------------------------------------
record('External', 'GET', '/api/ext/v1/webhook (none yet)', 404, (await call('GET', '/api/ext/v1/webhook', { key })).status)
r = await call('PUT', '/api/ext/v1/webhook', { key, body: { url: 'ftp://example.test/x' } })
record('External', 'PUT', '/api/ext/v1/webhook (invalid URL)', 400, r.status)
r = await call('PUT', '/api/ext/v1/webhook', { key, body: { url: hookUrl, events: [] } })
record('External', 'PUT', '/api/ext/v1/webhook', 200, r.status, `secret returned once: ${r.body?.secret?.startsWith('whsec_')}`)
const secret = r.body.secret
r = await call('GET', '/api/ext/v1/webhook', { key })
record('External', 'GET', '/api/ext/v1/webhook', 200, r.status, `${r.body?.events?.length} events, secret hidden: ${r.body?.secret == null}`)
r = await call('POST', '/api/ext/v1/webhook/test', { key })
record('External', 'POST', '/api/ext/v1/webhook/test', 200, r.status, `event ${r.body?.eventId}`)
await sleep(8000) // worker polls every 5 s
const t = received.find((x) => x.event === 'webhook.test')
const sigOk = t && (() => { const { t: ts, v1 } = Object.fromEntries(t.sig.split(',').map((p) => p.split('='))); return crypto.createHmac('sha256', secret).update(`${ts}.${t.body}`).digest('hex') === v1 })()
record('Webhook', 'POST', `${hookUrl} (delivery)`, true, !!sigOk, `received ${received.length} event(s): ${[...new Set(received.map((x) => x.event))].join(', ')}; signature valid ${!!sigOk}`)
r = await A('GET', `/${intId}/webhook/deliveries`)
record('Admin', 'GET', '/api/v1/admin/integrations/{id}/webhook/deliveries', 200, r.status, `${r.body?.items?.length} deliveries (${r.body?.items?.filter((d) => d.status === 'DELIVERED').length} delivered)`)
r = await A('PUT', `/${intId}/webhook`, { url: hookUrl, events: ['meeting.completed', 'recording.completed'], active: true, rotateSecret: true })
record('Admin', 'PUT', '/api/v1/admin/integrations/{id}/webhook (rotate secret)', 200, r.status, `new secret ${r.body?.secret?.startsWith('whsec_') && r.body.secret !== secret}`)
r = await A('POST', `/${intId}/webhook/test`)
record('Admin', 'POST', '/api/v1/admin/integrations/{id}/webhook/test', 200, r.status)
const failedId = sqlScalar(`UPDATE TOP (1) d SET [Status] = 'FAILED', Attempts = 8, LastError = N'smoke' OUTPUT inserted.DeliveryId FROM app.WebhookDeliveries d JOIN app.ApiIntegrations i ON i.IntegrationId = d.IntegrationId WHERE i.IntegrationCode = '${code}'`).split(/\s+/)[0]
r = await A('POST', `/webhook/deliveries/${failedId}/retry`)
record('Admin', 'POST', '/api/v1/admin/integrations/webhook/deliveries/{id}/retry', 204, r.status)
r = await call('DELETE', '/api/ext/v1/webhook', { key })
record('External', 'DELETE', '/api/ext/v1/webhook', 204, r.status, `active now: ${(await call('GET', '/api/ext/v1/webhook', { key })).body?.active}`)
r = await A('GET', `/${intId}/logs`)
record('Admin', 'GET', '/api/v1/admin/integrations/{id}/logs', 200, r.status, `${r.body?.total} logged request(s)`)

// ---- Isolation, scopes, rate limit, deactivation -------------------------------------------------------------------------
r = await A('POST', '', { name: `Smoke Other ${stamp}`, portalName: 'Other portal', scopes: ['meeting.read'], rateLimitPerMinute: 3 })
const otherKey = r.body.apiKey
const otherId = r.body.integration.id
record('Security', 'GET', '/api/ext/v1/meetings/{another portal\'s meeting}', 404, (await call('GET', `/api/ext/v1/meetings/${meeting.meetingId}`, { key: otherKey })).status)
r = await call('POST', '/api/ext/v1/meetings', { key: otherKey, body: plvc('9') })
record('Security', 'POST', '/api/ext/v1/meetings (scope missing)', 403, r.status, r.body?.code)
await call('GET', '/api/ext/v1/me', { key: otherKey }) // 3rd request this minute (limit 3)
r = await call('GET', '/api/ext/v1/me', { key: otherKey }) // 4th
record('Security', 'GET', '/api/ext/v1/me (over 3/min limit)', 429, r.status, `${r.body?.code}, Retry-After ${r.headers.get('retry-after')}`)
await A('PUT', `/${otherId}`, { isActive: false })
record('Security', 'GET', '/api/ext/v1/me (integration deactivated)', 403, (await call('GET', '/api/ext/v1/me', { key: otherKey })).status)

server.close()
const passed = rows.filter((x) => x.result === 'PASS').length
const out = path.join(HERE, 'results', `api-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), api: API, rows }, null, 2))
console.log(`\n${passed}/${rows.length} passed · ${out}`)
process.exit(passed === rows.length ? 0 : 1)
