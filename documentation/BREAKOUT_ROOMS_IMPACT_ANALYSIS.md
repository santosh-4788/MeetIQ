# Breakout Rooms: impact analysis (Phase 1)

Status: **for approval. No code has been written.** Date: 14 Nov 2026. Branch: `feature/ai-collab-1113`.

## 1. What exists today (inspected)

| Area | How it works now | Relevance |
|---|---|---|
| Video server | One self-hosted LiveKit server. Each meeting has exactly one LiveKit room, `mtg.Meetings.LiveKitRoomName`. | LiveKit supports any number of rooms on the same server, so breakout rooms need **no new video server and no new library**. |
| Room access | `POST /meetings/{id}/join` (employees) and `/join/{token}/…` (guests) issue a signed LiveKit token for one room name (`LiveKitTokens.CreateParticipantToken(ParticipantGrant(room, identity, …))`, `RoomEndpoints.Connection`). | A breakout token is the same call with a different room name. A participant can only enter a room the API issued a token for, so access is enforced by the server. |
| Host checks | `RoomEndpoints.CallerAsync(…, hostOnly: true)` and `IsHostRole` (HOST, CO_HOST). | Reused for every breakout host action. |
| Live notices | The server sends data messages to a room (`LiveKitRoomService.TrySendDataAsync(room, topic, …)`). | Reused to tell people that rooms opened, assignments changed, a broadcast was sent, or rooms are closing. |
| Attendance and meeting end | The LiveKit webhook (`LiveKitWebhookEndpoints.ProcessAsync`) finds the meeting **by the main room's name**. `room_finished` on the main room marks a LIVE meeting COMPLETED. | Breakout rooms are ignored by the webhook, which is good. **Risk:** if everyone moves to breakout rooms, the main room is empty, and after `DepartureTimeoutSeconds` (120 s) LiveKit closes it and the meeting would be marked COMPLETED. This needs a guard (see 4.3). |
| Ending a meeting | `MeetingAutoEnd.CloseRoomAsync` stops the recording, sends "meeting-ended" and deletes the main room. It is used by both "End for all" and the automatic end. | It must also close any open breakout rooms, otherwise people in them would stay connected. |
| Recording | One recorder process joins **the main LiveKit room** as a hidden participant (`oic-recorder…`, `RecorderLauncher`). Consent requests go to the identities present in the main room. | Breakout rooms are **not recorded**. People in a breakout room are absent from the main recording while they are away. No second recorder will be added. |
| Screen sharing | A LiveKit track in the participant's current room. | A presenter who moves to a breakout room stops sharing in the main room (they leave it). Sharing inside a breakout room works with the same permission. |
| Chat, polls, whiteboard, reactions, private chat | Sent as data messages in the current LiveKit room. Chat is also saved per **meeting** (`mtg.MeetingChatMessages`). | Saved chat would leak a breakout room's messages into the meeting-wide history (see decision D3). |
| Feature switches | `app.FeatureSettings` (V026), returned by `GET /room-features`, with an emergency switch that turns everything off. | A new switch, `BREAKOUT_ROOMS`, **off** by default. |
| Frontend room | `MeetingRoom.tsx` renders `<LiveKitRoom token=… connect>` for one connection. `onDisconnected` sends the person to the exit screen. | Switching rooms means connecting the same component to another token **without** showing the exit screen. This needs a small, guarded change (see 4.5). |

## 2. Architecture and data flow

```
Main meeting (LiveKit room  oic_<id>)            Breakout rooms (LiveKit rooms  oic_<id>_br_<n>)
        ▲  data: oic.breakout                       ▲  data: oic.breakout (broadcast, closing)
        │                                           │
  API  /meetings/{id}/breakout/*  ──►  mtg.Breakout* tables  ──►  token for the target room
        ▲
  Host panel (Breakout Rooms)        Participant: banner "You are in Room 2" + Return to main (if allowed)
```

1. The host creates rooms (a draft) and assigns people, manually or automatically, then reviews the assignments and opens the rooms.
2. The server saves the state and sends `breakout-changed` to the main room.
3. Each participant asks for their own state. With "move automatically" they switch at once; otherwise they get a **Join Room** prompt.
4. Switching: the client asks `POST …/breakout/join`. The server checks the person is assigned to that room (or self-selection is on, or they are a host) and returns a token for that room only. The client disconnects from the main room and connects to the breakout room, with the same camera and microphone choices.
5. Broadcast: the server sends the message to every open breakout room and to the main room.
6. Close all: the server marks the session CLOSING and sends `closing` with a countdown (default 30 s, or "now"). Clients return to the main room. The server then deletes the breakout rooms; anyone who missed the notice is disconnected and taken back to the main room instead of seeing "Connection lost". The main room, its recording and its screen share are not touched.

## 3. Files

### New files (additive)

