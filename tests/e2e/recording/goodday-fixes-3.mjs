// GoodDay #14216 (I39JOD), 13 Nov 2026: "Scheduled a customer PLVC meeting and it shows a message on the screen which is not closing;
// same is displayed on the customer's side." The message is the recording notice banner (Customer PLVC = MANDATORY + NOTIFICATION_ONLY).
// Its only close control was a 16 px × - on a phone almost every tap missed it, and the banner covered about half the video.
// Checks: full-size close targets (× and "OK, got it"), an off-centre tap closes it, it stays closed, height capped on a phone,
// the internal "Wording not confirmed" note only for the host (never the customer), the acknowledgement still recorded for both.
//
// Isolated environment ONLY: LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192, web http://127.0.0.1:5176 (Vite --mode api),
// isolated LiveKit 127.0.0.1:7890.   Run:  cd tests\e2e; node recording\goodday-fixes-3.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'goodday-fixes-3')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
if (!/_Rec$/.test(DB)) throw new Error('Only a database whose name ends in _Rec may be used.')
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Local web server only.')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sqlcmd = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${q}`], { encoding: 'utf8' }).trim()

const results = []
const pages = []
async function tc(id, title, fn) {
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, actual, result: 'PASS' }); log(`  PASS ${id}: ${actual ?? ''}`); return true
  } catch (e) {
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `${id}-fail-${i}.png`) }).catch(() => {})
    results.push({ id, title, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL' }); log(`  FAIL ${id}: ${e?.message ?? e}`); return false
  }
}
const check = (c, m) => { if (!c) throw new Error(m) }
async function until(fn, msg, ms = 25_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await fn()) return true } catch { /* retry */ } await sleep(300) }
  throw new Error(msg)
}
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, `${n}.png`) }).catch(() => {})
const browsers = []
async function newPage(viewport, mobile = false) {
  const b = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  browsers.push(b)
  const ctx = await b.newContext({ baseURL: WEB, viewport, isMobile: mobile, hasTouch: mobile, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const p = await ctx.newPage(); p.setDefaultTimeout(20_000)
  p.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
  pages.push(p); return p
}
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
  const r = await fetch(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}, { method, url, body })
const banner = (p) => p.locator('[data-testid="rec-notice-banner"]')
/** Clicks (or taps) a point 14 px off the centre of the close button - inside a 44 px target, outside the old 16 px icon. */
async function tapOffCentre(p, mobile) {
  const b = await p.getByTestId('rec-notice-close').boundingBox()
  check(b && b.width >= 44 && b.height >= 44, `close target only ${b?.width}×${b?.height} px (needs ≥ 44×44)`)
  const x = b.x + b.width / 2 - 14, y = b.y + b.height / 2 + 14
  if (mobile) await p.touchscreen.tap(x, y); else await p.mouse.click(x, y)
  return `${b.width}×${b.height}`
}

// Same production policy shape: Customer PLVC = mandatory recording, notification only (placeholder wording, unconfirmed).
sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE');
  UPDATE rec.RecordingPolicies SET IsEnabled = 1, Requirement = 'MANDATORY', ConsentMode = 'NOTIFICATION_ONLY' WHERE PolicyCode = 'CUSTOMER_PLVC'`)

let host, cust, meeting, mid
const ok1 = await tc('GD3-01', 'Host (desktop): PLVC notice banner with internal note; × is a 44 px target; an off-centre click closes it; it stays closed', async () => {
  host = await newPage({ width: 1366, height: 860 })
  await host.goto('/login')
  await host.getByLabel('Official Email / Employee ID').fill(HOST)
  await host.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await host.getByRole('button', { name: 'Sign In' }).click()
  await host.waitForURL(/\/dashboard/)
  const created = await api(host, 'POST', '/meetings/instant', { category: 'CUSTOMER_PLVC', durationMinutes: 30, prarambhMainId: '140216',
    participants: [{ name: 'Kavita Customer', email: 'kavita.customer@rec.oneinsure.test' }] })
  check(created.status === 201, `instant ${created.status}`)
  meeting = created.body
  mid = Number(sqlcmd(`SELECT MeetingId FROM mtg.Meetings WHERE PublicId = '${meeting.id}'`))
  await host.goto(`/meetings/${meeting.id}/room`)
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await banner(host).waitFor({ timeout: 30_000 })
  // 13 Nov 2026 redesign: the internal note (hosts only) shows only while the policy wording is unconfirmed.
  // RecordingPolicies.NoticeConfirmed: a reference and no placeholder wording/version (or the whole policy confirmed).
  const confirmed = sqlcmd(`SELECT CASE WHEN ISNULL(PolicyReference,'') <> '' AND (ApprovalStatus IN ('APPROVED','EXISTING_BUSINESS_POLICY')
    OR (NoticeText NOT LIKE '%[[]PLACEHOLDER%' AND NoticeVersion NOT LIKE 'PLACEHOLDER%')) THEN 1 ELSE 0 END FROM rec.RecordingPolicies WHERE PolicyCode = 'CUSTOMER_PLVC'`) === '1'
  check(await banner(host).getByTestId('rec-notice-internal').count() === (confirmed ? 0 : 1), `host internal note shown wrongly (policy confirmed: ${confirmed})`)
  await shot(host, 'gd3-01-host-banner')
  const size = await tapOffCentre(host, false)
  await until(async () => (await banner(host).count()) === 0, 'banner still open after clicking the ×', 3000)
  await sleep(12_000) // two state polls (10 s) later it must not come back
  check((await banner(host).count()) === 0, 'banner came back')
  await shot(host, 'gd3-01-host-closed')
  return `× target ${size} px; off-centre click closed it; still closed 12 s later (after a state poll)`
})

ok1 && await tc('GD3-02', 'Customer (phone 390×844, touch): banner without the internal note, height capped; "OK, got it" (≥ 44 px) closes it; stays closed', async () => {
  cust = await newPage({ width: 390, height: 844 }, true)
  await cust.goto(new URL(meeting.participants[0].joinUrl).pathname)
  await cust.getByRole('button', { name: 'Join meeting' }).click({ timeout: 30_000 })
  await cust.getByText('Ready to join?').waitFor({ timeout: 30_000 }).catch(() => {})
  const nm = cust.getByTestId('prejoin-name'); if ((await nm.count()) && !(await nm.inputValue())) await nm.fill('Kavita Customer')
  await cust.getByRole('button', { name: /Ask to join|Join now/ }).click()
  await until(async () => {
    if (await cust.locator('[data-testid="meeting-room"]').count()) return true
    if (!(await host.getByTestId('waiting-entry').count()) && (await host.getByTestId('waiting-badge').count())) await host.getByTestId('ctl-people').click().catch(() => {})
    const admit = host.getByTestId('waiting-admit'); if (await admit.count()) await admit.first().click().catch(() => {})
    return false
  }, 'customer never got into the room', 40_000)
  await banner(cust).waitFor({ timeout: 30_000 })
  check((await banner(cust).getByText('Wording not confirmed').count()) === 0, 'the customer sees the internal "Wording not confirmed" note')
  check((await banner(cust).getByTestId('rec-notice-text').count()) === 1, 'the customer does not see the notice text itself')
  const bb = await banner(cust).boundingBox()
  check(bb.height <= 844 * 0.4 + 1, `banner is ${Math.round(bb.height)} px tall on an 844 px screen (cap 40%)`)
  await shot(cust, 'gd3-02-customer-banner-390px')
  const ok = cust.getByTestId('rec-notice-ok')
  await ok.scrollIntoViewIfNeeded()
  const ob = await ok.boundingBox()
  check(ob.height >= 44, `"OK, got it" only ${ob.height} px tall on a phone`)
  await cust.touchscreen.tap(ob.x + 10, ob.y + ob.height / 2)
  await until(async () => (await banner(cust).count()) === 0, 'banner still open after tapping "OK, got it"', 3000)
  await sleep(12_000)
  check((await banner(cust).count()) === 0, 'banner came back on the customer side')
  check((await host.locator('[data-testid="rec-notice-banner"]').count()) === 0, 'host banner came back when the customer joined')
  await shot(cust, 'gd3-02-customer-closed-390px')
  return `banner ${Math.round(bb.height)} px of 844 (≤ 40%); no internal note for the customer; "OK, got it" ${Math.round(ob.width)}×${Math.round(ob.height)} px closed it; still closed 12 s later; host still closed`
})

ok1 && await tc('GD3-03', 'The notice acknowledgement is still recorded for host and customer (nothing about consent changed)', async () => {
  const rows = sqlcmd(`SELECT p.ParticipantType + ':' + c.Decision FROM mtg.MeetingConsent c JOIN mtg.MeetingParticipants p ON p.ParticipantId = c.ParticipantId
    WHERE c.MeetingId = ${mid} AND c.ConsentType = 'RECORDING' ORDER BY c.ConsentId`).split(/\r?\n/).filter(Boolean)
  check(rows.includes('EMPLOYEE:GRANTED') && rows.includes('CUSTOMER:GRANTED'), `consent rows ${JSON.stringify(rows)}`)
  const rec = sqlcmd(`SELECT TOP (1) [Status] FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)
  return `acknowledgements: ${rows.join(', ')}; recording ${rec}`
})

