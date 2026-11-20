# OneInsure Connect: Chat, Calls, Notes and Tasks module

## Phase 1: inspection and architecture (for approval)

**Status:** proposal only. No code, database or configuration was changed.

**Date:** 19 Nov 2026.

**Source:** `E:\deploy\oneinsure-chat\oneinsure-chat\Requirment.txt`.

**What was inspected:**
- the whole `oneinsure-chat` folder (backend, frontend, schema, sockets, uploads);
- the MeetIQ backend, frontend, database migrations, LiveKit setup, notifications, auth, workers and tests;
- this server's capacity.

---

## Summary

1. **The old `oneinsure-chat` app cannot be plugged in as it is.** Its server runs on Node/Express with PostgreSQL. MeetIQ runs on ASP.NET Core with SQL Server and LiveKit.
   - Its chat part covers only about 900 of its 9,000 lines. It has no emoji, reactions, delivered status, search, pinning, audio calls or scheduler.
   - It has serious security holes. Any user can listen to any group. Uploaded files are public and can carry script. File deletion allows path traversal. Message replies leak other people's messages.
   - **What we reuse:** its screen layouts and message-bubble design, its event list, and its data-model ideas. The server side is rebuilt inside MeetIQ.
2. **MeetIQ already has most of the building blocks**, so the module needs very little new infrastructure:
   - sign-in and permissions;
   - the employee directory and employee picker;
   - the notification bell;
   - background workers with safe job claiming;
   - the audit log;
   - feature switches;
   - LiveKit, which already handles audio-only rooms, for calls.
3. **Three things are genuinely new:**
   - **A live push channel.** MeetIQ has none outside meeting rooms; the bell is polled every 60 s. Proposed: **SignalR**. It is built into ASP.NET Core, so nothing is added on the server. IIS WebSockets are already installed.
   - **File uploads.** MeetIQ has none today.
   - **New tables** for chat, calls, notes and tasks.
4. **Only one new package: `@microsoft/signalr`** (MIT licence, Microsoft) in the website. There is no paid service, cloud account or external API. Emoji are native Unicode from our own list, and the ringtone is generated in the browser.
5. **Existing meetings, recording and screen sharing stay untouched.** The few existing files that must change are listed in section 13, each with the reason and how it is protected. The whole module sits behind an on/off switch, so it can be turned off without a deploy.

---

## 1. Architecture overview

```
Browser / Android app (WebView)
 ├─ existing pages (meetings, recordings, admin …)        unchanged
 └─ NEW /chat workspace (lazy-loaded)
      ├─ REST  /api/v1/chat/*  ─┐
      └─ SignalR /api/v1/hubs/chat (WebSocket) ─┐        same IIS site, same /api proxy rule
                                                ▼
ASP.NET Core API (MeetIQApi service, 127.0.0.1:58100)
 ├─ existing endpoints / workers                           unchanged
 ├─ NEW Chat endpoints + ChatHub (session cookie auth, membership checks)
 ├─ NEW ReminderDispatchWorker, ScheduledMessageWorker, FileScanWorker
 └─ LiveKit (existing server 7880) ← NEW call tokens, audio-only "oic_call_*" rooms
SQL Server Oneinsure_v ← NEW schema `chat` (MST_/TRN_ tables)
Local disk ← NEW Chat:StorageRoot (outside the web root), opaque file names
```

- **Single server.** The API runs as a single instance, so SignalR needs no backplane such as Redis.
- **Every message is saved in the database before it is pushed.** The push is only a fast notice: clients that missed it catch up from the database when they reconnect.

## 2. What `oneinsure-chat` actually contains

