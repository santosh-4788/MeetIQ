// R2 recorder PoC — scenario runner.
//   node harness/run.mjs T01 T02 ...      (no args = T01..T07)
//   node harness/run.mjs T09 --rooms 3    (concurrency)
// Results: tests/r2-poc/results/<runId>/<test>.json and summary.md
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ROOT, FFMPEG_DIR, ensureLiveKit, startLiveKit, stopLiveKit, liveKitUp, joinParticipant, startRecorder, rooms, sleep, log,
  closeParticipantBrowser, startSampler, analyseMp4, playbackCheck, killRecorderBrowser,
} from './lib.mjs'

const P = (n) => Array.from({ length: n }, (_, i) => [0, 'join', i])

// at (s), action, args… · allowGap: seconds of media disruption tolerated around a deliberate fault
export const TESTS = {
  T01: { title: 'One-to-one meeting (with mute/unmute)', seconds: 180, actions: [...P(2), [60, 'mute', 1], [75, 'unmute', 1]] },
  T02: {
    title: 'Six participants, staggered join, leave and rejoin',
    seconds: 210,
    actions: [...[0, 1, 2, 3, 4, 5].map((i) => [i * 5, 'join', i]), [90, 'leave', 4], [95, 'leave', 5], [120, 'join', 4]],
  },
  T03: { title: 'Screen sharing start/stop', seconds: 180, actions: [...P(3), [40, 'screenOn', 1], [120, 'screenOff', 1]], screenShare: [40, 120] },
  T04: {
    title: 'Participant reconnection (resume, full reconnect, hard drop + rejoin)',
    seconds: 170,
    actions: [...P(3), [40, 'simulate', 0, 'resume-reconnect'], [70, 'simulate', 1, 'full-reconnect'], [100, 'drop', 2], [115, 'join', 2]],
  },
  T05: {
    title: 'Recorder network reconnection (signal + full reconnect)',
    seconds: 150,
    actions: [...P(2), [40, 'recSimulate', 'signal-reconnect'], [80, 'recSimulate', 'full-reconnect']],
    allowGap: 10,
  },
  T06: { title: 'Media server (SFU) outage and restart', seconds: 180, actions: [...P(2), [50, 'sfuDown'], [58, 'sfuUp']], allowGap: 40 },
  T07: { title: 'Recorder browser crash and recovery (new segment)', seconds: 160, actions: [...P(2), [60, 'killRecBrowser']], allowGap: 20 },
  T08: { title: 'Long run (30 min) with screen share', seconds: 1800, actions: [...P(2), [600, 'screenOn', 0], [900, 'screenOff', 0]], screenShare: [600, 900] },
  T09: { title: 'Concurrent recordings', seconds: 150, actions: P(2), concurrent: true },
}

// Pass thresholds (mandatory criteria; see documentation/R2_RECORDER_POC_REPORT.md §3)
const LIMITS = { minEncodedFps: 20, maxAvMedianMs: 80, maxAvP95Ms: 150, maxGapSeconds: 2.6, maxFreezeSeconds: 2.5 }

const args = process.argv.slice(2)
const roomsArg = args.includes('--rooms') ? +args[args.indexOf('--rooms') + 1] : 3
const selected = args.filter((a) => /^T\d\d$/.test(a))
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = path.join(ROOT, 'tests/r2-poc/results', runId)
fs.mkdirSync(outDir, { recursive: true })

async function runRoom(testId, t, roomIndex = 0) {
  const room = `${testId.toLowerCase()}-${roomIndex}-${Date.now().toString(36)}`
  await rooms.createRoom({ name: room, emptyTimeout: 120 })
  const people = []
  const timeline = []
  let rec = null
  const t0 = Date.now()
  const act = async ([, name, a, b]) => {
    timeline.push({ at: +((Date.now() - t0) / 1000).toFixed(1), action: name, a, b })
    switch (name) {
      case 'join': people[a] = await joinParticipant(room, a, a === 1 ? 'Customer Test' : `Employee ${a + 1}`); break
      case 'leave': await people[a].call('disconnect').catch(() => {}); await people[a].page.close(); break
      case 'drop': await people[a].page.close(); break // abrupt: no leave message (like a lost connection)
      case 'mute': await people[a].call('muteMic', true); break
      case 'unmute': await people[a].call('muteMic', false); break
      case 'screenOn': await people[a].call('startScreen'); break
      case 'screenOff': await people[a].call('stopScreen'); break
      case 'simulate': await people[a].call('simulate', b).catch((e) => timeline.push({ error: String(e) })); break
      case 'recSimulate': rec.command(`simulate ${a}`); break
      case 'sfuDown': await stopLiveKit(); break
      case 'sfuUp': startLiveKit(); for (let i = 0; i < 30 && !(await liveKitUp()); i++) await sleep(500); break
      case 'killRecBrowser': timeline.push({ killedProcesses: await killRecorderBrowser(rec.jobId) }); break
    }
  }
  const initial = t.actions.filter(([at]) => at === 0)
  for (const a of initial) await act(a)
  rec = startRecorder({ room, title: `${testId} ${t.title}` })
  if (!(await rec.waitStarted())) throw new Error(`${room}: recorder did not start`)
  const start = Date.now()
  for (const a of t.actions.filter(([at]) => at > 0).sort((x, y) => x[0] - y[0])) {
    await sleep(Math.max(0, a[0] * 1000 - (Date.now() - start)))
    await act(a)
  }
  await sleep(Math.max(0, t.seconds * 1000 - (Date.now() - start)))
  await rooms.deleteRoom(room).catch(() => {})
  const exitCode = await rec.waitExit(900_000)
  return { room, rec, exitCode, timeline, wallSeconds: (Date.now() - start) / 1000 }
}

