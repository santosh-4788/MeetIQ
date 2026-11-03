// Phase 5 — recording management, end to end on localhost in Microsoft Edge (headless, fake camera/microphone) with the REAL R2 recorder.
//
// Isolated environment (never the developer instance on 7180/5173/5080):
//   database  OneInsureVideoMeetingDB_Rec on (localdb)\MSSQLLocalDB          (scripts/setup-rec-db.ps1)
//   API       https://localhost:7192 (recorder worker in-process, R2 recorder as a separate process)   (scripts/start-rec-api.ps1)
//   web       Vite dev server http://127.0.0.1:5176 proxying /api to 7192 (OIC_API_TARGET)
//   LiveKit   the running local dev server ws://127.0.0.1:7880 (not restarted; no webhooks needed)
//
// Run:  cd "E:\OneInsure Connect\tests\e2e"; node recording\recording.mjs
//
// Proves: an administrator configures the training & team policy through the admin API (placeholder wording stays flagged as not
// confirmed); host and employee join from the UI; both get the policy notice and accept it (append-only consent rows with evidence
// hash); the host starts recording; the REC indicator appears for both; the real R2 recorder (headless Edge + FFmpeg) records; the host
// stops; the API verifies the file again in the library (codecs, duration, full decode, faststart, SHA-256) and only then marks it
// COMPLETED; playback in Edge through a short-lived signed URL with seeking (HTTP ranges); download allowed/denied by policy role;
// a non-owner gets 404; every access is in rec.RecordingAccessLog; owner notification + meeting page + dashboard reflect it.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RESULTS = path.join(HERE, 'results')
const SHOTS = path.join(RESULTS, 'screenshots')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const DB = process.env.REC_DB ?? 'OneInsureVideoMeetingDB_Rec'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const FFPROBE = path.join(process.env.OIC_FFMPEG_DIR ?? 'C:/ffmpeg/ffmpeg-7.1.1-essentials_build/bin', 'ffprobe.exe')
const LIBRARY = path.join(ROOT, 'recording/e2e/library')
const HEADLESS = process.env.E2E_HEADED !== '1'
const RECORD_SECONDS = +(process.env.REC_SECONDS ?? 30)
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only (scripts/setup-rec-db.ps1)
const SUPER = 'superadmin@rec.oneinsure.test'
const HOST = { email: 'rekha.host@rec.oneinsure.test', name: 'Rekha Host' }
const EMP = { email: 'ravi.employee@rec.oneinsure.test', name: 'Ravi Employee' }

if (!/_Rec$/.test(DB)) throw new Error('Only a database whose name ends in _Rec may be used.')
if (/:7180|:5173/.test(WEB)) throw new Error('Never run against the developer instance (7180/5173).')
fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function sql(select) {
  const out = execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-y', '0', '-Q',
    `SET NOCOUNT ON; SELECT (SELECT * FROM (${select.replace(/\s*\r?\n\s*/g, ' ')}) q FOR JSON PATH, INCLUDE_NULL_VALUES) AS j`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const lines = out.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('[') || l.trim() === 'NULL')
  const json = start < 0 ? '' : lines.slice(start).join('').trim()
  return !json || json === 'NULL' ? [] : JSON.parse(json)
}
const scalar = (select) => Object.values(sql(select)[0] ?? { v: null })[0]

class Api {
  jar = new Map()
  async req(method, p, body, raw = false) {
    const headers = { Accept: 'application/json' }
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET' && this.jar.has('XSRF-TOKEN')) headers['X-XSRF-TOKEN'] = decodeURIComponent(this.jar.get('XSRF-TOKEN'))
    const r = await fetch(p.startsWith('/api/') ? `${WEB}${p}` : `${WEB}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(';')[0]
      const i = kv.indexOf('=')
      this.jar.set(kv.slice(0, i), kv.slice(i + 1))
    }
    if (raw) return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) }
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { status: r.status, data }
  }
  async login(email) {
    await this.req('GET', '/health')
    const r = await this.req('POST', '/auth/login', { login: email, password: PASSWORD, rememberMe: false })
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.data)}`)
    return this
  }
}

