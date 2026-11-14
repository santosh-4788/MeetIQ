// GoodDay 13 Nov 2026 (evening):
//  #14218 "while scheduling, if Customer PLVC is selected, the following options should not be there" - the No recording / Optional /
//         Required choice on the Schedule page (PLVC recording is mandatory).
//  #14217 "Remove this" - "Choose between 2 and 52 occurrences" still shown under a valid value (2).
//  #14219 "during video call give the option to make someone else host" - the hand-over existed as an unlabelled crown icon, and only
//         for colleagues; now a labelled "Make host" + a hint explaining who can be host.
// Isolated environment ONLY.   Run:  cd tests\e2e; node recording\goodday-fixes-4.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'goodday-fixes-4')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
const RAVI = 'ravi.employee@rec.oneinsure.test'
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
  try { const actual = await fn(); results.push({ id, title, actual, result: 'PASS' }); log(`  PASS ${id}: ${actual ?? ''}`); return true }
  catch (e) {
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `${id}-fail-${i}.png`), fullPage: true }).catch(() => {})
    results.push({ id, title, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL' }); log(`  FAIL ${id}: ${e?.message ?? e}`); return false
  }
}
const check = (c, m) => { if (!c) throw new Error(m) }
async function until(fn, msg, ms = 25_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await fn()) return true } catch { /* retry */ } await sleep(300) }
  throw new Error(msg)
}
const browsers = []
async function signedIn(email, viewport = { width: 1366, height: 860 }) {
  const b = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  browsers.push(b)
  const p = await (await b.newContext({ baseURL: WEB, viewport, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })).newPage(); p.setDefaultTimeout(20_000)
  pages.push(p)
  await p.goto('/login')
  await p.getByLabel('Official Email / Employee ID').fill(email)
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await p.getByRole('button', { name: 'Sign In' }).click()
  await p.waitForURL(/\/dashboard/)
  return p
}
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
  const r = await fetch(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}, { method, url, body })

sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
const host = await signedIn(HOST)
const tag = Date.now().toString(36).slice(-5)

await tc('G4-01', '#14218 Schedule Meeting + Customer PLVC: no No recording / Optional / Required choice - "Recording starts automatically" instead; Internal still offers the choice; a scheduled PLVC meeting is stored REQUIRED', async () => {
  await host.goto('/schedule')
  const form = host.getByTestId('schedule-form')
  await form.getByLabel('Category').selectOption('CUSTOMER_PLVC')
  await host.getByTestId('schedule-recording-mandatory').waitFor()
  check((await form.locator('input[name="recordingPolicy"]').count()) === 0, 'recording choices still offered for PLVC')
  const text = await host.getByTestId('schedule-recording-mandatory').innerText()
  await host.getByTestId('schedule-recording-mandatory').scrollIntoViewIfNeeded()
  await host.screenshot({ path: path.join(SHOTS, 'g4-01-plvc-recording.png') })
  await form.getByLabel('Category').selectOption('INTERNAL_MEETING')
  await until(async () => (await form.locator('input[name="recordingPolicy"]').count()) === 3, 'internal meeting lost its recording choice', 5000)
  await form.getByLabel('Category').selectOption('CUSTOMER_PLVC')
  await form.getByLabel('Title', { exact: true }).fill(`G4 PLVC ${tag}`)
  await form.getByTestId('prarambh-main-id').fill('4411')
  await host.getByTestId('participant-name').nth(0).fill('G4 Customer')
  await host.getByTestId('participant-email').nth(0).fill(`g4.${tag}@rec.oneinsure.test`)
  await form.getByRole('button', { name: /Schedule meeting/ }).click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 25_000 })
  const pol = sqlcmd(`SELECT RecordingPolicy FROM mtg.Meetings WHERE Title = N'G4 PLVC ${tag}'`)
  check(pol === 'REQUIRED', `stored recording policy ${pol}`)
  return `PLVC shows: "${text.replace(/\s+/g, ' ').slice(0, 90)}…"; Internal shows 3 choices; scheduled PLVC stored ${pol}`
})

await tc('G4-02', '#14217 Repeat → After N occurrences: the "between 2 and 52" message disappears as soon as the value is valid', async () => {
  await host.goto('/schedule')
  const form = host.getByTestId('schedule-form')
  await form.getByLabel('Title', { exact: true }).fill(`G4 repeat ${tag}`)
  await form.getByLabel('Category').selectOption('INTERNAL_MEETING')
  await form.getByText('Repeat this meeting').click()
  const occ = host.getByTestId('occurrences')
  await occ.waitFor()
  await host.getByTestId('ends-after').check()
  const seen = []
  for (const [typed, expect] of [['99', '52'], ['1', '2'], ['', '2'], ['7', '7']]) {
    await occ.fill(typed)
    await occ.blur()
    const v = await occ.inputValue()
    seen.push(`${typed || '(empty)'}→${v}`)
    check(v === expect, `typed "${typed}" became "${v}" (expected ${expect})`)
    check((await form.getByText(/Choose between 2 and \d+ occurrences/).count()) === 0, `red message shown after typing "${typed}"`)
  }
  // GoodDay #14217 reopened again (14 Nov): the grey hint was removed too - nothing under the field.
  check((await form.getByText('Between 2 and 52').count()) === 0, 'range hint still shown')
  // "On date" keeps its choice (two updates in a row used to overwrite each other).
  await host.getByTestId('ends-on').check()
  check(await host.getByTestId('ends-on').isChecked(), '"On date" not kept')
  await host.getByTestId('ends-after').check()
  await occ.fill('3'); await occ.blur()
  // G4-01's booking makes the host busy now: finish it so this booking is not (correctly) refused as a clash.
  sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
  await occ.scrollIntoViewIfNeeded()
  await host.screenshot({ path: path.join(SHOTS, 'g4-02-occurrences.png') })
  await form.getByRole('button', { name: /Schedule recurring meeting|Schedule meeting/ }).click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 25_000 })
  const n = sqlcmd(`SELECT COUNT(*) FROM mtg.Meetings WHERE Title = N'G4 repeat ${tag}'`)
  check(n === '3', `${n} occurrences created (expected 3)`)
  return `${seen.join(', ')}; no red message or hint at any point; scheduled 3 occurrences`
})

