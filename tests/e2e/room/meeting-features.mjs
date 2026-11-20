// Optional meeting features (13 Nov 2026) end to end in Microsoft Edge (headless, fake media) through playwright-core.
// Same isolated environment as room.mjs (LocalDB *_Room, API 7191 + webhooks 5091, Vite 5175, ISOLATED LiveKit) - never production.
//
// Proves: every feature is OFF by default and only an administrator can switch it; reactions reach the others; Yes/No polls
// (one answer each, live results for the host only, results for everyone after closing); private messages reach only the
// recipient (not the host, not a third person); the whiteboard (host opens, view-only until access is granted, strokes sync,
// late joiner sees the saved board, PNG/PDF download); background blur/image (browser-only, assets from our own server);
// noise-suppression switch keeps the microphone working; emergency switch turns everything off.
//
// Run:  cd tests\e2e; node room\meeting-features.mjs
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
const PASSWORD = 'Room!Strong#Pass2026' // local test database only (scripts/setup-room-db.ps1)
const ADMIN = 'superadmin@room.oneinsure.test'
const HOST = { email: 'hema.host@room.oneinsure.test', name: 'Hema Host' }
const EMP = { email: 'esha.employee@room.oneinsure.test', name: 'Esha Employee' }
const GUEST = { email: 'gita.guest@example.test', name: 'Gita Guest' }
const KEYS = ['REACTIONS', 'POLLS', 'PRIVATE_CHAT', 'WHITEBOARD', 'BACKGROUND_EFFECTS', 'NOISE_SUPPRESSION', 'CAMERA_FLIP', 'MEETING_MINUTES']