| Area | In the code | Problems found |
|---|---|---|
| Stack | Node 20, Express, Prisma on **PostgreSQL**, Socket.IO, React 18, Tailwind 3 | Postgres-only types (arrays, JSON, case-insensitive search) |
| Login | Own employee table, JWT kept 7 days in localStorage | No rate limit or revocation; token can travel in the URL |
| Direct chat | Works (send, reply, edit, soft delete, typing) | Reply id not checked, so **anyone can read any message by id** |
| Groups | Create, add or remove members, rename, leave | **Any user can join any group's live room**; removed members keep receiving |
| History | Pages of 50 | **Broken**: loads the oldest 50, so newer messages vanish once a chat passes 50 |
| Read status | Direct chats only, only when history is loaded | Spoofable; not shown in groups; no "delivered" |
| Presence | Online/offline broadcast to everyone | Closing one tab shows the person offline; last seen never shown |
| Files | 50 MB, saved under the original extension, served **publicly** | **Stored XSS** (HTML uploaded as an image), **delete with path traversal**, no download check |
| Emoji, reactions, search, pin, forward | None (only empty columns) | — |
| Calls | None from chat. A separate mesh-WebRTC meeting page uses Google STUN only | Not usable (no TURN); MeetIQ already has LiveKit |
| Reminders | Rows written, **never sent** | No scheduler |
| Other modules | Issues, projects, sprints, tasks, analytics, admin | **No authorization checks**; not in the requirement |

**Reuse, adapted to MeetIQ's React 19, TypeScript and design system:**
- the two-pane chat layout and conversation-list item;
- `MessageBubble` (message types, reply preview, ticks, hover menu);
- the create-group dialog and group info panel;
- the date, size and initials helpers;
- the event vocabulary.

**Not reused:** the Node server, Prisma, Socket.IO server, uploads, JWT login, mesh WebRTC, and the issues/projects modules. Section 17 covers whether the old app's issues/projects modules should be brought over.

## 3. Reusable MeetIQ components

| Need | Reused as is |
|---|---|
| Sign-in, sessions, MFA, daily logout | `SessionAuthentication.cs`, `oic_session` cookie, `RequirePermission` |
| CSRF | `UseCsrfProtection` (XSRF header, automatic in `api/http.ts`) |
| Rate limiting | built-in limiter (`Program.cs`); new per-user policies |
| Employee directory | `org.Employees` ↔ `auth.Users.EmployeeId`; `GET /employees/lookup`; `EmployeePicker.tsx` |
| Notifications bell | `mtg.MeetingNotifications`, `NotificationEndpoints`, `NotificationsPage` |
| Background jobs | `BackgroundService` pattern with lease + READPAST claims (as `ReminderWorker`) |
| Audit | `Audit.WriteAsync` → `app.AuditLog` (append-only) |
| On/off switch | `app.FeatureSettings` + Admin › Meeting features page |
| Audio media | LiveKit server, `LiveKitTokens`, `LiveKitRoomService`, signed webhooks |
| UI | `components/ui` (Button, Dialog, Avatar, Badge, Tabs, Toast, EmptyState, Skeleton …), theme tokens, lucide icons, `motion` |
| Browser alerts | `hostAlerts.ts` (permission on a click, Web Audio chime, tab-title flash) |
| Tests | xUnit `ApiFixture` (throwaway LocalDB), Playwright harness `tests/e2e/room/harness.mjs` |

## 4. Existing functionality that is extended

- **Left menu** (`navigation.ts`, `Sidebar.tsx`): a new **Chat** item directly below **Meetings**, plus an optional badge field for the unread count.
- **Phone bottom tabs** (`MobileTabBar.tsx`): add Chat. This is decision D2.
- **Notification bell**: new types for missed calls, mentions, reminders and being added to a group. Unread chat messages show on the Chat badge instead, so the bell is not flooded.
- **LiveKit webhook**: events for call rooms (`oic_call_*`) go to the call log. Meeting rooms follow exactly the current path.
- **My Day**: shows today's meetings and meeting-minutes action items assigned to me, read-only from the existing tables. Nothing is duplicated.

## 5. New modules

| Module | Backend (new folder `Chat/`) | Website (new folder `pages/chat/`) |
|---|---|---|
| Conversations and messages | `ChatEndpoints`, `ChatService`, `ChatAccess` (a single membership check) | Workspace, conversation list, message list, composer |
| Real-time | `ChatHub`, `PresenceTracker` | `ChatProvider` (one connection per tab) |
| Files | `ChatFileEndpoints`, `FileInspector` (content check), `FileScanWorker` | Drag and drop, progress, previews |
| Calls | `CallEndpoints`, `CallService`, webhook handler for call rooms | Incoming-call popup, call bar, call history |
| Notes, tasks, reminders | `NotesEndpoints`, `TasksEndpoints`, `ReminderDispatchWorker` | Notes, Tasks, My Day, reminder popup with snooze |
| Advanced (Phase 5) | `ScheduledMessageWorker`, saved and pinned messages, search | Saved items, scheduled messages, quiet hours |

