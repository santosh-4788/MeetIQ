// 19 Nov 2026: refreshing the page during a meeting (Chrome, Safari, the Android app) dropped the person to the "Join now" /
// "Ready to join?" screen; they had to join again. Now a refresh goes straight back into the meeting (room/rejoin.ts).
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\refresh-rejoin.mjs
setTimeout(() => { console.log('WATCHDOG: test still running after 8 min - giving up'); process.exit(2) }, 8 * 60_000).unref()
import { Api, HOST, check, closeAll, exec, inbound, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const ok = {}

const CUSTOMER = { email: `refresh.${tag}@example.test`, name: 'Refresh Customer' }
const api = await new Api().login(HOST.email)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `Refresh ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  guests: [{ name: CUSTOMER.name, email: CUSTOMER.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: true,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${CUSTOMER.email}' ORDER BY OutboxId DESC`)
const token = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]

const inRoom = (p) => p.locator('[data-testid="meeting-room"]')
const host = await newPage({ width: 1366, height: 860 })
await loginUI(host, HOST.email)
await host.goto(`/meetings/${meetingId}/room`)
await host.getByRole('button', { name: /Start meeting|Join now/ }).first().click()
await inRoom(host).waitFor({ timeout: 30_000 })

const phone = await newPage({ width: 390, height: 844, mobile: true })
await phone.goto(`/join/${token}`)
await phone.getByRole('button', { name: 'Join meeting' }).click()
await phone.getByText('Ready to join?').waitFor({ timeout: 25_000 })
await phone.getByRole('button', { name: 'Ask to join' }).click()
await phone.getByTestId('waiting-room').waitFor({ timeout: 15_000 })
await host.getByTestId('waiting-badge').waitFor({ timeout: 20_000 })
await host.getByTestId('ctl-people').click()
await host.getByTestId('waiting-entry').getByTestId('waiting-admit').click()
await inRoom(phone).waitFor({ timeout: 25_000 })
const hostSees = async () => (await host.getByText(CUSTOMER.name).count()) > 0
await until(hostSees, 'host does not see the customer', 20_000)
const entries = () => Number(scalar(`SELECT COUNT(*) AS v FROM mtg.WaitingRoomEntries WHERE MeetingId = ${mid}`))

ok.guest = await tc('RR-01', 'Customer (phone, waiting room on) refreshes the page in the meeting: back in the meeting without "Ready to join?" or the waiting room',
  'Reload → room again within 20 s; never shows the invitation page, pre-join or waiting room; no new waiting-room entry; the host sees the customer again', async () => {
    const before = entries()
    const seen = []
    const watch = setInterval(async () => {
      for (const [k, sel] of [['pre-join', phone.getByText('Ready to join?')], ['waiting', phone.getByTestId('waiting-room')], ['invitation', phone.getByRole('button', { name: 'Join meeting' })]])
        if (await sel.count().catch(() => 0)) seen.push(k)
    }, 150)
    const t0 = Date.now()
    await phone.reload()
    await inRoom(phone).waitFor({ timeout: 20_000 })
    clearInterval(watch)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    check(seen.length === 0, `showed ${[...new Set(seen)].join(', ')} on the way back`)
    check(entries() === before, 'a new waiting-room entry was created (host asked again)')
    await until(hostSees, 'host does not see the customer after the refresh', 20_000)
    // The microphone/camera are published again (the host receives the customer's audio and video).
    await sleep(3000)
    const a = await inbound(host)
    await sleep(3000)
    const b = await inbound(host)
    check(b.audio > a.audio && b.video > a.video, `host not receiving the customer after the refresh ${JSON.stringify([a, b])}`)
    return `back in the room ${secs} s after reload; no pre-join/waiting screens; host sees "${CUSTOMER.name}" and receives +${b.audio - a.audio} B audio / +${b.video - a.video} B video in 3 s`
  })

ok.twice = await tc('RR-02', 'Customer refreshes again (twice in a row)', 'Each reload returns to the room', async () => {
  for (let i = 0; i < 2; i++) {
    await phone.reload()
    await inRoom(phone).waitFor({ timeout: 20_000 })
    await sleep(1500)
  }
  await until(hostSees, 'host does not see the customer', 20_000)
  return 'returned to the room after each of 2 reloads'
})

