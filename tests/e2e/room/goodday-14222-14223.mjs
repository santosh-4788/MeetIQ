// GoodDay 14 Nov 2026:
//  #14223 "In mobile web access the schedule now call option not visible properly" - the phone header's "Schedule meeting" button
//         showed as an empty blue square (the + icon was squeezed to 8 px: cn() does not merge classes, px-4 beat px-0).
//  #14222 "If the customer has not given permission to camera and microphone, clicking the icons should redirect to settings" -
//         a web page cannot open the browser/phone settings; tapping a blocked device now opens an "Allow your …" dialog with the
//         steps for this phone, a Try again button, and the device turns on by itself once allowed.
//  #14217 "Remove this" (reopened again) - nothing at all under the Occurrences field any more (no red message, no hint).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14222-14223.mjs
import { chromium } from 'playwright-core'
import path from 'node:path'
import { Api, HOST, PASSWORD, SHOTS, WEB, check, closeAll, exec, loginUI, newPage, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const tag = Date.now().toString(36).slice(-5)
const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()

const ok = {}
let phone
ok.header = await tc('GD14223-01', '#14223 Phone header: the "Schedule meeting" button shows its + icon and opens Schedule', 'Icon ≥ 18 px wide, white on blue, inside the 40 px button; tap → /schedule', async () => {
  phone = await newPage({ width: 360, height: 780, mobile: true })
  await loginUI(phone, HOST.email)
  const btn = phone.getByTestId('header-schedule-mobile')
  await btn.waitFor()
  const m = await btn.evaluate((a) => {
    const r = (e) => e.getBoundingClientRect()
    const s = a.querySelector('svg')
    return { btnW: Math.round(r(a).width), btnH: Math.round(r(a).height), iconW: Math.round(r(s).width), iconH: Math.round(r(s).height), padL: getComputedStyle(a).paddingLeft, stroke: getComputedStyle(s).stroke }
  })
  await phone.screenshot({ path: path.join(SHOTS, 'gd14223-header.png'), clip: { x: 0, y: 0, width: 360, height: 90 } })
  check(m.iconW >= 18 && m.iconH >= 18, `icon ${m.iconW}×${m.iconH}`)
  check(m.btnW === 40 && m.btnH === 40 && m.padL === '0px', `button ${JSON.stringify(m)}`)
  check(m.stroke === 'rgb(255, 255, 255)', `icon colour ${m.stroke}`)
  await btn.click()
  await phone.waitForURL(/\/schedule$/)
  return JSON.stringify(m)
})

ok.occ = await tc('GD14217-01', '#14217 Repeat → After: nothing is shown under Occurrences (no red message, no hint); values are clamped; 2 occurrences schedule', 'typed 99→52, 1→2, empty→2, 2→2; no text under the field; schedules 2 meetings', async () => {
  const p = await newPage({ width: 1366, height: 900 })
  await loginUI(p, HOST.email)
  await p.goto('/schedule')
  const form = p.getByTestId('schedule-form')
  await form.getByLabel('Title', { exact: true }).fill(`GD14217 repeat ${tag}`)
  await form.getByLabel('Category').selectOption('INTERNAL_MEETING')
  await form.getByText('Repeat this meeting').click()
  const occ = p.getByTestId('occurrences')
  await occ.waitFor()
  await p.getByTestId('ends-after').check()
  const seen = []
  for (const [typed, expect] of [['99', '52'], ['1', '2'], ['', '2'], ['2', '2']]) {
    await occ.fill(typed)
    await occ.blur()
    const v = await occ.inputValue()
    seen.push(`${typed || '(empty)'}→${v}`)
    check(v === expect, `typed "${typed}" became "${v}" (expected ${expect})`)
    // The field's wrapper: label + input only - no hint or error paragraph.
    const under = await occ.evaluate((i) => [...i.closest('div.flex.flex-col, div')?.parentElement?.querySelectorAll('p') ?? []].map((x) => x.innerText.trim()).filter(Boolean))
    check(under.length === 0, `text under the field after "${typed}": ${JSON.stringify(under)}`)
  }
  check((await form.getByText(/Choose between 2 and|Between 2 and 52/).count()) === 0, 'an occurrences message or hint is still shown')
  await occ.scrollIntoViewIfNeeded()
  await p.screenshot({ path: path.join(SHOTS, 'gd14217-occurrences.png') })
  retire()
  await form.getByRole('button', { name: /Schedule recurring meeting|Schedule meeting/ }).click()
  await p.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 25_000 })
  const n = scalar(`SELECT COUNT(*) AS v FROM mtg.Meetings WHERE Title = N'GD14217 repeat ${tag}'`)
  check(Number(n) === 2, `${n} occurrences created (expected 2)`)
  return `${seen.join(', ')}; nothing under the field; scheduled ${n} occurrences`
})

