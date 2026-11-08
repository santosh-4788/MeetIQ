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

## Phases E–H

Added here as each phase is delivered.
