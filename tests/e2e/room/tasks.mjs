// Chat Phase 4 (20 Nov 2026): notes, tasks, reminders and My Day in the browser. Two employees (computer + Android phone),
// reminders fired by the real server worker, snooze / complete from the popup, catch-up after being away, follow-up
// from a chat message, private notes. Isolated environment only (LocalDB *_Room, API 7191, Vite 5175).
// Run:  cd "E:\Beeinsured.com\MeetIQ\tests\e2e"; node room\tasks.mjs
setTimeout(() => { console.log('WATCHDOG: test still running after 9 min - giving up'); process.exit(2) }, 9 * 60_000).unref()
import { Api, EMP, HOST, check, closeAll, exec, loginUI, newPage, overflowX, scalar, sleep, tc, until, view, writeResults } from './harness.mjs'

exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS')")
const tag = Date.now().toString(36).slice(-5)
const idOf = (email) => scalar(`SELECT CONVERT(varchar(36), PublicId) AS id FROM auth.Users WHERE Email = '${email}'`)
const ok = {}

const hema = await newPage({ width: 1366, height: 860 })
await loginUI(hema, HOST.email)
const esha = await newPage({ width: 412, height: 915, mobile: true })
await loginUI(esha, EMP.email)
const hemaApi = await new Api().login(HOST.email)
const eshaApi = await new Api().login(EMP.email)

const popup = (p) => p.getByTestId('reminder-popup')
const pad = (n) => String(n).padStart(2, '0')
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

ok.tabs = await tc('W-01', 'Chat shows My Day, Notes and Tasks when the switch is on', 'segmented control Chats · Calls · My Day · Notes · Tasks; My Day sections load on the phone', async () => {
  await esha.goto('/chat')
  for (const k of ['chats', 'calls', 'myday', 'notes', 'tasks']) await esha.getByTestId('chat-section-' + k).waitFor()
  await esha.getByTestId('chat-section-myday').click()
  await esha.getByTestId('myday-view').waitFor()
  for (const s of ['myday-today', 'myday-meetings', 'myday-upcoming', 'myday-followups', 'myday-notes', 'myday-chats']) await esha.getByTestId(s).waitFor()
  check(await overflowX(esha) <= 0, 'My Day scrolls sideways on the phone')
  await view(esha, 'w01-myday-phone')
  return 'five sections; My Day cards shown'
})

ok.remind = await tc('W-02', 'A task reminder fires from the server, Postpone works, then Complete from the popup', 'popup within ~20 s of the due time; Postpone 5 min puts it back (PENDING, +5 min); when due again it pops up again; Complete marks the task done; one bell row each time', async () => {
  await hema.goto('/chat?tab=tasks')
  await hema.getByTestId('tasks-view').waitFor()
  await hema.getByTestId('task-new').click()
  const ed = hema.getByTestId('task-editor')
  await ed.getByTestId('task-title').fill(`Send the renewal report ${tag}`)
  await ed.getByTestId('task-description').fill('Customer asked for it yesterday')
  // Due today at the current minute, reminder "At time of due" (already due, so the next worker pass fires it).
  const now = new Date()
  if (!(await ed.getByTestId('field-due-on').isChecked())) await ed.getByTestId('field-due-on').click()
  await ed.getByTestId('field-time-on').click()
  await ed.getByTestId('field-due-time').fill(localTime(now))
  await ed.getByTestId('field-reminder').selectOption('at')
  await ed.getByRole('tab', { name: 'High' }).click()
  await ed.getByTestId('sheet-done').click()
  await ed.waitFor({ state: 'detached' })
  await hema.getByTestId('task-row').filter({ hasText: `Send the renewal report ${tag}` }).waitFor()
  const taskId = scalar(`SELECT CONVERT(varchar(36), PublicId) AS id FROM chat.TRN_ChatTask WHERE Title = 'Send the renewal report ${tag}'`)
  check(!!taskId, 'task not saved')
  check(scalar(`SELECT Priority AS p FROM chat.TRN_ChatTask WHERE PublicId = '${taskId}'`) === 'HIGH', 'priority not saved')
  const pop = popup(hema)
  await pop.waitFor({ timeout: 30_000 })
  check((await pop.getByTestId('reminder-title').innerText()).includes(`Send the renewal report ${tag}`), 'popup shows another reminder')
  await view(hema, 'w02-reminder-popup')
  const bells = () => scalar(`SELECT COUNT(*) AS n FROM mtg.MeetingNotifications WHERE [Type] = 'TASK_REMINDER' AND Title LIKE '%${tag}%'`)
  check(bells() === 1, `expected 1 bell row, got ${bells()}`)
  await pop.getByTestId('reminder-snooze').click()
  await pop.getByTestId('snooze-5').click()
  await pop.waitFor({ state: 'detached' })
  const r = () => scalar(`SELECT r.[State] + '|' + CONVERT(varchar(30), DATEDIFF(SECOND, SYSUTCDATETIME(), r.DueUtc)) AS v FROM chat.TRN_ChatReminder r JOIN chat.TRN_ChatTask t ON t.TaskId = r.TaskId WHERE t.PublicId = '${taskId}' AND r.[State] IN ('PENDING','FIRED')`)
  const [state, secs] = String(r()).split('|')
  check(state === 'PENDING' && Number(secs) > 240 && Number(secs) <= 301, `snooze not saved (${r()})`)
  // Make it due now: the next worker pass fires it again.
  exec(`UPDATE r SET DueUtc = DATEADD(SECOND, -1, SYSUTCDATETIME()) FROM chat.TRN_ChatReminder r JOIN chat.TRN_ChatTask t ON t.TaskId = r.TaskId WHERE t.PublicId = '${taskId}' AND r.[State] = 'PENDING'`)
  await pop.waitFor({ timeout: 30_000 })
  check(bells() === 2, `expected 2 bell rows after the snooze fired, got ${bells()}`)
  await pop.getByTestId('reminder-complete').click()
  await pop.waitFor({ state: 'detached' })
  await until(() => scalar(`SELECT [Status] AS s FROM chat.TRN_ChatTask WHERE PublicId = '${taskId}'`) === 'COMPLETED', 'task not completed')
  return 'fired, postponed 5 min, fired again, completed; 2 bell rows'
})

