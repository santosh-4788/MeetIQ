<#
.SYNOPSIS
    Recreates the LOCAL E2E database (LocalDB only), creates the first SuperAdmin and seeds the test data.

    Full reset:   .\reset-db.ps1                 (drop, migrate V001..V011, setup-admin, node seed.mjs, backup)
    Fast reset:   .\reset-db.ps1 -FromBackup     (restore the backup taken after the last full reset)

    The seed creates meetings relative to "now", so take a full reset when the backup is older than a few hours.
    Stop the E2E API first (or restart it afterwards): dropping the database breaks its pooled connections.
#>
[CmdletBinding()]
param(
    [string] $Database = 'OneInsureVideoMeetingDB_E2E',
    [switch] $FromBackup
)
$ErrorActionPreference = 'Stop'
if ($Database -notmatch '_E2E$') { throw 'Only databases whose name ends in _E2E can be reset.' }
$server = '(localdb)\MSSQLLocalDB'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$e2e = Join-Path $root 'tests\e2e'
$backup = Join-Path $e2e "results\$Database.bak"
$env:OIC_ADMIN_PASSWORD = 'E2e!Strong#Pass2026'   # local test database only

function Sql([string] $q) {
    & sqlcmd -S $server -E -b -Q $q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $q" }
}

$drop = "IF DB_ID('$Database') IS NOT NULL BEGIN ALTER DATABASE [$Database] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$Database]; END"
if ($FromBackup) {
    if (-not (Test-Path $backup)) { throw "No backup at $backup. Run a full reset first." }
    Sql "IF DB_ID('$Database') IS NOT NULL ALTER DATABASE [$Database] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; RESTORE DATABASE [$Database] FROM DISK = N'$backup' WITH REPLACE; ALTER DATABASE [$Database] SET MULTI_USER;"
    Write-Host "Restored $Database from $backup"
    return
}

Sql $drop
& (Join-Path $root 'database\deploy-database.ps1') -Server $server -Database $Database -CreateDatabase
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'start-api.ps1') -Database $Database -SetupAdmin
if ($LASTEXITCODE -ne 0) { throw 'setup-admin failed' }
Push-Location $e2e
try { & node seed.mjs; if ($LASTEXITCODE -ne 0) { throw 'seed failed' } } finally { Pop-Location }
New-Item -ItemType Directory -Force (Split-Path $backup) | Out-Null
Sql "BACKUP DATABASE [$Database] TO DISK = N'$backup' WITH INIT, COPY_ONLY"
Write-Host "Seeded and backed up to $backup"
