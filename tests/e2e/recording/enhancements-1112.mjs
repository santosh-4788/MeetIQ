// 12 Nov 2026 enhancement batch, end to end in Microsoft Edge (headless, fake camera/microphone/screen) with the REAL R2 recorder:
// PLVC participant rows + Prarambh Main ID (instant and scheduled), the instant-meeting blank screen (chunk failure → one reload / error card,
// never white), screen share in an audio-only meeting, the API Documentation page (endpoint list from OpenAPI, Swagger UI, integrations,
// one-time API key, revocation), the external API driving a real PLVC recording (date-wise IST folder, file name starting with the Prarambh ID,
// completion report, signed download) and signed webhooks, and the no-idle-timeout session.
//
// Isolated environment ONLY: LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192 (started with Integrations__AllowPrivateWebhookTargets=true),
// web http://127.0.0.1:5176 (Vite --mode api), isolated LiveKit 127.0.0.1:7890.   Run:  cd tests\e2e; node recording\enhancements-1112.mjs
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'enhancements-1112')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FF = process.env.OIC_FFMPEG_DIR ?? 'C:/ffmpeg/bin'
const LIBRARY = path.join(ROOT, 'recording/e2e/library')
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
const ADMIN = 'superadmin@rec.oneinsure.test'

if (!/_Rec$/.test(DB)) throw new Error('Only a database whose name ends in _Rec may be used.')
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Local web server only.')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function sql(select) {
  const out = execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-y', '0', '-Q',
    `SET NOCOUNT ON; SELECT (SELECT * FROM (${select.replace(/\s*\r?\n\s*/g, ' ')}) q FOR JSON PATH, INCLUDE_NULL_VALUES) AS j`], { encoding: 'utf8' })
  const lines = out.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('[') || l.trim() === 'NULL')
  const json = start < 0 ? '' : lines.slice(start).join('').trim()
  return !json || json === 'NULL' ? [] : JSON.parse(json)
}
const scalar = (select) => Object.values(sql(select)[0] ?? { v: null })[0]
const exec = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q', q])

const results = []
const pages = []
async function tc(id, title, fn) {
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, actual, result: 'PASS' })
    log(`  PASS ${id}: ${actual ?? ''}`)
    return true
  } catch (e) {
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `${id}-fail-${i}.png`) }).catch(() => {})
    results.push({ id, title, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL' })
    log(`  FAIL ${id}: ${e?.message ?? e}`)
    return false
  }
}
const check = (c, m) => { if (!c) throw new Error(m) }
async function until(fn, msg, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: false }).catch(() => {})

