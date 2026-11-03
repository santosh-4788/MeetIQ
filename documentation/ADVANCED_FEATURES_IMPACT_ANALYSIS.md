# Advanced meeting features — implementation impact analysis (Phase A)

Date: 2 Nov 2026 · Scope: the "Advanced Meeting Features, UI Modernisation and Live Server Readiness" request · Status: **analysis complete; Phase B started**

This analysis is based on reading the code as it stands (API 65/65 + domain 18/18 tests green, migrations V001–V012 on `Oneinsure_v`). Nothing here is a commitment to a date. Each phase is delivered and tested before the next starts.

## 1. What already exists (reuse, do not rebuild)

| Area | Already working | Where |
|---|---|---|
| Video | LiveKit 1.13.11 SFU, native Windows binary; short-lived HS256 tokens; room created per meeting; adaptive stream, simulcast, dynacast, auto-reconnect | `Meetings/LiveKit.cs`, `pages/room/MeetingRoom.tsx` |
| Employee join | `POST /meetings/{id}/join` (participants only, join window, host join → LIVE) | `Meetings/RoomEndpoints.cs` |
| Customer/guest join | Personal invitation token (`/join/{token}`), pre-join device check, editable guest name, **waiting room with host admit/reject**, polling, rate limits | `RoomEndpoints.cs`, `JoinPage.tsx`, `GuestRoom.tsx` |
| Host controls | Mute a participant's mic/camera/screen, remove participant (admission revoked), end for all | `RoomEndpoints.cs`, `RoomPanels.tsx` |
| Group chat | Persisted (`mtg.MeetingChatMessages`), live delivery over LiveKit data (`oic.chat`), unread count, plain text only | `RoomEndpoints.cs`, `MeetingRoom.tsx`, `RoomPanels.tsx` |
| In-room | Raise hand, participant list with roles, grid/speaker view, device selection panel, connection quality, reconnect banner, timer | `MeetingRoom.tsx`, `RoomPanels.tsx` |
| Recording | 4 configurable policies, consent in room, R2 recorder (headless Edge + FFmpeg), verification before COMPLETED, library, signed playback/download, retention | `Recording/*` |
| Attendance | Signed LiveKit webhooks → `mtg.MeetingAttendance` | `LiveKitWebhookEndpoints.cs` |
| Security | Server sessions, CSRF double-submit + Origin check, rate limits, RFC 9457 problems, audit log, PublicId in URLs | `Security/*`, `Program.cs` |
| Schema already prepared | `mtg.Meetings.IsLocked` (unused), `WaitingRoomEnabled`, `MeetingInvitations.MaxUses/RevokedUtc`, `MeetingAttendance.NetworkQualityAvg` | `V005__mtg.sql` |

## 2. Gaps per requested feature

