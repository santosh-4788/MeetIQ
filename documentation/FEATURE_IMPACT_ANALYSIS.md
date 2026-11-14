# Feature impact analysis — Master enhancement prompt (Modules 1–14 + additional requirements)

**Phase 1 (inspection only) — 12 Nov 2026.** No schema, production data or deployment changes were made.

**Repository:** `E:\Beeinsured.com\MeetIQ`. The prompt names `E:\OneInsure Connect`, which is not where the project lives on this server.

**Stack:**
- ASP.NET Core minimal API (.NET 10, Dapper)
- SQL Server `Oneinsure_v` (schemas `auth`, `org`, `crm`, `mtg`, `rec`, `app`; migrations V001–V021)
- React 19 + Vite frontend
- Self-hosted LiveKit
- R2 recorder (Edge + MediaRecorder → FFmpeg)

Everything is free/open-source; no paid service is needed for any module below.

Status key: **Exists** · **Partial** · **Greenfield** · **Decision needed** (cannot proceed without the business owner).

---

## Module 1 — PLVC participants + Prarambh Main ID · Partial · Decision needed

**Today:**
- Categories are hard-coded: CHECK `CK_Meetings_Category` (V005:36), `MeetingEndpoints.cs:35`, `api/meetings.ts:8-17`, `pages/meetings/meta.tsx:32-46`.
- PLVC/GENERAL **require** a `crm.Customers` row (`CK_Meetings_CustomerRequired`, V005:41).
  - In the instant flow: `QuickMeetingDialogs.tsx:127-138` (`CustomerPicker` + "Add new customer").
  - In the scheduled flow: `MeetingForm.tsx:413-440`.
- Guest rows (name + e-mail, max 20, validated, de-duplicated) exist in the scheduled form only (`MeetingForm.tsx:787-822`; backend `ValidateGuests` `MeetingEndpoints.cs:117-130`, stored as `GUEST` in `mtg.MeetingParticipants`). The instant dialog has no guest support.
- There is no Prarambh field anywhere. `org.Employees.ExternalRef` is reserved and unused.

**Change:**
- Migration V022: `mtg.Meetings.PrarambhMainId NVARCHAR(?) NULL` plus CHECK "required when Category = CUSTOMER_PLVC" (new rows only — existing PLVC meetings have none, so the CHECK must be `NOT VALIDATED`-safe or trigger-based). The same column goes on `rec.MeetingRecordings` as a snapshot.
- Frontend: for PLVC, replace `CustomerPicker` with a participant-rows editor (reusing the guest rows) plus a Prarambh Main ID box, in both dialogs.
- Backend: `InstantInput` / `MeetingInput` gain `prarambhMainId` and `participants[]`.

**Decisions needed:**
1. **Prarambh Main ID format:** digits only? Length? Letters or `-` allowed? I will not invent a rule.
2. **Customer record:** PLVC currently requires a customer record (used by the dashboards, reports, recording access and customer-link features). Options:
   - (a) create/reuse a `crm.Customers` row from the first participant (keeps every report working); or
   - (b) relax the constraint for PLVC (reports would lose the customer link).

   **Recommended: (a).**

## Module 2 — Screen share in every meeting · Exists for staff · Decision needed

**Today:**
- The rule is `RoomEndpoints.cs:178`: `screen = CanPublish && (isHost || p.CanScreenShare)`.
- Neither category nor audio-only blocks sharing. Audio-only removes the camera only. The camera is not turned on by sharing.
- Employees and hosts can share. **Guests and customers cannot** (`CanScreenShare=0`: `MeetingEndpoints.cs:214,321`, `MeetingLinkEndpoints.cs:179,441`).
- Unsupported browsers already show a "not supported" button with a message (`MeetingRoom.tsx`, `ctl-present-unsupported`).

**Decision needed:** should **customers and external guests** also be allowed to share? This is a business/security choice (for example, a customer sharing their screen in a PLVC recording).

