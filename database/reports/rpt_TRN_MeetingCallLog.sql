/* =====================================================================================================================
   rpt.TRN_MeetingCallLog - one row per meeting in the calling portal's call-back shape
   (Agentname, CallerID, StartTime, EndTime, CallDuration, Duration, DialStatus, HangupBy, AudioFile, callid, ...).

   APPLIED: 16 Nov 2026 to production Oneinsure_v (run in SSMS, output checked) and to the test DB OneInsureVideoMeetingDB_Room.
   NOT a migration: deploy-database.ps1 does not run this folder. Re-run it by hand after a database rebuild / on a new server.

   - A VIEW over existing tables: always current, no copied data, no change to any table, procedure or application code.
   - Times in IST ("yyyy-mm-dd hh:mi:ss.mmm"); durations in seconds.
     CallDuration = host start -> meeting end; RingingDuration = host start -> customer joined; Duration = customer's time in the call.
     HangupBy = HOST (ended by host) / SYSTEM (automatic end) / ALL_LEFT; empty for meetings that never started or were cancelled.
     AudioFile = recording page link (sign-in required; no key in the URL). Did / HoldDuration / WrapUpDuration: no equivalent (NULL).
   - Rollback: DROP VIEW rpt.TRN_MeetingCallLog;   (DROP SCHEMA rpt; only if nothing else uses it)
   ===================================================================================================================== */

IF SCHEMA_ID('rpt') IS NULL EXEC ('CREATE SCHEMA rpt AUTHORIZATION dbo');
GO

CREATE OR ALTER VIEW rpt.TRN_MeetingCallLog
AS
SELECT
    -- identity of the "call"
    m.MeetingCode                                        AS callid,            -- portal: callid
    CAST(m.PublicId AS VARCHAR(36))                      AS monitorUCID,       -- portal: monitorUCID (unique id)
    m.MeetingId                                          AS MeetingId,         -- join key to every mtg./rec. table

    -- agent = host employee
    h.DisplayName                                        AS Agentname,
    h.Mobile                                             AS AgentPhoneNumber,
    h.EmployeeCode                                       AS AgentUniqueID,
    h.OfficialEmail                                      AS AgentEmail,

    -- customer
    cu.Mobile                                            AS CallerID,
    cu.FullName                                          AS CustomerName,
    cu.Email                                             AS CustomerEmail,
    m.PrarambhMainId                                     AS PrarambhMainId,
    m.ExternalReference                                  AS ExternalReference,

    -- campaign / list / skill
    m.Category                                           AS CampaignName,      -- CUSTOMER_PLVC, CUSTOMER_GENERAL, TEAM, ...
    COALESCE(i.Name, 'OneInsure Connect')                AS listname,          -- calling portal (integration) or our site
    d.Name                                               AS skillname,         -- host's department
    m.MeetingKind                                        AS [Type],            -- INSTANT / SCHEDULED (portal: OUT / IN)

    -- times (IST) and durations (seconds)
    CONVERT(VARCHAR(23), DATEADD(MINUTE, 330, COALESCE(m.ActualStartUtc, m.ScheduledStartUtc)), 121) AS StartTime,
    CONVERT(VARCHAR(23), DATEADD(MINUTE, 330, COALESCE(m.ActualEndUtc,   m.ScheduledEndUtc)),   121) AS EndTime,
    DATEDIFF(SECOND, m.ActualStartUtc, m.ActualEndUtc)   AS CallDuration,      -- whole meeting, host start -> end
    DATEDIFF(SECOND, m.ActualStartUtc, cust.FirstJoinUtc) AS RingingDuration,  -- host start -> customer joined
    cust.TalkSeconds                                     AS Duration,          -- customer's time in the meeting

    -- outcome
    CASE WHEN cust.TalkSeconds > 0 THEN 'CONNECTED' ELSE 'NOT_CONNECTED' END AS DialStatus,
    CASE WHEN cu.CustomerId IS NULL THEN NULL
         WHEN cust.Joins = 0        THEN 'NOT_JOINED'
         WHEN cust.StillIn > 0      THEN 'IN_CALL'
         ELSE 'LEFT' END                                 AS CustomerStatus,
    m.[Status]                                           AS [status],          -- SCHEDULED, LIVE, COMPLETED, EXPIRED, CANCELLED, INCOMPLETE
    m.[Status]                                           AS Disposition,
    endby.HangupBy                                       AS HangupBy,          -- HOST / SYSTEM (auto-end) / ALL_LEFT

    -- recording (latest one of the meeting)
    rec.[Status]                                         AS RecordingStatus,
    rec.DurationSeconds                                  AS RecordingDuration,
    CASE WHEN rec.PublicId IS NOT NULL
         THEN 'https://www.oneinsure.com/meet/recordings/' + LOWER(CAST(rec.PublicId AS VARCHAR(36))) END AS AudioFile, -- opens after sign-in (no key in the URL)

    -- portal fields with no equivalent in a video meeting
    CAST(NULL AS VARCHAR(20))                            AS Did,
    CAST(NULL AS INT)                                    AS HoldDuration,
    CAST(NULL AS INT)                                    AS WrapUpDuration
