// Device-Adaptive Meeting Recording — acceptance tests for the approved spec (2026-11-06).
// Scenarios map directly to the user's approved "Acceptance testing" list (section 7):
//   O1/O4: two landscape cameras, one-to-one          -> landscape 1280x720
//   O2/O7: one landscape + one portrait camera, 1:1   -> portrait 720x1280, no cropping/distortion (frame check)
//   O3:    two portrait cameras, one-to-one           -> portrait 720x1280
//   O5:    three participants (all portrait, worst case) -> stays landscape 1280x720
//   O6:    a participant rotates mid-call              -> canvas orientation locked at join-time, no restart
// Results: tests/r2-poc/results/orientation-<runId>/*.json, one extracted frame PNG for O2/O7.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, FFMPEG_DIR, ensureLiveKit, joinParticipant, startRecorder, rooms, sleep, log, closeParticipantBrowser, analyseMp4, playbackCheck } from './lib.mjs'

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = path.join(ROOT, 'tests/r2-poc/results', `orientation-${runId}`)
fs.mkdirSync(outDir, { recursive: true })

function probeDims(file) {
  const out = execFileSync(path.join(FFMPEG_DIR, 'ffprobe.exe'),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()
  const [width, height] = out.split(',').map(Number)
  return { width, height }
}

function extractFrame(file, atSeconds, outPng) {
  execFileSync(path.join(FFMPEG_DIR, 'ffmpeg.exe'), ['-y', '-ss', String(atSeconds), '-i', file, '-frames:v', '1', outPng])
}

async function runScenario(id, title, { participants, recordSeconds = 36, midCallActions = [], expect }) {
  log(`=== ${id} ${title}`)
  const room = `${id.toLowerCase()}-${Date.now().toString(36)}`
  await rooms.createRoom({ name: room, emptyTimeout: 120 })
  const people = []
  for (let i = 0; i < participants.length; i++) people.push(await joinParticipant(room, i, participants[i].name, participants[i].orientation))
  await sleep(1500) // let tracks stabilise before the recorder joins
  const rec = startRecorder({ room, title })
  if (!(await rec.waitStarted())) throw new Error(`${room}: recorder did not start`)
  const start = Date.now()
  for (const a of midCallActions) {
    await sleep(Math.max(0, a.at * 1000 - (Date.now() - start)))
    log(`${id}: ${a.label}`)
    await a.run(people)
  }
  await sleep(Math.max(0, recordSeconds * 1000 - (Date.now() - start)))
  await rooms.deleteRoom(room).catch(() => {})
  const exitCode = await rec.waitExit(180_000)
  await closeParticipantBrowser()
  const result = rec.result()
  const out = { id, title, room, exitCode, recorder: result, checks: {} }
  const c = out.checks
  c.completedAndVerified = result?.status === 'COMPLETED' && result?.verification?.Passed === true
  if (result?.file && fs.existsSync(result.file)) {
    const dims = probeDims(result.file)
    out.dimensions = dims
    c.dimensionsMatchExpected = dims.width === expect.width && dims.height === expect.height
    out.media = await analyseMp4(result.file)
    out.playback = await playbackCheck(result.file)
    c.avSyncOk = out.media.avPairs >= 3 && Math.abs(out.media.avOffsetMedianMs) <= 80
    c.noFreezes = out.media.freezes.every((f) => f <= 2.5)
    c.playbackOk = out.playback.ok === true
    c.restartsAsExpected = (expect.restarts ?? 0) === result.Restarts
    if (expect.frameAt != null) {
      const png = path.join(outDir, `${id}.frame.png`)
      extractFrame(result.file, expect.frameAt, png)
      out.framePng = png
    }
  }
  out.pass = Object.values(c).length > 0 && Object.values(c).every(Boolean)
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(out, null, 2))
  log(`${id} ${out.pass ? 'PASS' : 'FAIL'} dims=${out.dimensions?.width}x${out.dimensions?.height} checks=${JSON.stringify(c)}`)
  return out
}

await ensureLiveKit()
const results = []

results.push(await runScenario('O1-O4', 'Two landscape cameras, one-to-one (laptop/mobile landscape)', {
  participants: [{ name: 'Employee 1', orientation: 'landscape' }, { name: 'Customer', orientation: 'landscape' }],
  expect: { width: 1280, height: 720, restarts: 0 },
}))

results.push(await runScenario('O2-O7', 'One landscape + one portrait camera, one-to-one (mixed orientation, no cropping)', {
  participants: [{ name: 'Employee 1 (laptop)', orientation: 'landscape' }, { name: 'Customer (mobile portrait)', orientation: 'portrait' }],
  expect: { width: 720, height: 1280, restarts: 0, frameAt: 20 },
}))

results.push(await runScenario('O3', 'Two portrait cameras, one-to-one (mobile-to-mobile portrait)', {
  participants: [{ name: 'Employee 1 (mobile)', orientation: 'portrait' }, { name: 'Customer (mobile)', orientation: 'portrait' }],
  expect: { width: 720, height: 1280, restarts: 0 },
}))

results.push(await runScenario('O5', 'Three participants, all portrait cameras (group call must stay landscape)', {
  participants: [{ name: 'Employee 1', orientation: 'portrait' }, { name: 'Employee 2', orientation: 'portrait' }, { name: 'Customer', orientation: 'portrait' }],
  expect: { width: 1280, height: 720, restarts: 0 },
}))

results.push(await runScenario('O6', 'Mobile rotates mid-call (canvas must not change, no restart)', {
  participants: [{ name: 'Employee 1', orientation: 'landscape' }, { name: 'Customer (rotates)', orientation: 'landscape' }],
  recordSeconds: 40,
  midCallActions: [{ at: 18, label: 'rotate participant 1 to portrait', run: (people) => people[1].call('rotate', 'portrait') }],
  expect: { width: 1280, height: 720, restarts: 0 },
}))

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(results.map((r) => ({ id: r.id, title: r.title, pass: r.pass, dimensions: r.dimensions, checks: r.checks })), null, 2))
log('=== DONE ===')
for (const r of results) log(`${r.id}: ${r.pass ? 'PASS' : 'FAIL'}`)
console.log(`\nResults: ${outDir}`)
