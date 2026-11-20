# Chat module, Phase 4 (notes, tasks, reminders, My Day) and the iOS-style look: delivery note

**Built and tested on the test environment, 20 Nov 2026. DEPLOYED 20 Nov 2026, 09:39–09:46 IST, with "Notes, tasks and My Day" switched off (see CHANGELOG).**

Plan: `CHAT_MODULE_PHASE1.md` sections 5, 6, 7, 12 and 17. Requirement: sections 14–16 (notes, tasks and follow-up reminders, My Day).

## 1. iOS-style look for Chat and Calls

All chat and call screens now follow the iPhone look on every device: computers, Android phones, iPhones and the Android app.

- **Lettering and colours:**
  - System font: San Francisco on Apple devices, Segoe UI or Roboto elsewhere. No font files are downloaded.
  - iOS system colours.
  - Translucent top and bottom bars.
- **Chat list:**
  - Large "Chats" title.
  - Segmented control: Chats · Calls · My Day · Notes · Tasks.
  - iOS search field and filter chips.
  - Rows with thin separators, a two-line preview and a blue unread badge.
- **Conversation:**
  - Blue and grey bubbles with tails.
  - Reactions shown at the corner of the bubble.
  - A typing bubble with moving dots.
  - Header: "‹ Chats" with a centred avatar and name on phones.
  - iMessage-style composer: + to attach, a rounded field, emoji, and a round blue send arrow.
- **Message actions:**
  - Phones: tapping a message opens an iOS action sheet. It has quick reactions, then Reply, Copy, Forward, *Create task or reminder*, Edit, Delete and Cancel.
  - Computers: a toolbar appears on hover.
- **Menus:** the conversation menu and the status menu are iOS-style menus, with switches for "last seen" and "sounds".
- **Calls:**
  - Phones:
    - The incoming call fills the screen, with round red Decline and green Accept buttons.
    - The call screen also fills the screen: a large avatar and the timer, with mute, audio and add buttons and a red end button.
    - **Minimise** turns the call into a green pill at the top, so people can keep using the portal.
  - Computers: compact dark cards for both incoming and current calls.
- **Calls tab:** laid out like iOS Recents. Missed calls are shown in red, and each row has Message, Call again and Follow-up buttons.

Nothing outside Chat changed: the meeting room, dashboards and other pages look as before.

## 2. Notes, tasks, reminders and My Day (new, switch `CHAT_TASKS`)

### What employees get

- **My Day** (Chat › My Day):
  - The date and a greeting.
  - **Quick actions:** add task, add note, reminder, new chat, audio call, new group, meetings, schedule meeting, find people.
  - Counts for today, overdue, missed reminders and follow-ups.
  - **Missed reminders**, with Complete, In 1 hour, Tomorrow and Dismiss.
  - **Overdue** tasks.
  - **Today's tasks.**
  - **Meetings today**, each with *Follow up*.
  - **Upcoming reminders** for the next 7 days.
  - **Pending follow-ups.**
  - **Notes:** pinned notes and today's notes.
  - **Important chats:** pinned or unread.
  - **Recent calls**, each with *Follow up*.
- **Tasks:**
  - Smart lists like iOS Reminders: Today, Scheduled, Overdue, Follow-ups, All, Completed.
  - Search, plus a round tick to complete a task.
  - Each task has:
    - title and description;
    - priority (Low, Medium, High, Urgent);
    - due date with optional time;
    - reminder (at the due time, 5/15/30 min before, 1 h before, 1 day before, or a custom date and time);
    - repeat (daily, weekdays, weekly, monthly; completing the task creates the next one);
    - status (Pending, In progress, Completed, Postponed, Cancelled);
    - category (defaults plus your own);
    - notes;
    - related meeting, employee and chat.
- **Notes:**
  - Laid out like iOS Notes, with Pinned shown first.
  - Filters: All, Today, Pinned, Reminders, By date (a week strip), Completed, Archived.
  - Search across the title and text.
  - Pin, category, date, reminder, completed and archived.
  - A note can be linked to a meeting, an employee or a chat.
  - *Create follow-up task* from a note.
  - **Notes and tasks are private:** nobody else can see them, and the server answers "not found" to anyone else.
- **Follow-ups:** a task can be created straight from any of these, and it keeps a link to its source:
  - a chat message (the action sheet or toolbar), which keeps the message, sender and chat;
  - a chat (the ⋯ menu);
  - a call (Calls tab or My Day);
  - a meeting (My Day);
  - a note.

  Nothing is guessed automatically, and no AI is involved.
- **Reminder popup** on every portal page, styled like an iOS notification.
  - It shows the title, details, due time and priority.
  - Buttons: **Complete**, **Postpone** (5 min, 15 min, 30 min, 1 h, tomorrow 9:00, or custom), **Open task / Open note**, and Dismiss.
  - A soft chime plays, silent on Do not disturb or with sounds off. A browser notification also appears if the tab is in the background and notifications are allowed.
  - Answering a reminder in one tab closes it in the others.
  - There is also a bell entry, "Reminder: …".

### Reliability (server-side, never browser timers)

