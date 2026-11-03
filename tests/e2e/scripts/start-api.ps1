<#
.SYNOPSIS
    Starts an ISOLATED OneInsure Connect API instance for the E2E suite.

    - Database: local LocalDB database OneInsureVideoMeetingDB_E2E only (never a shared server).
    - E-mail: disabled (messages stay in app.EmailOutbox of the E2E database).
    - Port: https://localhost:7190 (the developer API on 7180 is not touched).
    - Runs the Debug build with the per-user .NET 10 runtime.

    Pass -SetupAdmin to run the one-off "setup-admin" command instead of the web server.
#>
[CmdletBinding()]
param(
    [string] $Database = 'OneInsureVideoMeetingDB_E2E',
    [int] $Port = 7190,
    [int] $WebPort = 5174,
    [switch] $SetupAdmin,
    [string] $AdminEmail = 'superadmin@e2e.oneinsure.test'
)
$ErrorActionPreference = 'Stop'
if ($Database -notmatch '_E2E$') { throw 'The E2E API only runs against a database whose name ends in _E2E.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$apiDir = Join-Path $root 'backend\src\OneInsure.Connect.Api'
$dll = Join-Path $apiDir 'bin\Debug\net10.0\OneInsure.Connect.Api.dll'
$dotnet = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
if (-not (Test-Path $dll)) { throw "Debug build not found: $dll. Run: & `"$dotnet`" build -c Debug (in backend)." }

$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ASPNETCORE_URLS = "https://localhost:$Port"
$env:ConnectionStrings__OneInsure = "Server=(localdb)\MSSQLLocalDB;Database=$Database;Integrated Security=true;TrustServerCertificate=true"
$env:Email__Enabled = 'false'
$env:Email__Procedure = 'dbo.E2E_EmailDisabled'
$env:Email__RedirectAllTo = 'nobody@e2e.oneinsure.test'
$env:Security__LoginPermitPerMinute = '1000'
$env:Security__PasswordResetPermitPer5Minutes = '1000'
$env:Security__AllowedOrigins__0 = "http://localhost:$WebPort"
$env:Security__AllowedOrigins__1 = "http://127.0.0.1:$WebPort"
$env:PublicEndpoints__WebBaseUrl = "http://localhost:$WebPort"
# Reminders poll faster so the reminder test does not wait long.
$env:Reminders__PollSeconds = '5'

Set-Location $apiDir
if ($SetupAdmin) {
    if (-not $env:OIC_ADMIN_PASSWORD) { throw 'Set $env:OIC_ADMIN_PASSWORD first.' }
    & $dotnet $dll setup-admin --email $AdminEmail --employee-code E2E-0001
    exit $LASTEXITCODE
}
& $dotnet $dll
