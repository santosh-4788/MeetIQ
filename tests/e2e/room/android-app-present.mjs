// Android app - phone screen sharing, end to end (19 Nov 2026).
// The real app (mobile/android) shows this website in a WebView; `window.OicAndroid` is its bridge, and on "present" it
// connects to OUR video server with the screen-only token and publishes the phone screen (LiveKit Android).
// Here: an Android-sized page with a fake OicAndroid bridge, and a "native app" page that does exactly what the app does
// with the token the website hands over (connect + publish a screen) - so server, website, permissions and what everyone
// else sees are tested for real. The Android code itself is covered by its unit tests and the device checklist.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\android-app-present.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 8 min'); process.exit(2) }, 8 * 60_000).unref()
import path from 'node:path'
import { Api, EMP, HOST, SHOTS, WEB, check, closeAll, exec, loginUI, newPage, scalar, tc, until, writeResults } from './harness.mjs'

const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const tag = Date.now().toString(36).slice(-5)
const api = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `APP ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status}`)
const meetingId = created.data.id

async function enter(page, email, button) {
  await loginUI(page, email)
  await page.goto(`/meetings/${meetingId}/room`)
  await page.getByRole('button', { name: button }).first().click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}

// The host watches on a computer.
const viewer = await newPage({ width: 1366, height: 800 })
await enter(viewer, HOST.email, /Start meeting|Join|Rejoin/)

// The app user: Android phone size + UA, no browser screen capture (as in the WebView), and the app's bridge.
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 OneInsureConnectApp/1.0.0'
const phone = await newPage({ width: 412, height: 860, mobile: true, userAgent: ANDROID_UA, deviceScaleFactor: 2.625 })
await phone.addInitScript(() => {
  if (navigator.mediaDevices) delete Object.getPrototypeOf(navigator.mediaDevices).getDisplayMedia
  window.__app = []
  window.OicAndroid = {
    postMessage: (data) => window.__app.push(JSON.parse(data)),
    onmessage: null,
  }
  // What the app sends back ("present" state events).
  window.__appSay = (msg) => window.OicAndroid.onmessage && window.OicAndroid.onmessage({ data: JSON.stringify(msg) })
})
const appMsgs = () => phone.evaluate(() => window.__app)
await enter(phone, EMP.email, /Join now|Join|Rejoin/)

let native, presentMsg
const ok = {}

ok.inMeeting = await tc('APP-01', 'In the app, the meeting page tells the app it is in a meeting', 'bridge receives {type:"inMeeting", on:true}', async () => {
  const m = await until(async () => (await appMsgs()).find((x) => x.type === 'inMeeting' && x.on === true), 'no inMeeting message')
  return JSON.stringify(m)
})

ok.button = await tc('APP-02', 'In the app, Present is a working button (not "not available")', 'More → Present (ctl-screen-app); no ctl-present-unsupported', async () => {
  await phone.getByTestId('ctl-more').click()
  await phone.getByTestId('ctl-screen-app').waitFor({ timeout: 5000 })
  check(await phone.getByTestId('ctl-present-unsupported').count() === 0, 'the "not available" button is shown in the app')
  await phone.screenshot({ path: path.join(SHOTS, 'app-01-more-present.png') })
  return 'Present offered in the app'
})

ok.token = ok.button && await tc('APP-03', 'Tapping Present gets a screen-only token from the server and hands it to the app', 'bridge receives {type:"present", url: ws(s)://<our host>/…, token, name}', async () => {
  await phone.getByTestId('ctl-screen-app').click()
  presentMsg = await until(async () => (await appMsgs()).find((x) => x.type === 'present'), 'no present message', 10_000)
  check(/^wss?:\/\/[^/]+/.test(presentMsg.url), `url ${presentMsg.url}`) // absolute (the app accepts only wss://www.oneinsure.com)
  check(presentMsg.name === 'Esha Employee', `name ${presentMsg.name}`)
  const claims = JSON.parse(Buffer.from(presentMsg.token.split('.')[1], 'base64url').toString())
  check(claims.sub.endsWith('.screen'), `identity ${claims.sub}`)
  check(JSON.stringify(claims.video.canPublishSources) === '["screen_share"]' && claims.video.canSubscribe === false && claims.video.canPublishData === false, `grants ${JSON.stringify(claims.video)}`)
  return `token for ${claims.sub}: only screen_share, no subscribe, no data`
})

ok.publish = ok.token && await tc('APP-04', 'The app publishes the phone screen; everyone sees "<name> is presenting", not an extra person', 'viewer: screen view with frames, name Esha Employee; still 2 people; no extra tile', async () => {
  // The "native app": connect with exactly the token the website handed over, publish a screen (fake capture).
  native = await newPage({ width: 412, height: 860 })
  await native.goto('/login')
  const r = await native.evaluate(async ({ url, token }) => {
    const lk = await import('/node_modules/livekit-client/dist/livekit-client.esm.mjs')
    const room = new lk.Room()
    window.__room = room
    await room.connect(url, token)
    await room.localParticipant.setScreenShareEnabled(true)
    return { identity: room.localParticipant.identity }
  }, presentMsg)
  await phone.evaluate(() => window.__appSay({ type: 'present', state: 'PRESENTING' }))
  const v = await until(async () => viewer.evaluate(() => {
    const vid = document.querySelector('[data-testid="video-screen"]')
    return vid && vid.videoWidth > 0 ? { w: vid.videoWidth, h: vid.videoHeight } : null
  }), 'viewer does not see the phone screen', 20_000)
  const chip = await viewer.locator('[data-testid="tile-screen"]').innerText()
  check(/Esha Employee/.test(chip) && /is presenting/.test(chip), `screen chip: ${chip}`)
  const people = await viewer.locator('.oic-chip').filter({ hasText: /^\s*\d+\s*$/ }).first().innerText().catch(() => '')
  check(people.trim() === '2', `people count ${people}`)
  const tiles = await viewer.locator('[data-testid="tile"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-identity')))
  check(!tiles.some((i) => i?.endsWith('.screen')), `phone screen shown as a person tile: ${tiles}`)
  await viewer.screenshot({ path: path.join(SHOTS, 'app-02-viewer-sees-phone-screen.png') })
  return `${r.identity} published; viewer sees ${v.w}x${v.h}, "${chip.replace(/\s+/g, ' ').trim()}", 2 people`
})

