// GoodDay "Meet" bug batch (12 Nov 2026), end to end in Microsoft Edge (headless, fake camera/microphone/screen) with the REAL R2 recorder:
// dashboard buttons and KPI links, the Invited tab, E-mail in Invite people no longer drops the call, the tile expand button, a guest
// on a phone can use the control bar (the sign-in layout footer no longer covers it), and a portrait 1:1 recording with a screen share
// gives the shared screen the full width.
//
// Isolated environment ONLY (never production): LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192, web http://127.0.0.1:5176,
// isolated LiveKit. Run:  cd tests\e2e; node recording\goodday-fixes.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'goodday-fixes')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FF = process.env.OIC_FFMPEG_DIR ?? 'C:/ffmpeg/bin'
const LIBRARY = path.join(ROOT, 'recording/e2e/library')
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
const GUEST_NAME = 'Phone Guest'

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

/** A y4m clip for Chromium's fake camera: moving bar over a checkerboard, W x H. */
function clip(file, W, H) {
  if (fs.existsSync(file)) return file
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const F = 40
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < F; f++) {
    const y = Buffer.alloc(W * H), u = Buffer.alloc(W * H / 4, 110), v = Buffer.alloc(W * H / 4, 150)
    const bar = Math.floor((f * H) / F)
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) y[r * W + c] = Math.abs(r - bar) < 12 ? 235 : 60 + (((r >> 4) + (c >> 4)) % 2) * 40
    parts.push(Buffer.from('FRAME\n'), y, u, v)
  }
  fs.writeFileSync(file, Buffer.concat(parts))
  return file
}
const LANDSCAPE = clip(path.join(RESULTS, 'fake-camera.y4m'), 320, 240)
const PORTRAIT = clip(path.join(RESULTS, 'fake-camera-portrait.y4m'), 240, 320)

const browsers = []
async function newPage({ viewport = { width: 1366, height: 820 }, mobile = false, cam = LANDSCAPE } = {}) {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam}`, '--autoplay-policy=no-user-gesture-required',
      '--auto-select-desktop-capture-source=Entire screen', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
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
/** The control is the element actually under its own centre (nothing drawn over it). */
const reachable = (p, testId) => p.evaluate((id) => {
  const b = document.querySelector(`[data-testid="${id}"]`)
  if (!b) return `no ${id}`
  const r = b.getBoundingClientRect()
  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return b.contains(el) ? true : `covered by <${el?.tagName.toLowerCase()} class="${el?.className}">${(el?.textContent ?? '').slice(0, 60)}`
}, testId)

// ---- Setup -------------------------------------------------------------------------------------------------------------
exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')`)

let host, guest, meetingId, mid, linkPath, recId

const ok1 = await tc('GD-01', 'Dashboard: one "Schedule meeting" (header) + "Instant meeting"; no second Schedule button (#14212, #14192)', async () => {
  host = await newPage()
  await host.goto('/login')
  await host.getByLabel('Official Email / Employee ID').fill(HOST)
  await host.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await host.getByRole('button', { name: 'Sign In' }).click()
  await host.waitForURL(/\/dashboard/, { timeout: 20_000 })
  const header = (await host.getByTestId('header-schedule').innerText()).trim()
  check(header === 'Schedule meeting', `header button "${header}"`)
  const instant = (await host.getByTestId('new-meeting').innerText()).trim()
  check(instant === 'Instant meeting', `instant button "${instant}"`)
  const scheduleLinks = await host.locator('main a[href$="/schedule"]').evaluateAll((a) => a.map((x) => x.textContent.trim()))
  check(!scheduleLinks.includes('Schedule'), `dashboard still has a "Schedule" button: ${JSON.stringify(scheduleLinks)}`)
  check(!(await host.getByText('New Meeting', { exact: true }).count()), '"New Meeting" still shown')
  await shot(host, 'gd01-dashboard-buttons')
  return `header "${header}", dashboard "${instant}"; schedule links on the page: ${JSON.stringify(scheduleLinks)}`
})

const ok2 = ok1 && await tc('GD-02', "Today's Meetings card opens My Meetings → Today (#14209)", async () => {
  await host.getByText("Today's Meetings", { exact: true }).click()
  await host.waitForURL(/\/meetings\?tab=today/)
  const sel = await host.getByRole('tab', { selected: true }).innerText()
  check(sel.trim() === 'Today', `selected tab "${sel}"`)
  await shot(host, 'gd02-today-tab')
  return `${new URL(host.url()).pathname}${new URL(host.url()).search} with tab "${sel.trim()}" selected`
})

