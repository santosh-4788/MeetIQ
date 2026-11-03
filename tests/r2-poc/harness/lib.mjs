// Shared helpers for the R2 recorder proof-of-concept tests.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

const run = promisify(execFile)
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
export const RECORDER_EXE = process.env.OIC_RECORDER_EXE ?? path.join(ROOT, 'backend/src/OneInsure.Connect.Recorder/bin/Release/net10.0/OneInsure.Connect.Recorder.exe')
export const SPOOL = path.join(ROOT, 'recording/spool')
// Real FFmpeg binaries (the PATH entry on this PC is a Chocolatey shim, which hides FFmpeg's CPU usage).
export const FFMPEG_DIR = process.env.OIC_FFMPEG_DIR ?? 'C:/ffmpeg/ffmpeg-7.1.1-essentials_build/bin'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---- LiveKit ---------------------------------------------------------------
export function loadEnv() {
  const file = path.join(ROOT, 'video-server/config/dev.local.env')
  const env = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}
export const ENV = loadEnv()
export const rooms = new RoomServiceClient(ENV.LIVEKIT_URL.replace('ws://', 'http://'), ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET)

export async function participantToken(room, identity, name) {
  const at = new AccessToken(ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET, { identity, name, ttl: '2h' })
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true })
  return at.toJwt()
}

export async function liveKitUp() {
  try {
    const r = await fetch(ENV.LIVEKIT_URL.replace('ws://', 'http://'))
    return r.ok
  } catch {
    return false
  }
}

export async function stopLiveKit() {
  await run('powershell', ['-NoProfile', '-Command', 'Get-Process livekit-server -ErrorAction SilentlyContinue | Stop-Process -Force']).catch(() => {})
}

export function startLiveKit() {
  const p = spawn(path.join(ROOT, 'video-server/bin/livekit-server.exe'), ['--config', path.join(ROOT, 'video-server/config/livekit.dev.yaml')], {
    env: { ...process.env, LIVEKIT_KEYS: ENV.LIVEKIT_KEYS },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  p.unref()
}

export async function ensureLiveKit() {
  if (await liveKitUp()) return
  startLiveKit()
  for (let i = 0; i < 30 && !(await liveKitUp()); i++) await sleep(500)
}

// ---- Synthetic participants -------------------------------------------------
const COLORS = ['#1F4A73', '#0E6E7E', '#5B21B6', '#9A3412', '#166534', '#9D174D', '#1E3A8A', '#854D0E']
let browser = null

/** One headless Edge instance (profile marked "oic-part-") hosts every synthetic participant. */
export async function participantBrowser() {
  if (browser) return browser
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oic-part-'))
  browser = await chromium.launchPersistentContext(dir, {
    executablePath: EDGE,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  // Chromium Local Network Access: an intercepted origin is treated as public, so it must be
  // explicitly allowed to reach the loopback/private LiveKit address.
  await browser.grantPermissions(['local-network-access'], { origin: 'http://127.0.0.1:7998' })
  await browser.route('http://127.0.0.1:7998/**', async (route) => {
    const rel = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    const f = path.join(ROOT, 'tests/r2-poc/participant/dist', rel)
    if (!fs.existsSync(f)) return route.fulfill({ status: 404 })
    const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'
    return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(f) })
  })
  return browser
}

export async function closeParticipantBrowser() {
  if (browser) await browser.close().catch(() => {})
  browser = null
}

export async function joinParticipant(room, index, name = `Participant ${index + 1}`) {
  const ctx = await participantBrowser()
  const page = await ctx.newPage()
  const identity = `p${index + 1}-${room}`
  const token = await participantToken(room, identity, name)
  const cfg = { url: ENV.LIVEKIT_URL, token, name, color: COLORS[index % COLORS.length], beepHz: 440 + index * 110 }
  await page.addInitScript((c) => {
    window.__P__ = c
    // Record the ICE servers the SFU hands to clients (must not include third-party STUN/TURN in production).
    const Orig = window.RTCPeerConnection
    window.__iceServers = []
    window.RTCPeerConnection = function (config, ...rest) {
      window.__iceServers.push(JSON.parse(JSON.stringify(config?.iceServers ?? [])))
      const pc = new Orig(config, ...rest)
      ;(window.__pcs ??= []).push(pc)
      return pc
    }
    window.RTCPeerConnection.prototype = Orig.prototype
  }, cfg)
  await page.goto('http://127.0.0.1:7998/index.html')
  await page.evaluate(() => window.p.connect())
  const transport = () => page.evaluate(async () => {
    const out = []
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === 'closed') continue
      const st = await pc.getStats()
      const byId = new Map([...st.values()].map((x) => [x.id, x]))
      for (const x of st.values()) {
        if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') {
          const l = byId.get(x.localCandidateId), r = byId.get(x.remoteCandidateId)
          out.push({ local: `${l?.candidateType}/${l?.protocol}`, remote: `${r?.address}:${r?.port}/${r?.protocol}`, rttMs: Math.round((x.currentRoundTripTime ?? 0) * 1000), availOutKbps: Math.round((x.availableOutgoingBitrate ?? 0) / 1000) })
        }
        if (x.type === 'remote-inbound-rtp' && x.kind === 'video') out.push({ remoteInboundVideo: { lossFrac: x.fractionLost, jitter: x.jitter, rttMs: Math.round((x.roundTripTime ?? 0) * 1000) } })
      }
    }
    return out
  })
  return { page, identity, name, transport, call: (fn, ...args) => page.evaluate(([f, a]) => window.p[f](...a), [fn, args]) }
}

