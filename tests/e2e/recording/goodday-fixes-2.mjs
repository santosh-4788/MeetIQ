// GoodDay "Meet" batch, part 2 (12 Nov 2026): scheduled-end countdown, Extend and automatic end (#14208), "Send link to customer"
// with WhatsApp / e-mail (#14195), and the Customer PLVC hint in the Instant meeting dialog (#14206). Microsoft Edge, headless, fake media.
//
// Isolated environment ONLY (never production): LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192, web http://127.0.0.1:5176,
// isolated LiveKit. Run:  cd tests\e2e; node recording\goodday-fixes-2.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'goodday-fixes-2')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
const PEER = 'ravi.employee@rec.oneinsure.test'

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
    results.push({ id, title, actual: String(e?.message ?? e).slice(0, 1200), result: 'FAIL' })
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
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`) }).catch(() => {})
const CAM = path.join(RESULTS, 'fake-camera.y4m')
check(fs.existsSync(CAM), 'run consent-request.mjs once first (it creates the fake camera clip)')
const browsers = []
async function newPage(viewport = { width: 1366, height: 820 }) {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`, '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
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
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
  const r = await fetch(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  let j = null; try { j = t ? JSON.parse(t) : null } catch { j = t }
  return { status: r.status, body: j }
}, { method, url, body })
async function enterRoom(page, meetingId, button) {
  await page.goto(`/meetings/${meetingId}/room`)
  await page.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: button }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}

// ---- Setup ---------------------------------------------------------------------------------------------------------------
exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
exec(`IF NOT EXISTS (SELECT 1 FROM crm.Customers WHERE CustomerRef = 'KC-WA-01') INSERT crm.Customers (CustomerRef, FullName, Email, Mobile, PolicyNumber) VALUES ('KC-WA-01', N'Meera Customer', 'meera.customer@rec.oneinsure.test', '98200 12345', 'POL-WA-1')`)
const custId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM crm.Customers WHERE CustomerRef = 'KC-WA-01'`)

let host, peer, mid, meetingId

await tc('GE-01', 'Instant meeting dialog: an internal type shows "Calling a customer? Choose Customer PLVC" (#14206); hidden for PLVC', async () => {
  host = await newPage()
  await login(host, HOST)
  await host.getByTestId('new-meeting').click()
  const hint = await host.getByTestId('instant-customer-hint').innerText()
  check(/Customer PLVC/.test(hint) && /not asked to accept/.test(hint), `hint "${hint}"`)
  await shot(host, 'ge01-instant-hint')
  await host.getByTestId('instant-type').selectOption('CUSTOMER_PLVC')
  check(!(await host.getByTestId('instant-customer-hint').count()), 'hint still shown for PLVC')
  await host.keyboard.press('Escape')
  return hint.replace(/\s+/g, ' ')
})

const ok2 = await tc('GE-02', 'Customer meeting page → "Send link to customer" → personal link with WhatsApp (mobile) and E-mail (#14195)', async () => {
  const r = await api(host, 'POST', '/meetings/instant', { category: 'CUSTOMER_GENERAL', customerId: custId, durationMinutes: 30 })
  check(r.status === 201, `instant ${JSON.stringify(r)}`)
  check(r.body.customer.mobile === '98200 12345' && r.body.customer.email, `instant response lacks contact ${JSON.stringify(r.body.customer)}`)
  await host.goto(`/meetings/${r.body.id}`)
  await host.getByTestId('send-to-customer-button').click()
  const wa = await host.getByTestId('customer-whatsapp').getAttribute('href')
  const mail = await host.getByTestId('customer-email').getAttribute('href')
  const url = await host.getByTestId('customer-link-url').inputValue()
  check(/^https:\/\/wa\.me\/919820012345\?text=/.test(wa), `whatsapp href ${wa}`)
  check(decodeURIComponent(wa).includes(url) && decodeURIComponent(wa).includes('Dear Meera Customer'), 'WhatsApp text lacks the link or name')
  check(mail.startsWith('mailto:meera.customer') && decodeURIComponent(mail).includes(url), `mail href ${mail}`)
  check((await host.getByTestId('customer-whatsapp').getAttribute('target')) === '_blank', 'WhatsApp link does not open separately')
  await shot(host, 'ge02-send-to-customer')
  // The link really works: the customer's invitation page opens.
  const p = await newPage({ width: 390, height: 844 })
  await p.goto(new URL(url).pathname)
  await p.getByRole('button', { name: 'Join meeting' }).waitFor({ timeout: 20_000 })
  await p.context().browser().close()
  pages.pop()
  await api(host, 'POST', `/meetings/${r.body.id}/room/end`)
  return `wa.me/919820012345 with the personal link; mailto ${mail.slice(0, 40)}…; link opens the customer's invitation page`
})

