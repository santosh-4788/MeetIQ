// 9. Notifications: bell count and dropdown, open/mark read, mark all, Notifications page filters; reminder worker.
import { signedIn } from '../lib/api.mjs'
import { as, settle, text, toastText, waitUntil } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { exec, q, query, scalar } from '../lib/db.mjs'
import { check, tc } from '../lib/runner.mjs'

const M = 'Notifications'
const unread = (email) => scalar(`SELECT COUNT(*) AS n FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = ${q(email)} AND n.IsRead = 0`)

export async function run() {
  await tc({ id: 'NTF-01', module: M, role: 'Employee', title: 'Bell shows the unread count; opening an item marks it read and navigates', steps: 'Rahul: read bell label; open dropdown; click first unread item', expected: 'Badge = DB unread count; dropdown lists items; click opens the meeting and count drops by one' }, async () => {
    const dbCount = unread(USERS.rahul.email)
    const s = await as(USERS.rahul.email)
    const bell = s.page.getByRole('button', { name: /^Notifications/ })
    await waitUntil(async () => (await bell.getAttribute('aria-label')) === `Notifications, ${dbCount} unread`, `bell label "${await bell.getAttribute('aria-label')}" vs DB ${dbCount}`)
    await bell.click()
    const first = s.page.locator('header li button').filter({ has: s.page.getByLabel('Unread') }).first()
    await first.waitFor()
    const title = await text(first)
    await first.click()
    await s.page.waitForURL(/\/meetings\/[0-9a-f-]{36}/)
    await waitUntil(async () => (await bell.getAttribute('aria-label')) === `Notifications, ${dbCount - 1} unread` || (dbCount === 1 && (await bell.getAttribute('aria-label')) === 'Notifications'), 'count decremented')
    await s.close()
    check(unread(USERS.rahul.email) === dbCount - 1, 'DB not updated')
    return `Badge ${dbCount}; opened "${title.slice(0, 60)}"; now ${dbCount - 1}.`
  })

  await tc({ id: 'NTF-02', module: M, role: 'Employee', title: 'Notifications page: filter, mark read, mark all read', steps: 'Notifications page; Unread only; Mark read on one; Mark all read; Unread only empty', expected: 'Unread badge decreases; mark all gives toast; "You\'re all caught up"; bell badge cleared' }, async () => {
    const s = await as(USERS.rahul.email, { path: '/notifications' })
    const p = s.page
    await p.getByText(/unread/).first().waitFor()
    await p.getByLabel('Show').selectOption('unread')
    await settle(p)
    const before = unread(USERS.rahul.email)
    const rows = await p.getByRole('button', { name: 'Mark read' }).count()
    check(rows === Math.min(before, 20), `${rows} unread rows vs DB ${before}`)
    await p.getByRole('button', { name: 'Mark read' }).first().click()
    await waitUntil(async () => unread(USERS.rahul.email) === before - 1, 'one marked read')
    await p.getByRole('button', { name: 'Mark all read' }).click()
    const t = await toastText(p)
    await p.getByText("You're all caught up").waitFor()
    const bell = await p.getByRole('button', { name: /^Notifications/ }).getAttribute('aria-label')
    await s.close()
    check(unread(USERS.rahul.email) === 0, 'still unread in DB')
    check(bell === 'Notifications', `bell "${bell}"`)
    return `Filter OK; single mark read; "${t}"; bell cleared.`
  })

  await tc({ id: 'NTF-03', module: M, role: 'Employee', title: 'Bell dropdown "Mark all read" and "View all"', steps: 'Priya: open bell; Mark all read; View all notifications', expected: 'Badge cleared; link opens /notifications' }, async () => {
    const s = await as(USERS.priya.email)
    const bell = s.page.getByRole('button', { name: /^Notifications/ })
    await bell.click()
    await s.page.getByRole('button', { name: 'Mark all read' }).click()
    await waitUntil(async () => (await bell.getAttribute('aria-label')) === 'Notifications', 'badge cleared')
    await s.page.getByRole('link', { name: 'View all notifications' }).click()
    await s.page.waitForURL(/\/notifications/)
    await s.close()
    check(unread(USERS.priya.email) === 0, 'DB unread remains')
    return 'Mark all from dropdown + View all link work.'
  })

  await tc({ id: 'NTF-04', module: M, role: 'Employee', title: 'Meeting reminder worker (15-minute reminder)', steps: 'Priya schedules a meeting with Rahul starting in ~16 minutes (API); wait for the reminder worker (poll 5 s); inspect DB and Rahul\'s bell', expected: '15-min reminder SENT; REMINDER in-app notification for Rahul; reminder e-mail queued in app.EmailOutbox (not sent: e-mail disabled); the 60/1440-min reminders do not fire late' }, async () => {
    const c = await signedIn(USERS.priya.email, PASSWORD)
    const rahul = scalar("SELECT PublicId AS id FROM org.Employees WHERE EmployeeCode = 'E2E-0004'")
    // Reminders whose due time has already passed are not created (by design), so start in 16 min: the 15-min one is due in ~1 min.
    const start = new Date(Date.now() + 17 * 60_000)
    start.setSeconds(0, 0)
    const m = await c.ok('POST', '/meetings', { title: 'E2E Reminder Soon', category: 'INTERNAL_1_1', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 15 * 60_000).toISOString(), employeeIds: [rahul], timeZoneId: 'Asia/Kolkata' })
    const sel = `SELECT r.OffsetMinutes AS o, r.[Status] AS s, r.Channel AS c, COUNT(*) AS n FROM mtg.MeetingReminders r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId WHERE m.PublicId = '${m.id}' GROUP BY r.OffsetMinutes, r.[Status], r.Channel`
    await waitUntil(async () => query(sel).some((r) => r.o === 15 && r.s === 'SENT'), '15-minute reminder sent', 150_000)
    const reminders = query(sel)
    const notif = scalar(`SELECT COUNT(*) AS n FROM mtg.MeetingNotifications n JOIN mtg.Meetings m ON m.MeetingId = n.MeetingId JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE m.PublicId = '${m.id}' AND u.Email = ${q(USERS.rahul.email)} AND n.[Type] IN ('REMINDER', 'STARTING_SOON')`)
    const mail = scalar(`SELECT COUNT(*) AS n FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.PublicId = '${m.id}' AND o.Template = 'MEETING_REMINDER' AND o.[Status] <> 'SENT'`)
    const late = reminders.filter((r) => r.o > 15 && r.s === 'SENT')
    const s = await as(USERS.rahul.email)
    await s.page.getByRole('button', { name: /^Notifications/ }).click()
    await s.page.locator('header li').filter({ hasText: 'E2E Reminder Soon' }).first().waitFor()
    await s.close()
    await c.ok('POST', `/meetings/${m.id}/cancel`, { reason: 'E2E cleanup' })
    void exec
    check(notif >= 1, `in-app reminder notifications: ${notif}`)
    check(mail >= 1, `reminder e-mails queued: ${mail}`)
    check(!late.length, `late reminders sent: ${JSON.stringify(late)}`)
    return `Reminders: ${reminders.map((r) => `${r.o}m/${r.c}=${r.s}`).join(', ')}; notification + queued e-mail; shown in Rahul's bell.`
  })
}
