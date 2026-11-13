// Live verification of the Nov 2026 recording / session fixes against a DEPLOYED OneInsure Connect (default https://www.oneinsure.com/meet).
//
// Uses three disposable QA accounts (host, peer = Employee role; admin = Admin role) whose shared password is read from a JSON file
// (LIVE_SECRET = {"password": "...", "host": "...", "peer": "...", "admin": "..."}) - never from this repository - and a SQL helper
// (LIVE_SQL = path to a PowerShell script that prints `SELECT ... FOR JSON` results) for server-side evidence. Real browsers
// (headless Edge, fake camera/microphone), real LiveKit, the real R2 recorder and FFmpeg.
//
// Run: $env:LIVE_SECRET='...\qa-secret.json'; $env:LIVE_SQL='...\qjson.ps1'; node live\live-verify.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'results')
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const WEB = (process.env.LIVE_WEB ?? 'https://www.oneinsure.com/meet').replace(/\/$/, '')
const API = `${new URL(WEB).pathname.replace(/\/$/, '')}/api/v1` // same-origin path used inside the pages
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FFPROBE = process.env.LIVE_FFPROBE ?? 'C:/ffmpeg/bin/ffprobe.exe'
const LIBRARY = process.env.LIVE_LIBRARY ?? 'E:/Beeinsured.com/MeetIQ/deploy/data/recordings'
const SECRET = JSON.parse(fs.readFileSync(process.env.LIVE_SECRET, 'utf8').replace(/^\uFEFF/, ''))
const RECORD_SECONDS = +(process.env.LIVE_REC_SECONDS ?? 20)
const ONLY = (process.env.LIVE_ONLY ?? '').split(',').filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sql = (select) => JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', process.env.LIVE_SQL, select.replace(/\s*\r?\n\s*/g, ' ')], { encoding: 'utf8' }).trim() || '[]')
const scalar = (select) => Object.values(sql(select)[0] ?? { v: null })[0]
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
async function until(fn, msg, ms = 20_000, every = 500) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

const results = []
const metrics = {}
const pages = []
async function tc(id, title, fn) {
  if (ONLY.length && !ONLY.includes(id)) return true
  const t0 = Date.now()
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, result: 'PASSED', evidence: actual ?? '', ms: Date.now() - t0 })
    log(`  PASSED ${id}: ${actual ?? ''}`)
    return true
  } catch (e) {
    const shots = []
    for (const [i, p] of pages.entries()) {
      const f = path.join(SHOTS, `${id}-fail-${i}.png`)
      try { await p.screenshot({ path: f }); shots.push(path.relative(HERE, f)) } catch { /* closed */ }
    }
    results.push({ id, title, result: 'FAILED', evidence: String(e?.message ?? e).slice(0, 1500), screenshots: shots, ms: Date.now() - t0 })
    log(`  FAILED ${id}: ${e?.message ?? e}`)
    return false
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {})

// Fake camera clip (moving bar) so the recorder has real video to compose.
const CAM = path.join(OUT, 'fake-camera.y4m')
if (!fs.existsSync(CAM)) {
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
async function newPage() {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  browsers.push(browser)
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (e) => log(`  [pageerror ${pages.indexOf(page)}] ${e.message}`))
  pages.push(page)
  return page
}

async function login(page, email) {
  await page.goto(`${WEB}/login`)
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(SECRET.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 })
}

/** Same-origin API call from inside the page (session cookie + XSRF header, exactly like the SPA). */
const api = (page, method, p, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1]
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf)
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' })
  const text = await r.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: r.status, data, contentType: r.headers.get('content-type') }
}, { method, url: `${API}${p}`, body })

async function enterRoom(page, meetingId, button) {
  await page.goto(`${WEB}/meetings/${meetingId}/room`)
  await page.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await until(() => page.evaluate(() => (document.querySelector('[data-testid="prejoin-preview"]')?.videoWidth ?? 0) > 0), 'camera preview never started', 20_000)
  await page.getByRole('button', { name: button }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}
const recStatus = (page) => page.evaluate(() => document.querySelector('[data-testid="rec-indicator"]')?.getAttribute('data-status') ?? null)

async function createMeeting(page, title, peerEmployeeId) {
  const start = new Date(Date.now() + 2 * 60_000)
  start.setSeconds(0, 0)
  const r = await api(page, 'POST', '/meetings', {
    title, category: 'GROUP', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 60 * 60_000).toISOString(),
    employeeIds: [peerEmployeeId], status: 'SCHEDULED', recordingPolicy: 'OPTIONAL', waitingRoomEnabled: false,
  })
  check(r.status === 201, `meeting not created: ${r.status} ${JSON.stringify(r.data)}`)
  return r.data.id
}

