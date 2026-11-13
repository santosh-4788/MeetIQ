<#
.SYNOPSIS
  READ-ONLY reconciliation of recording files on disk against rec.MeetingRecordings. Changes nothing (no rename, move, delete or update).

.DESCRIPTION
  Reports:
    1. COMPLETED rows whose MP4 is missing at its resolved path, or whose size / SHA-256 differs from the database.
    2. Library MP4 files (StorageRoot) that no row references (orphans) - e.g. a crash between the file move and the COMPLETED update.
    3. Leftover *.partial files (interrupted copies).
    4. Spool job folders <recording id without dashes>-<launch> whose recording is unknown, or already COMPLETED / PURGED (stale spool).
    5. Rows stuck in PENDING / RECORDING / PROCESSING / VERIFYING for longer than -StuckMinutes, with their job state.
  Ownership is never guessed: an orphan file carries no meeting id in its name (opaque key), so it is only REPORTED for a person to
  match from its MP4 metadata (the meeting code is written into the file's "comment"/"title" tag by the API) - use -ProbeOrphans.

.PARAMETER ConnectionStringFromService
  Read the connection string from the MeetIQApi Windows service environment (default). Otherwise pass -ConnectionString.
.EXAMPLE
  .\recording-reconciliation.ps1 -StorageRoot E:\Beeinsured.com\MeetIQ\deploy\data\recordings -SpoolRoot E:\Beeinsured.com\MeetIQ\deploy\data\spool -OutFile reconciliation.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $StorageRoot,
    [string] $SpoolRoot,
    [string] $ConnectionString,
    [string] $ServiceName = 'MeetIQApi',
    [int] $StuckMinutes = 60,
    [switch] $SkipHash,
    [switch] $ProbeOrphans,
    [string] $FfprobePath = 'C:\ffmpeg\bin\ffprobe.exe',
    [string] $OutFile
)
$ErrorActionPreference = 'Stop'

if (-not $ConnectionString) {
    $envs = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName").Environment
    $ConnectionString = ($envs | Where-Object { $_ -like 'ConnectionStrings__OneInsure=*' }) -replace '^ConnectionStrings__OneInsure=', ''
    if (-not $ConnectionString) { throw "No ConnectionStrings__OneInsure in the $ServiceName service environment; pass -ConnectionString." }
}

function Query([string] $sql) {
    $c = New-Object System.Data.SqlClient.SqlConnection($ConnectionString)
    $c.Open()
    try {
        $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 120
        $t = New-Object System.Data.DataTable
        $t.Load($cmd.ExecuteReader())
        return , $t
    } finally { $c.Close() }
}

$rows = Query @"
SELECT r.RecordingId, CONVERT(VARCHAR(36), r.PublicId) AS PublicId, r.[Status], r.StorageKey, r.StorageTier, r.ArchiveRoot, r.FileSizeBytes,
       CONVERT(VARCHAR(64), r.Sha256, 2) AS Sha256, m.MeetingCode, r.OwnerEmployeeId, r.CreatedUtc, r.ModifiedUtc, j.[State] AS JobState, j.LaunchCount
FROM rec.MeetingRecordings r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId LEFT JOIN rec.RecordingJobs j ON j.RecordingId = r.RecordingId
"@

$report = [ordered]@{ generatedUtc = (Get-Date).ToUniversalTime().ToString('o'); storageRoot = $StorageRoot; spoolRoot = $SpoolRoot; rows = $rows.Rows.Count
    completedOk = 0; completedProblems = @(); orphanFiles = @(); partialFiles = @(); staleSpool = @(); stuck = @() }

