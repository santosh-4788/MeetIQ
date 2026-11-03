// 6. Settings: profile, change password, two-factor management, sessions, my availability.
import { ApiClient, signedIn } from '../lib/api.mjs'
import { as, dialogsClosed, loginUI, session, settle, text, toastText, waitUntil } from '../lib/browser.mjs'
import { NEW_PASSWORD, PASSWORD, USERS } from '../lib/config.mjs'
import { q, scalar } from '../lib/db.mjs'
import { check, tc } from '../lib/runner.mjs'
import { freshTotp, nextTotp } from '../lib/totp.mjs'
import { ist } from '../seed.mjs'

const M = 'Settings'

export async function run() {
  await tc({ id: 'SET-01', module: M, role: 'Employee', title: 'Profile card shows employee master data', steps: 'Open Settings as Priya', expected: 'E-mail, employee code, department, designation, time zone and role badge shown' }, async () => {
    const s = await as(USERS.priya.email, { path: '/settings' })
    const card = await text(s.page.locator('main'))
    await s.close()
    for (const v of [USERS.priya.email, 'E2E-0003', 'Operations', 'Team Lead', 'Asia/Kolkata', 'Employee']) check(card.includes(v), `"${v}" missing from profile`)
    return 'All profile fields present.'
  })

  await tc({ id: 'SET-02', module: M, role: 'Employee', title: 'Change password from Settings (other sessions signed out)', steps: 'Second session open (API); Settings > Change password: wrong current; same as current; valid', expected: 'Server error for wrong current password; "must be different" message; success page; other session ends; new password works' }, async () => {
    const other = await signedIn(USERS.rahul.email, PASSWORD)
    const s = await as(USERS.rahul.email, { path: '/settings', fresh: true })
    await s.page.getByRole('link', { name: 'Change password' }).last().click()
    await s.page.waitForURL(/change-password/)
    await s.page.getByLabel('Current password').fill('Wrong#Password123')
    await s.page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await s.page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
    await s.page.getByRole('button', { name: 'Update password' }).click()
    const wrong = await text(s.page.getByRole('alert').first())
    await s.page.getByLabel('Current password').fill(PASSWORD)
    await s.page.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await s.page.getByLabel('Confirm new password').fill(PASSWORD)
    await s.page.getByRole('button', { name: 'Update password' }).click()
    await s.page.getByText('New password must be different from the current password.').waitFor()
    await s.page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await s.page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
    await s.page.getByRole('button', { name: 'Update password' }).click()
    await s.page.getByRole('heading', { name: 'Password changed' }).waitFor()
    const me = await other.get('/auth/me')
    await s.close()
    const c = await signedIn(USERS.rahul.email, NEW_PASSWORD)
    await c.ok('POST', '/auth/change-password', { currentPassword: NEW_PASSWORD, newPassword: PASSWORD })
    check(/incorrect/i.test(wrong), `wrong current password message "${wrong}"`)
    check(me.status === 401, `other session still valid (${me.status})`)
    return `Wrong current: "${wrong}"; same-password check; changed; other session 401.`
  })

  await tc({ id: 'SET-03', module: M, role: 'Employee', title: 'Active sessions: list and sign out all others', steps: 'Priya signed in via API and browser; Settings > Active sessions > Sign out all others', expected: 'Both sessions listed, current marked "This device"; after confirm the API session gets 401 and the browser stays signed in' }, async () => {
    const other = await signedIn(USERS.priya.email, PASSWORD)
    const s = await as(USERS.priya.email, { path: '/settings', fresh: true })
    await s.page.getByText('This device').waitFor()
    const n = await s.page.locator('li').filter({ hasText: 'Signed in' }).count()
    await s.page.getByRole('button', { name: /Sign out (all )?others/ }).click()
    await s.page.getByRole('dialog', { name: 'Sign out all other sessions?' }).getByRole('button', { name: 'Sign out' }).click()
    const t = await toastText(s.page)
    const me = await other.get('/auth/me')
    await s.page.reload()
    await s.page.getByText('This device').waitFor()
    await s.close()
    check(n >= 2, `${n} sessions listed`)
    check(me.status === 401, `other session ${me.status}`)
    return `${n} sessions listed; "${t}"; other session revoked; this one kept.`
  })

  await tc({ id: 'SET-04', module: M, role: 'Employee', title: 'Two-factor: new recovery codes and turn off', steps: 'Kavya with MFA on; New recovery codes (wrong then right code); Turn off (wrong password, then right)', expected: 'Errors shown in dialog; 10 new codes; MFA off afterwards' }, async () => {
    // Start from MFA off (an earlier scenario may have left it on with a secret this case does not know).
    if (scalar(`SELECT CAST(MfaEnabled AS INT) AS m FROM auth.Users WHERE Email = ${q(USERS.mfa.email)}`)) {
      const sa = await signedIn(USERS.superadmin.email, PASSWORD)
      await sa.ok('POST', `/admin/users/${scalar(`SELECT PublicId AS id FROM auth.Users WHERE Email = ${q(USERS.mfa.email)}`)}/reset-mfa`)
    }
    const k = await signedIn(USERS.mfa.email, PASSWORD)
    let secret
    if (!(await k.get('/account/mfa')).data.enabled) {
      const setup = await k.ok('POST', '/account/mfa/totp/setup', { currentPassword: PASSWORD })
      secret = setup.secret
      await k.ok('POST', '/account/mfa/totp/confirm', { code: await freshTotp(secret) })
    } else throw new Error('Kavya already has MFA from an earlier scenario with an unknown secret; run on a fresh database')
    const s = await session()
    await loginUI(s.page, USERS.mfa.email, PASSWORD, { expectPath: /\/mfa/ })
    await s.page.getByLabel('Digit 1').click()
    await s.page.keyboard.type(await nextTotp(secret))
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.waitForURL(/dashboard/)
    await s.page.goto('/settings')
    await s.page.getByRole('button', { name: 'New recovery codes' }).click()
    const d = s.page.getByRole('dialog', { name: 'New recovery codes' })
    await d.getByLabel('Verification code').fill('000000')
    await d.getByRole('button', { name: 'Generate new codes' }).click()
    await d.locator('[role=alert]').first().waitFor()
    await d.getByLabel('Verification code').fill(await nextTotp(secret))
    await d.getByRole('button', { name: 'Generate new codes' }).click()
    await d.getByRole('list', { name: 'Recovery codes' }).locator('li').first().waitFor()
    const codes = await d.getByRole('list', { name: 'Recovery codes' }).locator('li').count()
    await d.getByLabel('I have saved my recovery codes somewhere safe').check()
    await d.getByRole('button', { name: 'Done' }).click()
    await dialogsClosed(s.page)
    await s.page.getByText('10 of 10 recovery codes left').waitFor()
    await s.page.getByRole('button', { name: 'Turn off' }).click()
    const off = s.page.getByRole('dialog', { name: 'Turn off two-factor authentication?' })
    await off.getByLabel('Current password').fill('Wrong#Password123')
    await off.getByLabel('Authenticator code or recovery code').fill('123456')
    await off.getByRole('button', { name: 'Turn off' }).click()
    await off.locator('[role=alert]').filter({ hasText: /incorrect/i }).first().waitFor()
    await off.getByLabel('Current password').fill(PASSWORD)
    await off.getByLabel('Authenticator code or recovery code').fill(await nextTotp(secret))
    await off.getByRole('button', { name: 'Turn off' }).click()
    const t = await toastText(s.page)
    await s.page.getByRole('button', { name: 'Set up authenticator app' }).waitFor()
    await s.close()
    check(codes === 10, `${codes} new codes`)
    return `10 new codes; turned off ("${t}").`
  })

  await tc({ id: 'SET-05', module: M, role: 'Employee', title: 'My availability: working hours add / validate / edit / delete', steps: 'Add hours Monday 18:00-09:00 (invalid); 09:30-18:00; edit to 10:00-19:00; delete', expected: 'Validation message; chip shows hours; edit updates; delete removes' }, async () => {
    const s = await as(USERS.priya.email, { path: '/settings' })
    const p = s.page
    await p.getByRole('button', { name: 'Add hours' }).click()
    const d = p.getByRole('dialog', { name: 'Add working hours' })
    await d.getByLabel('Day').selectOption({ label: 'Monday' })
    await d.getByLabel('From').fill('18:00')
    await d.getByLabel('To').fill('09:00')
    await d.getByRole('button', { name: 'Save' }).click()
    await d.getByText('Working hours must end after they start.').waitFor()
    await d.getByLabel('From').fill('09:30')
    await d.getByLabel('To').fill('18:00')
    await d.getByRole('button', { name: 'Save' }).click()
    const chip = p.getByRole('button', { name: 'Edit Monday 09:30 to 18:00' })
    await chip.waitFor()
    await chip.click()
    const e = p.getByRole('dialog', { name: 'Edit working hours' })
    await e.getByLabel('From').fill('10:00')
    await e.getByLabel('To').fill('19:00')
    await e.getByRole('button', { name: 'Save' }).click()
    await p.getByRole('button', { name: 'Delete Monday 10:00 to 19:00' }).click()
    await p.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete' }).click()
    await p.getByRole('button', { name: 'Delete Monday 10:00 to 19:00' }).waitFor({ state: 'detached' })
    await s.close()
    return 'Invalid range refused; added, edited and deleted.'
  })

  await tc({ id: 'SET-06', module: M, role: 'Employee', title: 'My availability: leave and blocked time', steps: 'Add all-day leave on day+8; add blocked time day+9 14:00-15:00 with reason; edit reason; end before start; delete both', expected: 'Entries listed with dates/times and reason; validation for reversed times; delete works' }, async () => {
    const s = await as(USERS.priya.email, { path: '/settings' })
    const p = s.page
    const ymd = (days) => ist(days, 12).slice(0, 10)
    const leaveDay = ymd(8)
    const blockDay = ymd(9)
    await p.getByRole('button', { name: 'Add', exact: true }).click()
    let d = p.getByRole('dialog', { name: 'Add leave or blocked time' })
    await d.getByLabel('From date').fill(leaveDay)
    await d.getByLabel('To date (inclusive)').fill(leaveDay)
    await d.getByLabel('Reason (optional)').fill('E2E annual leave')
    await d.getByRole('button', { name: 'Save' }).click()
    await p.getByText('E2E annual leave').waitFor()
    await dialogsClosed(p)
    await p.getByRole('button', { name: 'Add', exact: true }).click()
    d = p.getByRole('dialog', { name: 'Add leave or blocked time' })
    await d.getByLabel('Type').selectOption('BLOCKED')
    await d.getByRole('switch').click()
    await d.getByLabel('Start date').fill(blockDay)
    await d.getByLabel('Start time').fill('15:00')
    await d.getByLabel('End date').fill(blockDay)
    await d.getByLabel('End time').fill('14:00')
    await d.getByRole('button', { name: 'Save' }).click()
    await d.getByText('The period must end after it starts.').waitFor()
    await d.getByLabel('Start time').fill('14:00')
    await d.getByLabel('End time').fill('15:00')
    await d.getByLabel('Reason (optional)').fill('E2E focus time')
    await d.getByRole('button', { name: 'Save' }).click()
    await p.getByText('E2E focus time').waitFor()
    await dialogsClosed(p)
    const item = p.locator('li').filter({ hasText: 'E2E focus time' })
    const itemText = await text(item)
    await item.getByRole('button', { name: 'Edit period' }).click()
    await p.getByRole('dialog', { name: 'Edit leave or blocked time' }).getByLabel('Reason (optional)').fill('E2E focus time (edited)')
    await p.getByRole('dialog', { name: 'Edit leave or blocked time' }).getByRole('button', { name: 'Save' }).click()
    await p.getByText('E2E focus time (edited)').waitFor()
    await dialogsClosed(p)
    for (const r of ['E2E focus time (edited)', 'E2E annual leave']) {
      await p.locator('li').filter({ hasText: r }).getByRole('button', { name: 'Delete period' }).click()
      await p.getByRole('dialog', { name: 'Delete this entry?' }).getByRole('button', { name: 'Delete' }).click()
      await p.getByText(r).waitFor({ state: 'detached' })
      await dialogsClosed(p)
    }
    await s.close()
    check(/2:00|14:00/.test(itemText) && /Blocked/.test(itemText), `blocked item "${itemText}"`)
    return `Leave + blocked time added ("${itemText}"), edited, validated and deleted.`
  })

  await tc({ id: 'SET-07', module: M, role: 'Employee (no employee record)', title: 'Settings for an account without employee record', steps: 'nolink user opens Settings', expected: 'Profile shows dashes; availability explains the missing employee link (no crash)' }, async () => {
    const s = await as(USERS.nolink.email, { path: '/settings' })
    await settle(s.page)
    const body = await text(s.page.locator('main'))
    await s.close()
    check(/not linked to an employee record/.test(body), `no explanation: ${body.slice(0, 300)}`)
    return 'Explanation shown in My availability.'
  })

  void ApiClient
  void waitUntil
}
