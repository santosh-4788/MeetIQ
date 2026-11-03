<#
.SYNOPSIS
    Installs or upgrades OneInsure Connect on a Windows Server (run in an elevated PowerShell, from the unpacked release folder).

.DESCRIPTION
    What it does (nothing else; it never changes DNS, the database or the network unless you pass the switches below):
      1. Stops the two services (upgrade), copies api, web, recorder, recorder-layout, video-server and tools to -InstallRoot.
         data\ (keys, recordings, spool) and logs\ are kept on upgrade.
      2. Writes api\appsettings.Production.json and video-server\livekit.production.yaml from the templates (no secrets).
      3. First install only: asks for the SQL connection string (hidden input) and generates the LiveKit API key and secret.
         They are stored ONLY as environment variables of the Windows services (registry, readable by administrators and
         SYSTEM). Nothing secret is written to a file.
      4. Creates/updates the Windows services, each under its own virtual account, automatic start, restart on failure:
           OneInsureConnectVideo  LiveKit video server (through OneInsure.Connect.ServiceHost)
           OneInsureConnectApi    the API (Kestrel, http://127.0.0.1:5000, loopback only)
      5. -ConfigureIis: IIS application pool + https site for -Domain with the certificate -CertThumbprint, ARR proxy on.
      6. -OpenFirewall: inbound Windows Firewall rules TCP 443, TCP 7881, UDP 7882 (only with your network team's approval).
      7. Starts the services and checks http://127.0.0.1:5000/api/v1/health.

    Prerequisites: Windows Server 2019/2022 (x64), IIS with "WebSocket Protocol", URL Rewrite 2.1 and Application Request
    Routing 3.0 (free Microsoft downloads), a TLS certificate for -Domain in LocalMachine\My, SQL Server reachable from this
    server, the database migrated (database\deploy-database.ps1). Recording (proof of concept) also needs Microsoft Edge and FFmpeg.

.EXAMPLE
    .\install-oneinsure-connect.ps1 -Domain meet.oneinsure.in -PublicIp 203.0.113.10 -MediaIp 10.0.0.5 -ConfigureIis -CertThumbprint 0123ABCD...
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Domain,
    # Address browsers use for media (public IP or the NAT's public IP).
    [Parameter(Mandatory)] [string] $PublicIp,
    # This server's own IPv4 on the network card that carries the media (the NAT target). Default: same as -PublicIp.
    [string] $MediaIp,
    [string] $InstallRoot = 'C:\OneInsureConnect',
    [switch] $ConfigureIis,
    [string] $CertThumbprint,
    [switch] $OpenFirewall,
    # Replace the stored SQL connection string / regenerate the LiveKit key (otherwise kept on upgrade).
    [switch] $ResetSecrets
)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an elevated PowerShell (Run as administrator).'
}
if (-not (Test-Path (Join-Path $src 'api\OneInsure.Connect.Api.exe'))) { throw "Run the script from the unpacked release folder (api\ not found next to it)." }
if ($Domain -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { throw "Not a valid host name: $Domain" }
$ip = [Net.IPAddress]::None
if (-not [Net.IPAddress]::TryParse($PublicIp, [ref]$ip)) { throw "Not an IP address: $PublicIp" }
if (-not $MediaIp) { $MediaIp = $PublicIp }
if (-not [Net.IPAddress]::TryParse($MediaIp, [ref]$ip)) { throw "Not an IP address: $MediaIp" }
if ($ConfigureIis -and -not $CertThumbprint) { throw '-ConfigureIis needs -CertThumbprint (certificate for the domain in LocalMachine\My).' }

$apiSvc = 'OneInsureConnectApi'
$videoSvc = 'OneInsureConnectVideo'
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

# ---- 1. Copy ------------------------------------------------------------------------------------------------------
Step 'Stopping services (upgrade) and copying files'
foreach ($s in $apiSvc, $videoSvc) { if (Get-Service $s -ErrorAction SilentlyContinue) { Stop-Service $s -Force; Write-Host "stopped $s" } }
Start-Sleep -Seconds 2
foreach ($d in 'data\keys', 'data\recordings', 'data\spool', 'logs') { New-Item -ItemType Directory -Force (Join-Path $InstallRoot $d) | Out-Null }
foreach ($d in 'api', 'web', 'recorder', 'recorder-layout', 'video-server', 'tools', 'database') {
    $from = Join-Path $src $d
    if (-not (Test-Path $from)) { continue }
    $to = Join-Path $InstallRoot $d
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse
}
Copy-Item (Join-Path $src 'server\web.config') (Join-Path $InstallRoot 'web\web.config') -Force
Copy-Item (Join-Path $src 'VERSION.txt') $InstallRoot -Force

# ---- 2. Configuration files (no secrets) ----------------------------------------------------------------------------
Step 'Writing configuration'
$rootJson = $InstallRoot.Replace('\', '\\')
(Get-Content (Join-Path $src 'server\appsettings.Production.template.json') -Raw).Replace('__ROOT__', $rootJson).Replace('__DOMAIN__', $Domain) |
    Set-Content (Join-Path $InstallRoot 'api\appsettings.Production.json') -Encoding UTF8

# ---- 3. Secrets (service environment only) --------------------------------------------------------------------------
function Get-ServiceEnv($name) {
    $v = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name Environment -ErrorAction SilentlyContinue).Environment
    $h = @{}
    foreach ($line in @($v)) { if ($line -match '^([^=]+)=(.*)$') { $h[$Matches[1]] = $Matches[2] } }
    return $h
}
$apiEnv = Get-ServiceEnv $apiSvc
$conn = $apiEnv['ConnectionStrings__OneInsure']
$lkKey = $apiEnv['LiveKit__ApiKey']
$lkSecret = $apiEnv['LiveKit__ApiSecret']
if ($ResetSecrets -or -not $conn) {
    Step 'SQL connection string'
    Write-Host 'Example: Server=SQLHOST,1433;Database=Oneinsure_v;User ID=support_oneinsure;Password=...;Encrypt=True;TrustServerCertificate=True'
    $sec = Read-Host 'Paste the connection string (input hidden)' -AsSecureString
    $conn = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if ($conn -notmatch 'Database=') { throw 'That does not look like a SQL Server connection string.' }
}
if ($ResetSecrets -or -not $lkKey -or -not $lkSecret) {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $b = New-Object byte[] 6; $rng.GetBytes($b); $lkKey = 'OIC' + (($b | ForEach-Object { $_.ToString('x2') }) -join '')
    $b = New-Object byte[] 36; $rng.GetBytes($b); $lkSecret = [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', 'A').Replace('/', 'B')
    Write-Host "Generated a new LiveKit API key ($lkKey) and secret (not shown)."
}
# Written without a byte-order mark (the LiveKit YAML parser does not accept one).
[IO.File]::WriteAllText((Join-Path $InstallRoot 'video-server\livekit.production.yaml'),
    (Get-Content (Join-Path $src 'server\livekit.production.template.yaml') -Raw).Replace('__PUBLIC_IP__', $PublicIp).Replace('__MEDIA_IP__', $MediaIp).Replace('__API_KEY__', $lkKey))

# ---- 4. Services ----------------------------------------------------------------------------------------------------
Step 'Windows services'
function Set-OicService($name, $display, $bin, $description, [string[]] $envLines, [string[]] $dependsOn) {
    if (-not (Get-Service $name -ErrorAction SilentlyContinue)) {
        & sc.exe create $name binPath= $bin start= delayed-auto obj= "NT SERVICE\$name" DisplayName= $display | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc create $name failed ($LASTEXITCODE)" }
    } else {
        & sc.exe config $name binPath= $bin start= delayed-auto obj= "NT SERVICE\$name" | Out-Null
    }
    & sc.exe description $name $description | Out-Null
    # Restart after 10 s, 30 s, 60 s; reset the counter after a day.
    & sc.exe failure $name reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
    if ($dependsOn) { & sc.exe config $name depend= ($dependsOn -join '/') | Out-Null }
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$name"
    New-ItemProperty $key -Name Environment -PropertyType MultiString -Value $envLines -Force | Out-Null
    # The environment holds secrets: only SYSTEM (the service manager) and administrators may read this key (by default
    # every user can read service keys).
    $acl = New-Object Security.AccessControl.RegistrySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($who in 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators') {
        $acl.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule($who, 'FullControl', 'ContainerInherit', 'None', 'Allow')))
    }
    Set-Acl -Path $key -AclObject $acl
    Write-Host "configured $name"
}
$video = Join-Path $InstallRoot 'video-server'
$hostDir = Join-Path $InstallRoot 'tools\servicehost'
# The supervisor's settings (paths only, no secrets).
@{ Supervisor = @{ ServiceName = $videoSvc; Executable = "$video\livekit-server.exe"; Arguments = "--config `"$video\livekit.production.yaml`""; LogDirectory = (Join-Path $InstallRoot 'logs') } } |
    ConvertTo-Json -Depth 3 | Set-Content (Join-Path $hostDir 'appsettings.json') -Encoding UTF8
Set-OicService $videoSvc 'OneInsure Connect - Video server' `
    "`"$hostDir\OneInsure.Connect.ServiceHost.exe`"" `
    'LiveKit SFU for OneInsure Connect meetings (signalling on loopback, media TCP 7881 / UDP 7882).' `
    @("LIVEKIT_KEYS=${lkKey}: $lkSecret") @()
Set-OicService $apiSvc 'OneInsure Connect - API' `
    "`"$(Join-Path $InstallRoot 'api\OneInsure.Connect.Api.exe')`"" `
    'OneInsure Connect API (http://127.0.0.1:5000, behind IIS).' `
    @('ASPNETCORE_ENVIRONMENT=Production', "ConnectionStrings__OneInsure=$conn", "LiveKit__ApiKey=$lkKey", "LiveKit__ApiSecret=$lkSecret") @()
$conn = $null; $lkSecret = $null

# Folder permissions: each service account gets only what it needs. Keys: API account + administrators only.
function Grant($path, $who, $rights) { & icacls $path /grant "${who}:(OI)(CI)$rights" /T /Q | Out-Null }
Grant (Join-Path $InstallRoot 'api') "NT SERVICE\$apiSvc" 'RX'
Grant (Join-Path $InstallRoot 'recorder') "NT SERVICE\$apiSvc" 'RX'
Grant (Join-Path $InstallRoot 'recorder-layout') "NT SERVICE\$apiSvc" 'RX'
foreach ($d in 'data\recordings', 'data\spool', 'logs') { Grant (Join-Path $InstallRoot $d) "NT SERVICE\$apiSvc" 'M' }
Grant (Join-Path $InstallRoot 'logs') "NT SERVICE\$videoSvc" 'M'
Grant $video "NT SERVICE\$videoSvc" 'RX'
Grant (Join-Path $InstallRoot 'tools') "NT SERVICE\$videoSvc" 'RX'
$keys = Join-Path $InstallRoot 'data\keys'
& icacls $keys /inheritance:r /grant:r 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' "NT SERVICE\${apiSvc}:(OI)(CI)M" /Q | Out-Null

# ---- 5. IIS ---------------------------------------------------------------------------------------------------------
if ($ConfigureIis) {
    Step 'IIS site'
    $appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
    if (-not (Test-Path $appcmd)) { throw 'IIS is not installed.' }
    if (-not (Test-Path (Join-Path $env:windir 'System32\inetsrv\rewrite.dll'))) { throw 'IIS URL Rewrite 2.1 is not installed.' }
    if (-not (Test-Path (Join-Path $env:ProgramFiles 'IIS\Application Request Routing'))) { throw 'IIS Application Request Routing 3.0 is not installed.' }
    if (-not (Test-Path "Cert:\LocalMachine\My\$CertThumbprint")) { throw "Certificate $CertThumbprint not found in LocalMachine\My." }
    # ARR as a reverse proxy, client IP in X-Forwarded-For, no response buffering (recording playback streams), X-Forwarded-Proto allowed.
    & $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /responseBufferLimit:"0" /commit:apphost | Out-Null
    & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_PROTO']" /commit:apphost 2>$null | Out-Null
    $pool = 'OneInsureConnect'
    if (-not (& $appcmd list apppool /name:$pool)) { & $appcmd add apppool /name:$pool /managedRuntimeVersion:"" | Out-Null }
    $site = 'OneInsure Connect'
    $web = Join-Path $InstallRoot 'web'
    if (-not (& $appcmd list site /name:"$site")) {
        & $appcmd add site /name:"$site" /physicalPath:"$web" /bindings:"https/*:443:$Domain,http/*:80:$Domain" | Out-Null
    }
    & $appcmd set site /site.name:"$site" /[path='/'].applicationPool:$pool | Out-Null
    & $appcmd set config "$site" -section:system.webServer/webSocket /enabled:"True" /commit:apphost 2>$null | Out-Null
    & netsh http delete sslcert hostnameport="${Domain}:443" 2>$null | Out-Null
    & netsh http add sslcert hostnameport="${Domain}:443" certhash=$CertThumbprint appid='{4dc3e181-e14b-4a21-b022-59fc669b0914}' certstorename=MY | Out-Null
    & $appcmd set site /site.name:"$site" /bindings.[protocol='https',bindingInformation='*:443:$Domain'].sslFlags:1 | Out-Null
    Grant $web 'IIS_IUSRS' 'RX'
    Write-Host "IIS site '$site' -> $web (https://$Domain)"
}

# ---- 6. Firewall (explicit switch only) ----------------------------------------------------------------------------
$rules = @(@{ n = 'OneInsure Connect HTTPS'; p = 'TCP'; port = 443 }, @{ n = 'OneInsure Connect HTTP (redirect)'; p = 'TCP'; port = 80 },
           @{ n = 'OneInsure Connect media TCP'; p = 'TCP'; port = 7881 }, @{ n = 'OneInsure Connect media UDP'; p = 'UDP'; port = 7882 })
if ($OpenFirewall) {
    Step 'Windows Firewall'
    foreach ($r in $rules) {
        Get-NetFirewallRule -DisplayName $r.n -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $r.n -Group 'OneInsure Connect' -Direction Inbound -Protocol $r.p -LocalPort $r.port -Action Allow -Profile Any | Out-Null
        Write-Host "allowed inbound $($r.p) $($r.port)"
    }
} else {
    Step 'Windows Firewall NOT changed (no -OpenFirewall). Needed inbound: TCP 443, TCP 80 (redirect), TCP 7881, UDP 7882. Never open 1433, 3389, 5000, 7880.'
}

# ---- 7. Start + health ------------------------------------------------------------------------------------------------
Step 'Starting services'
Start-Service $videoSvc
Start-Service $apiSvc
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep -Seconds 2
    try { $ok = (Invoke-WebRequest 'http://127.0.0.1:5000/api/v1/health' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { }
}
if ($ok) { Write-Host "API healthy (database reachable)." -ForegroundColor Green }
else { Write-Warning "API health check failed. Check Event Viewer > Windows Logs > Application (source OneInsureConnectApi) and the SQL connection string." }
try { $lk = (Invoke-WebRequest 'http://127.0.0.1:7880/' -UseBasicParsing -TimeoutSec 5).StatusCode; Write-Host "LiveKit answering ($lk)." -ForegroundColor Green }
catch { Write-Warning "LiveKit not answering on 127.0.0.1:7880. See $InstallRoot\logs\livekit-server-*.log" }
Write-Host "`nDone. Version: $(Get-Content (Join-Path $InstallRoot 'VERSION.txt') -TotalCount 1)"
Write-Host "Next: first administrator (once): see PRODUCTION_DEPLOYMENT_GUIDE.md, section 7."