const results = []
const pages = []
async function tc(id, title, expected, fn) {
  const t0 = Date.now()
  log(`▶ ${id} ${title}`)
  try {
    const actual = await fn()
    results.push({ id, title, expected, actual: actual ?? 'as expected', result: 'PASS', ms: Date.now() - t0 })
    log(`  PASS ${id}: ${actual ?? ''}`)
    return true
  } catch (e) {
    const shots = []
    for (const [i, p] of pages.entries()) {
      try {
        const f = path.join(SHOTS, `${id}-${i}.png`)
        await p.screenshot({ path: f })
        shots.push(path.relative(HERE, f))
      } catch { /* closed */ }
    }
    results.push({ id, title, expected, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL', screenshots: shots, ms: Date.now() - t0 })
    log(`  FAIL ${id}: ${e?.message ?? e}`)
    return false
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
async function until(fn, msg, ms = 20_000, every = 500) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}
const view = (page, name) => page.screenshot({ path: path.join(SHOTS, `view-${name}.png`) }).catch(() => {})

// Fake camera: a small generated Y4M clip (see tests/e2e/room/room.mjs for why).
const CAM = path.join(RESULTS, 'fake-camera.y4m')
if (!fs.existsSync(CAM)) {
  const W = 320, H = 240, F = 40
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < F; f++) {
    const y = Buffer.alloc(W * H), u = Buffer.alloc(W * H / 4, 110), v = Buffer.alloc(W * H / 4, 150)
    const bar = Math.floor((f * W) / F)
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) y[r * W + c] = Math.abs(c - bar) < 12 ? 235 : 60 + (((r >> 4) + (c >> 4)) % 2) * 40
    parts.push(Buffer.from('FRAME\n'), y, u, v)
  }
  fs.writeFileSync(CAM, Buffer.concat(parts))
}
const browsers = []
async function newPage() {
  const browser = await chromium.launch({
    executablePath: EDGE, headless: HEADLESS,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  browsers.push(browser)
  const context = await browser.newContext({ baseURL: WEB, viewport: { width: 1366, height: 820 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => log(`  [pageerror ${pages.indexOf(page)}] ${e.message}`))
  pages.push(page)
  return page
}

async function loginUI(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}

async function preJoinAndEnter(page, buttonName) {
  await page.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await until(() => page.evaluate(() => (document.querySelector('[data-testid="prejoin-preview"]')?.videoWidth ?? 0) > 0), 'camera preview never started', 15_000)
  await page.getByRole('button', { name: buttonName }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}

// ---- Scenario ----------------------------------------------------------------------------------------------------------
execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q',
  "UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE') AND Title LIKE N'Recording E2E%'"])
const superApi = await new Api().login(SUPER)
const hostApi = await new Api().login(HOST.email)
const empApi = await new Api().login(EMP.email)
const ok = {}
let meetingId, m, recId, rec

ok.admin = await tc('REC-01', 'Administrator configures the training & team recording policy', 'Admin API saves the policy (audited); placeholder wording keeps it "not confirmed"; recorder health is green', async () => {
  const list = (await superApi.req('GET', '/admin/recording-policies')).data
  const p = list.items.find((x) => x.code === 'TRAINING_TEAM_MEETING')
  check(p && !p.confirmed && p.hasPlaceholders, `unexpected shipped policy ${JSON.stringify(p)}`)
  const body = { ...p, isEnabled: true, requirement: 'OPTIONAL', consentMode: 'CONSENT_REQUIRED', consentFromAll: true, stopOnWithdrawal: true,
    playbackRoles: ['SuperAdmin'], downloadRoles: ['SuperAdmin'], ownerCanPlay: true, ownerCanDownload: false }
  const r = await superApi.req('PUT', '/admin/recording-policies/TRAINING_TEAM_MEETING', body)
  check(r.status === 200, `PUT ${r.status} ${JSON.stringify(r.data)}`)
  check(!r.data.confirmed && r.data.pending.length > 0, 'policy must stay not confirmed')
  const audit = scalar("SELECT COUNT(*) AS v FROM app.AuditLog WHERE [Action] = 'RECORDING_POLICY_UPDATED' AND IsPrivileged = 1 AND OldValuesJson IS NOT NULL")
  check(audit >= 1, 'no audit row')
  const h = (await superApi.req('GET', '/admin/recording/health')).data
  check(h.available, `recorder not available: ${JSON.stringify(h.items.filter((i) => !i.ok))}`)
  return `saved (audit rows ${audit}); pending items: ${r.data.pending.length}; health: ${h.items.map((i) => i.name.split(' (')[0]).join(', ')} all OK`
})

const host = await newPage()
const emp = await newPage()

ok.adminUi = await tc('REC-02', 'Admin panel shows the recording policies with the "Not confirmed" banner', 'Administration page lists four policies, banner visible, recorder status card', async () => {
  const admin = await newPage()
  await loginUI(admin, SUPER)
  await admin.goto('/admin')
  await admin.getByTestId('recording-policies').waitFor({ timeout: 20_000 })
  const banners = await admin.getByText('Not confirmed — values pending internal confirmation').count()
  check(banners === 4, `expected 4 banners, saw ${banners}`)
  await admin.getByTestId('recorder-health').waitFor({ timeout: 20_000 })
  await admin.getByTestId('policy-TRAINING_TEAM_MEETING').scrollIntoViewIfNeeded()
  await view(admin, 'admin-recording-policies')
  await admin.getByRole('button', { name: 'Edit Training & team meetings' }).click()
  await admin.getByTestId('policy-dialog').waitFor()
  await view(admin, 'admin-policy-dialog')
  await admin.context().browser().close()
  pages.splice(pages.indexOf(admin), 1)
  return `${banners} "Not confirmed" banners, edit dialog opens`
})

ok.join = await tc('REC-03', 'Host and employee join a team meeting from the UI', 'Both are in the room; meeting LIVE', async () => {
  const empId = scalar("SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RC-0002'")
  const start = new Date(Date.now() + 2 * 60_000)
  start.setSeconds(0, 0)
  const created = await hostApi.req('POST', '/meetings', {
    title: `Recording E2E ${new Date().toISOString().slice(11, 16)}`, category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 60 * 60_000).toISOString(),
    employeeIds: [empId], status: 'SCHEDULED', recordingPolicy: 'OPTIONAL', waitingRoomEnabled: false,
  })
  check(created.status === 201, `meeting not created: ${created.status} ${JSON.stringify(created.data)}`)
  meetingId = created.data.id
  m = sql(`SELECT MeetingId, LiveKitRoomName FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)[0]
  await loginUI(host, HOST.email)
  await host.goto(`/meetings/${meetingId}/room`)
  await preJoinAndEnter(host, 'Start meeting')
  await loginUI(emp, EMP.email)
  await emp.goto(`/meetings/${meetingId}/room`)
  await preJoinAndEnter(emp, 'Join now')
  await until(() => scalar(`SELECT [Status] AS v FROM mtg.Meetings WHERE MeetingId = ${m.MeetingId}`) === 'LIVE', 'meeting not LIVE')
  return `meeting ${meetingId}, room ${m.LiveKitRoomName}`
})

ok.consent = ok.join && await tc('REC-04', 'Both participants see the policy notice and accept it', 'Notice dialog with the configured wording (flagged as not confirmed); Accept → append-only consent rows with IP, user agent and evidence hash', async () => {
  for (const p of [emp, host]) {
    await p.getByTestId('rec-notice-text').waitFor({ timeout: 25_000 })
    const text = await p.getByTestId('rec-notice-text').innerText()
    check(text.includes('[PLACEHOLDER'), `unexpected notice text: ${text}`)
    check(await p.getByText('Wording not confirmed').count() === 1, 'placeholder warning missing')
  }
  await view(emp, 'consent-notice-employee')
  await emp.getByTestId('rec-accept').click()
  await host.getByTestId('rec-accept').click()
  const rows = await until(() => {
    const n = Number(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingConsent WHERE MeetingId = ${m.MeetingId} AND Decision = 'GRANTED' AND EvidenceHash IS NOT NULL AND UserAgent IS NOT NULL AND IpAddress IS NOT NULL`))
    return n >= 2 && n
  }, 'consent rows not written')
  return `${rows} GRANTED rows (notice version PLACEHOLDER-0) with evidence hash`
})

