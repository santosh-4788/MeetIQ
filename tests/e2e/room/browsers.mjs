// Cross-browser check of Chat, Calls, My Day, Notes and Tasks (20 Nov 2026), every scenario on every screen:
//   chrome-desktop (Google Chrome), edge-desktop (Microsoft Edge), safari-desktop (WebKit = Safari engine, Mac settings),
//   android-chrome (Chrome, Pixel 7), android-small (Chrome, Galaxy S8 360 px), iphone (WebKit, iPhone 14),
//   iphone-se (WebKit, iPhone SE 375 px), ipad (WebKit, iPad).
// Esha uses the browser under test; Hema (Edge on a computer + API) sends messages and places calls.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\browsers.mjs [profile ...]
setTimeout(() => { console.log('WATCHDOG: test still running after 9.5 min - giving up'); process.exit(2) }, 570_000).unref()
import fs from 'node:fs'
import path from 'node:path'
import { chromium, devices, webkit } from 'playwright-core'
import { Api, EMP, HOST, PASSWORD, RESULTS, SHOTS, WEB, check, exec, log, scalar, sleep, until } from './harness.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const PROFILES = {
  'chrome-desktop': { engine: 'chromium', exe: CHROME, ctx: { viewport: { width: 1440, height: 900 } }, phone: false, media: true },
  'edge-desktop': { engine: 'chromium', exe: EDGE, ctx: { viewport: { width: 1366, height: 768 } }, phone: false, media: true },
  'safari-desktop': { engine: 'webkit', ctx: { viewport: { width: 1440, height: 900 }, userAgent: MAC_SAFARI }, phone: false, media: false },
  'android-chrome': { engine: 'chromium', exe: CHROME, ctx: devices['Pixel 7'], phone: true, media: true },
  'android-small': { engine: 'chromium', exe: CHROME, ctx: devices['Galaxy S8'], phone: true, media: true },
  iphone: { engine: 'webkit', ctx: devices['iPhone 14'], phone: true, media: false },
  'iphone-se': { engine: 'webkit', ctx: devices['iPhone SE'], phone: true, media: false },
  ipad: { engine: 'webkit', ctx: devices['iPad (gen 7)'], phone: false, touch: true, media: false },
}
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROFILES)
for (const p of chosen) if (!PROFILES[p]) throw new Error(`unknown profile ${p}`)

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS')")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
// Answer any reminders left over from earlier runs so only this run's popups show.
exec("UPDATE chat.TRN_ChatReminder SET [State] = 'DISMISSED', AcknowledgedUtc = SYSUTCDATETIME() WHERE [State] IN ('FIRED') AND AcknowledgedUtc IS NULL")
const tag = Date.now().toString(36).slice(-5)
const results = []
const browsers = []
const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
const BENIGN = /due to access control checks|Load failed|The operation was aborted|AbortError|Failed to fetch dynamically imported module/i

async function launch(profile) {
  const b = profile.engine === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ executablePath: profile.exe, headless: true, args: MEDIA_ARGS })
  browsers.push(b)
  const ctx = await b.newContext({ ...profile.ctx, baseURL: WEB, locale: 'en-IN', timezoneId: 'Asia/Kolkata', ...(profile.engine === 'chromium' ? { permissions: ['microphone', 'notifications'] } : {}) })
  const page = await ctx.newPage()
  page.setDefaultTimeout(15_000)
  page.errors = []
  page.on('pageerror', (e) => { if (!BENIGN.test(e.message)) page.errors.push(e.message) })
  return page
}
async function login(page, email) {
  await page.goto('/login')
  await page.getByLabel('Official Email / Employee ID').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL(/dashboard/, { timeout: 30_000 })
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `br-${name}.png`) }).catch(() => {})
async function noOverflow(page, where) {
  const o = await overflowX(page)
  check(o <= 0, `${where}: page scrolls sideways by ${o} px`)
}

