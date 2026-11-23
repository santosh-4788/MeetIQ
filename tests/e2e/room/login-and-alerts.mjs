// 23 Nov 2026 request: employee logins with a shared default password (change required at first sign-in), staying signed in
// until 23:30 (or Log out), and live popups for chat messages, calls and assigned tasks on computers, phones and in the Android
// app. The test makes its own made-up employee (no real staff data, test-only default password).
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, LiveKit 7890).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\login-and-alerts.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 9 min'); process.exit(2) }, 9 * 60_000).unref()
import crypto from 'node:crypto'
import path from 'node:path'
import { Api, EMP, HOST, PASSWORD, SHOTS, check, closeAll, exec, loginUI, newPage, overflowX, scalar, sleep, tc, until, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS', 'TASK_COLLAB')")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
exec("UPDATE chat.MST_ChatUserPreference SET Availability = 'AVAILABLE', QuietEnabled = 0 WHERE UserId IN (SELECT UserId FROM auth.Users WHERE Email IN ('hema.host@room.oneinsure.test', 'esha.employee@room.oneinsure.test'))")
// A made-up employee created the way the account script does it (employee code as login ID, shared default password stored
// as a hash, change required), put back into its first-sign-in state on every run.
const NEW = { code: 'XL-TEST-01', email: 'xl.tester@room.oneinsure.test', name: 'Excel Tester' }
const DEFAULT_PW = 'Default#Start1' // test database only
// Hash in the API's format (ASP.NET Identity v3: HMACSHA512, 100000 iterations, 16-byte salt).
const firstHash = (() => {
  const salt = crypto.randomBytes(16), sub = crypto.pbkdf2Sync(Buffer.from(DEFAULT_PW), salt, 100000, 32, 'sha512')
  const head = Buffer.alloc(13); head[0] = 1; head.writeUInt32BE(2, 1); head.writeUInt32BE(100000, 5); head.writeUInt32BE(16, 9)
  return Buffer.concat([head, salt, sub]).toString('base64')
})()
exec(`IF NOT EXISTS (SELECT 1 FROM org.Employees WHERE EmployeeCode = '${NEW.code}')
  INSERT org.Employees (EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, DepartmentId, DesignationId, IsActive)
  SELECT '${NEW.code}', N'Excel', N'Tester', N'${NEW.name}', N'${NEW.email}', DepartmentId, DesignationId, 1 FROM org.Employees WHERE OfficialEmail = '${EMP.email}';
IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Email = '${NEW.email}')
BEGIN
  INSERT auth.Users (Email, EmployeeId, PasswordHash, PasswordChangedUtc, MustChangePassword)
  SELECT N'${NEW.email}', EmployeeId, '${firstHash}', SYSUTCDATETIME(), 1 FROM org.Employees WHERE EmployeeCode = '${NEW.code}';
  INSERT auth.UserRoles (UserId, RoleId) SELECT u.UserId, r.RoleId FROM auth.Users u CROSS JOIN auth.Roles r WHERE u.Email = '${NEW.email}' AND r.Code = 'Employee';
END`)
const tag = Date.now().toString(36).slice(-5)
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 OneInsureConnectApp/1.2.2'
const ok = {}

// The live connection starts after the page loads: wait for it (signalr negotiate + a little time).
const settle = (page) => page.waitForTimeout(3500)

// A page whose "tab visible / in the background" can be switched by the test (document.visibilityState).
async function withVisibility(page) {
  await page.addInitScript(() => {
    window.__vis = 'visible'
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => window.__vis })
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__vis === 'hidden' })
    window.__setVis = (v) => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')) }
  })
}

ok.login = await tc('LA-01', 'New employee signs in with the employee code and the default password, must pick a new password, then is in',
  'Login code / default password → change-password page → new password → dashboard; e-mail works as login ID too', async () => {
    exec(`UPDATE auth.Users SET PasswordHash = '${firstHash}', MustChangePassword = 1, FailedLoginCount = 0, LockoutEndUtc = NULL WHERE Email = '${NEW.email}'`)
    const p = await newPage({ width: 1280, height: 800 })
    await p.goto('/login')
    check((await p.getByTestId('login-stay-note').innerText()).includes('11:30 PM'), 'no "stay signed in" note')
    await p.getByLabel('Official Email / Employee ID').fill(NEW.code)
    await p.getByLabel('Password', { exact: true }).fill(DEFAULT_PW)
    await p.getByRole('button', { name: 'Sign In' }).click()
    await p.waitForURL(/change-password/, { timeout: 20_000 })
    await p.getByLabel('Current password').fill(DEFAULT_PW)
    await p.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await p.getByLabel('Confirm new password').fill(PASSWORD)
    await p.getByRole('button', { name: 'Update password' }).click()
    await p.getByText('Password changed').waitFor({ timeout: 15_000 })
    await p.getByRole('button', { name: 'Continue' }).click()
    await until(async () => !/change-password|login/.test(p.url()), 'not in the portal after the change', 20_000)
    check(scalar(`SELECT CAST(MustChangePassword AS int) AS v FROM auth.Users WHERE Email = '${NEW.email}'`) === 0, 'change not recorded')
    const mail = new Api(); await mail.req('GET', '/health')
    const viaEmail = await mail.req('POST', '/auth/login', { login: NEW.email, password: PASSWORD, rememberMe: false })
    check(viaEmail.status === 200, `e-mail login ${viaEmail.status}`)
    // Back to the first-sign-in state so the next run starts the same way.
    exec(`UPDATE auth.Users SET PasswordHash = '${firstHash}', MustChangePassword = 1 WHERE Email = '${NEW.email}'`)
    return 'code + default password → forced change → in; e-mail login works'
  })

