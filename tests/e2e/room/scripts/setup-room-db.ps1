<#
.SYNOPSIS
    (Re)creates the LOCAL database for the video-room browser test: OneInsureVideoMeetingDB_Room on (localdb)\MSSQLLocalDB.
    Drop → migrations V001..V0xx (database\deploy-database.ps1 -CreateDatabase) → first SuperAdmin (setup-admin) →
    two employees with user accounts (same test password). Stop the room API first (or restart it afterwards).
#>
[CmdletBinding()]
param([string] $Database = 'OneInsureVideoMeetingDB_Room')
$ErrorActionPreference = 'Stop'
if ($Database -notmatch '_Room$') { throw 'Only databases whose name ends in _Room can be reset here.' }
$server = '(localdb)\MSSQLLocalDB'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$env:OIC_ADMIN_PASSWORD = 'Room!Strong#Pass2026'   # local test database only

function Sql([string] $q, [string] $db = 'master') {
    & sqlcmd -S $server -d $db -E -b -I -Q $q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sqlcmd failed: $q" }
}

Sql "IF DB_ID('$Database') IS NOT NULL BEGIN ALTER DATABASE [$Database] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$Database]; END"
& (Join-Path $root 'database\deploy-database.ps1') -Server $server -Database $Database -CreateDatabase
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'start-room-api.ps1') -Database $Database -SetupAdmin
if ($LASTEXITCODE -ne 0) { throw 'setup-admin failed' }

Sql @"
SET NOCOUNT ON;
INSERT org.Departments (Code, Name) VALUES ('OPS', N'Operations');
INSERT org.Designations (Code, Name) VALUES ('EXE', N'Executive');
INSERT org.Employees (EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
SELECT v.Code, v.FirstName, v.LastName, v.DisplayName, v.Email, (SELECT DepartmentId FROM org.Departments WHERE Code = 'OPS'), (SELECT DesignationId FROM org.Designations WHERE Code = 'EXE')
FROM (VALUES ('RM-0001', N'Hema', N'Host', N'Hema Host', N'hema.host@room.oneinsure.test'),
             ('RM-0002', N'Esha', N'Employee', N'Esha Employee', N'esha.employee@room.oneinsure.test')) v (Code, FirstName, LastName, DisplayName, Email);
INSERT auth.Users (Email, PasswordHash, PasswordChangedUtc, EmployeeId)
SELECT e.OfficialEmail, (SELECT PasswordHash FROM auth.Users WHERE Email = N'superadmin@room.oneinsure.test'), SYSUTCDATETIME(), e.EmployeeId
FROM org.Employees e WHERE e.EmployeeCode IN ('RM-0001', 'RM-0002');
INSERT auth.UserRoles (UserId, RoleId)
SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = 'Employee'
WHERE u.Email IN (N'hema.host@room.oneinsure.test', N'esha.employee@room.oneinsure.test');
"@ $Database
Write-Host "Database $Database ready (SuperAdmin + Hema Host + Esha Employee, password in this script)."
