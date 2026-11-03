-- V008: views, table type and procedures for availability, booking locks and queue claiming.
-- Convention: app.AuditLog.EntityId holds the entity's PublicId when it has one (internal ids never leave the DB).

CREATE VIEW mtg.vw_MeetingCalendar
AS
SELECT  m.MeetingId, m.PublicId AS MeetingPublicId, m.MeetingCode, m.Title, m.Category, m.[Status],
        m.ScheduledStartUtc, m.ScheduledEndUtc, m.TimeZoneId, m.HostEmployeeId, m.CreatedByEmployeeId,
        m.DepartmentId, m.CustomerId, m.RecordingPolicy,
        CAST(CASE WHEN m.Category IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') THEN 1 ELSE 0 END AS BIT) AS IsCustomerMeeting,
        p.EmployeeId, p.[Role] AS ParticipantRole, p.ResponseStatus
FROM    mtg.Meetings m
JOIN    mtg.MeetingParticipants p ON p.MeetingId = m.MeetingId AND p.ParticipantType = 'EMPLOYEE';
GO

CREATE VIEW mtg.vw_MeetingAuditLog
AS
SELECT  a.AuditId, a.Utc, a.ActorUserId, a.ActorType, a.[Action], a.EntityId AS MeetingPublicId, a.Summary,
        a.OldValuesJson, a.NewValuesJson, a.IpAddress, a.CorrelationId, a.IsPrivileged
FROM    app.AuditLog a
WHERE   a.EntityType = 'Meeting';
GO

CREATE TYPE mtg.EmployeeIdList AS TABLE (EmployeeId BIGINT NOT NULL PRIMARY KEY);
GO

-- Busy-time conflicts for the given employees in [@StartUtc, @EndUtc).
-- Returns no meeting titles or leave reasons: the API decides what the caller may see.
-- Working hours are local-time rules and are evaluated in the API (IANA time zones).
CREATE PROCEDURE mtg.usp_CheckAvailability
    @EmployeeIds      mtg.EmployeeIdList READONLY,
    @StartUtc         DATETIME2(3),
    @EndUtc           DATETIME2(3),
    @ExcludeMeetingId BIGINT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @StartUtc IS NULL OR @EndUtc IS NULL OR @EndUtc <= @StartUtc
        THROW 51010, 'EndUtc must be after StartUtc.', 1;

    SELECT  e.EmployeeId, CAST('MEETING' AS VARCHAR(30)) AS ConflictType, m.PublicId AS MeetingPublicId,
            m.ScheduledStartUtc AS ConflictStartUtc, m.ScheduledEndUtc AS ConflictEndUtc
    FROM    @EmployeeIds e
    JOIN    mtg.Meetings m
            ON m.HostEmployeeId = e.EmployeeId
            OR EXISTS (SELECT 1 FROM mtg.MeetingParticipants p
                       WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = e.EmployeeId AND p.ResponseStatus <> 'DECLINED')
    WHERE   m.[Status] IN ('SCHEDULED', 'LIVE')
      AND   m.ScheduledStartUtc < @EndUtc AND m.ScheduledEndUtc > @StartUtc
      AND   (@ExcludeMeetingId IS NULL OR m.MeetingId <> @ExcludeMeetingId)
    UNION ALL
    SELECT  a.EmployeeId, a.[Type], NULL, a.StartUtc, a.EndUtc
    FROM    @EmployeeIds e
    JOIN    mtg.EmployeeAvailability a ON a.EmployeeId = e.EmployeeId
    WHERE   a.[Type] IN ('LEAVE', 'BLOCKED')
      AND   a.StartUtc < @EndUtc AND a.EndUtc > @StartUtc
    ORDER BY EmployeeId, ConflictStartUtc;
END;
GO

-- Double-booking guard. Call inside the create/reschedule transaction, before usp_CheckAvailability.
-- Locks are taken in EmployeeId order (no deadlocks) and released at commit/rollback.
CREATE PROCEDURE mtg.usp_LockEmployeesForBooking
    @EmployeeIds mtg.EmployeeIdList READONLY,
    @TimeoutMs   INT = 10000
AS
BEGIN
    SET NOCOUNT ON;
    IF @@TRANCOUNT = 0
        THROW 51011, 'usp_LockEmployeesForBooking must run inside a transaction.', 1;

    DECLARE @id BIGINT, @result INT, @resource NVARCHAR(255);
    DECLARE ids CURSOR LOCAL FAST_FORWARD FOR SELECT EmployeeId FROM @EmployeeIds ORDER BY EmployeeId;
    OPEN ids;
    FETCH NEXT FROM ids INTO @id;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        SET @resource = CONCAT(N'oic:booking:employee:', @id);
        EXEC @result = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = @TimeoutMs;
        IF @result < 0
        BEGIN
            CLOSE ids; DEALLOCATE ids;
            THROW 51012, 'Could not lock the employee calendars for booking. Retry.', 1;
        END;
        FETCH NEXT FROM ids INTO @id;
    END;
    CLOSE ids; DEALLOCATE ids;
END;
GO

-- Reminder worker: claims due reminders with a lease. READPAST lets several workers run without
-- double-sending; expired leases are re-claimed; stale schedule versions and cancelled meetings are skipped.
CREATE PROCEDURE mtg.usp_ClaimDueReminders
    @Owner        VARCHAR(100),
    @Batch        INT = 50,
    @LeaseSeconds INT = 120,
    @MaxAttempts  INT = 5
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now DATETIME2(3) = SYSUTCDATETIME();
    DECLARE @claimed TABLE (ReminderId BIGINT, MeetingId BIGINT, ParticipantId BIGINT, OffsetMinutes INT, Channel VARCHAR(30),
                            DueUtc DATETIME2(3), ScheduleVersion INT, Attempts INT);

    UPDATE mtg.MeetingReminders
    SET    [Status] = 'FAILED', LeaseOwner = NULL, LeaseExpiresUtc = NULL,
           LastError = COALESCE(LastError, N'Lease expired after the final attempt.')
    WHERE  [Status] = 'CLAIMED' AND LeaseExpiresUtc < @now AND Attempts >= @MaxAttempts;

    WITH due AS (
        SELECT TOP (@Batch) r.*
        FROM   mtg.MeetingReminders r WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE  r.DueUtc <= @now
          AND  r.Attempts < @MaxAttempts
          AND  ((r.[Status] IN ('PENDING', 'FAILED') AND (r.NextAttemptUtc IS NULL OR r.NextAttemptUtc <= @now))
             OR (r.[Status] = 'CLAIMED' AND r.LeaseExpiresUtc < @now))
          AND  EXISTS (SELECT 1 FROM mtg.Meetings m
                       WHERE m.MeetingId = r.MeetingId AND m.[Status] IN ('SCHEDULED', 'LIVE') AND m.ScheduleVersion = r.ScheduleVersion)
        ORDER BY r.DueUtc
    )
    UPDATE due
    SET    [Status] = 'CLAIMED', LeaseOwner = @Owner, LeaseExpiresUtc = DATEADD(SECOND, @LeaseSeconds, @now), Attempts = Attempts + 1
    OUTPUT inserted.ReminderId, inserted.MeetingId, inserted.ParticipantId, inserted.OffsetMinutes, inserted.Channel,
           inserted.DueUtc, inserted.ScheduleVersion, inserted.Attempts
    INTO   @claimed;

    -- OUTPUT ... INTO + SELECT (not a bare OUTPUT) keeps the procedure usable from INSERT ... EXEC.
    SELECT ReminderId, MeetingId, ParticipantId, OffsetMinutes, Channel, DueUtc, ScheduleVersion, Attempts FROM @claimed;
END;
GO

CREATE PROCEDURE app.usp_ClaimOutbox
    @Owner        VARCHAR(100),
    @Batch        INT = 20,
    @LeaseSeconds INT = 120,
    @MaxAttempts  INT = 5
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now DATETIME2(3) = SYSUTCDATETIME();
    DECLARE @claimed TABLE (OutboxId BIGINT, Template VARCHAR(50), ToAddress NVARCHAR(254), Subject NVARCHAR(300),
                            BodyHtml NVARCHAR(MAX), Attempts INT);

    UPDATE app.EmailOutbox
    SET    [Status] = 'FAILED', LeaseOwner = NULL, LeaseExpiresUtc = NULL
    WHERE  [Status] = 'CLAIMED' AND LeaseExpiresUtc < @now AND Attempts >= @MaxAttempts;

    WITH due AS (
        SELECT TOP (@Batch) o.*
        FROM   app.EmailOutbox o WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE  o.Attempts < @MaxAttempts
          AND  ((o.[Status] IN ('PENDING', 'FAILED') AND (o.NextAttemptUtc IS NULL OR o.NextAttemptUtc <= @now))
             OR (o.[Status] = 'CLAIMED' AND o.LeaseExpiresUtc < @now))
        ORDER BY o.CreatedUtc
    )
    UPDATE due
    SET    [Status] = 'CLAIMED', LeaseOwner = @Owner, LeaseExpiresUtc = DATEADD(SECOND, @LeaseSeconds, @now), Attempts = Attempts + 1
    OUTPUT inserted.OutboxId, inserted.Template, inserted.ToAddress, inserted.Subject, inserted.BodyHtml, inserted.Attempts
    INTO   @claimed;

    SELECT OutboxId, Template, ToAddress, Subject, BodyHtml, Attempts FROM @claimed;
END;
GO

-- Recorder host: claims queued jobs (QUEUED -> STARTING) and re-claims jobs whose lease expired
-- (state kept, so the host resumes or finalises the job; the attempt counter shows the takeover).
CREATE PROCEDURE rec.usp_ClaimRecordingJobs
    @Owner        VARCHAR(100),
    @Batch        INT = 1,
    @LeaseSeconds INT = 60
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now DATETIME2(3) = SYSUTCDATETIME();
    DECLARE @claimed TABLE (JobId BIGINT, RecordingId BIGINT, IdempotencyKey VARCHAR(100), Engine VARCHAR(30), [State] VARCHAR(30),
                            Attempt INT, SpoolPath NVARCHAR(400));

    WITH due AS (
        SELECT TOP (@Batch) j.*
        FROM   rec.RecordingJobs j WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE  j.[State] = 'QUEUED'
           OR (j.[State] IN ('STARTING', 'ACTIVE', 'STOPPING', 'POST_PROCESSING') AND j.LeaseExpiresUtc < @now)
        ORDER BY j.CreatedUtc
    )
    UPDATE due
    SET    [State] = CASE WHEN [State] = 'QUEUED' THEN 'STARTING' ELSE [State] END,
           LeaseOwner = @Owner, LeaseExpiresUtc = DATEADD(SECOND, @LeaseSeconds, @now),
           HeartbeatUtc = @now, Attempt = Attempt + 1, ModifiedUtc = @now
    OUTPUT inserted.JobId, inserted.RecordingId, inserted.IdempotencyKey, inserted.Engine, inserted.[State],
           inserted.Attempt, inserted.SpoolPath
    INTO   @claimed;

    SELECT JobId, RecordingId, IdempotencyKey, Engine, [State], Attempt, SpoolPath FROM @claimed;
END;
GO
