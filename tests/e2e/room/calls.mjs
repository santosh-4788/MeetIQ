// Chat audio calls, Phase 3 (20 Nov 2026): three employees in three browsers (one a phone), real audio through the isolated
// LiveKit test server (7890), fake microphones. Isolated environment only (LocalDB *_Room, API 7191, Vite 5175).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\calls.mjs
setTimeout(() => { console.log('WATCHDOG: test still running after 9 min - giving up'); process.exit(2) }, 9 * 60_000).unref()
import { EMP, HOST, check, closeAll, exec, inbound, loginUI, newPage, overflowX, scalar, sleep, tc, until, view, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS')")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
exec("UPDATE auth.Users SET PasswordHash = (SELECT PasswordHash FROM auth.Users WHERE Email = 'hema.host@room.oneinsure.test') WHERE Email = 'tst.e1@room.oneinsure.test'")
const THIRD = { email: 'tst.e1@room.oneinsure.test', name: 'Test Emp One' }
const ok = {}

const hema = await newPage({ width: 1366, height: 860 })
await loginUI(hema, HOST.email)
const esha = await newPage({ width: 1280, height: 820 })
await loginUI(esha, EMP.email)
const third = await newPage({ width: 390, height: 844, mobile: true })
await loginUI(third, THIRD.email)

const panel = (p) => p.getByTestId('call-panel')
const status = async (p) => (await panel(p).getByTestId('call-status').innerText()).trim()
async function openChatWith(p, name) {
  await p.goto('/chat')
  await p.getByTestId('chat-new').click()
  await p.getByRole('dialog', { name: 'New chat' }).getByLabel('Search colleagues').fill(name.split(' ').slice(-1)[0] === 'One' ? 'Emp One' : name.split(' ')[0])
  await p.getByTestId('chat-person').filter({ hasText: name }).first().click()
  await until(async () => (await p.getByTestId('chat-title').innerText()) === name, `chat with ${name} not open`)
}
async function audioFlows(p) {
  const a = await inbound(p)
  await sleep(2500)
  const b = await inbound(p)
  return b.audio - a.audio
}
async function noCall(p) {
  await until(async () => (await panel(p).count()) === 0, 'call panel still shown', 15_000)
}

ok.ring = await tc('CA-01', 'Direct call: the other person is rung on whatever page they are on, accepts, and both hear each other',
  'Hema → chat with Esha → phone button → "Ringing…"; Esha (on the dashboard) gets the popup with Hema\'s name → Accept → both panels show a timer; audio bytes flow both ways', async () => {
    await esha.goto('/dashboard')
    await openChatWith(hema, EMP.name)
    await hema.getByTestId('chat-call').click()
    await panel(hema).waitFor()
    await until(async () => /Ringing|Calling/.test(await status(hema)), 'caller not ringing', 10_000)
    const pop = esha.getByTestId('call-incoming')
    await pop.waitFor({ timeout: 15_000 })
    check((await pop.getByTestId('call-incoming-name').innerText()) === HOST.name, 'wrong caller name')
    await view(esha, 'call-incoming')
    await pop.getByTestId('call-accept').click()
    await until(async () => /\d:\d\d/.test(await status(esha)), 'callee timer not running', 20_000)
    await until(async () => /\d:\d\d/.test(await status(hema)), 'caller timer not running', 20_000)
    const toEsha = await until(async () => (await audioFlows(esha)) > 2000 && (await audioFlows(esha)), 'no audio reaching Esha', 20_000)
    const toHema = await until(async () => (await audioFlows(hema)) > 2000 && (await audioFlows(hema)), 'no audio reaching Hema', 20_000)
    await view(hema, 'call-active')
    return `popup on Esha's dashboard; connected; +${toEsha} B audio to Esha, +${toHema} B to Hema in 2.5 s`
  })

ok.mute = ok.ring && await tc('CA-02', 'Mute / unmute; presence shows "In a call"', 'Esha mutes → "Muted" for herself; unmutes; Hema\'s chat header shows Esha "In a call"', async () => {
    await panel(esha).getByTestId('call-mute').click()
    await until(async () => (await panel(esha).getByTestId('call-mute').getAttribute('aria-pressed')) === 'true', 'not muted')
    check(/Muted/.test(await panel(esha).innerText()), 'no "Muted" label')
    await panel(esha).getByTestId('call-mute').click()
    await until(async () => (await panel(esha).getByTestId('call-mute').getAttribute('aria-pressed')) === 'false', 'not unmuted')
    await hema.reload()
    await hema.getByTestId('chat-view').waitFor()
    await until(async () => /In a call/.test(await hema.getByTestId('chat-subtitle').innerText()), 'presence is not "In a call"', 15_000)
    return 'mute toggles; presence "In a call"'
  })

let groupOk = false
ok.add = ok.ring && await tc('CA-03', 'Add a third person during the call (phone); they accept; then leave; the call goes on', 'Hema → Add people → Test Emp One → phone popup → Accept → 3 in the call → phone hangs up → Hema and Esha still connected', async () => {
    // Hema reloaded in CA-02: her call moved out of this tab, so join it here again first.
    // The bar appears once the reloaded page has asked the server for its current call: wait for the bar or the panel.
    await until(async () => (await hema.getByTestId('call-elsewhere').count()) + (await panel(hema).count()) > 0, 'neither "Join here" nor the call panel after the reload', 15_000)
    if (await hema.getByTestId('call-elsewhere').count()) await hema.getByTestId('call-elsewhere').getByRole('button', { name: 'Join here' }).click()
    await panel(hema).waitFor({ timeout: 15_000 })
    await until(async () => /\d:\d\d/.test(await status(hema)), 'Hema not back in the call', 20_000)
    await panel(hema).getByTestId('call-add').click()
    const dlg = hema.getByRole('dialog', { name: 'Add people to the call' })
    await dlg.getByLabel('Search colleagues').fill('Emp One')
    await dlg.getByTestId('call-add-person').filter({ hasText: THIRD.name }).first().click()
    await dlg.getByTestId('call-add-confirm').click()
    const pop = third.getByTestId('call-incoming')
    await pop.waitFor({ timeout: 15_000 })
    check(await overflowX(third) <= 0, `popup overflows the phone by ${await overflowX(third)} px`)
    await view(third, 'call-incoming-phone')
    await pop.getByTestId('call-accept').click()
    await until(async () => /\d:\d\d/.test(await status(third)), 'phone not connected', 20_000)
    await until(async () => (await panel(hema).getByText('Test Emp One').count()) > 0 && !/Ringing/.test(await panel(hema).innerText()), 'Hema does not see the third person joined', 15_000)
    const phoneAudio = await until(async () => (await audioFlows(third)) > 2000 && (await audioFlows(third)), 'no audio on the phone', 20_000)
    await panel(third).getByTestId('call-hangup').click()
    await noCall(third)
    await sleep(2000)
    check(/\d:\d\d/.test(await status(hema)) && /\d:\d\d/.test(await status(esha)), 'call did not go on for the other two')
    groupOk = true
    return `phone joined (+${phoneAudio} B audio), left; the other two still connected`
  })

ok.endAll = ok.ring && await tc('CA-04', 'The starter ends the group call for everyone; a call line appears in the chat', '"End call for everyone" → both panels close; the chat shows "📞 Group audio call · …" (or "Audio call · …")', async () => {
    const endAll = panel(hema).getByTestId('call-end-all')
    if (groupOk && await endAll.count()) await endAll.click()
    else await panel(hema).getByTestId('call-hangup').click()
    await noCall(hema)
    await noCall(esha)
    await hema.getByTestId('chat-system').filter({ hasText: /📞 (Group audio call|Audio call) · / }).last().waitFor({ timeout: 15_000 })
    return 'ended for both; call line in the chat'
  })

ok.decline = ok.ring && await tc('CA-05', 'Declined call: the caller is told', 'Hema calls Esha → Esha declines → Hema sees "Esha Employee declined the call"', async () => {
    await hema.getByTestId('chat-call').click()
    await esha.getByTestId('call-incoming').getByTestId('call-decline').click({ timeout: 15_000 })
    await until(async () => /declined/i.test(await status(hema)), 'no "declined" for the caller', 15_000)
    await noCall(hema)
    return 'caller told it was declined'
  })

ok.busy = ok.ring && await tc('CA-06', 'Busy: someone already in a call is not interrupted; the caller hears "busy"; the busy person gets a missed-call alert',
  'Hema calls Esha (accepted) → Test Emp One calls Esha → "Esha Employee is busy"; Esha\'s call carries on; bell entry for Esha', async () => {
    await hema.getByTestId('chat-call').click()
    await esha.getByTestId('call-incoming').getByTestId('call-accept').click({ timeout: 15_000 })
    await until(async () => /\d:\d\d/.test(await status(esha)), 'not connected', 20_000)
    const bellBefore = Number(scalar("SELECT COUNT(*) AS v FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = 'esha.employee@room.oneinsure.test' AND n.[Type] = 'MISSED_CALL'"))
    await openChatWith(third, EMP.name)
    await third.getByTestId('chat-call').click()
    await until(async () => /busy/i.test(await status(third)), 'caller not told "busy"', 15_000)
    check((await esha.getByTestId('call-incoming').count()) === 0, 'busy person was rung')
    check(/\d:\d\d/.test(await status(esha)), 'busy person\'s call was interrupted')
    await until(async () => Number(scalar("SELECT COUNT(*) AS v FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = 'esha.employee@room.oneinsure.test' AND n.[Type] = 'MISSED_CALL'")) > bellBefore, 'no missed-call alert', 10_000)
    await panel(esha).getByTestId('call-hangup').click()
    await noCall(esha)
    await noCall(hema)
    return '"busy" for the caller; the ongoing call untouched; missed-call alert in the bell'
  })

ok.missed = ok.ring && await tc('CA-07', 'No answer within 45 s: missed for both sides', 'Test Emp One calls Hema, nobody answers → after ~45 s "No answer"; a "Missed audio call" line in the chat; Hema\'s Calls tab lists it as missed', async () => {
    await hema.goto('/dashboard')
    await third.getByTestId('chat-back').click().catch(() => {})
    await openChatWith(third, HOST.name)
    await third.getByTestId('chat-call').click()
    await hema.getByTestId('call-incoming').waitFor({ timeout: 15_000 })
    const t0 = Date.now()
    await until(async () => (await hema.getByTestId('call-incoming').count()) === 0, 'still ringing after 70 s', 70_000, 1000)
    const secs = Math.round((Date.now() - t0) / 1000)
    await third.getByTestId('chat-system').filter({ hasText: '📞 Missed audio call' }).last().waitFor({ timeout: 15_000 })
    await hema.goto('/chat')
    await hema.getByTestId('chat-section-calls').click()
    const row = hema.getByTestId('call-history-item').first()
    await row.waitFor()
    check(/Missed/.test(await row.innerText()), `history row: ${await row.innerText()}`)
    await view(hema, 'call-history')
    return `rang ${secs} s, then missed; chat line; history shows "Missed"`
  })

await closeAll()
writeResults('calls')
