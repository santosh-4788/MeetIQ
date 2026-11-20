// GoodDay #14230 (16 Nov 2026): "The Host has extended the meeting but still the message in screenshot is visible to customer"
// ("Scheduled time is up. The meeting ends automatically in 0:09 unless the host extends it.").
// Cause: an extension reached the others only as a one-off data message; a phone that was reconnecting at that moment never got it.
// Fix: the meeting's current end travels with the recording state every participant re-reads (10 s poll, on reconnect).
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, local LiveKit 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14230.mjs
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 6 min - giving up'); process.exit(2) }, 6 * 60_000).unref()
import { Api, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const ok = {}

const CUSTOMER = { email: `gd14230.${tag}@example.test`, name: 'Phone Customer' }
const api = await new Api().login(HOST.email)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14230 ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  guests: [{ name: CUSTOMER.name, email: CUSTOMER.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${CUSTOMER.email}' ORDER BY OutboxId DESC`)
const token = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]

const host = await newPage({ width: 1366, height: 860 })
await loginUI(host, HOST.email)
const enterHost = async () => {
  await host.goto(`/meetings/${meetingId}/room`)
  await host.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}
const phone = await newPage({ width: 390, height: 844, mobile: true })
const enterPhone = async () => {
  await phone.goto(`/join/${token}`)
  await phone.getByRole('button', { name: 'Join meeting' }).click()
  await phone.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await phone.getByRole('button', { name: /Join now|Ask to join|Join meeting/ }).last().click()
  await phone.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}
await enterHost()

ok.missed = await tc('GD14230-01', '#14230 Extension the customer\'s phone never heard about (no "end-changed" message) still clears "Scheduled time is up" on the phone',
  'Phone shows "Scheduled time is up ... unless the host extends it"; the end is moved +15 min without any message; within the 10 s refresh the phone strip is gone (no countdown to the old end)', async () => {
    exec(`UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, -10, SYSUTCDATETIME()), ScheduledEndUtc = DATEADD(SECOND, -20, SYSUTCDATETIME()) WHERE MeetingId = ${mid}`)
    await enterHost()
    await enterPhone()
    const strip = phone.getByTestId('end-time-banner')
    await strip.waitFor({ timeout: 10_000 })
    const before = await strip.innerText()
    check(/Scheduled time is up/.test(before) && /unless the host extends it/.test(before), `phone strip "${before}"`)
    await phone.screenshot({ path: path.join(SHOTS, 'gd14230-before.png') })
    // The extension the phone missed: only the database changes - no data message is sent to anyone.
    exec(`UPDATE mtg.Meetings SET ScheduledEndUtc = DATEADD(MINUTE, 15, SYSUTCDATETIME()) WHERE MeetingId = ${mid}`)
    const t0 = Date.now()
    await until(async () => !(await strip.count()), 'phone still shows the end-time strip 25 s after the extension', 25_000)
    const secs = Math.round((Date.now() - t0) / 1000)
    await sleep(1500)
    check((await phone.locator('[data-testid="meeting-room"]').count()) === 1, 'phone left the meeting')
    await phone.screenshot({ path: path.join(SHOTS, 'gd14230-after.png') })
    return `before: "${before.replace(/\s+/g, ' ')}"; cleared ${secs} s after the silent extension; phone still in the meeting`
  })

ok.normal = await tc('GD14230-02', '#14230 Normal extension from the host still reaches the phone at once',
  'Time up again; host clicks Extend 15 min in the popup; end +15 min in the database; phone strip gone within 5 s', async () => {
    exec(`UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, -10, SYSUTCDATETIME()), ScheduledEndUtc = DATEADD(SECOND, -20, SYSUTCDATETIME()) WHERE MeetingId = ${mid}`)
    await enterHost()
    await enterPhone()
    await phone.getByTestId('end-time-banner').waitFor({ timeout: 10_000 })
    const dlg = host.getByRole('dialog', { name: 'The scheduled time is up' })
    await dlg.waitFor({ timeout: 10_000 })
    await host.getByTestId('extend-prompt-15').click()
    await dlg.waitFor({ state: 'detached', timeout: 8000 })
    const t0 = Date.now()
    await until(async () => !(await phone.getByTestId('end-time-banner').count()), "phone strip did not clear after the host's Extend", 5000, 250)
    return `phone strip cleared ${Date.now() - t0} ms after Extend`
  })

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
retire()
await closeAll()
writeResults('goodday-14230')
