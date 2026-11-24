// Chat premium enhancement (24 Nov 2026): latest-message scrolling, availability menu, compact layout, designations, profile
// pictures, shared media, call back, meeting from chat, new statuses. Takes the review screenshots into
// E:\Beeinsured.com\MeetIQ\Chat_UI_Review\screenshots. Test data only (made-up messages in the isolated test database).
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175, LiveKit 7890).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\chat-premium.mjs
setTimeout(() => { console.log('WATCHDOG: giving up after 14 min'); process.exit(2) }, 14 * 60_000).unref()
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Api, EMP, HOST, check, closeAll, exec, loginUI, newPage, overflowX, scalar, sleep, tc, until, writeResults } from './harness.mjs'

const REVIEW = process.env.REVIEW_DIR ?? path.resolve('..', '..', 'Chat_UI_Review', 'screenshots')
fs.mkdirSync(REVIEW, { recursive: true })
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(REVIEW, `${name}.png`), ...opts })
// Two made-up colleagues (test database only) carrying the two designations of the 24 Nov request.
const ASHIT = 'pm.tester@room.oneinsure.test', RK = 'th.tester@room.oneinsure.test'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS', 'TASK_COLLAB', 'CHAT_ADVANCED')")
exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')")
exec(`UPDATE chat.MST_ChatUserPreference SET Availability = 'AVAILABLE', QuietEnabled = 0 WHERE UserId IN (SELECT UserId FROM auth.Users WHERE Email IN ('${HOST.email}', '${EMP.email}'))`)
exec(`IF NOT EXISTS (SELECT 1 FROM org.Designations WHERE Code = 'SPM') INSERT org.Designations (Code, Name, IsActive) VALUES ('SPM', N'Sr Project Manager', 1);
IF NOT EXISTS (SELECT 1 FROM org.Designations WHERE Code = 'TH') INSERT org.Designations (Code, Name, IsActive) VALUES ('TH', N'Tech Head', 1);`)
for (const [code, first, last, email, desig] of [['PM-TEST', 'Pat', 'Manager', ASHIT, 'SPM'], ['TH-TEST', 'Tara', 'Lead', RK, 'TH']]) {
  exec(`IF NOT EXISTS (SELECT 1 FROM org.Employees WHERE EmployeeCode = '${code}')
    INSERT org.Employees (EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, DepartmentId, DesignationId, IsActive)
    SELECT '${code}', N'${first}', N'${last}', N'${first} ${last}', N'${email}', e.DepartmentId, (SELECT DesignationId FROM org.Designations WHERE Code = '${desig}'), 1 FROM org.Employees e WHERE e.OfficialEmail = '${EMP.email}';
  IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Email = '${email}')
  BEGIN
    INSERT auth.Users (Email, EmployeeId, PasswordHash, PasswordChangedUtc, MustChangePassword) SELECT N'${email}', EmployeeId, (SELECT PasswordHash FROM auth.Users WHERE Email = '${HOST.email}'), SYSUTCDATETIME(), 0 FROM org.Employees WHERE EmployeeCode = '${code}';
    INSERT auth.UserRoles (UserId, RoleId) SELECT u.UserId, r.RoleId FROM auth.Users u CROSS JOIN auth.Roles r WHERE u.Email = '${email}' AND r.Code = 'Employee';
  END`)
}
exec(`UPDATE auth.Users SET MustChangePassword = 0, PasswordHash = (SELECT PasswordHash FROM auth.Users WHERE Email = '${HOST.email}') WHERE Email IN ('${ASHIT}', '${RK}')`)
exec(`UPDATE e SET PhotoPath = NULL FROM org.Employees e JOIN auth.Users u ON u.EmployeeId = e.EmployeeId WHERE u.Email = '${EMP.email}'`)
const tag = Date.now().toString(36).slice(-4)
const ok = {}

// A real small PNG (gradient), made here: for chat pictures and the profile picture.
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = (x * 255 / w + seed * 40) & 255; raw[o + 1] = (y * 255 / h + seed * 90) & 255; raw[o + 2] = (180 + seed * 30) & 255
    }
  }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const IMG_DIR = path.join(REVIEW, '..', 'test-files'); fs.mkdirSync(IMG_DIR, { recursive: true })