// ---- Scenario -------------------------------------------------------------------------------------------------------------
const peerEmp = scalar("SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'QA-BUGFIX-PEER'").toLowerCase()
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
let host, peer, meetingId, mid, rec1, rec2

const okJoin = await tc('L-01', 'Host and peer sign in; host creates an internal (Group) meeting; both join from the UI', async () => {
  host = await newPage()
  peer = await newPage()
  await login(host, SECRET.host)
  await login(peer, SECRET.peer)
  meetingId = await createMeeting(host, `QA bug-fix verification ${stamp}`, peerEmp)
  mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
  await enterRoom(host, meetingId, 'Start meeting')
  await enterRoom(peer, meetingId, 'Join now')
  await until(() => scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`) === 'LIVE', 'meeting not LIVE')
  await shot(host, 'L-01-host-in-room')
  return `meeting ${meetingId} LIVE, both in the room`
})

const okConsent = okJoin && await tc('L-02', 'Host presses Record: the participant whose consent is missing is ASKED (no dead end); after Accept the host can start', async () => {
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').waitFor()
  await shot(host, 'L-02a-start-dialog-waiting')
  await host.getByTestId('rec-start-confirm').click() // refused (consent missing) -> server asks the peer
  await peer.getByTestId('rec-accept').waitFor({ timeout: 15_000 })
  await shot(peer, 'L-02b-peer-asked-for-consent')
  const notice = await peer.getByTestId('rec-notice-text').innerText()
  await peer.getByTestId('rec-accept').click()
  await until(() => host.getByText(/Consent given by everyone required/).isVisible(), 'host dialog never turned ready after the peer accepted', 15_000)
  await shot(host, 'L-02c-start-dialog-ready')
  const rows = scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingConsent WHERE MeetingId = ${mid} AND Decision = 'GRANTED' AND EvidenceHash IS NOT NULL`)
  return `peer was asked automatically and accepted; host dialog turned ready; ${rows} GRANTED consent rows with evidence hash; notice shown: "${notice.slice(0, 60)}…"`
})

const okStart = okConsent && await tc('L-03', 'Recording starts; REC appears only after the recorder confirms capture; start-up time measured', async () => {
  const t0 = Date.now()
  await host.getByTestId('rec-start-confirm').click()
  // Before capture is confirmed the indicator must say "Starting", never REC.
  const early = await until(() => recStatus(host), 'no indicator at all', 10_000, 100)
  check(early === 'PENDING' || early === 'RECORDING', `unexpected first indicator state ${early}`)
  rec1 = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`).toLowerCase()
  await until(async () => (await recStatus(host)) === 'RECORDING', 'host REC never shown', 60_000, 100)
  const uiSeconds = (Date.now() - t0) / 1000
  await until(async () => (await recStatus(peer)) === 'RECORDING', 'peer REC never shown', 15_000, 200)
  const dbStatusAtRec = scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec1}'`)
  check(dbStatusAtRec === 'RECORDING', `REC shown while the database says ${dbStatusAtRec}`)
  const audit = sql(`SELECT TOP 1 JSON_VALUE(NewValuesJson, '$.startupSeconds') AS s FROM app.AuditLog WHERE [Action] = 'RECORDING_CAPTURE_STARTED' AND EntityId = '${rec1}'`)[0]
  metrics.startUiSeconds = +uiSeconds.toFixed(1)
  metrics.startServerSeconds = +audit?.s
  await shot(host, 'L-03-rec-indicator-host')
  await shot(peer, 'L-03-rec-indicator-peer')
  return `first indicator "${early}" → REC on host after ${uiSeconds.toFixed(1)} s (click → REC); server-measured start request → capture confirmed ${audit?.s} s; peer sees REC`
})