// Hema: a computer page on the chat with Esha (to place calls) + an API session (to send messages).
const hemaApi = await new Api().login(HOST.email)
const eshaId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS id FROM auth.Users WHERE Email = '${EMP.email}'`)
const conv = (await hemaApi.req('POST', '/chat/direct', { userId: eshaId })).data.id
const hema = await launch(PROFILES['edge-desktop'])
await login(hema, HOST.email)
await hema.goto(`/chat?c=${conv}`)
await hema.getByTestId('chat-view').waitFor()

let currentPage = null
async function scenario(profileName, id, title, fn) {
  const t0 = Date.now()
  try {
    const actual = await fn()
    results.push({ profile: profileName, id, title, result: 'PASS', actual: actual ?? 'as expected', ms: Date.now() - t0 })
    log(`  PASS ${profileName} ${id} ${title}${actual ? ' — ' + actual : ''}`)
  } catch (e) {
    results.push({ profile: profileName, id, title, result: 'FAIL', actual: String(e?.message ?? e).slice(0, 600), ms: Date.now() - t0 })
    await shot(currentPage, `${profileName}-${id}-FAIL`)
    await currentPage?.keyboard.press('Escape').catch(() => {})
    log(`  FAIL ${profileName} ${id} ${title}: ${String(e?.message ?? e).split('\n')[0]}`)
  }
}

for (const name of chosen) {
  const P = PROFILES[name]
  log(`▶ ${name}`)
  const page = await launch(P)
  currentPage = page
  const t = `${name}-${tag}`
  await scenario(name, 'B01', 'Sign in and reach Chat from the menu', async () => {
    await login(page, EMP.email)
    if (P.phone) await page.getByTestId('mobile-tabbar').getByTestId('tab-chat').click()
    else {
      const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ })
      if (await link.isVisible().catch(() => false)) await link.click()
      else await page.goto('/chat') // tablets: the menu is behind the menu button
    }
    await page.getByTestId('chat-page').waitFor()
    for (const k of ['chats', 'calls']) await page.getByTestId('chat-section-' + k).waitFor()
    check(await page.getByTestId('chat-section-tasks').count() === 0, 'My Day / Notes / Tasks still in the chat switcher')
    await noOverflow(page, 'chat list')
    await shot(page, `${name}-1-list`)
  })
  await scenario(name, 'B02', 'Open the chat, send a message, receive one live', async () => {
    await page.goto(`/chat?c=${conv}`)
    await page.getByTestId('chat-view').waitFor()
    if (P.phone) check(await page.getByTestId('chat-back').isVisible(), 'no Back button on the phone')
    await page.getByTestId('chat-input').fill(`Hello from ${t}`)
    await page.getByTestId('chat-send').click()
    const mine = page.getByTestId('chat-message').filter({ hasText: `Hello from ${t}` }).last()
    await mine.waitFor()
    const bg = await mine.locator('.ios-bubble').evaluate((el) => getComputedStyle(el).backgroundColor)
    check(bg === 'rgb(0, 122, 255)', `my bubble is ${bg}, not iOS blue`)
    await until(async () => (await mine.getByLabel(/Sent|Delivered|Read/).count()) > 0, 'no tick on my message')
    const r = await hemaApi.req('POST', `/chat/conversations/${conv}/messages`, { body: `Please share the report tomorrow ${t}`, clientMessageId: crypto.randomUUID() })
    check(r.status === 200 || r.status === 201, `Hema could not send: ${r.status}`)
    await page.getByTestId('chat-message').filter({ hasText: `Please share the report tomorrow ${t}` }).waitFor({ timeout: 10_000 })
    await noOverflow(page, 'conversation')
    await shot(page, `${name}-2-conversation`)
  })
  await scenario(name, 'B03', 'Message actions: react and reply (toolbar on computers, action sheet on phones)', async () => {
    const theirs = page.locator('[data-testid="chat-message"]:not([data-mine])').filter({ hasText: `Please share the report tomorrow ${t}` }).last()
    if (P.phone || P.touch) {
      await theirs.locator('.ios-bubble').click()
      const sheet = page.getByTestId('chat-action-sheet')
      await sheet.waitFor()
      await sleep(350)
      const box = await sheet.locator('.ios-sheet-group').last().boundingBox()
      const vp = page.viewportSize()
      check(box && box.y + box.height <= vp.height + 1 && box.x >= 0 && box.x + box.width <= vp.width + 1, 'action sheet does not fit the screen')
      await shot(page, `${name}-3-sheet`)
      await sheet.getByRole('button', { name: 'React 👍' }).click()
      await theirs.getByTestId('chat-reaction').waitFor()
      await theirs.locator('.ios-bubble').click()
      await page.getByTestId('chat-action-sheet').getByRole('button', { name: 'Reply', exact: true }).click()
    } else {
      await theirs.locator('.ios-bubble').hover()
      await theirs.getByRole('button', { name: 'React', exact: true }).click()
      await page.getByTestId('chat-quick-reactions').getByRole('button', { name: 'React 👍' }).click()
      await theirs.getByTestId('chat-reaction').waitFor()
      await theirs.locator('.ios-bubble').hover()
      await theirs.getByRole('button', { name: 'Reply', exact: true }).click()
    }
    await page.getByTestId('chat-replying').waitFor()
    await page.getByTestId('chat-input').fill(`Sure ${t}`)
    await page.getByTestId('chat-send').click()
    await page.getByTestId('chat-message').filter({ hasText: `Sure ${t}` }).last().waitFor()
  })
  await scenario(name, 'B04', 'Emoji picker inserts an emoji', async () => {
    await page.getByRole('button', { name: 'Emoji', exact: true }).click()
    const picker = page.getByTestId('emoji-picker')
    await picker.waitFor()
    const box = await picker.boundingBox()
    const vp = page.viewportSize()
    check(box && box.x >= -1 && box.x + box.width <= vp.width + 1, 'emoji picker goes off the screen')
    await picker.getByLabel('Search emoji').fill('party')
    await picker.getByRole('button', { name: '🎉' }).first().click()
    check((await page.getByTestId('chat-input').inputValue()).includes('🎉'), 'emoji not inserted')
    await page.getByTestId('chat-input').fill('')
    await page.keyboard.press('Escape').catch(() => {})
  })
  await scenario(name, 'B05', 'Send a file (checked by the antivirus)', async () => {
    const file = path.join(RESULTS, `br-${t}.txt`)
    fs.writeFileSync(file, `cross-browser file ${t}`)
    await page.getByTestId('chat-file-input').setInputFiles(file)
    const msg = page.getByTestId('chat-message').filter({ hasText: `br-${t}.txt` }).last()
    await msg.waitFor({ timeout: 20_000 })
    await until(async () => (await msg.getByTestId('chat-file').count()) > 0, 'file not cleared by the scan', 25_000)
  })
  await scenario(name, 'B06', 'Search inside the chat', async () => {
    if (P.phone) {
      await page.getByRole('button', { name: 'More options' }).click()
      await page.getByTestId('chat-menu').getByRole('menuitem', { name: /Search in chat/ }).click()
    } else await page.getByRole('button', { name: 'Search in this chat' }).click()
    await page.getByTestId('chat-search').getByLabel('Search in this chat').fill(`report tomorrow ${t}`)
    await page.getByTestId('chat-search-result').first().waitFor({ timeout: 10_000 })
    await page.getByTestId('chat-search').getByRole('button', { name: 'Close search' }).click()
  })
  await scenario(name, 'B07', 'Follow-up task from the message', async () => {
    const theirs = page.locator('[data-testid="chat-message"]:not([data-mine])').filter({ hasText: `Please share the report tomorrow ${t}` }).last()
    if (P.phone || P.touch) {
      await theirs.locator('.ios-bubble').click()
      await page.getByTestId('chat-action-sheet').getByRole('button', { name: 'Create task or reminder' }).click()
    } else {
      await theirs.locator('.ios-bubble').hover()
      await theirs.getByRole('button', { name: 'Create task or reminder' }).click()
    }
    const ed = page.getByTestId('task-editor')
    await ed.waitFor()
    check((await ed.innerText()).includes(`report tomorrow ${t}`), 'editor does not show the message')
    await sleep(300)
    await shot(page, `${name}-4-follow-up`)
    await ed.getByTestId('sheet-done').click()
    await ed.waitFor({ state: 'detached' })
    await until(() => scalar(`SELECT COUNT(*) AS n FROM chat.TRN_ChatTask WHERE Title LIKE '%report tomorrow ${t}%' AND SourceMessageId IS NOT NULL`) === 1, 'follow-up not saved with the message')
  })
  await scenario(name, 'B08', 'Incoming call from Hema' + (P.media ? ': answer, connected, hang up' : ': popup, decline, caller told'), async () => {
    if (P.phone) await page.goto('/chat') // ringing works on any page
    await hema.getByTestId('chat-call').click()
    const pop = page.getByTestId('call-incoming')
    await pop.waitFor({ timeout: 20_000 })
    await sleep(400)
    if (P.phone) {
      const box = await pop.boundingBox()
      const vp = page.viewportSize()
      check(box && box.width >= vp.width - 1 && box.height >= vp.height - 1, 'incoming call is not full screen on the phone')
    }
    await noOverflow(page, 'incoming call')
    await shot(page, `${name}-5-incoming`)
    if (P.media) {
      await pop.getByTestId('call-accept').click()
      const panel = page.getByTestId('call-panel')
      await until(async () => /\d:\d\d/.test(await panel.getByTestId('call-status').innerText()), 'call not connected', 25_000)
      await shot(page, `${name}-6-in-call`)
      await panel.getByTestId('call-hangup').click()
      await panel.waitFor({ state: 'detached', timeout: 20_000 })
    } else {
      await pop.getByTestId('call-decline').click()
      await until(async () => /declined/i.test(await hema.getByTestId('call-panel').innerText()), 'Hema not told "declined"', 15_000)
    }
    await hema.getByTestId('call-panel').waitFor({ state: 'detached', timeout: 20_000 })
  })
  await scenario(name, 'B09', 'Calls tab', async () => {
    await page.goto('/chat?tab=calls')
    await page.getByTestId('call-history-item').first().waitFor()
    await noOverflow(page, 'calls tab')
  })
  await scenario(name, 'B10', 'Task with a reminder: popup from the server, Postpone, then Complete', async () => {
    await page.goto('/chat?tab=tasks')
    await page.getByTestId('tasks-view').waitFor()
    await page.getByTestId('task-new').click()
    const ed = page.getByTestId('task-editor')
    await ed.getByTestId('task-title').fill(`Reminder check ${t}`)
    if (!(await ed.getByTestId('field-due-on').isChecked())) await ed.getByTestId('field-due-on').click()
    await ed.getByTestId('field-time-on').click()
    const now = new Date()
    await ed.getByTestId('field-due-time').fill(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
    await ed.getByTestId('field-reminder').selectOption('at')
    await ed.getByRole('tab', { name: 'Urgent' }).click()
    await sleep(300)
    await shot(page, `${name}-7-task-editor`)
    await ed.getByTestId('sheet-done').click()
    await ed.waitFor({ state: 'detached' })
    const pop = page.getByTestId('reminder-popup')
    await pop.filter({ hasText: `Reminder check ${t}` }).waitFor({ timeout: 35_000 })
    const box = await pop.boundingBox()
    const vp = page.viewportSize()
    check(box && box.x >= 0 && box.x + box.width <= vp.width + 1, 'reminder popup does not fit the screen')
    await shot(page, `${name}-8-reminder`)
    await pop.getByTestId('reminder-snooze').click()
    await pop.getByTestId('snooze-5').click()
    await until(() => scalar(`SELECT COUNT(*) AS n FROM chat.TRN_ChatReminder r JOIN chat.TRN_ChatTask k ON k.TaskId = r.TaskId WHERE k.Title = 'Reminder check ${t}' AND r.[State] = 'PENDING'`) === 1, 'postpone not saved')
    const row = page.getByTestId('task-row').filter({ hasText: `Reminder check ${t}` })
    await row.getByTestId('task-check').click()
    await until(() => scalar(`SELECT [Status] AS s FROM chat.TRN_ChatTask WHERE Title = 'Reminder check ${t}'`) === 'COMPLETED', 'task not completed')
    await noOverflow(page, 'tasks')
  })
  await scenario(name, 'B11', 'Notes: new pinned note, listed under Pinned', async () => {
    await page.goto('/notes')
    await page.getByTestId('notes-view').waitFor()
    await page.getByTestId('note-new').click()
    const ed = page.getByTestId('note-editor')
    await ed.getByTestId('note-title').fill(`Note ${t}`)
    await ed.getByTestId('note-body').fill('Prepare the renewal pack.')
    await ed.getByTestId('note-pin').click()
    await ed.getByTestId('sheet-done').click()
    await ed.waitFor({ state: 'detached' })
    await page.getByTestId('note-row').filter({ hasText: `Note ${t}` }).waitFor()
    await noOverflow(page, 'notes')
    await shot(page, `${name}-9-notes`)
  })
  await scenario(name, 'B12', 'My Day', async () => {
    await page.goto('/my-day')
    await page.getByTestId('myday-view').waitFor()
    await page.getByTestId('myday-followups').getByText(`report tomorrow ${t}`).first().waitFor({ timeout: 10_000 })
    await noOverflow(page, 'My Day')
    await shot(page, `${name}-10-myday`)
  })
  await scenario(name, 'B13', 'No script errors in the browser', async () => {
    check(page.errors.length === 0, `errors: ${page.errors.slice(0, 3).join(' | ')}`)
  })
  await page.context().browser().close().catch(() => {})
}

for (const b of browsers) await b.close().catch(() => {})
const name = `browsers-${chosen.join('+')}`.slice(0, 80)
const passed = results.filter((r) => r.result === 'PASS').length
fs.writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify({ runUtc: new Date().toISOString(), web: WEB, profiles: chosen, passed, failed: results.length - passed, results }, null, 2))
log(`${passed}/${results.length} passed (${chosen.join(', ')})`)
process.exit(passed === results.length ? 0 : 1)