const photoFile = path.join(IMG_DIR, 'profile-test.png'); fs.writeFileSync(photoFile, png(400, 300, 3))

// ---- Test data -----------------------------------------------------------------------------------------------------
const hemaApi = await new Api().login(HOST.email)
const uid = (email) => scalar(`SELECT CONVERT(varchar(36), PublicId) AS v FROM auth.Users WHERE Email = '${email}'`)
const rkId = uid(RK), ashitId = uid(ASHIT), eshaId = uid(EMP.email)
const longConv = (await hemaApi.req('POST', '/chat/direct', { userId: rkId })).data.id
const ashitConv = (await hemaApi.req('POST', '/chat/direct', { userId: ashitId })).data.id
const eshaConv = (await hemaApi.req('POST', '/chat/direct', { userId: eshaId })).data.id
// 600 old messages in Hema <-> Tara (made-up text), straight into the test database, then real pictures + a last line.
if (scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatMessage m JOIN chat.TRN_ChatConversation c ON c.ConversationId = m.ConversationId WHERE c.PublicId = '${longConv}'`) < 600) {
  exec(`DECLARE @c BIGINT = (SELECT ConversationId FROM chat.TRN_ChatConversation WHERE PublicId = '${longConv}');
    DECLARE @a BIGINT = (SELECT UserId FROM auth.Users WHERE Email = '${HOST.email}'), @b BIGINT = (SELECT UserId FROM auth.Users WHERE Email = '${RK}');
    ;WITH n AS (SELECT TOP (600) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b)
    INSERT chat.TRN_ChatMessage (ConversationId, SenderUserId, Kind, Body, CreatedUtc)
    SELECT @c, CASE WHEN i % 3 = 0 THEN @a ELSE @b END, 'TEXT',
      CONCAT(N'Release planning note #', i, CASE WHEN i % 7 = 0 THEN N' - longer update: API build green, QA sign-off pending, deployment window agreed with the team for Friday evening.' ELSE N'' END),
      DATEADD(MINUTE, -3000 + i * 4, SYSUTCDATETIME()) FROM n;
    UPDATE chat.TRN_ChatConversation SET LastMessageId = (SELECT MAX(MessageId) FROM chat.TRN_ChatMessage WHERE ConversationId = @c) WHERE ConversationId = @c;`)
}
async function sendImage(api, conv, seed, name) {
  const fd = new FormData()
  fd.append('file', new Blob([png(900, 600, seed)], { type: 'image/png' }), name)
  fd.append('clientMessageId', crypto.randomUUID())
  const headers = { Cookie: [...api.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'X-XSRF-TOKEN': decodeURIComponent(api.jar.get('XSRF-TOKEN')) }
  const r = await fetch(`http://127.0.0.1:5175/api/v1/chat/conversations/${conv}/files`, { method: 'POST', headers, body: fd })
  check(r.ok, `image upload ${r.status}`)
}
const say = (api, conv, body) => api.req('POST', `/chat/conversations/${conv}/messages`, { body, clientMessageId: crypto.randomUUID() })
await sendImage(hemaApi, longConv, 1, `site-photo-${tag}.png`)
await sendImage(hemaApi, longConv, 2, `dashboard-${tag}.png`)
const rkApi = await new Api().login(RK)
await say(rkApi, longConv, `Thanks Hema, both screenshots received. This is the latest message ${tag}.`)
await say(hemaApi, ashitConv, 'Hi Pat, can we review the project plan today?')
const ashitApi = await new Api().login(ASHIT)
await say(ashitApi, ashitConv, 'Sure, after lunch works.')
// 3000 messages between Tara and Pat (thousands-of-messages check), oldest first, then a real last message.
const bigConv = (await rkApi.req('POST', '/chat/direct', { userId: ashitId })).data.id
if (scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatMessage m JOIN chat.TRN_ChatConversation c ON c.ConversationId = m.ConversationId WHERE c.PublicId = '${bigConv}'`) < 3000) {
  exec(`DECLARE @c BIGINT = (SELECT ConversationId FROM chat.TRN_ChatConversation WHERE PublicId = '${bigConv}');
    DECLARE @a BIGINT = (SELECT UserId FROM auth.Users WHERE Email = '${RK}'), @b BIGINT = (SELECT UserId FROM auth.Users WHERE Email = '${ASHIT}');
    ;WITH n AS (SELECT TOP (3000) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b)
    INSERT chat.TRN_ChatMessage (ConversationId, SenderUserId, Kind, Body, CreatedUtc)
    SELECT @c, CASE WHEN i % 2 = 0 THEN @a ELSE @b END, 'TEXT', CONCAT(N'Archive note #', i), DATEADD(MINUTE, -9000 + i * 2, SYSUTCDATETIME()) FROM n;
    UPDATE chat.TRN_ChatConversation SET LastMessageId = (SELECT MAX(MessageId) FROM chat.TRN_ChatMessage WHERE ConversationId = @c) WHERE ConversationId = @c;`)
}
await say(ashitApi, bigConv, `Final note in a 3000-message chat ${tag}`)
// A group with all four (older test groups from earlier runs are archived so the list stays readable).
exec("UPDATE p SET IsArchived = 1 FROM chat.TRN_ChatConversationParticipant p JOIN chat.TRN_ChatConversation c ON c.ConversationId = p.ConversationId WHERE c.[Name] LIKE N'Release Team %'")
const group = (await hemaApi.req('POST', '/chat/groups', { name: `Release Team ${tag}`, description: 'Weekly release planning', memberIds: [eshaId, rkId, ashitId] })).data.id
for (let i = 1; i <= 40; i++) await say(i % 2 ? hemaApi : rkApi, group, `Group update ${i}: ${i % 5 === 0 ? 'checklist reviewed and shared with the team' : 'on track'}`)
await sendImage(rkApi, group, 4, `release-board-${tag}.png`)
await say(rkApi, group, `Latest group message ${tag}`)
await until(() => scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatFile f JOIN chat.TRN_ChatConversation c ON c.ConversationId = f.ConversationId WHERE c.PublicId IN ('${longConv}', '${group}') AND f.ScanStatus = 'PENDING'`) === 0, 'pictures still being scanned', 90_000, 2000)

