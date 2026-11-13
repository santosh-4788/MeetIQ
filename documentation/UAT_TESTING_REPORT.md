# UAT testing report — advanced meeting features

Two separate columns on purpose: **Dev status** is what the development team verified (automated tests, browser tests). **UAT** is your acceptance and stays *Pending* until you test and confirm it. Nothing here is accepted on your behalf.

Legend: ✅ passed · ❌ failed · ⏳ pending · ➖ not applicable yet

Environment for UAT: this laptop (`https://localhost:5173`) or LAN mode (`https://192.168.2.77:5173`, run `scripts\lan\enable-lan-firewall.ps1` once as Administrator so other PCs can connect). Database `Oneinsure_v`.

## Phase B — Instant meeting, shareable link, guest waiting room

Dev verification 2 Nov 2026: API tests 72/72, browser test `tests/e2e/room/instant-link.mjs` **8/8** (Edge, fake camera/mic, isolated LocalDB). UAT: **pending**.

| ID | Test | Steps | Expected | Dev status | UAT |
|---|---|---|---|---|---|
| B-01 | Start an instant meeting | Dashboard → **New meeting** → title → **Start meeting** → **Start meeting** on the pre-join screen | Room opens; the **Invite** dialog shows the meeting link; meeting appears as *Instant* in My meetings; no e-mails sent | ✅ API + browser (IL-01) | ⏳ |
| B-02 | Camera off at start | New meeting → switch off "Start with my camera on" | Pre-join opens with the camera off | ✅ (code path; covered by IL-07 for audio-only) | ⏳ |
| B-03 | Audio-only meeting | New meeting → "Audio-only meeting" on | Pre-join says *Audio-only meeting*, no camera choice; no camera button in the room; camera refused by the video server | ✅ API (token) + browser (IL-07) | ⏳ |
| B-04 | Copy / e-mail / share the link | In the room: **Invite** → Copy link / E-mail | Link copied; e-mail draft opens with the link | ✅ copy (IL-01) | ⏳ |
| B-05 | Guest joins without login | Open the link in another browser (or a private window / another PC) → **Join meeting** → type a name → **Ask to join** | "Please wait, the host will let you in soon"; the guest sees nothing of the meeting | ✅ API + browser (IL-02) | ⏳ |
| B-06 | Guest waits while the host is absent | Guest asks to join before the host has entered | Guest keeps waiting; never admitted automatically | ✅ API (`Link_guests_always_wait…`) | ⏳ |
| B-07 | Host admits the guest | Host: Participants badge → entry says "Guest · via meeting link" → **Admit** | Guest enters the room; both see and hear each other | ✅ API + browser (IL-03) | ⏳ |
| B-08 | Host denies the guest | **Deny** instead of Admit | Guest sees "The host has not let you in" | ✅ API (existing waiting-room test) | ⏳ |
| B-09 | Remove and block | Participants → remove the guest → tick "Do not allow them to rejoin" | Guest sees "You were removed"; asking again is refused | ✅ API + browser (IL-05) | ⏳ |
| B-10 | Colleague not invited uses the link | Signed in as Sagar → Dashboard **Join meeting** → paste the link → **Continue as …** → Ask to join | Waits; host sees "Colleague (not invited)"; after Admit Sagar is in the room as an employee and the meeting appears in his list | ✅ API + browser (IL-04) | ⏳ |
| B-11 | Join by code | Dashboard **Join meeting** → type the code (e.g. OIC-261102-AB12) | Opens the meeting if you are invited; otherwise "No meeting with this code was found among your meetings" | ✅ API | ⏳ |
| B-12 | Replace / withdraw the link | Meeting page → *Meeting link* card → **New link** / **Withdraw** | Old link shows "This meeting link no longer works" | ✅ API + browser (IL-06) | ⏳ |
| B-13 | Ended meeting | Use the link after **End for all** | "This meeting has ended"; asking is refused | ✅ API | ⏳ |
| B-14 | Link page on a phone | Open the link on an Android/iPhone browser | Fits the screen, no sideways scrolling | ✅ browser at 390 px (IL-08) | ⏳ |
| B-15 | Guessing protection | Many wrong links from one address | After 30/min the server answers "Too many requests" | ✅ API (rate-limit test) | ⏳ |

Known limits (by design, documented): someone who holds a shared link can ask again under a new name after being blocked — the host denies them, or replaces/withdraws the link, or (Phase E) locks the meeting. A permanent personal meeting link (PMI) is deferred. Guests cannot be made host (database rule; needs a policy decision).

## Mobile (Android and iOS)

Dev verification 3 Nov 2026: `tests/e2e/room/mobile-audit.mjs` 7/7 (Edge with phone viewports and touch: 360, 390, 430, 768 px; room portrait and landscape). Real phones: **not yet tested** (needs LAN mode with the firewall rule, or the server).

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| M-01 | Sign in on an Android phone (Chrome) and an iPhone (Safari) | Page fits, no sideways scrolling, fields do not zoom on iPhone | ✅ emulated | ⏳ |
| M-02 | Bottom tab bar: Home, Meetings, +, Calendar, Alerts | Each opens; + starts a new meeting | ✅ emulated | ⏳ |
| M-03 | Join a meeting on the phone (portrait) | Six large buttons fit; More shows the rest; chat and participants open full width | ✅ emulated | ⏳ |
| M-04 | Turn the phone to landscape | Video larger, toolbar still fits | ✅ emulated | ⏳ |
| M-05 | Guest opens a meeting link on a phone | Join page fits; waiting room; admitted into the room | ✅ emulated (IL-08) | ⏳ |
| M-06 | Add to home screen (Android: "Install app"; iPhone: Share → Add to Home Screen) | OneInsure Connect icon; opens full screen | ⏳ needs https on a real phone | ⏳ |
| M-07 | Present screen on a phone | Not offered (browser limitation) | ✅ | ⏳ |

## Host transfer (Phase C, part)

Dev verification 5 Nov 2026: manually verified end to end with two real employee sessions on the test deployment (`https://www.oneinsure.com/meet`). No automated browser test yet (would need a two-browser-context harness).

| ID | Test | Steps | Expected | Dev status | UAT |
|---|---|---|---|---|---|
| HT-01 | Host transfers to a colleague | As host, open Participants → crown icon next to an employee participant (not a guest) → confirm | Confirmation dialog; after confirming, that participant's badge changes to Host immediately for everyone, no reconnect | ✅ manual (2 sessions) | ⏳ |
| HT-02 | Previous host loses controls | After HT-01, check the original host's toolbar | "End for all", admit/mute/remove and "Make host" controls disappear immediately | ✅ manual | ⏳ |
| HT-03 | New host gains controls | After HT-01, check the new host's toolbar | Full host toolbar appears immediately, including recording start/stop if applicable | ✅ manual | ⏳ |
| HT-04 | Guest cannot become host | Open Participants as host while a guest (joined via link) is present | No crown icon next to the guest — database rule (`CK_MeetingParticipants_HostIsEmployee`) blocks it regardless | ✅ code + manual | ⏳ |
| HT-05 | Transfer is audited | After HT-01, check `mtg.HostTransfers` | One row: previous host, new host, meeting, timestamp | ✅ DB verified | ⏳ |

## Recording — business-approved behaviour (Phase D)

Approved by the user in writing 5 Nov 2026: customer/PLVC meetings auto-record (mandatory), internal/team meetings are host-controlled (optional), host-only control follows host transfer, library access stays with the meeting's permanent creator regardless of host transfer. **Not approved/invented**: policy document references, approver names/dates, consent wording, retention periods — these remain pending real company-approved values, and recording policies are correspondingly still shown as "Not confirmed" in Admin → Recording policies.

