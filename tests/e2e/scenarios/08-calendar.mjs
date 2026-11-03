// 8. Calendar: month/week/day/agenda, navigation, event → detail, filters, cancelled toggle, other employee (permission).
import { signedIn } from '../lib/api.mjs'
import { as, settle, text, waitUntil } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { q, scalar } from '../lib/db.mjs'
import { ensureSuperAdminLinked } from '../lib/fixtures.mjs'
import { check, tc } from '../lib/runner.mjs'

const M = 'Calendar'

export async function run() {
  await ensureSuperAdminLinked()
  const s = await as(USERS.priya.email, { path: '/calendar' })
  const page = s.page
  const heading = () => text(page.locator('main h2').first())
  const view = async (name) => {
    await page.getByRole('tab', { name }).click()
    await settle(page, 300)
  }
  const event = (title) => page.getByRole('link', { name: new RegExp(title) }).first()

  await tc({ id: 'CAL-01', module: M, role: 'Employee', title: 'Month view shows own meetings and drafts', steps: 'Open Meeting Calendar (month)', expected: 'Ops Sync, Admin Briefing and the own draft are on the grid; legend shown' }, async () => {
    await page.goto('/calendar')
    await event('E2E Weekly Ops Sync').waitFor()
    await event('E2E Admin Briefing').waitFor()
    await event('E2E Draft Planning').waitFor()
    await page.getByRole('list', { name: 'Legend' }).waitFor()
    return 'Seeded meetings and draft visible in month grid.'
  })

  await tc({ id: 'CAL-02', module: M, role: 'Employee', title: 'Previous / next / today', steps: 'Next; Previous twice; Today', expected: 'Range label changes each time and Today restores the current month' }, async () => {
    await view('Month')
    const h0 = await heading()
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    const h1 = await heading()
    await page.getByRole('button', { name: 'Previous', exact: true }).click()
    await page.getByRole('button', { name: 'Previous', exact: true }).click()
    const h2 = await heading()
    await page.getByRole('button', { name: 'Today' }).click()
    const h3 = await heading()
    check(h0 !== h1 && h1 !== h2 && h3 === h0, `labels ${h0} / ${h1} / ${h2} / ${h3}`)
    return `${h0} → ${h1} → ${h2} → ${h3}.`
  })

  await tc({ id: 'CAL-03', module: M, role: 'Employee', title: 'Week, day and agenda views', steps: 'Switch to Week, Day (via day button), Agenda', expected: 'Each view renders with its range; agenda lists the next 31 days including the customer meeting' }, async () => {
    await view('Week')
    const w = await heading()
    await view('Day')
    const d = await heading()
    await view('Agenda')
    const a = await heading()
    await event('E2E Customer Policy Verification').waitFor()
    check(/–/.test(w) && /\d{4}/.test(d) && /–/.test(a), `labels ${w} / ${d} / ${a}`)
    return `Week "${w}", Day "${d}", Agenda "${a}".`
  })

  await tc({ id: 'CAL-04', module: M, role: 'Employee', title: 'Click an event opens the meeting', steps: 'Agenda > click E2E Weekly Ops Sync', expected: 'Meeting detail page opens' }, async () => {
    await page.goto('/calendar')
    await view('Agenda')
    await event('E2E Weekly Ops Sync').click()
    await page.getByRole('heading', { name: 'E2E Weekly Ops Sync' }).waitFor()
    return 'Detail opened.'
  })

  await tc({ id: 'CAL-05', module: M, role: 'Employee', title: 'Category filter and show cancelled', steps: 'Agenda; Category "All customer"; then all + Show cancelled', expected: 'Only the PLVC with the customer filter; the cancelled review appears only with Show cancelled' }, async () => {
    await page.goto('/calendar')
    await view('Agenda')
    await page.getByLabel('Category').selectOption('CUSTOMER')
    await waitUntil(async () => !(await page.getByRole('link', { name: /E2E Weekly Ops Sync/ }).count()), 'internal hidden')
    await event('E2E Customer Policy Verification').waitFor()
    await page.getByLabel('Category').selectOption('')
    check((await page.getByRole('link', { name: /E2E Cancelled Review/ }).count()) === 0, 'cancelled shown without toggle')
    await page.getByRole('switch').click()
    await event('E2E Cancelled Review').waitFor()
    await page.getByRole('switch').click()
    return 'Filters work.'
  })

  await tc({ id: 'CAL-06', module: M, role: 'Employee', title: 'Drafts are private; other calendars need permission', steps: 'Rahul opens his calendar (agenda); Priya calls GET /calendar?employeeId=<Rahul> (API)', expected: 'Rahul does not see Priya\'s draft; no "View another employee" for Employee; API answers 403' }, async () => {
    const r = await as(USERS.rahul.email, { path: '/calendar' })
    await r.page.getByRole('tab', { name: 'Agenda' }).click()
    await r.page.getByRole('link', { name: /E2E Weekly Ops Sync/ }).first().waitFor()
    const draft = await r.page.getByRole('link', { name: /E2E Draft Planning/ }).count()
    const picker = await r.page.getByLabel('View another employee').count()
    await r.close()
    const c = await signedIn(USERS.priya.email, PASSWORD)
    const rahul = scalar("SELECT PublicId AS id FROM org.Employees WHERE EmployeeCode = 'E2E-0004'")
    const from = new Date().toISOString()
    const to = new Date(Date.now() + 7 * 864e5).toISOString()
    const res = await c.get(`/calendar?from=${from}&to=${to}&employeeId=${rahul}`)
    check(draft === 0, 'Rahul sees the draft')
    check(picker === 0, 'Employee has the other-employee picker')
    check(res.status === 403, `API status ${res.status}`)
    return 'Draft hidden from Rahul; picker hidden; API 403.'
  })

  await tc({ id: 'CAL-07', module: M, role: 'SuperAdmin', title: 'View another employee\'s calendar (meetings.view.all)', steps: 'SuperAdmin picks Rahul Verma; agenda', expected: 'Title "Rahul Verma\'s calendar"; Rahul\'s meetings and leave (without the private reason)' }, async () => {
    const a = await as(USERS.superadmin.email, { path: '/calendar' })
    await a.page.getByLabel('View another employee').fill('Rahul')
    await a.page.getByRole('option', { name: /Rahul Verma/ }).click()
    await a.page.getByText("Rahul Verma's calendar").waitFor()
    await a.page.getByRole('tab', { name: 'Agenda' }).click()
    await a.page.getByRole('link', { name: /E2E Weekly Ops Sync/ }).first().waitFor()
    await a.page.getByText('On leave').first().waitFor()
    const body = await text(a.page.locator('main'))
    await a.close()
    check(!body.includes('Family function'), 'leave reason leaked to another user')
    return 'Rahul\'s calendar with leave, reason hidden.'
  })

  await tc({ id: 'CAL-08', module: M, role: 'Employee', title: 'Own leave is visible with reason', steps: 'Rahul month/agenda', expected: '"On leave" day; own reason visible' }, async () => {
    const r = await as(USERS.rahul.email, { path: '/calendar' })
    await r.page.getByRole('tab', { name: 'Agenda' }).click()
    await r.page.getByText('On leave').first().waitFor()
    const body = await text(r.page.locator('main'))
    await r.close()
    check(body.includes('Family function'), 'own leave reason not shown')
    return 'Own leave reason shown.'
  })

  void q
  await s.close()
}
