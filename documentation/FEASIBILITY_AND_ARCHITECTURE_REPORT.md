# OneInsure Connect — Feasibility, Architecture & Phase 1 Report

**Product:** OneInsure Connect — *Connect. Collaborate. Grow.*
**Document status:** Phase 1 deliverable, for review. **No production claims are made here.**
**Date:** 30 Oct 2026
**Source specification:** `OneInsure_Video_Meeting_System_Implementation_Plan_Preview.pdf` (33 pages, read in full; the file is not modified) plus the OneInsure Connect requirements prompt.

Related deliverables:

| Item | File |
|---|---|
| B. Licence list | [`../SOFTWARE_LICENSES.md`](../SOFTWARE_LICENSES.md) |
| E. Database design (full) | [`DATABASE_DESIGN.md`](DATABASE_DESIGN.md) |
| G. Design system | [`UI_DESIGN_SYSTEM.md`](UI_DESIGN_SYSTEM.md) |
| H/I. Login + dashboard prototype | [`../frontend/`](../frontend/) (`npm run dev`) |
| Progress checklist | [`../PROJECT_CHECKLIST.md`](../PROJECT_CHECKLIST.md) |

---

## Decisions needed from you (summary)

The architecture below is buildable **except recording**, which has a real Windows limitation. Before Phase 4 I need your approval on the items marked ⛔. The others have a default I will use unless you say otherwise.

| # | Decision | Default I will use | Blocking? |
|---|---|---|---|
| D1 | **Recording engine**: official LiveKit Egress needs Linux. Choose: (R1) one Ubuntu server/VM for Egress, as in the BRD, **or** (R2) a Windows-native recorder that I build and prove in Spike S2 | R2 with a time-boxed spike. R1 is the fallback if S2 fails | ⛔ Phase 4 |
| D2 | Public hostname for customers: BRD uses `*.oneinsure.in`, you referenced `oneinsure.com` | `connect.oneinsure.in` / `livekit-connect.oneinsure.in`, **please confirm** | ⛔ Deployment |
| D3 | Public IP, NAT and firewall approval for the media ports (BRD risk, still open) | UDP 7882 (mux) + TCP 7881 + TURN/TLS 5349 + 443 | ⛔ Customer access |
| D4 | Backend runtime: **.NET 10 LTS** (support until Nov 2028). .NET 8 and 9 on this PC both reach end of support on **10 Nov 2026** | Install .NET 10 SDK | No |
| D5 | Recording encryption at rest: BitLocker volume + NTFS ACLs, optionally plus app-level AES-256-GCM per file | BitLocker + ACL. App-level encryption is optional | No |
| D6 | Web Push for browser reminders while the browser is closed sends encrypted payloads through Google/Mozilla/Microsoft push servers (free, but external) | **Off**. SMTP covers the browser-closed case | No |
| D7 | Recording consent wording, retention period, legal hold, withdrawal (BRD p.25) | Placeholders, pending Legal/Compliance | ⛔ Pilot |
| D8 | Meeting chat persistence (store chat in SQL for audit, or ephemeral) | Persist to SQL, with retention | No |

---

## A. BRD analysis and requirement gap report

### A.1 What the BRD specifies (retained)