| File | Purpose |
|---|---|
| `database/migrations/V028__breakout_rooms.sql` | 3 tables, the feature switch (off) and a permission (none needed if host roles are reused) |
| `database/rollback/V028__breakout_rooms.rollback.sql` | Drops only what V028 adds |
| `backend/…/Meetings/BreakoutEndpoints.cs` | All breakout APIs, checks and audit |
| `backend/tests/…/BreakoutTests.cs` | API tests: permissions, concurrency, assignment, close |
| `frontend/src/api/breakout.ts` | API calls and types |
| `frontend/src/pages/room/features/Breakout.tsx` | Host panel, participant banner and notices, state hook |
| `tests/e2e/room/breakout-rooms.mjs` | Browser tests (section 6) |
| `documentation/BREAKOUT_ROOMS.md` | Feature and operations guide |

### Existing files that need a small change (**approval needed**)

| File | Function | Change | Why it cannot be avoided |
|---|---|---|---|
| `backend/…/Program.cs` | startup | 1 line: `app.MapBreakoutEndpoints()` | Registers the new APIs |
| `backend/…/Meetings/RoomFeatureEndpoints.cs` | `Keys`, `/room-features` | Add `BREAKOUT_ROOMS` and `breakoutRooms` to the response (as was done for `MEETING_MINUTES`) | Feature switch |
| `backend/…/Meetings/LiveKitWebhookEndpoints.cs` | `ProcessAsync`, case `room_finished` | Do **not** mark the meeting COMPLETED while a breakout session is OPEN or CLOSING (about 3 lines) | Otherwise moving everyone to breakout rooms would end the meeting after 2 minutes |
| `backend/…/Meetings/MeetingAutoEnd.cs` | `CloseRoomAsync` | After deleting the main room, also close any open breakout rooms (1 call) | "End for all" and the automatic end must reach people in breakout rooms |
| `frontend/src/pages/room/MeetingRoom.tsx` | `MeetingRoom`, toolbar, `onDisconnected` | (a) the active connection can be replaced by a breakout or main token; (b) a planned switch is not treated as leaving; (c) a Breakout Rooms button (hosts) and the current-room badge | Room switching and the entry point |
| `frontend/src/api/roomFeatures.ts` | type | `breakoutRooms: boolean` | Feature switch |
| `frontend/src/pages/room/EmployeeRoomPage.tsx`, `GuestRoom.tsx` | `backend` object | Pass the breakout calls, the same way `features` is passed today | Employees and guests use different APIs |

Nothing else changes: no change to recording, consent, the waiting room, chat storage, authentication, the existing tables, or existing API responses (only one new field in `/room-features`).

## 4. Proposed design details

### 4.1 Database (V028, additive only; naming as in V026 and V027)

- **`mtg.BreakoutSessions`**: SessionId PK, PublicId, MeetingId FK. Status DRAFT, OPEN, CLOSING or CLOSED. Settings: AllowSelfSelect, MoveAutomatically, AllowReturnToMain, HostStaysInMain, CloseCountdownSeconds. CreatedBy/Utc, OpenedUtc, ClosedUtc and a `RowVersion` (two hosts cannot overwrite each other). A filtered unique index allows **one active session per meeting**.
- **`mtg.BreakoutRooms`**: BreakoutRoomId PK, PublicId, SessionId FK, Name (60 chars), SortOrder, LiveKitRoomName (unique), ClosedUtc. Names are unique within a session. At most 20 rooms.
- **`mtg.BreakoutAssignments`**: SessionId, ParticipantId FK to `mtg.MeetingParticipants`, BreakoutRoomId (NULL = main meeting), AssignedUtc, AssignedByParticipantId. Unique on (SessionId, ParticipantId), so **a person cannot be in two rooms**.
- **Events:** the existing `app.AuditLog` is used: BREAKOUT_CREATED, _OPENED, _ASSIGNED, _MOVED, _JOINED, _RETURNED, _BROADCAST, _CLOSED. A separate event table is not needed.
- **Feature switch:** `app.FeatureSettings ('BREAKOUT_ROOMS', 0)`.

### 4.2 APIs (`/api/v1/meetings/{id}/breakout/…`; guests use `/api/v1/join/{token}/breakout/…`)

| Method | Path | Who |
|---|---|---|
| GET | `/breakout` | Host: full state with room counts. Participant: their own room and the rules. |
| PUT | `/breakout/rooms` | Host. Create, rename or delete rooms (number of rooms, names). |
| POST | `/breakout/assign` | Host. Manual assignment or move: `{ participantId, roomId \| null }[]`. |
| POST | `/breakout/auto-assign` | Host. Returns an even split **for review only**; nothing is saved until `/assign`. |
| POST | `/breakout/open` | Host. |
| POST | `/breakout/join` | Host: any room. Participant: their assigned room, or any room if self-selection is on. Returns a LiveKit token for that room only. |
| POST | `/breakout/return` | Returns a main-room token, if allowed or the session is closing. No new waiting-room step for people already admitted. |
| POST | `/breakout/broadcast` | Host. Text up to 500 characters, sent to all open rooms and the main room. |
| POST | `/breakout/close` | Host. `{ countdownSeconds }` |

