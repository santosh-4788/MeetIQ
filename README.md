# OneInsure Connect

**Connect. Collaborate. Grow.** An enterprise video meeting, calendar and collaboration platform for OneInsure. It is self-hosted on Windows Server and uses free and open-source software only.

> **Status: Phase 2 in progress.** Database migrations, ASP.NET Core 10 API with real sign-in (sessions, lockout, password change/reset) and a real dashboard API exist. MFA, employee/org masters, meetings, video and recording UI are not built yet. The R2 recorder is a proof-of-concept. See [PROJECT_CHECKLIST.md](PROJECT_CHECKLIST.md) and [documentation/DEVELOPMENT_RECOVERY_REPORT.md](documentation/DEVELOPMENT_RECOVERY_REPORT.md).

## Start here

| Document | Purpose |
|---|---|
| [documentation/FEASIBILITY_AND_ARCHITECTURE_REPORT.md](documentation/FEASIBILITY_AND_ARCHITECTURE_REPORT.md) | BRD gap analysis, Windows compatibility, architecture, sitemap, roadmap, **decisions needed** |
| [SOFTWARE_LICENSES.md](SOFTWARE_LICENSES.md) | Every dependency, its licence and its restrictions |
| [documentation/DATABASE_DESIGN.md](documentation/DATABASE_DESIGN.md) | `OneInsureVideoMeetingDB` design |
| [documentation/UI_DESIGN_SYSTEM.md](documentation/UI_DESIGN_SYSTEM.md) | Colours, typography, motion, components |
| `OneInsure_Video_Meeting_System_Implementation_Plan_Preview.pdf` | Original BRD (not modified) |

## Run the UI prototype

Requires Node.js 22+.

```powershell
cd "E:\OneInsure Connect\frontend"
npm install
npm run dev        # http://localhost:5173  (demo mode: sample identities are listed on the login page)
npm run build      # production build -> frontend/dist (demo adapters are stripped)
```

Demo mode (`VITE_DEMO_MODE=true` in `.env.development`) uses the fictitious accounts in `frontend/src/dev/`. It is compiled out of production builds. Verified: no demo strings appear in `dist/`.

## Run against the real API (Phase 2)

Requires the .NET 10 SDK and SQL Server (LocalDB is fine for development).

```powershell
# 1. Database (see database/README.md)
.databasedeploy-database.ps1 -Server "(localdb)MSSQLLocalDB" -CreateDatabase

# 2. Connection string: user secrets (stored in your Windows profile, never in the repository)
cd backendsrcOneInsure.Connect.Api
dotnet user-secrets set ConnectionStrings:OneInsure "Server=(localdb)MSSQLLocalDB;Database=OneInsureVideoMeetingDB;Integrated Security=true;TrustServerCertificate=true"

# 3. First administrator (once; refuses if a SuperAdmin exists). Prints a one-time password that must be changed at first sign-in.
dotnet build -c Release
$env:ASPNETCORE_ENVIRONMENT = "Development"
dotnet binRelease
et10.0OneInsure.Connect.Api.dll setup-admin --email <your e-mail>

# 4. API on https://localhost:7180 (use "dotnet <dll>", the per-user .NET install is not found by the .exe launcher)
$env:ASPNETCORE_URLS = "https://localhost:7180"
dotnet binRelease
et10.0OneInsure.Connect.Api.dll

# 5. UI against the API (no demo data): http://localhost:5173
cd ......rontend
npm run dev:api
```

Tests: `cd backend; dotnet test` (domain unit tests + API integration tests on a disposable LocalDB database) and `powershell -File testsdatabaseTest-Database.ps1`.

## Video meetings on localhost (Phase 4)

The meeting room uses the local LiveKit server (`video-server/`, loopback only). The API issues short-lived LiveKit tokens and receives LiveKit's signed webhooks (attendance, room finished) on a **development-only plain-http listener on loopback** (`LiveKit:WebhookListenUrl`, default `http://127.0.0.1:5080`, serves nothing but `/api/v1/webhooks/livekit`).

```powershell
# Once: LiveKit key/secret into the API's user secrets (values from the git-ignored video-server\config\dev.local.env)
$kv = @{}; Get-Content "E:\OneInsure Connect\video-server\config\dev.local.env" | % { if ($_ -match '^([A-Z_]+)=(.*)$') { $kv[$Matches[1]] = $Matches[2] } }
& "$env:USERPROFILE\.dotnet\dotnet.exe" user-secrets set "LiveKit:ApiKey" $kv['LIVEKIT_API_KEY'] --project "E:\OneInsure Connect\backend\src\OneInsure.Connect.Api"
& "$env:USERPROFILE\.dotnet\dotnet.exe" user-secrets set "LiveKit:ApiSecret" $kv['LIVEKIT_API_SECRET'] --project "E:\OneInsure Connect\backend\src\OneInsure.Connect.Api"

# LiveKit with webhooks to the API (keep this window open)
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\OneInsure Connect\video-server\start-dev.ps1"
```

Then start the API (Development environment) and `npm run dev:api` as above, open a meeting that starts within 15 minutes and click **Join meeting** / **Start meeting**. Customers and guests join from the link in their invitation e-mail (`/join/{token}`); with the waiting room on, the host admits them from the Participants panel. Browser test: `tests/e2e/room/room.mjs` (isolated LocalDB, API on 7191, Vite on 5175).

## LAN test mode (colleagues on the same office network)

Colleagues open `https://<this-laptop-ip>:5173`. They see a one-time certificate warning (self-signed): click **Advanced → Continue**. They can then sign in, schedule meetings and join video meetings. Video signalling travels through the same HTTPS address (`/rtc` is forwarded to LiveKit); media uses TCP 7881 and UDP 7882.

```powershell
# Once, in PowerShell started with "Run as Administrator" (inbound TCP 5173, TCP 7881, UDP 7882, local subnet only):
powershell -ExecutionPolicy Bypass -File "E:OneInsure Connectscriptslanenable-lan-firewall.ps1"

# Start LAN mode (normal user). It creates the certificate and restarts LiveKit, the API and the website:
powershell -NoProfile -ExecutionPolicy Bypass -File "E:OneInsure Connectscriptslanstart-lan.ps1"

# Back to localhost-only:
powershell -NoProfile -ExecutionPolicy Bypass -File "E:OneInsure Connectscriptslanstop-lan.ps1"
# Remove the firewall rules (as Administrator):
powershell -ExecutionPolicy Bypass -File "E:OneInsure Connectscriptslandisable-lan-firewall.ps1"
```

In LAN mode, invitation e-mail links point to the LAN address. People outside the office network cannot join: that needs the server deployment.

## Layout

```
frontend/        React + TypeScript + Vite + Tailwind (design system, auth screens, dashboard)
backend/         .NET 10: Api (auth, dashboard), Domain (recording policy), Recorder (R2 PoC), tests
database/        SQL Server migrations + runner
documentation/   Deliverables, reports, recovery report
assets/logo/     connect/ (product mark, original)  oneinsure/ (corporate logo from oneinsure.com)
```

Also: `video-server/` (LiveKit), `recording/` (recorder layout), `deployment/`, `tests/` (R2 harness, database tests).