| Area | BRD requirement | Status in new architecture |
|---|---|---|
| PLVC lifecycle | Schedule → Invite → Join → Consent → Admit → Record → Complete → Verify (p.7) | **Kept as-is**. It is the core customer-meeting state machine |
| Roles | Employee/creator, Customer, Team leader, Admin, Compliance/Audit, Super admin (p.5) | **Kept**, extended with Department Head and HR/Master-data roles |
| Access rule | "Never rely on frontend visibility alone" (p.5) | **Kept**. Every permission is checked in the API; recording access uses short-lived signed URLs |
| Ownership | Recording owner copied from the immutable meeting creator (p.11) | **Kept**: `Meetings.CreatedByEmployeeId` is immutable |
| Invitations | Random high-entropy token, hashed at rest, expiry, revoke, rate-limit (p.6, 25) | **Kept** |
| Recording | Consent gate, auto start, stop on end, MP4, verify (size, duration, SHA-256) before "Completed" (p.20, 22) | **Kept**. The engine changes (see C, D1) |
| Reliability | Durable job table, idempotency key, webhook signature check, retry, reconciliation (p.20, 22) | **Kept**, implemented on SQL Server tables (no Redis) |
| Email | Outbox pattern so SMTP outages do not roll back meetings; invite / 24h / 1h / 10min / change / recording-ready (p.23) | **Kept**, merged with the configurable reminders (see A.3 #6) |
| API | `/api/v1/meetings`, join-token, consent, admit, end, recordings, playback, webhooks (p.14) | **Kept** as the core of a larger API |
| Security | HTTPS/WSS, DTLS-SRTP, MFA for privileged roles, audit (p.25) | **Kept**, raised to MFA for all staff + OWASP ASVS L2 |
| Capacity | 10–25 concurrent meetings, proven by load test (p.3, 26) | **Kept**. No capacity claim until load tests pass |
| Storage estimate | ≈281 GB/month at 1,000 × 25 min × 1.5 Mbps (p.27) | **Kept** for sizing; alerts at 70/80/90 % |
| Monitoring | Media, Egress, storage, backend, DB, security metrics (p.28) | **Kept**, using Prometheus + Grafana OSS on Windows |
| Tests | Functional, consent, recording, authz, network, load, recovery, browser matrix (p.29) | **Kept** |
| Exclusions | No AI transcription/summaries, facial recognition, native mobile apps, paid SaaS (p.4) | **Kept** |

### A.2 Conflicts between the BRD and the new requirements

| # | BRD says | New requirement says | Resolution |
|---|---|---|---|
| C1 | Integrate into Prarambh; reuse Prarambh login, sessions, employee/customer/policy masters (p.2, 3, 16, 21, 24) | Fully independent application with its own auth, masters and database. Prarambh only as an optional future integration | **New requirement wins.** OneInsure Connect has its own Users, Employees, Customers (with policy/reference fields) in `OneInsureVideoMeetingDB`. Prarambh integration becomes documented REST APIs + optional SSO (Phase 7). The Prarambh DB is never queried. |
| C2 | Media, Egress and MinIO on **dedicated Ubuntu servers**; Docker Compose layout (p.2, 18) | No Linux/WSL/VM/Docker Desktop without approval; Windows Server 2019 is the target | LiveKit server runs **natively on Windows** (verified: official `windows_amd64` build). **Egress cannot** (see C.2). → Decision **D1** |
| C3 | MinIO S3 object storage for recordings (p.3, 19) | Windows NTFS storage | **NTFS.** Also, the MinIO GitHub repository is now **archived** (verified 30 Oct 2026), so it should not be adopted anyway. |
| C4 | Redis for the Egress queue (p.8, 10) | Redis "or a suitable open-source alternative" | **No Redis in phase 1.** A single LiveKit node does not need Redis, and our job queues live in SQL Server. If multi-node LiveKit is needed later, Microsoft Garnet (MIT, native Windows) is the candidate, subject to a compatibility test. |
| C5 | Fixed reminders: 24 h, 1 h, 10 min (p.23) | Default 10 min; options 5/10/15/30/custom | Multiple reminders per meeting. Default **10 min**. Admin setting "customer meeting reminder set" pre-fills 24 h + 1 h + 10 min for PLVC. |
| C6 | Table names prefixed `VM_` (p.11–13) | Suggested names (`Meetings`, `MeetingRecordings`, …) | Use the new names. BRD columns are mapped in [DATABASE_DESIGN.md](DATABASE_DESIGN.md) §3. |
| C7 | Domains `*.oneinsure.in` (p.9) | User referenced oneinsure.com | → Decision **D2** |
| C8 | Portal on ASP.NET MVC + separate Node/TS API (p.10, 15) | ASP.NET Core **or** Node.js | **One ASP.NET Core API** (fits IIS and Windows Services natively, and the team's existing .NET skills). LiveKit has no official .NET server SDK. Its server API is Twirp (HTTP+JSON) and tokens are standard JWTs, so a thin typed client (~300 lines) is enough. |

### A.3 Gaps: missing in the BRD, added now

1. **Own identity**: login, MFA (TOTP + email OTP fallback), lockout, password reset, sessions, first-run admin setup.
2. **Masters**: Employees, Departments, Designations, Branches, Teams, reporting manager.
3. **Internal meetings**: 1:1, group, team, department, management, training, review, with accept/decline.
4. **Calendar**: day/week/month/agenda views, availability, double-booking prevention, audited override.
5. **Notification centre**: in-app (real-time via SignalR), read/unread, preferences.
6. **Reports**: daily/monthly/employee/department/category/attendance/recording/failed-recording/reminder-delivery, CSV/XLSX export.
7. **Administration**: users, roles, permissions matrix, SMTP, meeting/recording/security/retention settings, health, job status, audit log viewer.
8. **Attendance**: join/leave intervals per participant from LiveKit webhooks.
9. **Not covered in the BRD; resolved here:**
   - *Consent withdrawn mid-meeting*: stop recording, flag the meeting, audit, and require host acknowledgement.
   - *Optional customer OTP check* on the join link (email OTP; SMS is excluded because paid gateways are not allowed).
   - *Remote unmute*: LiveKit allows remote **mute**, but remote **unmute** is off by default for privacy. Hosts can mute; unmute sends a "request to unmute" prompt.
   - *E2EE vs recording*: see C.4.
   - *Accessibility*: WCAG 2.1 AA target, keyboard navigation, reduced-motion support.
   - *Time zones*: store UTC, display Asia/Kolkata by default, user-level override.
   - *DR*: SQL backups + recording volume backup + config backup; restore drill in Phase 7.
10. **Browser support** stays as in the BRD: Chrome, Edge, Firefox, Safari, Android Chrome, iOS Safari. Clients publish VP8/Opus where possible so the recorder handles one codec.

---

## B. Free/open-source technology list

See **[SOFTWARE_LICENSES.md](../SOFTWARE_LICENSES.md)**. Each licence was checked against the project's source repository on 30 Oct 2026. Summary:

- **All selected components are free to use** for internal enterprise production.
- **Copyleft items to note** (no cost, no action needed for internal, unmodified use): Grafana OSS (AGPL-3.0), FFmpeg GPL build (GPL because of x264; obligations apply only if we *distribute* it).
- **Rejected:** MinIO (archived, AGPL), Redis ≥7.4 (RSAL/SSPL/AGPL tri-licence, no official Windows build), Coturn (no native Windows build; LiveKit's embedded TURN covers it), Hangfire (Pro features paid), QuestPDF (revenue-capped community licence), FullCalendar **premium** plugins (commercial; only MIT plugins will be used), Docker Desktop (licensing + not supported on Windows Server).
- **Infrastructure costs remain** (as the BRD noted): server hardware/VM capacity, bandwidth, storage, backup media and a public TLS certificate. A free Let's Encrypt certificate via win-acme (Apache-2.0) is possible if your policy allows ACME.

---

## C. Windows Server 2019 compatibility report

### C.1 Component matrix

| Component | Native Windows Server 2019? | Evidence / notes | Verdict |
|---|---|---|---|
| IIS 10 + URL Rewrite + ARR 3 (WebSockets) | Yes | Built-in role + free Microsoft extensions | ✅ |
| ASP.NET Core (.NET 10 LTS) API on IIS (ASP.NET Core Module v2) | Yes | Windows Server 2019 is a supported OS for .NET 10 | ✅ (D4) |
| .NET Worker Services as Windows Services | Yes | `Microsoft.Extensions.Hosting.WindowsServices` | ✅ |
| SignalR (real-time notifications, waiting room) | Yes | Needs the IIS WebSocket Protocol feature | ✅ |
| SQL Server (existing) | Yes | TDE available in Standard edition from SQL Server 2019 | ✅ |
| **LiveKit Server v1.13.11** (SFU + signalling + embedded TURN) | **Yes, binary exists** | GitHub release ships `livekit_1.13.11_windows_amd64.zip`. LiveKit documents Linux as the primary production platform, so Windows production behaviour must be **proven in Spike S1** | ⚠️ Feasible, must be proven |
| Running LiveKit as a service | Yes | WinSW (MIT) service wrapper | ✅ |
| TURN | Yes | LiveKit embedded TURN (TURN/UDP 3478, TURN/TLS 5349). Coturn not needed | ✅ |
| **LiveKit Egress** (recording) | **No** | No binary releases. Docker image only. Depends on Linux-only pieces (PulseAudio, X virtual framebuffer, GStreamer Linux plugins). Docker Desktop is not supported on Windows Server, and Windows containers cannot run Linux images | ❌ → D1 |
| Redis | No official build | Not needed for a single node (see C4) | n/a |
| MinIO | Binary exists, but repo archived | Replaced by NTFS | ❌ rejected |
| FFmpeg 7.x | Yes | Already installed on this PC (gyan.dev build) | ✅ |
| Chromium via Playwright (for recorder R2) | Yes | Headless Chromium runs on Windows Server 2019 with Desktop Experience. Running as a Windows Service (session 0) must be proven in S2 | ⚠️ Must be proven |
| Prometheus, Alertmanager, windows_exporter, Grafana OSS | Yes | Official Windows binaries/installer | ✅ |
| BitLocker (encryption at rest) | Yes | Built-in Windows Server feature | ✅ |

### C.2 Why Egress cannot run on Windows

LiveKit Egress composites a room by launching headless Chrome into a **virtual X display (Xvfb)** and capturing system audio through **PulseAudio**, then encoding with **GStreamer** plugins built for Linux. None of these exist on Windows. The only distribution is a Linux Docker image. Running it would need a Linux host (VM, WSL or physical), and you have not approved any of those.

### C.3 Recording options

| | R1: Ubuntu Egress (BRD baseline) | R2: Windows-native composite recorder **(recommended, needs a spike)** | R3: Windows-native track recorder |
|---|---|---|---|
| How it works | Official Egress room-composite → MP4 | A .NET Windows Service starts headless Chromium (Playwright). Chromium opens an internal *recorder layout* page that joins the room as a **hidden, subscribe-only participant**, draws the grid on a canvas, mixes audio with WebAudio, and records with `MediaRecorder` into WebM chunks on a local spool. On stop, FFmpeg produces MP4 (H.264/AAC). The file is then verified with ffprobe + SHA-256 | A Go service (LiveKit Go SDK + Pion) subscribes to each track and writes per-track IVF/OGG files. After the meeting, FFmpeg builds the composite MP4 |
| Linux needed | **Yes** | No | No |
| Maturity | Production-proven upstream | Same approach as Egress (Chrome composite), but our own code. Needs testing | Lower real-time CPU, but complex timing alignment and gap handling |
| CPU estimate | ~4 vCPU per worker (LiveKit guidance) | Est. 1.5–2.5 vCPU per 720p recording (**to be benchmarked**) | Est. low during the call, heavy afterwards |
| Risk | Needs Linux approval | Session-0 GPU-less rendering, audio autoplay, long-run memory | Lip-sync / alignment bugs |

**Recommendation:** approve **R2 with Spike S2** (max 2 weeks). Pass criteria: 30-minute 1:1 and 4-party recordings, A/V drift < 100 ms, recovery from recorder crash (chunks already on disk are preserved), 5 concurrent recordings on the reference server, MP4 passes ffprobe on Chrome/Edge/Safari playback. **If S2 fails, I will stop and ask you about R1.** I will not introduce Linux myself.

**Capacity note:** with R2, 25 simultaneous *recorded* meetings ≈ 40–60 vCPU for recording alone, so recording needs its own Windows server(s). The BRD sizing on p.26 still applies, but on Windows hosts.

### C.4 WebRTC transport encryption vs E2EE

- **Transport encryption (used):** every media stream is encrypted with **DTLS-SRTP** between browser and LiveKit, and signalling uses **WSS/TLS 1.2+**. The SFU (our own server, on our premises) decrypts and re-encrypts packets to route them. Nobody on the network path can read media, but the server can.
- **E2EE (not used for recorded meetings):** LiveKit supports insertable-streams E2EE where only participants hold the key. The SFU and **any server-side recorder then see only ciphertext**, so server-side recording becomes impossible.
- **Decision:** recorded meetings (all PLVC) use transport encryption. E2EE may be offered later as an option for **non-recorded** internal meetings. Recordings are protected at rest (BitLocker + ACL, optional AES-GCM) and in access (RBAC, signed short-lived URLs, audit). Details go in `ENCRYPTION_AND_KEY_MANAGEMENT.md` (Phase 6).

---

## D. Final technical architecture

### D.1 Logical view

```
                         Internet (customers)                  Corporate LAN / VPN (employees)
                                   │                                         │
                        ┌──────────▼─────────────────────────────────────────▼───────────┐
                        │  WINDOWS SERVER A — Application (IIS 10, TLS 1.2+)              │
                        │  ├─ connect.<domain>       React SPA (static, IIS)              │
                        │  ├─ connect.<domain>/api   ASP.NET Core 10 API (ANCM in-proc)   │
                        │  │     • Auth/MFA/sessions   • Meetings/Calendar/Availability   │
                        │  │     • Invitations/Consent • Recording library + signed URLs  │
                        │  │     • Reports/Export      • Admin/Audit                      │
                        │  │     • LiveKit token issue + Twirp client + webhook receiver  │
                        │  ├─ connect.<domain>/hubs  SignalR (notifications, waiting room)│
                        │  └─ Windows Service: OneInsure.Connect.Worker                   │
                        │        reminders • email outbox (SMTP) • recording reconcile    │
                        │        retention/purge • attendance rollup • health probes      │
                        └───────────┬───────────────────────────────┬────────────────────┘
                                    │ TDS/TLS                        │ HTTPS (Twirp), webhooks
                        ┌───────────▼──────────┐       ┌────────────▼───────────────────────┐
                        │ SQL Server (existing)│       │ WINDOWS SERVER B — Media            │
                        │ OneInsureVideoMeeting│       │  LiveKit Server (WinSW service)     │
                        │ DB (dedicated login) │       │  • WSS 7880 behind IIS/ARR :443     │
                        └──────────────────────┘       │  • RTC TCP 7881, UDP 7882 (mux)     │
                                                       │  • Embedded TURN 3478/UDP, 5349/TLS │
                                                       └────────────┬───────────────────────┘
                                                                    │ WebRTC (hidden participant)
                                                       ┌────────────▼───────────────────────┐
                                                       │ WINDOWS SERVER C — Recording (R2)   │
                                                       │  OneInsure.Connect.Recorder service │
                                                       │  Playwright Chromium ×N → WebM spool│
                                                       │  FFmpeg → MP4 → verify → NTFS store │
                                                       │  R:\Recordings (BitLocker, ACL)     │
                                                       └────────────────────────────────────┘
        Monitoring: Prometheus + Alertmanager + windows_exporter + Grafana OSS (Server A or a separate host)
```

For the pilot, A+B can share one host; C should be separate because of CPU load.

### D.2 Key flows

- **Login:** SPA → `POST /api/v1/auth/login` → PBKDF2 (ASP.NET Core Identity hasher, 600k iterations, HMAC-SHA512) → optional MFA step → **HttpOnly, Secure, SameSite=Strict** session cookie + antiforgery token. Server-side session table allows "active sessions" view and revoke.
- **Join (employee):** `POST /meetings/{id}/join-token` → authz + state checks → LiveKit JWT (TTL 5 min, room-scoped, least-privilege grants). The **host** grant is `roomAdmin` only for the organiser/host.
- **Join (customer):** `/join/{token}` → token hash lookup → (optional email OTP) → consent screen → waiting room (SignalR) → host admits → backend issues the customer's LiveKit JWT. **Customers never receive `roomAdmin`.**
- **Recording (R2):** consent satisfied + host admitted → API writes a `RecordingJobs` row (idempotency key) → the recorder service claims it (`UPDLOCK, READPAST`) → hidden participant joins → chunks spool → on room end or stop: FFmpeg → ffprobe → SHA-256 → move to the private store → **Completed only after verification**. A reconciler finds stale `Starting/Recording/Processing` jobs.
- **Reminders:** rows in `MeetingReminders` (per recipient × offset). The Worker polls every 30 s with a lease claim. The unique key (MeetingId, RecipientId, OffsetMinutes, Channel, ScheduleVersion) prevents duplicates. A reschedule bumps `ScheduleVersion` and cancels old rows. Retries back off exponentially (max 5), and every attempt goes to `EmailDeliveryLog`.
- **Webhooks:** LiveKit `/api/v1/webhooks/livekit` → verify the JWT signature + body SHA-256 → insert `WebhookEvents` (unique event id) → processed idempotently (attendance, room finished → stop recording).

### D.3 Technology stack (final, pending D1/D4)

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript + Vite, Tailwind CSS v4, React Router, TanStack Query/Table, React Hook Form + Zod, Recharts, FullCalendar (MIT plugins only), Motion, Lucide, `livekit-client` + `@livekit/components-react`, Plus Jakarta Sans (self-hosted) |
| API | ASP.NET Core 10, EF Core 10 (SQL Server provider) + Dapper for reports, SignalR, MailKit, Otp.NET, QRCoder, ClosedXML, CsvHelper, Serilog, OpenTelemetry → Prometheus |
| Background | .NET Worker Service (Windows Service), SQL-backed job tables with lease/claim |
| Media | LiveKit Server (native Windows), embedded TURN |
| Recording | R2 recorder (.NET + Microsoft.Playwright + FFmpeg), or R1 if approved |
| Storage | NTFS on a BitLocker volume, folder ACL limited to the recorder and API service accounts |
| Monitoring | Prometheus, Alertmanager, windows_exporter, Grafana OSS |

### D.4 Repository layout

```
OneInsure Connect/
  frontend/                 React SPA (design system, pages)
  backend/                  OneInsure.Connect.sln
    src/Api  src/Domain  src/Infrastructure  src/Worker  src/Recorder  src/LiveKit
    tests/
  database/                 migrations, seed (reference data only), stored procs
  video-server/             livekit.yaml template, WinSW config
  recording/                recorder layout page, ffmpeg profiles
  deployment/windows/{scripts,configuration}
  documentation/            all *.md deliverables
  tests/                    e2e (Playwright), load (k6 + LiveKit CLI load-tester)
  assets/logo/{connect,oneinsure}
  logs/ backups/            (git-ignored)
```

---

## E. Database design

Full table/column design: **[DATABASE_DESIGN.md](DATABASE_DESIGN.md)**. DDL scripts follow in Phase 2 after you approve the design. Summary: 35 tables + 2 views in 6 schemas (`auth`, `org`, `crm`, `mtg`, `rec`, `app`; `sys` in v1 was reserved, see DATABASE_DESIGN.md), all timestamps UTC `DATETIME2(3)`, `BIGINT` identity keys plus `UNIQUEIDENTIFIER` public ids (internal ids are never exposed in URLs), soft-delete for masters, and append-only audit/consent tables protected by `DENY UPDATE, DELETE` to the application login.

---

## F. Complete UI sitemap

**Public / unauthenticated**

| Route | Page |
|---|---|
| `/login` | Sign in (two-panel) |
| `/forgot-password` | Forgot password |
| `/reset-password?token=` | Reset password |
| `/mfa` | MFA verification (TOTP / email OTP) |
| `/account-locked` | Account locked |
| `/session-expired` | Session expired |
| `/access-denied` | Access denied (403) |
| `/setup` | First-run administrator setup (works only while no admin exists; one-time setup key from the server console) |
| `/join/:token` | Customer join: device check → consent → waiting room → meeting |
| `/join/:token/ended` | Customer exit / thank-you |

**Authenticated app** (sidebar order; visibility follows permissions)

| Route | Page | Permission |
|---|---|---|
| `/dashboard` | Dashboard | `dashboard.view` |
| `/meetings` | My Meetings (Today, Upcoming, Organised, Participant, Invitations, Completed tabs) | `meetings.view.own` |
| `/meetings/:id` | Meeting details (participants, invites, attendance, consent, recording, audit) | scoped |
| `/meetings/:id/edit` | Edit / reschedule | owner or `meetings.manage.any` |
| `/calendar` | Meeting Calendar (day/week/month/agenda) | `calendar.view` |
| `/schedule` | Schedule Meeting | `meetings.create` |
| `/internal` | Internal Meetings | `meetings.view.own` |
| `/customers-meetings` | Customer Meetings (PLVC) | `customer.meetings.view` |
| `/customers` · `/customers/:id` | Customer participants | `customers.manage` |
| `/room/:id` | Video Meeting Room (+ pre-join device check) | participant |
| `/room/:id/waiting` | Host waiting-room panel (inside the room) | host |
| `/recordings` · `/recordings/:id` | Recording Library + details/playback/access history | `recordings.view.*` |
| `/notifications` | Notification centre | all |
| `/reports` · `/reports/:type` | Reports hub + 9 reports | `reports.view` |
| `/employees` · `/new` · `/:id` · `/:id/edit` · `/import` | Employee management | `employees.manage` |
| `/organisation/{departments,designations,branches,teams}` | Masters + reporting manager mapping | `org.manage` |
| `/admin/users` · `/roles` · `/permissions` | User / role / permission management | `admin.security` |
| `/admin/settings/{smtp,meetings,recording,security,retention}` | Configuration | `admin.settings` |
| `/admin/health` · `/admin/jobs` · `/admin/audit` | System health, background services, audit logs | `admin.ops` / `audit.view` |
| `/profile` (tabs: info, password, MFA, notifications, meeting prefs, time zone, sessions) | User profile | all |

---

## G. UI colour palette and design system

See **[UI_DESIGN_SYSTEM.md](UI_DESIGN_SYSTEM.md)**. The tokens are implemented in [`frontend/src/styles/theme.css`](../frontend/src/styles/theme.css) and [`frontend/src/design/tokens.ts`](../frontend/src/design/tokens.ts).

## H. Login page — design and functional prototype

Implemented in `frontend/` (see README). The prototype runs in **Demo mode** (`VITE_DEMO_MODE=true`, shown by a "DEMO" badge) against a local, clearly separated mock adapter in `src/dev/`. A production build with demo mode off calls the real `/api/v1` endpoints, which arrive in Phase 2. **No authentication backend exists yet**, so login security is not yet implemented or tested.

## I. Dashboard design

Implemented in the same prototype (`/dashboard`). It shows demo data only, labelled as such. Real data arrives with the Phase 2/3 APIs.

---

## J. Development roadmap

| Phase | Scope | Exit gate (must pass before the next phase) | Est. |
|---|---|---|---|
| **1** (this) | BRD analysis, feasibility, licences, architecture, DB design, design system, login + dashboard prototype | **Your review/approval of this report + UI** | done → review |
| **S1 spike** | LiveKit native on Windows Server 2019: IIS/ARR WSS proxy, UDP mux, embedded TURN/TLS, 2-party call from LAN + mobile data + corporate firewall | Call works through all 3 network paths; service restarts cleanly | 3–4 days |
| **2** | .NET 10 solution, DB migrations, auth (login, MFA, lockout, reset, sessions, first-run setup), employees/org masters, roles/permissions, real dashboard API | Unit + integration tests green; authz tests per role | 2.5–3 wks |
| **3** | Internal + customer meetings, calendar, availability, invitations, consent capture, reminders worker, SMTP outbox, notification centre (SignalR) | Reminder dedupe/reschedule tests; SMTP outage test | 3 wks |
| **S2 spike** | Windows recorder R2 (**needs D1**) | Criteria in C.3 | ≤2 wks |
| **4** | Video room (LiveKit components), waiting room, host controls, screen share, chat, recording orchestration + verification | E2E: schedule → join → consent → admit → record → verify | 3–4 wks |
| **5** | Recording library + signed playback, attendance, reports + export, admin settings, health, audit viewer | Authz: employee cannot see others' recordings | 2–3 wks |
| **6** | Security hardening (ASVS L2), threat model, load tests 5/10/25 rooms, chaos (SQL outage, network loss, recorder crash), Windows deployment scripts | Test reports with real results | 2–3 wks |
| **7** | Documentation set, backup/restore drill, handover, Prarambh integration API + optional SSO (OIDC) docs | Restore drill passes | 1–2 wks |

Indicative total ≈ 16–20 weeks with one full-time developer plus me. This is longer than the BRD's 11–13 weeks because the scope grew: own identity, masters, calendar, internal meetings, reports and admin.
