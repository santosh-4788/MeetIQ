// Screen-share inspection (18 Nov 2026, Phase 1 - measurement only, no app change): which resolution does a viewer receive
// at the size seen in the user's screenshot (browser window about 1460x745), and with the presenter tile maximised?
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\screen-share-probe.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 4 min'); process.exit(2) }, 4 * 60_000).unref()
import path from 'node:path'
import { Api, EMP, HOST, SHOTS, closeAll, exec, loginUI, newPage, scalar } from './harness.mjs'

exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
const tag = Date.now().toString(36).slice(-5)
const api = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `SSPROBE ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
const meetingId = created.data.id
async function enter(page, email, button) {
  await loginUI(page, email)
  await page.goto(`/meetings/${meetingId}/room`)
  await page.getByRole('button', { name: button }).first().click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}
const viewer = await newPage({ width: 1460, height: 745 })
await enter(viewer, HOST.email, /Start meeting|Join|Rejoin/)
const presenter = await newPage({ width: 1920, height: 1080 })
await enter(presenter, EMP.email, /Join now|Join|Rejoin/)
await presenter.getByTestId('ctl-screen').click()

const sample = () => viewer.evaluate(() => {
  const v = document.querySelector('video[data-testid="video-screen"]')
  if (!v) return null
  const r = v.getBoundingClientRect()
  return { received: `${v.videoWidth}x${v.videoHeight}`, shownCss: `${Math.round(r.width)}x${Math.round(r.height)}`, dpr: devicePixelRatio,
    objectFit: getComputedStyle(v).objectFit, fullscreen: !!document.fullscreenElement }
})
const sent = () => presenter.evaluate(() => {
  const v = document.querySelector('video[data-testid="video-screen"]')
  return v ? `${v.videoWidth}x${v.videoHeight}` : null
})
for (let i = 0; i < 8; i++) {
  await viewer.waitForTimeout(2500)
  console.log(`t+${(i + 1) * 2.5}s  presenter captures ${await sent()}  viewer:`, JSON.stringify(await sample()))
}
await viewer.screenshot({ path: path.join(SHOTS, 'ssprobe-viewer-normal.png') })

// The expand icon on the presenting tile (LiveKit FocusToggle): does anything change?
const before = await sample()
const toggle = viewer.locator('[data-testid="tile-screen"] .lk-focus-toggle-button')
console.log('expand buttons on the screen tile:', await toggle.count())
if (await toggle.count()) {
  await toggle.first().click()
  await viewer.waitForTimeout(4000)
  const after = await sample()
  console.log('after clicking expand:', JSON.stringify(after), 'changed size:', before?.shownCss !== after?.shownCss)
  await viewer.screenshot({ path: path.join(SHOTS, 'ssprobe-viewer-after-expand.png') })
}

// The same element made as large as the window (what a working fullscreen would give): which layer arrives then?
await viewer.evaluate(() => {
  const v = document.querySelector('video[data-testid="video-screen"]')
  Object.assign(v.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '9999', background: '#000' })
})
for (let i = 0; i < 4; i++) {
  await viewer.waitForTimeout(2500)
  console.log(`window-size element t+${(i + 1) * 2.5}s viewer:`, JSON.stringify(await sample()))
}
await closeAll()
exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
process.exit(0)