const okStop = okStart && await tc('L-04', `Record ~${RECORD_SECONDS}s, host stops with confirmation; REC clears without leaving; meeting continues`, async () => {
  await sleep(RECORD_SECONDS * 1000)
  await host.getByTestId('ctl-record').click()
  const title = await host.getByRole('dialog').getByText('Are you sure you want to stop recording?').isVisible()
  check(title, 'stop confirmation text missing')
  const t0 = Date.now()
  await host.getByTestId('rec-stop-confirm').click()
  const afterClick = await until(async () => (await recStatus(host)) !== 'RECORDING' ? (await recStatus(host)) ?? 'OFF' : null, 'indicator still REC after stop', 10_000, 100)
  const firstChange = (Date.now() - t0) / 1000
  await until(async () => (await recStatus(host)) === null, 'indicator never cleared', 60_000, 200)
  const cleared = (Date.now() - t0) / 1000
  await until(async () => (await recStatus(peer)) === null, 'peer indicator never cleared', 15_000, 200)
  const toast = await host.getByText(/Recording stopped successfully/).isVisible().catch(() => false)
  // Meeting continues: still in the room, Record available again, meeting LIVE.
  check(await host.locator('[data-testid="meeting-room"]').isVisible() && await peer.locator('[data-testid="meeting-room"]').isVisible(), 'someone left the room')
  check(scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`) === 'LIVE', 'meeting no longer LIVE')
  const label = await host.getByTestId('ctl-record').getAttribute('title')
  metrics.stopFirstChangeSeconds = +firstChange.toFixed(1)
  metrics.stopClearedSeconds = +cleared.toFixed(1)
  await shot(host, 'L-04-after-stop-host')
  return `indicator changed to "${afterClick}" ${firstChange.toFixed(1)} s after confirm, cleared after ${cleared.toFixed(1)} s on host (peer too); toast "Recording stopped successfully": ${toast}; both still in the room, meeting LIVE, Record button: "${label}"`
})

const okDone = okStop && await tc('L-05', 'MP4 finalised and verified → COMPLETED; file probed independently', async () => {
  const seen = new Set()
  await until(() => {
    const s = scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec1}'`)
    seen.add(s)
    if (s === 'FAILED') throw new Error(`FAILED: ${scalar(`SELECT FailureReason AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec1}'`)}`)
    return s === 'COMPLETED'
  }, 'not COMPLETED', 300_000, 1000)
  const r = sql(`SELECT StorageKey, FileSizeBytes, DurationSeconds, VideoCodec, AudioCodec, Width, Height, DATEDIFF(MILLISECOND, EndedUtc, VerifiedUtc) / 1000.0 AS FinalizeSeconds FROM rec.MeetingRecordings WHERE PublicId = '${rec1}'`)[0]
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path.join(LIBRARY, r.StorageKey)], { encoding: 'utf8' }))
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio')
  check(v?.codec_name === 'h264' && a?.codec_name === 'aac', 'unexpected codecs')
  metrics.finalizeSeconds = +r.FinalizeSeconds
  return `states ${[...seen].join('→')}; ${r.DurationSeconds} s, ${(r.FileSizeBytes / 1048576).toFixed(2)} MB, ${v.codec_name}/${a.codec_name} ${v.width}x${v.height}, ffprobe duration ${(+probe.format.duration).toFixed(1)} s; capture end → verified ${r.FinalizeSeconds} s`
})

const okCrash = okDone && await tc('L-06', 'Second recording in the same meeting; recorder process killed mid-recording → relaunched; peer network drop → state re-synced', async () => {
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').click()
  await until(async () => (await recStatus(host)) === 'RECORDING', 'second recording never reached REC', 60_000, 200)
  rec2 = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`).toLowerCase()
  check(rec2 !== rec1, 'no new recording row')
  await sleep(8000)
  const pid = scalar(`SELECT j.RecorderPid AS v FROM rec.RecordingJobs j JOIN rec.MeetingRecordings r ON r.RecordingId = j.RecordingId WHERE r.PublicId = '${rec2}'`)
  execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`])
  log(`  killed recorder pid ${pid}`)
  await until(() => +scalar(`SELECT j.LaunchCount AS v FROM rec.RecordingJobs j JOIN rec.MeetingRecordings r ON r.RecordingId = j.RecordingId WHERE r.PublicId = '${rec2}'`) >= 2, 'recorder not relaunched', 60_000, 1000)
  check(scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec2}'`) === 'RECORDING', 'recording did not stay RECORDING after the crash')
  // Peer loses the network for 8 s and comes back: its indicator must match the server again.
  await peer.context().setOffline(true)
  await sleep(8000)
  await peer.context().setOffline(false)
  await until(async () => (await recStatus(peer)) === 'RECORDING', 'peer indicator not re-synced after reconnect', 45_000, 500)
  await sleep(8000)
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-stop-confirm').click()
  await until(async () => (await recStatus(host)) === null, 'indicator not cleared after second stop', 60_000, 200)
  await until(() => {
    const s = scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec2}'`)
    if (s === 'FAILED') throw new Error(`FAILED: ${scalar(`SELECT FailureReason AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec2}'`)}`)
    return s === 'COMPLETED'
  }, 'second recording not COMPLETED', 300_000, 1000)
  const d = scalar(`SELECT JSON_VALUE(VerificationDetails, '$.joinedParts') AS v FROM rec.MeetingRecordings WHERE PublicId = '${rec2}'`)
  return `recorder pid ${pid} killed → relaunched (part 2), recording stayed RECORDING; peer offline 8 s → REC re-synced; stopped → COMPLETED, parts joined: ${d}`
})

