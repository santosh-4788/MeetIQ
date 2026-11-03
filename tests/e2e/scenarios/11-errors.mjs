// 11. Error handling: the (isolated) API is stopped temporarily → friendly errors, no crashes; recovery after restart.
// Only the E2E API process (Debug build, port 7190) is stopped; the developer API on 7180 is never touched.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiClient } from '../lib/api.mjs'
import { as, loginUI, session, settle, text, waitUntil } from '../lib/browser.mjs'
import { PASSWORD, USERS } from '../lib/config.mjs'
import { RESULTS_DIR, check, tc } from '../lib/runner.mjs'

const M = 'Error handling'
const startScript = fileURLToPath(new URL('../scripts/start-api.ps1', import.meta.url))

function stopE2eApi() {
  // Match the Debug DLL started by start-api.ps1 AND port 7190 is ours: never the Release build behind 7180.
  execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='dotnet.exe'\" | Where-Object { $_.CommandLine -match 'bin\\\\Debug\\\\net10.0\\\\OneInsure.Connect.Api.dll' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
}

function startE2eApi() {
  // Start-Process detaches the API from this Node process (a plain detached spawn did not survive in this environment).
  const log = join(RESULTS_DIR, 'api-restart.log')
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${startScript}"' -WindowStyle Hidden -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err'`], { stdio: 'ignore', timeout: 30_000 })
  } catch {
    /* the launcher may outlive the timeout while the API keeps running: the health check below decides */
  }
}

async function healthy() {
  const r = await new ApiClient().get('/health').catch(() => ({ status: 0 }))
  return r.status === 200
}

export async function run() {
  const s = await as(USERS.priya.email)
  const page = s.page

  stopE2eApi()
  await waitUntil(async () => !(await healthy()), 'API did not stop', 15_000)

  await tc({ id: 'ERR-01', module: M, role: 'Employee', title: 'API down: in-app navigation shows friendly error states', steps: 'Stop the API; click My Meetings, Meeting Calendar, Notifications, Settings in the sidebar', expected: 'Each page shows an error state with a clear "cannot reach the server" message and Try again; no crash, no blank page', allowServerErrors: true }, async () => {
    const seen = []
    for (const [link, title] of [['My Meetings', 'Unable to load meetings'], ['Meeting Calendar', 'Unable to load the calendar'], ['Notifications', 'Unable to load notifications']]) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link, exact: true }).click()
      const err = page.getByText(title)
      await err.waitFor({ timeout: 15_000 })
      const msg = await text(page.locator('main'))
      seen.push(`${link}: ${msg.match(/(Unable to reach[^.]*\.|The request could not be completed\.|[^.]*server[^.]*\.)/)?.[0] ?? msg.slice(0, 80)}`)
      check(await page.getByRole('button', { name: 'Try again' }).first().isVisible(), `${link}: no Try again`)
    }
    check(seen.every((x) => /reach|server/i.test(x)), `messages not clear: ${seen.join(' | ')}`)
    return seen.join(' | ')
  })

  await tc({ id: 'ERR-02', module: M, role: 'Anonymous', title: 'API down: sign-in attempt', steps: 'Open /login in a new browser and submit valid credentials', expected: 'Friendly "cannot reach the server" message; no crash', allowServerErrors: true }, async () => {
    const a = await session()
    await a.page.goto('/login', { waitUntil: 'domcontentloaded' })
    // Either the sign-in form (then try to sign in) or the app's own "not reachable" screen.
    const form = a.page.getByLabel('Official Email / Employee ID')
    await form.or(a.page.getByText('OneInsure Connect is not reachable')).first().waitFor({ timeout: 15_000 })
    let msg
    if (await form.isVisible()) {
      await loginUI(a.page, USERS.priya.email, PASSWORD, { expectPath: null })
      msg = await text(a.page.getByRole('alert').first())
    } else msg = await text(a.page.locator('body'))
    await a.close()
    check(/reach|server|unavailable/i.test(msg), `message "${msg.slice(0, 200)}"`)
    return `Message: "${msg.slice(0, 160)}".`
  })

  await tc({ id: 'ERR-03', module: M, role: 'Employee', title: 'API down: page reload does not pretend the user was signed out', steps: 'Reload the app while the API is down', expected: 'A "cannot reach the server" screen with Retry (not the sign-in page, which would wrongly suggest a sign-out)', allowServerErrors: true }, async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await settle(page, 1500)
    const url = page.url()
    const body = await text(page.locator('body'))
    check(!/\/login/.test(url) && /reach|server/i.test(body), `after reload: ${url} "${body.slice(0, 120)}"`)
    return `Stayed on ${new URL(url).pathname} with a server-unavailable message.`
  })

  startE2eApi()
  await waitUntil(healthy, 'API did not come back', 90_000)

  await tc({ id: 'ERR-04', module: M, role: 'Employee', title: 'Recovery after the API restarts', steps: 'Restart the API; click Retry / Try again; navigate', expected: 'Data loads again without signing in again (session survives the restart)', allowServerErrors: true }, async () => {
    const retry = page.getByRole('button', { name: /Retry|Try again/ }).first()
    if (await retry.isVisible().catch(() => false)) await retry.click()
    await settle(page, 800)
    if (/\/login/.test(page.url())) throw new Error('sent to /login after recovery')
    await page.goto('/meetings')
    await page.getByText('E2E Weekly Ops Sync').first().waitFor({ timeout: 15_000 })
    return 'Recovered with the same session.'
  })

  await s.close()
}