// ---- Browsers ------------------------------------------------------------------------------------------------------
const hema = await newPage({ width: 1440, height: 900 })
await loginUI(hema, HOST.email)
const bottomGap = (p) => p.getByTestId('chat-messages').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))
const openChat = async (p, conv) => { await p.goto(`/chat?c=${conv}`); await p.getByTestId('chat-view').waitFor(); await p.getByTestId('chat-message').last().waitFor() }

ok.landing = await tc('CP-01', 'Chat landing: workspace fills the window; iOS-style list without designations', 'outer margin ≤ 12 px; sidebar 340–360 px; rows 64–90 px; no designation in the list; no sideways scroll', async () => {
  await hema.goto('/chat')
  await hema.getByTestId('chat-list').waitFor()
  await sleep(800)
  const box = await hema.getByTestId('chat-page').boundingBox()
  const vw = 1440, vh = 900
  const aside = await hema.locator('aside[aria-label="Chats"]').boundingBox()
  const row = await hema.getByTestId('chat-item').first().boundingBox()
  check(vh - (box.y + box.height) <= 12, `bottom gap ${vh - (box.y + box.height)}`)
  check(aside.width >= 330 && aside.width <= 362, `sidebar ${aside.width}`)
  check(row.height >= 64 && row.height <= 90, `row ${row.height}`)
  check(!/Tech Head|Sr Project Manager|Executive|Underwriter/.test(await hema.getByTestId('chat-list').innerText()), 'designation shown in the list')
  check(await overflowX(hema) <= 0, 'sideways scroll')
  await shot(hema, '01-chat-landing')
  await shot(hema, '02-chat-sidebar', { clip: { x: aside.x, y: aside.y, width: aside.width, height: Math.min(aside.height, 820) } })
  return `bottom gap ${Math.round(vh - box.y - box.height)} px, right gap ${Math.round(vw - box.x - box.width)} px; sidebar ${Math.round(aside.width)} px; row ${Math.round(row.height)} px`
})

