// Task collaboration (V033, 21 Nov 2026): Hema (computer) assigns a task with "needs my review" and a required checklist
// step to Esha (Android phone); Esha gets the live alert, accepts from it, ticks the step, sends it for review; Hema sends it
// back, Esha sends again, Hema approves from the alert. Also: My Day hero / Top 3, quick add, note checklist + share, iPhone.
// Isolated environment only (LocalDB *_Room, API 7191, Vite 5175).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\task-collab.mjs
setTimeout(() => { console.log('WATCHDOG: test still running after 9 min - giving up'); process.exit(2) }, 9 * 60_000).unref()
import { webkit, devices } from 'playwright-core'
import path from 'node:path'
import { Api, EMP, HOST, SHOTS, check, closeAll, exec, loginUI, newPage, overflowX, scalar, sleep, tc, until, view, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_TASKS', 'TASK_COLLAB')")
const tag = Date.now().toString(36).slice(-5)
const TITLE = `Prepare Sharma renewal ${tag}`
const ok = {}

const hema = await newPage({ width: 1366, height: 860 })
await loginUI(hema, HOST.email)
const esha = await newPage({ width: 412, height: 915, mobile: true })
await loginUI(esha, EMP.email)
const eshaApi = await new Api().login(EMP.email)
let taskId = null

ok.assign = await tc('TC-01', 'Hema assigns a task with review and a required step', 'assign sheet: pick Esha, needs review on, required step; toast; the task shows under "Assigned by me"', async () => {
  await hema.goto('/tasks?filter=delegated')
  await hema.getByTestId('tasks-view').waitFor()
  await hema.getByTestId('task-new').click()
  const ed = hema.getByTestId('task-editor')
  await ed.getByTestId('task-title').fill(TITLE)
  await ed.getByTestId('task-assign').click()
  const pick = hema.getByTestId('assignee-picker')
  await pick.getByTestId('assignee-search').fill('Esha')
  await pick.getByTestId('assignee-option').filter({ hasText: 'Esha' }).first().click()
  await pick.getByTestId('sheet-done').click()
  check(await ed.getByTestId('task-requires-review').isChecked(), 'needs review should start on in "Assigned by me"')
  await ed.getByTestId('draft-step').fill('Collect the KYC documents')
  await ed.getByTestId('draft-step').press('Enter')
  await ed.getByTestId('draft-required').click()
  await view(hema, 'tc01-assign-sheet')
  await ed.getByTestId('sheet-done').click()
  await hema.getByTestId('task-row').filter({ hasText: TITLE }).waitFor()
  taskId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS v FROM chat.TRN_ChatTask WHERE Title = N'${TITLE}' AND IsActive = 1`)
  check(taskId, 'no copy created')
  check(scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatTaskChecklist c JOIN chat.TRN_ChatTask t ON t.TaskId = c.TaskId WHERE t.PublicId = '${taskId}' AND c.IsRequired = 1`) === 1, 'required step missing')
  await view(hema, 'tc01-delegated')
  return `copy ${taskId.slice(0, 8)} for Esha`
})

ok.alert = ok.assign && await tc('TC-02', 'Esha sees the live alert and accepts from it', 'task-alert with Accept within 10 s; after Accept the task is ACCEPTED; bell row TASK_ASSIGNED', async () => {
  await esha.goto('/my-day')
  // The alert may have arrived before the page was open: assign a second one to see it live.
  const second = `Call Mr Sharma ${tag}`
  const hemaApi = await new Api().login(HOST.email)
  const eshaId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS v FROM auth.Users WHERE Email = '${EMP.email}'`)
  await esha.getByTestId('myday-view').waitFor()
  await sleep(1500)
  await hemaApi.req('POST', '/chat/tasks', { title: second, assigneeIds: [eshaId] })
  const alert = esha.getByTestId('task-alert')
  await alert.waitFor({ timeout: 10_000 })
  check((await alert.getByTestId('task-alert-title').innerText()).includes(second), 'alert title')
  await view(esha, 'tc02-alert-phone')
  await alert.getByTestId('task-alert-accept').click()
  await until(() => scalar(`SELECT AssignState AS v FROM chat.TRN_ChatTask WHERE Title = N'${second}'`) === 'ACCEPTED', 'not accepted from the alert')
  check(scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = '${EMP.email}' AND n.[Type] = 'TASK_ASSIGNED' AND n.Title LIKE N'%${TITLE}%'`) === 1, 'bell row missing')
  return 'alert → Accept'
})

