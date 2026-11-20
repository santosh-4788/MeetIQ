// iOS-style Chat, Calls, My Day, Notes and Tasks (20 Nov 2026) on three screens: a computer (Edge), an Android phone
// (Chromium with Android phone settings) and an iPhone (WebKit, the Safari engine, with iPhone settings).
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175). Screenshots: results/screenshots/ios-*.png
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\ios-look.mjs
setTimeout(() => { console.log('WATCHDOG: test still running after 9 min - giving up'); process.exit(2) }, 9 * 60_000).unref()
import path from 'node:path'
import { chromium, devices, webkit } from 'playwright-core'
import { EMP, HOST, PASSWORD, SHOTS, WEB, check, exec, log, results, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const THIRD = { email: 'tst.e1@room.oneinsure.test', name: 'Test Emp One' }
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS')")
const tasksSwitch = scalar("SELECT COUNT(*) AS n FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_TASKS'")
if (tasksSwitch) exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT_TASKS'")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
exec("UPDATE auth.Users SET PasswordHash = (SELECT PasswordHash FROM auth.Users WHERE Email = 'hema.host@room.oneinsure.test') WHERE Email = 'tst.e1@room.oneinsure.test'")
const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browsers = []
const tag = Date.now().toString(36).slice(-5)

async function open(kind) {
  let ctx
  if (kind === 'iphone') {
    const b = await webkit.launch({ headless: true })
    browsers.push(b)
    ctx = await b.newContext({ ...devices['iPhone 14'], baseURL: WEB, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  } else {
    const b = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
    browsers.push(b)
    ctx = kind === 'android'
      ? await b.newContext({ ...devices['Pixel 7'], baseURL: WEB, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['microphone'] })
      : await b.newContext({ baseURL: WEB, viewport: { width: 1366, height: 860 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata', permissions: ['microphone'] })
  }
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e) => log(`  [pageerror ${kind}] ${e.message}`))
  return page
}
async function login(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/dashboard|change-password/, { timeout: 30_000 })
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `ios-${name}.png`) })
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
async function openChat(page, name, phone) {
  await page.goto('/chat')
  await page.getByTestId('chat-page').waitFor()
  await page.getByTestId('chat-new').click()
  await page.getByRole('dialog', { name: 'New chat' }).getByLabel('Search colleagues').fill(name.includes('One') ? 'Emp One' : name.split(' ')[0])
  await page.getByTestId('chat-person').filter({ hasText: name }).first().click()
  await until(async () => (await page.getByTestId('chat-title').innerText()) === name, `chat with ${name} not open`)
  if (phone) check(await page.getByTestId('chat-back').isVisible(), 'phone: no back button')
}

const desk = await open('desktop')
const android = await open('android')
const iphone = await open('iphone')
await login(desk, HOST.email)
await login(android, EMP.email)
await login(iphone, THIRD.email)

for (const [name, page, phone] of [['desktop', desk, false], ['android', android, true], ['iphone', iphone, true]]) {
  await tc(`IOS-${name}-1`, `Chat list and conversation in the iOS look (${name})`, 'large title, segmented control, search, bubbles with tails, composer; no sideways scrolling', async () => {
    await page.goto('/chat')
    await page.getByTestId('chat-page').waitFor()
    await page.locator('.ios-large-title').first().waitFor()
    await page.getByTestId('chat-section-calls').waitFor()
    check(await page.locator('.ios-seg').count() > 0, 'no segmented control')
    await shot(page, `${name}-1-list`)
    const other = name === 'desktop' ? EMP.name : name === 'android' ? THIRD.name : HOST.name
    await openChat(page, other, phone)
    await page.getByTestId('chat-input').fill(`iOS look check from ${name} ${tag}`)
    await page.getByTestId('chat-send').click()
    const mine = page.getByTestId('chat-message').filter({ hasText: `iOS look check from ${name} ${tag}` }).last()
    await mine.waitFor()
    const bubble = mine.locator('.ios-bubble')
    const bg = await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)
    check(bg === 'rgb(0, 122, 255)', `my bubble is not iOS blue (${bg})`)
    await until(async () => (await mine.getByLabel(/Sent|Delivered|Read/).count()) > 0, 'no tick')
    check(await overflowX(page) <= 0, `page scrolls sideways by ${await overflowX(page)} px`)
    await shot(page, `${name}-2-conversation`)
  })
}

await tc('IOS-sheet', 'Phones: tapping a message opens the iOS action sheet (Android and iPhone)', 'sheet with quick reactions, Reply, Copy, Forward, Cancel; a reaction is saved', async () => {
  for (const [name, page] of [['android', android], ['iphone', iphone]]) {
    const msg = page.getByTestId('chat-message').filter({ hasText: `iOS look check from ${name} ${tag}` }).last()
    await msg.locator('.ios-bubble').click()
    const sheet = page.getByTestId('chat-action-sheet')
    await sheet.waitFor()
    await sleep(400) // slide-in animation
    for (const label of ['Reply', 'Forward']) check(await sheet.getByRole('button', { name: label, exact: true }).count() === 1, `${name}: sheet has no ${label}`)
    const box = await sheet.locator('.ios-sheet-group').last().boundingBox()
    const vp = page.viewportSize()
    check(box && box.y + box.height <= vp.height + 1 && box.x >= 0 && box.x + box.width <= vp.width + 1, `${name}: sheet is off screen`)
    await shot(page, `${name}-3-action-sheet`)
    await sheet.getByRole('button', { name: 'React 👍' }).click()
    await msg.getByTestId('chat-reaction').waitFor()
    check(await sheet.count() === 0, `${name}: sheet still open after reacting`)
  }
})

