-- Schema behaviour tests for OneInsureVideoMeetingDB. Run ONLY against a disposable test database
-- (tests\database\Test-Database.ps1 creates and drops one). Uses fictitious *.invalid addresses.
SET NOCOUNT ON;
CREATE TABLE #results (Seq INT IDENTITY, Name NVARCHAR(200), Pass BIT, Detail NVARCHAR(4000));
GO
CREATE PROCEDURE #ExpectFail @Name NVARCHAR(200), @Sql NVARCHAR(MAX), @ErrorNumber INT = NULL
AS
BEGIN
    BEGIN TRY
        EXEC sp_executesql @Sql;
        INSERT #results (Name, Pass, Detail) VALUES (@Name, 0, N'statement succeeded but should have failed');
    END TRY
    BEGIN CATCH
        DECLARE @n INT = ERROR_NUMBER(), @m NVARCHAR(4000) = ERROR_MESSAGE();
        IF XACT_STATE() <> 0 ROLLBACK;
        INSERT #results (Name, Pass, Detail)
        VALUES (@Name, CASE WHEN @ErrorNumber IS NULL OR @n = @ErrorNumber THEN 1 ELSE 0 END, CONCAT(@n, N': ', @m));
    END CATCH
END;
GO

------------------------------------------------------------------------------------------------
-- 1. Structure
------------------------------------------------------------------------------------------------
DECLARE @counts NVARCHAR(400) = (
    SELECT STRING_AGG(CONCAT(s.name, '=', c.n), ',') WITHIN GROUP (ORDER BY s.name)
    FROM (SELECT schema_id, COUNT(*) n FROM sys.tables GROUP BY schema_id) c JOIN sys.schemas s ON s.schema_id = c.schema_id);
INSERT #results (Name, Pass, Detail) VALUES (N'35 tables in auth/org/crm/mtg/rec/app (+ dbo.SchemaMigrations)', CASE WHEN @counts = N'app=6,auth=9,crm=1,dbo=1,mtg=10,org=6,rec=3' THEN 1 ELSE 0 END, @counts);

DECLARE @views NVARCHAR(400) = (SELECT STRING_AGG(SCHEMA_NAME(schema_id) + '.' + name, ',') WITHIN GROUP (ORDER BY name) FROM sys.views);
INSERT #results (Name, Pass, Detail) VALUES (N'2 views', CASE WHEN @views = N'mtg.vw_MeetingAuditLog,mtg.vw_MeetingCalendar' THEN 1 ELSE 0 END, @views);

DECLARE @mig INT = (SELECT COUNT(*) FROM dbo.SchemaMigrations);
INSERT #results (Name, Pass, Detail) VALUES (N'All migrations recorded', CASE WHEN @mig >= 10 THEN 1 ELSE 0 END, @mig);

DECLARE @untrusted INT = (SELECT COUNT(*) FROM sys.foreign_keys WHERE is_not_trusted = 1 OR is_disabled = 1)
      + (SELECT COUNT(*) FROM sys.check_constraints WHERE is_not_trusted = 1 OR is_disabled = 1);
INSERT #results (Name, Pass, Detail) VALUES (N'All FK and CHECK constraints enabled and trusted', CASE WHEN @untrusted = 0 THEN 1 ELSE 0 END, @untrusted);

DECLARE @rcsi BIT = (SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = DB_NAME());
INSERT #results (Name, Pass, Detail) VALUES (N'READ_COMMITTED_SNAPSHOT on', @rcsi, NULL);

------------------------------------------------------------------------------------------------
-- 2. Seed data: reference data only, no credentials
------------------------------------------------------------------------------------------------
DECLARE @roles INT = (SELECT COUNT(*) FROM auth.Roles), @perms INT = (SELECT COUNT(*) FROM auth.Permissions),
        @users INT = (SELECT COUNT(*) FROM auth.Users), @mfa INT = (SELECT COUNT(*) FROM auth.UserMfaMethods);
INSERT #results (Name, Pass, Detail) VALUES (N'Seed: 7 roles, 23 permissions', CASE WHEN @roles = 7 AND @perms = 23 THEN 1 ELSE 0 END, @roles);
INSERT #results (Name, Pass, Detail) VALUES (N'Seed: no users or MFA secrets', CASE WHEN @users = 0 AND @mfa = 0 THEN 1 ELSE 0 END, NULL);

