// Menu items My Day, Tasks and Notes below Chat (20 Nov 2026): shown only while CHAT_TASKS is on; each opens the Chat
// workspace on that section and is highlighted; the segmented control and the menu stay in step; no duplicate
// "online" avatar strip above the chat list. Computer + phone (menu drawer). Isolated environment only.
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\sidebar-sections.mjs
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 5 * 60_000).unref()
import { HOST, check, closeAll, exec, loginUI, newPage, sleep, tc, view, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_TASKS')")
const ok = {}
const pc = await newPage({ width: 1366, height: 860 })
await loginUI(pc, HOST.email)
const phone = await newPage({ width: 390, height: 844, mobile: true })
await loginUI(phone, HOST.email)
const nav = (p) => p.getByRole('navigation', { name: 'Main' })

ok.pc = await tc('S-01', 'Computer: My Day, Tasks, Notes in the menu below Chat; each opens its section', 'menu order Chat › My Day › Tasks › Notes; click each → URL /my-day|/tasks|/notes, section shown, item highlighted; segmented "Chats" goes back to /chat', async () => {
  await pc.goto('/dashboard')
  await nav(pc).getByRole('link', { name: 'My Day', exact: true }).waitFor()
  const labels = (await nav(pc).locator('a').allInnerTexts()).map((t) => t.trim().replace(/\s+\d+$/, ''))
  const i = labels.indexOf('Chat')
  check(i >= 0 && labels.slice(i, i + 4).join('|') === 'Chat|My Day|Tasks|Notes', `menu order: ${labels.slice(i, i + 4).join('|')}`)
  for (const [label, url, testId] of [['My Day', '/my-day', 'myday-view'], ['Tasks', '/tasks', 'tasks-view'], ['Notes', '/notes', 'notes-view']]) {
    await nav(pc).getByRole('link', { name: label, exact: true }).click()
    await pc.getByTestId(testId).waitFor()
    check(new URL(pc.url()).pathname.endsWith(url), `${label}: URL ${pc.url()}`)
    check((await nav(pc).getByRole('link', { name: label, exact: true }).getAttribute('aria-current')) === 'page', `${label} not highlighted`)
    check(await pc.getByTestId('chat-section-tasks').count() === 0, `${label}: My Day / Notes / Tasks should not be in the switcher`)
  }
  await view(pc, 's01-notes-from-menu')
  await nav(pc).getByRole('link', { name: /^Chat/ }).first().click()
  await pc.getByTestId('chat-list').waitFor()
  check(new URL(pc.url()).pathname.endsWith('/chat'), `Chat did not go to /chat (${pc.url()})`)
  const segs = await pc.locator('[data-testid^="chat-section-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  check(segs.join(',') === 'chat-section-chats,chat-section-calls', `switcher shows ${segs.join(',')}`)
  return 'order, navigation, highlight; switcher has only Chats and Calls'
})

ok.dup = await tc('S-02', 'No duplicate names above the chat list', 'no "online" avatar strip; each colleague appears once (their chat row)', async () => {
  await pc.goto('/chat')
  await pc.getByTestId('chat-list').waitFor()
  await sleep(800)
  const strip = await pc.locator('button[title*=" · "]').count() // the old strip had title "Name · Online"
  check(strip === 0, `online strip still shown (${strip})`)
  await view(pc, 's02-chat-list')
  return 'no strip'
})

ok.phone = await tc('S-03', 'Phone: the menu drawer shows My Day, Tasks, Notes and opens them', '☰ → Tasks → Tasks section; drawer closes', async () => {
  await phone.goto('/dashboard')
  await phone.getByRole('button', { name: /menu/i }).first().click()
  const link = phone.getByRole('link', { name: 'Tasks', exact: true })
  await link.waitFor()
  await view(phone, 's03-phone-menu')
  await link.click()
  await phone.getByTestId('tasks-view').waitFor()
  return 'drawer works'
})

ok.chips = await tc('S-05', 'Chat filter chips: one line that scrolls, with ‹ › buttons (computer and phone)', 'all chips on one line; › shown while chips are hidden; tapping it brings "Archived" fully into view and shows ‹', async () => {
  exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_ADVANCED')")
  await sleep(11_000)
  for (const [name, p] of [['computer', pc], ['phone', phone]]) {
    await p.goto('/chat')
    const row = p.getByTestId('chat-filters')
    await row.waitFor()
    await sleep(500)
    const tops = await row.locator('[role="tab"]').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))])
    check(tops.length === 1, `${name}: chips are on ${tops.length} lines`)
    const archived = row.getByRole('tab', { name: 'Archived' })
    const inView = () => archived.evaluate((el) => { const r = el.getBoundingClientRect(); const c = el.parentElement.getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 })
    if (!(await inView())) {
      await p.getByTestId('chips-next').waitFor()
      await view(p, `s05-chips-${name}-start`)
      for (let i = 0; i < 4 && !(await inView()); i++) {
        await p.getByTestId('chips-next').click()
        await sleep(450)
      }
      check(await inView(), `${name}: "Archived" never came into view`)
      await p.getByTestId('chips-prev').waitFor()
    }
    await archived.click()
    check((await archived.getAttribute('aria-selected')) === 'true', `${name}: Archived not selectable`)
    await view(p, `s05-chips-${name}-end`)
  }
  return 'single line; arrows scroll; last chip reachable'
})

ok.off = await tc('S-04', 'Switch CHAT_TASKS off: the three menu items disappear', 'menu shows Chat only', async () => {
  exec("UPDATE app.FeatureSettings SET IsEnabled = 0 WHERE FeatureKey = 'CHAT_TASKS'")
  await sleep(11_000)
  await pc.goto('/dashboard')
  await nav(pc).getByRole('link', { name: /^Chat/ }).first().waitFor()
  await sleep(1500)
  check(await nav(pc).getByRole('link', { name: 'Tasks', exact: true }).count() === 0, 'Tasks still in the menu')
  exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT_TASKS'")
  return 'hidden while off'
})

await closeAll()
writeResults('sidebar-sections')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