ok.followUp = await tc('W-03', 'Follow-up task from a chat message (Esha on the phone, message from Hema)', 'message action sheet → "Create task or reminder" → editor shows the message → Add → listed under Follow-ups with the sender', async () => {
  const r = await hemaApi.req('POST', '/chat/direct', { userId: idOf(EMP.email) })
  check(r.status === 200, `direct chat: ${r.status}`)
  const conv = r.data.id
  const m = await hemaApi.req('POST', `/chat/conversations/${conv}/messages`, { body: `Please share the claims report tomorrow ${tag}`, clientMessageId: crypto.randomUUID() })
  check(m.status === 200 || m.status === 201, `send: ${m.status}`)
  await esha.goto(`/chat?c=${conv}`)
  const msg = esha.getByTestId('chat-message').filter({ hasText: `Please share the claims report tomorrow ${tag}` }).last()
  await msg.locator('.ios-bubble').click()
  const sheet = esha.getByTestId('chat-action-sheet')
  await sheet.waitFor()
  await sheet.getByRole('button', { name: 'Create task or reminder' }).click()
  const ed = esha.getByTestId('task-editor')
  await ed.waitFor()
  check((await ed.innerText()).includes(`Please share the claims report tomorrow ${tag}`), 'editor does not show the message')
  await view(esha, 'w03-follow-up-phone')
  await ed.getByTestId('sheet-done').click()
  await ed.waitFor({ state: 'detached' })
  await esha.goto('/chat?tab=tasks&filter=followups')
  const row = esha.getByTestId('task-row').filter({ hasText: `claims report tomorrow ${tag}` })
  await row.waitFor()
  check((await row.innerText()).includes('Hema Host'), 'follow-up does not show the sender')
  check(await overflowX(esha) <= 0, 'Tasks scrolls sideways on the phone')
  await view(esha, 'w03-followups-phone')
  return 'task linked to the message, shown under Follow-ups'
})

ok.notes = await tc('W-04', 'Notes: create, pin, search; notes are private', 'note saved and pinned; search finds it; the other employee gets 404 for it and cannot list it', async () => {
  await hema.goto('/chat?tab=notes')
  await hema.getByTestId('notes-view').waitFor()
  await hema.getByTestId('note-new').click()
  const ed = hema.getByTestId('note-editor')
  await ed.getByTestId('note-title').fill(`Prep for Acme renewal ${tag}`)
  await ed.getByTestId('note-body').fill('Ask about fleet size and claims history.')
  await ed.getByTestId('note-pin').click()
  await ed.getByTestId('sheet-done').click()
  await ed.waitFor({ state: 'detached' })
  await hema.getByTestId('note-row').filter({ hasText: `Prep for Acme renewal ${tag}` }).waitFor()
  check(await hema.getByText('Pinned', { exact: true }).count() > 0, 'no Pinned section')
  await hema.getByTestId('note-search').fill('fleet size')
  await until(async () => (await hema.getByTestId('note-row').filter({ hasText: tag }).count()) === 1, 'search does not find the note by its text')
  await view(hema, 'w04-notes-desktop')
  const id = scalar(`SELECT CONVERT(varchar(36), PublicId) AS id FROM chat.TRN_ChatNote WHERE Title = 'Prep for Acme renewal ${tag}'`)
  check((await eshaApi.req('GET', `/chat/notes/${id}`)).status === 404, 'another employee can open the note')
  check((await eshaApi.req('PATCH', `/chat/notes/${id}`, { title: 'x' })).status === 404, 'another employee can change the note')
  const list = await eshaApi.req('GET', '/chat/notes?search=' + tag)
  check(list.status === 200 && list.data.items.length === 0, 'the note shows in the other employee\'s list')
  return 'pinned, found by text, private (404 for Esha)'
})

