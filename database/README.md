# OneInsureVideoMeetingDB: migrations

These scripts implement [documentation/DATABASE_DESIGN.md](../documentation/DATABASE_DESIGN.md) (rev 1.1). The result is 35 tables in the `auth`, `org`, `crm`, `mtg`, `rec` and `app` schemas, plus 2 views, 5 procedures, 1 table type and 2 database roles (V001–V010); V011–V012 add Phase 3 and recording-management objects. V013 adds instant meetings and shareable links. Applied to `Oneinsure_v`: V001–V013 (verified 2 Nov 2026).

| Script | Content |
|---|---|
| V001 | Schemas |
| V002 | `org`: departments, designations, branches, employees, teams |
| V003 | `auth`: users, roles, permissions, sessions, MFA, reset tokens, login attempts |
| V004 | `crm`: customers |
| V005 | `mtg`: meetings, participants, invitations, reminders, notifications, attendance, consent, waiting room, chat, availability |
| V006 | `rec`: recordings, recording jobs, access log |
| V007 | `app`: settings, e-mail outbox and delivery log, background job log, webhooks, audit log |
| V008 | Views; availability check, booking lock, queue-claim procedures |
| V009 | Database roles and permissions (append-only tables are protected with `DENY`) |
| V010 | Reference data: roles, permissions, two settings. **No users or credentials** |
| V011 | Phase 3: `RESPONSE` notification type; PublicId on notifications and availability |
| V012 | Recording management: `rec.RecordingPolicies` (4 configurable policies, placeholder values, never approved by default), `rec.RecordingPolicyCategories` (category → policy mapping), `rec.RecordingDeletions` (dual-approval deletion), recording/job columns for policy snapshot, storage tier, retention and crash recovery; permission `recordings.policy.manage` (SuperAdmin) |
| V013 | Instant meetings and shareable links: `Meetings.MeetingKind` (SCHEDULED/INSTANT), `Meetings.IsAudioOnly`; `MeetingParticipants.JoinSource` (INVITED/LINK), `AdmissionRequired`, `IsBlocked` (+ when/by whom); `mtg.MeetingLinks` (hashed token, encrypted copy, expiry, revocation, one active link per meeting) |

## Rules

- **Never edit a migration after it has been applied anywhere.** Add `V011__…sql` instead. The runner stores each script's SHA-256 in `dbo.SchemaMigrations` and refuses to run if an applied file has changed.
- Each script runs in a single transaction together with its history row, so a failed script leaves nothing behind.
- Do not put `$(…)` in scripts, because sqlcmd variable substitution is disabled (`-x`).

## Run

```powershell
# Developer PC (LocalDB: the Windows user owns the instance)
.\database\deploy-database.ps1 -Server "(localdb)\MSSQLLocalDB" -CreateDatabase

# Tests: create a disposable OneInsureVideoMeetingDB_Test_* database, run assertions, then drop it
powershell -File tests\database\Test-Database.ps1
```

On `.\SQLEXPRESS` on the developer PC, the current Windows login (`ROBIN\106433`) has **no CREATE DATABASE permission** (verified 31 Oct 2026). A local administrator must grant `dbcreator`, or create the empty database and make that login `db_owner`. Until then, use LocalDB.

## Server deployment (Windows Server, SQL Server 2019+)

1. A DBA creates the empty database, or runs the script with `-CreateDatabase` using an account that has `dbcreator`. Set the recovery model to FULL and configure backups as described in DATABASE_DESIGN §7.
2. Run `deploy-database.ps1 -Server <host\instance> -Encrypt`. Use an account in `oic_migrator_role` or `db_owner`.
3. Map the application service accounts with Windows authentication. A gMSA is recommended, because it needs no password:
   ```sql
   CREATE LOGIN [DOMAIN\gmsa-oic-api$] FROM WINDOWS;
   USE OneInsureVideoMeetingDB;
   CREATE USER [DOMAIN\gmsa-oic-api$] FOR LOGIN [DOMAIN\gmsa-oic-api$];
   ALTER ROLE oic_app_role ADD MEMBER [DOMAIN\gmsa-oic-api$];
   ```
4. Never expose SQL Server port 1433 outside the application network (NETWORK_FIREWALL_REQUIREMENTS.md).
