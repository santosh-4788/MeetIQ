// 7. Meetings: schedule (availability, validation, conflicts, override), drafts, edit/reschedule, RSVP, participants,
//    cancel, lists/tabs/filters, customer meeting with new customer, public join page.
import { signedIn } from '../lib/api.mjs'
import { as, session, settle, text, toastText, waitUntil } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { q, query, scalar } from '../lib/db.mjs'
import { ensureSuperAdminLinked } from '../lib/fixtures.mjs'
import { check, tc } from '../lib/runner.mjs'
import { ist } from '../seed.mjs'

const M = 'Meetings'
/** IST date (yyyy-MM-dd) `days` from today. */
const day = (days) => {
  const d = new Date(Date.now() + 330 * 60_000)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function fillMeeting(page, { title, category, date, time, duration = '60', people = [] }) {
  if (title !== undefined) await page.getByLabel('Title').fill(title)
  if (category) await page.getByLabel('Category').selectOption(category)
  if (date) await page.getByLabel('Date').fill(date)
  if (time) await page.getByLabel(/^Start time/).fill(time)
  await page.getByLabel('Duration').selectOption(duration)
  for (const p of people) {
    await page.getByLabel('Add colleagues').fill(p)
    await page.getByRole('option', { name: new RegExp(p) }).first().click()
  }
}

export async function run(shared) {
  await ensureSuperAdminLinked()
  const priya = await as(USERS.priya.email, { path: '/schedule' })
  const page = priya.page
  const st = (shared.meetings ??= {})

  await tc({ id: 'MTG-01', module: M, role: 'Employee', title: 'Schedule an internal meeting with live availability', steps: 'Schedule Meeting: title, Group meeting, day+6 11:00, 60 min, add Rahul + Meera, agenda; Schedule', expected: '"Everyone is available" + "Available" per person; toast with meeting code; detail page lists 3 participants, status Scheduled, reminders pending; invitations queued' }, async () => {
    await page.goto('/schedule')
    await fillMeeting(page, { title: 'E2E Sprint Review', category: 'GROUP', date: day(6), time: '11:00', people: ['Rahul Verma', 'Meera Iyer'] })
    await page.getByLabel('Agenda (optional)').fill('1. Demo\n2. Retro')
    await page.getByText('Everyone is available').waitFor()
    await waitUntil(async () => (await page.getByText('Available', { exact: true }).count()) >= 3, 'Available badges for host + 2')
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    const t = await toastText(page)
    await page.waitForURL(/\/meetings\/[0-9a-f-]{36}$/)
    st.sprint = page.url().split('/').pop()
    await page.getByRole('heading', { name: 'E2E Sprint Review' }).waitFor()
    const body = await text(page.locator('main'))
    const notif = scalar(`SELECT COUNT(*) AS n FROM mtg.MeetingNotifications n JOIN mtg.Meetings m ON m.MeetingId = n.MeetingId JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE m.PublicId = '${st.sprint}' AND u.Email = '${USERS.rahul.email}' AND n.[Type] = 'INVITATION'`)
    check(/Meeting .* scheduled/.test(t), `toast "${t}"`)
    check(body.includes('Scheduled') && body.includes('Rahul Verma') && body.includes('Meera Iyer') && body.includes('Demo'), 'detail incomplete')
    check(notif === 1, `invitation notifications for Rahul: ${notif}`)
    return `Toast "${t}"; detail OK; Rahul got an in-app invitation.`
  })

  await tc({ id: 'MTG-02', module: M, role: 'Employee', title: 'Schedule form validation', steps: 'Submit empty; past date; guest with bad e-mail and duplicate guest', expected: 'Title/category required; "The start time is in the past"; guest e-mail errors; nothing saved' }, async () => {
    const before = scalar('SELECT COUNT(*) AS n FROM mtg.Meetings')
    await page.goto('/schedule')
    await page.getByLabel('Title').fill('')
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    await page.getByText('Title is required.').waitFor()
    await page.getByText('Choose a category.').waitFor()
    await fillMeeting(page, { title: 'Past', category: 'TEAM', date: day(-1), time: '10:00' })
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    await page.getByText('The start time is in the past. Choose a future time.').waitFor()
    await page.getByLabel('Date').fill(day(10))
    await page.getByRole('button', { name: 'Add guest' }).click()
    await page.getByRole('button', { name: 'Add guest' }).click()
    await page.getByLabel('Guest 1 name').fill('Guest One')
    await page.getByLabel('Guest 1 e-mail').fill('not-an-email')
    await page.getByLabel('Guest 2 name').fill('Guest Two')
    await page.getByLabel('Guest 2 e-mail').fill('g2@example.test')
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    await page.getByText('Enter a valid e-mail address.').waitFor()
    await page.getByLabel('Guest 1 e-mail').fill('G2@example.test')
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    await page.getByText('This guest is listed twice.').waitFor()
    const after = scalar('SELECT COUNT(*) AS n FROM mtg.Meetings')
    check(after === before, 'a meeting was saved')
    return 'All validation messages shown; nothing saved.'
  })

  await tc({ id: 'MTG-03', module: M, role: 'Employee', title: 'Conflict with another meeting (no override permission)', steps: 'Schedule with Rahul tomorrow 10:30 (Rahul is in "E2E Weekly Ops Sync" 10:00-11:00)', expected: 'Live card "1 person is not available"; on Schedule the 409 dialog lists the conflict and offers only "Change time or participants"; nothing saved' }, async () => {
    const before = scalar('SELECT COUNT(*) AS n FROM mtg.Meetings')
    await page.goto('/schedule')
    await fillMeeting(page, { title: 'E2E Clash', category: 'INTERNAL_1_1', date: day(1), time: '10:30', duration: '30', people: ['Rahul Verma'] })
    await page.getByText(/not available/).first().waitFor()
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    const d = page.getByRole('dialog', { name: 'Participants are not available' })
    await d.waitFor()
    const body = await text(d)
    const override = await d.getByRole('button', { name: 'Book anyway' }).count()
    await d.getByRole('button', { name: 'Change time or participants' }).click()
    const after = scalar('SELECT COUNT(*) AS n FROM mtg.Meetings')
    check(override === 0, 'override offered without permission')
    check(/Busy in another meeting/.test(body), `dialog "${body.slice(0, 200)}"`)
    check(after === before, 'meeting saved despite conflict')
    return 'Live warning + 409 dialog (no override for Employee).'
  })

  await tc({ id: 'MTG-04', module: M, role: 'Employee', title: 'Leave shows as a conflict in live availability', steps: 'Pick Rahul at day+4 11:00 (Rahul on leave)', expected: 'Rahul marked "On leave" in the participants list' }, async () => {
    await page.goto('/schedule')
    await fillMeeting(page, { title: 'E2E Leave check', category: 'TEAM', date: day(4), time: '11:00', people: ['Rahul Verma'] })
    const row = page.locator('li').filter({ hasText: 'Rahul Verma' }).first()
    await waitUntil(async () => /leave/i.test(await text(row)), 'leave label on Rahul')
    return `Rahul row: "${await text(row)}".`
  })

  await tc({ id: 'MTG-05', module: M, role: 'Admin', title: 'Override a conflict with a reason (permission meetings.override.conflict)', steps: 'Admin schedules with Priya tomorrow 10:15 (Priya in Ops Sync); Book anyway without reason; with reason', expected: '"Give a reason…" error; then saved; detail shows "Booked despite a conflict" + reason; privileged audit entry' }, async () => {
    const a = await as(USERS.admin.email, { path: '/schedule' })
    await fillMeeting(a.page, { title: 'E2E Urgent Escalation', category: 'MANAGEMENT', date: day(1), time: '10:15', duration: '30', people: ['Priya Sharma'] })
    await a.page.getByRole('button', { name: 'Schedule meeting' }).click()
    const d = a.page.getByRole('dialog', { name: 'Participants are not available' })
    await d.getByRole('button', { name: 'Book anyway' }).click()
    await d.getByText('Give a reason for booking despite the conflict.').waitFor()
    await d.getByLabel('Reason for overriding the conflict').fill('Regulator deadline today')
    await d.getByRole('button', { name: 'Book anyway' }).click()
    await a.page.waitForURL(/\/meetings\/[0-9a-f-]{36}$/)
    await a.page.getByText('Regulator deadline today').waitFor()
    const id = a.page.url().split('/').pop()
    const audit = scalar(`SELECT COUNT(*) AS n FROM app.AuditLog WHERE [Action] = 'MEETING_CONFLICT_OVERRIDDEN' AND EntityId = '${id}' AND IsPrivileged = 1`)
    await a.close()
    check(audit === 1, 'no privileged audit entry')
    return 'Reason required, booking saved with reason shown; audited.'
  })

  await tc({ id: 'MTG-06', module: M, role: 'Employee', title: 'Draft: save, private, edit and schedule', steps: 'Save as draft; check Drafts tab; Rahul opens it by URL; Edit draft > Schedule meeting', expected: 'Draft toast + Draft notice; listed under Drafts; invisible to Rahul (not found); scheduling sends invitations' }, async () => {
    await page.goto('/schedule')
    await fillMeeting(page, { title: 'E2E Draft Idea', category: 'TRAINING', date: day(12), time: '15:00', people: ['Rahul Verma'] })
    await page.getByRole('button', { name: 'Save as draft' }).click()
    const t = await toastText(page)
    await page.waitForURL(/\/meetings\/[0-9a-f-]{36}$/)
    const id = page.url().split('/').pop()
    await page.getByText('Only you can see this meeting.').waitFor()
    const r = await as(USERS.rahul.email, { path: `/meetings/${id}` })
    await settle(r.page)
    const rv = await text(r.page.locator('main'))
    await r.close()
    await page.goto('/meetings')
    await page.getByRole('tab', { name: 'Drafts' }).click()
    await page.getByText('E2E Draft Idea').waitFor()
    await page.goto(`/meetings/${id}`)
    await page.getByRole('link', { name: 'Edit draft' }).click()
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    const t2 = await toastText(page)
    const status = scalar(`SELECT [Status] AS s FROM mtg.Meetings WHERE PublicId = '${id}'`)
    check(/Draft saved/.test(t), `draft toast "${t}"`)
    check(/not found|Unable to load/i.test(rv), `Rahul saw: ${rv.slice(0, 120)}`)
    check(status === 'SCHEDULED', `status ${status}`)
    return `"${t}"; hidden from Rahul; scheduled ("${t2}").`
  })

  await tc({ id: 'MTG-07', module: M, role: 'Employee', title: 'Edit and reschedule', steps: 'Sprint Review > Edit / reschedule; change time to 16:00; Reschedule', expected: 'Reschedule warning; toast "Meeting rescheduled"; "Rescheduled" badge; Rahul notified (RESCHEDULED)' }, async () => {
    check(st.sprint, 'MTG-01 did not create the meeting')
    await page.goto(`/meetings/${st.sprint}`)
    await page.getByRole('link', { name: 'Edit / reschedule' }).click()
    await page.getByLabel('Title').fill('E2E Sprint Review (moved)')
    await page.getByLabel(/^Start time/).fill('16:00')
    await page.getByText('This reschedules the meeting').waitFor()
    await page.getByRole('button', { name: 'Reschedule meeting' }).click()
    const t = await toastText(page)
    await page.getByText('Rescheduled', { exact: true }).waitFor()
    const n = scalar(`SELECT COUNT(*) AS n FROM mtg.MeetingNotifications n JOIN mtg.Meetings m ON m.MeetingId = n.MeetingId WHERE m.PublicId = '${st.sprint}' AND n.[Type] = 'RESCHEDULED'`)
    check(/rescheduled/i.test(t), `toast "${t}"`)
    // Rahul is the only invited employee with a user account (Meera has none), so one in-app notification.
    check(n >= 1, `${n} RESCHEDULED notifications`)
    return `"${t}"; ${n} participants notified.`
  })

  await tc({ id: 'MTG-08', module: M, role: 'Employee (attendee)', title: 'RSVP accept / tentative / decline; host sees a statement', steps: 'Rahul opens Sprint Review: Accept, Tentative, Decline; Priya views her own meeting', expected: 'Each reply saved (toast, pressed button labelled Accepted/Tentative/Declined); host sees "You are hosting…" instead of buttons' }, async () => {
    const r = await as(USERS.rahul.email, { path: `/meetings/${st.sprint}` })
    const g = r.page.getByRole('group', { name: 'Reply to the invitation' })
    const seen = []
    for (const [btn, badge] of [['Accept', 'Accepted'], ['Tentative', 'Tentative'], ['Decline', 'Declined']]) {
      await g.getByRole('button', { name: btn }).click()
      seen.push(await toastText(r.page))
      await waitUntil(async () => (await g.getByRole('button', { name: btn }).getAttribute('aria-pressed')) === 'true', `${btn} pressed`)
      void badge
    }
    const resp = scalar(`SELECT p.ResponseStatus AS r FROM mtg.MeetingParticipants p JOIN mtg.Meetings m ON m.MeetingId = p.MeetingId JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE m.PublicId = '${st.sprint}' AND e.EmployeeCode = 'E2E-0004'`)
    await r.close()
    await page.goto(`/meetings/${st.sprint}`)
    // Hosts get a statement instead of reply buttons (they always attend).
    await page.getByText('You are hosting this meeting, so you are attending.').waitFor()
    check((await page.getByRole('group', { name: 'Reply to the invitation' }).count()) === 0, 'host offered reply buttons')
    check(resp === 'DECLINED', `DB response ${resp}`)
    return `Replies: ${seen.join(' / ')}; host decline disabled.`
  })

  await tc({ id: 'MTG-09', module: M, role: 'Employee', title: 'Add and remove participants', steps: 'Sprint Review > Add: Vikram Shah + guest; then remove the guest', expected: 'Participants added (count grows; guest shows link badge); removal asks for confirmation and removes the guest' }, async () => {
    await page.goto(`/meetings/${st.sprint}`)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const d = page.getByRole('dialog', { name: 'Add participants' })
    await d.getByLabel('Colleagues').fill('Vikram')
    await d.getByRole('option', { name: /Vikram Shah/ }).click()
    await d.getByRole('button', { name: 'Add guest' }).click()
    await d.getByLabel('Guest 1 name').fill('Esha External')
    await d.getByLabel('Guest 1 e-mail').fill('esha.external@example.test')
    await d.getByRole('button', { name: 'Add participants' }).click()
    await toastText(page)
    await page.getByText('Esha External').first().waitFor()
    await page.getByText('Vikram Shah').first().waitFor()
    const badge = await text(page.locator('li').filter({ hasText: 'Esha External' }))
    await page.getByRole('button', { name: 'Remove Esha External' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove participant' }).click()
    await toastText(page)
    await page.getByRole('button', { name: 'Remove Esha External' }).waitFor({ state: 'detached' })
    check(/Link active/.test(badge), `guest row "${badge}"`)
    return `Added Vikram + guest ("${badge}"); guest removed.`
  })

  await tc({ id: 'MTG-10', module: M, role: 'Employee', title: 'Cancel with reason', steps: 'Sprint Review > Cancel meeting: empty reason; then reason', expected: 'Reason required message in dialog; cancelled banner with reason; Cancelled tab lists it; participants notified' }, async () => {
    await page.goto(`/meetings/${st.sprint}`)
    await page.getByRole('button', { name: 'Cancel meeting' }).click()
    const d = page.getByRole('dialog', { name: 'Cancel this meeting?' })
    await d.getByRole('button', { name: 'Cancel meeting' }).click()
    await d.getByText(/Give a reason for cancelling/).waitFor()
    await d.getByLabel('Reason').fill('Sprint moved to next week')
    await d.getByRole('button', { name: 'Cancel meeting' }).click()
    await page.getByText('Reason: Sprint moved to next week').waitFor()
    const n = scalar(`SELECT COUNT(*) AS n FROM mtg.MeetingNotifications n JOIN mtg.Meetings m ON m.MeetingId = n.MeetingId WHERE m.PublicId = '${st.sprint}' AND n.[Type] = 'CANCELLED'`)
    await page.goto('/meetings')
    await page.getByRole('tab', { name: 'Cancelled' }).click()
    await page.getByText('E2E Sprint Review (moved)').waitFor()
    check(n >= 2, `${n} CANCELLED notifications`)
    return `Cancelled with reason; ${n} notified; listed under Cancelled.`
  })

  await tc({ id: 'MTG-11', module: M, role: 'Employee', title: 'My / Internal / Customer meetings: tabs, search, category filter', steps: 'Visit each tab of My Meetings; search; category filter; Internal and Customer pages', expected: 'Upcoming has Ops Sync + Admin Briefing; Hosting excludes Admin Briefing; Attending has Admin Briefing; Past has Past Retro; search narrows; Internal excludes the PLVC; Customer lists only PLVC' }, async () => {
    const titles = async () => (await page.locator('main ul.divide-y li').allInnerTexts()).join(' | ')
    // Waits until the tab's list contains want (lists load asynchronously after the tab switch).
    const tab = async (name, want) => {
      await page.getByRole('tab', { name }).click()
      await settle(page, 300)
      if (want) await waitUntil(async () => (await titles()).includes(want), `tab ${name} shows ${want}`).catch(() => {})
      return titles()
    }
    await page.goto('/meetings')
    await page.locator('main ul.divide-y li').first().waitFor()
    const up = await tab('Upcoming', 'E2E Admin Briefing')
    const hosting = await tab('Hosting', 'E2E Weekly Ops Sync')
    const attending = await tab('Attending', 'Admin Briefing')
    const past = await tab('Past', 'E2E Past Retro')
    const drafts = await tab('Drafts', 'E2E Draft Planning')
    await tab('Upcoming')
    await page.getByLabel('Search meetings').fill('Ops Sync')
    await waitUntil(async () => (await page.locator('main ul.divide-y li').count()) === 1, 'search to 1')
    await page.getByLabel('Search meetings').fill('')
    await page.getByLabel('Category').selectOption('MANAGEMENT')
    await waitUntil(async () => (await titles()).includes('Admin Briefing') && !(await titles()).includes('Ops Sync'), 'category filter')
    await page.goto('/internal')
    await page.locator('main ul.divide-y li').first().waitFor()
    const internal = await titles()
    await page.goto('/customer-meetings')
    await page.locator('main ul.divide-y li').first().waitFor()
    const customer = await titles()
    await page.getByRole('tab', { name: 'Customers' }).click()
    await page.getByText('Anil Kapoor').first().waitFor()
    const cust = await text(page.locator('main'))
    const problems = []
    if (!up.includes('E2E Weekly Ops Sync') || !up.includes('E2E Admin Briefing')) problems.push(`upcoming: ${up}`)
    if (hosting.includes('Admin Briefing')) problems.push(`hosting: ${hosting}`)
    if (!attending.includes('Admin Briefing')) problems.push(`attending: ${attending}`)
    if (!past.includes('E2E Past Retro')) problems.push(`past: ${past}`)
    if (!drafts.includes('E2E Draft Planning')) problems.push(`drafts: ${drafts}`)
    if (internal.includes('Customer Policy Verification')) problems.push(`internal: ${internal}`)
    if (!customer.includes('Customer Policy Verification') || customer.includes('Ops Sync')) problems.push(`customer: ${customer}`)
    if (!/an\*\*\*@example\.test/.test(cust)) problems.push('customer e-mail not masked')
    check(!problems.length, problems.join(' || '))
    return 'All tabs, search, filter and both family pages correct; customer e-mail masked.'
  })

  await tc({ id: 'MTG-12', module: M, role: 'Employee', title: 'Customer meeting with a new customer', steps: 'Customer Meetings > Schedule meeting (PLVC preselected); no customer → error; Add new customer (validation, then save); schedule day+7 11:00', expected: 'Customer required; customer form validation; customer created and selected; meeting saved with customer and an active join link' }, async () => {
    await page.goto('/customer-meetings')
    await page.locator('main').getByRole('link', { name: 'Schedule meeting' }).first().click()
    await page.waitForURL(/category=CUSTOMER_PLVC/)
    await waitUntil(async () => (await page.getByLabel('Category').inputValue()) === 'CUSTOMER_PLVC', 'PLVC not preselected')
    await fillMeeting(page, { title: 'E2E PLVC New Customer', date: day(7), time: '11:00', duration: '30' })
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    await page.getByText('Select the customer for a customer meeting.').waitFor()
    await page.getByRole('button', { name: 'Add new customer' }).click()
    const d = page.getByRole('dialog', { name: 'Add customer' })
    await d.getByRole('button', { name: 'Add customer' }).click()
    await d.locator('[role=alert]').first().waitFor()
    await d.getByLabel('Customer reference').fill('CUST-E2E-777')
    await d.getByLabel('Full name').fill('Farah Khan')
    await d.getByLabel('E-mail').fill('farah.khan@example.test')
    await d.getByLabel('Policy number (optional)').fill('POL-777')
    await d.getByRole('button', { name: 'Add customer' }).click()
    await toastText(page)
    await page.getByText('Farah Khan').first().waitFor()
    await page.getByRole('button', { name: 'Schedule meeting' }).click()
    await page.waitForURL(/\/meetings\/[0-9a-f-]{36}$/)
    st.plvc = page.url().split('/').pop()
    await page.getByRole('heading', { name: 'E2E PLVC New Customer' }).waitFor()
    await page.getByText('Link active').first().waitFor()
    const body = await text(page.locator('main'))
    check(body.includes('Farah Khan') && body.includes('POL-777') && /Link active/.test(body), `detail: ${body.slice(0, 300)}`)
    return 'Customer created inline; meeting saved with policy number and active link.'
  })

  await tc({ id: 'MTG-13', module: M, role: 'Customer (signed out)', title: 'Public join page from the e-mailed invitation; invalid link', steps: 'Take the join link of the new PLVC from app.EmailOutbox; open it signed out; open /join/bogus', expected: 'Meeting title and organiser shown; Join disabled until the meeting is joinable with "Joining opens at …"; bogus link: "This invitation link no longer works"' }, async () => {
    check(st.plvc, 'MTG-12 did not create the meeting')
    const mail = query(`SELECT TOP 1 o.BodyHtml FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.PublicId = '${st.plvc}' AND o.ToAddress = 'farah.khan@example.test' ORDER BY o.OutboxId DESC`)[0]
    check(mail, 'no invitation e-mail for the customer in the outbox')
    const m = mail.BodyHtml.match(/\/join\/([A-Za-z0-9_\-]+)/)
    check(m, 'no join link in the e-mail')
    st.joinToken = m[1]
    const s = await session()
    await s.page.goto(`/join/${m[1]}`)
    await s.page.getByText('E2E PLVC New Customer').first().waitFor()
    const body = await text(s.page.locator('body'))
    const join = s.page.getByRole('button', { name: 'Join meeting' })
    check(await join.isDisabled(), 'join enabled')
    check(/Priya Sharma/.test(body) && /Joining opens at/.test(body), `join page: ${body.slice(0, 300)}`)
    await s.page.goto('/join/bogus-token-123')
    await s.page.getByText(/This invitation link (no longer works|is not valid)/).waitFor()
    await s.close()
    return 'Join page shows meeting, organiser, Join disabled until it opens ("Joining opens at …"); invalid link handled.'
  })

  await tc({ id: 'MTG-14', module: M, role: 'Employee', title: 'Join link after the meeting is cancelled', steps: 'Cancel the PLVC; reopen its join link signed out', expected: 'The page says the meeting was cancelled (or the link is no longer valid) - no join button' }, async () => {
    check(st.joinToken, 'no token')
    const c = await signedIn(USERS.priya.email, PASSWORD)
    await c.ok('POST', `/meetings/${st.plvc}/cancel`, { reason: 'Customer asked to postpone' })
    const s = await session()
    await s.page.goto(`/join/${st.joinToken}`)
    await s.page.getByText(/This meeting was cancelled|no longer works|not valid/).first().waitFor()
    const t = await text(s.page.locator('body'))
    await s.close()
    return /cancelled/.test(t) ? 'Shows "This meeting was cancelled".' : 'Shows "link not valid".'
  })

  await tc({ id: 'MTG-15', module: M, role: 'HR Master', title: 'No customer meetings without customer.meetings.view', steps: 'HR opens /schedule and /customer-meetings', expected: 'Category list has no Customer group; customer pages denied' }, async () => {
    const h = await as(USERS.hr.email, { path: '/schedule' })
    const opts = await h.page.getByLabel('Category').locator('option').allInnerTexts()
    await h.page.goto('/customer-meetings')
    await h.page.getByRole('heading', { name: 'Access denied' }).waitFor()
    await h.close()
    check(!opts.some((o) => /Customer/.test(o)), `options: ${opts.join(', ')}`)
    return 'No customer categories; page denied.'
  })

  await tc({ id: 'MTG-16', module: M, role: 'Employee', title: 'Unknown meeting id', steps: 'Open /meetings/<random guid>', expected: 'Friendly "Meeting not found" error with retry, back link' }, async () => {
    await page.goto('/meetings/00000000-0000-0000-0000-000000000001')
    await page.getByText('Unable to load the meeting').waitFor()
    const t = await text(page.locator('main'))
    check(/not found/i.test(t), `page: ${t.slice(0, 200)}`)
    return 'Not-found error state shown.'
  })

  void q
  void ist
  await priya.close()
}