ok.persist = await tc('LA-02', 'Signed in stays signed in after closing and reopening the browser (until 23:30 IST)',
  'session cookie is persistent and expires at the next 23:30 IST; a new browser with the saved cookies opens the dashboard without signing in', async () => {
    const p = await newPage({ width: 1280, height: 800 })
    await loginUI(p, EMP.email)
    const cookie = (await p.context().cookies()).find((c) => c.name === 'oic_session')
    check(cookie && cookie.expires > 0, 'session cookie ends when the browser closes')
    const until = new Date(cookie.expires * 1000)
    const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(until)
    check(ist === '23:30', `cookie expires at ${ist} IST, not 23:30`)
    check(until.getTime() - Date.now() <= 24 * 3600_000 + 60_000, 'cookie lasts longer than the next cutoff')
    const state = await p.context().storageState()
    await p.context().browser().close()
    // "Reopen the browser": a fresh browser with only what was saved on disk.
    const q = await newPage({ width: 1280, height: 800 })
    await q.context().addCookies(state.cookies.filter((c) => c.expires > 0))
    await q.goto('/dashboard')
    await q.waitForTimeout(1500)
    check(!/\/login/.test(q.url()), 'sent back to sign in after reopening')
    await q.reload()
    check(!/\/login/.test(q.url()), 'sent back to sign in after a refresh')
    return `persistent cookie until ${ist} IST; reopened browser stays signed in`
  })

