// Merges re-run results (results/results-<scenario>.json) into the full-run results (results/results-fullrun.json)
// and writes results/results.json. Rows that changed status keep a note of the full-run outcome, so nothing is hidden.
// Usage: node scripts/merge-reruns.mjs 01-auth 06-settings
import { readFileSync, writeFileSync } from 'node:fs'

const dir = new URL('../results/', import.meta.url)
const read = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
const full = read('results-fullrun.json')
const reruns = new Map(process.argv.slice(2).flatMap((n) => read(`results-${n}.json`)).map((r) => [r.id, r]))
const merged = full.map((r) => {
  const x = reruns.get(r.id)
  if (!x) return r
  const note = r.status !== x.status ? ` [Full run: ${r.status} — ${r.actual}; re-run after the test fix described in the report]` : ''
  return { ...x, actual: x.actual + note }
})
writeFileSync(new URL('results.json', dir), JSON.stringify(merged, null, 2))
console.log(`${merged.filter((r) => r.status === 'PASS').length}/${merged.length} PASS after merging ${reruns.size} re-run rows`)
