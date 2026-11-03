# Starts LiveKit locally for development / the R2 recorder PoC (loopback only).
#
# Webhooks (Phase 4): LiveKit posts signed room events (participant joined/left, room finished) to the API's
# development webhook listener, plain http on loopback (the API's LiveKit:WebhookListenUrl, default http://127.0.0.1:5080).
# The webhook block needs the API key NAME (never the secret), which lives only in the git-ignored config/dev.local.env,
# so it is appended to livekit.dev.yaml here at start-up and handed to LiveKit through LIVEKIT_CONFIG (process
# environment only, nothing is written to disk).
#
#   .\start-dev.ps1                                       # webhooks to http://127.0.0.1:5080/api/v1/webhooks/livekit
#   .\start-dev.ps1 -WebhookUrls http://127.0.0.1:5080/api/v1/webhooks/livekit, http://127.0.0.1:5091/api/v1/webhooks/livekit
#   .\start-dev.ps1 -NoWebhooks
#
# LIVEKIT_WEBHOOK_URLS (comma-separated) in dev.local.env overrides the default list.
[CmdletBinding()]
param(
    [string[]] $WebhookUrls,
    [switch] $NoWebhooks,
    # LAN test mode: announce these private addresses for media (ICE), e.g. -LanIps 192.168.2.77,192.168.0.44.
    # Signalling stays on loopback; browsers reach it through the site (/rtc is forwarded by the dev server).
    [string[]] $LanIps
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$envFile = Join-Path $root 'config\dev.local.env'
if (-not (Test-Path $envFile)) { throw "Missing $envFile. Create it with LIVEKIT_KEYS=<key>: <secret> (never commit it)." }
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}

$yaml = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'config\livekit.dev.yaml')
if ($LanIps) {
    $LanIps = @($LanIps | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($ip in $LanIps) {
        # Private IPv4 only: LAN test mode never announces public addresses.
        if ($ip -notmatch '^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$') { throw "Not a private IPv4 address: $ip" }
    }
    $yaml = $yaml.Replace('node_ip: 127.0.0.1', "node_ip: $($LanIps[0])")
    $includes = (@($LanIps | ForEach-Object { "      - $_/32" }) + '      - 127.0.0.1/32') -join "`n"
    $yaml = $yaml.Replace('      - 127.0.0.1/32', $includes)
    Write-Host "LiveKit LAN mode: media announced on $($LanIps -join ', ') (+ loopback)"
}
if (-not $NoWebhooks) {
    if (-not $env:LIVEKIT_API_KEY) { throw "LIVEKIT_API_KEY is missing in $envFile (needed to sign webhooks)." }
    if (-not $WebhookUrls) {
        $WebhookUrls = if ($env:LIVEKIT_WEBHOOK_URLS) { $env:LIVEKIT_WEBHOOK_URLS -split ',' } else { @('http://127.0.0.1:5080/api/v1/webhooks/livekit') }
    }
    # "-File ... -WebhookUrls a,b" arrives as one string: split on commas too.
    $WebhookUrls = @($WebhookUrls | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($u in $WebhookUrls) {
        # Development webhooks stay on this machine.
        if ($u -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\]):\d+/') { throw "Webhook URL must be http on loopback: $u" }
    }
    $yaml += "`nwebhook:`n  api_key: $($env:LIVEKIT_API_KEY)`n  urls:`n" + (($WebhookUrls | ForEach-Object { "    - $_" }) -join "`n") + "`n"
    Write-Host "LiveKit webhooks -> $($WebhookUrls -join ', ')"
}
$env:LIVEKIT_CONFIG = $yaml
& (Join-Path $root 'bin\livekit-server.exe')
