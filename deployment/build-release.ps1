<#
.SYNOPSIS
    Builds the OneInsure Connect release package for a Windows Server (x64): deployment\out\OneInsureConnect-<version>.zip

.DESCRIPTION
    1. Tests: backend unit + API integration tests (LocalDB) unless -SkipTests.
    2. Web app: type check + production build (frontend\dist). Recorder layout page (recording\layout\dist).
    3. .NET: API, R2 recorder and the service host published self-contained for win-x64 (no .NET install on the server).
    4. Adds the LiveKit server binary (checksum-verified), database migrations, server templates, installer and guides.
    5. Refuses to package anything that looks like a secret (development settings, user secrets, keys, certificates).
    6. Zips the folder and writes SHA256 checksums.
    Nothing is deployed, uploaded or installed by this script.
#>
[CmdletBinding()]
param(
    [string] $Version = ('0.7.0-' + (Get-Date -Format 'yyyyMMdd.HHmm')),
    [switch] $SkipTests
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
if (-not (Test-Path $dotnet)) { $dotnet = 'dotnet' }
$name = "OneInsureConnect-$Version"
$out = Join-Path $PSScriptRoot 'out'
$stage = Join-Path $out $name
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Run($exe, [string[]] $a, $cwd) {
    Push-Location $cwd
    try { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') failed ($LASTEXITCODE)" } } finally { Pop-Location }
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

if (-not $SkipTests) {
    Step 'Backend tests'
    Run $dotnet @('test', 'OneInsure.Connect.sln', '-c', 'Debug', '--nologo', '-v', 'q') (Join-Path $repo 'backend')
}

Step 'Web app'
Run 'npm.cmd' @('run', 'build') (Join-Path $repo 'frontend')
Copy-Item (Join-Path $repo 'frontend\dist') (Join-Path $stage 'web') -Recurse

Step 'Recorder layout page'
Run 'npm.cmd' @('run', 'build') (Join-Path $repo 'recording\layout')
Copy-Item (Join-Path $repo 'recording\layout\dist') (Join-Path $stage 'recorder-layout') -Recurse

Step '.NET publish (self-contained, win-x64)'
$common = @('-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '--nologo', '-v', 'q', '-p:DebugType=none', "-p:InformationalVersion=$Version")
Run $dotnet (@('publish', 'src\OneInsure.Connect.Api\OneInsure.Connect.Api.csproj', '-o', (Join-Path $stage 'api')) + $common) (Join-Path $repo 'backend')
Run $dotnet (@('publish', 'src\OneInsure.Connect.Recorder\OneInsure.Connect.Recorder.csproj', '-o', (Join-Path $stage 'recorder')) + $common) (Join-Path $repo 'backend')
Run $dotnet (@('publish', 'src\OneInsure.Connect.ServiceHost\OneInsure.Connect.ServiceHost.csproj', '-o', (Join-Path $stage 'tools\servicehost')) + $common) (Join-Path $repo 'backend')
# Development settings never ship.
Get-ChildItem $stage -Recurse -Include 'appsettings.Development.json', 'appsettings.*.local.json' | Remove-Item -Force

Step 'LiveKit server'
$lk = Join-Path $repo 'video-server\bin'
$exe = Join-Path $lk 'livekit-server.exe'
# The SHA256 of livekit-server.exe 1.13.11 as installed on the build PC (extracted from livekit_1.13.11_windows_amd64.zip,
# whose hash is in video-server\bin\checksums.txt), pinned in deployment\livekit-server.exe.sha256 on 3 Nov 2026:
# any other binary is refused.
$expected = ((Get-Content (Join-Path $PSScriptRoot 'livekit-server.exe.sha256') -TotalCount 1) -split '\s+')[0]
$actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "livekit-server.exe SHA256 $actual does not match the verified hash $expected" }
Write-Host "livekit-server.exe verified ($actual)"
New-Item -ItemType Directory -Force (Join-Path $stage 'video-server') | Out-Null
Copy-Item $exe, (Join-Path $lk 'LICENSE') (Join-Path $stage 'video-server')

Step 'Database, server files, documentation'
New-Item -ItemType Directory -Force (Join-Path $stage 'database') | Out-Null
Copy-Item (Join-Path $repo 'database\migrations') (Join-Path $stage 'database\migrations') -Recurse
Copy-Item (Join-Path $repo 'database\deploy-database.ps1'), (Join-Path $repo 'database\README.md') (Join-Path $stage 'database')
Copy-Item (Join-Path $PSScriptRoot 'server') (Join-Path $stage 'server') -Recurse
Copy-Item (Join-Path $PSScriptRoot 'server\install-oneinsure-connect.ps1') $stage
New-Item -ItemType Directory -Force (Join-Path $stage 'docs') | Out-Null
foreach ($d in 'PRODUCTION_DEPLOYMENT_GUIDE.md', 'GO_LIVE_CHECKLIST.md', 'NETWORK_FIREWALL_REQUIREMENTS.md', 'UAT_TESTING_REPORT.md', 'RECORDING_POLICY_CONFIGURATION.md') {
    $f = Join-Path $repo "documentation\$d"
    if (Test-Path $f) { Copy-Item $f (Join-Path $stage 'docs') }
}
Copy-Item (Join-Path $repo 'documentation\PRODUCTION_DEPLOYMENT_GUIDE.md') (Join-Path $stage 'README.md')
@"
OneInsure Connect $Version
Built $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $env:COMPUTERNAME
Contents: web (static site for IIS), api (self-contained, win-x64), recorder (R2, proof of concept), tools\servicehost,
video-server (LiveKit $((& $exe --version 2>$null) -join ' ')), database (migrations V001-V0xx), server (templates), docs.
"@ | Set-Content (Join-Path $stage 'VERSION.txt') -Encoding UTF8

Step 'Secret scan'
$bad = @(Get-ChildItem $stage -Recurse -File | Where-Object {
    $_.Name -match '\.(pfx|p12|key|pem|env)$' -or $_.Name -match '^(secrets\.json|dev\.local\.env|appsettings\.Development\.json)$'
})
# Configuration-like files (our own; minified/third-party JavaScript is checked for the known development secret below).
$textFiles = Get-ChildItem $stage -Recurse -File -Include *.json, *.config, *.yaml, *.yml, *.ps1, *.md, *.txt, *.html
# Connection-string passwords (Password=xyz; not "...", not placeholders), known passwords, LiveKit keys with a value.
$patterns = @('(?<![A-Za-z_])Password=(?!\.\.\.)[^;"\s<]{4,}', 'LIVEKIT_KEYS=\w', 'ApiSecret"\s*:\s*"[^"]{8,}')
# Known passwords are never written in this repository: optionally list them, one per line, in deployment\.secret-patterns.local
# (git-ignored); the package is refused if any of them appears.
$local = Join-Path $PSScriptRoot '.secret-patterns.local'
if (Test-Path $local) { $patterns += @(Get-Content $local | Where-Object { $_ } | ForEach-Object { [regex]::Escape($_) }) }
foreach ($f in $textFiles) {
    foreach ($p in $patterns) { if (Select-String -Path $f.FullName -Pattern $p -Quiet) { $bad += $f; break } }
}
$devEnv = Join-Path $repo 'video-server\config\dev.local.env'
if (Test-Path $devEnv) {
    $devSecret = (Get-Content $devEnv | Where-Object { $_ -match '^LIVEKIT_API_SECRET=(.+)$' } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
    if ($devSecret) { $bad += @(Get-ChildItem $stage -Recurse -File | Where-Object { Select-String -Path $_.FullName -SimpleMatch $devSecret -Quiet }) }
}
if ($bad.Count) { throw "Possible secrets in the package, not zipped:`n$(($bad | Select-Object -ExpandProperty FullName -Unique) -join "`n")" }
Write-Host 'no secrets found'

Step 'Checksums and zip'
$sums = Get-ChildItem $stage -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | ForEach-Object {
    "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.FullName.Substring($stage.Length + 1))"
}
$sums | Set-Content (Join-Path $stage 'SHA256SUMS.txt') -Encoding ASCII
$zip = Join-Path $out "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $name.zip" | Set-Content "$zip.sha256" -Encoding ASCII
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "`nPackage: $zip ($mb MB)`nSHA256:  $hash" -ForegroundColor Green
