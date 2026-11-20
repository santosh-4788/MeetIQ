// Whole-portal layout audit in Google Chrome (20 Nov 2026): every page in the menu (+ chat sections) at computer, tablet
// and phone sizes. Flags: sideways page scroll; text or controls cut off without "…" (overflow hidden, no ellipsis);
// elements sticking out of the screen outside a scrolling area; script errors. Screenshots: results/screenshots/pa-*.png
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175).
// Run:  cd "E:\OneInsure Connect\tests\e2e"; node room\portal-audit.mjs [admin|chat]
setTimeout(() => { console.log('WATCHDOG: audit still running after 9.5 min - giving up'); process.exit(2) }, 570_000).unref()
import fs from 'node:fs'
import path from 'node:path'
import { chromium, devices } from 'playwright-core'
import { HOST, PASSWORD, RESULTS, SHOTS, WEB, exec, log } from './harness.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const ADMIN = 'superadmin@room.oneinsure.test'
const part = process.argv[2] ?? 'admin'
const SIZES = [
  { name: 'pc-1920', ctx: { viewport: { width: 1920, height: 1080 } } },
  { name: 'pc-1366', ctx: { viewport: { width: 1366, height: 768 } } },
  { name: 'pc-1280', ctx: { viewport: { width: 1280, height: 720 } } },
  { name: 'tab-768', ctx: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } },
  { name: 'iph-390', ctx: devices['iPhone 14'] && { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: devices['Pixel 7'].userAgent } },
  { name: 'and-360', ctx: devices['Galaxy S8'] },
]
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS', 'CHAT_ADVANCED')")

/** Runs in the page: returns layout problems. */
function audit() {
  const vw = window.innerWidth
  const out = { overflowX: document.documentElement.scrollWidth - vw, clipped: [], outside: [] }
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    const id = el.getAttribute('data-testid')
    return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${t}"`
  }
  // Width of the element's own text (not decorative children such as a shine effect).
  const textWidth = (el) => {
    let w = 0
    for (const n of el.childNodes)
      if (n.nodeType === 3 && n.textContent.trim()) {
        const rg = document.createRange()
        rg.selectNodeContents(n)
        w = Math.max(w, rg.getBoundingClientRect().width)
      }
    return w
  }
  const scrollsX = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') return true
    }
    return false
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || !visible(el)) continue
    if (el.closest('[aria-hidden="true"], svg, canvas, video, [data-audit-ignore]')) continue
    const s = getComputedStyle(el)
    // Text meant only for screen readers (Tailwind sr-only: 1 px box, clipped) is invisible on purpose.
    if (el.clientWidth <= 1 || el.clientHeight <= 1 || (s.clip && s.clip !== 'auto') || s.clipPath.startsWith('inset(50%')) continue
    // Cut-off text: content wider than the box, overflow hidden, and no "…".
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
    if (hasText && (s.overflowX === 'hidden' || s.overflowX === 'clip') && s.textOverflow !== 'ellipsis' && !String(s.webkitLineClamp).match(/\d/) && textWidth(el) > el.clientWidth + 2)
      out.clipped.push(label(el))
    // Sticking out of the screen (not inside a sideways-scrolling area, not a fixed off-canvas panel).
    const r = el.getBoundingClientRect()
    if ((r.right > vw + 1 || r.left < -1) && s.position !== 'fixed' && !scrollsX(el) && !el.closest('[inert], [aria-modal="true"][hidden]'))
      out.outside.push(`${label(el)} x=${Math.round(r.left)}..${Math.round(r.right)}`)
  }
  // Rows that scroll sideways with an item half hidden (e.g. a tab bar wider than a phone) - listed for review.
  out.scrollers = []
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || !visible(el) || el.closest('table, [role="grid"], pre, code')) continue
    const s = getComputedStyle(el)
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 120 && !el.querySelector('table'))
      out.scrollers.push(`${label(el).slice(0, 80)} (${el.scrollWidth}>${el.clientWidth})`)
  }
  out.scrollers = [...new Set(out.scrollers)].slice(0, 5)
  out.clipped = [...new Set(out.clipped)].slice(0, 8)
  out.outside = [...new Set(out.outside)].slice(0, 8)
  return out
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const report = []
async function login(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/dashboard|change-password/, { timeout: 30_000 })
}

// Routes: everything the super admin's menu offers (admin part), or the chat screens as an employee (chat part).
let routes
{
  const ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  if (part === 'admin') {
    // Every item of the menu (layouts/navigation.ts) except Chat, plus the profile page.
    routes = ['/dashboard', '/meetings', '/calendar', '/schedule', '/internal', '/customer-meetings', '/recordings', '/notifications', '/reports', '/employees', '/organisation', '/admin', '/audit-log', '/api-docs', '/meeting-features', '/settings']
  } else routes = ['/dashboard', '/chat', '/chat?tab=calls', '/chat?tab=myday', '/chat?tab=notes', '/chat?tab=tasks']
  await ctx.close()
}
routes = [...new Set(routes)]
log(`${part}: ${routes.length} pages × ${SIZES.length} sizes`)

for (const size of SIZES) {
  const ctx = await browser.newContext({ ...size.ctx, baseURL: WEB, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['microphone'] })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await login(page, part === 'admin' ? ADMIN : HOST.email)
  for (const r of routes) {
    errors.length = 0
    try {
      await page.goto(r, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      await page.waitForTimeout(700)
      const a = await page.evaluate(audit)
      const name = `${part}-${size.name}${r.replace(/[/?=&]+/g, '-')}`
      await page.screenshot({ path: path.join(SHOTS, `pa-${name}.png`) })
      const bad = a.overflowX > 0 || a.clipped.length || a.outside.length || errors.length
      report.push({ size: size.name, route: r, ...a, errors: [...errors], shot: `pa-${name}.png` })
      if (bad) log(`  ✗ ${size.name} ${r}: overflowX=${a.overflowX} clipped=${a.clipped.length} outside=${a.outside.length} errors=${errors.length}`)
    } catch (e) {
      report.push({ size: size.name, route: r, failed: String(e.message).slice(0, 200) })
      log(`  ! ${size.name} ${r}: ${String(e.message).split('\n')[0]}`)
    }
  }
  await ctx.close()
}
await browser.close()
fs.writeFileSync(path.join(RESULTS, `portal-audit-${part}.json`), JSON.stringify(report, null, 2))
const bad = report.filter((x) => x.failed || x.overflowX > 0 || x.clipped?.length || x.outside?.length || x.errors?.length)
log(`${part}: ${report.length - bad.length}/${report.length} page views clean`)
for (const x of report.filter((r) => r.scrollers?.length)) log(`  ↔ ${x.size} ${x.route}: ${x.scrollers.join(' | ')}`)
