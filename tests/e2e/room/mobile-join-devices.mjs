// Bugs docx, 18 Nov 2026 evening:
//  (1) "In some Android and iOS mobiles this message shows whenever the user taps mic and video, but no other app uses the
//      mic or camera" - the phone refuses a device for a moment (NotReadableError) and the first failure was final.
//      Now 3 quiet attempts; a message only if all fail. Simulated here: getUserMedia throws NotReadableError N times.
//  (2) "Mobile meeting joining page is big and needs scrolling, and the name is not showing because of mic and camera".
// Android and iPhone sizes as seen in the report (browser bars included). Chromium with phone size/touch/UA.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\mobile-join-devices.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 7 min'); process.exit(2) }, 7 * 60_000).unref()
import path from 'node:path'
import { Api, EMP, HOST, SHOTS, check, closeAll, closePage, exec, loginUI, newPage, overflowX, tc, until, writeResults } from './harness.mjs'

const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const api = await new Api().login(HOST.email)
const inst = await api.req('POST', '/meetings/instant', { title: 'Test 2', waitingRoomEnabled: true })
if (inst.status !== 201) throw new Error(`instant meeting not created: ${inst.status}`)
const meetingId = inst.data.id
const linkPath = new URL(inst.data.link.url).pathname

const PHONES = [
  { key: 'android-small', name: 'Android 360x600 (small phone, Chrome bars)', w: 360, h: 600, dpr: 3, ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36' },
  { key: 'android', name: 'Android 412x780', w: 412, h: 780, dpr: 2.625, ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36' },
  { key: 'iphone', name: 'iPhone 390x664 (Safari bars)', w: 390, h: 664, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1' },
]
const box = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right) } }, sel)
const overlaps = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
const ok = {}

for (const ph of PHONES) {
  ok[ph.key] = await tc(`MJ-${ph.key}`, `${ph.name}: join page fits without scrolling; the name is visible`, 'Ask to join visible without scrolling (camera off and on); name shown in the preview, not under the mic/camera buttons; no sideways scroll', async () => {
    const p = await newPage({ width: ph.w, height: ph.h, mobile: true, userAgent: ph.ua, deviceScaleFactor: ph.dpr })
    await p.goto(linkPath)
    await p.getByTestId('link-join').click()
    await p.getByText('Ready to join?').waitFor({ timeout: 25_000 })
    await p.getByTestId('prejoin-name').fill('Akshay kumar')
    // As in the report: microphone and camera switched off.
    for (const label of ['Turn microphone off', 'Turn camera off']) {
      const b = p.getByRole('button', { name: label })
      if (await b.count()) await b.click()
    }
    await p.getByTestId('prejoin-preview-name').waitFor()
    await p.evaluate(() => document.querySelector('[data-testid="prejoin"]').scrollTo(0, 0))
    await p.screenshot({ path: path.join(SHOTS, `mj-${ph.key}-off.png`) })
    const nameBox = await box(p, '[data-testid="prejoin-preview-name"]')
    const btns = await box(p, '[aria-label="Turn microphone on"]')
    const btns2 = await box(p, '[aria-label="Turn camera on"]')
    check(!overlaps(nameBox, btns) && !overlaps(nameBox, btns2), `name under the buttons: ${JSON.stringify({ nameBox, btns, btns2 })}`)
    const join = await box(p, 'button[type="submit"]')
    check(join.b <= ph.h, `Ask to join below the screen (bottom ${join.b} > ${ph.h}) - needs scrolling`)
    const ox = await overflowX(p)
    check(ox <= 0, `sideways scroll ${ox}px`)
    // Camera on (live preview): still fits.
    await p.getByRole('button', { name: 'Turn camera on' }).click()
    await p.getByTestId('prejoin-preview').waitFor({ state: 'visible', timeout: 15_000 })
    const join2 = await box(p, 'button[type="submit"]')
    check(join2.b <= ph.h, `with camera on, Ask to join below the screen (${join2.b} > ${ph.h})`)
    // The device lists are one tap away.
    await p.getByTestId('prejoin-devices').click()
    check(await p.getByText('Microphone', { exact: true }).isVisible(), 'device settings did not open')
    await p.screenshot({ path: path.join(SHOTS, `mj-${ph.key}-devices.png`) })
    await closePage(p)
    return `Ask to join bottom ${join.b}/${ph.h} (camera off), ${join2.b}/${ph.h} (camera on); name visible above the buttons`
  })
}

