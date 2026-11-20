// GoodDay #14227 (16 Nov 2026): "in some mobiles if we go back from Chrome or Google from the meeting, after a few seconds the
// user shows as exited; when the user opens the same URL again they show". The phone's Back navigated away from the meeting
// page (which leaves the call). Now Back inside the room asks "Leave the meeting?" (Stay / Leave meeting) instead.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14227-back.mjs
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 6 min - giving up'); process.exit(2) }, 6 * 60_000).unref()
import { Api, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const ok = {}

const CUSTOMER = { email: `gd14227b2.${tag}@example.test`, name: 'Back Customer' }
const api = await new Api().login(HOST.email)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14227B ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  guests: [{ name: CUSTOMER.name, email: CUSTOMER.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${CUSTOMER.email}' ORDER BY OutboxId DESC`)
const token = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]

const host = await newPage({ width: 1366, height: 860 })
await loginUI(host, HOST.email)
await host.goto(`/meetings/${meetingId}/room`)
await host.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })

// The customer arrives from another page (as from Google / WhatsApp), so Back has somewhere to go.
const phone = await newPage({ width: 390, height: 844, mobile: true })
await phone.goto('/login')
await phone.goto(`/join/${token}`)
await phone.getByRole('button', { name: 'Join meeting' }).click()
await phone.getByText('Ready to join?').waitFor({ timeout: 25_000 })
await phone.getByRole('button', { name: /Join now|Ask to join|Join meeting/ }).last().click()
await phone.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
await sleep(1500)
const hostSees = async () => (await host.getByText(CUSTOMER.name).count()) > 0
await until(hostSees, 'host does not see the customer', 20_000)
const leaveDlg = phone.getByRole('dialog', { name: 'Leave the meeting?' })

ok.stay = await tc('GD14227-04', '#14227 Customer on a phone presses Back in the meeting: asked "Leave the meeting?"; Stay keeps them in the call',
  'Back → dialog, same address, still in the room; after 10 s the host still sees the customer; Back again → asked again', async () => {
    const url0 = phone.url()
    await phone.evaluate(() => history.back())
    await leaveDlg.waitFor({ timeout: 8000 })
    check(phone.url() === url0, `address changed: ${phone.url()}`)
    check((await phone.locator('[data-testid="meeting-room"]').count()) === 1, 'customer left the room')
    await phone.screenshot({ path: path.join(SHOTS, 'gd14227-back-dialog.png') })
    await phone.getByTestId('back-guard-stay').click()
    await leaveDlg.waitFor({ state: 'detached', timeout: 5000 })
    await sleep(10_000)
    check(await hostSees(), 'host no longer sees the customer after Stay')
    check((await phone.locator('[data-testid="meeting-room"]').count()) === 1, 'customer not in the room after Stay')
    await phone.evaluate(() => history.back())
    await leaveDlg.waitFor({ timeout: 8000 })
    return `dialog on Back, address unchanged, still connected 10 s later (host sees "${CUSTOMER.name}"), asked again on a second Back`
  })

ok.leave = await tc('GD14227-05', '#14227 "Leave meeting" in that dialog leaves like the Leave button',
  'Leave meeting → the customer is out of the room (exit screen) and disappears for the host', async () => {
    await phone.getByTestId('back-guard-leave').click()
    await until(async () => (await phone.locator('[data-testid="meeting-room"]').count()) === 0, 'customer still in the room', 15_000)
    await until(async () => !(await hostSees()), 'host still sees the customer', 20_000)
    return 'left; host no longer sees the customer'
  })

ok.host = await tc('GD14227-06', '#14227 The host on a computer gets the same question on Back (the call is not dropped by accident)',
  'Back → "Leave the meeting?"; Stay → still in the room', async () => {
    await host.evaluate(() => history.back())
    const dlg = host.getByRole('dialog', { name: 'Leave the meeting?' })
    await dlg.waitFor({ timeout: 8000 })
    await host.getByTestId('back-guard-stay').click()
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    await sleep(2000)
    check((await host.locator('[data-testid="meeting-room"]').count()) === 1, 'host left the room')
    return 'asked; stayed in the room'
  })

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
retire()
await closeAll()
writeResults('goodday-14227-back')
