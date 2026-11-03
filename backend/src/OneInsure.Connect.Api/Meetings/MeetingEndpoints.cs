using System.Data;
using System.Globalization;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// /api/v1/meetings/* — scheduling, double-booking prevention, RSVP and participants. Meetings are addressed by PublicId.
/// Visibility: host, creator, participant (not for drafts) or meetings.view.all; anything else is 404.
/// </summary>
public static class MeetingEndpoints
{
    public sealed record GuestInput(string? Name, string? Email);
    public sealed record MeetingInput(string? Title, string? Description, string? Agenda, string? Category, DateTime? StartUtc, DateTime? EndUtc,
        string? TimeZoneId, Guid? HostEmployeeId, Guid[]? EmployeeIds, Guid? CustomerId, GuestInput[]? Guests, string? RecordingPolicy,
        bool? WaitingRoomEnabled, string? Status, string? Purpose, string? PolicyNumber, bool OverrideConflicts, string? OverrideReason);
    public sealed record MeetingUpdateInput(string? Title, string? Description, string? Agenda, string? Category, DateTime? StartUtc, DateTime? EndUtc,
        string? TimeZoneId, string? RecordingPolicy, bool? WaitingRoomEnabled, string? Status, string? Purpose, string? PolicyNumber,
        bool OverrideConflicts, string? OverrideReason);
    public sealed record CancelInput(string? Reason);
    public sealed record RespondInput(string? Response);
    public sealed record AddParticipantsInput(Guid[]? EmployeeIds, GuestInput[]? Guests, bool OverrideConflicts, string? OverrideReason);
    public sealed record AvailabilityInput(Guid[]? EmployeeIds, DateTime? StartUtc, DateTime? EndUtc, Guid? ExcludeMeetingId);

    internal static readonly string[] Categories = ["INTERNAL_1_1", "GROUP", "TEAM", "DEPARTMENT", "MANAGEMENT", "TRAINING", "REVIEW", "CUSTOMER_PLVC", "CUSTOMER_GENERAL"];
    static readonly string[] RecordingPolicies = ["NONE", "OPTIONAL", "REQUIRED"];
    const int MaxEmployees = 100, MaxGuests = 20;

    internal static bool IsCustomerCategory(string? c) => c is "CUSTOMER_PLVC" or "CUSTOMER_GENERAL";

    /// <summary>Same grouping as the dashboard's MeetingSummary.category (frontend/src/api/types.ts).</summary>
    internal static string CategoryGroup(string c) => c switch
    {
        "CUSTOMER_PLVC" or "CUSTOMER_GENERAL" => "CUSTOMER",
        "TRAINING" => "TRAINING",
        "REVIEW" => "REVIEW",
        "MANAGEMENT" => "MANAGEMENT",
        _ => "INTERNAL",
    };

    /// <summary>SQL predicate: may the actor (@emp, @all) see meeting m?</summary>
    internal const string Visible = """
        (@all = 1 OR m.HostEmployeeId = @emp OR m.CreatedByEmployeeId = @emp
         OR (m.[Status] <> 'DRAFT' AND EXISTS (SELECT 1 FROM mtg.MeetingParticipants vp WHERE vp.MeetingId = m.MeetingId AND vp.EmployeeId = @emp)))
        """;

    sealed record MeetingRow(long MeetingId, Guid PublicId, string Status, string Category, long HostEmployeeId, long CreatedByEmployeeId,
        DateTime StartUtc, DateTime EndUtc, int ScheduleVersion, long? CustomerId, string TimeZoneId);

