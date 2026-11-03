// Advanced features, Phase B — instant meeting, shareable link, guest waiting room, colleague via link, block, withdraw,
// audio-only and the link page at phone width. Same isolated environment as room.mjs (see harness.mjs).
//
// Run:  cd "E:\OneInsure Connect\tests\e2e"; node room\instant-link.mjs
import {
  Api, EMP, HOST, check, closeAll, closePage, exec, inbound, log, loginUI, newPage, overflowX, scalar, sql, tc, tileVideo, until, view, writeResults,
} from './harness.mjs'

// Earlier runs: retire their instant meetings so nothing is left "live" in the test database.
exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE') AND MeetingKind = 'INSTANT'")

const GUEST_NAME = 'Lata Link (Acme)'
const host = await newPage()
let meetingId, mid, linkUrl, guest, colleague, late
const ok = {}

ok.start = await tc('IL-01', 'Host starts an instant meeting from the dashboard', '"New meeting" → dialog → Start → pre-join (no schedule) → room; Invite dialog shows the link; meeting INSTANT and LIVE', async () => {
  await loginUI(host, HOST.email)
  await host.getByTestId('new-meeting').click()
  await host.getByLabel('Title (optional)').fill('Instant E2E')
  await view(host, 'il-new-meeting-dialog')
  await host.getByTestId('start-instant').click()
  await host.waitForURL(/\/meetings\/[0-9a-f-]{36}\/room/)
  meetingId = host.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  await host.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await host.getByRole('button', { name: 'Start meeting' }).click()
  await host.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  const box = host.getByTestId('meeting-link')
  await box.waitFor({ timeout: 15_000 })
  linkUrl = await box.inputValue()
  await view(host, 'il-invite-dialog')
  check(/\/m\/[A-Za-z0-9_-]{40,}$/.test(linkUrl), `link "${linkUrl}"`)
  const row = sql(`SELECT MeetingId, MeetingKind, [Status] FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)[0]
  mid = row.MeetingId
  check(row.MeetingKind === 'INSTANT', `kind ${row.MeetingKind}`)
  await until(() => scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${mid}`) === 'LIVE', 'meeting not LIVE')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM app.EmailOutbox WHERE RelatedMeetingId = ${mid}`)) === 0, 'e-mails were queued for an instant meeting')
  await host.keyboard.press('Escape')
  return `instant meeting ${meetingId} LIVE; link ${linkUrl.replace(/\/m\/.+/, '/m/…')} shown in the Invite dialog; no e-mails`
})

ok.guest = ok.start && await tc('IL-02', 'Guest without an account asks to join through the link and waits', 'Link page (title, organiser, waiting-room note) → name + device check → waiting screen; nothing of the meeting is shown', async () => {
  guest = await newPage()
  await guest.goto(new URL(linkUrl).pathname)
  await guest.getByText('Instant E2E').first().waitFor()
  await view(guest, 'il-link-page')
  const text = await guest.locator('body').innerText()
  check(!text.includes(EMP.name), 'link page shows participant names')
  await guest.getByTestId('link-join').click()
  await guest.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await guest.getByTestId('prejoin-name').fill(GUEST_NAME)
  await guest.getByRole('button', { name: 'Ask to join' }).click()
  await guest.getByTestId('waiting-room').waitFor({ timeout: 15_000 })
  await view(guest, 'il-guest-waiting')
  check(!(await guest.locator('[data-testid="meeting-room"]').count()), 'guest is in the room without admission')
  const p = sql(`SELECT ParticipantType, JoinSource, AdmissionRequired FROM mtg.MeetingParticipants WHERE MeetingId = ${mid} AND GuestName = N'${GUEST_NAME}'`)[0]
  check(p?.ParticipantType === 'GUEST' && p.JoinSource === 'LINK' && p.AdmissionRequired, `participant ${JSON.stringify(p)}`)
  return 'waiting; GUEST participant created via LINK with admission required'
})

ok.admit = ok.guest && await tc('IL-03', 'Host admits the link guest; media flows both ways', 'Waiting badge → Participants shows "Guest · via meeting link" → Admit → guest in the room, sees the host; host receives guest media', async () => {
  await host.getByTestId('waiting-badge').waitFor({ timeout: 20_000 })
  await host.getByTestId('ctl-people').click()
  const entry = host.getByTestId('waiting-entry').filter({ hasText: GUEST_NAME })
  check((await entry.innerText()).includes('via meeting link'), 'waiting entry does not say "via meeting link"')
  await view(host, 'il-host-waiting')
  await entry.getByTestId('waiting-admit').click()
  await guest.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  const hostId = scalar(`SELECT p.LiveKitIdentity AS v FROM mtg.MeetingParticipants p WHERE p.MeetingId = ${mid} AND p.[Role] = 'HOST'`)
  const guestId = scalar(`SELECT LiveKitIdentity AS v FROM mtg.MeetingParticipants WHERE MeetingId = ${mid} AND GuestName = N'${GUEST_NAME}'`)
  await until(async () => (await tileVideo(guest, hostId))?.w > 0, 'guest does not see the host video')
  await until(async () => (await tileVideo(host, guestId))?.w > 0, 'host does not see the guest video')
  const a = await inbound(host)
  await new Promise((r) => setTimeout(r, 3000))
  const b = await inbound(host)
  check(b.audio > a.audio && b.video > a.video, `host inbound not growing ${JSON.stringify([a, b])}`)
  return `admitted; host +${b.audio - a.audio} B audio / +${b.video - a.video} B video in 3 s from the guest`
})

ok.colleague = ok.start && await tc('IL-04', 'Non-invited colleague uses "Join meeting" with the link', 'Dashboard "Join meeting" → paste link → "Continue as Esha Employee" → waiting → admitted as an employee', async () => {
  colleague = await newPage()
  await loginUI(colleague, EMP.email)
  await colleague.getByTestId('join-meeting').click()
  await colleague.getByTestId('join-input').fill(linkUrl)
  await colleague.getByRole('button', { name: 'Join', exact: true }).click()
  await colleague.getByTestId('link-join').click()
  await colleague.getByText('Ready to join?').waitFor({ timeout: 25_000 })
  await colleague.getByRole('button', { name: 'Ask to join' }).click()
  await colleague.getByTestId('waiting-room').waitFor({ timeout: 15_000 })
  const entry = host.getByTestId('waiting-entry').filter({ hasText: EMP.name })
  await entry.waitFor({ timeout: 20_000 })
  check((await entry.innerText()).includes('Colleague (not invited)'), 'not labelled as a colleague')
  await entry.getByTestId('waiting-admit').click()
  await colleague.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  const p = sql(`SELECT p.ParticipantType, p.JoinSource FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = ${mid} AND e.EmployeeCode = 'RM-0002'`)[0]
  check(p?.ParticipantType === 'EMPLOYEE' && p.JoinSource === 'LINK', JSON.stringify(p))
  return 'colleague joined as EMPLOYEE (via link) after admission'
})

ok.block = ok.admit && await tc('IL-05', 'Host removes the guest and blocks re-entry', 'Remove → tick "Do not allow them to rejoin" → guest sees "You were removed"; Rejoin is refused', async () => {
  const guestId = scalar(`SELECT LiveKitIdentity AS v FROM mtg.MeetingParticipants WHERE MeetingId = ${mid} AND GuestName = N'${GUEST_NAME}'`)
  await host.locator(`[data-testid="participant"][data-identity="${guestId}"]`).getByTestId('participant-remove').click()
  await host.getByTestId('remove-block').check()
  await host.getByRole('button', { name: 'Remove from meeting' }).click()
  await guest.getByText('You were removed from the meeting').waitFor({ timeout: 15_000 })
  // No "Rejoin" after a removal: back to the link page and ask again (same browser, same personal token).
  await guest.getByRole('button', { name: 'Back' }).click()
  await guest.getByTestId('link-join').click()
  await guest.getByText('Ready to join?').waitFor({ timeout: 15_000 })
  await guest.getByRole('button', { name: 'Ask to join' }).click()
  await until(async () => /no longer works|invalid|withdrawn|expired/i.test(await guest.locator('body').innerText()), 'blocked guest was not refused', 15_000)
  await view(guest, 'il-guest-blocked')
  check(Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingParticipants WHERE MeetingId = ${mid} AND GuestName = N'${GUEST_NAME}' AND IsBlocked = 1`)) === 1, 'not blocked in SQL')
  return 'removed, blocked in SQL, rejoin refused'
})