// ---- Recorder -----------------------------------------------------------------
export function startRecorder({ room, title = room, kind = 'internal', consent = 'granted', jobId, env = {}, maxMinutes = 60 }) {
  jobId ??= `${room}-${Date.now().toString(36)}`
  const proc = spawn(RECORDER_EXE, ['record', '--room', room, '--title', title, '--kind', kind, '--consent', consent, '--job-id', jobId, '--max-minutes', String(maxMinutes)], {
    env: { ...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT ?? path.join(os.homedir(), '.dotnet'), LIVEKIT_URL: ENV.LIVEKIT_URL, LIVEKIT_API_KEY: ENV.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: ENV.LIVEKIT_API_SECRET,
      OIC_Recorder__Ffmpeg__FfmpegPath: path.join(FFMPEG_DIR, 'ffmpeg.exe'), OIC_Recorder__Ffmpeg__FfprobePath: path.join(FFMPEG_DIR, 'ffprobe.exe'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = []
  let started
  const startedP = new Promise((r) => (started = r))
  const onData = (buf) => {
    for (const l of buf.toString().split(/\r?\n/).filter(Boolean)) {
      lines.push(l)
      if (l.includes('"attempt_started"')) started(true)
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  const exited = new Promise((r) => proc.on('exit', (code) => { started(false); r(code) }))
  const jobDir = path.join(SPOOL, jobId)
  return {
    jobId,
    jobDir,
    proc,
    lines,
    waitStarted: (ms = 60_000) => Promise.race([startedP, sleep(ms).then(() => false)]),
    waitExit: (ms = 300_000) => Promise.race([exited, sleep(ms).then(() => 'timeout')]),
    command: (c) => proc.stdin.write(`${c}\n`),
    result: () => {
      const f = path.join(jobDir, 'result.json')
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
    },
    events: () => {
      const f = path.join(jobDir, 'events.log')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []
    },
  }
}

/** Hard-kills every browser process belonging to a recorder job (simulates a renderer/browser crash). */
export async function killRecorderBrowser(jobId) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*oic-rec-${jobId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps])
  return stdout.split(/\r?\n/).filter(Boolean).length
}

/** Listening sockets owned by recorder-related processes (should be none). */
export async function recorderListeningPorts() {
  const ps = `$ids = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'OneInsure.Connect.Recorder.exe' -or $_.CommandLine -like '*oic-rec-*' } | ForEach-Object { $_.ProcessId }); netstat -ano | Select-String 'LISTENING' | Where-Object { $ids -contains [int](($_ -split '\\s+')[-1]) } | ForEach-Object { $_.Line.Trim() }`
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps])
  return stdout.split(/\r?\n/).filter(Boolean)
}

// ---- Resource sampling -----------------------------------------------------------
export function startSampler(outDir, name) {
  const csv = path.join(outDir, `${name}.resources.csv`)
  const stop = path.join(outDir, `${name}.stop`)
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tests/r2-poc/harness/sample.ps1'), '-OutFile', csv, '-StopFile', stop, '-IntervalMs', '2000'], { stdio: 'ignore', windowsHide: true })
  const done = new Promise((r) => p.on('exit', r))
  return {
    stop: async () => {
      fs.writeFileSync(stop, '')
      await Promise.race([done, sleep(10_000)])
      fs.rmSync(stop, { force: true })
      return summariseResources(csv)
    },
  }
}

export function summariseResources(csv) {
  const cores = os.cpus().length
  const rows = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => {
    const [ts, role, pid, cpu, ws, priv] = l.split(',')
    return { ts: +ts, role, pid: +pid, cpu: +cpu, ws: +ws, priv: +priv }
  })
  const byTs = new Map()
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, [])
    byTs.get(r.ts).push(r)
  }
  const times = [...byTs.keys()].sort((a, b) => a - b)
  const roles = [...new Set(rows.map((r) => r.role))]
  const out = {}
  for (const role of roles) {
    const cpuPct = [], mem = []
    for (let i = 1; i < times.length; i++) {
      const prev = new Map(byTs.get(times[i - 1]).filter((r) => r.role === role).map((r) => [r.pid, r.cpu]))
      const cur = byTs.get(times[i]).filter((r) => r.role === role)
      const dt = (times[i] - times[i - 1]) / 1000
      let cpu = 0
      for (const r of cur) if (prev.has(r.pid)) cpu += Math.max(0, r.cpu - prev.get(r.pid))
      cpuPct.push((cpu / dt / cores) * 100)
      mem.push(cur.reduce((s, r) => s + r.ws, 0))
    }
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
    const sorted = [...cpuPct].sort((a, b) => a - b)
    out[role] = {
      cpuAvgPctOfMachine: +avg(cpuPct).toFixed(1),
      cpuP95PctOfMachine: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1),
      cpuAvgCores: +((avg(cpuPct) / 100) * cores).toFixed(2),
      memAvgMB: +avg(mem).toFixed(0),
      memPeakMB: +Math.max(0, ...mem).toFixed(0),
      memFirstMB: +(mem[0] ?? 0).toFixed(0),
      memLastMB: +(mem.at(-1) ?? 0).toFixed(0),
      samples: cpuPct.length,
    }
  }
  return { logicalCores: cores, roles: out }
}

