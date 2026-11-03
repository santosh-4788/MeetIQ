// 2. Navigation: sidebar per role (visible items match permissions, every item opens its page), header search,
//    profile menu, breadcrumbs, collapse, unknown routes, mobile drawer at 390 px.
import { ApiClient, signedIn } from '../lib/api.mjs'
import { as, settle, text, waitUntil } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { q, scalar } from '../lib/db.mjs'
import { check, eq, tc } from '../lib/runner.mjs'

const M = 'Navigation'

const ALL = ['Dashboard', 'My Meetings', 'Meeting Calendar', 'Schedule Meeting', 'Internal Meetings', 'Customer Meetings', 'Recording Library', 'Notifications', 'Reports', 'Employee Management', 'Department Management', 'Administration', 'Settings']
const EXPECTED = {
  SuperAdmin: ALL,
  Admin: ALL,
  Employee: ['Dashboard', 'My Meetings', 'Meeting Calendar', 'Schedule Meeting', 'Internal Meetings', 'Customer Meetings', 'Recording Library', 'Notifications', 'Settings'],
  'HR Master': ['Dashboard', 'My Meetings', 'Meeting Calendar', 'Schedule Meeting', 'Internal Meetings', 'Recording Library', 'Notifications', 'Employee Management', 'Department Management', 'Settings'],
  'Compliance Auditor': ['Dashboard', 'Notifications', 'Reports', 'Settings'],
}
// The page heading each item must show (planned modules show the honest "Not yet implemented" page).
const HEADINGS = {
  Dashboard: /Good (morning|afternoon|evening)/, 'My Meetings': 'My Meetings', 'Meeting Calendar': 'Meeting Calendar', 'Schedule Meeting': 'Schedule Meeting',
  'Internal Meetings': 'Internal Meetings', 'Customer Meetings': 'Customer Meetings', 'Recording Library': 'Recording Library', Notifications: 'Notifications',
  Reports: 'Reports', 'Employee Management': 'Employee Management', 'Department Management': 'Department Management', Administration: 'Administration', Settings: 'Settings',
}

async function auditor() {
  const email = 'auditor@e2e.oneinsure.test'
  if (!scalar(`SELECT COUNT(*) AS n FROM auth.Users WHERE Email = ${q(email)}`)) {
    const sa = await signedIn(USERS.superadmin.email, PASSWORD)
    const r = await sa.ok('POST', '/admin/users', { email, roles: ['ComplianceAuditor'] })
    const c = new ApiClient()
    await c.login(email, r.oneTimePassword)
    await c.ok('POST', '/auth/change-password', { currentPassword: r.oneTimePassword, newPassword: PASSWORD })
  }
  return email
}

