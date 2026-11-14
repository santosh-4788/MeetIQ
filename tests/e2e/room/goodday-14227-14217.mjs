// GoodDay 14 Nov 2026 (afternoon):
//  #14227 "If customer is minimizing the app and running the meet in background he is not showing in the meeting" - a phone
//         pauses the browser in the background and the connection times out (production OIC-261114-FJX2, Android 10 Chrome:
//         connection closed 10-25 s after minimising, rejoined by itself on return). Now the others see "<name> is away" until
//         the person is back (max 3 min); the screen is kept on during a call (Screen Wake Lock), so it does not lock by itself.
//  #14217 (reopened, retitled) "Remove the after radio button and occurrence input field from the repeat button" - a series
//         now ends on a date only.
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14227-14217.mjs
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 7 min - giving up'); process.exit(2) }, 7 * 60_000).unref()
import { Api, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const ok = {}

ok.repeat = await tc('GD14217-02', '#14217 Repeat: no "After" choice and no Occurrences box; the series ends on a date', 'No ends-after / occurrences / "After" text; "Ends on" date; weekly until +14 days → 3 meetings', async () => {
  const p = await newPage({ width: 1366, height: 900 })
  await loginUI(p, HOST.email)
  await p.goto('/schedule')
  const form = p.getByTestId('schedule-form')
  await form.getByLabel('Title', { exact: true }).fill(`GD14217 until ${tag}`)
  await form.getByLabel('Category').selectOption('INTERNAL_MEETING')
  await form.getByText('Repeat this meeting').click()
  const editor = p.getByTestId('recurrence-editor')
  await editor.waitFor()
  check((await p.getByTestId('ends-after').count()) === 0, '"After" radio still shown')
  check((await p.getByTestId('occurrences').count()) === 0, 'Occurrences box still shown')
  const text = await editor.innerText()
  check(!/\bAfter\b|Occurrences/.test(text), `editor text still mentions After/Occurrences: ${text}`)
  check((await p.getByTestId('ends-on-date').count()) === 1 && /Ends on/.test(text), 'no "Ends on" date')
  // End date = today (the default start date) + 14 days, picked in the calendar (weekly → 3 meetings).
  const startDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const end = new Date(Date.parse(startDate + 'T00:00:00Z') + 14 * 86_400_000)
  const iso = end.toISOString().slice(0, 10)
  const monthName = end.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  await p.getByTestId('ends-on-date').getByRole('button').first().click()
  // The calendar opens on the current end date's month (90 days ahead by default): step to the target month.
  const target = end.getUTCFullYear() * 12 + end.getUTCMonth()
  for (let i = 0; i < 24 && !(await p.getByText(monthName, { exact: true }).count()); i++) {
    const shown = await p.getByRole('button', { name: 'Previous month' }).locator('xpath=following-sibling::p[1]').innerText()
    const d = new Date(`1 ${shown} UTC`)
    await p.getByRole('button', { name: d.getUTCFullYear() * 12 + d.getUTCMonth() > target ? 'Previous month' : 'Next month' }).click()
  }
  await p.getByRole('button', { name: String(end.getUTCDate()), exact: true }).last().click()
  check((await p.getByTestId('ends-on-date').innerText()).includes(String(end.getUTCDate())), 'end date not set')
  await editor.scrollIntoViewIfNeeded()
  await p.screenshot({ path: path.join(SHOTS, 'gd14217-ends-on.png') })
  retire()
  await form.getByRole('button', { name: /Schedule recurring meeting|Schedule meeting/ }).click()
  await p.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 25_000 })
  const n = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.Meetings WHERE Title = N'GD14217 until ${tag}'`))
  check(n === 3, `${n} meetings created (expected 3, start ${startDate}, ends ${iso})`)
  retire()
  return `no After/Occurrences; "Ends on" ${iso}; ${n} weekly meetings scheduled`
})

// ---- #14227 -------------------------------------------------------------------------------------------------------------
const GUEST = { email: `gd14227.${tag}@example.test`, name: 'Naved Phone' }
const api = await new Api().login(HOST.email)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `GD14227 ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  guests: [{ name: GUEST.name, email: GUEST.email }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
const mail = scalar(`SELECT TOP 1 BodyHtml AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid} AND ToAddress = N'${GUEST.email}' ORDER BY OutboxId DESC`)
const guestToken = mail.match(/\/join\/([A-Za-z0-9_-]+)/)[1]

const host = await newPage({ width: 1366, height: 860 })
// Count Screen Wake Lock requests (headless Chromium may refuse them; the request itself is what this checks).
await host.addInitScript(() => {
  window.__wakeLocks = 0
  const fake = { request: async () => { window.__wakeLocks++; return { release: async () => {} } } }
  try { Object.defineProperty(navigator, 'wakeLock', { value: fake, configurable: true }) } catch {}
})
await loginUI(host, HOST.email)
await host.goto(`/meetings/${meetingId}/room`)
await host.getByRole('button', { name: /Start meeting|Join/ }).first().click()
await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })

