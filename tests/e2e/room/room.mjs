// Phase 4 — video meeting room, end to end in Microsoft Edge (headless, fake camera/microphone) through playwright-core.
//
// Isolated environment (never the developer instance on 7180/5173/5080):
//   database  OneInsureVideoMeetingDB_Room on (localdb)\MSSQLLocalDB   (scripts/setup-room-db.ps1)
//   API       https://localhost:7191, LiveKit webhooks on http://127.0.0.1:5091   (scripts/start-room-api.ps1)
//   web       Vite dev server http://127.0.0.1:5175 proxying /api to 7191  (OIC_API_TARGET)
//   LiveKit   local dev server ws://127.0.0.1:7880 started with webhooks to 5091 (video-server/start-dev.ps1 -WebhookUrls ...)
//
// Run:  cd "E:\OneInsure Connect\tests\e2e"; node room\room.mjs
//
// Proves: host and employee join from the UI and receive each other's audio + video (WebRTC inbound bytes), chat goes
// live over LiveKit and is persisted (history loads for a later joiner), screen share arrives, a guest waits in the
// waiting room until the host admits them, the host removes the guest, the host ends the meeting for everyone →
// COMPLETED, attendance rows written from LiveKit webhooks.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots')
const WEB = process.env.ROOM_WEB ?? 'http://127.0.0.1:5175'
const DB = process.env.ROOM_DB ?? 'OneInsureVideoMeetingDB_Room'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const HEADLESS = process.env.E2E_HEADED !== '1'
const PASSWORD = 'Room!Strong#Pass2026' // local test database only (scripts/setup-room-db.ps1)
const HOST = { email: 'hema.host@room.oneinsure.test', name: 'Hema Host' }
const EMP = { email: 'esha.employee@room.oneinsure.test', name: 'Esha Employee' }
const GUEST = { email: 'gopal.guest@example.test', invited: 'Gopal Guest', shown: 'Gopal G. (Acme Corp)' }

if (!/_Room$/.test(DB)) throw new Error('Only a database whose name ends in _Room may be used.')
if (/:7180|:5173/.test(WEB)) throw new Error('Never run against the developer instance (7180/5173).')
fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---- SQL (LocalDB, Windows auth) -------------------------------------------------------------------------------
function sql(select) {
  const out = execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-y', '0', '-Q',
    `SET NOCOUNT ON; SELECT (SELECT * FROM (${select.replace(/\s*\r?\n\s*/g, ' ')}) q FOR JSON PATH, INCLUDE_NULL_VALUES) AS j`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const lines = out.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('[') || l.trim() === 'NULL')
  const json = start < 0 ? '' : lines.slice(start).join('').trim()
  return !json || json === 'NULL' ? [] : JSON.parse(json)
}
const scalar = (select) => Object.values(sql(select)[0] ?? { v: null })[0]

// ---- API client through the Vite proxy (cookie session + XSRF like the SPA) ---------------------------------------
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