ok.withdraw = ok.start && await tc('IL-06', 'Host withdraws the link', 'Invite → Withdraw → confirm; a new visitor sees "This meeting link no longer works"', async () => {
  await host.getByTestId('ctl-invite').click()
  await host.getByRole('button', { name: 'Withdraw', exact: true }).click()
  await host.getByRole('button', { name: 'Withdraw link' }).click()
  await host.getByText('The link was withdrawn').waitFor()
  await host.keyboard.press('Escape')
  late = await newPage()
  await late.goto(new URL(linkUrl).pathname)
  await late.getByText('This meeting link no longer works').waitFor()
  return 'old link refused with an explanation'
})

// The remaining cases need no live meeting: close the room browsers so the PC is not decoding three video streams.
for (const p of [late, guest, colleague, host]) if (p) await closePage(p)

ok.audio = await tc('IL-07', 'Audio-only instant meeting', 'Pre-join says "Audio-only meeting" with no camera choice; the room has no camera button; the token has no camera source', async () => {
  const api = await new Api().login(HOST.email)
  const r = await api.req('POST', '/meetings/instant', { title: 'Audio only E2E', audioOnly: true })
  check(r.status === 201, `instant ${r.status}`)
  const p = await newPage()
  await loginUI(p, HOST.email)
  await p.goto(`/meetings/${r.data.id}/room`)
  await p.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  check(await p.getByText('Audio-only meeting').isVisible(), 'pre-join does not say audio-only')
  check(!(await p.getByLabel('Camera', { exact: true }).count()), 'camera selector shown')
  await p.getByRole('button', { name: 'Start meeting' }).click()
  await p.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  check(!(await p.getByTestId('ctl-cam').count()), 'camera button shown in an audio-only room')
  check(await p.getByTestId('ctl-mic').isVisible(), 'microphone button missing')
  return 'audio-only enforced in pre-join, room controls and token'
})

ok.mobile = ok.start && await tc('IL-08', 'Link page and dashboard actions at phone width (390 px)', 'No horizontal scroll; Join button visible', async () => {
  const link = await (await new Api().login(HOST.email)).req('GET', `/meetings/${meetingId}/link`)
  const phone = await newPage({ width: 390, height: 844, mobile: true })
  await phone.goto(link.data.path)
  await phone.getByTestId('link-join').waitFor()
  const over = await overflowX(phone)
  await view(phone, 'il-link-page-390')
  check(over <= 0, `horizontal overflow ${over}px`)
  const dash = await newPage({ width: 390, height: 844, mobile: true })
  await loginUI(dash, HOST.email)
  await dash.getByTestId('new-meeting').waitFor()
  const over2 = await overflowX(dash)
  await view(dash, 'il-dashboard-390')
  check(over2 <= 0, `dashboard horizontal overflow ${over2}px`)
  return 'link page and dashboard fit 390 px without horizontal scroll'
})

await closeAll()
log(Object.entries(ok).map(([k, v]) => `${k}:${v ? 'ok' : 'FAIL'}`).join(' '))
process.exit(writeResults('instant-link-results', { meetingId }) ? 0 : 1)
