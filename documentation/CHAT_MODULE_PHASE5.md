# Chat module, Phase 5 (advanced chat): delivery note

**Built and tested on the test environment, 20 Nov 2026. DEPLOYED 20 Nov 2026, 11:15–11:25 IST, with "Advanced chat" switched off (see CHANGELOG).**

Plan: `CHAT_MODULE_PHASE1.md` section 17, approved on 20 Nov 2026. Requirement: section 17 (A–M).

## Requirement 17, item by item

| Item | Status |
|---|---|
| A. Message to task | Done in Phase 4 (follow-up from a message keeps the message, chat, sender, due date and status) |
| B. Scheduled messages | **New**: schedule, edit, cancel; sent at the time, exactly once |
| C. Important messages | **New**: save (star), pin, saved list with search |
| D. Conversation search | **Extended**: by person, chat, date range, files; only your own chats |
| E. Unread management | Done in Phase 2, plus **new** mention notifications and an "@" badge on chats |
| F. @Mentions | **New**: mention people, @all for group admins, a bell alert, highlighting |
| G. Threading (replies) | Done in Phase 2 (reply with a quote; tapping the quote jumps to the original) |
| H. Quiet hours | **New**: times, days, call setting, exceptions; meeting reminders always come through |
| I. Notification centre | **Extended**: the bell and Notifications page now include mentions and "added to a group", with icons for missed calls and task and note reminders |
| J. Presence | Done in Phase 2 and 3 (Available, Busy, Do not disturb, Away; automatic "In a meeting" and "In a call") |
| K. Favourites | **New**: favourite colleagues shown at the top of Chat |
| L. Call quality | Done in Phase 3 (connection, network quality, reconnecting) |
| M. Quick follow-up panel | **New**: overdue, today and this week, with one-tap complete or +1 day / +1 week |

## What employees get

- **Scheduled messages:**
  - In a chat, tap **+ › Schedule message**. Choose a time: in 1 hour, this evening, tomorrow 9:00, Monday 9:00, or any date and time.
  - A banner "N scheduled messages" above the composer opens the list, where each message can be changed or cancelled.
  - All scheduled messages are listed under the status menu › Scheduled messages.
  - They are sent by the server, even if the person is offline.
- **Save and pin:** message actions now include **Save** and **Pin**.
  - Saved messages appear under the **★ Saved** filter, with search.
  - Pinned messages show in a bar under the chat header. Tapping the bar jumps to the message and moves on to the next pin.
  - A small star or pin appears on the bubble.
- **@Mentions** in groups:
  - Typing **@** shows matching members, and **@all** for group admins.
  - Mentions are highlighted in the message, in orange when it's you.
  - The person gets a bell alert, even if they muted the chat, and the chat shows an **@** badge.
  - The **@ Mentions** filter lists recent mentions.
- **Search filters:** the sliders button next to Search filters by person, chat, date range and files only.
- **Favourites:** in a direct chat, ⋯ › Add to Favourites. Favourites appear at the top of Chat for one-tap chat and calling.
- **Quiet hours** (status menu › Quiet hours):
  - Settings: from–to times, days, calls (show silently, or ring as usual), and whether mentions and urgent reminders still make a sound.
  - During quiet hours, sounds and browser alerts are held back. Popups, the bell and messages are never lost, and meeting reminders always come through.
  - A moon next to the status shows quiet hours are on.
- **Quick follow-up panel:** the checklist button in Chat shows overdue tasks, today's and this week's. Each can be ticked, or moved +1 day or +1 week.

## How it works

- **Switch:** `CHAT_ADVANCED`, seeded **off**. Chat must be on; the follow-up panel also needs `CHAT_TASKS`.
- **Database:** `V031__chat_advanced.sql`.
  - New tables: `chat.TRN_ChatScheduledMessage`, `chat.TRN_ChatSavedMessage`, `chat.TRN_ChatPinnedMessage`, `chat.TRN_ChatMessageMention`, `chat.TRN_ChatFavourite`.
  - Quiet-hours columns added to `chat.MST_ChatUserPreference`.
  - Notification types `CHAT_MENTION` and `GROUP_ADDED`.
  - Rollback script: `V031__chat_advanced.rollback.sql`, tested.
- **API:** `Chat/ChatAdvanced.cs` and `ChatScheduledMessageWorker`, plus small additions to chat sending, search, status and preferences.
  - **Scheduled messages are sent exactly once:** the worker claims due rows with locks that skip rows another server holds. The message is written with the scheduled row's id as its "client message id", so a retry can never create a second copy.
  - Saving, pinning and mentions check chat membership as every other chat action does. Only group admins may use @all.
- **Website:**
  - New: `pages/chat/advanced/*` (Scheduled, PinnedBar, Mentions, Lists, Settings) and `pages/chat/quiet.ts`.
  - Changed: ConversationView, ChatPage, ChatProvider, CallProvider and ReminderCenter (quiet hours), the notification icons, and the Meeting Features page.

## Tests (test environment)

- **Backend:** 125/125, including 11 new tests (switch, scheduled messages and their exactly-once worker, saved, pins, mentions, group-added, search filters, favourites, quiet hours, follow-up panel).
- **Browser, `tests/e2e/room/advanced.mjs`:** 8/8, on a computer and an Android phone.
  - Schedule a message, which is delivered once; a cancelled one is never sent.
  - Save and pin on the phone; Saved search; the pinned bar on both screens.
  - An @mention: picker, highlight, bell entry, "@" badge, and @all allowed only for an admin.
  - Search by person and files only.
  - Favourites.
  - Quiet hours.
  - Follow-up panel: +1 day, then complete.
  - Switch off: extras hidden and the API refuses.
- **Regression:** see the CHANGELOG when deployed.

## Switching on

Administration › Meeting Features › **Advanced chat** (Chat must be on).

## Deploy steps (only on "deploy")

1. Pre-check, file backup and a verified database backup.
2. Apply `V031__chat_advanced.sql` on its own.
3. Publish the API, then `npm run build`.
4. Live checks.
