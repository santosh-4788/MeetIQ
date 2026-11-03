# Development Recovery Report: OneInsure Connect

**Date:** 31 Oct 2026
**Reason:** the developer laptop shut down unexpectedly during development, and the previous Claude Code conversation is not available.
**Method:** the project was rebuilt from its own evidence: source files, documents, file modification times, test results, the recorder spool and logs, and fresh build and test runs. **No Git repository exists** (`git status`: "not a repository"), so there is no commit history. In this report, **"verified"** means confirmed in this session by inspection or by running something. **"Assumption"** is labelled as such.

---

## 1. Project structure (actual)

```
E:\OneInsure Connect
├─ frontend/            React 19 + TS + Vite + Tailwind v4 SPA: design system, auth screens, app shell, dashboard (demo data)
├─ backend/             OneInsure.Connect.sln (.NET 10)
│  ├─ src/OneInsure.Connect.Domain     Recording policy + enforcement gate
│  ├─ src/OneInsure.Connect.Recorder   R2 recorder host (Playwright/headless Chromium + FFmpeg), PoC
│  └─ tests/OneInsure.Connect.Domain.Tests   15 xUnit tests
├─ recording/layout/    Composite layout page run inside the recorder's headless Chromium
├─ recording/spool, recording/output   PoC artefacts (git-ignored)
├─ video-server/        LiveKit 1.13.11 native Windows binary (checksum-verified), dev config, start script
├─ tests/r2-poc/        R2 test harness: synthetic participants, scenarios T01–T09, bench, security, policy e2e
├─ deployment/configuration/public-endpoints.template.json   configurable public domain (PROPOSED)
├─ documentation/       Phase 1 report, DB design, UI design system, recording policy, network/firewall, R2 PoC report, approval checklist
├─ database/            NEW (this session): migrations V001–V010, runner, README
├─ tests/database/      NEW (this session): DB test driver + assertions
├─ backups/             NEW (this session): pre-resume snapshot (git-ignored)
└─ assets/logo/         Connect mark, OneInsure corporate logo
```

## 2. Technology stack (existing; unchanged)

| Layer | Technology | Evidence |
|---|---|---|
| Frontend | React 19, TypeScript, Vite 8 (rolldown), Tailwind CSS v4, React Router, Motion, Plus Jakarta Sans (self-hosted) | `frontend/package.json`, build output |
| Backend | .NET 10 (SDK 10.0.403, user-profile install `%USERPROFILE%\.dotnet`) | `dotnet --list-sdks` |
| Media server | LiveKit Server 1.13.11, native Windows | `video-server/bin` |
| Recorder (PoC) | .NET 10 + Microsoft.Playwright (Edge/Chromium headless) + FFmpeg 7.1.1 | `backend/src/OneInsure.Connect.Recorder` |
| Database | SQL Server 2019+ design; SQL Server 2022 Express installed; LocalDB 2019 available | `sqlcmd`, `sqllocaldb` |
| Tooling | Node 22.14, sqlcmd (ODBC 17) | |

No paid or cloud services are used. No Linux, WSL or VM is used.

## 3. Implementation status per module

Legend: **CT** completed and tested · **IT** implemented, not tested · **P** partial · **UI** UI done, backend pending · **BE** backend done, UI pending · **NS** not started · **BL** blocked by a dependency.
A "planned page" is the honest placeholder `PlannedModulePage`, not an implementation.

