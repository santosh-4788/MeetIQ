// Per-user module access (20 Nov 2026): the administrator ticks Meetings / Chat / Audio calls / Notes & tasks per user.
// Super admin (computer) edits tst.e2's access; tst.e2 (phone) sees only what is ticked. Isolated environment only.
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\user-access.mjs
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 7 * 60_000).unref()
import { Api, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, view, writeResults } from './harness.mjs'

const ADMIN = 'superadmin@room.oneinsure.test'
const USER = { email: 'tst.e2@room.oneinsure.test' }
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS')")
exec("UPDATE auth.Users SET PasswordHash = (SELECT PasswordHash FROM auth.Users WHERE Email = 'hema.host@room.oneinsure.test'), MustChangePassword = 0 WHERE Email IN ('tst.e2@room.oneinsure.test', 'superadmin@room.oneinsure.test')")
exec(`DELETE b FROM auth.UserModuleBlocks b JOIN auth.Users u ON u.UserId = b.UserId WHERE u.Email = '${USER.email}'`)
const ok = {}

const admin = await newPage({ width: 1366, height: 860 })
await loginUI(admin, ADMIN)
const nav = (p) => p.getByRole('navigation', { name: 'Main' })

async function setAccess(ticks) {
  await admin.goto('/admin')
  await admin.getByPlaceholder(/Search name/i).fill('tst.e2')
  const row = admin.locator('tr', { hasText: USER.email })
  await row.waitFor()
  await row.getByRole('button', { name: /actions|more/i }).click()
  await admin.getByRole('menuitem', { name: 'Edit access' }).click()
  const dlg = admin.getByRole('dialog', { name: 'Edit access' })
  await dlg.waitFor()
  for (const m of ['meetings', 'chat', 'calls', 'tasks']) {
    const box = dlg.getByTestId('access-' + m)
    if (await box.isDisabled()) continue
    if ((await box.isChecked()) !== ticks.includes(m)) await box.click()
  }
  for (const m of ['calls', 'tasks']) {
    const box = dlg.getByTestId('access-' + m)
    if (!(await box.isDisabled()) && (await box.isChecked()) !== ticks.includes(m)) await box.click()
  }
  await view(admin, `ua-dialog-${ticks.join('-') || 'none'}`)
  await dlg.getByTestId('access-save').click()
  await dlg.waitFor({ state: 'detached' })
  await admin.locator('tr', { hasText: USER.email }).getByTestId('user-access').waitFor()
  return (await admin.locator('tr', { hasText: USER.email }).getByTestId('user-access').innerText()).trim()
}

ok.chatOnly = await tc('UA-01', 'Chat and audio calls only: the user lands on Chat and sees no meeting pages', 'admin ticks Chat + Audio calls → user signs in → /chat; menu without Dashboard/Meetings/My Day; /dashboard → Access denied; API: meetings 403, calls allowed, tasks 403', async () => {
  const label = await setAccess(['chat', 'calls'])
  check(/Chat, Audio calls/.test(label), `list shows "${label}"`)
  check(scalar(`SELECT COUNT(*) AS n FROM app.AuditLog WHERE [Action] = 'USER_ACCESS_CHANGED' AND Utc > DATEADD(MINUTE, -2, SYSUTCDATETIME())`) >= 1, 'no audit row')
  const user = await newPage({ width: 390, height: 844, mobile: true })
  await loginUI(user, USER.email).catch(() => {})
  await user.waitForURL(/\/chat/, { timeout: 20_000 })
  await user.getByTestId('chat-page').waitFor()
  check(await user.getByTestId('mobile-tabbar').getByText('Meetings').count() === 0, 'Meetings in the phone tab bar')
  await user.getByRole('button', { name: /menu/i }).first().click()
  await nav(user).getByRole('link', { name: /^Chat/ }).first().waitFor()
  const links = (await nav(user).locator('a').allInnerTexts()).map((t) => t.trim())
  for (const bad of ['Dashboard', 'My Meetings', 'Meeting Calendar', 'Recording Library', 'My Day', 'Tasks']) check(!links.some((l) => l.startsWith(bad)), `menu shows ${bad}`)
  await view(user, 'ua-chat-only-menu')
  await user.goto('/dashboard')
  await user.waitForURL(/access-denied/, { timeout: 10_000 })
  const api = await new Api().login(USER.email)
  check((await api.req('GET', '/meetings?page=1&pageSize=5')).status === 403, 'meetings API not refused')
  check((await api.req('GET', '/chat/tasks')).status === 403, 'tasks API not refused')
  check((await api.req('GET', '/chat/calls/current')).status === 200, 'calls API refused')
  await user.context().browser().close()
  return 'Chat + calls only; meetings and tasks refused'
})

ok.meetingsOnly = await tc('UA-02', 'Meetings only: no Chat anywhere', 'admin ticks Meetings → user lands on the dashboard; no Chat in the menu or tab bar; /chat API 403', async () => {
  const label = await setAccess(['meetings'])
  check(label.endsWith('Meetings'), `list shows "${label}"`)
  const user = await newPage({ width: 1366, height: 860 })
  await loginUI(user, USER.email)
  await nav(user).getByRole('link', { name: 'Dashboard' }).waitFor()
  check(await nav(user).getByRole('link', { name: /^Chat/ }).count() === 0, 'Chat still in the menu')
  const api = await new Api().login(USER.email)
  check((await api.req('GET', '/chat/conversations')).status === 403, 'chat API not refused')
  await view(user, 'ua-meetings-only')
  await user.context().browser().close()
  return 'meetings only'
})

ok.restore = await tc('UA-03', 'All modules again; the create-user form has the Access section', 'access back to All; "Create user account" shows the four modules ticked', async () => {
  const label = await setAccess(['meetings', 'chat', 'calls', 'tasks'])
  check(/All/.test(label), `list shows "${label}"`)
  check(scalar(`SELECT COUNT(*) AS n FROM auth.UserModuleBlocks b JOIN auth.Users u ON u.UserId = b.UserId WHERE u.Email = '${USER.email}'`) === 0, 'blocks left behind')
  await admin.getByRole('button', { name: /Create/ }).first().click()
  const picker = admin.getByTestId('access-picker')
  await picker.waitFor()
  for (const m of ['meetings', 'chat', 'calls', 'tasks']) check(await picker.getByTestId('access-' + m).isChecked(), `${m} not ticked by default`)
  await admin.getByTestId('access-chat').click()
  check(await admin.getByTestId('access-calls').isDisabled(), 'Audio calls not disabled without Chat')
  await view(admin, 'ua-create-user')
  return 'restored; create form OK'
})

await closeAll()
writeResults('user-access')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
await sleep(0)
