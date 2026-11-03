# Project Checklist

Updated 31 Oct 2026, after the crash recovery (see documentation/DEVELOPMENT_RECOVERY_REPORT.md). Legend: ✅ done & verified · 🟡 partially done/tested · ⏳ pending · ⛔ blocked · ❌ failed / not meeting target

## Completed (implemented and verified)

| Item | Evidence |
|---|---|
| ✅ **Phase 1 — COMPLETED (accepted by user 1 Nov 2026)**: report, licences, DB design (rev 1.2), design system, logo; migrations V001–V012 documented | documentation/, database/README.md |
| Login + auth screens + dashboard prototype (demo mode, stripped from production build) | `tsc` + build pass (re-verified 31 Oct); no demo strings in `dist/` |
| .NET 10 solution: Domain library, Recorder, unit tests | `dotnet build` 0 warnings / 0 errors; 15/15 tests (re-verified 31 Oct) |
| Recording policy configuration with placeholders + enforcement gate | 15/15 unit tests, 4/4 end-to-end refusals |
| R2 recorder security checks (hidden, least privilege, no listening ports, opaque filenames) | tests/r2-poc/results/security.json |
| LiveKit 1.13.11 running natively on Windows (checksum-verified binary) | Local runs |
| Network & firewall requirements document | NETWORK_FIREWALL_REQUIREMENTS.md |
| Recording policy document, production approval checklist | documentation/ |
| Configurable public domain template | deployment/configuration/public-endpoints.template.json |
| Crash recovery: audit, recovery report, secret-free snapshot | DEVELOPMENT_RECOVERY_REPORT.md; backups/ |
| R2 on mains power (laptop): composite frame rate 24.2–25 fps | results/2026-10-31T02-00-35 |
| R2 T01 1:1, T03 screen share, T04 participant reconnect, T05 recorder reconnect, T06 SFU restart, T07 recorder crash recovery: all criteria met **on the laptop** | Same run + playback-recheck.json (7/7 Edge play/seek) |
| **Phase 2 step 1: database migrations** V001–V010 (35 tables, 2 views, 5 procs, roles, credential-free seed) + runner (transactional, idempotent, hash-checked, read-only `-Plan`) | tests/database: deploy, re-deploy no-op, tamper refusal, **37/37 assertions** on LocalDB 2019 |
| **Phase 2 step 2: ASP.NET Core 10 API**: sign-in, lockout, server-side sessions, CSRF, rate limits, forced/voluntary password change, forgot/reset, audit, real dashboard API, first-admin command | 13/13 API integration tests + 15/15 domain tests, 0 warnings; running locally against Oneinsure_v (health OK) |
| **Phase 2 step 3 API**: TOTP MFA (recovery codes, trusted device, admin reset), account sessions, org masters, employees (+ CSV import), users & roles administration with escalation guards | 25/25 API integration tests (incl. RFC 6238 vectors), 0 warnings |
| **E-mail delivery** through `[Beeinsured_v3_2].dbo.Util_SendEmail2` (EXECUTE-only grant): outbox worker with retries, e-mail OTP as second factor, dev redirect to the test inbox | Tests pass; **live test 31 Oct: handed to the procedure successfully** (password-reset mail to the test inbox) |
| **Phase 3 API**: customers, meetings (create/reschedule/cancel/RSVP/participants), double-booking prevention (serialized, concurrency-tested, audited override), calendar, availability, invitations + customer join links, reminders worker, notifications | 43/43 API tests, 37/37 DB tests, 0 warnings |
| 🟡 **Phase 4 video room**: token-based join (employees), customer/guest join with waiting room (admit/reject), pre-join device check, grid/speaker, mic/camera/screen share, chat (persisted), participants + host controls (mute/remove/end for all), auto-reconnect, adaptive stream/simulcast/audio priority, attendance via signed LiveKit webhooks, LIVE/COMPLETED status | 53/53 API + 18/18 unit tests; automated Edge test (2 employees + guest) 11/11 on localhost. **User acceptance on localhost pending.** LAN/external devices need HTTPS + network approvals (Phase 7) |
| ✅ **Click-through testing (Phase 2/3 screens, 4 roles)**: 113/113 cases pass, 9 product defects fixed (D1–D9) incl. linking a login to an employee | documentation/LOCALHOST_TEST_REPORT.md, tests/e2e/ |
| 🟡 **Recording management**: four configurable policies (Admin → Recording policies, all "Not confirmed"), consent in the room, server-side recording with the R2 recorder (PoC), verification before COMPLETED, library by employee/meeting, signed playback/download with role rules, access log, legal hold, retention (review/archive/delete with dual approval) | 64/64 API + 18/18 unit tests; real E2E 10/10 (recorded, verified, played). V012 applied to Oneinsure_v. **User acceptance pending**; policy values pending internal confirmation |
| 🟡 **Advanced features Phase A** (impact analysis) and **Phase B** (instant meeting, shareable link, guest/colleague via link → waiting room, join by code, remove + block, audio-only); V013 applied to Oneinsure_v 2 Nov | documentation/ADVANCED_FEATURES_IMPACT_ANALYSIS.md; API 72/72 + domain 18/18; browser 8/8 (tests/e2e/room/instant-link.mjs). **UAT pending** (documentation/UAT_TESTING_REPORT.md) |
| 🟡 **Mobile (Android/iOS)**: compact room toolbar + More sheet, bottom tab bar, installable web app, safe areas, iOS zoom fix | mobile audit 7/7 (emulated phones/tablet). Real-device UAT pending |
| 🟡 **Release package 0.7.0** built: `deployment/out/OneInsureConnect-0.7.0.zip` (+ .sha256); installer, IIS config, Windows services, guides | tests 18/18 + 72/72; packaged API smoke-tested in Production mode (health, secure cookies, origin check, per-client rate limit behind proxy). Installer/IIS **not yet run on a server** |