DECLARE @wide INT = (SELECT COUNT(*) FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId
                     WHERE p.Code IN ('recordings.view.team', 'recordings.view.department', 'recordings.view.all', 'recordings.download', 'recordings.legalhold'));
INSERT #results (Name, Pass, Detail) VALUES (N'Wider recording access unassigned (pending Compliance)', CASE WHEN @wide = 0 THEN 1 ELSE 0 END, @wide);

DECLARE @empPerms NVARCHAR(1000) = (SELECT STRING_AGG(p.Code, ',') WITHIN GROUP (ORDER BY p.Code)
    FROM auth.RolePermissions rp JOIN auth.Roles r ON r.RoleId = rp.RoleId JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE r.Code = 'Employee');
INSERT #results (Name, Pass, Detail) VALUES (N'Employee role matches the web client', CASE WHEN @empPerms = N'calendar.view,customer.meetings.view,dashboard.view,meetings.create,meetings.view.own,notifications.view,recordings.view.own' THEN 1 ELSE 0 END, @empPerms);
GO

------------------------------------------------------------------------------------------------
-- 3. Fixture (fictitious)
------------------------------------------------------------------------------------------------
INSERT org.Departments (Code, Name) VALUES ('TST', N'Test Department');
INSERT org.Designations (Code, Name) VALUES ('TEX', N'Test Executive');
DECLARE @d BIGINT = (SELECT DepartmentId FROM org.Departments WHERE Code = 'TST'),
        @g BIGINT = (SELECT DesignationId FROM org.Designations WHERE Code = 'TEX');
INSERT org.Employees (EmployeeCode, FirstName, DisplayName, OfficialEmail, DepartmentId, DesignationId) VALUES
 ('T001', N'Alpha', N'Test Alpha', N'alpha@test.invalid', @d, @g),
 ('T002', N'Bravo', N'Test Bravo', N'bravo@test.invalid', @d, @g),
 ('T003', N'Charlie', N'Test Charlie', N'charlie@test.invalid', @d, @g);
INSERT crm.Customers (CustomerRef, FullName, Email) VALUES ('TST-CUST-1', N'Test Customer', N'customer@test.invalid');
INSERT auth.Users (Email) VALUES (N'alpha@test.invalid');  -- no password: fixture only

DECLARE @a BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T001'),
        @b BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T002'),
        @c BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T003');

-- M1: 1 Jan 2030 10:00-11:00 UTC, host Alpha; Bravo pending; Charlie declined.
INSERT mtg.Meetings (MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, ScheduledStartUtc, ScheduledEndUtc, LiveKitRoomName)
VALUES ('TST-M1', N'Test meeting 1', 'GROUP', @a, @a, '2030-01-01T10:00:00', '2030-01-01T11:00:00', 'room-tst-m1');
-- M2: cancelled, overlaps M1, Bravo attending.
INSERT mtg.Meetings (MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, ScheduledStartUtc, ScheduledEndUtc, LiveKitRoomName, [Status], CancelReason)
VALUES ('TST-M2', N'Test meeting 2', 'GROUP', @b, @b, '2030-01-01T10:30:00', '2030-01-01T11:30:00', 'room-tst-m2', 'CANCELLED', N'test');
DECLARE @m1 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M1'),
        @m2 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M2');
INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, [Role], ResponseStatus, LiveKitIdentity) VALUES
 (@m1, 'EMPLOYEE', @a, 'HOST', 'ACCEPTED', 'p-a1'),
 (@m1, 'EMPLOYEE', @b, 'ATTENDEE', 'PENDING', 'p-b1'),
 (@m1, 'EMPLOYEE', @c, 'ATTENDEE', 'DECLINED', 'p-c1'),
 (@m2, 'EMPLOYEE', @b, 'HOST', 'ACCEPTED', 'p-b2');
-- Charlie on leave 10:45-12:00.
INSERT mtg.EmployeeAvailability (EmployeeId, [Type], StartUtc, EndUtc, Reason) VALUES (@c, 'LEAVE', '2030-01-01T10:45:00', '2030-01-01T12:00:00', N'test');
GO