ok.start = ok.consent && await tc('REC-05', 'Host starts recording; the R2 recorder joins; REC shown to everyone', 'Start dialog → recording PENDING → RECORDING; REC indicator on host and employee; recorder process running', async () => {
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-start-confirm').click()
  await until(() => scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${m.MeetingId}`) > 0, 'no recording row')
  recId = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${m.MeetingId} ORDER BY RecordingId DESC`)
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'RECORDING', 'recording never reached RECORDING', 120_000, 1000)
  for (const p of [host, emp])
    await until(() => p.evaluate(() => document.querySelector('[data-testid="rec-indicator"]')?.getAttribute('data-status') === 'RECORDING'), 'REC indicator not shown', 30_000)
  await view(emp, 'rec-indicator-employee')
  await view(host, 'rec-indicator-host')
  const procs = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process OneInsure.Connect.Recorder -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' }).trim()
  return `recording ${recId} RECORDING; REC visible to both; recorder processes: ${procs}`
})

ok.stop = ok.start && await tc('REC-06', `Record ~${RECORD_SECONDS}s, host stops; COMPLETED only after verification`, 'PROCESSING/VERIFYING → COMPLETED; MP4 in the library under an opaque key; SHA-256, codecs, duration verified', async () => {
  await sleep(RECORD_SECONDS * 1000)
  await host.getByTestId('ctl-record').click()
  const seen = new Set()
  await until(() => {
    const s = scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)
    seen.add(s)
    if (s === 'FAILED') throw new Error(`FAILED: ${scalar(`SELECT FailureReason AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)}`)
    return s === 'COMPLETED'
  }, 'recording not COMPLETED', 240_000, 1000)
  rec = sql(`SELECT [Status], StorageKey, CONVERT(VARCHAR(64), Sha256, 2) AS Sha, FileSizeBytes, DurationSeconds, VideoCodec, AudioCodec, Width, Height, VerifiedUtc, VerificationDetails,
             DATEDIFF(SECOND, StartedUtc, EndedUtc) AS WallSeconds FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`)[0]
  check(/^\d{4}\/\d{2}\/[0-9a-f]{32}\.mp4$/.test(rec.StorageKey), `storage key not opaque: ${rec.StorageKey}`)
  const file = path.join(LIBRARY, rec.StorageKey)
  check(fs.existsSync(file), `file missing: ${file}`)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  check(sha === rec.Sha.toLowerCase(), `sha mismatch ${sha} vs ${rec.Sha}`)
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }))
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio')
  check(v.codec_name === 'h264' && a.codec_name === 'aac' && v.width === 1280 && v.height === 720, 'unexpected streams')
  const details = JSON.parse(rec.VerificationDetails)
  await until(() => host.evaluate(() => !document.querySelector('[data-testid="rec-indicator"]')), 'REC indicator still shown after stop', 20_000)
  return `states seen ${[...seen].join('→')}; file ${file} (${(rec.FileSizeBytes / 1048576).toFixed(1)} MB, ${Number(probe.format.duration).toFixed(1)} s, recorded wall time ${details.ExpectedSeconds?.toFixed?.(1)} s, recording span ${rec.WallSeconds} s), sha256 ${sha.slice(0, 16)}…, h264/aac 1280x720, faststart ${details.FastStart}, decode errors ${details.DecodeErrors}`
})

ok.play = ok.stop && await tc('REC-07', 'Owner plays the recording in Edge through a signed URL and seeks', 'Detail page → Play → metadata, seek to the middle lands there, playback advances (HTTP 206 range requests)', async () => {
  await host.goto(`/recordings/${recId}`)
  await host.getByTestId('recording-detail').waitFor({ timeout: 20_000 })
  check((await host.getByTestId('sha256').innerText()).toLowerCase() === rec.Sha.toLowerCase(), 'checksum not shown')
  check(await host.getByTestId('download').count() === 0, 'download button shown to the owner although the policy forbids it')
  const ranges = []
  host.on('response', (r) => { if (r.url().includes('/recordings/media/')) ranges.push(r.status()) })
  await host.getByTestId('play').click()
  await host.getByTestId('recording-player').waitFor()
  const res = await host.evaluate(async () => {
    const v = document.querySelector('[data-testid="recording-player"]')
    v.muted = true
    const once = (ev, ms = 20000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), ms)
      v.addEventListener(ev, () => (clearTimeout(t), res()), { once: true })
    })
    if (v.readyState < 1) await once('loadedmetadata')
    const duration = v.duration
    const target = duration / 2
    v.currentTime = target
    await once('seeked')
    const landed = v.currentTime
    await v.play()
    const t0 = v.currentTime
    await new Promise((r) => setTimeout(r, 2500))
    return { duration, target, landed, advanced: v.currentTime - t0, w: v.videoWidth, h: v.videoHeight }
  })
  check(Math.abs(res.landed - res.target) < 2, `seek landed at ${res.landed}`)
  check(res.advanced > 1, `playback did not advance (${res.advanced})`)
  await view(host, 'recording-detail-playing')
  check(ranges.includes(206), `no 206 range responses (${ranges.join(',')})`)
  return `duration ${res.duration.toFixed(1)} s, ${res.w}x${res.h}, seek → ${res.landed.toFixed(1)} s, advanced ${res.advanced.toFixed(1)} s; media responses ${[...new Set(ranges)].join('/')}`
})

ok.download = ok.stop && await tc('REC-08', 'Download allowed / denied by policy role; non-owner gets 404', 'Owner: 403 (policy: owner download off); SuperAdmin (download role): 200 attachment with the exact bytes; employee participant: 404; link of another user: 403', async () => {
  const denied = await hostApi.req('POST', `/recordings/${recId}/download`)
  check(denied.status === 403, `owner download ${denied.status}`)
  const link = await superApi.req('POST', `/recordings/${recId}/download`)
  check(link.status === 200, `superadmin download link ${link.status}`)
  const file = await superApi.req('GET', link.data.url, undefined, true)
  check(file.status === 200 && file.bytes.length === Number(rec.FileSizeBytes), `download ${file.status} ${file.bytes.length} bytes`)
  const disposition = file.headers.get('content-disposition')
  check(/attachment/.test(disposition), `no attachment disposition: ${disposition}`)
  const sha = crypto.createHash('sha256').update(file.bytes).digest('hex')
  check(sha === rec.Sha.toLowerCase(), 'downloaded bytes differ')
  const foreign = await hostApi.req('GET', link.data.url, undefined, true)
  check(foreign.status === 403, `another user's link answered ${foreign.status}`)
  const hidden = await empApi.req('GET', `/recordings/${recId}`)
  check(hidden.status === 404, `employee detail ${hidden.status}`)
  const list = (await empApi.req('GET', '/recordings')).data
  check(list.total === 0, 'employee library not empty')
  return `owner 403, superadmin 200 (${file.bytes.length} bytes, ${disposition}), foreign link 403, employee 404 + empty library`
})

