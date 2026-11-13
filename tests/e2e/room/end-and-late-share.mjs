// 13 Nov 2026 (Oneinsure_connect_bugs.docx):
//  1. Recording notice redesign: one title, the policy wording, the support address, ONE "OK, got it"; no placeholder / version /
//     policy details for participants; compact on a phone; the acknowledgement is still recorded.
//  2. Late joiners must see a screen share that started before they joined (host + A sharing → B joins → C joins → A stops → B shares).
//  3. Host ends the meeting: everyone sees "Meeting Ended" at once (not "Reconnecting…"), also a participant whose network was down
//     at that moment; ending again is idempotent; the link afterwards says the meeting has ended.
//
// Isolated environment ONLY: LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192, web http://127.0.0.1:5176 (Vite --mode api),
// isolated LiveKit 127.0.0.1:7890.   Run:  cd tests\e2e; node room\end-and-late-share.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, '..', 'recording', 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'end-and-late-share')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const HOST = 'rekha.host@rec.oneinsure.test'
const NOTICE = 'This meeting may be recorded by OneInsure for business, service, quality assurance and compliance purposes, as applicable. The recording will be securely stored and accessed only by authorised personnel.'
if (!/_Rec$/.test(DB)) throw new Error('Only a database whose name ends in _Rec may be used.')
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Local web server only.')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sqlcmd = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${q}`], { encoding: 'utf8' }).trim()

const results = []
const pages = []
const consoleErrors = []
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
/** One browser process per participant (separate fake capture devices), like separate PCs/phones. */
async function newPage(name, viewport = { width: 1280, height: 800 }, mobile = false) {
  const b = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
  browsers.push(b)
  const ctx = await b.newContext({ baseURL: WEB, viewport, isMobile: mobile, hasTouch: mobile, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const p = await ctx.newPage(); p.setDefaultTimeout(20_000)
  p.on('pageerror', (e) => { consoleErrors.push(`${name}: ${e.message}`); log(`  [pageerror ${name}] ${e.message}`) })
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::|status of 401/.test(m.text())) consoleErrors.push(`${name}: ${m.text().slice(0, 300)}`) })
  // Watch for the reconnecting banner and "Connection lost" at any time (they must never show after an intentional end).
  await p.addInitScript(() => {
    window.__seen = { reconnecting: 0, lost: 0 }
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="reconnecting-banner"]')) window.__seen.reconnecting++
      if (/Connection lost/.test(document.body?.innerText ?? '')) window.__seen.lost++
    }).observe(document, { subtree: true, childList: true })
  })
  p.__name = name
  pages.push(p); return p
}
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
  const r = await fetch(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }
}, { method, url, body })
/** The screen-share <video> on this page: frames rendering, and whose name is on the tile. */
const screenOn = (p) => p.evaluate(() => {
  const v = document.querySelector('[data-testid="video-screen"]')
  const tile = v?.closest('[data-testid="tile-screen"]')
  return v ? { w: v.videoWidth, h: v.videoHeight, who: tile?.innerText?.replace(/\s+/g, ' ').trim() ?? '' } : null
})
const screenTiles = (p) => p.locator('[data-testid="tile-screen"]').count()