## 6. Database (Oneinsure_v, new schema `chat`)

### How the tables are set up

- **Naming:** the `MST_` / `TRN_` prefixes your requirement asks for, inside a new `chat` schema. The schema gives the module its own permission grant, as V009 does for each schema, and keeps it apart from the existing tables.
- **Existing conventions followed:**
  - keys: BIGINT identity, plus a `PublicId` GUID (the only id the API exposes);
  - times: UTC `DATETIME2(3)`;
  - columns: `CreatedUtc`, `RowVersion`, `IsActive`;
  - constraint names: `PK_`, `FK_`, `UX_`, `IX_`, `CK_`;
  - status values: CHECK lists.
- **Migrations:** V028 onward, run by `deploy-database.ps1`. Each one is additive only, has a rollback script in `database/rollback/`, and **never drops or truncates an existing table**.
- **Users:** the existing `auth.Users.UserId` (which maps to `org.Employees`). There is no second employee table.

**Masters**

| Table | Why |
|---|---|
| `chat.MST_ChatFileType` | Allowed file types: extension, allowed content types, file signature, max size, active flag. Admin-editable, so allowing ZIP needs no code change |
| `chat.MST_ChatUserPreference` | Per person: availability (Available / Busy / DND / Away), show last seen, sounds on/off, ringtone volume, quiet hours |
| `chat.MST_TaskCategory` | Default categories plus each person's own |

**Transactions**

| Table | Key columns / notes |
|---|---|
| `chat.TRN_ChatConversation` | Type DIRECT / GROUP; group name, description, image; `DirectKey` (unique per pair, so one chat per two people); last message pointer for fast lists |
| `chat.TRN_ChatConversationParticipant` | Role ADMIN / MEMBER; joined and left times; **read and delivered marks** (last message id read or delivered); pinned, muted (until), archived, marked unread |
| `chat.TRN_ChatMessage` | Conversation, sender, Kind TEXT / FILE / SYSTEM / CALL, Body up to 4,000 chars, reply-to, forwarded-from, edited and deleted times, **`ClientMessageId`** (unique per sender: retries never create duplicates). Index (ConversationId, MessageId DESC) for paging |
| `chat.TRN_ChatMessageMention` | Message, mentioned user (or @all) |
| `chat.TRN_ChatMessageReaction` | Message, user, emoji; unique per user and emoji |
| `chat.TRN_ChatFile` | Original name, extension, checked content type, size, SHA-256, **opaque storage key**, scan status PENDING / CLEAN / BLOCKED, uploader, deleted time |
| `chat.TRN_ChatCall` | DIRECT / GROUP, conversation, started by, LiveKit room, status RINGING / ACTIVE / ENDED / MISSED / DECLINED / FAILED, times |
| `chat.TRN_ChatCallParticipant` | Invited by, state INVITED / RINGING / ACCEPTED / DECLINED / MISSED / BUSY / LEFT, invited, joined and left times |
| `chat.TRN_ChatNote` | Owner, title, body, category, pinned, completed, archived, reminder time; optional links to a meeting, task, conversation or employee |
| `chat.TRN_ChatTask` | Owner, title, description, priority LOW / MEDIUM / HIGH / URGENT, status PENDING / IN_PROGRESS / COMPLETED / POSTPONED / CANCELLED, due time, category, repeat rule, links (meeting, employee, conversation, **source message**, source call, note) |
| `chat.TRN_ChatReminder` | For tasks and notes: due time, state PENDING / FIRED / DONE / CANCELLED, snoozed-until, fired time, **lease columns** (sent exactly once) |
| `chat.TRN_ChatSavedMessage` (Phase 5) | Starred or saved messages per user; messages pinned in a conversation |
| `chat.TRN_ChatScheduledMessage` (Phase 5) | Draft, send time, state, sent message id (sent exactly once) |

### Suggested tables not created, and why

