<#
.SYNOPSIS
    Leaves LAN test mode: restarts LiveKit, the API and the website in the normal localhost-only configuration.
    (Firewall rules stay until you run disable-lan-firewall.ps1 as Administrator.)
#>
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$logs = Join-Path $repo 'logs'
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'livekit-server.exe' -and $_.ExecutablePath -like "$repo\video-server\*") -or
    ($_.Name -eq 'dotnet.exe' -and $_.CommandLine -like '*bin\Release\net10.0\OneInsure.Connect.Api.dll*') -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'vite' -and ($_.CommandLine -match 'vite\.lan\.config' -or ($_.CommandLine -like "*$repo\frontend*" -and $_.CommandLine -match '--port 5173')))
} | ForEach-Object { Write-Host "Stopping $($_.Name) ($($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$repo\video-server\start-dev.ps1`"") `
    -WindowStyle Hidden -RedirectStandardOutput "$logs\livekit.log" -RedirectStandardError "$logs\livekit.err.log" | Out-Null
[Environment]::SetEnvironmentVariable('ASPNETCORE_ENVIRONMENT', 'Development', 'Process')
[Environment]::SetEnvironmentVariable('ASPNETCORE_URLS', 'https://localhost:7180', 'Process')
[Environment]::SetEnvironmentVariable('DOTNET_ROOT', (Join-Path $env:USERPROFILE '.dotnet'), 'Process')
Start-Process -FilePath (Join-Path $env:USERPROFILE '.dotnet\dotnet.exe') -ArgumentList 'bin\Release\net10.0\OneInsure.Connect.Api.dll' `
    -WorkingDirectory "$repo\backend\src\OneInsure.Connect.Api" -WindowStyle Hidden -RedirectStandardOutput "$logs\api-dev.log" -RedirectStandardError "$logs\api-dev.err.log" | Out-Null
Start-Process -FilePath 'node' -ArgumentList @('node_modules\vite\bin\vite.js', '--mode', 'api', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
    -WorkingDirectory "$repo\frontend" -WindowStyle Hidden -RedirectStandardOutput "$logs\vite.log" -RedirectStandardError "$logs\vite.err.log" | Out-Null
Start-Sleep -Seconds 10
Write-Host 'Back to localhost-only mode: http://localhost:5173'
