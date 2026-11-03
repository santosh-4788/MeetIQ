// 3. Organisation masters: departments, designations, branches, teams (+ members).
import { as, settle, text, toastText, waitUntil } from '../lib/browser.mjs'
import { USERS } from '../lib/config.mjs'
import { scalar } from '../lib/db.mjs'
import { check, tc } from '../lib/runner.mjs'

const M = 'Organisation'

async function openTab(page, name) {
  // Fresh page per case, so one failure (e.g. a dialog left open) does not cascade into the next case.
  await page.goto('/organisation')
  await page.getByRole('tab', { name }).click()
  await page.locator('tbody tr').first().waitFor()
  await settle(page, 150)
}

const row = (page, name) => page.locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) })

export async function run() {
  const hr = await as(USERS.hr.email, { path: '/organisation' })
  const page = hr.page

  await tc({ id: 'ORG-01', module: M, role: 'HR Master', title: 'Department list, search and show-inactive', steps: 'Open Department Management; search "oper"; clear; toggle Show inactive', expected: 'Seeded departments listed with employee counts; search filters; toggle works' }, async () => {
    await page.goto('/organisation')
    await page.getByRole('cell', { name: 'Operations', exact: true }).waitFor()
    const ops = await text(row(page, 'Operations'))
    check(/OPS/.test(ops) && /\b\d+\b/.test(ops), `Operations row: ${ops}`)
    await page.getByLabel('Search departments').fill('oper')
    await settle(page, 100)
    const n = await page.locator('tbody tr').count()
    check(n === 1, `search "oper" shows ${n} rows`)
    await page.getByRole('button', { name: 'Clear search' }).click()
    await page.getByRole('switch').click()
    await settle(page)
    await page.getByRole('switch').click()
    return `Operations row "${ops}"; search narrowed to 1 row; toggle OK.`
  })

  await tc({ id: 'ORG-02', module: M, role: 'HR Master', title: 'Add department: validation and duplicate code', steps: 'Add department with empty fields; invalid code "BAD CODE"; duplicate code OPS; then valid FIN', expected: 'Field errors; 409 "already exists" shown in dialog; valid one saved with toast' }, async () => {
    await openTab(page, 'Departments')
    await page.getByRole('button', { name: 'Add department' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Add department' }).click()
    await dlg.getByText('Code is required.').waitFor()
    await dlg.getByText('Name is required.').waitFor()
    await dlg.getByLabel('Code').fill('BAD CODE')
    await dlg.getByLabel('Name').fill('Bad')
    await dlg.getByRole('button', { name: 'Add department' }).click()
    await dlg.getByText("Use letters, digits, '-', '_' and '/' only.").waitFor()
    await dlg.getByLabel('Code').fill('OPS')
    await dlg.getByRole('button', { name: 'Add department' }).click()
    const dup = await text(dlg.getByRole('alert').first())
    check(/already exists/i.test(dup), `duplicate message "${dup}"`)
    await dlg.getByLabel('Code').fill('FIN')
    await dlg.getByLabel('Name').fill('Finance')
    await dlg.getByLabel('Parent department (optional)').selectOption({ label: 'Operations' })
    await dlg.getByRole('button', { name: 'Add department' }).click()
    const t = await toastText(page)
    await row(page, 'Finance').waitFor()
    check(t.includes('Department added'), `toast "${t}"`)
    return `Required/format errors shown; duplicate: "${dup}"; Finance added (toast "${t}").`
  })

  await tc({ id: 'ORG-03', module: M, role: 'HR Master', title: 'Edit department and set head', steps: 'Edit Finance: rename, pick head Vikram Shah', expected: 'Code locked; changes saved; head shown in list' }, async () => {
    await openTab(page, 'Departments')
    await row(page, 'Finance').getByRole('button', { name: 'Edit Finance' }).click()
    const dlg = page.getByRole('dialog')
    check(await dlg.getByLabel('Code').isDisabled(), 'code editable on edit')
    await dlg.getByLabel('Name').fill('Finance & Accounts')
    await dlg.getByLabel('Department head (optional)').fill('Vikram')
    await dlg.getByRole('option', { name: /Vikram Shah/ }).click()
    await dlg.getByRole('button', { name: 'Save changes' }).click()
    await row(page, 'Finance & Accounts').waitFor()
    const r = await text(row(page, 'Finance & Accounts'))
    check(r.includes('Vikram Shah') && r.includes('OPS'), `row "${r}"`)
    return `Row now "${r}".`
  })

  await tc({ id: 'ORG-04', module: M, role: 'HR Master', title: 'Deactivate a department with active employees is blocked', steps: 'Deactivate Operations; confirm', expected: '409 message "Move or deactivate the department\'s active employees first." in the dialog; stays active' }, async () => {
    await openTab(page, 'Departments')
    await row(page, 'Operations').getByRole('button', { name: 'Deactivate Operations' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Deactivate department' }).click()
    const msg = await text(dlg.getByRole('alert'))
    check(msg.includes('active employees first'), `message "${msg}"`)
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    check((await text(row(page, 'Operations'))).includes('Active'), 'Operations no longer active')
    return `Blocked with: "${msg}".`
  })

  await tc({ id: 'ORG-05', module: M, role: 'HR Master', title: 'Deactivate and re-activate an empty department', steps: 'Deactivate "Unused Department"; Show inactive; Activate', expected: 'Disappears from active list; visible as Inactive with Show inactive; activation works' }, async () => {
    await openTab(page, 'Departments')
    await row(page, 'Unused Department').getByRole('button', { name: 'Deactivate Unused Department' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Deactivate department' }).click()
    await toastText(page)
    await row(page, 'Unused Department').waitFor({ state: 'detached' })
    await page.getByRole('switch').click()
    await row(page, 'Unused Department').waitFor()
    check((await text(row(page, 'Unused Department'))).includes('Inactive'), 'not shown as inactive')
    await row(page, 'Unused Department').getByRole('button', { name: 'Activate Unused Department' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Activate department' }).click()
    await toastText(page)
    await waitUntil(async () => !(await text(row(page, 'Unused Department'))).includes('Inactive'), 'Unused Department not re-activated')
    await page.getByRole('switch').click()
    return 'Deactivated, listed as Inactive, re-activated.'
  })

  await tc({ id: 'ORG-06', module: M, role: 'HR Master', title: 'Designations: add with level validation, edit, deactivate blocked', steps: 'Add designation level 150; fix to 4 (Senior Manager); deactivate Executive', expected: 'Level error; saved; Executive deactivation blocked with 409 message' }, async () => {
    await openTab(page, 'Designations')
    await page.getByRole('button', { name: 'Add designation' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Code').fill('SRMGR')
    await dlg.getByLabel('Name').fill('Senior Manager')
    await dlg.getByLabel('Level (optional)').fill('150')
    await dlg.getByRole('button', { name: 'Add designation' }).click()
    await dlg.getByText('Level must be a whole number from 0 to 100.').waitFor()
    await dlg.getByLabel('Level (optional)').fill('4')
    await dlg.getByRole('button', { name: 'Add designation' }).click()
    await row(page, 'Senior Manager').waitFor()
    await row(page, 'Executive').getByRole('button', { name: 'Deactivate Executive' }).click()
    const c = page.getByRole('dialog')
    await c.getByRole('button', { name: 'Deactivate designation' }).click()
    const msg = await text(c.getByRole('alert'))
    await c.getByRole('button', { name: 'Cancel' }).click()
    check(/active employees first/i.test(msg), `message "${msg}"`)
    return `Level validated; Senior Manager added; Executive blocked: "${msg}".`
  })

  await tc({ id: 'ORG-07', module: M, role: 'HR Master', title: 'Branches: add, edit time zone', steps: 'Add branch BLR Bengaluru (Asia/Kolkata); edit city', expected: 'Branch saved and listed with location and time zone' }, async () => {
    await openTab(page, 'Branches')
    await page.getByRole('button', { name: 'Add branch' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Code').fill('BLR')
    await dlg.getByLabel('Name').fill('Bengaluru Branch')
    await dlg.getByLabel('City (optional)').fill('Bangalore')
    await dlg.getByLabel('State (optional)').fill('Karnataka')
    await dlg.getByLabel('Time zone').selectOption('Asia/Kolkata')
    await dlg.getByRole('button', { name: 'Add branch' }).click()
    await row(page, 'Bengaluru Branch').waitFor()
    await row(page, 'Bengaluru Branch').getByRole('button', { name: 'Edit Bengaluru Branch' }).click()
    await page.getByRole('dialog').getByLabel('City (optional)').fill('Bengaluru')
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    const r = await text(row(page, 'Bengaluru Branch'))
    check(r.includes('Bengaluru, Karnataka') && r.includes('Asia/Kolkata'), `row "${r}"`)
    return `Row "${r}".`
  })

  await tc({ id: 'ORG-08', module: M, role: 'HR Master', title: 'Deactivating a branch that still has active employees', steps: 'Deactivate Delhi Branch (has active employees)', expected: 'Blocked like departments/designations (otherwise those employees can no longer be saved)' }, async () => {
    await openTab(page, 'Branches')
    await row(page, 'Delhi Branch').getByRole('button', { name: 'Deactivate Delhi Branch' }).click()
    const c = page.getByRole('dialog')
    await c.getByRole('button', { name: 'Deactivate branch' }).click()
    await settle(page)
    const blocked = await c.getByRole('alert').isVisible().catch(() => false)
    const msg = blocked ? await text(c.getByRole('alert')) : ''
    if (blocked) await c.getByRole('button', { name: 'Cancel' }).click()
    const active = scalar("SELECT CAST(IsActive AS INT) AS a FROM org.Branches WHERE Code = 'DEL'")
    if (!active) await (await import('../lib/db.mjs')).exec("UPDATE org.Branches SET IsActive = 1, DeactivatedUtc = NULL WHERE Code = 'DEL'")
    check(blocked && active === 1, 'Delhi Branch was deactivated although active employees are assigned to it')
    return `Blocked: "${msg}".`
  })

  await tc({ id: 'ORG-09', module: M, role: 'HR Master', title: 'Teams: add with validation; members drawer add/remove/save', steps: 'Add team without department; then OPS-T2 in Sales; open Members; add Kavya; remove; add Lokesh; save', expected: '"Choose a department." error; team saved; members saved; count updated' }, async () => {
    await openTab(page, 'Teams')
    await page.getByRole('button', { name: 'Add team' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Code').fill('SALES-T1')
    await dlg.getByLabel('Name').fill('Sales Hunters')
    await dlg.getByRole('button', { name: 'Add team' }).click()
    await dlg.getByText('Choose a department.').waitFor()
    await dlg.getByLabel('Department').selectOption({ label: 'Sales' })
    await dlg.getByRole('button', { name: 'Add team' }).click()
    await row(page, 'Sales Hunters').waitFor()
    await row(page, 'Sales Hunters').getByRole('button', { name: 'Members of Sales Hunters' }).click()
    const d = page.getByRole('dialog')
    await d.getByText('No members').waitFor()
    check(await d.getByRole('button', { name: 'Save members' }).isDisabled(), 'Save enabled without changes')
    await d.getByLabel('Add member').fill('Kavya')
    await d.getByRole('option', { name: /Kavya Nair/ }).click()
    await d.getByRole('button', { name: 'Remove Kavya Nair' }).click()
    await d.getByLabel('Add member').fill('Lokesh')
    await d.getByRole('option', { name: /Lokesh Kumar/ }).click()
    await d.getByLabel('Add member').fill('Ritu')
    await d.getByRole('option', { name: /Ritu Desai/ }).click()
    await d.getByText('Unsaved changes').waitFor()
    await d.getByRole('button', { name: 'Save members' }).click()
    await d.waitFor({ state: 'detached' })
    await settle(page)
    const r = await text(row(page, 'Sales Hunters'))
    check(/\b2\b/.test(r), `row "${r}" does not show 2 members`)
    return `Team created; members saved; row "${r}".`
  })

  await tc({ id: 'ORG-10', module: M, role: 'HR Master', title: 'Inactive team: Members button disabled', steps: 'Deactivate Sales Hunters; show inactive', expected: 'Members button disabled with a hint' }, async () => {
    await openTab(page, 'Teams')
    await row(page, 'Sales Hunters').getByRole('button', { name: 'Deactivate Sales Hunters' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Deactivate team' }).click()
    await toastText(page)
    await page.getByRole('switch').click()
    await row(page, 'Sales Hunters').waitFor()
    check(await row(page, 'Sales Hunters').getByRole('button', { name: 'Members of Sales Hunters' }).isDisabled(), 'Members enabled for an inactive team')
    await row(page, 'Sales Hunters').getByRole('button', { name: 'Activate Sales Hunters' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Activate team' }).click()
    await toastText(page)
    return 'Members disabled while inactive; re-activated.'
  })

  await tc({ id: 'ORG-11', module: M, role: 'Employee', title: 'Employee cannot manage organisation masters', steps: 'Employee opens /organisation; sidebar check', expected: 'No "Department Management" in sidebar; URL shows Access denied' }, async () => {
    const s = await as(USERS.priya.email)
    const has = await s.page.locator('aside').getByRole('link', { name: 'Department Management' }).count()
    await s.page.goto('/organisation')
    await s.page.getByRole('heading', { name: 'Access denied' }).waitFor()
    await s.close()
    check(has === 0, 'sidebar shows Department Management')
    return 'Hidden in sidebar; access denied by URL.'
  })

  await hr.close()
}