// A phone browser where this site's camera and microphone are blocked (prompts denied, nothing granted).
let blocked, ctx, meetingId
ok.dialog = await tc('GD14222-01', '#14222 Microphone blocked: tapping the mic opens "Allow your microphone" with Android steps (no toast)', 'Dialog with numbered steps (address-bar icon → Permissions → Allow) and the phone-settings fallback; no microphone toast', async () => {
  retire()
  const b = await chromium.launch({ executablePath: EDGE, headless: process.env.E2E_HEADED !== '1', args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'] })
  ctx = await b.newContext({ baseURL: WEB, viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  blocked = await ctx.newPage(); blocked.setDefaultTimeout(20_000)
  blocked.on('close', () => b.close().catch(() => {}))
  await loginUI(blocked, HOST.email)
  const api = await new Api().login(HOST.email)
  const created = await api.req('POST', '/meetings/instant', { title: `GD14222 ${tag}` })
  check(created.status === 200 || created.status === 201, `instant ${created.status}`)
  meetingId = created.data.id
  await blocked.goto(`/meetings/${meetingId}/room`)
  await blocked.getByRole('button', { name: /Start meeting|Join/ }).first().click()
  await blocked.locator('[data-testid="meeting-room"]').waitFor({ timeout: 30_000 })
  await blocked.keyboard.press('Escape').catch(() => {})
  // Joining with a blocked microphone may already open the dialog (the pre-join choice): close it, then tap the icon.
  await sleep(2500)
  if (await blocked.getByTestId('device-help').count()) await blocked.getByTestId('device-help-close').click()
  await blocked.getByTestId('ctl-mic').click()
  const dlg = blocked.getByTestId('device-help')
  await dlg.waitFor({ timeout: 10_000 })
  check((await dlg.getAttribute('data-kind')) === 'microphone', `kind ${await dlg.getAttribute('data-kind')}`)
  const title = await blocked.getByRole('dialog').getByRole('heading').first().innerText()
  const steps = await blocked.getByTestId('device-help-steps').locator('li').allInnerTexts()
  const text = await dlg.innerText()
  await blocked.screenshot({ path: path.join(SHOTS, 'gd14222-mic-dialog.png') })
  check(/Allow your microphone/.test(title), `title "${title}"`)
  check(steps.length === 3 && /left of the web address/.test(steps[0]) && /Permissions/.test(steps[1]) && /Microphone to Allow/.test(steps[2]), `steps ${JSON.stringify(steps)}`)
  check(/Settings → Apps → Chrome → Permissions → Microphone/.test(text), 'phone-settings fallback missing')
  const toasts = (await blocked.locator('[role="status"][aria-live="polite"] > *').allInnerTexts()).filter((t) => /microphone/i.test(t))
  check(toasts.length === 0, `microphone toast(s) as well: ${JSON.stringify(toasts)}`)
  return `"${title}"; steps: ${steps.map((s) => s.replace(/^\d+\s*/, '')).join(' | ')}`
})

ok.retry = await tc('GD14222-02', '#14222 Still blocked → Try again explains; camera opens its own dialog', '"still blocked" notice after Try again; camera icon → "Allow your camera"', async () => {
  await blocked.getByTestId('device-help-retry').click()
  await blocked.getByTestId('device-help-still-blocked').waitFor({ timeout: 10_000 })
  await blocked.getByTestId('device-help-close').click()
  await blocked.getByTestId('device-help').waitFor({ state: 'detached' })
  await blocked.getByTestId('ctl-cam').click()
  const dlg = blocked.getByTestId('device-help')
  await dlg.waitFor({ timeout: 10_000 })
  check((await dlg.getAttribute('data-kind')) === 'camera', `kind ${await dlg.getAttribute('data-kind')}`)
  check(/Set Camera to Allow/.test(await dlg.innerText()), 'camera steps missing')
  await blocked.getByTestId('device-help-close').click()
  return 'Try again → "still blocked" notice; camera → "Allow your camera" with camera steps'
})

ok.allow = await tc('GD14222-03', '#14222 User allows the microphone: the device turns on (by itself, or with Try again)', 'After granting, the dialog closes and the mic is on', async () => {
  await blocked.getByTestId('ctl-mic').click()
  await blocked.getByTestId('device-help').waitFor({ timeout: 10_000 })
  await ctx.grantPermissions(['microphone'], { origin: new URL(WEB).origin })
  let how = 'by itself'
  try {
    await blocked.getByTestId('device-help').waitFor({ state: 'detached', timeout: 6000 })
  } catch {
    how = 'after Try again (this browser did not report the change)'
    await blocked.getByTestId('device-help-retry').click()
    await blocked.getByTestId('device-help').waitFor({ state: 'detached', timeout: 10_000 })
  }
  await until(async () => (await blocked.getByTestId('ctl-mic').getAttribute('aria-pressed')) === 'true', 'microphone not on after allowing', 10_000)
  await blocked.screenshot({ path: path.join(SHOTS, 'gd14222-mic-on.png') })
  return `dialog closed and microphone on ${how}`
})

if (meetingId) await new Api().login(HOST.email).then((a) => a.req('POST', `/meetings/${meetingId}/room/end`, {})).catch(() => {})
await blocked?.close().catch(() => {})
await closeAll()
writeResults('goodday-14222-14223')