if (!/_Room$/.test(DB)) throw new Error('Only a database whose name ends in _Room may be used.')
if (/:7180|:5173/.test(WEB)) throw new Error('Never run against the developer instance (7180/5173).')
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
const exec = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q', q])

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
const pages = []
async function tc(id, title, expected, fn) {
  const t0 = Date.now()
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    const nt = typeof actual === 'string' && actual.startsWith('NOT TESTED')
    results.push({ id, title, expected, actual: actual ?? 'as expected', result: nt ? 'NOT TESTED' : 'PASS', ms: Date.now() - t0 })
    log(`  ${nt ? 'NOT TESTED' : 'PASS'} ${id}: ${actual ?? ''}`)
    return !nt
  } catch (e) {
    const shots = []
    for (const [i, p] of pages.entries()) {
      try {
        const f = path.join(SHOTS, `${id}-${i}.png`)
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
async function until(fn, msg, ms = 20_000, every = 400) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

// ---- Browser ---------------------------------------------------------------------------------------------------------
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
const browsers = []
const requests = [] // every URL the pages load (to prove no third-party hosts are used by the features)
async function newPage(label, viewport = { width: 1366, height: 820 }) {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  })
  browsers.push(browser)
  const context = await browser.newContext({ baseURL: WEB, viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'], acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = function (...args) {
      const pc = new Orig(...args)
      window.__pcs.push(pc)
      return pc
    }
    window.RTCPeerConnection.prototype = Orig.prototype
  })
  page.on('pageerror', (e) => log(`  [pageerror ${label}] ${e.message}`))
  page.on('request', (r) => requests.push(r.url()))
  page.on('console', (m) => {
    if (m.type() === 'error') fs.appendFileSync(path.join(RESULTS, 'features-console.log'), `${new Date().toISOString()} [${label}] ${m.text().slice(0, 400)}\n`)
  })
  pages.push(page)
  return page
}
const view = (page, name) => page.screenshot({ path: path.join(SHOTS, `view-features-${name}.png`) }).catch(() => {})
const inbound = (page) => page.evaluate(async () => {
  const out = { audio: 0, video: 0 }
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue
    for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.bytesReceived) out[s.kind] += s.bytesReceived
  }
  return out
})
/** Dark (drawn) pixels on the whiteboard canvas. */
const inked = (page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="wb-canvas"]')
  if (!c) return -1
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++
  return n
})
async function drag(page, from, to, steps = 12) {
  const box = await page.getByTestId('wb-canvas').boundingBox()
  const at = ([x, y]) => [box.x + box.width * x, box.y + box.height * y]
  await page.mouse.move(...at(from))
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(...at([from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]))
  await page.mouse.up()
}
async function loginUI(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}
async function enterRoom(page, button) {
  await page.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await until(() => page.evaluate(() => (document.querySelector('[data-testid="prejoin-preview"]')?.videoWidth ?? 0) > 0), 'camera preview never started', 15_000)
  await page.getByRole('button', { name: button }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}
async function openTools(page) {
  if (!(await page.getByTestId('tools-menu').isVisible().catch(() => false))) await page.getByTestId('ctl-tools').click()
  await page.getByTestId('tools-menu').waitFor()
}

// ---- Scenario --------------------------------------------------------------------------------------------------------
exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE') AND (Title LIKE N'Room E2E%' OR Title LIKE N'Features E2E%')")
exec('UPDATE app.FeatureSettings SET IsEnabled = 0') // start from the shipped state: everything off
const admin = await new Api().login(ADMIN)
const hostApi = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const start = new Date(Date.now() + 2 * 60_000)
start.setSeconds(0, 0)
const created = await hostApi.req('POST', '/meetings', {
  title: `Features E2E ${new Date().toISOString().slice(11, 16)}`, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 60 * 60_000).toISOString(),
  employeeIds: [eshaId], guests: [{ name: GUEST.name, email: GUEST.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const m = sql(`SELECT MeetingId, LiveKitRoomName FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)[0]
const ident = Object.fromEntries(sql(`SELECT COALESCE(e.EmployeeCode, 'GUEST') AS k, p.LiveKitIdentity AS v FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = ${m.MeetingId}`).map((r) => [r.k, r.v]))
const guestMail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${m.MeetingId} AND ToAddress = N'${GUEST.email}' ORDER BY OutboxId DESC`)
const guestToken = guestMail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]
const guestApi = new Api()
log(`meeting ${meetingId} host=${ident['RM-0001']} esha=${ident['RM-0002']} guest=${ident.GUEST}`)

let host, emp, guest
const ok = {}

ok.switches = await tc('MF-01', 'Every feature is off by default; only an administrator can switch it; changes are audited',
  '/room-features all false; a host (no features.manage) gets 403; the admin switches all 7 on; 7 FEATURE_SETTING_CHANGED audit rows', async () => {
    const before = (await new Api().req('GET', '/room-features')).data
    check(Object.values(before).every((v) => v === false), `defaults: ${JSON.stringify(before)}`)
    const denied = await hostApi.req('PUT', '/admin/features/REACTIONS', { enabled: true })
    check(denied.status === 403, `host switching a feature: ${denied.status}`)
    const disabledCall = await hostApi.req('GET', `/meetings/${meetingId}/room/polls`)
    check(disabledCall.status === 403 && disabledCall.data?.code === 'FEATURE_DISABLED', `polls while off: ${disabledCall.status} ${JSON.stringify(disabledCall.data)}`)
    const auditBefore = Number(scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'FEATURE_SETTING_CHANGED'"))
    for (const k of KEYS) {
      const r = await admin.req('PUT', `/admin/features/${k}`, { enabled: true })
      check(r.status === 204, `admin enabling ${k}: ${r.status}`)
    }
    const after = (await new Api().req('GET', '/room-features')).data
    check(Object.values(after).every((v) => v === true), `after: ${JSON.stringify(after)}`)
    const audits = Number(scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'FEATURE_SETTING_CHANGED'")) - auditBefore
    check(audits === KEYS.length, `audit rows: ${audits}`)
    return `defaults all off; host 403; polls 403 FEATURE_DISABLED while off; admin switched ${KEYS.length} on; ${audits} audit rows`
  })

ok.join = ok.switches && await tc('MF-02', 'Host and employee join; the Tools button appears', 'Both in the room with media; "Reactions and tools" button visible', async () => {
  host = await newPage('host')
  emp = await newPage('employee')
  await loginUI(host, HOST.email)
  await host.goto(`/meetings/${meetingId}`)
  await host.getByRole('link', { name: 'Start meeting' }).click()
  await enterRoom(host, 'Start meeting')
  await loginUI(emp, EMP.email)
  await emp.goto(`/meetings/${meetingId}/room`)
  await enterRoom(emp, 'Join now')
  await host.getByTestId('ctl-tools').waitFor()
  await emp.getByTestId('ctl-tools').waitFor()
  await until(async () => (await inbound(host)).video > 0, 'host receives no video from the employee', 25_000)
  const a = await inbound(host)
  await sleep(3000)
  const b = await inbound(host)
  check(b.audio > a.audio && b.video > a.video, `host media not flowing ${JSON.stringify({ a, b })}`)
  await view(host, 'room-with-tools')
  return `in the room; tools button on both; host receives audio +${b.audio - a.audio} B, video +${b.video - a.video} B in 3 s`
})

ok.reactions = ok.join && await tc('MF-03', 'Reactions reach the other participants', 'Host sends Applause; the employee sees the bubble with the host’s name; it disappears after a few seconds', async () => {
  await openTools(host)
  await view(host, 'tools-menu')
  await host.getByTestId('reaction-applause').click()
  const bubble = emp.getByTestId('reaction-bubble').filter({ hasText: HOST.name })
  await bubble.waitFor({ timeout: 8000 })
  const txt = await bubble.innerText()
  check(txt.includes('👏'), `bubble text ${txt}`)
  await view(emp, 'reaction-received')
  await until(async () => (await emp.getByTestId('reaction-bubble').count()) === 0, 'reaction did not disappear', 8000)
  if (await host.getByTestId('tools-menu').isVisible()) await host.keyboard.press('Escape')
  return `employee saw "${txt.replace(/\s+/g, ' ')}" and it disappeared`
})

ok.polls = ok.join && await tc('MF-04', 'Yes/No poll: one answer each, live results for everyone (15 Nov 2026), final results after closing',
  'Host starts a poll; employee sees the "!" badge and answers Yes in the UI; guest answers No through the API; second answer 409; host sees 1/1 live; employee sees live results before the host closes', async () => {
    await openTools(host)
    await host.getByTestId('tools-polls').click()
    await host.getByTestId('poll-question').fill('Have you understood the policy benefits?')
    await host.getByTestId('poll-start').click()
    await host.getByTestId('poll-card').first().waitFor()
    // Employee: badge on the tools button, then answers.
    await emp.locator('[data-testid="ctl-tools"] .oic-ctl-badge').waitFor({ timeout: 10_000 })
    await openTools(emp)
    await emp.getByTestId('tools-polls').click()
    await emp.getByTestId('poll-vote-yes').click()
    await emp.getByTestId('poll-my-answer').waitFor()
    await emp.getByTestId('poll-results').waitFor({ timeout: 10_000 }) // live results for everyone, not only after closing
    // Guest (API, personal token) answers No; a second answer is refused.
    const list = await guestApi.req('GET', `/join/${guestToken}/polls`)
    check(list.status === 200 && list.data.items.length === 1 && list.data.items[0].results?.total >= 1, `guest list ${JSON.stringify(list.data)}`)
    const pollId = list.data.items[0].id
    const v1 = await guestApi.req('POST', `/join/${guestToken}/polls/${pollId}/vote`, { answer: 'NO' })
    const v2 = await guestApi.req('POST', `/join/${guestToken}/polls/${pollId}/vote`, { answer: 'YES' })
    check(v1.status === 204 && v2.status === 409, `guest votes ${v1.status} / ${v2.status}`)
    // Host: live results 1 Yes / 1 No.
    await until(async () => (await host.getByTestId('poll-results').innerText()).includes('2 answers'), 'host results not live')
    const hostText = (await host.getByTestId('poll-results').innerText()).replace(/\s+/g, ' ')
    await view(host, 'poll-host-live')
    await host.getByTestId('poll-close').click()
    await emp.getByTestId('poll-results').waitFor({ timeout: 10_000 })
    await view(emp, 'poll-employee-closed')
    const rows = sql(`SELECT v.Answer FROM mtg.MeetingPollVotes v JOIN mtg.MeetingPolls p ON p.PollId = v.PollId WHERE p.MeetingId = ${m.MeetingId}`).map((r) => r.Answer).sort()
    check(JSON.stringify(rows) === '["NO","YES"]', `stored votes ${JSON.stringify(rows)}`)
    const audit = Number(scalar(`SELECT COUNT(*) AS v FROM app.AuditLog WHERE EntityId = '${meetingId}' AND [Action] IN ('MEETING_POLL_CREATED', 'MEETING_POLL_CLOSED')`))
    check(audit === 2, `poll audit rows ${audit}`)
    await host.getByRole('button', { name: 'Close polls' }).click()
    await emp.getByRole('button', { name: 'Close polls' }).click()
    return `host saw live "${hostText}"; guest second vote 409; employee saw results after close; SQL votes ${rows.join('+')}; 2 audit rows`
  })

ok.private = ok.join && await tc('MF-05', 'Private messages reach only the recipient',
  'Employee → host private message; host sees the unread count on the Private tab and the message; the guest (third person) cannot list it; a message to an identity outside the meeting is refused', async () => {
    await emp.getByTestId('ctl-chat').click()
    await emp.getByTestId('chat-tab-private').click()
    await emp.getByTestId('private-person').filter({ hasText: HOST.name }).click()
    const secret = `Private check ${Date.now()}`
    await emp.getByTestId('private-input').fill(secret)
    await emp.getByTestId('private-send').click()
    await emp.getByTestId('private-message').filter({ hasText: secret }).waitFor()
    // Host: unread badge on the chat button and the Private tab.
    await until(async () => (await host.locator('[data-testid="ctl-chat"] .oic-ctl-badge').innerText().catch(() => '')) === '1', 'host has no unread badge', 10_000)
    await host.getByTestId('ctl-chat').click()
    await host.getByTestId('chat-tab-private').click()
    await host.getByTestId('private-unread').waitFor()
    await view(host, 'private-unread')
    await host.getByTestId('private-person').filter({ hasText: EMP.name }).click()
    await host.getByTestId('private-message').filter({ hasText: secret }).waitFor()
    await view(host, 'private-thread')
    // Host replies; the employee receives it live.
    await host.getByTestId('private-input').fill('Reply in private')
    await host.getByTestId('private-send').click()
    await emp.getByTestId('private-message').filter({ hasText: 'Reply in private' }).waitFor({ timeout: 10_000 })
    // Third person (guest): sees none of it.
    const g = await guestApi.req('GET', `/join/${guestToken}/private`)
    check(g.status === 200 && g.data.items.length === 0, `guest sees ${JSON.stringify(g.data)}`)
    // Outside identity refused; self refused.
    const other = await guestApi.req('POST', `/join/${guestToken}/private`, { toIdentity: 'p_not_in_this_meeting', body: 'x' })
    const self = await guestApi.req('POST', `/join/${guestToken}/private`, { toIdentity: ident.GUEST, body: 'x' })
    check(other.status === 404 && self.status === 400, `outside ${other.status}, self ${self.status}`)
    const stored = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.PrivateMessages WHERE MeetingId = ${m.MeetingId}`))
    const readFlag = scalar(`SELECT CASE WHEN ReadUtc IS NULL THEN 0 ELSE 1 END AS v FROM mtg.PrivateMessages WHERE Body = N'${secret}'`)
    check(stored === 2 && readFlag === 1, `stored ${stored}, read ${readFlag}`)
    await host.getByTestId('ctl-chat').click()
    await emp.getByTestId('ctl-chat').click()
    return 'delivered both ways live; host unread badge 1; guest list empty; outside identity 404; self 400; 2 rows stored, first marked read'
  })

ok.board = ok.join && await tc('MF-06', 'Whiteboard: host opens (everyone may draw by default), host can restrict to hosts, strokes sync both ways, PNG/PDF download',
  'Host opens from Tools; both see the board; employee "View only"; host draws a rectangle → employee canvas inked; host grants Everyone → employee draws → host canvas gains ink; scene saved; PNG and PDF download', async () => {
    await openTools(host)
    await host.getByTestId('tools-whiteboard').click()
    await host.getByTestId('whiteboard').waitFor({ timeout: 10_000 })
    await emp.getByTestId('whiteboard').waitFor({ timeout: 10_000 })
    await emp.getByTestId('wb-tool-pen').waitFor({ timeout: 10_000 }) // 15 Nov 2026: drawing for everyone by default
    await host.getByTestId('wb-access').click()
    await host.getByTestId('wb-mode-hosts').click()
    await until(() => host.getByTestId('wb-mode-hosts').isChecked(), 'restriction not confirmed', 10_000)
    await host.getByTestId('wb-access').click()
    await emp.getByTestId('wb-view-only').waitFor({ timeout: 10_000 })
    await host.getByTestId('wb-tool-rect').click()
    await drag(host, [0.15, 0.2], [0.45, 0.6])
    await until(async () => (await inked(emp)) > 500, 'rectangle not shown at the employee', 10_000)
    const empInkAfterRect = await inked(emp)
    // Employee may not draw yet: dragging changes nothing.
    await drag(emp, [0.6, 0.2], [0.8, 0.5])
    await sleep(800)
    check((await inked(emp)) === empInkAfterRect, 'view-only employee could draw')
    // Host grants everyone.
    await host.getByTestId('wb-access').click()
    await host.getByTestId('wb-mode-everyone').click() // confirmed by the server's broadcast, then shown as selected
    await until(() => host.getByTestId('wb-mode-everyone').isChecked(), 'access change not confirmed', 10_000)
    await host.getByTestId('wb-access').click() // close the menu
    await emp.getByTestId('wb-tool-pen').waitFor({ timeout: 10_000 })
    const hostBefore = await inked(host)
    await emp.getByTestId('wb-tool-pen').click()
    await drag(emp, [0.6, 0.3], [0.85, 0.7], 20)
    await until(async () => (await inked(host)) > hostBefore + 100, 'employee stroke not shown at the host', 10_000)
    // Sticky note via keyboard.
    await host.getByTestId('wb-tool-note').click()
    const box = await host.getByTestId('wb-canvas').boundingBox()
    await host.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.08)
    await host.getByTestId('wb-text-input').fill('Premium: ₹12,000 / year')
    await host.keyboard.press('Enter')
    await sleep(1800) // debounced save
    await view(host, 'whiteboard-host')
    await view(emp, 'whiteboard-employee')
    const saved = sql(`SELECT [Version], LEN(SceneJson) AS Len, IsOpen, DrawMode FROM mtg.MeetingWhiteboards WHERE MeetingId = ${m.MeetingId}`)[0]
    check(saved && saved.Version > 0 && saved.Len > 100 && saved.IsOpen && saved.DrawMode === 'EVERYONE', `saved ${JSON.stringify(saved)}`)
    check(scalar(`SELECT SceneJson AS v FROM mtg.MeetingWhiteboards WHERE MeetingId = ${m.MeetingId}`).includes('Premium'), 'note not in the saved scene')
    const [png] = await Promise.all([host.waitForEvent('download'), host.getByTestId('wb-png').click()])
    const [pdf] = await Promise.all([host.waitForEvent('download'), host.getByTestId('wb-pdf').click()])
    const pngPath = path.join(RESULTS, 'whiteboard-export.png')
    const pdfPath = path.join(RESULTS, 'whiteboard-export.pdf')
    await png.saveAs(pngPath)
    await pdf.saveAs(pdfPath)
    const pngHead = fs.readFileSync(pngPath).subarray(0, 8).toString('hex')
    const pdfHead = fs.readFileSync(pdfPath).subarray(0, 5).toString()
    check(pngHead === '89504e470d0a1a0a' && pdfHead === '%PDF-', `exports ${pngHead} ${pdfHead}`)
    const audit = sql(`SELECT [Action] AS a FROM app.AuditLog WHERE EntityId = '${meetingId}' AND [Action] LIKE 'WHITEBOARD%'`).map((r) => r.a)
    check(audit.includes('WHITEBOARD_OPENED') && audit.includes('WHITEBOARD_ACCESS_CHANGED'), `audit ${audit}`)
    return `employee ink ${empInkAfterRect}px after host rectangle; view-only drag ignored; employee stroke reached host; scene v${saved.Version} (${saved.Len} chars) saved; PNG ${fs.statSync(pngPath).size} B, PDF ${fs.statSync(pdfPath).size} B`
  })

ok.late = ok.board && await tc('MF-07', 'Late joiner (guest, on a 390 px phone) sees the saved whiteboard; phone layout fits',
  'Guest joins after the drawing; the board opens with the existing ink; no horizontal overflow; the Tools menu fits the screen', async () => {
  guest = await newPage('guest', { width: 390, height: 844 })
  await guest.goto(`/join/${guestToken}`)
  await guest.getByRole('button', { name: 'Join meeting' }).click()
  await guest.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await guest.getByTestId('prejoin-name').fill(GUEST.name)
  await guest.getByRole('button', { name: /Join now|Ask to join/ }).click()
  await guest.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  await guest.getByTestId('whiteboard').waitFor({ timeout: 15_000 })
  const ink = await until(async () => { const n = await inked(guest); return n > 1000 ? n : 0 }, 'late joiner sees an empty board', 15_000)
  await view(guest, 'whiteboard-late-guest-phone')
  const overflow = await guest.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check(overflow <= 1, `phone horizontal overflow ${overflow}px`)
  await guest.getByTestId('ctl-tools').click()
  const menu = await guest.getByTestId('tools-menu').boundingBox()
  check(menu && menu.x >= 0 && menu.x + menu.width <= 390, `tools menu off-screen ${JSON.stringify(menu)}`)
  await view(guest, 'tools-menu-phone')
  await guest.keyboard.press('Escape')
  // Host closes it for everyone.
  await host.getByTestId('wb-close').click()
  await guest.getByTestId('whiteboard').waitFor({ state: 'detached', timeout: 10_000 })
  await emp.getByTestId('whiteboard').waitFor({ state: 'detached', timeout: 10_000 })
  return `guest (390 px phone) canvas shows ${ink} inked pixels on joining; no overflow; tools menu within the screen; host closed the board for everyone`
})

ok.bg = ok.join && await tc('MF-08', 'Background blur and image (processed in the browser, assets from our own server)',
  'Employee chooses Blur, then "OneInsure blue"; no error; the host still receives the employee’s video; the MediaPipe files come from the app’s own origin only', async () => {
    await emp.getByTestId('ctl-tools').click()
    await emp.getByTestId('tools-effects').click()
    await emp.getByTestId('effects-settings').waitFor()
    if (await emp.getByText('This browser or device can’t run background effects').isVisible()) {
      await view(emp, 'effects-unsupported')
      return 'NOT TESTED: this headless browser reports no WebGL2 support; the fallback message was shown correctly'
    }
    await emp.getByTestId('bg-blur').click()
    await until(async () => (await emp.getByTestId('bg-blur').getAttribute('aria-pressed')) === 'true', 'blur not selected')
    await sleep(4000)
    check(!(await emp.getByText('could not be started on this device').isVisible().catch(() => false)), 'blur failed with an error toast')
    await view(emp, 'effects-blur')
    await emp.getByTestId('bg-blue').click()
    await sleep(3000)
    await view(emp, 'effects-image')
    check((await emp.getByTestId('bg-blue').getAttribute('aria-pressed')) === 'true', 'image background not selected (fell back?)')
    const a = await inbound(host)
    await sleep(3000)
    const b = await inbound(host)
    check(b.video > a.video, 'host stopped receiving the employee video')
    const mp = requests.filter((u) => /mediapipe|tflite|tasks-vision/i.test(u))
    check(mp.length > 0 && mp.every((u) => u.startsWith(WEB)), `mediapipe requests ${JSON.stringify(mp)}`)
    await emp.getByTestId('bg-none').click()
    return `blur + image applied without error; host video +${b.video - a.video} B in 3 s; ${mp.length} MediaPipe requests, all to ${WEB}`
  })

ok.noise = ok.join && await tc('MF-09', 'Noise-suppression switch keeps the microphone working', 'Employee turns it off and on; the host keeps receiving the employee audio', async () => {
  await emp.getByTestId('noise-toggle').uncheck()
  await sleep(1500)
  const a = await inbound(host)
  await sleep(3000)
  const b = await inbound(host)
  await emp.getByTestId('noise-toggle').check()
  await sleep(1500)
  const c = await inbound(host)
  await sleep(3000)
  const d = await inbound(host)
  check(b.audio > a.audio && d.audio > c.audio, `audio stalled ${JSON.stringify({ a, b, c, d })}`)
  const settings = await emp.evaluate(async () => {
    const s = await navigator.mediaDevices.enumerateDevices()
    return s.filter((x) => x.kind === 'videoinput').length
  })
  return `audio flowing with suppression off (+${b.audio - a.audio} B) and on again (+${d.audio - c.audio} B); cameras visible to the page: ${settings}`
})

await tc('MF-10', 'Switch-camera button', 'Shown only when the device has two or more cameras; switches without leaving', async () => {
  const visible = await emp.getByTestId('flip-camera').isVisible().catch(() => false)
  if (!visible) return 'NOT TESTED: the headless test browser has only one (fake) camera, so the button is correctly hidden; needs a real phone or a PC with two cameras'
  await emp.getByTestId('flip-camera').click()
  return 'switched'
})

await tc('MF-11', 'Emergency switch turns every feature off; turning it back restores them', 'Admin sets EMERGENCY_DISABLE → /room-features all false and polls API 403; cleared → back on; both audited', async () => {
  const on = await admin.req('PUT', '/admin/features/EMERGENCY_DISABLE', { enabled: true })
  check(on.status === 204, `set ${on.status}`)
  const f = (await new Api().req('GET', '/room-features')).data
  check(Object.values(f).every((v) => v === false), `features during emergency ${JSON.stringify(f)}`)
  const p = await hostApi.req('GET', `/meetings/${meetingId}/room/polls`)
  check(p.status === 403, `polls during emergency ${p.status}`)
  check(await host.locator('[data-testid="meeting-room"]').isVisible(), 'meeting interrupted')
  const off = await admin.req('PUT', '/admin/features/EMERGENCY_DISABLE', { enabled: false })
  const f2 = (await new Api().req('GET', '/room-features')).data
  check(off.status === 204 && Object.values(f2).every((v) => v === true), `after clearing ${JSON.stringify(f2)}`)
  const audit = sql("SELECT [Action] AS a FROM app.AuditLog WHERE [Action] LIKE 'FEATURES_EMERGENCY%'").map((r) => r.a)
  check(audit.includes('FEATURES_EMERGENCY_DISABLED') && audit.includes('FEATURES_EMERGENCY_CLEARED'), `audit ${audit}`)
  return 'all off during emergency (API 403, meeting kept running); restored after clearing; audited'
})

await tc('MF-12', 'Admin page "Meeting features" (Organisation → System)', 'Admin sees the page with the emergency switch and 7 switches; the host does not see the menu entry', async () => {
  const adminPage = await newPage('admin')
  await loginUI(adminPage, ADMIN)
  await adminPage.goto('/meeting-features')
  await adminPage.getByTestId('meeting-features-page').waitFor()
  for (const k of KEYS) await adminPage.getByTestId(`feature-${k}`).waitFor()
  await view(adminPage, 'admin-page')
  await adminPage.setViewportSize({ width: 390, height: 844 })
  await sleep(500)
  const overflow = await adminPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  await view(adminPage, 'admin-page-phone')
  const me = (await hostApi.req('GET', '/auth/me')).data
  const perms = me.permissions ?? me.user?.permissions ?? []
  check(Array.isArray(perms) && perms.length > 0 && !perms.includes('features.manage'), `host permissions ${JSON.stringify(perms).slice(0, 200)}`)
  check(overflow <= 1, `phone overflow ${overflow}px`)
  return `${KEYS.length} switches + emergency switch shown;` + ' no horizontal overflow at 390 px; host lacks features.manage'
})

await tc('MF-13', 'Host ends the meeting; features leave nothing behind', 'Meeting COMPLETED; everyone sees "Meeting Ended"', async () => {
  await host.getByTestId('ctl-end').click()
  await host.getByRole('dialog').getByRole('button', { name: 'End for all' }).click()
  await host.getByRole('heading', { name: 'Meeting Ended' }).waitFor({ timeout: 20_000 })
  await emp.getByRole('heading', { name: 'Meeting Ended' }).waitFor({ timeout: 20_000 })
  check(scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${m.MeetingId}`) === 'COMPLETED', 'not COMPLETED')
  return 'COMPLETED; host and employee saw Meeting Ended'
})

exec('UPDATE app.FeatureSettings SET IsEnabled = 0') // leave the test DB in the shipped state
for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const notTested = results.filter((r) => r.result === 'NOT TESTED').length
const summary = { runUtc: new Date().toISOString(), web: WEB, database: DB, meetingId, passed, notTested, failed: results.length - passed - notTested, results }
fs.writeFileSync(path.join(RESULTS, 'features-results.json'), JSON.stringify(summary, null, 2))
fs.writeFileSync(path.join(RESULTS, 'features-results-summary.md'),
  `# Meeting features E2E — ${summary.runUtc}\n\n${passed} passed, ${notTested} not tested, ${summary.failed} failed (Edge headless, fake media)\n\n| Id | Case | Result | Actual |\n|---|---|---|---|\n` +
  results.map((r) => `| ${r.id} | ${r.title} | ${r.result} | ${String(r.actual).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n') + '\n')
log(`${passed} passed, ${notTested} not tested, ${summary.failed} failed`)
process.exit(summary.failed === 0 ? 0 : 1)
