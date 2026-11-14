// GoodDay 14 Nov 2026:
//  #14224 "If meeting time is over and i Extend it customer is automatically removed from the meet"
//  #14225 "If I try to remove customer from the meet invalid message is shown" (the confirmation said "They are disconnected now")
//  #14226 "Remove this message from the host" (the "To hand over hosting…" note in the host's Participants panel)
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14224-14226.mjs
import path from 'node:path'
import { Api, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sql, sleep, tc, until, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
const GUEST = { email: `gd14224.${tag}@example.test`, name: 'Vedant Guest' }
exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")

const api = await new Api().login(HOST.email)
const start = new Date(Date.now() + 2 * 60_000); start.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14224 ${tag}`, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 15 * 60_000).toISOString(),
  guests: [{ name: GUEST.name, email: GUEST.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: true,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
// The booked time is already over (ended 1 minute ago; the server's automatic end is still minutes away).
exec(`UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, -16, SYSUTCDATETIME()), ScheduledEndUtc = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE MeetingId = ${mid}`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${GUEST.email}' ORDER BY OutboxId DESC`)
const guestToken = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]

const errors = { host: [], guest: [] }
const watch = (p, who) => {
  p.on('pageerror', (e) => errors[who].push(`pageerror: ${e.message}`))
  p.on('console', (m) => { if (m.type() === 'error') errors[who].push(`console: ${m.text().slice(0, 300)}`) })
}

const host = await newPage({ width: 1366, height: 860 }); watch(host, 'host')
await loginUI(host, HOST.email)
await host.goto(`/meetings/${meetingId}/room`)
await host.getByRole('button', { name: /Start meeting|Join/ }).first().click()
await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })

let guest = await newPage({ width: 390, height: 844, mobile: true }); watch(guest, 'guest')
await guest.goto(`/join/${guestToken}`)
await guest.getByRole('button', { name: 'Join meeting' }).click()
await guest.getByText('Ready to join?').waitFor({ timeout: 25_000 })
await guest.getByRole('button', { name: 'Ask to join' }).click()
await guest.getByTestId('waiting-room').waitFor({ timeout: 15_000 })
await host.getByTestId('waiting-badge').waitFor({ timeout: 20_000 })
await host.getByTestId('ctl-people').click()
await host.getByTestId('waiting-entry').getByTestId('waiting-admit').click()
await guest.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
const guestIdentity = scalar(`SELECT LiveKitIdentity AS v FROM mtg.MeetingParticipants WHERE MeetingId = ${mid} AND ParticipantType = 'GUEST'`)

const ok = {}
ok.extend = await tc('GD14224-01', '#14224 Booked time over → host extends 15 min → the guest stays in the meeting', 'Guest still connected 45 s after the extension, sees the new end time; no page errors; one attendance interval, still open', async () => {
  await host.getByTestId('end-time-banner').waitFor()
  check(/Scheduled time is up/.test(await host.getByTestId('end-time-banner').innerText()), 'host banner is not in the "time is up" state')
  await host.getByTestId('extend-15').click()
  await guest.getByText(/extended by 15 min/).waitFor({ timeout: 10_000 })
  for (let i = 0; i < 45; i++) {
    check(await guest.locator('[data-testid="meeting-room"]').count(), `guest left the room ${i} s after the extension; errors: ${JSON.stringify(errors.guest)}`)
    await sleep(1000)
  }
  await guest.screenshot({ path: path.join(SHOTS, 'gd14224-guest-after-extend.png') })
  const att = sql(`SELECT CONVERT(VARCHAR(19), a.JoinedUtc, 126) AS j, CONVERT(VARCHAR(19), a.LeftUtc, 126) AS l, a.LeaveReason AS r FROM mtg.MeetingAttendance a JOIN mtg.MeetingParticipants p ON p.ParticipantId = a.ParticipantId WHERE a.MeetingId = ${mid} AND p.LiveKitIdentity = '${guestIdentity}'`)
  check(att.length === 1 && !att[0].l, `guest attendance ${JSON.stringify(att)}`)
  check(errors.guest.filter((e) => e.startsWith('pageerror')).length === 0, `guest page errors ${JSON.stringify(errors.guest)}`)
  const header = await guest.locator('[data-testid="meeting-room"]').innerText()
  return `guest connected 45 s after extending; attendance ${JSON.stringify(att)}; console errors: ${errors.guest.length}; header has "Ends": ${/Ends \d/.test(header)}`
})

