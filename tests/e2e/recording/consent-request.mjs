// Recording consent requests (V020), end to end in real browsers (Microsoft Edge, headless, fake camera/microphone) with the REAL
// R2 recorder - the host manually starts recording during a live meeting and every participant (employees + a guest on a phone-sized
// screen) must accept before anything is recorded.
//
// Isolated environment ONLY (never production): database OneInsureVideoMeetingDB_Rec on LocalDB, API https://localhost:7192,
// web http://127.0.0.1:5176 (Vite proxy), an isolated LiveKit instance. Recorder processes are matched by their build path, so a
// production recorder on the same machine is never touched.
//
// Run:  cd tests\e2e; node recording\consent-request.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'consent')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FFPROBE = path.join(process.env.OIC_FFMPEG_DIR ?? 'C:/ffmpeg/bin', 'ffprobe.exe')
const LIBRARY = path.join(ROOT, 'recording/e2e/library')
const RECORDER_BUILD = path.join(ROOT, 'backend', 'src', 'OneInsure.Connect.Recorder', 'bin').toLowerCase()
const HEADLESS = process.env.E2E_HEADED !== '1'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const SUPER = 'superadmin@rec.oneinsure.test'
const HOST = { email: 'rekha.host@rec.oneinsure.test', name: 'Rekha Host' }
const RAVI = { email: 'ravi.employee@rec.oneinsure.test', name: 'Ravi Employee' }
const PRIYA = { email: 'priya.sharma@rec.oneinsure.test', name: 'Priya Sharma' }
const ARJUN = { email: 'arjun.mehta@rec.oneinsure.test', name: 'Arjun Mehta' }
const GUEST_NAME = 'Neha Guest'

if (!/_Rec$/.test(DB)) throw new Error('Only a database whose name ends in _Rec may be used.')
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Local web server only.')
fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function sql(select) {
  const out = execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-y', '0', '-Q',
    `SET NOCOUNT ON; SELECT (SELECT * FROM (${select.replace(/\s*\r?\n\s*/g, ' ')}) q FOR JSON PATH, INCLUDE_NULL_VALUES) AS j`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const lines = out.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('[') || l.trim() === 'NULL')
  const json = start < 0 ? '' : lines.slice(start).join('').trim()
  return !json || json === 'NULL' ? [] : JSON.parse(json)
}
const scalar = (select) => Object.values(sql(select)[0] ?? { v: null })[0]

class Api {
  jar = new Map()
  async req(method, p, body) {
    const headers = { Accept: 'application/json' }
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET' && this.jar.has('XSRF-TOKEN')) headers['X-XSRF-TOKEN'] = decodeURIComponent(this.jar.get('XSRF-TOKEN'))
    const r = await fetch(`${WEB}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(';')[0]
      const i = kv.indexOf('=')
      this.jar.set(kv.slice(0, i), kv.slice(i + 1))
    }
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { status: r.status, data }
  }
  async login(email) {
    await this.req('GET', '/health')
    const r = await this.req('POST', '/auth/login', { login: email, password: PASSWORD, rememberMe: false })
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.data)}`)
    return this
  }
}

