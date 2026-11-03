# OneInsure Connect — production deployment guide (Windows Server)

For the IT/server administrator who installs the release package. Version and build date are in `VERSION.txt`.

> **Status:** the package is built and verified on the build PC. **User acceptance testing (UAT) is still pending** for Phases 2–4, recording and Phase B (see `docs/UAT_TESTING_REPORT.md`), and the R2 recorder is a **proof of concept**. Go live only after the [go-live checklist](GO_LIVE_CHECKLIST.md) is signed off.

## 1. What runs on the server

| Component | How it runs | Listens on | Reached by |
|---|---|---|---|
| Web app (static files) | IIS site `OneInsure Connect` (`<InstallRoot>\web`) | 443 (https), 80 (redirect only) | Everyone |
| API | Windows service `OneInsureConnectApi` (self-contained .NET 10, account `NT SERVICE\OneInsureConnectApi`) | `127.0.0.1:5000` | IIS only (`/api/*`) |
| LiveKit video server 1.13.11 | Windows service `OneInsureConnectVideo` (supervisor + `livekit-server.exe`, account `NT SERVICE\OneInsureConnectVideo`) | signalling `127.0.0.1:7880`; media **TCP 7881, UDP 7882** on all interfaces | Signalling via IIS (`/rtc`); media directly from browsers |
| R2 recorder (proof of concept) | Started by the API per recording (headless Microsoft Edge + FFmpeg) | nothing | — |
| SQL Server | Existing server (not installed by this package) | 1433 (or your port) | The API only — **never expose it to the internet** |
| E-mail | `[Beeinsured_v3_2].dbo.Util_SendEmail2` through the same SQL connection | — | — |

## 2. Server requirements

- Windows Server 2019 or 2022, x64, **4 vCPU / 8 GB RAM minimum** (10–25 meetings: 8 vCPU / 16 GB, to be confirmed by load test), 100 GB free disk + recording storage, 1 Gbit/s NIC.
- A **public IPv4** (directly, or NAT with port forwarding) and a DNS name, e.g. `meet.oneinsure.in` → that IP.
- A **TLS certificate** for that name (PFX) imported into *Local Computer → Personal* (`Cert:\LocalMachine\My`).
- IIS with these features (Server Manager → Add roles → Web Server): *Static Content, Default Document, HTTP Errors, Request Filtering, WebSocket Protocol, IIS Management Console*.
- Free Microsoft add-ons: **URL Rewrite 2.1** and **Application Request Routing 3.0** (download from iis.net).
- Recording only (proof of concept): Microsoft Edge (installed on Server 2022 by default) and FFmpeg 7.x (e.g. the "essentials" build unpacked to `C:\ffmpeg`, so `C:\ffmpeg\bin\ffmpeg.exe` exists). FFmpeg is not included in the package.
- No .NET installation is needed (the programs are self-contained).

## 3. Network and firewall (needs the network team's approval)

| Direction | Port | Purpose |
|---|---|---|
| Inbound from the internet | TCP 443 | Website, API, video signalling (all through IIS) |
| Inbound from the internet | TCP 80 | Redirect to https only |
| Inbound from the internet | **UDP 7882** | Video/audio media (preferred) |
| Inbound from the internet | **TCP 7881** | Video/audio media fallback when UDP is blocked |
| Outbound | SQL Server port to the database server | API → database and e-mail procedure |
| Never open | 1433, 3389 (RDP), 5000, 7880, 5985 | Internal only |

With NAT, forward TCP 443/80, TCP 7881 and UDP 7882 to the server's internal address. Users on networks that block both UDP 7882 and TCP 7881 cannot send media (a TURN server is not part of this release).

## 4. Database

Run once per release **before** installing, from the unpacked package, in PowerShell (password asked hidden, kept only in this window):

```powershell
cd C:\Deploy\OneInsureConnect-<version>
$env:SQLCMDPASSWORD = Read-Host 'SQL password' -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
.\database\deploy-database.ps1 -Server "103.224.240.90,57116" -Database Oneinsure_v -SqlLogin support_oneinsure -Plan   # shows what would change
.\database\deploy-database.ps1 -Server "103.224.240.90,57116" -Database Oneinsure_v -SqlLogin support_oneinsure         # applies new migrations (transactional)
Remove-Item Env:SQLCMDPASSWORD
```