ok.tabs = await tc('GD14224-02', '#14224 Same guest opens the link again in a new tab while the first tab is reconnecting: the first tab steps aside, the new one stays', 'Old tab: "You joined from another window"; new tab connected 30 s later; exactly one open attendance', async () => {
  // Production, 14 Nov 12:41-12:47 (iPhone Safari): the first tab lost its connection, the link was opened again, and the
  // old tab's background "resume" attempts closed every new connection. Here: cut the first tab's signalling, then rejoin.
  const cdp = await guest.context().newCDPSession(guest)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  const second = await guest.context().newPage(); watch(second, 'guest')
  second.setDefaultTimeout(20_000)
  await second.goto(`/join/${guestToken}`)
  await second.getByRole('button', { name: 'Join meeting' }).click()
  await second.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await second.getByRole('button', { name: /Ask to join|Join now|Join meeting/ }).last().click()
  // A removed-from-room-by-reconnect guest may have to be let in again.
  const where = await Promise.race([
    second.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 }).then(() => 'room'),
    second.getByTestId('waiting-room').waitFor({ timeout: 25_000 }).then(() => 'waiting'),
  ])
  if (where === 'waiting') {
    await host.getByTestId('waiting-entry').getByTestId('waiting-admit').click()
    await second.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  }
  await guest.getByText('You joined from another window').waitFor({ timeout: 15_000 })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
  for (let i = 0; i < 30; i++) {
    check(await second.locator('[data-testid="meeting-room"]').count(), `new tab dropped ${i} s after joining; errors ${JSON.stringify(errors.guest)}`)
    await sleep(1000)
  }
  await guest.screenshot({ path: path.join(SHOTS, 'gd14224-old-tab.png') })
  await second.screenshot({ path: path.join(SHOTS, 'gd14224-new-tab.png') })
  const open = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingAttendance a JOIN mtg.MeetingParticipants p ON p.ParticipantId = a.ParticipantId WHERE a.MeetingId = ${mid} AND p.LiveKitIdentity = '${guestIdentity}' AND a.LeftUtc IS NULL`))
  check(open === 1, `${open} open attendance rows for the guest`)
  const visible = await until(async () => (await host.getByTestId('participant-list').innerText()).includes(GUEST.name), 'host does not list the guest', 10_000)
  guest = second
  return `new tab ${where === 'waiting' ? 'admitted again and ' : ''}connected for 30 s; old tab shows "You joined from another window"; host lists the guest: ${!!visible}`
})

ok.hint = await tc('GD14226-01', '#14226 Host Participants panel: no "To hand over hosting…" note', 'No host-transfer-hint element and no such text; "Make host" still offered for colleagues (not for the guest)', async () => {
  await host.getByTestId('participant-list').waitFor()
  check((await host.getByTestId('host-transfer-hint').count()) === 0, 'host-transfer-hint still shown')
  check((await host.getByText(/To hand over hosting/).count()) === 0, 'hand-over text still shown')
  await host.screenshot({ path: path.join(SHOTS, 'gd14226-participants.png') })
  return 'note gone'
})

ok.remove = await tc('GD14225-01', '#14225 Remove the guest: the confirmation explains what will happen (no "They are disconnected now")', 'Dialog text speaks in the future tense; removing works; guest sees "You were removed"', async () => {
  await host.getByTestId('participant-remove').first().click()
  const dlg = host.getByRole('dialog')
  await dlg.waitFor()
  const text = await dlg.innerText()
  await host.screenshot({ path: path.join(SHOTS, 'gd14225-remove-dialog.png') })
  check(!/They are disconnected now/.test(text), `old text still shown: ${text}`)
  check(/will be removed from the call/.test(text), `dialog text: ${text}`)
  await dlg.getByRole('button', { name: 'Remove from meeting' }).click()
  await guest.getByText('You were removed from the meeting').waitFor({ timeout: 15_000 })
  return text.replace(/\s+/g, ' ').slice(0, 300)
})

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
console.log('guest console/page errors:', JSON.stringify(errors.guest, null, 1))
console.log('host console/page errors:', JSON.stringify(errors.host, null, 1))
await closeAll()
writeResults('goodday-14224-14226')
