<#
.SYNOPSIS
    Applies OneInsureVideoMeetingDB migrations (database\migrations\V###__name.sql) in order.

.DESCRIPTION
    - Windows authentication only (no SQL passwords on the command line or in files).
    - Each migration runs in one transaction together with its history row in dbo.SchemaMigrations.
    - Already-applied migrations are skipped; if an applied file was edited afterwards, the run stops
      (never edit an applied migration: add a new one).
    - The database is created only with -CreateDatabase.

.EXAMPLE
    # Developer PC (LocalDB):
    .\deploy-database.ps1 -Server "(localdb)\MSSQLLocalDB" -CreateDatabase
.EXAMPLE
    # Server, run by a DBA/deployment account that holds oic_migrator_role or db_owner:
    .\deploy-database.ps1 -Server "SQLHOST\INSTANCE" -Encrypt
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Server,
    [string] $Database = 'OneInsureVideoMeetingDB',
    [string] $MigrationsPath,
    [switch] $CreateDatabase,
    # Encrypt the connection (use on servers; the certificate must be trusted).
    [switch] $Encrypt,
    # Dev only: trust a self-signed server certificate.
    [switch] $TrustServerCertificate,
    # SQL authentication login. The password is read ONLY from $env:SQLCMDPASSWORD (never a parameter or file).
    # Omit to use Windows authentication (preferred).
    [string] $SqlLogin,
    # Read-only: report what would be created/applied, change nothing.
    [switch] $Plan
)

$ErrorActionPreference = 'Stop'
# Resolved here, not as a parameter default: Windows PowerShell 5.1 leaves $PSScriptRoot empty there under -File.
if (-not $MigrationsPath) { $MigrationsPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'migrations' }
if ($Database -notmatch '^[A-Za-z][A-Za-z0-9_]{0,99}$') { throw "Invalid database name '$Database'." }

$sqlcmd = (Get-Command sqlcmd -ErrorAction Stop).Source
if ($SqlLogin -and -not $env:SQLCMDPASSWORD) { throw 'With -SqlLogin, set $env:SQLCMDPASSWORD in this session (do not pass passwords as parameters).' }

function Invoke-Sql {
    param([string] $Db, [string] $Query, [string] $File)
    $auth = if ($SqlLogin) { @('-U', $SqlLogin) } else { @('-E') }
    $sqlArgs = @('-S', $Server) + $auth + @('-b', '-I', '-x', '-h', '-1', '-W')
    if ($Db) { $sqlArgs += @('-d', $Db) }  # no -d: server-level statement in the login's default database context (never master)
    if ($Encrypt) { $sqlArgs += '-N' }
    if ($TrustServerCertificate) { $sqlArgs += '-C' }
    if ($File) { $sqlArgs += @('-i', $File) } else { $sqlArgs += @('-Q', "SET NOCOUNT ON; $Query") }
    $out = & $sqlcmd @sqlArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed ($LASTEXITCODE) on ${Db}:`n$($out -join "`n")" }
    return $out
}

$scripts = Get-ChildItem $MigrationsPath -Filter 'V*.sql' | Where-Object Name -match '^V\d{3}__[A-Za-z0-9_]+\.sql$' | Sort-Object Name
if (-not $scripts) { throw "No migrations found in $MigrationsPath." }

# 1. Database
$exists = (Invoke-Sql -Query "SELECT CASE WHEN DB_ID(N'$Database') IS NULL THEN 0 ELSE 1 END;" | Select-Object -First 1).Trim()

if ($Plan) {
    $done = @{}
    if ($exists -eq '1') {
        $hasHistory = (Invoke-Sql -Db $Database -Query "SELECT CASE WHEN OBJECT_ID(N'dbo.SchemaMigrations', N'U') IS NULL THEN 0 ELSE 1 END;" | Select-Object -First 1).Trim()
        if ($hasHistory -eq '1') {
            foreach ($line in (Invoke-Sql -Db $Database -Query "SELECT ScriptName + '|' + Sha256 FROM dbo.SchemaMigrations;")) {
                if ($line -match '^(.+)\|([0-9A-F]{64})$') { $done[$Matches[1]] = $Matches[2] }
            }
        }
    }
    Write-Host "PLAN (read-only, nothing changed) for $Database on $Server"
    Write-Host ("  Database: " + $(if ($exists -eq '1') { 'exists' } else { 'MISSING -> would be created (needs -CreateDatabase), READ_COMMITTED_SNAPSHOT ON' }))
    foreach ($s in $scripts) {
        $hash = (Get-FileHash $s.FullName -Algorithm SHA256).Hash
        $state = if (-not $done.ContainsKey($s.Name)) { 'would apply' } elseif ($done[$s.Name] -eq $hash) { 'already applied' } else { 'MODIFIED after apply -> run would stop' }
        Write-Host "  $($s.Name)  $state"
    }
    return
}

if ($exists -eq '0') {
    if (-not $CreateDatabase) { throw "Database $Database does not exist on $Server. Re-run with -CreateDatabase." }
    Write-Host "Creating database $Database on $Server"
    Invoke-Sql -Query "CREATE DATABASE [$Database]; ALTER DATABASE [$Database] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;" | Out-Null
}

# 2. Migration history
Invoke-Sql -Db $Database -Query @"
IF OBJECT_ID(N'dbo.SchemaMigrations', N'U') IS NULL
CREATE TABLE dbo.SchemaMigrations (
    ScriptName  VARCHAR(200)  NOT NULL CONSTRAINT PK_SchemaMigrations PRIMARY KEY,
    Sha256      CHAR(64)      NOT NULL,
    AppliedUtc  DATETIME2(3)  NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedUtc DEFAULT (SYSUTCDATETIME()),
    AppliedBy   NVARCHAR(128) NOT NULL CONSTRAINT DF_SchemaMigrations_AppliedBy DEFAULT (SUSER_SNAME())
);
"@ | Out-Null

$applied = @{}
foreach ($line in (Invoke-Sql -Db $Database -Query "SELECT ScriptName + '|' + Sha256 FROM dbo.SchemaMigrations;")) {
    if ($line -match '^(.+)\|([0-9A-F]{64})$') { $applied[$Matches[1]] = $Matches[2] }
}

# 3. Apply pending migrations in order
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oic-migrate-" + [guid]::NewGuid().ToString('N') + '.sql')
$count = 0
try {
    foreach ($s in $scripts) {
        $hash = (Get-FileHash $s.FullName -Algorithm SHA256).Hash
        if ($applied.ContainsKey($s.Name)) {
            if ($applied[$s.Name] -ne $hash) { throw "$($s.Name) was modified after it was applied (recorded $($applied[$s.Name]), now $hash). Add a new migration instead." }
            continue
        }
        Write-Host "Applying $($s.Name)"
        $body = Get-Content $s.FullName -Raw -Encoding UTF8
        $wrapped = @"
SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;
GO
$body
GO
INSERT dbo.SchemaMigrations (ScriptName, Sha256) VALUES ('$($s.Name)', '$hash');
COMMIT TRANSACTION;
GO
"@
        [IO.File]::WriteAllText($tmp, $wrapped, (New-Object Text.UTF8Encoding $false))
        Invoke-Sql -Db $Database -File $tmp | Out-Null
        $count++
    }
}
finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
}
Write-Host "Done: $count migration(s) applied, $($scripts.Count - $count) already present. Database: $Database on $Server"
