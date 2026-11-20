// Chat, Phase 2 (20 Nov 2026, documentation/CHAT_MODULE_PHASE1.md): two employees in two browsers, live over SignalR, plus a phone.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175). Real Windows Defender scan of uploads (Chat:ScanEnabled default).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\chat.mjs
import fs from 'node:fs'
import path from 'node:path'
setTimeout(() => { console.log('WATCHDOG: test still running after 8 min - giving up'); process.exit(2) }, 8 * 60_000).unref()
import { Api, EMP, HOST, RESULTS, SHOTS, check, closeAll, exec, loginUI, newPage, overflowX, scalar, sleep, tc, until, view, writeResults } from './harness.mjs'

const tag = Date.now().toString(36).slice(-5)
exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT'")
// The third colleague signs in on the phone: same test password as the others (test database only).
exec("UPDATE auth.Users SET PasswordHash = (SELECT PasswordHash FROM auth.Users WHERE Email = 'hema.host@room.oneinsure.test') WHERE Email = 'tst.e1@room.oneinsure.test'")
const ok = {}
const THIRD = { email: 'tst.e1@room.oneinsure.test', name: 'Test Emp One' }

const hema = await newPage({ width: 1366, height: 860 })
await loginUI(hema, HOST.email)
const esha = await newPage({ width: 1280, height: 820 })
await loginUI(esha, EMP.email)

const nav = (p) => p.getByRole('navigation', { name: 'Main' })
const input = (p) => p.getByTestId('chat-input')
const bodies = (p) => p.getByTestId('chat-body')
async function openChatWith(p, name) {
  await p.getByTestId('chat-new').click()
  await p.getByRole('dialog', { name: 'New chat' }).getByLabel('Search colleagues').fill(name.split(' ')[0])
  await p.getByTestId('chat-person').filter({ hasText: name }).first().click()
  await until(async () => (await p.getByTestId('chat-title').innerText()) === name, `chat with ${name} not open`)
}
async function send(p, text) {
  await input(p).fill(text)
  await p.getByTestId('chat-send').click()
}

ok.nav = await tc('CH-01', 'Chat appears in the menu directly below Meetings, opens inside the portal',
  '"Communication › Chat" after the Meetings section; /chat shows the workspace (list + empty state)', async () => {
    const link = nav(hema).getByRole('link', { name: /^Chat/ })
    await link.waitFor({ timeout: 15_000 })
    const order = await nav(hema).locator('p.eyebrow').allInnerTexts()
    const iMeet = order.findIndex((t) => /meetings/i.test(t))
    check(iMeet >= 0 && /communication/i.test(order[iMeet + 1] ?? ''), `sections: ${order.join(' | ')}`)
    await link.click()
    await hema.getByTestId('chat-page').waitFor()
    check(hema.url().includes('/chat'), hema.url())
    await view(hema, 'chat-empty')
    return `sections ${order.join(' › ')}; workspace open at ${new URL(hema.url()).pathname}`
  })

let conversationUrl = ''
ok.direct = ok.nav && await tc('CH-02', 'Direct chat: search a colleague, send; the other person gets it live with an unread badge',
  'Hema → New chat → "Esha" → send → Esha (other browser, on the dashboard) sees the menu badge, opens Chat, reads it; Hema sees the read tick', async () => {
    await openChatWith(hema, EMP.name)
    conversationUrl = hema.url()
    await send(hema, `Hello Esha ${tag}`)
    await bodies(hema).filter({ hasText: `Hello Esha ${tag}` }).waitFor()
    // Esha is on another page: the menu badge appears without reloading.
    const badge = nav(esha).getByTestId('nav-chat-badge')
    await badge.waitFor({ timeout: 15_000 })
    const n = await badge.innerText()
    await nav(esha).getByRole('link', { name: /^Chat/ }).click()
    await esha.getByTestId('chat-item').filter({ has: esha.getByTestId('chat-item-name').getByText(HOST.name, { exact: true }) }).click()
    await bodies(esha).filter({ hasText: `Hello Esha ${tag}` }).waitFor()
    // Read tick for Hema.
    const mine = hema.getByTestId('chat-message').filter({ hasText: `Hello Esha ${tag}` })
    await until(async () => (await mine.getByLabel('Read').count()) > 0, 'Hema did not get the read tick', 15_000)
    await until(async () => (await nav(esha).getByTestId('nav-chat-badge').count()) === 0, 'Esha badge did not clear', 10_000)
    return `badge "${n}" on Esha's dashboard, message shown, read tick back to Hema, badge cleared`
  })