------------------------------------------------------------------------------------------------
-- 4. Integrity rules
------------------------------------------------------------------------------------------------
EXEC #ExpectFail N'Meeting owner (CreatedByEmployeeId) is immutable',
    N'UPDATE mtg.Meetings SET CreatedByEmployeeId = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = ''T002'') WHERE MeetingCode = ''TST-M1''', 51001;

EXEC #ExpectFail N'Customer meeting requires a customer',
    N'INSERT mtg.Meetings (MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, ScheduledStartUtc, ScheduledEndUtc, LiveKitRoomName)
      SELECT ''TST-M3'', N''x'', ''CUSTOMER_PLVC'', EmployeeId, EmployeeId, ''2030-01-02T10:00:00'', ''2030-01-02T11:00:00'', ''room-tst-m3'' FROM org.Employees WHERE EmployeeCode = ''T001''', 547;

EXEC #ExpectFail N'Meeting end must be after start',
    N'INSERT mtg.Meetings (MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, ScheduledStartUtc, ScheduledEndUtc, LiveKitRoomName)
      SELECT ''TST-M4'', N''x'', ''GROUP'', EmployeeId, EmployeeId, ''2030-01-02T10:00:00'', ''2030-01-02T10:00:00'', ''room-tst-m4'' FROM org.Employees WHERE EmployeeCode = ''T001''', 547;

EXEC #ExpectFail N'EMPLOYEE participant requires EmployeeId',
    N'INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, LiveKitIdentity) SELECT MeetingId, ''EMPLOYEE'', ''p-x'' FROM mtg.Meetings WHERE MeetingCode = ''TST-M1''', 547;

EXEC #ExpectFail N'Customers cannot host',
    N'INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, CustomerId, [Role], LiveKitIdentity)
      SELECT m.MeetingId, ''CUSTOMER'', c.CustomerId, ''HOST'', ''p-cust'' FROM mtg.Meetings m CROSS JOIN crm.Customers c WHERE m.MeetingCode = ''TST-M1''', 547;

EXEC #ExpectFail N'Same employee cannot be added twice to a meeting',
    N'INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, LiveKitIdentity)
      SELECT m.MeetingId, ''EMPLOYEE'', e.EmployeeId, ''p-dup'' FROM mtg.Meetings m CROSS JOIN org.Employees e WHERE m.MeetingCode = ''TST-M1'' AND e.EmployeeCode = ''T002''', 2601;

EXEC #ExpectFail N'Notification links must be app-relative',
    N'INSERT mtg.MeetingNotifications (RecipientUserId, [Type], Title, LinkPath) SELECT UserId, ''REMINDER'', N''x'', N''https://example.invalid'' FROM auth.Users WHERE Email = N''alpha@test.invalid''', 547;
GO

-- Reminders: dedupe and claiming
DECLARE @m1 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M1');
DECLARE @pb BIGINT = (SELECT ParticipantId FROM mtg.MeetingParticipants WHERE LiveKitIdentity = 'p-b1');
DECLARE @pa BIGINT = (SELECT ParticipantId FROM mtg.MeetingParticipants WHERE LiveKitIdentity = 'p-a1');
INSERT mtg.MeetingReminders (MeetingId, ParticipantId, OffsetMinutes, Channel, DueUtc, ScheduleVersion) VALUES
 (@m1, @pb, 15, 'EMAIL',  DATEADD(MINUTE, -1, SYSUTCDATETIME()), 1),  -- due
 (@m1, @pa, 15, 'EMAIL',  DATEADD(MINUTE, -1, SYSUTCDATETIME()), 1),  -- due
 (@m1, @pb, 60, 'EMAIL',  DATEADD(MINUTE, -1, SYSUTCDATETIME()), 0),  -- stale schedule version
 (@m1, @pb, 5,  'IN_APP', DATEADD(DAY, 1, SYSUTCDATETIME()), 1);      -- not due yet
