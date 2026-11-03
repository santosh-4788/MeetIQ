// Microsoft Edge (headless) through playwright-core. One browser, one context per signed-in role.
import { chromium } from 'playwright-core'
import { EDGE, HEADLESS, PASSWORD, WEB } from './config.mjs'
import { watch } from './runner.mjs'

let browser

export async function launch() {
  // One retry: Edge occasionally fails to start under heavy machine load.
  if (!browser?.isConnected()) {
    try {
      browser = await chromium.launch({ executablePath: EDGE, headless: HEADLESS })
    } catch {
      await new Promise((r) => setTimeout(r, 3000))
      browser = await chromium.launch({ executablePath: EDGE, headless: HEADLESS })
    }
  }
  return browser
}

/** Waits until no dialog is open (closing dialogs animate out and still cover the page for a moment). */
export async function dialogsClosed(page) {
  await page.waitForFunction(() => document.querySelectorAll('[data-oic-dialog]').length === 0, null, { timeout: 10_000 })
}

export async function closeBrowser() {
  await browser?.close()
  browser = undefined
}

/**
 * A browser context + page that records uncaught page errors and failed API calls (HTTP >= 500, or network failures),
 * so a case fails when the UI crashes or the API errors even if the visible check passed.
 */
export async function session({ width = 1440, height = 900, storageState } = {}) {
  const b = await launch()
  const context = await b.newContext({ baseURL: WEB, viewport: { width, height }, storageState, locale: 'en-IN', timezoneId: 'Asia/Kolkata', acceptDownloads: true })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.setDefaultNavigationTimeout(30_000) // first loads from the Vite dev server can be slow
  const events = []
  page.on('pageerror', (e) => events.push({ t: Date.now(), kind: 'pageerror', text: e.message }))
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/') && r.status() >= 500) events.push({ t: Date.now(), kind: 'api', text: `${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}` })
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) events.push({ t: Date.now(), kind: 'console', text: m.text().slice(0, 200) })
  })
  const s = {
    context,
    page,
    events,
    /** Errors since a time; `allow` = true ignores API 5xx (used by the API-down scenario). */
    errorsSince(t, allow) {
      return events.filter((e) => e.t >= t && (e.kind === 'pageerror' || (!allow && e.kind === 'api'))).map((e) => `${e.kind}: ${e.text}`)
    },
    async close() {
      await context.close().catch(() => {})
    },
  }
  watch(s)
  return s
}

/** Signs in through the real login form. Returns when the dashboard (or the expected path) is shown. */
export async function loginUI(page, login, password = PASSWORD, { expectPath = /\/dashboard/ } = {}) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(login)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  if (expectPath) await page.waitForURL(expectPath, { timeout: 15_000 })
}

/** New signed-in session for a role (re-used storage state per login to keep the run fast). */
const states = new Map()
export async function as(login, opts = {}) {
  const key = `${login}|${opts.width ?? 1440}`
  if (states.has(key) && !opts.fresh) {
    const s = await session({ ...opts, storageState: states.get(key) })
    await s.page.goto(opts.path ?? '/dashboard')
    // A stored session can be revoked by an earlier test: fall back to a fresh login.
    if (!/\/login|session-expired/.test(s.page.url())) {
      await s.page.waitForLoadState('networkidle').catch(() => {})
      if (!/\/login/.test(s.page.url())) return s
    }
    await s.close()
  }
  const s = await session(opts)
  await loginUI(s.page, login, opts.password ?? PASSWORD)
  states.set(key, await s.context.storageState())
  if (opts.path) await s.page.goto(opts.path)
  return s
}

export function forgetSessions() {
  states.clear()
}

/** Visible text of an element (normalised whitespace). */
export async function text(locator) {
  return ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim()
}

/** Waits until no request is in flight for a moment (best-effort). */
export async function settle(page, ms = 300) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

/** The toast region text. */
export async function toastText(page) {
  const t = page.locator('div[role="status"][aria-live="polite"]').last()
  await t.locator('p').first().waitFor({ timeout: 6000 })
  return text(t)
}

/** Polls `fn` until it returns a truthy value (or times out with `message`). */
export async function waitUntil(fn, message, timeout = 8000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn().catch(() => undefined)
    if (last) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out: ${message}`)
}
