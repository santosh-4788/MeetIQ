// Screen sharing quality / fullscreen / zoom (18 Nov 2026, "Screen Sharing Quality, Fullscreen and Remote Control
// Enhancement" Phase 2). Phase 1 measured: a viewer at the user's window size (1460x745) received the 960x540 layer of a
// 1920x1080 share, and the tile's expand icon changed nothing. This checks the fix and that nothing else changed.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\screen-share-view.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 7 min'); process.exit(2) }, 7 * 60_000).unref()
import path from 'node:path'
import { Api, EMP, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, overflowX, scalar, tc, until, writeResults } from './harness.mjs'

const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const tag = Date.now().toString(36).slice(-5)
const api = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `SSVIEW ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status}`)
const meetingId = created.data.id
async function enter(page, email, button) {
  await loginUI(page, email)
  await page.goto(`/meetings/${meetingId}/room`)
  await page.getByRole('button', { name: button }).first().click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `ssview-${name}.png`) })
const info = (page) => page.evaluate(() => {
  const v = document.querySelector('[data-testid="screen-view"] video')
  if (!v) return null
  const r = v.getBoundingClientRect()
  return { received: [v.videoWidth, v.videoHeight], shown: [Math.round(r.width), Math.round(r.height)], fullscreen: !!document.fullscreenElement,
    strip: document.querySelectorAll('.lk-carousel').length, playing: !v.paused && v.readyState >= 2 }
})
/** The screen toolbar is closed by default (one small button): open it, then return the control. */
async function tb(page, id) {
  if (await page.getByTestId('screen-tools').count() === 0) await page.getByTestId('screen-tools-toggle').click()
  await page.getByTestId('screen-tools').waitFor()
  return page.getByTestId(id)
}

const ok = {}

const viewer = await newPage({ width: 1460, height: 745 })
await enter(viewer, HOST.email, /Start meeting|Join|Rejoin/)
const presenter = await newPage({ width: 1920, height: 1080 })
await enter(presenter, EMP.email, /Join now|Join|Rejoin/)
await presenter.getByTestId('ctl-screen').click()
await viewer.getByTestId('screen-view').waitFor({ timeout: 20_000 })

ok.quality = await tc('SSV-01', 'Viewer at 1460x745 (the screenshot) receives the full 1920x1080 picture (Auto)', 'videoWidth 1920 while shown about 1100 px wide; no blank stretch', async () => {
  const i = await until(async () => { const x = await info(viewer); return x?.received[0] === 1920 && x }, 'full layer never arrived', 20_000)
  await shot(viewer, '01-auto')
  check(i.shown[0] < 1460 && i.shown[0] > 900, `shown ${i.shown}`)
  check(Math.abs(i.shown[0] / i.shown[1] - 16 / 9) < 0.02, `aspect ${i.shown}`)
  return `received ${i.received.join('x')}, shown ${i.shown.join('x')}`
})

ok.standard = await tc('SSV-02', 'Quality Standard: the smaller layer, as before; back to Auto: full again', 'Standard -> 960x540; Auto -> 1920x1080', async () => {
  await (await tb(viewer, 'screen-quality')).selectOption('standard')
  const s = await until(async () => { const x = await info(viewer); return x?.received[0] === 960 && x }, 'standard did not switch to the 960 layer', 20_000)
  await (await tb(viewer, 'screen-quality')).selectOption('auto')
  const a = await until(async () => { const x = await info(viewer); return x?.received[0] === 1920 && x }, 'auto did not return to 1920', 20_000)
  return `standard ${s.received.join('x')}; auto ${a.received.join('x')}`
})

ok.thumbs = await tc('SSV-03', 'Hide / show participants', 'strip hidden -> screen wider; shown again', async () => {
  const areaW = () => viewer.evaluate(() => document.querySelector('[data-testid="screen-view"]').clientWidth)
  const before = await info(viewer)
  const w0 = await areaW()
  check(before.strip === 1, `strip at start ${before.strip}`)
  await (await tb(viewer, 'screen-thumbs')).click()
  // The area gets the strip's width; the picture itself grows only when width (not height) was the limit.
  const w1 = await until(async () => { const x = await info(viewer); const w = await areaW(); return x.strip === 0 && w > w0 + 100 && w }, 'strip not hidden / screen area not wider')
  await shot(viewer, '03-thumbs-hidden')
  await (await tb(viewer, 'screen-thumbs')).click()
  await until(async () => (await info(viewer)).strip === 1, 'strip not shown again')
  return `screen area ${w0} -> ${w1} px wide with the strip hidden`
})