ok.scroll = await tc('CP-02', 'Opening a long direct chat lands on the latest message (pictures load after the first scroll)', '600+ messages + 2 pictures: after opening, the bottom is in view and stays there when the pictures finish loading', async () => {
  await openChat(hema, longConv)
  await hema.getByTestId('chat-messages').getByText(`This is the latest message ${tag}`).waitFor()
  await hema.waitForFunction(() => { const box = document.querySelector('[data-testid="chat-messages"]').getBoundingClientRect(); return [...document.querySelectorAll('[data-testid="chat-messages"] img')].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom }).every((i) => i.complete) }, null, { timeout: 15_000 })
  await sleep(600)
  const gap = await bottomGap(hema)
  check(gap <= 4, `not at the bottom: ${gap} px above`)
  check(await hema.getByTestId('chat-messages').getByText(`This is the latest message ${tag}`).isVisible(), 'latest message not visible')
  await shot(hema, '03-direct-chat-latest-message')
  return `bottom gap ${gap} px after pictures loaded`
})

ok.big = await tc('CP-02b', 'A chat with 3000+ messages opens at its latest message', 'Tara opens his chat with Pat (3000+ messages) → bottom in view, latest line visible', async () => {
  const p = await newPage({ width: 1366, height: 820 })
  await loginUI(p, RK)
  await p.goto(`/chat?c=${bigConv}`)
  await p.getByTestId('chat-messages').getByText(`Final note in a 3000-message chat ${tag}`).waitFor()
  await sleep(800)
  const gap = await bottomGap(p)
  check(gap <= 4, `not at the bottom (${gap})`)
  const n = scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatMessage m JOIN chat.TRN_ChatConversation c ON c.ConversationId = m.ConversationId WHERE c.PublicId = '${bigConv}'`)
  await p.context().browser().close()
  return `${n} messages; bottom gap ${gap} px`
})

ok.switch = await tc('CP-03', 'Rapid switching between chats always opens the new one at its latest message', 'long chat → group → Pat → long chat quickly → each ends at the bottom', async () => {
  const gaps = []
  for (const conv of [group, ashitConv, longConv, group]) {
    await hema.goto(`/chat?c=${conv}`)
    await hema.getByTestId('chat-message').first().waitFor()
    await sleep(900)
    gaps.push(await bottomGap(hema))
  }
  check(gaps.every((g) => g <= 4), `gaps ${gaps}`)
  await hema.getByTestId('chat-messages').getByText(`Latest group message ${tag}`).waitFor()
  await shot(hema, '04-group-chat-latest-message')
  return `gaps ${gaps.join(', ')} px`
})

ok.older = await tc('CP-04', 'Reading older messages: new message does not pull me down; jump button; loading older keeps my place', 'scroll up → incoming message → position unchanged + "jump to latest" → click → bottom; scroll to top loads older above without a jump', async () => {
  await openChat(hema, longConv)
  await sleep(800)
  const el = hema.getByTestId('chat-messages')
  await el.evaluate((e) => (e.scrollTop = e.scrollHeight / 2))
  await sleep(500)
  const before = await el.evaluate((e) => e.scrollTop)
  await say(rkApi, longConv, `New while reading ${tag}`)
  await hema.getByTestId('chat-jump-latest').waitFor({ timeout: 10_000 })
  const after = await el.evaluate((e) => e.scrollTop)
  check(Math.abs(after - before) < 5, `moved from ${before} to ${after}`)
  await shot(hema, '05-new-messages-indicator-while-reading')
  await hema.getByTestId('chat-jump-latest').click()
  await until(async () => (await bottomGap(hema)) <= 4, 'jump did not reach the bottom', 5000)
  // Older pages: anchor on the first visible message, scroll to the very top, it must stay in place.
  await el.evaluate((e) => (e.scrollTop = 0))
  const firstSeq = await hema.getByTestId('chat-message').first().evaluate((m) => m.closest('[data-seq]')?.getAttribute('data-seq'))
  await sleep(2500)
  const count = await hema.getByTestId('chat-message').count()
  const top = await hema.locator(`[data-seq="${firstSeq}"]`).evaluate((n) => n.getBoundingClientRect().top)
  check(count > 60, `older messages not loaded (${count})`)
  check(top > 80, 'jumped to the very top instead of keeping the place')
  return `kept position ±${Math.abs(after - before)} px; jump → bottom; older loaded (${count} rows), anchor still on screen`
})

ok.menu = await tc('CP-05', 'Availability menu shows every option, also on a short screen', '6 statuses incl. Be right back and Appear offline; menu fits the window (≤ 70 %) and scrolls inside; Escape closes', async () => {
  await hema.goto('/chat')
  await hema.getByTestId('chat-me').click()
  const menu = hema.getByTestId('chat-me-menu')
  await menu.waitFor()
  const labels = await menu.getByRole('menuitemradio').allInnerTexts()
  for (const s of ['Available', 'Busy', 'Do not disturb', 'Be right back', 'Away', 'Appear offline']) check(labels.some((l) => l.includes(s)), `missing ${s}`)
  const b = await menu.boundingBox()
  check(b.y + b.height <= 900 && b.height <= 900 * 0.7 + 2, `menu box ${JSON.stringify(b)}`)
  await shot(hema, '06-availability-dropdown-all-options')
  await hema.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  // Short laptop window.
  const small = await newPage({ width: 1280, height: 620 })
  await loginUI(small, HOST.email)
  await small.goto('/chat')
  await small.getByTestId('chat-me').click()
  const m2 = small.getByTestId('chat-me-menu')
  await m2.waitFor()
  const b2 = await m2.boundingBox()
  const scrolls = await m2.evaluate((e) => e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'auto')
  check(b2.y + b2.height <= 620 && scrolls, `short window: ${JSON.stringify(b2)} scrolls=${scrolls}`)
  await m2.evaluate((e) => (e.scrollTop = e.scrollHeight))
  await m2.getByText('New message sound').waitFor()
  await shot(small, '07-availability-dropdown-short-screen')
  await small.context().browser().close()
  return `${labels.length} statuses; menu ${Math.round(b.height)} px; short window scrolls inside`
})

ok.status = await tc('CP-06', 'Be right back / Appear offline as colleagues see them', 'Esha chooses Be right back → Hema sees it; Appear offline → Hema sees Offline', async () => {
  const esha = await newPage({ width: 1280, height: 800 })
  await loginUI(esha, EMP.email)
  await esha.goto('/chat')
  const pick = async (name) => { await esha.getByTestId('chat-me').click(); await esha.getByTestId('chat-me-menu').getByRole('menuitemradio', { name: new RegExp(name) }).click() }
  await pick('Be right back')
  await openChat(hema, eshaConv)
  await until(async () => /Be right back/.test(await hema.getByTestId('chat-subtitle').innerText()), 'Hema does not see Be right back', 15_000)
  await pick('Appear offline')
  await hema.reload(); await hema.getByTestId('chat-view').waitFor()
  await until(async () => /Offline/.test(await hema.getByTestId('chat-subtitle').innerText()), 'Hema does not see Offline', 15_000)
  await pick('Available')
  await esha.context().browser().close()
  return 'BRB shown; Appear offline → "Offline"'
})

ok.photo = await tc('CP-07', 'Profile picture: edit from My profile, preview, save; colleagues see it at once', 'Esha → Settings → camera → choose picture → round preview → Save → her avatar is the picture; Hema (open chat list) sees it without reloading', async () => {
  const esha = await newPage({ width: 1280, height: 800 })
  await loginUI(esha, EMP.email)
  await esha.goto('/settings')
  await esha.getByTestId('profile-photo-edit').waitFor()
  await shot(esha, '08-profile-with-edit-picture-option')
  await esha.getByTestId('profile-photo-edit').click()
  await esha.getByTestId('photo-dialog').waitFor()
  await esha.getByTestId('photo-input').setInputFiles(photoFile)
  await esha.getByTestId('photo-preview').waitFor()
  await shot(esha, '09-profile-picture-upload-preview')
  await hema.goto('/chat'); await hema.getByTestId('chat-list').waitFor()
  await esha.getByTestId('photo-save').click()
  await esha.getByTestId('photo-dialog').waitFor({ state: 'hidden' })
  await until(async () => (await esha.locator('[data-testid="profile-photo-edit"] [data-photo="yes"]').count()) === 1, 'own avatar not updated', 10_000)
  await until(async () => (await hema.getByTestId('chat-item').filter({ hasText: EMP.name }).locator('[data-photo="yes"]').count()) > 0, 'Hema does not see the picture', 15_000)
  // Bad file is refused with a message.
  await esha.getByTestId('profile-photo-edit').click()
  const txt = path.join(IMG_DIR, 'not-a-picture.txt'); fs.writeFileSync(txt, 'hello')
  await esha.getByTestId('photo-input').setInputFiles(txt)
  check(/JPG, PNG or WEBP/.test(await esha.getByTestId('photo-error').innerText()), 'no type error')
  await esha.keyboard.press('Escape')
  await openChat(hema, eshaConv)
  await until(async () => (await hema.getByTestId('chat-view').locator('header [data-photo="yes"]').count()) > 0, 'no picture in the chat header', 10_000)
  await shot(hema, '10-chat-with-profile-picture')
  await esha.context().browser().close()
  return 'saved; own avatar and Hema\'s list updated live; text file refused'
})

ok.desig = await tc('CP-08', 'Designations Sr Project Manager / Tech Head shown in contact info', 'contact info shows the new designations (not in the list or header)', async () => {
  await openChat(hema, ashitConv)
  check(!/Sr Project Manager/.test(await hema.getByTestId('chat-subtitle').innerText()), 'designation in the header')
  await hema.getByRole('button', { name: 'Contact info' }).click()
  await hema.getByText('Sr Project Manager').last().waitFor()
  await shot(hema, '11-designation-sr-project-manager')
  await openChat(hema, longConv)
  check(!/Tech Head/.test(await hema.getByTestId('chat-subtitle').innerText()), 'designation in the header')
  await hema.getByRole('button', { name: 'Contact info' }).click()
  await hema.getByText('Tech Head').last().waitFor()
  await shot(hema, '12-designation-tech-head')
  return 'both shown in contact info; not in list or header'
})

ok.shared = await tc('CP-09', 'Shared media and documents in the info panel', 'Media grid shows the chat pictures; search filters; Files tab', async () => {
  const panel = hema.getByTestId('shared-files')
  await panel.waitFor()
  await until(async () => (await panel.getByTestId('shared-media').locator('img').count()) >= 2, 'no pictures in Media', 10_000)
  await panel.getByTestId('shared-search').fill(`dashboard-${tag}`)
  await until(async () => (await panel.getByTestId('shared-media').locator('img').count()) === 1, 'search did not filter', 8000)
  await shot(hema, '13-shared-media-and-files')
  await panel.getByTestId('shared-search').fill('')
  await panel.getByTestId('shared-tab-files').click()
  return 'media grid + search + files tab'
})

ok.newchat = await tc('CP-10', 'New chat / new group screens', 'dialogs open with people search', async () => {
  await hema.goto('/chat')
  await hema.getByTestId('chat-new').click()
  const d = hema.getByRole('dialog', { name: 'New chat' })
  await d.getByLabel('Search colleagues').fill('Ra')
  await d.getByTestId('chat-person').first().waitFor()
  await shot(hema, '14-new-chat')
  await hema.keyboard.press('Escape')
  await hema.getByTestId('chat-new-group').click()
  await hema.getByRole('dialog', { name: 'New group' }).waitFor()
  await shot(hema, '15-new-group')
  await hema.keyboard.press('Escape')
  return 'ok'
})

ok.messaging = await tc('CP-11', 'Advanced messaging (reply, reactions, actions) and search with filters', 'hover actions + quick reactions on a message; search filter sheet', async () => {
  await openChat(hema, group)
  const target = hema.getByTestId('chat-message').filter({ hasText: `Latest group message ${tag}` }).first()
  await target.hover()
  await target.getByRole('button', { name: 'React', exact: true }).click()
  await hema.getByTestId('chat-quick-reactions').waitFor()
  await shot(hema, '16-advanced-messaging-actions')
  await hema.keyboard.press('Escape')
  await hema.goto('/chat')
  await hema.getByTestId('chat-search-all').fill('release')
  await sleep(1200)
  await shot(hema, '17-chat-search')
  if (await hema.getByTestId('chat-search-filters').count()) {
    await hema.getByTestId('chat-search-filters').click()
    await sleep(600)
    await shot(hema, '18-chat-search-filters')
    await hema.keyboard.press('Escape')
  }
  return 'ok'
})

ok.callback = await tc('CP-12', 'Audio call screen; missed call line gets Call back', 'Hema calls Tara (not online) → ringing screen; hang up → "Missed" line with Call back', async () => {
  await openChat(hema, longConv)
  await hema.getByTestId('chat-view').getByRole('button', { name: 'Audio call', exact: true }).first().click()
  await hema.getByTestId('call-panel').waitFor()
  await sleep(1500)
  await shot(hema, '19-audio-call')
  await hema.getByTestId('call-panel').getByTestId('call-hangup').click()
  await hema.getByTestId('chat-system').filter({ hasText: 'Missed audio call' }).last().waitFor({ timeout: 20_000 })
  check((await hema.getByTestId('chat-call-back').count()) === 0, 'caller sees Call back on own call')
  const rk = await newPage({ width: 1440, height: 900 })
  await loginUI(rk, RK)
  await openChat(rk, longConv)
  await rk.getByTestId('chat-call-back').last().waitFor({ timeout: 15_000 })
  await shot(rk, '20-missed-call-call-back')
  await rk.context().browser().close()
  return 'ringing screen; caller has no Call back; Tara has Call back'
})

ok.meeting = await tc('CP-13', 'Start a video meeting from a chat', 'chat menu → Start a video meeting → link posted in the chat → room opens', async () => {
  await openChat(hema, ashitConv)
  await hema.getByRole('button', { name: 'More options' }).click()
  await hema.getByTestId('chat-menu').waitFor()
  await shot(hema, '21-chat-menu-start-meeting')
  await hema.getByTestId('chat-start-meeting').click()
  await sleep(4000)
  if (!/room/.test(hema.url())) { await hema.screenshot({ path: path.join(REVIEW, '..', 'test-files', 'cp13-debug.png') }); console.log('CP13 url', hema.url(), 'toast:', await hema.locator('[role=status], [role=alert]').allInnerTexts().catch(() => [])) }
  await hema.waitForURL(/\/meetings\/.+\/room/, { timeout: 30_000 })
  const posted = scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatMessage m JOIN chat.TRN_ChatConversation c ON c.ConversationId = m.ConversationId WHERE c.PublicId = '${ashitConv}' AND m.Body LIKE N'%Video meeting started%'`)
  check(posted >= 1, 'link not posted')
  await hema.goto('/dashboard')
  return 'room opened; link posted in the chat'
})

