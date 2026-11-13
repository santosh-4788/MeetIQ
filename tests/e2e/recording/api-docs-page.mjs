// 13 Nov 2026: API Documentation page - complete self-explanatory guide, visible only with api.docs.view (Admin, SuperAdmin, or the
// "API Documentation Viewer" role, V025); API keys stay with integrations.manage; the OpenAPI file is no longer public.
// Isolated environment ONLY (LocalDB *_Rec, local API/web).   Run:  cd tests\e2e; node recording\api-docs-page.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots', 'api-docs-page')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
const ADMIN = 'superadmin@rec.oneinsure.test'
const VIEWER = 'arjun.mehta@rec.oneinsure.test' // an Employee; gets the API Documentation Viewer role during the test
const EMPLOYEE = 'priya.sharma@rec.oneinsure.test'
if (!/_Rec$/.test(DB)) throw new Error('Only a database whose name ends in _Rec may be used.')
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Local web server only.')
fs.mkdirSync(SHOTS, { recursive: true })
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sqlcmd = (q) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${q}`], { encoding: 'utf8' }).trim()
const results = []
const pages = []
async function tc(id, title, fn) {
  log(`▶ ${id} ${title}`)
  try { const actual = await fn(); results.push({ id, title, actual, result: 'PASS' }); log(`  PASS ${id}: ${actual ?? ''}`); return true }
  catch (e) {
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(SHOTS, `${id}-fail-${i}.png`), fullPage: true }).catch(() => {})
    results.push({ id, title, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL' }); log(`  FAIL ${id}: ${e?.message ?? e}`); return false
  }
}
const check = (c, m) => { if (!c) throw new Error(m) }
const browsers = []
async function signedIn(email, viewport = { width: 1440, height: 900 }) {
  const b = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1' })
  browsers.push(b)
  const p = await (await b.newContext({ baseURL: WEB, viewport, acceptDownloads: true })).newPage(); p.setDefaultTimeout(20_000)
  pages.push(p)
  await p.goto('/login')
  await p.getByLabel('Official Email / Employee ID').fill(email)
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await p.getByRole('button', { name: 'Sign In' }).click()
  await p.waitForURL(/\/dashboard/)
  return p
}
const status = (p, url) => p.evaluate(async (u) => (await fetch(u)).status, url)

// Start clean: the viewer does not have the role yet.
sqlcmd(`DELETE ur FROM auth.UserRoles ur JOIN auth.Users u ON u.UserId = ur.UserId JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE u.Email = N'${VIEWER}' AND r.Code = 'ApiDocsViewer'`)

let admin
await tc('AD-01', 'Admin: full guide - every section, 13 endpoints with parameters, example request and response; Integrations & API keys tab', async () => {
  admin = await signedIn(ADMIN)
  await admin.getByRole('link', { name: 'API Documentation' }).click()
  await admin.getByTestId('api-guide').waitFor()
  const sections = ['start', 'connection', 'keys', 'scopes', 'endpoints', 'plvc', 'statuses', 'errors', 'limits', 'webhooks', 'postman', 'checklist']
  for (const s of sections) check(await admin.getByTestId(`api-${s}`).count() === 1, `section ${s} missing`)
  const cards = admin.locator('[data-testid^="endpoint-"]')
  const n = await cards.count()
  check(n === 13, `${n} endpoint cards`)
  for (let i = 0; i < n; i++) await cards.nth(i).locator('button').first().click()
  const create = admin.getByTestId('endpoint-create')
  const createText = await create.innerText()
  for (const f of ['prarambhMainId', 'plvcIdentification', 'participants', 'Idempotency-Key', 'Example request', 'Example response', 'OIC-261113-AB12'])
    check(createText.includes(f), `create endpoint lacks "${f}"`)
  check((await admin.getByText('Integrations & API keys').count()) >= 1, 'no Integrations & API keys tab for the admin')
  const shotPath = path.join(SHOTS, 'ad-01-admin-guide.png')
  await admin.screenshot({ path: shotPath, fullPage: true })
  return `${sections.length} sections; ${n} endpoints expanded with parameters/examples; keys tab present`
})

await tc('AD-02', 'Admin: Swagger tab loads the (now private) OpenAPI document; Download OpenAPI works', async () => {
  await admin.getByRole('tab', { name: 'API reference (Swagger)' }).click()
  await admin.locator('.opblock').first().waitFor({ timeout: 30_000 })
  const ops = await admin.locator('.opblock').count()
  await admin.getByRole('tab', { name: 'Integration guide' }).click()
  const [dl] = await Promise.all([admin.waitForEvent('download'), admin.getByTestId('download-openapi').click()])
  const file = path.join(RESULTS, 'downloaded-openapi.json')
  await dl.saveAs(file)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  check(doc.openapi?.startsWith('3.') && Object.keys(doc.paths).length >= 10, 'downloaded file is not the OpenAPI document')
  return `Swagger shows ${ops} operations; downloaded OpenAPI ${doc.openapi} with ${Object.keys(doc.paths).length} paths`
})

await tc('AD-03', 'Ordinary employee: no menu entry, page refused, OpenAPI file refused (403); not public either (401)', async () => {
  const emp = await signedIn(EMPLOYEE)
  check((await emp.getByRole('link', { name: 'API Documentation' }).count()) === 0, 'employee sees the menu entry')
  await emp.goto('/api-docs')
  await emp.waitForURL(/access-denied/)
  const s = await status(emp, '/api/ext/openapi/ext-v1.json')
  const anon = await (await fetch(`${WEB}/api/ext/openapi/ext-v1.json`)).status
  check(s === 403 && anon === 401, `employee ${s}, anonymous ${anon}`)
  return `menu hidden; /api-docs → access denied; OpenAPI: employee ${s}, anonymous ${anon}`
})

await tc('AD-04', 'Admin gives the role: "API Documentation Viewer" is offered in Users & roles; with it the employee sees the whole guide + Swagger, but no API keys tab and no admin integration API', async () => {
  // The role is offered to administrators (it comes from the roles API).
  const roles = await admin.evaluate(async () => (await (await fetch('/api/v1/admin/roles')).json()))
  const list = Array.isArray(roles) ? roles : roles.items ?? []
  check(list.some((r) => (r.code ?? r.Code) === 'ApiDocsViewer' && /API Documentation Viewer/.test(r.name ?? r.Name)), 'role not offered')
  sqlcmd(`INSERT auth.UserRoles (UserId, RoleId) SELECT u.UserId, r.RoleId FROM auth.Users u CROSS JOIN auth.Roles r WHERE u.Email = N'${VIEWER}' AND r.Code = 'ApiDocsViewer'`)
  const v = await signedIn(VIEWER)
  await v.getByRole('link', { name: 'API Documentation' }).click()
  await v.getByTestId('api-guide').waitFor()
  check((await v.locator('[data-testid^="endpoint-"]').count()) === 13, 'viewer does not see all endpoints')
  check((await v.getByRole('tab', { name: /Integrations & API keys/ }).count()) === 0, 'viewer sees the API keys tab')
  const adminApi = await status(v, '/api/v1/admin/integrations')
  const spec = await status(v, '/api/ext/openapi/ext-v1.json')
  check(adminApi === 403 && spec === 200, `admin integrations ${adminApi}, OpenAPI ${spec}`)
  await v.getByRole('tab', { name: 'API reference (Swagger)' }).click()
  await v.locator('.opblock').first().waitFor({ timeout: 30_000 })
  await v.getByRole('tab', { name: 'Integration guide' }).click()
  await v.screenshot({ path: path.join(SHOTS, 'ad-04-viewer-guide.png') })
  return `role offered; viewer sees 13 endpoints + Swagger; keys tab hidden; /admin/integrations ${adminApi}; OpenAPI ${spec}`
})

await tc('AD-05', 'Phone (390 px): the guide is readable - no horizontal page scroll; endpoint cards open', async () => {
  const p = await signedIn(ADMIN, { width: 390, height: 844 })
  await p.goto('/api-docs')
  await p.getByTestId('api-guide').waitFor()
  await p.getByTestId('endpoint-create').locator('button').first().click()
  const sw = await p.evaluate(() => document.scrollingElement.scrollWidth)
  await p.screenshot({ path: path.join(SHOTS, 'ad-05-phone.png') })
  check(sw <= 390, `page scrollWidth ${sw}`)
  return `scrollWidth ${sw}`
})

sqlcmd(`DELETE ur FROM auth.UserRoles ur JOIN auth.Users u ON u.UserId = ur.UserId JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE u.Email = N'${VIEWER}' AND r.Code = 'ApiDocsViewer'`)
for (const b of browsers) await b.close().catch(() => {})
const file = path.join(RESULTS, `api-docs-page-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
fs.writeFileSync(file, JSON.stringify({ suite: 'api-docs-page', web: WEB, db: DB, results }, null, 2))
const passed = results.filter((r) => r.result === 'PASS').length
log(`${passed}/${results.length} passed → ${file}`)
process.exit(passed === results.length ? 0 : 1)