ok.live = ok.direct && await tc('CH-03', 'Typing indicator, presence, reply and reaction arrive live both ways',
  'Esha types → Hema sees "is typing…"; Hema sees Esha "Online"; Esha replies to the message and reacts 👍 → Hema sees both', async () => {
    await until(async () => /Online/.test(await hema.getByTestId('chat-subtitle').innerText()), 'Hema does not see Esha online', 15_000)
    await input(esha).pressSequentially('typing a reply', { delay: 40 })
    await until(async () => /typing/.test(await hema.getByTestId('chat-subtitle').innerText()), 'no typing indicator', 8000)
    await input(esha).fill('')
    const target = esha.getByTestId('chat-message').filter({ hasText: `Hello Esha ${tag}` }).first()
    await target.hover()
    await target.getByRole('button', { name: 'Reply', exact: true }).click()
    await esha.getByTestId('chat-replying').waitFor()
    await send(esha, `Reply from Esha ${tag}`)
    await target.hover()
    await target.getByRole('button', { name: 'React', exact: true }).click()
    await esha.getByTestId('chat-quick-reactions').getByRole('button', { name: 'React 👍' }).click()
    const reply = hema.getByTestId('chat-message').filter({ hasText: `Reply from Esha ${tag}` })
    await reply.waitFor()
    check((await reply.innerText()).includes(`Hello Esha ${tag}`), 'reply preview missing')
    await hema.getByTestId('chat-message').filter({ hasText: `Hello Esha ${tag}` }).getByTestId('chat-reaction').waitFor({ timeout: 10_000 })
    return 'typing shown, Online shown, reply with quoted preview, 👍 reaction'
  })

ok.edit = ok.live && await tc('CH-04', 'Edit and delete own message; the other side updates live; emoji picker inserts emoji',
  'Hema edits → "edited" for Esha; Hema deletes → "This message was deleted" for Esha; composer emoji picker adds 🎉', async () => {
    await send(hema, `Typo mesage ${tag}`)
    const msg = hema.getByTestId('chat-message').filter({ hasText: `Typo mesage ${tag}` })
    await msg.waitFor()
    await until(async () => (await msg.getByLabel(/Sent|Delivered|Read/).count()) > 0, 'not saved yet')
    await msg.hover()
    await msg.getByRole('button', { name: 'Edit', exact: true }).click()
    await input(hema).fill(`Typo message fixed ${tag}`)
    await hema.getByTestId('chat-send').click()
    const seen = esha.getByTestId('chat-message').filter({ hasText: `Typo message fixed ${tag}` })
    await seen.waitFor()
    check(/edited/i.test(await seen.innerText()), 'no "edited" label')
    const fixed = hema.getByTestId('chat-message').filter({ hasText: `Typo message fixed ${tag}` })
    await fixed.hover()
    await fixed.getByRole('button', { name: 'Delete for everyone' }).click()
    await hema.getByRole('dialog', { name: 'Delete for everyone?' }).getByRole('button', { name: 'Delete' }).click()
    await until(async () => (await esha.getByText(`Typo message fixed ${tag}`).count()) === 0, 'deleted text still visible to Esha', 10_000)
    check((await esha.getByText('This message was deleted').count()) > 0, 'no deleted placeholder')
    await hema.getByRole('button', { name: 'Emoji', exact: true }).click()
    await hema.getByTestId('emoji-picker').getByLabel('Search emoji').fill('party')
    await hema.getByTestId('emoji-picker').getByRole('button', { name: '🎉' }).click()
    check((await input(hema).inputValue()).includes('🎉'), 'emoji not inserted')
    await send(hema, `${await input(hema).inputValue()} done ${tag}`)
    await bodies(esha).filter({ hasText: `done ${tag}` }).waitFor()
    return 'edited label, deleted for both, emoji search + insert'
  })

