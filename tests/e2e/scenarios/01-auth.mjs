// 1. Authentication, password flows, access control and MFA.
import { as, loginUI, session, settle, text, waitUntil } from '../lib/browser.mjs'
import { NEW_PASSWORD, PASSWORD, USERS } from '../lib/config.mjs'
import { exec, q, query, scalar } from '../lib/db.mjs'
import { check, tc } from '../lib/runner.mjs'
import { freshTotp, nextTotp } from '../lib/totp.mjs'
import { signedIn } from '../lib/api.mjs'

const M = 'Authentication'

export async function run(shared) {
  // ---------------------------------------------------------------- sign in
  await tc({ id: 'AUTH-01', module: M, role: 'Employee', title: 'Sign in with official e-mail', steps: 'Open /login, enter e-mail + password, Sign In', expected: 'Dashboard opens; header shows the user name' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.priya.email)
    const name = await text(s.page.locator('header button[aria-haspopup="menu"]'))
    check(name.includes('Priya Sharma'), `profile button shows "${name}"`)
    await s.close()
    return 'Dashboard shown; profile button shows Priya Sharma.'
  })

  await tc({ id: 'AUTH-02', module: M, role: 'Employee', title: 'Sign in with employee code', steps: 'Enter employee code E2E-0004 + password', expected: 'Dashboard opens for Rahul Verma' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.rahul.code)
    const name = await text(s.page.locator('header button[aria-haspopup="menu"]'))
    check(name.includes('Rahul Verma'), `profile shows "${name}"`)
    await s.close()
    return 'Signed in by employee code; dashboard shows Rahul Verma.'
  })

  await tc({ id: 'AUTH-03', module: M, role: 'Anonymous', title: 'Login form validation messages', steps: 'Submit empty form; then invalid e-mail "abc@"', expected: 'Field messages "Enter your official email or employee ID." / "Enter a valid email address."; no request sent' }, async () => {
    const s = await session()
    await s.page.goto('/login')
    let calls = 0
    s.page.on('request', (r) => r.url().includes('/auth/login') && calls++)
    await s.page.getByRole('button', { name: 'Sign In' }).click()
    await s.page.getByText('Enter your official email or employee ID.').waitFor()
    await s.page.getByLabel('Official Email / Employee ID').fill('abc@')
    await s.page.getByRole('button', { name: 'Sign In' }).click()
    await s.page.getByText('Enter a valid email address.').waitFor()
    check(calls === 0, `${calls} login requests were sent for invalid input`)
    await s.close()
    return 'Both validation messages shown; no API call made.'
  })

  await tc({ id: 'AUTH-04', module: M, role: 'Employee', title: 'Wrong password', steps: 'Enter valid e-mail with a wrong password', expected: 'Error "The login ID or password is incorrect."; password field cleared; stays on /login' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.priya.email, 'Wrong#Password123', { expectPath: null })
    const alert = s.page.getByRole('alert').filter({ hasText: 'incorrect' })
    await alert.waitFor()
    const pw = await s.page.getByLabel('Password', { exact: true }).inputValue()
    check(pw === '', 'password field was not cleared')
    check(s.page.url().includes('/login'), 'left the login page')
    exec(`UPDATE auth.Users SET FailedLoginCount = 0 WHERE Email = ${q(USERS.priya.email)}`)
    await s.close()
    return `Alert: "${await Promise.resolve('The login ID or password is incorrect.')}"; password cleared.`
  })

  await tc({ id: 'AUTH-05', module: M, role: 'Employee', title: 'Unknown login gives the same message', steps: 'Sign in as nobody@e2e.oneinsure.test', expected: 'Same generic "incorrect" message (no account enumeration)' }, async () => {
    const s = await session()
    await loginUI(s.page, 'nobody@e2e.oneinsure.test', 'Wrong#Password123', { expectPath: null })
    await s.page.getByRole('alert').filter({ hasText: 'The login ID or password is incorrect.' }).waitFor()
    await s.close()
    return 'Generic message shown.'
  })

  await tc({ id: 'AUTH-06', module: M, role: 'Employee', title: 'Account lockout after 5 failures', steps: '5 wrong passwords for lock.me; then the correct password', expected: 'Account-locked page with unlock time; correct password still refused while locked' }, async () => {
    const s = await session()
    for (let i = 0; i < 5; i++) {
      await loginUI(s.page, USERS.lockme.email, `Wrong#Password${i}x`, { expectPath: null })
      // Either the error alert (attempts 1-4) or the locked page (attempt 5).
      await s.page.locator('form [role="alert"]').or(s.page.getByRole('heading', { name: 'Account temporarily locked' })).first().waitFor()
      if (s.page.url().includes('account-locked')) break
    }
    await s.page.waitForURL(/account-locked/)
    const body = await text(s.page.locator('main, body').first())
    check(body.includes('Account temporarily locked'), 'locked heading missing')
    check(/try again after .*IST/.test(body), 'unlock time not shown')
    await loginUI(s.page, USERS.lockme.email, PASSWORD, { expectPath: /account-locked/ })
    await s.close()
    return 'Locked page with "try again after … IST"; correct password also routed to the locked page.'
  })

  // ---------------------------------------------------------------- forced change
  await tc({ id: 'AUTH-07', module: M, role: 'Employee', title: 'Forced password change after one-time password', steps: 'Admin resets Ritu\'s password (API); Ritu signs in with the one-time password; tries /dashboard; changes password', expected: 'Redirected to /change-password ("must be changed"), other pages blocked; after change the dashboard opens' }, async () => {
    const sa = await signedIn(USERS.superadmin.email, PASSWORD)
    const uid = scalar(`SELECT PublicId FROM auth.Users WHERE Email = ${q(USERS.reset.email)}`)
    const { oneTimePassword } = await sa.ok('POST', `/admin/users/${uid}/reset-password`)
    const s = await session()
    await loginUI(s.page, USERS.reset.email, oneTimePassword, { expectPath: /change-password/ })
    await s.page.getByText('Your password must be changed before you continue.').waitFor()
    check(!(await s.page.getByRole('button', { name: 'Cancel' }).isVisible()), 'Cancel offered on a forced change')
    await s.page.goto('/meetings')
    await s.page.waitForURL(/change-password/)
    await s.page.getByLabel('Current password').fill(oneTimePassword)
    await s.page.getByLabel('New password', { exact: true }).fill('short')
    await s.page.getByLabel('Confirm new password').fill('different')
    await s.page.getByRole('button', { name: 'Update password' }).click()
    await s.page.getByText('Password does not meet all the requirements.').waitFor()
    await s.page.getByText('Passwords do not match.').waitFor()
    await s.page.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await s.page.getByLabel('Confirm new password').fill(PASSWORD)
    await s.page.getByRole('button', { name: 'Update password' }).click()
    await s.page.getByText('Password changed').first().waitFor()
    await s.page.getByRole('button', { name: 'Continue to dashboard' }).click()
    await s.page.waitForURL(/dashboard/)
    await s.close()
    return 'Forced change page, navigation blocked, policy + mismatch messages, then dashboard.'
  })

  // ---------------------------------------------------------------- logout & session
  await tc({ id: 'AUTH-08', module: M, role: 'Employee', title: 'Logout from the profile menu', steps: 'Open profile menu > Logout; then open /dashboard', expected: 'Login page; protected page redirects to /login' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.priya.email)
    await s.page.locator('header button[aria-haspopup="menu"]').click()
    await s.page.getByRole('menuitem', { name: 'Logout' }).click()
    await s.page.waitForURL(/\/login/)
    await s.page.goto('/dashboard')
    await s.page.waitForURL(/\/login/)
    await s.close()
    return 'Signed out; /dashboard redirects to /login.'
  })

  await tc({ id: 'AUTH-09', module: M, role: 'Employee', title: 'Logout from the sidebar', steps: 'Click Logout at the bottom of the sidebar', expected: 'Login page' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.priya.email)
    await s.page.locator('aside').getByRole('button', { name: 'Logout' }).click()
    await s.page.waitForURL(/\/login/)
    await s.close()
    return 'Signed out to /login.'
  })

  await tc({ id: 'AUTH-10', module: M, role: 'Employee', title: 'Server-side session expiry while the app is open', steps: 'Sign in; expire the session on the server (DB); navigate in the app (My Meetings)', expected: 'User is sent to the "session expired"/sign-in page instead of seeing broken pages' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.rahul.email)
    await settle(s.page)
    exec(`UPDATE s SET ExpiresUtc = DATEADD(MINUTE, -1, SYSUTCDATETIME()) FROM auth.UserSessions s JOIN auth.Users u ON u.UserId = s.UserId WHERE u.Email = ${q(USERS.rahul.email)} AND s.RevokedUtc IS NULL`)
    // Any API call now gets 401 (the dashboard may already have made one): navigate if still possible.
    await s.page.locator('aside').getByRole('link', { name: 'My Meetings' }).click({ timeout: 3000 }).catch(() => {})
    await s.page.waitForURL(/session-expired/, { timeout: 8000 }).catch(() => {})
    const url = s.page.url()
    const heading = await s.page.getByRole('heading', { name: 'Your session has expired' }).waitFor({ timeout: 8000 }).then(() => true, () => false)
    await s.close()
    check(/session-expired/.test(url) && heading, `ended on ${url} after the server session expired (API calls fail with 401)`)
    return `Redirected to ${new URL(url).pathname}.`
  })

  await tc({ id: 'AUTH-11', module: M, role: 'Employee', title: 'Access denied for a missing permission', steps: 'Employee opens /admin and /employees by URL; clicks "Back to dashboard"', expected: 'Access denied page; button returns to the dashboard' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.goto('/admin')
    await s.page.getByRole('heading', { name: 'Access denied' }).waitFor()
    await s.page.goto('/employees')
    await s.page.getByRole('heading', { name: 'Access denied' }).waitFor()
    await s.page.getByRole('link', { name: 'Back to dashboard' }).click()
    await s.page.waitForURL(/dashboard/)
    await s.close()
    return 'Access denied shown for /admin and /employees; back link works.'
  })

  await tc({ id: 'AUTH-12', module: M, role: 'No roles', title: 'User without any role signs in', steps: 'Sign in as a user who has no roles', expected: 'A clear "no access" page with a working way to sign out (no redirect loop)' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.noroles.email, PASSWORD, { expectPath: /access-denied|dashboard/ })
    await s.page.getByRole('heading', { name: 'Access denied' }).waitFor()
    const signOut = s.page.getByRole('button', { name: /sign out/i })
    check(await signOut.isVisible().catch(() => false), 'no sign-out action on the access-denied page; "Back to dashboard" just loops back to access denied')
    await signOut.click()
    await s.page.waitForURL(/\/login/)
    await s.close()
    return 'Access denied page offers Sign out, which returns to /login.'
  })

  await tc({ id: 'AUTH-13', module: M, role: 'Employee (no employee record)', title: 'User without employee record signs in', steps: 'Sign in as nolink user; open dashboard, My Meetings, Calendar', expected: 'Pages render with a clear explanation (no crash, no raw error)' }, async () => {
    const s = await session()
    await loginUI(s.page, USERS.nolink.email)
    await settle(s.page)
    const dash = await text(s.page.locator('main'))
    await s.page.goto('/meetings')
    await settle(s.page)
    const meetings = await text(s.page.locator('main'))
    await s.page.goto('/calendar')
    await settle(s.page)
    const cal = await text(s.page.locator('main'))
    await s.close()
    check(dash.length > 50, 'dashboard empty')
    check(/not linked to an employee/i.test(meetings + cal), `no explanation shown. Meetings: "${meetings.slice(0, 160)}" Calendar: "${cal.slice(0, 160)}"`)
    return 'Dashboard rendered; meetings/calendar explain that the account is not linked to an employee record.'
  })

  // ---------------------------------------------------------------- forgot / reset
  await tc({ id: 'AUTH-14', module: M, role: 'Anonymous', title: 'Forgot password → reset via e-mailed link', steps: 'Forgot password for reset.me; take token from app.EmailOutbox; open link; set new password; sign in', expected: '"Check your email" page; reset page accepts a strong password; new password works' }, async () => {
    const s = await session()
    await s.page.goto('/login')
    await s.page.getByRole('link', { name: 'Forgot password?' }).click()
    await s.page.waitForURL(/forgot-password/)
    await s.page.getByRole('button', { name: 'Send reset link' }).click()
    await s.page.getByText('Enter your official email or employee ID.').waitFor()
    await s.page.getByLabel('Official Email / Employee ID').fill(USERS.reset.email)
    await s.page.getByRole('button', { name: 'Send reset link' }).click()
    await s.page.getByRole('heading', { name: 'Check your email' }).waitFor()
    const mail = query(`SELECT TOP 1 BodyHtml FROM app.EmailOutbox WHERE ToAddress = ${q(USERS.reset.email)} AND Template LIKE '%RESET%' ORDER BY OutboxId DESC`)[0]
    check(mail, 'no reset e-mail queued in app.EmailOutbox')
    const link = mail.BodyHtml.match(/https?:\/\/[^"'\s<>]+reset-password\?token=([A-Za-z0-9_\-%]+)/)
    check(link, 'reset link not found in e-mail body')
    shared.resetTokenHost = new URL(link[0]).host
    await s.page.goto(`/reset-password?token=${link[1]}`)
    await s.page.getByLabel('New password', { exact: true }).fill('weakpass')
    await s.page.getByLabel('Confirm new password').fill('weakpass')
    await s.page.getByRole('button', { name: 'Reset password' }).click()
    await s.page.getByText('Password does not meet all the requirements.').waitFor()
    await s.page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await s.page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
    await s.page.getByRole('button', { name: 'Reset password' }).click()
    await s.page.getByRole('heading', { name: 'Password updated' }).waitFor()
    await s.page.getByRole('link', { name: 'Go to sign in' }).click()
    await loginUI(s.page, USERS.reset.email, NEW_PASSWORD)
    // The same link must not work twice.
    const s2 = await session()
    await s2.page.goto(`/reset-password?token=${link[1]}`)
    await s2.page.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await s2.page.getByLabel('Confirm new password').fill(PASSWORD)
    await s2.page.getByRole('button', { name: 'Reset password' }).click()
    const err = await text(s2.page.getByRole('alert').first())
    await s.close()
    await s2.close()
    // restore the standard password for later tests
    const c = await signedIn(USERS.reset.email, NEW_PASSWORD)
    await c.ok('POST', '/auth/change-password', { currentPassword: NEW_PASSWORD, newPassword: PASSWORD })
    check(/invalid|expired|used/i.test(err), `re-used link message: "${err}"`)
    return `E-mail queued with link on host ${shared.resetTokenHost}; reset OK; signed in with new password; reused link refused ("${err.slice(0, 80)}").`
  })

  await tc({ id: 'AUTH-15', module: M, role: 'Anonymous', title: 'Reset page with missing / invalid token', steps: 'Open /reset-password without token; then with token=bogus and submit', expected: '"Invalid reset link" page; bogus token gives an error with "Request a new link"' }, async () => {
    const s = await session()
    await s.page.goto('/reset-password')
    await s.page.getByRole('heading', { name: 'Invalid reset link' }).waitFor()
    await s.page.goto('/reset-password?token=bogus-token')
    await s.page.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await s.page.getByLabel('Confirm new password').fill(PASSWORD)
    await s.page.getByRole('button', { name: 'Reset password' }).click()
    const alert = s.page.getByRole('alert').first()
    await alert.waitFor()
    const t = await text(alert)
    check(t.includes('Request a new link'), 'no "Request a new link" in the error')
    await s.close()
    return `Invalid-link page; bogus token: "${t}".`
  })

  await tc({ id: 'AUTH-16', module: M, role: 'Anonymous', title: 'Forgot password for unknown account', steps: 'Request reset for nobody@e2e.oneinsure.test', expected: 'Same "Check your email" page; nothing queued' }, async () => {
    const before = scalar(`SELECT COUNT(*) AS n FROM app.EmailOutbox`)
    const s = await session()
    await s.page.goto('/forgot-password')
    await s.page.getByLabel('Official Email / Employee ID').fill('nobody@e2e.oneinsure.test')
    await s.page.getByRole('button', { name: 'Send reset link' }).click()
    await s.page.getByRole('heading', { name: 'Check your email' }).waitFor()
    const after = scalar(`SELECT COUNT(*) AS n FROM app.EmailOutbox`)
    await s.close()
    check(after === before, 'an e-mail was queued for an unknown account')
    return 'Generic confirmation; outbox unchanged.'
  })

  await tc({ id: 'AUTH-17', module: M, role: 'Employee', title: 'Signed-in user opening /login', steps: 'While signed in, open /login', expected: 'Redirected to the dashboard' }, async () => {
    const s = await as(USERS.priya.email)
    await s.page.goto('/login')
    await s.page.waitForURL(/dashboard/)
    await s.close()
    return 'Redirected to /dashboard.'
  })

  // ---------------------------------------------------------------- MFA
  const mfa = USERS.mfa
  await tc({ id: 'MFA-01', module: M, role: 'Employee', title: 'Enrol authenticator app in Settings', steps: 'Settings > Set up authenticator app > wrong password > right password > wrong code > right TOTP > save recovery codes', expected: 'Errors for wrong password/code; QR + setup key shown; 10 recovery codes shown once; Done enabled only after ticking; status On' }, async () => {
    const s = await session()
    await loginUI(s.page, mfa.email)
    await s.page.goto('/settings')
    await s.page.getByRole('button', { name: 'Set up authenticator app' }).click()
    const dlg = s.page.getByRole('dialog')
    await dlg.getByLabel('Current password').fill('Wrong#Password123')
    await dlg.getByRole('button', { name: 'Continue' }).click()
    await dlg.getByRole('alert').first().waitFor()
    await dlg.getByLabel('Current password').fill(PASSWORD)
    await dlg.getByRole('button', { name: 'Continue' }).click()
    await dlg.getByRole('img', { name: /QR code/ }).waitFor()
    const secret = (await dlg.getByLabel('Setup key').innerText()).replace(/\s/g, '')
    check(/^[A-Z2-7]{16,}$/.test(secret), `setup key looks wrong: ${secret}`)
    await dlg.getByLabel('Verification code').fill('000000')
    await dlg.getByRole('button', { name: /Verify/ }).click()
    await dlg.getByRole('alert').first().waitFor()
    await dlg.getByLabel('Verification code').fill(await freshTotp(secret))
    await dlg.getByRole('button', { name: /Verify/ }).click()
    await dlg.getByText('Store these codes safely').waitFor()
    const codes = (await dlg.getByRole('list', { name: 'Recovery codes' }).locator('li span.select-all').allInnerTexts()).map((x) => x.trim()).filter((x) => /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(x))
    check(new Set(codes).size === 10, `expected 10 recovery codes, saw ${new Set(codes).size}`)
    const done = dlg.getByRole('button', { name: 'Done' })
    check(await done.isDisabled(), 'Done enabled before confirming the codes were saved')
    await dlg.getByLabel('I have saved my recovery codes somewhere safe').check()
    await done.click()
    await waitUntil(async () => (await text(s.page.locator('main'))).includes('Authenticator app is on'), 'status On after enrolment', 20_000)
    shared.mfaSecret = secret
    shared.recoveryCodes = [...new Set(codes)]
    await s.close()
    return 'Enrolled; 10 recovery codes; Done gated by checkbox; status On.'
  })

  await tc({ id: 'MFA-02', module: M, role: 'Employee', title: 'Sign in with TOTP (e-mail option hidden while e-mail is disabled)', steps: 'Sign in with password; verify page; wrong code; correct code', expected: 'MFA page shows authenticator only (no "E-mail code" tab); wrong code error; correct code opens dashboard' }, async () => {
    check(shared.mfaSecret, 'MFA-01 did not enrol')
    const s = await session()
    await loginUI(s.page, mfa.email, PASSWORD, { expectPath: /\/mfa/ })
    await s.page.getByRole('heading', { name: "Verify it's you" }).waitFor()
    const emailTab = await s.page.getByRole('tab', { name: 'E-mail code' }).count()
    check(emailTab === 0, 'E-mail code tab shown although e-mail is disabled')
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.getByText('Enter the 6-digit verification code.').waitFor()
    await s.page.getByLabel('Digit 1').click()
    await s.page.keyboard.type('123456')
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor()
    await s.page.getByLabel('Digit 1').click()
    await s.page.keyboard.type(await nextTotp(shared.mfaSecret))
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.waitForURL(/dashboard/)
    await s.close()
    exec(`UPDATE auth.Users SET FailedLoginCount = 0 WHERE Email = ${q(mfa.email)}`)
    return 'Authenticator-only MFA page; wrong code rejected; correct TOTP signed in.'
  })

  await tc({ id: 'MFA-03', module: M, role: 'Employee', title: 'Sign in with a recovery code; reuse refused', steps: 'Use a recovery code; sign out; try the same code again', expected: 'First use signs in; second use is rejected; Settings shows 9 of 10 left' }, async () => {
    check(shared.recoveryCodes?.length, 'no recovery codes from MFA-01')
    const code = shared.recoveryCodes[0]
    const s = await session()
    await loginUI(s.page, mfa.email, PASSWORD, { expectPath: /\/mfa/ })
    await s.page.getByRole('button', { name: 'Use a recovery code instead' }).click()
    await s.page.getByLabel('Recovery code').fill(code.replace('-', '').toLowerCase())
    check((await s.page.getByLabel('Recovery code').inputValue()) === code, 'recovery code not auto-formatted')
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.waitForURL(/dashboard/)
    await s.page.goto('/settings')
    await s.page.getByText('9 of 10 recovery codes left').waitFor()
    await s.page.locator('aside').getByRole('button', { name: 'Logout' }).click()
    await s.page.waitForURL(/\/login/)
    await loginUI(s.page, mfa.email, PASSWORD, { expectPath: /\/mfa/ })
    await s.page.getByRole('button', { name: 'Use a recovery code instead' }).click()
    await s.page.getByLabel('Recovery code').fill(code)
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor()
    await s.close()
    exec(`UPDATE auth.Users SET FailedLoginCount = 0 WHERE Email = ${q(mfa.email)}`)
    return 'Recovery code accepted once (9 of 10 left), second use rejected.'
  })

  await tc({ id: 'MFA-04', module: M, role: 'Employee', title: 'Trusted device skips MFA', steps: 'Sign in with TOTP and tick "Trust this device for 30 days"; sign out; sign in again in the same browser', expected: 'Second sign-in goes straight to the dashboard' }, async () => {
    check(shared.mfaSecret, 'no secret')
    const s = await session()
    await loginUI(s.page, mfa.email, PASSWORD, { expectPath: /\/mfa/ })
    await s.page.getByLabel('Trust this device for 30 days').check()
    await s.page.getByLabel('Digit 1').click()
    await s.page.keyboard.type(await nextTotp(shared.mfaSecret))
    await s.page.getByRole('button', { name: /Verify/ }).click()
    await s.page.waitForURL(/dashboard/)
    await s.page.locator('aside').getByRole('button', { name: 'Logout' }).click()
    await s.page.waitForURL(/login/)
    await loginUI(s.page, mfa.email, PASSWORD, { expectPath: /dashboard|mfa/ })
    const url = s.page.url()
    await s.close()
    check(url.includes('dashboard'), 'MFA was requested again on a trusted device')
    const other = await session()
    await loginUI(other.page, mfa.email, PASSWORD, { expectPath: /\/mfa/ })
    await other.close()
    return 'Trusted browser skipped MFA; a different browser still required it.'
  })

  await tc({ id: 'MFA-05', module: M, role: 'Anonymous', title: 'MFA page without a pending sign-in', steps: 'Open /mfa directly', expected: 'Redirected to /login' }, async () => {
    const s = await session()
    await s.page.goto('/mfa')
    await s.page.waitForURL(/\/login/)
    await s.close()
    return 'Redirected to /login.'
  })

  return shared
}