FROM mtg.Meetings m
JOIN org.Employees h            ON h.EmployeeId = m.HostEmployeeId
LEFT JOIN org.Departments d     ON d.DepartmentId = h.DepartmentId
LEFT JOIN app.ApiIntegrations i ON i.IntegrationId = m.IntegrationId
LEFT JOIN crm.Customers cu      ON cu.CustomerId = m.CustomerId
OUTER APPLY (
    SELECT COUNT(a.AttendanceId)                                                        AS Joins,
           MIN(a.JoinedUtc)                                                             AS FirstJoinUtc,
           SUM(DATEDIFF(SECOND, a.JoinedUtc, COALESCE(a.LeftUtc, mm.EndUtc)))           AS TalkSeconds,
           SUM(CASE WHEN a.LeftUtc IS NULL AND mm.St = 'LIVE' THEN 1 ELSE 0 END)        AS StillIn
    FROM mtg.MeetingParticipants p
    CROSS APPLY (VALUES (m.ActualEndUtc, m.[Status])) mm (EndUtc, St)
    LEFT JOIN mtg.MeetingAttendance a ON a.ParticipantId = p.ParticipantId
    WHERE p.MeetingId = m.MeetingId AND p.ParticipantType = 'CUSTOMER'
) cust
OUTER APPLY (
    SELECT TOP (1) CASE al.[Action] WHEN 'MEETING_ENDED' THEN 'HOST' WHEN 'MEETING_AUTO_ENDED' THEN 'SYSTEM' ELSE 'ALL_LEFT' END AS HangupBy
    FROM app.AuditLog al
    WHERE al.EntityType = 'Meeting' AND al.EntityId = LOWER(CAST(m.PublicId AS VARCHAR(36)))
      AND al.[Action] IN ('MEETING_ENDED', 'MEETING_AUTO_ENDED', 'MEETING_COMPLETED')
    ORDER BY al.Utc DESC
) endby
OUTER APPLY (
    SELECT TOP (1) r.PublicId, r.[Status], r.DurationSeconds
    FROM rec.MeetingRecordings r
    WHERE r.MeetingId = m.MeetingId
    ORDER BY r.RecordingId DESC
) rec;
GO

/* Example: today's customer calls, like the portal's call-back data
SELECT callid, Agentname, AgentUniqueID, CallerID, CustomerName, PrarambhMainId, CampaignName, StartTime, EndTime,
       CallDuration, RingingDuration, Duration, DialStatus, CustomerStatus, HangupBy, [status], RecordingStatus, AudioFile
FROM rpt.TRN_MeetingCallLog
WHERE CampaignName IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') AND StartTime >= CONVERT(VARCHAR(10), DATEADD(MINUTE, 330, SYSUTCDATETIME()), 121)
ORDER BY StartTime DESC;
*/