ok.host = await tc('RR-03', 'Host (computer) refreshes the page in the meeting: back in the meeting at once, still the host; the customer stays connected',
  'Reload → room without "Start meeting/Join now"; host controls (People/waiting) present; the customer is still in the room', async () => {
    let prejoin = false
    const watch = setInterval(async () => { if (await host.getByRole('button', { name: /Start meeting|Join now/ }).count().catch(() => 0)) prejoin = true }, 150)
    await host.reload()
    await inRoom(host).waitFor({ timeout: 25_000 })
    clearInterval(watch)
    check(!prejoin, 'host saw the pre-join screen')
    check((await inRoom(phone).count()) === 1, 'customer dropped when the host refreshed')
    await host.getByTestId('ctl-people').click()
    await until(hostSees, 'host does not see the customer after refreshing', 20_000)
    return 'host back in the room, sees the customer; customer never left'
  })

ok.leave = await tc('RR-04', 'After leaving on purpose, a refresh does NOT rejoin', 'Leave → exit screen; reload → the invitation page (not the room)', async () => {
  await phone.getByTestId('ctl-leave').click()
  const confirm = phone.getByRole('button', { name: /^Leave( meeting)?$/ })
  if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) await confirm.last().click()
  await until(async () => (await inRoom(phone).count()) === 0, 'still in the room', 15_000)
  await phone.reload()
  await phone.getByRole('button', { name: 'Join meeting' }).waitFor({ timeout: 20_000 })
  await sleep(3000)
  check((await inRoom(phone).count()) === 0, 'rejoined after leaving on purpose')
  return 'invitation page after reload; not rejoined'
})

ok.newTab = await tc('RR-05', 'The same link opened in a new tab (not a refresh) shows the normal page', 'New tab → invitation page "Join meeting", not straight into the room', async () => {
  const p2 = await newPage({ width: 390, height: 844, mobile: true })
  await p2.goto(`/join/${token}`)
  await p2.getByRole('button', { name: 'Join meeting' }).waitFor({ timeout: 20_000 })
  check((await inRoom(p2).count()) === 0, 'new tab went into the room')
  return 'normal invitation page'
})

ok.link = await tc('RR-06', 'Guest from the shared meeting link (/m/…) refreshes in the meeting: back in at once, not asked to wait again',
  'Link page → name → waiting → host admits → reload → room again, no link page / pre-join / waiting room; host sees the guest', async () => {
    const link = await api.req('GET', `/meetings/${meetingId}/link`)
    check(link.status === 200 && link.data.path, `no meeting link: ${link.status}`)
    const NAME = `Link Guest ${tag}`
    const g = await newPage({ width: 390, height: 844, mobile: true })
    await g.goto(link.data.path)
    await g.getByTestId('link-join').click()
    await g.getByText('Ready to join?').waitFor({ timeout: 25_000 })
    await g.getByTestId('prejoin-name').fill(NAME)
    await g.getByRole('button', { name: 'Ask to join' }).click()
    await g.getByTestId('waiting-room').waitFor({ timeout: 15_000 })
    await host.getByTestId('waiting-badge').waitFor({ timeout: 20_000 })
    if (!(await host.getByTestId('waiting-entry').count())) await host.getByTestId('ctl-people').click()
    await host.getByTestId('waiting-entry').filter({ hasText: NAME }).getByTestId('waiting-admit').click()
    await inRoom(g).waitFor({ timeout: 25_000 })
    const before = entries()
    const seen = []
    const watch = setInterval(async () => {
      for (const [k, sel] of [['pre-join', g.getByText('Ready to join?')], ['waiting', g.getByTestId('waiting-room')], ['link page', g.getByTestId('link-join')]])
        if (await sel.count().catch(() => 0)) seen.push(k)
    }, 150)
    await g.reload()
    await inRoom(g).waitFor({ timeout: 20_000 })
    clearInterval(watch)
    check(seen.length === 0, `showed ${[...new Set(seen)].join(', ')} on the way back`)
    check(entries() === before, 'a new waiting-room entry was created')
    await until(async () => (await host.getByText(NAME).count()) > 0, 'host does not see the link guest after the refresh', 20_000)
    return `back in the room under the same name "${NAME}"; not queued again`
  })

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
retire()
await closeAll()
writeResults('refresh-rejoin')
