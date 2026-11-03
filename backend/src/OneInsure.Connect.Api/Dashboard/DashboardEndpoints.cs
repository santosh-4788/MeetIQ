using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Dashboard;

/// <summary>
/// GET /api/v1/dashboard/summary — DashboardSummary in frontend/src/api/types.ts, from real data.
/// Scope: meetings the user hosts, created or attends (all meetings with meetings.view.all); recordings the user
/// owns (all with recordings.view.all). "Today", "this month" and the week are in the user's time zone.
/// </summary>
public static class DashboardEndpoints
{
    sealed record Kpis(int TotalEmployees, int TodaysMeetings, int UpcomingMeetings, int InternalMeetings, int CustomerMeetings,
        int CompletedMeetings, int TotalRecordings, int PendingRecordings);
    sealed record MeetingRow(Guid Id, string Title, string Category, string Status, DateTime StartUtc, DateTime EndUtc,
        string Organiser, string? CustomerName, bool Recording, string? Participants, bool Mine);
    sealed record ActivityRow(string Id, string Type, string Title, string Actor, DateTime AtUtc);
    sealed record DeptRow(string Department, int Internal, int Customer);
    sealed record TrendRow(DateTime ScheduledStartUtc, string Status);
    sealed record AttendanceRow(int Attended, int Late, int Missed);
    sealed record RecordingRow(int Completed, int Processing, int Pending, int Failed);
    sealed record Scope(long? EmployeeId, string TimeZoneId);