const results = []
const metrics = {}
const pages = []
async function tc(id, title, expected, fn) {
  const t0 = Date.now()
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, expected, actual: actual ?? 'as expected', result: 'PASS', ms: Date.now() - t0 })
    log(`  PASS ${id}: ${actual ?? ''}`)
    return true
  } catch (e) {
    const shots = []
    for (const [i, p] of pages.entries()) {
      try {
        const f = path.join(SHOTS, `${id}-fail-${i}.png`)
        await p.screenshot({ path: f })
        shots.push(path.relative(HERE, f))
      } catch { /* closed */ }
    }
    results.push({ id, title, expected, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL', screenshots: shots, ms: Date.now() - t0 })
    log(`  FAIL ${id}: ${e?.message ?? e}`)
    return false
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
async function until(fn, msg, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {})

const CAM = path.join(RESULTS, 'fake-camera.y4m')
if (!fs.existsSync(CAM)) {
  fs.mkdirSync(RESULTS, { recursive: true })
  const W = 320, H = 240, F = 40
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < F; f++) {
    const y = Buffer.alloc(W * H), u = Buffer.alloc(W * H / 4, 110), v = Buffer.alloc(W * H / 4, 150)
    const bar = Math.floor((f * W) / F)
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) y[r * W + c] = Math.abs(c - bar) < 12 ? 235 : 60 + (((r >> 4) + (c >> 4)) % 2) * 40
    parts.push(Buffer.from('FRAME\n'), y, u, v)
  }
  fs.writeFileSync(CAM, Buffer.concat(parts))
}
const browsers = []
async function newPage(viewport = { width: 1366, height: 820 }, mobile = false) {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: HEADLESS,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  browsers.push(browser)
  const context = await browser.newContext({ baseURL: WEB, viewport, isMobile: mobile, hasTouch: mobile, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
  pages.push(page)
  return page
}
async function closePage(page) {
  const i = pages.indexOf(page)
  if (i >= 0) pages.splice(i, 1)
  await page.context().browser().close().catch(() => {})
}
async function loginUI(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}
async function preJoinAndEnter(page, buttonName) {
  await page.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: buttonName }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}
const popupVisible = (p) => p.locator('[data-testid="rec-consent-popup"]').isVisible().catch(() => false)
const memberStatuses = (host) => host.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="rec-consent-member"]')]
  .map((li) => [li.querySelector('span.truncate')?.childNodes[0]?.textContent?.trim(), li.getAttribute('data-status')])))
const recStatus = (p) => p.evaluate(() => document.querySelector('[data-testid="rec-indicator"]')?.getAttribute('data-status') ?? null)
/** Our test recorder processes only (by executable path) - never a production recorder on this machine. */
function testRecorderPids() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='OneInsure.Connect.Recorder.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"], { encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).filter(([, p]) => (p ?? '').toLowerCase().startsWith(RECORDER_BUILD)).map(([pid]) => Number(pid))
}
function ffprobe(file) {
  return JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height', '-of', 'json', file], { encoding: 'utf8' }))
}

// ---- Setup ---------------------------------------------------------------------------------------------------------------
execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q',
  "UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE') AND Title LIKE N'Consent E2E%'"])
const superApi = await new Api().login(SUPER)
const hostApi = await new Api().login(HOST.email)
const ok = {}
let meetingId, mid, linkPath
let host, ravi, priya, guest, arjun

