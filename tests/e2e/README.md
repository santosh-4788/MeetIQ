# OneInsure Connect — browser E2E tests

Real click-through tests of every implemented screen, driven in **Microsoft Edge (headless)** through `playwright-core`
against an **isolated** environment:

| Piece | Isolated instance | Never touched |
|---|---|---|
| Database | `OneInsureVideoMeetingDB_E2E` on `(localdb)\MSSQLLocalDB` | shared SQL Servers, the developer DB, user secrets |
| API | Debug build on `https://localhost:7190`, `Email__Enabled=false` | developer API on 7180 |
| Web | Vite dev server on `http://127.0.0.1:5174` (proxy → 7190) | developer Vite on 5173 |

E-mail is disabled: messages stay in `app.EmailOutbox` of the E2E database (the tests read reset links and join links from there).

## Layout

```
tests/e2e/
  run.mjs                 runner: runs scenarios/*.mjs in order, writes results/results.json + results-summary.md
  seed.mjs                seed data through the API (+ SQL for states the API cannot create, e.g. past meetings)
  lib/                    config, api client, sqlcmd access, TOTP (RFC 6238), browser helpers, test-case recorder
  scenarios/01-auth … 11-errors.mjs
  scripts/start-api.ps1   starts the isolated API (or runs setup-admin with -SetupAdmin)
  scripts/reset-db.ps1    drop + migrate + setup-admin + seed + backup (or -FromBackup for a fast restore)
  report.mjs              per-module Markdown tables for documentation/LOCALHOST_TEST_REPORT.md (node report.mjs)
  results/                results JSON/summary, screenshots of failures, run logs (generated)
  room/                   Phase 4 video-room test (separate harness, maintained with the room module; not run by run.mjs)
```

Each test case records: id, module, role, steps, expected, actual, PASS/FAIL and a screenshot path on failure.
A case also fails when the page throws an uncaught error or an `/api/v1` call answers HTTP 5xx during the case.

## Prerequisites

- Node.js 22+, SQL Server LocalDB + `sqlcmd`, Microsoft Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- .NET 10 runtime at `%USERPROFILE%\.dotnet\dotnet.exe` (the `dotnet` on PATH may be an older SDK)
- `cd "E:\OneInsure Connect\tests\e2e"; npm install` (only dependency: `playwright-core@1.64.1`; no browser download)

## Run (PowerShell)

```powershell
# 1. Build the API (Debug: the Release binaries may be locked by the developer API)
cd "E:\OneInsure Connect\backend"
& "$env:USERPROFILE\.dotnet\dotnet.exe" build -c Debug

# 2. Start the isolated API (keep this window open) - https://localhost:7190, LocalDB *_E2E, e-mail off
powershell -NoProfile -File "E:\OneInsure Connect\tests\e2e\scripts\start-api.ps1"

# 3. In a second window: Vite dev server on 5174 pointed at 7190 (call vite directly: PowerShell drops "--" for npm run)
cd "E:\OneInsure Connect\frontend"
$env:OIC_API_TARGET = "https://localhost:7190"
node node_modules\vite\bin\vite.js --mode api --host 127.0.0.1 --port 5174 --strictPort

# 4. In a third window: create + seed the database, then run all scenarios
cd "E:\OneInsure Connect\tests\e2e"
powershell -NoProfile -File scripts\reset-db.ps1          # drop/migrate/setup-admin/seed, then backs up to results\
node run.mjs                                              # all scenarios (~20 min)
```

Useful variants:

```powershell
powershell -NoProfile -File scripts\reset-db.ps1 -FromBackup   # restore the seeded state (fast) before re-running a scenario
node run.mjs 07-meetings                                       # one scenario file (name filter)
$env:E2E_ONLY = 'MTG-0[1-3]'; node run.mjs 07-meetings; $env:E2E_ONLY = ''   # selected case ids
$env:E2E_HEADED = '1'; node run.mjs 02-navigation                              # watch the browser

# Report: keep the full run, merge re-runs of single scenarios, regenerate the tables in documentation\LOCALHOST_TEST_REPORT.md
Copy-Item results\results.json results\results-fullrun.json
node run.mjs 06-settings                                   # writes results\results-06-settings.json
node scripts\merge-reruns.mjs 06-settings                  # -> results\results.json (failures of the full run stay visible)
node report.mjs | Out-File -Encoding utf8 results\report-tables.md
node scripts\insert-tables.mjs
```

Notes:

- Scenarios are written for a **freshly seeded** database in order 01 → 11 (later scenarios rely on earlier state only
  where noted; each scenario also runs on its own after `reset-db.ps1 -FromBackup`). The seed creates meetings relative
  to "now": take a full reset when the backup is older than a few hours.
- `11-errors` stops **only** the E2E API process (`bin\Debug\net10.0\OneInsure.Connect.Api.dll`) and restarts it with
  `scripts\start-api.ps1` (log in `results\api-restart.log`). Stop that restarted API yourself when you are done
  (`Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" | ? CommandLine -match 'bin\\Debug' | % { Stop-Process -Id $_.ProcessId }`).
- Test accounts use the password `E2e!Strong#Pass2026` and exist only in the local `_E2E` database.
- The suite never sends e-mail and never connects to a shared database: `lib/config.mjs` refuses database names that do not
  end in `_E2E` and the ports 7180/5173.
