// Runs the scenario scripts in order and writes tests/e2e/results/results.json + results-summary.md.
// Usage: node run.mjs [scenario-name-filter]      e.g. node run.mjs 03-org
// Env:   E2E_ONLY=<regex on test id>   E2E_HEADED=1 (visible browser)
import { readdirSync } from 'node:fs'
import { closeBrowser } from './lib/browser.mjs'
import { results, writeResults } from './lib/runner.mjs'

const filter = process.argv[2]
const dir = new URL('./scenarios/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && (!filter || f.includes(filter))).sort()
const shared = {}
const started = Date.now()

for (const f of files) {
  console.log(`\n=== ${f} ===`)
  try {
    const mod = await import(new URL(f, dir).href)
    await mod.run(shared)
  } catch (e) {
    console.error(`Scenario ${f} aborted:`, e)
    results.push({ id: `${f}-ABORT`, module: f, role: '-', title: 'Scenario aborted', steps: '-', expected: 'Scenario completes', actual: String(e?.message ?? e), status: 'FAIL', screenshot: null })
  }
}
await closeBrowser()

const name = filter ? `results-${filter}` : 'results'
const byModule = writeResults(name)
const total = results.length
const pass = results.filter((r) => r.status === 'PASS').length
const fail = results.filter((r) => r.status === 'FAIL').length
console.log(`\n${pass}/${total} passed, ${fail} failed, ${total - pass - fail} not run (${Math.round((Date.now() - started) / 1000)} s)`)
console.table(byModule)
process.exitCode = fail ? 1 : 0