async function createMeeting(title, invitees) {
  const ids = invitees.map((e) => scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE OfficialEmail = N'${e.email}'`))
  const start = new Date(Date.now() + 2 * 60_000)
  start.setSeconds(0, 0)
  const created = await hostApi.req('POST', '/meetings', {
    title, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 60 * 60_000).toISOString(),
    employeeIds: ids, status: 'SCHEDULED', recordingPolicy: 'OPTIONAL', waitingRoomEnabled: false,
  })
  check(created.status === 201, `meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
  return { id: created.data.id, mid: scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${created.data.id}'`) }
}
async function guestJoin(page, admitBy) {
  await page.goto(linkPath)
  await page.getByTestId('link-join').click()
  await page.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  const name = page.getByTestId('prejoin-name')
  if (await name.count()) await name.fill(GUEST_NAME)
  await page.getByRole('button', { name: /Ask to join|Join now/ }).click()
  // Link guests wait to be admitted by the host.
  const inRoom = page.locator('[data-testid="meeting-room"]')
  const waiting = page.getByTestId('waiting-room')
  await until(async () => (await inRoom.count()) || (await waiting.count()), 'guest neither waiting nor in the room', 25_000)
  if (!(await inRoom.count())) {
    await until(async () => (await admitBy.getByTestId('waiting-entry').filter({ hasText: GUEST_NAME }).count()) > 0 || (await admitBy.getByTestId('waiting-badge').count()) > 0, 'host never saw the waiting guest', 25_000)
    if (!(await admitBy.getByTestId('waiting-entry').filter({ hasText: GUEST_NAME }).count())) await admitBy.getByTestId('ctl-people').click()
    await admitBy.getByTestId('waiting-entry').filter({ hasText: GUEST_NAME }).getByTestId('waiting-admit').click()
    await inRoom.waitFor({ timeout: 25_000 })
    await admitBy.keyboard.press('Escape').catch(() => {})
  }
}

ok.policy = await tc('CR-00', 'Policy for team meetings: optional recording, consent required from everyone (approved wording NOT invented)', 'Admin API saves CONSENT_REQUIRED + consent from all; notice text stays the configured placeholder', async () => {
  const list = (await superApi.req('GET', '/admin/recording-policies')).data
  const p = list.items.find((x) => x.code === 'TRAINING_TEAM_MEETING')
  const r = await superApi.req('PUT', '/admin/recording-policies/TRAINING_TEAM_MEETING', {
    ...p, isEnabled: true, requirement: 'OPTIONAL', consentMode: 'CONSENT_REQUIRED', consentFromAll: true, stopOnWithdrawal: true,
    playbackRoles: ['SuperAdmin'], downloadRoles: ['SuperAdmin'], ownerCanPlay: true, ownerCanDownload: false,
  })
  check(r.status === 200, `PUT ${r.status} ${JSON.stringify(r.data)}`)
  const h = (await superApi.req('GET', '/admin/recording/health')).data
  check(h.available, `recorder not available: ${JSON.stringify(h.items.filter((i) => !i.ok))}`)
  return `policy saved (not confirmed, placeholder wording kept); recorder health OK`
})

ok.join = ok.policy && await tc('CR-01', 'Host + 2 employees join from the UI; a guest joins through the meeting link on a phone-sized screen', 'All four in the room; meeting LIVE; NO consent popup appears just because the meeting started (optional recording)', async () => {
  const m = await createMeeting(`Consent E2E ${new Date().toISOString().slice(11, 16)}`, [RAVI, PRIYA, ARJUN])
  meetingId = m.id
  mid = m.mid
  host = await newPage()
  await loginUI(host, HOST.email)
  await host.goto(`/meetings/${meetingId}/room`)
  await preJoinAndEnter(host, 'Start meeting')
  linkPath = (await hostApi.req('GET', `/meetings/${meetingId}/link`)).data.path
  check(linkPath?.startsWith('/m/'), `no meeting link: ${linkPath}`)
  ravi = await newPage()
  await loginUI(ravi, RAVI.email)
  await ravi.goto(`/meetings/${meetingId}/room`)
  await preJoinAndEnter(ravi, 'Join now')
  priya = await newPage()
  await loginUI(priya, PRIYA.email)
  await priya.goto(`/meetings/${meetingId}/room`)
  await preJoinAndEnter(priya, 'Join now')
  guest = await newPage({ width: 390, height: 844 }, true)
  await guestJoin(guest, host)
  await until(() => scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`) === 'LIVE', 'meeting not LIVE')
  await sleep(5000)
  for (const [n, p] of [['host', host], ['ravi', ravi], ['priya', priya], ['guest', guest]]) check(!(await popupVisible(p)), `consent popup shown to ${n} on meeting start`)
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.RecordingRequests WHERE MeetingId = ${mid}`)) === 0, 'a request exists before the host asked')
  return `meeting ${meetingId} LIVE with host, Ravi, Priya and guest "${GUEST_NAME}" (390 px); no popup on start`
})

