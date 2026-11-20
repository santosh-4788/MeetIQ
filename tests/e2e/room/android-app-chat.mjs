// Android app + Chat (20 Nov 2026): the app shows this website in a WebView with the `window.OicAndroid` bridge.
// Here: an Android-app-sized page (the app's user agent and a fake bridge, as in android-app-present.mjs) as Esha.
// Checks: Chat, My Day, Notes and Tasks fit the app screen; an incoming chat call is answered in the app and the app is
// told to keep the microphone alive in the background ({type:"inMeeting", on:true}, then on:false after hanging up);
// a reminder pops up inside the app. Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, LiveKit 7890).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\android-app-chat.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 8 min'); process.exit(2) }, 8 * 60_000).unref()
import { Api, EMP, HOST, check, closeAll, exec, loginUI, newPage, overflowX, scalar, sleep, tc, until, view, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS')")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
exec("UPDATE chat.TRN_ChatReminder SET [State] = 'DISMISSED', AcknowledgedUtc = SYSUTCDATETIME() WHERE [State] = 'FIRED' AND AcknowledgedUtc IS NULL")
const tag = Date.now().toString(36).slice(-5)
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 OneInsureConnectApp/1.0.0'

const hemaApi = await new Api().login(HOST.email)
const eshaApi = await new Api().login(EMP.email)
const eshaId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS id FROM auth.Users WHERE Email = '${EMP.email}'`)
const conv = (await hemaApi.req('POST', '/chat/direct', { userId: eshaId })).data.id

const hema = await newPage({ width: 1366, height: 820 })
await loginUI(hema, HOST.email)
await hema.goto(`/chat?c=${conv}`)
await hema.getByTestId('chat-view').waitFor()

const app = await newPage({ width: 412, height: 860, mobile: true, userAgent: ANDROID_UA, deviceScaleFactor: 2.625 })
await app.addInitScript(() => {
  window.__app = []
  window.OicAndroid = { postMessage: (data) => window.__app.push(JSON.parse(data)), onmessage: null }
})
const appMsgs = () => app.evaluate(() => window.__app)
await loginUI(app, EMP.email)
const ok = {}

ok.screens = await tc('AC-01', 'Chat, My Day, Notes and Tasks inside the app', 'Chat tab in the bottom bar; every section fits the app screen (no sideways scrolling)', async () => {
  await app.getByTestId('mobile-tabbar').getByTestId('tab-chat').click()
  await app.getByTestId('chat-page').waitFor()
  for (const [tab, testId] of [['chats', 'chat-list'], ['myday', 'myday-view'], ['notes', 'notes-view'], ['tasks', 'tasks-view'], ['calls', 'call-history']]) {
    await app.goto(tab === 'chats' ? '/chat' : tab === 'calls' ? '/chat?tab=calls' : tab === 'myday' ? '/my-day' : '/' + tab)
    await app.getByTestId(testId).waitFor()
    check(await overflowX(app) <= 0, `${tab} scrolls sideways in the app`)
    await view(app, `ac01-app-${tab}`)
  }
  return 'all five sections fit'
})

ok.call = await tc('AC-02', 'A chat call answered in the app keeps the microphone alive in the background', 'full-screen incoming call → Accept → connected → bridge gets {type:"inMeeting", on:true}; hang up → {on:false}', async () => {
  await app.goto('/dashboard')
  await hema.getByTestId('chat-call').click()
  const pop = app.getByTestId('call-incoming')
  await pop.waitFor({ timeout: 20_000 })
  await pop.getByTestId('call-accept').click()
  const panel = app.getByTestId('call-panel')
  await until(async () => /\d:\d\d/.test(await panel.getByTestId('call-status').innerText()), 'call not connected in the app', 25_000)
  await until(async () => (await appMsgs()).some((m) => m.type === 'inMeeting' && m.on === true), 'the app was not told to keep the call alive')
  await view(app, 'ac02-app-in-call')
  await panel.getByTestId('call-hangup').click()
  await panel.waitFor({ state: 'detached', timeout: 20_000 })
  await until(async () => (await appMsgs()).some((m) => m.type === 'inMeeting' && m.on === false), 'the app was not told the call ended', 10_000)
  const seq = (await appMsgs()).filter((m) => m.type === 'inMeeting').map((m) => m.on)
  check(seq.join(',') === 'true,false', `unexpected keep-alive messages: ${seq.join(',')}`)
  await hema.getByTestId('call-panel').waitFor({ state: 'detached', timeout: 20_000 })
  return 'inMeeting true then false'
})

ok.remind = await tc('AC-03', 'A reminder pops up inside the app and Complete works', 'reminder due now → popup in the app within ~20 s → Complete → task completed', async () => {
  const now = new Date().toISOString()
  const r = await eshaApi.req('POST', '/chat/tasks', { title: `App reminder ${tag}`, dueUtc: now, hasDueTime: true, reminderUtc: now })
  check(r.status === 200 || r.status === 201, `create: ${r.status}`)
  const pop = app.getByTestId('reminder-popup').filter({ hasText: `App reminder ${tag}` })
  await pop.waitFor({ timeout: 35_000 })
  await sleep(300)
  await view(app, 'ac03-app-reminder')
  await pop.getByTestId('reminder-complete').click()
  await until(() => scalar(`SELECT [Status] AS s FROM chat.TRN_ChatTask WHERE Title = 'App reminder ${tag}'`) === 'COMPLETED', 'not completed')
  return 'popup shown in the app; completed'
})

await closeAll()
writeResults('android-app-chat')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
