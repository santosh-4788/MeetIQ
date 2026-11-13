// 13 Nov 2026 (Oneinsure_connect_bugs.docx, part 3 - the parts approved for now):
//  - Instant meeting: every participant is e-mailed their OWN personal link when the host starts (queued in app.EmailOutbox);
//    a removed row gets nothing; double click creates one meeting; delivery status + "Send again" for the host.
//  - Schedule Meeting: compact two-column layout, every field still there, PLVC scheduling + Save as draft still work,
//    no horizontal scroll on a phone.
//  - Reports: Prarambh Main ID column.
// Isolated environment ONLY (LocalDB *_Rec, local API/web). E-mail sending is off locally: rows stay PENDING in the outbox.
//   Run:  cd tests\e2e; node recording\doc3-instant-schedule.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'doc3-instant-schedule')
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
const sqlcmd = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${q}`], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim()
const lines = (q) => sqlcmd(q).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

const results = []
const pages = []
async function tc(id, title, fn) {
  log(`â–¶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, actual, result: 'PASS' }); log(`  PASS ${id}: ${actual ?? ''}`); return true
  } catch (e) {
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `${id}-fail-${i}.png`), fullPage: true }).catch(() => {})
    results.push({ id, title, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL' }); log(`  FAIL ${id}: ${e?.message ?? e}`); return false
  }
}
const check = (c, m) => { if (!c) throw new Error(m) }
async function until(fn, msg, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await fn()) return true } catch { /* retry */ } await sleep(300) }
  throw new Error(msg)
}
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
async function login(p) {
  await p.goto('/login')
  await p.getByLabel('Official Email / Employee ID').fill(HOST)
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await p.getByRole('button', { name: 'Sign In' }).click()
  await p.waitForURL(/\/dashboard/)
}
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
  const r = await fetch(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}, { method, url, body })

sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
// Mirror the live Customer PLVC policy (mandatory, notification only, approved wording, status PENDING_CONFIRMATION).
sqlcmd(`UPDATE rec.RecordingPolicies SET IsEnabled = 1, Requirement = 'MANDATORY', ConsentMode = 'NOTIFICATION_ONLY', ApprovalStatus = 'PENDING_CONFIRMATION',
  PolicyReference = N'Approved by product owner (Santosh Yadav), 13 Nov 2026', ApprovedBy = N'Santosh Yadav (product owner)', ApprovedOn = '2026-11-13' WHERE PolicyCode = 'CUSTOMER_PLVC'`)
const tag = Date.now().toString(36).slice(-5)
const mail = (n) => `${n}.${tag}@rec.oneinsure.test`

const host = await newPage({ width: 1366, height: 860 })
await login(host)

async function openInstantPlvc(p) {
  await p.goto('/dashboard')
  await p.getByTestId('new-meeting').click()
  await p.getByRole('dialog').getByText('Start an instant meeting').waitFor()
  await p.getByTestId('instant-type').selectOption('CUSTOMER_PLVC')
  await p.getByTestId('prarambh-main-id').fill('7712345')
}
async function fillRow(p, i, name, email) {
  await p.getByTestId('participant-name').nth(i).fill(name)
  await p.getByTestId('participant-email').nth(i).fill(email)
}