ok.request = ok.join && await tc('CR-02', 'Host clicks Record → Request recording: every participant (employees AND the guest) gets the popup automatically', 'Popup on Ravi, Priya and the guest within seconds, not on the host; host panel shows Accepted (host) + Pending (others); nothing recorded; controls stay usable', async () => {
  await host.getByTestId('ctl-record').click()
  const label = await host.getByTestId('rec-start-confirm').innerText()
  check(/Request recording/.test(label), `start button says "${label}"`)
  await shot(host, 'cr02-host-start-dialog')
  const t0 = Date.now()
  await host.getByTestId('rec-start-confirm').click()
  const lat = {}
  await Promise.all([['ravi', ravi], ['priya', priya], ['guest', guest]].map(async ([n, p]) => {
    await p.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 20_000 })
    lat[n] = +((Date.now() - t0) / 1000).toFixed(1)
  }))
  metrics.popupSeconds = lat
  check(!(await popupVisible(host)), 'host (requester) got a popup')
  const title = await ravi.locator('[data-testid="rec-consent-popup"] h2').innerText()
  check(title === 'Recording Request', `popup title "${title}"`)
  const body = await ravi.locator('[data-testid="rec-consent-popup"]').innerText()
  check(body.includes('The host has requested to record this meeting.') && body.includes('Recording will begin only after all required participants have accepted.'), 'popup text missing')
  // The policy's configured wording, verbatim (13 Nov 2026: the owner-approved wording replaced the placeholder).
  const configured = scalar(`SELECT p.NoticeText AS v FROM rec.RecordingPolicies p JOIN rec.RecordingPolicyCategories c ON c.PolicyCode = p.PolicyCode JOIN mtg.Meetings m ON m.Category = c.Category WHERE m.MeetingId = ${mid}`)
  check(configured && body.includes(configured.trim()), 'the configured notice text is not shown verbatim')
  check(!body.includes('Notice version') && !body.includes('PLACEHOLDER'), 'participant sees internal version/placeholder text')
  await host.getByTestId('rec-consent-panel').waitFor()
  const st = await until(async () => { const s = await memberStatuses(host); return Object.keys(s).length === 4 && s }, 'host panel does not list 4 people')
  check(st[HOST.name] === 'GRANTED' && st[RAVI.name] === 'PENDING' && st[PRIYA.name] === 'PENDING' && st[GUEST_NAME] === 'PENDING', `statuses ${JSON.stringify(st)}`)
  check((await host.getByTestId('rec-consent-waiting').innerText()).includes('Waiting for all required participants to accept before recording can start.'), 'waiting message missing')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) === 0, 'a recording exists before consent')
  check(!(await recStatus(ravi)), 'REC indicator shown before consent')
  // The control bar is not covered: the microphone button is still the element under its own centre.
  const micFree = await ravi.evaluate(() => { const b = document.querySelector('[data-testid="ctl-mic"]'); if (!b) return 'no mic'; const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return b.contains(el) })
  check(micFree === true, `control bar covered by the popup (${micFree})`)
  await shot(ravi, 'cr02-popup-desktop')
  await shot(guest, 'cr02-popup-guest-390px')
  await shot(host, 'cr02-host-panel')
  const overflow = await guest.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(overflow <= 0, `guest page overflows horizontally by ${overflow}px`)
  return `popup after ${JSON.stringify(lat)} s; host panel ${JSON.stringify(st)}; no recording; mic button clickable; 390 px no overflow`
})

ok.dup = ok.request && await tc('CR-03', 'Duplicate Accept click', 'Buttons lock on the first click; one evidence row; confirmation shown, then the popup closes; host panel turns Accepted live', async () => {
  const before = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingConsent c JOIN mtg.MeetingParticipants p ON p.ParticipantId = c.ParticipantId JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE c.MeetingId = ${mid} AND e.OfficialEmail = N'${RAVI.email}'`))
  const btn = ravi.getByTestId('rec-accept')
  await btn.dblclick()
  await btn.click({ force: true, timeout: 1000 }).catch(() => {})
  await ravi.getByTestId('rec-consent-confirmed').waitFor({ timeout: 10_000 })
  await shot(ravi, 'cr03-confirmation')
  await ravi.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'hidden', timeout: 10_000 })
  const after = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingConsent c JOIN mtg.MeetingParticipants p ON p.ParticipantId = c.ParticipantId JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE c.MeetingId = ${mid} AND e.OfficialEmail = N'${RAVI.email}'`))
  check(after - before === 1, `${after - before} evidence rows for one answer`)
  const t0 = Date.now()
  await until(async () => (await memberStatuses(host))[RAVI.name] === 'GRANTED', 'host panel did not turn Accepted', 15_000)
  return `1 evidence row; confirmation shown; popup closed; host panel Accepted ${((Date.now() - t0) / 1000).toFixed(1)} s after the popup closed (no refresh)`
})