ok.work = ok.assign && await tc('TC-03', 'Esha opens the task: locked details, required step, send for review', 'banner + progress; Send for review disabled until the required step is ticked; then IN_REVIEW', async () => {
  await esha.goto(`/tasks?task=${taskId}`)
  const ed = esha.getByTestId('task-editor')
  await ed.getByTestId('task-locked').waitFor()
  await ed.getByTestId('task-progress').waitFor()
  await ed.getByTestId('task-accept').click()
  await ed.getByTestId('banner-working').waitFor()
  check(await ed.getByTestId('task-submit').isDisabled(), 'Send for review should wait for the required step')
  await ed.getByTestId('checklist-tick').first().click()
  await until(async () => !(await ed.getByTestId('task-submit').isDisabled()), 'submit stays disabled after ticking')
  check(await overflowX(esha) <= 0, 'task sheet scrolls sideways on the phone')
  await view(esha, 'tc03-task-phone')
  await ed.getByTestId('task-submit').click()
  const p = esha.getByTestId('prompt-submit')
  await p.getByTestId('prompt-text').fill('KYC done, quote attached')
  await p.getByTestId('sheet-done').click()
  await until(() => scalar(`SELECT [Status] AS v FROM chat.TRN_ChatTask WHERE PublicId = '${taskId}'`) === 'IN_REVIEW', 'not in review')
  return 'IN_REVIEW'
})

ok.review = ok.work && await tc('TC-04', 'Hema sends it back, Esha re-sends, Hema approves from the alert', 'review banner; send back needs a comment; Esha gets the comment; approve → COMPLETED', async () => {
  await hema.goto(`/tasks?filter=to-review&task=${taskId}`)
  const ed = hema.getByTestId('task-editor')
  await ed.getByTestId('banner-review').waitFor()
  await view(hema, 'tc04-review')
  await ed.getByTestId('task-return').click()
  const p = hema.getByTestId('prompt-return')
  check(await p.getByTestId('sheet-done').isDisabled(), 'send back without a comment')
  await p.getByTestId('prompt-text').fill('Add the GST line please')
  await p.getByTestId('sheet-done').click()
  await until(() => scalar(`SELECT [Status] AS v FROM chat.TRN_ChatTask WHERE PublicId = '${taskId}'`) === 'IN_PROGRESS', 'not sent back')
  await ed.getByTestId('activity-event').filter({ hasText: 'GST' }).waitFor()
  await ed.getByTestId('task-comment').fill('Thanks Esha')
  await ed.getByTestId('task-comment-send').click()
  await ed.getByTestId('activity-comment').filter({ hasText: 'Thanks Esha' }).waitFor()
  await hema.keyboard.press('Escape')
  await sleep(800)
  await eshaApi.req('POST', `/chat/tasks/${taskId}/submit`, { note: 'GST added' })
  const alert = hema.getByTestId('task-alert').filter({ hasText: TITLE })
  await alert.waitFor({ timeout: 10_000 })
  await alert.getByTestId('task-alert-approve').click()
  await until(() => scalar(`SELECT [Status] AS v FROM chat.TRN_ChatTask WHERE PublicId = '${taskId}'`) === 'COMPLETED', 'not approved')
  const kinds = (await eshaApi.req('GET', `/chat/tasks/${taskId}/details`)).data.activity.map((a) => a.kind).join(',')
  check(kinds === 'ASSIGNED,ACCEPTED,SUBMITTED,RETURNED,COMMENT,SUBMITTED,APPROVED', `history ${kinds}`)
  return kinds
})

