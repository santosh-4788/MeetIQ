// 15 Nov 2026: the recording shows the whiteboard and polls; the board opens with drawing for everyone; everyone sees live poll results.
//  - A drawing made BEFORE recording starts reaches the recorder (server snapshot on each recorder segment).
//  - Strokes drawn during the recording by a non-host (default "Everyone") appear live in the recording.
//  - A poll and its live Yes/No counts appear as a card; the final result shows after it closes.
// Needs the local room test API started WITH recording (scratchpad start-room-api-rec.ps1: Recording__* settings) and FFmpeg.
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\recording-board-poll.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 9 min - giving up'); process.exit(2) }, 9 * 60_000).unref()
import { Api, EMP, HOST, RESULTS, SHOTS, check, closeAll, exec, loginUI, newPage, scalar, sleep, sql, tc, until, writeResults } from './harness.mjs'

const ADMIN = 'superadmin@room.oneinsure.test'
const ROOT = path.resolve(RESULTS, '..', '..', '..', '..')
const SPOOL = path.join(ROOT, 'recording', 'e2e', 'spool')
const LIBRARY = path.join(ROOT, 'recording', 'e2e', 'library')
const FFMPEG = 'C:/ffmpeg/bin/ffmpeg.exe'
const FRAMES = path.join(SHOTS, 'rec-board-poll')
fs.mkdirSync(FRAMES, { recursive: true })

exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
const tag = Date.now().toString(36).slice(-5)
const admin = await new Api().login(ADMIN)
const hostApi = await new Api().login(HOST.email)
const ok = {}

/** Dark (drawn) pixels on a page's whiteboard canvas. */
const inked = (page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="wb-canvas"]')
  if (!c) return -1
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++
  return n
})
async function drag(page, from, to, steps = 14) {
  const box = await page.getByTestId('wb-canvas').boundingBox()
  const at = ([x, y]) => [box.x + box.width * x, box.y + box.height * y]
  await page.mouse.move(...at(from))
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(...at([from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]))
  await page.mouse.up()
}
async function openTools(page) {
  if (!(await page.getByTestId('tools-menu').isVisible().catch(() => false))) await page.getByTestId('ctl-tools').click()
  await page.getByTestId('tools-menu').waitFor()
}
const closeTools = async (page) => { if (await page.getByTestId('tools-menu').isVisible().catch(() => false)) await page.keyboard.press('Escape') }

let meetingId, mid, recId, host, emp, t0, originalPolicy

/** Accepts the recording notice wherever it is shown (at join or when recording is requested, depending on the policy). */
async function acceptNotices(ms) {
  const end = Date.now() + ms
  const pending = new Set([host, emp])
  while (pending.size && Date.now() < end) {
    for (const p of [...pending]) {
      const b = p.getByTestId('rec-accept')
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); pending.delete(p) }
    }
    await sleep(500)
  }
}

ok.setup = await tc('RBP-01', 'Polls and whiteboard switched on; team recording policy enabled', 'Admin API 204/200', async () => {
  for (const k of ['POLLS', 'WHITEBOARD']) {
    const r = await admin.req('PUT', `/admin/features/${k}`, { enabled: true })
    check(r.status === 204, `${k}: ${r.status}`)
  }
  const list = (await admin.req('GET', '/admin/recording-policies')).data
  const p = list.items.find((x) => x.code === 'TRAINING_TEAM_MEETING')
  check(p, 'no TRAINING_TEAM_MEETING policy')
  originalPolicy = p
  const r = await admin.req('PUT', '/admin/recording-policies/TRAINING_TEAM_MEETING', { ...p, isEnabled: true, requirement: 'OPTIONAL', consentMode: 'CONSENT_REQUIRED', consentFromAll: true,
    stopOnWithdrawal: true, playbackRoles: ['SuperAdmin'], downloadRoles: ['SuperAdmin'], ownerCanPlay: true, ownerCanDownload: false })
  check(r.status === 200, `policy ${r.status} ${JSON.stringify(r.data)}`)
  const h = (await admin.req('GET', '/admin/recording/health')).data
  check(h.available, `recorder not available: ${JSON.stringify(h.items.filter((i) => !i.ok))}`)
  return 'POLLS, WHITEBOARD on; policy enabled; recorder health OK'
})

