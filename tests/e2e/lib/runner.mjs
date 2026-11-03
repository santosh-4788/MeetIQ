// Tiny test runner: records each case (id, module, role, steps, expected, actual, PASS/FAIL, screenshot on failure).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url))
const SHOTS = join(RESULTS_DIR, 'screenshots')
mkdirSync(SHOTS, { recursive: true })

export const results = []
let current = { pages: [] }

/** Pages whose state is captured when a case fails, and whose runtime errors fail the case. */
const allSessions = []
export function watch(session) {
  current.pages.push(session)
  allSessions.push(session)
}

export class AssertionError extends Error {}

export function check(condition, message) {
  if (!condition) throw new AssertionError(message)
}

export function eq(actual, expected, label) {
  if (actual !== expected) throw new AssertionError(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const filter = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null

/**
 * meta: { id, module, role, title, steps, expected, allowServerErrors? }
 * fn(): returns a string describing what was observed (the "actual" column) or throws.
 */
export async function tc(meta, fn) {
  if (filter && !filter.test(meta.id)) return
  current = { pages: [] }
  const started = Date.now()
  const row = { ...meta, actual: '', status: 'PASS', screenshot: null, durationMs: 0, issue: meta.issue ?? '', resolution: meta.resolution ?? '' }
  try {
    const actual = await fn()
    row.actual = typeof actual === 'string' ? actual : 'As expected.'
    for (const s of new Set([...current.pages, ...allSessions])) {
      const errs = s.errorsSince?.(started, meta.allowServerErrors) ?? []
      if (errs.length) throw new AssertionError(`Runtime/API errors: ${errs.slice(0, 3).join(' | ')}`)
    }
  } catch (e) {
    row.status = 'FAIL'
    row.actual = (row.actual ? row.actual + ' ' : '') + (e instanceof AssertionError ? e.message : `${e?.name ?? 'Error'}: ${String(e?.message ?? e).split('\n')[0]}`)
    // Sessions opened inside the case first, then any other open page (e.g. a scenario-wide session).
    for (const s of [...current.pages, ...allSessions.slice().reverse()]) {
      try {
        if (s.page && !s.page.isClosed()) {
          const file = join(SHOTS, `${meta.id}.png`)
          await s.page.screenshot({ path: file, fullPage: true, timeout: 5000 })
          row.screenshot = `tests/e2e/results/screenshots/${meta.id}.png`
          break
        }
      } catch {
        /* screenshot is best-effort */
      }
    }
  }
  row.durationMs = Date.now() - started
  results.push(row)
  const mark = row.status === 'PASS' ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${meta.id.padEnd(14)} [${meta.role}] ${meta.title}${row.status === 'FAIL' ? `\n      -> ${row.actual}` : ''}`)
  return row
}

/** Records a case that could not be executed in this environment (counted separately, never as PASS). */
export function notRun(meta, reason) {
  if (filter && !filter.test(meta.id)) return
  results.push({ ...meta, actual: reason, status: 'NOT RUN', screenshot: null, durationMs: 0, issue: '', resolution: '' })
  console.log(`SKIP  ${meta.id.padEnd(14)} [${meta.role}] ${meta.title} -> ${reason}`)
}

export function writeResults(name = 'results') {
  writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(results, null, 2))
  const byModule = {}
  for (const r of results) {
    byModule[r.module] ??= { PASS: 0, FAIL: 0, 'NOT RUN': 0 }
    byModule[r.module][r.status]++
  }
  const lines = ['| Module | Pass | Fail | Not run |', '|---|---|---|---|']
  for (const [m, c] of Object.entries(byModule)) lines.push(`| ${m} | ${c.PASS} | ${c.FAIL} | ${c['NOT RUN']} |`)
  writeFileSync(join(RESULTS_DIR, `${name}-summary.md`), lines.join('\n') + '\n')
  return byModule
}