| Module | Status | Source files | API | DB (scripted this session) | Tests |
|---|---|---|---|---|---|
| Authentication and login | **UI** | `frontend/src/pages/auth/*`, `auth/AuthContext.tsx`, `api/index.ts`, `api/types.ts` (contract) | Not implemented (`/api/v1/auth/*` contract only) | `auth.*` (9 tables) | None (manual walkthrough in demo mode in Phase 1) |
| Employee management | NS | planned page | — | `org.Employees` | — |
| Department / designation | NS | planned page | — | `org.Departments`, `org.Designations`, `org.Branches`, `org.Teams` | — |
| Roles and permissions | P | client gating `RequirePermission`/`can()`; navigation permission codes | — | `auth.Roles/Permissions/RolePermissions/UserRoles` + seed | DB assertions |
| Dashboard | **UI** | `pages/DashboardPage.tsx`, `dev/demoDashboard.ts` | `/dashboard/summary` contract only | (reads mtg/rec) | — |
| Internal meetings | NS | planned page | — | `mtg.Meetings`, `mtg.MeetingParticipants` | — |
| Customer meetings | NS | planned page | — | `crm.Customers`, `CUSTOMER_*` categories | — |
| Video conferencing | P (infra only) | LiveKit runs natively; test participant page only in `tests/r2-poc/participant` | — | — | Used by R2 harness |
| Waiting room | NS | — | — | `mtg.WaitingRoomEntries` | — |
| Screen sharing | P (recorder side only) | Recorder layout has presenter view (`recording/layout/src/main.ts`) | — | — | T03 (see §7) |
| Meeting chat | NS | — | — | `mtg.MeetingChatMessages` | — |
| Meeting calendar | NS | planned page | — | `mtg.vw_MeetingCalendar` | — |
| Employee availability | P (DB only) | — | — | `mtg.EmployeeAvailability`, `mtg.usp_CheckAvailability` | DB assertions |
| Double-booking prevention | P (DB only) | — | — | `mtg.usp_LockEmployeesForBooking` (app locks) + availability check | DB assertions |
| Meeting invitations | NS | — | — | `mtg.MeetingInvitations` (hashed tokens) | — |
| Automated reminders | P (DB only) | — | — | `mtg.MeetingReminders` (dedupe key), `mtg.usp_ClaimDueReminders` | DB assertions |
| Notification centre | UI shell (demo list) | `layouts/Header.tsx` `NotificationBell` | — | `mtg.MeetingNotifications` | — |
| Recording consent | P | Policy gate `Domain/Recording/RecordingPolicy.cs` (CT); consent capture UI NS | — | `mtg.MeetingConsent` (append-only) | 15/15 unit, 4/4 e2e refusals |
| Recording engine (R2) | P, **PoC only** | `backend/src/OneInsure.Connect.Recorder/*`, `recording/layout` | CLI `record` | `rec.RecordingJobs`, `rec.usp_ClaimRecordingJobs` | See §7. **Not production-ready** |
| Recording library | NS | planned page | — | `rec.MeetingRecordings`, `rec.RecordingAccessLog` | — |
| Recording verification | IT/P | `Recorder/Finalizer.cs` (ffprobe, full decode, faststart, SHA-256) | — | `CHECK` COMPLETED ⇒ verified | Exercised in PoC; rejected 3 bad files |
| Attendance | NS | — | — | `mtg.MeetingAttendance` | — |
| Reports | NS | planned page | — | report procedures deferred to Phase 5 | — |
| Administration | NS | planned page | — | `app.SystemSettings`, `app.AuditLog` | — |
| Security | P | Design docs, policy gate, recorder isolation checks, demo code stripped from production build, CSRF header support in client | No server-side auth exists | Least-privilege roles, append-only evidence | R2 security.json; DB permission assertions |
| SQL Server integration | P (scripts only) | `database/` | No data-access code yet | 35 tables | DB tests |
| Windows deployment | NS | dev start script only | — | — | — |
| Monitoring | NS | — | — | `app.BackgroundJobLog` | — |
| Backup and restore | NS (designed) | DATABASE_DESIGN §7 | — | — | — |
| Prarambh API integration | NS (by design, Phase 7) | — | — | `org.Employees.ExternalRef` reserved | — |

## 4. Completed functionality (verified this session)

- The frontend type-checks (`tsc --noEmit`, exit 0) and builds. The production `dist/` contains **no demo strings or demo adapters** (grep checked).
- The recorder layout page builds.
- The .NET solution builds with **0 warnings and 0 errors**. **15/15** domain unit tests pass.
- Recording policy gate: unit and end-to-end results are on file (`tests/r2-poc/results/policy-e2e.json`: 4/4 refusals; the recorder never joins).
- R2 recorder security checks are on file (`security.json`): hidden, cannot publish, no listening sockets, opaque file names.
- Phase 1 documents exist and are internally consistent with the code.

## 5. Partially implemented