Back up the database before applying migrations (`BACKUP DATABASE … TO DISK = …` on the SQL Server). Which database is the production database is your decision; the commands above use the current test database as the example.

## 5. Install

1. Copy `OneInsureConnect-<version>.zip` to the server, check it: `Get-FileHash .\OneInsureConnect-<version>.zip` must equal the `.sha256` file. Unpack to e.g. `C:\Deploy\`.
2. Elevated PowerShell in the unpacked folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-oneinsure-connect.ps1 -Domain meet.oneinsure.in -PublicIp <public IPv4> -MediaIp <this server's IPv4 on the media NIC> `
    -ConfigureIis -CertThumbprint <certificate thumbprint>
# add -OpenFirewall only after the network team approved the rules in section 3
```

The script asks once for the SQL connection string (hidden input) and generates the LiveKit key/secret. Secrets are stored **only** as environment variables of the two Windows services (registry keys readable only by SYSTEM and administrators), never in files. It creates the services, the IIS site, and checks `http://127.0.0.1:5000/api/v1/health`.

Installed layout (`C:\OneInsureConnect` by default): `web`, `api`, `recorder`, `recorder-layout`, `video-server`, `tools\servicehost`, `database`, `data\keys` (Data Protection keys — **back up**), `data\recordings`, `data\spool`, `logs`.

## 6. Check

```powershell
Get-Service OneInsureConnectApi, OneInsureConnectVideo        # both Running
Invoke-WebRequest https://meet.oneinsure.in/api/v1/health -UseBasicParsing   # 200 {"status":"Healthy"}
```

Then from a PC **outside** the office network and from a phone on mobile data: sign in, start a meeting (Dashboard → New meeting), open the link on the phone, admit, check audio/video both ways.

## 7. First administrator (new database only)

If the database has no users yet (the current `Oneinsure_v` already has its SuperAdmin):

```powershell
cd C:\OneInsureConnect\api
$env:ASPNETCORE_ENVIRONMENT = 'Production'
$env:ConnectionStrings__OneInsure = Read-Host 'Connection string'
$env:OIC_ADMIN_PASSWORD = Read-Host 'Temporary admin password'
.\OneInsure.Connect.Api.exe setup-admin --email admin@oneinsure.com --employee-code ADMIN-001
Remove-Item Env:ConnectionStrings__OneInsure, Env:OIC_ADMIN_PASSWORD
```

The password must be changed at the first sign-in.

## 8. Upgrade, restart, rollback

- **Upgrade:** database step (section 4), then run the installer of the new package with the same parameters. Services are stopped, programs replaced, `data\` and the stored secrets kept.
- **Restart:** `Restart-Service OneInsureConnectVideo, OneInsureConnectApi`. Both restart automatically after a crash (10 s / 30 s / 60 s).
- **Rollback:** run the previous package's installer. Migrations are additive; a database restore is only needed if a migration must be undone.
- **Change the SQL connection string / rotate the LiveKit key:** run the installer again with `-ResetSecrets`.

## 9. Logs and monitoring

- API: Event Viewer → Windows Logs → Application (warnings and errors), audit trail in `app.AuditLog`.
- Video server: `C:\OneInsureConnect\logs\livekit-server-YYYYMMDD.log`.
- Health: `https://<domain>/api/v1/health` (200 = API and database OK). Monitor it every minute from your monitoring tool.

## 10. Important

- **Data Protection keys** (`data\keys`) encrypt two-factor secrets and meeting links. Back them up with the server. A **new server has new keys**: people who set up two-factor sign-in on the test laptop must set it up again (an administrator resets it in Users & roles), and meeting links created on the laptop stop working.
- **Recording** stays refused in production until a policy is confirmed in Administration → Recording policies (by design). The recorder is a proof of concept.
- **Mobile:** works in Chrome (Android) and Safari (iOS 15+); the site can be added to the home screen. Screen sharing is not available on phones (browser limitation). Keep the meeting screen open: phones may cut audio when the browser is in the background.