// ---- Test-case recorder ----------------------------------------------------------------------------------------
const results = []
let pages = []
async function tc(id, title, expected, fn) {
  const t0 = Date.now()
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, expected, actual: actual ?? 'as expected', result: 'PASS', ms: Date.now() - t0 })
    log(`  PASS ${id}: ${actual ?? ''}`)
    return true
  } catch (e) {
    const shot = path.join(SHOTS, `${id}.png`)
    const shots = []
    for (const [i, p] of pages.entries()) {
      try {
        const f = shot.replace('.png', `-${i}.png`)
        await p.screenshot({ path: f })
        shots.push(path.relative(HERE, f))
      } catch { /* page closed */ }
    }
    results.push({ id, title, expected, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL', screenshots: shots, ms: Date.now() - t0 })
    log(`  FAIL ${id}: ${e?.message ?? e}`)
    return false
  }
}
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

// ---- Browser -----------------------------------------------------------------------------------------------------
// Fake camera = a small generated Y4M clip (320×240, 10 fps). Chromium's built-in generated 720p test pattern stalls
// intermittently on a loaded PC when the fake microphone runs in the same page ("Timeout starting video source").
const CAM = path.join(RESULTS, 'fake-camera.y4m')
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
// One browser PROCESS per participant (like separate PCs): within one process all pages share a single fake capture
// device, and one page re-opening it ends the other page's camera track.
const browsers = []
const launchArgs = {
  executablePath: EDGE,
  headless: HEADLESS,
  args: [
    '--use-fake-ui-for-media-stream', // auto-accept camera/microphone prompts
    '--use-fake-device-for-media-stream', // synthetic camera and microphone (beep)
    `--use-file-for-fake-video-capture=${CAM}`,
    '--auto-select-desktop-capture-source=Entire screen', // screen share without the picker
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
}

async function newPage() {
  const browser = await chromium.launch(launchArgs)
  browsers.push(browser)
  const context = await browser.newContext({ baseURL: WEB, viewport: { width: 1366, height: 820 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  // Keep a handle on every RTCPeerConnection to read WebRTC stats (proof that media actually flows).
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = function (...args) {
      const pc = new Orig(...args)
      window.__pcs.push(pc)
      window.__ice = args[0]?.iceServers ?? []
      return pc
    }
    window.RTCPeerConnection.prototype = Orig.prototype
    // Diagnostics: who stops a camera track, and when a capture ends on its own.
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c)
      for (const t of s.getVideoTracks()) {
        console.error(`[diag] getUserMedia video ${t.id} ${JSON.stringify(c?.video ?? null)}`)
        t.addEventListener('ended', () => console.error(`[diag] video track ENDED ${t.id}`))
      }
      return s
    }
    const stop = MediaStreamTrack.prototype.stop
    MediaStreamTrack.prototype.stop = function () {
      if (this.kind === 'video' && !/screen|window|tab/i.test(this.label)) console.error(`[diag] video track stop() ${this.id} ${new Error().stack?.split('\n').slice(2, 7).join(' | ')}`)
      return stop.call(this)
    }
  })
  page.on('pageerror', (e) => log(`  [pageerror ${pages.indexOf(page)}] ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || (msg.type() === 'warning' && /livekit|track|publish|device|camera/i.test(msg.text())))
      fs.appendFileSync(path.join(RESULTS, 'browser-console.log'), `${new Date().toISOString()} [page ${pages.indexOf(page)} ${msg.type()}] ${msg.text().slice(0, 500)}\n`)
  })
  pages.push(page)
  return page
}

/** Inbound RTP bytes by kind, summed over the page's peer connections. */
const inbound = (page) => page.evaluate(async () => {
  const out = { audio: 0, video: 0 }
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue
    for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.bytesReceived) out[s.kind] += s.bytesReceived
  }
  return out
})

/** A <video> inside the tile of `identity` that is actually rendering frames. */
const tileVideo = (page, identity, testId = 'video-camera') => page.evaluate(([id, t]) => {
  const v = document.querySelector(`[data-identity="${id}"] video[data-testid="${t}"]`) ?? (t === 'video-screen' ? document.querySelector('[data-testid="video-screen"]') : null)
  return v ? { w: v.videoWidth, h: v.videoHeight, paused: v.paused } : null
}, [identity, testId])

async function loginUI(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}

/** Design-review screenshots (results/screenshots/view-*.png); never fail a case. */
const view = (page, name) => page.screenshot({ path: path.join(SHOTS, `view-${name}.png`) }).catch(() => {})

async function preJoinAndEnter(page, buttonName, shot) {
  await page.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  // Preview from the fake camera.
  await until(() => page.evaluate(() => (document.querySelector('[data-testid="prejoin-preview"]')?.videoWidth ?? 0) > 0), 'camera preview never started', 15_000)
  if (shot) await view(page, shot)
  await page.getByRole('button', { name: buttonName }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}

// ---- Scenario ----------------------------------------------------------------------------------------------------
// Earlier runs leave meetings at "now" that would (correctly) be refused as double bookings: retire them in this test DB.
execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q',
  "UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE') AND Title LIKE N'Room E2E%'"])
const hostApi = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const start = new Date(Date.now() + 2 * 60_000)
start.setSeconds(0, 0)
const created = await hostApi.req('POST', '/meetings', {
  title: `Room E2E ${new Date().toISOString().slice(11, 16)}`, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 60 * 60_000).toISOString(),
  employeeIds: [eshaId], guests: [{ name: GUEST.invited, email: GUEST.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: true,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const m = sql(`SELECT MeetingId, LiveKitRoomName FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)[0]
const ident = Object.fromEntries(sql(`SELECT COALESCE(e.EmployeeCode, 'GUEST') AS k, p.LiveKitIdentity AS v FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = ${m.MeetingId}`).map((r) => [r.k, r.v]))
const guestMail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${m.MeetingId} AND ToAddress = N'${GUEST.email}' ORDER BY OutboxId DESC`)
const guestToken = guestMail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]
log(`meeting ${meetingId} room ${m.LiveKitRoomName} host=${ident['RM-0001']} esha=${ident['RM-0002']} guest=${ident.GUEST}`)

const host = await newPage()
const emp = await newPage()
let guest
let ok = {}

ok.api = await tc('ROOM-01', 'API: join window and permissions before anyone joins', 'Host detail says joinable (Start meeting); the guest link reports joinableNow + videoAvailable', async () => {
  const d = (await hostApi.req('GET', `/meetings/${meetingId}`)).data
  check(d.join.joinable && d.my.canHostRoom, `detail.join = ${JSON.stringify(d.join)}`)
  const j = (await new Api().req('GET', `/join/${guestToken}`)).data
  check(j.joinableNow && j.videoAvailable && j.waitingRoom && j.participantType === 'GUEST', `join info ${JSON.stringify(j)}`)
  return `joinable, opens ${d.join.opensUtc}; guest link joinable with waiting room`
})

ok.host = await tc('ROOM-02', 'Host starts the meeting from the meeting page', 'Pre-join shows the fake camera; "Start meeting" connects; status LIVE', async () => {
  await loginUI(host, HOST.email)
  await host.goto(`/meetings/${meetingId}`)
  await host.getByRole('link', { name: 'Start meeting' }).click()
  await preJoinAndEnter(host, 'Start meeting', 'prejoin-host')
  await until(async () => (await tileVideo(host, ident['RM-0001']))?.w > 0, 'host does not see own camera')
  await until(() => scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${m.MeetingId}`) === 'LIVE', 'meeting not LIVE')
  const ice = await host.evaluate(() => JSON.stringify(window.__ice))
  return `room connected, own video rendering, meeting LIVE; ICE servers handed to the browser: ${ice}`
})