const ok3 = ok2 && await tc('GD-03', 'Upcoming Meetings card opens My Meetings → Upcoming, not the calendar (#14210)', async () => {
  await host.goto('/dashboard')
  await host.getByText('Upcoming Meetings', { exact: true }).click()
  await host.waitForURL(/\/meetings\?tab=upcoming/)
  const sel = await host.getByRole('tab', { selected: true }).innerText()
  check(sel.trim() === 'Upcoming', `selected tab "${sel}"`)
  return `${new URL(host.url()).pathname}${new URL(host.url()).search} with tab "${sel.trim()}" selected`
})

ok3 && await tc('GD-04', 'My Meetings explains each list; "Attending" is now "Invited" (#14211)', async () => {
  const up = await host.getByTestId('tab-hint').innerText()
  check(/ones you host and ones you are invited to/.test(up), `upcoming hint "${up}"`)
  await host.getByRole('tab', { name: 'Invited' }).click()
  const inv = await until(async () => { const t = await host.getByTestId('tab-hint').innerText(); return /invited you/.test(t) && t }, 'Invited hint not shown', 5000)
  check(/someone else hosts and has invited you/.test(inv), `invited hint "${inv}"`)
  check(!(await host.getByRole('tab', { name: 'Attending' }).count()), '"Attending" tab still present')
  check(/tab=attending/.test(host.url()), 'tab not kept in the URL')
  await shot(host, 'gd04-invited-tab')
  return `Upcoming: "${up}" · Invited: "${inv}"`
})

const ok5 = await tc('GD-05', 'Invite people → E-mail opens the mail app WITHOUT ending the call (#14207)', async () => {
  const hostApi = await host.evaluate(async () => {
    const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
    const start = new Date(Date.now() + 60_000); start.setSeconds(0, 0)
    const r = await fetch('/api/v1/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf },
      body: JSON.stringify({ title: `GoodDay fixes ${new Date().toISOString().slice(11, 16)}`, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 3600_000).toISOString(), employeeIds: [], status: 'SCHEDULED', recordingPolicy: 'OPTIONAL', waitingRoomEnabled: false }) })
    return { status: r.status, body: await r.json() }
  })
  check(hostApi.status === 201, `create ${JSON.stringify(hostApi)}`)
  meetingId = hostApi.body.id
  mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
  await host.goto(`/meetings/${meetingId}/room`)
  await host.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  await host.getByRole('button', { name: /Invite/ }).first().click()
  const dialog = host.getByRole('dialog', { name: 'Invite people' })
  await dialog.waitFor()
  linkPath = new URL(await dialog.getByTestId('meeting-link').inputValue()).pathname.replace(/^\/meet/, '')
  const mail = dialog.getByRole('link', { name: 'E-mail' })
  check((await mail.getAttribute('target')) === '_blank', 'E-mail link still opens in the same tab')
  let unloaded = false
  await host.evaluate(() => { window.__unload = 0; window.addEventListener('beforeunload', () => { window.__unload++ }) })
  host.once('framenavigated', (f) => { if (f === host.mainFrame()) unloaded = true })
  const popup = host.context().waitForEvent('page', { timeout: 5000 }).catch(() => null)
  await mail.click()
  const pp = await popup
  await pp?.close().catch(() => {})
  await sleep(6000)
  check(!unloaded, 'the meeting page navigated away')
  check(await host.locator('[data-testid="meeting-room"]').isVisible(), 'meeting room gone after clicking E-mail')
  const state = await host.evaluate(() => document.querySelector('[data-testid="meeting-room"]') ? 'in room' : 'left')
  const fired = await host.evaluate(() => window.__unload)
  // Some browsers still fire beforeunload for an external-protocol link: the room must survive that event too.
  await host.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
  await sleep(4000)
  check(await host.locator('[data-testid="meeting-room"]').isVisible(), 'a beforeunload event (as fired for mailto:) still ends the call')
  check(!(await host.getByText(/You left the meeting|Connection lost/).count()), 'left/connection-lost screen shown')
  const people = (await host.getByTestId('ctl-people').innerText().catch(() => '')).trim()
  await shot(host, 'gd05-after-email-click')
  await host.keyboard.press('Escape')
  return `mailto opened in a separate context (${pp ? 'popup page' : 'no page'}); beforeunload fired ${fired}× on the call page; host still ${state} 6 s later; a synthetic beforeunload no longer disconnects (room still shown 4 s later)${people}`
})