Dev verification 5 Nov 2026: FFmpeg/ffprobe installed and verified on the server, R2 Recorder and its layout page built and deployed, `Recording:Environment` set to `Test` so the mandatory-recording mechanism can be functionally exercised without the legal-confirmation gate (`RecordingPolicyGate`) blocking it — that gate still applies as designed once a real production environment is configured. The underlying mechanism (auto-start, host-only stop with confirmation, access tied to the immutable meeting creator, full audit trail) was verified by code review to already implement the approved behaviour; the outstanding step is an administrator setting each policy's "Requirement" field (see PROJECT_CHECKLIST.md).

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| R-01 | Customer/PLVC meeting auto-starts recording | Recording starts by itself when the meeting goes live, no host action | ⏳ needs policy Requirement set to Mandatory first | ⏳ |
| R-02 | REC indicator shown to all | Pulsing red REC badge visible to every participant once recording is active | ✅ code (pre-existing) | ⏳ |
| R-03 | Host stops recording after confirmation | "Stop meeting recording?" dialog (Cancel / Yes, stop recording) before it actually stops | ✅ code (dialog added 5 Nov) | ⏳ |
| R-04 | Recording does not restart after host stops it | A 5-minute cooldown after a consent-based or manual stop prevents auto-restart | ✅ code (pre-existing `TryAutoStartAsync` cooldown) | ⏳ |
| R-05 | Internal meeting does not auto-record | No recording starts without the host acting | ✅ code (Requirement=Optional path) | ⏳ |
| R-06 | Internal host can manually start/stop | Record button available to host/co-host, disabled with a reason for everyone else | ✅ code (pre-existing) | ⏳ |
| R-07 | Recording permissions transfer with host | After a host transfer, the new host gets recording start/stop; the previous host loses it | ✅ manual (same session as HT-01/02/03) | ⏳ |
| R-08 | Admin can view all recordings | Recording Library, `recordings.view.all` | ✅ code (pre-existing RBAC) | ⏳ |
| R-09 | Meeting scheduler can view their meetings' recordings | Owner access tied to `CreatedByEmployeeId`, immutable | ✅ code (pre-existing RBAC) | ⏳ |
| R-10 | Unauthorised employees cannot access recordings | No role/ownership match → 404, not a permission-revealing error | ✅ code (pre-existing RBAC) | ⏳ |
| R-11 | MP4 files are generated and playable | Full decode + faststart + SHA-256 verification before a recording is marked Completed | ✅ code (pre-existing `MediaVerifier`); not yet re-run on this server (needs a Requirement=Mandatory or manual-start test first) | ⏳ |
| R-12 | Recording status and audit logs are correct | Status progresses Pending → Processing → Completed (or Failed with a reason); `RECORDING_STARTED`/`RECORDING_STOP_REQUESTED`/`RECORDING_FAILED` audit rows | ✅ code (pre-existing) | ⏳ |
| R-13 | Consent captured with timestamp + meeting ID | Every grant/deny/withdraw writes `mtg.MeetingConsent` (append-only, V005) with `DecisionUtc`, `MeetingId`, IP, user agent and a tamper-evident hash | ✅ code (pre-existing, verified 5 Nov) | ⏳ |
| R-14 | Consent decisions appear in the general audit trail | Every consent decision and every start/stop also writes `app.AuditLog` (same table the Audit Log viewer reads) | ✅ code (pre-existing, verified 5 Nov) | ⏳ |
| R-15 | Withdrawing consent stops a mandatory recording | For a `CONSENT_REQUIRED` + `stopOnWithdrawal` policy, a DENIED/WITHDRAWN decision stops the active recording automatically | ✅ code (pre-existing, verified 5 Nov) | ⏳ |
| R-16 | Same notice/consent behaviour for guests as employees | Guest/customer rooms use the identical `RecordingControls` component and backend `RecordingService` calls as employee rooms | ✅ code (pre-existing, verified 5 Nov) | ⏳ |
| R-17 | Live per-participant consent status (host) | Participants panel shows a "Consented / Awaiting consent / Declined / Withdrawn" tag next to each required participant while a consent-required policy applies — not only in the pre-start dialog | ✅ built and deployed 5 Nov (new `decisions` field on the existing consent payload; `RoomPanels.tsx`) | ⏳ |
| R-19 | Meeting creator can download their own recording | Download button works for the meeting's owner, not just Play — no admin action needed per-recording | ✅ built and deployed 6 Nov (migration V017, `OwnerCanDownload=1` on all 4 policies); live-tested end to end with a fresh meeting, byte-identical SHA-256 | ⏳ |
| R-20 | Admin/SuperAdmin can view and download any recording | `recordings.view.all` + `recordings.download` granted to both roles (previously granted to no role at all, including SuperAdmin) | ✅ built and deployed 6 Nov (migration V017) | ⏳ |
| R-21 | Recordings land in day-wise folders on disk | `StorageRoot/yyyy/MM/dd/<opaque file>.mp4` | ✅ built and deployed 6 Nov; confirmed via `ls` against a fresh recording | ⏳ |
| R-22 | Recording identifiable by meeting without an opaque path | Opening the MP4 or running `ffprobe` shows the meeting code in its title/comment metadata tags; the on-disk folder/filename itself stays a random opaque string (unchanged security property) | ✅ built and deployed 6 Nov; confirmed via `ffprobe -show_entries format_tags` against a fresh recording, independent of the app | ⏳ |
| R-18 | Approved recording notice wording | The notice shown before recording starts is the company's actual approved wording, with a real policy name/version — not `[PLACEHOLDER - NOT CONFIRMED]` / `PLACEHOLDER-0` | ⛔ blocked — searched the entire repo again 5 Nov on the user's instruction that this is already approved; no approved text exists anywhere in code, migrations or documentation (all explicitly marked pending). Left as-is rather than inventing wording or removing the warning; user asked directly for the real text | ⏳ |

## Meeting room premium visual redesign