- **`TRN_ChatMessageRead`:** a row per message per reader grows very fast. Read and delivered marks on the participant row give the same ticks and "read by" with one row per person per chat.
- **`TRN_ChatPresence`:** "online" lives in memory, where it is correct within seconds. Last seen and the chosen availability go in `MST_ChatUserPreference`.
- **`TRN_ChatNotification`:** the existing bell table is reused.
- **`TRN_ChatAuditLog`:** the existing append-only `app.AuditLog` is reused.
- **`TRN_ChatCallEvent`:** the participant times plus the audit log cover it.
- **`MST_ChatGroup` and `TRN_ChatGroupParticipant`:** a group is a conversation of type GROUP.
- **Status and priority master tables:** short CHECK lists, as the rest of MeetIQ does.

### Changes to existing database objects

| Object | Change |
|---|---|
| `mtg.MeetingNotifications` | Replace the Type CHECK to add `CHAT_MENTION`, `MISSED_CALL`, `TASK_REMINDER`, `NOTE_REMINDER`, `GROUP_ADDED` (all existing values kept) |
| `auth.Permissions` / `auth.RolePermissions` | New `chat.use`, granted to every role by default; it can be removed per role |
| `app.FeatureSettings` | New `CHAT` row (on/off) |

Each of these follows the V026/V027 pattern and has a rollback script.

## 7. APIs (all under `/api/v1`, session required, `chat.use`)

| Group | Endpoints |
|---|---|
| Directory | `GET /chat/people?search=` (name, code, department, designation; email only if permitted, see D8; with presence) |
| Conversations | `GET /chat/conversations?filter=all\|unread\|pinned\|groups\|archived`; `POST /chat/direct {employeeId}`; `POST /chat/groups`; `GET/PATCH /chat/conversations/{id}`; `POST …/{id}/pin \| mute \| archive \| mark-unread \| read` |
| Members | `GET/POST /chat/conversations/{id}/members`; `DELETE …/members/{userId}`; `POST …/members/{userId}/role` |
| Messages | `GET /chat/conversations/{id}/messages?before=&after=&limit=` (keyset paging); `POST` (with `clientMessageId`); `PATCH/DELETE /chat/messages/{id}`; `POST/DELETE /chat/messages/{id}/reactions`; `POST /chat/messages/{id}/forward` |
| Search | `GET /chat/search?q=&conversation=&from=&to=&sender=&files=` (only your own chats) |
| Files | `POST /chat/conversations/{id}/files` (upload); `GET /chat/files/{id}` (download, member check every time); `GET /chat/files/{id}/preview` (images only) |
| Calls | `POST /chat/calls {conversationId \| employeeIds}`; `POST /chat/calls/{id}/accept \| decline \| leave \| end \| invite`; `GET /chat/calls?search=` (history) |
| Presence and settings | `GET/PUT /chat/me/preferences` |
| Notes, tasks, reminders | `GET/POST/PATCH/DELETE /chat/notes`, `/chat/tasks`; `POST /chat/reminders/{id}/snooze {minutes \| untilUtc}`, `…/done`; `GET /chat/my-day` |
| Phase 5 | `/chat/saved`, `/chat/scheduled` |

Every endpoint that names a conversation, message, file, call, note or task checks on the server that the caller may access it. The API exposes only PublicIds, never internal ids or file paths.

## 8. Real-time (SignalR)