ok.join = ok.setup && await tc('RBP-02', 'Host and employee join; both accept the recording notice', 'Both in the room', async () => {
  const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
  const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
  const created = await hostApi.req('POST', '/meetings', {
    title: `RecBoard ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
    employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'OPTIONAL', waitingRoomEnabled: false,
  })
  check(created.status === 201, `meeting: ${created.status} ${JSON.stringify(created.data)}`)
  meetingId = created.data.id
  mid = scalar(`SELECT MeetingId AS v FROM mtg.Meetings WHERE PublicId = '${meetingId}'`)
  host = await newPage({ width: 1366, height: 860 })
  emp = await newPage({ width: 1366, height: 860 })
  for (const [p, email, button] of [[host, HOST.email, /Start meeting|Join|Rejoin/], [emp, EMP.email, /Join now|Join|Rejoin/]]) {
    await loginUI(p, email)
    await p.goto(`/meetings/${meetingId}/room`)
    await p.getByRole('button', { name: button }).first().click()
    await p.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  }
  await acceptNotices(8000)
  return `meeting ${meetingId}`
})

ok.boardBefore = ok.join && await tc('RBP-03', 'Before recording: host opens the board (drawing for Everyone by default) and draws a rectangle', 'Saved scene with the rectangle; DrawMode EVERYONE; employee has the pen', async () => {
  await openTools(host)
  await host.getByTestId('tools-whiteboard').click()
  await host.getByTestId('whiteboard').waitFor({ timeout: 10_000 })
  await emp.getByTestId('whiteboard').waitFor({ timeout: 10_000 })
  await emp.getByTestId('wb-tool-pen').waitFor({ timeout: 10_000 }) // not "View only": everyone may draw
  check(await emp.getByTestId('wb-view-only').count() === 0, 'employee is view-only by default')
  await host.getByTestId('wb-tool-rect').click()
  await drag(host, [0.08, 0.15], [0.4, 0.6])
  await sleep(2000) // debounced save
  const b = sql(`SELECT DrawMode, IsOpen, LEN(SceneJson) AS Len FROM mtg.MeetingWhiteboards WHERE MeetingId = ${mid}`)[0]
  check(b?.DrawMode === 'EVERYONE' && b.IsOpen && b.Len > 50, `board row ${JSON.stringify(b)}`)
  return `DrawMode ${b.DrawMode}; scene ${b.Len} chars`
})

ok.start = ok.boardBefore && await tc('RBP-04', 'Host starts recording', 'Recording RECORDING', async () => {
  await host.getByTestId('ctl-record').click()
  const consent = host.getByTestId('rec-start-consent')
  if (await consent.isVisible().catch(() => false)) await consent.check().catch(() => consent.click())
  await host.getByTestId('rec-start-confirm').click()
  await acceptNotices(20_000)
  await until(() => Number(scalar(`SELECT COUNT(*) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid}`)) > 0, 'no recording row')
  recId = scalar(`SELECT TOP 1 CONVERT(VARCHAR(36), PublicId) AS v FROM rec.MeetingRecordings WHERE MeetingId = ${mid} ORDER BY RecordingId DESC`)
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'RECORDING', 'never RECORDING', 120_000, 1000)
  t0 = Date.now()
  return `recording ${recId}`
})

const eventsFile = () => path.join(SPOOL, `${recId.replace(/-/g, '').toLowerCase()}-1`, 'events.log')
const events = () => { try { return fs.readFileSync(eventsFile(), 'utf8') } catch { return '' } }

ok.recBoard = ok.start && await tc('RBP-05', 'The recorder gets the board that was already open, then the employee draws live', 'events.log: whiteboard open; employee stroke shown at host', async () => {
  await until(() => /"whiteboard"[^\n]*"open":true/.test(events()), `recorder never got the open board (${eventsFile()})`, 20_000, 500)
  const before = await inked(host)
  await emp.getByTestId('wb-tool-pen').click()
  await drag(emp, [0.5, 0.25], [0.9, 0.75], 24)
  await until(async () => (await inked(host)) > before + 100, 'employee stroke not shown at the host', 10_000)
  return `board open in recorder; host ink ${before} → ${await inked(host)}`
})

ok.poll = ok.recBoard && await tc('RBP-06', 'Poll: host asks, employee answers and sees LIVE results before it closes; host closes', 'Employee poll-results visible while open; events.log poll open then closed', async () => {
  await sleep(4000) // let the recording show the board with both drawings
  await openTools(host)
  await host.getByTestId('tools-polls').click()
  await host.getByTestId('poll-question').fill('Is the premium amount clear?')
  await host.getByTestId('poll-start').click()
  await host.getByTestId('poll-card').first().waitFor()
  await emp.locator('[data-testid="ctl-tools"] .oic-ctl-badge').waitFor({ timeout: 10_000 })
  await openTools(emp)
  await emp.getByTestId('tools-polls').click()
  await emp.getByTestId('poll-vote-yes').click()
  await emp.getByTestId('poll-my-answer').waitFor()
  await until(async () => (await emp.getByTestId('poll-results').first().innerText().catch(() => '')).includes('1 answer'), 'employee does not see live results', 10_000)
  const live = (await emp.getByTestId('poll-results').first().innerText()).replace(/\s+/g, ' ')
  await until(() => /"poll"[^\n]*"closed":false[^\n]*"total":1/.test(events()), 'recorder did not get the live count', 10_000)
  await sleep(5000) // the live card in the recording
  await host.getByTestId('poll-close').click()
  await until(() => /"poll"[^\n]*"closed":true/.test(events()), 'recorder did not get the closed poll', 10_000)
  await sleep(5000) // the final result in the recording
  return `employee live: "${live}"`
})

let file
ok.stop = ok.poll && await tc('RBP-07', 'Host stops; the recording is COMPLETED', 'MP4 in the library', async () => {
  await closeTools(host)
  await host.getByTestId('ctl-record').click()
  await host.getByTestId('rec-stop-confirm').click()
  await until(() => scalar(`SELECT [Status] AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`) === 'COMPLETED', 'not COMPLETED', 240_000, 1000)
  file = path.join(LIBRARY, scalar(`SELECT StorageKey AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`))
  check(fs.existsSync(file), `missing ${file}`)
  return `${file} (${Math.round(fs.statSync(file).size / 1024)} KB, ${Math.round((Date.now() - t0) / 1000)} s after start)`
})

ok.frames = ok.stop && await tc('RBP-08', 'Frames from the MP4: board with both drawings; poll card live; final result', 'PNG frames saved for review', async () => {
  const dur = Number(scalar(`SELECT DurationSeconds AS v FROM rec.MeetingRecordings WHERE PublicId = '${recId}'`))
  const at = { board: Math.min(8, dur * 0.25), pollLive: dur - 9, pollFinal: dur - 3 }
  const out = []
  for (const [name, s] of Object.entries(at)) {
    const png = path.join(FRAMES, `${name}.png`)
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, s)), '-i', file, '-frames:v', '1', png])
    check(fs.statSync(png).size > 5000, `${name} frame empty`)
    out.push(`${name}@${s.toFixed(1)}s`)
  }
  return `duration ${dur}s; ${out.join(', ')} → ${FRAMES}`
})

await closeAll()
exec(`UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE MeetingId = ${mid ?? 0}`)
// Put the team recording policy back as it was: other room tests expect no recording notice in team meetings.
if (originalPolicy) await admin.req('PUT', '/admin/recording-policies/TRAINING_TEAM_MEETING', originalPolicy)
writeResults('recording-board-poll', ok)
process.exit(Object.values(ok).every(Boolean) ? 0 : 1)