ok.net = ok.request && await tc('CR-04', 'Network interruption during consent submission', 'The failed submission shows an error, nothing is saved, the buttons work again; the retry succeeds', async () => {
  let aborted = 0
  await priya.route('**/recording/consent', async (route) => { aborted++; await route.abort('internetdisconnected') })
  await priya.getByTestId('rec-accept').click()
  await priya.getByTestId('rec-consent-error').waitFor({ timeout: 10_000 })
  await shot(priya, 'cr04-network-error')
  check(await priya.getByTestId('rec-accept').isEnabled(), 'Accept not re-enabled after the failure')
  check((await memberStatuses(host))[PRIYA.name] === 'PENDING', 'Priya counted as accepted although nothing was saved')
  await priya.unroute('**/recording/consent')
  await priya.getByTestId('rec-accept').click()
  await priya.getByTestId('rec-consent-confirmed').waitFor({ timeout: 10_000 })
  await until(async () => (await memberStatuses(host))[PRIYA.name] === 'GRANTED', 'host panel did not turn Accepted', 15_000)
  return `${aborted} request(s) cut off → error shown, still Pending on the host; retry → Accepted`
})

ok.pending = ok.net && await tc('CR-05', 'One participant (the guest) remains pending', 'Nothing is recorded while anyone is pending; host sees the waiting message', async () => {
  await sleep(6000)
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) === 0, 'recording started with a pending participant')
  const st = await memberStatuses(host)
  check(st[GUEST_NAME] === 'PENDING', `guest status ${st[GUEST_NAME]}`)
  check(await popupVisible(guest), 'guest popup disappeared')
  return `after 6 s: no recording; ${JSON.stringify(st)}`
})

