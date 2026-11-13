// Instant meeting → Customer PLVC, end to end in Microsoft Edge (headless, fake camera) with the REAL R2 recorder (V021).
// The host starts an instant PLVC call for a customer from the dashboard; the customer joins through their personal link; recording starts
// automatically and nobody is asked to accept (notification only: notice banner + REC). Customer-general and internal types are offered too.
//
// Isolated environment ONLY (never production): LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192, web http://127.0.0.1:5176,
// isolated LiveKit. Run:  cd tests\e2e; node recording\instant-plvc.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'instant-plvc')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FFPROBE = path.join(process.env.OIC_FFMPEG_DIR ?? 'C:/ffmpeg/bin', 'ffprobe.exe')
const LIBRARY = path.join(ROOT, 'recording/e2e/library')
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
const CUSTOMER = 'Kavita Customer'

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
async function newPage(viewport = { width: 1366, height: 820 }, mobile = false) {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`, '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  browsers.push(browser)
  const ctx = await browser.newContext({ baseURL: WEB, viewport, isMobile: mobile, hasTouch: mobile, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
  pages.push(page)
  return page
}
const recStatus = (p) => p.evaluate(() => document.querySelector('[data-testid="rec-indicator"]')?.getAttribute('data-status') ?? null)

// ---- Setup: a customer in the local test database ---------------------------------------------------------------------
exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)
exec(`IF NOT EXISTS (SELECT 1 FROM crm.Customers WHERE CustomerRef = 'KC-PLVC-01') INSERT crm.Customers (CustomerRef, FullName, Email, PolicyNumber) VALUES ('KC-PLVC-01', N'${CUSTOMER}', 'kavita.customer@rec.oneinsure.test', 'POL-PLVC-77')`)

let host, customer, meetingId, mid, customerUrl, recId

const ok1 = await tc('IP-01', 'Dashboard button is "Instant meeting"; the dialog offers internal AND customer types (PLVC, general)', async () => {
  host = await newPage()
  await host.goto('/login')
  await host.getByLabel('Official Email / Employee ID').fill(HOST)
  await host.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await host.getByRole('button', { name: 'Sign In' }).click()
  await host.waitForURL(/\/dashboard/, { timeout: 20_000 })
  const label = (await host.getByTestId('new-meeting').innerText()).trim()
  check(label === 'Instant meeting', `button says "${label}"`)
  await shot(host, 'ip01-dashboard-button')
  await host.getByTestId('new-meeting').click()
  await host.getByRole('dialog').getByText('Start an instant meeting').waitFor()
  const groups = await host.getByTestId('instant-type').evaluate((s) => [...s.querySelectorAll('optgroup')].map((g) => `${g.label}: ${[...g.querySelectorAll('option')].map((o) => o.value).join(',')}`))
  check(groups.some((g) => g.startsWith('Customer:') && g.includes('CUSTOMER_PLVC') && g.includes('CUSTOMER_GENERAL')), `types ${JSON.stringify(groups)}`)
  check(groups.some((g) => g.startsWith('Internal:')), 'internal types missing')
  return `button "${label}"; types ${groups.join(' | ')}`
})

const ok2 = ok1 && await tc('IP-02', 'Choosing PLVC: customer required; recording shown as starting automatically, no acceptance needed', async () => {
  await host.getByTestId('instant-type').selectOption('CUSTOMER_PLVC')
  const note = await host.getByTestId('instant-recording-mandatory').innerText()
  check(/Recording starts automatically/.test(note) && /no acceptance is needed/.test(note), `recording note "${note}"`)
  check(!(await host.locator('input[name="instant-recording"]').count()), 'NONE/OPTIONAL choices still offered for PLVC')
  await host.getByTestId('start-instant').click()
  await host.getByText('Select the customer for a customer meeting.').waitFor()
  await host.getByRole('combobox', { name: 'Customer' }).fill('Kavita')
  await host.getByRole('option', { name: new RegExp(CUSTOMER) }).click()
  await shot(host, 'ip02-instant-plvc-dialog')
  // Customer general: also offered; it keeps its own policy (consent required).
  await host.getByTestId('instant-type').selectOption('CUSTOMER_GENERAL')
  const general = await host.getByTestId('instant-recording-mandatory').innerText()
  check(/accept the recording notice/.test(general), `general note "${general}"`)
  await host.getByTestId('instant-type').selectOption('CUSTOMER_PLVC')
  return `PLVC: "${note.replace(/\s+/g, ' ')}"; general: consent still required`
})

const ok3 = ok2 && await tc('IP-03', 'Start the instant PLVC call; the Invite dialog shows the customer\'s personal link', async () => {
  // The customer may have been cleared by the type switch only if it was not a customer type; re-pick if needed.
  if (!(await host.getByRole('button', { name: `Remove ${CUSTOMER}` }).count())) {
    await host.getByRole('combobox', { name: 'Customer' }).fill('Kavita')
    await host.getByRole('option', { name: new RegExp(CUSTOMER) }).click()
  }
  await host.getByTestId('start-instant').click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}\/room/)
  meetingId = host.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  await host.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  await host.getByTestId('customer-link').waitFor({ timeout: 15_000 })
  customerUrl = await host.getByTestId('customer-link-url').inputValue()
  check(/\/join\/[A-Za-z0-9_-]{20,}$/.test(customerUrl), `customer link "${customerUrl}"`)
  await shot(host, 'ip03-invite-customer-link')
  await host.keyboard.press('Escape')
  const m = sql(`SELECT MeetingId, Category, MeetingKind, RecordingPolicy, PolicyNumber FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)[0]
  mid = m.MeetingId
  check(m.Category === 'CUSTOMER_PLVC' && m.MeetingKind === 'INSTANT' && m.RecordingPolicy === 'REQUIRED' && m.PolicyNumber === 'POL-PLVC-77', `meeting ${JSON.stringify(m)}`)
  return `instant PLVC meeting ${meetingId}; customer link ${customerUrl.replace(/\/join\/.+/, '/join/…')}`
})