- **Hub:** `/api/v1/hubs/chat`, inside the existing `/api` proxy rule, so `web.config` needs no new rule.
- **Sign-in:** the same session cookie as the rest of the site.
- **Origin check:** the hub accepts only our own site address (CSRF protection for the WebSocket).
- **Connections:** one per browser tab. On connect, the server adds the connection only to the groups the database says the person belongs to.
- **Server → client events:**
  - messages: `message.new`, `message.updated`, `message.deleted`, `message.reaction`;
  - read status: `receipt.delivered`, `receipt.read`;
  - conversations: `conversation.updated`, `conversation.added`, `conversation.removed` (removal takes effect at once: the server drops all of that person's connections from the group);
  - people: `presence.changed`, `typing`;
  - calls: `call.incoming`, `call.updated`, `call.ended`, `call.participant`;
  - bell: `reminder.due`, `notification.new`.
- **Client → server:** only `typing` and `presence.heartbeat`. Everything that changes data goes through the REST API, so validation, rate limits and the audit log live in one place.
- **Reliability:**
  - messages are saved first; `clientMessageId` removes duplicates when a send is retried;
  - after reconnecting, the client asks for messages newer than the last one it has;
  - every event carries ids, so applying one twice changes nothing;
  - messages from your other tabs appear too, because they are pushed to all of your connections.
- **Presence:**
  - you are online while at least one tab is connected;
  - the keep-alive is 15 s and the timeout 30 s, so a closed laptop or lost network shows offline within about 30 s;
  - last seen is the time your last connection ended;
  - "In a meeting" comes from the existing attendance table, which LiveKit webhooks keep up to date; "In a call" comes from the call table.
- **Daily logout and sign-out** close that person's hub connections.

## 9. File storage

- **Location:** `Chat:StorageRoot` on the server's own disk, outside the website folder, laid out as `yyyy/MM/<random 32-hex>`. There is no file extension and no original name on disk, and the database stores only the key.
- **Upload checks (server side; nothing the browser says is trusted):**
  - the extension must be in `MST_ChatFileType`;
  - the **file signature (magic bytes)** must match the extension;
  - size per type, default 25 MB (decision D3);
  - per-user rate limit;
  - Windows executables, scripts, `.html`/`.svg` and Office files with macros (`.docm`, `.xlsm`) are refused;
  - the file name is cleaned.
- **Antivirus:** Windows Defender is on this server. Each file is scanned with `MpCmdRun.exe -Scan -ScanType 3 -File …`. Until the scan says CLEAN, the file shows as "Checking…" and cannot be downloaded; infected files are blocked and audited. This is free and needs no external service; the service account's rights are confirmed in Phase 2.
- **Download:**
  - only through `GET /chat/files/{id}`, which checks membership each time;
  - sent as `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` and a sandbox content policy;
  - only images (PNG, JPEG, GIF, WebP) and PDFs open inline;
  - access to files is audited.
- **Previews:**
  - images as thumbnails;
  - PDFs in the browser's own viewer;
  - text and CSV as plain text (first 200 KB);
  - Word, Excel and PowerPoint: **download only**. A free preview without an external service, such as Office Online, isn't possible.
- **Disk:** about 150 GB free per drive today. The admin sets a size cap per file, and there is an optional retention period (decision D9).

## 10. Audio calls

- **Uses the existing LiveKit server.** There is no new media server and no paid TURN.
  - Each call is its own audio-only room `oic_call_<random>`.
  - Tokens allow **microphone only**: no camera, screen or data.
  - Tokens are short-lived and issued only to people invited to that call.
- **Flow:**
  1. The caller calls `POST /chat/calls`.
  2. The server creates the call and the invitations, then pushes `call.incoming` to every open tab of each invitee.
  3. Each invitee sees the popup and hears the ringtone.
  4. **Accept** returns a LiveKit token. Accepting in one tab stops the ringing in the person's other tabs.
  5. If nobody answers in 45 s, the call is marked **Missed**, and a bell notification and a chat line "Missed call" are added.
- **Busy:** someone already in a call or meeting gets a "Busy" status; the caller sees "Busy". Their current call is never interrupted.
- **Group calls:**
  - start from a group chat;
  - invite more people at any time ("Add participants": search, invite, they accept);
  - participant list with speaking indicators.
  - **Cap: 10 per call to start (decision D4).** It is raised only after a load test on this server. No unlimited capacity is claimed.
- **Controls:**
  - mute and unmute; microphone and speaker selection (where the browser allows);
  - duration, status, connection quality (good, weak, reconnecting);
  - end or leave.
  - The call stays connected while you move between portal pages: the call bar lives in the page layout.
- **Ringtone:** an original tone generated with Web Audio (no audio file, no copyright). It plays only if the browser allows sound; otherwise the popup still shows and the tab title flashes. It can be muted in preferences.
- **Call log:** from the call and participant tables, kept up to date by LiveKit webhooks for `oic_call_*` rooms only. It holds metadata only. **Calls are never recorded.**
- **Network:** calls use the same ports as meetings (TCP 7881 / UDP 7882), so they work wherever meetings already work.
- **Limit:** there is no ringing while the portal is closed. Waking a closed browser needs "web push", which goes through Google's or Apple's push servers. Those are third-party services, so this is not proposed.

## 11. Security

- **Authentication:** the existing session cookie only; no new login. Every API call and the hub check the session as today.
- **Authorization:** a single server-side helper, `ChatAccess`, answers "can this user see or act on this conversation / message / file / call / note / task?". Every endpoint and hub action uses it, which protects against IDOR. Notes and tasks are visible only to their owner.
- **Input:**
  - parameterised SQL (Dapper) only;
  - length limits on every field;
  - control characters stripped;
  - messages shown as **plain text**: links made clickable safely, no HTML.
- **CSRF:** the existing XSRF check for REST, plus the origin check on the hub.
- **Rate limits per user:** sending (for example 30 messages per 10 s), uploads, starting calls, and search.
- **Audit:** group created; members added or removed; admin changes; file downloads and deletions; blocked files; calls started, accepted and ended; preference changes. **Message text is never logged.**
- **Privacy:** last seen can be hidden; email is not shown in search unless decision D8 allows it; notes are private.
- **Group admins:** the last admin cannot leave without choosing a new one.

## 12. Screens and layout

- **Chat workspace** (`/chat`, inside the normal portal frame):
  - **left column:** search, New chat, New group, and tabs All / Unread / Groups / Pinned. Below them, the conversation list with avatar, presence dot, last message, time and unread count, then Favourites / Online.
  - **centre:** a header with name, presence or last seen, Audio call, Add people, Search in chat and Info. Then the messages, grouped by day, with replies, reactions, ticks (sent, delivered, read), files and images, a "new messages" line and "jump to latest". Then the composer with emoji, attach (drag and drop), reply preview and mentions.
  - **right panel (optional):** group info, members with presence, files shared, pinned messages.
  - **section tabs:** Chats · Calls · My Day · Notes · Tasks.
- **Phones:** a single column. The list opens the conversation, and Back returns. Large touch targets, and the composer stays above the keyboard. It works in the Android app too.
- **Incoming call:** a card at the top right on a computer, or full-width on a phone, above everything. It shows the avatar, name, employee code and "Audio call", with **Accept** and **Decline**. It does not block navigation.
- **Reminder popup:** title and details, with **Complete**, **Snooze** (5 min, 15 min, 30 min, 1 h, Tomorrow, Custom…) and **Open**.
- **States:** loading skeletons, empty states, error states with retry, keyboard navigation, and screen-reader labels.
- **Theme:** MeetIQ has no dark mode today, so the module matches the current light theme. Dark mode would be a separate change across the whole site.
- **Existing meeting screens are not changed.**

## 13. Existing files that would change

All other work is in new files.

| File | Change | Why | Risk / protection |
|---|---|---|---|
| `frontend/src/layouts/navigation.ts` | Add the Chat item below Meetings; optional `badge` field | Menu entry | Additive; other items unchanged |
| `frontend/src/layouts/Sidebar.tsx` | Show the unread badge | Badge | Only renders when the badge is set |
| `frontend/src/layouts/MobileTabBar.tsx` | Chat tab (D2) | Phone access | e2e `mobile-audit` re-run |
| `frontend/src/App.tsx` | `/chat/*` route, lazy-loaded | Page | Chat code is not loaded by other pages |
| `frontend/src/layouts/AppLayout.tsx` | Mount `ChatProvider` (connection, call popup, call bar, reminder popup) | Calls and reminders on any page | Does nothing when the CHAT switch is off; an error boundary keeps a chat fault from breaking the page |
| `frontend/src/pages/notifications/NotificationsPage.tsx` | Icons and links for the new types | Bell | Additive |
| `frontend/package.json` | Add `@microsoft/signalr` | Live push | Single new package |
| `backend/.../Program.cs` | `AddSignalR`, `MapHub`, new endpoints, workers, rate-limit policies | Wiring | Additive registrations; existing order kept |
| `backend/.../Security/DailyLogout.cs` (and sign-out) | Close the person's hub connections | Security | Existing logout unchanged; one extra call |
| `backend/.../Meetings/LiveKitWebhookEndpoints.cs` | Hand `oic_call_*` room events to the call service, at the very top | Call log | Meeting rooms take exactly today's path; covered by existing webhook tests plus new ones |
| `backend/.../Meetings/LiveKit.cs` | Add `CreateCallToken` (microphone only) | Calls | New method; existing tokens unchanged |
| `backend/.../Meetings/RoomFeatureEndpoints.cs` + `MeetingFeaturesPage.tsx` | Add the `CHAT` switch | On/off | Additive key |
| `database/migrations/V028…` + `database/rollback/…` | New schema and tables, notification types, permission, switch | Data | Additive; rollback scripts |

**Not changed:** meeting creation, scheduling or joining; the meeting room; recording; screen sharing; the Android app; existing tables (apart from one CHECK list); and authentication.

## 14. New dependencies

| Package | Where | Licence | Commercial use | Maintained | Paid service or account? | Why |
|---|---|---|---|---|---|---|
| `@microsoft/signalr` 8.x/9.x | website | MIT | Yes; keep the licence notice | Microsoft, active | No | Client for the live channel; handles reconnects |
| SignalR server | API | MIT (part of ASP.NET Core) | Yes | Microsoft | No | **Already included**, nothing to install |
| Emoji | — | Unicode (no package) | — | — | No | Our own curated list of about 300 common emoji, with recently used ones remembered |
| Ringtone | — | Generated in code | — | — | No | Web Audio tone |
| Windows Defender | server | Part of Windows | — | — | No | File scan (already on) |

There are no others. If a later phase seems to need one, it comes back for approval first.

## 15. Performance and server impact

| Item | Measured / expected |
|---|---|
| Server | 16 cores / 32 threads, 27% load at the time of the check. **128 GB RAM but only about 13 GB free**: something else on this machine uses most of it. This should be checked before group calls go live |
| Disk | C: 195 GB, E: 154 GB, F: 152 GB free |
| API | About 220 MB today. SignalR adds a few KB per open tab, so roughly 10–50 MB for several hundred users |
| Database | Keyset paging, last-message pointers and read marks keep the list and badge to one indexed query. **No polling for chat**: everything is pushed |
| Audio calls | About 30–50 kbit/s per speaker through LiveKit. A 10-person call is light compared with a video meeting. **Group-call capacity will be measured with a load test**, not assumed |
| Network | Same ports as meetings; nothing new to open |
| Search | `LIKE` over your own chats with date and sender filters, paged. SQL Server full-text search can be evaluated later if needed |
| Session check | Every API call already runs one session query. The hub checks the session at connect and every few minutes, not per message |

## 16. Risks

| Risk | Mitigation |
|---|---|
| A fault in the new code affects the portal | Lazy-loaded page, error boundary, CHAT switch for instant off, additive-only database changes, full regression run before each deploy |
| WebSocket through IIS for `/api` | IIS WebSockets are installed and already proxy `/rtc`. Verify on the test site first; if WebSocket fails, SignalR falls back to long-polling automatically |
| Low free memory on the server | Measure before Phase 3; start group calls capped at 10 |
| Browser blocks the ringtone | Visual popup, tab-title flash and the browser notification (permission asked on a click) |
| No ringing when the portal is closed | Missed-call notification and chat line; web push not proposed (third-party) |
| File abuse or malware | Signature check, block list, Defender scan before download, attachment-only download, audit |
| Storage growth | Per-file size cap, optional retention period, admin view of usage |
| Notification CHECK change on an existing table | Every existing value kept; rollback script; covered by notification tests |
| Webhook change | Call rooms branch off first by name prefix; meeting webhook tests must still pass |
| Remote database latency | Small indexed queries; message send is one insert plus one update |

## 17. Roadmap

Each phase ends with tests, a demo on the test site, and your approval before deploy.

| Phase | Scope | Done when |
|---|---|---|
| **2. Chat** | Schema V028 (conversations, messages, participants, reactions, mentions, files, file types, preferences); SignalR hub; Chat menu with badge; people search; direct and group chat; reply, edit, delete, forward, copy, react, emoji; read/delivered ticks; unread, pin, mute, archive, mark unread; files with Defender scan; search in chat; presence and last seen | New API and e2e tests pass; regression suite passes |
| **3. Calls** | Call tables; call tokens; incoming popup and ringtone; 1:1 and group audio calls; add participants mid-call; busy handling; call history; webhook handling; load test of group calls on this server | Two-browser and multi-browser call tests; measured capacity reported |
| **4. Notes, tasks, My Day** | Notes, tasks, reminders worker (sent once, catch-up when you return), snooze, My Day, message/call/meeting → task, new bell types | Reminder tests incl. offline and duplicate prevention |
| **5. Advanced** | Scheduled messages, saved and pinned messages, conversation-wide search, @all, quiet hours, favourites, quick follow-up panel | Feature tests |
| **6. Testing** | Full regression and security tests (below), phones (Android and iPhone) | Test report |
| **7. Delivery** | File lists, scripts, configuration, deploy and rollback steps | Your sign-off |

**Not included unless you ask:**
- the old app's Issues / Projects / Sprints / Analytics modules (not in the requirement, and they have no access control);
- video calls from chat (the requirement asks for audio only);
- calls to phone numbers;
- web push;
- AI features.

## 18. Regression test plan

**Existing tests, all re-run before every deploy:**
- backend: 96 xUnit tests;
- browser, room harness: `room`, `refresh-rejoin`, `instant-link`, `goodday-*`, `screen-share-view`, `screen-share-mobile`, `mobile-audit`, `mobile-join-devices`, `meeting-features`, `meeting-minutes`, `android-app-present`, `recording-board-poll`;
- browser, scenario runner `tests/e2e/scenarios/01–11` (login, MFA, meetings, recordings, admin, errors).

They cover:
- login and logout;
- meetings: create, schedule, instant, join, host controls, screen sharing;
- recording and the recording library;
- notifications;
- the external API and webhooks.

**New tests:**

| Area | Tests |
|---|---|
| Chat (API) | Direct or group create; send and receive; duplicate `clientMessageId`; paging older and newer; edit/delete rules; reactions; mentions; read and delivered marks; pin, mute, archive, unread |
| Security (API) | Outsider gets 404/403 on every conversation, message, file, call, note and task id; removed member loses access at once (REST and live); group admin rules; rate limits; upload of `.exe`, `.html`, `.svg`, macro files, renamed files and a too-large file refused; EICAR test file blocked by Defender; download without membership refused; no file paths in responses |
| Real-time (browser) | Two or three browsers: live delivery, ticks, typing, presence (tab closed → offline within about 30 s, last seen correct), several tabs, reconnect catch-up |
| Calls (browser) | Ring, accept, decline, missed (45 s), busy, mute/unmute, end, group call, add participant mid-call, reconnect, call history entries |
| Notes and tasks | CRUD; private to owner; reminder fires once; snooze options; fires on return after being offline; no duplicates after an API restart |
| Screens | Desktop, laptop, tablet, 390 px phone, Android app; keyboard only; no horizontal overflow |

---

## Decisions needed from you

| # | Question | Recommendation |
|---|---|---|
| D1 | Table names: `chat.MST_…` / `chat.TRN_…` in a new `chat` schema? | **Yes**: follows your prefix rule and MeetIQ's per-schema permission grants |
| D2 | Phone bottom bar has 5 tabs today (Home, Meetings, New, Calendar, Alerts). Where does Chat go? | **Replace Calendar with Chat**; Calendar stays in the menu |
| D3 | File size limit and ZIP? | **25 MB**; ZIP allowed (scanned by Defender), can be turned off |
| D4 | Group call size to start? | **10**, raised after the load test |
| D5 | Edit and delete own messages? | Edit within **15 min**; "delete for everyone" within **1 hour**, shown as "Message deleted" |
| D6 | Who can create groups? | **Every employee**; the group creator is admin |
| D7 | Can a person turn off "last seen"? | **Yes** (then they also don't see others' last seen) |
| D8 | Show email in people search? | **No**: name, code, department and designation only, as the meeting picker does today |
| D9 | Keep chat messages and files how long? | **Keep** by default; an admin retention setting (for example delete files after N days) |
| D10 | Old app's Issues / Projects / Analytics modules? | **Not now**: not in the requirement |

On approval (with any changes to D1–D10), Phase 2 starts on the test environment. Nothing goes to production without your "deploy".