| # | Feature | Gap | Approach (free / Windows) | Phase |
|---|---|---|---|---|
| 1 | Instant meeting | No way to meet without a schedule | `POST /meetings/instant`: meeting starts now (default 60 min, configurable), `MeetingKind = INSTANT`, no calendar conflict block, no invitation e-mails; host goes straight to the pre-join screen | B |
| 1 | Shareable meeting link | Only per-person invitation links exist | `mtg.MeetingLinks`: one random 256-bit link per meeting (stored as SHA-256 + Data-Protection-encrypted copy so the host can copy it again), expiry = meeting end + grace, **revocable/regenerable** | B |
| 1 | Audio-only / video off | Not available | `Meetings.IsAudioOnly`: enforced in the LiveKit token (camera not in `canPublishSources`); "start with video off" is a pre-join default | B |
| 1 | Join Meeting (dashboard) | Not available | Signed-in: paste a link or type the meeting code → opens it **only if the user may see the meeting**; anonymous lookup by code is not offered (prevents ID guessing) | B |
| 1 | Personal meeting link (PMI) | — | **Deferred**: a permanent personal link is a standing open door; revisit with the security owner | — |
| 1 | History: instant vs scheduled | — | `kind` on list/detail + badge | B |
| 2 | Guest via link, no login | Guests must be pre-invited by e-mail | Link page → name + device check → server creates a GUEST participant (`JoinSource = LINK`, `AdmissionRequired = 1`) and a personal token → existing waiting-room flow. **Link joiners always wait for admission**, even if the host has not joined | B |
| 2 | Remove + block re-entry | Remove exists; re-entry by personal link possible after asking again | `MeetingParticipants.IsBlocked`; personal token revoked; blocked participants are refused everywhere. Limitation: someone holding the shared link could ask again under a new name — host must reject, or revoke/regenerate the link | B |
| 2 | Separate identity types | Exists (EMPLOYEE / CUSTOMER / GUEST) | Signed-in non-invited employees using the link join as EMPLOYEE with admission | B |
| 3 | Private chat | Group chat only | `MeetingChatMessages.RecipientParticipantId`; **the server delivers** private messages (LiveKit `SendData` to sender + recipient only) and history is filtered server-side; clients can no longer broadcast chat themselves | C |
| 3 | Chat retention | — | Configurable (no value invented): `Chat:RetentionDays` = null (keep) until policy is confirmed | C |
| 4 | Transfer host | Host fixed at scheduling | `POST /room/host-transfer`; roles swapped in one transaction; `mtg.HostTransfers` history; LiveKit `UpdateParticipant` changes permissions/metadata live. DB rule "host must be an employee" kept: **guest hosts not allowed** unless policy changes (needs a constraint change) | C |
| 4 | Host continuity | — | Configurable `Meetings:HostContinuity`: `KEEP_HOST` (default, host can rejoin; co-hosts act) / `PROMOTE_COHOST` / `PROMOTE_EARLIEST_EMPLOYEE` after N seconds | C |
| 5 | Recording host-only | HOST **or COHOST** can start/stop today | Restrict to current HOST; new host after transfer inherits; audited admin emergency stop (`recordings.emergency_stop`, unassigned until policy); "recording stopped because host transferred" is **not** done — recording continues | D |
| 5 | Finalise on meeting end | End triggers room delete; recorder detects room end (existing) | Verify path + test explicitly | D |
| 6 | Mute all, lock, waiting-room toggle, screen-share & chat permissions, reactions, full screen | Missing (lock column exists) | `POST /room/settings` (lock, waiting room, who can share, chat on/off) + `mute-all`; lock enforced in join/enter; screen-share enforced via token + `UpdateParticipant` | E |
| 6 | Attendance report, meeting feedback, notes | Attendance data exists | CSV export (authorised), `mtg.MeetingFeedback`, notes (host-owned, access rule configurable) | E |
| 6 | Polls | — | Feasible: DB + data channel | E |
| 6 | Virtual backgrounds | — | Feasible with `@livekit/track-processors` (Apache-2.0, MediaPipe WASM, runs in the browser); CPU-heavy on low-end phones → opt-in, desktop first | E (assess) |
| 6 | Breakout rooms | — | **Deferred**: needs multiple LiveKit rooms + moving participants + recording rules per room | — |
| 6 | Live captions | — | **Deferred**: no free, private, reliable option; browser speech APIs send audio to third-party clouds | — |
| 6 | File sharing | — | **Deferred**: needs storage quotas and malware scanning (Defender CLI possible later) | — |
| 7 | UI modernisation | Design system exists (tokens, navy/blue/cyan) | Incremental page-by-page polish; no business-logic changes | F |
| 8 | Mobile | Room toolbar hides some controls under `sm`; tables not all responsive | Audit at 360/390/430/768/1024/1366; overflow menu for room controls; PWA manifest + icons (no offline calling promised) | F |
| 9 | Production readiness | Network/firewall doc + approval checklist exist; no deployment guide | 5 documents requested; IIS (reverse proxy + static), Kestrel as Windows service, LiveKit as Windows service (WinSW/NSSM or `sc`), R2 recorder under the API worker | G |
| 10 | Performance | Media independent of SQL already | Health page, job failure reporting, load test with N simulated rooms (LiveKit `lk load-test` is free) | G/H |

## 3. Database impact (all in `Oneinsure_v`, additive only)

| Migration | Content | Phase |
|---|---|---|
| V013 | `Meetings.MeetingKind`, `Meetings.IsAudioOnly`; `MeetingParticipants.JoinSource`, `AdmissionRequired`, `IsBlocked`; `mtg.MeetingLinks` | B |
| V014 | `MeetingChatMessages.RecipientParticipantId` + index; `mtg.HostTransfers` | C |
| V015 | Meeting room settings columns (screen share / chat permissions), `mtg.MeetingFeedback`, polls, notes | E |

Existing data is preserved: new columns have defaults matching today's behaviour. A backup-free approach is acceptable because each migration is additive and runs in one transaction (the runner rolls back on any error); a schema snapshot is taken before applying.

## 4. Risks and constraints

1. **CO-HOST behaviour change (Phase D)**: today co-hosts can start/stop recording. The request makes this host-only. Co-hosts keep mute/remove/admit.
2. **Shared links are bearer secrets**: anyone holding a meeting link can *ask* to join. Mitigation: always-on admission for link joiners, rate limits, revocation, expiry, block list, lock meeting.
3. **Guest as host** is blocked by an existing DB rule and is not enabled. Needs a policy decision.
4. **R2 recorder remains a proof of concept** (T02 six-person test failed on the laptop; T08/T09 not run).
5. **Mobile browsers**: iOS Safari cannot share the screen; background audio stops when the page is hidden on some phones. Documented, not promised.
6. **Production** needs: domain, public IP/NAT, UDP media ports, TLS certificate, Windows Server. All require your approval; nothing is deployed or opened by this work.

## 5. Order of work

A (this document) → B instant meeting + link/guest waiting room → C private chat + host transfer → D host-only recording → E room controls → F UI/mobile → G production docs/config → H integration, security, performance, UAT. Each phase reports files, DB changes, tests, open issues and how to test.
