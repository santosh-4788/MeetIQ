// Minutes of meeting (MOM) without AI (V027, 14 Nov 2026) end to end in Microsoft Edge (headless) through playwright-core.
// Isolated environment only: LocalDB *_Room, API 7191, Vite 5175 - never production. No video/LiveKit is needed.
//
// Test set-up shortcut (stated in the report): the meetings are marked as having taken place (COMPLETED + actual start/end, one
// attendance row) directly in the test database, instead of running a real video meeting - the room itself is covered by
// room.mjs and meeting-features.mjs.
//
// Run:  cd tests\e2e; node room\meeting-minutes.mjs
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
const HOST = 'hema.host@room.oneinsure.test'
const EMP = 'esha.employee@room.oneinsure.test'
const HINDI = 'ग्राहक को सोमवार तक पॉलिसी दस्तावेज़ भेजें'

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
    results.push({ id, title, expected, actual: actual ?? 'as expected', result: 'PASS', ms: Date.now() - t0 })
    log(`  PASS ${id}: ${actual ?? ''}`)
    return true
  } catch (e) {
    const shots = []
    for (const [i, p] of pages.entries()) {
      try {
        const f = path.join(SHOTS, `${id}-${i}.png`)
        await p.screenshot({ path: f, fullPage: true })
        shots.push(path.relative(HERE, f))
      } catch { /* closed */ }
    }
    results.push({ id, title, expected, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL', screenshots: shots, ms: Date.now() - t0 })
    log(`  FAIL ${id}: ${e?.message ?? e}`)
    return false
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
async function until(fn, msg, ms = 15_000, every = 300) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

const browsers = []
async function newPage(label, viewport = { width: 1366, height: 900 }) {
  const browser = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1' })
  browsers.push(browser)
  const context = await browser.newContext({ baseURL: WEB, viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => log(`  [pageerror ${label}] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') fs.appendFileSync(path.join(RESULTS, 'minutes-console.log'), `${new Date().toISOString()} [${label}] ${m.text().slice(0, 400)}\n`)
  })
  pages.push(page)
  return page
}
const view = (page, name) => page.screenshot({ path: path.join(SHOTS, `view-minutes-${name}.png`), fullPage: true }).catch(() => {})
async function loginUI(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const statusText = (page) => page.getByTestId('minutes-status').innerText()

// ---- Set-up ----------------------------------------------------------------------------------------------------------
exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE') AND (Title LIKE N'Room E2E%' OR Title LIKE N'Features E2E%' OR Title LIKE N'Minutes E2E%')")
exec("UPDATE app.FeatureSettings SET IsEnabled = 0 WHERE FeatureKey IN ('MEETING_MINUTES', 'EMERGENCY_DISABLE')")
const admin = await new Api().login(ADMIN)
const hostApi = await new Api().login(HOST)
const empApi = await new Api().login(EMP)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const stamp = new Date().toISOString().slice(11, 16)

let slot = 0
async function meeting(title, extra = {}) {
  // Separate one-hour slots: the participants may not be double-booked.
  const start = new Date(Date.now() + (3 + 2 * slot++) * 60 * 60_000)
  start.setSeconds(0, 0)
  const r = await hostApi.req('POST', '/meetings', {
    title, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 60 * 60_000).toISOString(),
    employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false, ...extra,
  })
  if (r.status !== 201) throw new Error(`meeting not created: ${r.status} ${JSON.stringify(r.data)}`)
  const row = sql(`SELECT MeetingId FROM mtg.Meetings WHERE PublicId = '${r.data.id}'`)[0]
  return { id: r.data.id, mid: row.MeetingId }
}
/** Test shortcut: the meeting "took place" 10:00-10:45 IST today (host attended, Esha did not). */
function markHeld(mid) {
  exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualStartUtc = DATEADD(MINUTE, -90, SYSUTCDATETIME()), ActualEndUtc = DATEADD(MINUTE, -45, SYSUTCDATETIME()) WHERE MeetingId = ${mid};
        INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, LeftUtc)
        SELECT ${mid}, p.ParticipantId, DATEADD(MINUTE, -90, SYSUTCDATETIME()), DATEADD(MINUTE, -45, SYSUTCDATETIME())
        FROM mtg.MeetingParticipants p WHERE p.MeetingId = ${mid} AND p.[Role] = 'HOST';`)
}

const team = await meeting(`Minutes E2E team ${stamp}`)
markHeld(team.mid)
const upcoming = await meeting(`Minutes E2E upcoming ${stamp}`)
const empty = await meeting(`Minutes E2E empty ${stamp}`)
markHeld(empty.mid)
const cust = await hostApi.req('POST', '/customers', { customerRef: `MOM${Date.now().toString().slice(-8)}`, fullName: 'Kavya Customer', email: 'kavya.customer@example.test' })
if (cust.status !== 201 && cust.status !== 200) throw new Error(`customer not created: ${cust.status} ${JSON.stringify(cust.data)}`)
const customerMeeting = await meeting(`Minutes E2E customer ${stamp}`, { category: 'CUSTOMER_PLVC', customerId: cust.data.id, prarambhMainId: '4455667788' })
markHeld(customerMeeting.mid)
log(`team ${team.id} upcoming ${upcoming.id} empty ${empty.id} customer ${customerMeeting.id}`)

const base = (m) => `/meetings/${m.id}/minutes`
let host, emp, adminPage
let v1Decisions = 'Renewal quote to be sent at the current premium.'

// ---- Cases -----------------------------------------------------------------------------------------------------------
await tc('MM-01', 'Off by default; only an administrator switches it on; audited',
  '/room-features meetingMinutes=false; minutes API 403 FEATURE_DISABLED; meeting page shows no minutes card; host cannot switch it; admin can (audited)', async () => {
    const f = (await new Api().req('GET', '/room-features')).data
    check(f.meetingMinutes === false, `default ${JSON.stringify(f)}`)
    const off = await hostApi.req('GET', base(team))
    check(off.status === 403 && off.data?.code === 'FEATURE_DISABLED', `GET while off ${off.status} ${JSON.stringify(off.data)}`)
    host = await newPage('host')
    await loginUI(host, HOST)
    await host.goto(`/meetings/${team.id}`)
    await host.getByRole('heading', { name: new RegExp(`Minutes E2E team`) }).first().waitFor()
    await sleep(1500)
    check(!(await host.getByTestId('minutes-card').isVisible().catch(() => false)), 'minutes card visible while the feature is off')
    const denied = await hostApi.req('PUT', '/admin/features/MEETING_MINUTES', { enabled: true })
    check(denied.status === 403, `host switching ${denied.status}`)
    const auditBefore = Number(scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'FEATURE_SETTING_CHANGED' AND EntityId = 'MEETING_MINUTES'"))
    const on = await admin.req('PUT', '/admin/features/MEETING_MINUTES', { enabled: true })
    check(on.status === 204, `admin switching ${on.status}`)
    check((await new Api().req('GET', '/room-features')).data.meetingMinutes === true, 'not on after switching')
    const audits = Number(scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'FEATURE_SETTING_CHANGED' AND EntityId = 'MEETING_MINUTES'")) - auditBefore
    check(audits === 1, `audit rows ${audits}`)
    return 'off by default (API 403 FEATURE_DISABLED, no card on the meeting page); host 403; admin switched it on; 1 audit row'
  })

await tc('MM-02', 'Not before the meeting has started', 'Upcoming meeting: canCreate=false and a save is refused (409)', async () => {
  const g = await hostApi.req('GET', base(upcoming))
  check(g.status === 200 && g.data.canCreate === false && g.data.writableMeeting === false, `GET ${g.status} ${JSON.stringify(g.data).slice(0, 200)}`)
  const s = await hostApi.req('PUT', base(upcoming), { baseVersion: 0, discussionSummary: 'x', actionItems: [] })
  check(s.status === 409, `save ${s.status} ${JSON.stringify(s.data)}`)
  return `canCreate=false; save → ${s.status} "${s.data?.detail}"`
})

await tc('MM-03', 'A participant who is not host/organiser/co-host cannot write minutes', 'Esha (Employee, attendee): canCreate=false; save 403; no card on her meeting page', async () => {
  const g = await empApi.req('GET', base(team))
  check(g.status === 200 && g.data.canCreate === false && g.data.minutes === null, `GET ${JSON.stringify(g.data).slice(0, 200)}`)
  const s = await empApi.req('PUT', base(team), { baseVersion: 0, discussionSummary: 'attempt', actionItems: [] })
  check(s.status === 403, `save ${s.status}`)
  return 'canCreate=false; save 403'
})

await tc('MM-04', 'Host writes the minutes on the meeting page (draft, version 1)',
  'Card "Write minutes" → form; meeting facts filled in from the record (ID, host, attendance); summary (incl. Hindi), decisions, pending, follow-up, 2 action items (one assigned to Esha, due date, High) → "Create draft" → Draft v1; DB: 2 items, version 1 CREATED, audit MINUTES_CREATED', async () => {
    await host.goto(`/meetings/${team.id}`)
    await host.getByTestId('minutes-card').waitFor()
    await view(host, 'card-empty')
    await host.getByTestId('minutes-open').click()
    await host.getByTestId('minutes-form').waitFor()
    const facts = await host.getByTestId('minutes-facts').innerText()
    const code = scalar(`SELECT MeetingCode AS v FROM mtg.Meetings WHERE MeetingId = ${team.mid}`)
    check(facts.includes(code) && facts.includes('Hema Host') && /Attended/.test(facts) && /Did not join/.test(facts), `facts: ${facts.slice(0, 400)}`)
    check(!(await host.getByTestId('mom-requirements').isVisible().catch(() => false)), 'customer requirements shown for an internal meeting')
    await host.getByTestId('mom-summary').fill(`Reviewed the renewal pipeline for November.\n${HINDI}`)
    await host.getByTestId('mom-decisions').fill(v1Decisions)
    await host.getByTestId('mom-pending').fill('Claims team to confirm the two open cases.')
    await host.getByTestId('mom-followup').fill('2026-11-28')
    await host.getByTestId('mom-add-item').click()
    await host.getByTestId('mom-add-item').click()
    const items = host.getByTestId('mom-item')
    await items.nth(0).getByTestId('mom-item-desc').fill('Send the renewal quote to the customer')
    await items.nth(0).getByPlaceholder('Search employee').fill('Esha')
    await host.getByRole('option', { name: /Esha/ }).first().click()
    await items.nth(0).getByTestId('mom-item-due').fill('2026-11-20')
    await items.nth(0).getByTestId('mom-item-priority').selectOption('HIGH')
    await items.nth(1).getByTestId('mom-item-desc').fill('Update the claims tracker')
    await view(host, 'editor')
    check((await statusText(host)).includes('Unsaved changes'), 'no unsaved-changes marker')
    await host.getByTestId('minutes-save').click()
    await until(async () => /Draft – pending approval/.test(await statusText(host)) && /version 1/.test(await statusText(host)), 'not saved as Draft v1')
    const db = sql(`SELECT mm.[Status], mm.[Version], (SELECT COUNT(*) FROM mtg.MeetingMinutesActionItems i WHERE i.MinutesId = mm.MinutesId) AS Items,
      (SELECT COUNT(*) FROM mtg.MeetingMinutesActionItems i JOIN org.Employees e ON e.EmployeeId = i.AssignedEmployeeId WHERE i.MinutesId = mm.MinutesId AND e.EmployeeCode = 'RM-0002' AND i.[Priority] = 'HIGH' AND i.DueDate = '2026-11-20') AS EshaHigh,
      (SELECT STRING_AGG([Action], ',') FROM mtg.MeetingMinutesVersions v WHERE v.MinutesId = mm.MinutesId) AS Versions,
      CASE WHEN mm.DiscussionSummary LIKE N'%${HINDI}%' THEN 1 ELSE 0 END AS HindiKept
      FROM mtg.MeetingMinutes mm WHERE mm.MeetingId = ${team.mid}`)[0]
    check(scalar(`SELECT CONVERT(VARCHAR(10), FollowUpDate, 23) AS v FROM mtg.MeetingMinutes WHERE MeetingId = ${team.mid}`) === '2026-11-28', 'follow-up date changed on save')
    check(db && db.Status === 'DRAFT' && db.Version === 1 && db.Items === 2 && db.EshaHigh === 1 && db.Versions === 'CREATED' && db.HindiKept === 1, `db ${JSON.stringify(db)}`)
    const audit = Number(scalar(`SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'MINUTES_CREATED' AND Summary LIKE N'%${code}%'`))
    check(audit === 1, `audit ${audit}`)
    await view(host, 'draft-v1')
    return `facts from the record (code ${code}, host, attended / did not join); Draft v1 saved with 2 action items (Esha, High, due 20 Nov); Hindi text stored intact; version CREATED; audit MINUTES_CREATED`
  })

await tc('MM-05', 'A draft is private to the writers and approvers', 'Esha: minutes=null, draftInProgress=true, history 403; her page says the minutes are being written', async () => {
  const g = await empApi.req('GET', base(team))
  check(g.data.minutes === null && g.data.draftInProgress === true, `GET ${JSON.stringify(g.data).slice(0, 200)}`)
  const h = await empApi.req('GET', `${base(team)}/versions`)
  check(h.status === 403, `history ${h.status}`)
  emp = await newPage('esha')
  await loginUI(emp, EMP)
  await emp.goto(`/meetings/${team.id}`)
  await emp.getByTestId('minutes-card').waitFor()
  const t = await emp.getByTestId('minutes-card').innerText()
  check(/preparing the minutes/.test(t), `card text ${t}`)
  check(!(await emp.getByTestId('minutes-open').isVisible().catch(() => false)), 'Esha can open a draft')
  return 'draft hidden from Esha (API and page); history 403'
})

await tc('MM-06', 'Editing saves a new version; earlier versions stay readable', 'Host changes decisions and an item status → Save draft → v2; history lists v2 SAVED and v1 CREATED; v1 still shows the old decisions', async () => {
  await host.getByTestId('mom-decisions').fill('Renewal quote approved with a 5% loyalty discount.')
  await host.getByTestId('mom-item').nth(1).getByTestId('mom-item-status').selectOption('IN_PROGRESS')
  await host.getByTestId('minutes-save').click()
  await until(async () => /version 2/.test(await statusText(host)), 'not saved as v2')
  await host.getByTestId('minutes-history').click()
  const list = host.getByTestId('minutes-history-list')
  await until(async () => /Version 2 · Saved/.test(await list.innerText()) && /Version 1 · Created/.test(await list.innerText()), 'history entries missing')
  await list.getByRole('button', { name: /Version 1 · Created/ }).click()
  await until(async () => (await host.getByTestId('minutes-history-version').innerText()).includes(v1Decisions), 'v1 content not shown')
  await view(host, 'history')
  await host.keyboard.press('Escape')
  return 'v2 saved; history shows v2 Saved and v1 Created; v1 still shows the original decisions'
})

await tc('MM-07', 'Two people editing at once cannot overwrite each other', 'A save based on version 1 after v2 exists → 409 CONFLICT; nothing changed', async () => {
  const r = await hostApi.req('PUT', base(team), { baseVersion: 1, discussionSummary: 'stale overwrite', actionItems: [] })
  check(r.status === 409, `stale save ${r.status}`)
  const v = Number(scalar(`SELECT [Version] AS v FROM mtg.MeetingMinutes WHERE MeetingId = ${team.mid}`))
  check(v === 2, `version ${v}`)
  return `409 "${r.data?.detail}"; still version 2`
})

await tc('MM-08', 'Input checks', 'Action item without text → 400 with a field error; unknown assignee → 400; approving empty minutes → 400', async () => {
  const a = await hostApi.req('PUT', base(empty), { baseVersion: 0, actionItems: [{ description: '  ' }] })
  check(a.status === 400 && a.data?.errors?.['actionItems[0].description'], `blank item ${a.status} ${JSON.stringify(a.data)}`)
  const b = await hostApi.req('PUT', base(empty), { baseVersion: 0, actionItems: [{ description: 'x', assigneeId: '00000000-0000-0000-0000-000000000001' }] })
  check(b.status === 400 && b.data?.errors?.['actionItems[0].assigneeId'], `bad assignee ${b.status} ${JSON.stringify(b.data)}`)
  const bad = await hostApi.req('PUT', base(empty), { baseVersion: 0, followUpDate: '2026-02-30', actionItems: [] })
  check(bad.status === 400 && bad.data?.errors?.followUpDate, `impossible date ${bad.status} ${JSON.stringify(bad.data)}`)
  const c = await hostApi.req('PUT', base(empty), { baseVersion: 0, actionItems: [] })
  check(c.status === 200, `empty draft ${c.status}`)
  const d = await admin.req('POST', `${base(empty)}/approve`, { version: 1 })
  check(d.status === 400, `approve empty ${d.status} ${JSON.stringify(d.data)}`)
  // Calendar dates must come back exactly as entered, however often they are saved (no time-zone shift).
  let ver = 1
  for (let i = 0; i < 3; i++) {
    const s = await hostApi.req('PUT', base(empty), { baseVersion: ver, followUpDate: '2026-11-28', actionItems: [{ description: 'date check', dueDate: '2026-11-20' }] })
    check(s.status === 200, `date save ${s.status} ${JSON.stringify(s.data)}`)
    ver = s.data.version
  }
  const g = (await hostApi.req('GET', base(empty))).data.minutes
  check(g.followUpDate === '2026-11-28' && g.actionItems[0].dueDate === '2026-11-20', `dates after 3 saves: ${g.followUpDate} / ${g.actionItems[0].dueDate}`)
  return 'blank item 400; unknown assignee 400; 30 Feb 400; empty minutes cannot be approved (400); dates unchanged after 3 saves (28 Nov / 20 Nov)'
})

await tc('MM-09', 'Only an approver can approve; approved minutes are read-only',
  'Host (Employee role) and Esha cannot approve (403); Super Admin approves on the page → Approved v3; edit form gone; save 409; audit MINUTES_APPROVED', async () => {
    const h = await hostApi.req('POST', `${base(team)}/approve`, { version: 2 })
    const e = await empApi.req('POST', `${base(team)}/approve`, { version: 2 })
    check(h.status === 403 && e.status === 403, `host ${h.status} esha ${e.status}`)
    adminPage = await newPage('admin')
    await loginUI(adminPage, ADMIN)
    await adminPage.goto(`/meetings/${team.id}/minutes`)
    await adminPage.getByTestId('minutes-approve').click()
    await adminPage.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()
    await until(async () => /Approved by/.test(await statusText(adminPage)) && /version 3/.test(await statusText(adminPage)), 'not approved')
    check(!(await adminPage.getByTestId('minutes-form').isVisible().catch(() => false)), 'form still shown after approval')
    await adminPage.getByTestId('minutes-view').waitFor()
    const s = await hostApi.req('PUT', base(team), { baseVersion: 3, discussionSummary: 'after approval', actionItems: [] })
    check(s.status === 409, `save after approval ${s.status}`)
    check(Number(scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'MINUTES_APPROVED'")) >= 1, 'no audit')
    await view(adminPage, 'approved')
    return 'host/Esha 403; Super Admin approved → v3, read-only (form gone, save 409); audited'
  })

await tc('MM-10', 'Approved minutes are visible to every participant', 'Esha now sees the minutes read-only (summary, Hindi text, action items) and the card says Approved', async () => {
  await emp.goto(`/meetings/${team.id}`)
  await until(async () => /Approved/.test(await emp.getByTestId('minutes-card').innerText()), 'card not Approved for Esha')
  await emp.getByTestId('minutes-open').click()
  await emp.getByTestId('minutes-view').waitFor()
  const t = await emp.getByTestId('minutes-page').innerText()
  check(t.includes(HINDI) && t.includes('Send the renewal quote') && t.includes('Esha Employee') && !(await emp.getByTestId('minutes-form').isVisible().catch(() => false)), `page ${t.slice(0, 300)}`)
  check(!(await emp.getByTestId('minutes-reopen').isVisible().catch(() => false)) && !(await emp.getByTestId('minutes-history').isVisible().catch(() => false)), 'Esha sees reopen/history')
  await view(emp, 'participant-approved')
  return 'Esha reads the approved minutes (Hindi intact); no edit, reopen or history for her'
})

await tc('MM-11', 'Print / Save as PDF', 'The print document contains the meeting facts, all sections, "Not specified" for empty ones and the action items; rendered to a PDF file as evidence', async () => {
  await emp.getByTestId('minutes-print').click()
  const html = await until(() => emp.evaluate(() => document.querySelector('[data-testid="minutes-print-frame"]')?.contentDocument?.documentElement?.outerHTML ?? ''), 'no print frame')
  const code = scalar(`SELECT MeetingCode AS v FROM mtg.Meetings WHERE MeetingId = ${team.mid}`)
  for (const s of [code, 'Minutes of meeting', 'Approved', HINDI, 'Send the renewal quote', 'Esha Employee', 'High', 'Discussion summary', 'Action items', 'not generated by AI'])
    check(html.includes(s), `print document lacks "${s}"`)
  const pdfPage = await (await browsers[browsers.length - 1].newContext()).newPage()
  await pdfPage.setContent(html, { waitUntil: 'load' })
  const pdf = path.join(RESULTS, 'minutes-sample.pdf')
  await pdfPage.pdf({ path: pdf, format: 'A4', printBackground: true })
  await pdfPage.screenshot({ path: path.join(SHOTS, 'view-minutes-print.png'), fullPage: true })
  const size = fs.statSync(pdf).size
  check(size > 5000, `pdf ${size} B`)
  return `print document complete (code ${code}, Hindi, items, AI disclaimer); PDF written (${Math.round(size / 1024)} KB): results/minutes-sample.pdf`
})

await tc('MM-12', 'Reopening needs a reason and a new approval', 'Esha cannot reopen (403); host reopens on the page with a reason → Draft v4; history shows v3 Approved and v4 Reopened with the reason; audited', async () => {
  const e = await empApi.req('POST', `${base(team)}/reopen`, { version: 3, reason: 'try' })
  check(e.status === 403, `Esha reopen ${e.status}`)
  const noReason = await hostApi.req('POST', `${base(team)}/reopen`, { version: 3, reason: ' ' })
  check(noReason.status === 400, `no reason ${noReason.status}`)
  await host.goto(`/meetings/${team.id}/minutes`)
  await host.getByTestId('minutes-reopen').click()
  await host.getByTestId('minutes-reopen-reason').fill('Customer asked to add the nominee change')
  await host.getByTestId('minutes-reopen-confirm').click()
  await until(async () => /Draft – pending approval/.test(await statusText(host)) && /version 4/.test(await statusText(host)), 'not reopened as v4')
  await host.getByTestId('minutes-form').waitFor()
  const v = sql(`SELECT v.[Version], v.[Action], v.Note FROM mtg.MeetingMinutesVersions v JOIN mtg.MeetingMinutes mm ON mm.MinutesId = v.MinutesId WHERE mm.MeetingId = ${team.mid}`).sort((a, b) => a.Version - b.Version)
  check(v.map((x) => x.Action).join(',') === 'CREATED,SAVED,APPROVED,REOPENED' && v[3].Note === 'Customer asked to add the nominee change', `versions ${JSON.stringify(v)}`)
  check(Number(scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'MINUTES_REOPENED'")) >= 1, 'no audit')
  const after = await empApi.req('GET', base(team))
  check(after.data.minutes === null && after.data.draftInProgress === true, 'Esha still sees the reopened draft')
  return 'Esha 403; empty reason 400; host reopened → Draft v4; history CREATED,SAVED,APPROVED,REOPENED (reason kept); Esha no longer sees it until re-approved'
})

await tc('MM-13', 'Customer meeting: customer and Prarambh Main ID from the record; customer requirements box', 'Facts show Kavya Customer and 4455667788; the Customer requirements field is offered and saved', async () => {
  await host.goto(`/meetings/${customerMeeting.id}/minutes`)
  await host.getByTestId('minutes-form').waitFor()
  const facts = await host.getByTestId('minutes-facts').innerText()
  check(facts.includes('Kavya Customer') && facts.includes('4455667788'), `facts ${facts.slice(0, 300)}`)
  await host.getByTestId('mom-requirements').fill('Wants the policy schedule by e-mail.')
  await host.getByTestId('mom-summary').fill('PLVC completed; customer confirmed the details.')
  await host.getByTestId('minutes-save').click()
  await until(async () => /version 1/.test(await statusText(host)), 'not saved')
  check(scalar(`SELECT CustomerRequirements AS v FROM mtg.MeetingMinutes WHERE MeetingId = ${customerMeeting.mid}`) === 'Wants the policy schedule by e-mail.', 'requirements not stored')
  await view(host, 'customer')
  return 'customer name and Prarambh Main ID filled in from the meeting; customer requirements saved'
})

await tc('MM-14', 'Phone layout (390 px)', 'Minutes page (editor and read-only) has no horizontal scrolling', async () => {
  await host.setViewportSize({ width: 390, height: 844 })
  await host.goto(`/meetings/${team.id}/minutes`)
  await host.getByTestId('minutes-form').waitFor()
  await sleep(500)
  const a = await overflow(host)
  // The floating Save bar must sit above the phone tab bar, not behind it.
  const gap = await host.evaluate(() => {
    const bar = document.querySelector('[data-testid="minutes-save"]')?.getBoundingClientRect()
    const tab = document.querySelector('[data-testid="mobile-tabbar"]')?.getBoundingClientRect()
    return bar && tab ? tab.top - bar.bottom : null
  })
  check(gap !== null && gap >= 0, `save button covered by the tab bar (gap ${gap}px)`)
  await host.screenshot({ path: path.join(SHOTS, 'view-minutes-phone-savebar.png') })
  await view(host, 'phone-editor')
  await adminPage.setViewportSize({ width: 390, height: 844 })
  await adminPage.goto(`/meetings/${customerMeeting.id}/minutes`)
  await adminPage.getByTestId('minutes-page').waitFor()
  await sleep(500)
  const b = await overflow(adminPage)
  await view(adminPage, 'phone-view')
  check(a <= 1 && b <= 1, `overflow editor ${a}px, view ${b}px`)
  return `no horizontal overflow (editor ${a}px, other page ${b}px); Save button ${Math.round(gap)}px above the phone tab bar`
})

await tc('MM-15', 'Switching it off hides it but keeps the data; emergency switch also stops it; no access without sign-in',
  'Off → API 403 and no card; data rows unchanged; on again → minutes back; emergency → 403; anonymous → 401', async () => {
    const rowsBefore = Number(scalar('SELECT COUNT(*) AS v FROM mtg.MeetingMinutes'))
    await admin.req('PUT', '/admin/features/MEETING_MINUTES', { enabled: false })
    const off = await hostApi.req('GET', base(team))
    check(off.status === 403, `off ${off.status}`)
    await host.setViewportSize({ width: 1366, height: 900 })
    await host.goto(`/meetings/${team.id}`)
    await host.getByTestId('meeting-recordings').or(host.getByText('Participants').first()).first().waitFor().catch(() => {})
    await sleep(1500)
    check(!(await host.getByTestId('minutes-card').isVisible().catch(() => false)), 'card visible while off')
    check(Number(scalar('SELECT COUNT(*) AS v FROM mtg.MeetingMinutes')) === rowsBefore, 'rows changed')
    await admin.req('PUT', '/admin/features/MEETING_MINUTES', { enabled: true })
    const back = await hostApi.req('GET', base(team))
    check(back.status === 200 && back.data.minutes?.version === 4, `back ${back.status}`)
    await admin.req('PUT', '/admin/features/EMERGENCY_DISABLE', { enabled: true })
    const em = await hostApi.req('GET', base(team))
    await admin.req('PUT', '/admin/features/EMERGENCY_DISABLE', { enabled: false })
    check(em.status === 403, `emergency ${em.status}`)
    const anon = await new Api().req('GET', base(team))
    check(anon.status === 401, `anonymous ${anon.status}`)
    return `off: 403 + no card, ${rowsBefore} minutes rows kept; on: version 4 back; emergency: 403; anonymous: 401`
  })

await tc('MM-16', 'Admin page lists the new switch', '"Minutes of meeting" switch on Organisation → System → Meeting features', async () => {
  await adminPage.setViewportSize({ width: 1366, height: 900 })
  await adminPage.goto('/meeting-features')
  await adminPage.getByTestId('feature-MEETING_MINUTES').waitFor()
  await view(adminPage, 'admin-switch')
  return 'switch shown'
})

exec("UPDATE app.FeatureSettings SET IsEnabled = 0 WHERE FeatureKey IN ('MEETING_MINUTES', 'EMERGENCY_DISABLE')") // shipped state
for (const b of browsers) await b.close().catch(() => {})
const passed = results.filter((r) => r.result === 'PASS').length
const summary = { runUtc: new Date().toISOString(), web: WEB, database: DB, passed, failed: results.length - passed, results }
fs.writeFileSync(path.join(RESULTS, 'minutes-results.json'), JSON.stringify(summary, null, 2))
fs.writeFileSync(path.join(RESULTS, 'minutes-results-summary.md'),
  `# Minutes of meeting E2E — ${summary.runUtc}\n\n${passed} passed, ${summary.failed} failed (Edge headless; meetings marked as held in the test database)\n\n| Id | Case | Result | Actual |\n|---|---|---|---|\n` +
  results.map((r) => `| ${r.id} | ${r.title} | ${r.result} | ${String(r.actual).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n') + '\n')
log(`${passed} passed, ${summary.failed} failed`)
process.exit(summary.failed === 0 ? 0 : 1)
