// 5. Administration: users (create, roles, reset password, unlock, reset MFA, (de)activate), escalation guards, roles matrix.
import { ApiClient, signedIn } from '../lib/api.mjs'
import { as, loginUI, session, settle, text, toastText, waitUntil } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { exec, q, scalar } from '../lib/db.mjs'
import { check, tc } from '../lib/runner.mjs'
import { freshTotp } from '../lib/totp.mjs'

const M = 'Administration'

export async function run() {
  const s = await as(USERS.superadmin.email, { path: '/admin' })
  const page = s.page
  const usersCard = () => page.locator('div').filter({ has: page.getByRole('heading', { name: 'Users & roles' }) }).last()
  const userRow = (name) => page.locator('tbody tr').filter({ hasText: name })
  const fresh = async () => {
    await page.goto('/admin')
    await page.locator('tbody tr').first().waitFor()
    await settle(page, 200)
  }
  const search = async (term) => {
    await page.getByLabel('Search users').fill(term)
    await waitUntil(async () => (await page.locator('tbody tr').count()) >= 1 && (await text(page.locator('tbody tr').first())).toLowerCase().includes(term.toLowerCase().split('@')[0].split(' ')[0]), `user search ${term}`)
  }
  const action = async (name, label) => {
    // The menu closes on scroll (by design): bring the row to the middle first so opening it needs no scrolling.
    const trigger = page.getByRole('button', { name: `Actions for ${name}` }).first()
    await trigger.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await trigger.click()
    await page.getByRole('menuitem', { name: label }).click()
  }

  // ---- Linking existing accounts to employees (defect reported during manual testing) ----
  await tc({ id: 'ADM-14', module: M, role: 'SuperAdmin (unlinked)', title: 'Unlinked SuperAdmin: /schedule explains how to fix it', steps: 'First SuperAdmin from setup-admin (no employee link) opens Schedule Meeting and Administration', expected: '/schedule shows "not linked" notice pointing to Administration → Users & roles; own row shows "No employee link"' }, async () => {
    const linked = scalar(`SELECT COUNT(*) AS n FROM auth.Users WHERE Email = ${q(USERS.superadmin.email)} AND EmployeeId IS NOT NULL`)
    check(linked === 0, 'precondition: SuperAdmin already linked (run on a freshly seeded database)')
    await page.goto('/schedule')
    const notice = await text(page.getByRole('status').filter({ hasText: 'not linked to an employee record' }))
    check(notice.includes('Administration → Users & roles'), `notice "${notice}"`)
    await fresh()
    check((await text(userRow('superadmin@e2e.oneinsure.test'))).includes('No employee link'), 'no "No employee link" badge')
    return `Notice: "${notice.slice(0, 140)}…"; badge shown.`
  })

  await tc({ id: 'ADM-15', module: M, role: 'SuperAdmin', title: 'Employee detail: link the existing account instead of a failing "Create user account"', steps: 'Employee Management > Sunita Rao (E2E-0001) > "Link existing account superadmin@…"; reload /schedule', expected: 'Drawer offers linking (no Create button); after linking the account is shown; /schedule shows the meeting form' }, async () => {
    await page.goto('/employees')
    await page.getByLabel('Search employees').fill('Sunita')
    await waitUntil(async () => (await page.locator('tbody tr').count()) === 1, 'Sunita row')
    await page.locator('tbody tr').first().click()
    const det = page.getByRole('dialog', { name: 'Employee details' })
    const btn = det.getByRole('button', { name: `Link existing account ${USERS.superadmin.email}` })
    await btn.waitFor()
    check((await det.getByRole('button', { name: 'Create user account' }).count()) === 0, '"Create user account" still offered')
    await btn.click()
    const t = await toastText(page)
    await det.getByText('Sign-in e-mail').waitFor()
    await page.goto('/schedule')
    await page.getByLabel('Title').first().waitFor()
    return `Linked ("${t}"); /schedule now shows the form.`
  })

  await tc({ id: 'ADM-16', module: M, role: 'SuperAdmin', title: 'Administration: Link to employee / change / unlink', steps: 'nolink user > Link to employee: no choice; Priya (already linked); Aarav Bulk1; then Change linked employee > Unlink', expected: '"Choose an employee."; 409 "already linked to the account …"; linked (toast, row shows employee); unlink restores "No employee link"' }, async () => {
    await fresh()
    await search('nolink')
    await action(USERS.nolink.email, 'Link to employee')
    const d = page.getByRole('dialog', { name: 'Link to employee' })
    await d.getByText('Not linked: this account cannot schedule meetings').waitFor()
    await d.getByRole('button', { name: 'Link account' }).click()
    await d.getByText('Choose an employee.').waitFor()
    await d.getByLabel('Employee', { exact: true }).fill('Priya')
    await d.getByRole('option', { name: /Priya Sharma/ }).click()
    await d.getByRole('button', { name: 'Link account' }).click()
    const dup = await text(d.getByRole('alert').first())
    check(/already linked to the account/.test(dup), `duplicate "${dup}"`)
    await d.getByRole('button', { name: 'Remove Priya Sharma' }).click()
    await d.getByLabel('Employee', { exact: true }).fill('Aarav')
    await d.getByRole('option', { name: /Aarav Bulk1/ }).click()
    await d.getByRole('button', { name: 'Link account' }).click()
    await toastText(page)
    await search('Aarav')
    check(!(await text(page.locator('tbody tr').first())).includes('No employee link'), 'still shows No employee link')
    await action('Aarav Bulk1', 'Change linked employee')
    const c = page.getByRole('dialog', { name: 'Change linked employee' })
    await c.getByText('Aarav Bulk1').first().waitFor()
    await c.getByRole('button', { name: 'Unlink' }).click()
    await toastText(page)
    await search('nolink')
    await waitUntil(async () => (await text(page.locator('tbody tr').first())).includes('No employee link'), 'unlink not reflected')
    return `Validation + duplicate ("${dup}") handled; linked to Aarav, then unlinked.`
  })

  await tc({ id: 'ADM-17', module: M, role: 'SuperAdmin', title: 'Unlink refused while the employee organises upcoming meetings', steps: 'Priya (hosts seeded meetings) > Change linked employee > Unlink', expected: '409 message explaining the upcoming meetings; link kept' }, async () => {
    await fresh()
    await search('priya')
    await action('Priya Sharma', 'Change linked employee')
    const c = page.getByRole('dialog', { name: 'Change linked employee' })
    await c.getByRole('button', { name: 'Unlink' }).click()
    const msg = await text(c.getByRole('alert').first())
    await c.getByRole('button', { name: 'Cancel' }).click()
    check(/upcoming meeting/.test(msg), `message "${msg}"`)
    check(scalar(`SELECT COUNT(*) AS n FROM auth.Users WHERE Email = ${q(USERS.priya.email)} AND EmployeeId IS NOT NULL`) === 1, 'link removed')
    return `Refused: "${msg}".`
  })

  await tc({ id: 'ADM-01', module: M, role: 'SuperAdmin', title: 'Users list, search and status filters', steps: 'Open Administration; search "priya"; status Locked/Inactive/All', expected: 'List shows roles, MFA and status badges; filters narrow results; own row marked "(you)"' }, async () => {
    exec(`UPDATE auth.Users SET LockoutEndUtc = DATEADD(MINUTE, 15, SYSUTCDATETIME()) WHERE Email = ${q(USERS.lockme.email)}`)
    await fresh()
    check((await text(userRow('Sunita Rao'))).includes('(you)'), 'own row not marked (you)')
    await search('priya')
    const r = await text(page.locator('tbody tr').first())
    check(r.includes('Employee') && r.includes('MFA off') && r.includes('Active'), `row "${r}"`)
    await page.getByLabel('Search users').fill('')
    await page.getByLabel('Status').selectOption('locked')
    await waitUntil(async () => (await text(page.locator('tbody').first())).includes('Lokesh Kumar'), 'locked filter shows Lokesh')
    const locked = await page.locator('tbody tr').count()
    await page.getByLabel('Status').selectOption('all')
    await settle(page, 500)
    const all = await text(page.getByRole('navigation', { name: 'Pagination' }))
    return `Search row: "${r.slice(0, 120)}"; Locked filter: ${locked} row(s); All: "${all}".`
  })

  await tc({ id: 'ADM-02', module: M, role: 'SuperAdmin', title: 'Create user: validation and duplicate account', steps: 'Create user without employee; uncheck all roles; pick Priya (already has account); then e-mail-only account', expected: '"Choose an employee." / "Choose at least one role."; 409 message for duplicate; e-mail account created with one-time password' }, async () => {
    await fresh()
    await page.getByRole('button', { name: /Create( user)?/ }).first().click()
    const d = page.getByRole('dialog', { name: 'Create user account' })
    await d.getByLabel('Employee', { exact: true }).waitFor()
    await d.getByRole('checkbox', { name: /^Employee\b/ }).uncheck()
    await d.getByRole('button', { name: 'Create account' }).click()
    await d.getByText('Choose an employee.').waitFor()
    await d.getByText('Choose at least one role.').waitFor()
    await d.getByLabel('Employee', { exact: true }).fill('Priya')
    await d.getByRole('option', { name: /Priya Sharma/ }).click()
    await d.getByRole('checkbox', { name: /^Employee\b/ }).check()
    await d.getByRole('button', { name: 'Create account' }).click()
    const dup = await text(d.getByRole('alert').first())
    check(/already has a user account/.test(dup), `duplicate message "${dup}"`)
    await d.getByRole('radio', { name: 'E-mail only' }).click()
    await d.getByLabel('E-mail address').fill('svc.account@')
    await d.getByRole('button', { name: 'Create account' }).click()
    await d.getByText('Enter a valid e-mail address.').waitFor()
    await d.getByLabel('E-mail address').fill('svc.account@e2e.oneinsure.test')
    await d.getByRole('button', { name: 'Create account' }).click()
    const done = page.getByRole('dialog', { name: 'User account created' })
    const pw = (await done.getByLabel('One-time password').innerText()).trim()
    await done.getByRole('button', { name: 'Done' }).click()
    await toastText(page)
    await search('svc.account')
    check((await text(page.locator('tbody tr').first())).includes('Must change password'), 'new account not flagged "Must change password"')
    // The one-time password works once and forces a change.
    const u = await session()
    await loginUI(u.page, 'svc.account@e2e.oneinsure.test', pw, { expectPath: /change-password/ })
    await u.close()
    return `Validation OK; duplicate: "${dup}"; e-mail account created, flagged, one-time password leads to forced change.`
  })

  await tc({ id: 'ADM-03', module: M, role: 'SuperAdmin', title: 'Edit roles', steps: 'Actions for Rahul Verma > Edit roles; add Team Leader; save', expected: 'Roles updated (toast) and shown in the row; DB has both roles' }, async () => {
    await fresh()
    await search('Rahul')
    await action('Rahul Verma', 'Edit roles')
    const d = page.getByRole('dialog', { name: 'Edit roles' })
    await d.getByRole('checkbox', { name: /Team Leader/ }).check()
    await d.getByRole('button', { name: 'Save roles' }).click()
    const t = await toastText(page)
    await waitUntil(async () => (await text(page.locator('tbody tr').first())).includes('TeamLeader'), 'TeamLeader badge')
    const n = scalar(`SELECT COUNT(*) AS n FROM auth.UserRoles ur JOIN auth.Users u ON u.UserId = ur.UserId WHERE u.Email = ${q(USERS.rahul.email)}`)
    check(n === 2, `Rahul has ${n} roles`)
    return `Toast "${t}"; row shows Employee + TeamLeader.`
  })

  await tc({ id: 'ADM-04', module: M, role: 'SuperAdmin', title: 'Reset password (one-time password; sessions revoked)', steps: 'Rahul signed in elsewhere; Actions > Reset password; confirm', expected: 'One-time password shown once; Rahul\'s open session ends; old password refused; one-time password forces change' }, async () => {
    const rahul = await signedIn(USERS.rahul.email, PASSWORD)
    await fresh()
    await search('Rahul')
    await action('Rahul Verma', 'Reset password')
    const d = page.getByRole('dialog', { name: 'Reset password?' })
    await d.getByRole('button', { name: 'Reset password' }).click()
    const done = page.getByRole('dialog', { name: 'Password reset' })
    const pw = (await done.getByLabel('One-time password').innerText()).trim()
    await done.getByRole('button', { name: 'Done' }).click()
    const me = await rahul.get('/auth/me')
    const old = await new ApiClient().post('/auth/login', { login: USERS.rahul.email, password: PASSWORD })
    const fresh2 = new ApiClient()
    const r = await fresh2.post('/auth/login', { login: USERS.rahul.email, password: pw })
    check(me.status === 401, `old session still valid (${me.status})`)
    check(old.status === 401, `old password still accepted (${old.status})`)
    check(r.data?.status === 'PASSWORD_CHANGE_REQUIRED', `login with one-time password: ${JSON.stringify(r.data?.status)}`)
    await fresh2.ok('POST', '/auth/change-password', { currentPassword: pw, newPassword: PASSWORD })
    return 'One-time password shown; previous session 401; old password refused; new one requires a change (restored).'
  })

  await tc({ id: 'ADM-05', module: M, role: 'SuperAdmin', title: 'Unlock a locked account', steps: 'Status Locked; Actions for Lokesh Kumar > Unlock account; confirm; Lokesh signs in', expected: 'Unlock succeeds; Lokesh can sign in immediately' }, async () => {
    exec(`UPDATE auth.Users SET LockoutEndUtc = DATEADD(MINUTE, 15, SYSUTCDATETIME()) WHERE Email = ${q(USERS.lockme.email)}`)
    await fresh()
    await page.getByLabel('Status').selectOption('locked')
    await waitUntil(async () => (await text(page.locator('tbody').first())).includes('Lokesh Kumar'), 'locked list')
    await action('Lokesh Kumar', 'Unlock account')
    await page.getByRole('dialog', { name: 'Unlock account?' }).getByRole('button', { name: 'Unlock' }).click()
    const t = await toastText(page)
    const r = await new ApiClient().post('/auth/login', { login: USERS.lockme.email, password: PASSWORD })
    check(r.status === 200, `login after unlock -> ${r.status}`)
    return `Toast "${t}"; Lokesh signs in.`
  })

  await tc({ id: 'ADM-06', module: M, role: 'SuperAdmin', title: 'Reset MFA for a user who lost the phone', steps: 'Kavya enrols TOTP (API); Actions > Reset MFA; confirm; Kavya signs in', expected: 'Row shows MFA on before, MFA off after; password alone signs in' }, async () => {
    // Enrol through the API unless an earlier scenario (MFA-01) already did (then a password-only sign-in is not possible).
    if (!scalar(`SELECT CAST(MfaEnabled AS INT) AS m FROM auth.Users WHERE Email = ${q(USERS.mfa.email)}`)) {
      const k = await signedIn(USERS.mfa.email, PASSWORD)
      const setup = await k.ok('POST', '/account/mfa/totp/setup', { currentPassword: PASSWORD })
      await k.ok('POST', '/account/mfa/totp/confirm', { code: await freshTotp(setup.secret) })
    }
    await fresh()
    await search('Kavya')
    check((await text(page.locator('tbody tr').first())).includes('MFA on'), 'MFA on badge missing')
    await action('Kavya Nair', 'Reset MFA')
    await page.getByRole('dialog', { name: 'Reset two-factor authentication?' }).getByRole('button', { name: 'Reset MFA' }).click()
    await toastText(page)
    await waitUntil(async () => (await text(page.locator('tbody tr').first())).includes('MFA off'), 'MFA off badge')
    const r = await new ApiClient().post('/auth/login', { login: USERS.mfa.email, password: PASSWORD })
    check(r.data?.status === 'SUCCESS', `login status ${r.data?.status}`)
    return 'MFA reset; password-only sign-in works.'
  })

  await tc({ id: 'ADM-07', module: M, role: 'SuperAdmin', title: 'Deactivate / activate a user account', steps: 'Deactivate nolink user; user tries to sign in; Inactive filter; Activate', expected: 'Sign-in refused with "deactivated" message; activation restores access' }, async () => {
    await fresh()
    await search('nolink')
    await action(USERS.nolink.email, 'Deactivate')
    await page.getByRole('dialog', { name: 'Deactivate user?' }).getByRole('button', { name: 'Deactivate' }).click()
    await toastText(page)
    const u = await session()
    await loginUI(u.page, USERS.nolink.email, PASSWORD, { expectPath: null })
    const msg = await text(u.page.getByRole('alert').first())
    await u.close()
    check(/deactivated/i.test(msg), `sign-in message "${msg}"`)
    await page.getByLabel('Status').selectOption('inactive')
    await waitUntil(async () => (await text(page.locator('tbody').first())).includes(USERS.nolink.email), 'inactive list')
    await action(USERS.nolink.email, 'Activate')
    await page.getByRole('dialog', { name: 'Activate user?' }).getByRole('button', { name: 'Activate' }).click()
    await toastText(page)
    const r = await new ApiClient().post('/auth/login', { login: USERS.nolink.email, password: PASSWORD })
    check(r.status === 200, `login after activation ${r.status}`)
    return `Deactivated (sign-in: "${msg}"); re-activated, sign-in OK.`
  })

  await tc({ id: 'ADM-08', module: M, role: 'SuperAdmin', title: 'Own account: no self-deactivation', steps: 'Open actions for own row', expected: 'Edit roles / Reset password offered, no Deactivate' }, async () => {
    await fresh()
    await page.getByRole('button', { name: 'Actions for Sunita Rao' }).click()
    const items = await page.getByRole('menuitem').allInnerTexts()
    await page.keyboard.press('Escape')
    check(!items.some((i) => /Deactivate/.test(i)), `own menu: ${items.join(', ')}`)
    return `Own menu: ${items.map((x) => x.trim()).join(', ')}.`
  })

  await tc({ id: 'ADM-09', module: M, role: 'SuperAdmin', title: 'Roles matrix editable; SuperAdmin keeps roles.manage', steps: 'Grant Employee "View and export reports"; Save; check DB; undo + save', expected: 'Checkbox editable, Save per role, toast; SuperAdmin/roles.manage cell disabled' }, async () => {
    await fresh()
    const cell = page.getByRole('checkbox', { name: 'Employee: View and export reports' })
    await cell.check()
    await page.getByRole('button', { name: 'Save Employee' }).click()
    const t = await toastText(page)
    const has = scalar("SELECT COUNT(*) AS n FROM auth.RolePermissions rp JOIN auth.Roles r ON r.RoleId = rp.RoleId JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE r.Code = 'Employee' AND p.Code = 'reports.view'")
    check(has === 1, 'permission not saved')
    await waitUntil(async () => (await page.getByRole('button', { name: 'Save Employee' }).count()) === 0, 'save button gone after save')
    await page.getByRole('checkbox', { name: 'Employee: View and export reports' }).uncheck()
    await page.getByRole('button', { name: 'Save Employee' }).click()
    await toastText(page)
    const locked = await page.getByRole('checkbox', { name: 'Super Administrator: Edit roles and the permission matrix' }).isDisabled()
    check(locked, 'SuperAdmin roles.manage editable')
    return `Saved ("${t}") and reverted; SuperAdmin roles.manage locked.`
  })

  // ---- Admin (not SuperAdmin): escalation guards ----
  await tc({ id: 'ADM-10', module: M, role: 'Admin', title: 'Admin cannot act on or grant Super Administrator', steps: 'Admin opens Administration; checks SuperAdmin row, Create user role list and roles matrix', expected: 'SuperAdmin row "Protected"; SuperAdmin role disabled with note; matrix Read-only' }, async () => {
    const a = await as(USERS.admin.email, { path: '/admin' })
    await a.page.locator('tbody tr').first().waitFor()
    const prot = await text(a.page.locator('tbody tr').filter({ hasText: 'Sunita Rao' }))
    await a.page.getByRole('button', { name: /Create( user)?/ }).first().click()
    const d = a.page.getByRole('dialog', { name: 'Create user account' })
    const superBox = d.getByRole('checkbox', { name: /Super Administrator/ })
    await superBox.waitFor()
    const disabled = await superBox.isDisabled()
    const note = await d.getByText('Needs the "manage roles" permission to grant.').isVisible()
    await d.getByRole('button', { name: 'Cancel' }).click()
    const ro = await a.page.getByText('Read-only', { exact: true }).isVisible()
    const boxes = await a.page.locator('table input[type=checkbox]').count()
    await a.close()
    check(prot.includes('Protected'), `SuperAdmin row "${prot}"`)
    check(disabled && note, 'SuperAdmin role grantable by Admin in the UI')
    check(ro && boxes === 0, `matrix read-only=${ro}, checkboxes=${boxes}`)
    return 'Protected row, disabled SuperAdmin role with note, read-only matrix.'
  })

  await tc({ id: 'ADM-11', module: M, role: 'Admin', title: 'API refuses privilege escalation by an Admin', steps: 'As Admin (API): create user with SuperAdmin; set Priya\'s roles to SuperAdmin; reset SuperAdmin\'s password; edit role matrix', expected: '403 for each' }, async () => {
    const a = await signedIn(USERS.admin.email, PASSWORD)
    const priya = scalar(`SELECT PublicId FROM auth.Users WHERE Email = ${q(USERS.priya.email)}`)
    const sup = scalar(`SELECT PublicId FROM auth.Users WHERE Email = ${q(USERS.superadmin.email)}`)
    const r1 = await a.post('/admin/users', { email: 'evil@e2e.oneinsure.test', roles: ['SuperAdmin'] })
    const r2 = await a.put(`/admin/users/${priya}/roles`, { roles: ['SuperAdmin'] })
    const r3 = await a.post(`/admin/users/${sup}/reset-password`)
    const r4 = await a.put('/admin/roles/Admin/permissions', { permissions: ['roles.manage'] })
    const codes = [r1.status, r2.status, r3.status, r4.status]
    check(codes.every((c) => c === 403), `statuses ${codes.join(', ')}`)
    return `All refused: ${codes.join(', ')}.`
  })

  await tc({ id: 'ADM-12', module: M, role: 'SuperAdmin', title: 'Last SuperAdmin cannot be demoted', steps: 'SuperAdmin removes own SuperAdmin role (Edit roles on own row)', expected: 'Error "You cannot remove your own Super Administrator role." shown in the dialog' }, async () => {
    await fresh()
    await action('Sunita Rao', 'Edit roles')
    const d = page.getByRole('dialog', { name: 'Edit roles' })
    await d.getByRole('checkbox', { name: /Super Administrator/ }).uncheck()
    await d.getByRole('checkbox', { name: /^Administrator/ }).check()
    await d.getByRole('button', { name: 'Save roles' }).click()
    const msg = await text(d.getByRole('alert').first())
    await d.getByRole('button', { name: 'Cancel' }).click()
    check(/own Super Administrator role|At least one active Super Administrator/.test(msg), `message "${msg}"`)
    return `Refused: "${msg}".`
  })

  await tc({ id: 'ADM-13', module: M, role: 'HR Master', title: 'Administration hidden for roles without admin.settings', steps: 'HR Master sidebar; open /admin', expected: 'No Administration item; access denied' }, async () => {
    const h = await as(USERS.hr.email)
    const n = await h.page.locator('aside').getByRole('link', { name: 'Administration' }).count()
    await h.page.goto('/admin')
    await h.page.getByRole('heading', { name: 'Access denied' }).waitFor()
    await h.close()
    check(n === 0, 'Administration visible')
    return 'Hidden and denied.'
  })

  void usersCard
  await s.close()
}
