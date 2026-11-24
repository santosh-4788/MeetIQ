# Changelog

## 24 Nov 2026, 15:21–15:30 IST — DEPLOYED: chat enhancement (approved after screenshot review)

- **Bug fixes:**
  - Chats always open at the latest message. The list follows every size change (box, each block, each picture as it loads), browser scroll anchoring is off, and "stop following" happens only on a real scroll up. Pictures keep a placeholder until loaded.
  - The availability menu opens in a portal: below or above the button, at most 70 vh, scrolling inside.
- **Look:**
  - Chat uses the whole window on computers (10 px margin).
  - iOS-style chat list: 50 px picture, name, time, chevron, two-line preview, unread badge.
  - Designations are no longer shown in the chat list or header (user decision); they stay in contact info and people search.
- **New:**
  - Statuses "Be right back" and "Appear offline" (others see Offline, no last seen).
  - Own profile picture (`Auth/ProfilePhotoEndpoints.cs`): upload, preview, replace, remove.
    - Checks: JPG/PNG/WEBP by content, 2 MB, shrunk to 256 px in the browser.
    - Storage: private chat storage, recorded in `org.Employees.PhotoPath`.
    - Live push `photo.changed`; pictures shown on every avatar.
  - Shared media and documents per chat (search, paging).
  - "Call back" on missed calls (only for the person who missed it).
  - "Start a video meeting" from a chat: instant meeting, link posted in the chat.
- **Database:** V034 (`Availability` VARCHAR(10)→(20) + BRB/APPEAR_OFFLINE in the CHECK), applied alone. Rollback script tested.
- **Data:**
  - two employees got the requested designations (Sr Project Manager and Tech Head). They are new designations, because "Sr. BA" is shared; matched by e-mail and PublicId.
  - The other Sr. BA employees and the similarly named colleague are unchanged (verified).
  - The script is kept with the backup.
- **Tests:**
  - new `room/chat-premium.mjs` 15/15 (screenshots in `Chat_UI_Review/`);
  - backend 160/160 (new `ChatProfileTests`);
  - chat 10/10, calls 7/7, advanced 8/8, task-collab 15/15, login-and-alerts 7/7, android-app-chat 3/3, chat-phone-view 4/4, ios-look 9/9, call-speaker OK, tasks 7/7.
- **Deploy:**
  - pre-check clear;
  - backups: files in `deploy\_backup-20261124-152124`; database `Oneinsure_v_pre-chatpremium-20261124-152124.bak` (68.1 MB, verified);
  - V034 applied alone; API restart 7 s, health Healthy; website `npm run build`; `/people/photos` answers 401 without sign-in.
- **Undo:**
  - copy back `api` (service stopped) and `frontend-dist`;
  - run `database/rollback/V034…`;
  - designations: point the two employees back to "Sr. BA", or restore from the backup.

## 23 Nov 2026, 16:30–16:40 IST — DEPLOYED: employee logins from EmployeeDetails.xlsx; stay signed in until 23:30; live message, call and task popups

- **Employees (production data):**
  - 13 employees and accounts created from `EmployeeDetails.xlsx` in department IT. Designations come from the HR master (`MST_Employees`); 7 designations were created (Tech Lead, Senior Software Tester, Senior UI Developer, Senior Mobile Developer, Senior Executive - Company Secretary, Senior Web Developer, Junior Software Developer) and "Executive" is used where HR has none.
  - Login ID = employee code (the e-mail also works). The shared default password from the sheet, stored only as a PBKDF2 hash with a unique salt; change required at first sign-in; role Employee; everything audited.
  - Two people already had accounts and were not touched; the empty last row was skipped.
  - User decision: two people whose HR record differs from the sheet (one inactive in HR, one with another code) were created as in the sheet.
  - The script (re-runnable, hashes only) is kept with the backup, not in Git.
- **Stay signed in:** with the daily logout on, the session cookie is always persistent until the next 23:30 IST cutoff, with or without "Remember me", so closing the browser no longer signs people out. The login page shows "You stay signed in until 11:30 PM" instead of the checkbox. The 23:30 logout itself and "no idle logout" were already in place.
- **Chat message popups:** new `MessageAlerts` on every page shows the sender, the group and the text; tapping it opens the chat.
  - Not shown for the open chat, for muted chats (unless mentioned), during Do not disturb or quiet hours, or while the chat list is on screen.
  - In the background: a phone notification in the Android app (bridge `notify`) or a browser notification.
- **Calls:** the incoming-call phone notification is now also sent through the Android app in the background.
- **Task popup:** the `notification.new` push carries `task {title, assignedBy, dueUtc, hasDueTime, priority}`. The popup shows From / Due / priority, and the same details go into phone and browser notifications.
- **Layout:** message and task banners share one stack (top, right on computers).
- **Code changes:**
  - the "Turn on notifications" prompt (now for messages, calls and tasks) moved to `pages/chat/NotifyPrompt.tsx` and is shown in Chat too;
  - `ChatProvider` got `isOnScreen(id)`.
- **Tests:**
  - new `room/login-and-alerts.mjs` 7/7;
  - backend 153/153 (cookie test updated to the persistent cookie);
  - task-collab 15/15, chat 10/10, calls 7/7, android-app-chat 3/3, chat-phone-view 4/4, call-speaker OK.
  - Production check: one new account with the default password → PASSWORD_CHANGE_REQUIRED, cookie expires 23:30 IST, then logged out.
- **Deploy:**
  - pre-check clear;
  - backups: files in `deploy\_backup-20261123-163044`; database `Oneinsure_v_pre-employees-alerts-20261123-163044.bak` (65.1 MB, verified);
  - API restart about 12 s, health Healthy; website `npm run build`.
- **Undo:** copy back `api` and `frontend-dist`; the new accounts can be deactivated in User Management, or restored from the database backup.

## 22 Nov 2026, 23:19–23:25 IST — DEPLOYED: e-mail policy (meeting and sign-in mails only) and blocked addresses

- **Only these e-mails are sent:**
  - meeting scheduled (invitation, instant invite), rescheduled, cancelled, removed from a meeting;
  - the reminder 15 minutes before the start;
  - password reset and sign-in code (and the admin test mail).
- **Switched off:** recording ready / failed, all task e-mails, note sharing and everything else. `EmailOutboxWorker` marks them `CANCELLED`, with "Not sent: … switched off" in `EmailDeliveryLog`.
- **Settings:** `EmailOptions.AllowedTemplates`, `ReminderEmailMinutes` (default 15) and `BlockedAddresses`.
- **Reminders:** in-app reminders keep 24 h / 1 h / 15 min. E-mail reminder rows are now created only for 15 min, and older 24 h / 1 h e-mail rows are closed by `ReminderWorker`. In production, 324 pending 24 h / 1 h e-mail reminder rows were closed at deploy with the same reason.
- **Blocked addresses:** the 3 addresses the user asked to remove (Naved) are blocked in `deploy\api\appsettings.Production.json` → `Email:BlockedAddresses`. They are kept out of source control on purpose. His login and history are unchanged.
- **Website:** the "E-mail me about tasks" switch was removed from Task settings; the Assign footer no longer mentions an e-mail.
- **Tests:**
  - backend 153/153;
  - new: switched-off kinds and blocked addresses never sent; allowed list; reminder e-mail only at 15 min; an old 1 h e-mail reminder is closed unsent;
  - the reminder and RSVP tests were updated to the new counts.
- **Deploy:**
  - pre-check clear;
  - backups: files in `deploy\_backup-20261122-231941` (incl. the previous `appsettings.Production.json`); database `Oneinsure_v_pre-emailpolicy-20261122-231941.bak` (63.1 MB, verified);
  - API restart about 12 s, health Healthy; website `npm run build`.
- **Undo:**
  - copy back `api` (service stopped), `frontend-dist` and the old `appsettings.Production.json`;
  - for the closed reminder rows, restore from the database backup if ever needed.

## 21 Nov 2026, 22:50 IST — DEPLOYED: call speaker button on every device; Android app 1.2.2 (versionCode 6)

- **Bug fixed (phones):** the speaker chooser and "Add people" opened behind the full-screen call screen, so the buttons seemed to do nothing. Call dialogs now open above it (`Dialog` got an optional `layer`; the default z-[60] is unchanged for every other dialog).
- **Speaker button per device:**
  - Android app 1.2.2: real Speaker on/off switch (loudspeaker / earpiece), new `Speaker.kt` + bridge `{type:"speaker", on?}`; routing goes back to the system when the call ends;
  - computers (Chrome, Edge, Firefox): speaker chooser;
  - Safari on Mac, iPhone/iPad, Android browsers: the chooser explains where to change the output (menu-bar Sound, Control Center, or the app).
- **Tests:**
  - new `room/call-speaker.mjs` passes (app switch on → off → on; computer list; iPhone hint);
  - calls 7/7, android-app-chat 3/3, ios-look 9/9;
  - browsers 102/104: the two iPad failures did not repeat when iPad ran alone, 13/13;
  - gradle tests, lint and assembleRelease passed;
  - downloaded APK sha256 `f12d5336…96c4` = published.
- **Not yet tried on a real phone:** the earpiece switch was tested with a simulated app bridge only.
- **Backup:** website files in `deploy\_backup-20261121-225035` (the 1.2.1 APK is inside). Undo: copy back to `frontend\dist`. No API or database change.

## 21 Nov 2026, 18:42 IST — PUBLISHED: Android app 1.2.1 (versionCode 5); phone bottom bar without Meetings

- **Bottom bar (phones and the Android app):** Meetings removed from the bar; it stays in the menu (top left). The bar is now Home, Chat (or Calendar while Chat is off), the + (new meeting) in the middle, My Day and Alerts. File: `frontend/src/layouts/MobileTabBar.tsx`.
- **Android app 1.2.1:** version raised so the app offers the update. The app itself is unchanged and shows the live site, so the new bar also reaches 1.2.0 users without updating.
- **Tests:**
  - gradle unit tests, lint and assembleRelease passed;
  - e2e android-app-chat 3/3, chat-phone-view 4/4, task-collab 15/15; app-sized screenshot shows Home | Chat | + | My Day | Alerts;
  - downloaded APK sha256 `fac880cc…4990` = published.
- **Backup:** website files in `deploy\_backup-20261121-184228` (the 1.2.0 APK is inside at `frontend-dist\app`). Undo: copy it back to `frontend\dist`.

## 21 Nov 2026, 17:32–17:36 IST — DEPLOYED: assign an existing task to a colleague

- **Problem reported:** "assigned to someone not working, assigned user not getting any notification and not showing tasks". "Assign to" was only offered when creating a task. On an existing task, the user set "Related to → Employee", which is only a reference, so nothing was assigned, no notification went out and the colleague saw no task.
- **Fix:**
  - API: new `POST /chat/tasks/{id}/assign` (owner only, not for assigned or closed tasks). It creates the assigned copies through the normal assign path (notification, live alert, e-mail), carrying over the title, details, priority, due date, links and open checklist steps, then retires the original and cancels its reminders.
  - Website: the task editor shows "Assign to" (with "Needs my review") on your own open tasks, and the button reads "Assign". The employee link is relabelled "About (colleague)", with a note that it is for reference only.
  - No database change.