function encodedFps(jobDir) {
  let frames = 0, span = 0
  for (const f of fs.readdirSync(jobDir).filter((x) => x.endsWith('.webm'))) {
    const pts = execFileSync(path.join(FFMPEG_DIR, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path.join(jobDir, f)])
      .toString().trim().split(/\r?\n/).filter(Boolean).map(Number)
    if (pts.length > 1) { frames += pts.length; span += pts.at(-1) - pts[0] }
  }
  return span ? +(frames / span).toFixed(1) : 0
}

async function evaluate(testId, t, r) {
  const result = r.rec.result()
  const out = { test: testId, title: t.title, room: r.room, exitCode: r.exitCode, wallSeconds: +r.wallSeconds.toFixed(1), timeline: r.timeline, recorder: result, checks: {} }
  const c = out.checks
  c.completedAndVerified = result?.status === 'COMPLETED' && result?.verification?.Passed === true
  if (result?.file && fs.existsSync(result.file)) {
    out.media = await analyseMp4(result.file)
    out.media.encodedFps = encodedFps(r.rec.jobDir)
    out.playback = await playbackCheck(result.file)
    const allow = t.allowGap ?? 0
    const share = t.screenShare
    const inShare = (s) => share && s >= share[0] - 3 && s <= share[1] + 3
    const gaps = out.media.flashGaps.filter((g) => !inShare(g.at))
    c.encodedFpsOk = out.media.encodedFps >= LIMITS.minEncodedFps
    c.avSyncOk = out.media.avPairs >= 5 && Math.abs(out.media.avOffsetMedianMs) <= LIMITS.maxAvMedianMs && out.media.avOffsetP95AbsMs <= LIMITS.maxAvP95Ms
    c.continuityOk = gaps.every((g) => g.seconds <= Math.max(LIMITS.maxGapSeconds, allow))
    c.noFreezes = out.media.freezes.every((f) => f <= Math.max(LIMITS.maxFreezeSeconds, allow))
    c.playbackOk = out.playback.ok === true
    c.durationWithinTolerance = result.verification.Failures.every((f) => !f.startsWith('Duration'))
  }
  out.pass = Object.values(c).length > 1 && Object.values(c).every(Boolean)
  return out
}

await ensureLiveKit()
const ids = selected.length ? selected : ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07']
const summary = []
for (const id of ids) {
  const t = TESTS[id]
  log(`=== ${id} ${t.title}`)
  const sampler = startSampler(outDir, id)
  let runs
  try {
    runs = t.concurrent
      ? await Promise.all(Array.from({ length: roomsArg }, (_, i) => runRoom(id, t, i)))
      : [await runRoom(id, t)]
  } catch (e) {
    log(`${id} aborted: ${e.message}`)
    summary.push({ test: id, title: t.title, pass: false, error: e.message })
    await sampler.stop().catch(() => {})
    await closeParticipantBrowser()
    continue
  }
  const resources = await sampler.stop()
  await closeParticipantBrowser()
  for (const r of runs) {
    const ev = await evaluate(id, t, r)
    ev.resources = resources
    ev.concurrentRooms = runs.length
    fs.writeFileSync(path.join(outDir, `${id}-${r.room}.json`), JSON.stringify(ev, null, 2))
    log(`${id} ${ev.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(ev.checks)} fps=${ev.media?.encodedFps} av=${ev.media?.avOffsetMedianMs}/${ev.media?.avOffsetP95AbsMs}ms`)
    summary.push({ test: id, title: t.title, room: r.room, pass: ev.pass, checks: ev.checks, encodedFps: ev.media?.encodedFps, avMedianMs: ev.media?.avOffsetMedianMs, avP95Ms: ev.media?.avOffsetP95AbsMs, restarts: ev.recorder?.Restarts, cpuRecorderCores: resources.roles['recorder-browser']?.cpuAvgCores, memRecorderPeakMB: resources.roles['recorder-browser']?.memPeakMB })
  }
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
const md = ['| Test | Result | Encoded fps | A/V median / p95 (ms) | Restarts | Recorder CPU (cores) | Recorder RAM peak (MB) |', '|---|---|---|---|---|---|---|',
  ...summary.map((s) => `| ${s.test} ${s.title} | ${s.pass ? 'PASS' : 'FAIL'}${s.error ? ` (${s.error})` : ''} | ${s.encodedFps ?? '-'} | ${s.avMedianMs ?? '-'} / ${s.avP95Ms ?? '-'} | ${s.restarts ?? '-'} | ${s.cpuRecorderCores ?? '-'} | ${s.memRecorderPeakMB ?? '-'} |`)]
fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n'))
console.log(md.join('\n'))