const browsers = []
async function newPage({ viewport = { width: 1366, height: 860 } } = {}) {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  browsers.push(browser)
  const ctx = await browser.newContext({ baseURL: WEB, viewport, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
  pages.push(page)
  return page
}
async function login(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}
/** In-page API call with the session cookie + XSRF header. */
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
  const r = await fetch(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}, { method, url, body })
/** External API call (through the Vite proxy, exactly as a portal would call /meet/api/ext/v1 in production). */
async function ext(key, method, url, body, headers = {}) {
  const r = await fetch(`${WEB}/api/ext/v1${url}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body: json, headers: r.headers }
}
const recStatus = (p) => p.evaluate(() => document.querySelector('[data-testid="rec-indicator"]')?.getAttribute('data-status') ?? null)
const endMeeting = (page, id) => api(page, 'POST', `/meetings/${id}/room/end`)

// ---- Setup -------------------------------------------------------------------------------------------------------------
exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
let host, admin, apiKey, integrationCode
const PRARAMBH_UI = String(700000000 + Math.floor(Math.random() * 99999999))

const ok1 = await tc('EN-01', 'Instant meeting → Customer PLVC: Prarambh Main ID + participant rows (no customer picker); validation; starts without a blank screen', async () => {
  host = await newPage()
  await login(host, HOST)
  const s = await api(host, 'GET', '/auth/session')
  check(s.body.idleMinutes === 0, `idleMinutes ${s.body.idleMinutes} (expected 0 = no idle timeout)`)
  await host.getByTestId('new-meeting').click()
  await host.getByTestId('instant-type').selectOption('CUSTOMER_PLVC')
  await host.getByTestId('plvc-fields').waitFor()
  check(!(await host.getByRole('button', { name: /Add new customer/i }).count()), 'the old "Add customer" control is still shown for PLVC')
  await host.getByTestId('start-instant').click()
  await host.getByText('Prarambh Main ID is required').waitFor()
  await host.getByText('Enter the participant name.').waitFor()
  await host.getByTestId('prarambh-main-id').fill('12ab34')
  check((await host.getByTestId('prarambh-main-id').inputValue()) === '1234', 'non-digits were not stripped')
  await host.getByTestId('prarambh-main-id').fill(PRARAMBH_UI)
  const rows = host.getByTestId('participant-row')
  await rows.nth(0).getByTestId('participant-name').fill('Kavita Customer')
  await rows.nth(0).getByTestId('participant-email').fill('kavita.customer@rec.oneinsure.test')
  await host.getByTestId('participant-add').click()
  await rows.nth(1).getByTestId('participant-name').fill('Nikhil Nominee')
  await rows.nth(1).getByTestId('participant-email').fill('KAVITA.customer@rec.oneinsure.test')
  await host.getByTestId('participant-add').click()
  check((await rows.count()) === 3, 'add (+) did not add a row')
  await rows.nth(2).getByTestId('participant-remove').click()
  check((await rows.count()) === 2, 'remove (×) did not remove the row')
  await host.getByTestId('start-instant').click()
  await host.getByText('This participant is listed twice.').waitFor()
  await rows.nth(1).getByTestId('participant-email').fill('nikhil.nominee@rec.oneinsure.test')
  await shot(host, 'en01-plvc-instant-dialog')
  const t0 = Date.now()
  await host.getByTestId('start-instant').click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}\/room/, { timeout: 20_000 })
  await host.getByRole('button', { name: 'Start meeting' }).waitFor({ timeout: 25_000 })
  const toPrejoin = Date.now() - t0
  const id = host.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  const row = sql(`SELECT m.PrarambhMainId, c.FullName, c.Email, c.CustomerRef, (SELECT COUNT(*) FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.ParticipantType = 'GUEST') AS Guests
    FROM mtg.Meetings m JOIN crm.Customers c ON c.CustomerId = m.CustomerId WHERE m.PublicId = '${id}'`)[0]
  check(row?.PrarambhMainId === PRARAMBH_UI, `stored Prarambh ${row?.PrarambhMainId}`)
  check(row.Email === 'kavita.customer@rec.oneinsure.test' && row.Guests === 1, `customer/guests ${JSON.stringify(row)}`)
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  const links = await until(async () => (await host.getByTestId('customer-link').count()) >= 2 && host.getByTestId('customer-link').count(), 'invite dialog did not list both participant links', 15_000)
  await shot(host, 'en01-invite-links')
  await host.keyboard.press('Escape')
  await endMeeting(host, id)
  return `pre-join shown ${toPrejoin} ms after Start (no refresh); Prarambh ${row.PrarambhMainId} stored; customer ${row.CustomerRef} (${row.Email}) + 1 guest; invite dialog shows ${links} personal links`
})

ok1 && await tc('EN-02', 'Schedule meeting → Customer PLVC: participant rows + Prarambh Main ID; the detail page shows it', async () => {
  await host.goto('/schedule')
  await host.getByLabel('Title').fill('PLVC verification (scheduled)')
  await host.getByLabel('Category').selectOption('CUSTOMER_PLVC')
  await host.getByTestId('plvc-fields').waitFor()
  const prarambh = String(Number(PRARAMBH_UI) + 1)
  await host.getByTestId('prarambh-main-id').fill(prarambh)
  const rows = host.getByTestId('participant-row')
  await rows.nth(0).getByTestId('participant-name').fill('Meera Customer')
  await rows.nth(0).getByTestId('participant-email').fill('meera.customer@rec.oneinsure.test')
  await shot(host, 'en02-schedule-plvc')
  // The form defaults to the next free slot today (always in the future).
  await host.getByRole('button', { name: 'Schedule meeting', exact: true }).click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 }).catch(async () => {
    const conflict = host.getByRole('button', { name: /Schedule anyway|Book anyway/ })
    if (await conflict.count()) await conflict.click()
    await host.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 })
  })
  const shown = (await host.getByTestId('detail-prarambh').innerText()).trim()
  check(shown === prarambh, `detail shows "${shown}"`)
  const id = host.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  const mails = scalar(`SELECT COUNT(*) AS v FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.PublicId = '${id}' AND o.ToAddress = N'meera.customer@rec.oneinsure.test'`)
  await shot(host, 'en02-detail-prarambh')
  await api(host, 'POST', `/meetings/${id}/cancel`, { reason: 'E2E cleanup' })
  return `scheduled; detail page Prarambh Main ID ${shown}; invitation e-mails queued for the customer: ${mails}`
})

await tc('EN-03', 'Instant meeting room chunk fails to download once → one automatic reload, room opens (no blank page); fails every time → error card, never blank', async () => {
  const p = await newPage()
  await login(p, HOST)
  const created = await api(p, 'POST', '/meetings/instant', { category: 'GROUP', durationMinutes: 15 })
  check(created.status === 201, `instant ${created.status}`)
  let hits = 0
  await p.route(/\/src\/pages\/room\/EmployeeRoomPage\.tsx/, (route) => (hits++ === 0 ? route.abort('failed') : route.continue()))
  await p.goto(`/meetings/${created.body.id}/room`)
  await p.getByRole('button', { name: 'Start meeting' }).waitFor({ timeout: 25_000 })
  check(hits >= 2, `room module requested ${hits}× (expected a retry after the failure)`)
  const once = hits
  await p.unroute(/\/src\/pages\/room\/EmployeeRoomPage\.tsx/)
  // Always failing: the error card is shown, not a white page.
  const q = await newPage()
  await login(q, HOST)
  await q.route(/\/src\/pages\/room\/EmployeeRoomPage\.tsx/, (route) => route.abort('failed'))
  await q.goto(`/meetings/${created.body.id}/room`)
  await q.getByTestId('page-error').waitFor({ timeout: 25_000 })
  const text = (await q.locator('body').innerText()).trim()
  check(text.length > 20, 'page is blank')
  await shot(q, 'en03-error-card')
  await endMeeting(p, created.body.id)
  return `1st download aborted → reloaded once, pre-join shown (module requested ${once}×); permanent failure → "${(await q.getByTestId('page-error').locator('h1').innerText()).trim()}" card with Reload`
})

await tc('EN-04', 'Screen share in an AUDIO-ONLY meeting: Present button available, no camera button', async () => {
  const p = await newPage()
  await login(p, HOST)
  const created = await api(p, 'POST', '/meetings/instant', { category: 'TEAM', durationMinutes: 15, audioOnly: true, waitingRoomEnabled: false })
  await p.goto(`/meetings/${created.body.id}/room`)
  await p.getByRole('button', { name: 'Start meeting' }).click()
  await p.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  await p.keyboard.press('Escape')
  await p.getByTestId('ctl-screen').waitFor({ timeout: 10_000 })
  check(!(await p.getByTestId('ctl-cam').count()), 'camera control shown in an audio-only meeting')
  await p.getByTestId('ctl-screen').click()
  await until(async () => (await p.locator('[data-testid="tile-screen"]').count()) > 0, 'screen share did not start', 15_000)
  const cam = await p.evaluate(() => [...document.querySelectorAll('video')].length)
  await shot(p, 'en04-audio-only-sharing')
  await endMeeting(p, created.body.id)
  return `audio-only meeting: Present available, camera control absent; sharing started (${cam} video element(s) = the screen only)`
})

const ok5 = await tc('EN-05', 'Organisation → System → API Documentation: endpoint list from OpenAPI, Swagger UI, create integration (key shown once), use it, revoke it', async () => {
  admin = await newPage()
  await login(admin, ADMIN)
  await admin.getByRole('link', { name: 'API Documentation' }).click()
  await admin.getByTestId('api-docs-page').waitFor()
  const endpoints = await until(async () => { const n = await admin.locator('[data-testid="api-endpoint-table"] tbody tr').count(); return n >= 10 && n }, 'endpoint table not filled from OpenAPI', 15_000)
  await shot(admin, 'en05-guide')
  const dl = await fetch(`${WEB}${await admin.getByTestId('download-openapi').getAttribute('href')}`)
  check(dl.status === 200 && (await dl.json()).openapi?.startsWith('3.'), 'OpenAPI download failed')
  await admin.getByRole('tab', { name: /API reference/ }).click()
  const ops = await until(async () => { const n = await admin.locator('[data-testid="swagger-ui"] .opblock').count(); return n >= 10 && n }, 'Swagger UI did not render operations', 30_000)
  await shot(admin, 'en05-swagger')
  await admin.getByRole('tab', { name: /Integrations/ }).click()
  await admin.getByTestId('integration-new').click()
  await admin.getByTestId('integration-name').fill(`E2E Portal ${Date.now().toString(36)}`)
  await admin.getByTestId('integration-portal').fill('E2E partner portal')
  for (const s of ['meeting.schedule', 'meeting.cancel', 'recording.download', 'webhook.manage']) await admin.getByTestId(`scope-${s}`).check()
  await admin.getByTestId('integration-create').click()
  apiKey = await admin.getByTestId('secret-value').inputValue()
  integrationCode = (await admin.getByTestId('new-integration-code').innerText()).trim()
  check(/^oic_live_[0-9a-f]{16}_/.test(apiKey), `key format ${apiKey.slice(0, 20)}`)
  await shot(admin, 'en05-key-shown-once')
  const me = await ext(apiKey, 'GET', '/me')
  check(me.status === 200 && me.body.integrationId === integrationCode, `me ${me.status}`)
  check(scalar(`SELECT COUNT(*) AS v FROM app.ApiKeys WHERE KeyPrefix = '${apiKey.slice(0, 25)}'`) === 1, 'key prefix not stored')
  // Employees do not see the module.
  check(!(await host.getByRole('link', { name: 'API Documentation' }).count()), 'an employee sees API Documentation')
  return `${endpoints} endpoints listed from OpenAPI; Swagger UI rendered ${ops} operations; integration ${integrationCode} created, key shown once and accepted by /me`
})

ok5 && await tc('EN-06', 'External API → real PLVC recording: IST date folder, file name starts with the Prarambh ID; completion report; signed download; signed webhooks', async () => {
  // Webhook receiver on localhost (allowed because the isolated API runs with Integrations__AllowPrivateWebhookTargets=true).
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { received.push({ event: req.headers['x-oic-event'], sig: req.headers['x-oic-signature'], body }); res.writeHead(200).end('ok') })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const hook = await ext(apiKey, 'PUT', '/webhook', { url: `http://localhost:${port}/oic`, events: [] })
    check(hook.status === 200 && hook.body.secret?.startsWith('whsec_'), `webhook ${hook.status} ${JSON.stringify(hook.body)}`)
    const secret = hook.body.secret
    const prarambh = String(Number(PRARAMBH_UI) + 2)
    const created = await ext(apiKey, 'POST', '/meetings', {
      category: 'Customer-PLVC', meetingType: 'Instant', meetingTitle: 'API PLVC call', prarambhMainId: prarambh, host: { email: HOST },
      participants: [{ name: 'Kavita Customer', email: 'kavita.customer@rec.oneinsure.test' }], durationMinutes: 15, externalReference: 'E2E-REF-9',
    }, { 'Idempotency-Key': `e2e-${prarambh}` })
    check(created.status === 201, `create ${created.status} ${JSON.stringify(created.body)}`)
    const code = created.body.meetingId
    const id = created.body.id
    // The host joins from the portal; PLVC recording is mandatory and starts by itself.
    await host.goto(`/meetings/${id}/room`)
    await host.getByRole('button', { name: 'Start meeting' }).click()
    await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
    await host.keyboard.press('Escape')
    await until(async () => (await recStatus(host)) === 'RECORDING', 'PLVC recording never started', 120_000, 500)
    await sleep(10_000)
    const end = await endMeeting(host, id)
    check(end.status === 204, `end ${end.status}`)
    const rec = await until(() => sql(`SELECT r.[Status], r.StorageKey, r.PrarambhMainId, r.IntegrationId, CONVERT(VARCHAR(36), r.PublicId) AS Id, r.StartedUtc FROM rec.MeetingRecordings r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId WHERE m.PublicId = '${id}' AND r.[Status] = 'COMPLETED'`)[0],
      'recording not COMPLETED', 240_000, 2000)
    const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(rec.StartedUtc + 'Z')).replaceAll('-', '')
    const re = new RegExp(`^${istDate}/${prarambh}-${code}-REC\\d+\\.mp4$`)
    check(re.test(rec.StorageKey), `storage key "${rec.StorageKey}" does not match ${re}`)
    check(rec.PrarambhMainId === prarambh && rec.IntegrationId != null, 'recording metadata missing Prarambh/integration')
    const file = path.join(LIBRARY, rec.StorageKey)
    check(fs.existsSync(file), `file missing: ${file}`)
    const probe = execFileSync(path.join(FF, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'format_tags=title,comment:format=duration', '-of', 'json', file], { encoding: 'utf8' })
    const tags = JSON.parse(probe).format
    check(tags.tags?.title === `${prarambh}-${code}`, `MP4 title tag "${tags.tags?.title}"`)
    // Completion report.
    const report = await until(async () => { const r = await ext(apiKey, 'GET', `/meetings/${code}/report`); return r.body?.recording?.status === 'Completed' && r }, 'report never showed the completed recording', 30_000, 1000)
    check(report.body.meeting.status === 'Completed' && report.body.meeting.prarambhMainId === prarambh, `report meeting ${JSON.stringify(report.body.meeting)}`)
    const host0 = report.body.participants.find((p) => p.role === 'HOST')
    // Join/leave rows come from LiveKit webhooks, which this isolated environment does not receive: the report must then say
    // "no attendance" (null), never invent times. (Attendance with real rows: API test Completion_report_keeps_recording_status_separate….)
    check(host0 && (host0.joinedAt === null ? host0.attendedSeconds === 0 && host0.sessions.length === 0 : host0.joinedAt.endsWith('+05:30')), `host attendance ${JSON.stringify(host0)}`)
    check(report.body.meeting.startTime?.endsWith('+05:30') && report.body.meeting.endTime?.endsWith('+05:30'), 'meeting times not in IST')
    // Download through a signed, short-lived link (no API key).
    const link = await ext(apiKey, 'POST', `/meetings/${code}/recordings/${rec.Id}/download-link`)
    check(link.status === 200 && link.body.fileName === path.basename(rec.StorageKey), `link ${link.status} ${JSON.stringify(link.body)}`)
    const urlPath = new URL(link.body.url).pathname.replace(/^\/meet/, '')
    const dlRes = await fetch(`${WEB}${urlPath}`)
    const bytes = Buffer.from(await dlRes.arrayBuffer())
    check(dlRes.status === 200 && dlRes.headers.get('content-type') === 'video/mp4' && bytes.length === fs.statSync(file).size, `download ${dlRes.status} ${bytes.length}`)
    check(!JSON.stringify(report.body).includes('library') && !JSON.stringify(link.body).includes('\\'), 'a server path leaked')
    // Webhooks: signed, one per state change.
    await until(() => ['meeting.created', 'meeting.started', 'recording.started', 'recording.completed', 'meeting.completed'].every((e) => received.some((r) => r.event === e)),
      `webhooks missing; got ${JSON.stringify(received.map((r) => r.event))}`, 60_000, 1000)
    for (const r of received) {
      const { t, v1 } = Object.fromEntries(r.sig.split(',').map((x) => x.split('=')))
      check(crypto.createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex') === v1, `bad signature on ${r.event}`)
    }
    const dupes = received.filter((r) => r.event === 'meeting.started').length
    check(dupes === 1, `meeting.started delivered ${dupes}×`)
    // Revoke from the admin page → the key stops working at once.
    if (await admin.getByRole('button', { name: 'Done' }).count()) await admin.getByRole('button', { name: 'Done' }).click()
    await admin.getByRole('tab', { name: /Integrations/ }).click()
    await admin.getByTestId('integration-row').filter({ hasText: integrationCode }).click()
    await admin.getByTestId('key-revoke').first().click()
    await admin.getByTestId('revoke-reason').fill('E2E test complete')
    await admin.getByRole('button', { name: 'Revoke key' }).click()
    await until(async () => (await ext(apiKey, 'GET', '/me')).status === 401, 'revoked key still accepted', 10_000)
    await shot(admin, 'en06-integration-detail-after-revoke')
    return `key ${rec.StorageKey}; MP4 title "${tags.tags.title}", ${Number(tags.duration).toFixed(1)} s; report: meeting Completed, recording Completed; signed download ${bytes.length} bytes; webhooks ${[...new Set(received.map((r) => r.event))].join(', ')} (all signatures valid, meeting.started once); revoked key → 401`
  } finally {
    server.close()
  }
})

for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const out = path.join(RESULTS, `enhancements-1112-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), results }, null, 2))
log(`${passed}/${results.length} passed · ${out}`)
process.exit(passed === results.length ? 0 : 1)