// ---- MP4 analysis ------------------------------------------------------------------
async function ff(args) {
  const { stderr } = await run(path.join(FFMPEG_DIR, 'ffmpeg.exe'), ['-hide_banner', '-nostdin', ...args], { maxBuffer: 256 * 1024 * 1024 })
  return stderr
}

/**
 * Objective media checks on the final MP4:
 *  - flash onsets (whole-frame luminance spikes) vs beep onsets (end of silence) → A/V offset
 *  - continuity: gaps between consecutive flashes (expected every 2 s)
 *  - freezes (no visual change for ≥2 s)
 */
export async function analyseMp4(file, { expectFlashes = true } = {}) {
  const vlog = await ff(['-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-an', '-f', 'null', '-'])
  const frames = []
  let t = null
  for (const l of vlog.split(/\r?\n/)) {
    const m1 = l.match(/pts_time:([\d.]+)/)
    if (m1) t = +m1[1]
    const m2 = l.match(/lavfi\.signalstats\.YAVG=([\d.]+)/)
    if (m2 && t !== null) frames.push({ t, y: +m2[1] })
  }
  const ys = frames.map((f) => f.y).sort((a, b) => a - b)
  const median = ys[Math.floor(ys.length / 2)] ?? 0
  const flashes = []
  let inFlash = false
  for (const f of frames) {
    const hi = f.y > median + 22
    if (hi && !inFlash) flashes.push(f.t)
    inFlash = hi
  }

  const alog = await ff(['-i', file, '-af', 'silencedetect=noise=-30dB:d=0.3', '-vn', '-f', 'null', '-'])
  const beeps = [...alog.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1])

  const flog = await ff(['-i', file, '-vf', 'freezedetect=n=-50dB:d=2', '-an', '-f', 'null', '-'])
  const freezes = [...flog.matchAll(/freeze_duration: ([\d.]+)/g)].map((m) => +m[1])

  const offsets = []
  for (const v of flashes) {
    let best = null
    for (const a of beeps) if (best === null || Math.abs(a - v) < Math.abs(best - v)) best = a
    if (best !== null && Math.abs(best - v) < 0.6) offsets.push(+((v - best) * 1000).toFixed(0))
  }
  const sortedAbs = offsets.map(Math.abs).sort((a, b) => a - b)
  const sorted = [...offsets].sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < flashes.length; i++) {
    const d = flashes[i] - flashes[i - 1]
    if (d > 2.6) gaps.push({ at: +flashes[i - 1].toFixed(1), seconds: +d.toFixed(2) })
  }
  const duration = frames.at(-1)?.t ?? 0
  return {
    durationSeconds: +duration.toFixed(2),
    frames: frames.length,
    effectiveFps: duration ? +(frames.length / duration).toFixed(2) : 0,
    flashes: flashes.length,
    expectedFlashes: Math.floor(duration / 2),
    beeps: beeps.length,
    avPairs: offsets.length,
    avOffsetMedianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
    avOffsetP95AbsMs: sortedAbs[Math.floor(sortedAbs.length * 0.95)] ?? null,
    avOffsetMaxAbsMs: sortedAbs.at(-1) ?? null,
    flashGaps: gaps,
    freezes,
    expectFlashes,
  }
}