// GoodDay MaXW9q (reopened 13 Nov, iPhone): "when user click on more button no option to close popup". The toolbar's backdrop-filter made it the
// containing block of the sheet's "fixed inset-0" backdrop, so the backdrop covered only the toolbar and a tap on the video did nothing.
ok1 && cust && await tc('GD3-04', 'Phone (390×844, touch): the More sheet has a Close button and its backdrop covers the whole screen; a tap on the video or on Close closes it', async () => {
  const sheet = cust.getByTestId('more-sheet')
  await cust.getByTestId('ctl-more').tap()
  await sheet.waitFor()
  const bd = await cust.getByTestId('more-sheet-backdrop').boundingBox()
  check(bd && bd.width >= 389 && bd.height >= 843, `backdrop only ${bd?.width}×${bd?.height} px (must cover 390×844)`)
  const hit = await cust.evaluate(() => document.elementFromPoint(195, 250)?.getAttribute('data-testid'))
  check(hit === 'more-sheet-backdrop', `a tap on the video at (195, 250) lands on "${hit}", not the backdrop`)
  await shot(cust, 'gd3-04-more-sheet-390px')
  await cust.touchscreen.tap(195, 250)
  await until(async () => (await sheet.count()) === 0, 'More sheet still open after tapping the video', 3000)
  await cust.getByTestId('ctl-more').tap()
  await sheet.waitFor()
  const cb = await cust.getByTestId('more-sheet-close').boundingBox()
  check(cb.width >= 44 && cb.height >= 44, `Close button ${cb.width}×${cb.height} px`)
  await cust.touchscreen.tap(cb.x + cb.width / 2, cb.y + cb.height / 2)
  await until(async () => (await sheet.count()) === 0, 'More sheet still open after tapping Close', 3000)
  // The controls in it still work (they close it too): Speaker/Grid view.
  await cust.getByTestId('ctl-more').tap()
  await sheet.getByText(/Speaker view|Grid view/).waitFor()
  return `backdrop ${bd.width}×${bd.height} px; tap on the video closes it; Close ${cb.width}×${cb.height} px closes it`
})
if (cust) await cust.keyboard.press('Escape').catch(() => {})

