import fs from 'node:fs'
import path from 'node:path'
import { startRecorder, ROOT } from './lib.mjs'
const cases = [
  { name: 'customer meeting, shipped placeholder policy', args: { kind: 'customer', consent: 'granted' }, env: {}, expect: 'CUSTOMER_RECORDING_DISABLED' },
  { name: 'internal meeting, consent missing', args: { kind: 'internal', consent: 'missing' }, env: {}, expect: 'CONSENT_MISSING' },
  { name: 'Pilot env, customer recording enabled without legal approval', args: { kind: 'customer', consent: 'granted' }, env: { OIC_Recorder__Environment: 'Pilot', OIC_RecordingPolicy__CustomerRecordingEnabled: 'true' }, expect: 'POLICY_INVALID' },
  { name: 'Production env, customer recording enabled without legal approval', args: { kind: 'customer', consent: 'granted' }, env: { OIC_Recorder__Environment: 'Production', OIC_RecordingPolicy__CustomerRecordingEnabled: 'true' }, expect: 'POLICY_INVALID' },
]
const out = []
for (const c of cases) {
  const rec = startRecorder({ room: `policy-${Date.now().toString(36)}`, ...c.args, env: c.env })
  const code = await rec.waitExit(60_000)
  const r = rec.result()
  const types = rec.events().map((e) => e.type ?? e.evt?.type)
  const joined = types.some((t) => ['attempt_started', 'connected'].includes(t))
  const pass = code === 3 && r?.status === 'REFUSED' && r?.Code === c.expect && !joined
  out.push({ case: c.name, exitCode: code, status: r?.status, code: r?.Code, joinedRoom: joined, pass })
  console.log(pass ? 'PASS' : 'FAIL', c.name, '->', code, r?.Code, 'joined:', joined)
}
fs.mkdirSync(path.join(ROOT, 'tests/r2-poc/results'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'tests/r2-poc/results/policy-e2e.json'), JSON.stringify(out, null, 2))
