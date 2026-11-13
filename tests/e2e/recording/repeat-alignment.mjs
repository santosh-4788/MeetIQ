// GoodDay #14213: Schedule meeting → "Repeat this meeting": Frequency / Repeat every / unit line up, and the Ends rows line up,
// at desktop and phone widths, for Daily / Weekly / Monthly. Measures element boxes (not just a screenshot).
// Isolated environment ONLY: web http://127.0.0.1:5176 (Vite, --mode api) → API https://localhost:7192 (LocalDB *_Rec).
// Run:  cd tests\e2e; node recording\repeat-alignment.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(HERE, 'results', 'screenshots', 'repeat-alignment')
const WEB = process.env.REC_WEB ?? 'http://127.0.0.1:5176'
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PASSWORD = 'Rec!Strong#Pass2026' // local test database only
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(WEB)) throw new Error('Local web server only.')
fs.mkdirSync(SHOTS, { recursive: true })
const results = []
const browser = await chromium.launch({ executablePath: EDGE, headless: true })

for (const [name, viewport] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await (await browser.newContext({ baseURL: WEB, viewport, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })).newPage()
  page.setDefaultTimeout(15_000)
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill('rekha.host@rec.oneinsure.test')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 })
  await page.goto('/schedule')
  await page.getByText('Repeat this meeting').click()
  const ed = page.getByTestId('recurrence-editor')
  await ed.waitFor()
  for (const pattern of ['DAILY', 'WEEKLY', 'MONTHLY']) {
    await page.getByTestId('repeat-frequency').selectOption(pattern)
    await page.waitForTimeout(150)
    const m = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.y + r.height / 2) } }
      const q = (id) => document.querySelector(`[data-testid="${id}"]`)
      const ed = q('recurrence-editor')
      const labelOf = (el) => el.closest('div.flex.flex-col')?.querySelector('label')
      const freq = q('repeat-frequency'), interval = q('repeat-interval'), unit = q('repeat-unit')
      const after = q('ends-after'), on = q('ends-on')
      const occ = [...ed.querySelectorAll('input[type=number]')].find((i) => i !== interval)
      const date = on.closest('label').parentElement.parentElement.querySelector('button')
      return {
        freq: box(freq), interval: box(interval), unit: box(unit), freqLabel: box(labelOf(freq)), intervalLabel: box(labelOf(interval)),
        afterRadio: box(after), occ: box(occ), onRadio: box(on), date: box(date),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    const issues = []
    const near = (a, b, tol, what) => { if (Math.abs(a - b) > tol) issues.push(`${what}: ${a} vs ${b}`) }
    const sameRow = m.interval.y < m.freq.y + m.freq.h // phone may wrap the row
    if (sameRow) {
      near(m.freq.y, m.interval.y, 1, 'Frequency box top vs Repeat every box top')
      near(m.freqLabel.y, m.intervalLabel.y, 1, 'Frequency label vs Repeat every label')
    }
    if (m.unit.y < m.interval.y + m.interval.h) near(m.unit.cy, m.interval.cy, 2, 'unit centre vs Repeat every box centre')
    near(m.afterRadio.cy, m.occ.cy, 2, 'After radio vs Occurrences box (centre)')
    near(m.onRadio.cy, m.date.cy, 2, 'On date radio vs End date box (centre)')
    near(m.occ.x, m.date.x, 1, 'Occurrences box left vs End date box left')
    if (m.overflow > 0) issues.push(`horizontal overflow ${m.overflow}px`)
    await ed.screenshot({ path: path.join(SHOTS, `${name}-${pattern.toLowerCase()}.png`) })
    results.push({ case: `${name} ${pattern}`, result: issues.length ? 'FAIL' : 'PASS', detail: issues.length ? issues.join('; ') : `boxes top ${m.freq.y}/${m.interval.y}${sameRow ? '' : ' (wrapped)'}; unit cy ${m.unit.cy}=${m.interval.cy}; Ends x ${m.occ.x}/${m.date.x}; radios cy ${m.afterRadio.cy}/${m.occ.cy}, ${m.onRadio.cy}/${m.date.cy}` })
    console.log(`${results.at(-1).result} ${name} ${pattern}: ${results.at(-1).detail}`)
  }
}
await browser.close()
const passed = results.filter((r) => r.result === 'PASS').length
console.log(`${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