**Change if yes:** set `CanScreenShare=1` at those inserts. This is a one-line backend change plus tests.

## Module 3 — Date-wise storage + PLVC filename · Partial

**Today:**
- Key `yyyy/MM/dd/<random-hex>.mp4` (`RecorderWorker.cs:456`), dated in **UTC**: a recording at 02:00 IST lands in the previous day's folder.
- The name is deliberately opaque, with no meeting data. The meeting code is in the MP4 metadata and in the download filename.
- DB: `rec.MeetingRecordings.StorageKey` (CHECK: relative, no `..`; unique index). Playback/download resolve `StorageRoot|ArchiveRoot + StorageKey` and never expose the path (signed short-lived token, `RecordingAccess.cs:124-148`).

**Change (new recordings only):**
- Key `YYYYMMDD/<name>.mp4` with the date taken from the recording's **start** in Asia/Kolkata.
- Name:
  - `OIC-<meetingCode>-<recordingShortId>.mp4`
  - PLVC: `<sanitisedPrarambhId>-<meetingCode>-<recordingShortId>.mp4`
- Collision: the unique index plus a numeric suffix.
- Existing keys keep working unchanged, because playback reads `StorageKey` as stored. No migration of old files is proposed.

**Note:** filenames will then contain the meeting code and the Prarambh ID. No customer name or e-mail is ever used.

## Module 4 — Automatic deletion · Exists but inactive · Compliance flag

**Today:**
- `Recording/RetentionWorker.cs` runs hourly (`Recording:RetentionEnabled=true`). It can REVIEW, ARCHIVE or DELETE (dual approval) recordings whose policy has `RetentionDays`.
- **No policy has `RetentionDays` set** (V012 seeds are placeholders; V018 and V021 left retention untouched; `RECORDING_POLICY_CONFIGURATION.md:61` says "not set"). So today **nothing is ever deleted automatically.**
- Legal hold, manual deletion with reason, audit, dual approval and the "no PURGED unless the file delete succeeded" rule all already exist (V012, V019, `RecordingLibraryEndpoints.cs:346-537`). `PurgeAsync` refuses legal-hold and non-COMPLETED recordings.

**Compliance conflict:** `PRODUCTION_APPROVAL_CHECKLIST.md:18` lists "Existing retention period and expiry action — Compliance — ⏳ values to be supplied". So Compliance still owes a retention decision. Hard-disabling expiry deletion pre-empts that decision and needs their sign-off.

**Proposed change (after sign-off):**
- Take the `DELETE` action out of the retention worker. Retention may still flag (REVIEW) or archive.
- Block saving `ExpiryAction=DELETE` in the policy admin.
- Manual deletion stays as is.
- No existing files are touched.

## Module 5 — Instant meeting blank screen · Root-cause candidates found

**Facts:**
- Navigation happens only after the API answers.
- The room route is lazy-loaded with a Suspense fallback (`App.tsx:30,78-85`).
- **There is no React error boundary anywhere.** A failed lazy chunk download — typical right after a redeploy, when the browser still has the old `index` with old chunk hashes — or any render exception unmounts the whole app and leaves a **blank page that a refresh fixes**. This matches the report exactly.
- Pressing Enter in the dialog can re-submit while the request is busy, because `start()` does not check `busy`.

**Change:**
- Error boundary around the room route, with a "Reconnect" card.
- A `vite:preloadError` handler that reloads once.
- Re-entry guard in `start()`.

The meeting is never re-created, because the retry re-opens the already-created meeting ID.

## Module 6 — Unexpected logout · Root cause found

**Cause:** a 30-minute idle timeout on both sides:
- client: `SESSION_IDLE_MINUTES=30`, `config.ts:13`; `useIdleTimeout`, `AuthContext.tsx:288-335`
- server: `Security:SessionIdleMinutes=30`