const okRelogin = okDone && await tc('L-07', 'Host logs out (server session invalidated) and back in: both recordings still in the Recording Library, playable', async () => {
  const before = (await host.context().cookies()).find((c) => c.name === 'oic_session')
  const out = await api(host, 'POST', '/auth/logout')
  check(out.status === 204, `logout ${out.status}`)
  // The old session cookie no longer reaches a protected API.
  const replay = await fetch(`${WEB}/api/v1/recordings`, { headers: { Cookie: `oic_session=${before.value}`, Accept: 'application/json' } })
  check(replay.status === 401, `old session cookie answered ${replay.status}`)
  await host.goto(`${WEB}/dashboard`)
  await host.waitForURL(/\/login/, { timeout: 15_000 })
  await login(host, SECRET.host)
  await host.goto(`${WEB}/recordings`)
  await host.getByText(`QA bug-fix verification ${stamp}`).first().waitFor({ timeout: 20_000 })
  await shot(host, 'L-07-library-after-relogin')
  const list = await api(host, 'GET', '/recordings?pageSize=100')
  const ids = list.data.items.map((i) => i.id.toLowerCase())
  check(ids.includes(rec1) && (!rec2 || ids.includes(rec2)), 'recording missing from the library')
  const play = await api(host, 'POST', `/recordings/${rec1}/play`)
  check(play.status === 200, `play ${play.status}`)
  const range = await host.evaluate(async (url) => { const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } }); return { s: r.status, t: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength } }, play.data.url)
  check(range.s === 206 && range.t === 'video/mp4' && range.n === 1024, `media ${JSON.stringify(range)}`)
  return `old cookie → 401 after logout; after re-login the library lists ${ids.filter((i) => i === rec1 || i === rec2).length} recording(s) of this meeting; signed play URL → HTTP 206 video/mp4`
})

const okAccess = okDone && await tc('L-08', 'Access control: attendee (not host/organiser) cannot open it; administrator can', async () => {
  const p = await api(peer, 'GET', `/recordings/${rec1}`)
  check(p.status === 404, `attendee got ${p.status}`)
  const admin = await newPage()
  await login(admin, SECRET.admin)
  const a = await api(admin, 'GET', `/recordings/${rec1}`)
  check(a.status === 200, `admin got ${a.status}`)
  await admin.context().browser().close()
  pages.splice(pages.indexOf(admin), 1)
  return 'attendee → 404 (not visible); Admin (recordings.view.all) → 200'
})

okJoin && await tc('L-09', 'Host ends the meeting', async () => {
  const r = await api(host, 'POST', `/meetings/${meetingId}/room/end`)
  check(r.status === 200 || r.status === 204, `end ${r.status} ${JSON.stringify(r.data)}`)
  await until(() => ['COMPLETED', 'ENDED'].includes(scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)), 'meeting not ended')
  return `meeting ${scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)}`
})

