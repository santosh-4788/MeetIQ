# Software Licences — OneInsure Connect

Licences were verified against each project's source repository (GitHub licence metadata and licence files) on **30 Oct 2026**. Re-verify when pinning versions. **Status:** ✅ selected · 🧪 selected pending a spike · ❌ rejected.

Intended use: internal enterprise production, self-hosted, **not redistributed** to third parties.

## Runtime / server

| Component | Version (target) | Licence | Use restrictions for our case | Extra cost | Status |
|---|---|---|---|---|---|
| LiveKit Server | 1.13.x (Windows amd64 build) | Apache-2.0 | None. Keep the NOTICE file | None | 🧪 S1 |
| LiveKit Egress | 1.15.x | Apache-2.0 | Licence OK, but **Linux/Docker only** | Linux host (needs approval) | ❌ unless D1 = R1 |
| .NET 10 / ASP.NET Core / EF Core | 10.0 LTS | MIT | None | None | ✅ |
| SignalR | (in ASP.NET Core) | MIT | None | None | ✅ |
| Microsoft.Playwright (.NET) 1.64.1 + Chromium/Edge | 1.64.1 | **MIT** (corrected; Chromium: BSD-3 + others) | None | None | 🧪 R2 PoC |
| FFmpeg (gyan.dev "essentials"/full build) | 7.1 | GPL-3.0 build (includes libx264) | GPL obligations apply **only on distribution**. Internal use is fine. An LGPL build + OpenH264 (BSD-2) is the alternative if the software is ever distributed | None | ✅ |
| Microsoft SQL Server | existing | Commercial (already licensed) | Express (dev only) is limited to 10 GB/DB | Existing licence | ✅ |
| IIS 10, URL Rewrite 2.1, ARR 3.0 | — | Microsoft free components of Windows Server | None | None | ✅ |
| WinSW (service wrapper for LiveKit) | 2.12 | MIT | None | None | ✅ |
| win-acme (optional, Let's Encrypt) | 2.2 | Apache-2.0 | Needs public ACME validation; policy decision | None | optional |
| Prometheus, Alertmanager | 3.x | Apache-2.0 | None | None | ✅ |
| windows_exporter | 0.3x | MIT | None | None | ✅ |
| Grafana OSS | 12.x | AGPL-3.0 | Unmodified internal use: no obligations. Modifying and serving it to others would require sharing source | None | ✅ |
| Microsoft Garnet (only if multi-node LiveKit) | 1.x | MIT | LiveKit compatibility not yet tested | None | deferred |
| Redis | 7.4+/8.x | RSALv2 / SSPLv1 / AGPLv3 tri-licence | No official Windows build. Not needed | — | ❌ |
| Valkey | 8.x | BSD-3-Clause | No native Windows build | — | ❌ |
| MinIO | — | AGPL-3.0, **repository archived** | Not maintained | — | ❌ |
| Coturn | — | BSD-3-Clause | No native Windows build. LiveKit embedded TURN used instead | — | ❌ |
| Docker Desktop | — | Commercial for large orgs | Not supported on Windows Server | Paid | ❌ |

## Backend libraries (NuGet)

| Package | Licence | Notes | Status |
|---|---|---|---|
| Microsoft.EntityFrameworkCore.SqlServer | MIT | | ✅ |
| Dapper 2.1.66 | Apache-2.0 | API data access (in use since Phase 2) | ✅ |
| Microsoft.Data.SqlClient 7.1.1 | MIT | in use since Phase 2 | ✅ |
| System.Security.Cryptography.Pkcs 10.0.14 | MIT | pinned: SqlClient pulls a vulnerable 9.0.x (CVE-2026-84008) | ✅ |
| Microsoft.AspNetCore.Mvc.Testing 10.0.14 | MIT | API integration tests only | ✅ |
| MailKit / MimeKit | MIT | SMTP | ✅ |
| Otp.NET | MIT | TOTP MFA | ✅ |
| QRCoder 1.6.0 | MIT | MFA enrolment QR (SVG), in use since Phase 2 | ✅ |
| ClosedXML | MIT | XLSX export | ✅ |
| CsvHelper | MS-PL / Apache-2.0 (dual) | CSV export/import | ✅ |
| Serilog (+ Sinks.File, Sinks.MSSqlServer) | Apache-2.0 | logging | ✅ |
| OpenTelemetry .NET + Prometheus exporter | Apache-2.0 | metrics | ✅ |
| System.IdentityModel.Tokens.Jwt | MIT | Approved for LiveKit token signing / webhook verification; **not needed so far**: Phase 4 signs and verifies the HS256 tokens with .NET's built-in `HMACSHA256` (`Meetings/LiveKit.cs`) | ✅ |
| Microsoft.Extensions.Hosting.WindowsServices | MIT | Worker/Recorder as services | ✅ |
| Hangfire | LGPL-3.0 (Pro paid) | Not needed; SQL job tables | ❌ |
| Quartz.NET | Apache-2.0 | Only if cron complexity grows | deferred |
| QuestPDF | Community licence with revenue cap | Avoided; no PDF export needed | ❌ |

## Frontend (npm)

| Package | Licence | Notes | Status |
|---|---|---|---|
| react, react-dom | MIT | | ✅ |
| vite, @vitejs/plugin-react | MIT | | ✅ |
| typescript | Apache-2.0 | | ✅ |
| tailwindcss, @tailwindcss/vite | MIT | | ✅ |
| react-router-dom | MIT | | ✅ |
| motion (formerly Framer Motion) | MIT | Verified: repo licence MIT. Motion+ (paid) components are **not** used | ✅ |
| lucide-react | ISC | | ✅ |
| recharts | MIT | | ✅ |
| clsx | MIT | | ✅ |
| @fontsource-variable/plus-jakarta-sans | OFL-1.1 (font), MIT (package) | self-hosted, no Google Fonts CDN call | ✅ |
| @tanstack/react-query, @tanstack/react-table | MIT | Phase 2 | ✅ |
| react-hook-form, zod | MIT | Phase 2 | ✅ |
| @fullcalendar/core, daygrid, timegrid, list, interaction, react | MIT | **Premium plugins (resource-timeline etc.) are commercial and excluded** | ✅ |
| livekit-client 2.23.0, @livekit/components-react 2.9.24 (+ @livekit/components-core 0.12.15), @livekit/components-styles 1.2.0 | Apache-2.0 | Phase 4 video room (frontend, lazy-loaded chunk) + recorder layout (PoC). Pinned exact versions (released 2026-10-16, 2026-08-11, 2025-11-14). Transitive: rxjs 7.8.2 (Apache-2.0), usehooks-ts 3.1.1 (MIT), jose 6 (MIT), @floating-ui/dom 1.7.6 (MIT), loglevel (MIT), sdp-transform (MIT), webrtc-adapter (BSD-3-Clause). The optional peer `@livekit/krisp-noise-filter` (LiveKit Cloud terms, not open source) is **not installed** | ✅ |
| livekit-server-sdk 2.19.2, playwright-core 1.64.1 | Apache-2.0 | PoC test harness only | ✅ |
| xUnit 2.9 | Apache-2.0 | .NET unit tests | ✅ |
| @microsoft/signalr | MIT | Phase 3 | ✅ |
| date-fns, @date-fns/tz | MIT | | ✅ |

## Assets

| Asset | Licence / ownership | Notes |
|---|---|---|
| OneInsure Connect logo (`assets/logo/connect/`, `frontend/src/components/brand/`) | Original work created for this project | |
| OneInsure corporate logo (`assets/logo/oneinsure/`) | OneInsure trademark, from oneinsure.com | Used by OneInsure for its own internal product |
| Icons | Lucide (ISC) | |
| Illustrations / animations | Original inline SVG + CSS | No Lottie or third-party assets used yet |
| Font | Plus Jakarta Sans, SIL OFL-1.1 | |

## Test tooling

| Tool | Licence | Status |
|---|---|---|
| xUnit, FluentAssertions 7.x (8.x is commercial — stay on 7.x or use Shouldly, BSD-3) | Apache-2.0 / BSD | ✅ (version-pinned) |
| Playwright Test (e2e) | Apache-2.0 | ✅ |
| Grafana k6 | AGPL-3.0 (unmodified CLI use) | ✅ |
| LiveKit CLI `lk load-test` | Apache-2.0 | ✅ |
| OWASP ZAP | Apache-2.0 | ✅ |

**Net additional software cost: ₹0.** Infrastructure (servers, bandwidth, storage, backup, public certificate if not ACME) is still an operating cost, as the BRD stated.