ok.myday = await tc('TC-05', 'My Day: hero ring, Top 3, quick add in plain words', 'hero shows progress; quick add "… tomorrow 4pm urgent" → due tomorrow 16:00 URGENT; ☆ Add puts it in Top 3', async () => {
  await hema.goto('/tasks?filter=today')
  const qa = hema.getByTestId('quick-add-input')
  await qa.fill(`Ring the branch ${tag} tomorrow 4pm urgent`)
  await hema.getByTestId('quick-add-preview').waitFor()
  await qa.press('Enter')
  await until(() => scalar(`SELECT [Priority] AS v FROM chat.TRN_ChatTask WHERE Title = N'Ring the branch ${tag}'`) === 'URGENT', 'quick add priority')
  const due = new Date(scalar(`SELECT CONVERT(varchar(30), DueUtc, 126) AS v FROM chat.TRN_ChatTask WHERE Title = N'Ring the branch ${tag}'`) + 'Z')
  const t = new Date(); t.setDate(t.getDate() + 1)
  check(due.getDate() === t.getDate() && due.getHours() === 16, `due ${due}`)
  const own = await new Api().login(HOST.email)
  const today = (await own.req('POST', '/chat/tasks', { title: `Top task ${tag}`, priority: 'HIGH', dueUtc: new Date(new Date().setHours(23, 59, 0, 0)).toISOString() })).data
  exec(`UPDATE chat.TRN_ChatTask SET FocusUtc = NULL WHERE OwnerUserId = (SELECT UserId FROM auth.Users WHERE Email = '${HOST.email}')`)
  await hema.goto('/my-day')
  await hema.getByTestId('myday-hero').waitFor()
  await hema.getByTestId('myday-focus').getByTestId('focus-suggest').first().click()
  await until(() => scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatTask WHERE OwnerUserId = (SELECT UserId FROM auth.Users WHERE Email = '${HOST.email}') AND FocusUtc IS NOT NULL`) === 1, 'Top 3 not set')
  await view(hema, 'tc05-myday')
  await esha.goto('/my-day')
  await esha.getByTestId('myday-hero').waitFor()
  check(await overflowX(esha) <= 0, 'My Day scrolls sideways on the phone')
  await view(esha, 'tc05-myday-phone')
  return `quick add + Top 3 (${today.id.slice(0, 8)})`
})

ok.notes = await tc('TC-06', 'Note with checklist and colour, line → task, shared read-only with Esha', 'checklist progress; ⊕ creates a task linked to the note; Esha sees it under "Shared with me" read-only', async () => {
  const title = `Branch visit notes ${tag}`
  await hema.goto('/notes')
  await hema.getByTestId('note-new').click()
  const ed = hema.getByTestId('note-editor')
  await ed.getByTestId('note-title').fill(title)
  await ed.getByTestId('note-body').fill('Things to carry\n- [ ] Brochures\n- [x] Visiting cards')
  await ed.getByTestId('note-check-item').nth(1).waitFor()
  await ed.getByTestId('note-color').first().click()
  await ed.getByTestId('sheet-done').click()
  const row = hema.getByTestId('note-row').filter({ hasText: title })
  await row.waitFor()
  check((await row.innerText()).includes('1/2'), 'checklist progress in the list')
  await row.click()
  await hema.getByTestId('note-line-task').first().click()
  await until(() => scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatTask t JOIN chat.TRN_ChatNote n ON n.NoteId = t.NoteId WHERE n.Title = N'${title}' AND t.Title = N'Brochures'`) === 1, 'line → task')
  await hema.getByTestId('note-share').click()
  const pick = hema.getByTestId('note-share-picker')
  await pick.getByTestId('assignee-search').fill('Esha')
  await pick.getByTestId('assignee-option').filter({ hasText: 'Esha' }).first().click()
  await pick.getByTestId('sheet-done').click()
  await until(() => scalar(`SELECT COUNT(*) AS v FROM chat.TRN_ChatNoteShare s JOIN chat.TRN_ChatNote n ON n.NoteId = s.NoteId WHERE n.Title = N'${title}'`) === 1, 'not shared')
  await view(hema, 'tc06-note')
  await esha.goto('/notes?filter=shared')
  await esha.getByTestId('note-row').filter({ hasText: title }).click()
  const sh = esha.getByTestId('shared-note')
  await sh.waitFor()
  check((await sh.innerText()).includes('Read-only'), 'shared note not read-only')
  await view(esha, 'tc06-shared-phone')
  return 'checklist, colour, line → task, shared'
})

