// Admin → Users & roles: an account for someone who is not yet in the employee master is created WITH an employee record
// ("Add new employee" inside Create user / Link to employee), so new users never end up without a calendar or scheduling.
// Isolated environment ONLY: LocalDB OneInsureVideoMeetingDB_Rec, API https://localhost:7192, web http://127.0.0.1:5176.
// Run:  cd tests\e2e; node recording\user-employee-link.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(HERE, 'results', 'screenshots', 'user-employee-link')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const SUPER = 'superadmin@rec.oneinsure.test'
if (!/_Rec$/.test(DB) || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Isolated environment only.')
fs.mkdirSync(SHOTS, { recursive: true })
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const scalar = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${q}`], { encoding: 'utf8' }).trim()
const stamp = Date.now().toString().slice(-6)
const results = []
let page
async function tc(id, title, fn) {
  log(`▶ ${id} ${title}`)
  try { const a = await fn(); results.push({ id, result: 'PASS', a }); log(`  PASS ${id}: ${a}`) } catch (e) {
    await page?.screenshot({ path: path.join(SHOTS, `${id}-fail.png`) }).catch(() => {})
    results.push({ id, result: 'FAIL', a: String(e?.message ?? e) }); log(`  FAIL ${id}: ${e?.message ?? e}`)
  }
}
const check = (c, m) => { if (!c) throw new Error(m) }

const browser = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1' })
page = await (await browser.newContext({ baseURL: WEB, viewport: { width: 1366, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })).newPage()
page.setDefaultTimeout(15_000)
page.on('pageerror', (e) => log(`  [pageerror] ${e.message}`))
await page.goto('/login')
await page.getByLabel('Official Email / Employee ID').fill(SUPER)
await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
await page.getByRole('button', { name: 'Sign In' }).click()
await page.waitForURL(/\/dashboard/, { timeout: 20_000 })

async function fillEmployee(dialog, code, first, email) {
  await dialog.getByLabel('Employee code').fill(code)
  await dialog.getByLabel('First name').fill(first)
  if (email) await dialog.getByLabel('Official e-mail').fill(email)
  await dialog.getByLabel('Department').selectOption({ index: 1 })
  await dialog.getByLabel('Designation').selectOption({ index: 1 })
}

await tc('UE-01', 'Create user → "Add new employee" → the account is created linked to the new employee', async () => {
  const email = `neha.new${stamp}@rec.oneinsure.test`
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Create user' }).click()
  const create = page.getByRole('dialog', { name: 'Create user account' })
  await create.getByTestId('add-new-employee').click()
  const drawer = page.getByRole('dialog').filter({ has: page.getByLabel('Employee code') })
  await fillEmployee(drawer, `NW-${stamp}`, 'Neha', email)
  await page.screenshot({ path: path.join(SHOTS, 'ue01-add-employee-from-create-user.png') })
  await drawer.getByRole('button', { name: /Add employee|Save/ }).click()
  await create.getByText('Neha').first().waitFor({ timeout: 10_000 })
  check(await create.isVisible(), 'saving the employee closed or submitted the Create user dialog')
  await create.getByRole('button', { name: 'Create account' }).click()
  await page.getByRole('dialog', { name: 'User account created' }).waitFor()
  const linked = scalar(`SELECT COUNT(*) FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.Email = N'${email}' AND e.EmployeeCode = 'NW-${stamp}'`)
  check(linked === '1', `account not linked (${linked})`)
  await page.screenshot({ path: path.join(SHOTS, 'ue01-account-created.png') })
  await page.getByRole('button', { name: 'Done' }).click()
  return `account ${email} created and linked to employee NW-${stamp} in one flow`
})

await tc('UE-02', 'E-mail only shows the warning that such accounts cannot schedule or have a calendar', async () => {
  await page.getByRole('button', { name: 'Create user' }).click()
  const create = page.getByRole('dialog', { name: 'Create user account' })
  await create.getByRole('radio', { name: 'E-mail only' }).click()
  const w = await create.getByTestId('email-only-warning').innerText()
  check(/cannot schedule meetings/.test(w), `warning "${w}"`)
  await page.screenshot({ path: path.join(SHOTS, 'ue02-email-only-warning.png') })
  await create.getByRole('button', { name: 'Cancel' }).click()
  return w.replace(/\s+/g, ' ')
})

await tc('UE-03', 'Existing unlinked account → Link to employee → "Add new employee" (e-mail prefilled) → linked', async () => {
  const email = `harsh${stamp}@rec.oneinsure.test`
  // An unlinked account, as on production.
  const api = await page.evaluate(async (email) => {
    const xsrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN=')) ?? '').split('=')[1] ?? '')
    const r = await fetch('/api/v1/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: JSON.stringify({ email, roles: ['Employee'] }) })
    return { status: r.status, body: await r.json() }
  }, email)
  check(api.status === 201 && api.body.linkedToEmployee === false, `create ${JSON.stringify(api)}`)
  await page.goto('/admin')
  const row = page.getByRole('row').filter({ hasText: email })
  await row.getByRole('button').last().click()
  await page.getByRole('menuitem', { name: 'Link to employee' }).click()
  const link = page.getByRole('dialog', { name: 'Link to employee' })
  await link.getByTestId('add-new-employee').click()
  const drawer = page.getByRole('dialog').filter({ has: page.getByLabel('Employee code') })
  let prefilled = ''
  for (let i = 0; i < 20 && prefilled !== email; i++) { prefilled = await drawer.getByLabel('Official e-mail').inputValue(); if (prefilled !== email) await new Promise((r) => setTimeout(r, 150)) }
  check(prefilled === email, `e-mail not prefilled (${prefilled})`)
  await fillEmployee(drawer, `HR-${stamp}`, 'Harsh', null)
  await drawer.getByRole('button', { name: /Add employee|Save/ }).click()
  await link.getByText('Harsh').first().waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(SHOTS, 'ue03-link-new-employee.png') })
  await link.getByRole('button', { name: 'Link account' }).click()
  await link.waitFor({ state: 'hidden' })
  const linked = scalar(`SELECT COUNT(*) FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.Email = N'${email}' AND e.EmployeeCode = 'HR-${stamp}'`)
  check(linked === '1', `not linked (${linked})`)
  return `unlinked account ${email} → new employee HR-${stamp} (e-mail prefilled) → linked`
})

await browser.close()
const passed = results.filter((r) => r.result === 'PASS').length
log(`${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