- **Tests:**
  - backend TaskCollabTests 9/9 (new: an existing own task can be assigned later);
  - e2e `task-collab.mjs` 15/15 (new TC-15 repeats the user's steps on an existing task), tasks 7/7.
- **Deploy:**
  - pre-check: 0 live meetings, recordings, jobs or meetings starting soon;
  - backups: files in `deploy\_backup-20261121-173247`; database `Oneinsure_v_pre-assignexisting-20261121-173247.bak` (61.1 MB, CHECKSUM + VERIFYONLY);
  - API: self-contained publish, service restart, about 10 s downtime, health Healthy; new endpoint answers 403 without sign-in, not 404;
  - website: `npm run build`.
- **Undo:** copy `api` back to `deploy\api` (with the service stopped) and `frontend-dist` back to `frontend\dist`.

## 21 Nov 2026, 15:42 IST — PUBLISHED: Android app 1.2.0 (versionCode 4) with phone notifications for tasks; TASK_COLLAB switched ON

- **TASK_COLLAB switched on in production** at the user's request (audit row `FEATURE_CHANGED`). Assigning, reviews, comments, files and note sharing are now visible to everyone with Notes & tasks access.
- **Cross-check:** all scenarios were run on the exact production build (the same code served by `vite preview`, against the test API): `task-collab.mjs` 13/13. Scenarios: assign, live alert + Accept, locked details + required step + send for review, send back / re-send / approve, My Day + quick add, notes, iPhone, new date, decline, withdraw, proof file, e-mails, switch off/on.
- **Android app 1.2.0** (new `Alerts.kt`, channel "Tasks and reminders", icon `ic_stat_task`):
  - bridge messages `notify` and `notifyPermission`; the page asks for a phone notification when a task alert or a reminder arrives while the app is in the background;
  - tapping it opens that task or note in the app; only portal links are used;
  - no cloud push service: notifications come from the app's own live connection while it runs (open or in the background); if Android has closed the app, the alerts wait in the bell;
  - the app offers the update itself (`/meet/app/android.json`, versionCode 4).
- **Website:**
  - `appNotify` / `appNotifyPermission` in `androidBridge.ts`; TaskAlerts and ReminderCenter use them in the app;
  - Tasks → Settings shows "Phone notifications" in the app.
- **Tests:**
  - gradle unit tests, lint and assembleRelease passed;
  - `task-collab.mjs` 14/14 (new TC-14: background alert → `notify` with the task link); android-app-chat 3/3; tasks 7/7;
  - downloaded APK sha256 `5e2614c8…fbbbb` = published.
- **Backup:**
  - website files in `deploy\_backup-20261121-154228` (the previous APK is inside it at `frontend-dist\app`).
  - Undo: copy it back to `frontend\dist`, and the app stays at 1.1.1 for people who did not update.

## 21 Nov 2026, 14:49–14:56 IST — DEPLOYED: task collaboration and iOS redesign of My Day, Tasks and Notes (V033, switch TASK_COLLAB)

- **Deploy:**
  - pre-check: 0 live meetings, recordings, jobs or meetings starting soon;
  - plan: only V033 pending; V033 applied alone (`-MigrationsPath` with the one script) to `Oneinsure_v`; 4 new tables and the new columns verified;
  - API: self-contained win-x64 publish, MeetIQApi stopped/started, about 11 s downtime, health Healthy;
  - website: `npm run build`; live site 200; new endpoint answers 401 without sign-in.
- **Switch:** TASK_COLLAB is still **OFF** in production. Switching it on at deploy was blocked by a tool permission rule, so it was not done. An admin turns it on in Admin → Meeting Features → "Assign tasks and reviews". Until then, people get the new look, Top 3, quick add, checklists and note colours; assigning, reviews, comments, files and sharing stay hidden.
- **Backups:**
  - files in `deploy\_backup-20261121-144957` (api, frontend-dist, git diff/status);
  - database `Oneinsure_v_pre-taskcollab-20261121-144957.bak` (60.1 MB, verified).
- **Undo:**
  1. switch TASK_COLLAB off (normal);
  2. full rollback: stop MeetIQApi, copy `api` back from the backup, copy `frontend-dist` back to `frontend\dist`, start MeetIQApi, then run `database/rollback/V033__task_collaboration.rollback.sql`.

- **Assign tasks** (anyone with Notes & tasks access to any active colleague who also has it):
  - one copy per person (`OwnerUserId` = the person doing it, `AssignedByUserId`, shared `AssignmentKey`);
  - only those two people can see it; anyone else gets 404;
  - the person can Accept, Ask for a new date (with a reason; the assigner approves or keeps the date) or Decline (reason required);
  - what the task is and when it is due stay with the assigner; the person doing it keeps their own category, reminder and private notes, which the assigner never sees;
  - the assigner can edit the task or Withdraw it, and the other person is told.
- **Needs my review:**
  - the person doing the task cannot complete it; they use "Send for review" (new status `IN_REVIEW`, with an optional note);
  - the assigner chooses Approve & close, or Send back (comment required);
  - checklist steps marked **Required** must be ticked before a task can be completed or sent for review.
- **Comments, history and proof files:**
  - the full timeline (assigned, accepted, review, sent back, approved, overdue …) and a comment thread;
  - files use the same checks and Windows Defender scan as chat attachments;
  - a 25 MB limit and up to 20 files per task.
- **Nudge:** the assigner can send a "Remind" at most every 4 hours.
- **Due alerts for assigned tasks:**
  - the day before the due date, an alert to the person doing it;
  - when it becomes overdue, both people get an alert and an e-mail;
  - then one alert a day to the person doing it, for up to 7 days.
- **Notifications** (all in-house):
  - bell types TASK_ASSIGNED, TASK_UPDATE, TASK_REVIEW, TASK_COMMENT, TASK_DUE and NOTE_SHARED;
  - a live pop-up on any page with Accept / Approve / Open;
  - a browser notification while the portal is in a background tab (after "Turn on");
  - e-mails for assigned / review / decision / declined / overdue, through the existing outbox; each person can switch them off in Tasks → Settings (`TaskEmails`).
- **My Day:**
  - a gradient header with today's progress ring;
  - Top 3 for today, with suggestions and a limit of 3;
  - the sections Assigned to you (with Accept), Waiting for your review and Waiting on others;
  - live refresh.
- **Tasks:**
  - new lists Assigned to me, Assigned by me (grouped by state) and To review;
  - quick add in plain words ("Call Ramesh tomorrow 4pm urgent"), which also sets a 15-minute reminder for timed tasks;
  - on phones, swipe right to complete and swipe left for Top 3;
  - row badges (New, In review, checklist x/y, comments, files);
  - a progress stepper inside the task.
- **Notes:**
  - colours;
  - checklists as `- [ ]` lines with a progress bar;
  - turn a line into a task linked to the note;
  - share read-only with colleagues, plus a "Shared with me" list.
- **Navigation:** a My Day | Tasks | Notes switcher; My Day in the phone tab bar when Notes & tasks is on.
- **Database V033 (additive):**
  - new columns on `chat.TRN_ChatTask` and `chat.TRN_ChatNote` (`Color`) and on `chat.MST_ChatUserPreference` (`TaskEmails`);
  - new tables `chat.TRN_ChatTaskChecklist`, `TRN_ChatTaskActivity`, `TRN_ChatTaskFile` and `TRN_ChatNoteShare`;
  - two widened CHECKs: task status +IN_REVIEW, and the notification types;
  - feature `TASK_COLLAB` is seeded OFF.
  - Rollback: `database/rollback/V033__task_collaboration.rollback.sql`. The normal way to stop the feature is to switch TASK_COLLAB off.
- **Tests:**
  - backend 140/140, including the new `TaskCollabTests` 8/8;
  - new e2e `tests/e2e/room/task-collab.mjs` 7/7 (computer + Android phone + iPhone WebKit);
  - regression: tasks 7/7, chat 10/10, calls 7/7, advanced 8/8, sidebar 5/5, user-access 3/3, ios-look 9/9, receipts 2/2, chat-downloads 6/6, chat-phone-view 4/4, android-app-chat 3/3, 8 browsers 104/104.

## 20 Nov 2026, 18:16 IST — DEPLOYED: phone chat view (full screen, keyboard, long file names); website only

Reported from an iPhone (Chrome): inside a chat, the portal header and the bottom tab bar took a third of the screen. With the keyboard open, the message box was hidden behind the tab bar. A long file name (`4. Undertaking - not holding ins license Rama.docx`) pushed the bubble off the left edge.
- **Full-screen conversation on phones** (<768 px), new `pages/chat/useFullScreenChat.ts`:
  - the open chat is drawn at the page root (portal) as a fixed layer (z-45), above the header and tab bar and below the drawer, sheets and call screens;
  - it is sized to `visualViewport`, so it fits above the keyboard on iOS and Android;
  - the page behind does not scroll; leaving the chat restores everything.
- **Newest message stays in view** when the list gets shorter (keyboard): ResizeObserver keeps the bottom position.
- **Bubbles never exceed the screen:**
  - `min-w-0` / `max-w-full` on the bubble;
  - file cards are 260 px wide, capped to the bubble;
  - file names show on up to 2 lines;
  - bubbles with a file may be 86% of the screen width.
- **Tests:**
  - New `tests/e2e/room/chat-phone-view.mjs`: 4/4 on iPhone 14, iPhone SE and Android Chrome. It checks full screen, the message box and newest message with a 55% "keyboard" viewport, the bubble inside the screen, and the tab bar back after leaving.
  - Regression: chat-downloads 6/6, chat 10/10, calls 7/7, tasks 7/7, advanced 8/8, sidebar 5/5, receipts 2/2, ios-look 9/9, user-access 3/3, 8 browsers 104/104, android-app-chat 3/3, portal audit 96 with 0 problems.
- **Backups:**
  - website files in `deploy\_backup-20261120-174728`;
  - database `Oneinsure_v_pre-phonechat-20261120-174728.bak` (verified).
  - Pre-check: 0 live meetings, recordings or jobs.
  - API not restarted; no database change.
  - Undo: copy `frontend-dist` from the backup back to `frontend\dist`.

## 20 Nov 2026, 17:00–17:05 IST — DEPLOYED: chat file downloads on phones; chat list on laptop screens

- **Downloads (Android app, Android Chrome):** `GET /chat/files/{id}` now sends `attachment; filename="<name>"` first, with `filename*` only for non-ASCII names. It also sends the real type from `chat.MST_ChatFileType` instead of `application/octet-stream`; HTML, SVG, XML and JS types stay octet-stream, and the site-wide nosniff still applies.
  - Before: Android's WebView download parser saved names with spaces or brackets as `<id>.bin`, and phones could not open the file in Excel.
  - The installed APK benefits without an update. Non-ASCII names still need the next APK.
- **Downloads (iPhone/iPad):** the download button fetches the file and opens the iOS share sheet ("Save to Files", "Open in Excel"); if sharing is unavailable it saves through a link. It works from the Home Screen app, where plain attachment links save nothing. New file: `pages/chat/saveFile.ts`.
- **Chat list on short laptop screens (1366×657, 1280×600):**
  - the Favourites row now scrolls with the list;
  - the title is smaller when the window height is 760 px or less;
  - the floating date label has a light shadow.
  - Before, only 1–2 chats showed.
- **Tests:**
  - New `tests/e2e/room/chat-downloads.mjs`: 6/6, covering a real .xlsx named `Sales Report (Nov) ….xlsx` in Chrome, Android Chrome, iPhone and the iOS share sheet, plus Android's URLUtil file-name rule.
  - Regression:
    - chat 10/10, calls 7/7, tasks 7/7, advanced 8/8, sidebar 5/5, receipts 2/2, ios-look 9/9, user-access 3/3;
    - all 8 browsers 104/104;
    - portal audit 96 pages × sizes with 0 problems.
  - Backend: new unit test; ChatTests 7/7.
  - Full backend run: 132/132 with the required test settings (`OIC_TEST_DATA_PATH`, `OIC_FFMPEG_DIR`). An earlier run without `OIC_FFMPEG_DIR` showed 16 recording-related failures, and the last commit failed them the same way, so they were not real.
- **Backups:**
  - files in `deploy\_backup-20261120-162056`;
  - database `Oneinsure_v_pre-downloads-20261120-162056.bak`, 58.1 MB, verified.
  - Pre-check: no live meetings, recordings or jobs.
  - No database change.
- **Incident during the deploy:** the first copy was a framework-dependent build. The live API is **self-contained** (`-r win-x64 --self-contained`), so the service would not start: "No frameworks were found". The API was down for about 3½ minutes, 17:00:40 to 17:04:12. It was fixed by publishing self-contained and copying again; health returned 200.

## 20 Nov 2026 — One more IT user: Mukta Bansal (data only, production)

- Ran a script on production `Oneinsure_v` built the same way as the two earlier IT users. It added employee **Mukta Bansal**: department IT, placeholder code `IT-TEMP-03` (edit it on Employee Management), sign-in `mukta.bansal@oneinsure.com`, role Employee.
- The default password is stored as a hash only. She must change it at first sign-in. She has full access: no module blocks, so meetings (including scheduling, `meetings.create`), chat, audio calls, and notes and tasks.
- **Checked:** her permissions on production; a real sign-in on the live site returns 200 with the password change required. Audit rows: EMPLOYEE_CREATED and USER_CREATED.
- No code or schema change.

## 20 Nov 2026, 14:45 IST — APK link: every address form works (main website settings, approved)

Administrator-approved change to the **main OneInsure website's** IIS settings (outside the portal).
- **Backups:** IIS configuration backup `pre-oneinsure-http-20261120` (`appcmd restore backup` to undo), and the main website's `web.config` copied to `deploy\_backup-20261120-142243\main-website-web.config.bak`.
- **Main website `web.config`** (`E:\Beeinsured.com\OneInsureWebSite_v2\one-insure-website`): one new first rule, "MeetIQ app links without /meet". It sends `/app/OneInsureConnect.apk`, `/app/android.json` and `/get-app` to the same addresses under `/meet` (302). These are the addresses the earlier broken redirect produced and browsers may have remembered.
- **IIS site `v2.oneinsure.com`:** added the binding `http *:80:oneinsure.com`. Before, plain `http://oneinsure.com` had no live site and returned a bare 404. The stopped old site `v4.beeinsured.com` also lists this binding, as it already did for `www.oneinsure.com`.
- **Checked afterwards:**
  - The APK downloads from https and http, with or without www, with or without `/meet`.
  - The download page opens; the main website home page is unchanged on https, http, www and no-www.

## 20 Nov 2026, 14:22–14:30 IST — DEPLOYED: per-user module access; two IT users; http link fix

Deployed with approval. 0 live meetings and 0 calls; the next meeting was 68 minutes later.

**Backups:**
- Database `Oneinsure_v_preAccess_20261120-142243.bak` (verified, 56.1 MB). The earlier `Oneinsure_v_preITusers_20261120-134147.bak` was taken before the users were created.
- Files `deploy\_backup-20261120-142243`.

**Per-user module access (V032):**
- **What it does:** in Administration › Users & roles, "Create user" has an **Access** section, and each user has a new action **Edit access**.
  - The four modules are **Meetings** (dashboard, meetings, calendar, recordings, reports), **Chat**, **Audio calls** and **Notes & tasks**. Calls and Notes & tasks need Chat.
  - A module switched off removes its permissions from that user even if a role grants them.
  - It applies on the user's next click; no sign-out is needed. Each change is audited as `USER_ACCESS_CHANGED`.
- **Database:**
  - New permissions `chat.calls` and `chat.tasks`, granted to every role that has `chat.use`.
  - New `auth.ModulePermissions` (19 rows), `auth.UserModuleBlocks` and the function `auth.EffectivePermissions`, now used for every permission check.
  - Verified on production: no user's permissions changed (0 users lost a permission; 0 blocks).
- **API:**
  - Calls need `chat.calls`; colleagues without it are not rung (409 `CALLS_NOT_AVAILABLE`, or skipped in a group).
  - Notes, tasks and My Day need `chat.tasks`.
  - `/chat/status` gains `calls`; `/chat/people` gains `canCall`.
  - Admin: `access` on user rows, `PUT /admin/users/{id}/access`, `GET /admin/users/{id}`, and an optional `access` when creating a user.
- **Website:**
  - Access picker and Edit access dialog; "Access: …" shown in the user list.
  - Sign-in and "/" go to the first page the person may use (dashboard, otherwise Chat, otherwise My Meetings, otherwise Settings).
  - My Day, Tasks and Notes in the menu need `chat.tasks`.
- **Tests:**
  - Backend 131/131 (6 new).
  - New `user-access` 3/3: Chat + calls only → lands on Chat, no meeting pages, dashboard refused; Meetings only → no Chat; restored; create form.
  - Regression all passing: `chat` 10/10, `calls` 7/7, `tasks` 7/7, `advanced` 8/8, `sidebar-sections` 5/5, `browsers` (Chrome, Android, iPhone) 39/39, `room` 11/11, `instant-link` 8/8, `refresh-rejoin` 6/6, `meeting-features` 12 passed / 1 not testable headless, `android-app-present` 9/9.
- **Rollback:**
  - code: restore `api\*` and `frontend-dist\*` from `_backup-20261120-142243`;
  - database: `database/rollback/V032__user_module_access.rollback.sql`.

**Users created (script, 13:42 IST):**
- **Ashit Shetty:** `ashit.shetty@oneinsure.com`, code `IT-TEMP-01`.
- **Ramakrishna Rao:** `ramakrishna.rao@oneinsure.com`, code `IT-TEMP-02`.
- **Both:** department IT, designation Sr. BA, role Employee, full access. The default password, which must be changed at first sign-in. Codes and designation can be edited on Employee Management › Edit employee.
- Audited `EMPLOYEE_CREATED` and `USER_CREATED`.

**Link fix (13:58 IST):**
- The portal's http→https redirect now keeps the full address, including `/meet` and the query (`frontend/public/web.config`). `http://www.oneinsure.com/meet/...` links, including the APK, work again.
- `http://oneinsure.com` (no www, no https) still gets a 404 from the server itself: the main website has no plain-http binding for that name, which is outside the portal.

## 20 Nov 2026, 13:25 IST — Android app 1.1.1 published

Requested by the administrator. versionCode 3. Same signing key, so it updates in place, and the app offers the update itself.
- No change to the app's own behaviour since 1.1.0. All chat features (read receipts, menu, scrolling chips, Chats | Calls) come from the live website and were already in 1.1.0.
- Build: unit tests and lint passed; signature checked by `publish-apk.ps1`.
- `/meet/app/OneInsureConnect.apk`, 26.3 MB, SHA-256 `69e070df0fc8457c6e4131c243ca664e34fedc02c6c5df7ea4ff9af212c24904`.
- Website backup before publishing: `deploy\_backup-20261120-132407` (contains APK 1.1.0).

## 20 Nov 2026, 13:11 IST — DEPLOYED: chat switcher shows Chats | Calls only; filter chips on one scrolling line (website only)

Requested by the administrator. No API or database change. 0 live meetings. Website backup `deploy\_backup-20261120-131057`.

- **Chat list switcher:** only **Chats | Calls**. My Day, Notes and Tasks are opened from the left menu (`/my-day`, `/tasks`, `/notes`) and no longer repeat the switcher.
- **Filter chips** (All, Unread, @ Mentions, ★ Saved, Groups, Pinned, Archived) are on **one line that scrolls sideways**, with **‹ ›** buttons and a soft fade on the side where more chips are hidden. Swipe, trackpad and mouse wheel also work. The Notes filters work the same way (new `pages/chat/ScrollChips.tsx`).
- **Tests:**
  - `sidebar-sections` 5/5, including the new S-05: chips on one line, › scrolls, "Archived" can be reached and selected, on a computer and a phone.
  - Tests that used the removed segments now open the sections from the menu or by address.
  - The full regression was still running at deploy time.
- **Rollback:** copy `frontend-dist\*` from `_backup-20261120-131057`.

## 20 Nov 2026, 12:53 IST — DEPLOYED: portal UI fixes, read receipts, My Day / Tasks / Notes in the menu (website only)

Deployed with approval. No API or database change. 0 live meetings. Website backup `deploy\_backup-20261120-125347` (`frontend-dist` 55 files).

**Fixes and changes:**
- **Chat filter chips** (All, Unread, @ Mentions, ★ Saved, Groups, Pinned, Archived) wrap onto a second line instead of running off the edge ("Gr…"). The Notes filters do the same.
- **Tab bars across the portal** (shared `Tabs` component: Department Management, API Documentation and 4 more) wrap on narrow screens instead of cutting the last tab.
- **API Documentation:** the "Visible only to administrators…" line is a normal sentence again (on phones it had split into three columns).
- **My Day quick actions** are a wrapping grid on phones and tablets, so no button is half hidden.
- **Chat list:** the "online" avatar strip above the list is removed. It repeated names already in the list; the green dot on each row shows presence.
- **Read receipts:**
  - In the bubble: sent ✓, delivered ✓✓ (white), read ✓✓ (green).
  - Under the latest message I sent: "Sent", "Delivered", or a blue "✓✓ Read".
  - In groups: "Read by N of M", then "Read by everyone".
- **Menu:** My Day, Tasks and Notes below Chat (`/my-day`, `/tasks`, `/notes`). They are shown only while "Notes, tasks and My Day" (CHAT_TASKS) is on, and they open the Chat workspace on that section, kept in step with the section control.

**Tests (test environment):**
- **Whole-portal layout audit** in Google Chrome (`tests/e2e/room/portal-audit.mjs`): every menu page and the chat sections at 1920, 1366, 1280, 768, 390 (iPhone size) and 360 (Android) px. All 132 page views are clean: no sideways scrolling, nothing cut off or outside the screen, no half-hidden rows, no script errors.
- **New tests:** `receipts` 2/2, `sidebar-sections` 4/4.
- **Suites:** `chat` 10/10, `calls` 7/7, `browsers` (Chrome, Android, iPhone) 39/39.
- One earlier run failed because leftover test processes from a stopped run were running at the same time. They were stopped, and every suite was then re-run clean.

**Rollback:** copy `frontend-dist\*` from `_backup-20261120-125347` over `frontend\dist`.

## 20 Nov 2026, 11:15–11:25 IST — DEPLOYED: Chat Phase 5 (advanced chat, switched off) + Android app 1.1.0

Deployed with approval. Delivery note: `documentation/CHAT_MODULE_PHASE5.md`. How it works for staff: `documentation/CHAT_HOW_IT_WORKS.md`.

**Production state:**
- CHAT and CHAT_CALLS on; CHAT_TASKS off.
- 0 live meetings, 0 recordings, 0 calls. The next meeting was the following day.

**Backups:**
- Database `Oneinsure_v_preAdvanced_20261120-111508.bak` (copy-only, CHECKSUM, verified, 55.1 MB).
- Files `deploy\_backup-20261120-111508` (`api` 376, `frontend-dist` 56).

**Database (additive):**
- V031 applied on its own.
- New tables: `chat.TRN_ChatScheduledMessage`, `TRN_ChatSavedMessage`, `TRN_ChatPinnedMessage`, `TRN_ChatMessageMention`, `TRN_ChatFavourite`.
- Quiet-hours columns on `chat.MST_ChatUserPreference`.
- Notification types `CHAT_MENTION` and `GROUP_ADDED`.
- Switch `CHAT_ADVANCED` is **off**.

**API:**
- `Chat/ChatAdvanced.cs`: scheduled, saved and pinned messages, mentions, favourites, quiet hours, search filters, follow-up panel.
- `ChatScheduledMessageWorker` sends each scheduled message exactly once.
- The API was down for about 10 s. Health `Healthy`; the new routes return 401 without sign-in. No MeetIQ errors in the event log.

**Website:**
- Phase 5 screens: + › Schedule message; Save and Pin in message actions; pinned bar; ★ Saved and @ Mentions filters; @mention picker and highlighting; search filters; Favourites row; quiet hours (moon indicator); quick follow-up panel.
- Notification icons for mentions, group-added and task and note reminders.
- Meeting Features switch "Advanced chat".

**Android app 1.1.0** (versionCode 2):
- Same signing key, so phones update in place, and the app offers the update itself.
- Change: the background notification now reads "OneInsure Connect call or meeting in progress", because chat calls also keep the microphone alive.
- Build: unit tests and lint passed; signature checked by `publish-apk.ps1`.
- `/meet/app/OneInsureConnect.apk`, SHA-256 `257a5a4fcccf5c27651aa81c8b32972cee66f26c43f5511c3d65191ea4065f9c`, 26.3 MB.

**Tests (test environment):**
- **Backend:** 125/125.
- **Phase 5:** `advanced` 8/8.
- **Chat and calls suites:** `chat` 10/10 (also with Advanced off), `calls` 7/7, `tasks` 7/7, `ios-look` 9/9, `android-app-chat` 3/3.
- **Cross-browser:** `browsers` 104/104 across Chrome, Edge, Safari, two Android phones, iPhone 14, iPhone SE and iPad. The iPhone 14 and the chat "last seen" check each failed once during the long run and passed on re-runs.
- **With the chat features off:** `room` 11/11, `refresh-rejoin` 6/6, `instant-link` 8/8, `mobile-audit` 8/8, `meeting-features` 12 passed / 1 not testable headless, `android-app-present` 9/9.

**Rollback:**
- normal: switch CHAT_ADVANCED off;
- code: restore `api\*` and `frontend-dist\*` from `_backup-20261120-111508` (the previous APK 1.0.0 is in that `frontend-dist\app`);
- database (deletes scheduled, saved, pinned, mentions, favourites and quiet hours): `database/rollback/V031__chat_advanced.rollback.sql`.

## 20 Nov 2026, 09:39–09:46 IST — DEPLOYED: Chat Phase 4 (notes, tasks, reminders, My Day), iOS-style Chat and Calls, animations, call fixes

Deployed with approval. Delivery note: `documentation/CHAT_MODULE_PHASE4.md`.

**Production state before the deploy:**
- CHAT and CHAT_CALLS had been switched **on** by the administrator; 0 chat messages and 0 calls in progress.
- 0 live meetings and 0 recordings. One meeting was due to start at 10:00 IST, so the API swap was done at 09:42, before joining opened. The API was down for about 10 s.

**Backups:**
- Database `Oneinsure_v_preTasks_20261120-093927.bak`: copy-only, CHECKSUM, RESTORE VERIFYONLY passed, 54.1 MB.
- Files `deploy\_backup-20261120-093927` (`api` 376 files, `frontend-dist` 51 files, git diff and status).

**Database (additive only):**
- V030 applied from its own folder.
- New tables: `chat.MST_TaskCategory` (5 defaults), `chat.TRN_ChatTask`, `chat.TRN_ChatNote`, `chat.TRN_ChatReminder`.
- Notification types `TASK_REMINDER` and `NOTE_REMINDER`.
- Switch `CHAT_TASKS` is **off**.

**API:**
- `Chat/ChatWork.cs`: notes, tasks, categories, reminders (snooze, done, dismiss, due, upcoming), My Day, meeting picker.
- `ChatReminderWorker` runs every 15 s and fires each reminder exactly once, with a bell entry and a live popup.
- `/chat/status` now also returns `tasks`.
- Health `Healthy`, and the new routes return 401 without sign-in.

**Website (`npm run build`):**
- **iOS look for Chat and Calls:**
  - large titles and a segmented control;
  - bubbles with tails;
  - action sheets on phones and tablets;
  - full-screen incoming and in-call screens on phones, with a minimise-to-pill option;
  - Calls tab like iOS Recents.
- **Phase 4 screens:** My Day, Tasks, Notes, the editors, follow-ups from message, chat, call, meeting and note, and the reminder popup on every page.
- **Animations** (the existing `motion` library and CSS, nothing new downloaded):
  - sliding segmented thumb;
  - new bubbles, reactions and badges pop in;
  - section fades;
  - phone conversations slide in;
  - ticked tasks bounce.

  All are off when the device asks for reduced motion.
- **Call fixes** (Phase 3 code): a call declined within about a second no longer leaves the caller's panel stuck or shows a false error.
- **Android app:** chat calls now tell the app to keep the microphone alive in the background, using the meeting room's existing message. The app shows the new screens with no new APK.
- Reminders set in the past now mean "now", and editing a task no longer re-sends an unchanged reminder.
- Meeting Features page: new switch "Notes, tasks and My Day".

**Tests (test environment, all passing):**
- **Backend:** 114/114.
- **Cross-browser** (`tests/e2e/room/browsers.mjs`, 13 scenarios each): 104/104 on 8 screens. The scenarios are sign-in and menu, send and receive, react and reply, emoji, file and antivirus, search, follow-up, incoming call, Calls tab, reminder popup with Postpone and Complete, notes, My Day, and no script errors.
  - Computers: Google Chrome, Microsoft Edge, Safari (WebKit, Mac settings).
  - Android: Chrome on a Pixel 7 and on a 360 px Galaxy S8.
  - Apple: Safari (WebKit) on iPhone 14, iPhone SE and iPad.
- **Other suites:**
  - `tasks` 7/7, `chat` 10/10, `calls` 7/7, `ios-look` 9/9;
  - `android-app-chat` 3/3 (sections fit the app; the app is told to keep calls alive; reminder popup in the app);
  - with the switches off: `room` 11/11, `android-app-present` 9/9, `refresh-rejoin` 6/6, `instant-link` 8/8, `mobile-audit` 8/8, `meeting-features` 12 passed / 1 not testable headless.
- **Fixed during testing:**
  - the emoji picker ran off the edge of small phones;
  - tablets now get the touch action sheet;
  - a reminder set at the current minute could be refused.

**Switching on:** Administration › Meeting Features › **Notes, tasks and My Day** (Chat must be on).

**Rollback:**
- normal: switch CHAT_TASKS off;
- code: restore `api\*` (stop/start MeetIQApi) and `frontend-dist\*` from `_backup-20261120-093927`;
- database (deletes notes and tasks): `database/rollback/V030__chat_tasks.rollback.sql`.

## 20 Nov 2026, 06:17–06:25 IST — DEPLOYED: Chat module Phase 3, audio calls (switched OFF until an admin turns it on)

Deployed with approval. Delivery note: `documentation/CHAT_MODULE_PHASE3.md` (decision D4: up to 10 people per call).

**Pre-checks and backups:**
- 0 live meetings, 0 recordings and 0 meetings starting soon, checked before the database change and again before the API swap.
- Database backup `Oneinsure_v_preCalls_20261120-061740.bak`: copy-only, CHECKSUM, RESTORE VERIFYONLY passed, 53.1 MB, in the SQL Server default backup folder.
- Files backup `deploy\_backup-20261120-061740` (`api` 376 files, `frontend-dist` 47 files, `git-diff.patch`, `git-status.txt`).

**Database `Oneinsure_v` (additive only):**
- V029 applied from its own folder (same method as V028; the dry run showed only V029).
- Adds `chat.TRN_ChatCall` and `chat.TRN_ChatCallParticipant`.
- Adds notification type `MISSED_CALL`.
- Switch `CHAT_CALLS` is **off**; `CHAT` is still off.

**API:**
- `Chat/ChatCalls.cs` (REST `/api/v1/chat/calls/*`): start, accept, decline, leave, end, invite, token, current, history.
- `ChatCallWorker` runs every 5 s: ring timeout after 45 s, and connection state from LiveKit's participant list.
- `RoomFeatureEndpoints.Keys` gains `CHAT_CALLS`.
- The meeting webhook and meeting code are unchanged.
- MeetIQApi restarted; health `Healthy`.

**Website (`npm run build`):**
- Phone button in chats; incoming-call popup on every portal page; call panel; Calls tab with history.
- "In a call" presence; missed-call bell icon; Audio calls switch on the Meeting Features page.
- The call screen (`CallOverlay`, 13 KB) loads only when needed.
- **Size fix:** since the 19 Nov Android deploy, the video library (571 KB) had been in the main file. It now loads only for meetings and calls. Main file: 1.76 MB → 1.19 MB.

**Live checks without sign-in:**
- health OK; `/chat/status` and `/chat/calls/current` return 401;
- `/meet/`, `/meet/login`, `/meet/chat`, the new chunks and the Android APK are served.
- Event log: no MeetIQ errors after the restart. A Hangfire message repeats every 10 minutes, but it comes from another application on this server (MeetIQ doesn't use Hangfire) and was already there before the deploy.

**Tests (test environment):**
- backend 106/106 (4 new call tests);
- `tests/e2e/room/calls.mjs` 7/7 (three people incl. a phone, real audio both ways through the test LiveKit);
- `chat.mjs` 10/10;
- regression with chat and calls off: `room` 11/11, `refresh-rejoin` 6/6, `instant-link` 8/8, `mobile-audit` 8/8, `android-app-present` 9/9, `meeting-features` 12 passed / 1 not tested;
- V029 rollback tested, then re-applied.

**Switching on:** Administration › Meeting Features: first **Chat**, then **Audio calls in Chat**.

**Rollback:**
- normal: switch CHAT_CALLS off (ends calls in progress within seconds);
- code: copy `api\*` over `deploy\api` (stop/start MeetIQApi) and `frontend-dist\*` over `frontend\dist` from `_backup-20261120-061740`;
- database (deletes call history): `database/rollback/V029__chat_calls.rollback.sql`.

## 20 Nov 2026, 01:53–02:05 IST — DEPLOYED: Chat module Phase 2 (switched OFF until an admin turns it on)

Deployed with approval. Plan: `documentation/CHAT_MODULE_PHASE1.md` (approved, decisions D1–D10). Delivery note: `documentation/CHAT_MODULE_PHASE2.md`.

**Pre-checks and backups:**
- 0 live meetings and 0 recordings, checked before the database change and again before the API swap.
- Database backup `Oneinsure_v_preChat_20261120-015326.bak`: copy-only, CHECKSUM, RESTORE VERIFYONLY passed, 53.1 MB, in the SQL Server default backup folder.
- Files backup `deploy\_backup-20261120-015326` (`api`, `frontend-dist`, `git-diff.patch`, `git-status.txt`).

**Database `Oneinsure_v` (additive only):**
- V028 applied from its own folder.
  - The full-folder dry run reports V001–V013 as "modified after apply". Those files are unchanged since the first import, so production was set up from a different copy of them (line endings). Nothing was changed for them.
- Adds the `chat` schema: 7 tables (`MST_ChatFileType` with 15 types, `MST_ChatUserPreference`, `TRN_ChatConversation`, `TRN_ChatConversationParticipant`, `TRN_ChatMessage`, `TRN_ChatMessageReaction`, `TRN_ChatFile`).
- Permission `chat.use` granted to all 8 roles; switch `CHAT` is **off**.

**Storage:** new folder `deploy\data\chat` with its own permissions (Administrators and SYSTEM full control, `NT SERVICE\MeetIQApi` Modify, nothing inherited).

**API:** `Chat/` (REST `/api/v1/chat/*`, SignalR hub `/api/v1/hubs/chat`, presence and session sweep every 30 s, Windows Defender scan worker). `Program.cs` additions; `RoomFeatureEndpoints.Keys` gains `CHAT`. MeetIQApi restarted; health `Healthy`.

**Website (`npm run build`):**
- New Chat workspace (`/chat`, own chunk; the SignalR client loads only when Chat is on for the person).
- Menu item "Communication › Chat" below Meetings, with an unread badge, shown only while CHAT is on.
- On phones Chat replaces Calendar in the bottom bar while on.
- Chat switch on the Meeting Features page.

**New package:** `@microsoft/signalr` 10.0.11 (MIT).

**Live checks without sign-in:**
- health OK;
- `/chat/status` and `/chat/conversations` return 401;
- hub negotiate returns 403 without the security token;
- `/meet/chat` and the chat chunk are served.

**Tests (test environment):**
- backend 102/102 (6 new chat tests);
- `tests/e2e/room/chat.mjs` 10/10 (two people live plus a phone; files scanned by the real Windows Defender);
- regression with Chat off: `room` 11/11, `refresh-rejoin` 6/6, `instant-link` 8/8, `mobile-audit` 8/8 (also 8/8 with Chat on), `mobile-join-devices` 5/5, `goodday-14227-back` 3/3, `goodday-14224-14226` 4/4, `screen-share-view` 10/10, `android-app-present` 9/9, `meeting-features` 12 passed / 1 not tested;
- V028 rollback tested, then re-applied.

**After switching Chat on:** the first upload confirms that Windows Defender runs under the service account. If it cannot run, files stay "could not be checked" and are never served.

**Rollback:**
- normal: switch CHAT off;
- code: copy `api\*` over `deploy\api` (stop/start MeetIQApi) and `frontend-dist\*` over `frontend\dist`;
- database (deletes chat data): `database/rollback/V028__chat.rollback.sql`.

## 19 Nov 2026, 14:20 IST — Android app 1.0.0 (phone screen sharing) + refresh rejoins the meeting

Deployed with approval: API, website and recording layout (no database change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. API down about 7 s. Backup `deploy/_backup-20261119-141811` (`api`, `frontend-dist`, `recorder-layout`, `git-diff.patch`, `git-status.txt`).

- **Android app** (`mobile/android`, new; free and open-source tools only, no store or paid service):
  - what it is: the portal in a locked-down WebView, package `com.oneinsure.connect` 1.0.0, Android 8+, ARM, 26.3 MB, signed with our own key (certificate SHA-256 `b0e35fac…bc02`; key at `C:\Android\keys`, **back it up**);
  - download: `/meet/get-app` (new public page) → `/meet/app/OneInsureConnect.apk`, SHA-256 `56dd0135…1fc46`; `android.json` drives the in-app update check;
  - **presenting the phone screen** (phone browsers cannot): Android MediaProjection + a second, screen-only LiveKit connection `<identity>.screen`;
  - the call keeps going while another app is open (foreground service);
  - meeting/join links open in the app;
  - security: only `https://www.oneinsure.com/meet/…` runs inside; other links go to the browser; the JS bridge is origin-locked to the main frame; the screen goes only to our own `wss://` server.
- **API** (`ScreenCompanion.cs`, `LiveKit.CreateScreenCompanionToken`, `RoomEndpoints.cs`):
  - `POST /meetings/{id}/room/screen-companion` (employees) and `POST /join/{token}/screen-companion` (admitted guests, rate-limited) give a token that may only publish a screen: no subscribe, no data, no admin, at most 10 minutes;
  - live meeting and publish rights required; audited `ROOM_SCREEN_APP_TOKEN_ISSUED`;
  - removing a person also removes their phone screen.
- **Website:**
  - `androidApp.ts` bridge; Present in More inside the app;
  - "You're presenting your phone screen · Stop" bar; the presenter does not see their own screen mirrored;
  - the screen connection is not counted or listed as a person (`usePeople`: header, participants, chat, whiteboard);
  - `web.config` serves `.apk` and `.json`.
- **Recording layout:** the phone screen shows as "<name> is presenting", with no extra person tile.
- **Refresh rejoins the meeting** (`room/rejoin.ts`, `EmployeeRoomPage.tsx`, `GuestRoom.tsx`, `JoinPage.tsx`, `LinkJoinPage.tsx`):
  - before: refreshing during a meeting (Chrome, Safari, the app) dropped the person to "Join now" / the invitation page;
  - now: "Rejoining the meeting…" and straight back in with the same mic/camera choices, for hosts, colleagues, customers and link guests; an admitted customer is not queued again;
  - how: a per-tab sessionStorage marker (device choices and the guest's name only, no tokens), used only within 2 minutes;
  - when it does not apply: Leave, removed, ended, turned away, a new tab;
  - someone refreshing in the waiting room asks again automatically.
- **Tests** (test site):
  - backend 96/96 (new `Android_app_screen_companion_token_may_only_publish_a_screen_…`);
  - Android unit tests 7/7, lint clean, signed APK verified;
  - `android-app-present` 9/9; new `refresh-rejoin` 6/6 (media flows to the host after a refresh);
  - regression: `room` 11/11, `goodday-14224-14226` 4/4, `goodday-14227-back` 3/3, `instant-link` 8/8, `mobile-join-devices` 5/5, `screen-share-view` 10/10, `screen-share-mobile` 4/4, `goodday-14229` 6/6, `mobile-audit` 8/8, `goodday-14231` 2/2, `goodday-14222-14223` 6/6, `meeting-features` 12 passed / 1 not tested.
- **Live checks after the deploy:**
  - health OK;
  - the new endpoint answers 403 without sign-in;
  - `android.json` 200 `application/json`;
  - APK 200 `application/vnd.android.package-archive`, downloaded SHA-256 matches;
  - `/meet/get-app` renders at 390 px with no overflow and no errors.
- **Not tested:** real phones; use `documentation/ANDROID_APP_TEST_CHECKLIST.md`. iOS app not built (needs a Mac and a paid Apple account).
- **Rollback:**
  - API: `Stop-Service MeetIQApi`; copy `api\*` over `deploy\api`; `Start-Service MeetIQApi`;
  - website: copy `frontend-dist\*` over `frontend\dist`;
  - recording layout: copy `recorder-layout\*` over `deploy\recorder-layout`.

## 18 Nov 2026, 23:29 IST — Shorter meeting and join links (128-bit codes) + link format check

Deployed with approval: API only (no database or website change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. API down about 9 s. Backup `deploy/_backup-20261118-232902` (`api`, `frontend-dist`, `git-diff.patch`, `git-status.txt`).

- **Shorter links** (`Security/Crypto.cs` `Tokens.NewLinkToken`; `MeetingLinkEndpoints.cs` x5, `MeetingSupport.cs` x1): meeting links (`/m/…`) and personal join links (`/join/…`) use 16 random bytes = 22 base64url characters (128-bit), was 32 bytes / 43. A link is ~55 characters instead of ~76. Links made before keep working (looked up by SHA-256 hash, whatever their length). Sessions, password resets, API keys and webhook secrets unchanged (32 bytes).
- **Format check** (`Tokens.LinkTokenRoute`): every link route (`/m/{token}`, `/m/{token}/request`, `/join/{token}`, `/join/{token}/…` incl. `/join/{token}/recording`) accepts only base64url codes of exactly 22 or 43 characters; anything else gets the same 404 "invalid link" JSON from a low-precedence catch-all, without a database lookup.
- **Unchanged protections:** only hashes stored, per-IP rate limit on link/join requests, links expire with the meeting and can be withdrawn/replaced, link guests always go through the waiting room.
- **Tests:** backend 95/95 (new `Link_codes_are_22_characters_old_43_character_links_still_work_and_junk_is_refused`; the rate-limit test now uses well-formed unknown codes; customer invitation test expects 22); browser (test site) `instant-link` 8/8, `goodday-14231` 2/2, `mobile-join-devices` 5/5, `goodday-14222-14223` 6/6, `room` 11/11.
- **Rollback:** `Stop-Service MeetIQApi`; copy `api\*` over `deploy\api`; `Start-Service MeetIQApi`. Links created while this version ran (22 characters) keep working after a rollback (hash lookup; the old version has no format check).

## 18 Nov 2026, 22:58 IST — Phones: mic/camera "busy" message, join page fits, screen toolbar folds away

Request: `Oneinsure_connect_bugs.docx` (18 Nov evening, 3 screenshots) plus the phone check of the screen-share view. Deployed with approval: website only (no API restart, no database change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. Backup `deploy/_backup-20261118-225814` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **"Your microphone/camera is being used by another app" on Android/iOS** (`MeetingRoom.tsx`):
  - cause: phones refuse a device for a moment (NotReadable/TrackStart/Abort) after it was released or after returning from another app; the first refusal was final, and the room-wide `onMediaDeviceFailure` showed the message at once (and reported a failed screen share as a microphone problem);
  - fix: `enableDevice` - up to 3 quiet attempts over ~2 s (waits while the page is in the background), used by the mic/camera buttons and the on-join publish; one message only if all fail, with the browser's error code; the room-wide handler now only opens the "blocked permission" steps, and ignores screen-share failures.
- **Phone join page** (`PreJoin.tsx`): the name is shown under the avatar above the mic/camera buttons (was hidden behind them); compact header, preview and card on phones; Camera/Microphone pickers behind "Camera and microphone settings" on phones; "Ask to join" visible without scrolling at 360x600, 412x780, 390x664.
- **Screen-share toolbar** (`ScreenShareView.tsx`, `room.css`): closed by default to one small faint button; opens on tap/click; closes by itself after 5 s without use (not while the mouse is over it) or with its close button. No fullscreen button where the browser cannot do page fullscreen (iPhone Safari).
- **Tests** (test site): new `mobile-join-devices.mjs` 5/5, `screen-share-mobile.mjs` 4/4 (Android/iPhone portrait/landscape), `screen-share-view.mjs` 10/10; regression `room` 11/11, `goodday-14229` 6/6, `mobile-audit` 8/8, `instant-link` 8/8, `meeting-features` 12 passed / 1 not tested, `goodday-14222-14223` 6/6, `goodday-14227-back` 3/3; frontend type check clean. Test helper `newPage` takes optional `userAgent` / `deviceScaleFactor`.

## 18 Nov 2026, 16:55 IST — Screen sharing: sharp full-resolution picture, working fullscreen, zoom (Phase 2)

Request: `Oneinsure_connect_bugs.docx` "Screen Sharing Quality, Fullscreen and Remote Control Enhancement" (two screenshots from OIC-261118-5YE5). Phase 1 report approved; remote control dropped by the user. Deployed with approval: website only (no API restart, no database change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. Backup `deploy/_backup-20261118-165457` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Root causes** (measured, `tests/e2e/room/screen-share-probe.mjs`):
  - blurry text: adaptive stream requested the layer matching the shown size, so a 1920x1080 share shown ~1163x545 arrived as 960x540 and was stretched (production log: the share itself was sent at 1920x1080);
  - "expand" did nothing: it was LiveKit's pin toggle, and the share is already the pinned tile;
  - small: header + toolbar + participants strip left ~970x545 for a 16:9 screen.
- **Fix** (new `src/pages/room/ScreenShareView.tsx`; `MeetingRoom.tsx` `Stage`, `Tile`, `roomOptions`, `ScreenShareToggle`; `room.css`):
  - someone else's screen on the main area: the video element keeps the share's full size and is scaled down with a transform, so the full-resolution layer is received and downsampled (sharp); the video server still lowers it on a weak link;
  - **Quality**: Auto (default; full unless this viewer's connection is poor), Standard (smaller layer, previous behaviour), Maximum; remembered per browser;
  - **Zoom** in / out, **Fit**, **1:1** actual size, drag or scroll to move, Ctrl + wheel;
  - **Hide / show participants**; compact participants strip while a screen is shown;
  - **Fullscreen**: the whole meeting page (controls, dialogs, toasts usable) through the Fullscreen API from the click; Esc or the button exits and restores the strip; if the browser refuses, a message says so and the screen is expanded in the page instead;
  - the useless pin icon is hidden on screen tiles only (camera tiles keep it); the presenter's own view is unchanged;
  - presenter: screen-share bitrate 2.5 -> 3.5 Mbps (1080p, 15 fps) and `contentHint: 'detail'`.
- **Not changed:** capture, room connection, permissions, recording (the recorder already receives the full layer), meeting lifecycle. Remote control not built (not approved).
- **Tests** (test site):
  - new `tests/e2e/room/screen-share-view.mjs` 9/9 (full 1920x1080 received at the screenshot size; Standard 960x540; hide strip; zoom/1:1/fit; fullscreen enter/exit with the share still running; late joiner; 390 px; touch phone toolbar; stop presenting);
  - regression: `room` 11/11, `goodday-14229` 6/6, `mobile-audit` 8/8, `meeting-features` 12 passed / 1 not tested, `instant-link` 8/8, `goodday-14227-back` 3/3; frontend type check clean;
  - not run here: `end-and-late-share` (needs the 5176 environment), `recording-board-poll` (recorder not configured in this test launch).

## 17 Nov 2026, 21:28 IST — GoodDay #14229: presenting from iPhone needs the latest iOS (message corrected)

Deployed with approval: website only (no API restart, no database change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. Backup `deploy/_backup-20261117-212830` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Finding** (production video-server logs 3–17 Nov, screen-share tracks by the sender's device):
  - iPhone on iOS 27.2+ (Safari and Chrome): 7 screen shares (13–16 Nov), including after the 15 Nov change;
  - iPhone on iOS 26.x / 27.0: 0 of 22 connections;
  - Android phone browsers: 0 of 68 connections.
  The browser offers screen capture (`getDisplayMedia`) only on the latest iOS; Present was already shown by feature detection (in More on a phone). The earlier statement that Apple never allows it was wrong.
- **Fix** (`MeetingRoom.tsx` `screenShareUnsupportedMessage`): an iPhone/iPad without screen capture now reads "Presenting from iPhone or iPad needs the latest iOS. Update it in Settings > General > Software Update (iOS 27.2 or later), then join again: Present will be in the More (⋯) menu. You can still see screens others present." Android message unchanged.
- **Tests:** `tests/e2e/room/goodday-14229.mjs` 6/6 on the test site (new GD14229-06: an iPhone whose browser offers screen capture gets the working Present button in More); frontend type check clean.
- **Android:** not possible from a phone browser; would need a companion Android app (proposed, not approved).

## 17 Nov 2026, 20:23 IST — GoodDay #14231: one link in "Invite people" for customer meetings

Deployed with approval: website only (no API restart, no database change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. Backup `deploy/_backup-20261117-202327` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Report:** after starting an instant customer meeting, Invite showed two different links (the customer's personal link and the general meeting link), both with "Copy link".
- **Fix** (`MeetingLinkShare.tsx` `ShareLinkDialog`): with personal links (customer / PLVC participants / "Send link to customer"), only those are shown; the general meeting link is behind **Invite someone else (colleague or extra person)**. Internal meetings unchanged.
- **Tests:** `tests/e2e/room/goodday-14231.mjs` 2/2 on the test site; frontend type check clean.
- **Not changed:** #14229 (screen sharing from phone browsers). Present is already enabled by feature detection (`getDisplayMedia`), so any phone browser that supports screen capture gets it; iOS and Android phone browsers do not offer it to websites.

## 17 Nov 2026, 18:12 IST — Instant meeting: Title is mandatory for everyone

Deployed with approval: API and website (no database change). Before the deploy: 0 live meetings, 0 active recordings, nothing starting in the next 30 min. API down about 9 s. Backup `deploy/_backup-20261117-181208` (`api`, `frontend-dist`, `git-diff.patch`, `git-status.txt`).

- **Dialog** (`QuickMeetingDialogs.tsx`): "Title (optional)" is now **Title**; blank or spaces shows "Title is required." under the field and the meeting is not started. Applies to every type, including PLVC **Skip details & start**. The default "<name>'s meeting" placeholder is replaced by an example.
- **API** (`MeetingLinkEndpoints.cs`): `POST /api/v1/meetings/instant` (portal) refuses a missing title with 400 `VALIDATION` `errors.title`, collected with the other field errors. The external Integration API is **unchanged**: `meetingTitle` stays optional with the default "<host name>'s meeting".
- **Tests:**
  - backend 94/94, with a new blank-title check;
  - browser test `tests/e2e/room/instant-link.mjs` 8/8 on the test site (now also checks that a blank title is blocked).
- **Rollback:**
  1. **Website:** copy `frontend-dist\*` over `frontend\dist`.
  2. **API:** `Stop-Service MeetIQApi`; copy `api\*` over `deploy\api`; `Start-Service MeetIQApi`.

## 17 Nov 2026, 16:53 IST — PLVC: Ganesh Pansare as Senior Manager / department head; dashboard "My Team"

Deployed with approval: database data, API and website. Before the deploy nobody was connected (last video-server activity 15:42 IST). API down about 4 s. Backup `deploy/_backup-20261117-165332` (`api`, `frontend-dist`, `git-diff.patch`, `git-status.txt`).

- **Data** (production `Oneinsure_v`, scratchpad script `plvc-ganesh-head.sql`, audited):
  - designation **Senior Manager** (SM) created and set on GANESH PANSARE (5847);
  - PLVC department head = Ganesh;
  - Tanvi Patil, Ayush Salian, Akshay Udhan and Tahir Khan report to Ganesh;
  - Ganesh's sign-in got the **DepartmentHead** role (adds `reports.view` and `minutes.approve`; next sign-in).
- **Dashboard** (`DashboardEndpoints.cs`, `DashboardPage.tsx`, `Card.tsx` `StatCard.onClick`):
  - "Total Employees" (all active employees) is shown only with `employees.manage`;
  - everyone else sees **My Team** (`#team`: own department, departments they head, reports at any depth), with the department as footnote;
  - clicking it opens the read-only team list from the new `GET /api/v1/dashboard/team` (name, designation, department, code; Head / Reports to you).
- **Tests:**
  - backend 94/94;
  - manager, member and admin views checked through the API and on screen (test site);
  - data script re-run safe;
  - frontend type check clean.
- **Rollback:**
  1. **Website:** copy `frontend-dist\*` over `frontend\dist`.
  2. **API:** `Stop-Service MeetIQApi`; copy `api\*` over `deploy\api`; `Start-Service MeetIQApi`.
  3. **Data:** keep it, or reverse in Employee/Department Management (the audit log has the old values).

## 17 Nov 2026, 16:16 IST — Change-password page fits on one screen (no scrolling)

Deployed with approval: website only (no API restart, no database change). Before the deploy, the production video server's last activity was 15:42 IST and nobody was connected. Backup `deploy/_backup-20261117-161617` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Report:** the change-password page (shown at first sign-in) was too tall and had to be scrolled (screenshot at about 125% zoom).
- **Change:**
  - `AuthCard compact`: a small one-row brand, tighter padding; the in-card "OneInsure" line is hidden on very short screens.
  - `AuthHeading compact`: no large icon.
  - Smaller gaps, strength meter and rules list (`PasswordPages.tsx`).
  - Applies to **Change password** and **Set a new password** only.
  - Short screens (`short:` ≤ 820 px tall) get less outer padding on every sign-in page.
  - Phones get `py-5` instead of `py-8`.
- **Extra scroll, before → after:**

  | Screen | Before | After |
  |---|---|---|
  | 1536×736 | 191 px | 0 |
  | 1366×650 | 261 px | 0 |
  | 1920×940 | 0 | 0 |
  | 390×844 phone | 187 px | 0 |

  The sign-in page is unchanged in look and also fits at 1536×736 and 390×844. Frontend type check clean.

## 16 Nov 2026, 22:23 IST — GoodDay #14227: phone Back during a meeting asks "Leave the meeting?"

Deployed with approval: website only (no API restart, no database change). Before the deploy, the production video server had no activity since 16:28 IST. Backup `deploy/_backup-20261116-222311` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Report:** "if we go back from Chrome or Google from the meeting, after a few seconds the user shows as exited; opening the same URL again brings them back".
- **Cause:** the phone's Back button or gesture navigated away from the meeting page. That leaves the call (`pagehide`), and returning showed the previous page.
- **Change** (`MeetingRoom.tsx` `BackGuard`):
  - while in the room, one extra history entry (same address, router state `oicRoomGuard`) catches Back and is put back at once;
  - the person is asked "Leave the meeting?" (Stay in the meeting / Leave meeting; Leave = the normal Leave button);
  - applies to everyone in a meeting.
- **Tests (isolated test environment):**
  - new `room/goodday-14227-back.mjs` 3/3: Back asks; after Stay, the host still sees the customer 10 s later; Leave leaves; the host also asked;
  - regression 26/26: host-alert 3, 14230 2, 14208/14227 2, 14229 5, 14222/14223 6, instant-link 8;
  - frontend type check clean.
- **GoodDay:** #14227 resolved. #14229 commented: phone browsers cannot present; asked for phone, browser and time if it worked from a phone earlier.

## 16 Nov 2026, 21:51 IST — GoodDay #14230 (reopened): hosts get the Extend prompt 5 minutes early and when not looking at the meeting

Deployed with approval: website only (no API restart, no database change). Before the deploy, the production video server's last activity was 16:28 IST, so no meeting was running. Backup `deploy/_backup-20261116-215038` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Report:** "logged in through an id which is not an admin; no option is coming to the host for extending" / "sometimes the host does not get the extend notification".
- **Findings:** production query of 16 Nov tests (host Harsh Raj, Employee login, role HOST).
  - The host ended all four meetings himself before the scheduled end, e.g. `OIC-261116-LVJ9` at 15:22:57 vs end 15:23:33.
  - Extend is not admin-only: it needs the meeting role HOST or COHOST. A non-admin host was verified on phone and computer.
  - **Cause:** before the end there was only the small strip. The popup came only once the time was up, and only inside the page.
- **Changes** (`MeetingRoom.tsx` `EndTimeBanner`, new `pages/room/hostAlerts.ts`, `EmployeeRoomPage.tsx`):
  - **Earlier popup:** hosts get the popup at the **5-minute warning** ("The meeting ends soon": Extend 15 / Extend 30 / End now / Keep going), then again when the time is up. Each comes once per end time.
  - **When the popup opens:** a short chime plays (Web Audio, unlocked by the Start/Join click).
  - **If the page is hidden:** a **system notification** (only if allowed; asked once on the host's Start/Join click; clicking it focuses the tab) and a **flashing tab title** ("⏰ Time is up - extend?"), restored on return.
  - **Unchanged:** customers and guests see only the strip, as before. Nothing is sent to any server or third party.
- **Tests (isolated test environment):**
  - new `room/goodday-14230-host-alert.mjs` 3/3: popup at 5 min, host only; hidden tab → notification and title; Extend from the popup;
  - regression `goodday-14230.mjs` 2/2 and `goodday-14208-14227.mjs` 2/2;
  - frontend type check clean.

## 16 Nov 2026 — Reporting view `rpt.TRN_MeetingCallLog` (calling-portal call-back shape)

Applied on 16 Nov 2026 to production `Oneinsure_v` (run in SSMS, output checked) and to the test database `OneInsureVideoMeetingDB_Room`. Database only: one new schema `rpt` and one view. No table, procedure or application code changed; no restart.

- **What it is:** one row per meeting, with the calling portal's field names.
- **Fields:** `callid`, `Agentname`, `AgentUniqueID`, `CallerID`, `CampaignName`, `StartTime`/`EndTime` (IST), `CallDuration`, `RingingDuration`, `Duration`, `DialStatus`, `CustomerStatus`, `HangupBy`, `status`; plus Prarambh Main ID, external reference, recording status/duration and an `AudioFile` link (sign-in required).
- **Script:** `database/reports/rpt_TRN_MeetingCallLog.sql`. It is not a migration, so re-run it by hand after a database rebuild.
- **Rollback:** `DROP VIEW rpt.TRN_MeetingCallLog;`

## 16 Nov 2026 — GoodDay #14230, #14223 (reopened), #14229 / #14227 answered; Integration API idempotency fix (phase a)

Deployed with approval on 16 Nov 2026, ~13:49–13:50 IST: API and website. Backup `deploy/_backup-20261116-134848` (`api`, `frontend-dist`, `git-diff.patch`, `git-status.txt`). No database change.

**Before the deploy** (production `Oneinsure_v`, read-only check): 0 LIVE meetings, 0 active recordings or recording jobs, none starting within 30 min; checked again just before the API swap. API down about 4 s.

**#14230: "Host extended the meeting but the customer still sees 'Scheduled time is up'":**
- **Cause:**
  - an extension reached the other participants only as a one-off LiveKit data message (`end-changed`);
  - a phone that was reconnecting at that moment missed it;
  - nothing re-checked afterwards, so it counted down to the old end.
- **Fix:**
  - the recording state that every participant (guests too) already re-reads every 10 s and on reconnect now carries `ends: {endUtc, autoEndUtc}` (`RecordingService.StateAsync`; additive field);
  - the room applies it when it differs (`MeetingRoom.tsx`, `sameInstant`).
- **Unchanged:** the push message, the host popup, Extend / End now, and automatic end.

**#14223 (reopened 16 Nov: "schedule meeting is visible 2 times in the mobile"):**
- The phone-only dashboard "Schedule meeting" button (`dashboard-schedule-mobile`) was removed.
- The header's labelled "+ Schedule" is the one Schedule button on phones, as on a computer.
- On phones an odd last quick-action button (Calendar) takes the full row (`DashboardPage.tsx`).

**#14229 / #14227:** answered in GoodDay, no code change.
- **#14229:** phone browsers have no screen capture for websites. It was set to Resolved, "works as designed for the web".
- **#14227:** Nothing OS cuts the browser's network when minimised. We asked for the battery setting and the auto-rejoin result, and left it Reopened.

**Integration API — idempotency (requirements doc "instant meeting returned 14 November"):**
- **Root cause:**
  - the portal sent its Integration ID (`INT-…`) as `Idempotency-Key` on every create;
  - `POST /meetings` replayed the stored 14 Nov response (same body hash; an instant body has no time);
  - stored keys never expired.
  - The server clock and the IST conversion were correct.
- **Fix (`ExternalApiEndpoints.CreateMeeting`):**
  - **Integration ID refused:** `Idempotency-Key` equal to the Integration ID → `400 IDEMPOTENCY_KEY_INVALID`.
  - **Keys expire:** a key is remembered for `Integrations:IdempotencyHours` (default 24, 1–720), then it is free again.
  - **No stale replays:** a replay whose meeting has ended, expired or been cancelled → `409 IDEMPOTENCY_KEY_USED` instead of the old response.
  - **Unchanged:** a retry of a live meeting is still replayed (`Idempotent-Replayed: true`), and 422 / 409 REQUEST_IN_PROGRESS work as before.
- **Hourly cleanup:** `WebhookWorker.CleanupIdempotencyAsync`. In production it removed the one stale key at startup (1 → 0 rows).
- **Docs:** API guide (`ApiGuide.tsx`: notes, curl example, error table), the OpenAPI description, `API_INTEGRATION_GUIDE.md`, `API_ENDPOINT_REFERENCE.md`, and the static OpenAPI copy.
- **The portal team must still change their call:** a new key per meeting (for example case ID + GUID), and the same key only for a retry.

**Tests:**
- **Backend:** 94/94 (`OIC_TEST_DATA_PATH`, `OIC_FFMPEG_DIR=C:\ffmpeg\bin` on this server), including the new `IntegrationTests.Idempotency_keys_cannot_be_the_integration_id_never_replay_ended_meetings_and_expire`.
- **Browser (isolated LocalDB `_Room`, API 7191, LiveKit 7890 — never production 7880):**
  - new `room/goodday-14230.mjs` 2/2: a silent extension cleared the phone strip in 9 s; a normal Extend cleared it in 21 ms;
  - `room/goodday-14222-14223.mjs` 6/6 (GD14223-02 updated to the new rule);
  - regression `room/goodday-14208-14227.mjs` 2/2.

**Rollback:**
1. **Website:** copy `deploy\_backup-20261116-134848\frontend-dist\*` over `frontend\dist`.
2. **API:** `Stop-Service MeetIQApi`; copy `deploy\_backup-20261116-134848\api\*` over `deploy\api`; `Start-Service MeetIQApi`.

**Pending your approval:** Integration API phase (b) (reschedule endpoint, `timeZone` field) and phase (c) (host direct join with an e-mail code). Their detailed designs come first.

## 15 Nov 2026 — API Documentation: Swagger UI replaced by a built-in API reference

Deployed with approval on 15 Nov 2026 ~21:50 IST (website only; no service restarted). Backup `deploy/_backup-20261115-214959` (`frontend-dist`, `git-diff.patch`, `git-status.txt`). Rollback: copy `frontend-dist\*` over `frontend\dist`.

- **Removed:** `swagger-ui-dist` (package, `SwaggerPanel.tsx`, type file). No new packages; no CDN, analytics or paid service.
- **New `ApiReferencePanel.tsx`** (tab renamed "API reference"): reads the same OpenAPI document, shows operations, parameters, request/response schemas, and a "Try it" form with a ready-to-copy `curl`.
- **Security of "Try it":**
  - the API key is held in memory only and cleared when you leave the tab;
  - requests go only to this site's `/api/ext/`;
  - the session cookie is never sent;
  - redirects are refused;
  - no caching and no referrer.
- **Unchanged:** backend, external API, OpenAPI generation and its 401/403 rules, the guide, Download OpenAPI, Integrations & API keys.
- **Before the deploy:** the last LiveKit activity was at 16:08 IST.
- **Checked live:**
  - `/meet/` serves the new entry script;
  - health 200;
  - OpenAPI 401 and `/api/ext/v1/me` 401 when called without credentials;
  - the new chunk is served, and nothing in the entry script mentions Swagger.
- **Tests:** `api-docs-page.mjs` and `enhancements-1112.mjs` now target the new panel; not yet re-run.

## 15 Nov 2026 — Recordings show the whiteboard and polls; whiteboard open to everyone; live poll results for everyone

Deployed with approval on 15 Nov 2026 ~11:28 IST: API, website and recorder page. Backup `deploy/_backup-20261115-112647` (`api`, `frontend-dist`, `recorder-layout`, `git-diff.patch`).

**Feature switches:** Polls, Whiteboard and the other six features were **already on** in production: switched on 14 Nov 2026, 21:44 IST, by Santosh Yadav (audit `FEATURE_SETTING_CHANGED`). The 07:27 entry below ("every switch is off") describes the state at that deploy only. No switch was changed today.

**What changed:**
- **Recording shows the whiteboard:**
  - while the board is open it fills the main area of the recording, live, like a screen share;
  - when there is both a board and a screen share, the one started more recently is shown;
  - cameras move to the side strip.
- **Recording shows polls:**
  - a card in the top-right of the main area with the question and live Yes/No counts;
  - "Final result" for 15 s after the host closes the poll.
- **Private chat is never recorded.**
- **Drawing made before recording starts:** the server sends the recorder the open board, the saved drawing and the current poll, to the recorder's identity only. This happens each time the recorder starts a segment, including after a restart (`RecorderWorker` → `RoomFeatureEndpoints.SendRecorderSnapshotAsync`), and again when the board is reopened.
  - Server-sent data has no sending participant, so nobody in the meeting can forge it.
  - Strokes from participants who may not draw are ignored, as in the room.
- **Whiteboard:** opens with drawing for **Everyone** by default; the host can still choose Only hosts or Selected people.
- **Polls:** everyone in the meeting sees live results (until now only hosts did, before the poll was closed). Only hosts start and close polls, as before.
- **Whiteboard drawing code** is now one shared file (`frontend/src/pages/room/features/whiteboardRender.ts`), used by both the room and the recorder page.

**Before the deploy:** 0 LIVE meetings, 0 active recordings or recording jobs, no recorder process.

**Checked live:**
- API: `Healthy`, about 35 s down; production `appsettings*.json` untouched; the new code is in the deployed DLL.
- `/room-features`: polls and whiteboard true.
- `index.html` is new (Last-Modified 05:59 UTC); the sign-in page loads.
- The recorder page in `deploy/recorder-layout` has the board and poll code.

**Tests (local, isolated LiveKit on 7980 with the development keys):**
- new `room/recording-board-poll.mjs`: 8/8. A rectangle drawn before recording, an employee stroke during recording, the live poll card and the final result were all checked in frames taken from the MP4.
- `room.mjs`: 11/11.
- `meeting-features.mjs`: 12/13. MF-10 (camera flip) not tested: it needs 2 cameras. MF-04 and MF-06 were updated to the new defaults.
- `goodday-14229`: 5/5; `goodday-14208-14227`: 2/2; `goodday-14224-14226`: 4/4. That test now closes the #14208 "time is up" popup, which blocked it since 14 Nov evening.
- API build: 0 warnings. The database-backed API unit tests could not run on this machine (LocalDB "Access is denied" while creating the test database); 9 of 9 tests that need no database pass.

## 15 Nov 2026 — GoodDay #14229 "Screen Present Feature Not Working in iOS Chrome, Check for iOS, Android and for all device"

Deployed with approval on 15 Nov 2026 ~10:05 IST (website only; backup `deploy/_backup-20261115-100526`). In GoodDay (project Meet), this was the only new bug. It is marked Resolved there with a comment.

- **Cause (platform limit):** every browser on iPhone/iPad (Chrome, Safari, Edge, Firefox) uses Apple's WebKit, which gives web pages no screen capture (`getDisplayMedia` is missing). Android phone browsers lack it too. A website cannot add it; only an installed native app could.
- **What was wrong on our side:** the message told an iOS Chrome user to "try a desktop browser such as Chrome or Edge".
- **Change (`MeetingRoom.tsx`, `screenShareUnsupportedMessage`):** tapping Present on such a device now explains why, per device:
  - iPhone/iPad (an iPad reports itself as a touch-screen Mac): Apple restriction, in all browsers;
  - Android: phone browsers cannot share;
  - other: update the browser.
  - Each message also says you can still see screens others present, and that you present by joining from a computer.
- **Before the deploy:** 0 LIVE meetings in the database; last LiveKit activity 09:46 IST.
- **Checked live:** `index.html` is new (Last-Modified 04:35 UTC); the room chunk has the new text; MediaPipe `.wasm` is served as `application/wasm`; the sign-in page loads.
- **Tests:**
  - new `room/goodday-14229.mjs`: 5/5 (iPhone Chrome, Android Chrome, iPad messages; desktop gets the working Present button; an iPhone page receives a screen presented from a desktop);
  - the frontend type check is clean.

## 14 Nov 2026, 07:27–07:32 IST — DEPLOYED: optional meeting features + minutes of meeting

Deployed with your approval to `https://www.oneinsure.com/meet` and database `Oneinsure_v`. Covers the two sections below.

**Pre-checks and backups:**
- No live meeting and no recording in progress (`LIVE=0;REC=0`), checked before the database change and again before the API swap.
- Database backup: `Oneinsure_v_preMeetingFeatures_20261114.bak` (copy-only, CHECKSUM, `RESTORE VERIFYONLY` passed, 38.1 MB) in the SQL Server Backup folder.
- Files backup: `deploy\_backup-20261114-072753` (`api`, `frontend-dist`, `git-diff.patch`).

**Database:**
- Dry run first, then V026 and V027 applied: 2 migrations, 8 new tables.
- Every switch is **off**.
- Permissions: `features.manage` → SuperAdmin, Admin; `minutes.approve` → SuperAdmin, Admin, DepartmentHead, TeamLeader.

**API:** `MeetIQApi` stopped, files copied (`appsettings*.json` untouched), started; health `Healthy`.

**Website:** `npm run build`. MediaPipe files (`.wasm` served as `application/wasm`, `.tflite`) and the background pictures are served from our own server.

**Live checks without sign-in:**
- `/room-features` returns all `false`;
- every new endpoint returns 401 without a session;
- guest calls return 403 while the features are off;
- the sign-in page loads in Edge without script errors.

**Live tests with sign-in: pending.** The QA accounts' password file no longer exists, and `qa.bugfix.admin` has no role.

## 14 Nov 2026 — Minutes of meeting without AI (branch `feature/ai-collab-1113`)

The host or organiser writes the minutes of meeting on the meeting page. **No AI**: nothing is generated, summarised or guessed. Local only, awaiting your approval. **Off** until an administrator switches on "Minutes of meeting".

**Added:**
- **Minutes of meeting page** (`/meetings/:id/minutes`), opened from a new card on the meeting page:
  - meeting facts **from the meeting record**: meeting ID, title, category, date, scheduled and actual times, actual duration, host, organiser, participants with "Attended / Did not join", and for customer meetings the customer and Prarambh Main ID;
  - typed by people: discussion summary, customer requirements (customer meetings), decisions, pending activities, follow-up date;
  - action items: description, assigned employee, due date, priority (Low/Medium/High), status (Open/In progress/Done).
- **Workflow:**
  - written once the meeting has started;
  - draft (seen only by the writers and approvers);
  - every save is a new version;
  - **approve** (permission `minutes.approve`: Super Admin, Admin, Department Head, Team Leader) makes the minutes read-only and visible to every participant;
  - **reopen** needs a reason and a new approval.
- **Version history:** every version stays readable.
- **Print / Save as PDF:** the browser prints, so Hindi and every other language prints correctly. Empty sections print "Not specified".
- **Rules:**
  - a save based on an older version is refused (two people cannot overwrite each other);
  - audited (`MINUTES_CREATED`, `MINUTES_SAVED`, `MINUTES_APPROVED`, `MINUTES_REOPENED`);
  - nothing is sent to anyone automatically.
- **Who can write:** the host, the organiser, co-hosts, and users who can see all meetings. Minutes of a customer meeting also need `customer.meetings.view`.

**Database V027 (additive only):**
- tables `mtg.MeetingMinutes`, `mtg.MeetingMinutesActionItems`, `mtg.MeetingMinutesVersions`;
- feature switch `MEETING_MINUTES` (off);
- permission `minutes.approve`;
- rollback script `database/rollback/V027__meeting_minutes.rollback.sql`.
- V027 needs V026.

**Existing code touched:**
- `RoomFeatureEndpoints.cs`: one more switch key, and `meetingMinutes` added to `/room-features`;
- `Program.cs`: one line;
- `MeetingDetailPage.tsx`: one card, shown only when the switch is on;
- `MeetingsPages.tsx`: one route.

**Bug found by the tests and fixed:** dates moved back by one day on every save. The API's global date converter treats every date as an instant in time and converts it to UTC. The minutes API now takes follow-up and due dates as plain `yyyy-MM-dd` text.

**Tests:** `tests/e2e/room/meeting-minutes.mjs`, MM-01 to MM-16: 16 passed. In the tests, the meetings are marked as held directly in the test database rather than by running a video meeting.

## 13 Nov 2026 — Optional meeting features (branch `feature/ai-collab-1113`, NOT deployed)

"Advanced AI & collaboration" request: we built the parts that are **free and feasible now**. Everything is **local only**, awaiting your approval. Every feature is **off** until an administrator switches it on.

**Added:**
- **Meeting features admin page** (Organisation → System, permission `features.manage`): one switch per feature, plus an **emergency switch**. Audited.
- **Reactions:** 👍 👏 ❤️ 🎉 🤔 👎, temporary bubbles, not stored.
- **Yes/No polls:**
  - host creates and closes; one answer per participant (database-enforced);
  - live results for hosts; results for everyone after closing;
  - stored and audited.
- **Private 1:1 messages:**
  - "Private" tab in Chat, with an unread count;
  - recipient checked by the server; live delivery to exactly two people;
  - the host cannot read others' messages; reloaded after a reconnect.
- **Whiteboard:**
  - own canvas code (pen, highlighter, eraser, line, arrow, rectangle, circle, text, sticky note; colours; undo/redo; clear);
  - host controls who may draw; strokes synced live; saved for late joiners;
  - PNG/PDF download.
- **Background blur / four own backgrounds / your own picture:**
  - processed in the browser;
  - MediaPipe files self-hosted (no CDN).
- **Noise-suppression switch:** browser WebRTC suppression and auto-gain off/on; echo cancellation always on.
- **Switch camera button** on devices with 2 or more cameras.

**Database V026 (additive only):**
- tables `app.FeatureSettings`, `mtg.MeetingPolls`, `mtg.MeetingPollVotes`, `mtg.PrivateMessages`, `mtg.MeetingWhiteboards`;
- permission `features.manage`;
- rollback script `database/rollback/V026__meeting_features.rollback.sql` (tested).

**Dependencies (exact versions, `npm audit`: 0 vulnerabilities):**
- `@livekit/track-processors` 0.8.2 (Apache-2.0);
- `jspdf` 4.2.1 (MIT).
- Excalidraw was tried and removed: its dependencies carried 12 known vulnerabilities.

**Existing code touched:**
- room endpoints: 4 helpers made `internal`;
- `MeetingRoom.tsx`: optional controls rendered only when switched on;
- Settings panel: optional slot;
- `web.config`: `.wasm`/`.tflite` MIME types.

**Tests (local):**
- new browser suite `meeting-features.mjs`: 12 passed, 1 not tested (two-camera device), 0 failed;
- regression `room.mjs` 11/11 with features off and 11/11 with features on;
- API 93/93; domain 18/18.

**Bugs found and fixed during testing:**
- the host's private-message receiver read an empty identity before connecting;
- placing a sticky note lost focus at once;
- the whiteboard PDF was 4.3 MB (now about 30 KB, using JPEG).

**Not built (decision needed):**
- AI assistant, transcription, summaries/minutes and live captions: the server benchmark needs approval; no approved AI notice or retention rule;
- gesture recognition: planned after acceptance.

**Docs:** `AI_MEETING_ASSISTANT.md`, `AI_PRIVACY_AND_PROCESSING.md`, `TRANSCRIPTION_AND_MOM.md`, `VIRTUAL_BACKGROUND_AND_AUDIO.md`, `WHITEBOARD_FEATURE.md`, `PRIVATE_CHAT_SECURITY.md`, `GESTURE_RECOGNITION.md`, `RESOURCE_BENCHMARK.md`, `OPEN_SOURCE_LICENCE_REVIEW.md`, `FEATURE_CONFIGURATION.md`, `ROLLBACK_PLAN.md`.

## 14 Nov 2026 (evening) — GoodDay #14208, #14227 and #14223 (reopened)

Deployed with approval on 14 Nov 2026 ~21:02 IST (website only; backup `deploy/_backup-20261114-210143`). Checked in GoodDay (project Meet): these three were reopened, and there were no new bugs. All three are marked Resolved in GoodDay with comments.

- **Before the deploy:** the production LiveKit log had no activity since 18:12 IST, so no meeting was live. The database check was not possible from this session.
- **Checked live:** `index.html` is new (Last-Modified 15:32 UTC); the bundles contain the three changes; no garbled characters; the sign-in page loads without script errors.

- **#14208** "popup to extend meeting is not coming for host":
  - Before, the host got only the orange strip with small Extend buttons.
  - Now, when the scheduled time is up, the host also gets a **popup**: "The scheduled time is up … ends automatically for everyone in m:ss". It has Extend 15 min, Extend 30 min, End now and Keep going.
  - Other participants get no popup.
  - "Keep going" closes it and the strip stays. An extension that runs out brings it back (`EndTimeBanner` in `MeetingRoom.tsx`).
- **#14227** "Only happening for nothing phones and its OS":
  - Nothing OS (like Xiaomi and OnePlus) stops the browser's network soon after it is minimised, unless the browser's battery use is "Unrestricted". A website cannot change that setting.
  - On Android, a person whose connection dropped while the app was in the background now gets, on return, the steps: Settings → Apps → Chrome → Battery → Unrestricted. "Don't show again" is remembered on that phone.
  - The call is registered as an ongoing call (Media Session).
  - Both are in `BackgroundCallKeeper`.
- **#14223** reopened again with no comment after the 17:18 deploy, which was confirmed live (`index.html` dated 11:47 UTC).
  - The phone header's icon-only "+" square is now a labelled **"+ Schedule"** pill. The icon's size is also set as SVG attributes, so it cannot be squeezed (`Header.tsx`).
  - The dashboard button from 17:18 stays.
- **Tests:**
  - new `room/goodday-14208-14227.mjs`: 2/2;
  - `goodday-14222-14223.mjs`: 6/6 (GD14223-01 now checks the labelled pill at 320/360/412 px);
  - `goodday-14227-14217.mjs`: 2/2;
  - `mobile-audit.mjs`: 8/8;
  - the frontend type check is clean.

## 14 Nov 2026 — GoodDay #14223 (reopened: "Still the same")

- The 13:15 fix (full-size + icon in the phone header) is live: no service worker, and `index.html` is served `no-cache`. But on a phone the only "schedule" option was still that unlabelled "+" in the header, next to a second "+" at the bottom.
- Change: on phones (under 640 px) the dashboard's quick actions now include a labelled **"Schedule meeting"** button (just "Schedule" under 360 px), next to Calendar, which also fills the half-empty second row (`DashboardPage.tsx`).
  - Desktop is unchanged: there, Schedule stays only in the header, as asked earlier.
- Tests: `goodday-14222-14223.mjs` 6/6 (new GD14223-02: 320/360/412 px visible, icon 16 px, no clipping, opens Schedule; hidden at 1366 px); `mobile-audit.mjs` 8/8.
- Deployed 14 Nov 2026 ~17:18 IST (website only; backup `deploy/_backup-20261114-170022`). I waited until test meeting OIC-261114-5HC7 had ended. Marked Resolved in GoodDay with a comment.

## 14 Nov 2026 — GoodDay #14227 and #14217 (reopened, retitled)

Deployed 14 Nov 2026 ~16:37 IST (website only; backup `deploy/_backup-20261114-163448`). Both marked Resolved in GoodDay with comments.

- **#14227** "If customer is minimizing the app and running the meet in background he is not showing in the meeting".
  - Evidence: meeting OIC-261114-FJX2, customer on Android 10 / Chrome Mobile. Each time the app was minimised, the phone closed the connection after 10–25 s. The server timed it out about 20 s later (CONNECTION_TIMEOUT, four times). On return the app rejoined by itself within about 3 s.
  - A website cannot keep running in the background on a phone the way an installed app can.
  - Changed:
    - **"<name> is away"** notice for everyone in the call when someone drops without leaving (connection timeout or signal lost; not "left", "removed" or "meeting ended"). It clears when they are back, or after 3 minutes (`AwayNotice`).
    - The screen is kept on during a call (Screen Wake Lock, `KeepScreenOn`), so the phone does not lock by itself and pause the call.
- **#14217** (reopened, retitled "Remove the after radio button and occurrence input field from the repeat button"): the "After [n] occurrences" choice and its box are removed. A series now ends on a date ("Ends on", default 90 days); the server still stops at 52 meetings.
- Tests: `room/goodday-14227-14217.mjs` (new, 2/2). The older #14217 checks in `goodday-14222-14223.mjs` (GD14217-01) and `recording/goodday-fixes-4.mjs` (G4-02) now expect no After/Occurrences.

## 14 Nov 2026 — Blocked guest message (IL-05) and remaining test runs

- A person removed with "Do not allow them to rejoin" now sees "You can no longer join this meeting. The host removed you from this meeting and turned off rejoining." This replaces "This link needs to be refreshed. Please try joining again." (`GuestRoom.tsx`). The page asks the existing `GET /join/{token}` for the reason ("Removed by the host"), and the token is kept, so trying again gets the same answer. No API change.
- Tests: `room/instant-link.mjs` 8/8 (IL-05 now expects the new text). On the second local test setup (`_Rec`, 7192/5176): `recording/goodday-fixes-4.mjs` 4/4 and `room/end-and-late-share.mjs` 10/10.
- Deployed 14 Nov 2026 ~15:30 IST (website only; backup `deploy/_backup-20261114-152804`).

## 14 Nov 2026 — GoodDay #14224, #14225 and #14226

Deployed 14 Nov 2026 ~13:58 IST (website only; backup `deploy/_backup-20261114-135646`). All three marked Resolved in GoodDay with comments.

- **#14224** "If meeting time is over and I extend it, customer is automatically removed from the meet".
  - Evidence (meeting OIC-261114-3LAL; audit, attendance and LiveKit log):
    - the guest (iPhone, Mobile Safari, iOS 18.7) lost its signalling connection at 12:41:24 IST, from the phone's side;
    - the host extended 18 s later, at 12:41:42, so the extension did not cause the drop;
    - every rejoin from 12:42:38 to 12:47 was then knocked out by an older tab of the same guest resuming in the background ("unable to resume due to missing published tracks", "could not restart participant").
  - Fix: one live connection per person per browser (`frontend/src/pages/room/oneConnection.ts`, `OneConnectionGuard` in `MeetingRoom.tsx`).
    - The newest tab claims the identity (in localStorage, announced over a BroadcastChannel).
    - An older tab stops retrying at once and shows "You joined from another window". LiveKit's retry policy also checks the claim before every retry.
  - Not changed: an iPhone that locks or leaves Safari can still drop its connection; the customer can rejoin with their link.
- **#14225** "If I try to remove customer from the meet invalid message is shown". The confirmation said "They are disconnected now" before anything had happened. It now reads "<name> will be removed from the call straight away. If a customer or guest opens their link again, they wait in the waiting room until a host lets them in." Removing itself already worked (audit 12:36:02 IST).
- **#14226** "Remove this message from the host": the "To hand over hosting…" note in the host's Participants panel is removed. "Make host" next to each colleague is unchanged.
- Tests: `tests/e2e/room/goodday-14224-14226.mjs` (new; the two-tab case fails with the guard switched off and passes with it on). `recording/goodday-fixes-4.mjs` G4-03 now expects no note.

## 14 Nov 2026 — GoodDay #14223, #14222 and #14217 (reopened again)

Deployed 14 Nov 2026 ~13:15 IST (website only; backup `deploy/_backup-20261114-131433`). All three marked Resolved in GoodDay with comments.

- **#14223** "In mobile web access the schedule now call option not visible properly": on phones the header's "Schedule meeting" button was an empty blue square.
  - Cause: `cn()` does not merge Tailwind classes, so the button's own `px-4` beat the `px-0` override, leaving 8 px for the + icon.
  - Fix: `px-0!` and a non-shrinking icon (20 px).
- **#14222** "if the customer has not given permission to camera and microphone, clicking the icons should redirect to settings":
  - A web page cannot open the browser's or the phone's settings (browsers do not allow it). The closest safe behaviour is now in place.
  - Tapping a blocked camera / microphone opens an **"Allow your microphone / camera"** dialog (instead of a toast that disappears). It gives numbered steps for the phone and browser (Android Chrome, iPhone Safari / Chrome, desktop), plus the phone-settings fallback.
  - **Try again** asks the browser again; if it is still blocked, it says so.
  - While the dialog is open, the browser's permission is watched: once the user allows it, the dialog closes and the device turns on by itself.
  - New `pages/room/DeviceHelp.tsx`. The other device messages (in use by another app, not found) stay as toasts.
- **#14217** "Remove this", reopened a second time without a comment. The red message was already gone; the only text left under Occurrences was the grey hint "Between 2 and 52". The hint is removed too, so nothing is shown under the field. The limit stays in the sentence under the repeat editor, and values are still corrected to 2–52.
- **Tests:** new `room/goodday-14222-14223.mjs` 5/5 (header icon 20×20 and opens Schedule; nothing under Occurrences and 2 occurrences schedule; blocked mic → dialog with Android steps and no toast; Try again → "still blocked"; camera dialog; allowing the mic → dialog closes and mic on by itself). `recording/goodday-fixes-4.mjs` G4-02 / G4-04 updated to the new behaviour (not rerun: that suite needs the separate `_Rec` test stack).

## 14 Nov 2026 — GoodDay #14221: extra space on phones; room toolbar with the optional features

**Deployed 14 Nov 2026 ~10:00 IST** with approval ("go ahead"). Website only. No live meeting at the time. Backup `deploy\_backup-20261114-095828`. Checked live: the new CSS is served (main and room), API Healthy, the sign-in page at iPhone size has no band (top 0 px), no script errors, no garbled characters. GoodDay #14221 is Resolved, with a comment.

- **#14221** "While login through phone some extra space is coming" (iPhone Safari):
  - Cause: the page added the iPhone safe-area insets (notch / home indicator) in an ordinary browser tab too. Newer iOS Safari reports those insets even though its own address bar and toolbar already cover that space, so an empty band appeared above the header and below the tab bar.
  - Fix: the top and bottom insets now apply only in the installed app (display-mode standalone/fullscreen), through the CSS variables `--sat` / `--sab`. Left/right insets (landscape notch) are unchanged.
  - In the meeting room, the top inset was counted twice (container padding plus header margin). It is now counted once.
- **Room toolbar with the optional features on** (found while testing): the extra Tools button pushed Leave / End off screen on 360 px phones and in phone landscape.
  - Phones in landscape (touch screens up to 500 px tall) use the compact toolbar (essentials plus More).
  - With 7 controls, phones under 390 px tighten the gaps (44 px targets; 40 px under 360 px).
- **Tests:** `goodday-14221` 5/5; `mobile-audit` 8/8 with the features off and on (new 320 px case; the More sheet is now also tested in landscape); `room.mjs` regression. No API or database change.

## 13 Nov 2026 — GoodDay #14217 (reopened) and #14220

**Deployed 13 Nov 2026 18:40 IST** with approval ("yes deploy and mark"). Website only. Backup `deploy\_backup-20261113-184030`. Checked live: both changes are served, 0 garbled characters, API Healthy. Both tasks are Resolved in GoodDay, each with a comment.

- **#14217**, reopened as "not removed":
  - The red "Choose between 2 and 52 occurrences" message is gone completely.
  - The typed number is corrected to 2–52 when you leave the field, with the grey hint "Between 2 and 52".
  - Fixed two updates in a row overwriting each other in the repeat editor (the After / On date choice).
- **#14220**, customer cannot turn on the mic (live call OIC-261113-HTDE):
  - The customer's Chrome (Android 10) refused the site's mic and camera; the server had granted them.
  - The room now shows one clear message per cause (blocked, with steps to allow; in use by another app; not found) instead of three identical "could not be started" toasts.
- **Tests:** `goodday-fixes-4` **4/4** (G4-04 joins with the mic blocked: exactly one message), `doc3-instant-schedule` 10/10, `end-and-late-share` 10/10.

## 13 Nov 2026 — GoodDay #14217, #14218, #14219 and a text-encoding repair

**Deployed 13 Nov 2026 17:56 IST** with approval ("deploy and mark as resolved in goodday"). No live meeting or recording at the time. API and website only; no database change. Backup `deploy\_backup-20261113-175604`; about 9 s of downtime; Healthy. All three tasks are Resolved in GoodDay, each with a comment.

- **#14218** (Schedule, Customer PLVC):
  - The No recording / Optional / Required choice is replaced by "Recording starts automatically…" for mandatory policies.
  - The meeting is stored as REQUIRED. Other categories are unchanged.
- **#14217** ("Remove this"): the occurrences error no longer stays under a valid value.
- **#14219** (make someone else host):
  - A labelled "Make host" button next to colleagues, instead of an unlabelled crown icon.
  - A hint in the Participants panel.
  - Customers and guests still cannot be host (server and database rule).
- **Encoding repair:**
  - A PowerShell edit had garbled UTF-8 characters on the live Schedule page (e.g. "Administration â†’ Recording policies"), in MeetingLinkEndpoints.cs (comments, and the "…" added when a title is shortened) and in three test files.
  - A garbled comment already in RecordingPolicyEndpoints.cs was repaired too.
  - Checked live: 0 garbled sequences in the served code.
- **Tests:** `goodday-fixes-4` **3/3** (including a real host hand-over between two people), `doc3-instant-schedule` 10/10, `goodday-fixes-3` 5/5, API 93/93.

## 13 Nov 2026 — API Documentation page: complete guide, admin-only with a grantable role (V025)

**Deployed 13 Nov 2026 17:18 IST** with approval ("yes deploy"). No live meeting or recording at the time.
- **Database:** backup `Oneinsure_v_preV025_20261113_1718.bak` (copy-only, with checksum, verified). Then **V025** in one transaction, with its `SchemaMigrations` row.
- **Files:** backup `deploy\_backup-20261113-171841`.
- **API:** 8 s of downtime; Healthy.
- **Website:** rebuilt.
- **Checked on the live site:** the guide and the new menu permission are served, and the OpenAPI document answers 401 when not signed in.

- **Page** (`ApiGuide.tsx`, `ApiDocsPage.tsx`): a self-explanatory guide with an "On this page" menu. Sections:
  - Quick start (6 steps)
  - Connection details (base URL, auth header, OpenAPI URL, format, time zone)
  - **API keys**: Integration ID, key format, how to get, send, rotate and revoke a key, isolation, audit, how to test with `/me`, how to store it safely
  - Scopes
  - **13 endpoints**, each opening to show the full URL, scope, success code, parameters / body fields with rules, an example `curl` request, an example response and its errors
  - Categories & PLVC rules, including identified / unidentified
  - Meeting and recording statuses
  - Errors (15 codes)
  - Rate limits & idempotency
  - Webhooks: events with their exact `data` fields, headers, payload, and signature checks in Node.js, C# and Python
  - Postman / OpenAPI import
  - Go-live checklist

  Every detail was checked against the API code. Keys themselves are never shown on the page (only their hash is stored).
- **Access (V025):**
  - New permission `api.docs.view`, granted to Admin and Super Admin.
  - New role **API Documentation Viewer** (`api.docs.view` + `dashboard.view`). An administrator gives the page to anyone by adding this role in Users & roles.
  - The Integrations & API keys tab stays with `integrations.manage`.
  - The OpenAPI document `/api/ext/openapi/ext-v1.json` is no longer public: 401 when not signed in, 403 without the permission.
- **Tests:**
  - API **93/93** (the OpenAPI test now checks 401 / 403 / 200).
  - New `tests/e2e/recording/api-docs-page.mjs` **5/5**: admin sees the full guide, Swagger and the download; an employee is refused; an employee given the role sees everything except API keys; no sideways scroll on a phone (fixed 757 → 390 px).

## 13 Nov 2026 — "Skip details" / unidentified PLVC (V024), approved wording on every recording policy, PLVC recording fix

**Deployed 13 Nov 2026 16:20 IST** with approval ("approved all the pending things related to recording … go live"). No live meeting or recording at the time.
- **Database:** backup `Oneinsure_v_preV024_20261113_1618.bak` (copy-only, with checksum, verified; SQL Server default backup folder). Then **V024** in one transaction, with its `dbo.SchemaMigrations` row.
- **Files:** backup `deploy\_backup-20261113-161956` (api, frontend-dist, git-diff.patch, `policies-before.json`).
- **API:** published self-contained; 7 s of downtime; Healthy.
- **Website:** rebuilt; the new code is confirmed live.

- **Fix: live PLVC recording (14:37 → about 15:25 IST).**
  - The 14:37 deploy marked the CUSTOMER_PLVC policy `APPROVED`.
  - The recording gate refuses an Approved policy that has no retention period, and PLVC's retention period is intentionally empty (no automatic deletion). A new PLVC meeting in that window would not have recorded; none was started.
  - The status was set back to `PENDING_CONFIRMATION`, with an audit row. The approved wording and version stay.
  - Hosts no longer see the "not confirmed" note, because the wording carries an approval reference (`RecordingPolicies.NoticeConfirmed`). The gate is unchanged.
  - The tests now require that mandatory PLVC recording really starts.
- **Same approved wording on the other four policies** (owner's decision): Customer meeting, Customer audio call, Internal, Training.
  - Each has its own version (e.g. `CUSTMEET-NOTICE-1.0`) and the owner's reference.
  - Approval status, consent mode and on/off settings are unchanged. Audited.
- **"Skip details & start meeting"** (instant Customer – PLVC):
  - creates an **Unidentified PLVC** meeting with no Prarambh ID (none is ever invented), no customer, no participants and no e-mails;
  - the host shares the meeting link;
  - it is recorded as normal, with no ID prefix in the file name.
- **V024 (database):**
  - computed `PlvcIdentification` column;
  - a missing customer is now allowed for **instant** PLVC meetings only;
  - new external API scope `meeting.plvc.unidentified`.
  - 67 older PLVC meetings, created before the Prarambh ID existed, now correctly show as Unidentified.
- **Add Prarambh Main ID later** (meeting page; host, co-host, organiser or admin):
  - also works after the meeting has ended, and only while the meeting has no ID;
  - the ID is added to the recordings' metadata, and files are never renamed;
  - audited as `MEETING_PRARAMBH_ADDED`.
- **Reports and recording library:**
  - "Customer PLVC — identified / unidentified" filters;
  - an "Unidentified" label;
  - a "PLVC identification" column in the CSV.
- **External API:**
  - `plvcIdentification: "UNIDENTIFIED"` must be sent explicitly, and the integration must hold the new scope;
  - every response and the `meeting.created` webhook return `plvcIdentification`.
  - Documented in `API_INTEGRATION_GUIDE.md`. Rules are in `documentation/PLVC_BUSINESS_RULES.md`.
- **Tests:**
  - API **93/93**, including the new `Skipped_PLVC_details_…` test.
  - `doc3-instant-schedule` **10/10**, including SK-01 (skip → unidentified, recorded, file name without ID) and SK-02 (ID added after the end → identified, file unchanged, audited).
  - `end-and-late-share` **10/10**; RN-02 now also requires the PLVC recording to start.
  - `goodday-fixes-3` **5/5**, `consent-request` **15/15**. CR-02 now checks the configured wording instead of the placeholder.

## 13 Nov 2026 — Oneinsure_connect_bugs.docx: recording notice redesign, "Meeting Ended" for everyone, late-joiner screen share, instant-meeting e-mails, compact Schedule page

**Deployed 13 Nov 2026 14:37 IST** with approval ("complete it and deploy on live"); no live meeting or recording. Backup `deploy\_backup-20261113-143610` (api, frontend-dist, git-diff.patch, `policy-CUSTOMER_PLVC-before.json`). API published self-contained (production appsettings untouched), Healthy (`/meet/api/v1/health` 200). Live policy row CUSTOMER_PLVC updated in one transaction plus an audit row (`RECORDING_POLICY_UPDATED`, old and new values). Website rebuilt. Checked on the live site: the new notice, Meeting Ended, the in-band end message, the screen-share recovery, invitation e-mail status, the Schedule layout and the Reports column are all in the served code.

- **Recording notice** (`RecordingControls.tsx`, `RecordingConsentUi.tsx`, `room.css`). A compact floating card over the video:
  - Contents: the title "Meeting Recording Notice", the policy wording, "For assistance: support@oneinsure.com", and ONE "OK, got it". There is also a 44 px ×.
  - Layout: aware of the iPhone safe area, height capped at 46% of the screen, with a fade-and-scale entrance.
  - Participants no longer see: the placeholder warning, the notice version, the policy name, or "Wording pending policy confirmation" (also removed from the Accept/Decline popup).
  - Hosts see a small "not confirmed" note only while the wording is unconfirmed.
  - The acknowledgement, the consent flow, recording start/stop and the R2 recorder are unchanged.
  - **Live data** (owner-approved, "Your wording is approved"; reference "Approved by product owner (Santosh Yadav), 13 Nov 2026"; version `PLVC-NOTICE-1.0`): the CUSTOMER_PLVC policy got the wording from the document and is now APPROVED. The other four policies are unchanged.
- **Host ends the meeting → "Meeting Ended" for everyone** (`MeetingAutoEnd.cs`, `RoomEndpoints.End`, `MeetingRoom.tsx`, `RoomExitScreen.tsx`).
  - Cause, from the live LiveKit log of 13 Nov 12:26: the server deleted the room and sent "leave", the iPhone missed it, and it kept trying to reconnect ("could not restart participant").
  - Fix, part 1: the server first sends an in-band `oic.meeting` "meeting-ended" message, then closes the room. Clients leave at once and release camera, microphone and screen.
  - Fix, part 2: while reconnecting, or when the connection drops, the client asks the API whether the meeting has ended, and shows "Meeting Ended" instead of "Reconnecting…" or "Connection lost".
  - Ending again returns 204 (idempotent). The ended screen shows the title, meeting ID, end time and "Back to Home".
  - A participant's own network loss and a host's temporary loss still use the normal reconnect.
- **Late joiners and screen share:**
  - Not reproducible on desktop or phone-sized Chromium: late joiners saw the share every time (multi-participant test).
  - The live log shows the failing late joiner was an **iPhone (Safari)**, which the server had subscribed to the share.
  - Added (`useScreenShareRecovery`): when a remote screen share shows no picture, the room re-plays the video and, after about 6 s, re-subscribes (at most 3 times). It never restarts the presenter's share and never creates a second track.
  - A real iPhone check is still pending.
- **Instant meeting e-mails** (`MeetingLinkEndpoints`, `MeetingLinkShare.tsx`, `QuickMeetingDialogs.tsx`).
  - Each participant is e-mailed their **own** personal link (`MEETING_INSTANT_INVITED`), queued in the existing outbox in the same transaction as the meeting.
  - Invite people shows the delivery status and offers "Send again", which issues a new personal link for that person only and is audited as `MEETING_INVITATION_RESENT`.
  - A double click can no longer create two meetings (synchronous guard).
  - The external API is unchanged.
- **Schedule Meeting** (`MeetingForm.tsx`, `schedule.css`):
  - a compact two-column layout from 1024 px;
  - Title and Category side by side, a shorter details box, tighter cards and 40 px inputs (44 px on touch screens);
  - all fields and all logic unchanged.
- **Reports:**
  - new Prarambh Main ID column, and search by the ID;
  - fixed a summary error (`TotalHours` read as decimal instead of double) that made the Reports API fail.
- **Not built, awaiting approval:** "Skip details & start meeting" and the identified/unidentified PLVC states. They need database migration V024; see `documentation/PLVC_BUSINESS_RULES.md`.
- **Tests:**
  - API **92/92** (the room test now expects the idempotent end and the in-band message).
  - New `tests/e2e/room/end-and-late-share.mjs` **10/10**: host plus 3 participants, one on a phone, one offline during the end.
  - New `tests/e2e/recording/doc3-instant-schedule.mjs` **8/8**.
  - Regressions: `goodday-fixes-3` **5/5**, `consent-request` **15/15**.

## 13 Nov 2026 — GoodDay reopened: MaXW9q (More sheet cannot be closed on iPhone) and CVPJMP (no end prompt "after 15 minutes")

**Deployed 13 Nov 2026 10:28 IST** with approval ("deploy on live"). No live meeting or recording. Backup `deploy_backup-20261113-102838` (api, frontend-dist, git-diff.patch). API published self-contained (production appsettings untouched), about 7 s down, Healthy; website rebuilt. Checked on the live site: health 200, OpenAPI 200, the room code served contains the new More-sheet close button and backdrop, and the deployed API contains the early-start change.

- **MaXW9q, reopened ("when user click on more button no option to close popup"):**
  - Cause: the toolbar has `backdrop-filter`, which makes it the containing block of the sheet's full-screen (`position: fixed`) backdrop. The backdrop therefore covered only the toolbar, so tapping the video did nothing, and the sheet had no Close button.
  - Fix (`MeetingRoom.tsx`): the sheet is rendered through a portal into the room element, so its backdrop covers the whole screen, and it has a 44 px Close (×) button.
- **CVPJMP, reopened ("did not receive any popup after 15 minutes"):**
  - Cause: meeting OIC-261113-KK6W was booked 09:15–09:30 and started at 09:02. The countdown, the Extend/End prompt and the automatic end follow the booked end, so nothing could appear before 09:25.
  - Fix (`RoomEndpoints.Join`): when a host starts a scheduled meeting **early**, its slot moves to the actual start, keeping the booked length (start = now, end = now + duration). The change is audited in `MEETING_STARTED` with the booked times. A late start keeps its booked end, and the host is prompted to extend.
- **Tests:**
  - API **92/92**, including the new `A_scheduled_meeting_started_early_runs_its_booked_duration_from_the_actual_start`.
  - `goodday-fixes-3` **5/5** (GD3-04 More sheet on a touch phone; GD3-05 early start).
  - Regression: `goodday-fixes` **8/8**.
- **qe9ILR** was moved to Review by the reporter with no comment, so there was nothing to fix.

## 13 Nov 2026 — GoodDay #14216: PLVC recording notice "not closing"

**Deployed 13 Nov 2026 09:57 IST** with approval ("go live"): website rebuild only (API untouched, no downtime); no live meeting or recording at the time; backup `deploy_backup-20261113-095721`. Checked on the live site: the room code served contains the new close button and "OK, got it"; health 200.

- **Bug:** in a Customer PLVC call (mandatory recording, notification only), the recording notice banner seemed impossible to close for both host and customer. Its only close control was a 16 px ×, so most taps missed, and on a phone the banner covered about half the video.
- **Fix:** `frontend/src/pages/room/RecordingControls.tsx`.
  - The × is now a 44×44 px target, and there is an "OK, got it" button (44 px tall on a phone).
  - The banner's height is capped at 40% of the screen on a phone (50% on desktop) and scrolls inside.
  - The internal "Wording not confirmed" note is shown to the host only, never to a customer or guest.
  - The notice text itself is still shown to everyone, and the acknowledgement is still recorded automatically. Consent behaviour is unchanged.
- **Tests:** `tests/e2e/recording/goodday-fixes-3.mjs` **3/3** (host desktop, customer phone with touch, acknowledgement rows). Regression `consent-request` **15/15**.
- **Not part of this fix:** the notice still shows the placeholder wording, because the PLVC recording policy has no approved text yet. Compliance must enter it in Administration → Recording policies; it is not invented here.
- **Ignored as instructed:** GoodDay "Email is received to the customer in spam".

## 13 Nov 2026 — Master enhancement batch: PLVC participants + Prarambh Main ID, screen share everywhere, date-wise recordings, no auto-deletion, no idle logout, external API platform

**Deployed 13 Nov 2026 00:01 IST** with approval ("deploy all on live"). No live meeting or recording at the time.

- **Database:** backup `Oneinsure_v_preV022_20261113.bak` (copy-only, with checksum, 35.1 MB; SQL Server default backup folder). Then **V022** and **V023**, each in one transaction with its `dbo.SchemaMigrations` row.
- **API:** published self-contained; about 8 s of downtime; Healthy.
- **Production settings:** `deploy\api\appsettings.json` changed `Security:SessionIdleMinutes` from 30 to **0**. This is the only settings change.
- **Website:** rebuilt.
- **File backup:** `deploy\_backup-20261113-000118` (api, frontend-dist, git-diff.patch).

Business decisions (12 Nov 2026):
- Prarambh Main ID is digits only.
- PLVC creates the customer record from the first participant.
- Screen sharing is for everyone.
- Automatic deletion is off (Compliance agreed).
- External access uses API keys.

### Module 1 — PLVC participants and Prarambh Main ID
- In the instant dialog and the schedule form, **Customer – PLVC** shows a **Prarambh Main ID** box and **Participants** rows (name, e-mail, + add, × remove) instead of "Add customer". Shared component: PlvcFields.tsx.
- Client checks mirror the server: Prarambh required and digits only (non-digits are stripped as you type); at least one participant; valid e-mails; no duplicates.
- **Server** (Meetings/Plvc.cs, used by instant, one-off and recurring creation):
  - Prarambh Main ID is required for PLVC, **digits only (1–30)**, stored exactly as given (leading zeros kept), and refused for other categories.
  - The first participant becomes the meeting's customer: an active customer with that e-mail is reused, otherwise one is created (CustomerRef PLVC-<id>, ReferenceNumber = the ID). Dashboards, reports and recording access keep working.
  - The other participants are guests. Instant meetings return a personal join link for each; scheduled meetings e-mail them.
  - A PLVC meeting cannot change category.
- **Where the Prarambh ID appears:**
  - meeting detail;
  - Recording Library (list, detail, search);
  - reports (list, CSV column, search);
  - MP4 metadata (title and comment);
  - the recording file name;
  - the external API and webhooks (ids only).
- The "Invite people" dialog in the room lists every PLVC participant's personal link.
- **V022:** mtg.Meetings.PrarambhMainId and rec.MeetingRecordings.PrarambhMainId (VARCHAR(30)), CHECK digits-only and "PLVC only", filtered indexes. The API enforces "required" for new meetings only, so existing PLVC meetings are not affected.

### Module 2 — Screen sharing in every meeting
- The room connection grants screen share to everyone who may speak (canScreenShare = CanPublish). That includes customers and guests, every category, and audio-only meetings.
- Audio-only still removes only the camera, and presenting never turns the camera on. Browsers that cannot capture a screen keep the existing "not supported" message.

### Module 3 — Recording storage
- New recordings are saved under YYYYMMDD/, by the **IST start date**:
  - PLVC: <PrarambhMainId>-<MeetingCode>-REC<id>.mp4;
  - others: <MeetingCode>-REC<id>.mp4.
- Collisions get a -n suffix. No customer names or e-mails are ever used in names.
- Code: Recording/RecordingStorageKeys.cs.
- Old recordings keep their keys and still play and download. See documentation/RECORDING_STORAGE_STRUCTURE.md.

### Module 4 — No automatic recording deletion
- RetentionWorker: an expiry with action DELETE now only flags the recording for review. It never purges and never queues a deletion. ARCHIVE and REVIEW are unchanged.
- The policy API and screen no longer accept DELETE.
- Manual deletion is unchanged: permission, confirmation and reason, legal-hold block, dual approval, audit, and "PURGED only after the file is really gone".
- No production policy had a retention period set, so nothing was ever deleted automatically before this change either.

### Module 5 — Instant meeting blank screen
- **Cause:** there was no React error boundary anywhere. A failed download of the room's page chunk (typical right after a redeploy, or on a dropped mobile request), or any render error, unmounted the whole app, leaving a white page until a refresh.
- **Fix** (components/ErrorBoundary.tsx, main.tsx, App.tsx):
  - an app-wide boundary plus a room boundary with a "Reload" card;
  - a chunk error or vite:preloadError triggers **one** automatic reload (at most once per minute, so no loop);
  - pressing Enter twice no longer starts a second meeting.

### Module 6 — Sessions
- **Cause** of the unexpected logouts: a 30-minute idle timeout in both the browser and the server.
- **Now:**
  - Security:SessionIdleMinutes = 0 means no idle timeout;
  - a session's absolute expiry is the **next 23:30 IST** daily logout;
  - the 23:25 warning, server-side revocation and the per-admin test mode are unchanged.
- See documentation/SESSION_MANAGEMENT.md.

### Module 7 — Toolbar
Deployed earlier (22:59 IST): 80 → 68 px, and the support line moved into the room.

### Modules 8–13 — External API platform (backend/.../Integrations/)
- **/api/ext/v1:**
  - API-key authentication (SHA-256-hashed keys, shown once);
  - scopes;
  - per-integration rate limit;
  - request log;
  - Idempotency-Key;
  - **isolation** (every query filters on the caller's IntegrationId; anything else is 404).
- **Endpoints:**
  - /me;
  - create (instant or scheduled, PLVC validation, host by e-mail, employee code or default);
  - list and get;
  - cancel;
  - **completion report** (meeting and recording status independent; attendance; IST times);
  - recordings;
  - **signed short-lived downloads** (Range support, audited, 410 when deleted);
  - webhook management and test.
- **Webhooks** (WebhookWorker):
  - each state change is enqueued once;
  - deliveries are signed (HMAC-SHA256) and retried 30 s → 6 h, 8 attempts;
  - SSRF guard (public HTTPS only, no redirects);
  - payloads carry no personal data.
- **OpenAPI 3.1:** generated from the endpoints (Microsoft.AspNetCore.OpenApi 10.0.14) at /api/ext/openapi/ext-v1.json. Only the external API is published.
- **Portal:** Organisation → System → **API Documentation** (integrations.manage: Admin and SuperAdmin):
  - the guide;
  - the endpoint table, built from the live OpenAPI;
  - Swagger UI (swagger-ui-dist 5.17.14, MIT, bundled locally);
  - an OpenAPI download;
  - integration management: keys, scopes, rate limit, webhook, delivery and request logs.
- **V023:** app.ApiIntegrations, ApiIntegrationScopes, ApiKeys, ApiRequestLog, ApiIdempotency, WebhookSubscriptions, WebhookDeliveries; IntegrationId/ExternalReference on meetings; IntegrationId on recordings; audit actor type INTEGRATION; permission integrations.manage.
- **Docs:** documentation/API_INTEGRATION_GUIDE.md, API_ENDPOINT_REFERENCE.md, OPENAPI_SPECIFICATION/.
- The development Vite proxy key is now ^/api/ (a plain /api prefix also captured the app's /api-docs page).

### Tests
- **API:** 91/91 (13 Nov). The 4 older failures were outdated tests, not API defects, and were updated: signed media links are absolute (`WebBaseUrl`) so the tests now request their path; storage keys are now date-wise (`YYYYMMDD/…-REC<id>.mp4`); a failed recording notifies the owner **and** every Admin/SuperAdmin; with automatic deletion off only the manual, dual-approved deletion purges. The manual-deletion/dual-approval flow now runs to the end and passes.
- **New API tests:** IntegrationTests.cs (7).
- **Browser:** tests/e2e/recording/enhancements-1112.mjs 6/6, including a real PLVC recording saved as 20261112/706082601-OIC-261112-QWD3-REC10030.mp4. Regression: goodday-fixes 8/8, goodday-fixes-2 4/4, repeat-alignment 6/6, consent-request 15/15.
- **OpenAPI:** validated with @apidevtools/swagger-parser 10.1.1.

### Rollback
1. **Website:** copy _backup-20261113-000118\frontend-dist\* over frontend\dist.
2. **API:**
   - Stop-Service MeetIQApi;
   - copy _backup-20261113-000118\api\* over deploy\api. This includes the old appsettings.json, which brings back the 30-minute idle timeout;
   - Start-Service MeetIQApi.
3. **Database:** V022/V023 are additive, and the old API ignores them, so they can stay. Full reversal: the rollback SQL in the migration headers, or restore Oneinsure_v_preV022_20261113.bak (this loses data written since).

## Unreleased — 12 Nov 2026 — Mobile meeting toolbar, support e-mail, screen-share recording orientation

**Deployed 12 Nov 2026 22:59 IST** with approval. Frontend and recorder layout only; no service restart. Backup: `deploy\_backup-20261112-225829` (frontend-dist, recorder-layout).

- **Toolbar overlap (iOS/Android).**
  - **Cause:** guests join under the sign-in layout (`layouts/AuthLayout.tsx`). Its footer ("Need help? it.support@…", ©) was painted over the room's bottom control bar. The 16:05 deploy fixed this with stacking order (wrapper `z-20`), so it still relied on z-index.
  - **Now:**
    - The footer gets class `oic-auth-footer` and is not rendered at all while a meeting room, pre-join or room status screen is open (`styles/theme.css`, `body:has(.oic-room, .oic-room-canvas)`).
    - The support contact now lives inside the room: the Settings panel on desktop and the More sheet on phones (`SupportLine` in `pages/room/RoomPanels.tsx`).
- **Support e-mail.** `SUPPORT.email` (`frontend/src/config.ts`) changed from `it.support@oneinsure.com` to `support@oneinsure.com`. This one constant feeds the in-room support line, the sign-in/join footer, the join pages and the status pages.
  - Not changed: SMTP `From`/`ReplyTo` (already `support@`) and the backend `Email:SupportEmail` shown in e-mail footers (`appsettings.json`, still `it.support@`; out of scope, change separately if wanted).
- **Thinner toolbar (Module 7).**
  - Desktop/tablet bar height: 80 → 68 px.
  - Short landscape screens: 64 → 56 px.
  - Phone bar vertical padding: 10 → 7 px.
  - Button sizes are unchanged: 48 px (desktop), 46 px (phones).
  - New `max-width: 359px` rule (iPhone SE/mini): tighter margins and gaps, 44 px buttons. The six phone controls (mic, camera, chat, people, more, leave) used to overflow a 320 px screen.
  - Safe-area insets are unchanged (`env(safe-area-inset-bottom)` margin).
- **Recording looked like a phone when a desktop user presented.**
  - **Cause:** `recording/layout/src/main.ts` `decideCanvasSize()` locked a 1:1 call to a portrait canvas if *either* camera was portrait. MediaRecorder cannot resize later, so a desktop's screen share was squeezed into 720×1280.
  - **Now:** a 1:1 call is portrait only when *every* participant's camera is portrait (in practice, both people on phones, which cannot present). It also stays landscape if someone is already presenting when the canvas is locked. Group calls are unchanged (always landscape).
  - This changes the 7 Nov device-adaptive rule ("either camera").
- **Tests:** `tests/e2e/recording/goodday-fixes.mjs` 8/8 (12 Nov 17:18 UTC). Frontend and recorder-layout type checks are clean. See the UAT report, section "Mobile toolbar…".
- **Deploy when approved:**
  1. Build the recorder layout and copy it to `deploy\recorder-layout`.
  2. Run `npm run build` (frontend).
  3. No service restart is needed.
- **Rollback:** restore `frontend\dist` and `deploy\recorder-layout` from the pre-deploy backup.

## Unreleased — 12 Nov 2026 — GoodDay #14213: Repeat section alignment (Schedule meeting)

**Deployed 12 Nov 2026 18:07 IST** with approval. Frontend only (`pages/meetings/MeetingForm.tsx` → `RecurrenceEditor`); no API restart. Backup: `deploy\_backup-20261112-180657\frontend-dist` (rollback: copy it over `frontend\dist`). GoodDay #14213 is marked RESOLVED.
- **Cause:** the Frequency / Repeat every row was bottom-aligned, and "Repeat every" had a "day(s)" hint underneath. That pushed Frequency's label and box lower than its neighbour. The Ends rows had radio labels of different widths ("After" vs "On date"), so "Occurrences" and "End date" started at different positions.
- **Now:**
  - fields align by their tops, and the unit sits beside the box;
  - the radio buttons sit in a fixed-width column under an invisible label-height spacer, centred on their boxes;
  - the Ends rows never wrap on phones.
- **Test:** `tests/e2e/recording/repeat-alignment.mjs` measures the element boxes. 6/6 pass (desktop and 390 px, for Daily / Weekly / Monthly): labels and boxes within 1 px, radios centred on their boxes, the Ends boxes left-aligned, no horizontal scroll.

## Unreleased — 12 Nov 2026 — GoodDay "Meet" batch, part 2 (the remaining open reports)

**Deployed 12 Nov 2026 17:10 IST** with approval, with no live meeting or recording. Auto-end grace is 5 min (the default).
- Backup: `deploy\_backup-20261112-170921` (`api`, `frontend-dist`, `git-diff.patch`).
- About 7 s of API downtime; health is Healthy; the live bundle and the new endpoints are present.
- GoodDay: #14208, #14195, #14206 and #14196 are marked RESOLVED with notes. #14197 has a note and stays open until the employee-code script is approved.

**Rollback:**
1. `Stop-Service MeetIQApi`.
2. Copy `_backup-20261112-170921\api\*` over `deploy\api`, then `Start-Service MeetIQApi`.
3. Copy `_backup-20261112-170921\frontend-dist\*` over `frontend\dist`.

To keep the code but switch automatic ending off, set `Meetings:AutoEndGraceMinutes` to 0 and restart the service.

No schema change. Tests:
- API 80/84 (the 4 failures are the pre-existing ones), including 1 new test and new checks in the instant-PLVC test;
- browser `tests/e2e/recording/goodday-fixes-2.mjs` 4/4;
- regression suites re-run.

### #14208 — the meeting did not end at its scheduled time
- **Countdown banner:** from 5 minutes before the scheduled end, everyone sees "scheduled to end at … (in m:ss)". After the end it reads "Scheduled time is up. The meeting ends automatically in m:ss". Hosts get **Extend 15 min / 30 min** and **End now**.
- **Extend:** `POST /meetings/{id}/room/extend` (host or co-host; 5–`MaxExtendMinutes` minutes; total length capped by `MaxDurationHours`). It moves `ScheduledEndUtc`, writes the audit entry `MEETING_EXTENDED`, and tells everyone in the room (the "end-changed" message updates the banner and header live).
- **Automatic end:** the new `MeetingAutoEndWorker` (every 30 s) ends a LIVE meeting `Meetings:AutoEndGraceMinutes` (default **5**; 0 = off) after its scheduled end, exactly like "End for all":
  - it claims the meeting atomically first, so an extension can't lose a race;
  - then it stops the recording cleanly and closes the room;
  - audit `MEETING_AUTO_ENDED` (SYSTEM).

  "End for all" and the worker share `MeetingAutoEnd`. The join response includes `autoEndUtc`.
- **Exit screen:** now reads "<title> has ended for everyone" (it was "The host ended…").

### #14195 — send the link directly to the customer
- **Endpoint:** `POST /meetings/{id}/link/customer` (host, co-host or organiser of a customer meeting). It issues a fresh personal `/join/{token}` link for the customer; the e-mailed link keeps working. Audit `MEETING_CUSTOMER_LINK_ISSUED`.
- **Where:** the meeting page (customer meetings) and the room's Invite dialog have **Send link to customer**, which shows the link with:
  - **WhatsApp** — `wa.me/91…` with the message ready, from the host's own WhatsApp; no SMS gateway, no paid service;
  - **E-mail** — to the customer's e-mail;
  - **Copy**.
- The instant-meeting response includes the customer's e-mail and mobile.

### #14206 — the customer was asked for consent
- **Cause:** the call ("12:26 testing call") was an internal one-to-one meeting with the customer joining through the guest link. Internal recording policy asks everyone, so the customer was asked when the host pressed Record.
- **Change:** the Instant meeting dialog now says "Calling a customer? Choose Customer PLVC". PLVC records with a notice only.
- **Policy unchanged:** I did not change any recording policy. Making internal meetings notice-only is the policy administrator's decision.

### #14196 — answered (no code change)
- The company mail log (`[Beeinsured_v3_2].dbo.trn_logemail`) shows every Gmail invitation **DELIVERED**, and most were opened or clicked.
- The 11 Nov ones arrived 10–22 minutes late at the provider: queued at 14:45 IST, delivered at 15:06; the report was raised at 14:59.

### #14197 — employee codes (data fix prepared, not applied)
- Our codes were placeholders. The HR master (`MST_Employees`, matched by official e-mail) gives:
  - Santosh: **6433** (the failed login was this code);
  - Hasib: **5509**;
  - Harsh (`harsh@oneinsure.com`, the unlinked account): **109812 Harsh Raj**, Cluster Manager, HO - Mumbai, joined 5 Jan 2026.
- 107249 belongs to charugundla.prasanth, who has no account in Meet. Naved and Mohit (galentic addresses) are not in HR: their IDs stay 0003 and 0002.
- **Applied 12 Nov 2026 ~17:30 IST** with approval, in one transaction:
  - codes updated (TMP-SANTOSH → 6433, 0111 → 5509);
  - department "HO - Mumbai" (002) and designation "Cluster Manager" (002) created;
  - employee 109812 Harsh Raj created and account 7 linked;
  - audit: `EMPLOYEE_UPDATED` ×2, `EMPLOYEE_CREATED`, `USER_EMPLOYEE_LINKED` (privileged).
- **Verified:** the sign-in lookup resolves 6433, 5509, 109812, 0003 and 0002 to the right accounts.
- **Backup:** `Oneinsure_v_preEmpCodes_20261112.bak` (34.1 MB). GoodDay #14197 is RESOLVED.

## Unreleased — 12 Nov 2026 — GoodDay "Meet" bug batch (17 reports from Naved)

**Deployed 12 Nov 2026 16:05 IST** with approval, with no live meeting or recording. Backup: `deploy\_backup-20261112-160430` (frontend `dist`, `recorder-layout`, `git-diff.patch`). The API was not restarted (no downtime); health is Healthy, and the live bundle and the recorder layout contain the changes. GoodDay #14212, #14192, #14209, #14210, #14211, #14207, #14205, #14203 and #14204 are marked RESOLVED with notes. Tested before in the isolated local environment: `tests/e2e/recording/goodday-fixes.mjs` 8/8, `consent-request.mjs` 15/15. No database or API change; frontend and the recorder layout only.

**Rollback:**
1. Copy `deploy\_backup-20261112-160430\frontend-dist\*` over `frontend\dist`.
2. Copy `deploy\_backup-20261112-160430\recorder-layout\*` over `deploy\recorder-layout` (robocopy /MIR).

### Fixed
- **#14212 / #14192 Dashboard buttons:**
  - header "New Meeting" → **Schedule meeting**;
  - the dashboard's duplicate "Schedule" button is removed;
  - the dashboard keeps **Instant meeting**, Join meeting and Calendar (`layouts/Header.tsx`, `pages/DashboardPage.tsx`).
- **#14209 / #14210 KPI cards:** Today's Meetings → `/meetings?tab=today`; Upcoming Meetings → `/meetings?tab=upcoming` (was the calendar). My Meetings now reads and keeps the tab in the URL (`pages/meetings/MeetingsList.tsx`).
- **#14211 Upcoming vs Attending:** "Attending" is renamed **Invited**, and a line under the tabs says what each list holds.
- **#14207 E-mail in Invite people ended the call:**
  - LiveKit's `disconnectOnPageLeave` disconnects on `beforeunload`, which Chrome and Edge also fire when a `mailto:` link opens the mail app;
  - the room now leaves only on `pagehide`, and the E-mail link opens in a separate context (`pages/room/MeetingRoom.tsx`, `pages/meetings/MeetingLinkShare.tsx`).
- **#14205 Customer on iPhone could not use mic, camera and other buttons:**
  - guests join from `/join` and `/m` pages under the sign-in layout, whose "Need help? / © OneInsure" footer was stacked above the full-screen room and covered the control bar;
  - the content layer is now above the footer (`layouts/AuthLayout.tsx`).
- **#14203 Tile expand button did nothing:** the stage now honours LiveKit's pinned track; pressing expand again returns to the grid.
- **#14204 Shared screen small in recordings:**
  - a one-to-one call with a portrait phone camera records a portrait canvas, and a later desktop share was squeezed beside a camera strip;
  - on a portrait canvas the share now takes the full width at the top, with the cameras side by side underneath (`recording/layout/src/main.ts`);
  - deploy by rebuilding the layout and copying `dist` to `deploy\recorder-layout`.

### Already fixed (live), marked RESOLVED in GoodDay
- #14193 instant PLVC (12 Nov 11:45 IST);
- #14190 users without an employee (12 Nov 12:41 IST);
- #14191 recording play/download (11 Nov 15:08 IST; recording #1 has no file).

### Not code defects / need a decision (not changed)
- **#14197 Login with employee ID:**
  - the login code accepts employee codes;
  - production employee codes are placeholders (e.g. Naved = `0003`), and the failed attempts were `6433` and `107249`;
  - the real codes must be entered under Employees.
- **#14196 Invitation to a personal Gmail not received:** all 14 external e-mails were handed to `[Beeinsured_v3_2].dbo.Util_SendEmail2` without error. Delivery beyond that is the company mail server; the mail administrator must confirm it relays to external domains (there is a separate `Util_SendEmailPersonal`).
- **#14208 Meeting not ended at its scheduled time:** by design, overrunning calls continue (toast at the end time). Auto-ending is a product decision.
- **#14206 Customer asked for consent when the host turns on video:** needs clarification. PLVC already records without asking; Customer general asks by policy.
- **#14195 Send the link to the customer's mobile:** SMS needs a paid gateway (not allowed). Customer meetings already e-mail the customer a personal link.

## Unreleased — 12 Nov 2026 — new users without an employee record (no calendar, cannot schedule)

**Deployed 12 Nov 2026 12:41 IST** with approval (after waiting for a live recorded meeting to end; its recording completed normally). Backups: `deploy_backup-20261112-123226` and copy-only `Oneinsure_v_preUserLink_20261112.bak` (34.1 MB). API downtime about 7 s. Tested before in the isolated local environment.

### Fixed — "Your user account is not linked to an employee record"
- **Root cause:** Administration → Users & roles → *Create user* offered "E-mail only" with no way to add the person to the employee master. Meetings, the calendar and availability are per employee, so such accounts could sign in but saw "Unable to load the calendar" and could not schedule. Nothing ever linked them later, even after the employee record was added.
  - Production on 12 Nov: 1 of 10 accounts is unlinked (created 11 Nov 09:49), and **no employee record exists for its e-mail**. Someone has to enter the person's real employee code, department and designation; I did not invent them.
- **Now:**
  - **"Add new employee"** inside *Create user* (Employee mode) and *Link to employee*. It opens the normal employee form (same validation and audit as Employee Management; needs `employees.manage`, which Admin and HR have). The account's e-mail is prefilled when linking, and the new employee is picked straight away. One flow gives an account with an employee.
  - **E-mail only:** a clear warning that such accounts cannot schedule, use the calendar or appear in availability. If an active employee with that official e-mail exists (and has no account), the account is **linked automatically** at creation. The response returns `linkedToEmployee`.
  - **At sign-in:** an unlinked account whose e-mail matches exactly one active employee without an account is linked automatically (privileged audit `USER_EMPLOYEE_LINKED`). Ambiguous cases are left for an administrator.
- **Files:**
  - `Admin/UserAdminEndpoints.cs`, `Auth/AuthService.cs`;
  - `pages/admin/UserDialogs.tsx`, `pages/employees/EmployeeForm.tsx` (`defaults` prop);
  - tests: `Phase2Tests.cs` (new automatic-linking test, link test reordered), `tests/e2e/recording/user-employee-link.mjs` (3 browser scenarios).
- **No database change.**

## Unreleased — 12 Nov 2026 — "Instant meeting" with PLVC / customer general; PLVC recording mandatory without acceptance

**Deployed 12 Nov 2026 11:40–11:45 IST** to `https://www.oneinsure.com/meet` + `Oneinsure_v` with the user's approval. Backups first: `deploy_backup-20261112-114010` (API, frontend `dist`, source diff) and copy-only `Oneinsure_v_preConsentPlvc_20261112.bak` (33.1 MB, checksum) on the SQL server. V020 + V021 applied (V001–V013 are recorded with LF line endings from the laptop; the runner was given an LF copy of those so history stays untouched). API downtime about 8 s; no meeting or recording was active. Tested before deployment in the isolated local environment.

### Changed — "New meeting" is now "Instant meeting", and offers customer types
- **Dashboard:** the button that starts a meeting now (with a shareable link) is labelled **Instant meeting** (the test id is unchanged). The phone tab bar's centre button is "Start an instant meeting". The header's "New Meeting" button still opens the Schedule page and is unchanged.
- **Dialog "Start an instant meeting":** *Type* now has two groups:
  - **Internal:** as before.
  - **Customer:** **Customer — PLVC** and **Customer — General**. Shown to users with `customer.meetings.view`, as on the Schedule page.
- **Customer meetings:**
  - A customer picker appears (with "Add new customer"). The database requires a customer for customer meetings.
  - The customer is added as a `CUSTOMER` participant. Their **personal join link** (`/join/{token}`, expiring with the meeting) is shown at the top of the Invite dialog after starting, for the host to copy.
  - No e-mail is sent, as for every instant meeting.
  - The meeting's policy number defaults to the customer's.
- **Recording section:** when the type's policy is mandatory, the NONE/OPTIONAL/REQUIRED choice is replaced by "**Recording starts automatically** when the meeting starts — mandatory for this meeting type", followed by either "…no acceptance is needed" (notification-only) or "…each participant is asked to accept" (consent required).
- **API:** `POST /meetings/instant` accepts `customerId` and returns `customer { name, joinUrl }`. It used to reject customer categories ("use Schedule meeting"). `GET /meetings/recording-options` now also returns `consentMode`.

### Changed — PLVC calls: recording mandatory, no permission step (migration **V021**)
- **Why a migration:** PLVC and customer-general meetings shared one policy (`CUSTOMER_MEETING`: mandatory, consent required from everyone), so PLVC could not change alone.
- **New policy `CUSTOMER_PLVC` ("Customer PLVC calls"):**
  - copied from `CUSTOMER_MEETING`: notice text and version, retention, access roles, approval status;
  - **Requirement = MANDATORY, ConsentMode = NOTIFICATION_ONLY.**
  - The `CUSTOMER_PLVC` category now maps to it. Customer general still uses `CUSTOMER_MEETING`, unchanged.
- **What happens in a PLVC call:**
  - recording starts automatically once the meeting is live (the existing auto-start, the existing R2 recorder);
  - nobody gets an Accept/Decline popup;
  - everyone sees the recording **notice banner and the REC indicator** (no covert recording), and the acknowledgement is stored as evidence automatically.
- **Not changed:**
  - the notice wording is still the placeholder, shown verbatim and flagged "Wording not confirmed";
  - the approval status is still pending. In Pilot/Production deployment environments the shared gate refuses customer recording under an unconfirmed policy, exactly as before. The current server runs with `Recording:Environment = Test`;
  - the policy stays editable (audited) in Administration → Recording policies. Customer categories may now use either customer policy.
- **Audit:** `RECORDING_POLICY_CREATED` (SYSTEM, from the migration).
- **Rollback:**
  - `UPDATE rec.RecordingPolicyCategories SET PolicyCode = 'CUSTOMER_MEETING' WHERE Category = 'CUSTOMER_PLVC'`;
  - `DELETE rec.RecordingPolicies WHERE PolicyCode = 'CUSTOMER_PLVC'`;
  - restore the 4-code `CK_RecordingPolicies_Code`.

### Files
- `database/migrations/V021__plvc_recording_policy.sql` (new).
- Backend:
  - `Meetings/MeetingLinkEndpoints.cs` (instant meeting with customer);
  - `Recording/RecordingPolicies.cs` (policy codes, stable order);
  - `Recording/RecordingPolicyEndpoints.cs` (mapping validation, `consentMode` in options).
- Frontend:
  - `pages/meetings/QuickMeetingDialogs.tsx`, `pages/meetings/MeetingLinkShare.tsx` (customer link);
  - `pages/DashboardPage.tsx`, `layouts/MobileTabBar.tsx`;
  - `pages/room/EmployeeRoomPage.tsx`, `pages/room/MeetingRoom.tsx`, `pages/room/roomUi.ts`;
  - `pages/admin/RecordingPolicies.tsx`;
  - `api/meetings.ts`.
- Tests:
  - `RecordingTests.cs` (new `An_instant_PLVC_call_with_a_customer_records_automatically_and_nobody_has_to_accept`; policy-list test updated for the 5th policy);
  - `tests/e2e/recording/instant-plvc.mjs` (new, 6 browser scenarios).

## Unreleased — 12 Nov 2026 — recording consent requests: popup for every participant, live host status, premium UI

**Deployed 12 Nov 2026** together with the instant-meeting / PLVC change above (same backups). Built and tested before that in an isolated local environment on the server (LocalDB `OneInsureVideoMeetingDB_Rec`, API on `https://localhost:7192`, Vite on 5176, a separate LiveKit instance on loopback ports 7890–7892). Production (`MeetIQApi`, `/meet`, `Oneinsure_v`, LiveKit 7880–7882) was not touched.

### Fixed — participants did not get the consent popup when the host started recording
- **Traced flow:** host Record → `POST /meetings/{id}/recording/start` → `RecordingService.StartAsync` → consent check → LiveKit data message → `useRoomRecording` (`RecordingControls.tsx`) → notice dialog → `POST …/recording/consent` → start. (There is no SignalR: room events go through LiveKit data messages on topic `oic.recording` plus room metadata.)
- **Delivery itself works.** LiveKit `SendData` returned 200 in production (`deploy/logs/livekit-server-20261111.log`), and the 11 Nov live test L-02 showed an employee's popup. The root causes were in what was sent and when:
  1. **One-off message, nothing stored.** The request existed only as a single data message sent at the moment the host confirmed. Anyone who joined, reconnected or reloaded afterwards, or whose data channel was briefly down, was never asked, and nothing on the server said a request was pending.
  2. **Wrong target set.** It went only to identities whose latest decision was *empty*. People who had **declined** earlier (or withdrawn) were never asked again, yet still blocked the start ("Waiting for: …").
  3. **Popup state from a stale snapshot.** The client opened the notice from an event flag compared against its last fetched state, which could already be out of date.
  4. **Host got an error, not a request.** The start answered `409 CONSENT_MISSING`, so the host saw a refusal rather than a pending request with live answers. Nothing started automatically once everyone had agreed; the host had to press Start again.
- **Fix:** a stored **consent request** (`rec.RecordingRequests` + `rec.RecordingRequestParticipants`, migration **V020**, additive only):
  - Host presses Record → Request recording. If consent is missing from anyone in the room, a request is opened (one per meeting). The host's own acceptance is recorded, and **everyone** in the room is told (data message with no destination filter, plus the request id in room metadata).
  - Each client shows the popup **from the server's state** (`state.request`: open, not the requester, not yet answered), not from the message. Every message on the topic, the room-metadata event, `Reconnected` and the 10 s poll all just re-read the state. A late joiner, a reconnecting participant, a guest or a page reload is therefore always asked.
  - **Required set:** everyone in the room when the request opened, plus anyone who joins while it is pending. Someone who already has a current *Accepted* consent for this notice version counts as accepted; they are not asked twice, and can withdraw at any time as before.
  - **Disconnected never counts as accepted:** a member not in the room who has not accepted is shown as *Disconnected* and blocks the start. The host can remove such a person (`POST …/recording/request/remove`, host only, refused for anyone still in the room, audited `RECORDING_REQUEST_MEMBER_REMOVED`). This is needed because a link guest who rejoins is a new participant. A removed person is asked again if they return.
  - **Decline:** one Decline closes the request (`DECLINED`, audited); the host is told who declined; nothing is recorded.
  - **All accepted:** the existing `StartAsync` → existing R2 recorder (no new engine), then the request is marked `STARTED` with its recording id. The REC indicator still appears only once the recorder confirms capture (unchanged).
  - If the start fails, the request is closed `FAILED` with the reason; a recorder failure after that is reported as before ("Recording could not be started: …").
  - **Cancel:** the host's Cancel request (the existing Stop endpoint), or the meeting ending, closes it `CANCELLED`. Unanswered requests expire after `Recording:ConsentRequestMinutes` (default 10).
  - **Duplicate or retried answers:** an identical repeated answer reuses the existing evidence row; one request decision at a time (in-process lock), so two acceptances arriving together can never start two recorders.
  - **Evidence:** unchanged. `mtg.MeetingConsent` stays append-only; request members only link to it (`ConsentId`). New audit actions: `RECORDING_REQUESTED`, `RECORDING_REQUEST_STARTED`/`DECLINED`/`CANCELLED`/`EXPIRED`/`FAILED`, `RECORDING_REQUEST_MEMBER_REMOVED`.
- **Unchanged (scope):**
  - mandatory/automatic recording and the popup when joining a mandatory meeting;
  - notification-only policies;
  - policies requiring consent only from the starter;
  - category-to-policy mapping;
  - scheduled-meeting behaviour;
  - the policy wording (still the placeholder, shown verbatim and flagged "Wording pending policy confirmation").
- **API compatibility:** the start endpoint now answers `200` with the state (including `request`) when consent is still needed, where it used to answer `409 CONSENT_MISSING`. Only the bundled frontend calls it. New state fields: `request`, `lastRequest`, `canCancelRequest`.

### Added — premium consent popup and host consent panel
- **`RecordingConsentUi.tsx` → `ConsentPopup`.**
  - Dark gradient card with backdrop blur, the OneInsure Connect mark, and a red recording dot with a pulse ring. Title "Recording Request" with the requested wording, the policy's notice text verbatim, and a policy/version line.
  - **Accept & Continue** (primary) / **Decline** (secondary). Both lock while saving; a short confirmation appears only after the server confirms, then the popup closes. On failure, an error shows and both buttons work again.
  - Entrance animation (respects reduced motion), `alertdialog` with focus on Accept.
  - The dimmed backdrop does not take clicks, so the control bar stays usable. Responsive (stacked buttons at phone width).
- **`ConsentRequestPanel`.** Host-only, collapsible, top-left (it must not cover the Participants panel, where hosts admit people).
  - Progress "N of M accepted" and the message "Waiting for all required participants to accept before recording can start."
  - Each person with Accepted (green) / Pending (amber) / Declined (red) / Disconnected (grey); remove (×) on Disconnected; Cancel request.
  - A "Recording requested · N/M" chip in the header for everyone.
  - The Record button becomes "Cancel request" while a request is pending, and the start dialog says "Request recording" when consent is needed.
- The Participants panel badge gained "Disconnected".

### Files
- `database/migrations/V020__recording_consent_requests.sql` (new).
- Backend:
  - `Recording/RecordingRequests.cs` (new);
  - `Recording/RecordingService.cs`, `Recording/RecordingRoomEndpoints.cs`, `Recording/RecordingOptions.cs`.
- Frontend:
  - `pages/room/RecordingConsentUi.tsx` (new);
  - `pages/room/RecordingControls.tsx`, `pages/room/EmployeeRoomPage.tsx`, `pages/room/MeetingRoom.tsx`, `pages/room/RoomPanels.tsx`;
  - `api/recordings.ts`.
- Tests:
  - `backend/tests/.../RecordingTests.cs` (consent test updated, plus 3 new tests);
  - `tests/e2e/recording/consent-request.mjs` (new, 15 browser scenarios).

### Rollback
- Not deployed, so nothing to roll back in production.
- **If deployed later:**
  - back up `deploy\api`, `frontend\dist` and the database first;
  - to undo, restore the previous API build and `dist`;
  - V020 can stay (additive, unused by older builds), or be dropped with `DROP TABLE rec.RecordingRequestParticipants; DROP TABLE rec.RecordingRequests;` plus deleting the V020 row from `dbo.SchemaMigrations`.
- **Source:** `git diff` against `84894f6` holds all changes (nothing is committed yet).

## Unreleased — 11 Nov 2026 (`https://www.oneinsure.com/meet`, `Oneinsure_v`) — recording, Recording Library and session fixes

Deployed with the user's approval. Backups first: `deploy\_backup-20261111-150834` (API, recorder, recorder layout, frontend `dist`, uncommitted diff) and a copy-only full backup `Oneinsure_v_preBugfix_20261111.bak` on the SQL server. No schema migration was needed.

### Fixed — recording consent dead end
- **Root cause (data):** all four `rec.RecordingPolicies` rows are still the V012 seed: `ConsentMode = CONSENT_REQUIRED`, `ConsentFromAll = 1`, `ApprovalStatus = PENDING_CONFIRMATION`, placeholder notice. The server applies exactly that, so it waits for every participant's consent, and the "Wording not confirmed" placeholder is correct. **Not changed:** the approved wording, policy reference and whether click-through acceptance is needed must come from the policy administrator. Once entered as `NOTIFICATION_ONLY` + `EXISTING_BUSINESS_POLICY`/`APPROVED` in Administration → Recording policies (audited), recording starts without click-through, with the notice banner and REC indicator. No code change is needed for that.
- **Root cause (code):** with an *optional* recording policy, participants were only shown the Accept/Decline notice once a recording was already running. A host's start was refused until they consented, so they were never asked and the host was stuck on "Waiting for consent: …". Now, when a host's start is refused for missing consent, the server asks exactly those participants: a LiveKit data message `consent-requested`, sent only to the identities whose consent is missing. Their notice opens, and the host's start dialog follows the answers live (3-second refresh) and turns ready as soon as everyone has agreed. The policy itself is still fully enforced. Files: `RecordingService.cs`, `RecordingControls.tsx`.
- **Hardening:** a `CONSENT_REQUIRED` policy limited to the starter or hosts (`ConsentFromAll = 0`) was not enforced on the server, because the shared gate only knew "from all". `StartAsync` now refuses with `CONSENT_MISSING` whenever the required consent check fails.

### Fixed — recording stop left REC on (and slow start)
- **Root cause:** stop only marked the job `STOPPING`. The recording row stayed `RECORDING` (and so did what the room was shown) until the recorder process **exited**, which happens only after the full MP4 transcode and decode check (about 0.2× the recorded length, plus up to 3 s for the next worker tick). Meetings over about 25 minutes also hit the 300 s stop timeout: the recorder was killed mid-transcode and the API re-ran the whole transcode.
- **Now:**
  - The stop response already reports `STOPPING`; the Stop button is disabled while stopping.
  - When the recorder prints `recording_finished` (capture over), the worker moves the recording to `PROCESSING` at once. REC clears for everyone and the meeting continues; another recording can be started.
  - `COMPLETED` still only after the library copy is verified.
  - The kill timeout after capture ends is proportional to the recording length (`max(StopTimeoutSeconds, 120 + 0.75 × recorded seconds)`).
  - A repeated stop is a harmless no-op returning the actual state (was a 409 error).
  - The worker is woken immediately by recorder events (`attempt_started`, `recording_finished`, process exit) instead of waiting for its 3-second poll.
- **Frontend:**
  - Stop confirmation now reads "Are you sure you want to stop recording?".
  - Indicator states "Starting recording…" → REC → "Stopping recording…" → off, then the toast "Recording stopped successfully…" (or the failure reason).
  - Failed stops refresh the real state.
  - Out-of-order responses can no longer bring back a stale REC (request sequence counter).
- **Start-up:** the recorder layout waited a flat 4 s whenever any participant's camera was off. It now waits only for cameras that are on, with a cap of 1.5 s (`recording/layout/src/main.ts`). Start-up time and stop→capture-end time are written to the audit log (`RECORDING_CAPTURE_STARTED` / `RECORDING_CAPTURE_ENDED`) as evidence.
- **Post-processing errors:** any exception now ends in `FAILED` with the reason. Previously SQL or launch errors left the row `PROCESSING`/`VERIFYING` and it was re-claimed forever.
- Files: `RecorderLauncher.cs`, `RecorderWorker.cs`, `RecordingService.cs`, `RecordingRoomEndpoints.cs`, `RecordingControls.tsx`, `api/recordings.ts`, `recording/layout/src/main.ts`.

### Fixed — Recording Library: host / co-host / starter could not see recordings
- **Root cause:** ownership is the meeting creator, enforced by a trigger, and non-admin visibility was owner-only. A host or co-host who was not the creator (meeting scheduled for them, host transfer, co-host) could not see recordings they made. The meeting page showed "N recording(s) you are not permitted to see".
- **Not the cause:** logout/login (identity and permissions are reloaded from the database on every request, nothing cached in the browser).
- **In live data on 11 Nov**, no owner was missing their own recordings; plain attendees (e.g. recordings 1/10/12) cannot see them, as designed.
- **Now:** with `recordings.view.own`, the employee who started a recording and the meeting's hosts/co-hosts also see and play it (under the policy's owner-play flag). Download and delete stay with the owner and the explicit permissions. Admin view-all is unchanged. List, detail, play and download use the same rule (`RecordingAccess.cs`).
- **Reconciliation:** new read-only `scripts/recording-reconciliation.ps1` (files vs rows, SHA-256, orphans, partial copies, stale spool, stuck rows; never changes anything). Run on 11 Nov: 10 COMPLETED verified, no orphans/partials/stale/stuck; **recording #1 (2 Nov, `OIC-261102-FHR9`) is COMPLETED but its MP4 is not at its storage path** — flagged, not altered.

### Fixed — unexpected mid-day logouts; added the daily 23:30 IST logout
- **Root cause:** every browser tab ran its own 30-minute idle timer, and when it fired it POSTed `/auth/logout`, which revoked the **shared** server session. A forgotten background tab logged the user out of the tab they were working in, and dropped them from a meeting. Also, the server's idle window only slid on API calls, not on typing or reading. And the 12-hour absolute limit cut a 09:00 sign-in off at 21:00 without warning.
- **Now:**
  - The idle clock is shared across tabs (`localStorage`).
  - Real activity slides the server window (`GET /auth/session`, at most every 5 min).
  - An ended session never navigates away from a meeting: media continues, and a banner asks the user to sign in again for host controls; leaving the meeting completes the sign-out.
  - `SessionAbsoluteHours` is 12 → 18; the daily logout is now the effective daily cap.
- **Daily logout** (`Security:DailyLogout`, default `23:30` `Asia/Kolkata`, warning 5 min before):
  - The session handler refuses sessions created before the latest cutoff from the cutoff itself; `DailyLogoutService` marks them revoked (`DAILY_LOGOUT`, audited) every 30 s.
  - The portal shows "Your OneInsure Connect session will end at 11:30 PM for daily security reset." with a countdown, then "Your daily session has ended. Please log in again to continue."
  - LiveKit media and server-side recordings do not use the portal session and are unaffected.
- **Test mode:** `POST /api/v1/admin/ops/daily-logout/test {minutes}` (admin.ops) ends only the caller's own sessions; it is in memory only and never changes the configured time. `GET /admin/ops/daily-logout/status` gives a dry-run count.
- Files: `Security/DailyLogout.cs` (new), `SessionAuthentication.cs`, `Program.cs`, `appsettings.json` (source + deployed), `auth/AuthContext.tsx`, `api/session.ts` (new), `pages/auth/StatusPages.tsx`, `pages/room/MeetingRoom.tsx`.

### Tests and verification
- **`dotnet test`:** Domain 18/18; API 74/78. The 4 failures are pre-existing and identical on the last commit (`84894f6`), verified in a separate worktree. They are stale assertions: admin failure notifications, day-wise storage key, two media-stream tests under TestServer. Playback works live: HTTP 206 in L-07.
- **New tests:**
  - stop state machine;
  - co-host visibility;
  - daily-logout cutoff arithmetic (3);
  - admin test-mode logout end to end;
  - consent request sent only to the missing participant.
- **Local test environment:** `deploy-database.ps1 -DataPath` / `OIC_TEST_DATA_PATH` added because this server's LocalDB 2017 default data folder is broken.
- **Live, on production with disposable audited QA accounts** (`tests/e2e/live/live-verify.mjs`; 12/12 passed; accounts locked afterwards):
  - start: click → REC 13.0 s (server: request → capture confirmed 11.5 s);
  - stop: REC → "Stopping" in 1.0 s and cleared in 2.0 s, meeting continued;
  - capture end → verified MP4: 10.9 s;
  - recorder killed mid-recording → relaunched, parts joined, COMPLETED;
  - peer offline 8 s → REC re-synced;
  - logout → old cookie 401; re-login → both recordings listed, signed URL 206 `video/mp4`;
  - attendee 404, admin 200;
  - daily-logout test mode in and out of a meeting.

## Unreleased — 7 Nov 2026 (test deployment, `https://www.oneinsure.com/meet`) — part 2

### Fixed — mobile layout: Recording Library table overflow and the clipped notifications panel
From a mobile screenshot: the Recording Library's recordings list and "By employee" summary were rendering as fixed-width desktop tables (`min-w-[720px]`) with no mobile fallback — the one list-view page in the app that didn't follow the existing `hidden md:block` table / `md:hidden` card pattern already used by, e.g., the Employees page. On a ~390px phone this pushed the "Recorded"/duration/status columns off-screen with no visible way to reach them. Added the matching mobile card list for both tabs (`frontend/src/pages/recordings/RecordingsPage.tsx` — new `RecordingCard` component, and inline cards for "By employee").
- **Notifications bell dropdown was clipped at the left edge** ("Notifications" rendered as "tifications"): the panel was `absolute right-0` relative to the bell icon's own small wrapper, not the header's true right edge — since `ProfileMenu` sits to the bell's right and is never hidden, the bell's own right edge isn't the header's right edge, so the panel's left side landed off-screen. Fixed by anchoring the dropdown to the header's right-hand button cluster instead of the bell's own wrapper (`frontend/src/layouts/Header.tsx`).
- **Minor**: added `disablePictureInPicture` and `controlsList="noremoteplayback"` to the recording player — suppresses the browser's own floating AirPlay/cast icon some mobile browsers place over a corner of the video, which could be mistaken for a layout glitch next to the recording's baked-in title bar; this recording is permissioned and logged, not meant to cast to a TV.
- Verified live on the test deployment at a 390×844 mobile viewport (Playwright, a disposable QA account): both the recordings list and "By employee" tab now render as clean cards with the full date/time visible, and the notifications panel opens fully on-screen with its heading intact.

### Added — user-initiated recording deletion, with history kept in the backend
On request: a "Delete recording" option for users, with the deletion recorded rather than the file silently vanishing. Investigated first: the project already has a complete, tested dual-approval deletion mechanism (`rec.RecordingDeletions`, V012) used today only for retention-expiry deletions (`Source='RETENTION'`) — its `Source` column's CHECK constraint already allowed `'MANUAL'`, unused until now. Reused it rather than building a second deletion system:
- **New**: `POST /recordings/{id}/delete` (`backend/.../Recording/RecordingLibraryEndpoints.cs`) — the recording's owner, or anyone with the new `recordings.delete` permission, may request deletion of their own COMPLETED/FAILED, non-legal-hold recording. The request is always written to `rec.RecordingDeletions` and audited (`RECORDING_DELETION_REQUESTED`) the moment it's made — "history in the backend" starts here, before any file is touched.
  - **`recordings.delete` holders (granted to Admin/SuperAdmin, migration V019 — same trust level V017 already gave them for view-all/download) delete immediately**, still fully audited.
  - **An ordinary owner's request goes through the recording's own policy**: if the policy requires dual approval (`DualApprovalForDeletion`, on by default for all four policies today), the request waits for two different approvers — exactly like a retention-triggered deletion already would, not auto-approved just because a user asked. Honest about where this stands today: `DeletionApproverRoles` is still an empty, unconfigured list for all four policies (a pending Compliance item, same one already flagged for retention deletions), so until that's filled in, an owner's own dual-approval-required request correctly shows "Deletion requested, awaiting two approvals" and stays there — nothing is silently bypassed or stuck without explanation.
  - **The recording is never erased**: deleting removes only the stored video file (`RetentionWorker.PurgeAsync`, reused unchanged); the database row (now `Status='PURGED'`), `rec.RecordingAccessLog` and `app.AuditLog` are kept forever, exactly as they already are for a retention-triggered deletion.
- **Frontend**: a "Delete recording" button (`RecordingsPage.tsx`, recording detail → Actions card) opens a confirmation dialog requiring a typed, audited reason — the same UX pattern already used for Legal Hold — and shows "Deletion requested, awaiting approval" in place of the button once one is pending, instead of silently repeating.
- **7 Nov 2026, follow-up — delete made discoverable from the list, not just the detail page**: after this shipped, a delete action in the Recording Library's list itself (a small trash icon next to "Play", both the desktop table and the mobile card) was added — the detail-page button alone meant finding it required clicking into each recording first. `Item()` (the shared row projection used by the list, the by-meeting view and the retention review list) now also returns `canDelete`, computed the same way as the detail page's (owner or `recordings.delete`, not under legal hold, completed/failed) so the icon only appears where the request would actually be accepted; the endpoint itself still re-checks everything (including any already-pending request) before acting. One shared confirmation dialog handles every row.
- **8 Nov 2026, follow-up — recording detail page was ~350px too wide on mobile, pushing the player off-screen**: from a screenshot, the player on a phone appeared to overflow the right edge of the screen. Root cause: the detail page's two-column layout (`grid xl:grid-cols-[minmax(0,1fr)_380px]`, video on the left, Details/Actions on the right) had no base column count for screens below `xl` — Tailwind's `grid-cols-N` utilities specifically use `minmax(0, 1fr)` tracks to let their content shrink; with no base class at all, the grid falls back to plain CSS `grid-template-columns: none`, whose implicit, content-sized (`auto`) tracks have no such protection, so the video player's native 1280×720 content "blew out" the track width instead of being scaled down to fit. The two columns were effectively rendering side by side off-screen on every viewport below `xl`, not just visually cramped. Fixed by adding the base `grid-cols-1` class so the page genuinely stacks into one column below `xl`, exactly as intended, only switching to the two-column layout at `xl` and above. `frontend/src/pages/recordings/RecordingsPage.tsx`. Verified live: the page's total scroll width now exactly matches the viewport width (390px, no overflow) and the player renders centered and fully on-screen.
- **8 Nov 2026, follow-up — a sliver of white above the login card on notched phones**: from a screenshot (Chrome/iOS), the top ~6% of the login screen showed the app's normal light background instead of the dark gradient the rest of the page uses. Root cause: `body` has `padding-top: env(safe-area-inset-top)` globally (`theme.css`) so page content clears the iPhone's notch/status bar — correct for every other, light-background page, but that padding area is still part of `body`'s own box, painted in `body`'s own light `bg-canvas` colour, not whatever a child layout renders beneath it. `AuthLayout` (login, forgot/reset password, etc.) is the one layout with its own full-bleed dark background on a child `<div>`, so that reserved notch strip showed through as a light gap above it instead of extending the gradient under the status bar. Fixed by having `AuthLayout`'s root pull up by that same inset (`-mt-[env(safe-area-inset-top)]`) and pad it straight back on the inside (`pt-[env(safe-area-inset-top)]`) — net effect: the gradient now extends all the way to the top of the screen (under the status bar) while the actual card position is unchanged, since the added margin and padding cancel out. `frontend/src/layouts/AuthLayout.tsx`.
- **Verified live, not just code-reviewed**: a disposable QA account (owner, no special permission) requested deletion of a real test recording on the test deployment — the request correctly returned `PENDING, requiredApprovals=2` (its policy, Internal employee meetings, requires dual approval), the recording stayed playable and unchanged, the UI showed the pending state and a toast explaining admin approval is needed, and the request was written to `rec.RecordingDeletions` with `Source='MANUAL'`. The test request was cancelled afterwards (not approved) so it doesn't sit as a stray pending item for a real administrator to puzzle over.
- Deployed: `dotnet build` (API, Recorder, Domain, both test projects) 0 warnings/0 errors; `npm run build` clean; migration V019 applied to `Oneinsure_v` and recorded in `dbo.SchemaMigrations`; `MeetIQApi` redeployed, `/api/v1/health` → Healthy; frontend `dist` rebuilt and live.

## Unreleased — 7 Nov 2026 (test deployment, `https://www.oneinsure.com/meet`)

### Added — device-adaptive meeting recording (portrait/landscape), smallest safe change
Investigated first, as instructed, before changing anything: the R2 compositor (`recording/layout/src/main.ts`) was never recording a fixed browser screen — it already decodes each participant's real WebRTC camera track frame-by-frame onto an HTML5 canvas (`MediaStreamTrackProcessor`, proof it reads genuine camera pixels, not a screenshot). The actual root cause was that this canvas was sized exactly once, at page load, from a single static server-side config value (1280×720), and that same fixed number was then duplicated into the FFmpeg `scale`/`pad` filter that builds the final MP4 and into `MediaVerifier`'s hard equality check on width/height before a recording could be marked `COMPLETED`. A phone held upright was therefore always cover-cropped into a landscape frame — faces and content cut off at the sides — no matter what the camera actually sent. These findings were shared with the user before any code was written; the user then approved a specific 7-point scope (one-to-one calls adapt, group calls never do, contain not cover rendering, no canvas change on mid-call rotation, no new recording architecture, no paid services) which this round implements exactly:
- **One-to-one calls (≤2 participants) choose their own canvas**: the compositor now waits a few seconds after joining for real camera dimensions to arrive, then locks a **portrait 720×1280** canvas if either participant's camera is portrait, otherwise **landscape 1280×720** — decided once, client-side, from the actual WebRTC video track dimensions (`room.remoteParticipants`), not guessed from the device or user agent. `recording/layout/src/main.ts` (`decideCanvasSize`).
- **Group calls (3+) are completely unaffected**: they always stay landscape 1280×720, with no detection delay and no per-call canvas variation, exactly as approved — verified with the worst case (3 participants, all 3 cameras portrait) still producing a landscape recording.
- **Participant tiles now render contain, not cover, in every call**: the complete video is always shown, letterboxed/pillarboxed as needed, never stretched or cropped — this applies to landscape and portrait video alike, including existing group-call landscape tiles (a deliberate, approved behaviour change from the previous cropped look). A portrait one-to-one canvas also stacks its two tiles vertically instead of squeezing them into unreadably thin side-by-side columns. `main.ts` (`drawTile`, `gridRects`).
- **A mid-call device rotation never touches the recording itself**: because each frame is drawn contain-fit from its own live dimensions, a participant rotating their phone is absorbed automatically by the next draw — no canvas resize, no recorder restart, no audio/video interruption. Verified live: rotating a participant 18 seconds into a 40-second one-to-one recording produced one continuous segment, zero restarts, no gaps around the rotation point, and visually confirmed (extracted frame) that their tile re-letterboxed correctly without affecting the other participant or the overall canvas.
- **FFmpeg build and verification now use the canvas size actually chosen for each job, not a hard-coded landscape default**: the compositor reports its chosen width/height back to the recorder host (`RecordingSession.ActualWidth/Height`), which flows into `Finalizer.BuildMp4Async`/`VerifyAsync`, the crash-recovery `finalize` retry path (which recovers the size via a new `MediaVerifier.ProbeVideoDimensionsAsync` on the spooled WebM, since that decision was only ever made live in the browser), and the API's own independent re-verification after the file is moved into the recording library (`RecorderWorker.cs`, reusing the dimensions the recorder itself already verified rather than assuming 1280×720). No database migration and no new configuration — the orientation decision is made entirely by the browser compositor at record time.
- **Verified against real generated MP4 files**, not just code review, per the user's explicit instruction not to mark this done otherwise: extended the existing R2 recorder proof-of-concept harness (`tests/r2-poc/harness/`) with a configurable synthetic camera orientation and a live `rotate()` control, run against a local loopback-only LiveKit instance kept deliberately separate from the live test deployment's own video server (different ports; the live `MeetIQVideo` test service was never touched). All 7 of the user's approved acceptance scenarios passed — see `documentation/UAT_TESTING_REPORT.md` "Device-adaptive meeting recording" for the full table, real dimensions, A/V-sync numbers and an extracted-frame visual check confirming no cropping/distortion on either a mixed-orientation call or a post-rotation frame.
- Deployed to the test environment: `dotnet build` (API, Recorder, Domain, both test projects) 0 warnings/0 errors; recorder layout rebuilt; `MeetIQApi` Windows service stopped, redeployed (self-contained win-x64, existing `appsettings.Production.json` untouched) and restarted, `/api/v1/health` → Healthy.
- **Not done this round** (flagged, not silently dropped): a real mobile device's browser over LAN (the acceptance tests used a synthetic camera of known pixel dimensions, which exercises the same WebRTC-track-dimension code path a real phone uses, but is not a substitute for a hands-on device check); a 3+ participant call combined with a live rotation; re-running the 30-minute soak/concurrency scenarios against the new logic.

## Unreleased — 6 Nov 2026 (test deployment, `https://www.oneinsure.com/meet`)

### Fixed — disconnect and resume now works for everyone with a still-valid link
The user's instruction on host-transfer reconnect ("everyone can disconnect and resume if meeting link is working and not expired") turned a narrow host-only question into a broader audit of reconnection for all three ways someone joins. A signed-in employee (host, co-host or attendee) already resumed cleanly — their role is a persisted database value, not tied to the live connection, and a lock set after they first joined never blocks their own reconnect (`HasAttendedAsync`). Two real gaps were found and fixed:
- **An already-admitted guest or customer reconnecting through their personal invitation link was forced back into the waiting room and had to be manually re-admitted by the host every time** — `GuestEnter` only recognised a *last* waiting-room status of `WAITING` or a recent `REJECTED`; an `ADMITTED` status fell through to creating a brand-new wait entry. Fixed: an already-admitted participant now gets their connection straight back, the same way a returning employee always did. `backend/.../Meetings/RoomEndpoints.cs`.
- **An anonymous guest joining through the generic shareable link (not a personal invitation) had no persisted identity at all** — every full reconnect (closed tab, locked phone, crashed browser) minted a brand-new participant and waiting-room entry, with no way for the server to recognise them as the same person who was already let in minutes earlier. Fixed by remembering that guest's own personal token in their browser's `localStorage`, keyed only by the public link token (nothing identifying is stored), so a reconnect reuses it instead of asking to join from scratch — combined with the `GuestEnter` fix above, this takes them straight back into the live meeting. An invalidated/expired remembered token (e.g. the host later removed and blocked them) is detected and cleared automatically, not retried forever. `frontend/src/pages/LinkJoinPage.tsx`, `frontend/src/pages/room/GuestRoom.tsx`.
- **Live-tested, not just code-reviewed**: a real guest was admitted into a live meeting, their entire browser context was closed (simulating a crashed tab/closed laptop), then reopened from the same saved browser storage and the same link revisited — they landed directly back in the live meeting room with no new wait and no host action needed.
- **Noted, not changed**: two background safety nets can still end a meeting outright (not just drop one person) — LiveKit closes a room 2 minutes after literally everyone has left, and a stuck-row sweep force-completes a `LIVE` meeting 4 hours past its scheduled end regardless of actual occupancy. Both only matter once a meeting has genuinely ended or stalled for hours, which is consistent with "not expired" rather than a contradiction of it — flagged here in case the thresholds themselves ever need revisiting, not touched this round.
- Deployed: `dotnet build` clean; `MeetIQApi` redeployed, health OK; frontend rebuilt and live.

### Phase 2 — host controls completed, Customer/PLVC auto-recording turned on
Against the 20-section feature request, a full read-only audit was done first (four parallel code audits covering host controls, chat/reactions/voting/spotlight, camera/extension/audio, and whiteboard/AI/gesture — see the feature status table shared with the user) before any code was written, confirming what already worked, what was partial, and what didn't exist at all. This round closes every item from that audit that was fixable without a new dependency or a legal/business decision:
- **Mute All already worked but gave the muted person no on-screen cue** — the host's mute (individual, or looped for "mute all") now also sends the affected participant a direct, real-time notice ("The host turned off your microphone/camera"), over the same LiveKit data channel already used for waiting-room/host-transfer events (`oic.host-notice`). `backend/.../Meetings/RoomEndpoints.cs`, `frontend/.../MeetingRoom.tsx`.
- **"Unmute All" added**: no browser lets a host force a remote microphone back on, so this sends a "the host is asking you to unmute" notice instead — new endpoint `POST /room/participants/{identity}/unmute-request`, a per-participant button and a bulk "Unmute all" button (Participants panel).
- **"Disable participant's camera" added**: the backend could already force-mute a `CAMERA` track (built for mic muting, source was generic) — the Participants panel just never offered a button for it. Added one, next to mute.
- **Lock Meeting / Unlock Meeting completed**: the `IsLocked` column and one enforcement check (the public shareable-link path) already existed from an earlier phase, but nothing could ever set the flag and the two other join paths (an already-invited employee's `/join`, a personal guest/customer invitation's `/enter`) didn't check it at all. Added `POST /room/lock`, enforced it on all three join paths, and added a Lock/Unlock button + a "🔒 Locked" header chip. Locking never retroactively disconnects anyone already in the meeting and never locks out the host.
- **Customer meetings (PLVC + general) now actually auto-record**: the business decision to make this Mandatory was approved in writing days ago but the policy's `Requirement` field was still `Optional` — flipped via migration `V018`. Customer audio calls were set to `Disabled` in the same migration (no telephony integration exists to capture them, also per the already-approved decision). Internal/Training meetings were already correctly `Optional` and are unchanged.
- **Recording notice: banner instead of a blocking pop-up, where the policy allows it**: a policy using `NOTIFICATION_ONLY` consent mode no longer shows a modal requiring a click to dismiss — it shows a small dismissible banner and the "notice shown" acknowledgement is recorded automatically rather than gated on a button press. A policy using `CONSENT_REQUIRED` (all four current policies, today) is completely unchanged — that's a real legal consent decision, not a redundant pop-up, so nothing about that flow was touched. This only changes behaviour once/if a policy's consent mode is actually set to notification-only; no current policy is.
- **Recording-failure admin alert added**: a failed recording already notified the meeting's owner (in-app + e-mail); it now also raises an in-app notification for every Admin/SuperAdmin, not just whoever happened to schedule that one meeting.
- Deployed: `dotnet build` (API + Recorder + both test projects) clean; migrations `V017`/`V018` applied and tracked; `MeetIQApi` redeployed, health OK; frontend rebuilt and live.
- **Live-tested end to end, not just code-reviewed**: a real two-participant meeting confirmed, with screenshots — muting a participant shows them "The host turned off your microphone"; requesting unmute shows "The host is asking you to unmute"; disabling a participant's camera actually stops their video (tile switches to the avatar placeholder, confirmed by both host and guest view); locking the meeting shows a fresh guest "The meeting is locked" with no way to even request to join, and unlocking immediately lets the same guest reach the waiting room.
- **Not done this round** (out of Phase 2's scope, flagged not silently dropped): host-transfer "accidental disconnect, nobody is host" recovery (today, a disconnected host simply resumes as host on reconnect because the role is a persisted DB value, not tied to the live connection — but if they never come back, no co-host is ever auto-promoted; this needs a product decision on timing/behaviour before being built); persistently revoking a participant's ability to turn their own mic/camera back on (today's "disable" is a one-shot mute, same as before); a live auto-start test against an actual Customer-category meeting (the Mandatory flip and the underlying auto-start mechanism were both verified — the flip via direct DB check, the mechanism via code review earlier this session — but a full live run with a real customer invitation was not separately re-executed this round).

### Added — recording download access, date-wise storage, findable-without-opaque-path metadata
Closes the "no role can download anything, not even their own recording" gap found during yesterday's live pipeline test. `database/migrations/V017__recording_download_access.sql`:
- **Meeting creators can now download their own recordings** (not just play them): `OwnerCanDownload` turned on for all four recording policies (was off by default since V012). No permission change needed for this — `RecordingAccess.Decide` already had an `(is owner && policy says owner can download)` path that nothing had ever enabled.
- **Admin and SuperAdmin get full access to every recording**: granted `recordings.view.all` and `recordings.download` (both existed as permission codes since V010 but had never been granted to any role — not even SuperAdmin). Scoped to just these two roles; team/department-level access and the wider Compliance-approved access matrix (`PRODUCTION_APPROVAL_CHECKLIST.md` item 14) remain exactly as pending as before — this isn't a substitute for that.
- **Recordings are now organised into day-wise folders on disk** (`StorageRoot/yyyy/MM/dd/...`, was `yyyy/MM/...`) — `RecorderWorker.cs`.
- **The meeting code is now embedded in the MP4's own metadata** (title/comment tags, written via an FFmpeg stream-copy remux — no re-encode, no quality loss) so a recording is identifiable by opening it or running `ffprobe`, **without** changing the on-disk folder/filename itself, which stays a random opaque string by deliberate design (a documented, tested security pass-criterion: "no meeting, customer or employee data in folder or file names," `documentation/R2_RECORDER_POC_REPORT.md`). This was a direct choice between three options put to the user; the one that keeps raw file paths and backups free of any meeting-identifying string was chosen. The HTTP download filename already included the meeting code (`recording-{code}-{date}.mp4`) before this change — unaffected.
- Verified live (not just code review): ran a fresh two-participant test meeting end to end; confirmed independently (filesystem `ls`, `sha256sum`, `ffprobe` — not the app's own claims) that the new recording landed at `.../2026/11/06/<opaque-hash>.mp4`, its metadata tags read `title=OIC-261106-YJ2A` / `comment=OneInsure Connect meeting OIC-261106-YJ2A`, and the meeting's own creator could download it directly with no manual policy override — byte-identical SHA-256 throughout.
- Deployed: `dotnet build` (API, Recorder, both test projects) 0 warnings/0 errors; V017 applied to `Oneinsure_v` and recorded in `dbo.SchemaMigrations`; `MeetIQApi` service redeployed (self-contained win-x64, config untouched) and restarted; `/api/v1/health` → Healthy.

### Recording consent — audited, one gap closed, wording still blocked on Legal/Compliance
The user asked to "complete all the recording related things" against a 10-point checklist, stating the company's recording policy and consent wording are already approved and asking for the approved text to be used instead of the placeholder — or, if it isn't in the codebase, to be asked for it rather than inventing anything. A full repo search (code, SQL migrations, all documentation) turned up **no approved wording, policy name/version, or retention period anywhere** — every single occurrence is explicitly marked a placeholder pending confirmation, including in the project's own `documentation/RECORDING_POLICY_CONFIGURATION.md` and `documentation/PRODUCTION_APPROVAL_CHECKLIST.md` ("nothing is approved" as of 31 Oct 2026). Per the user's own instruction, the placeholder banner, `PLACEHOLDER-0` version and placeholder notice text were **left in place** rather than removed or replaced with invented text — removing them without real text would make genuinely-unconfirmed wording look approved, which is the one thing this project has been careful never to do. Asked the user directly for the actual text.
- Everything else on the 10-point list was audited against the existing code and found **already fully implemented**: consent is captured with a timestamp, meeting ID, IP, user agent and a tamper-evident hash (`mtg.MeetingConsent`, append-only, V005); every consent decision and every recording start/stop is also written to the general `app.AuditLog` trail (same table the Audit Log viewer reads); the "REC" indicator is broadcast to and visible by every participant, not just the host; withdrawing consent already stops a consent-required recording automatically when the policy says so (`stopOnWithdrawal`); and employee and guest/customer meeting rooms already share one `RecordingControls` component and one backend code path, so the same notice/consent behaviour already applies to both consistently.
- **New, built and deployed**: the only real gap found was that per-participant consent status (who has granted/is pending/declined) was only ever shown once, inside the pre-start "Start recording?" dialog. The host-only Participants panel now shows a live "Consented / Awaiting consent / Declined / Withdrawn" tag next to each required participant's name, fed by a new `decisions` field on the existing `GET /meetings/{id}/recording` consent payload (`RecordingService.StateAsync`) — no new endpoint, no new table, just surfacing data that was already being computed server-side. `backend/src/OneInsure.Connect.Api/Recording/RecordingService.cs`, `frontend/src/api/recordings.ts`, `frontend/src/pages/room/RoomPanels.tsx`, `MeetingRoom.tsx`.
- Deployed: `dotnet build` 0 warnings/0 errors, `npm run build` clean; `MeetIQApi` Windows service stopped, new self-contained win-x64 build copied in (existing `appsettings*.json` left untouched), service restarted; `/api/v1/health` → `{"status":"Healthy"}` confirmed live. Frontend `dist` rebuilt and live (same IIS physical path as before).
- **Still blocked on you**: the exact approved recording-notice wording, the policy's name/reference and version number, and the retention period for each of the four policy types (Customer Meeting, Customer Audio Call, Internal Meeting, Training/Team Meeting) — once supplied, these are pure configuration values entered via Administration → Recording policies (or a direct `rec.RecordingPolicies` update), no further code change needed to display them.

### Reverted — colour palette rolled back one round, login animation kept
The reference-image colour/panel round below (bright sky-blue login, white meeting-room panels, `#0788EF`-family palette) was reverted on the user's instruction ("revert colour changes one step back"), restoring the previous round's palette (`#2463D3`/`#3B82F6`/`#22D3EE` blue-cyan family, dark midnight login gradient, dark-glass meeting room header/toolbar/panels) across `theme.css`, `tokens.ts`, `room.css`, `RoomPanels.tsx`, `MeetingRoom.tsx`, `RecordingControls.tsx`, `ConnectLogo.tsx`, `Avatar.tsx`, `LoginPage.tsx` and `DashboardPage.tsx`. One thing was kept and is new: the login background now has three slowly drifting glass bubbles (camera, laptop, people icons), matching the floating-icon animation in the reference image, without carrying over its colour scheme. Exact note on fidelity: this project's colour history was never committed to git between rounds, so the three meeting-room accent tokens (`--oic-enterprise-blue`/`--oic-electric-blue`/`--oic-cyan`) and the files touched only in the just-reverted round were restored to their exact prior values (captured verbatim earlier this session); `theme.css`'s full brand ramp (the shades between those three anchor colours — `brand-50` through `brand-300`, `brand-600`) is a careful reconstruction around those same anchors rather than a byte-exact restore, since no snapshot of that exact intermediate state existed to restore from — flag it if any particular shade looks off.

### Changed — visual design aligned to the approved reference image (superseded by the revert above)
A reference image (login / dashboard / live meeting room) was provided as the primary design source, correcting two earlier judgment calls (see 0.7.1 entries below for the first pass at this palette).
- **Login background is now bright sky-blue/cyan** (`--gradient-login`, new token in `frontend/src/styles/theme.css`), replacing the dark midnight-to-blue gradient from the previous round. Ambient decorations (orbs, dot grid, network nodes, sparkles) were recoloured for a light background instead of a dark one. Single unified card layout (shipped earlier) is unchanged.
- **Meeting room header, bottom toolbar and all three side panels (Participants, Chat, Settings) are now white/translucent**, matching the reference image, while the video stage itself (tiles, avatars, name chips) stays dark/immersive as before — reversing the earlier decision to keep these dark. Changed in `frontend/src/pages/room/room.css` (`.oic-room header`, `.oic-controls`, `.oic-panel`, `.oic-ctl`, `.oic-chip`, `.oic-input`/`.oic-select`) and `frontend/src/pages/room/RoomPanels.tsx` / `MeetingRoom.tsx` / `RecordingControls.tsx` (every hard-coded `text-white/*`, `bg-white/*`, `border-white/*` class in the panels and header recoloured for a light surface). Toggle-on states (screen-share active, chat/people panel open) keep a solid blue fill; mute/camera-off, recording and Leave/End keep a solid red fill — both with white icons/text for contrast, unchanged from before.
- **Final approved palette propagated everywhere**, including a few places the previous round's token-level change didn't reach because they used hard-coded hex values: `ConnectLogo.tsx` (product mark gradient), the sign-in button gradient, the dashboard "Next meeting" card's shadow colour, the avatar initials colour palette, and the meeting room's `--oic-enterprise-blue`/`--oic-electric-blue`/`--oic-cyan`/`--lk-accent3` tokens.
- Verified locally before deploying: login page screenshotted at 1440px and 390px against the running dev build; the meeting room header/toolbar/panel chrome verified by rendering the actual compiled production CSS and component markup (a live meeting was not created against the production backend for this, to avoid writing a real meeting/LiveKit room into production data without a separate approval).
- Not yet done (flagged, not silently skipped): the other ~20 screens (My Meetings, Calendar, Recording Library, Employee/Department Management, Administration, etc.) still use the pre-existing styling; full 8-breakpoint responsive sweep; screen-share "include audio" toggle.

### Fixed
- **Recording consent popup shown to everyone even when nothing was being recorded**: turning on host-optional recording for Internal/Training meetings earlier today meant the "This meeting may be recorded" notice (with its honest "wording not confirmed" placeholder banner) now popped up for every participant on every internal call the moment they joined, regardless of whether the host ever started recording. It now only appears on its own for a meeting where recording is Mandatory (it will start automatically, so advance notice matters) or once recording is actually running/starting for an Optional meeting — not pre-emptively for a call nobody is recording.

### Added
- **Speaker/audio-output selection is real, not decorative** (meeting room → Settings): investigated the existing "Speaker" dropdown and confirmed it already calls LiveKit's `room.switchActiveDevice('audiooutput', …)`, which calls the standard `HTMLMediaElement.setSinkId()` on every remote participant's actual audio element — so choosing a device already worked (this is how a user can already send meeting audio to a laptop speaker instead of an HDMI monitor). What was missing, now added: a **Test speaker** button that plays a short synthesised chime through exactly the selected device, independent of the live call (so you can confirm it worked without interrupting the meeting); the chosen speaker (and camera/microphone) is now **remembered per browser** and restored automatically in the next meeting; and on browsers that cannot do this at all (Safari, iOS) the panel now says so upfront, with a plain-language pointer to the OS's own sound settings, instead of only failing silently when tried. Device-list refresh on plug/unplug and graceful fallback when the active device disappears were already handled by LiveKit itself — verified in its source, not assumed.
- **Approved colour palette applied project-wide**: `frontend/src/styles/theme.css` and `frontend/src/design/tokens.ts` (its JS mirror) now use the approved hex values for primary blue, electric blue, cyan, teal, success, danger, background and border; the meeting room's own dark palette (kept intentionally distinct, per instructions, for the immersive video stage) was retuned to the same blue/cyan/teal family. This is a token-level change — most components picked it up automatically since they reference the tokens rather than hard-coded colours; a full manual per-component pass against the approved table was not done.
- **Login background**: added a quiet animated network of connected nodes (dashed lines + pulsing cyan dots) over the existing drifting gradient, glow orbs and sparkles — connectivity-themed, not literal camera icons, so it reads as atmosphere rather than clutter behind the card.
- **New font project-wide**: replaced Plus Jakarta Sans with **Inter** (self-hosted, free, OFL-licensed, same approach as before — no network calls added) across the entire app, including the meeting room. One line to change if a different face is wanted later: `--font-sans` in `frontend/src/styles/theme.css`.
- **Login (and every auth screen) redesigned as one unified card**, replacing the old split brand-panel + form layout: a single centered card over an animated midnight-to-blue gradient backdrop with drifting glow orbs, a faint dot grid and a few twinkling sparkles, a spinning conic-glow halo behind the product mark, a light sweep across the Sign-in button, and the real OneInsure logo as a compact "platform by" line at the card's foot. The card is noticeably smaller/tighter than before. Applies to Forgot password, Reset password, MFA, Account locked and Session expired too, since they all share the same layout — each now gets the same brand header for free.
- **Dashboard shine pass**: stat-card icon badges now have a glossy diagonal highlight and lift with a colour-matched glow + slight tilt on hover; the "Next meeting" card pulses its ambient glow and gets a slow light sweep; "New Meeting" (header) got the same light-sweep treatment.
- **Meeting room shine pass**: the active-speaker glow now actually pulses instead of sitting static; participant avatars got a glossy highlight; the floating header and toolbar got a faint cyan edge-glow; the Stop-recording control pulses red while recording is live.
- **Dashboard stat cards are now clickable** (iOS-style): Total Employees, Today's/Upcoming/Internal/Customer/Completed Meetings, Total/Pending Recordings each link straight to the relevant page, gated by the same permission that page already requires — a card the viewer can't open just stays non-clickable instead of leading to Access Denied. Circular icon badges, a trailing chevron on hover, and a press-down tap effect make it visually obvious which ones are tappable.
- **"Today's schedule" rows are now a single tappable row** (iOS list-style) instead of a bordered card with separate controls: click anywhere on a row to open that meeting, with Join/Details staying as their own buttons inside it (clicking them doesn't also trigger the row).
- **"Today's schedule" collapses to 3 meetings** on the dashboard, with a "Show N more meetings" / "Show fewer" toggle — a busy day (15 meetings, in one real case) no longer pushes the rest of the dashboard off-screen.
- **iOS-style meeting room**: controls are now fully circular (Control Center-style) instead of rounded rectangles, the header floats as its own glass "island" at the top (mirroring the floating toolbar at the bottom, Dynamic-Island-style) instead of a bar flush with the screen edge, and tiles/panels share one consistent larger corner radius throughout.
- **Meeting room visual refresh**: richer toolbar buttons (per-control icon tints, deeper glass gradient), a bolder header title with refined status chips, a slow ambient background drift, and a softer animated ring behind the camera-off avatar placeholder.
- **Mute all** (meeting room, Participants panel, host only): one click mutes every other participant's microphone, reusing the existing per-participant mute call for each.
- **Scheduled-end notice** (meeting room): a one-time toast when a meeting's scheduled end time passes, telling everyone the call keeps going until a host ends it. Purely informational — nobody is disconnected automatically; see "Known limitation" below.
- **Auto-refresh so "Join" appears on its own**: the Dashboard (every 30s) and My/Internal/Customer Meetings lists (every 30s, paused while the tab is hidden) now silently refresh in the background. Previously the "Join" button only appeared after a manual page reload, even though the join window had already opened — the page was showing a one-time snapshot from when it first loaded. `MeetingDetailPage` already self-corrected at the right second and was not affected. Added generic `pollMs` support to the shared `useLoader` hook so other screens can opt in the same way.
- **Dashboard "Next meeting" card no longer stretches to match "Today's schedule"**: it shared a grid row with "Today's schedule" and was set to always match its height, so a short next-meeting entry left a large empty gap. It now sizes to its own content.
- **Internal meetings and Training/Team meetings: recording turned on, host-optional** (database config, no deploy): the host now sees the recording control and can start it if they want; nothing records automatically. Previously these two policies were switched off entirely (seed-data default), so there was no recording control at all for any internal/training meeting.
- **Emails go to real recipients** (database config, no deploy): removed the test-only `RedirectAllTo` setting that funnelled every outgoing e-mail (invitations, reminders, password resets, recording notices) to one inbox. They now go to each actual recipient.

Known limitation (deliberate, needs a decision - see PROJECT_CHECKLIST.md "Pending"): a `LIVE` meeting is never force-ended at its scheduled time — only the host ending it, or `MeetingExpiryWorker`'s stuck-row safety net (3 hours past the join-late window) closes it. This matches how Zoom/Teams behave and avoids silently cutting off a live call. The new scheduled-end toast above is the safe half of this request; forcing every participant off the call at the exact scheduled minute is a real behaviour change that needs an explicit decision before being built.

- **Recurring meetings**: schedule a meeting that repeats Daily, Weekly (on chosen weekdays) or Monthly, ending after a chosen number of occurrences or on a date (capped at 52 occurrences within one year). Implemented as independent `mtg.Meetings` rows per occurrence linked by a new `mtg.MeetingSeries` table (migration `V015__recurring_meetings.sql`) — conflict detection, recording policy, invitations, reminders, reports, host transfer and the join flow all work per-occurrence exactly as they already did for a one-off meeting, with no changes to any of that code. New API: `POST /meetings/recurring`, `GET /meetings/{id}/series`, `POST /meetings/{id}/series/cancel` (scope: this-and-following, or all). New UI: a "Repeat" section on the scheduling form (new meetings only), a "Recurring series" card and a cancel-scope choice (this meeting / this and following) on the meeting detail page. New files: `backend/src/OneInsure.Connect.Api/Meetings/RecurrenceSupport.cs`, `database/migrations/V015__recurring_meetings.sql`.
- **Audit log viewer** (`/audit-log`): filterable (date range, action, entity type, free text, privileged-only), paginated, with expandable before/after detail for entries that recorded one. Built entirely on the existing append-only `app.AuditLog` table (V007) and the existing `audit.view` permission (seeded to ComplianceAuditor, Admin and SuperAdmin in V010) — **no new database migration**. Previously this permission had nowhere to be used: the only page behind it, `/admin`, required `admin.settings`, which ComplianceAuditor does not have — so that role could never reach the audit trail it exists to review. `/audit-log` is now its own route, gated on `audit.view` directly. New files: `backend/src/OneInsure.Connect.Api/Admin/AuditEndpoints.cs`, `frontend/src/pages/admin/AuditLogPage.tsx`, `frontend/src/api/audit.ts`.

- **Reset password from Employee Management**: opening an employee with a linked sign-in account now shows a "Reset password" action right there (same confirmation and one-time-password flow as Administration → Users & roles → Reset password) instead of requiring a trip to the separate Administration screen. Still gated by `users.manage`; no new backend endpoint — reuses the existing `POST /admin/users/{id}/reset-password`.

### Fixed
- **OneInsure parent-brand logo broken everywhere** (login, sidebar, meeting room, invite popup, guest/waiting pages): `OneInsureLogo.tsx` used a hard-coded absolute path (`/brand/oneinsure-logo.png`) that 404'd under the app's `/meet` sub-path. Now built from `import.meta.env.BASE_URL`, which Vite rewrites correctly for any deployment path. Single shared component, so one fix covers every location. Verified live: `https://www.oneinsure.com/meet/brand/oneinsure-logo.png` → 200 `image/png`.

### Changed — scheduling form
- **Agenda and Description merged** into one "Meeting Details (Optional)" field (`frontend/src/pages/meetings/MeetingForm.tsx`, `MeetingDetailPage.tsx`, `meta.tsx`). Both database columns are untouched — nothing deleted, nothing migrated. A combined save writes the merged text to `agenda` only; an older record with both fields is shown as one combined block (`combineMeetingDetails()`), so no existing data is lost or hidden.
- **Category dropdown simplified** to 5 top-level choices (Internal Meeting, Training, Review, Customer — PLVC, Customer — General). Internal Meeting shows a secondary "Meeting Format" selector (One-to-one / Group / Team / Department / Management). Pure frontend presentation change — the underlying `DbMeetingCategory` database values, recording-policy mapping and historical/report data are unchanged.

### Changed — visual polish
- Dashboard stat cards: coloured top accent bar and icon lift on hover (`components/ui/Card.tsx`), matching the approved navy/electric-blue/cyan palette per accent.
- Invite-meeting link dialog (`MeetingLinkShare.tsx`): the link box is now a glass-tinted card with a labelled header; copy/e-mail/share/new-link/withdraw actions regrouped; waiting-room and expiry info shown as an icon-led info panel. Link generation, expiry and permission rules are unchanged.

### Documentation
- `PROJECT_CHECKLIST.md`, `documentation/UAT_TESTING_REPORT.md` updated with today's work and outstanding UAT items.

### Known pending (not done in this round — flagged, not silently skipped)
- Full interactive responsive testing at 360/390/430/768/1024/1366px+ against this round's changes (the mobile breakpoints were last verified against the pre-5-Nov room UI — see `tests/e2e/room/mobile-audit.mjs`, 3 Nov 2026).
- Admin-panel screens (SMTP settings, security settings) — new backend/UI surfaces, not yet built. (Audit log viewer shipped later the same day — see "Added" above.)
- "Private Chat" (1:1 messaging) — a new feature, not yet built; needs confirmation before starting.
- Live user acceptance testing of all of the above by the product owner.

## 0.7.0 (release package) — 3 Nov 2026

### Added — mobile (Android and iOS)
- **Meeting room on phones:** compact toolbar (microphone, camera, chat, participants, **More**, leave) with a bottom sheet for raise hand, view, audio/video settings, recording, present and end-for-all; screen sharing is hidden where the browser cannot do it (Android/iOS); smaller header and toolbar in landscape; safe-area padding for notches and the iOS home indicator.
- **Bottom tab bar** on phones (Home, Meetings, **New meeting**, Calendar, Alerts); toasts sit above it.
- **Installable web app:** manifest, app icons (Android, maskable, iOS home screen), standalone mode, `viewport-fit=cover`.
- iOS: form fields no longer zoom the page on focus; no grey tap flash.
- Fixed: tables no longer widen the page on tablets (screen-reader labels escaped the scroll area); the dashboard "Join now" button was white on white.
- Verified at 360, 390, 430 and 768 px (16 screens) and the room in portrait (360/390) and landscape (844×390): `tests/e2e/room/mobile-audit.mjs` 7/7.

### Added — production build
- `deployment/build-release.ps1` → `deployment/out/OneInsureConnect-<version>.zip`: tests, web build, self-contained win-x64 API, R2 recorder and service host, LiveKit (hash-pinned), migrations, installer, guides; secret scan; SHA256 checksums.
- `deployment/server/`: IIS `web.config` (HTTPS redirect, `/api` and `/rtc` reverse proxy, SPA routes, security headers, caching), production settings and LiveKit templates, `install-oneinsure-connect.ps1` (Windows services under virtual accounts, secrets only in locked service environment keys, optional IIS site and firewall rules).
- API: runs as a Windows service (`OneInsureConnectApi`); behind IIS it uses the real client address (`ReverseProxy:Enabled`) for rate limits and audit.
- New project `OneInsure.Connect.ServiceHost` (runs LiveKit as the Windows service `OneInsureConnectVideo`, restart on crash, daily logs).
- Docs: `documentation/PRODUCTION_DEPLOYMENT_GUIDE.md`, `documentation/GO_LIVE_CHECKLIST.md`.

## 0.7.0-advanced-b (unreleased) — 2 Nov 2026

### Added
- **Instant meetings** ("New meeting" on the dashboard): start now without a calendar booking or e-mails; title, type, length, camera on/off, **audio-only** (camera blocked in the LiveKit token, not just hidden), waiting room, recording per policy. Marked *Instant* in meeting lists and detail.
- **Shareable meeting link** (`/m/{token}`, 256-bit random, stored as SHA-256 + Data-Protection-encrypted copy): copy, e-mail, device share, replace and withdraw (hosts, co-hosts, organiser). Expires when joining closes.
- **Guest joining without an account through the link**: name + device check → waiting room. People from the link **always** wait for a host's admission, even when the meeting's waiting room is off or the host has not joined. Signed-in colleagues who were not invited join as employees after admission; invited participants go straight to their room.
- **Join meeting** (dashboard): paste a link or type a meeting code (codes open only meetings the user can already see; no anonymous code lookup).
- **Remove and block**: hosts can remove a participant and prevent re-entry (personal link revoked, refused everywhere).
- Room: **Invite** button with the link for hosts (opens automatically for a meeting just started); waiting list says "via meeting link" / "Colleague (not invited)".
- Migration **V013** (applied to Oneinsure_v 2 Nov 2026): `Meetings.MeetingKind`, `Meetings.IsAudioOnly`, `MeetingParticipants.JoinSource/AdmissionRequired/IsBlocked/BlockedUtc/BlockedByEmployeeId`, `mtg.MeetingLinks`.
- Phase A impact analysis: `documentation/ADVANCED_FEATURES_IMPACT_ANALYSIS.md`.

### Tests
- API 72/72 (7 new in `MeetingLinkTests`, incl. per-address rate limit on the link page), domain 18/18. Browser test `tests/e2e/room/instant-link.mjs` (isolated environment).

## 0.6.0-phase4-room (unreleased) — 1 Nov 2026

### Added
- **Live video meeting room** (LiveKit SFU, browser client lazy-loaded): pre-join with camera/microphone preview, device choice and permission help; grid and speaker layouts with active speaker, mic/camera/screen share, raise hand, network-quality indicators, "Reconnecting…" banner with automatic recovery, chat (live over LiveKit, persisted in SQL, history on join), participants panel; hosts admit/deny from the waiting room, mute, remove and end the meeting for everyone.
- **API:** `POST /meetings/{id}/join` (short-lived least-privilege LiveKit tokens; participants only, administrators cannot enter silently), chat, waiting room and host controls (LiveKit RoomService), customer/guest `/join/{token}/enter` + waiting-room polling, signed and idempotent LiveKit webhooks → attendance and room lifecycle (`LIVE` → `COMPLETED`). No database migration.
- Meeting detail, dashboard and the public join page offer "Join" only when the room is open (`join.joinable`).
- Development: loopback-only http listener for LiveKit webhooks (`LiveKit:WebhookListenUrl`), `video-server/start-dev.ps1` adds the webhook block; isolated browser test `tests/e2e/room/room.mjs`.

## 0.5.0-phase3-api (unreleased) — 31 Oct 2026

### Added
- **E-mail:** delivered through OneInsure's `Util_SendEmail2` procedure (configurable three-part name, Unicode body, retries with back-off, delivery log, development redirect to a test inbox); e-mail one-time code as a second sign-in factor.
- **Phase 3 API:** customers; meetings with participants, RSVP, reschedule and cancel; double-booking prevention (serializable transaction + per-employee app locks, conflicts without titles, audited override); calendar; personal availability (leave, blocked time, working-hours warnings); e-mail invitations; customer join links (hashed tokens, public `/join/{token}`); reminder worker (no duplicates, version-aware); notification centre API.
- Migration V011: `RESPONSE` notification type; PublicId on notifications and availability (applied to Oneinsure_v on 31 Oct with approval).

### Added (UI)
- Schedule/Edit Meeting with live availability and conflict handling, My/Internal/Customer Meetings, meeting detail with RSVP and host actions, Calendar (month, week, day, agenda), real notification bell and Notifications page, Customers, My availability (Settings), public customer join page. Video join remains Phase 4.

## 0.4.0-phase2 (unreleased) — 31 Oct 2026

### Added (API)
- **Two-factor sign-in (TOTP authenticator apps)**, RFC 6238 verified against the RFC test vectors:
  - Enrolment with a QR code (password re-check), confirmation code, and 10 one-time recovery codes (stored as SHA-256 hashes).
  - Sign-in flow `MFA_REQUIRED` → `/auth/mfa/verify`. Codes cannot be replayed, and failed codes count toward the account lockout.
  - "Trust this device for 30 days", bound to the security stamp. Regenerate or disable (password + code). Administrator reset for a lost phone.
  - Secrets are encrypted with ASP.NET Core Data Protection (DPAPI-protected key ring).
  - E-mail OTP waits for SMTP.
- **Account:** list and revoke your own active sessions.
- **Organisation masters:** departments (parent, head), designations (level), branches (IANA time zone), teams with membership history. Code-addressed; activate/deactivate (blocked while active employees remain).
- **Employees:**
  - Paged search, filters and sorting; detail view with teams, direct reports and linked account; create and edit with reporting-loop detection.
  - Deactivation disables the linked account, revokes its sessions and ends team memberships.
  - Pick-list lookup for any signed-in user.
  - **CSV bulk import:** template download, dry run, per-row errors, all-or-nothing apply, upsert by code, reporting managers may reference rows in the same file.
- **Users & roles:**
  - Create accounts (from an employee or an e-mail) with a one-time password; edit roles; admin password reset; unlock; reset MFA; activate/deactivate; editable role × permission matrix.
  - Guards: SuperAdmin-related actions need `roles.manage`; you cannot demote or deactivate yourself; the last active SuperAdmin is protected; SuperAdmin keeps `roles.manage`.
- `documentation/API_DOCUMENTATION.md`: full v1 contract.
- All API timestamps are serialised as UTC with "Z".

### Added (UI)
- Settings (two-factor setup with QR, recovery codes, sessions), recovery-code sign-in, Employee Management (search, filters, add/edit, detail, deactivate, user account creation, CSV import with preview), Department Management (departments, designations, branches, teams + members), Administration → Users & roles (one-time passwords, roles, unlock, reset MFA, permission matrix). Other admin areas remain labelled "not yet implemented".
- Tests: 25 API integration tests (+12: MFA end to end, RFC vectors, org masters, employees, CSV import, user administration guards).

## 0.3.0-phase2-api (unreleased) — 31 Oct 2026

### Added
- `backend/src/OneInsure.Connect.Api`: ASP.NET Core 10 API implementing the existing frontend contract (`/api/v1/auth/*`, `/api/v1/dashboard/summary`, `/api/v1/health`).
  - Sign-in by e-mail or employee code. PBKDF2 hashing (ASP.NET Core Identity hasher). Generic error for unknown user or wrong password. Lockout after 5 failures for 15 minutes. All attempts logged to `auth.LoginAttempts`.
  - Server-side sessions: random token in an HttpOnly, SameSite=Strict cookie, stored only as SHA-256. 30-minute idle and 12-hour absolute expiry (7 days with "remember me"). Revoked on logout and on password change or reset.
  - Double-submit CSRF token (`XSRF-TOKEN` cookie + `X-XSRF-TOKEN` header) and an Origin check. Per-IP rate limits on sign-in and password reset. Security headers. RFC 9457 problem responses with the `code` values the UI expects.
  - Forced password change gate, change password, and forgot/reset password (single-use hashed token, 30 minutes; e-mail queued in `app.EmailOutbox` and sent later by the Phase 3 worker).
  - Dashboard summary from real data, scoped to the user's own meetings and recordings.
  - `setup-admin` operator command: creates the first SuperAdmin with a one-time password that must be changed. No credentials are seeded.
  - Audit entries for sign-in, sign-out, lockout, password change and reset, and admin creation.
- `backend/tests/OneInsure.Connect.Api.Tests`: 13 integration tests on a disposable LocalDB database.
- `frontend`: `npm run dev:api` (real API, no demo data). `npm run dev` stays in demo mode.

### Security
- Pinned `System.Security.Cryptography.Pkcs` 10.0.14: SqlClient pulled in a vulnerable 9.0.x (CVE-2026-84008).

### Fixed
- `deploy-database.ps1`: migrations path resolved correctly under `powershell -File` (Windows PowerShell 5.1).

## 0.2.0-phase2-db (unreleased) — 31 Oct 2026

### Recovery
- Recovered the project state after the laptop shut down unexpectedly: `documentation/DEVELOPMENT_RECOVERY_REPORT.md`.
- Took a secret-free source snapshot before making changes: `backups/recovery-snapshot-2026-10-31-pre-resume.zip` with a SHA-256 manifest.
- Re-ran the R2 benchmark and scenarios on mains power. These replace the T01 run that was aborted on battery.

### Added
- `database/`: migrations V001–V010 for `OneInsureVideoMeetingDB` (35 tables, 2 views, 5 procedures, roles, reference seed with no credentials), plus `deploy-database.ps1`, a hash-checked, transactional, idempotent runner.
- `tests/database/`: a disposable-database test driver and schema assertions covering integrity rules, reminder dedupe and claiming, availability and booking locks, recording ownership and verification rules, append-only evidence, and least-privilege role checks.

### Changed
- DATABASE_DESIGN.md rev 1.1: platform schema `sys` → `app` (`sys` is reserved by SQL Server), session token hash, guest columns, and the extra integrity rules.

## 0.1.0-phase1 — 30 Oct 2026

### Added
- Phase 1 report: BRD analysis, conflicts and gaps, Windows Server 2019 compatibility, recording options (R1/R2/R3), architecture, sitemap, roadmap.
- `SOFTWARE_LICENSES.md`, with licences verified against the source repositories.
- Database design for `OneInsureVideoMeetingDB` (35 tables, 2 views, 6 schemas).
- UI design system (tokens in CSS + TS), OneInsure Connect logo (SVG mark + wordmark), favicon, and OneInsure corporate logo integration.
- Frontend prototype: login, forgot/reset password, MFA, change password, account locked, session expired, access denied; app shell (collapsible sidebar, mobile drawer, header with page search, notifications, profile menu); dashboard with KPIs, schedule, charts and activity; honest "planned" pages for later modules.
- Dev-only demo adapter, excluded from production builds.
