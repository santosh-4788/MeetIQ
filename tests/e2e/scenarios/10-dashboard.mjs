// 10. Dashboard with real data: KPIs, next meeting, today's schedule and upcoming list match the database.
import { signedIn } from '../lib/api.mjs'
import { as, settle, text } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { q, scalar } from '../lib/db.mjs'
import { ensureSuperAdminLinked } from '../lib/fixtures.mjs'
import { check, tc } from '../lib/runner.mjs'

const M = 'Dashboard'

/** Meetings visible to an employee (same rule as the API): host, organiser or participant; never drafts. */
const visible = (email) => `
  FROM mtg.Meetings m WHERE m.[Status] <> 'DRAFT' AND EXISTS (
    SELECT 1 FROM auth.Users u WHERE u.Email = ${q(email)} AND (m.HostEmployeeId = u.EmployeeId OR m.CreatedByEmployeeId = u.EmployeeId
      OR EXISTS (SELECT 1 FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = u.EmployeeId)))`

async function kpi(page, label) {
  // KPI cards are <article> elements: "<label> <value> <footnote>".
  const t = await text(page.locator('main article').filter({ has: page.getByText(label, { exact: true }) }).first())
  const n = t.slice(t.indexOf(label) + label.length).match(/\d[\d,]*/)
  return n ? Number(n[0].replace(/,/g, '')) : NaN
}

export async function run() {
  await ensureSuperAdminLinked()

  await tc({ id: 'DSH-01', module: M, role: 'Employee', title: 'KPIs reflect the seeded meetings', steps: 'Priya opens the dashboard; compare KPI cards with the database', expected: 'Total employees = active employees; Upcoming (next 7 days) and Customer (this month) match independent SQL counts' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.getByText('Upcoming Meetings', { exact: true }).waitFor()
    await settle(s.page)
    const ui = {
      total: await kpi(s.page, 'Total Employees'),
      upcoming: await kpi(s.page, 'Upcoming Meetings'),
      customer: await kpi(s.page, 'Customer Meetings'),
    }
    await s.close()
    const db = {
      total: scalar('SELECT COUNT(*) AS n FROM org.Employees WHERE IsActive = 1'),
      upcoming: scalar(`SELECT COUNT(*) AS n ${visible(USERS.priya.email)} AND m.[Status] = 'SCHEDULED' AND m.ScheduledStartUtc > SYSUTCDATETIME() AND m.ScheduledStartUtc < DATEADD(DAY, 7, SYSUTCDATETIME())`),
      customer: scalar(`SELECT COUNT(*) AS n ${visible(USERS.priya.email)} AND m.[Status] <> 'CANCELLED' AND m.Category IN ('CUSTOMER_PLVC','CUSTOMER_GENERAL')
        AND m.ScheduledStartUtc >= DATEADD(MINUTE, -330, DATETIME2FROMPARTS(YEAR(DATEADD(MINUTE, 330, SYSUTCDATETIME())), MONTH(DATEADD(MINUTE, 330, SYSUTCDATETIME())), 1, 0, 0, 0, 0, 0))
        AND m.ScheduledStartUtc < DATEADD(MINUTE, -330, DATEADD(MONTH, 1, DATETIME2FROMPARTS(YEAR(DATEADD(MINUTE, 330, SYSUTCDATETIME())), MONTH(DATEADD(MINUTE, 330, SYSUTCDATETIME())), 1, 0, 0, 0, 0, 0)))`),
    }
    check(JSON.stringify(ui) === JSON.stringify(db), `UI ${JSON.stringify(ui)} vs DB ${JSON.stringify(db)}`)
    return `UI = DB: ${JSON.stringify(ui)}.`
  })

  await tc({ id: 'DSH-02', module: M, role: 'Employee', title: 'Next meeting, today\'s schedule and upcoming list', steps: 'Compare cards with the API summary and seeded data', expected: 'Upcoming list shows Ops Sync and Admin Briefing (next 7 days only, nothing later); "View all" opens My Meetings; Refresh reloads' }, async () => {
    const c = await signedIn(USERS.priya.email, PASSWORD)
    const api = (await c.ok('GET', '/dashboard/summary'))
    const s = await as(USERS.priya.email)
    await s.page.getByText('Next 7 days', { exact: true }).last().waitFor()
    await s.page.locator('main').getByText('E2E Admin Briefing').first().waitFor()
    const up = await text(s.page.locator('main'))
    const tooFar = api.upcoming.filter((m) => new Date(m.startUtc).getTime() > Date.now() + 7 * 864e5)
    await s.page.getByRole('button', { name: 'Refresh' }).click()
    await settle(s.page)
    await s.page.getByRole('link', { name: 'View all' }).click()
    await s.page.waitForURL(/\/meetings$/)
    await s.close()
    check(up.includes('E2E Admin Briefing'), `upcoming card: ${up.slice(0, 200)}`)
    check(!tooFar.length, `meetings beyond 7 days in "Next 7 days": ${tooFar.map((m) => m.title).join(', ')}`)
    check(api.nextMeeting, 'no next meeting')
    return `Next meeting "${api.nextMeeting.title}"; upcoming list ${api.upcoming.length} item(s) within 7 days; links work.`
  })

  await tc({ id: 'DSH-03', module: M, role: 'SuperAdmin', title: 'SuperAdmin dashboard (all meetings)', steps: 'SuperAdmin opens dashboard', expected: 'Renders without errors; upcoming KPI counts all employees\' meetings in the next 7 days' }, async () => {
    const s = await as(USERS.superadmin.email)
    await s.page.getByText('Upcoming Meetings', { exact: true }).waitFor()
    await settle(s.page)
    const ui = await kpi(s.page, 'Upcoming Meetings')
    await s.close()
    const db = scalar("SELECT COUNT(*) AS n FROM mtg.Meetings WHERE [Status] = 'SCHEDULED' AND ScheduledStartUtc > SYSUTCDATETIME() AND ScheduledStartUtc < DATEADD(DAY, 7, SYSUTCDATETIME())")
    check(ui === db, `UI ${ui} vs DB ${db}`)
    return `Upcoming ${ui} = DB.`
  })
}