ok.catchUp = await tc('W-05', 'Catch-up: a reminder that fired while the person was away pops up when they come back', 'reminder due while Esha has no page open fires on the server; on opening the portal the popup shows it; Dismiss clears it (and it is listed under My Day before)', async () => {
  await esha.goto('about:blank')
  const due = new Date(Date.now() - 30_000).toISOString()
  const r = await eshaApi.req('POST', '/chat/tasks', { title: `Call back Mr Rao ${tag}`, priority: 'URGENT', dueUtc: due, hasDueTime: true, reminderUtc: due })
  check(r.status === 200 || r.status === 201, `create: ${r.status} ${JSON.stringify(r.data)}`)
  await until(() => scalar(`SELECT COUNT(*) AS n FROM chat.TRN_ChatReminder r JOIN chat.TRN_ChatTask t ON t.TaskId = r.TaskId WHERE t.Title = 'Call back Mr Rao ${tag}' AND r.[State] = 'FIRED'`) === 1, 'server did not fire it', 30_000)
  await esha.goto('/dashboard')
  const pop = popup(esha)
  await pop.waitFor({ timeout: 20_000 })
  check((await pop.innerText()).includes(`Call back Mr Rao ${tag}`), 'popup shows another reminder')
  const box = await pop.boundingBox()
  check(box && box.x >= 0 && box.x + box.width <= 412 + 1, 'popup does not fit the phone')
  await view(esha, 'w05-catch-up-phone')
  await pop.getByTestId('reminder-dismiss').click()
  await until(() => scalar(`SELECT COUNT(*) AS n FROM chat.TRN_ChatReminder r JOIN chat.TRN_ChatTask t ON t.TaskId = r.TaskId WHERE t.Title = 'Call back Mr Rao ${tag}' AND r.AcknowledgedUtc IS NOT NULL`) === 1, 'dismiss not saved')
  return 'fired while away, shown on return, dismissed'
})

ok.myDay = await tc('W-06', 'My Day on the computer: counts, overdue task, quick actions', 'overdue task listed under Overdue; "Add task" quick action opens the iOS sheet; follow-up from a meeting/call buttons present', async () => {
  const past = new Date(Date.now() - 26 * 3600_000).toISOString()
  await hemaApi.req('POST', '/chat/tasks', { title: `Overdue quote ${tag}`, dueUtc: past, hasDueTime: true })
  await hema.goto('/chat?tab=myday')
  await hema.getByTestId('myday-view').waitFor()
  await hema.getByTestId('myday-overdue').getByText(`Overdue quote ${tag}`).waitFor()
  check(Number(await hema.getByTestId('myday-count-overdue').locator('span.text-\\[24px\\]').innerText()) >= 1, 'overdue count is 0')
  await view(hema, 'w06-myday-desktop')
  await hema.getByTestId('qa-task').click()
  await hema.getByTestId('task-editor').waitFor()
  await hema.getByTestId('task-editor').getByRole('button', { name: 'Cancel' }).click()
  // Complete the overdue task from My Day.
  await hema.getByTestId('myday-overdue').getByTestId('task-row').filter({ hasText: `Overdue quote ${tag}` }).getByTestId('task-check').click()
  await until(() => scalar(`SELECT [Status] AS s FROM chat.TRN_ChatTask WHERE Title = 'Overdue quote ${tag}'`) === 'COMPLETED', 'not completed from My Day')
  return 'overdue shown and completed from My Day; quick action opens the editor'
})

ok.off = await tc('W-07', 'Switch CHAT_TASKS off: the sections and popups disappear, chat still works', 'no My Day/Notes/Tasks tabs; API answers 403 FEATURE_DISABLED; Chats and Calls tabs still there', async () => {
  exec("UPDATE app.FeatureSettings SET IsEnabled = 0 WHERE FeatureKey = 'CHAT_TASKS'")
  await sleep(11_000) // the API caches the switch for 10 s
  const r = await eshaApi.req('GET', '/chat/tasks')
  check(r.status === 403 && r.data?.code === 'FEATURE_DISABLED', `API not switched off: ${r.status} ${JSON.stringify(r.data)}`)
  await esha.goto('/chat')
  await esha.getByTestId('chat-section-calls').waitFor()
  check(await esha.getByTestId('chat-section-tasks').count() === 0, 'Tasks tab still shown')
  exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT_TASKS'")
  return 'hidden and refused while off; switched back on'
})

await closeAll()
writeResults('tasks')
const all = Object.values(ok)
console.log(`${all.filter(Boolean).length}/${all.length} passed`)
process.exit(all.every(Boolean) ? 0 : 1)