Dev verification 5 Nov 2026: visual-only changes (palette, floating glass toolbar with grouped controls, tile/header/panel treatment, screen-share-unsupported messaging, smoother panel transitions); no functional behaviour changed. Verified by build + live deployment; a mobile clipping bug found during UAT (audio-prompt centering) was fixed and redeployed same day.

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| UI-01 | Desktop meeting room | Floating glass toolbar, grouped controls with dividers, palette matches the approved spec | ✅ deployed | ⏳ |
| UI-02 | Mobile meeting room | No clipped/overflowing elements, compact toolbar + More sheet, "tap to enable audio" prompt fully visible and centred | ✅ fixed 5 Nov (was clipped, root-caused to a CSS specificity conflict with LiveKit's stylesheet) | ⏳ |
| UI-03 | Screen-share unsupported | Devices without `getDisplayMedia` show a disabled control explaining why, instead of silently hiding it | ✅ deployed | ⏳ |
| UI-04 | Waiting room | Pulsing cyan ring, gradient avatar, camera preview where available, palette matches the approved spec | ✅ deployed | ⏳ |

Not yet started: Admin panel SMTP/security settings screens (new surfaces), "Private Chat" (1:1 messaging — a new feature, not yet built, needs confirmation before starting).

## Logo fix, meeting-form simplification, dashboard and invite visual polish (5 Nov 2026)

Dev verification 5 Nov 2026: `npm run build` clean after each change; logo path verified live (`/meet/brand/oneinsure-logo.png` → 200 `image/png`); dashboard and invite-dialog changes are visual-only (no API/data contract changes). Database `Oneinsure_v` untouched by any of this — the category and meeting-details changes are presentation-layer only.

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| L-01 | OneInsure logo renders | Visible and undistorted on login, sidebar footer, meeting room, invite dialog, guest/waiting pages | ✅ fixed and deployed | ⏳ |
| F-01 | Meeting details field | Scheduling an old meeting that had both Agenda and Description shows both combined in one "Meeting Details" box; saving writes it back without deleting either original column | ✅ code + build | ⏳ |
| F-02 | Category picker | 5 top-level choices; choosing Internal Meeting reveals a Meeting Format selector; existing meetings keep their original category and still report correctly | ✅ code + build (no DB values changed) | ⏳ |
| D-01 | Dashboard stat cards | Coloured accent bar and icon lift on hover, matching each card's accent colour | ✅ deployed | ⏳ |
| I-01 | Invite-meeting dialog | Glass-tinted link card, grouped actions, expiry/waiting-room info panel; copy/e-mail/share/replace/withdraw all still work | ✅ deployed | ⏳ |

## Speaker / audio-output selection (5 Nov 2026)

Dev verification 5 Nov 2026: read LiveKit's own `switchActiveDevice('audiooutput', …)` source directly (not assumed) and confirmed it calls the standard `setSinkId()` on every remote participant's audio element — the existing dropdown already worked before today. Added: Test speaker button (synthesised chime, no network asset), per-browser localStorage persistence of the chosen camera/microphone/speaker, and a proactive message on browsers that cannot do this (Safari/iOS) instead of a silent failure. Not verified with a real HDMI monitor (no such hardware available in this session) — the mechanism is LiveKit's own, used by thousands of production deployments, but a real plug/unplug test on this server would still be worth doing.

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| AO-01 | Pick a non-default speaker (e.g. headphones) mid-meeting | Meeting audio moves to that device immediately, no reconnect | ✅ code (LiveKit `setSinkId`, verified in source) | ⏳ |
| AO-02 | Click Test speaker | A short chime plays through the currently selected device only, meeting audio is unaffected | ✅ code | ⏳ |
| AO-03 | Connect an HDMI monitor during a call | The new output appears in the Speaker list without reloading the page | ✅ code (LiveKit's device observer listens for `devicechange`) | ⏳ needs a real HDMI monitor to confirm |
| AO-04 | Disconnect the active HDMI output during a call | Falls back automatically; call, mic and camera keep working | ✅ code (LiveKit-managed) | ⏳ needs a real HDMI monitor to confirm |
| AO-05 | Reopen a new meeting later | The previously chosen speaker (and mic/camera) is selected again automatically, if still connected | ✅ code (new localStorage persistence) | ⏳ |
| AO-06 | Open the room in Safari or on an iPhone | A clear message explains the OS controls the output here instead of a non-functional dropdown | ✅ code (`supportsAudioOutputSelection()` check) | ⏳ needs a real Safari/iOS test |

## Recurring meetings (5 Nov 2026)

Dev verification 5 Nov 2026: builds clean (`dotnet build`, `npm run build`), migration V015 applied and verified on Oneinsure_v, redeployed, live checks passed (unauthenticated `POST /meetings/recurring` refused the same way the existing `POST /meetings` is, `GET .../series` refused with 401). No automated test yet for the recurrence date-generation logic (`Recurrence.Generate` in `RecurrenceSupport.cs`) — recommended before production sign-off.

| ID | Test | Steps | Expected | Dev status | UAT |
|---|---|---|---|---|---|
| RM-01 | Schedule a weekly series | Schedule Meeting → fill details → turn on **Repeat** → Weekly, pick days, "After 10 occurrences" → Schedule recurring meeting | 10 separate meetings are created, one per matching weekday, each with its own invitations | ✅ code + live deploy | ⏳ |
| RM-02 | Schedule a daily / monthly series | Same, with Daily (every N days) or Monthly (same day of month) | Correct dates generated; a monthly series starting on the 31st lands on the last day of shorter months | ✅ code (`Recurrence.Generate`) | ⏳ |
| RM-03 | End on a date instead of a count | Choose "On date" instead of "After N occurrences" | Series stops at or before that date; capped at 52 occurrences / one year regardless | ✅ code | ⏳ |
| RM-04 | Conflict on one occurrence | Invite someone who is busy on only one of the dates | Booking is refused; a dialog lists exactly which occurrence(s) conflict and with whom, same as the single-meeting conflict dialog | ✅ code | ⏳ |
| RM-05 | Override and book anyway | From RM-04, click "Book the whole series anyway" (needs the override-conflicts permission) | Every occurrence is created; the conflicting ones are flagged in the audit log | ✅ code | ⏳ |
| RM-06 | Each occurrence behaves like a normal meeting | Open one occurrence from the series | Reschedule, cancel, add/remove participants, recording and join all work exactly as on a one-off meeting — because it is one | ✅ by construction (shared code path) | ⏳ |
| RM-07 | View the series from one occurrence | Open any occurrence's detail page | "Recurring series" card lists every occurrence with its status; clicking one navigates to it | ✅ code | ⏳ |
| RM-08 | Cancel this occurrence only | Cancel meeting → "This meeting only" | Only that occurrence is cancelled; the rest of the series is untouched | ✅ code (existing single-cancel path, unchanged) | ⏳ |
| RM-09 | Cancel this and following | Cancel meeting → "This and all following meetings in the series" | This occurrence and every later SCHEDULED/DRAFT one in the series are cancelled in one action; earlier occurrences are untouched | ✅ code | ⏳ |
| RM-10 | Drafts are not offered for a series | Turn on Repeat | "Save as draft" is hidden; only "Schedule recurring meeting" is offered | ✅ code (by design — see PROJECT_CHECKLIST.md) | ⏳ |

## Audit log viewer (5 Nov 2026)

Dev verification 5 Nov 2026: builds clean (`dotnet build`, `npm run build`), redeployed, live checks passed (unauthenticated request to the API refused with 401, the page itself loads). Read-only — exposes an existing table (`app.AuditLog`, append-only since V007) and an existing permission (`audit.view`, seeded since V010); no new migration.

| ID | Test | Steps | Expected | Dev status | UAT |
|---|---|---|---|---|---|
| AU-01 | ComplianceAuditor can reach the audit log | Sign in as a user whose only relevant permission is `audit.view` → sidebar | "Audit Log" appears under System; opens the page (previously `/admin` required `admin.settings`, which this role lacks, so there was no way in) | ✅ code (route gated on `audit.view` directly) | ⏳ |
| AU-02 | Users without the permission cannot reach it | Sign in as a role without `audit.view` → try `/audit-log` directly | Redirected to Access denied; no nav entry shown | ✅ code (`RequirePermission`, same pattern as every other gated route) | ⏳ |
| AU-03 | Filter by date range, action, entity type, text | Set filters in combination | Only matching entries show; the total count updates | ✅ code + live | ⏳ |
| AU-04 | Privileged-only toggle | Switch it on | Only entries with `IsPrivileged = 1` show | ✅ code | ⏳ |
| AU-05 | Expandable before/after detail | Click an entry that has recorded values (e.g. a recording-policy change) | Shows "Before"/"After" JSON panels; entries without recorded values show no expand control | ✅ code | ⏳ |
| AU-06 | The log itself cannot be altered | — | No edit/delete action exists in the UI or API; the database role is denied UPDATE/DELETE on `app.AuditLog` regardless | ✅ pre-existing DB grant (V009), confirmed still in force | ⏳ |

## Visual design realigned to the approved reference image, then reverted one round (5 Nov 2026)

Dev verification 5 Nov 2026: visual-only changes — no API, database or permission changes, both for the change below and its same-day reversal. First pass: the user supplied a reference image (login / dashboard / live meeting room) and asked for it to be followed literally, correcting the previous "Meeting room premium visual redesign" round (UI-01..04 above) by making the login bright sky-blue and the room's header/panels/toolbar white/translucent. Second pass, same day: the user asked to revert that colour/panel direction one round back (restoring the dark midnight login and dark-glass room chrome) while keeping only the login's floating-icon animation from the reference image. **RM-01/RM-02 below describe the current, live state** (the reverted one) — the bright/white version they superseded was live only briefly and is no longer deployed.

| ID | Test | Expected (current, live) | Dev status | UAT |
|---|---|---|---|---|
| RM-01 | Login background | Dark midnight-to-blue gradient (not the briefly-live bright sky-blue version), single unified card, three slowly drifting glass bubbles (camera/laptop/people icons) around the card | ✅ deployed, screenshotted live at 1440px | ⏳ |
| RM-02 | Meeting room header, toolbar, panels | Header, bottom toolbar and Participants/Chat/Settings panels are dark glass with light text and icons (not the briefly-live white/translucent version); video tiles and avatars stay dark/immersive | ✅ deployed (reverted to match the pre-reference-image state, verified by code diff against the captured prior values) | ⏳ |
| RM-03 | Palette consistency | Login, dashboard and room all use the `#2463D3`/`#3B82F6`/`#22D3EE` blue-cyan family (not the briefly-live `#0788EF` family) | ✅ code audit + build; the fine brand-ramp shades (`brand-50`..`brand-300`, `brand-600`) are a reconstruction around 3 confirmed anchor colours, not a byte-exact restore — see CHANGELOG.md | ⏳ |

Not done this round (flagged, not silently skipped): the other ~20 screens were never moved to the reference-image direction, so there is nothing to revert there; full 360–1920px breakpoint sweep; screen-share "include audio" toggle.

## Disconnect and resume for everyone (6 Nov 2026)

Dev verification 6 Nov 2026: audited all 3 ways someone joins a meeting (signed-in employee, personal invitation, generic shareable link) against "everyone can disconnect and resume if meeting link is working and not expired." Employee reconnect already worked correctly. Two real gaps found and fixed; live-tested, not just code-reviewed.

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| RC-01 | Employee (any role) reconnects | Rejoining uses the same identity/role; a lock set after they first joined never blocks their own reconnect | ✅ confirmed already correct by code audit, no change needed | ⏳ |
| RC-02 | Already-admitted guest/customer reconnects via personal invitation | Goes straight back into the meeting, not back into the waiting room for re-admission | ✅ fixed and live-tested (via the same mechanism as RC-03) | ⏳ |
| RC-03 | Anonymous guest reconnects via the generic shareable link | A closed tab/crashed browser/locked phone, then reopening the same link, lands them back in the live meeting without a new wait or host action | ✅ live-tested: admitted a guest, closed their entire browser context, reopened from saved browser storage, revisited the same link — landed directly in the live room (screenshot confirms) | ⏳ |
| RC-04 | A genuinely invalid/expired personal token doesn't loop forever | If a remembered token stops working (e.g. the host later removed and blocked that guest), the browser forgets it and a retry asks to join fresh, rather than silently failing the same way every time | ✅ code complete; not separately exercised live this round (would need deliberately revoking a guest's access mid-test) | ⏳ |

## Phase 2 — host controls and Customer/PLVC auto-recording (6 Nov 2026)

Dev verification 6 Nov 2026: full audit first (4 parallel code-reading passes, no code written until findings were shared with the user), then this round closed every gap the audit found that didn't need a new dependency or a legal/business decision. Live-tested end to end with a real two-participant meeting (one signed-in host, one unauthenticated guest via the shareable link), screenshots taken at each step — not just code review.

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| HC-01 | Muted participant is told | Muting someone (individually or via "Mute all") shows them "The host turned off your microphone/camera" on their own screen | ✅ live-tested, screenshot confirms the toast | ⏳ |
| HC-02 | Host can ask a muted participant to unmute | "Request unmute" (per participant) and "Unmute all" (bulk) show the participant "The host is asking you to unmute" — never force-unmutes (impossible in a browser) | ✅ live-tested, screenshot confirms the toast | ⏳ |
| HC-03 | Host can turn off a participant's camera | New button next to mute; the participant's video tile genuinely stops (switches to the avatar placeholder) for both the host's and the participant's own view | ✅ live-tested, screenshots from both sides confirm the camera actually stopped | ⏳ |
| HC-04 | Lock Meeting blocks new arrivals | A brand-new (never-attended) guest opening the shareable link while locked sees "The meeting is locked" and cannot even submit a join request; the host and anyone already in the meeting are unaffected | ✅ live-tested: fresh guest blocked with the exact message, enforced on all 3 join paths (employee `/join`, personal invitation `/enter`, shareable link) | ⏳ |
| HC-05 | Unlock Meeting lets new arrivals back in | The same guest, after the host unlocks, can submit a join request and reach the waiting room | ✅ live-tested: same guest session reached "Please wait, the host will let you in soon" immediately after unlock | ⏳ |
| HC-06 | Customer/PLVC meetings auto-record | `Requirement = Mandatory` for the Customer Meetings policy (migration V018); Customer Audio Calls set to `Disabled` (no telephony integration) | ✅ applied and verified via direct database check; the underlying auto-start mechanism (`TryAutoStartAsync`/`RecordingPolicyGate`) was independently code-verified earlier in this project - a full live run against an actual Customer-category meeting (needs a real customer invitation) was not separately re-executed this round | ⏳ |
| HC-07 | Recording notice doesn't block when the policy doesn't require a click | A policy set to `NOTIFICATION_ONLY` shows a dismissible banner, not a modal, and records the acknowledgement automatically | ✅ code complete; not exercised live since all 4 current policies are `CONSENT_REQUIRED` (their modal flow is untouched and still gates a real consent decision, as it should) | ⏳ |
| HC-08 | Recording failures alert Admin/SuperAdmin | Every active Admin/SuperAdmin gets an in-app notification on a recording failure, not just the meeting's owner | ✅ code complete (reuses the existing `mtg.MeetingNotifications` mechanism); not exercised against a real failure this round (would mean deliberately breaking the recorder on the test server) | ⏳ |

Not done this round (flagged, not silently dropped — see PROJECT_CHECKLIST.md "Pending"): what happens if a host disconnects and never returns (today nobody is auto-promoted); persistently revoking a participant's mic/camera beyond a one-time mute.

## Device-adaptive meeting recording — portrait/landscape (7 Nov 2026)

Root cause first, then the approved "smallest safe change": the R2 compositor (`recording/layout/src/main.ts`) already decodes each participant's real WebRTC camera frames onto a canvas (it is not a screen capture), but that canvas was sized once at page load from a single static config value (1280×720) and never anything else — the same fixed number was then hard-coded into the FFmpeg `scale`/`pad` filter and into the verifier's hard equality check on width/height. A portrait phone camera was therefore always squeezed (cover-cropped) into a landscape frame no matter what it actually recorded. Fix, approved by the user in 7 numbered points before implementation: a one-to-one call now waits a few seconds for real camera dimensions, then locks a portrait canvas (720×1280) if either side is portrait, otherwise landscape (1280×720); a group call (3+) always stays landscape, no detection; participant tiles render contain (letterboxed), not cover (cropped), in both orientations; a mid-call device rotation is absorbed by the per-frame contain draw with no canvas resize, no recorder restart; the FFmpeg build/verify and the API's own re-verification pass were changed from a hard-coded landscape expectation to whatever dimensions the recorder actually chose for that job.

Verified against real generated MP4 files (not just code review), using the existing R2 recorder proof-of-concept harness (`tests/r2-poc/harness/`) extended with a configurable synthetic camera orientation and a `rotate()` control for the mid-call test, against a local, loopback-only LiveKit instance kept separate from the live test deployment's own video server. Every scenario below ran the real `OneInsure.Connect.Recorder.exe` end to end: joined a real LiveKit room, composited real decoded video frames, encoded with FFmpeg, and verified by `MediaVerifier` before being marked `COMPLETED`.

| ID | Test (spec §7) | Expected | Result | Evidence |
|---|---|---|---|---|
| O1 | Laptop-to-laptop one-to-one | Landscape 1280×720 | ✅ `1280x720`, verification passed, A/V offset median −75 ms / p95 80 ms, no freezes, played back and seeked correctly | `O1-O4.json` |
| O4 | Mobile-to-mobile landscape one-to-one | Landscape 1280×720 | ✅ same run as O1 (both cameras landscape is the same input either way) | `O1-O4.json` |
| O2 | Laptop-to-mobile-portrait one-to-one | Portrait 720×1280 | ✅ `720x1280`, verification passed, A/V offset median −11 ms / p95 53 ms, playback OK | `O2-O7.json` |
| O3 | Mobile-to-mobile portrait one-to-one | Portrait 720×1280 | ✅ `720x1280`, verification passed, A/V offset median −33 ms / p95 41 ms, playback OK | `O3.json` |
| O5 | Three or more participants | Landscape 1280×720 regardless of camera orientation | ✅ worst case tested — all 3 synthetic cameras set to **portrait** — canvas still locked `1280x720`, verification passed, playback OK. A/V offset p95 was 154 ms (median −17 ms) — above the main R2 report's 150 ms p95 bar, consistent with the already-documented CPU-contention pattern for multi-participant compositing on this machine (`PROJECT_CHECKLIST.md` "Failed" — T02, six participants), not something introduced by this change; the dimension decision under test was unaffected | `O5.json` |
| O6 | Rotate a mobile during recording | That participant's tile adapts; canvas orientation, recording and A/V are undisturbed | ✅ one participant rotated landscape→portrait at 18 s into a 40 s recording: canvas stayed `1280x720` throughout, **0 restarts**, 1 continuous segment, no flash/beep gaps, no freezes, full playback to end | `O6.json`, `O6.post-rotation.frame.png` |
| O7 | Portrait and landscape participants together | No cropping or distortion | ✅ same run as O2 — frame extracted at 20 s and visually inspected: all 4 corner markers on both participants' video are fully visible (letterboxed/pillarboxed, not cropped); portrait canvas correctly stacks the two tiles vertically instead of squeezing them side by side | `O2-O7.frame.png` |

Representative numbers (O6, the longest/most demanding run — rotation mid-call): duration 40.04 s vs 40.19 s expected wall time (within tolerance), H.264/AAC, faststart, 0 decode errors, 20/20 expected flash events detected with no gap >2.6 s, A/V offset median −20 ms / p95 58 ms (limits: ≤80 ms / ≤150 ms), played and seeked correctly in headless Chromium with byte-identical SHA-256 before and after the move into storage.

Not covered by this round (flagged, not silently dropped): a real mobile device's browser (only a synthetic camera of known pixel dimensions was used — sufficient to exercise the orientation-detection and contain-rendering logic itself, since both read the same WebRTC track dimensions a real phone would publish, but not a substitute for a hands-on check with an actual Android/iOS device over LAN); a 3+ participant call with a live rotation; the 30-minute soak/concurrency scenarios (T08/T09 in the main R2 report) re-run against the new orientation logic.

Files changed: `recording/layout/src/main.ts` (canvas orientation decision, contain rendering, portrait-aware 2-tile grid), `backend/src/OneInsure.Connect.Recorder/{RecordingSession,Finalizer,FinalizeCommand,Program}.cs`, `backend/src/OneInsure.Connect.Domain/Recording/MediaVerifier.cs` (`ProbeVideoDimensionsAsync`), `backend/src/OneInsure.Connect.Api/Recording/RecorderWorker.cs`. No database migration, no new configuration — the orientation decision is made entirely client-side by the browser compositor at record time.

## Recording, Recording Library and session bug fixes (11 Nov 2026)

**Environment:** `https://www.oneinsure.com/meet` and `Oneinsure_v` (deployed with approval).
**Evidence:**
- `tests/e2e/live/live-verify.mjs`: results JSON and screenshots in `tests/e2e/live/results/` (not committed);
- `dotnet test` (78 API + 18 domain tests);
- audit log entries `RECORDING_CAPTURE_STARTED` / `RECORDING_CAPTURE_ENDED` / `SESSIONS_DAILY_LOGOUT*`.

**Status values:** Passed / Failed / Partially Passed / Not Tested / Blocked — "Passed" only with an executed check.

**Accounts and devices:** the live runs used three disposable QA accounts, locked afterwards, and headless Edge with a fake camera and microphone on the server. No real phone, tablet or Mac was used.

| # | Scenario | Dev status | Evidence | UAT |
|---|---|---|---|---|
| R1 | Host starts internal meeting | Passed | L-01: meeting LIVE, host + peer in the room | ⏳ |
| R2 | Host starts internal recording | Passed | L-02/L-03 | ⏳ |
| R3 | No unnecessary acceptance gate where policy permits | **Blocked (policy data)** | Policies are still `CONSENT_REQUIRED` + placeholder wording; the code path for `NOTIFICATION_ONLY` exists and is unit-tested. The consent dead end itself is fixed: L-02, peer asked automatically. Needs the approved wording from the policy administrator. | ⏳ |
| R4 | REC only after actual capture | Passed | L-03: "Starting…" first; REC only when the DB says RECORDING | ⏳ |
| R5 | Host stops recording (with confirmation) | Passed | L-04 | ⏳ |
| R6 | REC disappears right after backend confirms stop | Passed | L-04: "Stopping" in 1.0 s, cleared in 2.0 s (host and peer) | ⏳ |
| R7 | Meeting continues after stop | Passed | L-04: both in room, meeting LIVE | ⏳ |
| R8 | Host records again in the same meeting | Passed | L-06 | ⏳ |
| R9 | Customer meeting auto-recording starts | Not Tested (live) | Unchanged code path (auto-start on the host's first state request); customer policy is MANDATORY + `CONSENT_REQUIRED`, so it waits for the customer's Accept until the policy is confirmed | ⏳ |
| R10 | Customer recording failure reported | Partially Passed | Failure toast and reason path in UI; `FailAsync` notifies owner + admins (unit tests). Not forced live. | ⏳ |
| R11 | MP4 finalised | Passed | L-05: PROCESSING→VERIFYING→COMPLETED, 10.9 s after capture end | ⏳ |
| R12 | MP4 playable | Passed | L-05: ffprobe h264/aac 1280×720; L-07: signed URL HTTP 206 `video/mp4` | ⏳ |
| R13 | Recording appears in Recording Library | Passed | L-07 | ⏳ |
| R14–R16 | Logout, login again, still visible to organiser | Passed | L-07: old cookie 401 after logout; after re-login both recordings listed | ⏳ |
| R17 | Admin sees recordings in scope | Passed | L-08: Admin → 200 | ⏳ |
| R18 | Unauthorised employee cannot access | Passed | L-08: attendee → 404; unit test: outsider 404 | ⏳ |
| R19 | Recorder crash during recording | Passed | L-06: recorder process killed → relaunched (part 2), parts joined, COMPLETED | ⏳ |
| R20 | Reconnect after network interruption, state in sync | Passed | L-06: peer offline 8 s → REC re-synced | ⏳ |
| R21 | Co-host / starter (not creator) sees the recording | Passed (automated) | `A_cohost_who_did_not_create_the_meeting_sees_and_plays_…` | ⏳ |
| S1 | Login / navigate / create / join meetings | Passed | L-01, L-07 | ⏳ |
| S2 | Active for an extended period without logout | Not Tested (live) | Shared idle clock and server keep-alive are code-reviewed and type-checked; the 30-minute timer was not run live | ⏳ |
| S3 | Daily warning (5 min before, countdown) | Passed (test mode) | L-10/L-11 screenshots | ⏳ |
| S4 | Daily logout at the cutoff | Passed (test mode) | L-10/L-11; the production time was checked separately in L-12 (next cutoff 23:30 IST = 18:00 UTC) | ⏳ |
| S5 | Invalidated session cannot reach protected APIs | Passed | L-07, L-10 (401); API test | ⏳ |
| S6 | Active meeting not corrupted by the daily reset | Passed (test mode) | L-10: stayed in the call (video on), banner shown, other participant unaffected | ⏳ |
| S7 | Sign in again after the reset | Passed | L-10 | ⏳ |
| S8 | Real 23:30 IST run | Passed | `app.AuditLog` #759: `SESSIONS_DAILY_LOGOUT` at 11 Nov 18:00:16 UTC (23:30:16 IST), 9 portal sessions ended at the cutoff | ⏳ |
| F | Full application start-to-end (dashboard, calendar, AI/MOM, admin modules, all devices) | **Not Tested** | Not run in this round. The existing click-through suites (`tests/e2e/scenarios`) target an isolated local API, not production. | ⏳ |

## Oneinsure_connect_bugs.docx — notice redesign, meeting end, late-joiner screen share, instant e-mails, Schedule page (13 Nov 2026)

Dev verification 13 Nov 2026 in the isolated environment: Edge with fake camera/mic, separate browser process per participant, LocalDB `OneInsureVideoMeetingDB_Rec`, local LiveKit 1.13.11. API tests **92/92**. UAT: **pending**.

| ID | Check | Result | Evidence |
|---|---|---|---|
| RN-01 | Customer on a phone (390×844): one card — "Meeting Recording Notice", the approved wording, "For assistance: support@oneinsure.com", ONE "OK, got it"; no placeholder, version or policy text | ✅ Passed | card 366×298 px (≤ 46% of the screen); one 332×44 px button; closes on tap |
| RN-02 | Host: same card, no internal note once the wording is confirmed; acknowledgements recorded (consent rows + audit) | ✅ Passed | `EMPLOYEE:GRANTED:PLVC-NOTICE-1.0`, `CUSTOMER:GRANTED:PLVC-NOTICE-1.0`, 2 audit rows |
| SS-01 | Customer A (desktop) presents; host sees it | ✅ Passed | 1920×1080 "Asha Customer is presenting" |
| SS-02 | Guest B joins **on a phone-sized browser** while A presents → sees it without refresh or restart | ✅ Passed | 960×540 frames 9.6 s after opening the link; host unaffected |
| SS-03 | Guest C joins later still → sees it; exactly one screen tile at host/B/C | ✅ Passed | 1,1,1 |
| SS-04 | A stops → the share disappears for host, B, C | ✅ Passed | |
| SS-05 | C starts presenting → host, A, B (phone) see C's screen | ✅ Passed | |
| END-01 | Host ends for everyone while C is **offline**: A, B, host see "Meeting Ended" at once; C sees it when back online; nobody sees "Connection lost" or "Reconnecting…" after the end; local media released; meeting COMPLETED | ✅ Passed | 1.4 s after End for all; C 1.1 s after reconnecting |
| END-02 | End again → 204 (idempotent, one `MEETING_ENDED` audit row); the link then reports ENDED | ✅ Passed | |
| END-03 | No browser errors | ✅ Passed | |
| IM-01 | Instant PLVC: 3 rows, one removed, Start double-clicked → **1** meeting, **2** e-mails, each with only its owner's personal link; removed person not e-mailed | ✅ Passed | outbox rows `MEETING_INSTANT_INVITED`; token hashes map to their own participants |
| IM-02 | Invite people shows e-mail status; a failed one → "Send again" → new e-mail + new personal link for that person only (old revoked); meeting not re-created; audited | ✅ Passed | failure simulated in the local DB |
| IM-03 | Invalid e-mail and half-filled row rejected, nothing created | ✅ Passed | browser message + "Enter the e-mail address." |
| SC-01 | Schedule Meeting (1366 px): two columns, every field present, Schedule button visible without scrolling | ✅ Passed | columns 698 px + 340 px; button at y=399 |
| SC-02 | PLVC scheduled through the redesigned form | ✅ Passed | `SCHEDULED`, Prarambh 8812345, invitation queued |
| SC-03 | Save as draft | ✅ Passed | |
| SC-04 | Phone 390×844: one column, no horizontal scroll | ✅ Passed | scrollWidth 390 |
| RP-01 | Reports: Prarambh Main ID column + search by ID (found and fixed a summary error: `TotalHours` decimal vs double) | ✅ Passed | |
| Regression | `goodday-fixes-3` 5/5 (internal-note check updated to the new design), `consent-request` 15/15 | ✅ Passed | |
| R-iOS | Late joiner on a **real iPhone (Safari)** | ⏳ Not tested | Not available here. The live log (room `oic_20ff6f…`, 12:13 IST) shows the server subscribed the iPhone to the share; the room now retries playback / re-subscribes when a remote share shows no picture. Needs a real iPhone check. |
| R-email | Real e-mail delivery of instant invitations | ⏳ Not tested | E-mail is switched off in the test environment; live uses the existing outbox worker. |
| SK-01 | "Skip details & start meeting" (after typing a Prarambh ID and a half-filled row) → UNIDENTIFIED: no ID, no customer, no participants, no e-mails; Invite offers only the meeting link; **recorded**; file `20261113/OIC-261113-R642-REC10054.mp4` (no ID prefix) | ✅ Passed | V024 on the test DB |
| SK-02 | Meeting page "Unidentified PLVC" → host adds `9988` after the meeting ended → IDENTIFIED; recording metadata 9988, file unchanged; 1 `MEETING_PRARAMBH_ADDED` audit row | ✅ Passed | |
| API | Skip, reports filters, correction rules (403 / 400 / 409 on second change), external API needs explicit request + scope | ✅ Passed | API test `Skipped_PLVC_details_…` (93/93) |
| RN-02+ | Mandatory PLVC recording really starts with the live policy state (PENDING_CONFIRMATION + approved wording) | ✅ Passed | status RECORDING |

## GoodDay #14216 — PLVC recording notice not closing (13 Nov 2026)

**Environment:** the isolated copy (LocalDB `OneInsureVideoMeetingDB_Rec`, isolated LiveKit, Edge headless), with Customer PLVC set to MANDATORY + NOTIFICATION_ONLY as in production.

| # | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|
| GD3-01 | Host on desktop: banner shows the internal note; × is 44×44 px; an off-centre click closes it; still closed after a state poll | Passed | `goodday-fixes-3` results, `gd3-01-*.png` | ⏳ |
| GD3-02 | Customer on phone (390×844, touch): no internal note; banner ≤ 40% of the screen; "OK, got it" 44 px tall closes it; stays closed | Passed | `gd3-02-customer-*-390px.png` | ⏳ real phone |
| GD3-03 | Acknowledgement still recorded for host and customer; recording running | Passed | DB rows EMPLOYEE:GRANTED, CUSTOMER:GRANTED | — |
| GD3-04 | MaXW9q, reopened: phone with touch: More sheet backdrop covers 390×844; a tap on the video closes it; Close button 44×44 closes it | Passed | `gd3-04-more-sheet-390px.png` | ⏳ real iPhone |
| GD3-05 | CVPJMP, reopened: 15-min meeting started 12 min early → slot runs 15 min from the actual start; auto-end 5 min after; late start keeps the booked end (API test) | Passed | `goodday-fixes-3` results; API test | ⏳ |

## Master enhancement batch — Modules 1–14 (12–13 Nov 2026)

**Environment:**
- Isolated local copy: LocalDB `OneInsureVideoMeetingDB_Rec` with V022/V023, isolated LiveKit, the real R2 recorder, Edge headless.
- API tests run on throw-away LocalDB databases built from all migrations.

**Deployed 13 Nov 2026 00:01 IST** (DB backup; V022/V023; API ~8 s down; website). Checked on the live site:
- health is Healthy;
- the bundle contains the new pages;
- `/meet/api-docs` returns 200;
- the OpenAPI document is served with server `https://www.oneinsure.com/meet`;
- `/meet/api/ext/v1/me` returns 401 without a key and with a bad key;
- the admin integration API returns 401 without a session.

**Evidence files:**
- `tests/e2e/recording/results/enhancements-1112-2026-11-12T18-19-50-632Z.json` (6/6) and `results/screenshots/enhancements-1112/`;
- API suite **91/91** (13 Nov 2026: the 4 older recording tests were brought up to date with the intended behaviour; no product code changed);
- regression: goodday-fixes 8/8, goodday-fixes-2 4/4, repeat-alignment 6/6, consent-request 15/15.

| # | Module | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|---|
| M1.1 | 1 | Instant → Customer PLVC: Prarambh box + participant rows; no "Add customer" | Passed | EN-01 | ⏳ |
| M1.2 | 1 | Validation: Prarambh required; non-digits stripped; participant name/e-mail required; duplicate e-mail refused | Passed | EN-01; API `Portal_PLVC_meetings_take_participant_rows…` | ⏳ |
| M1.3 | 1 | Add (+) / remove (×) participant rows | Passed | EN-01 (3 rows → 2) | ⏳ |
| M1.4 | 1 | Instant PLVC created: Prarambh stored exactly (leading zeros kept); customer created or reused from the first participant; others are guests; personal links shown in the invite dialog | Passed | EN-01; API test (`000123` kept, second meeting reused the customer) | ⏳ |
| M1.5 | 1 | Scheduled PLVC: participant rows + Prarambh; detail page shows it; invitation e-mail queued | Passed | EN-02 | ⏳ |
| M1.6 | 1 | Prarambh refused for non-PLVC categories (portal and API) | Passed | API tests | — |
| M2.1 | 2 | Audio-only meeting: Present available, no camera button, sharing works without the camera | Passed | EN-04 | ⏳ |
| M2.2 | 2 | Guests and customers get screen share (token sources, `CanScreenShare=1`) | Passed | API `RoomTests`, `MeetingLinkTests`, `Portal_PLVC…` | ⏳ |
| M2.3 | 2 | Phone and tablet browsers that cannot capture a screen show the "not supported" message | Not Tested (this batch) | Unchanged control from 11 Nov; needs a real phone | ⏳ |
| M3.1 | 3 | Real PLVC recording stored as `YYYYMMDD/<Prarambh>-<code>-REC<id>.mp4`, with the IST date | Passed | EN-06: `20261112/706082601-OIC-261112-QWD3-REC10030.mp4` (recorded 23:48 IST) | ⏳ |
| M3.2 | 3 | IST date boundary (20:00 UTC → next IST day), non-PLVC name, collision suffix, unsafe input never used | Passed | API `Recording_keys_are_date_wise_in_IST…` | — |
| M3.3 | 3 | MP4 metadata title `<Prarambh>-<code>` | Passed | EN-06 (ffprobe) | — |
| M3.4 | 3 | Existing recordings still play and download (old keys) | Passed (code path) | Same StorageKey resolution; GD-08 / CR suites still pass | ⏳ |
| M4.1 | 4 | Retention expiry with legacy DELETE: flagged for review only, file kept, no deletion queued; DELETE cannot be chosen | Passed | `Retention_review…` (whole test passes, 13 Nov) | — |
| M4.2 | 4 | Manual deletion: reason, dual approval, legal hold, audit | Passed | `Retention_review…` now runs to the end (13 Nov): legal hold, archive + playback from archive, manual delete → PENDING, same approver twice → 409, second approver → EXECUTED/PURGED, exactly 1 purge audited, the expired legacy-DELETE recording untouched | ⏳ |
| M5.1 | 5 | Start instant meeting → pre-join without refresh | Passed | EN-01 (shown 0.7–1.4 s after Start) | ⏳ |
| M5.2 | 5 | Room page chunk fails once → one automatic reload → room opens | Passed | EN-03 (module requested twice) | — |
| M5.3 | 5 | Chunk fails permanently → "This page did not load properly" card + Reload (never white) | Passed | EN-03, `en03-error-card.png` | — |
| M5.4 | 5 | Real iOS Safari / Android Chrome | Not Tested | Needs devices | ⏳ |
| M6.1 | 6 | No idle timeout: `idleMinutes 0`; session valid after 3 h without requests | Passed | API `Sessions_have_no_idle_timeout…`; EN-01 | ⏳ |
| M6.2 | 6 | Session ends at the next 23:30 IST (absolute = idle = cutoff) | Passed | Same API test | ⏳ |
| M6.3 | 6 | 23:25 warning / 23:30 logout / admin test mode | Passed (existing) | `DailyLogoutTests` | ⏳ real evening |
| M7 | 7 | Thinner toolbar, support line in the room | Passed | Section above (T1–T8), deployed 22:59 IST | ⏳ |
| M8.1 | 8 | System → API Documentation visible to admins only; guide; endpoint table from OpenAPI (13); Swagger UI (13 operations); OpenAPI download | Passed | EN-05 | ⏳ |
| M8.2 | 8 | Create integration → Integration ID + key shown once → key works; only the hash is stored | Passed | EN-05; API test | ⏳ |
| M8.3 | 8 | Revoke key → 401 immediately; rotate → new key works; deactivate → 403 | Passed | EN-06 (UI revoke); API test | ⏳ |
| M9.1 | 9 | API: instant PLVC with participants; Prarambh mandatory and digits only; host mapping | Passed | API test; EN-06 | ⏳ |
| M9.2 | 9 | API: scheduled meeting (needs `meeting.schedule`), invitation e-mails, cancel | Passed | API test | ⏳ |
| M9.3 | 9 | Idempotency: same key returns the same meeting; different body → 422 | Passed | API test | — |
| M10.1 | 10 | Completion report: meeting Completed with recording Processing → Failed → Completed → Deleted (independent statuses) | Passed | API `Completion_report…` | ⏳ |
| M10.2 | 10 | Report with real attendance (IST, attended seconds) | Passed (synthetic rows) | API test. In the isolated environment the video server sends no webhooks, so EN-06 correctly showed no attendance (null, not invented) | ⏳ live |
| M11.1 | 11 | Signed download link: streams (Range 206), tampered → 403, deleted → 410, another portal → 404, audited | Passed | API test; EN-06 (417,447 bytes) | ⏳ |
| M12.1 | 12 | Webhooks: signed (HMAC verified by receiver), each state change once, no personal data, retry on failure, admin history | Passed | API `Webhooks_are_signed…`; EN-06 (6 event types) | ⏳ |
| M13 | 13 | V022/V023 applied to production in a transaction with history rows; backup taken | Passed | Deployment log (CHANGELOG) | — |
| S1 | Security | Portal A cannot read, report on or download Portal B's meeting (404); missing scope → 403 INSUFFICIENT_SCOPE | Passed | API test | — |
| S2 | Security | Per-integration rate limit (429) without affecting other integrations | Passed | API test | — |
| S3 | Security | OpenAPI lists only /api/ext endpoints (no internal APIs) | Passed | API `OpenApi_document_lists_only…` | — |
| S5 | All APIs | Endpoint-by-endpoint run, 13 Nov 00:32 IST: every external endpoint and every integration-admin endpoint, with success and error cases (auth, scopes, isolation, rate limit, idempotency, validation, cancel, report, signed download + Range + tampered + deleted, webhook create/test/rotate/retry/delete with signed delivery) | Passed 58/58 | `tests/e2e/api/api-smoke.mjs` → `tests/e2e/api/results/api-smoke-2026-11-12T19-02-51-105Z.json` (isolated environment). Full API suite 91/91. Production, read-only: health, OpenAPI, /api-docs page, and all 13 external routes + admin routes answer with the expected 401/403 without valid credentials (21/21, after correcting 2 curl calls that omitted Content-Length) | ⏳ |
| S4 | Docs | OpenAPI imports into Postman | Not Tested | Postman not installed here; document validated with `@apidevtools/swagger-parser` (OpenAPI 3.1.1, 10 paths, 22 schemas) | ⏳ |

## Mobile toolbar, support e-mail, screen-share recording orientation (12 Nov 2026)

**Environment:** isolated local copy (LocalDB `OneInsureVideoMeetingDB_Rec`, isolated LiveKit on 7890, real R2 recorder, Edge headless with fake camera and screen). **Deployed 12 Nov 2026 22:59 IST** (live bundle verified). **Evidence:** `tests/e2e/recording/goodday-fixes.mjs` 8/8 (12 Nov 17:18 UTC, `results/goodday-fixes-2026-11-12T17-18-40-674Z.json`); screenshots in `results/screenshots/goodday-fixes/gd06-*.png` and `gd08-recording-frame-during-share.png`.

| # | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|
| T1 | Guest on a phone: the sign-in footer is not rendered in the room; no "it.support" text anywhere | Passed | GD-06: footer `display:none` | ⏳ |
| T2 | Every control is the element under its own centre, with no horizontal overflow, the bar inside the viewport and every button ≥ 44 px, at 320×568, 360×740, 390×844, 430×932, 844×390 (phone landscape), 768×1024, 1024×768 and 1366×768 | Passed | GD-06: bar 60/62/62/62/56/68/68/68 px; smallest button 44 px (320 wide), else 46–48 px | ⏳ |
| T3 | Phone: More sheet shows "Need help? support@oneinsure.com" | Passed | GD-06, `gd06-more-sheet-support.png` | ⏳ |
| T4 | Mic tap still toggles on a phone (control handlers unchanged) | Passed | GD-06 | ⏳ |
| T5 | Desktop host (landscape camera) + phone guest (portrait camera); host presents → recording is landscape, screen share large with both cameras in the side strip | Passed | GD-08: 1280×720 MP4, frame checked visually | ⏳ |
| T6 | Two phones (both portrait) → recording still portrait | Not Tested | No automated two-phone case yet; the rule is unchanged in code for this case | — |
| T7 | Real iPhone Safari / Android Chrome (safe area, browser bars, keyboard) | Not Tested | Emulated viewports only; needs a device check after deployment | — |
| T8 | Desktop layout otherwise unchanged; other in-room flows (invite e-mail, tile expand, recording consent) | Passed | GD-05, GD-07, GD-08 in the same run | ⏳ |

## GoodDay "Meet" batch, part 2 (12 Nov 2026)

**Environment:** isolated local copy. **Deployed 12 Nov 2026 17:10 IST** (health Healthy; live bundle and endpoints verified; GoodDay updated). **Evidence:** `tests/e2e/recording/goodday-fixes-2.mjs` 4/4 (12 Nov 11:24 UTC); API test `A_live_meeting_can_be_extended_and_otherwise_ends_automatically_after_its_scheduled_time` and the customer-link checks in `An_instant_PLVC_call…` pass (suite 80/84, the 4 are pre-existing).

| # | GoodDay | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|---|
| H1 | #14206 | Instant dialog: internal type → "Calling a customer? Choose Customer PLVC"; hidden for PLVC | Passed | GE-01 | ⏳ |
| H2 | #14195 | Customer meeting → Send link to customer → WhatsApp (wa.me/91…) + E-mail + Copy; the link opens the customer's invitation | Passed | GE-02; API customer-link checks | ⏳ |
| H3 | #14208 | Countdown 5 min before the end on every screen; host-only Extend 15 → +15 min, everyone updated live | Passed | GE-03 | ⏳ |
| H4 | #14208 | Overdue: "ends automatically in m:ss" + End now; nobody extends → server ends the call for everyone; audited SYSTEM | Passed | GE-04 (COMPLETED 34 s later, both disconnected) | ⏳ |
| H5 | #14208 | Within the grace the meeting keeps running; after it, COMPLETED and cannot be extended | Passed (API) | auto-end API test | ⏳ |
| H6 | #14196 | Personal Gmail invitations | Passed (production log) | trn_logemail: DELIVERED / OPEN / CLICK for every Gmail invitation | ⏳ |
| H7 | #14197 | Login with real employee code | Passed (data) | Applied 12 Nov ~17:30 IST; the sign-in lookup resolves 6433 / 5509 / 109812 / 0003 / 0002 to the right accounts (no live password attempt made) | ⏳ |

## GoodDay "Meet" bug batch (12 Nov 2026)

**Environment:** isolated local copy (LocalDB `OneInsureVideoMeetingDB_Rec`, isolated LiveKit, real R2 recorder). **Deployed 12 Nov 2026 16:05 IST** (live bundle and recorder layout verified; health Healthy; G1–G8 marked RESOLVED in GoodDay). **Evidence:** `tests/e2e/recording/goodday-fixes.mjs` 8/8 (12 Nov 10:16 UTC); regression `consent-request.mjs` 15/15 (10:22 UTC); frontend and recorder-layout type checks clean.

| # | GoodDay | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|---|
| G1 | #14212, #14192 | One "Schedule meeting" (header), "Instant meeting" on the dashboard, no second Schedule button | Passed | GD-01 | ⏳ |
| G2 | #14209 | Today's Meetings card → My Meetings, Today tab | Passed | GD-02 | ⏳ |
| G3 | #14210 | Upcoming Meetings card → My Meetings, Upcoming tab (was the calendar) | Passed | GD-03 | ⏳ |
| G4 | #14211 | "Attending" renamed "Invited"; one line under the tabs explains each list | Passed | GD-04 | ⏳ |
| G5 | #14207 | Invite people → E-mail opens the mail app; the call continues | Passed | GD-05: no unload, room still connected; a `beforeunload` no longer disconnects | ⏳ |
| G6 | #14205 | Guest on an iPhone-sized screen: every control reachable and tappable | Passed | GD-06: 6/6 controls; control run with the old z-index shows the footer covering Leave | ⏳ |
| G7 | #14203 | Tile expand button → that person on the main stage; again → grid | Passed | GD-07 | ⏳ |
| G8 | #14204 | 1:1 portrait recording + desktop screen share: share full width at the top | Passed | GD-08: 720x1280 MP4, frame checked | ⏳ |
| G9 | #14193, #14190, #14191 | Already live (12 Nov / 11 Nov deployments) | Passed (production smoke) | Marked RESOLVED in GoodDay with notes | ⏳ |
| G10 | #14197 | Login with employee ID | Not a code defect | Production employee codes are placeholders (0002, 0003, 0111…); failed attempts used 6433 and 107249. Needs the real codes | Blocked |
| G11 | #14196 | Invitation to a personal (Gmail) address not received | Blocked | 14/14 external e-mails handed to `Util_SendEmail2` with no error; delivery beyond is the company mail server | Blocked |
| G12 | #14208, #14206, #14195 | Auto-end at scheduled time; customer consent on video; send link by mobile | Not Tested | Need a product decision (see CHANGELOG) | — |

## New users without an employee record (12 Nov 2026)

**Environment:** isolated local copy; deployed 12 Nov 12:41 IST. **Evidence:** `tests/e2e/recording/user-employee-link.mjs` 3/3 (12 Nov 06:56 UTC); API test `An_account_for_someone_in_the_employee_master_is_linked_automatically_never_left_without_a_calendar`.

| # | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|
| U1 | Create user → Add new employee → account created linked | Passed | UE-01 | ⏳ |
| U2 | E-mail only shows the "cannot schedule / no calendar" warning | Passed | UE-02 | ⏳ |
| U3 | Existing unlinked account → Link to employee → Add new employee (e-mail prefilled) → linked | Passed | UE-03 | ⏳ |
| U4 | E-mail-only account for an existing employee is linked automatically | Passed (API) | linkedToEmployee = true; /auth/me employeeLinked | ⏳ |
| U5 | Account created before its employee → linked at next sign-in (audited) | Passed (API) | USER_EMPLOYEE_LINKED, privileged | ⏳ |
| U6 | Production | Passed (smoke) | Deployed 12 Nov 12:41 IST: health Healthy; live bundle contains "Add new employee" and the e-mail-only warning. Linking Harsh's account needs the real employee details | ⏳ |

## Instant meeting with PLVC / customer general; PLVC recording without acceptance (12 Nov 2026)

**Environment:** the same isolated local environment as the consent requests below, with V021 applied — **not production, not deployed**.
**Evidence:** `tests/e2e/recording/instant-plvc.mjs`. Final run 12 Nov 05:56 UTC: **6/6**, results in `tests/e2e/recording/results/instant-plvc-2026-11-12T05-57-21-722Z.json`, screenshots in `…/screenshots/instant-plvc/`. API test `An_instant_PLVC_call_with_a_customer_records_automatically_and_nobody_has_to_accept`.

| # | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|
| P1 | Dashboard button renamed "Instant meeting" | Passed | IP-01 | ⏳ |
| P2 | Instant dialog offers Customer — PLVC and Customer — General (plus internal types) | Passed | IP-01: two option groups | ⏳ |
| P3 | PLVC shows "Recording starts automatically … no acceptance is needed"; no NONE/OPTIONAL choice | Passed | IP-02 | ⏳ |
| P4 | Customer general keeps consent ("each participant is asked to accept") | Passed | IP-02; API test: `CUSTOMER_GENERAL` → `CUSTOMER_MEETING` | ⏳ |
| P5 | A customer is required for a customer instant meeting | Passed | IP-02 (UI message); API test (400) | ⏳ |
| P6 | Instant PLVC call created with the customer; Invite dialog shows the customer's personal link | Passed | IP-03: `CUSTOMER_PLVC`, `INSTANT`, `REQUIRED`, policy number defaulted | ⏳ |
| P7 | PLVC recording starts automatically; REC only after the recorder confirms capture; no consent request | Passed | IP-04: `PENDING → RECORDING` about 8–11 s after the host joined; audit "Mandatory recording started automatically"; 0 requests | ⏳ |
| P8 | Customer joins via personal link (phone width): REC + notice banner, no Accept/Decline | Passed | IP-05: `CUSTOMER` participant; banner shown; acknowledgement stored automatically (1 row) | ⏳ |
| P9 | Actual MP4 | Passed | IP-06: `COMPLETED` 34 s, H.264/AAC, ffprobe 33.6 s | ⏳ |
| P10 | Production deployment | Passed (smoke) | Deployed 12 Nov 11:45 IST: API health Healthy; live bundle contains "Instant meeting", "Start an instant meeting", "Recording starts automatically", the customer link; DB: `CUSTOMER_PLVC` → `CUSTOMER_PLVC` (MANDATORY, NOTIFICATION_ONLY). A real PLVC call on production not yet made | ⏳ |
| P11 | Approved notice wording / policy approval for PLVC | **Blocked** | Placeholder shown verbatim and flagged; with `Recording:Environment` = Pilot/Production the gate refuses customer recording until the policy is confirmed (unchanged rule) | ⏳ |

**Test-environment note (not an app issue):** after another network adapter on the server came up, the isolated LiveKit advertised `127.0.0.1` for UDP but was not bound there, so the headless recorder could not connect. Fixed for the test by advertising the bound vEthernet address (`node_ip 172.21.80.1`). Production LiveKit and its configuration were not touched.

## Recording consent requests — popup for every participant (12 Nov 2026)

**Environment:** isolated, on the server — **not production**.
- LocalDB `OneInsureVideoMeetingDB_Rec` with V001–V020;
- API (Debug build) on `https://localhost:7192`;
- Vite on `http://127.0.0.1:5176`;
- a separate LiveKit 1.13.11 on loopback ports 7890–7892;
- the real R2 recorder (`OneInsure.Connect.Recorder`, Release build) with FFmpeg.

**Not deployed.**

**Browsers:**
- 5 independent headless Microsoft Edge instances, each with its own fake camera and microphone: host, two employees, a late-joining employee, and a guest who joins through the meeting link on a **390 × 844 phone-sized** viewport.
- No physical phone, tablet or Mac was used.

**Evidence:**
- `tests/e2e/recording/consent-request.mjs`. The final run, 12 Nov 04:35–04:39 UTC, passed **15/15**. Results are in `tests/e2e/recording/results/consent-request-2026-11-12T04-39-44-971Z.json` and screenshots in `tests/e2e/recording/results/screenshots/consent/` (not committed).
- API tests in `RecordingTests.cs`.

**Policy used:** team meetings, optional recording, `CONSENT_REQUIRED`, consent from all. Notice wording left as the configured placeholder, which must not be invented.

**Measured:**
- Popup on every participant **0.7–1.6 s** after the host's click (5 runs).
- Host panel updated **at once**, with no refresh.
- Last acceptance → REC **9.2–9.9 s** (recorder start-up, unchanged).

**Earlier runs found and fixed three real issues** before the final run:
1. The host panel covered the Participants panel's Admit button.
2. A link guest who rejoins is a *new* participant, so their old entry stayed Disconnected for good. Fixed with the host's remove action.
3. The original host's room did not wire up that remove action.

| # | Scenario | Status | Evidence | UAT |
|---|---|---|---|---|
| C1 | Host + one participant | Passed | CR-14: request → popup → accept → REC → MP4 `COMPLETED` (10 s) | ⏳ |
| C2 | Host + multiple participants | Passed | CR-01/02: host + 2 employees + guest; +1 newcomer (CR-10) | ⏳ |
| C3 | Host + guest participant | Passed | CR-01/02/06/09/11: guest via meeting link (phone width) got the popup, declined, rejoined, accepted | ⏳ |
| C4 | All participants receive the popup | Passed | CR-02: Ravi, Priya and the guest within about 1 s; not the requesting host; the control bar stays clickable; no horizontal overflow at 390 px | ⏳ |
| C5 | Everyone accepts → recording starts | Passed | CR-11: request `STARTED`; host indicator `PENDING → RECORDING`; REC only when the DB says `RECORDING`; all 5 see REC; audit "Host started recording: every participant accepted the recording request" | ⏳ |
| C6 | One participant declines → no recording | Passed | CR-06: request `DECLINED` (audited); host toast "Neha Guest declined recording. The recording request was cancelled."; 0 recordings; Record available again. API test too | ⏳ |
| C7 | One participant stays pending → no recording | Passed | CR-05: 6 s with the guest pending → 0 recordings, host panel Pending | ⏳ |
| C8 | Participant disconnects before responding | Passed | CR-08: host panel "Disconnected" (grey); no recording. API test: Disconnected is never counted as accepted | ⏳ |
| C9 | Participant reconnects while pending | Passed | CR-09: guest rejoined → popup again automatically → Pending. The old entry was removed by the host (audited). CR-10: employee page reload → asked again, listed once | ⏳ |
| C10 | New participant joins while pending | Passed | CR-10: Arjun gets the popup on joining; host panel "3 of 5 accepted" | ⏳ |
| C11 | Duplicate Accept click | Passed | CR-03: double click + extra click → 1 evidence row; confirmation, then the popup closes | ⏳ |
| C12 | Network interruption during submission | Passed | CR-04: request cut off → error shown, buttons re-enabled, still Pending on the host; retry → Accepted | ⏳ |
| C13 | R2 recorder start-up failure | Passed | CR-13: every recorder launch killed before capture (3 of 3) → `FAILED`; host toast "Recording could not be started: …"; REC never shown; no start time recorded. (A single crash is healed by the existing relaunch, as seen in run 6.) | ⏳ |
| C14 | Actual MP4 recording and playback | Passed | CR-12: 25 s, 1.38 MB, H.264/AAC 1280×720, ffprobe 25.0 s; signed play URL → HTTP 206 `video/mp4` | ⏳ |
| C15 | No popup when the meeting starts (optional recording) | Passed | CR-01: no popup on any of 4 screens for 5 s; no request row | ⏳ |
| C16 | Host cancels / request expires | Passed (API) | `The_host_can_cancel_a_consent_request_and_an_unanswered_request_expires`; ending the meeting closed the open request (E2E cleanup log) | ⏳ |
| C17 | Production | Passed (smoke) | Deployed 12 Nov 11:45 IST; live room bundle contains the consent popup and host panel; V020 tables exist. A live multi-user request not yet made | ⏳ |
| C18 | Real phones/tablets, other browsers (Safari, Firefox) | **Not Tested** | Only headless Edge, including a phone-sized viewport | ⏳ |
| C19 | Approved consent wording | **Blocked** | Placeholder still shown and flagged; needs the policy administrator | ⏳ |

## Phases E–H

Added here as each phase is delivered.
