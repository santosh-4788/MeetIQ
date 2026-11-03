// Turns results/results.json into the per-module Markdown tables of documentation/LOCALHOST_TEST_REPORT.md.
// Usage: node report.mjs > results/report-tables.md
import { readFileSync } from 'node:fs'

const results = JSON.parse(readFileSync(new URL('./results/results.json', import.meta.url), 'utf8'))

// Defects found by these cases (D-numbers refer to the "Fixed defects" list of the report).
const issues = {
  'AUTH-10': ['D1: an expired/revoked server session left every page broken (401s) instead of signing out', 'Fixed (frontend)'],
  'AUTH-12': ['D2: account without roles looped between Access denied and "Back to dashboard" with no way to sign out', 'Fixed (frontend)'],
  'ORG-08': ['D3: a branch with active employees could be deactivated; those employees then could not be saved', 'Fixed (backend + test)'],
  'ADM-02': ['D4: creating an account for an employee whose e-mail already had an account gave a misleading error', 'Fixed (backend + test)'],
  'ADM-14': ['D5 (reported by user): first SuperAdmin from setup-admin could not be linked to an employee; /schedule unusable', 'Fixed (backend + UI + tests)'],
  'ADM-15': ['D5: Employee detail offered a failing "Create user account" instead of linking the existing account', 'Fixed (backend + UI + tests)'],
  'ADM-16': ['D5: no "Link to employee" action in Administration', 'Fixed (backend + UI + tests)'],
  'ADM-17': ['D5: unlink guard (upcoming meetings)', 'Implemented'],
  'NAV-06': ['D6: "New Meeting"/"Schedule meeting"/"View calendar" links shown to roles that only get Access denied', 'Fixed (frontend)'],
  'DSH-01': ['D7: "Upcoming Meetings · Next 7 days" KPI and list counted all future meetings', 'Fixed (backend + test)'],
  'DSH-02': ['D7', 'Fixed (backend + test)'],
  'DSH-03': ['D7', 'Fixed (backend + test)'],
  'ERR-01': ['D8: API down gave "The request could not be completed."', 'Fixed (frontend)'],
  'ERR-02': ['D8', 'Fixed (frontend)'],
  'ERR-03': ['D9: reload while the API is down redirected to sign-in (looked like a sign-out)', 'Fixed (frontend)'],
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const modules = [...new Set(results.map((r) => r.module))]
const out = []
for (const m of modules) {
  const rows = results.filter((r) => r.module === m)
  out.push(`### ${m}`, '', '| ID | Test case | Role | Expected result | Actual result | Pass/Fail | Issue description | Resolution status |', '|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const [issue, resolution] = issues[r.id] ?? ['', '']
    const actual = r.status === 'FAIL' && r.screenshot ? `${r.actual} (screenshot: \`${r.screenshot}\`)` : r.actual
    out.push(`| ${r.id} | ${esc(r.title)} | ${esc(r.role)} | ${esc(r.expected)} | ${esc(actual)} | **${r.status}** | ${esc(issue)} | ${esc(resolution)} |`)
  }
  out.push('')
}
const totals = modules.map((m) => {
  const rows = results.filter((r) => r.module === m)
  return `| ${m} | ${rows.length} | ${rows.filter((r) => r.status === 'PASS').length} | ${rows.filter((r) => r.status === 'FAIL').length} |`
})
console.log(['| Module | Cases | Pass | Fail |', '|---|---|---|---|', ...totals,
  `| **Total** | **${results.length}** | **${results.filter((r) => r.status === 'PASS').length}** | **${results.filter((r) => r.status === 'FAIL').length}** |`, '', ...out].join('\n'))