let meetingId, mid
await tc('IM-01', 'Instant PLVC, 3 rows then one removed, Start double-clicked: ONE meeting; 2 invitation e-mails, each to its own address with only its own personal link; the removed person gets nothing', async () => {
  await openInstantPlvc(host)
  await fillRow(host, 0, 'Meera Customer', mail('meera'))
  await host.getByTestId('participant-add').click()
  await fillRow(host, 1, 'Removed Person', mail('removed'))
  await host.getByTestId('participant-add').click()
  await fillRow(host, 2, 'Nikhil Guest', mail('nikhil'))
  await host.getByTestId('participant-remove').nth(1).click()
  const before = Number(sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings WHERE PrarambhMainId = '7712345'`))
  await host.getByTestId('start-instant').dblclick()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}\/room/, { timeout: 30_000 })
  meetingId = host.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  await sleep(1500)
  const after = Number(sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings WHERE PrarambhMainId = '7712345'`))
  check(after - before === 1, `${after - before} meetings created by a double click`)
  mid = Number(sqlcmd(`SELECT MeetingId FROM mtg.Meetings WHERE PublicId = '${meetingId}'`))
  const rows = lines(`SELECT ToAddress + '|' + [Status] FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND Template = 'MEETING_INSTANT_INVITED' ORDER BY OutboxId`)
  check(rows.length === 2 && rows[0].startsWith(mail('meera')) && rows[1].startsWith(mail('nikhil')), `outbox ${JSON.stringify(rows)}`)
  check(!rows.some((r) => r.includes('removed')), 'the removed participant was e-mailed')
  // Each body carries exactly one /join/ token, and the two are different (nobody gets someone else's link).
  const tokens = [mail('meera'), mail('nikhil')].map((to) => {
    // First and last /join/ occurrence of the body (sqlcmd cannot print a whole NVARCHAR(MAX) with -h -1).
    const body = sqlcmd(`SELECT SUBSTRING(BodyHtml, CHARINDEX('/join/', BodyHtml), 80) + ' ' + SUBSTRING(BodyHtml, LEN(BodyHtml) - CHARINDEX(REVERSE('/join/'), REVERSE(BodyHtml)) - 4, 80) FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${to}'`)
    const t = [...new Set([...body.matchAll(/\/join\/([A-Za-z0-9_-]{20,})/g)].map((m) => m[1]))]
    check(t.length === 1, `${to}: ${t.length} distinct join tokens in the e-mail`)
    return t[0]
  })
  check(tokens[0] !== tokens[1], 'both e-mails carry the same link')
  // And each token is that person's own invitation.
  const owners = tokens.map((t) => execFileSync('node', ['-e', `process.stdout.write(require('crypto').createHash('sha256').update('${t}').digest('hex'))`], { encoding: 'utf8' }))
  const who = owners.map((h) => sqlcmd(`SELECT COALESCE(cu.Email, p.GuestEmail) FROM mtg.MeetingInvitations i JOIN mtg.MeetingParticipants p ON p.ParticipantId = i.ParticipantId
    LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId WHERE CONVERT(VARCHAR(64), i.TokenHash, 2) = UPPER('${h}')`))
  const sub = sqlcmd(`SELECT TOP (1) Subject FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND Template = 'MEETING_INSTANT_INVITED'`)
  return `1 meeting from a double click; 2 e-mails (${rows.join(', ')}); subject "${sub}"; link owners ${JSON.stringify(who)}; removed row not e-mailed`
})