ok.audit = ok.download && await tc('REC-09', 'Every access is in rec.RecordingAccessLog; auditors see it in the UI', 'VIEW_DETAILS, PLAY, DOWNLOAD and DENIED rows; access history table on the detail page for the SuperAdmin (playback role)', async () => {
  const rows = sql(`SELECT l.[Action], u.Email, COUNT(*) AS N FROM rec.RecordingAccessLog l JOIN auth.Users u ON u.UserId = l.UserId JOIN rec.MeetingRecordings r ON r.RecordingId = l.RecordingId
                    WHERE r.PublicId = '${recId}' GROUP BY l.[Action], u.Email`)
  const has = (a, e) => rows.some((x) => x.Action === a && x.Email === e)
  check(has('VIEW_DETAILS', HOST.email) && has('PLAY', HOST.email) && has('DENIED', HOST.email) && has('DOWNLOAD', SUPER) && has('DENIED', EMP.email), `rows ${JSON.stringify(rows)}`)
  const admin = await newPage()
  await loginUI(admin, SUPER)
  await admin.goto(`/recordings/${recId}`)
  await admin.getByTestId('access-history').waitFor({ timeout: 20_000 })
  const entries = await admin.getByTestId('access-history').locator('tbody tr').count()
  await view(admin, 'access-history')
  await admin.goto('/recordings')
  await admin.getByTestId('recordings-table').waitFor()
  await view(admin, 'recording-library')
  return `${rows.map((x) => `${x.Action}×${x.N} (${x.Email.split('@')[0]})`).join(', ')}; ${entries} rows in the UI history`
})

