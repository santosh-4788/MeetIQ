// GoodDay #14230 (reopened 16 Nov 2026: "no option is coming to the host for extending the meeting") and "sometimes the host
// did not get the extend notification". Production showed hosts ending calls seconds before the scheduled end: the popup only
// came once the time was up, and only inside the page. Now hosts also get the popup at the 5-minute warning, and when the page
// is hidden (presenting another window, another tab, minimised) a system notification, a chime and a flashing tab title.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14230-host-alert.mjs
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 6 min - giving up'); process.exit(2) }, 6 * 60_000).unref()
import { Api, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const ok = {}

const CUSTOMER = { email: `gd14230h.${tag}@example.test`, name: 'Phone Customer' }
const api = await new Api().login(HOST.email)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14230H ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  guests: [{ name: CUSTOMER.name, email: CUSTOMER.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${CUSTOMER.email}' ORDER BY OutboxId DESC`)
const token = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]
const setEnd = (sql) => exec(`UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, -10, SYSUTCDATETIME()), ScheduledEndUtc = ${sql} WHERE MeetingId = ${mid}`)

// Host: notifications allowed (recorded instead of shown) and page visibility under the test's control.
const host = await newPage({ width: 1366, height: 860 })
await host.addInitScript(() => {
  window.__notes = []
  class FakeNotification { constructor(title, opts) { window.__notes.push({ title, body: opts?.body }) } close() {} }
  FakeNotification.permission = 'granted'
  FakeNotification.requestPermission = () => Promise.resolve('granted')
  window.Notification = FakeNotification
  window.__vis = 'visible'
  Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true })
  Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true })
})
const setHostVis = (v) => host.evaluate((v) => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')) }, v)
await loginUI(host, HOST.email)
await host.goto(`/meetings/${meetingId}/room`)
await host.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })

const phone = await newPage({ width: 390, height: 844, mobile: true })
await phone.goto(`/join/${token}`)
await phone.getByRole('button', { name: 'Join meeting' }).click()
await phone.getByText('Ready to join?').waitFor({ timeout: 25_000 })
await phone.getByRole('button', { name: /Join now|Ask to join|Join meeting/ }).last().click()
await phone.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })

const soonDlg = host.getByRole('dialog', { name: 'The meeting ends soon' })
const upDlg = host.getByRole('dialog', { name: 'The scheduled time is up' })

ok.soon = await tc('GD14230-03', '#14230 Host already in the call gets the Extend popup at the 5-minute warning (not only when the time is up); the customer does not',
  'End moved to 3 min from now (server only): within the 10 s refresh the host sees "The meeting ends soon" with Extend 15/30, End now, Keep going and the countdown; the phone gets the strip only; Keep going closes it', async () => {
    setEnd('DATEADD(MINUTE, 3, SYSUTCDATETIME())')
    await soonDlg.waitFor({ timeout: 20_000 })
    const text = await host.getByTestId('extend-soon-text').innerText()
    check(/scheduled to end at/.test(text) && /\(in [0-3]:\d\d\)/.test(text), `soon text "${text}"`)
    for (const id of ['extend-prompt-15', 'extend-prompt-30', 'extend-prompt-end', 'extend-prompt-later']) check(await host.getByTestId(id).count(), `${id} missing`)
    await host.screenshot({ path: path.join(SHOTS, 'gd14230-host-soon-popup.png') })
    await phone.getByTestId('end-time-banner').waitFor({ timeout: 15_000 })
    check((await phone.getByRole('dialog').count()) === 0, 'customer got a popup')
    await host.getByTestId('extend-prompt-later').click()
    await soonDlg.waitFor({ state: 'detached', timeout: 5000 })
    await sleep(4000)
    check((await soonDlg.count()) === 0, '"ends soon" popup came back after Keep going')
    return `host popup "${text.replace(/\s+/g, ' ')}"; customer strip only; Keep going closes it`
  })

ok.hidden = await tc('GD14230-04', '#14230 Host not looking at the meeting (tab hidden) when the time is up: system notification + flashing tab title; popup waiting on return',
  'Host page hidden; scheduled end passes: a notification "Scheduled time is up - extend the meeting?" is raised, the tab title alternates with "⏰ Time is up - extend?", the time-up popup is open; back on the page the title is normal again', async () => {
    const title0 = await host.title()
    await setHostVis('hidden')
    setEnd('DATEADD(SECOND, -15, SYSUTCDATETIME())')
    await until(async () => (await host.evaluate(() => window.__notes.length)) > 0, 'no system notification raised', 20_000)
    const notes = await host.evaluate(() => window.__notes)
    check(notes.some((n) => /Scheduled time is up/.test(n.title) && /extend/i.test(n.body)), `notifications ${JSON.stringify(notes)}`)
    const titles = new Set()
    for (let i = 0; i < 6; i++) { titles.add(await host.title()); await sleep(500) }
    check([...titles].some((t) => /Time is up - extend\?/.test(t)), `tab titles ${JSON.stringify([...titles])}`)
    check((await upDlg.count()) === 1, 'time-up popup not open')
    await setHostVis('visible')
    await sleep(1200)
    check((await host.title()) === title0, `title not restored: "${await host.title()}"`)
    return `notification "${notes.at(-1).title}"; tab title flashes ${JSON.stringify([...titles])}; popup waiting; title restored`
  })

ok.extend = await tc('GD14230-05', '#14230 Extending from the time-up popup still works and clears everything',
  'Extend 15 min from the popup: end +15 min in the database, popup closed, host and phone strips gone', async () => {
    const before = scalar(`SELECT CONVERT(VARCHAR(19), ScheduledEndUtc, 126) AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)
    await host.getByTestId('extend-prompt-15').click()
    await upDlg.waitFor({ state: 'detached', timeout: 8000 })
    const after = scalar(`SELECT CONVERT(VARCHAR(19), ScheduledEndUtc, 126) AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`)
    const mins = Math.round((new Date(after + 'Z') - new Date(before + 'Z')) / 60000)
    check(mins >= 15 && mins <= 16, `end moved by ${mins} min`)
    await until(async () => !(await phone.getByTestId('end-time-banner').count()) && !(await host.getByTestId('end-time-banner').count()), 'strips did not clear', 8000)
    return `${before} → ${after}; strips cleared`
  })

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
retire()
await closeAll()
writeResults('goodday-14230-host-alert')