ok.files = ok.direct && await tc('CH-05', 'Files: picture and document are checked by Windows Defender, then shown / downloadable for the other person; an .exe is refused',
  'Upload PNG + TXT → "Checking for viruses…" → image appears for Esha, document downloads (200, attachment); setup.exe refused with a message', async () => {
    const dir = path.join(RESULTS, 'chat-files')
    fs.mkdirSync(dir, { recursive: true })
    const png = path.join(dir, `pixel-${tag}.png`)
    fs.writeFileSync(png, Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360F8CFC0000003010100C9FE92EF0000000049454E44AE426082', 'hex'))
    const txt = path.join(dir, `notes-${tag}.txt`)
    fs.writeFileSync(txt, `Meeting notes ${tag}\nLine two\n`)
    const exe = path.join(dir, 'setup.exe')
    fs.writeFileSync(exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
    await hema.getByTestId('chat-file-input').setInputFiles([png, txt])
    const t0 = Date.now()
    await esha.getByRole('img', { name: `pixel-${tag}.png` }).waitFor({ timeout: 60_000 })
    const scanned = ((Date.now() - t0) / 1000).toFixed(1)
    const doc = esha.getByTestId('chat-file').filter({ hasText: `notes-${tag}.txt` })
    await doc.waitFor({ timeout: 60_000 })
    const href = await doc.getByTestId('chat-file-download').getAttribute('href')
    const res = await esha.request.get(href)
    check(res.status() === 200, `download ${res.status()}`)
    check(/attachment/.test(res.headers()['content-disposition'] ?? ''), `disposition ${res.headers()['content-disposition']}`)
    check((await res.text()).includes(`Meeting notes ${tag}`), 'wrong file content')
    const status = scalar(`SELECT TOP 1 ScanStatus + '|' + ISNULL(ScanDetail, '') AS v FROM chat.TRN_ChatFile WHERE OriginalName = N'notes-${tag}.txt'`)
    check(status.startsWith('CLEAN|Windows Defender'), `scan ${status}`)
    await hema.getByTestId('chat-file-input').setInputFiles([exe])
    await hema.getByTestId('chat-upload').filter({ hasText: 'setup.exe' }).getByRole('alert').waitFor()
    const why = await hema.getByTestId('chat-upload').filter({ hasText: 'setup.exe' }).innerText()
    check(/cannot be shared/.test(why), why)
    await view(esha, 'chat-files')
    return `visible to Esha ${scanned} s after upload (Defender: "${status.split('|')[1]}"); download 200 attachment; .exe refused ("${why.split('\n').pop()}")`
  })

ok.group = ok.direct && await tc('CH-06', 'Group: create with two colleagues; members see it live; admin adds/removes; info panel lists members',
  'New group "Claims <tag>" with Esha + Test Emp One → system line; Esha sees the group and posts; Hema removes Test Emp One → the list updates', async () => {
    await hema.getByTestId('chat-new-group').click()
    const dlg = hema.getByRole('dialog', { name: 'New group' })
    await dlg.getByTestId('group-name').fill(`Claims ${tag}`)
    for (const who of ['Esha', 'Test Emp One']) {
      await dlg.getByLabel('Search colleagues to add').fill(who.split(' ').at(-1) === 'One' ? 'Emp One' : who)
      await dlg.getByTestId('chat-person').filter({ hasText: who === 'Esha' ? EMP.name : THIRD.name }).first().click()
    }
    await dlg.getByTestId('group-create').click()
    await until(async () => (await hema.getByTestId('chat-title').innerText()) === `Claims ${tag}`, 'group not open')
    await hema.getByTestId('chat-system').filter({ hasText: 'created the group' }).waitFor()
    // The list re-orders as the group's first lines arrive: click until the group is really open.
    await until(async () => {
      await esha.getByTestId('chat-item').filter({ hasText: `Claims ${tag}` }).click({ timeout: 5000 })
      return (await esha.getByTestId('chat-title').innerText()) === `Claims ${tag}`
    }, 'Esha could not open the group', 20_000)
    await send(esha, `Hi team ${tag}`)
    await bodies(hema).filter({ hasText: `Hi team ${tag}` }).waitFor()
    await hema.getByRole('button', { name: 'Group info' }).click()
    const info = hema.getByTestId('chat-info')
    await info.getByText('Group · 3 members').waitFor()
    await info.getByRole('button', { name: `Remove ${THIRD.name}` }).click()
    await hema.getByRole('dialog', { name: `Remove ${THIRD.name}?` }).getByRole('button', { name: 'Remove' }).click()
    await info.getByText('Group · 2 members').waitFor({ timeout: 10_000 })
    await esha.getByTestId('chat-system').filter({ hasText: `removed ${THIRD.name}` }).waitFor({ timeout: 10_000 })
    await view(hema, 'chat-group')
    await info.getByRole('button', { name: 'Close info' }).click()
    return 'group created, live for Esha, member removed, system lines on both sides'
  })

ok.search = ok.direct && await tc('CH-07', 'Search across chats finds a message and opens it in context', 'Search "Hello Esha <tag>" → Messages result → opens the direct chat highlighted', async () => {
    await hema.getByTestId('chat-search-all').fill(`Hello Esha ${tag}`)
    await hema.getByTestId('chat-search-message').first().click({ timeout: 10_000 })
    await until(async () => (await hema.getByTestId('chat-title').innerText()) === EMP.name, 'did not open the direct chat')
    await hema.locator('[data-seq] .ring-4').first().waitFor({ timeout: 5000 })
    return 'found and highlighted'
  })

ok.mobile = ok.direct && await tc('CH-08', 'Phone (390 px): Chat replaces Calendar in the bottom bar; list → conversation → back; nothing overflows',
  'Bottom bar has Chat; tapping opens the list; a conversation fills the screen with a Back button; no horizontal scroll', async () => {
    const phone = await newPage({ width: 390, height: 844, mobile: true })
    await loginUI(phone, THIRD.email)
    const tab = phone.getByTestId('tab-chat')
    await tab.waitFor({ timeout: 15_000 })
    check((await phone.getByTestId('mobile-tabbar').getByText('Calendar').count()) === 0, 'Calendar still in the bottom bar')
    await tab.click()
    await phone.getByTestId('chat-page').waitFor()
    check(await overflowX(phone) <= 0, `overflow ${await overflowX(phone)} px on the list`)
    await phone.getByTestId('chat-new').click()
    await phone.getByRole('dialog', { name: 'New chat' }).getByLabel('Search colleagues').fill('Hema')
    await phone.getByTestId('chat-person').filter({ hasText: HOST.name }).first().click()
    await phone.getByTestId('chat-view').waitFor()
    check(!(await phone.getByTestId('chat-list').isVisible()), 'list still visible next to the conversation on a phone')
    await send(phone, `From my phone ${tag}`)
    await phone.getByTestId('chat-body').filter({ hasText: `From my phone ${tag}` }).waitFor()
    check(await overflowX(phone) <= 0, `overflow ${await overflowX(phone)} px in the conversation`)
    await view(phone, 'chat-phone')
    await phone.getByTestId('chat-back').click()
    await phone.getByTestId('chat-list').waitFor()
    await phone.context().browser().close()
    return 'Chat tab, full-screen conversation with Back, no overflow'
  })

ok.lastSeen = ok.live && await tc('CH-09', 'Closing the browser shows the person offline with "Last seen" within ~35 s', 'Esha closes her browser → Hema sees "Last seen just now / today at …"', async () => {
    await hema.goto(conversationUrl)
    await hema.getByTestId('chat-view').waitFor()
    await until(async () => /Online/.test(await hema.getByTestId('chat-subtitle').innerText()), 'Esha not online first', 15_000)
    const t0 = Date.now()
    await esha.context().browser().close()
    await until(async () => /Last seen/.test(await hema.getByTestId('chat-subtitle').innerText()), 'still online', 45_000, 1000)
    return `"${await hema.getByTestId('chat-subtitle').innerText()}" after ${((Date.now() - t0) / 1000).toFixed(0)} s`
  })

ok.off = await tc('CH-10', 'Switching CHAT off hides it for everyone; the API refuses', 'Feature off → after reload no Chat menu item, /chat says it is switched off', async () => {
    exec("UPDATE app.FeatureSettings SET IsEnabled = 0 WHERE FeatureKey = 'CHAT'")
    await sleep(11_000) // the API caches the switch for 10 s
    await hema.goto('/dashboard')
    await hema.waitForLoadState('networkidle')
    check((await nav(hema).getByRole('link', { name: /^Chat/ }).count()) === 0, 'Chat still in the menu')
    await hema.goto('/chat')
    await hema.getByText('Chat is switched off by your administrator.').waitFor()
    exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT'")
    return 'hidden; page explains it is off'
  })

await closeAll()
writeResults('chat')
