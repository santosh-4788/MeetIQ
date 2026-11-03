// Re-runs only the Edge playback/seek check on the MP4s of an existing scenario run and records the outcome
// next to the original results (the original JSON files are not modified).
//   node harness/recheck-playback.mjs <runId>      e.g. 2026-10-31T02-00-35
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, playbackCheck } from './lib.mjs'

const runId = process.argv[2]
if (!runId) throw new Error('usage: node harness/recheck-playback.mjs <runId>')
const dir = path.join(ROOT, 'tests/r2-poc/results', runId)
const out = []
for (const f of fs.readdirSync(dir).filter((n) => /^T\d\d-.+\.json$/.test(n)).sort()) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const mp4 = r.recorder?.file
  if (!mp4 || !fs.existsSync(mp4)) { out.push({ test: f, ok: false, error: `MP4 not found (${mp4})` }); continue }
  const playback = await playbackCheck(mp4)
  const otherChecks = Object.entries(r.checks ?? {}).filter(([k]) => k !== 'playbackOk')
  const allOtherPass = otherChecks.every(([, v]) => v === true)
  out.push({ test: f, file: path.basename(mp4), playback, otherChecksPass: allOtherPass, failedOther: otherChecks.filter(([, v]) => v !== true).map(([k]) => k), passWithRecheck: allOtherPass && playback.ok })
  console.log(`${f}: playback ${playback.ok ? 'OK' : 'FAIL ' + playback.error} | other checks ${allOtherPass ? 'all pass' : 'FAIL'}`)
}
fs.writeFileSync(path.join(dir, 'playback-recheck.json'), JSON.stringify({ atUtc: new Date().toISOString(), reason: 'harness served MP4 without HTTP range support; seeks silently reset to 0', results: out }, null, 2))