    public static RouteGroupBuilder MapDashboardEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/dashboard/summary", async (HttpContext ctx, Db db, IClock clock, IOptions<MeetingOptions> mo, IOptions<LiveKitOptions> lk, CancellationToken ct) =>
        {
            var userId = ctx.User.UserId();
            var allMeetings = ctx.User.HasClaim(SessionClaims.Permission, "meetings.view.all");
            var allRecordings = ctx.User.HasClaim(SessionClaims.Permission, "recordings.view.all");

            using var c = await db.OpenAsync(ct);
            var scope = await c.QuerySingleAsync<Scope>("SELECT EmployeeId, TimeZoneId FROM auth.Users WHERE UserId = @userId", new { userId });
            var tz = FindZone(scope.TimeZoneId);
            var now = clock.UtcNow;
            var localToday = TimeZoneInfo.ConvertTimeFromUtc(now, tz).Date;
            DateTime Utc(DateTime local) => TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), tz);
            var monthStartLocal = new DateTime(localToday.Year, localToday.Month, 1);
            var p = new
            {
                emp = scope.EmployeeId, all = allMeetings, recAll = allRecordings, now, weekAhead = now.AddDays(7),
                todayStart = Utc(localToday), todayEnd = Utc(localToday.AddDays(1)),
                weekStart = Utc(localToday.AddDays(-6)), weekAgo = now.AddDays(-7), monthAgo = now.AddDays(-30),
                monthStart = Utc(monthStartLocal), monthEnd = Utc(monthStartLocal.AddMonths(1)),
            };

            using var multi = await c.QueryMultipleAsync(Sql, p);
            var kpis = await multi.ReadSingleAsync<Kpis>();
            var meetings = (await multi.ReadAsync<MeetingRow>()).Select(m => ToSummary(m, now, mo.Value, lk.Value.IsConfigured)).ToList();
            var activity = (await multi.ReadAsync<ActivityRow>()).Select(a => new
            {
                id = a.Id, type = a.Type, actor = a.Actor, atUtc = AsUtc(a.AtUtc),
                text = a.Type switch
                {
                    "MEETING_COMPLETED" => $"{a.Title} completed",
                    "MEETING_CANCELLED" => $"{a.Title} cancelled",
                    "RECORDING_READY" => $"Recording verified for {a.Title}",
                    _ => $"Recording failed for {a.Title}",
                },
            }).ToList();
            var departments = (await multi.ReadAsync<DeptRow>()).Select(d => new { department = d.Department, @internal = d.Internal, customer = d.Customer }).ToList();
            var trendRows = (await multi.ReadAsync<TrendRow>()).ToList();
            var attendance = await multi.ReadSingleAsync<AttendanceRow>();
            var recordings = await multi.ReadSingleAsync<RecordingRow>();

            var weeklyTrend = Enumerable.Range(0, 7).Select(i => localToday.AddDays(i - 6)).Select(day =>
            {
                var rows = trendRows.Where(r => TimeZoneInfo.ConvertTimeFromUtc(AsUtc(r.ScheduledStartUtc), tz).Date == day).ToList();
                return new { day = day.ToString("ddd", System.Globalization.CultureInfo.InvariantCulture), scheduled = rows.Count, completed = rows.Count(r => r.Status == "COMPLETED") };
            }).ToList();

            var todayStart = AsUtc(p.todayStart);
            var todayEnd = AsUtc(p.todayEnd);
            var nowUtc = AsUtc(now);
            var active = meetings.Where(m => m.status is "SCHEDULED" or "LIVE" && m.endUtc > nowUtc).OrderBy(m => m.startUtc).ToList();
            return Results.Ok(new
            {
                generatedUtc = nowUtc,
                kpis = new
                {
                    totalEmployees = kpis.TotalEmployees, todaysMeetings = kpis.TodaysMeetings, upcomingMeetings = kpis.UpcomingMeetings,
                    internalMeetings = kpis.InternalMeetings, customerMeetings = kpis.CustomerMeetings, completedMeetings = kpis.CompletedMeetings,
                    totalRecordings = kpis.TotalRecordings, pendingRecordings = kpis.PendingRecordings,
                },
                todaySchedule = meetings.Where(m => m.startUtc >= todayStart && m.startUtc < todayEnd).OrderBy(m => m.startUtc).ToList(),
                nextMeeting = active.FirstOrDefault(),
                // "Upcoming meetings · Next 7 days" (the KPI uses the same window).
                upcoming = active.Where(m => m.startUtc >= nowUtc && m.startUtc < nowUtc.AddDays(7)).Take(8).ToList(),
                recentActivity = activity,
                departmentMeetings = departments,
                weeklyTrend,
                attendance = new { attended = attendance.Attended, late = attendance.Late, missed = attendance.Missed },
                recordingStatus = new { completed = recordings.Completed, processing = recordings.Processing, pending = recordings.Pending, failed = recordings.Failed },
            });
        }).RequirePermission("dashboard.view");
        return api;
    }

    sealed record MeetingSummary(string id, string title, string category, DateTime startUtc, DateTime endUtc, string organiser,
        string[] participants, string status, bool recording, string? customerName, bool joinable, DateTime joinOpensUtc);

    /// <summary>joinable: the user is a participant and the video room is open now (Phase 4). The UI offers "Join" only then.</summary>
    static MeetingSummary ToSummary(MeetingRow m, DateTime now, MeetingOptions mo, bool liveKit) => new(
        m.Id.ToString(), m.Title,
        m.Category switch
        {
            "CUSTOMER_PLVC" or "CUSTOMER_GENERAL" => "CUSTOMER",
            "TRAINING" => "TRAINING",
            "REVIEW" => "REVIEW",
            "MANAGEMENT" => "MANAGEMENT",
            _ => "INTERNAL",
        },
        AsUtc(m.StartUtc), AsUtc(m.EndUtc), m.Organiser,
        (m.Participants ?? "").Split('\u001F', StringSplitOptions.RemoveEmptyEntries),
        // The UI knows four states; EXPIRED shows as cancelled, INCOMPLETE as completed. DRAFT is never listed.
        m.Status switch { "EXPIRED" => "CANCELLED", "INCOMPLETE" => "COMPLETED", var s => s },
        m.Recording, m.CustomerName,
        m.Mine && liveKit && JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, mo).Joinable,
        JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, mo).OpensUtc);

    static DateTime AsUtc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);

    static TimeZoneInfo FindZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
    }

    const string Sql = """
        SET NOCOUNT ON;
        SELECT m.MeetingId, m.Category, m.[Status], m.ScheduledStartUtc, m.HostEmployeeId
        INTO #vis
        FROM mtg.Meetings m
        WHERE m.[Status] <> 'DRAFT'
          AND (@all = 1 OR m.HostEmployeeId = @emp OR m.CreatedByEmployeeId = @emp
               OR EXISTS (SELECT 1 FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = @emp));

        SELECT r.RecordingId, r.[Status]
        INTO #rec
        FROM rec.MeetingRecordings r
        WHERE r.[Status] <> 'PURGED' AND (@recAll = 1 OR r.OwnerEmployeeId = @emp);

        SELECT
          (SELECT COUNT(*) FROM org.Employees WHERE IsActive = 1) AS TotalEmployees,
          (SELECT COUNT(*) FROM #vis WHERE ScheduledStartUtc >= @todayStart AND ScheduledStartUtc < @todayEnd AND [Status] <> 'CANCELLED') AS TodaysMeetings,
          (SELECT COUNT(*) FROM #vis WHERE ScheduledStartUtc > @now AND ScheduledStartUtc < @weekAhead AND [Status] = 'SCHEDULED') AS UpcomingMeetings, -- "Next 7 days" in the UI
          (SELECT COUNT(*) FROM #vis WHERE ScheduledStartUtc >= @monthStart AND ScheduledStartUtc < @monthEnd AND [Status] <> 'CANCELLED' AND Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL')) AS InternalMeetings,
          (SELECT COUNT(*) FROM #vis WHERE ScheduledStartUtc >= @monthStart AND ScheduledStartUtc < @monthEnd AND [Status] <> 'CANCELLED' AND Category IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL')) AS CustomerMeetings,
          (SELECT COUNT(*) FROM #vis WHERE ScheduledStartUtc >= @monthStart AND ScheduledStartUtc < @monthEnd AND [Status] = 'COMPLETED') AS CompletedMeetings,
          (SELECT COUNT(*) FROM #rec WHERE [Status] = 'COMPLETED') AS TotalRecordings,
          (SELECT COUNT(*) FROM #rec WHERE [Status] IN ('PENDING', 'RECORDING', 'PROCESSING', 'VERIFYING')) AS PendingRecordings;

        SELECT TOP (60) m.PublicId AS Id, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc,
               h.DisplayName AS Organiser, cu.FullName AS CustomerName,
               CAST(CASE WHEN m.RecordingPolicy <> 'NONE' THEN 1 ELSE 0 END AS BIT) AS Recording,
               (SELECT STRING_AGG(COALESCE(e.DisplayName, pc.FullName, p.GuestName), CHAR(31))
                FROM mtg.MeetingParticipants p
                LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
                LEFT JOIN crm.Customers pc ON pc.CustomerId = p.CustomerId
                WHERE p.MeetingId = m.MeetingId) AS Participants,
               CAST(CASE WHEN EXISTS (SELECT 1 FROM mtg.MeetingParticipants mp WHERE mp.MeetingId = m.MeetingId AND mp.EmployeeId = @emp) THEN 1 ELSE 0 END AS BIT) AS Mine
        FROM #vis v
        JOIN mtg.Meetings m ON m.MeetingId = v.MeetingId
        JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
        LEFT JOIN crm.Customers cu ON cu.CustomerId = m.CustomerId
        WHERE (m.ScheduledStartUtc >= @todayStart AND m.ScheduledStartUtc < @todayEnd)
           OR (m.ScheduledEndUtc > @now AND m.[Status] IN ('SCHEDULED', 'LIVE'))
        ORDER BY m.ScheduledStartUtc;

        SELECT TOP (10) a.Id, a.[Type], a.Title, a.Actor, a.AtUtc FROM (
            SELECT CONCAT('m-', CONVERT(VARCHAR(36), m.PublicId)) AS Id, 'MEETING_COMPLETED' AS [Type], m.Title, h.DisplayName AS Actor,
                   COALESCE(m.ActualEndUtc, m.ScheduledEndUtc) AS AtUtc
            FROM #vis v JOIN mtg.Meetings m ON m.MeetingId = v.MeetingId JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
            WHERE m.[Status] = 'COMPLETED' AND COALESCE(m.ActualEndUtc, m.ScheduledEndUtc) >= @weekAgo
            UNION ALL
            SELECT CONCAT('c-', CONVERT(VARCHAR(36), m.PublicId)), 'MEETING_CANCELLED', m.Title, h.DisplayName, COALESCE(m.ModifiedUtc, m.CreatedUtc)
            FROM #vis v JOIN mtg.Meetings m ON m.MeetingId = v.MeetingId JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
            WHERE m.[Status] = 'CANCELLED' AND COALESCE(m.ModifiedUtc, m.CreatedUtc) >= @weekAgo
            UNION ALL
            SELECT CONCAT('r-', CONVERT(VARCHAR(36), r.PublicId)), CASE WHEN r.[Status] = 'COMPLETED' THEN 'RECORDING_READY' ELSE 'RECORDING_FAILED' END,
                   m.Title, 'System', COALESCE(r.VerifiedUtc, r.ModifiedUtc, r.CreatedUtc)
            FROM #rec x JOIN rec.MeetingRecordings r ON r.RecordingId = x.RecordingId JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId
            WHERE r.[Status] IN ('COMPLETED', 'FAILED') AND COALESCE(r.VerifiedUtc, r.ModifiedUtc, r.CreatedUtc) >= @weekAgo
        ) a
        ORDER BY a.AtUtc DESC;

        SELECT TOP (8) d.Name AS Department,
               SUM(CASE WHEN v.Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') THEN 1 ELSE 0 END) AS Internal,
               SUM(CASE WHEN v.Category IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') THEN 1 ELSE 0 END) AS Customer
        FROM #vis v JOIN org.Employees h ON h.EmployeeId = v.HostEmployeeId JOIN org.Departments d ON d.DepartmentId = h.DepartmentId
        WHERE v.ScheduledStartUtc >= @monthStart AND v.ScheduledStartUtc < @monthEnd AND v.[Status] <> 'CANCELLED'
        GROUP BY d.Name
        ORDER BY COUNT(*) DESC;

        SELECT ScheduledStartUtc, [Status] FROM #vis
        WHERE ScheduledStartUtc >= @weekStart AND ScheduledStartUtc < @todayEnd AND [Status] <> 'CANCELLED';

        SELECT ISNULL(SUM(CASE WHEN a.FirstJoin IS NOT NULL AND a.FirstJoin <= DATEADD(MINUTE, 5, m.ScheduledStartUtc) THEN 1 ELSE 0 END), 0) AS Attended,
               ISNULL(SUM(CASE WHEN a.FirstJoin > DATEADD(MINUTE, 5, m.ScheduledStartUtc) THEN 1 ELSE 0 END), 0) AS Late,
               ISNULL(SUM(CASE WHEN a.FirstJoin IS NULL THEN 1 ELSE 0 END), 0) AS Missed
        FROM #vis v
        JOIN mtg.Meetings m ON m.MeetingId = v.MeetingId
        JOIN mtg.MeetingParticipants p ON p.MeetingId = m.MeetingId AND p.ParticipantType = 'EMPLOYEE' AND p.ResponseStatus <> 'DECLINED'
                                       AND (@all = 1 OR p.EmployeeId = @emp)
        OUTER APPLY (SELECT MIN(x.JoinedUtc) AS FirstJoin FROM mtg.MeetingAttendance x WHERE x.ParticipantId = p.ParticipantId) a
        WHERE m.[Status] = 'COMPLETED' AND m.ScheduledStartUtc >= @monthAgo;

        SELECT ISNULL(SUM(CASE WHEN [Status] = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS Completed,
               ISNULL(SUM(CASE WHEN [Status] IN ('RECORDING', 'PROCESSING', 'VERIFYING') THEN 1 ELSE 0 END), 0) AS Processing,
               ISNULL(SUM(CASE WHEN [Status] = 'PENDING' THEN 1 ELSE 0 END), 0) AS Pending,
               ISNULL(SUM(CASE WHEN [Status] = 'FAILED' THEN 1 ELSE 0 END), 0) AS Failed
        FROM #rec;

        DROP TABLE #vis; DROP TABLE #rec;
        """;
}