GO
EXEC #ExpectFail N'Duplicate reminder (meeting, participant, offset, channel, version) rejected',
    N'INSERT mtg.MeetingReminders (MeetingId, ParticipantId, OffsetMinutes, Channel, DueUtc, ScheduleVersion)
      SELECT MeetingId, ParticipantId, 15, ''EMAIL'', SYSUTCDATETIME(), 1 FROM mtg.MeetingParticipants WHERE LiveKitIdentity = ''p-b1''', 2627;

CREATE TABLE #claim1 (ReminderId BIGINT, MeetingId BIGINT, ParticipantId BIGINT, OffsetMinutes INT, Channel VARCHAR(30), DueUtc DATETIME2(3), ScheduleVersion INT, Attempts INT);
CREATE TABLE #claim2 (ReminderId BIGINT, MeetingId BIGINT, ParticipantId BIGINT, OffsetMinutes INT, Channel VARCHAR(30), DueUtc DATETIME2(3), ScheduleVersion INT, Attempts INT);
INSERT #claim1 EXEC mtg.usp_ClaimDueReminders @Owner = 'worker-1', @Batch = 10;
INSERT #claim2 EXEC mtg.usp_ClaimDueReminders @Owner = 'worker-2', @Batch = 10;
DECLARE @n1 INT = (SELECT COUNT(*) FROM #claim1), @n2 INT = (SELECT COUNT(*) FROM #claim2),
        @stale INT = (SELECT COUNT(*) FROM #claim1 WHERE ScheduleVersion = 0);
INSERT #results (Name, Pass, Detail) VALUES (N'Reminder claim returns only due rows of the current schedule version', CASE WHEN @n1 = 2 AND @stale = 0 THEN 1 ELSE 0 END, @n1);
INSERT #results (Name, Pass, Detail) VALUES (N'Claimed reminders are not handed to a second worker while leased', CASE WHEN @n2 = 0 THEN 1 ELSE 0 END, @n2);

-- Expire the lease: another worker may take over.
UPDATE mtg.MeetingReminders SET LeaseExpiresUtc = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE LeaseOwner = 'worker-1';
DELETE #claim2;
INSERT #claim2 EXEC mtg.usp_ClaimDueReminders @Owner = 'worker-2', @Batch = 10;
SET @n2 = (SELECT COUNT(*) FROM #claim2);
INSERT #results (Name, Pass, Detail) VALUES (N'Expired reminder leases are re-claimed', CASE WHEN @n2 = 2 THEN 1 ELSE 0 END, @n2);
GO

-- Availability / double booking
DECLARE @ids mtg.EmployeeIdList;
DECLARE @r TABLE (EmployeeId BIGINT, ConflictType VARCHAR(30), MeetingPublicId UNIQUEIDENTIFIER, S DATETIME2(3), E DATETIME2(3));
DECLARE @a BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T001'),
        @b BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T002'),
        @c BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T003'),
        @m1 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M1');
INSERT @ids VALUES (@a), (@b), (@c);
INSERT @r EXEC mtg.usp_CheckAvailability @EmployeeIds = @ids, @StartUtc = '2030-01-01T10:15:00', @EndUtc = '2030-01-01T10:50:00';
DECLARE @summary NVARCHAR(400) = (SELECT STRING_AGG(CONCAT(e.EmployeeCode, ':', r.ConflictType), ',') WITHIN GROUP (ORDER BY e.EmployeeCode, r.ConflictType)
                                  FROM @r r JOIN org.Employees e ON e.EmployeeId = r.EmployeeId);
-- Alpha (host) and Bravo (pending) clash with M1; Charlie declined M1 but is on leave; cancelled M2 is ignored.
INSERT #results (Name, Pass, Detail) VALUES (N'Availability: overlaps found, declined/cancelled ignored, leave reported', CASE WHEN @summary = N'T001:MEETING,T002:MEETING,T003:LEAVE' THEN 1 ELSE 0 END, @summary);

DELETE @r;
INSERT @r EXEC mtg.usp_CheckAvailability @EmployeeIds = @ids, @StartUtc = '2030-01-01T11:00:00', @EndUtc = '2030-01-01T11:30:00';
SET @summary = (SELECT STRING_AGG(CONCAT(e.EmployeeCode, ':', r.ConflictType), ',') FROM @r r JOIN org.Employees e ON e.EmployeeId = r.EmployeeId);
INSERT #results (Name, Pass, Detail) VALUES (N'Availability: back-to-back meetings do not conflict', CASE WHEN @summary = N'T003:LEAVE' THEN 1 ELSE 0 END, @summary);

DELETE @r;
INSERT @r EXEC mtg.usp_CheckAvailability @EmployeeIds = @ids, @StartUtc = '2030-01-01T10:15:00', @EndUtc = '2030-01-01T10:30:00', @ExcludeMeetingId = @m1;
INSERT #results (Name, Pass, Detail) VALUES (N'Availability: rescheduling excludes the meeting itself', CASE WHEN NOT EXISTS (SELECT 1 FROM @r) THEN 1 ELSE 0 END, NULL);
GO
EXEC #ExpectFail N'Booking lock requires a transaction',
    N'DECLARE @ids mtg.EmployeeIdList; INSERT @ids VALUES (1); EXEC mtg.usp_LockEmployeesForBooking @EmployeeIds = @ids;', 51011;

BEGIN TRANSACTION;
DECLARE @ids mtg.EmployeeIdList; INSERT @ids SELECT EmployeeId FROM org.Employees WHERE EmployeeCode IN ('T001', 'T002');
EXEC mtg.usp_LockEmployeesForBooking @EmployeeIds = @ids;
DECLARE @held INT = (SELECT COUNT(*) FROM sys.dm_tran_locks WHERE request_session_id = @@SPID AND resource_type = 'APPLICATION' AND request_mode = 'X');
COMMIT;
DECLARE @after INT = (SELECT COUNT(*) FROM sys.dm_tran_locks WHERE request_session_id = @@SPID AND resource_type = 'APPLICATION');
INSERT #results (Name, Pass, Detail) VALUES (N'Booking lock holds one exclusive lock per employee until commit', CASE WHEN @held = 2 AND @after = 0 THEN 1 ELSE 0 END, @held);
GO

-- Recordings
DECLARE @m1 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M1');
DECLARE @a BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'T001');
INSERT rec.MeetingRecordings (MeetingId, OwnerEmployeeId) VALUES (@m1, @a);
GO
EXEC #ExpectFail N'Recording owner must be the meeting creator',
    N'INSERT rec.MeetingRecordings (MeetingId, OwnerEmployeeId) SELECT m.MeetingId, e.EmployeeId FROM mtg.Meetings m CROSS JOIN org.Employees e WHERE m.MeetingCode = ''TST-M1'' AND e.EmployeeCode = ''T002''', 51004;

