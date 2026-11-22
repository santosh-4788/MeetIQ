// Call speaker button (21 Nov 2026): Android app (1.2.2+) gets a real Speaker on/off switch through the bridge
// ({type:"speaker", on?}, fake bridge here answering like Speaker.kt); computers get the speaker chooser; iPhone gets
// the Control Center hint. Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, LiveKit 7890).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; $env:SHOTDIR='results'; node room\call-speaker.mjs
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 6 * 60_000).unref()
import { EMP, HOST, check, closeAll, exec, loginUI, newPage, sleep, until } from './harness.mjs'
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS')")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
const SHOT = process.env.SHOTDIR || 'results'
const AND = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 OneInsureConnectApp/1.2.2'
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const hema = await newPage({ width: 1366, height: 860 }); await loginUI(hema, HOST.email)
const st = (p) => p.getByTestId('call-panel').getByTestId('call-status').innerText()
async function call(esha) {
  await esha.goto('/dashboard')
  await hema.goto('/chat'); await hema.getByTestId('chat-new').click()
  await hema.getByRole('dialog', { name: 'New chat' }).getByLabel('Search colleagues').fill(EMP.name.split(' ')[0])
  await hema.getByTestId('chat-person').filter({ hasText: EMP.name }).first().click()
  await hema.getByTestId('chat-call').click()
  await esha.getByTestId('call-incoming').waitFor({ timeout: 20000 }); await esha.getByTestId('call-accept').click()
  await until(async () => /\d:\d\d/.test(await st(hema)) && /\d:\d\d/.test(await st(esha)), 'not connected', 25000)
}
async function hang(esha) { await hema.getByTestId('call-panel').getByTestId('call-hangup').click(); await until(async () => (await esha.getByTestId('call-panel').count()) === 0, 'panel stays', 15000); await esha.close() }

// 1) Android app: fake bridge answering like Speaker.kt (starts on the loudspeaker).
const app = await newPage({ width: 412, height: 860, mobile: true, userAgent: AND, deviceScaleFactor: 2 })
await app.addInitScript(() => {
  window.__msgs = []; window.__spk = true
  window.OicAndroid = { onmessage: null, postMessage(d) { const m = JSON.parse(d); window.__msgs.push(m)
    if (m.type === 'speaker') { if ('on' in m) window.__spk = m.on; setTimeout(() => window.OicAndroid.onmessage?.({ data: JSON.stringify({ type: 'speaker', supported: true, on: window.__spk }) }), 30) } } }
})
await loginUI(app, EMP.email); await call(app)
const key = app.getByTestId('call-panel').getByTestId('call-speaker')
await until(async () => (await key.getAttribute('aria-label')) === 'Speaker on', 'app button not "Speaker on"', 8000)
await app.screenshot({ path: `${SHOT}/spk-app-on.png` })
await key.click(); await until(async () => (await key.getAttribute('aria-label')) === 'Speaker off', 'did not switch to earpiece', 5000)
await app.screenshot({ path: `${SHOT}/spk-app-off.png` })
await key.click(); await until(async () => (await key.getAttribute('aria-label')) === 'Speaker on', 'did not switch back', 5000)
const sent = (await app.evaluate(() => window.__msgs)).filter(m => m.type === 'speaker').map(m => 'on' in m ? m.on : 'ask')
console.log('APP: Speaker on → off → on; messages to app:', JSON.stringify(sent))
check((await app.getByRole('dialog').count()) === 0, 'chooser opened in the app')
// Computer side: same button opens the chooser with speaker list.
const hk = hema.getByTestId('call-panel').getByTestId('call-speaker'); check((await hk.getAttribute('aria-label')) === 'Microphone and speaker', 'computer label')
await hk.click(); const dlg = hema.getByRole('dialog', { name: 'Microphone and speaker' }); await dlg.waitFor()
console.log('COMPUTER speaker options:', (await dlg.locator('select').count()) === 2 ? 'list shown' : 'NO LIST'); await dlg.getByRole('button', { name: 'Done' }).click()
await hang(app)

// 2) iPhone: chooser shows how to change the output.
const ios = await newPage({ width: 390, height: 844, mobile: true, userAgent: IOS, deviceScaleFactor: 3 })
await loginUI(ios, EMP.email); await call(ios)
const ik = ios.getByTestId('call-panel').getByTestId('call-speaker'); await sleep(1800)
check((await ik.getAttribute('aria-label')) === 'Microphone and speaker', 'iPhone label')
await ik.click(); const idlg = ios.getByRole('dialog', { name: 'Microphone and speaker' }); await idlg.waitFor(); await sleep(600)
console.log('IPHONE help:', await idlg.getByTestId('call-speaker-help').innerText(), '| speaker list:', await idlg.locator('select').count() === 2)
await ios.screenshot({ path: `${SHOT}/spk-ios.png` }); await idlg.getByRole('button', { name: 'Done' }).click({ timeout: 5000 })
await hang(ios)
console.log('ALL OK'); await closeAll(); process.exit(0)