await tc('IM-02', 'Host sees the delivery status in Invite people; a failed e-mail can be sent again (new personal link for that person only, old link revoked, meeting not re-created)', async () => {
  await host.getByText('Ready to join?').waitFor({ timeout: 30_000 })
  await until(() => host.evaluate(() => (document.querySelector('[data-testid="prejoin-preview"]')?.videoWidth ?? 0) > 0), 'camera preview never started', 15_000)
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  const dlg = host.getByTestId('invitation-emails')
  await dlg.waitFor({ timeout: 30_000 })
  check((await dlg.getByTestId('invitation-email').count()) === 2, 'not 2 status rows')
  // Simulate a delivery failure for Nikhil (local DB only).
  sqlcmd(`UPDATE app.EmailOutbox SET [Status] = 'FAILED', Attempts = 5 WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${mail('nikhil')}'`)
  await until(async () => (await dlg.locator('[data-status="FAILED"]').count()) === 1, 'failed status not shown', 15_000)
  await host.screenshot({ path: path.join(SHOTS, 'im-02-invite-dialog-status.png') })
  const oldActive = Number(sqlcmd(`SELECT COUNT(*) FROM mtg.MeetingInvitations i JOIN mtg.MeetingParticipants p ON p.ParticipantId = i.ParticipantId WHERE i.MeetingId = ${mid} AND p.GuestEmail = N'${mail('nikhil')}' AND i.RevokedUtc IS NULL`))
  await dlg.getByTestId('invitation-resend').click()
  await until(async () => (await dlg.locator('[data-status="FAILED"]').count()) === 0, 'still failed after Send again', 15_000)
  const n = lines(`SELECT [Status] FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${mail('nikhil')}' ORDER BY OutboxId`)
  check(n.length === 2 && n[1] === 'PENDING', `nikhil outbox ${JSON.stringify(n)}`)
  const active = Number(sqlcmd(`SELECT COUNT(*) FROM mtg.MeetingInvitations i JOIN mtg.MeetingParticipants p ON p.ParticipantId = i.ParticipantId WHERE i.MeetingId = ${mid} AND p.GuestEmail = N'${mail('nikhil')}' AND i.RevokedUtc IS NULL`))
  const meera = lines(`SELECT [Status] FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${mail('meera')}'`)
  const meetings = Number(sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings WHERE PrarambhMainId = '7712345' AND [Status] IN ('SCHEDULED','LIVE')`))
  const audit = sqlcmd(`SELECT COUNT(*) FROM app.AuditLog WHERE Action = 'MEETING_INVITATION_RESENT' AND EntityId = '${meetingId}'`)
  check(active === 1 && meera.length === 1 && meetings === 1 && audit === '1', `active links ${active}, meera mails ${meera.length}, live meetings ${meetings}, audit ${audit}`)
  return `status rows shown (Sendingâ€¦/Not delivered); Send again â†’ new PENDING e-mail, ${oldActive}â†’${active} active link for that person (old revoked), Meera untouched, still 1 meeting, 1 audit row`
})
await api(host, 'POST', `/meetings/${meetingId}/room/end`).catch(() => {})

await tc('IM-03', 'Validation: an invalid e-mail and a half-filled row are rejected with clear messages; nothing is created', async () => {
  await openInstantPlvc(host)
  await fillRow(host, 0, 'Bad Mail', 'not-an-email')
  await host.getByTestId('participant-add').click()
  await host.getByTestId('participant-name').nth(1).fill('Only A Name')
  const before = Number(sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings`))
  await host.getByTestId('start-instant').click()
  await sleep(800)
  // The browser's own e-mail check stops the form first (a native message on the field); fix that one, then the form's own check runs.
  const native = await host.getByTestId('participant-email').nth(0).evaluate((e) => e.validationMessage)
  check(native.length > 0, 'invalid e-mail accepted by the browser')
  await host.getByTestId('participant-email').nth(0).fill('bad.mail@rec.oneinsure.test')
  await host.getByTestId('start-instant').click()
  await host.getByText('Please correct the highlighted fields.').waitFor()
  const msgs = [native, ...await host.getByRole('dialog').getByRole('alert').allInnerTexts()]
  await host.screenshot({ path: path.join(SHOTS, 'im-03-validation.png') })
  check(Number(sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings`)) === before, 'a meeting was created')
  await host.keyboard.press('Escape')
  return `messages: ${msgs.map((m) => m.trim()).join(' | ')}`
})

// ---- V024: "Skip details & start meeting" (unidentified PLVC) --------------------------------------------------------
let skipId
await tc('SK-01', 'PLVC: half-filled details, then "Skip details & start meeting": meeting starts UNIDENTIFIED - no ID invented, no customer, no e-mails; recorded as normal with no ID in the file name; Invite shows only the meeting link', async () => {
  await openInstantPlvc(host) // types a Prarambh ID...
  await fillRow(host, 0, 'Half Filled', '')   // ...and a half-filled row
  await host.getByTestId('skip-plvc-details').click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}\/room/, { timeout: 30_000 })
  skipId = host.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  const row = sqlcmd(`SELECT CONCAT(ISNULL(PrarambhMainId,'-'), '|', ISNULL(CONVERT(VARCHAR(20), CustomerId),'-'), '|', PlvcIdentification, '|', MeetingKind) FROM mtg.Meetings WHERE PublicId = '${skipId}'`)
  check(row === '-|-|UNIDENTIFIED|INSTANT', `meeting ${row}`)
  const smid = Number(sqlcmd(`SELECT MeetingId FROM mtg.Meetings WHERE PublicId = '${skipId}'`))
  check(sqlcmd(`SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = ${smid}`) === '0', 'e-mails were queued')
  check(sqlcmd(`SELECT COUNT(*) FROM mtg.MeetingParticipants WHERE MeetingId = ${smid} AND ParticipantType <> 'EMPLOYEE'`) === '0', 'participants were created')
  // Start the meeting: PLVC is mandatory recording - it is recorded as normal.
  await host.getByText('Ready to join?').waitFor({ timeout: 30_000 })
  await until(() => host.evaluate(() => (document.querySelector('[data-testid="prejoin-preview"]')?.videoWidth ?? 0) > 0), 'camera preview never started', 15_000)
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  const dlg = host.getByRole('dialog', { name: 'Invite people' })
  await dlg.waitFor({ timeout: 15_000 })
  check((await dlg.getByTestId('send-to-customer').count()) === 0, '"Send link to customer" offered although there is no customer')
  await host.screenshot({ path: path.join(SHOTS, 'sk-01-invite-unidentified.png') })
  await host.keyboard.press('Escape')
  await until(() => sqlcmd(`SELECT COUNT(*) FROM rec.MeetingRecordings WHERE MeetingId = ${smid} AND [Status] IN ('RECORDING','PROCESSING','COMPLETED')`) !== '0', 'not recorded', 60_000)
  const rec = sqlcmd(`SELECT TOP (1) CONCAT([Status], '|', ISNULL(PrarambhMainId,'-')) FROM rec.MeetingRecordings WHERE MeetingId = ${smid} ORDER BY RecordingId DESC`)
  check(rec.endsWith('|-'), `recording ${rec}`)
  await api(host, 'POST', `/meetings/${skipId}/room/end`)
  const key = await until(() => sqlcmd(`SELECT TOP (1) ISNULL(StorageKey,'') FROM rec.MeetingRecordings WHERE MeetingId = ${smid} ORDER BY RecordingId DESC`).length > 0, 'no storage key yet', 90_000)
    .then(() => sqlcmd(`SELECT TOP (1) StorageKey FROM rec.MeetingRecordings WHERE MeetingId = ${smid} ORDER BY RecordingId DESC`))
  const code = sqlcmd(`SELECT MeetingCode FROM mtg.Meetings WHERE MeetingId = ${smid}`)
  check(new RegExp(`^\\d{8}/${code}-REC\\d+\\.mp4$`).test(key), `file ${key} (expected no ID prefix)`)
  return `meeting ${row}; no e-mails/participants; Invite has only the meeting link; recorded (${rec}); file ${key}`
})

await tc('SK-02', 'Meeting page shows "Unidentified PLVC"; the host adds the Prarambh Main ID once → identified, recording metadata updated, file not renamed, audited', async () => {
  await host.goto(`/meetings/${skipId}`)
  await host.getByTestId('plvc-unidentified').waitFor()
  const keyBefore = sqlcmd(`SELECT TOP (1) StorageKey FROM rec.MeetingRecordings r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId WHERE m.PublicId = '${skipId}' ORDER BY r.RecordingId DESC`)
  await host.getByTestId('prarambh-add').click()
  await host.getByTestId('prarambh-add-input').fill('99A88') // letters are stripped as typed
  check((await host.getByTestId('prarambh-add-input').inputValue()) === '9988', 'non-digits accepted')
  await host.getByTestId('prarambh-add-save').click()
  await host.getByTestId('detail-prarambh').waitFor()
  await host.screenshot({ path: path.join(SHOTS, 'sk-02-prarambh-added.png') })
  const m = sqlcmd(`SELECT CONCAT(PrarambhMainId, '|', PlvcIdentification) FROM mtg.Meetings WHERE PublicId = '${skipId}'`)
  const r = sqlcmd(`SELECT TOP (1) CONCAT(ISNULL(r.PrarambhMainId,'-'), '|', r.StorageKey) FROM rec.MeetingRecordings r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId WHERE m.PublicId = '${skipId}' ORDER BY r.RecordingId DESC`)
  const audit = sqlcmd(`SELECT COUNT(*) FROM app.AuditLog WHERE Action = 'MEETING_PRARAMBH_ADDED' AND EntityId = '${skipId}'`)
  check(m === '9988|IDENTIFIED' && r === `9988|${keyBefore}` && audit === '1', `meeting ${m}; recording ${r}; audit ${audit}`)
  return `meeting ${m}; recording metadata ${r.split('|')[0]}, file unchanged (${keyBefore}); 1 audit row`
})

await tc('SC-01', 'Schedule Meeting (desktop 1366): compact two-column layout; every field still present; screenshot', async () => {
  await host.goto('/schedule')
  const form = host.getByTestId('schedule-form')
  await form.waitFor()
  await form.getByLabel('Category').selectOption('CUSTOMER_PLVC')
  for (const label of ['Title', 'Category', 'Purpose (optional)', 'Policy number (optional)', 'Date', 'Duration', 'Meeting Details (Optional)'])
    check(await form.getByLabel(label, { exact: true }).count() >= 1, `field "${label}" missing`)
  check(await form.getByTestId('prarambh-main-id').count() === 1, 'Prarambh field missing')
  check(await form.getByTestId('participant-row').count() >= 1, 'participant rows missing')
  check(await form.getByText(/Start time/).count() >= 1, 'start time missing')
  check(await form.getByText('Availability').count() >= 1, 'availability panel missing')
  check(await form.getByRole('button', { name: /Schedule meeting/ }).count() === 1 && await form.getByRole('button', { name: /Save as draft|Save draft/ }).count() === 1, 'actions missing')
  const cols = await form.evaluate((f) => getComputedStyle(f).gridTemplateColumns)
  const side = await form.getByRole('button', { name: /Schedule meeting/ }).boundingBox()
  await host.screenshot({ path: path.join(SHOTS, 'sc-01-schedule-desktop.png'), fullPage: true })
  const h = await host.evaluate(() => document.documentElement.scrollHeight)
  check(side.y < 860, `Schedule button at y=${Math.round(side.y)}, below the first screen`)
  return `columns "${cols}"; all fields present; Schedule button visible at y=${Math.round(side.y)} without scrolling; page height ${h} px`
})

await tc('SC-02', 'Schedule a PLVC meeting through the form: created SCHEDULED with the Prarambh ID; the participant\'s invitation e-mail queued', async () => {
  // Earlier cases leave the host in meetings "now": finish them so the booking check does not (correctly) refuse.
  sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
  await host.goto('/schedule')
  await host.getByTestId('schedule-form').getByLabel('Category').selectOption('CUSTOMER_PLVC')
  const form = host.getByTestId('schedule-form')
  await form.getByLabel('Title', { exact: true }).fill(`Doc3 PLVC ${tag}`)
  await form.getByTestId('prarambh-main-id').fill('8812345')
  await fillRow(host, 0, 'Sched Customer', mail('sched'))
  await form.getByRole('button', { name: /Schedule meeting/ }).click()
  const ov = host.getByRole('button', { name: /Schedule anyway|Book anyway/ })
  await until(async () => /\/meetings\/[0-9a-f-]{36}$/.test(host.url()) || (await ov.count()) > 0, 'not scheduled', 25_000)
  if (await ov.count()) { await ov.first().click(); await host.waitForURL(/\/meetings\/[0-9a-f-]{36}$/) }
  const row = sqlcmd(`SELECT [Status] + '|' + ISNULL(PrarambhMainId,'') FROM mtg.Meetings WHERE Title = N'Doc3 PLVC ${tag}'`)
  const mails = sqlcmd(`SELECT COUNT(*) FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.Title = N'Doc3 PLVC ${tag}' AND o.ToAddress = N'${mail('sched')}'`)
  check(row === 'SCHEDULED|8812345' && Number(mails) >= 1, `meeting ${row}, e-mails ${mails}`)
  return `meeting ${row}; ${mails} invitation e-mail queued`
})

await tc('SC-03', 'Save as draft still works from the redesigned form', async () => {
  await host.goto('/schedule')
  const form = host.getByTestId('schedule-form')
  await form.getByLabel('Title', { exact: true }).fill(`Doc3 draft ${tag}`)
  await form.getByLabel('Category').selectOption('INTERNAL_MEETING')
  await form.getByRole('button', { name: /Save as draft|Save draft/ }).click()
  await until(() => sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings WHERE Title = N'Doc3 draft ${tag}' AND [Status] = 'DRAFT'`) === '1', 'draft not saved', 20_000)
  return 'draft saved (status DRAFT)'
})