export async function run() {
  const roles = [
    ['SuperAdmin', USERS.superadmin.email],
    ['Admin', USERS.admin.email],
    ['Employee', USERS.priya.email],
    ['HR Master', USERS.hr.email],
    ['Compliance Auditor', await auditor()],
  ]
  let n = 0
  for (const [role, login] of roles) {
    n++
    await tc({ id: `NAV-0${n}`, module: M, role, title: `Sidebar items match permissions and every item opens its page (${role})`, steps: 'Sign in; read sidebar; click each item', expected: `Visible: ${EXPECTED[role].join(', ')}; each opens a page with the right heading (planned modules say "Not yet implemented"); no access-denied` }, async () => {
      const s = await as(login)
      const nav = s.page.getByRole('navigation', { name: 'Main' })
      await nav.getByRole('link').first().waitFor()
      const items = (await nav.getByRole('link').allInnerTexts()).map((x) => x.trim()).filter(Boolean)
      eq(JSON.stringify(items), JSON.stringify(EXPECTED[role]), 'sidebar items')
      const problems = []
      for (const label of items) {
        await nav.getByRole('link', { name: label, exact: true }).click()
        await settle(s.page, 150)
        const h = HEADINGS[label]
        // The page transition is animated: wait until the new page's heading is shown.
        const heading = s.page.locator('main h1').first()
        const matches = (t) => (h instanceof RegExp ? h.test(t) : t === h)
        let ht = ''
        const ok = await waitUntil(async () => matches((ht = (await heading.innerText().catch(() => '')).trim())), label, 10_000).then(() => true, () => false)
        if (!ok) problems.push(`${label} -> "${ht}" (${new URL(s.page.url()).pathname})`)
        if (['Recording Library', 'Reports'].includes(label) && !(await s.page.getByText('Not yet implemented').first().isVisible())) problems.push(`${label} not marked as planned`)
        if (s.page.url().includes('access-denied')) problems.push(`${label} -> access denied`)
        let crumb = ''
        if (label !== 'Dashboard' && !(await waitUntil(async () => (crumb = await text(s.page.locator('header').getByRole('navigation', { name: 'Breadcrumb' })).catch(() => '')).includes(label), 'crumb', 5000).then(() => true, () => false)))
          problems.push(`breadcrumb for ${label}: "${crumb}"`)
      }
      await s.close()
      check(!problems.length, problems.join('; '))
      return `${items.length} items, all opened correctly.`
    })
  }

  await tc({ id: 'NAV-06', module: M, role: 'Compliance Auditor', title: 'Header "New Meeting" only for users who may schedule', steps: 'Compliance Auditor (no meetings.create) looks at the header and dashboard', expected: 'No "New Meeting"/"Schedule meeting" buttons that lead to Access denied' }, async () => {
    const s = await as(await auditor())
    await settle(s.page)
    const header = await s.page.locator('header').getByRole('link', { name: /New meeting/i }).count()
    const dash = await s.page.locator('main').getByRole('link', { name: /Schedule meeting/i }).count()
    await s.close()
    check(header === 0 && dash === 0, `New Meeting in header: ${header}, Schedule meeting on dashboard: ${dash} (both lead to Access denied)`)
    return 'No scheduling buttons shown.'
  })

  await tc({ id: 'NAV-07', module: M, role: 'Employee', title: 'Header search (Ctrl+K) navigates to pages', steps: 'Ctrl+K; type "calen"; Enter; type "zzz"', expected: 'Results list "Meeting Calendar"; Enter opens /calendar; unknown term shows "No matching pages"; admin pages not offered to Employee' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.keyboard.press('Control+k')
    await s.page.keyboard.type('calen')
    await s.page.getByRole('button', { name: 'Meeting Calendar' }).waitFor()
    await s.page.keyboard.press('Enter')
    await s.page.waitForURL(/\/calendar/)
    await s.page.getByLabel('Global search').fill('admin')
    await s.page.getByText('No matching pages').waitFor()
    await s.page.getByLabel('Global search').fill('zzz')
    await s.page.getByText('No matching pages').waitFor()
    await s.close()
    return 'Search navigates; Administration not offered to Employee; no-match message shown.'
  })

  await tc({ id: 'NAV-08', module: M, role: 'Employee', title: 'Profile menu links', steps: 'Open profile menu; My profile & settings; then Change password; Cancel', expected: 'Menu shows name, designation, code; links open /settings and /change-password (with Cancel back)' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.locator('header button[aria-haspopup="menu"]').click()
    const menu = await text(s.page.getByRole('menu'))
    check(menu.includes('Priya Sharma') && menu.includes('E2E-0003') && menu.includes('Team Lead'), `menu "${menu}"`)
    await s.page.getByRole('menuitem', { name: 'My profile & settings' }).click()
    await s.page.waitForURL(/\/settings/)
    await s.page.locator('header button[aria-haspopup="menu"]').click()
    await s.page.getByRole('menuitem', { name: 'Change password' }).click()
    await s.page.waitForURL(/change-password/)
    await s.page.getByText('Update the password you use to sign in').waitFor()
    await s.page.getByRole('button', { name: 'Cancel' }).click()
    await s.page.waitForURL(/\/settings/)
    await s.close()
    return 'Menu content correct; both links work; Cancel returns.'
  })

  await tc({ id: 'NAV-09', module: M, role: 'Employee', title: 'Collapse / expand sidebar (remembered)', steps: 'Collapse; reload; Expand', expected: 'Narrow sidebar with icon tooltips; state survives reload; expand restores labels' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await s.page.reload()
    await s.page.getByRole('button', { name: 'Expand sidebar' }).waitFor()
    const w = await s.page.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)
    await s.page.getByRole('button', { name: 'Expand sidebar' }).click()
    await s.close()
    check(w < 100, `collapsed width ${w}`)
    return `Collapsed to ${Math.round(w)} px, remembered after reload, expanded again.`
  })

  await tc({ id: 'NAV-10', module: M, role: 'Employee', title: 'Unknown route and breadcrumb Home', steps: 'Open /does-not-exist and /meetings/not-a-real/path; click Home', expected: '"Page not found" with Back to dashboard; Home opens dashboard' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.goto('/does-not-exist')
    await s.page.getByRole('heading', { name: 'Page not found' }).waitFor()
    await s.page.goto('/meetings/not-a-real/path')
    await s.page.getByRole('heading', { name: 'Page not found' }).waitFor()
    await s.page.getByRole('link', { name: 'Back to dashboard' }).click()
    await s.page.waitForURL(/dashboard/)
    await s.page.goto('/settings')
    await s.page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' }).click()
    await s.page.waitForURL(/dashboard/)
    await s.close()
    return 'Not-found page and Home breadcrumb work.'
  })

  await tc({ id: 'NAV-11', module: M, role: 'Employee', title: 'Mobile drawer at 390 px', steps: 'Viewport 390x844; Open menu; tap My Meetings; check overflow on main pages', expected: 'Drawer opens with the same items, closes on navigation and on the X; no horizontal scroll' }, async () => {
    const s = await as(USERS.priya.email, { width: 390, height: 844 })
    check(!(await s.page.locator('aside').first().isVisible()), 'desktop sidebar visible on mobile')
    await s.page.getByRole('button', { name: 'Open menu' }).click()
    const drawer = s.page.getByRole('dialog', { name: 'Navigation' })
    const items = (await drawer.getByRole('link').allInnerTexts()).map((x) => x.trim()).filter(Boolean)
    eq(JSON.stringify(items), JSON.stringify(EXPECTED.Employee), 'drawer items')
    await drawer.getByRole('link', { name: 'My Meetings' }).click()
    await s.page.waitForURL(/\/meetings/)
    await drawer.waitFor({ state: 'detached' })
    await s.page.getByRole('button', { name: 'Open menu' }).click()
    await drawer.getByRole('button', { name: 'Close menu' }).click()
    await drawer.waitFor({ state: 'detached' })
    const overflow = []
    for (const p of ['/dashboard', '/meetings', '/calendar', '/schedule', '/notifications', '/settings']) {
      await s.page.goto(p)
      await settle(s.page, 300)
      const o = await s.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      if (o > 1) overflow.push(`${p} +${o}px`)
    }
    await s.close()
    check(!overflow.length, `horizontal overflow: ${overflow.join(', ')}`)
    return 'Drawer works; no horizontal overflow on 6 pages.'
  })
}