// (1) In the meeting on a phone: the device is "busy" for the first attempt(s).
const phone = await newPage({ width: 390, height: 844, mobile: true, userAgent: PHONES[2].ua, deviceScaleFactor: 3 })
await phone.addInitScript(() => {
  const md = navigator.mediaDevices
  const orig = md.getUserMedia.bind(md)
  window.__busy = 0
  md.getUserMedia = async (c) => {
    if (window.__busy > 0) {
      window.__busy--
      throw new DOMException('Could not start video source', 'NotReadableError')
    }
    return orig(c)
  }
})
await loginUI(phone, HOST.email) // the host of the instant meeting
await phone.goto(`/meetings/${meetingId}/room`)
await phone.getByRole('button', { name: 'Turn microphone off' }).click().catch(() => {})
await phone.getByRole('button', { name: 'Turn camera off' }).click().catch(() => {})
await phone.getByRole('button', { name: /Start meeting|Join now|Join|Rejoin/ }).first().click()
await phone.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
const toastText = () => phone.locator('[role="status"] p').allInnerTexts().then((a) => a.join(' | ')).catch(() => '')

ok.retry = await tc('MJ-retry', 'Phone in the meeting: mic and camera refused once/twice ("busy"), then fine - no message', 'tap mic: on after a quiet retry, no "being used" message; same for the camera (2 refusals)', async () => {
  await phone.evaluate(() => { window.__busy = 1 })
  await phone.getByTestId('ctl-mic').click()
  await until(async () => (await phone.getByTestId('ctl-mic').getAttribute('aria-pressed')) === 'true', 'microphone not on after the retry', 10_000)
  await phone.evaluate(() => { window.__busy = 2 })
  await phone.getByTestId('ctl-cam').click()
  await until(async () => (await phone.getByTestId('ctl-cam').getAttribute('aria-pressed')) === 'true', 'camera not on after the retries', 12_000)
  const t = await toastText()
  check(!/could not be started|being used/i.test(t), `a message was shown although the retry worked: ${t}`)
  await phone.screenshot({ path: path.join(SHOTS, 'mj-retry-ok.png') })
  return 'mic on after 1 refusal, camera on after 2 refusals; no message'
})

ok.fail = await tc('MJ-fail', 'Phone in the meeting: device refused every time - one clear message with the code', 'after 3 attempts one toast: tap again / close apps / rejoin, with (NotReadableError); no message for the other device', async () => {
  await phone.getByTestId('ctl-cam').click() // camera off
  await until(async () => (await phone.getByTestId('ctl-cam').getAttribute('aria-pressed')) === 'false', 'camera did not turn off')
  await phone.evaluate(() => { window.__busy = 10 })
  await phone.getByTestId('ctl-cam').click()
  const t = await until(async () => { const x = await toastText(); return /camera could not be started/i.test(x) && x }, 'no message after all attempts failed', 15_000)
  check(/NotReadableError/.test(t) && /Tap the camera button again/.test(t), `message: ${t}`)
  check(!/microphone/i.test(t), `a microphone message too: ${t}`)
  const tries = await phone.evaluate(() => 10 - window.__busy)
  check(tries === 3, `attempts ${tries}, expected 3`)
  await phone.evaluate(() => { window.__busy = 0 })
  await phone.screenshot({ path: path.join(SHOTS, 'mj-fail-message.png') })
  return `${tries} attempts, then: "${t.slice(0, 120)}…"`
})

await closeAll()
retire()
writeResults('mobile-join-devices')
const n = Object.values(ok).filter(Boolean).length
console.log(`${n}/${Object.keys(ok).length} passed`)
process.exit(n === Object.keys(ok).length ? 0 : 1)