// Local DB mirrors the live policy: Customer PLVC = mandatory, notification only, the owner-approved wording; status still PENDING_CONFIRMATION
// (an APPROVED policy needs a retention period, which is intentionally unset - it would block recording).
sqlcmd(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE');
  UPDATE rec.RecordingPolicies SET IsEnabled = 1, Requirement = 'MANDATORY', ConsentMode = 'NOTIFICATION_ONLY', NoticeText = N'${NOTICE}',
    NoticeVersion = 'PLVC-NOTICE-1.0', ApprovalStatus = 'PENDING_CONFIRMATION', PolicyReference = N'Approved by product owner (Santosh Yadav), 13 Nov 2026', ApprovedBy = N'Santosh Yadav (product owner)', ApprovedOn = '2026-11-13' WHERE PolicyCode = 'CUSTOMER_PLVC'`)

const host = await newPage('host', { width: 1366, height: 860 })
await host.goto('/login')
await host.getByLabel('Official Email / Employee ID').fill(HOST)
await host.getByLabel('Password', { exact: true }).fill(PASSWORD)
await host.getByRole('button', { name: 'Sign In' }).click()
await host.waitForURL(/\/dashboard/)
const created = await api(host, 'POST', '/meetings/instant', { category: 'CUSTOMER_PLVC', durationMinutes: 30, prarambhMainId: '131120',
  participants: [{ name: 'Asha Customer', email: 'asha.customer@rec.oneinsure.test' }, { name: 'Bala Guest', email: 'bala.guest@rec.oneinsure.test' }, { name: 'Chitra Guest', email: 'chitra.guest@rec.oneinsure.test' }] })
if (created.status !== 201) throw new Error(`instant ${created.status} ${JSON.stringify(created.body)}`)
const meeting = created.body
const mid = Number(sqlcmd(`SELECT MeetingId FROM mtg.Meetings WHERE PublicId = '${meeting.id}'`))
const link = (i) => new URL(meeting.participants[i].joinUrl).pathname
await host.goto(`/meetings/${meeting.id}/room`)
await host.getByRole('button', { name: 'Start meeting' }).click()
await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
await host.keyboard.press('Escape').catch(() => {}) // the invite dialog that opens for a new instant meeting

async function join(p, i, name) {
  await p.goto(link(i))
  await p.getByRole('button', { name: 'Join meeting' }).click({ timeout: 30_000 })
  await p.getByText('Ready to join?').waitFor({ timeout: 30_000 }).catch(() => {})
  const nm = p.getByTestId('prejoin-name'); if ((await nm.count()) && !(await nm.inputValue())) await nm.fill(name)
  await p.getByRole('button', { name: /Ask to join|Join now/ }).click()
  await until(async () => {
    if (await p.locator('[data-testid="meeting-room"]').count()) return true
    if (!(await host.getByTestId('waiting-entry').count()) && (await host.getByTestId('waiting-badge').count())) await host.getByTestId('ctl-people').click().catch(() => {})
    const admit = host.getByTestId('waiting-admit'); if (await admit.count()) await admit.first().click().catch(() => {})
    return false
  }, `${name} never got into the room`, 45_000)
}

// ---- 1. Recording notice ------------------------------------------------------------------------------------------
let a, b, c
await tc('RN-01', 'Customer on a phone (390×844): one clean notice - title, approved wording, support e-mail, ONE "OK, got it"; no placeholder/version/policy text; compact', async () => {
  a = await newPage('A-customer-phone', { width: 390, height: 844 }, true)
  await join(a, 0, 'Asha Customer')
  const card = a.getByTestId('rec-notice-banner')
  await card.waitFor({ timeout: 30_000 })
  await sleep(400) // entrance animation
  const text = await card.innerText()
  check(text.includes('Meeting Recording Notice'), 'title missing')
  check(text.includes(NOTICE), 'approved wording missing')
  check(text.includes('For assistance: support@oneinsure.com'), 'support line missing')
  for (const bad of ['PLACEHOLDER', 'Notice version', 'Wording not confirmed', 'not confirmed', 'Customer PLVC', 'PLVC-NOTICE']) check(!text.includes(bad), `customer sees "${bad}"`)
  const buttons = await card.locator('button').allInnerTexts()
  check(buttons.filter((t) => t.trim()).length === 1 && /OK, got it/.test(buttons.join('')), `buttons with text: ${JSON.stringify(buttons)}`)
  const bb = await card.boundingBox()
  check(bb.height <= 844 * 0.46 + 1 && bb.x >= 11 && bb.x + bb.width <= 390 - 11, `card ${Math.round(bb.x)},${Math.round(bb.y)} ${Math.round(bb.width)}×${Math.round(bb.height)} on 390×844`)
  const ok = await a.getByTestId('rec-notice-ok').boundingBox()
  check(ok.height >= 44, `OK button ${ok.height} px`)
  await shot(a, 'rn-01-customer-phone')
  await a.touchscreen.tap(ok.x + ok.width / 2, ok.y + ok.height / 2)
  await until(async () => (await card.count()) === 0, 'card still open after OK', 3000)
  return `card ${Math.round(bb.width)}×${Math.round(bb.height)} px at y=${Math.round(bb.y)} (≤ 46% of 844); 1 button "OK, got it" ${Math.round(ok.width)}×${Math.round(ok.height)} px; no placeholder/version/policy text; closed on tap`
})
await tc('RN-02', 'Host (desktop): same clean card (wording is confirmed, so no internal note); acknowledgements recorded for host and customer; recording still mandatory', async () => {
  const card = host.getByTestId('rec-notice-banner')
  if (await card.count()) {
    const t = await card.innerText()
    check(!t.includes('PLACEHOLDER') && !t.includes('Notice version'), 'host card shows placeholder/version')
    check((await host.getByTestId('rec-notice-internal').count()) === 0, 'internal note shown although the policy is confirmed')
    await shot(host, 'rn-02-host-desktop')
    await host.getByTestId('rec-notice-ok').click()
  }
  const rows = sqlcmd(`SELECT p.ParticipantType + ':' + c.Decision + ':' + c.NoticeVersion FROM mtg.MeetingConsent c JOIN mtg.MeetingParticipants p ON p.ParticipantId = c.ParticipantId
    WHERE c.MeetingId = ${mid} AND c.ConsentType = 'RECORDING' ORDER BY c.ConsentId`).split(/\r?\n/).filter(Boolean)
  check(rows.includes('EMPLOYEE:GRANTED:PLVC-NOTICE-1.0') && rows.includes('CUSTOMER:GRANTED:PLVC-NOTICE-1.0'), `consent rows ${JSON.stringify(rows)}`)
  const audit = sqlcmd(`SELECT COUNT(*) FROM app.AuditLog WHERE Action = 'RECORDING_CONSENT_GRANTED' AND EntityId = '${meeting.id}'`)
  // Mandatory PLVC recording must really start with this policy state (13 Nov: an APPROVED policy without retention blocked it).
  await until(() => ['RECORDING', 'PROCESSING', 'COMPLETED'].includes(sqlcmd(`SELECT TOP (1) [Status] FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)), 'mandatory PLVC recording did not start', 60_000)
  const rec = sqlcmd(`SELECT TOP (1) [Status] FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)
  return `acknowledgements ${rows.join(', ')}; ${audit} audit rows; recording ${rec || '(none yet)'}`
})

// ---- 2. Screen share for late joiners ----------------------------------------------------------------------------
await tc('SS-01', 'Customer A (desktop) presents; the host sees it', async () => {
  // A re-joins from a desktop browser for screen sharing (phones cannot share a screen from a browser).
  await a.goto('about:blank')
  a = await newPage('A-desktop')
  await join(a, 0, 'Asha Customer')
  await a.getByTestId('rec-notice-ok').click({ timeout: 15_000 }).catch(() => {})
  await a.getByTestId('ctl-screen').click()
  await until(async () => (await screenOn(host))?.w > 0, 'host does not see A\'s screen', 25_000)
  const s = await screenOn(host)
  check(/Asha/.test(s.who), `screen tile name "${s.who}"`)
  return `host sees ${s.w}×${s.h} "${s.who}"`
})
await tc('SS-02', 'Guest B joins on a PHONE (390×844) WHILE A is presenting: sees A\'s screen at once, without a refresh and without A restarting', async () => {
  b = await newPage('B-phone', { width: 390, height: 844 }, true)
  const t0 = Date.now()
  await join(b, 1, 'Bala Guest')
  await b.getByTestId('rec-notice-ok').click({ timeout: 15_000 }).catch(() => {})
  await until(async () => (await screenOn(b))?.w > 0, 'B (late joiner) does not see the active screen share', 25_000)
  const s = await screenOn(b)
  check(/Asha/.test(s.who), `B's screen tile name "${s.who}"`)
  check((await screenOn(host))?.w > 0, 'host lost the screen share when B joined')
  await shot(b, 'ss-02-late-joiner-B')
  return `B sees ${s.w}×${s.h} "${s.who}" ${((Date.now() - t0) / 1000).toFixed(1)} s after opening the link; host still sees it`
})
await tc('SS-03', 'Guest C joins later still: also sees the same screen share; exactly one screen tile everywhere', async () => {
  c = await newPage('C')
  await join(c, 2, 'Chitra Guest')
  await c.getByTestId('rec-notice-ok').click({ timeout: 15_000 }).catch(() => {})
  await until(async () => (await screenOn(c))?.w > 0, 'C does not see the active screen share', 25_000)
  const counts = [await screenTiles(host), await screenTiles(b), await screenTiles(c)]
  check(counts.every((n) => n === 1), `screen tiles host/B/C = ${counts}`)
  const pubs = await a.evaluate(() => document.querySelectorAll('[data-testid="tile-screen"]').length)
  return `C sees "${(await screenOn(c)).who}"; one screen tile at host/B/C (${counts}); A's own view ${pubs} tile`
})
await tc('SS-04', 'A stops presenting: the screen share disappears for host, B and C', async () => {
  await a.getByTestId('ctl-screen').click()
  for (const p of [host, b, c]) await until(async () => (await screenTiles(p)) === 0, `${p.__name} still shows a screen tile`, 15_000)
  return 'no screen tile left at host, B, C'
})
await tc('SS-05', 'C (desktop) starts presenting: host, A and B (phone) see C\'s screen', async () => {
  await c.getByTestId('ctl-screen').click()
  for (const p of [host, a, b]) await until(async () => /Chitra/.test((await screenOn(p))?.who ?? '') && (await screenOn(p)).w > 0, `${p.__name} does not see C's screen`, 25_000)
  await shot(b, 'ss-05-B-phone-sees-C')
  return 'C\'s screen rendering at host, A and B (phone)'
})

