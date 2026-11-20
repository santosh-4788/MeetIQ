// GoodDay #14231 (17 Nov 2026): "After sending Instant meeting link and joining 2 different links are visible on Invite option".
// A customer instant meeting showed the customer's personal link AND the general meeting link one under the other, both with
// "Copy link". Now only the personal link(s) are shown; the general link is behind "Invite someone else". Internal meetings
// still show the general link directly.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, room-test LiveKit 7890 - never production 7880).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\goodday-14231.mjs
setTimeout(() => { console.log('WATCHDOG: test still running after 5 min - giving up'); process.exit(2) }, 5 * 60_000).unref()
import { HOST, check, closeAll, exec, loginUI, newPage, tc, view, writeResults } from './harness.mjs'

const retire = () => exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = COALESCE(ActualEndUtc, SYSUTCDATETIME()) WHERE [Status] IN ('SCHEDULED', 'LIVE')")
retire()
const tag = Date.now().toString(36).slice(-5)
const ok = {}

async function startInstant(page, fill) {
  await page.goto('/dashboard')
  await page.getByTestId('new-meeting').click()
  await page.getByTestId('instant-title').fill(`GD14231 ${tag}`)
  await fill?.()
  await page.getByTestId('start-instant').click()
  await page.waitForURL(/\/meetings\/[0-9a-f-]{36}\/room/)
  await page.getByText('Ready to join?').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Start meeting' }).click()
  await page.locator('[data-testid="meeting-room"]').waitFor({ timeout: 25_000 })
}

const host = await newPage({ width: 1366, height: 860 })
await loginUI(host, HOST.email)

ok.plvc = await tc('GD14231-01', 'Customer PLVC instant meeting: Invite shows only the customer\'s personal link', 'One personal link; the general link only after "Invite someone else"', async () => {
  await startInstant(host, async () => {
    await host.getByTestId('instant-type').selectOption('CUSTOMER_PLVC')
    await host.getByTestId('prarambh-main-id').fill('142310')
    await host.getByTestId('participant-name').first().fill('Naved Test')
    await host.getByTestId('participant-email').first().fill(`gd14231.${tag}@example.test`)
  })
  const dlg = host.getByRole('dialog', { name: 'Invite people' })
  await dlg.getByTestId('customer-link').waitFor({ timeout: 15_000 })
  await host.waitForTimeout(1500)
  await view(host, 'gd14231-plvc-invite')
  const personal = await dlg.getByTestId('customer-link-url').count()
  const general = await dlg.getByTestId('meeting-link').count()
  check(personal === 1, `personal links shown: ${personal}`)
  check(general === 0, `general meeting link also shown (${general})`)
  await dlg.getByTestId('show-general-link').click()
  await dlg.getByTestId('meeting-link').waitFor({ timeout: 10_000 })
  const url = await dlg.getByTestId('meeting-link').inputValue()
  check(/\/m\/[A-Za-z0-9_-]{22}$/.test(url), `general link "${url}"`)
  await view(host, 'gd14231-plvc-invite-someone-else')
  await host.keyboard.press('Escape')
  return 'one link (customer\'s personal link); general link only after "Invite someone else"'
})

retire()
ok.internal = await tc('GD14231-02', 'Internal instant meeting: Invite still shows the meeting link directly', 'Meeting link shown directly, as before', async () => {
  await startInstant(host)
  const dlg = host.getByRole('dialog', { name: 'Invite people' })
  await dlg.getByTestId('meeting-link').waitFor({ timeout: 15_000 })
  check(await dlg.getByTestId('show-general-link').count() === 0, '"Invite someone else" shown for an internal meeting')
  check(await dlg.getByTestId('customer-link').count() === 0, 'customer link shown for an internal meeting')
  return 'meeting link shown as before'
})

retire()
await closeAll()
writeResults?.('goodday-14231')
const passed = Object.values(ok).filter(Boolean).length
console.log(`${passed}/${Object.keys(ok).length} passed`)
process.exit(passed === Object.keys(ok).length ? 0 : 1)