ok.decline = ok.pending && await tc('CR-06', 'One participant declines → recording does not start; the request is cancelled and the host is told', 'Guest Decline → confirmation; host toast names the guest; panel closes; no recording; Record available again', async () => {
  await guest.getByTestId('rec-decline').click()
  await guest.getByTestId('rec-consent-confirmed').waitFor({ timeout: 10_000 })
  await shot(guest, 'cr06-guest-declined')
  await until(async () => /Neha Guest declined recording\. The recording request was cancelled\./.test(await host.locator('body').innerText()), 'host was not told', 15_000)
  await shot(host, 'cr06-host-toast')
  await host.getByTestId('rec-consent-panel').waitFor({ state: 'hidden', timeout: 10_000 })
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) === 0, 'recording exists after a decline')
  check(scalar(`SELECT TOP 1 [Status] AS v FROM rec.RecordingRequests WHERE MeetingId = ${mid} ORDER BY RequestId DESC`) === 'DECLINED', 'request not DECLINED')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'RECORDING_REQUEST_DECLINED' AND EntityId = '${meetingId}'`)) === 1, 'no audit row')
  await until(async () => (await host.getByTestId('ctl-record').getAttribute('title')) === 'Start recording' && await host.getByTestId('ctl-record').isEnabled(), 'Record not available again')
  return 'request DECLINED (audited); host toast "Neha Guest declined recording. The recording request was cancelled."; nothing recorded'
})

ok.again = ok.decline && await tc('CR-07', 'Host requests again: the person who declined is asked again; people who already accepted are not asked twice', 'Guest popup again; Ravi/Priya counted as Accepted from their consent; host panel live', async () => {
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').click()
  await guest.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 20_000 })
  const st = await until(async () => { const s = await memberStatuses(host); return s[GUEST_NAME] === 'PENDING' && s }, 'host panel not shown')
  check(st[RAVI.name] === 'GRANTED' && st[PRIYA.name] === 'GRANTED', `statuses ${JSON.stringify(st)}`)
  check(!(await popupVisible(ravi)) && !(await popupVisible(priya)), 'already-accepted participants were asked again')
  return `guest asked again; ${JSON.stringify(st)}`
})

ok.disconnect = ok.again && await tc('CR-08', 'Participant disconnects before responding', 'Host panel shows the guest as Disconnected (grey); recording does not start', async () => {
  await closePage(guest)
  guest = null
  await until(async () => (await memberStatuses(host))[GUEST_NAME] === 'DISCONNECTED', 'guest never shown as Disconnected', 40_000, 500)
  await shot(host, 'cr08-host-disconnected')
  await sleep(3000)
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) === 0, 'recording started with a disconnected participant')
  return 'guest shown as Disconnected; no recording'
})

ok.reconnect = ok.disconnect && await tc('CR-09', 'Participant reconnects while consent is pending', 'After rejoining, the pending request is shown again automatically; host panel back to Pending', async () => {
  guest = await newPage({ width: 390, height: 844 }, true)
  await guestJoin(guest, host)
  await guest.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 20_000 })
  // A link guest is anonymous: rejoining makes a NEW participant, so the old entry stays "Disconnected" (never accepted). The host
  // removes it (audited); the new entry is Pending.
  const guestRows = () => host.evaluate((n) => [...document.querySelectorAll('[data-testid="rec-consent-member"]')]
    .filter((li) => li.textContent.includes(n)).map((li) => li.getAttribute('data-status')).sort().join(','), GUEST_NAME)
  await until(async () => (await guestRows()) === 'DISCONNECTED,PENDING', 'host panel does not show old (Disconnected) + new (Pending) guest', 20_000)
  await shot(host, 'cr09-host-guest-rejoined')
  await host.locator('[data-testid="rec-consent-member"][data-status="DISCONNECTED"]').getByTestId('rec-consent-remove').click()
  await until(async () => (await guestRows()) === 'PENDING', 'stale entry not removed', 15_000)
  check(Number(scalar(`SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'RECORDING_REQUEST_MEMBER_REMOVED' AND EntityId = '${meetingId}'`)) === 1, 'removal not audited')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) === 0, 'recording started after the removal')
  return 'guest rejoined (new participant) → popup shown again, Pending; host removed the old Disconnected entry (audited); still nothing recorded'
})

ok.newcomer = ok.reconnect && await tc('CR-10', 'A new participant joins while consent is pending', 'Arjun gets the popup on joining and is added to the required set (host panel lists him as Pending)', async () => {
  arjun = await newPage()
  await loginUI(arjun, ARJUN.email)
  await arjun.goto(`/meetings/${meetingId}/room`)
  await preJoinAndEnter(arjun, 'Join now')
  await arjun.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 20_000 })
  await until(async () => (await memberStatuses(host))[ARJUN.name] === 'PENDING', 'Arjun not in the host panel', 20_000)
  const progress = await host.getByTestId('rec-consent-progress').innerText()
  check(/3 of 5 accepted/.test(progress), `progress "${progress}"`)
  await shot(arjun, 'cr10-newcomer-popup')
  // An employee reconnecting (page reload) keeps the same identity: asked again, not listed twice.
  await arjun.reload()
  await until(async () => (await arjun.getByText('Ready to join?').count()) || (await arjun.locator('[data-testid="meeting-room"]').count()), 'neither pre-join nor room after reload', 25_000)
  if (!(await arjun.locator('[data-testid="meeting-room"]').count())) await preJoinAndEnter(arjun, 'Join now')
  await arjun.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 25_000 })
  await until(async () => (await memberStatuses(host))[ARJUN.name] === 'PENDING', 'Arjun not Pending after reload', 25_000)
  const after = await host.getByTestId('rec-consent-progress').innerText()
  check(/3 of 5 accepted/.test(after), `progress after reload "${after}"`)
  return `Arjun asked on joining; host panel: ${progress}; after a page reload he is asked again and listed once (${after})`
})

let recId
ok.start = ok.newcomer && await tc('CR-11', 'Everyone accepts → the existing R2 recorder starts; REC only after it confirms capture', 'Request STARTED; indicator "Starting recording…" first; REC exactly when the DB says RECORDING; all five see REC', async () => {
  await arjun.getByTestId('rec-accept').click()
  await arjun.getByTestId('rec-consent-confirmed').waitFor()
  const t0 = Date.now()
  await guest.getByTestId('rec-accept').click()
  await until(() => Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) > 0, 'recording not created after the last acceptance', 15_000)
  recId = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)
  check(scalar(`SELECT TOP 1 [Status] AS v FROM rec.RecordingRequests WHERE MeetingId = ${mid} ORDER BY RequestId DESC`) === 'STARTED', 'request not STARTED')
  // REC must never be shown while the recorder has not confirmed capture.
  const seen = new Set()
  let falseRec = 0
  await until(async () => {
    const s = await recStatus(host)
    if (s) seen.add(s)
    if (s === 'RECORDING') {
      const db = scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)
      if (db !== 'RECORDING') falseRec++
      return true
    }
    return false
  }, 'REC never shown', 120_000, 200)
  metrics.lastAcceptToRecSeconds = +((Date.now() - t0) / 1000).toFixed(1)
  check(falseRec === 0, 'REC shown before the recorder confirmed capture')
  for (const p of [ravi, priya, guest, arjun]) await until(async () => (await recStatus(p)) === 'RECORDING', 'REC not shown to a participant', 30_000)
  await shot(host, 'cr11-host-rec')
  await shot(guest, 'cr11-guest-rec-390px')
  const audit = scalar(`SELECT TOP 1 Summary AS v FROM app.AuditLog WHERE [Action] = 'RECORDING_STARTED' AND EntityId = '${recId}'`)
  return `indicator states seen on host: ${[...seen].join(' → ')}; REC ${metrics.lastAcceptToRecSeconds} s after the last acceptance; audit: "${audit}"`
})

ok.mp4 = ok.start && await tc('CR-12', 'Actual MP4 recording and playback', 'Record ~20 s; host stops; COMPLETED; file probed independently (H.264/AAC); signed play URL streams', async () => {
  await sleep(20_000)
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-stop-confirm').click()
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'COMPLETED', 'recording not COMPLETED', 240_000, 1000)
  const r = sql(`SELECT StorageKey, DurationSeconds, FileSizeBytes FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)[0]
  const file = path.join(LIBRARY, r.StorageKey)
  const probe = ffprobe(file)
  const v = probe.streams.find((s) => s.codec_type === 'video')
  const a = probe.streams.find((s) => s.codec_type === 'audio')
  check(v?.codec_name === 'h264' && a?.codec_name === 'aac', `codecs ${JSON.stringify(probe.streams)}`)
  const dur = Number(probe.format.duration)
  check(dur >= 15, `duration ${dur}`)
  const play = await hostApi.req('POST', `/recordings/${recId}/play`)
  check(play.status === 200, `play ${play.status}`)
  const range = await host.evaluate(async (url) => { const x = await fetch(url, { headers: { Range: 'bytes=0-1023' } }); return { s: x.status, t: x.headers.get('content-type'), n: (await x.arrayBuffer()).byteLength } }, play.data.url)
  check(range.s === 206 && range.t === 'video/mp4' && range.n === 1024, `media ${JSON.stringify(range)}`)
  for (const p of [host, ravi]) check((await recStatus(p)) === null, 'REC still shown after stop')
  return `COMPLETED: ${r.DurationSeconds} s, ${(r.FileSizeBytes / 1048576).toFixed(2)} MB, ${v.codec_name}/${a.codec_name} ${v.width}x${v.height}, ffprobe ${dur.toFixed(1)} s; play URL → 206 video/mp4`
})