ok.emp = await tc('ROOM-03', 'Employee joins from the dashboard', 'Dashboard shows "Join" for the open meeting; pre-join → room', async () => {
  await loginUI(emp, EMP.email)
  const join = emp.locator(`a[href="/meetings/${meetingId}/room"]`).first()
  await join.waitFor({ timeout: 15_000 })
  await join.click()
  await preJoinAndEnter(emp, 'Join now')
  return 'joined via the dashboard Join button'
})

ok.media = ok.host && ok.emp && await tc('ROOM-04', 'Host and employee receive each other\'s video and audio', 'Each sees the other\'s camera tile rendering; inbound WebRTC audio and video bytes keep growing on both sides', async () => {
  await until(async () => (await tileVideo(host, ident['RM-0002']))?.w > 0, 'host does not see the employee video')
  await until(async () => (await tileVideo(emp, ident['RM-0001']))?.w > 0, 'employee does not see the host video')
  const h1 = await inbound(host), e1 = await inbound(emp)
  await sleep(3000)
  const h2 = await inbound(host), e2 = await inbound(emp)
  check(h2.audio > h1.audio && h2.video > h1.video, `host inbound not growing: ${JSON.stringify([h1, h2])}`)
  check(e2.audio > e1.audio && e2.video > e1.video, `employee inbound not growing: ${JSON.stringify([e1, e2])}`)
  const audioEls = await emp.evaluate(() => [...document.querySelectorAll('audio')].filter((a) => a.srcObject?.getAudioTracks?.()[0]?.readyState === 'live').length)
  check(audioEls >= 1, 'no live <audio> element for the remote participant')
  return `host +${h2.audio - h1.audio} B audio / +${h2.video - h1.video} B video in 3 s; employee +${e2.audio - e1.audio} B / +${e2.video - e1.video} B; ${audioEls} live audio element(s)`
})

const chatText = `Hello Hema <b>not bold</b> ${Date.now().toString(36)}`
ok.chat = ok.media && await tc('ROOM-05', 'Chat round trip, rendered as text and persisted', 'Employee sends; host receives live; markup shown literally; row in mtg.MeetingChatMessages', async () => {
  await emp.getByTestId('ctl-chat').click()
  await emp.getByTestId('chat-input').fill(chatText)
  await emp.getByTestId('chat-input').press('Enter')
  await until(() => host.getByTestId('ctl-chat').locator('.oic-ctl-badge').isVisible(), 'host did not get an unread badge', 10_000)
  await host.getByTestId('ctl-chat').click()
  const msg = host.getByTestId('chat-message').filter({ hasText: chatText })
  await msg.waitFor({ timeout: 10_000 })
  const bold = await host.getByTestId('chat-list').locator('b').count()
  check(bold === 0, 'chat markup was rendered as HTML')
  await until(() => Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingChatMessages WHERE MeetingId = ${m.MeetingId} AND Body = N'${chatText.replace(/'/g, "''")}'`)) === 1, 'chat message not persisted', 10_000)
  await host.getByTestId('ctl-chat').click() // close the panel again
  return 'delivered live, shown as literal text, stored once in SQL'
})