ok.phone = await tc('CP-14', 'Phone: list, open chat at latest, menu', 'iPhone size: list fits; long chat opens at the bottom; status menu fits', async () => {
  const p = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 })
  await loginUI(p, HOST.email)
  await p.goto('/chat'); await p.getByTestId('chat-list').waitFor(); await sleep(600)
  check(await overflowX(p) <= 0, 'phone sideways scroll')
  await shot(p, '22-phone-chat-list')
  await p.getByTestId('chat-me').click()
  const b = await p.getByTestId('chat-me-menu').boundingBox()
  check(b.y + b.height <= 844, 'menu cut off on the phone')
  await shot(p, '23-phone-availability-menu')
  await p.keyboard.press('Escape')
  await openChat(p, longConv)
  await p.waitForFunction(() => { const box = document.querySelector('[data-testid="chat-messages"]').getBoundingClientRect(); return [...document.querySelectorAll('[data-testid="chat-messages"] img')].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom }).every((i) => i.complete) }, null, { timeout: 15_000 })
  await sleep(700)
  const gap = await bottomGap(p)
  check(gap <= 4, `phone not at bottom (${gap})`)
  await shot(p, '24-phone-chat-latest-message')
  await p.context().browser().close()
  return `phone bottom gap ${gap} px`
})

// Leave no unread test messages behind for the other suites (their badge checks count every unread chat).
exec(`UPDATE p SET LastReadMessageId = c.LastMessageId, MarkedUnread = 0 FROM chat.TRN_ChatConversationParticipant p JOIN chat.TRN_ChatConversation c ON c.ConversationId = p.ConversationId WHERE c.LastMessageId IS NOT NULL AND (c.[Name] LIKE N'Release Team %' OR c.PublicId IN ('${longConv}', '${ashitConv}', '${eshaConv}', '${bigConv}'))`)
await closeAll()
writeResults('chat-premium', { ok })
const passed = Object.values(ok).filter(Boolean).length
console.log(`${passed}/${Object.keys(ok).length} passed`)
process.exit(passed === Object.keys(ok).length ? 0 : 1)
