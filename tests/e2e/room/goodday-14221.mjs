// GoodDay #14221: "While login through phone some extra space is coming" (iPhone Safari): an empty band above the
// header / below the tab bar, and a double top gap in the meeting room.
// Fix: the top/bottom safe-area insets go through --sat / --sab, which are 0 in a browser tab and the real inset only in
// the installed app (display-mode standalone/fullscreen); the room header no longer adds the top inset a second time.
//
// Chromium reports 0 for env(safe-area-inset-*), so this test checks the rules themselves (CSSOM) plus the layout at
// phone size in a browser tab and with display-mode: standalone emulated (CDP).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14221.mjs
import { Api, HOST, check, closeAll, exec, loginUI, newPage, tc, writeResults } from './harness.mjs'
import path from 'node:path'
import { SHOTS } from './harness.mjs'

exec("UPDATE mtg.Meetings SET [Status] = 'CANCELLED', CancelReason = N'rerun' WHERE [Status] IN ('SCHEDULED', 'LIVE') AND Title LIKE N'GD14221%'")
exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] = 'LIVE' AND MeetingKind = 'INSTANT'")

const layout = (page) => page.evaluate(() => {
  const css = getComputedStyle(document.documentElement)
  const header = document.querySelector('header')?.getBoundingClientRect()
  const tab = document.querySelector('[data-testid="mobile-tabbar"]')
  return {
    standalone: matchMedia('(display-mode: standalone)').matches,
    sat: css.getPropertyValue('--sat').trim(), sab: css.getPropertyValue('--sab').trim(),
    bodyPadTop: getComputedStyle(document.body).paddingTop,
    headerTop: header ? Math.round(header.top) : null,
    tabBottomGap: tab ? Math.round(window.innerHeight - tab.getBoundingClientRect().bottom) : null,
    tabPadBottom: tab ? getComputedStyle(tab).paddingBottom : null,
  }
})
// Every rule text in the loaded stylesheets that mentions a top/bottom safe-area inset.
const insetRules = (page) => page.evaluate(() => {
  const out = []
  const walk = (rules, media) => {
    for (const r of rules) {
      if (r.cssRules && !r.selectorText) walk(r.cssRules, r.conditionText ?? r.media?.mediaText ?? media)
      // Only rules that style an element on this page (Tailwind also emits unused classes it finds in old deploy backups).
      else if (/safe-area-inset-(top|bottom)/.test(r.cssText)) {
        let used = r.selectorText === ':root'
        try { used ||= !!document.querySelector(r.selectorText) } catch { /* selector not queryable */ }
        if (used) out.push({ media: media ?? '', text: r.cssText })
      }
    }
  }
  for (const s of document.styleSheets) { try { walk(s.cssRules) } catch { /* cross-origin */ } }
  return out
})

const ok = {}
let page
ok.tab = await tc('GD14221-01', 'Phone, browser tab: no band above the header or below the tab bar', '--sat/--sab 0; body padding-top 0; header at the very top; tab bar flush with the bottom', async () => {
  page = await newPage({ width: 390, height: 844, mobile: true })
  await loginUI(page, HOST.email)
  await page.getByTestId('mobile-tabbar').waitFor()
  const l = await layout(page)
  await page.screenshot({ path: path.join(SHOTS, 'gd14221-dashboard-tab.png') })
  check(!l.standalone, 'unexpected standalone')
  check(l.sat === '0px' && l.sab === '0px', `vars ${l.sat}/${l.sab}`)
  check(l.bodyPadTop === '0px', `body padding-top ${l.bodyPadTop}`)
  check(l.headerTop === 0, `header top ${l.headerTop}`)
  check(l.tabBottomGap === 0 && l.tabPadBottom === '0px', `tab bar gap ${l.tabBottomGap}, padding ${l.tabPadBottom}`)
  return JSON.stringify(l)
})