ok.fail = ok.mp4 && await tc('CR-13', 'R2 recorder startup failure', 'Recorder process killed before it confirms capture → recording FAILED; host gets a meaningful error; REC is never shown', async () => {
  // Everyone already accepted in this meeting, so Start goes straight to the recorder (no new request).
  // A single crash is healed by design (the worker relaunches the recorder), so a recorder that CANNOT start is simulated by
  // killing every launch, before it confirms capture, until the launch limit is used up.
  const seen = new Set(testRecorderPids())
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').click()
  const rid = await until(() => scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} AND PublicId <> '${recId}' ORDER BY RecordingId DESC`), 'no recording row')
  const killed = []
  let sawRec = false
  await until(async () => {
    for (const p of testRecorderPids().filter((x) => !seen.has(x))) {
      seen.add(p)
      try { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' }); killed.push(p) } catch { /* already gone */ }
    }
    if ((await recStatus(host)) === 'RECORDING') sawRec = true
    return scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${rid}'`) === 'FAILED'
  }, 'recording did not fail', 180_000, 100)
  check(!sawRec, 'REC shown although the recorder never confirmed capture')
  check(scalar(`SELECT StartedUtc AS v FROM rec.MeetingRecordings WHERE PublicId = '${rid}'`) === null, 'recording has a start time although capture never started')
  const toast = await until(async () => { const t = await host.locator('body').innerText(); return /Recording could not be started/.test(t) && t.match(/Recording could not be started[^\n]*/)[0] }, 'host not told', 20_000)
  const reason = scalar(`SELECT FailureReason AS v FROM rec.MeetingRecordings WHERE PublicId = '${rid}'`)
  await shot(host, 'cr13-host-start-failure')
  return `${killed.length} recorder launch(es) killed before capture → FAILED ("${reason}"); host: "${toast}"; REC never shown`
})