// ---- Daily logout (administrator test mode: own account only, production time unchanged) --------------------------------
await tc('L-10', 'Daily logout test mode while IN a meeting: warning with countdown, then the call continues with a "sign in again" banner; leaving shows the daily message', async () => {
  const admin = await newPage()
  const other = await newPage()
  await login(admin, SECRET.admin)
  await login(other, SECRET.peer)
  const m2 = await createMeeting(admin, `QA daily-logout test ${stamp}`, peerEmp)
  const sched = await api(admin, 'POST', '/admin/ops/daily-logout/test', { minutes: 2 })
  check(sched.status === 200, `schedule ${sched.status}`)
  const cutoff = Date.parse(sched.data.testLogoutUtc)
  await enterRoom(admin, m2, 'Start meeting') // fresh page load fetches the session info (with the test cutoff)
  await enterRoom(other, m2, 'Join now')
  await admin.getByTestId('daily-logout-warning').waitFor({ timeout: 20_000 })
  const warning = (await admin.getByTestId('daily-logout-warning').innerText()).replace(/\s+/g, ' ')
  await shot(admin, 'L-10a-warning-in-meeting')
  await sleep(Math.max(0, cutoff - Date.now()) + 3000)
  await admin.getByTestId('session-lost-in-meeting').waitFor({ timeout: 45_000 })
  await shot(admin, 'L-10b-session-ended-still-in-call')
  check(/\/meetings\/.+\/room/.test(admin.url()), `navigated away: ${admin.url()}`)
  check(await admin.locator('[data-testid="meeting-room"]').isVisible(), 'room no longer shown')
  const s = await api(admin, 'GET', '/auth/session')
  check(s.status === 401, `session still valid: ${s.status}`)
  const revoked = scalar(`SELECT COUNT(*) AS v FROM auth.UserSessions s JOIN auth.Users u ON u.UserId = s.UserId WHERE u.Email = '${SECRET.admin}' AND s.RevokedReason = 'DAILY_LOGOUT_TEST'`)
  // The other participant is unaffected.
  check((await api(other, 'GET', '/auth/session')).status === 200, 'another user was signed out')
  await admin.getByTestId('ctl-leave').click()
  await admin.waitForURL(/session-expired/, { timeout: 20_000 })
  const page = (await admin.locator('body').innerText()).replace(/\s+/g, ' ')
  check(page.includes('Your daily session has ended. Please log in again to continue.'), 'daily message missing')
  await shot(admin, 'L-10c-daily-session-ended-page')
  await login(admin, SECRET.admin)
  await api(admin, 'POST', `/meetings/${m2}/room/end`)
  for (const p of [admin, other]) { await p.context().browser().close(); pages.splice(pages.indexOf(p), 1) }
  return `warning: "${warning.slice(0, 140)}"; at the cutoff the admin stayed in the call with the banner, /auth/session → 401, ${revoked} session(s) revoked (DAILY_LOGOUT_TEST), other participant unaffected; leaving → "Your daily session has ended. Please log in again to continue."; sign-in again works`
})

await tc('L-11', 'Daily logout test mode outside a meeting: redirected to the login flow with the daily message at the cutoff', async () => {
  const admin = await newPage()
  await login(admin, SECRET.admin)
  const sched = await api(admin, 'POST', '/admin/ops/daily-logout/test', { minutes: 1 })
  check(sched.status === 200, `schedule ${sched.status}`)
  await admin.reload()
  await admin.getByTestId('daily-logout-warning').waitFor({ timeout: 20_000 })
  await shot(admin, 'L-11a-warning-dashboard')
  await admin.waitForURL(/session-expired/, { timeout: 120_000 })
  await admin.getByText('Your daily session has ended. Please log in again to continue.').waitFor({ timeout: 15_000 })
  const page = (await admin.locator('body').innerText()).replace(/\s+/g, ' ')
  check(page.includes('Your daily session has ended. Please log in again to continue.'), 'daily message missing')
  await shot(admin, 'L-11b-daily-session-ended')
  await admin.context().browser().close()
  pages.splice(pages.indexOf(admin), 1)
  return 'warning shown on the dashboard, then /session-expired?reason=daily with the required message'
})

await tc('L-12', 'Production daily logout configuration (not changed by the tests)', async () => {
  const p = await newPage()
  await login(p, SECRET.peer)
  const s = await api(p, 'GET', '/auth/session')
  check(s.status === 200, `session ${s.status}`)
  check(s.data.dailyLogoutDescription === '23:30 Asia/Kolkata' && !s.data.dailyLogoutTest, `unexpected ${JSON.stringify(s.data)}`)
  const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(s.data.dailyLogoutUtc))
  await p.context().browser().close()
  pages.splice(pages.indexOf(p), 1)
  return `next daily logout ${s.data.dailyLogoutUtc} = ${ist} IST; warning ${s.data.warningMinutes} min before; idle ${s.data.idleMinutes} min; absolute expiry ${s.data.absoluteExpiryUtc}`
})

for (const b of browsers) await b.close().catch(() => {})
const file = path.join(OUT, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ web: WEB, metrics, results }, null, 2))
log(`\n${results.filter((r) => r.result === 'PASSED').length}/${results.length} passed · metrics ${JSON.stringify(metrics)} · ${file}`)
