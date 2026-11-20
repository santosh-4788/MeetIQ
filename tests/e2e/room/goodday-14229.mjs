// GoodDay #14229: "Screen Present Feature Not Working in iOS Chrome, Check for iOS, Android and for all device".
// Every browser on iPhone/iPad (Chrome included) runs on Apple's WebKit, which gives web pages no screen capture
// (navigator.mediaDevices.getDisplayMedia is missing); Android phone browsers lack it as well. A website cannot add it.
// The old message told an iOS Chrome user to "try a desktop browser such as Chrome" - now the reason is given per device.
// This test removes getDisplayMedia and sets the phone's user agent, as on the real devices, then taps Present.
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14229.mjs
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 6 min - giving up'); process.exit(2) }, 6 * 60_000).unref()
import { Api, EMP, HOST, SHOTS, check, closeAll, closePage, exec, loginUI, newPage, scalar, tc, writeResults } from './harness.mjs'

const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; SM-A156E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const IPAD_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'

exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
const tag = Date.now().toString(36).slice(-5)
const api = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14229 ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id

/** A phone page: its user agent and touch points as on the device, and no getDisplayMedia (as on iOS / Android browsers). */
async function phone(ua, touch = 5, size = { width: 390, height: 844 }, canCapture = false) {
  const p = await newPage({ ...size, mobile: true })
  await p.addInitScript(([u, t, c]) => {
    Object.defineProperty(navigator, 'userAgent', { get: () => u, configurable: true })
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => t, configurable: true })
    if (!c && navigator.mediaDevices) delete Object.getPrototypeOf(navigator.mediaDevices).getDisplayMedia
  }, [ua, touch, canCapture])
  return p
}
async function enter(page, email, button) {
  await loginUI(page, email)
  await page.goto(`/meetings/${meetingId}/room`)
  await page.getByRole('button', { name: button }).first().click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}
/** Opens "More" (phones) or uses the toolbar, taps the unavailable Present button and returns the toast text. */
async function tapPresent(page, shot) {
  const more = page.getByTestId('ctl-more')
  if (await more.isVisible().catch(() => false)) await more.click()
  check(await page.getByTestId('ctl-screen').count() === 0, 'a working Present button is offered without getDisplayMedia')
  await page.getByTestId('ctl-present-unsupported').click()
  const toast = page.locator('[role="status"] p').last()
  await toast.waitFor({ timeout: 5000 })
  await page.screenshot({ path: path.join(SHOTS, `gd14229-${shot}.png`) })
  return (await toast.innerText()).trim()
}

const ok = {}
let host = await phone(IPHONE_CHROME)
ok.ios = await tc('GD14229-01', 'iPhone on older iOS (no screen capture): tapping Present says to update iOS', 'Toast names iPhone/iPad, the latest iOS and Software Update, says others\' screens can still be seen, and does not suggest Chrome', async () => {
  await enter(host, HOST.email, /Start meeting|Join|Rejoin/)
  const t = await tapPresent(host, 'iphone-chrome')
  check(/iPhone or iPad/.test(t) && /latest iOS/.test(t) && /Software Update/.test(t) && /see screens others present/.test(t), `toast: ${t}`)
  check(!/such as Chrome/.test(t), `old text still shown: ${t}`)
  return t
})

let emp = await phone(ANDROID_CHROME, 5, { width: 412, height: 860 })
ok.android = await tc('GD14229-02', 'Android Chrome: tapping Present explains the Android limit', 'Toast names Android and says to join from a computer', async () => {
  await enter(emp, EMP.email, /Join now|Join|Rejoin/)
  const t = await tapPresent(emp, 'android-chrome')
  check(/Android/.test(t) && /join from a computer/.test(t) && !/iOS/.test(t), `toast: ${t}`)
  return t
})
await closePage(emp)

emp = await phone(IPAD_SAFARI, 5, { width: 820, height: 1180 })
ok.ipad = await tc('GD14229-03', 'iPad (reports itself as a Mac with touch): the iOS update message is shown', 'Toast says the latest iOS', async () => {
  await enter(emp, EMP.email, /Join now|Join|Rejoin/)
  const t = await tapPresent(emp, 'ipad-safari')
  check(/latest iOS/.test(t), `toast: ${t}`)
  return t
})
await closePage(emp)

// 17 Nov 2026: production logs show iPhone Safari / Chrome on iOS 27.2+ presenting. Where the browser offers screen capture,
// the working Present button must be offered (in More on a phone), not the "update iOS" message.
emp = await phone('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1', 5, { width: 390, height: 844 }, true)
ok.iosNew = await tc('GD14229-06', 'iPhone on iOS 27.2+ (browser offers screen capture): Present is offered in More', 'ctl-screen in the More sheet; no unavailable button', async () => {
  await enter(emp, EMP.email, /Join now|Join|Rejoin/)
  await emp.getByTestId('ctl-more').click()
  await emp.getByTestId('ctl-screen').waitFor({ timeout: 5000 })
  check(await emp.getByTestId('ctl-present-unsupported').count() === 0, 'unavailable button shown although screen capture exists')
  await emp.screenshot({ path: path.join(SHOTS, 'gd14229-iphone-ios27-more.png') })
  return 'Present offered in More'
})
await closePage(emp)

emp = await newPage({ width: 1366, height: 820 })
ok.desktop = await tc('GD14229-04', 'Desktop browser: the working Present button is offered', 'ctl-screen visible, no "unavailable" button', async () => {
  await enter(emp, EMP.email, /Join now|Join|Rejoin/)
  await emp.getByTestId('ctl-screen').waitFor({ timeout: 10_000 })
  check(await emp.getByTestId('ctl-present-unsupported').count() === 0, 'unavailable button shown on desktop')
  return 'Present button visible'
})

ok.view = ok.desktop && await tc('GD14229-05', 'The iPhone still sees a screen presented from a computer', 'Desktop presents; the iPhone page renders the screen-share video with frames', async () => {
  const screenVideo = () => host.evaluate(() => {
    const v = document.querySelector('video[data-testid="video-screen"]')
    return v ? { w: v.videoWidth, h: v.videoHeight } : null
  })
  await emp.getByTestId('ctl-screen').click()
  let v = null
  for (let i = 0; i < 50 && !(v?.w > 0); i++) { await host.waitForTimeout(500); v = await screenVideo() }
  await host.screenshot({ path: path.join(SHOTS, 'gd14229-iphone-sees-screen.png') })
  check(v?.w > 0, `no screen-share video on the iPhone page: ${JSON.stringify(v)}`)
  await emp.getByTestId('ctl-screen').click()
  return `screen share rendered on the iPhone page (${v.w}x${v.h})`
})

await closeAll()
exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE PublicId = '${meetingId}'`)
writeResults('goodday-14229', ok)
process.exit(Object.values(ok).every(Boolean) ? 0 : 1)
