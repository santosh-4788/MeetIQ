// GoodDay 14 Nov 2026 (evening):
//  #14227 (reopened: "Only happening for nothing phones and its OS") - Nothing OS stops the browser's network soon after it is
//         minimised unless the browser's battery use is "Unrestricted". A phone (Android) whose connection dropped while the
//         app was in the background now gets the steps on return ("Don't show again" is remembered); the call is registered
//         as an ongoing call (Media Session).
//  #14208 (reopened: "popup to extend meeting is not coming for host") - when the scheduled time is up, a host gets a popup
//         (Extend 15 min / Extend 30 min / End now / Keep going) besides the strip; other participants do not.
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14208-14227.mjs
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 7 min - giving up'); process.exit(2) }, 7 * 60_000).unref()
import { Api, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; A065) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const ok = {}

const GUEST = { email: `gd14227b.${tag}@example.test`, name: 'Nothing Phone' }
const api = await new Api().login(HOST.email)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14208 ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  guests: [{ name: GUEST.name, email: GUEST.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${GUEST.email}' ORDER BY OutboxId DESC`)
const guestToken = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]

const host = await newPage({ width: 1366, height: 860 })
await loginUI(host, HOST.email)
const enterHost = async () => {
  await host.goto(`/meetings/${meetingId}/room`)
  await host.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}
await enterHost()

// An Android phone whose page visibility the test controls (minimise = hidden).
const guest = await newPage({ width: 412, height: 860, mobile: true })
await guest.addInitScript((ua) => {
  Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true })
  window.__vis = 'visible'
  Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true })
  Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true })
}, ANDROID_UA)
const enterGuest = async () => {
  await guest.goto(`/join/${guestToken}`)
  await guest.getByRole('button', { name: 'Join meeting' }).click()
  await guest.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await guest.getByRole('button', { name: /Join now|Ask to join|Join meeting/ }).last().click()
  await guest.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}
await enterGuest()
const setVis = (v) => guest.evaluate((v) => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')) }, v)

ok.bg = await tc('GD14227-03', '#14227 (Nothing phones) Android phone minimised, connection dropped, back: battery "Unrestricted" steps; not after a plain minimise; "Don\'t show again" remembered', 'No hint after minimise without a drop; hint with Settings → Apps → Chrome → Battery → Unrestricted after a drop; gone for good after "Don\'t show again"', async () => {
  const session = await guest.evaluate(() => navigator.mediaSession?.metadata ? `${navigator.mediaSession.metadata.title} / ${navigator.mediaSession.playbackState}` : 'none')
  check(/GD14208/.test(session) && /playing/.test(session), `media session ${session}`)
  // 1) Minimised without any drop: nothing.
  await setVis('hidden'); await sleep(2000); await setVis('visible'); await sleep(1500)
  check((await guest.getByTestId('background-hint').count()) === 0, 'hint shown after a plain minimise')
  // 2) Minimised and the phone cut the network: hint on return.
  await setVis('hidden')
  await guest.context().setOffline(true)
  await sleep(6000)
  await guest.context().setOffline(false)
  await setVis('visible')
  const hint = guest.getByTestId('background-hint')
  await hint.waitFor({ timeout: 45_000 })
  const text = await hint.innerText()
  check(/paused the call/.test(text) && /Settings/.test(text) && /Battery/.test(text) && /Unrestricted/.test(text) && /Nothing/.test(text), `hint "${text}"`)
  await guest.screenshot({ path: path.join(SHOTS, 'gd14227-background-hint.png') })
  await guest.getByTestId('background-hint-never').click()
  check((await hint.count()) === 0, 'hint not closed')
  // 3) Same again after "Don't show again": no hint.
  await guest.locator('[data-testid="meeting-room"]').waitFor()
  await setVis('hidden'); await guest.context().setOffline(true); await sleep(6000); await guest.context().setOffline(false); await setVis('visible')
  await sleep(12_000)
  check((await guest.getByTestId('background-hint').count()) === 0, 'hint shown again after "Don\'t show again"')
  return `media session "${session}"; no hint after a plain minimise; hint after a drop; remembered`
})

ok.prompt = await tc('GD14208-05', '#14208 (reopened) Time is up: the host gets a popup with Extend / End now / Keep going; the guest does not', 'Popup "The scheduled time is up" for the host only; Keep going closes it; Extend 15 min → end +15 min, popup closed', async () => {
  // Scheduled end 20 s ago; reload both rooms so they pick it up.
  exec(`UPDATE mtg.Meetings SET ScheduledEndUtc = DATEADD(SECOND, -20, SYSUTCDATETIME()) WHERE MeetingId = ${mid}`)
  await enterHost()
  await enterGuest()
  const dlg = host.getByRole('dialog', { name: 'The scheduled time is up' })
  await dlg.waitFor({ timeout: 10_000 })
  const text = await dlg.innerText()
  check(/ends automatically for everyone in \d+:\d\d/.test(text), `popup text "${text}"`)
  for (const id of ['extend-prompt-15', 'extend-prompt-30', 'extend-prompt-end', 'extend-prompt-later']) check(await host.getByTestId(id).count(), `${id} missing`)
  await sleep(1500)
  check((await guest.getByRole('dialog', { name: 'The scheduled time is up' }).count()) === 0, 'guest got the popup')
  check(/unless the host extends it/.test(await guest.getByTestId('end-time-banner').innerText()), 'guest strip text')
  await host.screenshot({ path: path.join(SHOTS, 'gd14208-host-popup.png') })
  await host.getByTestId('extend-prompt-later').click()
  await dlg.waitFor({ state: 'detached', timeout: 5000 })
  await sleep(3000)
  check((await dlg.count()) === 0, 'popup came back after Keep going')
  check(await host.getByTestId('extend-15').count(), 'strip Extend gone after Keep going')
  // Bring it back (rejoin), then extend from the popup.
  await enterHost()
  await dlg.waitFor({ timeout: 10_000 })
  const before = scalar(`SELECT CONVERT(VARCHAR(19), ScheduledEndUtc, 126) AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)
  await host.getByTestId('extend-prompt-15').click()
  await dlg.waitFor({ state: 'detached', timeout: 8000 })
  const after = scalar(`SELECT CONVERT(VARCHAR(19), ScheduledEndUtc, 126) AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)
  const mins = Math.round((new Date(after + 'Z') - new Date(before + 'Z')) / 60000)
  check(mins >= 15 && mins <= 16, `end moved by ${mins} min (${before} → ${after})`)
  await until(async () => !(await guest.getByTestId('end-time-banner').count()), "guest's strip did not clear", 8000)
  return `host popup "${text.replace(/\s+/g, ' ').slice(0, 90)}…"; guest none; Keep going closes it; Extend 15 → ${before} → ${after}`
})

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
retire()
await closeAll()
writeResults('goodday-14208-14227')