# 1. COMPLETED rows -> file present, size and hash match
$referenced = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($r in $rows.Rows) {
    if ($r.StorageKey -is [DBNull]) { continue }
    $root = if ($r.StorageTier -eq 'ARCHIVE' -and -not ($r.ArchiveRoot -is [DBNull])) { $r.ArchiveRoot } else { $StorageRoot }
    $file = Join-Path $root ($r.StorageKey -replace '/', '\')
    if ($root -eq $StorageRoot) { [void]$referenced.Add((Resolve-Path -LiteralPath $StorageRoot).Path.TrimEnd('\') + '\' + ($r.StorageKey -replace '/', '\')) }
    if ($r.Status -ne 'COMPLETED') { continue }
    $problem = $null
    if (-not (Test-Path -LiteralPath $file)) { $problem = 'file missing' }
    else {
        $len = (Get-Item -LiteralPath $file).Length
        if (-not ($r.FileSizeBytes -is [DBNull]) -and $len -ne [long]$r.FileSizeBytes) { $problem = "size $len <> database $($r.FileSizeBytes)" }
        elseif (-not $SkipHash -and -not ($r.Sha256 -is [DBNull])) {
            $h = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
            if ($h -ne $r.Sha256) { $problem = "SHA-256 mismatch" }
        }
    }
    if ($problem) { $report.completedProblems += [ordered]@{ recordingId = $r.RecordingId; publicId = $r.PublicId; meeting = $r.MeetingCode; file = $file; problem = $problem } }
    else { $report.completedOk++ }
}

# 2/3. Library files nobody references; leftover partial copies
if (Test-Path -LiteralPath $StorageRoot) {
    foreach ($f in Get-ChildItem -LiteralPath $StorageRoot -Recurse -File) {
        if ($f.Name -like '*.partial') { $report.partialFiles += [ordered]@{ file = $f.FullName; bytes = $f.Length; modified = $f.LastWriteTime.ToString('o') }; continue }
        if ($f.Extension -ne '.mp4') { continue }
        if ($referenced.Contains($f.FullName)) { continue }
        $o = [ordered]@{ file = $f.FullName; bytes = $f.Length; modified = $f.LastWriteTime.ToString('o'); meetingCodeFromMetadata = $null }
        if ($ProbeOrphans -and (Test-Path $FfprobePath)) {
            $tags = & $FfprobePath -v error -show_entries format_tags -of json $f.FullName | ConvertFrom-Json
            $o.meetingCodeFromMetadata = @($tags.format.tags.comment, $tags.format.tags.title) | Where-Object { $_ } | Select-Object -First 1
        }
        $report.orphanFiles += $o
    }
}

# 4. Spool folders
if ($SpoolRoot -and (Test-Path -LiteralPath $SpoolRoot)) {
    $byId = @{}; foreach ($r in $rows.Rows) { $byId[$r.PublicId.Replace('-', '').ToLowerInvariant()] = $r }
    foreach ($d in Get-ChildItem -LiteralPath $SpoolRoot -Directory) {
        if ($d.Name -notmatch '^([0-9a-f]{32})-(\d+)$') { continue }
        $r = $byId[$Matches[1]]
        $why = if (-not $r) { 'unknown recording' } elseif ($r.Status -in 'COMPLETED', 'PURGED') { "recording already $($r.Status)" } else { $null }
        if ($why) { $report.staleSpool += [ordered]@{ folder = $d.FullName; reason = $why; bytes = (Get-ChildItem -LiteralPath $d.FullName -Recurse -File | Measure-Object Length -Sum).Sum } }
    }
}

# 5. Stuck rows
$cut = (Get-Date).ToUniversalTime().AddMinutes(-$StuckMinutes)
foreach ($r in $rows.Rows) {
    if ($r.Status -notin 'PENDING', 'RECORDING', 'PROCESSING', 'VERIFYING') { continue }
    $last = if ($r.ModifiedUtc -is [DBNull]) { $r.CreatedUtc } else { $r.ModifiedUtc }
    if ($last -lt $cut) { $report.stuck += [ordered]@{ recordingId = $r.RecordingId; publicId = $r.PublicId; status = $r.Status; jobState = "$($r.JobState)"; lastChangeUtc = ([datetime]$last).ToString('o') } }
}

$summary = "Rows $($report.rows); COMPLETED verified $($report.completedOk); COMPLETED with problems $($report.completedProblems.Count); orphan MP4 $($report.orphanFiles.Count); partial $($report.partialFiles.Count); stale spool $($report.staleSpool.Count); stuck $($report.stuck.Count)"
$report.summary = $summary
if ($OutFile) { $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $OutFile }
$summary
if ($report.completedProblems.Count) { "COMPLETED problems:"; $report.completedProblems | ForEach-Object { "  #$($_.recordingId) $($_.meeting): $($_.problem) ($($_.file))" } }
if ($report.orphanFiles.Count) { "Orphan files (not referenced by any row - NOT matched automatically):"; $report.orphanFiles | ForEach-Object { "  $($_.file) ($([math]::Round($_.bytes / 1MB, 1)) MB) meeting tag: $($_.meetingCodeFromMetadata)" } }
if ($report.stuck.Count) { "Stuck:"; $report.stuck | ForEach-Object { "  #$($_.recordingId) $($_.status) / job $($_.jobState) since $($_.lastChangeUtc)" } }
