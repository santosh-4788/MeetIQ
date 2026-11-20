// Read receipts (20 Nov 2026): the sender sees Sent / Delivered, then a green double tick in the bubble and a blue
// "✓✓ Read" under the message once the colleague has read it; in groups "Read by N of M", then "Read by everyone".
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\receipts.mjs
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 6 * 60_000).unref()
import { Api, EMP, HOST, check, closeAll, exec, loginUI, newPage, scalar, tc, until, view, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT'")
exec("UPDATE auth.Users SET PasswordHash = (SELECT PasswordHash FROM auth.Users WHERE Email = 'hema.host@room.oneinsure.test') WHERE Email = 'tst.e1@room.oneinsure.test'")
const THIRD = { email: 'tst.e1@room.oneinsure.test', name: 'Test Emp One' }
const tag = Date.now().toString(36).slice(-5)
const idOf = (email) => scalar(`SELECT CONVERT(varchar(36), PublicId) AS id FROM auth.Users WHERE Email = '${email}'`)
const hemaApi = await new Api().login(HOST.email)
const direct = (await hemaApi.req('POST', '/chat/direct', { userId: idOf(EMP.email) })).data.id
const group = (await hemaApi.req('POST', '/chat/groups', { name: `Receipts ${tag}`, description: '', memberIds: [idOf(EMP.email), idOf(THIRD.email)] })).data.id
const ok = {}

const hema = await newPage({ width: 1366, height: 860 })
await loginUI(hema, HOST.email)
const esha = await newPage({ width: 412, height: 915, mobile: true })
await loginUI(esha, EMP.email)
await esha.goto('/dashboard') // online but not in the chat: the message is delivered, not read
const receipt = () => hema.getByTestId('chat-receipt')

ok.direct = await tc('R-01', 'Direct chat: Delivered, then green ticks and a blue "Read" once Esha opens the chat', 'receipt "Delivered" (grey) → Esha opens the chat → "Read" (blue) and the bubble tick turns green', async () => {
  await hema.goto(`/chat?c=${direct}`)
  await hema.getByTestId('chat-view').waitFor()
  await hema.getByTestId('chat-input').fill(`Did you get the file ${tag}?`)
  await hema.getByTestId('chat-send').click()
  await until(async () => /Delivered/.test(await receipt().innerText().catch(() => '')), 'no "Delivered" receipt', 15_000)
  const grey = await receipt().evaluate((el) => getComputedStyle(el).color)
  await view(hema, 'r01-delivered')
  await esha.goto(`/chat?c=${direct}`)
  await esha.getByTestId('chat-message').filter({ hasText: `Did you get the file ${tag}?` }).waitFor()
  await until(async () => (await receipt().innerText().catch(() => '')).trim().endsWith('Read'), 'no "Read" receipt', 15_000)
  const blue = await receipt().evaluate((el) => getComputedStyle(el).color)
  check(blue === 'rgb(0, 122, 255)' && blue !== grey, `"Read" is not blue (${blue}, delivered was ${grey})`)
  const msg = hema.getByTestId('chat-message').filter({ hasText: `Did you get the file ${tag}?` }).last()
  const tickColor = await msg.getByLabel('Read').evaluate((el) => getComputedStyle(el).color)
  check(tickColor === 'rgb(134, 247, 181)', `read tick is not green (${tickColor})`)
  await view(hema, 'r01-read')
  return 'Delivered → Read (blue), green ticks'
})

ok.group = await tc('R-02', 'Group: "Read by 1 of 2", then "Read by everyone"', 'Esha reads → "Read by 1 of 2"; Test Emp One reads (API) → "Read by everyone"', async () => {
  await hema.goto(`/chat?c=${group}`)
  await hema.getByTestId('chat-view').waitFor()
  await hema.getByTestId('chat-input').fill(`Team update ${tag}`)
  await hema.getByTestId('chat-send').click()
  await hema.getByTestId('chat-message').filter({ hasText: `Team update ${tag}` }).waitFor()
  await esha.goto(`/chat?c=${group}`)
  await esha.getByTestId('chat-message').filter({ hasText: `Team update ${tag}` }).waitFor()
  await until(async () => /Read by 1 of 2/.test(await receipt().innerText().catch(() => '')), 'no "Read by 1 of 2"', 15_000)
  await view(hema, 'r02-read-by-1')
  const third = await new Api().login(THIRD.email)
  const page = await third.req('GET', `/chat/conversations/${group}/messages?limit=5`)
  const last = page.data.items.at(-1)
  await third.req('POST', `/chat/conversations/${group}/read`, { seq: last.seq })
  await until(async () => /Read by everyone/.test(await receipt().innerText().catch(() => '')), 'no "Read by everyone"', 15_000)
  return 'Read by 1 of 2 → Read by everyone'
})

await closeAll()
writeResults('receipts')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