EXEC #ExpectFail N'Recording owner is immutable',
    N'UPDATE rec.MeetingRecordings SET OwnerEmployeeId = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = ''T002'')', 51003;

EXEC #ExpectFail N'COMPLETED requires verification (VerifiedUtc, Sha256, StorageKey, size)',
    N'UPDATE rec.MeetingRecordings SET [Status] = ''COMPLETED'', StorageKey = N''2030/01/01/a.mp4'', FileSizeBytes = 10', 547;

EXEC #ExpectFail N'FAILED requires a reason', N'UPDATE rec.MeetingRecordings SET [Status] = ''FAILED''', 547;

EXEC #ExpectFail N'StorageKey cannot escape the recordings root',
    N'UPDATE rec.MeetingRecordings SET StorageKey = N''..\..\Windows\x.mp4''', 547;

EXEC #ExpectFail N'StorageKey cannot be absolute', N'UPDATE rec.MeetingRecordings SET StorageKey = N''C:\x.mp4''', 547;

UPDATE rec.MeetingRecordings
SET [Status] = 'COMPLETED', StorageKey = N'2030/01/01/a.mp4', FileSizeBytes = 10, Sha256 = HASHBYTES('SHA2_256', 'x'),
    VerifiedUtc = SYSUTCDATETIME(), VerificationDetails = N'{"decodeErrors":0}';
INSERT #results (Name, Pass, Detail) VALUES (N'Verified recording can be COMPLETED', CASE WHEN @@ROWCOUNT = 1 THEN 1 ELSE 0 END, NULL);
GO