// ---- 3. Host ends the meeting ------------------------------------------------------------------------------------
await tc('END-01', 'Host ends for everyone (C\'s network is down at that moment): A and B see "Meeting Ended" at once; C sees it when back online; nobody sees "Connection lost"', async () => {
  await c.context().setOffline(true)
  await sleep(1500)
  const before = await Promise.all([a, b].map((p) => p.evaluate(() => window.__seen.reconnecting)))
  await host.getByTestId('ctl-end').click()
  const t0 = Date.now()
  await host.getByRole('dialog').getByRole('button', { name: 'End for all' }).click()
  for (const p of [a, b, host]) await until(async () => (await p.getByTestId('meeting-ended').count()) > 0, `${p.__name} does not show "Meeting Ended"`, 10_000)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const after = await Promise.all([a, b].map((p) => p.evaluate(() => window.__seen.reconnecting)))
  check(after[0] === before[0] && after[1] === before[1], `A/B showed "Reconnecting…" after the end (${before} → ${after})`)
  const txt = await b.getByTestId('meeting-ended').innerText()
  check(/The host has ended this meeting/.test(txt) && txt.includes(meeting.meetingCode), `ended screen text: ${txt}`)
  await shot(b, 'end-01-B-meeting-ended')
  await shot(host, 'end-01-host-meeting-ended')
  // C comes back online: LiveKit cannot resume (the room is gone); the API says it has ended.
  await sleep(4000)
  await c.context().setOffline(false)
  const t1 = Date.now()
  await until(async () => (await c.getByTestId('meeting-ended').count()) > 0, 'C (was offline) does not show "Meeting Ended"', 40_000)
  await shot(c, 'end-01-C-after-offline')
  const lost = await Promise.all([a, b, c].map((p) => p.evaluate(() => window.__seen.lost)))
  check(lost.every((n) => n === 0), `"Connection lost" was shown (${lost})`)
  // Local camera/mic/screen released after the end.
  const live = await b.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject?.getTracks?.().some((t) => t.readyState === 'live')).length)
  check(live === 0, `${live} live video elements left at B`)
  const db = sqlcmd(`SELECT [Status] FROM mtg.Meetings WHERE MeetingId = ${mid}`)
  check(db === 'COMPLETED', `meeting status ${db}`)
  return `A, B and host on "Meeting Ended" ${secs} s after End for all; C (offline during the end) ${((Date.now() - t1) / 1000).toFixed(1)} s after reconnecting; no "Connection lost"; meeting ${db}`
})
await tc('END-02', 'Ending again is idempotent (204, nothing processed twice); the link afterwards says the meeting has ended', async () => {
  const again = await api(host, 'POST', `/meetings/${meeting.id}/room/end`)
  check(again.status === 204, `second end ${again.status}`)
  const n = sqlcmd(`SELECT COUNT(*) FROM app.AuditLog WHERE Action = 'MEETING_ENDED' AND EntityId = '${meeting.id}'`)
  check(n === '1', `${n} MEETING_ENDED audit rows`)
  const j = await b.evaluate(async (u) => (await fetch(`/api/v1/join/${u.split('/join/')[1]}`)).json(), link(1))
  check(j.status === 'ENDED', `join info status ${j.status}`)
  return `second End → 204; 1 MEETING_ENDED audit row; join link status ${j.status}`
})
await tc('END-03', 'No browser errors during the run', async () => {
  // C was deliberately offline when the meeting ended: when it comes back, the LiveKit SDK logs its own errors about the dead
  // session ("cannot send signal request before connected", "Unexpected first message") before the page shows Meeting Ended
  // (checked in END-01). Those SDK messages from C are expected; anything else fails.
  const sdkNoiseFromC = (e) => e.startsWith('C: ') && /cannot send signal request before connected|Unexpected first message|could not connect|websocket|signal/i.test(e)
  const real = consoleErrors.filter((e) => !sdkNoiseFromC(e))
  check(real.length === 0, real.slice(0, 8).join(' | '))
  return `none (${consoleErrors.length - real.length} expected SDK reconnect message(s) from C, which was offline during the end)`
})

for (const br of browsers) await br.close().catch(() => {})
const file = path.join(RESULTS, `end-and-late-share-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ suite: 'end-and-late-share', web: WEB, db: DB, results }, null, 2))
const passed = results.filter((r) => r.result === 'PASS').length
log(`${passed}/${results.length} passed → ${file}`)
process.exit(passed === results.length ? 0 : 1)