- `ChatReminderWorker` checks every 15 s.
  - It claims due reminders in one database statement, with row locks that skip rows another server already holds. **Each reminder fires exactly once**, even with two servers, and a test checks this.
  - The bell entry is written in the same transaction. The live popup is pushed after the transaction commits.
- **Away or offline:** reminders that fired while someone was away stay "unanswered". The popup shows them when the person opens the portal again, and My Day lists them under *Missed reminders*.
- **Switched off:** if `CHAT_TASKS` (or Chat) is off, reminders wait and fire when it is switched back on.
- Completing or cancelling a task closes its reminder, and deleted items never fire.

### Technical

- **Database:** `V030__chat_tasks.sql`.
  - Tables: `chat.MST_TaskCategory` (5 defaults), `chat.TRN_ChatTask`, `chat.TRN_ChatNote`, `chat.TRN_ChatReminder`.
  - Notification types `TASK_REMINDER` and `NOTE_REMINDER`.
  - Switch `CHAT_TASKS`, seeded **off**.
  - Rollback script: `V030__chat_tasks.rollback.sql`, tested.
- **API:** `Chat/ChatWork.cs`, under `/api/v1/chat`.
  - Endpoints: `categories`, `notes`, `tasks`, `tasks/{id}/status`, `reminders/due`, `reminders/upcoming`, `reminders/{id}/snooze|done|dismiss`, `my-day`, `work/meetings`.
  - Every id is checked against the owner. Links to meetings, chats, messages and calls are checked against what the person may see.
  - Limits: 5,000 notes and 5,000 open tasks per person.
- **Website:**
  - `pages/chat/work/*`: My Day, Tasks, Notes, the editors, the follow-up sheet and the reminder popup. All of it loads only when the switch is on.
  - `api/work.ts`.
  - Small additions to ChatPage, ConversationView, CallHistory, ChatProvider and AppLayout.
- **Privacy:** note and task text is not written to the audit log.

## 3. Tests (test environment)

- **Backend:** 114/114, including 8 new tests:
  - the switch;
  - privacy (404 for every action on someone else's items);
  - note and task create, edit and filters;
  - repeat with the reminder offset kept;
  - follow-up from a message (member and non-member) and from a call;
  - the reminder fires exactly once, then snooze fires again, then done;
  - catch-up after the switch was off;
  - My Day.
- **Browser, `tests/e2e/room/tasks.mjs`:** 7/7, on a computer and an Android phone.
  - Tabs and My Day on the phone.
  - A real server reminder pops up; Postpone 5 min, it pops up again, then Complete (one bell entry each time).
  - Follow-up from a chat message on the phone.
  - Notes: pin and search; private (404 for the other employee).
  - Catch-up: a reminder that fired while the person was away pops up when they return.
  - My Day: an overdue task is completed from there.
  - Switch off: tabs hidden and the API refuses.
- **Browser, `tests/e2e/room/ios-look.mjs`:** run on three screens: a computer (Edge), an **Android phone** (Chromium, Pixel 7 settings) and an **iPhone** (WebKit, the Safari engine, iPhone 14 settings).
  - Chat list and conversation; bubbles are iOS blue; no sideways scrolling.
  - Phone action sheet with a reaction saved.
  - iPhone full-screen incoming call with Decline.
  - Android full-screen call, then minimised to the pill.
  - Calls tab.
  - My Day, Tasks and Notes with the editor sheets on all three.
- **Regression** (all pass):
  - with Chat, Calls and Tasks off, as production is today: `room` 11/11, `refresh-rejoin` 6/6, `instant-link` 8/8, `mobile-audit` 8/8, `meeting-features` 12 passed / 1 not testable headless (as before), `android-app-present` 9/9;
  - with everything on: `chat` 10/10, `calls` 7/7 (twice in a row), `tasks` 7/7, `ios-look` 9/9, `mobile-audit` 8/8.

## 3a. Bug found and fixed in calls (Phase 3 code, deployed but switched off)

The new tests found two timing problems when a call is **declined within about a second**, while the caller's browser is still connecting the audio:
- the late "connected" signal overwrote "declined", so the call panel stayed on screen, and a false "could not be connected" message could appear;
- on a freshly opened page, "call ended" could arrive before the caller's own "call started" reply, leaving the caller on "Ringing…".

`CallProvider.tsx` now ignores a connection that finishes after the call has ended, and remembers recently ended calls. A dedicated check passed 9/9 times; `calls.mjs` passed 7/7 twice in a row.

The test `calls.mjs` also had its own timing issue: it checked for "Join here" before the reloaded page had asked the server. It now waits up to 15 s.

**Limit:** iPhone testing uses the Safari engine (WebKit) on this server, not a physical iPhone. A quick check on a real iPhone after deploy is recommended.

## 4. Switching on

Administration › Meeting Features:
1. **Chat**.
2. **Audio calls in Chat** (optional).
3. **Notes, tasks and My Day**.

## 5. Deploy steps (only on "deploy")

1. Pre-check, file backup and a verified database backup.
2. Apply `V030__chat_tasks.sql` on its own.
3. Publish the API, then `npm run build`.
4. Live checks.
