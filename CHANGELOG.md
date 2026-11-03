# Changelog

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
