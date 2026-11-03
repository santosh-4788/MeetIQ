// Shared helpers for the isolated video-room browser tests (same environment as room.mjs: LocalDB *_Room, API 7191, Vite 5175,
// local LiveKit 7880). room.mjs keeps its own copy of these helpers; new room scenarios import this module.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RESULTS = path.join(HERE, 'results')
export const SHOTS = path.join(RESULTS, 'screenshots')
export const WEB = process.env.ROOM_WEB ?? 'http://127.0.0.1:5175'
export const DB = process.env.ROOM_DB ?? 'OneInsureVideoMeetingDB_Room'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const HEADLESS = process.env.E2E_HEADED !== '1'
export const PASSWORD = 'Room!Strong#Pass2026' // local test database only (scripts/setup-room-db.ps1)
export const HOST = { email: 'hema.host@room.oneinsure.test', name: 'Hema Host' }
export const EMP = { email: 'esha.employee@room.oneinsure.test', name: 'Esha Employee' }

if (!/_Room$/.test(DB)) throw new Error('Only a database whose name ends in _Room may be used.')
if (/:7180|:5173/.test(WEB)) throw new Error('Never run against the developer instance (7180/5173).')
fs.mkdirSync(SHOTS, { recursive: true })

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

export function sql(select) {
  const out = execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-y', '0', '-Q',
    `SET NOCOUNT ON; SELECT (SELECT * FROM (${select.replace(/\s*\r?\n\s*/g, ' ')}) q FOR JSON PATH, INCLUDE_NULL_VALUES) AS j`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const lines = out.split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith('[') || l.trim() === 'NULL')
  const json = start < 0 ? '' : lines.slice(start).join('').trim()
  return !json || json === 'NULL' ? [] : JSON.parse(json)
}
export const scalar = (select) => Object.values(sql(select)[0] ?? { v: null })[0]
export const exec = (statement) => execFileSync('sqlcmd', ['-S', '(localdb)\\MSSQLLocalDB', '-d', DB, '-E', '-b', '-I', '-Q', statement])

/** API client through the Vite proxy (cookie session + XSRF like the SPA). */
export class Api {
  jar = new Map()
  async req(method, p, body) {
    const headers = { Accept: 'application/json' }
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET' && this.jar.has('XSRF-TOKEN')) headers['X-XSRF-TOKEN'] = decodeURIComponent(this.jar.get('XSRF-TOKEN'))
    const r = await fetch(`${WEB}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(';')[0]
      const i = kv.indexOf('=')
      this.jar.set(kv.slice(0, i), kv.slice(i + 1))
    }
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

export const results = []
export const pages = []
export async function tc(id, title, expected, fn) {
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
      } catch { /* page closed */ }
    }
    results.push({ id, title, expected, actual: String(e?.message ?? e).slice(0, 1500), result: 'FAIL', screenshots: shots, ms: Date.now() - t0 })
    log(`  FAIL ${id}: ${e?.message ?? e}`)
    return false
  }
}
export const check = (cond, msg) => { if (!cond) throw new Error(msg) }
export async function until(fn, msg, ms = 20_000, every = 500) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`${msg} (timed out after ${ms} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

// Fake camera: the same small Y4M clip as room.mjs (generated there on first run).
const CAM = path.join(RESULTS, 'fake-camera.y4m')
const browsers = []
export async function newPage({ width = 1366, height = 820, mobile = false } = {}) {
  if (!fs.existsSync(CAM)) throw new Error('results/fake-camera.y4m missing: run room.mjs once first.')
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: HEADLESS,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAM}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  browsers.push(browser)
  const context = await browser.newContext({ baseURL: WEB, viewport: { width, height }, isMobile: mobile, hasTouch: mobile, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['camera', 'microphone'] })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = function (...args) {
      const pc = new Orig(...args)
      window.__pcs.push(pc)
      return pc
    }
    window.RTCPeerConnection.prototype = Orig.prototype
  })
  page.on('pageerror', (e) => log(`  [pageerror ${pages.indexOf(page)}] ${e.message}`))
  pages.push(page)
  return page
}
export const closeAll = async () => { for (const b of browsers) await b.close().catch(() => {}) }
/** Closes one participant's browser (frees CPU: every open room decodes everyone's video). */
export const closePage = async (page) => {
  pages.splice(pages.indexOf(page), 1)
  await page?.context().browser()?.close().catch(() => {})
}

export const inbound = (page) => page.evaluate(async () => {
  const out = { audio: 0, video: 0 }
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue
    for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.bytesReceived) out[s.kind] += s.bytesReceived
  }
  return out
})

export const tileVideo = (page, identity) => page.evaluate((id) => {
  const v = document.querySelector(`[data-identity="${id}"] video[data-testid="video-camera"]`)
  return v ? { w: v.videoWidth, h: v.videoHeight } : null
}, identity)

export async function loginUI(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
}

export const view = (page, name) => page.screenshot({ path: path.join(SHOTS, `view-${name}.png`) }).catch(() => {})

/** No horizontal page scroll (mobile layout check). */
export const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

export function writeResults(name, extra = {}) {
  const passed = results.filter((r) => r.result === 'PASS').length
  const summary = { runUtc: new Date().toISOString(), web: WEB, database: DB, ...extra, passed, failed: results.length - passed, results }
  fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(RESULTS, `${name}-summary.md`),
    `# ${name} — ${summary.runUtc}\n\n${passed}/${results.length} passed (Edge headless, fake media)\n\n| Id | Case | Result | Actual |\n|---|---|---|---|\n` +
    results.map((r) => `| ${r.id} | ${r.title} | ${r.result} | ${String(r.actual).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n') + '\n')
  log(`${passed}/${results.length} passed`)
  return passed === results.length
}
