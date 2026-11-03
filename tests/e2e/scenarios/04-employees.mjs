// 4. Employee master: list, filters, sort, paging, add/edit validation, detail, (de)activate, user account, CSV import.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { as, settle, text, toastText, waitUntil } from '../lib/browser.mjs'
import { USERS } from '../lib/config.mjs'
import { scalar } from '../lib/db.mjs'
import { RESULTS_DIR, check, tc } from '../lib/runner.mjs'

const M = 'Employees'

export async function run() {
  const s = await as(USERS.admin.email, { path: '/employees' })
  const page = s.page
  const rows = () => page.locator('tbody tr')
  const fresh = async () => {
    await page.goto('/employees')
    await rows().first().waitFor()
    await settle(page, 200)
  }
  const pager = () => text(page.getByRole('navigation', { name: 'Pagination' }))

  await tc({ id: 'EMP-01', module: M, role: 'Admin', title: 'List, paging and page size', steps: 'Open Employee Management; read pager; Next; Previous', expected: '25 rows on page 1 of 2 (31 active employees); Next shows the rest' }, async () => {
    await fresh()
    const p1 = await pager()
    check((await rows().count()) === 25, `page 1 has ${await rows().count()} rows`)
    check(/of 31/.test(p1) && /Page 1 of 2/.test(p1), `pager "${p1}"`)
    await page.getByRole('button', { name: 'Next page' }).click()
    await waitUntil(async () => /Page 2 of 2/.test(await pager()) && (await rows().count()) === 6, 'page 2 with 6 rows')
    const n2 = await rows().count()
    check(n2 === 6, `page 2 has ${n2} rows`)
    check(await page.getByRole('button', { name: 'Next page' }).isDisabled(), 'Next enabled on last page')
    await page.getByRole('button', { name: 'Previous page' }).click()
    await waitUntil(async () => /Page 1 of 2/.test(await pager()), 'back to page 1')
    return `"${p1}"; page 2 has ${n2} rows; Next disabled on the last page.`
  })

  await tc({ id: 'EMP-02', module: M, role: 'Admin', title: 'Search, filters, clear filters', steps: 'Search "priya"; then department Sales + branch Delhi; status Inactive (none); Clear filters', expected: 'Results narrow correctly; empty state with "Clear filters" restores the list' }, async () => {
    await fresh()
    await page.getByLabel('Search employees').fill('priya')
    await waitUntil(async () => (await rows().count()) === 1, 'search to 1 row')
    check((await text(rows().first())).includes('Priya Sharma'), 'wrong search hit')
    await page.getByLabel('Search employees').fill('')
    await page.getByLabel('Department').selectOption('SALES')
    await page.getByLabel('Branch').selectOption('DEL')
    await settle(page, 600)
    const r = await rows().allInnerTexts()
    check(r.length > 0 && r.every((x) => x.includes('Sales') && x.includes('Delhi')), `filtered rows: ${r.length}`)
    await page.getByLabel('Status').selectOption('inactive')
    await page.getByText('No matching employees').waitFor()
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await waitUntil(async () => (await rows().count()) === 25, 'list restored')
    return `Search → 1 row; Sales+Delhi → ${r.length} rows; inactive → empty state; Clear filters restored 25 rows.`
  })

  await tc({ id: 'EMP-03', module: M, role: 'Admin', title: 'Sort by code and newest joiners', steps: 'Click Code header; click Joined header', expected: 'Rows ordered by code (E2E-0001 first); Joined sorts newest first with aria-sort' }, async () => {
    await fresh()
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await waitUntil(async () => (await text(rows().first())).includes('E2E-0001'), 'code sort')
    const th = page.locator('th[aria-sort="ascending"]')
    check((await text(th)).includes('Code'), 'aria-sort not on Code')
    await page.getByRole('button', { name: 'Joined', exact: true }).click()
    await waitUntil(async () => (await text(rows().first())).includes('2025'), 'joined sort (2025 joiners first)')
    return 'Code ascending then Joined descending; aria-sort set.'
  })

  await tc({ id: 'EMP-04', module: M, role: 'Admin', title: 'Add employee: client and server validation', steps: 'Add with empty form; invalid e-mail/mobile; invalid code "BAD CODE"; duplicate e-mail of Priya; then valid', expected: 'Required/format messages; server code error; 409 duplicate e-mail message; valid employee saved and detail opens' }, async () => {
    await fresh()
    await page.getByRole('button', { name: 'Add employee' }).first().click()
    const d = page.getByRole('dialog')
    await d.getByRole('button', { name: 'Add employee' }).click()
    for (const m of ['Employee code is required.', 'First name is required.', 'Official e-mail is required.', 'Choose a department.', 'Choose a designation.']) await d.getByText(m).waitFor()
    await d.getByLabel('Employee code').fill('BAD CODE')
    await d.getByLabel('First name').fill('Nikhil')
    await d.getByLabel('Last name (optional)').fill('Rao')
    await d.getByLabel('Official e-mail').fill('nikhil@')
    await d.getByLabel('Mobile (optional)').fill('12ab')
    await d.getByLabel('Department').selectOption('IT')
    await d.getByLabel('Designation').selectOption('EXEC')
    await d.getByRole('button', { name: 'Add employee' }).click()
    await d.getByText('Enter a valid official e-mail.').waitFor()
    await d.getByText('Enter a valid mobile number (digits, optional leading +).').waitFor()
    await d.getByLabel('Official e-mail').fill('nikhil.rao@e2e.oneinsure.test')
    await d.getByLabel('Mobile (optional)').fill('+919812345678')
    await d.getByRole('button', { name: 'Add employee' }).click()
    await d.getByText(/Employee code may contain only/).waitFor()
    await d.getByLabel('Employee code').fill('E2E-0100')
    await d.getByLabel('Official e-mail').fill(USERS.priya.email)
    await d.getByRole('button', { name: 'Add employee' }).click()
    const dup = await text(d.getByRole('alert').first())
    check(/already uses this official e-mail/.test(dup), `duplicate message "${dup}"`)
    await d.getByLabel('Official e-mail').fill('nikhil.rao@e2e.oneinsure.test')
    await d.getByLabel('Date of joining (optional)').fill('2026-01-05')
    await d.getByLabel('Reporting manager (optional)').fill('Arjun')
    await d.getByRole('option', { name: /Arjun Mehta/ }).click()
    await d.getByRole('button', { name: 'Add employee' }).click()
    const t = await toastText(page)
    const det = page.getByRole('dialog', { name: 'Employee details' })
    await det.getByText('Nikhil Rao').first().waitFor()
    const body = await text(det)
    check(body.includes('Arjun Mehta') && body.includes('E2E-0100') && body.includes('no user account'), `detail: ${body.slice(0, 200)}`)
    await det.getByRole('button', { name: 'Close' }).click()
    return `Validation messages shown; duplicate e-mail "${dup}"; saved (${t}); detail shows manager and "no user account".`
  })

  await tc({ id: 'EMP-05', module: M, role: 'Admin', title: 'Edit employee: reporting loop is refused', steps: 'Open Priya; Edit; set reporting manager Rahul (who reports to Priya); save', expected: 'Field error "would create a reporting loop"; then clear manager and save OK' }, async () => {
    await fresh()
    await page.getByLabel('Search employees').fill('Priya')
    await waitUntil(async () => (await rows().count()) === 1, 'priya row')
    await rows().first().click()
    const det = page.getByRole('dialog', { name: 'Employee details' })
    await det.getByRole('button', { name: 'Edit' }).click()
    const d = page.getByRole('dialog', { name: 'Edit employee' })
    check(await d.getByLabel('Employee code').isDisabled(), 'code editable')
    await d.getByLabel('Reporting manager (optional)').fill('Rahul')
    await d.getByRole('option', { name: /Rahul Verma/ }).click()
    await d.getByRole('button', { name: 'Save changes' }).click()
    await d.getByText('This reporting manager would create a reporting loop.').waitFor()
    await d.getByRole('button', { name: 'Remove Rahul Verma' }).click()
    await d.getByLabel('Mobile (optional)').fill('+919800000003')
    await d.getByRole('button', { name: 'Save changes' }).click()
    const t = await toastText(page)
    check(t.includes('Employee updated'), `toast ${t}`)
    await page.keyboard.press('Escape')
    return 'Loop refused with field error; save without manager succeeded.'
  })

  await tc({ id: 'EMP-06', module: M, role: 'Admin', title: 'Deactivate and re-activate an employee (account disabled, sessions revoked)', steps: 'Open Ritu Desai (has a user); Deactivate; confirm; filter Inactive; Activate', expected: 'Ritu inactive and her user account disabled; activation restores employee but account stays disabled' }, async () => {
    await fresh()
    await page.getByLabel('Search employees').fill('Ritu')
    await waitUntil(async () => (await rows().count()) === 1, 'ritu row')
    await rows().first().click()
    const det = page.getByRole('dialog', { name: 'Employee details' })
    await det.getByRole('button', { name: 'Deactivate' }).click()
    await page.getByRole('dialog', { name: /Deactivate Ritu Desai/ }).getByRole('button', { name: 'Deactivate employee' }).click()
    await toastText(page)
    const userActive = scalar(`SELECT CAST(IsActive AS INT) AS a FROM auth.Users WHERE Email = '${USERS.reset.email}'`)
    check(userActive === 0, 'linked user account still active')
    await page.keyboard.press('Escape')
    await page.getByLabel('Search employees').fill('')
    await page.getByLabel('Status').selectOption('inactive')
    await waitUntil(async () => (await text(rows().first())).includes('Ritu Desai'), 'inactive list shows Ritu')
    await rows().first().click()
    await det.getByRole('button', { name: 'Activate' }).click()
    await page.getByRole('dialog', { name: /Activate Ritu Desai/ }).getByRole('button', { name: 'Activate employee' }).click()
    await toastText(page)
    await det.getByText('The account is disabled.').waitFor()
    return 'Employee + account deactivated; activation restored the employee; detail explains the account stays disabled.'
  })

  await tc({ id: 'EMP-07', module: M, role: 'Admin', title: 'Create user account from the employee detail (one-time password shown once)', steps: 'Open Meera Iyer (No login); Create user account; role Employee; Create', expected: 'One-time password shown once; dialog cannot be dismissed until Done; account listed in detail' }, async () => {
    await fresh()
    await page.getByLabel('Search employees').fill('Meera')
    await waitUntil(async () => (await rows().count()) === 1, 'meera row')
    check((await text(rows().first())).includes('No login'), 'Meera not marked No login')
    await rows().first().click()
    const det = page.getByRole('dialog', { name: 'Employee details' })
    await det.getByRole('button', { name: 'Create user account' }).click()
    const d = page.getByRole('dialog', { name: 'Create user account' })
    await d.getByRole('button', { name: 'Create account' }).click()
    const done = page.getByRole('dialog', { name: 'User account created' })
    const pw = await done.getByLabel('One-time password').innerText()
    check(pw.length >= 16, `one-time password "${pw}"`)
    check((await done.getByRole('button', { name: 'Close' }).count()) === 0, 'created dialog can be dismissed with the X')
    await done.getByRole('button', { name: 'Done' }).click()
    await toastText(page)
    await det.getByText('meera.iyer@e2e.oneinsure.test').last().waitFor()
    s.shared = { meeraPassword: pw.trim() }
    return 'One-time password shown once; account listed in the drawer.'
  })

  await tc({ id: 'EMP-08', module: M, role: 'Admin', title: 'CSV import: template, dry run with errors, apply', steps: 'Import CSV: download template; choose file with 1 valid + 2 invalid rows; Check file; fix file; Check; Apply', expected: 'Template has the header; row errors listed and Apply unavailable; valid file: dry run then Apply creates employees' }, async () => {
    await fresh()
    await page.getByRole('button', { name: 'Import CSV' }).click()
    const d = page.getByRole('dialog', { name: 'Import employees from CSV' })
    const [dl] = await Promise.all([page.waitForEvent('download'), d.getByRole('button', { name: 'Download template' }).click()])
    const tpl = join(RESULTS_DIR, 'employee-import-template.csv')
    await dl.saveAs(tpl)
    const header = readFileSync(tpl, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0]
    check(header.startsWith('EmployeeCode,FirstName,LastName'), `template header "${header}"`)
    const bad = join(RESULTS_DIR, 'import-bad.csv')
    writeFileSync(bad, [header, 'E2E-2001,Asha,Import,,asha.import@e2e.oneinsure.test,,OPS,EXEC,MUM,E2E-0003,2026-02-01', 'E2E-2002,,NoFirst,,bad-email,,NOPE,EXEC,,,01/02/2026', 'E2E-2003,Dup,Mail,,' + USERS.priya.email + ',,OPS,EXEC,,,'].join('\r\n'))
    await page.locator('#employee-import-file').setInputFiles(bad)
    await d.getByText('import-bad.csv').waitFor()
    await d.getByRole('button', { name: 'Check file' }).click()
    await d.getByText('2 rows with errors').waitFor()
    const report = await text(d.locator('tbody'))
    check(/firstName/.test(report) && /dateOfJoining/.test(report) && /Already used by employee/.test(report), `report: ${report.slice(0, 300)}`)
    check((await d.getByRole('button', { name: 'Apply import' }).count()) === 0, 'Apply offered with errors')
    const good = join(RESULTS_DIR, 'import-good.csv')
    writeFileSync(good, [header, 'E2E-2001,Asha,Import,,asha.import@e2e.oneinsure.test,,OPS,EXEC,MUM,E2E-0003,2026-02-01', 'E2E-2002,Bina,Import,,bina.import@e2e.oneinsure.test,9876500011,SALES,EXEC,DEL,E2E-2001,2026-02-02'].join('\r\n'))
    await page.locator('#employee-import-file').setInputFiles(good)
    await d.getByRole('button', { name: 'Check file' }).click()
    await d.getByText('Every row is valid').waitFor()
    check(scalar("SELECT COUNT(*) AS n FROM org.Employees WHERE EmployeeCode IN ('E2E-2001','E2E-2002')") === 0, 'dry run saved rows')
    await d.getByRole('button', { name: 'Apply import' }).click()
    await d.getByText('Import applied').waitFor()
    await d.getByRole('button', { name: 'Done' }).click()
    await toastText(page)
    const n = scalar("SELECT COUNT(*) AS n FROM org.Employees WHERE EmployeeCode IN ('E2E-2001','E2E-2002')")
    const mgr = scalar("SELECT m.EmployeeCode AS c FROM org.Employees e JOIN org.Employees m ON m.EmployeeId = e.ReportingManagerId WHERE e.EmployeeCode = 'E2E-2002'")
    check(n === 2 && mgr === 'E2E-2001', `created ${n}, manager of E2E-2002 = ${mgr}`)
    return 'Template downloaded; 2 error rows reported (Apply hidden); valid file dry-run saved nothing; Apply created 2 employees with in-file manager.'
  })

  await tc({ id: 'EMP-09', module: M, role: 'HR Master', title: 'HR Master manages employees but cannot create user accounts', steps: 'Sign in as HR; open an employee without login', expected: 'Employee Management available; "Create user account" not offered (needs users.manage)' }, async () => {
    const hr = await as(USERS.hr.email, { path: '/employees' })
    await hr.page.locator('tbody tr').first().waitFor()
    await hr.page.getByLabel('Search employees').fill('Aarav')
    await waitUntil(async () => (await hr.page.locator('tbody tr').count()) === 1, 'aarav row')
    await hr.page.locator('tbody tr').first().click()
    const det = hr.page.getByRole('dialog', { name: 'Employee details' })
    await det.getByText('there is no user account').waitFor()
    const btn = await det.getByRole('button', { name: 'Create user account' }).count()
    await hr.close()
    check(btn === 0, 'Create user account offered to HR')
    return 'Detail shows "no user account" without a create button.'
  })

  await tc({ id: 'EMP-10', module: M, role: 'Admin', title: 'Mobile layout: employee cards and sort select at 390 px', steps: 'Open Employee Management at 390x844', expected: 'Cards instead of table; Sort select visible; no horizontal page scroll' }, async () => {
    const m = await as(USERS.admin.email, { width: 390, height: 844, path: '/employees' })
    await m.page.locator('ul li button').filter({ hasText: 'E2E-' }).first().waitFor()
    const sortVisible = await m.page.getByLabel('Sort by').isVisible()
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    await m.close()
    check(sortVisible, 'sort select hidden on mobile')
    check(overflow <= 1, `page scrolls horizontally by ${overflow}px`)
    return 'Cards + sort select; no horizontal overflow.'
  })

  await s.close()
}
