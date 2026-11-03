// Mobile layout audit: every built screen at phone and tablet widths (Android/iOS-like viewports, touch, mobile UA), plus the
// pre-join screen and the meeting room in portrait and landscape. Fails on horizontal page scroll, room toolbars that do not
// fit, and touch targets in the room toolbar smaller than 40 px. Screenshots: results/screenshots/m-*.png.
//
// Run:  cd "E:\OneInsure Connect\tests\e2e"; node room\mobile-audit.mjs
import { Api, HOST, check, closeAll, exec, loginUI, newPage, sql, tc, writeResults } from './harness.mjs'
import path from 'node:path'
import { SHOTS } from './harness.mjs'

const ADMIN = 'superadmin@room.oneinsure.test'
const PHONES = [
  { name: 'android-360', width: 360, height: 780 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'iphone-430', width: 430, height: 932 },
  { name: 'tablet-768', width: 768, height: 1024 },
]

// Earlier runs: free the host's calendar slot.
exec("UPDATE mtg.Meetings SET [Status] = 'CANCELLED', CancelReason = N'audit rerun' WHERE [Status] IN ('SCHEDULED', 'LIVE') AND Title LIKE N'Mobile %'")
const hostApi = await new Api().login(HOST.email)
const start = new Date(Date.now() + 26 * 3600_000)
start.setMinutes(0, 0, 0)
const created = await hostApi.req('POST', '/meetings', {
  title: 'Mobile audit meeting with a fairly long title to test wrapping', category: 'TEAM', startUtc: start.toISOString(), endUtc: new Date(start.getTime() + 3600_000).toISOString(),
  employeeIds: [], guests: [{ name: 'Mira Mobile', email: 'mira.mobile@example.test' }], status: 'SCHEDULED', recordingPolicy: 'NONE', waitingRoomEnabled: true,
  overrideConflicts: false,
})
check(created.status === 201, `meeting ${created.status} ${JSON.stringify(created.data)}`)
const meetingId = created.data.id
const instant = await hostApi.req('POST', '/meetings/instant', { title: 'Mobile room audit' })
const linkPath = instant.data.link.path

/** Elements that stick out of the viewport horizontally (the usual cause of sideways scrolling). */
const offenders = (page) => page.evaluate(() => {
  const w = window.innerWidth
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= w + 1) continue
    // Ignore children of horizontally scrollable containers (tables inside overflow-x-auto are fine).
    let p = el.parentElement, scrolls = false
    while (p) { const s = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(s.overflowX) && p.clientWidth < p.scrollWidth + 1) { scrolls = true; break } p = p.parentElement }
    if (scrolls) continue
    out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ').slice(0, 3).join('.')} right=${Math.round(r.right)}`)
    if (out.length > 5) break
  }
  return out
})

const SCREENS = [
  { who: 'anon', path: '/login', name: 'login' },
  { who: 'anon', path: '/forgot-password', name: 'forgot' },
  { who: 'anon', path: linkPath, name: 'link' },
  { who: 'host', path: '/dashboard', name: 'dashboard' },
  { who: 'host', path: '/meetings', name: 'meetings' },
  { who: 'host', path: `/meetings/${meetingId}`, name: 'meeting-detail' },
  { who: 'host', path: '/schedule', name: 'schedule' },
  { who: 'host', path: '/calendar', name: 'calendar' },
  { who: 'host', path: '/internal', name: 'internal' },
  { who: 'host', path: '/notifications', name: 'notifications' },
  { who: 'host', path: '/settings', name: 'settings' },
  { who: 'admin', path: '/recordings', name: 'recordings' },
  { who: 'admin', path: '/employees', name: 'employees' },
  { who: 'admin', path: '/organisation', name: 'organisation' },
  { who: 'admin', path: '/admin', name: 'admin' },
  { who: 'admin', path: '/customer-meetings', name: 'customer-meetings' },
]