await tc('G4-03', '#14219 In a call: the host sees a labelled "Make host" next to a colleague (not next to customers/guests); hand-over works', async () => {
  // G4-01/02 left the host booked "now": finish those so this booking is not (correctly) refused as a clash.
  sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
  const start = new Date(Date.now() + 60_000)
  const ravi = sqlcmd(`SELECT e.PublicId FROM org.Employees e JOIN auth.Users u ON u.EmployeeId = e.EmployeeId WHERE u.Email = N'${RAVI}'`)
  const created = await api(host, 'POST', '/meetings', { title: `G4 host ${tag}`, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 30 * 60_000).toISOString(),
    employeeIds: [ravi], status: 'SCHEDULED', waitingRoomEnabled: false, allowConflicts: true })
  check(created.status === 201, `create ${created.status}`)
  const id = created.body.id
  await host.goto(`/meetings/${id}/room`)
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  await host.getByTestId('ctl-people').click()
  // GoodDay #14226 (14 Nov): the hand-over note was removed at the tester's request - no note at all.
  await host.getByTestId('participant-list').waitFor()
  check((await host.getByTestId('host-transfer-hint').count()) === 0, 'hand-over note still shown')
  const r = await signedIn(RAVI)
  await r.goto(`/meetings/${id}/room`)
  await r.getByRole('button', { name: 'Join now' }).click()
  await r.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  const btn = host.locator(`[data-testid="participant"]:not(:has-text("(you)")) [data-testid="participant-make-host"]`)
  await btn.waitFor({ timeout: 20_000 })
  const label = (await btn.innerText()).trim()
  check(label === 'Make host', `button label "${label}"`)
  check((await host.getByTestId('host-transfer-hint').count()) === 0, 'hand-over note shown once a colleague joined')
  await host.screenshot({ path: path.join(SHOTS, 'g4-03-make-host.png') })
  await btn.click()
  await host.getByRole('dialog').getByRole('button', { name: 'Make host' }).click()
  await until(() => sqlcmd(`SELECT COUNT(*) FROM mtg.HostTransfers t JOIN mtg.Meetings m ON m.MeetingId = t.MeetingId WHERE m.PublicId = '${id}'`) === '1', 'no host transfer recorded', 15_000)
  await r.getByText('You are now the host.').waitFor({ timeout: 15_000 })
  await api(r, 'POST', `/meetings/${id}/room/end`)
  return `no hand-over note; "${label}" next to Ravi; hand-over recorded and Ravi told "You are now the host."`
})

await tc('G4-04', '#14220 Microphone blocked by the browser: ONE clear message with the steps to allow it (was 3 identical "could not be started")', async () => {
  sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
  // A browser where this site's camera and microphone are blocked (no fake-ui auto-allow, permissions not granted).
  const b = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1', args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'] })
  browsers.push(b)
  const p = await (await b.newContext({ baseURL: WEB, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })).newPage()
  pages.push(p); p.setDefaultTimeout(20_000)
  await p.goto('/login')
  await p.getByLabel('Official Email / Employee ID').fill(HOST)
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await p.getByRole('button', { name: 'Sign In' }).click()
  await p.waitForURL(/\/dashboard/)
  const created = await api(p, 'POST', '/meetings/instant', { category: 'GROUP', durationMinutes: 15 })
  check(created.status === 201, `instant ${created.status}`)
  await p.goto(`/meetings/${created.body.id}/room`)
  await p.getByRole('button', { name: 'Start meeting' }).click()
  await p.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  await p.keyboard.press('Escape').catch(() => {})
  await sleep(2500)
  await p.getByTestId('ctl-mic').click().catch(async () => p.locator('[aria-label*="microphone" i]').first().click())
  await sleep(2500)
  // GoodDay #14222 (14 Nov): a blocked device now opens ONE "Allow your microphone" dialog with the steps (no toast).
  const texts = await p.locator('[role="status"][aria-live="polite"] > *').allInnerTexts() // one entry per toast
  const mic = texts.filter((t) => /microphone/i.test(t))
  await p.screenshot({ path: path.join(SHOTS, 'g4-04-mic-blocked.png') })
  check(mic.length === 0, `microphone toast(s): ${JSON.stringify(mic)}`)
  const dialogs = p.getByTestId('device-help')
  check((await dialogs.count()) === 1, `${await dialogs.count()} device dialogs`)
  const text = await dialogs.innerText()
  check(/blocked the microphone/.test(text) && /Permissions/.test(text), `dialog: ${text}`)
  await api(p, 'POST', `/meetings/${created.body.id}/room/end`)
  return `one dialog: "${text.replace(/\s+/g, ' ').slice(0, 140)}…"`
})

for (const b of browsers) await b.close().catch(() => {})
const file = path.join(RESULTS, `goodday-fixes-4-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ suite: 'goodday-fixes-4', web: WEB, db: DB, results }, null, 2))
const passed = results.filter((r) => r.result === 'PASS').length
log(`${passed}/${results.length} passed → ${file}`)
process.exit(passed === results.length ? 0 : 1)
