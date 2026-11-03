<#
.SYNOPSIS
    Starts OneInsure Connect in LAN test mode on this laptop: colleagues on the same local network open
    https://<this-laptop-ip>:5173 (one-time certificate warning) and can sign in, schedule and join video meetings.

    What it does (no administrator rights needed; the firewall rules are separate: enable-lan-firewall.ps1):
      1. Creates (once) a self-signed HTTPS certificate for this laptop's private IPv4 addresses, localhost and
         the computer name; exported to scripts\lan\.local\ (git-ignored) with a random passphrase.
      2. Restarts LiveKit announcing those addresses for media (signalling stays on loopback).
      3. Restarts the API with: LiveKit:PublicUrl "/" (browsers reach video through the site's /rtc),
         the LAN origins allowed, and e-mail links pointing to the LAN address.
      4. Restarts the website (Vite) on HTTPS, all interfaces, port 5173.
    Stop LAN mode: scripts\lan\stop-lan.ps1 (back to localhost-only).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lan\start-lan.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lan\start-lan.ps1 -PrimaryIp 192.168.2.77
#>
[CmdletBinding()]
param([string] $PrimaryIp)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$local = Join-Path $PSScriptRoot '.local'
New-Item -ItemType Directory -Force $local | Out-Null
$dotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'

# ---- 1. Addresses + certificate ----------------------------------------------------------------------------
$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
        $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.InterfaceAlias -notlike 'vEthernet*' -and $_.AddressState -eq 'Preferred'
    } | Sort-Object { if ($_.InterfaceAlias -like 'Ethernet*') { 0 } else { 1 } } | Select-Object -ExpandProperty IPAddress)
if (-not $ips) { throw 'No private IPv4 address found. Connect to the office network first.' }
if ($PrimaryIp) { if ($ips -notcontains $PrimaryIp) { throw "$PrimaryIp is not an address of this laptop ($($ips -join ', '))." }; $ips = @($PrimaryIp) + @($ips | Where-Object { $_ -ne $PrimaryIp }) }
$primary = $ips[0]
$pfx = Join-Path $local 'lan-cert.pfx'
$passFile = Join-Path $local 'lan-cert.pass'
$ipsFile = Join-Path $local 'lan-cert.ips'
if (-not (Test-Path $pfx) -or -not (Test-Path $passFile) -or ((Get-Content $ipsFile -ErrorAction SilentlyContinue) -ne ($ips -join ','))) {
    $san = (@($ips + '127.0.0.1' | ForEach-Object { "IPAddress=$_" }) + @('DNS=localhost', "DNS=$env:COMPUTERNAME")) -join '&'
    $cert = New-SelfSignedCertificate -Subject "CN=OneInsure Connect LAN test ($env:COMPUTERNAME)" -FriendlyName 'OneInsure Connect LAN test' `
        -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddDays(90) `
        -TextExtension @("2.5.29.17={text}$san", '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
    $pass = [Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ }))
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pass -AsPlainText -Force) | Out-Null
    Set-Content -Path $passFile -Value $pass -NoNewline
    Set-Content -Path $ipsFile -Value ($ips -join ',') -NoNewline
    Write-Host "Created HTTPS certificate for $($ips -join ', '), localhost, $env:COMPUTERNAME (valid 90 days)"
}
$pass = Get-Content $passFile -Raw

# ---- 2. Stop the running localhost stack (only OneInsure Connect processes) ---------------------------------
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'livekit-server.exe' -and $_.ExecutablePath -like "$repo\video-server\*") -or
    ($_.Name -eq 'dotnet.exe' -and $_.CommandLine -like '*bin\Release\net10.0\OneInsure.Connect.Api.dll*') -or
    # The LAN site is started with a relative path (vite.lan.config.mjs), the localhost site with the full frontend path.
    ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'vite' -and ($_.CommandLine -match 'vite\.lan\.config' -or ($_.CommandLine -like "*$repo\frontend*" -and $_.CommandLine -match '--port 5173')))
} | ForEach-Object { Write-Host "Stopping $($_.Name) ($($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$logs = Join-Path $repo 'logs'; New-Item -ItemType Directory -Force $logs | Out-Null

# ---- 3. LiveKit (media on the LAN addresses) ---------------------------------------------------------------------
Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$repo\video-server\start-dev.ps1`"", '-LanIps', ($ips -join ',')) `
    -WindowStyle Hidden -RedirectStandardOutput "$logs\livekit-lan.log" -RedirectStandardError "$logs\livekit-lan.err.log" | Out-Null

# ---- 4. API --------------------------------------------------------------------------------------------------------
$origins = @('http://localhost:5173', 'http://127.0.0.1:5173', 'https://localhost:5173') + @($ips | ForEach-Object { "https://$($_):5173" })
$apiEnv = @{
    ASPNETCORE_ENVIRONMENT = 'Development'; ASPNETCORE_URLS = 'https://localhost:7180'; DOTNET_ROOT = Join-Path $env:USERPROFILE '.dotnet'
    LiveKit__PublicUrl = '/'; PublicEndpoints__WebBaseUrl = "https://$($primary):5173"
}
for ($i = 0; $i -lt $origins.Count; $i++) { $apiEnv["Security__AllowedOrigins__$i"] = $origins[$i] }
foreach ($k in $apiEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $apiEnv[$k], 'Process') }
Start-Process -FilePath $dotnet -ArgumentList 'bin\Release\net10.0\OneInsure.Connect.Api.dll' -WorkingDirectory "$repo\backend\src\OneInsure.Connect.Api" `
    -WindowStyle Hidden -RedirectStandardOutput "$logs\api-dev.log" -RedirectStandardError "$logs\api-dev.err.log" | Out-Null

# ---- 5. Website (HTTPS on all interfaces) ----------------------------------------------------------------------
[Environment]::SetEnvironmentVariable('OIC_HTTPS_PFX', $pfx, 'Process')
[Environment]::SetEnvironmentVariable('OIC_HTTPS_PASSPHRASE', $pass, 'Process')
Start-Process -FilePath 'node' -ArgumentList @('node_modules\vite\bin\vite.js', '--config', 'vite.lan.config.mjs', '--mode', 'api', '--port', '5173') `
    -WorkingDirectory "$repo\frontend" -WindowStyle Hidden -RedirectStandardOutput "$logs\vite-lan.log" -RedirectStandardError "$logs\vite-lan.err.log" | Out-Null

Start-Sleep -Seconds 12
Write-Host "`nLAN test mode started."
Write-Host "  This laptop:  https://localhost:5173"
foreach ($ip in $ips) { Write-Host "  Colleagues:   https://$($ip):5173" }
Write-Host "  First visit shows a certificate warning: Advanced -> Continue."
Write-Host "  Firewall: run scripts\lan\enable-lan-firewall.ps1 once as Administrator."