-- Append-only evidence
DECLARE @m1 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M1');
DECLARE @pb BIGINT = (SELECT ParticipantId FROM mtg.MeetingParticipants WHERE LiveKitIdentity = 'p-b1');
INSERT mtg.MeetingConsent (MeetingId, ParticipantId, NoticeVersion, Decision) VALUES (@m1, @pb, 'PLACEHOLDER-v0', 'GRANTED');
INSERT app.AuditLog (ActorType, [Action], EntityType, Summary) VALUES ('SYSTEM', 'TEST', 'Meeting', N'test');
GO
EXEC #ExpectFail N'Consent rows cannot be updated', N'UPDATE mtg.MeetingConsent SET Decision = ''DENIED''', 51002;
EXEC #ExpectFail N'Audit rows cannot be updated', N'UPDATE app.AuditLog SET Summary = N''changed''', 51002;
EXEC #ExpectFail N'USER audit rows need an actor', N'INSERT app.AuditLog (ActorType, [Action], EntityType) VALUES (''USER'', ''X'', ''Meeting'')', 547;

-- Attendance duration
DECLARE @m1 BIGINT = (SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = 'TST-M1');
DECLARE @pb BIGINT = (SELECT ParticipantId FROM mtg.MeetingParticipants WHERE LiveKitIdentity = 'p-b1');
INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, LeftUtc) VALUES (@m1, @pb, '2030-01-01T10:00:00', '2030-01-01T10:42:30');
DECLARE @dur INT = (SELECT DurationSeconds FROM mtg.MeetingAttendance WHERE ParticipantId = @pb);
INSERT #results (Name, Pass, Detail) VALUES (N'Attendance duration is computed', CASE WHEN @dur = 2550 THEN 1 ELSE 0 END, @dur);
GO

------------------------------------------------------------------------------------------------
-- 5. Application role permissions (least privilege)
------------------------------------------------------------------------------------------------
CREATE USER oic_test_app WITHOUT LOGIN;
ALTER ROLE oic_app_role ADD MEMBER oic_test_app;
GO
EXECUTE AS USER = 'oic_test_app';
DECLARE @p NVARCHAR(1000) = CONCAT(
    'consentInsert=',  HAS_PERMS_BY_NAME('mtg.MeetingConsent', 'OBJECT', 'INSERT'),
    ',consentUpdate=', HAS_PERMS_BY_NAME('mtg.MeetingConsent', 'OBJECT', 'UPDATE'),
    ',consentDelete=', HAS_PERMS_BY_NAME('mtg.MeetingConsent', 'OBJECT', 'DELETE'),
    ',auditDelete=',   HAS_PERMS_BY_NAME('app.AuditLog', 'OBJECT', 'DELETE'),
    ',accessUpdate=',  HAS_PERMS_BY_NAME('rec.RecordingAccessLog', 'OBJECT', 'UPDATE'),
    ',meetingsUpdate=',HAS_PERMS_BY_NAME('mtg.Meetings', 'OBJECT', 'UPDATE'),
    ',execAvail=',     HAS_PERMS_BY_NAME('mtg.usp_CheckAvailability', 'OBJECT', 'EXECUTE'),
    ',migrations=',    HAS_PERMS_BY_NAME('dbo.SchemaMigrations', 'OBJECT', 'SELECT'),
    ',createTable=',   HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'),
    ',alterSchema=',   HAS_PERMS_BY_NAME('mtg', 'SCHEMA', 'ALTER'));
REVERT;
INSERT #results (Name, Pass, Detail) VALUES (N'App role: DML allowed, append-only/DDL/migrations denied', CASE WHEN @p = N'consentInsert=1,consentUpdate=0,consentDelete=0,auditDelete=0,accessUpdate=0,meetingsUpdate=1,execAvail=1,migrations=0,createTable=0,alterSchema=0' THEN 1 ELSE 0 END, @p);
GO

------------------------------------------------------------------------------------------------
SELECT CONCAT(CASE WHEN Pass = 1 THEN 'PASS' ELSE 'FAIL' END, ' | ', Name, CASE WHEN Pass = 0 OR Detail IS NOT NULL THEN CONCAT(' | ', Detail) ELSE '' END)
FROM #results ORDER BY Seq;
DECLARE @failed INT = (SELECT COUNT(*) FROM #results WHERE Pass = 0), @total INT = (SELECT COUNT(*) FROM #results);
PRINT CONCAT('RESULT: ', @total - @failed, '/', @total, ' passed');
IF @failed > 0 THROW 50001, 'Database assertions failed.', 1;
GO