ok.limits = ok.publish && await tc('APP-05', 'The screen-only connection cannot do anything else', 'camera/microphone publish refused; it receives nothing from the meeting', async () => {
  const res = await native.evaluate(async () => {
    const room = window.__room
    const out = {}
    try { await room.localParticipant.setCameraEnabled(true); out.camera = 'published' } catch (e) { out.camera = 'refused: ' + (e.name || e.message) }
    try { await room.localParticipant.setMicrophoneEnabled(true); out.mic = 'published' } catch (e) { out.mic = 'refused: ' + (e.name || e.message) }
    await new Promise((r) => setTimeout(r, 2500))
    let subscribed = 0
    room.remoteParticipants.forEach((p) => p.trackPublications.forEach((t) => { if (t.isSubscribed) subscribed++ }))
    out.subscribed = subscribed
    out.camPub = !!room.localParticipant.getTrackPublication('camera')
    return out
  })
  check(res.camera !== 'published' || !res.camPub, `camera allowed: ${JSON.stringify(res)}`)
  check(res.mic !== 'published', `microphone allowed: ${JSON.stringify(res)}`)
  check(res.subscribed === 0, `it receives meeting media: ${JSON.stringify(res)}`)
  return JSON.stringify(res)
})

ok.self = ok.publish && await tc('APP-06', 'The presenter does not see their own phone screen; a bar says it is on with Stop', 'no screen tile of their own phone screen; app-presenting-bar; Stop → bridge stopPresent', async () => {
  await phone.keyboard.press('Escape').catch(() => {})
  await phone.getByTestId('app-presenting-bar').waitFor({ timeout: 15_000 })
  check(await phone.locator('[data-testid="tile-screen"]').count() === 0, 'presenter sees their own phone screen (mirror)')
  await phone.screenshot({ path: path.join(SHOTS, 'app-03-presenter-bar.png') })
  await phone.getByTestId('app-presenting-stop').click()
  await until(async () => (await appMsgs()).some((x) => x.type === 'stopPresent'), 'no stopPresent message')
  return 'own screen hidden; bar shown; Stop sent to the app'
})

ok.stop = ok.publish && await tc('APP-07', 'When the app stops, the presentation disappears for everyone', 'native disconnects → viewer has no screen view', async () => {
  await native.evaluate(() => window.__room.disconnect())
  await phone.evaluate(() => window.__appSay({ type: 'present', state: 'IDLE', detail: 'user' }))
  await until(async () => (await viewer.locator('[data-testid="video-screen"]').count()) === 0, 'presentation still shown')
  return 'gone'
})

ok.remove = await tc('APP-08', 'Host removes the app user: their phone screen is cut too', 'second token → native publishes → host removes Esha → native disconnected', async () => {
  // Present again with a fresh token.
  await phone.getByTestId('ctl-more').click()
  await phone.getByTestId('ctl-screen-app').click()
  const msgs = await until(async () => { const m = (await appMsgs()).filter((x) => x.type === 'present'); return m.length >= 2 && m }, 'no second present message', 10_000)
  const second = msgs[msgs.length - 1]
  await native.evaluate(async ({ url, token }) => {
    const lk = await import('/node_modules/livekit-client/dist/livekit-client.esm.mjs')
    const room = new lk.Room()
    window.__room = room
    await room.connect(url, token)
    await room.localParticipant.setScreenShareEnabled(true)
  }, second)
  await until(async () => (await viewer.locator('[data-testid="video-screen"]').count()) > 0, 'second presentation not shown')
  const empIdentity = await phone.evaluate(() => window.__room?.localParticipant?.identity).catch(() => null)
  const identity = empIdentity ?? JSON.parse(Buffer.from(second.token.split('.')[1], 'base64url').toString()).sub.replace(/\.screen$/, '')
  const r = await api.req('POST', `/meetings/${meetingId}/room/participants/${encodeURIComponent(identity)}/remove`, { block: false })
  check(r.status === 204, `remove ${r.status} ${JSON.stringify(r.data)}`)
  const state = await until(async () => { const s = await native.evaluate(() => window.__room.state); return s === 'disconnected' && s }, 'phone screen connection not cut', 15_000)
  await until(async () => (await viewer.locator('[data-testid="video-screen"]').count()) === 0, 'presentation still shown after removal')
  return `removed ${identity}; phone screen connection ${state}`
})

ok.leave = await tc('APP-09', 'Leaving the meeting (here: removed by the host) tells the app', 'bridge receives {type:"inMeeting", on:false} after the room closes', async () => {
  const m = await until(async () => (await appMsgs()).find((x) => x.type === 'inMeeting' && x.on === false), 'no inMeeting:false message', 15_000)
  await phone.screenshot({ path: path.join(SHOTS, 'app-04-removed.png') })
  return JSON.stringify(m) + ' (the app also resets its meeting state on every full page load)'
})

await closeAll()
retire()
writeResults('android-app-present')
const n = Object.values(ok).filter(Boolean).length
console.log(`${n}/${Object.keys(ok).length} passed`)
process.exit(n === Object.keys(ok).length ? 0 : 1)