ok.kpi = ok.stop && await tc('REC-10', 'Owner notification, meeting page and dashboard reflect the recording', 'RECORDING_AVAILABLE notification + e-mail queued; meeting detail lists the recording; dashboard counts it', async () => {
  const n = scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = '${HOST.email}' AND n.[Type] = 'RECORDING_AVAILABLE'`)
  const mail = scalar(`SELECT COUNT(*) AS v FROM app.EmailOutbox WHERE Template = 'RECORDING_AVAILABLE' AND ToAddress = '${HOST.email}'`)
  check(n >= 1 && mail >= 1, `notifications ${n}, mails ${mail}`)
  const dash = (await hostApi.req('GET', '/dashboard/summary')).data
  check(dash.kpis.totalRecordings >= 1 && dash.recordingStatus.completed >= 1, `dashboard ${JSON.stringify(dash.kpis)}`)
  await host.goto(`/meetings/${meetingId}`)
  await host.getByTestId('meeting-recordings').waitFor({ timeout: 20_000 })
  await view(host, 'meeting-detail-recordings')
  return `notification ${n}, e-mail ${mail}, dashboard totalRecordings ${dash.kpis.totalRecordings}`
})

// Leave everything tidy: end the meeting.
await hostApi.req('POST', `/meetings/${meetingId}/room/end`).catch(() => {})
for (const b of browsers) await b.close().catch(() => {})

const summary = { atUtc: new Date().toISOString(), web: WEB, database: DB, recording: recId, file: rec ? path.join(LIBRARY, rec.StorageKey) : null,
  passed: results.filter((r) => r.result === 'PASS').length, failed: results.filter((r) => r.result === 'FAIL').length, results }
fs.writeFileSync(path.join(RESULTS, 'recording-results.json'), JSON.stringify(summary, null, 2))
fs.writeFileSync(path.join(RESULTS, 'recording-results-summary.md'),
  `# Recording E2E — ${summary.atUtc}\n\n${summary.passed} passed, ${summary.failed} failed. Recording: ${recId}, file: ${summary.file}\n\n| Id | Title | Result | Actual |\n|---|---|---|---|\n` +
  results.map((r) => `| ${r.id} | ${r.title} | ${r.result} | ${String(r.actual).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n') + '\n')
log(`${summary.passed} passed, ${summary.failed} failed`)
process.exit(summary.failed ? 1 : 0)