- **R2 recorder (S2 spike):** the pipeline works end to end, and so do stall detection, restart and verification. The mandatory test matrix is still incomplete (§7).
- **Roles and permissions:** client-side gating plus the DB model and seed exist. There is no server enforcement yet.
- **Availability, double booking, reminders:** DB primitives exist. API and worker are pending.

## 6. Missing functionality

The whole Phase 2 API is missing: ASP.NET Core API, authentication (login, MFA, lockout, reset, sessions, first-run `/setup`), employee and org masters, and the real dashboard. Phases 3–7 are all missing: meetings, calendar, invitations, reminders worker, SMTP, notifications, video room, waiting room, chat, recording orchestration, library, attendance, reports, admin, hardening, deployment, monitoring, backup, and the Prarambh API. The S1 network spike (IIS/ARR WSS proxy, TURN/TLS, LAN + mobile + corporate firewall) has not been run.

## 7. Build and test results (this session)

| Check | Result |
|---|---|
| `dotnet build -c Release` (backend) | ✅ 0 warnings, 0 errors |
| `dotnet test` (Domain.Tests) | ✅ 15/15 |
| `tsc --noEmit` (frontend) | ✅ |
| `npm run build` (frontend, recording/layout) | ✅ (warning: frontend JS chunk 911 kB > 500 kB, needs code splitting later) |
| Demo code absent from production `dist/` | ✅ |
| R2 bench on **mains power** (2 participants, 40 s) | ✅ generator/VP8 **25 fps** COMPLETED; capture/VP8 **25 fps** COMPLETED (on battery: 9–10 fps) |
| R2 T01–T07 on mains power | 6 of 7 meet every mandatory criterion; **T02 FAIL** (see §7a) |
| Database migrations + assertions | ✅ deploy, idempotent re-deploy, tamper detection, **37/37 assertions** (see §7b) |

### 7a. R2 scenarios on mains power (run `results/2026-10-31T02-00-35`, laptop, PowerOnline=True at start and end)

| Test | fps | A/V median / p95 (ms) | Restarts | Recorder CPU (cores) | Recorder RAM peak (MB) | Verdict |
|---|---|---|---|---|---|---|
| T01 one-to-one, mute/unmute | 24.8 | −46 / 86 | 0 | 0.43 | 1872 | ✅ PASS* |
| T02 six participants, join/leave/rejoin | 24.2 | −13 / **199** | 0 | 0.84 | 2092 | ❌ **FAIL**: A/V p95 > 150; continuity gaps 4–17 s and freezes 2.0–2.8 s while participants joined (0–80 s) |
| T03 screen share on/off | 25 | −29 / 69 | 0 | 1.09 | 2006 | ✅ PASS* |
| T04 participant reconnects / hard drop | 25 | −30 / 69 | 0 | 0.82 | 2201 | ✅ PASS* |
| T05 recorder network reconnect | 25 | −74 / 120 | 0 | 0.69 | 1915 | ✅ PASS* |
| T06 SFU outage + restart | 25 | −54 / 62 | 0 | 0.43 | 1912 | ✅ PASS* |
| T07 recorder browser crash → new segment | 25 | −22 / 60 | 1 | 0.48 | 1914 | ✅ PASS* |

\* The run's own summary shows every test as FAIL. In every case the only failing check was `playbackOk`, because the **test harness** served the MP4 without HTTP range support, so Edge silently reset every seek to 0 (diagnosed with event logging). The harness now serves `206 Partial Content`, and the check now verifies where each seek lands. The same seven MP4s were then re-checked in Edge (`harness/recheck-playback.mjs`, `playback-recheck.json`): **7/7 play, seek and reach the end**. The recordings themselves were never re-encoded.

**Interpretation of T02 (hypothesis, not yet proven):** six synthetic participant browsers plus the recorder ran on one 10-core laptop. Joins ran about 10 s late (the timeline shows joins at 15–35 s against a plan of 5–25 s), which suggests CPU contention. A layout re-tile on every join is another candidate. Next steps: re-run T02 with participants on a second machine, and look at the recorder's frame push timing around joins.

