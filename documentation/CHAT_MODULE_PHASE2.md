# Chat module, Phase 2 (chat): delivery note

**Built and tested on the test environment, 20 Nov 2026. Not deployed.**

Plan: `CHAT_MODULE_PHASE1.md`, approved on 20 Nov 2026 with decisions D1 to D10.

## What employees get

- **Chat in the menu,** directly below Meetings. On phones it replaces Calendar in the bottom bar (D2), and it shows an unread badge.
- **Starting chats:**
  - direct chats, by searching a colleague by name, employee code, department or designation (no e-mail shown, D8);
  - group chats, with name, description and picture. Admins add or remove people and make others admin. People added later see messages from then on. The last admin can't leave without naming another.
- **Messages:**
  - live delivery, with ticks for sent, delivered and read;
  - typing indicator;
  - reply, react (emoji), copy, forward (up to 10 chats);
  - edit your own message within 15 minutes, or delete it for everyone within 1 hour (D5);
  - emoji picker with search and recently used.
- **Organising chats:**
  - unread counts, pin, mute (8 h, 1 week, always), archive, mark as unread;
  - search across all your chats (messages and file names), and search inside a chat that jumps to the result.
- **Files:**
  - drag and drop, paste, or choose a file, with upload progress;
  - picture previews; PDFs open in the browser; everything else downloads.
  - Files are checked by **Windows Defender before anyone can download them**. A blocked file shows as blocked.
- **Presence:** Online, Busy, Do not disturb, Away, In a meeting, or "Last seen …". Last seen can be hidden, and then you also don't see others' (D7). There's a new-message sound, which can be switched off.

## How it is built

- **API:** `backend/src/OneInsure.Connect.Api/Chat/`
  - `ChatCore.cs`: access rules, presence, live push;
  - `ChatHub.cs`: SignalR hub plus a 30-second session check;
  - `ChatEndpoints.cs`: REST API;
  - `ChatFiles.cs`: uploads, content checks, Defender scan worker, downloads.
- **Database:** `database/migrations/V028__chat.sql` adds the new schema `chat` (7 tables, `MST_` / `TRN_`), permission `chat.use` (all roles) and switch `CHAT` (seeded **off**). Rollback script: `database/rollback/V028__chat.rollback.sql`.
- **Website:**
  - `frontend/src/pages/chat/` and `frontend/src/api/chat.ts` (new);
  - small additions to `navigation.ts`, `Sidebar.tsx`, `Header.tsx`, `MobileTabBar.tsx`, `AppLayout.tsx`, `App.tsx` and `MeetingFeaturesPage.tsx`;
  - `vite.config.ts`: development proxy only.
- **New package:** `@microsoft/signalr` 10.0.11 (MIT). It loads only for people who have Chat.

## Settings

All optional; section `Chat` in appsettings or environment variables.

| Setting | Default | Meaning |
|---|---|---|
| `StorageRoot` | `<API folder>\..\data\chat` (production: `E:\Beeinsured.com\MeetIQ\deploy\data\chat`) | Where attachments are stored; outside the website |
| `ScanEnabled` | `true` | Windows Defender check before download |
| `MaxUploadMb` | `25` | Largest file (D3); each type can be lower in `chat.MST_ChatFileType` |
| `EditWindowMinutes` / `DeleteWindowMinutes` | `15` / `60` | D5 |
| `MaxGroupMembers` | `256` | |
| `FileRetentionDays` | `0` (keep) | D9: delete attachments older than N days |

## Switching it on

Go to Administration › Meeting Features › **Chat**. Switching it off hides Chat for everyone within seconds and deletes nothing. The emergency switch also turns it off.

## Deploy steps

To be run only when you say "deploy".

1. Pre-check that there are no live meetings, then take the usual backup (`api`, `frontend-dist`) plus a database backup.
2. Apply `V028__chat.sql` to Oneinsure_v with `database/deploy-database.ps1`. It is additive only.
3. Create `deploy\data\chat` with its own permissions: Administrators and SYSTEM full control, `NT SERVICE\MeetIQApi` Modify, no inherited "Everyone".
4. Publish the API and restart MeetIQApi (a few seconds). Then `npm run build`.
5. Check: health OK; the hub answers; upload a test file and confirm Defender marks it clean when the API runs as the service account.
6. Switch Chat on when you are ready.

## Rollback

| Part | How |
|---|---|
| Normal (keeps everything) | Switch Chat off |
| Code | Restore the `api` and `frontend-dist` backups |
| Database (deletes all chat data) | Run `V028__chat.rollback.sql` after a database backup |

## Tests

All on the test environment.

- **Backend:** 102/102, including 6 new chat tests.
  - The feature switch, and refusing users without an employee profile.
  - Outsiders get "not found" on every chat id.
  - Retried sends are saved once.
  - Read marks, mute and the unread badge.
  - Edit and delete windows; emoji-only reactions; forwarding.
  - Group admin rules; history visibility for people added later; removed members lose access.
  - Files: `.exe`, `.html`, `.svg`, fake `.png`, macro `.docx`/`.docm`, binary `.txt` and empty files are refused. A file can't be downloaded before the scan or once blocked, and outsiders can't download at all. Deleting the message deletes the stored file. Name and path cleaning.
- **Browser:** `tests/e2e/room/chat.mjs` 10/10, with two people live plus a phone.
  - Menu position; live badge; read tick; typing, presence, reply and reaction.
  - Edit, delete and emoji.
  - Files scanned by the real Windows Defender (about 2 s), then shown or downloaded; `.exe` refused.
  - Group create and remove, with live system lines.
  - Search with jump; phone layout (Chat tab, Back, no overflow).
  - Last seen within seconds of closing the browser; switch off hides Chat.
- **Regression:** all passed.
  - With Chat off: `room` 11/11, `refresh-rejoin` 6/6, `instant-link` 8/8, `mobile-audit` 8/8, `mobile-join-devices` 5/5, `goodday-14227-back` 3/3, `goodday-14224-14226` 4/4, `screen-share-view` 10/10, `android-app-present` 9/9, `meeting-features` 12 passed / 1 not tested.
  - With Chat on: `mobile-audit` 8/8 again.
- **Database:** the rollback script removes everything V028 created, and V028 re-applies cleanly afterwards.

## Not in this phase

- Audio calls (Phase 3).
- Notes, tasks and reminders (Phase 4).
- @mentions, scheduled or saved messages, quiet hours (Phase 5).
- Chat is not available inside the meeting room screen.
- No sound or ringing when the portal is closed (web push would need Google or Apple servers).