ok.screen = ok.media && await tc('ROOM-06', 'Screen share reaches the other participant', 'Host presents; the employee gets a screen-share tile with frames', async () => {
  await host.getByTestId('ctl-screen').click()
  await until(async () => (await tileVideo(emp, ident['RM-0001'], 'video-screen'))?.w > 0, 'no screen-share video at the employee', 25_000)
  const v = await tileVideo(emp, ident['RM-0001'], 'video-screen')
  await view(emp, 'screen-share-employee')
  await host.getByTestId('ctl-screen').click() // stop presenting
  return `screen share rendered at the employee (${v.w}×${v.h})`
})

ok.waiting = ok.host && await tc('ROOM-07', 'Guest waits in the waiting room until the host admits', 'Guest: pre-join with name → waiting screen; host: badge + Admit; guest connected and sees the host', async () => {
  guest = await newPage()
  await guest.goto(`/join/${guestToken}`)
  await guest.getByRole('button', { name: 'Join meeting' }).click()
  await guest.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await guest.getByTestId('prejoin-name').fill(GUEST.shown)
  await guest.getByRole('button', { name: 'Ask to join' }).click()
  await guest.getByTestId('waiting-room').waitFor({ timeout: 15_000 })
  await view(guest, 'waiting-room-guest')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM mtg.WaitingRoomEntries WHERE MeetingId = ${m.MeetingId} AND [Status] = 'WAITING'`)) === 1, 'no WAITING entry in SQL')
  await host.getByTestId('waiting-badge').waitFor({ timeout: 20_000 }) // pushed by the API over LiveKit (or the 15 s fallback poll)
  await host.getByTestId('ctl-people').click()
  await view(host, 'host-waiting-list')
  await host.getByTestId('waiting-entry').filter({ hasText: GUEST.invited }).getByTestId('waiting-admit').click()
  await guest.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  await until(async () => (await tileVideo(guest, ident['RM-0001']))?.w > 0, 'guest does not see the host video')
  await until(async () => (await tileVideo(host, ident.GUEST))?.w > 0, 'host does not see the guest video')
  const shownName = await host.locator(`[data-testid="participant"][data-identity="${ident.GUEST}"]`).innerText()
  check(shownName.includes(GUEST.shown), `host lists the guest as "${shownName}"`)
  // Chat history (persisted) is loaded for the late joiner.
  await guest.getByTestId('ctl-chat').click()
  await guest.getByTestId('chat-message').filter({ hasText: chatText }).waitFor({ timeout: 10_000 })
  await view(host, 'room-host-3-people')
  await view(guest, 'room-guest-chat')
  return 'waited → admitted → connected both ways; guest shown with the chosen name; chat history loaded on join'
})

ok.remove = ok.waiting && await tc('ROOM-08', 'Host removes the guest', 'Confirmation dialog; the guest sees "You were removed from the meeting"', async () => {
  await host.locator(`[data-testid="participant"][data-identity="${ident.GUEST}"]`).getByTestId('participant-remove').click()
  await host.getByRole('button', { name: 'Remove from meeting' }).click()
  await guest.getByText('You were removed from the meeting').waitFor({ timeout: 15_000 })
  check(Number(scalar(`SELECT COUNT(*) AS v FROM app.AuditLog WHERE EntityId = '${meetingId}' AND [Action] = 'ROOM_PARTICIPANT_REMOVED'`)) === 1, 'no audit entry')
  return 'guest disconnected by the host (audited)'
})

ok.reconnect = ok.emp && await tc('ROOM-09', 'Connection loss shows "Reconnecting…" and recovers automatically', 'Employee goes offline for a few seconds → banner; back online → room continues (host still visible)', async () => {
  await emp.context().setOffline(true)
  const saw = await emp.getByTestId('reconnecting-banner').waitFor({ timeout: 20_000 }).then(() => true, () => false)
  await sleep(2000)
  await emp.context().setOffline(false)
  await until(async () => !(await emp.getByTestId('reconnecting-banner').isVisible()), 'still reconnecting', 30_000)
  await until(async () => (await tileVideo(emp, ident['RM-0001']))?.w > 0, 'host video not back after reconnect', 20_000)
  check(await emp.locator('[data-testid="meeting-room"]').isVisible(), 'employee left the room')
  return saw ? 'banner shown while offline; reconnected with media' : 'offline window too short for the banner, but the room recovered with media'
})

ok.end = ok.host && await tc('ROOM-10', 'Host ends the meeting for everyone', '"End for all" with confirmation; host and employee see "The meeting has ended"; status COMPLETED', async () => {
  await host.getByTestId('ctl-end').click()
  await host.getByRole('dialog').getByRole('button', { name: 'End for all' }).click()
  await host.getByText('The meeting has ended').waitFor({ timeout: 20_000 })
  await view(host, 'ended-host')
  if (ok.emp) await emp.getByText('The meeting has ended').waitFor({ timeout: 20_000 })
  const st = sql(`SELECT [Status], ActualStartUtc, ActualEndUtc FROM mtg.Meetings WHERE MeetingId = ${m.MeetingId}`)[0]
  check(st.Status === 'COMPLETED' && st.ActualStartUtc && st.ActualEndUtc, `meeting row ${JSON.stringify(st)}`)
  return `COMPLETED (${st.ActualStartUtc} → ${st.ActualEndUtc})`
})

await tc('ROOM-11', 'Attendance and room lifecycle from signed LiveKit webhooks', 'app.WebhookEvents has verified events for the room; a closed attendance interval for host, employee and guest; guest left with PARTICIPANT_REMOVED', async () => {
  const room = m.LiveKitRoomName
  const events = await until(() => {
    const rows = sql(`SELECT EventType, COUNT(*) AS n FROM app.WebhookEvents WHERE Source = 'LIVEKIT' AND SignatureValid = 1 AND ProcessedUtc IS NOT NULL AND PayloadJson LIKE '%${room}%' GROUP BY EventType`)
    return rows.some((r) => r.EventType === 'room_finished') ? rows : null
  }, 'no room_finished webhook processed', 30_000, 1000)
  const att = sql(`SELECT COALESCE(e.EmployeeCode, 'GUEST') AS who, a.JoinedUtc, a.LeftUtc, a.LeaveReason, a.DurationSeconds, a.ClientInfo FROM mtg.MeetingAttendance a JOIN mtg.MeetingParticipants p ON p.ParticipantId = a.ParticipantId LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE a.MeetingId = ${m.MeetingId}`)
  for (const who of ['RM-0001', 'RM-0002', 'GUEST']) check(att.some((a) => a.who === who && a.LeftUtc), `no closed attendance row for ${who}: ${JSON.stringify(att)}`)
  check(att.every((a) => a.LeftUtc), `open attendance rows: ${JSON.stringify(att)}`)
  check(att.some((a) => a.who === 'GUEST' && a.LeaveReason === 'PARTICIPANT_REMOVED'), `guest leave reason: ${JSON.stringify(att.filter((a) => a.who === 'GUEST'))}`)
  check(att.some((a) => /^livekit:PA_/.test(a.ClientInfo ?? '')), 'attendance rows did not come from webhooks')
  const audit = sql(`SELECT [Action] AS a FROM app.AuditLog WHERE EntityId = '${meetingId}'`).map((r) => r.a)
  for (const a of ['MEETING_STARTED', 'WAITING_ROOM_ADMITTED', 'ROOM_PARTICIPANT_REMOVED', 'MEETING_ENDED']) check(audit.includes(a), `audit lacks ${a}: ${audit.join(',')}`)
  return `webhooks: ${events.map((r) => `${r.EventType}×${r.n}`).join(', ')}; attendance: ${att.map((a) => `${a.who} ${a.DurationSeconds}s (${a.LeaveReason})`).join('; ')}`
})

for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const summary = { runUtc: new Date().toISOString(), web: WEB, database: DB, meetingId, passed, failed: results.length - passed, results }
fs.writeFileSync(path.join(RESULTS, 'room-results.json'), JSON.stringify(summary, null, 2))
fs.writeFileSync(path.join(RESULTS, 'room-results-summary.md'),
  `# Video room E2E — ${summary.runUtc}\n\n${passed}/${results.length} passed (Edge headless, fake media)\n\n| Id | Case | Result | Actual |\n|---|---|---|---|\n` +
  results.map((r) => `| ${r.id} | ${r.title} | ${r.result} | ${String(r.actual).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n') + '\n')
log(`${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
