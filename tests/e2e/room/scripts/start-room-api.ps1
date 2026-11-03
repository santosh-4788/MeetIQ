<#
.SYNOPSIS
    Starts an ISOLATED OneInsure Connect API instance for the Phase 4 video-room browser test.

    - Database: LocalDB OneInsureVideoMeetingDB_Room only (never a shared server). The environment name is "RoomE2E",
      so .NET user secrets (the developer's connection string) are NOT loaded; everything comes from this script.
    - Port: https://localhost:7191. LiveKit webhooks: plain http on http://127.0.0.1:5091 (loopback only).
    - LiveKit: the local dev server (ws://127.0.0.1:7880); key/secret read from video-server/config/dev.local.env.
    - E-mail disabled (messages stay in app.EmailOutbox).
    The developer API (7180 / webhook 5080) is never touched.

    Pass -SetupAdmin to run the one-off "setup-admin" command instead of the web server.
#>
[CmdletBinding()]
param(
    [string] $Database = 'OneInsureVideoMeetingDB_Room',
    [int] $Port = 7191,
    [int] $WebPort = 5175,
    [int] $WebhookPort = 5091,
    [switch] $SetupAdmin,
    [string] $AdminEmail = 'superadmin@room.oneinsure.test'
)
$ErrorActionPreference = 'Stop'
if ($Database -notmatch '_Room$') { throw 'The room test API only runs against a database whose name ends in _Room.' }
if ($Port -eq 7180 -or $WebPort -eq 5173 -or $WebhookPort -eq 5080) { throw 'Ports 7180/5173/5080 belong to the developer instance.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$apiDir = Join-Path $root 'backend\src\OneInsure.Connect.Api'
$dll = Join-Path $apiDir 'bin\Debug\net10.0\OneInsure.Connect.Api.dll'
$dotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
if (-not (Test-Path $dll)) { throw "Debug build not found: $dll. Run: & `"$dotnet`" build -c Debug (in backend)." }

$lk = @{}
foreach ($line in Get-Content (Join-Path $root 'video-server\config\dev.local.env')) { if ($line -match '^([A-Z_]+)=(.*)$') { $lk[$Matches[1]] = $Matches[2] } }

$env:ASPNETCORE_ENVIRONMENT = 'RoomE2E'
$env:ASPNETCORE_URLS = "https://localhost:$Port"
$env:ConnectionStrings__OneInsure = "Server=(localdb)\MSSQLLocalDB;Database=$Database;Integrated Security=true;TrustServerCertificate=true"
$env:Security__CookieSecure = 'false'
$env:Security__LoginPermitPerMinute = '1000'
$env:Security__AllowedOrigins__0 = "http://localhost:$WebPort"
$env:Security__AllowedOrigins__1 = "http://127.0.0.1:$WebPort"
$env:PublicEndpoints__WebBaseUrl = "http://127.0.0.1:$WebPort"
$env:Email__Enabled = 'false'
$env:Reminders__Enabled = 'false'
$env:LiveKit__PublicUrl = 'ws://127.0.0.1:7880'
$env:LiveKit__ApiUrl = 'http://127.0.0.1:7880'
$env:LiveKit__ApiKey = $lk['LIVEKIT_API_KEY']
$env:LiveKit__ApiSecret = $lk['LIVEKIT_API_SECRET']
$env:LiveKit__WebhookListenUrl = "http://127.0.0.1:$WebhookPort"

Set-Location $apiDir
if ($SetupAdmin) {
    if (-not $env:OIC_ADMIN_PASSWORD) { throw 'Set $env:OIC_ADMIN_PASSWORD first.' }
    & $dotnet $dll setup-admin --email $AdminEmail --employee-code RM-ADMIN
    exit $LASTEXITCODE
}
& $dotnet $dll