ok.iphone = await tc('TC-07', 'iPhone (WebKit): Tasks lists, assigned task sheet, tab bar My Day', 'no sideways scroll; My Day in the tab bar; assigned task sheet opens', async () => {
  const b = await webkit.launch({ headless: true })
  try {
    const ctx = await b.newContext({ ...devices['iPhone 14'], baseURL: process.env.ROOM_WEB ?? 'http://127.0.0.1:5175' })
    const p = await ctx.newPage()
    p.setDefaultTimeout(20_000)
    await loginUI(p, EMP.email)
    await p.goto('/tasks?filter=assigned')
    await p.getByTestId('tasks-view').waitFor()
    await p.getByTestId('mobile-tabbar').getByText('My Day').waitFor()
    check(await overflowX(p) <= 0, 'Tasks scrolls sideways on iPhone')
    await p.screenshot({ path: path.join(SHOTS, 'view-tc07-iphone-tasks.png') })
    await p.goto(`/tasks?task=${taskId}`)
    await p.getByTestId('task-editor').waitFor()
    check(await overflowX(p) <= 0, 'task sheet scrolls sideways on iPhone')
    await p.screenshot({ path: path.join(SHOTS, 'view-tc07-iphone-task.png') })
    return 'ok'
  } finally { await b.close() }
})