**R2 status:** still a **proof-of-concept**. Not yet run: T08 (30-min soak), T09 (concurrency), Firefox/Safari/iOS playback, and everything on the Windows Server 2019 host.

### 7b. Database (LocalDB 2019, disposable `OneInsureVideoMeetingDB_Test_*`, dropped afterwards)

`tests/database/Test-Database.ps1`: deploy V001–V010 ✅ · re-deploy is a no-op ✅ · editing an applied migration is refused ✅ · `assertions.sql` **37/37** ✅. The assertions cover 35 tables, 2 views, trusted constraints, RCSI, a seed with no credentials and with wider recording access unassigned, owner immutability, customer/host/participant rules, reminder dedupe, lease-based claiming and re-claim, availability (overlap, declined, cancelled, back-to-back, leave, reschedule exclusion), booking app-locks, recording owner and verification rules, StorageKey path safety, append-only consent and audit, computed attendance, and least privilege for `oic_app_role`.

## 8. Known errors and defects

| # | Finding | Status |
|---|---|---|
| E1 | `DATABASE_DESIGN.md` placed 6 tables in schema `sys`, which is reserved by SQL Server (Msg 2760 even as sysadmin) | **Fixed**: schema `app` (design rev 1.1) |
| E2 | On `.\SQLEXPRESS` the developer login has no CREATE DATABASE permission | Open. Needs a local admin (see `database/README.md`). LocalDB used for development/tests |
| E3 | Interrupted T01 run (`results/2026-10-30T19-46-59`) was on battery and was marked `ABORTED_NOT_VALID`. Its spool directory `recording/spool/t01-0-mvvdviij-…` stayed in state `recording` (not finalised) | Left untouched as evidence of the interruption. Not a valid result |
| E4 | `recording/output/2026/10/30/*.mp4.partial` files from runs on 30 Oct that failed verification (as designed) | Expected PoC artefacts, kept |
| E5 | Frontend bundle 911 kB | Low priority. Code-split when real modules arrive |
| E6 | R2 harness playback check served MP4 without byte ranges → false `playbackOk=false` | **Fixed** (harness). Re-check 7/7 OK |
| E7 | R2 T02 (6 participants): A/V p95 199 ms, gaps and freezes during joins | **Open**. Re-run with participants on a second machine |
| E9 | `harness/run.mjs` writes its summary but does not exit (an open handle keeps the process alive) | Open, minor. The process was stopped manually after its results were written. PowerOnline=True was confirmed after the run |
| E8 | Remote SQL Server provided by the user (`103.224.240.11,57115`) is reachable from the internet and the provided SQL login is **sysadmin**. Server is SQL Server **2017** (design target 2019+) | Raised with the user. Only read-only checks have been done |

No TODO/FIXME/NotImplemented markers exist in project source. The only hits are in Playwright's vendored `protocol.d.ts` under `bin/`.

## 9. Security gaps (current state)

1. **There is no server-side authentication or authorisation yet.** The UI's permission checks are cosmetic until the API enforces them.
2. No HTTPS/reverse proxy configuration exists yet (IIS/ARR is planned in S1/Phase 6).
3. LiveKit RTC TCP binds to all interfaces. This needs host firewall rules plus IP pinning (documented in NETWORK_FIREWALL_REQUIREMENTS).
4. Dev LiveKit keys live in `video-server/config/dev.local.env`. That file is git-ignored and was excluded from the backup. **Rotate them before any shared or server use.**
5. PoC recordings in `recording/output` are not encrypted at rest. BitLocker and ACLs are a production requirement.
6. **No version control.** A further crash or bad edit cannot be rolled back except from the snapshot. Recommendation: initialise Git (local only). This needs your go-ahead.
7. No webhook signature verification, rate limiting, audit trail or session store exists at runtime yet (designed, not built).

## 10. Windows compatibility findings

- LiveKit runs natively on Windows. It logs "capacity management is unavailable", so the **application must enforce room and participant limits**.
- LiveKit Egress is Linux-only, which is why R2 (Windows-native) is being trialled. R1 (Ubuntu) needs your approval and is not used.
- .NET 10 is installed per-user. The harness sets `DOTNET_ROOT`. Servers need the runtime installed, or a self-contained publish.
- `ffmpeg` on PATH is a Chocolatey shim, so the recorder uses an explicit FFmpeg path.
- SQL Server: target is 2019+. Scripts were validated on LocalDB **2019** (15.0), which is the compatibility floor. Express 2022 is also present.
- On battery, Windows throttles the CPU enough to invalidate every recorder performance number (§7: 9–10 fps on battery vs 25 fps on mains).

