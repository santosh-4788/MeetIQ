// Screen-share viewing on phones (18 Nov 2026, after the Phase 2 screen-share deploy): Android Chrome and iPhone, portrait and
// landscape. A computer presents; the phone watches. Chromium with each phone's size, pixel density, touch and user agent;
// the iPhone also gets iPhone Safari's limits (no page fullscreen, no screen capture). Real WebKit is not installed here.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\screen-share-mobile.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 9 min'); process.exit(2) }, 9 * 60_000).unref()
import path from 'node:path'
import { Api, EMP, HOST, SHOTS, check, closeAll, closePage, exec, loginUI, newPage, overflowX, scalar, tc, until, writeResults } from './harness.mjs'

const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const tag = Date.now().toString(36).slice(-5)
const api = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(VARCHAR(36), PublicId) AS v FROM org.Employees WHERE EmployeeCode = 'RM-0002'`)
const s0 = new Date(Date.now() + 2 * 60_000); s0.setSeconds(0, 0)
const created = await api.req('POST', '/meetings', {
  title: `SSMOB ${tag}`, category: 'TEAM', startUtc: s0.toISOString(), endUtc: new Date(s0.getTime() + 30 * 60_000).toISOString(),
  employeeIds: [eshaId], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: false,
})
if (created.status !== 201) throw new Error(`meeting not created: ${created.status}`)
const meetingId = created.data.id

const DEVICES = {
  android: { name: 'Android Chrome', w: 412, h: 915, dpr: 2.625, ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36', iphone: false },
  iphone: { name: 'iPhone Safari', w: 390, h: 844, dpr: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1', iphone: true },
}

// The computer that presents (stays in the meeting for every phone case).
const presenter = await newPage({ width: 1920, height: 1080 })
await loginUI(presenter, EMP.email)
await presenter.goto(`/meetings/${meetingId}/room`)
await presenter.getByRole('button', { name: /Join now|Join|Rejoin/ }).first().click()
await presenter.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
await presenter.getByTestId('ctl-screen').click()

async function phone(d, landscape) {
  const p = await newPage({ width: landscape ? d.h : d.w, height: landscape ? d.w : d.h, mobile: true, userAgent: d.ua, deviceScaleFactor: d.dpr })
  if (d.iphone) {
    // iPhone Safari: no Fullscreen API for page elements, no screen capture.
    await p.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true })
      Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false, configurable: true })
      Element.prototype.requestFullscreen = undefined
      Element.prototype.webkitRequestFullscreen = undefined
      if (navigator.mediaDevices) delete Object.getPrototypeOf(navigator.mediaDevices).getDisplayMedia
    })
  }
  await loginUI(p, HOST.email)
  await p.goto(`/meetings/${meetingId}/room`)
  await p.getByRole('button', { name: /Start meeting|Join|Rejoin/ }).first().click()
  await p.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  await p.getByTestId('screen-view').waitFor({ timeout: 25_000 })
  return p
}

/** Geometry of the screen view, its toolbar, the presenter chip and the meeting controls. */
const layout = (p) => p.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } }
  const v = document.querySelector('[data-testid="screen-view"] video')
  const bar = document.querySelector('[data-testid="screen-tools"]')
  const toggle = document.querySelector('[data-testid="screen-tools-toggle"]')
  const frame = document.querySelector('[data-testid="screen-view"] .oic-screen-frame')
  const btns = bar ? [...bar.querySelectorAll('button, select')].map((b) => b.getBoundingClientRect()) : []
  return {
    vw: innerWidth, vh: innerHeight,
    received: [v.videoWidth, v.videoHeight], picture: r(frame), view: r(document.querySelector('[data-testid="screen-view"]')),
    bar: r(bar), barScroll: bar ? bar.scrollWidth - bar.clientWidth : 0, toggle: r(toggle),
    minBtn: btns.length ? Math.round(Math.min(...btns.map((b) => b.height))) : 0,
    chip: r(document.querySelector('[data-testid="tile-screen"] .oic-tile-chip')),
    controls: r(document.querySelector('nav[aria-label="Meeting controls"]')), leave: r(document.querySelector('[data-testid="ctl-leave"]')),
  }
})
const overlaps = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b

/** The screen toolbar is closed by default (one small button): open it, then return the control. */
async function tb(page, id) {
  if (await page.getByTestId('screen-tools').count() === 0) await page.getByTestId('screen-tools-toggle').click()
  await page.getByTestId('screen-tools').waitFor()
  return page.getByTestId(id)
}

const ok = {}
for (const key of ['android', 'iphone']) {
  const d = DEVICES[key]
  for (const landscape of [false, true]) {
    const label = `${d.name} ${landscape ? 'landscape' : 'portrait'}`
    const id = `SSM-${key === 'android' ? 'A' : 'I'}${landscape ? 'L' : 'P'}`
    ok[id] = await tc(id, `${label}: watching a computer's screen`, 'picture fits the screen with its aspect; toolbar visible, inside the picture area, finger-size, not over the presenter chip or the controls; no sideways page scroll; full-resolution picture; zoom + move by touch; fullscreen or a clear fallback', async () => {
      const p = await phone(d, landscape)
      await until(async () => { const x = await layout(p); return x.received[0] > 0 && x.picture?.w > 0 }, 'no picture', 20_000)
      // Closed by default: only the small button (bugs docx 18 Nov 2026); a tap opens the toolbar, which closes by itself.
      const shotBase = path.join(SHOTS, `ssmob-${key}-${landscape ? 'land' : 'port'}`)
      const C = await layout(p)
      check(!C.bar && C.toggle, 'toolbar open by default / no small button')
      check(C.toggle.h >= 40, `small button not finger-size: ${C.toggle.h}px`)
      await p.screenshot({ path: `${shotBase}-closed.png` })
      await p.getByTestId('screen-tools-toggle').tap()
      await p.getByTestId('screen-tools').waitFor()
      const L = await layout(p)
      await p.screenshot({ path: `${shotBase}.png` })
      const notes = []
      const closed = await until(async () => !(await layout(p)).bar, 'toolbar did not close by itself', 9000).then(() => true).catch(() => false)
      check(closed, 'toolbar stays open on a touch screen')
      check(L.bar.l >= L.view.l - 1 && L.bar.r <= L.view.r + 1 && L.bar.r <= L.vw, `toolbar outside the screen area: ${JSON.stringify(L.bar)} view ${JSON.stringify(L.view)}`)
      check(L.minBtn >= 40, `buttons smaller than 40 px: ${L.minBtn}`)
      check(!overlaps(L.bar, L.chip), 'toolbar covers the "is presenting" chip')
      check(!overlaps(L.bar, L.controls), 'toolbar covers the meeting controls')
      check(L.picture.r <= L.vw + 1 && L.picture.b <= L.vh + 1, `picture outside the screen: ${JSON.stringify(L.picture)}`)
      check(Math.abs(L.picture.w / L.picture.h - 16 / 9) < 0.03, `aspect ${L.picture.w}x${L.picture.h}`)
      check(L.leave && L.leave.b <= L.vh + 1, 'Leave button off screen')
      const ox = await overflowX(p)
      check(ox <= 0, `page scrolls sideways by ${ox}px`)
      if (L.barScroll > 0) notes.push(`toolbar scrolls sideways by ${L.barScroll}px`)

      // Zoom in twice, then move the picture with a finger (touch scroll).
      await (await tb(p, 'screen-zoom-in')).tap()
      await (await tb(p, 'screen-zoom-in')).tap()
      const lvl = await (await tb(p, 'screen-zoom-level')).innerText()
      const moved = await p.evaluate(() => { const b = document.querySelector('[data-testid="screen-view"]'); b.scrollLeft = 120; b.scrollTop = 40; return [b.scrollLeft, b.scrollTop, getComputedStyle(b).touchAction] })
      check(moved[0] > 0, `zoomed picture cannot be moved: ${moved}`)
      check(/pan/.test(moved[2]), `touch panning not allowed: ${moved[2]}`)
      await p.screenshot({ path: `${shotBase}-zoom.png` })
      await (await tb(p, 'screen-fit')).tap()

      // Fullscreen: Android enters it; iPhone Safari cannot, so no button is offered (Hide participants / rotating instead).
      let fs = 'n/a'
      if (d.iphone) {
        check(await (await tb(p, 'screen-fullscreen')).count() === 0, 'a fullscreen button is offered on iPhone, where it cannot work')
        check(await (await tb(p, 'screen-thumbs')).count() === 1, 'no Hide participants on iPhone')
        fs = 'no button on iPhone (not supported by Safari); Hide participants offered'
      } else {
        await (await tb(p, 'screen-fullscreen')).tap()
        const on = await until(() => p.evaluate(() => !!document.fullscreenElement), 'android fullscreen not entered', 6000).catch(() => false)
        if (on) {
          await p.screenshot({ path: `${shotBase}-fullscreen.png` })
          await (await tb(p, 'screen-fullscreen')).tap()
          await until(() => p.evaluate(() => !document.fullscreenElement), 'android fullscreen not left', 6000)
          fs = 'entered and left'
        } else {
          const t = await p.locator('[role="status"] p').last().innerText({ timeout: 3000 }).catch(() => '')
          check(/did not allow fullscreen/.test(t), `android: neither fullscreen nor a message ("${t}")`)
          fs = 'refused by the test browser -> message shown'
        }
      }
      await closePage(p)
      return `${L.vw}x${L.vh} @${d.dpr}x: picture ${L.picture.w}x${L.picture.h}, received ${L.received.join('x')}; toolbar ${L.bar.w}px, buttons ${L.minBtn}px; zoom ${lvl}; fullscreen ${fs}${notes.length ? '; ' + notes.join('; ') : ''}`
    })
  }
}

await closeAll()
retire()
writeResults('screen-share-mobile')
const n = Object.values(ok).filter(Boolean).length
console.log(`${n}/${Object.keys(ok).length} passed`)
process.exit(n === Object.keys(ok).length ? 0 : 1)