ok.zoom = await tc('SSV-04', 'Zoom in / out, Actual size, Fit', 'level text changes; 1:1 shows 1920 px wide and can be moved; Fit restores', async () => {
  await (await tb(viewer, 'screen-zoom-in')).click()
  const z1 = await (await tb(viewer, 'screen-zoom-level')).innerText()
  check(/%$/.test(z1), `level after zoom in: ${z1}`)
  await (await tb(viewer, 'screen-actual')).click()
  check(await (await tb(viewer, 'screen-zoom-level')).innerText() === '100%', 'actual size not 100%')
  const a = await info(viewer)
  check(Math.abs(a.shown[0] - 1920) <= 2, `actual size shown ${a.shown}`)
  check(await viewer.getByTestId('screen-view').getAttribute('data-zoomed') !== null, 'zoomed picture cannot be moved')
  const scrolled = await viewer.evaluate(() => { const b = document.querySelector('[data-testid="screen-view"]'); b.scrollLeft = 300; return b.scrollLeft })
  check(scrolled > 0, 'cannot scroll the zoomed picture')
  await shot(viewer, '04-actual-size')
  await (await tb(viewer, 'screen-zoom-out')).click()
  await (await tb(viewer, 'screen-fit')).click().catch(() => {})
  check(await (await tb(viewer, 'screen-zoom-level')).innerText() === 'Fit', 'fit not restored')
  return `zoom ${z1}; actual size ${a.shown.join('x')}; fit restored`
})

ok.fullscreen = await tc('SSV-05', 'Fullscreen: whole meeting page, controls usable, participants hidden; exit restores; share keeps running', 'fullscreenElement set; Leave button visible; strip back after exit; same track still playing', async () => {
  const sid = await viewer.evaluate(() => document.querySelector('[data-testid="screen-view"]').closest('[data-identity]')?.getAttribute('data-identity'))
  await (await tb(viewer, 'screen-fullscreen')).click()
  const fs = await until(async () => { const x = await info(viewer); return x.fullscreen && x.strip === 0 && x }, 'fullscreen not entered', 8000).catch(() => null)
  if (!fs) {
    // Headless browsers may refuse: the app must then say so and not claim fullscreen.
    const toastText = await viewer.locator('[role="status"] p').last().innerText().catch(() => '')
    check(/did not allow fullscreen/.test(toastText), `refused without a message: "${toastText}"`)
    check((await info(viewer)).strip === 0, 'strip not hidden as the fallback')
    await (await tb(viewer, 'screen-thumbs')).click()
    return 'browser refused fullscreen: message shown, participants hidden instead'
  }
  check(fs.strip === 0, 'strip not hidden in fullscreen')
  check(await viewer.getByTestId('ctl-leave').isVisible(), 'meeting controls not visible in fullscreen')
  await shot(viewer, '05-fullscreen')
  await (await tb(viewer, 'screen-fullscreen')).click()
  const out = await until(async () => { const x = await info(viewer); return !x.fullscreen && x.strip === 1 && x }, 'did not leave fullscreen / strip not restored', 8000)
  const still = await viewer.evaluate(() => document.querySelector('[data-testid="screen-view"]').closest('[data-identity]')?.getAttribute('data-identity'))
  check(still === sid && out.playing, 'screen share stopped or changed')
  const presenting = await presenter.getByTestId('ctl-screen').getAttribute('aria-pressed')
  check(presenting === 'true', 'presenter stopped presenting')
  return `fullscreen ${fs.shown.join('x')} -> exited, strip back, share still playing`
})

