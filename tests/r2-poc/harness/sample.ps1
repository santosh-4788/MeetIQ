# Samples CPU time and memory of R2 PoC processes every IntervalMs until StopFile exists.
# Roles: a browser's main process is identified by its profile dir ("oic-rec-" = recorder,
# "oic-part-" = synthetic participants). Chromium renderer/GPU/utility children do not always carry
# that path, so every DESCENDANT inherits the role of its root.
param([Parameter(Mandatory)][string]$OutFile, [Parameter(Mandatory)][string]$StopFile, [int]$IntervalMs = 2000)
$ErrorActionPreference = 'SilentlyContinue'
"ts,role,pid,cpuSec,wsMB,privMB" | Out-File -FilePath $OutFile -Encoding ascii
while (-not (Test-Path $StopFile)) {
    $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $all = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='OneInsure.Connect.Recorder.exe' OR Name='ffmpeg.exe' OR Name='livekit-server.exe'"
    $role = @{}
    foreach ($p in $all) {
        $cl = [string]$p.CommandLine
        switch -Wildcard ($p.Name) {
            'OneInsure.Connect.Recorder.exe' { $role[$p.ProcessId] = 'recorder-host' }
            'ffmpeg.exe' { $role[$p.ProcessId] = 'ffmpeg' }
            'livekit-server.exe' { $role[$p.ProcessId] = 'livekit' }
            default {
                if ($cl -like '*oic-rec-*') { $role[$p.ProcessId] = 'recorder-browser' }
                elseif ($cl -like '*oic-part-*') { $role[$p.ProcessId] = 'participant-browser' }
            }
        }
    }
    # Propagate roles to descendants (a few passes cover Chromium's process depth).
    for ($pass = 0; $pass -lt 4; $pass++) {
        foreach ($p in $all) {
            if (-not $role.ContainsKey($p.ProcessId) -and $role.ContainsKey($p.ParentProcessId)) {
                $r = $role[$p.ParentProcessId]
                if ($r -like '*-browser') { $role[$p.ProcessId] = $r }
            }
        }
    }
    $lines = foreach ($id in $role.Keys) {
        $gp = Get-Process -Id $id
        if ($gp) { "{0},{1},{2},{3:F3},{4:F1},{5:F1}" -f $ts, $role[$id], $id, $gp.TotalProcessorTime.TotalSeconds, ($gp.WorkingSet64 / 1MB), ($gp.PrivateMemorySize64 / 1MB) }
    }
    if ($lines) { $lines | Out-File -FilePath $OutFile -Append -Encoding ascii }
    Start-Sleep -Milliseconds $IntervalMs
}