const ok4 = ok3 && await tc('IP-04', 'Recording starts automatically; REC only after the recorder confirms; nobody is asked to accept', async () => {
  const seen = new Set()
  await until(async () => { const s = await recStatus(host); if (s) seen.add(s); return s === 'RECORDING' }, 'REC never shown on the host', 120_000, 300)
  recId = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)
  check(scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'RECORDING', 'REC shown before the DB says RECORDING')
  check(!(await host.locator('[data-testid="rec-consent-popup"]').count()), 'host was asked to accept')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.RecordingRequests WHERE MeetingId = ${mid}`)) === 0, 'a consent request was opened')
  const audit = scalar(`SELECT TOP 1 Summary AS v FROM app.AuditLog WHERE [Action] = 'RECORDING_STARTED' AND EntityId = '${recId}'`)
  await shot(host, 'ip04-host-rec')
  return `host indicator ${[...seen].join(' → ')}; audit "${audit}"; no consent request`
})

const ok5 = ok4 && await tc('IP-05', 'The customer joins through their personal link (phone width): notice banner + REC, no Accept/Decline popup', async () => {
  customer = await newPage({ width: 390, height: 844 }, true)
  await customer.goto(new URL(customerUrl).pathname)
  // The personal link opens the invitation page (meeting, organiser, "Live now") first.
  await customer.getByRole('button', { name: 'Join meeting' }).click({ timeout: 20_000 })
  await customer.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await customer.getByRole('button', { name: /Join now|Ask to join/ }).click()
  const inRoom = customer.locator('[data-testid="meeting-room"]')
  await until(async () => (await inRoom.count()) || (await customer.getByTestId('waiting-room').count()), 'customer neither waiting nor in the room', 25_000)
  if (!(await inRoom.count())) {
    await until(async () => (await host.getByTestId('waiting-entry').count()) > 0 || (await host.getByTestId('waiting-badge').count()) > 0, 'host never saw the waiting customer', 25_000)
    if (!(await host.getByTestId('waiting-entry').count())) await host.getByTestId('ctl-people').click()
    await host.getByTestId('waiting-entry').first().getByTestId('waiting-admit').click()
    await inRoom.waitFor({ timeout: 25_000 })
  }
  await until(async () => (await recStatus(customer)) === 'RECORDING', 'customer does not see REC', 30_000)
  await customer.getByTestId('rec-notice-banner').waitFor({ timeout: 15_000 })
  await sleep(3000)
  check(!(await customer.locator('[data-testid="rec-consent-popup"]').count()), 'customer was asked to accept')
  const ack = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingConsent c JOIN mtg.MeetingParticipants p ON p.ParticipantId = c.ParticipantId WHERE c.MeetingId = ${mid} AND p.ParticipantType = 'CUSTOMER' AND c.Decision = 'GRANTED'`))
  check(scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'RECORDING', 'recording stopped when the customer joined')
  await shot(customer, 'ip05-customer-banner-rec-390px')
  return `customer (CUSTOMER participant via personal link) sees REC and the notice banner; no popup; notice acknowledgement stored automatically: ${ack} row(s)`
})

ok5 && await tc('IP-06', 'End the call → MP4 verified (H.264/AAC) in the library', async () => {
  await sleep(10_000)
  const end = await host.evaluate(async (id) => {
    const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
    return (await fetch(`/api/v1/meetings/${id}/room/end`, { method: 'POST', headers: { 'X-XSRF-TOKEN': xsrf } })).status
  }, meetingId)
  check(end === 204, `end ${end}`)
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'COMPLETED', 'not COMPLETED', 240_000, 1000)
  const r = sql(`SELECT StorageKey, DurationSeconds FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)[0]
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type', '-of', 'json', path.join(LIBRARY, r.StorageKey)], { encoding: 'utf8' }))
  const codecs = probe.streams.map((s) => s.codec_name).join('/')
  check(codecs.includes('h264') && codecs.includes('aac'), `codecs ${codecs}`)
  return `COMPLETED ${r.DurationSeconds} s, ${codecs}, ffprobe ${Number(probe.format.duration).toFixed(1)} s`
})

for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const out = path.join(RESULTS, `instant-plvc-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), results }, null, 2))
log(`${passed}/${results.length} passed · ${out}`)
process.exit(passed === results.length ? 0 : 1)