const hemaApi2 = await new Api().login(HOST.email)
const eshaUserId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS v FROM auth.Users WHERE Email = '${EMP.email}'`)
const assignNew = async (title, extra = {}) => {
  const r = await hemaApi2.req('POST', '/chat/tasks', { title, assigneeIds: [eshaUserId], dueUtc: new Date(Date.now() + 2 * 86400_000).toISOString(), ...extra })
  check(r.status === 200, `assign ${r.status} ${JSON.stringify(r.data)}`)
  return scalar(`SELECT CONVERT(varchar(36), PublicId) AS v FROM chat.TRN_ChatTask WHERE Title = N'${title}' AND IsActive = 1`)
}
const bell = (email, type, like) => scalar(`SELECT COUNT(*) AS v FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = '${email}' AND n.[Type] = '${type}' AND n.Title LIKE N'%${like}%'`)

ok.dateFlow = await tc('TC-08', 'Esha asks for a new date in the UI; Hema approves it from the banner', 'request needs a reason; Hema sees "asks for …" and Approve; due date moves; Esha gets a bell entry', async () => {
  const title = `Visit Pune branch ${tag}`
  const id = await assignNew(title)
  await esha.goto(`/tasks?task=${id}`)
  const ed = esha.getByTestId('task-editor')
  await ed.getByTestId('task-ask-date').first().click()
  const p = esha.getByTestId('prompt-date')
  const want = new Date(Date.now() + 6 * 86400_000)
  const ymd = `${want.getFullYear()}-${String(want.getMonth() + 1).padStart(2, '0')}-${String(want.getDate()).padStart(2, '0')}`
  await p.getByTestId('prompt-date').fill(ymd)
  check(await p.getByTestId('sheet-done').isDisabled(), 'sent without a reason')
  await p.getByTestId('prompt-text').fill('Branch manager is on leave')
  await p.getByTestId('sheet-done').click()
  await until(() => scalar(`SELECT CASE WHEN RequestedDueUtc IS NULL THEN 0 ELSE 1 END AS v FROM chat.TRN_ChatTask WHERE PublicId = '${id}'`) === 1, 'request not saved')
  await hema.goto(`/tasks?filter=delegated&task=${id}`)
  const he = hema.getByTestId('task-editor')
  await he.getByTestId('banner-assigner').filter({ hasText: 'on leave' }).waitFor()
  await he.getByTestId('date-approve').click()
  await until(() => scalar(`SELECT CONVERT(varchar(10), DueUtc, 23) AS v FROM chat.TRN_ChatTask WHERE PublicId = '${id}'`) === new Date(`${ymd}T18:00`).toISOString().slice(0, 10), 'due not moved')
  check(bell(EMP.email, 'TASK_UPDATE', `approved your new date: ${title}`) === 1, 'Esha not told')
  await hema.keyboard.press('Escape')
  return `moved to ${ymd}`
})

ok.decline = await tc('TC-09', 'Esha declines in the UI with a reason; Hema is told and sees "Declined"', 'reason required; status CANCELLED/DECLINED; bell + e-mail to Hema; row shows Declined under Assigned by me', async () => {
  const title = `Audit old files ${tag}`
  const id = await assignNew(title)
  await esha.goto(`/tasks?task=${id}`)
  await esha.getByTestId('task-editor').getByTestId('task-decline').first().click()
  const p = esha.getByTestId('prompt-decline')
  check(await p.getByTestId('sheet-done').isDisabled(), 'declined without a reason')
  await p.getByTestId('prompt-text').fill('Not my department')
  await p.getByTestId('sheet-done').click()
  await until(() => scalar(`SELECT AssignState AS v FROM chat.TRN_ChatTask WHERE PublicId = '${id}'`) === 'DECLINED', 'not declined')
  check(bell(HOST.email, 'TASK_UPDATE', `declined: ${title}`) === 1, 'Hema not told')
  check(scalar(`SELECT COUNT(*) AS v FROM app.EmailOutbox WHERE Template = 'TASK_UPDATE' AND ToAddress = '${HOST.email}' AND Subject LIKE N'%declined: ${title}%'`) === 1, 'no e-mail to Hema')
  await hema.goto('/tasks?filter=delegated')
  const row = hema.getByTestId('task-row').filter({ hasText: title })
  await row.waitFor()
  check((await row.innerText()).includes('Declined'), 'row does not say Declined')
  return 'declined, told'
})

ok.withdraw = await tc('TC-10', 'Hema withdraws a task in the UI; Esha is told', 'confirm dialog; Esha copy CANCELLED; bell to Esha', async () => {
  const title = `Old renewal list ${tag}`
  const id = await assignNew(title)
  await hema.goto(`/tasks?filter=delegated&task=${id}`)
  await hema.getByTestId('task-editor').getByTestId('task-withdraw').click()
  await hema.getByRole('button', { name: 'Withdraw', exact: true }).click()
  await until(() => scalar(`SELECT [Status] AS v FROM chat.TRN_ChatTask WHERE PublicId = '${id}'`) === 'CANCELLED', 'not withdrawn')
  check(bell(EMP.email, 'TASK_UPDATE', `withdrew: ${title}`) === 1, 'Esha not told')
  return 'withdrawn'
})

ok.files = await tc('TC-11', 'Esha attaches a proof file; it is scanned; Hema downloads it', 'upload from the task sheet; CLEAN; Hema GET 200 attachment; Dan (outsider) cannot', async () => {
  const title = `Upload KYC proof ${tag}`
  const id = await assignNew(title, { requiresReview: true })
  await esha.goto(`/tasks?task=${id}`)
  const ed = esha.getByTestId('task-editor')
  await ed.getByTestId('task-file-input').setInputFiles({ name: 'kyc-proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') })
  await ed.getByTestId('task-file').filter({ hasText: 'kyc-proof.pdf' }).waitFor()
  await until(() => scalar(`SELECT TOP 1 f.ScanStatus AS v FROM chat.TRN_ChatTaskFile f JOIN chat.TRN_ChatTask t ON t.TaskId = f.TaskId WHERE t.PublicId = '${id}'`) === 'CLEAN', 'not scanned clean', 60_000)
  const fid = scalar(`SELECT TOP 1 CONVERT(varchar(36), f.PublicId) AS v FROM chat.TRN_ChatTaskFile f JOIN chat.TRN_ChatTask t ON t.TaskId = f.TaskId WHERE t.PublicId = '${id}'`)
  const hdr = { Cookie: [...hemaApi2.jar].map(([k, v]) => `${k}=${v}`).join('; ') }
  const r = await fetch(`${process.env.ROOM_WEB ?? 'http://127.0.0.1:5175'}/api/v1/chat/task-files/${fid}`, { headers: hdr })
  check(r.status === 200 && /attachment; filename="kyc-proof.pdf"/.test(r.headers.get('content-disposition') ?? ''), `download ${r.status} ${r.headers.get('content-disposition')}`)
  check(bell(HOST.email, 'TASK_COMMENT', `added a file: ${title}`) === 1, 'Hema not told about the file')
  return 'uploaded, clean, downloaded'
})

ok.emails = await tc('TC-12', 'E-mails were queued for assigned and review', 'EmailOutbox has TASK_ASSIGNED to Esha and TASK_REVIEW to Hema for the main task', async () => {
  check(scalar(`SELECT COUNT(*) AS v FROM app.EmailOutbox WHERE Template = 'TASK_ASSIGNED' AND ToAddress = '${EMP.email}' AND Subject LIKE N'%${TITLE}%'`) === 1, 'no assigned e-mail')
  check(scalar(`SELECT COUNT(*) AS v FROM app.EmailOutbox WHERE Template = 'TASK_REVIEW' AND ToAddress = '${HOST.email}' AND Subject LIKE N'%${TITLE}%'`) >= 1, 'no review e-mail')
  return 'queued'
})

ok.switchOff = await tc('TC-13', 'With "Assign tasks and reviews" OFF (production today): no assigning, personal tasks still work', 'no Assign to row, no Assigned lists, no alerts; a personal task can be added and completed; turning it on shows them again', async () => {
  exec("UPDATE app.FeatureSettings SET IsEnabled = 0 WHERE FeatureKey = 'TASK_COLLAB'")
  await sleep(11_000)   // the server caches switches for 10 s
  await hema.goto('/tasks?filter=today')
  await hema.getByTestId('tasks-view').waitFor()
  check(await hema.getByTestId('task-list-delegated').count() === 0, '"Assigned by me" shown while off')
  await hema.getByTestId('task-new').click()
  const ed = hema.getByTestId('task-editor')
  await ed.getByTestId('task-title').waitFor()
  check(await ed.getByTestId('task-assign').count() === 0, '"Assign to" shown while off')
  await ed.getByTestId('task-title').fill(`Own task while off ${tag}`)
  await ed.getByTestId('sheet-done').click()
  await hema.getByTestId('task-row').filter({ hasText: `Own task while off ${tag}` }).waitFor()
  await view(hema, 'tc13-off')
  exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'TASK_COLLAB'")
  await sleep(11_000)
  await hema.goto('/tasks?filter=today')
  await hema.getByTestId('task-list-delegated').waitFor()
  await hema.getByTestId('task-new').click()
  await hema.getByTestId('task-editor').getByTestId('task-assign').waitFor()
  return 'off: hidden, personal ok; on: shown'
})

ok.appNotify = await tc('TC-14', 'Android app 1.2.0: a task alert in the background becomes a phone notification', 'with the app bridge and the app in the background, the page posts {type:"notify"} with the title and a full portal link to the task', async () => {
  const phone = await newPage({ width: 412, height: 915, mobile: true })
  await phone.addInitScript(() => {
    window.__sent = []
    window.OicAndroid = { postMessage: (d) => window.__sent.push(JSON.parse(d)), onmessage: null }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') })
  })
  await loginUI(phone, EMP.email)
  await phone.goto('/my-day')
  await phone.getByTestId('myday-view').waitFor()
  await sleep(1500)
  await phone.evaluate(() => { window.__hidden = true })
  const title = `Phone alert check ${tag}`
  await assignNew(title)
  await until(() => phone.evaluate((t) => window.__sent.some((m) => m.type === 'notify' && m.title.includes(t)), title), 'no notify message to the app', 15_000)
  const m = await phone.evaluate((t) => window.__sent.find((x) => x.type === 'notify' && x.title.includes(t)), title)
  check(/^https?:\/\/[^/]+\/tasks\?task=[0-9a-f-]{36}$/i.test(m.link), `link ${m.link}`)
  return m.link.replace(/^https?:\/\/[^/]+/, '')
})

await closeAll()
writeResults('task-collab')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