for (const vp of PHONES) {
  const sessions = {}
  for (const who of ['anon', 'host', 'admin']) {
    const p = await newPage({ width: vp.width, height: vp.height, mobile: vp.width < 700 })
    if (who !== 'anon') await loginUI(p, who === 'host' ? HOST.email : ADMIN)
    sessions[who] = p
  }
  await tc(`MOB-${vp.name}`, `All screens at ${vp.width}×${vp.height}`, 'No horizontal scrolling on any screen', async () => {
    const problems = []
    for (const s of SCREENS) {
      const p = sessions[s.who]
      await p.goto(s.path)
      await p.waitForLoadState('networkidle').catch(() => {})
      await p.waitForTimeout(600)
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      await p.screenshot({ path: path.join(SHOTS, `m-${vp.name}-${s.name}.png`), fullPage: true }).catch(() => {})
      if (vp.width < 768 && s.who !== 'anon' && !(await p.getByTestId('mobile-tabbar').isVisible())) problems.push(`${s.name}: no bottom tab bar`)
      if (over > 0) problems.push(`${s.name}: +${over}px [${(await offenders(p)).join('; ')}]`)
    }
    check(problems.length === 0, problems.join('\n'))
    return `${SCREENS.length} screens fit`
  })
  for (const p of Object.values(sessions)) await p.context().browser().close().catch(() => {})
}

for (const [name, width, height] of [['portrait-360', 360, 740], ['portrait-390', 390, 844], ['landscape-844', 844, 390]]) {
  await tc(`MOB-room-${name}`, `Pre-join and meeting room, ${width}×${height}`, 'Pre-join fits; toolbar fits without scrolling; controls ≥ 40 px; panels usable', async () => {
    const p = await newPage({ width, height, mobile: true })
    await loginUI(p, HOST.email)
    await p.goto(`/meetings/${instant.data.id}/room`)
    await p.getByText('Ready to join?').waitFor({ timeout: 20_000 })
    const pre = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await p.screenshot({ path: path.join(SHOTS, `m-room-${name}-prejoin.png`) })
    await p.getByRole('button', { name: /Start meeting|Join now/ }).click()
    await p.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
    await p.waitForTimeout(1500)
    await p.keyboard.press('Escape') // invite dialog, if open
    const bar = await p.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Meeting controls"]')
      const btns = [...nav.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0)
      const small = btns.filter((b) => { const r = b.getBoundingClientRect(); return r.width < 40 || r.height < 40 }).map((b) => b.title || b.textContent)
      const outside = btns.filter((b) => { const r = b.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1 || r.bottom > window.innerHeight + 1 }).map((b) => b.title || b.getAttribute('aria-label') || b.textContent)
      return { scroll: nav.scrollWidth - nav.clientWidth, small, outside, count: btns.length, page: document.documentElement.scrollWidth - window.innerWidth }
    })
    await p.screenshot({ path: path.join(SHOTS, `m-room-${name}.png`) })
    // Chat and participants panels open and can be closed.
    await p.getByTestId('ctl-chat').click()
    await p.getByTestId('chat-input').waitFor()
    await p.screenshot({ path: path.join(SHOTS, `m-room-${name}-chat.png`) })
    await p.getByTestId('ctl-chat').click()
    await p.getByTestId('ctl-people').click()
    await p.getByTestId('participant-list').waitFor()
    await p.screenshot({ path: path.join(SHOTS, `m-room-${name}-people.png`) })
    await p.getByTestId('ctl-people').click()
    let sheet = 'n/a'
    if (width < 640) {
      await p.getByTestId('ctl-more').click()
      await p.getByTestId('more-sheet').waitFor()
      await p.screenshot({ path: path.join(SHOTS, `m-room-${name}-more.png`) })
      sheet = String(await p.getByTestId('more-sheet').locator('button.oic-ctl').count())
      await p.getByTestId('ctl-hand').click() // a control in the sheet works and closes it
      await p.getByTestId('more-sheet').waitFor({ state: 'detached' })
    }
    await p.context().browser().close()
    const issues = []
    if (pre > 0) issues.push(`pre-join overflow ${pre}px`)
    if (bar.page > 0) issues.push(`room page overflow ${bar.page}px`)
    if (bar.scroll > 0) issues.push(`toolbar scrolls by ${bar.scroll}px`)
    if (bar.outside.length) issues.push(`controls off screen: ${bar.outside.join(', ')}`)
    if (bar.small.length) issues.push(`controls under 40px: ${bar.small.join(', ')}`)
    check(issues.length === 0, issues.join('; '))
    return `${bar.count} controls visible, all ≥ 40 px, no scrolling; More sheet controls: ${sheet}`
  })
}

sql(`SELECT 1 AS v`)
await closeAll()
process.exit(writeResults('mobile-audit-results') ? 0 : 1)