if (meeting) await api(host, 'POST', `/meetings/${meeting.id}/room/end`).catch(() => {})

// GoodDay CVPJMP (reopened 13 Nov): "did not receive any popup after 15 minutes" - meeting 09:15-09:30 started at 09:02.
host && await tc('GD3-05', 'Scheduled 15-minute meeting started 12 minutes early: the room\'s end time and automatic end follow the actual start', async () => {
  const start = new Date(Date.now() + 12 * 60_000), end = new Date(start.getTime() + 15 * 60_000)
  const ravi = sqlcmd(`SELECT e.PublicId FROM org.Employees e JOIN auth.Users u ON u.EmployeeId = e.EmployeeId WHERE u.Email = 'ravi.employee@rec.oneinsure.test'`)
  const created = await api(host, 'POST', '/meetings', { title: 'GD3-05 early start', category: 'TEAM', startUtc: start.toISOString(), endUtc: end.toISOString(),
    employeeIds: [ravi], status: 'SCHEDULED', waitingRoomEnabled: false, allowConflicts: true })
  check(created.status === 201, `create ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`)
  const id = created.body.id
  await host.goto(`/meetings/${id}/room`)
  const t0 = Date.now()
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  const row = sqlcmd(`SELECT CONCAT(DATEDIFF(SECOND, ScheduledStartUtc, ScheduledEndUtc), '|', DATEDIFF(SECOND, ActualStartUtc, ScheduledStartUtc), '|', [Status]) FROM mtg.Meetings WHERE PublicId = '${id}'`)
  const [secs, drift, status] = row.split('|')
  check(status === 'LIVE' && Number(secs) === 900 && Math.abs(Number(drift)) <= 1, `after an early start: ${row} (expected 900 s slot from the actual start)`)
  const session = await api(host, 'POST', `/meetings/${id}/join`)
  const m = session.body.meeting
  const mins = (Date.parse(m.endUtc) - Date.parse(m.startUtc)) / 60_000
  const fromNow = (Date.parse(m.endUtc) - t0) / 60_000
  check(Math.abs(mins - 15) < 0.05 && fromNow > 14 && fromNow < 15.5, `room end time ${m.endUtc}: ${mins} min slot, ${fromNow.toFixed(1)} min from the start`)
  const autoEnd = (Date.parse(m.autoEndUtc) - Date.parse(m.endUtc)) / 60_000
  await shot(host, 'gd3-05-early-start-room')
  await api(host, 'POST', `/meetings/${id}/room/end`)
  return `booked ${start.toISOString().slice(11, 16)}-${end.toISOString().slice(11, 16)} UTC, started 12 min early → slot now ${m.startUtc.slice(11, 16)}-${m.endUtc.slice(11, 16)} UTC (15 min from the actual start); automatic end ${autoEnd} min after it`
})
for (const b of browsers) await b.close().catch(() => {})
const file = path.join(RESULTS, `goodday-fixes-3-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ suite: 'goodday-fixes-3', web: WEB, db: DB, results }, null, 2))
const passed = results.filter((r) => r.result === 'PASS').length
log(`${passed}/${results.length} passed → ${file}`)
process.exit(passed === results.length && results.length === 5 ? 0 : 1)