await tc('IOS-calls', 'Calls in the iOS look: iPhone full-screen incoming call, Android full-screen call, computer card', 'incoming screen fills the iPhone; Decline works; Android answers and sees the full-screen call; minimise to the green pill', async () => {
  // Computer calls the iPhone user: full-screen incoming call on the iPhone, then Decline.
  await openChat(desk, THIRD.name, false)
  await desk.getByTestId('chat-call').click()
  const pop = iphone.getByTestId('call-incoming')
  await pop.waitFor({ timeout: 20_000 })
  await sleep(500)
  const box = await pop.boundingBox()
  const vp = iphone.viewportSize()
  check(box && box.width >= vp.width - 1 && box.height >= vp.height - 1, `iPhone: incoming call is not full screen (${JSON.stringify(box)})`)
  await shot(iphone, 'iphone-4-incoming-call')
  await shot(desk, 'desktop-4-calling')
  await pop.getByTestId('call-decline').click()
  await until(async () => /declined/i.test(await desk.getByTestId('call-panel').innerText()), 'caller not told "declined"', 15_000)
  await desk.getByTestId('call-panel').waitFor({ state: 'detached', timeout: 20_000 })

  // Computer calls the Android user: answer, full-screen call, minimise to the pill, then hang up.
  await openChat(desk, EMP.name, false)
  await desk.getByTestId('chat-call').click()
  const apop = android.getByTestId('call-incoming')
  await apop.waitFor({ timeout: 20_000 })
  await shot(android, 'android-4-incoming-call')
  await apop.getByTestId('call-accept').click()
  const panel = android.getByTestId('call-panel')
  await until(async () => /\d:\d\d/.test(await panel.getByTestId('call-status').innerText()), 'Android call not connected', 25_000)
  const pbox = await panel.boundingBox()
  check(pbox && pbox.height >= android.viewportSize().height - 1, 'Android: in-call screen is not full screen')
  await shot(android, 'android-5-in-call')
  await shot(desk, 'desktop-5-in-call')
  await panel.getByRole('button', { name: 'Minimise the call' }).click()
  await until(async () => ((await panel.boundingBox())?.height ?? 999) < 80, 'call did not shrink to the pill')
  await shot(android, 'android-6-call-pill')
  await panel.getByTestId('call-hangup').click()
  await panel.waitFor({ state: 'detached', timeout: 20_000 })
})

await tc('IOS-calls-tab', 'Calls tab (Recents) on the three screens', 'list in the iOS Recents style; no sideways scrolling', async () => {
  for (const [name, page] of [['desktop', desk], ['android', android], ['iphone', iphone]]) {
    await page.goto('/chat?tab=calls')
    await page.getByTestId('call-history').waitFor()
    await page.getByTestId('call-history-item').first().waitFor()
    check(await overflowX(page) <= 0, `${name}: sideways scrolling`)
    await shot(page, `${name}-7-calls-tab`)
  }
})

if (tasksSwitch && !process.env.SKIP_WORK) {
  for (const [name, page] of [['desktop', desk], ['android', android], ['iphone', iphone]]) {
    await tc(`IOS-${name}-work`, `My Day, Tasks and Notes in the iOS look (${name})`, 'all three sections render with the segmented control; editors open as iOS sheets; no sideways scrolling', async () => {
      await page.goto('/chat?tab=myday')
      await page.getByTestId('myday-view').waitFor()
      await page.getByTestId('myday-today').waitFor()
      check(await overflowX(page) <= 0, `${name}: My Day scrolls sideways`)
      await shot(page, `${name}-8-myday`)
      await page.goto('/tasks')
      await page.getByTestId('tasks-view').waitFor()
      await page.getByTestId('task-new').click()
      const ed = page.getByTestId('task-editor')
      await ed.waitFor()
      const box = await ed.locator('.ios-sheet-up').boundingBox()
      const vp = page.viewportSize()
      check(box && box.x >= 0 && box.x + box.width <= vp.width + 1, `${name}: task sheet off screen`)
      await shot(page, `${name}-9-task-editor`)
      await ed.getByRole('button', { name: 'Cancel' }).click()
      await page.goto('/notes')
      await page.getByTestId('notes-view').waitFor()
      check(await overflowX(page) <= 0, `${name}: Notes scrolls sideways`)
      await shot(page, `${name}-10-notes`)
    })
  }
}

for (const b of browsers) await b.close().catch(() => {})
writeResults('ios-look')
log(`${results.filter((r) => r.result === 'PASS').length}/${results.length} passed`)
process.exit(results.every((r) => r.result === 'PASS') ? 0 : 1)
await sleep(0)