// Esha on the dashboard (computer) and Esha in the Android app (phone size) for the popup tests.
const hemaApi = await new Api().login(HOST.email)
const eshaApi = await new Api().login(EMP.email)
const eshaId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS v FROM auth.Users WHERE Email = '${EMP.email}'`)
const conv = (await hemaApi.req('POST', '/chat/direct', { userId: eshaId })).data.id
const say = (text) => hemaApi.req('POST', `/chat/conversations/${conv}/messages`, { body: text, clientMessageId: crypto.randomUUID() })

const desk = await newPage({ width: 1366, height: 820 })
await withVisibility(desk)
await loginUI(desk, EMP.email)
await desk.goto('/meetings')
await settle(desk)

ok.msg = await tc('LA-03', 'Chat message popup on another page (computer)', 'Esha on Meetings; Hema writes → banner with Hema\'s name and the text; tap → that chat opens; no banner while the chat is open', async () => {
    const text = `Hello from the meetings test ${tag}`
    check((await say(text)).status === 200, 'send failed')
    const b = desk.getByTestId('message-alert')
    await b.waitFor({ timeout: 15_000 })
    check((await b.getByTestId('message-alert-sender').innerText()).includes(HOST.name), 'no sender name')
    check((await b.getByTestId('message-alert-text').innerText()).includes(text), 'no message text')
    await desk.screenshot({ path: path.join(SHOTS, 'view-la03-message-popup.png') })
    await b.getByTestId('message-alert-open').click()
    await desk.getByTestId('chat-view').waitFor()
    check(desk.url().includes(conv), 'did not open that chat')
    await say(`Second one while open ${tag}`)
    await sleep(2500)
    check((await desk.getByTestId('message-alert').count()) === 0, 'banner shown for the open chat')
    return 'banner on Meetings; opens the chat; none while it is open'
  })

ok.task = await tc('LA-04', 'Task assigned: popup with title, who assigned it, deadline and priority', 'Hema assigns a High task due tomorrow 17:00 → Esha (on Meetings) sees From Hema Host · Due … · High', async () => {
    await desk.goto('/meetings')
    await settle(desk)
    const due = new Date(Date.now() + 86400_000); due.setHours(17, 0, 0, 0)
    const title = `Popup details ${tag}`
    const r = await hemaApi.req('POST', '/chat/tasks', { title, assigneeIds: [eshaId], dueUtc: due.toISOString(), hasDueTime: true, priority: 'HIGH' })
    check(r.status === 200, `assign ${r.status} ${JSON.stringify(r.data)}`)
    const a = desk.getByTestId('task-alert')
    await until(async () => (await a.count()) > 0 && (await a.getByTestId('task-alert-title').innerText()).includes(title), 'no task popup', 15_000)
    const d = await a.getByTestId('task-alert-details').innerText()
    check(d.includes('From') && d.includes(HOST.name), `no assigner: ${d}`)
    check(/Due/.test(d) && /Tomorrow|tomorrow|\d/.test(d), `no deadline: ${d}`)
    check(d.includes('High'), `no priority: ${d}`)
    await desk.screenshot({ path: path.join(SHOTS, 'view-la04-task-popup.png') })
    return d.replace(/\s+/g, ' ')
  })

// Android app (fake bridge records what the page asks the app to do).
const app = await newPage({ width: 412, height: 860, mobile: true, userAgent: ANDROID_UA, deviceScaleFactor: 2 })
await withVisibility(app)
await app.addInitScript(() => {
  window.__app = []
  window.OicAndroid = { postMessage: (d) => window.__app.push(JSON.parse(d)), onmessage: null }
})
const appMsgs = () => app.evaluate(() => window.__app)
await loginUI(app, EMP.email)
await app.goto('/my-day')
await settle(app)

ok.phone = await tc('LA-05', 'Phone: message popup fits the screen; in the background the app gets a phone notification', 'banner inside 412 px; app hidden → {type:"notify"} with sender, text and the chat link, no banner', async () => {
    await say(`Phone visible ${tag}`)
    const b = app.getByTestId('message-alert')
    await b.waitFor({ timeout: 15_000 })
    const box = await b.boundingBox()
    check(box && box.x >= 0 && box.x + box.width <= 412, 'banner wider than the phone')
    check(await overflowX(app) <= 0, 'page scrolls sideways')
    await app.screenshot({ path: path.join(SHOTS, 'view-la05-phone-popup.png') })
    await b.getByTestId('message-alert-dismiss').click()
    await app.evaluate(() => window.__setVis('hidden'))
    const text = `Phone hidden ${tag}`
    await say(text)
    const n = await until(async () => (await appMsgs()).find((m) => m.type === 'notify' && m.body?.includes(text)), 'no phone notification', 15_000)
    check(n.title.includes(HOST.name) && n.link.includes(`/chat?c=${conv}`), `wrong notification ${JSON.stringify(n)}`)
    await app.evaluate(() => window.__setVis('visible'))
    return `notify "${n.title}" → ${n.link.replace(/^https?:\/\/[^/]+/, '')}`
  })

ok.call = await tc('LA-06', 'Incoming call: popup on any page; in the background the app gets a phone notification', 'app hidden → Hema calls → {type:"notify"} "Incoming call from Hema Host"; visible → ringing popup', async () => {
    await app.evaluate(() => window.__setVis('hidden'))
    const r = await hemaApi.req('POST', '/chat/calls', { conversationId: conv })
    check(r.status === 200 || r.status === 201, `call start ${r.status} ${JSON.stringify(r.data)}`)
    const n = await until(async () => (await appMsgs()).find((m) => m.type === 'notify' && /Incoming call from/.test(m.title ?? '')), 'no call notification', 15_000)
    check(n.title.includes(HOST.name), 'no caller name')
    await app.evaluate(() => window.__setVis('visible'))
    await app.getByTestId('call-incoming').waitFor({ timeout: 15_000 })
    await app.getByTestId('call-incoming').getByRole('button', { name: /Decline/i }).click().catch(() => {})
    return `notify "${n.title}"; ringing popup shown`
  })

ok.task2 = await tc('LA-07', 'Phone in the background: task assigned → phone notification with the details', '{type:"notify"} body has From Hema Host and Due', async () => {
    await app.evaluate(() => window.__setVis('hidden'))
    const title = `Phone task ${tag}`
    await hemaApi.req('POST', '/chat/tasks', { title, assigneeIds: [eshaId], dueUtc: new Date(Date.now() + 2 * 86400_000).toISOString(), priority: 'URGENT' })
    const n = await until(async () => (await appMsgs()).find((m) => m.type === 'notify' && m.title?.includes(title)), 'no task notification', 15_000)
    check(n.body.includes(`From ${HOST.name}`) && n.body.includes('Due') && n.body.includes('Urgent'), `body: ${n.body}`)
    await app.evaluate(() => window.__setVis('visible'))
    return n.body.replace(/\n/g, ' | ')
  })

await closeAll()
writeResults('login-and-alerts', { ok })
const passed = Object.values(ok).filter(Boolean).length
console.log(`${passed}/${Object.keys(ok).length} passed`)
process.exit(passed === Object.keys(ok).length ? 0 : 1)