ok.autoclose = await tc('SSV-10', 'Toolbar: closed by default, opens on click, closes by itself after ~5 s, close button', 'only the small button at first; opens; gone ~5 s after the mouse leaves; close button works', async () => {
  await viewer.mouse.move(5, 5)
  if (await viewer.getByTestId('screen-tools').count()) await viewer.getByTestId('screen-tools-close').click()
  await viewer.mouse.move(5, 5)
  check(await viewer.getByTestId('screen-tools').count() === 0 && await viewer.getByTestId('screen-tools-toggle').count() === 1, 'not closed to the small button')
  await shot(viewer, '10-closed')
  await viewer.getByTestId('screen-tools-toggle').click()
  await viewer.getByTestId('screen-tools').waitFor()
  await viewer.mouse.move(5, 5) // mouse away from the toolbar
  const t0 = Date.now()
  await until(async () => (await viewer.getByTestId('screen-tools').count()) === 0, 'toolbar did not close by itself', 9000)
  const after = Date.now() - t0
  check(after >= 3500, `closed too early (${after} ms)`)
  await viewer.getByTestId('screen-tools-toggle').click()
  await viewer.getByTestId('screen-tools-close').click()
  check(await viewer.getByTestId('screen-tools').count() === 0, 'close button did not close')
  return `closed by itself after ${(after / 1000).toFixed(1)} s; close button works`
})

ok.late = await tc('SSV-06', 'Late participant sees the existing share sharply; presenter\'s own view unchanged', 'viewer leaves and joins again while the share runs: screen-view with the full picture; presenter has no viewer toolbar', async () => {
  check(await presenter.getByTestId('screen-tools').count() === 0, 'presenter sees the viewer toolbar on their own screen')
  await viewer.goto('/dashboard')
  await viewer.goto(`/meetings/${meetingId}/room`)
  await viewer.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
  await viewer.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  const i = await until(async () => { const x = await info(viewer); return x?.received[0] === 1920 && x }, 'late joiner did not get the full picture', 25_000)
  return `late joiner received ${i.received.join('x')}`
})

ok.mobile = await tc('SSV-07', 'Phone width (390 px): toolbar fits, no sideways page scroll', 'screen-view + toolbar visible; no horizontal overflow', async () => {
  await viewer.setViewportSize({ width: 390, height: 844 })
  await viewer.waitForTimeout(1500)
  await tb(viewer, 'screen-tools')
  const ox = await overflowX(viewer)
  check(ox <= 0, `horizontal page overflow at 390 px: ${ox}px`)
  await shot(viewer, '07-phone')
  await viewer.setViewportSize({ width: 1460, height: 745 })
  return 'fits at 390 px'
})

await presenter.getByTestId('ctl-screen').click()
ok.stop = await tc('SSV-08', 'Presenter stops: viewer returns to the normal layout', 'no screen-view; camera tiles shown', async () => {
  await until(async () => (await viewer.getByTestId('screen-view').count()) === 0, 'screen view still shown after stop')
  check(await viewer.getByTestId('tile').count() >= 2, 'camera tiles not back')
  return 'normal layout'
})

// Phone check last: it signs in as the host again, which takes over the desktop viewer's connection (#14224).
await presenter.getByTestId('ctl-screen').click()
ok.touch = await tc('SSV-09', 'Real phone mode (touch, 390 px): small button, tap opens the toolbar with finger-size buttons', 'closed by default; tap opens; buttons at least 40 px; no page overflow', async () => {
  const phone = await newPage({ width: 390, height: 844, mobile: true })
  await loginUI(phone, HOST.email)
  await phone.goto(`/meetings/${meetingId}/room`)
  await phone.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
  await phone.getByTestId('screen-tools-toggle').waitFor({ timeout: 30_000 })
  check(await phone.getByTestId('screen-tools').count() === 0, 'toolbar open by default')
  await phone.getByTestId('screen-tools-toggle').tap()
  await phone.getByTestId('screen-tools').waitFor()
  const t = await phone.evaluate(() => {
    const b = document.querySelector('[data-testid="screen-tools"] [data-testid="screen-fullscreen"]').getBoundingClientRect()
    return { btn: Math.round(b.height) }
  })
  await phone.screenshot({ path: path.join(SHOTS, 'ssview-09-phone-touch.png') })
  check(t.btn >= 40, `buttons too small: ${t.btn}px`)
  const ox = await overflowX(phone)
  check(ox <= 0, `page overflow ${ox}px`)
  return `closed by default, tap opens; buttons ${t.btn}px`
})


await closeAll()
retire()
writeResults('screen-share-view')
const n = Object.values(ok).filter(Boolean).length
console.log(`${n}/${Object.keys(ok).length} passed`)
process.exit(n === Object.keys(ok).length ? 0 : 1)