const joinGuest = async () => {
  const g = await newPage({ width: 390, height: 844, mobile: true })
  await g.goto(`/join/${guestToken}`)
  await g.getByRole('button', { name: 'Join meeting' }).click()
  await g.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await g.getByRole('button', { name: /Join now|Ask to join|Join meeting/ }).last().click()
  await g.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  return g
}

ok.away = await tc('GD14227-01', '#14227 Guest\'s phone pauses the call (tab stops without leaving): the host sees "<name> is away"; it clears when the guest is back', 'away-notice with the guest name within 60 s; gone after the guest rejoins; Screen Wake Lock requested in the call', async () => {
  const wake = await host.evaluate(() => window.__wakeLocks)
  check(wake >= 1, `screen wake lock requested ${wake} time(s)`)
  let guest = await joinGuest()
  await until(async () => (await host.getByTestId('participant-list').count()) || (await host.locator(`text=${GUEST.name}`).count()), 'host does not see the guest', 20_000)
  // A paused/killed phone browser: the page stops without "pagehide", so no leave is sent - the server times the connection out.
  const cdp = await guest.context().newCDPSession(guest)
  const t0 = Date.now()
  void cdp.send('Page.crash').catch(() => {}) // never answers: the tab is gone
  const notice = host.getByTestId('away-notice')
  await notice.waitFor({ timeout: 60_000 })
  const secs = Math.round((Date.now() - t0) / 1000)
  const text = await notice.innerText()
  check(text.includes(GUEST.name) && /is away/.test(text), `notice "${text}"`)
  await host.screenshot({ path: path.join(SHOTS, 'gd14227-host-away.png') })
  const reason = scalar(`SELECT TOP 1 a.LeaveReason AS v FROM mtg.MeetingAttendance a JOIN mtg.MeetingParticipants p ON p.ParticipantId = a.ParticipantId WHERE a.MeetingId = ${mid} AND p.ParticipantType = 'GUEST' ORDER BY a.AttendanceId DESC`)
  await guest.context().browser().close().catch(() => {})
  guest = await joinGuest()
  await notice.waitFor({ state: 'detached', timeout: 20_000 })
  // A normal "Leave" is not "away".
  await guest.getByTestId('ctl-leave').click().catch(() => {})
  const confirm = guest.getByRole('button', { name: /^Leave/ })
  if (await confirm.count()) await confirm.last().click().catch(() => {})
  await sleep(6000)
  check((await host.getByTestId('away-notice').count()) === 0, 'away notice shown after a normal Leave')
  return `"${text.slice(0, 80)}…" after ${secs} s (leave reason ${reason}); cleared on rejoin; not shown after a normal Leave; wake lock requests ${wake}`
})

await api.req('POST', `/meetings/${meetingId}/room/end`, {}).catch(() => {})
await closeAll()
writeResults('goodday-14227-14217')