    static async Task<MeetingRow?> FindVisibleAsync(IDbConnection c, Guid id, Actor me, IDbTransaction? tx = null) =>
        await c.QuerySingleOrDefaultAsync<MeetingRow>($"""
            SELECT m.MeetingId, m.PublicId, m.[Status], m.Category, m.HostEmployeeId, m.CreatedByEmployeeId, m.ScheduledStartUtc AS StartUtc,
                   m.ScheduledEndUtc AS EndUtc, m.ScheduleVersion, m.CustomerId, m.TimeZoneId
            FROM mtg.Meetings m WHERE m.PublicId = @id AND {Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll }, tx);

    static bool CanEdit(MeetingRow m, Actor me) => me.ViewAll || m.HostEmployeeId == me.EmployeeId || m.CreatedByEmployeeId == me.EmployeeId;

    static IResult NoEmployee() => Problems.Create(400, "VALIDATION",
        "Your user account is not linked to an employee record, so you cannot schedule meetings. Ask an administrator to link your account to your employee record in Administration → Users & roles (action \"Link to employee\").");
    static IResult MeetingNotFound() => Db_.NotFound("Meeting");
    static IResult NotEditable() => Problems.Create(403, "FORBIDDEN", "Only the host, the organiser or an administrator can change this meeting.");
    static IResult ConflictResult(List<ConflictDto> conflicts) => Problems.Create(409, "CONFLICT",
        "One or more participants are not available at this time.", new Dictionary<string, object?> { ["conflicts"] = conflicts });

    public static RouteGroupBuilder MapMeetingEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/meetings");

        g.MapGet("", List).RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapGet("/{id:guid}", Get).RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapPost("", Create).RequirePermission("meetings.create");
        g.MapPut("/{id:guid}", Update).RequirePermission("meetings.create");
        g.MapPost("/{id:guid}/cancel", Cancel).RequirePermission("meetings.create");
        g.MapPost("/{id:guid}/respond", Respond).RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapPost("/{id:guid}/participants", AddParticipants).RequirePermission("meetings.create");
        g.MapDelete("/{id:guid}/participants/{participantId}", RemoveParticipant).RequirePermission("meetings.create");
        g.MapPost("/availability", Availability).RequirePermission("meetings.create");
        return api;
    }

    // ---- Validation helpers ------------------------------------------------------------------------------------

    internal static string? Upper(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().ToUpperInvariant();

    static void ValidateTimes(Validator v, DateTime? start, DateTime? end, bool allowPast, DateTime now, MeetingOptions o)
    {
        if (start is null) v.Add("startUtc", "Start time is required.");
        if (end is null) v.Add("endUtc", "End time is required.");
        if (start is null || end is null) return;
        if (end <= start) v.Add("endUtc", "The meeting must end after it starts.");
        else if (end.Value - start.Value > TimeSpan.FromHours(o.MaxDurationHours)) v.Add("endUtc", $"A meeting can last at most {o.MaxDurationHours} hours.");
        if (!allowPast && start < now.AddMinutes(-1)) v.Add("startUtc", "The start time is in the past. Choose a future time.");
        if (start.Value.Year < 2000 || start.Value > now.AddYears(2)) v.Add("startUtc", "Choose a start date within the next two years.");
    }

    static string? ValidateZone(Validator v, string? tz, MeetingOptions o)
    {
        var z = string.IsNullOrWhiteSpace(tz) ? o.DefaultTimeZone : tz.Trim();
        if (z.Length > 64 || !Zones.IsValid(z)) { v.Add("timeZoneId", "Unknown time zone. Use an IANA name such as Asia/Kolkata."); return null; }
        return z;
    }

    static List<(string Name, string Email)> ValidateGuests(Validator v, GuestInput[]? guests)
    {
        var list = new List<(string, string)>();
        if (guests is null) return list;
        if (guests.Length > MaxGuests) { v.Add("guests", $"At most {MaxGuests} guests can be invited."); return list; }
        for (var i = 0; i < guests.Length; i++)
        {
            var name = v.Required($"guests[{i}].name", guests[i].Name, 200, "Guest name");
            var email = v.Email($"guests[{i}].email", guests[i].Email, "Guest e-mail");
            if (name is not null && email is not null)
            {
                if (list.Any(x => x.Item2 == email)) v.Add($"guests[{i}].email", "This guest is listed twice.");
                else list.Add((name, email));
            }
        }
        return list;
    }

    sealed record EmpRef(long EmployeeId, Guid PublicId, long DepartmentId);
    sealed record CustomerPick(long CustomerId, string? PolicyNumber);
    sealed record MyParticipant(long ParticipantId, string Role, string ResponseStatus);
    sealed record RemovableParticipant(long ParticipantId, string Type, string Role, bool HasHistory);

    /// <summary>
    /// A colleague typed in as a "guest" (by e-mail) is added as an employee participant instead, so the meeting appears in
    /// their portal, calendar and notifications. Matches an active employee's official e-mail or a linked login's e-mail.
    /// </summary>
    static async Task<(List<EmpRef> Employees, List<(string Name, string Email)> Guests)> PromoteEmployeeGuests(
        IDbConnection c, List<EmpRef> employees, List<(string Name, string Email)> guests)
    {
        if (guests.Count == 0) return (employees, guests);
        var emails = guests.Select(g => g.Email).ToArray();
        var matches = (await c.QueryAsync<(long EmployeeId, Guid PublicId, long DepartmentId, string Email)>("""
            SELECT e.EmployeeId, e.PublicId, e.DepartmentId, e.OfficialEmail FROM org.Employees e WHERE e.IsActive = 1 AND e.OfficialEmail IN @emails
            UNION
            SELECT e.EmployeeId, e.PublicId, e.DepartmentId, u.Email FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE e.IsActive = 1 AND u.Email IN @emails
            """, new { emails })).ToList();
        if (matches.Count == 0) return (employees, guests);
        var all = employees.ToList();
        foreach (var m in matches.Where(m => all.All(e => e.EmployeeId != m.EmployeeId)))
            all.Add(new EmpRef(m.EmployeeId, m.PublicId, m.DepartmentId));
        var rest = guests.Where(g => !matches.Any(m => string.Equals(m.Email, g.Email, StringComparison.OrdinalIgnoreCase))).ToList();
        return (all, rest);
    }

    static async Task<List<EmpRef>?> ResolveEmployees(IDbConnection c, Guid[]? ids, Validator v, string field)
    {
        var distinct = (ids ?? []).Distinct().ToArray();
        if (distinct.Length > MaxEmployees) { v.Add(field, $"At most {MaxEmployees} employees can be invited."); return null; }
        if (distinct.Length == 0) return [];
        var rows = (await c.QueryAsync<EmpRef>("SELECT EmployeeId, PublicId, DepartmentId FROM org.Employees WHERE IsActive = 1 AND PublicId IN @distinct", new { distinct })).ToList();
        if (rows.Count != distinct.Length) { v.Add(field, "One or more selected employees were not found or are no longer active."); return null; }
        return rows;
    }

    /// <summary>
    /// Runs a booking transaction (SERIALIZABLE, see AvailabilityCheck). A deadlock victim or a calendar-lock timeout is retried
    /// twice; the work is idempotent because the whole transaction rolled back.
    /// </summary>
    static async Task<IResult> Booking(IDbConnection c, bool serializable, Func<IDbTransaction, Task<IResult>> work)
    {
        for (var attempt = 1; ; attempt++)
        {
            using var tx = c.BeginTransaction(serializable ? IsolationLevel.Serializable : IsolationLevel.ReadCommitted);
            try
            {
                var result = await work(tx);
                if (tx.Connection is not null) tx.Commit(); // work() rolls back itself when it returns an error
                return result;
            }
            catch (SqlException e) when ((e.Number == 1205 || e.Number == 51012) && attempt < 3)
            {
                try { tx.Rollback(); } catch (InvalidOperationException) { } // already rolled back by the server
                await Task.Delay(50 * attempt);
            }
            finally
            {
                // The isolation level outlives the transaction on this (pooled) connection: restore the default.
                if (serializable && tx.Connection is null && c.State == ConnectionState.Open) await c.ExecuteAsync("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
            }
        }
    }

    sealed record ParticipantInsert(long MeetingId, string Type, long? EmployeeId, long? CustomerId, string? GuestName, string? GuestEmail,
        string Role, string Response, string Identity, bool CanScreenShare, long UserId);

    static Task InsertParticipants(IDbConnection c, IDbTransaction tx, IEnumerable<ParticipantInsert> rows) =>
        c.ExecuteAsync("""
            INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, CustomerId, GuestName, GuestEmail, [Role], ResponseStatus, LiveKitIdentity, CanScreenShare, CreatedByUserId)
            VALUES (@MeetingId, @Type, @EmployeeId, @CustomerId, @GuestName, @GuestEmail, @Role, @Response, @Identity, @CanScreenShare, @UserId)
            """, rows, tx);

    static ParticipantInsert Employee(long meetingId, long employeeId, string role, long userId) =>
        new(meetingId, "EMPLOYEE", employeeId, null, null, null, role, role == "HOST" ? "ACCEPTED" : "PENDING", MeetingMessaging.NewOpaqueId("p_", 12), true, userId);

    static ParticipantInsert Guest(long meetingId, (string Name, string Email) g, long userId) =>
        new(meetingId, "GUEST", null, null, g.Name, g.Email, "ATTENDEE", "PENDING", MeetingMessaging.NewOpaqueId("p_", 12), false, userId);

    // ---- Create ------------------------------------------------------------------------------------------------

    static async Task<IResult> Create(MeetingInput i, Db db, HttpContext ctx, MeetingMessaging msg, IClock clock, IOptions<MeetingOptions> mo)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        if (me.EmployeeId is null) return NoEmployee();
        var now = clock.UtcNow;
        var o = mo.Value;

        var v = new Validator();
        var title = v.Required("title", i.Title, 200, "Title");
        var description = v.Optional("description", i.Description, 2000, "Description");
        var agenda = v.Optional("agenda", i.Agenda, 4000, "Agenda");
        var purpose = v.Optional("purpose", i.Purpose, 200, "Purpose");
        var policyNumber = v.Optional("policyNumber", i.PolicyNumber, 50, "Policy number");
        var category = Upper(i.Category);
        if (category is null) v.Add("category", "Category is required.");
        else if (!Categories.Contains(category)) v.Add("category", "Unknown meeting category.");
        var status = Upper(i.Status) ?? "SCHEDULED";
        if (status is not ("DRAFT" or "SCHEDULED")) v.Add("status", "A new meeting is either DRAFT or SCHEDULED.");
        ValidateTimes(v, i.StartUtc, i.EndUtc, allowPast: status == "DRAFT", now, o);
        var tz = ValidateZone(v, i.TimeZoneId, o);
        var recording = Upper(i.RecordingPolicy) ?? "NONE";
        if (!RecordingPolicies.Contains(recording)) v.Add("recordingPolicy", "Recording policy must be NONE, OPTIONAL or REQUIRED.");
        var guests = ValidateGuests(v, i.Guests);
        var overrideReason = v.Optional("overrideReason", i.OverrideReason, 500, "Override reason");
        if (i.OverrideConflicts && overrideReason is null && me.Override) v.Add("overrideReason", "Give a reason for booking despite the conflict.");
        if (!v.IsValid) return v.Problem();

        var isCustomer = IsCustomerCategory(category);
        if (isCustomer && !me.Customers) return Problems.Create(403, "FORBIDDEN", "You do not have permission to schedule customer meetings.");
        if (i.OverrideConflicts && !me.Override) return Problems.Create(403, "FORBIDDEN", "You do not have permission to override calendar conflicts.");

        long hostId = me.EmployeeId.Value;
        long hostDept;
        if (i.HostEmployeeId is { } hostPublic)
        {
            var h = await c.QuerySingleOrDefaultAsync<EmpRef>("SELECT EmployeeId, PublicId, DepartmentId FROM org.Employees WHERE PublicId = @hostPublic AND IsActive = 1", new { hostPublic });
            if (h is null) { v.Add("hostEmployeeId", "The selected host was not found or is no longer active."); return v.Problem(); }
            (hostId, hostDept) = (h.EmployeeId, h.DepartmentId);
        }
        else hostDept = await c.ExecuteScalarAsync<long>("SELECT DepartmentId FROM org.Employees WHERE EmployeeId = @hostId", new { hostId });
        var employees = await ResolveEmployees(c, i.EmployeeIds, v, "employeeIds");
        CustomerPick? customer = null;
        if (isCustomer)
        {
            if (i.CustomerId is null) v.Add("customerId", "Select the customer for a customer meeting.");
            else
            {
                customer = await c.QuerySingleOrDefaultAsync<CustomerPick>("SELECT CustomerId, PolicyNumber FROM crm.Customers WHERE PublicId = @id AND IsActive = 1", new { id = i.CustomerId });
                if (customer is null) v.Add("customerId", "The selected customer was not found or is inactive.");
            }
        }
        else if (i.CustomerId is not null) v.Add("customerId", "Only customer meetings (CUSTOMER_PLVC, CUSTOMER_GENERAL) can include a customer.");
        if (!v.IsValid || employees is null) return v.Problem();
        (employees, guests) = await PromoteEmployeeGuests(c, employees, guests);

        var employeeIds = new List<long> { hostId, me.EmployeeId.Value };
        employeeIds.AddRange(employees.Select(e => e.EmployeeId));
        employeeIds = employeeIds.Distinct().ToList();
        var start = DateTime.SpecifyKind(i.StartUtc!.Value, DateTimeKind.Utc);
        var end = DateTime.SpecifyKind(i.EndUtc!.Value, DateTimeKind.Utc);
        var scheduled = status == "SCHEDULED";

        return await Booking(c, scheduled, async tx =>
        {
            var warnings = new List<ConflictDto>();
            List<ConflictDto> conflicts = [];
            if (scheduled)
            {
                var check = await AvailabilityCheck.RunAsync(c, tx, employeeIds, start, end, null, lockCalendars: true);
                (conflicts, warnings) = (check.Conflicts, check.Warnings);
                if (conflicts.Count > 0 && !i.OverrideConflicts) { tx.Rollback(); return ConflictResult(conflicts); }
            }

            long meetingId = 0;
            Guid publicId = default;
            string code = "";
            for (var attempt = 0; meetingId == 0; attempt++)
            {
                code = MeetingMessaging.NewMeetingCode(now);
                try
                {
                    (meetingId, publicId) = await c.QuerySingleAsync<(long, Guid)>("""
                        INSERT mtg.Meetings (MeetingCode, Title, Description, Agenda, Category, CreatedByEmployeeId, HostEmployeeId, DepartmentId, CustomerId,
                            PolicyNumber, Purpose, ScheduledStartUtc, ScheduledEndUtc, TimeZoneId, [Status], RecordingPolicy, WaitingRoomEnabled, LiveKitRoomName,
                            OverrideConflictReason, CreatedByUserId)
                        OUTPUT inserted.MeetingId, inserted.PublicId
                        VALUES (@code, @title, @description, @agenda, @category, @creator, @hostId, @hostDept, @customerId, @policyNumber, @purpose, @start, @end,
                            @tz, @status, @recording, @waiting, @room, @overrideNote, @user)
                        """, new
                    {
                        code, title, description, agenda, category, creator = me.EmployeeId, hostId, hostDept, customerId = customer?.CustomerId,
                        policyNumber = policyNumber ?? customer?.PolicyNumber, purpose, start, end, tz, status, recording, waiting = i.WaitingRoomEnabled ?? true,
                        room = MeetingMessaging.NewOpaqueId("oic_", 16), overrideNote = conflicts.Count > 0 ? overrideReason : null, user = me.UserId,
                    }, tx);
                }
                catch (SqlException e) when (e.IsUniqueViolation() && e.Message.Contains("MeetingCode") && attempt < 5) { }
            }

            var rows = new List<ParticipantInsert> { Employee(meetingId, hostId, "HOST", me.UserId) };
            if (me.EmployeeId.Value != hostId) rows.Add(Employee(meetingId, me.EmployeeId.Value, "HOST", me.UserId));
            rows.AddRange(employees.Where(e => e.EmployeeId != hostId && e.EmployeeId != me.EmployeeId).Select(e => Employee(meetingId, e.EmployeeId, "ATTENDEE", me.UserId)));
            if (customer is not null)
                rows.Add(new(meetingId, "CUSTOMER", null, customer.CustomerId, null, null, "ATTENDEE", "PENDING", MeetingMessaging.NewOpaqueId("p_", 12), false, me.UserId));
            rows.AddRange(guests.Select(gu => Guest(meetingId, gu, me.UserId)));
            await InsertParticipants(c, tx, rows);

            if (scheduled)
            {
                var info = await MeetingMessaging.LoadAsync(c, tx, meetingId);
                var recipients = await MeetingMessaging.RecipientsAsync(c, tx, meetingId);
                await msg.SendAsync(c, tx, info, recipients, MessageKind.Invited, me.UserId);
                await msg.ScheduleRemindersAsync(c, tx, info, recipients);
            }
            var ip = ClientInfo.From(ctx).Ip;
            await Audit.WriteAsync(c, "USER", me.UserId, scheduled ? "MEETING_SCHEDULED" : "MEETING_DRAFT_CREATED", "Meeting", publicId.ToString(),
                $"Meeting {code} {(scheduled ? "scheduled" : "saved as draft")}", ip, tx, newValues: new
                {
                    meetingCode = code, title, category, status, startUtc = start, endUtc = end, timeZoneId = tz, recordingPolicy = recording,
                    employees = rows.Count(r => r.Type == "EMPLOYEE"), customer = customer is not null, guests = guests.Count,
                });
            if (conflicts.Count > 0)
                await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_CONFLICT_OVERRIDDEN", "Meeting", publicId.ToString(),
                    $"Booked despite {conflicts.Count} calendar conflict(s)", ip, tx, privileged: true,
                    newValues: new { reason = overrideReason, conflicts = conflicts.Select(x => new { employeeId = x.EmployeeId, x.Type, x.StartUtc, x.EndUtc }) });
            return Results.Json(new { id = publicId, meetingCode = code, status, warnings, overriddenConflicts = conflicts.Count }, statusCode: 201);
        });
    }

    // ---- Update / reschedule -----------------------------------------------------------------------------------

    static async Task<IResult> Update(Guid id, MeetingUpdateInput i, Db db, HttpContext ctx, MeetingMessaging msg, IClock clock, IOptions<MeetingOptions> mo)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await FindVisibleAsync(c, id, me);
        if (m is null) return MeetingNotFound();
        if (!CanEdit(m, me)) return NotEditable();
        if (IsCustomerCategory(m.Category) && !me.Customers) return Problems.Create(403, "FORBIDDEN", "You do not have permission to manage customer meetings.");
        if (m.Status is not ("DRAFT" or "SCHEDULED")) return Db_.Conflict("This meeting can no longer be changed.");
        var now = clock.UtcNow;
        var o = mo.Value;

        var v = new Validator();
        var title = v.Required("title", i.Title, 200, "Title");
        var description = v.Optional("description", i.Description, 2000, "Description");
        var agenda = v.Optional("agenda", i.Agenda, 4000, "Agenda");
        var purpose = v.Optional("purpose", i.Purpose, 200, "Purpose");
        var policyNumber = v.Optional("policyNumber", i.PolicyNumber, 50, "Policy number");
        var category = Upper(i.Category) ?? m.Category;
        if (!Categories.Contains(category)) v.Add("category", "Unknown meeting category.");
        else if (IsCustomerCategory(category) != IsCustomerCategory(m.Category))
            v.Add("category", "A customer meeting cannot become an internal meeting (or the other way round). Cancel it and create a new one.");
        var status = Upper(i.Status) ?? m.Status;
        if (status is not ("DRAFT" or "SCHEDULED")) v.Add("status", "Status must be DRAFT or SCHEDULED. Use cancel to cancel a meeting.");
        else if (m.Status == "SCHEDULED" && status == "DRAFT") v.Add("status", "A scheduled meeting cannot go back to draft.");
        var start = i.StartUtc is null ? (DateTime?)null : DateTime.SpecifyKind(i.StartUtc.Value, DateTimeKind.Utc);
        var end = i.EndUtc is null ? (DateTime?)null : DateTime.SpecifyKind(i.EndUtc.Value, DateTimeKind.Utc);
        var timeChanged = start != m.StartUtc || end != m.EndUtc;
        var scheduling = status == "SCHEDULED" && (m.Status == "DRAFT" || timeChanged);
        ValidateTimes(v, start, end, allowPast: !scheduling, now, o);
        var tz = ValidateZone(v, i.TimeZoneId ?? m.TimeZoneId, o);
        var recording = Upper(i.RecordingPolicy);
        if (recording is not null && !RecordingPolicies.Contains(recording)) v.Add("recordingPolicy", "Recording policy must be NONE, OPTIONAL or REQUIRED.");
        var overrideReason = v.Optional("overrideReason", i.OverrideReason, 500, "Override reason");
        if (i.OverrideConflicts && overrideReason is null && me.Override) v.Add("overrideReason", "Give a reason for booking despite the conflict.");
        if (!v.IsValid) return v.Problem();
        if (i.OverrideConflicts && !me.Override) return Problems.Create(403, "FORBIDDEN", "You do not have permission to override calendar conflicts.");

        var rescheduled = m.Status == "SCHEDULED" && timeChanged;
        return await Booking(c, scheduling, async tx =>
        {
            List<ConflictDto> conflicts = [], warnings = [];
            if (scheduling)
            {
                var employeeIds = (await c.QueryAsync<long>(
                    "SELECT EmployeeId FROM mtg.MeetingParticipants WHERE MeetingId = @id AND EmployeeId IS NOT NULL AND (ResponseStatus <> 'DECLINED' OR @reset = 1)",
                    new { id = m.MeetingId, reset = rescheduled }, tx)).ToList();
                var check = await AvailabilityCheck.RunAsync(c, tx, employeeIds, start!.Value, end!.Value, m.MeetingId, lockCalendars: true);
                (conflicts, warnings) = (check.Conflicts, check.Warnings);
                if (conflicts.Count > 0 && !i.OverrideConflicts) { tx.Rollback(); return ConflictResult(conflicts); }
            }
            var n = await c.ExecuteAsync("""
                UPDATE mtg.Meetings SET Title = @title, Description = @description, Agenda = @agenda, Category = @category, Purpose = @purpose,
                    PolicyNumber = COALESCE(@policyNumber, PolicyNumber), ScheduledStartUtc = @start, ScheduledEndUtc = @end, TimeZoneId = @tz, [Status] = @status,
                    RecordingPolicy = COALESCE(@recording, RecordingPolicy), WaitingRoomEnabled = COALESCE(@waiting, WaitingRoomEnabled),
                    ScheduleVersion = ScheduleVersion + @bump, OverrideConflictReason = CASE WHEN @overrideNote IS NULL THEN OverrideConflictReason ELSE @overrideNote END,
                    ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                WHERE MeetingId = @id AND [Status] = @oldStatus
                """, new
            {
                title, description, agenda, category, purpose, policyNumber, start, end, tz, status, recording, waiting = i.WaitingRoomEnabled,
                bump = rescheduled ? 1 : 0, overrideNote = conflicts.Count > 0 ? overrideReason : null, user = me.UserId, id = m.MeetingId, oldStatus = m.Status,
            }, tx);
            if (n == 0) { tx.Rollback(); return Db_.Conflict("The meeting was changed by someone else. Reload and try again."); }

            if (rescheduled)
            {
                // New time: attendees answer again; old reminders and join links stop working.
                await c.ExecuteAsync("UPDATE mtg.MeetingParticipants SET ResponseStatus = 'PENDING', ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE MeetingId = @id AND [Role] = 'ATTENDEE'",
                    new { id = m.MeetingId, user = me.UserId }, tx);
                await MeetingMessaging.CancelRemindersAsync(c, tx, m.MeetingId);
            }
            if (scheduling)
            {
                var info = await MeetingMessaging.LoadAsync(c, tx, m.MeetingId);
                var recipients = await MeetingMessaging.RecipientsAsync(c, tx, m.MeetingId);
                await msg.SendAsync(c, tx, info, recipients, rescheduled ? MessageKind.Rescheduled : MessageKind.Invited, me.UserId);
                await msg.ScheduleRemindersAsync(c, tx, info, recipients);
            }
            var ip = ClientInfo.From(ctx).Ip;
            var action = rescheduled ? "MEETING_RESCHEDULED" : scheduling ? "MEETING_SCHEDULED" : "MEETING_UPDATED";
            await Audit.WriteAsync(c, "USER", me.UserId, action, "Meeting", id.ToString(), action switch
            {
                "MEETING_RESCHEDULED" => "Meeting rescheduled",
                "MEETING_SCHEDULED" => "Draft meeting scheduled",
                _ => "Meeting details updated",
            }, ip, tx, newValues: new { title, category, status, startUtc = start, endUtc = end, timeZoneId = tz, recordingPolicy = recording, i.WaitingRoomEnabled });
            if (conflicts.Count > 0)
                await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_CONFLICT_OVERRIDDEN", "Meeting", id.ToString(),
                    $"Booked despite {conflicts.Count} calendar conflict(s)", ip, tx, privileged: true,
                    newValues: new { reason = overrideReason, conflicts = conflicts.Select(x => new { employeeId = x.EmployeeId, x.Type, x.StartUtc, x.EndUtc }) });
            return Results.Ok(new { id, status, rescheduled, warnings, overriddenConflicts = conflicts.Count });
        });
    }

    // ---- Cancel ------------------------------------------------------------------------------------------------

    static async Task<IResult> Cancel(Guid id, CancelInput input, Db db, HttpContext ctx, MeetingMessaging msg)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await FindVisibleAsync(c, id, me);
        if (m is null) return MeetingNotFound();
        if (!CanEdit(m, me)) return NotEditable();
        if (m.Status is not ("DRAFT" or "SCHEDULED")) return Db_.Conflict("Only draft or scheduled meetings can be cancelled.");
        var v = new Validator();
        var reason = v.Required("reason", input.Reason, 500, "Reason");
        if (!v.IsValid) return v.Problem();

        using var tx = c.BeginTransaction();
        var n = await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET [Status] = 'CANCELLED', CancelReason = @reason, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
            WHERE MeetingId = @id AND [Status] = @old
            """, new { reason, user = me.UserId, id = m.MeetingId, old = m.Status }, tx);
        if (n == 0) { tx.Rollback(); return Db_.Conflict("The meeting was changed by someone else. Reload and try again."); }
        await MeetingMessaging.CancelRemindersAsync(c, tx, m.MeetingId);
        if (m.Status == "SCHEDULED")
        {
            var info = await MeetingMessaging.LoadAsync(c, tx, m.MeetingId);
            await msg.SendAsync(c, tx, info, await MeetingMessaging.RecipientsAsync(c, tx, m.MeetingId), MessageKind.Cancelled, me.UserId);
        }
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_CANCELLED", "Meeting", id.ToString(), "Meeting cancelled", ClientInfo.From(ctx).Ip, tx, newValues: new { reason });
        tx.Commit();
        return Results.NoContent();
    }

    // ---- RSVP --------------------------------------------------------------------------------------------------

    static async Task<IResult> Respond(Guid id, RespondInput input, Db db, HttpContext ctx)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await FindVisibleAsync(c, id, me);
        if (m is null) return MeetingNotFound();
        var response = Upper(input.Response);
        if (response is not ("ACCEPTED" or "DECLINED" or "TENTATIVE"))
        {
            var v = new Validator();
            v.Add("response", "Answer ACCEPTED, DECLINED or TENTATIVE.");
            return v.Problem();
        }
        var p = me.EmployeeId is null ? null : await c.QuerySingleOrDefaultAsync<MyParticipant>(
            "SELECT ParticipantId, [Role], ResponseStatus FROM mtg.MeetingParticipants WHERE MeetingId = @m AND EmployeeId = @e", new { m = m.MeetingId, e = me.EmployeeId });
        if (p is null) return Problems.Create(400, "VALIDATION", "You are not a participant in this meeting.");
        if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("You can only respond to a scheduled meeting.");
        if (p.Role == "HOST" && response == "DECLINED") return Problems.Create(400, "VALIDATION", "The host cannot decline. Cancel the meeting or hand it over instead.");
        if (p.ResponseStatus == response) return Results.NoContent();

        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("UPDATE mtg.MeetingParticipants SET ResponseStatus = @response, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE ParticipantId = @pid",
            new { response, user = me.UserId, pid = p.ParticipantId }, tx);
        if (response == "DECLINED")
            await MeetingMessaging.CancelRemindersAsync(c, tx, m.MeetingId, p.ParticipantId);
        else // re-accepting brings back the reminders of the current schedule that are still ahead
            await c.ExecuteAsync("""
                UPDATE mtg.MeetingReminders SET [Status] = 'PENDING', Attempts = 0, NextAttemptUtc = NULL, LastError = NULL
                WHERE ParticipantId = @pid AND ScheduleVersion = @v AND [Status] = 'CANCELLED' AND SentUtc IS NULL AND DueUtc > SYSUTCDATETIME()
                """, new { pid = p.ParticipantId, v = m.ScheduleVersion }, tx);
        var hostUser = await c.QuerySingleOrDefaultAsync<long?>("SELECT UserId FROM auth.Users WHERE EmployeeId = @h AND IsActive = 1", new { h = m.HostEmployeeId }, tx);
        if (hostUser is not null && hostUser != me.UserId)
        {
            var info = await MeetingMessaging.LoadAsync(c, tx, m.MeetingId);
            var verb = response switch { "ACCEPTED" => "accepted", "DECLINED" => "declined", _ => "tentatively accepted" };
            await MeetingMessaging.NotifyAsync(c, tx, hostUser.Value, info, "RESPONSE", $"{me.EmployeeName} {verb}: {info.Title}",
                $"{me.EmployeeName} {verb} your meeting on {Zones.FormatRange(info.StartUtc, info.EndUtc, info.TimeZoneId)}.");
        }
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_RESPONDED", "Meeting", id.ToString(), $"Invitation {response.ToLowerInvariant()}", ClientInfo.From(ctx).Ip, tx, newValues: new { response });
        tx.Commit();
        return Results.NoContent();
    }

    // ---- Participants ------------------------------------------------------------------------------------------

    static async Task<IResult> AddParticipants(Guid id, AddParticipantsInput i, Db db, HttpContext ctx, MeetingMessaging msg, IClock clock)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await FindVisibleAsync(c, id, me);
        if (m is null) return MeetingNotFound();
        if (!CanEdit(m, me)) return NotEditable();
        if (IsCustomerCategory(m.Category) && !me.Customers) return Problems.Create(403, "FORBIDDEN", "You do not have permission to manage customer meetings.");
        if (m.Status is not ("DRAFT" or "SCHEDULED")) return Db_.Conflict("Participants can only be changed on draft or scheduled meetings.");
        if (m.Status == "SCHEDULED" && m.EndUtc <= clock.UtcNow) return Db_.Conflict("This meeting has already ended.");

        var v = new Validator();
        var guests = ValidateGuests(v, i.Guests);
        var overrideReason = v.Optional("overrideReason", i.OverrideReason, 500, "Override reason");
        if (i.OverrideConflicts && overrideReason is null && me.Override) v.Add("overrideReason", "Give a reason for booking despite the conflict.");
        var employees = await ResolveEmployees(c, i.EmployeeIds, v, "employeeIds");
        if (!v.IsValid || employees is null) return v.Problem();
        (employees, guests) = await PromoteEmployeeGuests(c, employees, guests);
        if (i.OverrideConflicts && !me.Override) return Problems.Create(403, "FORBIDDEN", "You do not have permission to override calendar conflicts.");

        var existing = (await c.QueryAsync<(long? EmployeeId, string? GuestEmail)>(
            "SELECT EmployeeId, GuestEmail FROM mtg.MeetingParticipants WHERE MeetingId = @id", new { id = m.MeetingId })).ToList();
        var newEmployees = employees.Where(e => !existing.Any(x => x.EmployeeId == e.EmployeeId)).ToList();
        var newGuests = guests.Where(gu => !existing.Any(x => string.Equals(x.GuestEmail, gu.Email, StringComparison.OrdinalIgnoreCase))).ToList();
        if (newEmployees.Count == 0 && newGuests.Count == 0)
            return Problems.Create(400, "VALIDATION", "Everyone selected is already a participant.");
        if (existing.Count + newEmployees.Count + newGuests.Count > MaxEmployees + MaxGuests + 2)
            return Problems.Create(400, "VALIDATION", "This meeting has reached the maximum number of participants.");

        var scheduled = m.Status == "SCHEDULED";
        return await Booking(c, scheduled && newEmployees.Count > 0, async tx =>
        {
            List<ConflictDto> conflicts = [], warnings = [];
            if (scheduled && newEmployees.Count > 0)
            {
                var check = await AvailabilityCheck.RunAsync(c, tx, newEmployees.Select(e => e.EmployeeId).ToList(), m.StartUtc, m.EndUtc, m.MeetingId, lockCalendars: true);
                (conflicts, warnings) = (check.Conflicts, check.Warnings);
                if (conflicts.Count > 0 && !i.OverrideConflicts) { tx.Rollback(); return ConflictResult(conflicts); }
            }
            var rows = newEmployees.Select(e => Employee(m.MeetingId, e.EmployeeId, "ATTENDEE", me.UserId)).Concat(newGuests.Select(gu => Guest(m.MeetingId, gu, me.UserId))).ToList();
            await InsertParticipants(c, tx, rows);
            if (scheduled)
            {
                var identities = rows.Select(r => r.Identity).ToArray();
                var pids = await c.QueryAsync<long>("SELECT ParticipantId FROM mtg.MeetingParticipants WHERE MeetingId = @id AND LiveKitIdentity IN @identities", new { id = m.MeetingId, identities }, tx);
                var info = await MeetingMessaging.LoadAsync(c, tx, m.MeetingId);
                var recipients = await MeetingMessaging.RecipientsAsync(c, tx, m.MeetingId, pids);
                await msg.SendAsync(c, tx, info, recipients, MessageKind.Invited, me.UserId);
                await msg.ScheduleRemindersAsync(c, tx, info, recipients);
            }
            var ip = ClientInfo.From(ctx).Ip;
            await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_PARTICIPANTS_ADDED", "Meeting", id.ToString(),
                $"{newEmployees.Count} employee(s) and {newGuests.Count} guest(s) added", ip, tx,
                newValues: new { employeeIds = newEmployees.Select(e => e.PublicId), guests = newGuests.Count });
            if (conflicts.Count > 0)
                await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_CONFLICT_OVERRIDDEN", "Meeting", id.ToString(),
                    $"Participants added despite {conflicts.Count} calendar conflict(s)", ip, tx, privileged: true,
                    newValues: new { reason = overrideReason, conflicts = conflicts.Select(x => new { employeeId = x.EmployeeId, x.Type, x.StartUtc, x.EndUtc }) });
            return Results.Ok(new { added = rows.Count, warnings, overriddenConflicts = conflicts.Count });
        });
    }

    static async Task<IResult> RemoveParticipant(Guid id, string participantId, Db db, HttpContext ctx, MeetingMessaging msg)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await FindVisibleAsync(c, id, me);
        if (m is null) return MeetingNotFound();
        if (!CanEdit(m, me)) return NotEditable();
        if (IsCustomerCategory(m.Category) && !me.Customers) return Problems.Create(403, "FORBIDDEN", "You do not have permission to manage customer meetings.");
        if (m.Status is not ("DRAFT" or "SCHEDULED")) return Db_.Conflict("Participants can only be changed on draft or scheduled meetings.");
        var p = await c.QuerySingleOrDefaultAsync<RemovableParticipant>("""
            SELECT p.ParticipantId, p.ParticipantType AS Type, p.[Role],
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM mtg.MeetingAttendance x WHERE x.ParticipantId = p.ParticipantId)
                          OR EXISTS (SELECT 1 FROM mtg.MeetingConsent x WHERE x.ParticipantId = p.ParticipantId)
                          OR EXISTS (SELECT 1 FROM mtg.WaitingRoomEntries x WHERE x.ParticipantId = p.ParticipantId)
                          OR EXISTS (SELECT 1 FROM mtg.MeetingChatMessages x WHERE x.ParticipantId = p.ParticipantId) THEN 1 ELSE 0 END AS BIT) AS HasHistory
            FROM mtg.MeetingParticipants p WHERE p.MeetingId = @m AND p.LiveKitIdentity = @participantId
            """, new { m = m.MeetingId, participantId });
        if (p is null) return Db_.NotFound("Participant");
        if (p.Role == "HOST") return Db_.Conflict("The host and the organiser cannot be removed.");
        if (p.Type == "CUSTOMER") return Db_.Conflict("The customer cannot be removed from a customer meeting. Cancel the meeting instead.");
        if (p.HasHistory) return Db_.Conflict("This participant has already joined the meeting and cannot be removed.");

        using var tx = c.BeginTransaction();
        var pid = p.ParticipantId;
        if (m.Status == "SCHEDULED")
        {
            var info = await MeetingMessaging.LoadAsync(c, tx, m.MeetingId);
            await msg.SendAsync(c, tx, info, await MeetingMessaging.RecipientsAsync(c, tx, m.MeetingId, [pid]), MessageKind.Removed, me.UserId);
        }
        // Delivered reminder e-mails stay in the outbox (history); only their link to the deleted reminder row is cleared.
        await c.ExecuteAsync("""
            UPDATE app.EmailOutbox SET RelatedReminderId = NULL WHERE RelatedReminderId IN (SELECT ReminderId FROM mtg.MeetingReminders WHERE ParticipantId = @pid);
            DELETE mtg.MeetingReminders WHERE ParticipantId = @pid;
            DELETE mtg.MeetingInvitations WHERE ParticipantId = @pid;
            DELETE mtg.MeetingParticipants WHERE ParticipantId = @pid;
            """, new { pid }, tx);
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_PARTICIPANT_REMOVED", "Meeting", id.ToString(), $"{p.Type.ToLowerInvariant()} participant removed",
            ClientInfo.From(ctx).Ip, tx, newValues: new { participantId });
        tx.Commit();
        return Results.NoContent();
    }

    // ---- Availability (live form warnings) ---------------------------------------------------------------------

    static async Task<IResult> Availability(AvailabilityInput i, Db db, HttpContext ctx, IOptions<MeetingOptions> mo)
    {
        var v = new Validator();
        if (i.StartUtc is null) v.Add("startUtc", "Start time is required.");
        if (i.EndUtc is null) v.Add("endUtc", "End time is required.");
        if (i.StartUtc is not null && i.EndUtc is not null)
        {
            if (i.EndUtc <= i.StartUtc) v.Add("endUtc", "The meeting must end after it starts.");
            else if (i.EndUtc.Value - i.StartUtc.Value > TimeSpan.FromHours(mo.Value.MaxDurationHours)) v.Add("endUtc", $"A meeting can last at most {mo.Value.MaxDurationHours} hours.");
        }
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var ids = i.EmployeeIds is { Length: > 0 } ? i.EmployeeIds : me.EmployeeId is null ? [] : [await c.QuerySingleAsync<Guid>("SELECT PublicId FROM org.Employees WHERE EmployeeId = @e", new { e = me.EmployeeId })];
        var employees = await ResolveEmployees(c, ids, v, "employeeIds");
        if (!v.IsValid || employees is null) return v.Problem();
        long? exclude = null;
        if (i.ExcludeMeetingId is { } ex)
        {
            exclude = (await FindVisibleAsync(c, ex, me))?.MeetingId;
            if (exclude is null) return MeetingNotFound();
        }
        var r = await AvailabilityCheck.RunAsync(c, null, employees.Select(e => e.EmployeeId).ToList(),
            DateTime.SpecifyKind(i.StartUtc!.Value, DateTimeKind.Utc), DateTime.SpecifyKind(i.EndUtc!.Value, DateTimeKind.Utc), exclude, lockCalendars: false);
        return Results.Ok(new { available = r.Conflicts.Count == 0, conflicts = r.Conflicts, warnings = r.Warnings });
    }

    // ---- Read --------------------------------------------------------------------------------------------------

    sealed record ListRow(Guid Id, string MeetingCode, string Title, string Category, string Status, DateTime StartUtc, DateTime EndUtc, string TimeZoneId,
        string Organiser, Guid HostId, string? CustomerName, string RecordingPolicy, int ParticipantCount, string? Participants, string? MyRole, string? MyResponse, string MeetingKind);

    internal static bool TryParseUtc(string? s, out DateTime? value)
    {
        value = null;
        if (string.IsNullOrWhiteSpace(s)) return true;
        if (!DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)) return false;
        value = DateTime.SpecifyKind(d, DateTimeKind.Utc);
        return true;
    }

    static async Task<IResult> List(string? scope, string? status, string? category, string? from, string? to, string? search, string? sort,
        int? page, int? pageSize, Db db, HttpContext ctx)
    {
        var v = new Validator();
        var sc = (scope ?? "mine").Trim().ToLowerInvariant();
        if (sc is not ("mine" or "hosting" or "attending" or "all")) v.Add("scope", "Scope must be mine, hosting, attending or all.");
        if (!TryParseUtc(from, out var fromUtc)) v.Add("from", "Use an ISO 8601 date-time.");
        if (!TryParseUtc(to, out var toUtc)) v.Add("to", "Use an ISO 8601 date-time.");
        var st = Upper(status);
        var cat = Upper(category);
        if (cat is not null && !Categories.Contains(cat) && cat is not ("CUSTOMER" or "INTERNAL")) v.Add("category", "Unknown meeting category.");
        if (!v.IsValid) return v.Problem();
        if (sc == "all" && !ctx.User.Can("meetings.view.all")) return Problems.Create(403, "FORBIDDEN", "You do not have permission to view all meetings.");

        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var size = Math.Clamp(pageSize ?? 25, 5, 100);
        var p = Math.Max(page ?? 1, 1);
        var scopeSql = sc switch
        {
            "all" => "1 = 1",
            "hosting" => "m.HostEmployeeId = @emp",
            "attending" => "m.HostEmployeeId <> @emp AND m.[Status] <> 'DRAFT' AND EXISTS (SELECT 1 FROM mtg.MeetingParticipants x WHERE x.MeetingId = m.MeetingId AND x.EmployeeId = @emp)",
            _ => Visible.Replace("@all = 1 OR ", ""),
        };
        var where = $"""
            WHERE {scopeSql}
              AND (@st IS NULL OR m.[Status] = @st)
              AND (@cat IS NULL OR m.Category = @cat OR (@cat = 'CUSTOMER' AND m.Category IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL'))
                   OR (@cat = 'INTERNAL' AND m.Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL')))
              AND (@from IS NULL OR m.ScheduledEndUtc > @from) AND (@to IS NULL OR m.ScheduledStartUtc < @to)
              AND (@search IS NULL OR m.Title LIKE @like OR m.MeetingCode LIKE @like)
            """;
        var term = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
        var prm = new
        {
            emp = me.EmployeeId ?? -1, st, cat, from = fromUtc, to = toUtc, search = term,
            like = term is null ? null : "%" + term.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%", skip = (p - 1) * size, size,
        };
        using var multi = await c.QueryMultipleAsync($"""
            SELECT COUNT(*) FROM mtg.Meetings m {where};
            SELECT m.PublicId AS Id, m.MeetingCode, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc, m.TimeZoneId,
                   h.DisplayName AS Organiser, h.PublicId AS HostId, cu.FullName AS CustomerName, m.RecordingPolicy,
                   (SELECT COUNT(*) FROM mtg.MeetingParticipants x WHERE x.MeetingId = m.MeetingId) AS ParticipantCount,
                   (SELECT STRING_AGG(COALESCE(e.DisplayName, pc.FullName, x.GuestName), CHAR(31)) FROM (SELECT TOP (10) * FROM mtg.MeetingParticipants y WHERE y.MeetingId = m.MeetingId ORDER BY y.ParticipantId) x
                        LEFT JOIN org.Employees e ON e.EmployeeId = x.EmployeeId LEFT JOIN crm.Customers pc ON pc.CustomerId = x.CustomerId) AS Participants,
                   mp.[Role] AS MyRole, mp.ResponseStatus AS MyResponse, m.MeetingKind
            FROM mtg.Meetings m JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = m.CustomerId
            LEFT JOIN mtg.MeetingParticipants mp ON mp.MeetingId = m.MeetingId AND mp.EmployeeId = @emp
            {where}
            ORDER BY m.ScheduledStartUtc {(sort == "asc" ? "ASC" : "DESC")}, m.MeetingId
            OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
            """, prm);
        var total = await multi.ReadSingleAsync<int>();
        var items = (await multi.ReadAsync<ListRow>()).Select(r => new
        {
            id = r.Id, meetingCode = r.MeetingCode, title = r.Title, category = r.Category, categoryGroup = CategoryGroup(r.Category), status = r.Status,
            startUtc = r.StartUtc, endUtc = r.EndUtc, timeZoneId = r.TimeZoneId, organiser = r.Organiser, hostId = r.HostId,
            participants = (r.Participants ?? "").Split('\u001F', StringSplitOptions.RemoveEmptyEntries), participantCount = r.ParticipantCount,
            recording = r.RecordingPolicy != "NONE", recordingPolicy = r.RecordingPolicy, customerName = r.CustomerName, myRole = r.MyRole, myResponse = r.MyResponse,
            kind = r.MeetingKind,
        }).ToList();
        return Results.Ok(new Page<object>(items, total, p, size));
    }

    sealed record DetailRow(long MeetingId, Guid Id, string MeetingCode, string Title, string? Description, string? Agenda, string Category, string Status,
        DateTime StartUtc, DateTime EndUtc, string TimeZoneId, DateTime? ActualStartUtc, DateTime? ActualEndUtc, string RecordingPolicy, bool WaitingRoomEnabled,
        int ScheduleVersion, string? CancelReason, string? OverrideConflictReason, string? Purpose, string? PolicyNumber, long HostEmployeeId, Guid HostId, string HostName,
        long CreatedByEmployeeId, Guid CreatedById, string CreatedByName, Guid? CustomerId, string? CustomerName, string? CustomerRef, string? Department,
        DateTime CreatedUtc, DateTime? ModifiedUtc, string MeetingKind, bool IsAudioOnly);
    sealed record ParticipantRow(long ParticipantId, string Id, string Type, long? EmployeeRowId, Guid? EmployeeId, string Name, string? Department,
        string? GuestEmail, string Role, string ResponseStatus, bool IsRequired);
    sealed record InvitationRow(long ParticipantId, DateTime CreatedUtc, DateTime ExpiresUtc, DateTime? RevokedUtc, int UseCount, DateTime? LastUsedUtc);

    static async Task<IResult> Get(Guid id, Db db, HttpContext ctx, IClock clock, IOptions<MeetingOptions> mo, IOptions<LiveKitOptions> lk)
    {
        using var c = await db.OpenAsync();
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await c.QuerySingleOrDefaultAsync<DetailRow>($"""
            SELECT m.MeetingId, m.PublicId AS Id, m.MeetingCode, m.Title, m.Description, m.Agenda, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc,
                   m.ScheduledEndUtc AS EndUtc, m.TimeZoneId, m.ActualStartUtc, m.ActualEndUtc, m.RecordingPolicy, m.WaitingRoomEnabled, m.ScheduleVersion,
                   m.CancelReason, m.OverrideConflictReason, m.Purpose, m.PolicyNumber, m.HostEmployeeId, h.PublicId AS HostId, h.DisplayName AS HostName,
                   m.CreatedByEmployeeId, cb.PublicId AS CreatedById, cb.DisplayName AS CreatedByName, cu.PublicId AS CustomerId, cu.FullName AS CustomerName,
                   cu.CustomerRef, d.Name AS Department, m.CreatedUtc, m.ModifiedUtc, m.MeetingKind, m.IsAudioOnly
            FROM mtg.Meetings m JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId JOIN org.Employees cb ON cb.EmployeeId = m.CreatedByEmployeeId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = m.CustomerId LEFT JOIN org.Departments d ON d.DepartmentId = m.DepartmentId
            WHERE m.PublicId = @id AND {Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (m is null) return MeetingNotFound();
        var canEdit = me.ViewAll || m.HostEmployeeId == me.EmployeeId || m.CreatedByEmployeeId == me.EmployeeId;

        using var multi = await c.QueryMultipleAsync("""
            SELECT p.ParticipantId, p.LiveKitIdentity AS Id, p.ParticipantType AS Type, p.EmployeeId AS EmployeeRowId, e.PublicId AS EmployeeId,
                   COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name, d.Name AS Department, p.GuestEmail, p.[Role], p.ResponseStatus, p.IsRequired
            FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE p.MeetingId = @mid ORDER BY CASE p.[Role] WHEN 'HOST' THEN 0 WHEN 'COHOST' THEN 1 ELSE 2 END, p.ParticipantId;
            SELECT ParticipantId, CreatedUtc, ExpiresUtc, RevokedUtc, UseCount, LastUsedUtc FROM mtg.MeetingInvitations WHERE MeetingId = @mid ORDER BY InvitationId;
            SELECT [Status], COUNT(*) AS N, MIN(CASE WHEN [Status] = 'PENDING' THEN DueUtc END) AS NextDue
            FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = @v GROUP BY [Status];
            """, new { mid = m.MeetingId, v = m.ScheduleVersion });
        var participants = (await multi.ReadAsync<ParticipantRow>()).ToList();
        var invitations = (await multi.ReadAsync<InvitationRow>()).ToList();
        var reminders = (await multi.ReadAsync<(string Status, int N, DateTime? NextDue)>()).ToList();
        var now = clock.UtcNow;
        var mine = participants.FirstOrDefault(p => p.EmployeeRowId is not null && p.EmployeeRowId == me.EmployeeId);
        var isCustomer = IsCustomerCategory(m.Category);
        // Phase 4: can the current user enter the video room now? Only participants (administrators included) can.
        var window = JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, mo.Value);
        var (joinReason, joinMessage) = mine is null ? ("NOT_PARTICIPANT", "Only participants can join this meeting.")
            : !window.Joinable ? (window.Reason, window.Message)
            : !lk.Value.IsConfigured ? ("UNAVAILABLE", "Video meetings are not available: the video service is not configured on this server.")
            : ((string?)null, (string?)null);

        return Results.Ok(new
        {
            id = m.Id, meetingCode = m.MeetingCode, title = m.Title, description = m.Description, agenda = m.Agenda, category = m.Category,
            categoryGroup = CategoryGroup(m.Category), status = m.Status, startUtc = m.StartUtc, endUtc = m.EndUtc, timeZoneId = m.TimeZoneId,
            actualStartUtc = m.ActualStartUtc, actualEndUtc = m.ActualEndUtc, recordingPolicy = m.RecordingPolicy, waitingRoomEnabled = m.WaitingRoomEnabled,
            scheduleVersion = m.ScheduleVersion, cancelReason = m.CancelReason, overrideConflictReason = canEdit ? m.OverrideConflictReason : null,
            purpose = m.Purpose, policyNumber = isCustomer && !me.Customers ? null : m.PolicyNumber, department = m.Department,
            host = new { id = m.HostId, name = m.HostName }, createdBy = new { id = m.CreatedById, name = m.CreatedByName },
            customer = m.CustomerId is null ? null : new { id = m.CustomerId, name = m.CustomerName, customerRef = me.Customers ? m.CustomerRef : null },
            createdUtc = m.CreatedUtc, modifiedUtc = m.ModifiedUtc, kind = m.MeetingKind, audioOnly = m.IsAudioOnly,
            participants = participants.Select(p =>
            {
                var inv = invitations.Where(x => x.ParticipantId == p.ParticipantId).OrderByDescending(x => x.CreatedUtc).FirstOrDefault();
                return new
                {
                    id = p.Id, type = p.Type, employeeId = p.EmployeeId, name = p.Name, department = p.Department,
                    email = canEdit && p.Type == "GUEST" ? p.GuestEmail : null, role = p.Role, responseStatus = p.ResponseStatus, isRequired = p.IsRequired,
                    invitation = inv is null || !canEdit ? null : new
                    {
                        status = inv.RevokedUtc is not null ? "REVOKED" : inv.ExpiresUtc <= now ? "EXPIRED" : "ACTIVE",
                        createdUtc = inv.CreatedUtc, expiresUtc = inv.ExpiresUtc, useCount = inv.UseCount, lastUsedUtc = inv.LastUsedUtc,
                    },
                };
            }),
            reminders = new
            {
                pending = reminders.Where(r => r.Status is "PENDING" or "CLAIMED").Sum(r => r.N),
                sent = reminders.Where(r => r.Status == "SENT").Sum(r => r.N),
                failed = reminders.Where(r => r.Status == "FAILED").Sum(r => r.N),
                cancelled = reminders.Where(r => r.Status == "CANCELLED").Sum(r => r.N),
                nextDueUtc = reminders.Select(r => r.NextDue).Where(d => d is not null).Min(),
            },
            my = new
            {
                participantId = mine?.Id, role = mine?.Role, responseStatus = mine?.ResponseStatus,
                isHost = m.HostEmployeeId == me.EmployeeId, isOrganiser = m.CreatedByEmployeeId == me.EmployeeId,
                canEdit = canEdit && m.Status is ("DRAFT" or "SCHEDULED") && ctx.User.Can("meetings.create") && (!isCustomer || me.Customers),
                canCancel = canEdit && m.Status is ("DRAFT" or "SCHEDULED") && ctx.User.Can("meetings.create") && (!isCustomer || me.Customers),
                canRespond = mine is not null && m.Status is ("SCHEDULED" or "LIVE"),
                canJoin = joinReason is null,
                canHostRoom = mine is not null && mine.Role is "HOST" or "COHOST",
                canShareLink = MeetingLinkEndpoints.CanManageLink(m.HostEmployeeId, m.CreatedByEmployeeId, mine?.Role, me) && m.Status is ("SCHEDULED" or "LIVE"),
            },
            join = new { joinable = joinReason is null, reason = joinReason, message = joinMessage, opensUtc = window.OpensUtc, closesUtc = window.ClosesUtc },
        });
    }
}