## 11. Last verified development milestone

**Verified facts:**

- The last files written before the shutdown are timestamped 31 Oct 2026, 01:20: PROJECT_CHECKLIST.md, SOFTWARE_LICENSES.md, R2_RECORDER_POC_REPORT.md (interim, day 1), PRODUCTION_APPROVAL_CHECKLIST.md, public-endpoints.template.json, and `ABORTED_NOT_VALID.txt` for the T01 run.
- The T01 run started at 01:17 local time (19:47 UTC) and wrote its last spool status at 01:19. Its status stayed `recording`, and it was then marked aborted ("on battery").

**Most likely last completed task:** R2 PoC day 1 was finished and documented. That covers the smoke test, the defect fixes, the security and policy tests, the interim report and the checklist update. The first scenario run (T01) was then started and abandoned because the laptop was on battery.

**Assumption (not provable):** the laptop shut down from battery exhaustion shortly after 01:20. The R2 report records the battery at 15% → 7%.

**Next planned step, as recorded in the checklist:** re-run the R2 scenarios on mains power, then start Phase 2 (DB scripts, API, authentication, masters).

## 12. Resumed work (this session)

1. A snapshot was taken first: `backups/recovery-snapshot-2026-10-31-pre-resume.zip` (96 source and config files, **no secrets**, no binaries or recordings) with a SHA-256 manifest.
2. R2 bench and T01–T07 were re-run **on mains power**. This was the interrupted task (§7a).
3. **Phase 2, step 1: database migrations** for `OneInsureVideoMeetingDB` (`database/`), with an automated test suite (§7b).

## 12a. Continued (same day, after the recovery)

- `Oneinsure_v` was created on 103.224.240.90,57116 on the user's instruction, with migrations applied and verified. SQL login `support_oneinsure` has db_owner on that database only.
- **Phase 2 step 2 done:** the ASP.NET Core 10 API (auth + dashboard) passes 13/13 integration tests and runs locally against `Oneinsure_v`. Creating the first SuperAdmin there needs the user's approval.

## 13. Recommended next development task

~~Phase 2 step 2 (API + authentication)~~ done. **Next: Phase 2 step 3, MFA plus employee and organisation masters.** Original note on step 2: It covers login by email or employee code, lockout, server-side sessions (hashed tokens, HttpOnly cookie), antiforgery, first-run `/setup` with a one-time key, `/auth/me`, logout, and change, forgot and reset password. It implements the contract the frontend already uses (`frontend/src/api/types.ts`), so the existing screens work unchanged once demo mode is off. MFA (TOTP, e-mail OTP) follows, then the employee and org master APIs and screens.

## 14. Remaining roadmap

| Phase | Scope | Status |
|---|---|---|
| S2 | R2 recorder trial: T01–T09, 30-min soak, concurrency, Windows Server 2019 host | In progress (needs IT host) |
| 2 | DB ✅ scripted · API + auth + MFA · masters · roles admin · real dashboard | In progress |
| S1 | Network spike (IIS/ARR, TURN/TLS, external paths) | Not started; needs IT/network |
| 3 | Meetings, calendar, availability, invitations, consent capture, reminders worker, SMTP outbox, notifications | Not started |
| 4 | Video room, waiting room, host controls, screen share, chat, recording orchestration | Not started |
| 5 | Recording library and playback, attendance, reports, admin, health, audit viewer | Not started |
| 6 | Hardening (ASVS L2), load and chaos tests, Windows deployment scripts | Not started |
| 7 | Docs, backup/restore drill, Prarambh API + optional SSO | Not started |

Approvals still pending from others (unchanged): domain/DNS/certificate (IT), public IP/NAT/firewall (network team), Windows Server 2019 test host (IT), consent wording, retention, legal hold and access matrix (Legal/Compliance).