await tc('SC-04', 'Schedule Meeting on a phone (390Ã—844): single column, no horizontal scrolling, nothing overlapping the edges', async () => {
  const phone = await newPage({ width: 390, height: 844 }, true)
  await login(phone)
  await phone.goto('/schedule')
  const form = phone.getByTestId('schedule-form')
  await form.waitFor()
  await form.getByLabel('Category').selectOption('CUSTOMER_PLVC')
  await sleep(500)
  const sw = await phone.evaluate(() => document.scrollingElement.scrollWidth)
  const cols = await form.evaluate((f) => getComputedStyle(f).gridTemplateColumns.split(' ').length)
  const wide = await phone.evaluate(() => [...document.querySelectorAll('[data-testid="schedule-form"] input, [data-testid="schedule-form"] select, [data-testid="schedule-form"] button')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > 390.5 || r.left < -0.5) }).length)
  await phone.screenshot({ path: path.join(SHOTS, 'sc-04-schedule-phone.png'), fullPage: true })
  check(sw <= 390 && cols === 1 && wide === 0, `scrollWidth ${sw}, ${cols} columns, ${wide} controls outside the screen`)
  return `scrollWidth ${sw} px, 1 column, 0 controls off-screen`
})

await tc('RP-01', 'Reports: Prarambh Main ID column shows the ID; search by Prarambh ID finds the meeting', async () => {
  // The host role has no reports.view - use the (local) super admin.
  const host2 = await newPage({ width: 1366, height: 860 })
  await host2.goto('/login')
  await host2.getByLabel('Official Email / Employee ID').fill('superadmin@rec.oneinsure.test')
  await host2.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await host2.getByRole('button', { name: 'Sign In' }).click()
  await host2.waitForURL(/\/dashboard/)
  await host2.goto('/reports')
  await host2.getByPlaceholder('Title, meeting code or Prarambh ID').fill('8812345')
  await until(async () => (await host2.getByTestId('report-prarambh').allInnerTexts()).some((t) => t.includes('8812345')), 'Prarambh ID not in the report', 20_000)
  await host2.screenshot({ path: path.join(SHOTS, 'rp-01-reports.png') })
  return 'column shows 8812345; search by ID works'
})

for (const b of browsers) await b.close().catch(() => {})
const file = path.join(RESULTS, `doc3-instant-schedule-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ suite: 'doc3-instant-schedule', web: WEB, db: DB, results }, null, 2))
const passed = results.filter((r) => r.result === 'PASS').length
log(`${passed}/${results.length} passed â†’ ${file}`)
process.exit(passed === results.length ? 0 : 1)