const ok3 = await tc('GE-03', '5 min before the end: everyone sees the countdown; the host extends by 15 min and every screen updates (#14208)', async () => {
  const r = await api(host, 'POST', '/meetings/instant', { category: 'GROUP', durationMinutes: 5, waitingRoomEnabled: false })
  check(r.status === 201, `instant ${JSON.stringify(r)}`)
  meetingId = r.body.id
  mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
  exec(`INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, [Role], ResponseStatus, LiveKitIdentity, CanScreenShare)
        SELECT ${mid}, 'EMPLOYEE', EmployeeId, 'ATTENDEE', 'ACCEPTED', CONCAT('p_', LEFT(REPLACE(CONVERT(VARCHAR(36), NEWID()), '-', ''), 12)), 1 FROM org.Employees WHERE OfficialEmail = N'${PEER}'`)
  await enterRoom(host, meetingId, 'Start meeting')
  peer = await newPage()
  await login(peer, PEER)
  await enterRoom(peer, meetingId, 'Join now')
  const hb = await host.getByTestId('end-time-banner').innerText()
  const pb = await peer.getByTestId('end-time-banner').innerText()
  check(/scheduled to end at/.test(hb) && /scheduled to end at/.test(pb), `banners "${hb}" / "${pb}"`)
  check(await host.getByTestId('extend-15').count() && !(await peer.getByTestId('extend-15').count()), 'Extend must be offered to the host only')
  await shot(host, 'ge03-host-countdown')
  const before = scalar(`SELECT CONVERT(VARCHAR(19), ScheduledEndUtc, 126) AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)
  await host.getByTestId('extend-15').click()
  await until(async () => !(await host.getByTestId('end-time-banner').count()), 'host banner still shown after extending', 8000)
  await until(async () => !(await peer.getByTestId('end-time-banner').count()), "peer's banner did not update after the host extended", 8000)
  const after = scalar(`SELECT CONVERT(VARCHAR(19), ScheduledEndUtc, 126) AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)
  const diff = (new Date(after + 'Z') - new Date(before + 'Z')) / 60000
  check(diff === 15, `end moved by ${diff} min`)
  const toast = await peer.getByText(/extended by 15 min/).count()
  return `countdown on host and peer; host-only Extend; end ${before} → ${after} (+15 min); peer banner cleared live${toast ? ' with a toast' : ''}`
})

ok3 && await tc('GE-04', 'Past the scheduled end: "ends automatically in m:ss" + End now; nobody extends → the server ends the call for everyone', async () => {
  // Move the schedule into the past, then reload both rooms so they pick up the new end time.
  exec(`UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, -30, SYSUTCDATETIME()), ScheduledEndUtc = DATEADD(SECOND, -270, SYSUTCDATETIME()) WHERE MeetingId = ${mid}`)
  await enterRoom(host, meetingId, /Start meeting|Join now|Rejoin/)
  await enterRoom(peer, meetingId, 'Join now')
  const hb = await until(async () => { const t = await host.getByTestId('end-time-banner').innerText(); return /ends automatically in \d+:\d\d/.test(t) && t }, 'no auto-end countdown', 10_000)
  check(await host.getByTestId('end-now').count(), 'End now missing for the host')
  check(/unless the host extends it/.test(await peer.getByTestId('end-time-banner').innerText()), 'peer text')
  await shot(host, 'ge04-host-overdue')
  await shot(peer, 'ge04-peer-overdue')
  // About 30 s left of the 5-min grace; the worker sweeps every 30 s.
  const t0 = Date.now()
  await until(async () => scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`) === 'COMPLETED', 'meeting not auto-ended', 120_000, 1000)
  await until(async () => !(await host.locator('[data-testid="meeting-room"]').count()) && !(await peer.locator('[data-testid="meeting-room"]').count()), 'participants still in the room', 30_000)
  const audit = scalar(`SELECT TOP 1 CONCAT(ActorType, ': ', Summary) AS v FROM app.AuditLog WHERE [Action] = 'MEETING_AUTO_ENDED' AND EntityId = '${meetingId}'`)
  await shot(peer, 'ge04-peer-after-auto-end')
  const screen = (await peer.locator('body').innerText()).split('\n').filter(Boolean).slice(0, 3).join(' | ')
  return `banner "${hb.replace(/\s+/g, ' ')}"; COMPLETED ${Math.round((Date.now() - t0) / 1000)} s later; both disconnected (peer sees: ${screen}); audit ${audit}`
})

for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const out = path.join(RESULTS, `goodday-fixes-2-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), results }, null, 2))
log(`${passed}/${results.length} passed · ${out}`)
process.exit(passed === results.length ? 0 : 1)