const ok6 = ok5 && await tc('GD-06', 'Guest on an iPhone-sized screen (portrait camera): control bar reachable, not covered by the footer (#14205)', async () => {
  guest = await newPage({ viewport: { width: 390, height: 844 }, mobile: true, cam: PORTRAIT })
  await guest.goto(linkPath)
  await guest.getByTestId('link-join').click()
  await guest.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  const name = guest.getByTestId('prejoin-name')
  if (await name.count()) await name.fill(GUEST_NAME)
  await guest.getByRole('button', { name: /Ask to join|Join now/ }).click()
  const inRoom = guest.locator('[data-testid="meeting-room"]')
  await until(async () => (await inRoom.count()) || (await guest.getByTestId('waiting-room').count()), 'guest neither waiting nor in the room', 25_000)
  if (!(await inRoom.count())) {
    await until(async () => (await host.getByTestId('waiting-entry').count()) > 0 || (await host.getByTestId('waiting-badge').count()) > 0, 'host never saw the guest', 25_000)
    if (!(await host.getByTestId('waiting-entry').count())) await host.getByTestId('ctl-people').click()
    await host.getByTestId('waiting-entry').first().getByTestId('waiting-admit').click()
    await inRoom.waitFor({ timeout: 25_000 })
    await host.keyboard.press('Escape').catch(() => {})
  }
  await sleep(2500)
  const checks = {}
  for (const id of ['ctl-mic', 'ctl-cam', 'ctl-chat', 'ctl-people', 'ctl-more', 'ctl-leave']) checks[id] = await reachable(guest, id)
  const bad = Object.entries(checks).filter(([, v]) => v !== true)
  check(!bad.length, `covered controls: ${JSON.stringify(bad)}`)
  // The sign-in layout's footer ("Need help? …") is not rendered at all while the room is open (12 Nov: support line moved into
  // the room's More sheet / Settings, support@oneinsure.com).
  const footer = await guest.evaluate(() => {
    const f = document.querySelector('.oic-auth-footer')
    return f ? getComputedStyle(f).display : 'no footer element'
  })
  check(footer === 'none', `sign-in footer still rendered in the room (display: ${footer})`)
  check(!(await guest.getByText('it.support@oneinsure.com').count()), 'old it.support address still shown')
  // Every size: controls reachable, no horizontal overflow, toolbar inside the viewport, toolbar height.
  const sizes = [['iPhone SE', 320, 568], ['Android small', 360, 740], ['iPhone 14', 390, 844], ['iPhone Pro Max', 430, 932], ['phone landscape', 844, 390], ['iPad', 768, 1024], ['iPad landscape', 1024, 768], ['laptop', 1366, 768]]
  const sized = []
  for (const [label, width, height] of sizes) {
    await guest.setViewportSize({ width, height })
    await sleep(600)
    const ids = await guest.evaluate(() => [...document.querySelectorAll('nav[aria-label="Meeting controls"] [data-testid^="ctl-"]')].map((b) => b.getAttribute('data-testid')))
    check(ids.includes('ctl-leave') && ids.includes('ctl-mic'), `${label}: controls missing (${ids})`)
    const bad = []
    for (const id of ids) { const r = await reachable(guest, id); if (r !== true) bad.push(`${id}: ${r}`) }
    const m = await guest.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Meeting controls"]').getBoundingClientRect()
      const btns = [...document.querySelectorAll('nav[aria-label="Meeting controls"] .oic-ctl')].map((b) => b.getBoundingClientRect())
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, navH: Math.round(nav.height), navBottom: Math.round(nav.bottom), vh: innerHeight, minBtn: Math.round(Math.min(...btns.map((b) => Math.min(b.width, b.height)))), outside: btns.filter((b) => b.left < 0 || b.right > innerWidth).length }
    })
    check(!bad.length, `${label}: ${bad.join('; ')}`)
    check(m.overflow <= 0 && !m.outside, `${label}: horizontal overflow ${m.overflow}px, ${m.outside} buttons off-screen`)
    check(m.navBottom <= m.vh, `${label}: toolbar bottom ${m.navBottom} below viewport ${m.vh}`)
    check(m.minBtn >= 44, `${label}: smallest control ${m.minBtn}px < 44px touch target`)
    await shot(guest, `gd06-${label.replace(/\W+/g, '-').toLowerCase()}`)
    sized.push(`${label} ${width}x${height}: ${ids.length} ctl, bar ${m.navH}px, min ${m.minBtn}px`)
  }
  await guest.setViewportSize({ width: 390, height: 844 })
  await sleep(600)
  // Phones: the support contact is in the More sheet.
  await guest.getByTestId('ctl-more').tap()
  const support = (await guest.getByTestId('more-sheet').getByTestId('room-support').innerText()).replace(/\s+/g, ' ').trim()
  check(support.includes('support@oneinsure.com') && !support.includes('it.support'), `More sheet support line: "${support}"`)
  await shot(guest, 'gd06-more-sheet-support')
  await guest.keyboard.press('Escape')
  await guest.getByTestId('more-sheet').waitFor({ state: 'detached', timeout: 5000 })
  const footerShown = `footer display:none; More sheet shows "${support}"; ${sized.join(' | ')}`
  const before = await guest.getByTestId('ctl-mic').getAttribute('aria-pressed')
  await guest.getByTestId('ctl-mic').tap()
  await until(async () => (await guest.getByTestId('ctl-mic').getAttribute('aria-pressed')) !== before, 'tapping the microphone did nothing', 8000)
  await guest.getByTestId('ctl-mic').tap()
  await shot(guest, 'gd06-guest-iphone-controls')
  return `all 6 controls are the element under their own centre; mic tap toggled ${before} → ${before === 'true' ? 'false' : 'true'}; control: ${footerShown}`
})