Every call checks: signed in or a valid guest token, the meeting is LIVE and belongs to the caller, the feature switch is on, the host role for host actions, and room membership for `join`. Every change is written to the audit log. Live data topic `oic.breakout`: `changed`, `broadcast`, `closing`, `closed`.

### 4.3 Main meeting protection

- The webhook guard (above) keeps the meeting LIVE while breakout rooms are open, even if the main room is briefly empty.
- `HostStaysInMain` (default on) keeps the host in the main room.
- The main recording keeps running. It records only the main room, as it does today.

### 4.4 Disconnection and concurrency

- State lives in the database. A participant who reconnects asks `GET /breakout` and goes back to their assigned room, or to the main room if the session closed.
- If the host disconnects, nothing changes. Rooms stay open until a host closes them or the meeting ends, and co-hosts can manage them.
- All host changes go through a transaction with a RowVersion check, so a stale change is refused with "refresh". Unique indexes stop duplicate rooms and duplicate assignments.

### 4.5 Client room switching

- The meeting page keeps the person's camera and microphone choices (on or off).
- The active connection is changed to the new token. The page reconnects, and the camera and microphone are opened again (no permission prompt, because permission was already given).
- The "left the meeting" screen is suppressed for that planned switch only.
- The one-tab-per-person guard (#14224) is unchanged: it is the same tab and the same identity.

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | The main room empties and the meeting is marked COMPLETED | Webhook guard (approval needed) |
| R2 | A camera or microphone fails to reopen after switching (some phones) | Reuse the existing device retry and the "Allow your camera" help; regression tests on the mobile profile |
| R3 | Attendance shows the person "left" the main meeting while in a breakout room (main-room attendance gets a leave and a re-join) | Decision D2 |
| R4 | Breakout conversations are not recorded, and people in breakout rooms are missing from the main recording | Stated in the host panel. No new recorder (as required). Decision D1 for customer (PLVC) meetings. |
| R5 | Saved chat could reveal one room's messages to others | Decision D3 |
| R6 | Host tools (mute, remove, admit from the waiting room) act on the main room only. A host inside a breakout room sees waiting-room requests only through the existing 15 s refresh. | Version 1: host tools stay main-room only; this is shown in the panel |
| R7 | A presenter's screen share in the main room stops when they move | The panel warns the host before moving a presenter |
| R8 | Polls, whiteboard and reactions are tied to the room they are used in | Hidden inside breakout rooms in version 1 |

## 6. Test plan

- **New `breakout-rooms.mjs`, one case per requirement in section 8:**
  - create one room and several rooms;
  - manual and automatic assignment, then move;
  - audio and video isolation: a person in room 1 receives no tracks from room 2;
  - a token for an unassigned room is refused (403);
  - the host joins and leaves rooms;
  - a broadcast reaches all rooms;
  - close all, with everyone back in the main room;
  - a participant goes offline and comes back;
  - the host drops;
  - the main meeting stays LIVE with an empty main room for longer than 120 s;
  - the recording continues (same job, no second recorder);
  - the main screen share continues;
  - phone (360/412 px, Android and iOS profiles) and desktop.
- **API tests** (`BreakoutTests.cs`): permissions, the feature switch off (403), stale RowVersion, duplicate names, a person in two rooms.
- **Regression:**
  - room tests: `room.mjs`, `instant-link`, `end-and-late-share`, `mobile-audit`, `meeting-features`, `meeting-minutes`, the `goodday-*` suites;
  - recording tests: `goodday-fixes*`, `consent-request`, on the `_Rec` stack;
  - API tests: all of them.
  - Everything is run with the switch **off** (behaviour must be identical) and **on**.

## 7. Deployment and rollback (when approved and finished)

- **Database:** V028 is additive only, with the switch off. Rollback with `V028__breakout_rooms.rollback.sql`.
- **API and website:** same steps as the 14 Nov deploy (check that no meeting is live, back up the files, copy, check health).
- **Off switch:** turning `BREAKOUT_ROOMS` off, or the emergency switch, hides the feature immediately. Any open breakout session is closed and everyone is returned to the main room.

## 8. Decisions needed before development

- **D1. Customer and PLVC meetings with required recording.** Recommended: **no breakout rooms while a recording is required or running**, because the conversation in breakout rooms would not be recorded. Alternative: allow them with a warning.
- **D2. Attendance.** Recommended: count time in a breakout room as attendance of the parent meeting. This is a small extra change in the webhook: a breakout room name maps to its parent meeting. Alternative: leave attendance as it is, which shows leave and re-join entries.
- **D3. Chat inside breakout rooms.** Recommended: version 1 has **no chat** in breakout rooms (audio, video and screen share only). Alternative: room-only chat that is not saved.
- **D4. Who can manage rooms.** Recommended: host **and co-hosts**, the same as the other host controls.
- **D5.** Approve the 4 backend and 4 frontend changes to existing files listed in section 3.
