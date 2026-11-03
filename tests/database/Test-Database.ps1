<#
.SYNOPSIS
    End-to-end test of the database migrations on a DISPOSABLE database:
      1. deploy all migrations to a new, uniquely named test database
      2. deploy again (must be a no-op: idempotent)
      3. run tests\database\assertions.sql (schema rules, procedures, permissions)
      4. tamper with an applied migration (the runner must refuse)
      5. drop the test database (always)
    Never touches OneInsureVideoMeetingDB itself.

.EXAMPLE
    powershell -File tests\database\Test-Database.ps1                       # LocalDB (default)
    powershell -File tests\database\Test-Database.ps1 -Server ".\SQLEXPRESS" # needs CREATE DATABASE permission
#>
[CmdletBinding()]
param([string] $Server = '(localdb)\MSSQLLocalDB')

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$deploy = Join-Path $root 'database\deploy-database.ps1'
$db = 'OneInsureVideoMeetingDB_Test_' + (Get-Date -Format 'yyyyMMddHHmmss')
$failures = New-Object System.Collections.Generic.List[string]
$tamperDir = Join-Path ([IO.Path]::GetTempPath()) ("oic-migrations-tamper-" + [guid]::NewGuid().ToString('N'))

function Step([string] $name, [scriptblock] $body) {
    try { & $body; Write-Host "PASS | $name" }
    catch { Write-Host "FAIL | $name | $($_.Exception.Message)"; $failures.Add($name) }
}

Write-Host "Test database: $db on $Server"
try {
    Step 'Deploy all migrations to an empty database' {
        $out = & $deploy -Server $Server -Database $db -CreateDatabase 6>&1 | Out-String
        if ($out -notmatch 'Done: (\d+) migration\(s\) applied, 0 already present') { throw $out }
    }
    Step 'Re-deploy is a no-op (idempotent)' {
        $out = & $deploy -Server $Server -Database $db 6>&1 | Out-String
        if ($out -notmatch 'Done: 0 migration\(s\) applied') { throw $out }
    }
    Step 'Schema assertions (assertions.sql)' {
        $out = & sqlcmd -S $Server -E -b -I -x -h -1 -W -d $db -i (Join-Path $PSScriptRoot 'assertions.sql') 2>&1
        $out | Where-Object { $_ -match '^(PASS|FAIL|RESULT)' } | ForEach-Object { Write-Host "       $_" }
        if ($LASTEXITCODE -ne 0) { throw (($out | Where-Object { $_ -notmatch '^PASS' }) -join "`n") }
    }
    Step 'Runner refuses an edited, already-applied migration' {
        New-Item -ItemType Directory $tamperDir | Out-Null
        Copy-Item (Join-Path $root 'database\migrations\*.sql') $tamperDir
        $target = Get-ChildItem $tamperDir -Filter 'V*.sql' | Sort-Object Name | Select-Object -Last 1
        Add-Content $target.FullName '-- tampered'
        $refused = $false
        try { & $deploy -Server $Server -Database $db -MigrationsPath $tamperDir 6>$null | Out-Null }
        catch { $refused = $_.Exception.Message -match 'was modified after it was applied' }
        if (-not $refused) { throw 'Tampered migration was not detected.' }
    }
}
finally {
    Remove-Item $tamperDir -Recurse -Force -ErrorAction SilentlyContinue
    if ($db -like 'OneInsureVideoMeetingDB_Test_*') {
        & sqlcmd -S $Server -E -b -Q "IF DB_ID(N'$db') IS NOT NULL BEGIN ALTER DATABASE [$db] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$db]; END" | Out-Null
        Write-Host "Dropped $db"
    }
}

if ($failures.Count) { Write-Host "DATABASE TESTS FAILED: $($failures -join '; ')"; exit 1 }
Write-Host 'DATABASE TESTS PASSED'