## Pending

| Item | Notes |
|---|---|
| Server 103.224.240.11,57115 | Superseded by the user: only read-only checks were made there; nothing was created |
| ✅ 31 Oct: database **`Oneinsure_v`** created on 103.224.240.90,57116 (SQL Server 2022) on the user's instruction; V001–V010 applied; verified 35 tables, 2 views, 5 procs, 10 migrations, no users, all constraints trusted, RCSI on. No other database touched | The application does not connect to it yet (API not built). SQL login `support_oneinsure` (db_owner of Oneinsure_v only, not sysadmin, no access to other DBs) created on the user's instruction |
| ✅ First SuperAdmin `santosh.yadav@oneinsure.com` created in Oneinsure_v on the user's instruction (31 Oct; one-time password, must change at first sign-in; audited) | Done |
| Enter confirmed recording policy values (name/version, wording, retention, access) | Internal team |
| R2 T02 re-run with participants on a second machine | See Failed |
| R2 T08 (30-min soak), T09 (1/3/5 concurrent rooms) | Mains power required |
| 🟡 Phase 2 step 3 **screens** built: Settings (MFA, sessions), Employees (incl. CSV import), Organisation (departments, designations, branches, teams), Users & roles + permission matrix | `tsc` + production build pass. **Not yet clicked through in a signed-in session**: user acceptance pending |
| ✅ Migration V011 applied to Oneinsure_v on the user's approval (31 Oct; verified: 11 migrations, new columns and constraint present) | Done |
| 🟡 Phase 3 **screens** built: Schedule/Edit Meeting (live availability, conflict + override), My/Internal/Customer Meetings, meeting detail (RSVP, participants, cancel), Calendar (month/week/day/agenda), Notifications (bell + page), Customers, My availability, public join page | `tsc` + production build pass; pages load. **Not yet clicked through in a signed-in session**: user acceptance pending |
| Initialise Git (local) for change history | Needs your go-ahead |
| Phases S1, 3–7 | Per roadmap |
| Advanced features Phases C–H | C private chat + host transfer → D host-only recording → E room controls → F UI/mobile → G production docs → H integration/security/performance + UAT |

## Blocked (waiting on someone else)

| Item | Waiting for |
|---|---|
| Domain `meet.oneinsure.com`, DNS, certificate | IT confirmation |
| Public IP / NAT / firewall rules | Network team approval |
| Windows Server 2019 test host for the R2 trial | IT |
| Consent wording, retention, legal hold, access/download rules (wider recording permissions left unassigned in the seed) | Legal/Compliance |
| Creating databases on local `.\SQLEXPRESS` (login has no CREATE DATABASE permission) | Local administrator. LocalDB used meanwhile |

## Failed / not meeting target

| Item | Detail |
|---|---|
| ❌ R2 T02, six participants (laptop) | A/V p95 199 ms (limit 150), continuity gaps 4–17 s and freezes 2.0–2.8 s while participants joined. Suspected CPU contention; under investigation |
| ❌ MediaRecorder H.264 path | Fails full-decode verification → rejected (VP8 + FFmpeg transcode used instead) |
| ~~❌ R2 composite frame rate 9–10 fps~~ | Superseded: battery throttling. 24.2–25 fps on mains power |