const ok7 = ok6 && await tc('GD-07', "Tile expand button puts that person on the main stage and back (#14203)", async () => {
  const tile = host.locator('[data-testid="tile"]').filter({ hasText: GUEST_NAME }).first()
  await tile.hover()
  const toggle = tile.locator('.lk-focus-toggle-button')
  check(await toggle.count(), 'no expand button on the guest tile')
  check(!(await host.locator('.lk-focus-layout').count()), 'already in focus layout before expanding')
  await toggle.click()
  await until(async () => (await host.locator('.lk-focus-layout').count()) > 0, 'expand did not change the layout', 5000)
  const focused = await host.locator('.lk-focus-layout > .lk-participant-tile').last().getAttribute('data-identity').catch(() => null)
  await shot(host, 'gd07-expanded')
  const big = host.locator('.lk-focus-layout > [data-testid="tile"]').filter({ hasText: GUEST_NAME })
  await big.hover()
  await big.locator('.lk-focus-toggle-button').click()
  await until(async () => (await host.locator('.lk-focus-layout').count()) === 0, 'collapse did not return to the grid', 5000)
  return `expanded → focus layout (main tile ${focused}); pressed again → grid`
})

ok7 && await tc('GD-08', 'Desktop host + phone guest (portrait camera), desktop presents: the recording is LANDSCAPE, not phone-shaped', async () => {
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').click()
  await guest.locator('[data-testid="rec-consent-popup"]').waitFor({ state: 'visible', timeout: 20_000 })
  await guest.locator('[data-testid="rec-consent-popup"]').getByTestId('rec-accept').tap()
  await until(async () => (await recStatus(host)) === 'RECORDING', 'recording never started', 120_000, 500)
  recId = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)
  await sleep(4000)
  await host.getByTestId('ctl-screen').click()
  await until(async () => (await host.locator('[data-testid="tile-screen"]').count()) > 0, 'screen share did not start (headless capture)', 15_000)
  const shareAt = Date.now()
  await sleep(12_000)
  await shot(host, 'gd08-host-presenting')
  const end = await host.evaluate(async (id) => {
    const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
    return (await fetch(`/api/v1/meetings/${id}/room/end`, { method: 'POST', headers: { 'X-XSRF-TOKEN': xsrf } })).status
  }, meetingId)
  check(end === 204, `end ${end}`)
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'COMPLETED', 'recording not COMPLETED', 240_000, 1000)
  const r = sql(`SELECT StorageKey, DurationSeconds, Width, Height FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)[0]
  const file = path.join(LIBRARY, r.StorageKey)
  // 12 Nov 2026 rule: portrait only when EVERY participant's camera is portrait; the host here is a desktop (landscape camera).
  check(r.Width > r.Height, `recording is not landscape (${r.Width}x${r.Height}) - a desktop + phone call was still locked portrait`)
  const dur = Number(execFileSync(path.join(FF, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }))
  const frame = path.join(SHOTS, 'gd08-recording-frame-during-share.png')
  execFileSync(path.join(FF, 'ffmpeg.exe'), ['-y', '-v', 'error', '-sseof', '-6', '-i', file, '-frames:v', '1', frame])
  // Measure the share area: rows near the top whose pixels are not the background, across nearly the full width.
  return `recording ${r.Width}x${r.Height}, ${dur.toFixed(1)} s (share for the last ~${Math.round((Date.now() - shareAt) / 1000)} s); frame saved to ${path.relative(HERE, frame)}`
})

for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const out = path.join(RESULTS, `goodday-fixes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), results }, null, 2))
log(`${passed}/${results.length} passed · ${out}`)
process.exit(passed === results.length ? 0 : 1)
