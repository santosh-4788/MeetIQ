<#
.SYNOPSIS
    Starts an ISOLATED OneInsure Connect API instance for the Phase 5 recording end-to-end test.

    - Database: LocalDB OneInsureVideoMeetingDB_Rec only (never a shared server). Environment name "RecE2E", so .NET user secrets
      (the developer's connection string) are NOT loaded; everything comes from this script.
    - Port: https://localhost:7192 (web: Vite on http://127.0.0.1:5176). No LiveKit webhook listener (the meeting is ended from the UI).
    - LiveKit: the running local dev server (ws://127.0.0.1:7880); key/secret read from video-server/config/dev.local.env.
    - Recording: library recording\e2e\library, spool recording\e2e\spool, the R2 recorder build given by -RecorderExe,
      FFmpeg from C:\ffmpeg\ffmpeg-7.1.1-essentials_build\bin (override with $env:OIC_FFMPEG_DIR).
    - E-mail disabled (messages stay in app.EmailOutbox).
    The developer API (7180 / 5173 / webhook 5080) is never touched.

    -ApiDll / -RecorderExe default to the build in backend\.artifacts (dotnet build --artifacts-path backend\.artifacts),
    falling back to the normal bin\Debug / bin\Release outputs.
#>
[CmdletBinding()]
param(
    [string] $Database = 'OneInsureVideoMeetingDB_Rec',
    [int] $Port = 7192,
    [int] $WebPort = 5176,
    [string] $ApiDll,
    [string] $RecorderExe,
    [switch] $SetupAdmin,
    [string] $AdminEmail = 'superadmin@rec.oneinsure.test'
)
$ErrorActionPreference = 'Stop'
if ($Database -notmatch '_Rec$') { throw 'The recording test API only runs against a database whose name ends in _Rec.' }
if ($Port -eq 7180 -or $WebPort -eq 5173) { throw 'Ports 7180/5173 belong to the developer instance.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$apiDir = Join-Path $root 'backend\src\OneInsure.Connect.Api'
if (-not $ApiDll) {
    $ApiDll = Join-Path $root 'backend\.artifacts\bin\OneInsure.Connect.Api\debug\OneInsure.Connect.Api.dll'
    if (-not (Test-Path $ApiDll)) { $ApiDll = Join-Path $apiDir 'bin\Debug\net10.0\OneInsure.Connect.Api.dll' }
}
if (-not $RecorderExe) {
    $RecorderExe = Join-Path $root 'backend\.artifacts\bin\OneInsure.Connect.Recorder\debug\OneInsure.Connect.Recorder.exe'
    if (-not (Test-Path $RecorderExe)) { $RecorderExe = Join-Path $root 'backend\src\OneInsure.Connect.Recorder\bin\Release\net10.0\OneInsure.Connect.Recorder.exe' }
}
$dotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
if (-not (Test-Path $ApiDll)) { throw "API build not found: $ApiDll" }
if (-not (Test-Path $RecorderExe)) { throw "Recorder build not found: $RecorderExe" }
$ffmpegDir = if ($env:OIC_FFMPEG_DIR) { $env:OIC_FFMPEG_DIR } else { 'C:\ffmpeg\ffmpeg-7.1.1-essentials_build\bin' }

$lk = @{}
foreach ($line in Get-Content (Join-Path $root 'video-server\config\dev.local.env')) { if ($line -match '^([A-Z_]+)=(.*)$') { $lk[$Matches[1]] = $Matches[2] } }

$env:ASPNETCORE_ENVIRONMENT = 'RecE2E'
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
$env:Recording__Environment = 'Development'
$env:Recording__StorageRoot = Join-Path $root 'recording\e2e\library'
$env:Recording__SpoolRoot = Join-Path $root 'recording\e2e\spool'
$env:Recording__RecorderExePath = $RecorderExe
$env:Recording__LayoutDistPath = Join-Path $root 'recording\layout\dist'
$env:Recording__FfmpegPath = Join-Path $ffmpegDir 'ffmpeg.exe'
$env:Recording__FfprobePath = Join-Path $ffmpegDir 'ffprobe.exe'
$env:Recording__PollSeconds = '2'

Set-Location $apiDir
if ($SetupAdmin) {
    if (-not $env:OIC_ADMIN_PASSWORD) { throw 'Set $env:OIC_ADMIN_PASSWORD first.' }
    & $dotnet $ApiDll setup-admin --email $AdminEmail --employee-code RC-ADMIN
    exit $LASTEXITCODE
}
& $dotnet $ApiDll