ok.rules = await tc('GD14221-02', 'Safe-area top/bottom insets are only used inside the installed-app media query', 'Every rule using env(safe-area-inset-top|bottom) is under (display-mode: standalone), (display-mode: fullscreen)', async () => {
  const rules = await insetRules(page)
  check(rules.length > 0, 'no inset rule found at all')
  const outside = rules.filter((r) => !/display-mode: standalone/.test(r.media))
  check(outside.length === 0, `outside the media query: ${outside.map((r) => r.text).join(' || ')}`)
  return rules.map((r) => `${r.media} { ${r.text} }`).join('; ')
})

// Chromium cannot emulate display-mode (CDP ignores it), so the installed-app branch is checked as a rule.
ok.standalone = await tc('GD14221-03', 'Installed app: the variables switch to the real insets', 'A :root rule under (display-mode: standalone), (display-mode: fullscreen) sets --sat/--sab from env(); the body, tab bar, room and toasts use the variables', async () => {
  const rules = await insetRules(page)
  const root = rules.find((r) => /display-mode: standalone/.test(r.media) && /--sat: env\(safe-area-inset-top/.test(r.text) && /--sab: env\(safe-area-inset-bottom/.test(r.text))
  check(root, 'standalone :root rule missing')
  check(/display-mode: fullscreen/.test(root.media), `media ${root.media}`)
  const uses = await page.evaluate(() => {
    const t = []
    const walk = (rules) => { for (const r of rules) { if (r.selectorText) t.push(r); else if (r.cssRules) walk(r.cssRules) } }
    for (const s of document.styleSheets) { try { walk(s.cssRules) } catch {} }
    return ['body', '.oic-tabbar', '.oic-main'].map((sel) => [sel, t.some((r) => r.selectorText === sel && /var\(--sa[tb]\)/.test(r.cssText))])
  })
  check(uses.every(([, u]) => u), `not using the variables: ${JSON.stringify(uses)}`)
  return `${root.media} { ${root.text} }`
})

ok.auth = await tc('GD14221-04', 'Sign-in page on a phone: the brand background reaches the top', 'The auth layout starts at y = 0 (no light strip)', async () => {
  const p = await newPage({ width: 390, height: 844, mobile: true })
  await p.goto('/login')
  await p.getByLabel('Official Email / Employee ID').waitFor()
  const top = await p.evaluate(() => Math.round(document.querySelector('#root > div, #root div')?.getBoundingClientRect().top ?? -1))
  await p.screenshot({ path: path.join(SHOTS, 'gd14221-login.png') })
  check(top === 0, `auth layout top ${top}`)
  return `auth layout top ${top}px`
})

ok.room = await tc('GD14221-05', 'Meeting room on a phone: header 8 px from the top, toolbar 10 px from the bottom', 'Header island top = 8 px (top inset not added twice); controls 10 px above the bottom edge', async () => {
  const hostApi = await new Api().login(HOST.email)
  const instant = await hostApi.req('POST', '/meetings/instant', { title: 'GD14221 room' })
  check(instant.status === 200 || instant.status === 201, `instant ${instant.status}`)
  await page.goto(`/meetings/${instant.data.id}/room`)
  await page.getByRole('button', { name: /Start meeting|Join/ }).first().click({ timeout: 25_000 })
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  const m = await page.evaluate(() => {
    const h = document.querySelector('.oic-room header')?.getBoundingClientRect()
    const c = document.querySelector('.oic-controls')?.getBoundingClientRect()
    return { headerTop: h && Math.round(h.top), controlsGap: c && Math.round(window.innerHeight - c.bottom), marginTop: getComputedStyle(document.querySelector('.oic-room header')).marginTop }
  })
  await page.screenshot({ path: path.join(SHOTS, 'gd14221-room.png') })
  await hostApi.req('POST', `/meetings/${instant.data.id}/end`, {}).catch(() => {})
  check(m.headerTop === 8 && m.marginTop === '8px', `header ${JSON.stringify(m)}`)
  check(m.controlsGap === 10, `controls gap ${m.controlsGap}`)
  return JSON.stringify(m)
})

await closeAll()
writeResults('goodday-14221')