Plus an 18 h absolute limit. Anyone idle for 30 min outside a meeting is signed out.

**Already exists:**
- daily forced logout at 23:30 IST with a 5-minute warning (`Security/DailyLogout.cs`), enforced server-side by revoking `auth.UserSessions`;
- a per-admin **test mode** (`POST /admin/ops/daily-logout/test`) that never changes the real schedule.

**Change:**
- Remove the client idle sign-out and raise the server idle window so it never ends a session before the next 23:30 cutoff (absolute expiry = next cutoff).
- Keep cookie, revocation and audit as they are.
- Guests are not employees and are unaffected.

## Module 7 — Thinner toolbar · **Done (not deployed)**

80 → 68 px (desktop/tablet), 64 → 56 px (short landscape), phone padding 10 → 7 px. See CHANGELOG 12 Nov "Mobile meeting toolbar…" and UAT T1–T8.

## Modules 8–12 + additional requirements — External API platform · Greenfield

**Today:**
- Only cookie-session auth.
- CSRF is required on every POST except `/api/v1/webhooks`.
- No API keys, no OpenAPI package, no outbound webhooks (`app.WebhookEvents` is inbound LiveKit only).
- Rate limiting is per-IP fixed windows only.
- Sidebar sections "Organisation" and "System" exist (`layouts/navigation.ts:41-56`); there are no integration permissions.

**Proposed design (free, built-in):**
- **Auth:** per-integration API key.
  - Format: `oic_<integrationId>_<secret>`. The secret is shown once and stored as a SHA-256 hash with a prefix for lookup.
  - Header `Authorization: Bearer …`.
  - Scopes: `meeting.create`, `meeting.read`, `meeting.schedule`, `meeting.cancel`, `recording.read`, `recording.download`, `meeting.json.read`, `webhook.manage`.
  - Rotate / revoke takes effect immediately.
  - A separate path, `/api/ext/v1`, is not subject to the CSRF check and is never served with cookies.
- **Isolation:** every meeting carries `IntegrationId`. Every external query filters `WHERE IntegrationId = @caller` (no IDOR), and cross-integration access returns 404.
- **Host mapping:** the request's host e-mail must match an active employee. An integration cannot create meetings for non-employees.
- **Idempotency:** an `Idempotency-Key` header is stored per integration.
- **Rate limit:** ASP.NET `RateLimiter`, partitioned per integration.
- **Completion JSON / download:**
  - Meeting status and recording status are reported independently, using existing data (`mtg.MeetingAttendance` join/leave, `rec.MeetingRecordings` status).
  - Download uses the existing signed-token media endpoint, bound to the integration.
- **Webhooks:**
  - New outbox table; HMAC-SHA256 signature header; event ID + timestamp; exponential retry from a background worker (same pattern as `EmailOutboxWorker`); delivery log; "send test event".
  - Payloads carry IDs and status only, no personal data.
- **Docs:**
  - `Microsoft.AspNetCore.OpenApi` (part of .NET 10, free) generates `/openapi/ext-v1.json` from the real endpoints only.
  - Swagger UI from `swagger-ui-dist` (MIT), served locally — no CDN.
  - New page under **System → API Documentation**, with Integration Management (admin only, new permission `integrations.manage`).
- **New tables** (V023+), since nothing reusable exists:
  - `app.ApiIntegrations`
  - `app.ApiKeys`
  - `app.ApiIntegrationScopes`
  - `app.ApiRequestLog`
  - `app.ApiIdempotency`
  - `app.WebhookSubscriptions`
  - `app.WebhookDeliveries`
  - plus `mtg.Meetings.IntegrationId` and `ExternalReference` (nullable FK)

**Decisions needed:**
- API key vs OAuth2 client-credentials. **Recommended: API key**, which is simpler for partner portals with the same security when hashed, scoped and rotated.
- Which portals will integrate first (names only).

## Module 13 / 14 — Database and testing