/** Plays the MP4 in headless Edge (H.264/AAC path used by Chrome/Edge clients). */
export async function playbackCheck(file) {
  const b = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
  try {
    const page = await b.newPage()
    await page.route('http://127.0.0.1:7997/**', (route) => {
      const u = new URL(route.request().url())
      // Byte ranges are required: without 206 responses Chromium treats the media as non-seekable and
      // every seek silently lands at 0 (the production API must serve recordings with range support too).
      if (u.pathname === '/v.mp4') {
        const data = fs.readFileSync(file)
        const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()['range'] ?? '')
        if (!m) return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: data })
        const start = m[1] ? +m[1] : data.length - +m[2]
        const end = m[1] && m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1
        return route.fulfill({
          status: 206, contentType: 'video/mp4',
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}` },
          body: data.subarray(start, end + 1),
        })
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<video id="v" muted playsinline src="/v.mp4"></video>' })
    })
    await page.goto('http://127.0.0.1:7997/')
    return await page.evaluate(async () => {
      const v = document.getElementById('v')
      const once = (ev, ms = 15000) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms)
        v.addEventListener(ev, () => (clearTimeout(t), res()), { once: true })
        v.addEventListener('error', () => (clearTimeout(t), rej(new Error(`media error ${v.error?.code}`))), { once: true })
      })
      try {
        if (v.readyState < 1) await once('loadedmetadata')
        const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight }
        const target = v.duration / 2
        v.currentTime = target
        await once('seeked')
        if (Math.abs(v.currentTime - target) > 2) throw new Error(`seek landed at ${v.currentTime.toFixed(2)}s, expected ${target.toFixed(2)}s`)
        await v.play()
        const t0 = v.currentTime
        await new Promise((r) => setTimeout(r, 2000))
        const advanced = v.currentTime - t0
        v.currentTime = Math.max(0, v.duration - 1)
        await once('ended', 10000)
        return { ok: true, ...meta, playedSecondsIn2s: +advanced.toFixed(2), reachedEnd: true }
      } catch (e) {
        return { ok: false, error: String(e), mediaError: v.error?.code ?? null }
      }
    })
  } finally {
    await b.close()
  }
}
