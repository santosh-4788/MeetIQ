using System.Globalization;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>GET /api/v1/calendar and /api/v1/account/availability (the signed-in employee's leave, blocked time and working hours).</summary>
public static class CalendarEndpoints
{
    public sealed record AvailabilityInput(string? Type, int? DayOfWeek, string? StartLocalTime, string? EndLocalTime, DateTime? StartUtc, DateTime? EndUtc, string? Reason);

    sealed record CalMeeting(Guid MeetingId, string MeetingCode, string Title, string Category, string Status, DateTime StartUtc, DateTime EndUtc,
        string TimeZoneId, bool IsCustomerMeeting, string RecordingPolicy, Guid EmployeeId, string EmployeeName, string ParticipantRole, string ResponseStatus);
    sealed record CalBlock(Guid Id, string Type, DateTime StartUtc, DateTime EndUtc, string? Reason, Guid EmployeeId, string EmployeeName, long EmployeeRowId);
    sealed record HoursRow(Guid Id, int DayOfWeek, TimeSpan StartLocalTime, TimeSpan EndLocalTime);
    sealed record PeriodRow(Guid Id, string Type, DateTime StartUtc, DateTime EndUtc, string? Reason);

    public static RouteGroupBuilder MapCalendarEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/calendar", Calendar).RequirePermission("calendar.view");

        var a = api.MapGroup("/account/availability").RequirePermission("calendar.view");
        a.MapGet("", ListAvailability);
        a.MapPost("", (AvailabilityInput i, Db db, HttpContext ctx) => SaveAvailability(null, i, db, ctx));
        a.MapPut("/{id:guid}", (Guid id, AvailabilityInput i, Db db, HttpContext ctx) => SaveAvailability(id, i, db, ctx));
        a.MapDelete("/{id:guid}", DeleteAvailability);
        return api;
    }

    // ---- Calendar ----------------------------------------------------------------------------------------------

    static async Task<IResult> Calendar(string? from, string? to, Guid? employeeId, string? department, string? category, bool? includeCancelled,
        Db db, HttpContext ctx, IOptions<MeetingOptions> mo)
    {
        var v = new Validator();
        if (!MeetingEndpoints.TryParseUtc(from, out var f) || f is null) v.Add("from", "Start of the range is required (ISO 8601).");
        if (!MeetingEndpoints.TryParseUtc(to, out var t) || t is null) v.Add("to", "End of the range is required (ISO 8601).");
        if (f is not null && t is not null)
        {
            if (t <= f) v.Add("to", "The end of the range must be after its start.");
            else if ((t.Value - f.Value).TotalDays > mo.Value.MaxCalendarDays) v.Add("to", $"The calendar shows at most {mo.Value.MaxCalendarDays} days at a time.");
        }
        var cat = MeetingEndpoints.Upper(category);
        if (cat is not null && !MeetingEndpoints.Categories.Contains(cat) && cat is not ("CUSTOMER" or "INTERNAL")) v.Add("category", "Unknown meeting category.");
        if (!v.IsValid) return v.Problem();

        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var dept = MeetingEndpoints.Upper(department);
        long[] employees;
        if (employeeId is not null)
        {
            var target = await c.QuerySingleOrDefaultAsync<long?>("SELECT EmployeeId FROM org.Employees WHERE PublicId = @employeeId", new { employeeId });
            if (target is null) return Db_.NotFound("Employee");
            if (target != me.EmployeeId && !me.ViewAll) return Problems.Create(403, "FORBIDDEN", "You can only view your own calendar.");
            employees = [target.Value];
        }
        else if (dept is not null && me.ViewAll)
        {
            employees = (await c.QueryAsync<long>("SELECT e.EmployeeId FROM org.Employees e JOIN org.Departments d ON d.DepartmentId = e.DepartmentId WHERE d.Code = @dept AND e.IsActive = 1", new { dept })).ToArray();
            if (employees.Length == 0 && !await c.ExecuteScalarAsync<bool>("SELECT CAST(COUNT(*) AS BIT) FROM org.Departments WHERE Code = @dept", new { dept })) return Db_.NotFound("Department");
            dept = null; // already applied through the employee list
        }
        else
        {
            if (me.EmployeeId is null) return Problems.Create(400, "VALIDATION", "Your user account is not linked to an employee record, so you have no calendar. Ask an administrator to link your account in Administration → Users & roles (action \"Link to employee\").");
            employees = [me.EmployeeId.Value];
        }
        if (employees.Length == 0) return Results.Ok(new { fromUtc = f, toUtc = t, items = Array.Empty<object>() });

        var self = employees.Length == 1 && employees[0] == me.EmployeeId;
        var prm = new { ids = employees, from = f, to = t, cat, dept, cancelled = includeCancelled == true, emp = me.EmployeeId ?? -1 };
        using var multi = await c.QueryMultipleAsync("""
            SELECT v.MeetingPublicId AS MeetingId, v.MeetingCode, v.Title, v.Category, v.[Status], v.ScheduledStartUtc AS StartUtc, v.ScheduledEndUtc AS EndUtc,
                   v.TimeZoneId, v.IsCustomerMeeting, v.RecordingPolicy, e.PublicId AS EmployeeId, e.DisplayName AS EmployeeName, v.ParticipantRole, v.ResponseStatus
            FROM mtg.vw_MeetingCalendar v JOIN org.Employees e ON e.EmployeeId = v.EmployeeId
            WHERE v.EmployeeId IN @ids AND v.ScheduledStartUtc < @to AND v.ScheduledEndUtc > @from
              AND (v.[Status] <> 'DRAFT' OR v.HostEmployeeId = @emp OR v.CreatedByEmployeeId = @emp)
              AND (@cancelled = 1 OR v.[Status] <> 'CANCELLED')
              AND (@cat IS NULL OR v.Category = @cat OR (@cat = 'CUSTOMER' AND v.IsCustomerMeeting = 1) OR (@cat = 'INTERNAL' AND v.IsCustomerMeeting = 0))
              AND (@dept IS NULL OR v.DepartmentId = (SELECT DepartmentId FROM org.Departments WHERE Code = @dept))
            ORDER BY v.ScheduledStartUtc, e.DisplayName;
            SELECT a.PublicId AS Id, a.[Type], a.StartUtc, a.EndUtc, a.Reason, e.PublicId AS EmployeeId, e.DisplayName AS EmployeeName, e.EmployeeId AS EmployeeRowId
            FROM mtg.EmployeeAvailability a JOIN org.Employees e ON e.EmployeeId = a.EmployeeId
            WHERE a.EmployeeId IN @ids AND a.[Type] IN ('LEAVE', 'BLOCKED') AND a.StartUtc < @to AND a.EndUtc > @from
            ORDER BY a.StartUtc;
            """, prm);
        var meetings = (await multi.ReadAsync<CalMeeting>()).ToList();
        var blocks = (await multi.ReadAsync<CalBlock>()).ToList();
        var items = meetings.Select(m => (m.StartUtc, (object)new
        {
            kind = "MEETING", id = m.MeetingId, meetingCode = m.MeetingCode, title = m.Title, category = m.Category,
            categoryGroup = MeetingEndpoints.CategoryGroup(m.Category), status = m.Status, startUtc = m.StartUtc, endUtc = m.EndUtc, timeZoneId = m.TimeZoneId,
            isCustomerMeeting = m.IsCustomerMeeting, recording = m.RecordingPolicy != "NONE", employeeId = m.EmployeeId, employeeName = m.EmployeeName,
            role = m.ParticipantRole, responseStatus = m.ResponseStatus,
        })).Concat(blocks.Select(b => (b.StartUtc, (object)new
        {
            kind = b.Type, id = b.Id, title = b.Type == "LEAVE" ? "On leave" : "Busy", startUtc = b.StartUtc, endUtc = b.EndUtc,
            reason = b.EmployeeRowId == me.EmployeeId ? b.Reason : null, // other people's reasons stay private
            employeeId = b.EmployeeId, employeeName = b.EmployeeName,
        }))).OrderBy(x => x.StartUtc).Select(x => x.Item2).ToList();
        return Results.Ok(new { fromUtc = f, toUtc = t, self, items });
    }

    // ---- My availability ---------------------------------------------------------------------------------------

    static async Task<IResult> ListAvailability(string? from, Db db, HttpContext ctx, IClock clock)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        if (me.EmployeeId is null) return NoEmployee();
        if (!MeetingEndpoints.TryParseUtc(from, out var f)) { var v = new Validator(); v.Add("from", "Use an ISO 8601 date-time."); return v.Problem(); }
        using var multi = await c.QueryMultipleAsync("""
            SELECT PublicId AS Id, CAST([DayOfWeek] AS INT) AS [DayOfWeek], CAST(StartLocalTime AS TIME(0)) AS StartLocalTime, CAST(EndLocalTime AS TIME(0)) AS EndLocalTime
            FROM mtg.EmployeeAvailability WHERE EmployeeId = @emp AND [Type] = 'WORKING_HOURS' ORDER BY [DayOfWeek], StartLocalTime;
            SELECT PublicId AS Id, [Type], StartUtc, EndUtc, Reason FROM mtg.EmployeeAvailability
            WHERE EmployeeId = @emp AND [Type] IN ('LEAVE', 'BLOCKED') AND EndUtc > @from ORDER BY StartUtc;
            SELECT COALESCE(u.TimeZoneId, 'Asia/Kolkata') FROM auth.Users u WHERE u.UserId = @user;
            """, new { emp = me.EmployeeId, from = f ?? clock.UtcNow.AddDays(-30), user = me.UserId });
        var hours = (await multi.ReadAsync<HoursRow>()).Select(h => new
        {
            id = h.Id, dayOfWeek = h.DayOfWeek, startLocalTime = h.StartLocalTime.ToString(@"hh\:mm", CultureInfo.InvariantCulture),
            endLocalTime = h.EndLocalTime.ToString(@"hh\:mm", CultureInfo.InvariantCulture),
        }).ToList();
        var periods = (await multi.ReadAsync<PeriodRow>()).ToList();
        var tz = await multi.ReadSingleAsync<string>();
        return Results.Ok(new { timeZoneId = tz, workingHours = hours, periods });
    }

    static IResult NoEmployee() => Problems.Create(400, "VALIDATION", "Your user account is not linked to an employee record, so you have no calendar. Ask an administrator to link your account in Administration → Users & roles (action \"Link to employee\").");

    static bool TryTime(string? s, out TimeSpan t) =>
        TimeSpan.TryParseExact(s?.Trim(), [@"hh\:mm", @"h\:mm", @"hh\:mm\:ss"], CultureInfo.InvariantCulture, out t) && t >= TimeSpan.Zero && t < TimeSpan.FromDays(1);

    static async Task<IResult> SaveAvailability(Guid? id, AvailabilityInput i, Db db, HttpContext ctx)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        if (me.EmployeeId is null) return NoEmployee();
        var v = new Validator();
        var type = MeetingEndpoints.Upper(i.Type);
        var reason = v.Optional("reason", i.Reason, 400, "Reason");
        int? day = null; TimeSpan? sl = null, el = null; DateTime? su = null, eu = null;
        if (type == "WORKING_HOURS")
        {
            if (i.DayOfWeek is null or < 0 or > 6) v.Add("dayOfWeek", "Day of week must be 0 (Sunday) to 6 (Saturday).");
            else day = i.DayOfWeek;
            if (!TryTime(i.StartLocalTime, out var s1)) v.Add("startLocalTime", "Enter the start time as HH:mm.");
            else sl = s1;
            if (!TryTime(i.EndLocalTime, out var e1)) v.Add("endLocalTime", "Enter the end time as HH:mm.");
            else el = e1;
            if (sl is not null && el is not null && el <= sl) v.Add("endLocalTime", "Working hours must end after they start.");
            if (i.StartUtc is not null || i.EndUtc is not null) v.Add("startUtc", "Working hours use local times only (startLocalTime, endLocalTime).");
        }
        else if (type is "LEAVE" or "BLOCKED")
        {
            if (i.StartUtc is null) v.Add("startUtc", "Start is required.");
            if (i.EndUtc is null) v.Add("endUtc", "End is required.");
            if (i.StartUtc is not null && i.EndUtc is not null)
            {
                su = DateTime.SpecifyKind(i.StartUtc.Value, DateTimeKind.Utc);
                eu = DateTime.SpecifyKind(i.EndUtc.Value, DateTimeKind.Utc);
                if (eu <= su) v.Add("endUtc", "The period must end after it starts.");
                else if ((eu.Value - su.Value).TotalDays > 366) v.Add("endUtc", "A single period can last at most one year.");
            }
            if (i.DayOfWeek is not null) v.Add("dayOfWeek", "Leave and blocked time use UTC start and end only.");
        }
        else v.Add("type", "Type must be WORKING_HOURS, LEAVE or BLOCKED.");
        if (!v.IsValid) return v.Problem();

        var p = new { id, emp = me.EmployeeId, type, day, sl, el, su, eu, reason, user = me.UserId };
        using var tx = c.BeginTransaction();
        Guid publicId;
        if (id is null)
            publicId = await c.QuerySingleAsync<Guid>("""
                INSERT mtg.EmployeeAvailability (EmployeeId, [Type], [DayOfWeek], StartLocalTime, EndLocalTime, StartUtc, EndUtc, Reason, CreatedByUserId)
                OUTPUT inserted.PublicId VALUES (@emp, @type, @day, @sl, @el, @su, @eu, @reason, @user)
                """, p, tx);
        else
        {
            var n = await c.ExecuteAsync("""
                UPDATE mtg.EmployeeAvailability SET [Type] = @type, [DayOfWeek] = @day, StartLocalTime = @sl, EndLocalTime = @el, StartUtc = @su, EndUtc = @eu,
                    Reason = @reason, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                WHERE PublicId = @id AND EmployeeId = @emp
                """, p, tx);
            if (n == 0) { tx.Rollback(); return Db_.NotFound("Availability entry"); }
            publicId = id.Value;
        }
        await Audit.WriteAsync(c, "USER", me.UserId, id is null ? "AVAILABILITY_CREATED" : "AVAILABILITY_UPDATED", "EmployeeAvailability", publicId.ToString(),
            $"{type} {(id is null ? "added" : "updated")}", ClientInfo.From(ctx).Ip, tx,
            newValues: new { type, dayOfWeek = day, startLocalTime = sl?.ToString(@"hh\:mm", CultureInfo.InvariantCulture), endLocalTime = el?.ToString(@"hh\:mm", CultureInfo.InvariantCulture), startUtc = su, endUtc = eu });
        tx.Commit();
        return id is null ? Results.Json(new { id = publicId }, statusCode: 201) : Results.NoContent();
    }

    static async Task<IResult> DeleteAvailability(Guid id, Db db, HttpContext ctx)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        if (me.EmployeeId is null) return NoEmployee();
        using var tx = c.BeginTransaction();
        var type = await c.QuerySingleOrDefaultAsync<string>("DELETE mtg.EmployeeAvailability OUTPUT deleted.[Type] WHERE PublicId = @id AND EmployeeId = @emp", new { id, emp = me.EmployeeId }, tx);
        if (type is null) { tx.Rollback(); return Db_.NotFound("Availability entry"); }
        await Audit.WriteAsync(c, "USER", me.UserId, "AVAILABILITY_DELETED", "EmployeeAvailability", id.ToString(), $"{type} removed", ClientInfo.From(ctx).Ip, tx);
        tx.Commit();
        return Results.NoContent();
    }
}