if (meetingId) {
  const end = await hostApi.req('POST', `/meetings/${meetingId}/room/end`)
  log(`  first meeting ended: HTTP ${end.status}; open requests left: ${scalar(`SELECT COUNT(*) AS v FROM rec.RecordingRequests WHERE MeetingId = ${mid} AND [Status] = 'OPEN'`)}`)
}
for (const p of [arjun, guest, priya, ravi, host]) if (p) await closePage(p).catch(() => {})

ok.one = await tc('CR-14', 'Host + one participant', 'Request → the participant accepts → recording starts and is verified', async () => {
  const m = await createMeeting(`Consent E2E 1:1 ${new Date().toISOString().slice(11, 16)}`, [RAVI])
  host = await newPage()
  await loginUI(host, HOST.email)
  await host.goto(`/meetings/${m.id}/room`)
  await preJoinAndEnter(host, 'Start meeting')
  ravi = await newPage()
  await loginUI(ravi, RAVI.email)
  await ravi.goto(`/meetings/${m.id}/room`)
  await preJoinAndEnter(ravi, 'Join now')
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').click()
  await ravi.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 20_000 })
  await ravi.getByTestId('rec-accept').click()
  await until(async () => (await recStatus(host)) === 'RECORDING' && (await recStatus(ravi)) === 'RECORDING', 'REC not shown', 120_000, 300)
  const rid = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${m.mid} ORDER BY RecordingId DESC`)
  await sleep(8000)
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-stop-confirm').click()
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${rid}'`) === 'COMPLETED', 'not COMPLETED', 240_000, 1000)
  const r = sql(`SELECT DurationSeconds FROM rec.MeetingRecordings WHERE PublicId = '${rid}'`)[0]
  await closePage(ravi)
  await closePage(host)
  return `request → accepted → REC → COMPLETED (${r.DurationSeconds} s)`
})

for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const out = path.join(RESULTS, `consent-request-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), web: WEB, db: DB, metrics, results }, null, 2))
log(`${passed}/${results.length} passed · metrics ${JSON.stringify(metrics)} · ${out}`)
process.exit(passed === results.length ? 0 : 1)
