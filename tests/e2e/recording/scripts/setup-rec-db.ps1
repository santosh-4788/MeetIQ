<#
.SYNOPSIS
    (Re)creates the LOCAL database for the recording browser test: OneInsureVideoMeetingDB_Rec on (localdb)\MSSQLLocalDB.
    Drop → migrations V001..V012 (database\deploy-database.ps1 -CreateDatabase) → first SuperAdmin (setup-admin) →
    two employees with user accounts (same test password). Stop the recording test API first (or restart it afterwards).
#>
[CmdletBinding()]
param([string] $Database = 'OneInsureVideoMeetingDB_Rec')
$ErrorActionPreference = 'Stop'
if ($Database -notmatch '_Rec$') { throw 'Only databases whose name ends in _Rec can be reset here.' }
$server = '(localdb)\MSSQLLocalDB'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$env:OIC_ADMIN_PASSWORD = 'Rec!Strong#Pass2026'   # local test database only

function Sql([string] $q, [string] $db = 'master') {
    & sqlcmd -S $server -d $db -E -b -I -Q $q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $q" }
}

Sql "IF DB_ID('$Database') IS NOT NULL BEGIN ALTER DATABASE [$Database] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$Database]; END"
& (Join-Path $root 'database\deploy-database.ps1') -Server $server -Database $Database -CreateDatabase
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'start-rec-api.ps1') -Database $Database -SetupAdmin
if ($LASTEXITCODE -ne 0) { throw 'setup-admin failed' }

Sql @"
SET NOCOUNT ON;
INSERT org.Departments (Code, Name) VALUES ('OPS', N'Operations');
INSERT org.Designations (Code, Name) VALUES ('EXE', N'Executive');
INSERT org.Employees (EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
SELECT v.Code, v.FirstName, v.LastName, v.DisplayName, v.Email, (SELECT DepartmentId FROM org.Departments WHERE Code = 'OPS'), (SELECT DesignationId FROM org.Designations WHERE Code = 'EXE')
FROM (VALUES ('RC-0001', N'Rekha', N'Host', N'Rekha Host', N'rekha.host@rec.oneinsure.test'),
             ('RC-0002', N'Ravi', N'Employee', N'Ravi Employee', N'ravi.employee@rec.oneinsure.test')) v (Code, FirstName, LastName, DisplayName, Email);
INSERT auth.Users (Email, PasswordHash, PasswordChangedUtc, EmployeeId)
SELECT e.OfficialEmail, (SELECT PasswordHash FROM auth.Users WHERE Email = N'superadmin@rec.oneinsure.test'), SYSUTCDATETIME(), e.EmployeeId
FROM org.Employees e WHERE e.EmployeeCode IN ('RC-0001', 'RC-0002');
INSERT auth.UserRoles (UserId, RoleId)
SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = 'Employee'
WHERE u.Email IN (N'rekha.host@rec.oneinsure.test', N'ravi.employee@rec.oneinsure.test');
"@ $Database
Write-Host "Database $Database ready (SuperAdmin + Rekha Host + Ravi Employee, password in this script)."