- Every schema change is a new forward-only migration with a rollback script.
- Each is applied first to LocalDB `*_Rec` and tested end to end with the real recorder.
- Production DB changes and deployment happen only with explicit approval and a `.bak` taken first.

## Status (13 Nov 2026)

Every step below is **implemented, tested and deployed** (13 Nov 2026 00:01 IST; step 1 on 12 Nov 22:59 IST). The decisions were made by the business owner on 12 Nov: Prarambh is digits only; the customer is created from the first participant; screen share is for everyone; Compliance agreed to stop automatic deletion; API keys. Results: CHANGELOG.md and UAT_TESTING_REPORT.md ("Master enhancement batch").

## Original order (each step small, tested, separately deployable)

| Step | Content | Schema? | Blocked on |
|---|---|---|---|
| 1 | Toolbar + support e-mail + recording orientation | No | Deploy approval only — **done & tested** |
| 2 | Blank-screen fix (Module 5) + idle-logout fix (Module 6) | No | Nothing |
| 3 | Prarambh ID + PLVC participants (Module 1) | V022 | Prarambh format; customer-record choice |
| 4 | Date-wise IST folders + PLVC filename (Module 3) | No (key format only) | Step 3 |
| 5 | Screen share for guests/customers (Module 2) | No | Yes/no decision |
| 6 | Retention DELETE disabled (Module 4) | No | Compliance sign-off |
| 7 | External API: integrations, keys, create/read/complete/download, webhooks, OpenAPI + docs page (Modules 8–12) | V023+ | Auth-method choice |
| 8 | Full E2E per Module 14 + docs (API guide, endpoint reference, OpenAPI file, storage, sessions) | — | — |

---

# Advanced AI & collaboration request (13 Nov 2026)

**Phase 1 inspection:** branch `feature/ai-collab-1113`, created from `feature/doc-bugs-1113` @ `cee5cdb`, with no uncommitted user changes apart from one updated test.

| Feature | Exists today? | Impact on existing modules | Decision |
|---|---|---|---|
| Raise hand | **Exists** (`useHands`, `oic.hand`) | None | Reused; gestures would trigger it later |
| Camera switching | **Exists** (Settings → Camera list) | None | Added only a one-tap "Switch camera" button (`CAMERA_FLIP`) |
| Noise suppression / echo cancellation / AGC | **Exists** (browser WebRTC, always on) | None | Added an off/on switch (`NOISE_SUPPRESSION`); RNNoise not added |
| Group chat | **Exists** (persisted) | None | Unchanged; private messages are a separate tab and table |
| Reactions, Yes/No polls | Greenfield | Room toolbar: one optional button | **Built** (V026) |
| Private 1:1 messages | Greenfield | Chat panel: one optional tab | **Built** (V026; server-enforced) |
| Whiteboard | Greenfield | Room stage shows the board instead of video while it is open | **Built** (own code; V026) |
| Background blur / images | Greenfield | Camera track gets a browser-side processor (the recording shows the same picture) | **Built** (browser-only) |
| Admin configuration + emergency switch | Greenfield | New admin page + permission | **Built** (V026) |
| Minutes of meeting written by people (no AI) — added 14 Nov 2026 | Greenfield | Meeting page: one optional card; one new route; no change to meetings, recordings or the room | **Built** (V027: 3 new tables, switch `MEETING_MINUTES`, permission `minutes.approve`) |
| AI assistant, transcription, AI-drafted summaries/minutes, live captions | Greenfield | Recording pipeline (input), new job worker, new tables | **Not built:** needs a measured server benchmark (approval) and approved notice/retention wording |
| Gesture recognition | Greenfield | Browser only | Planned after acceptance |

**Rollback:** `ROLLBACK_PLAN.md`. **Licences:** `OPEN_SOURCE_LICENCE_REVIEW.md`. **Hardware:** `RESOURCE_BENCHMARK.md`.
