using System.Data;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// /api/v1/meetings/{id}/minutes - minutes of meeting (MOM) written by people. NO AI: nothing is generated, summarised or guessed;
/// the meeting facts (title, times, host, participants, attendance, customer) come from the meeting record and everything else is
/// typed by the host/organiser. Off until an administrator switches on MEETING_MINUTES (V027; 403 FEATURE_DISABLED otherwise).
/// Workflow: draft -> (any number of saves, each one a new version) -> approved (read-only) -> reopened with a reason -> draft ...
/// Who: write/edit = host, organiser, co-host or meetings.view.all; approve = minutes.approve; read a draft = those two groups;
/// read approved minutes = everyone who can see the meeting. Customer meetings additionally need customer.meetings.view.
/// Nothing is ever sent to anyone automatically.
/// </summary>
public static class MeetingMinutesEndpoints
{
    const int SummaryMax = 8000, TextMax = 4000, ItemTextMax = 500, ItemsMax = 50, NoteMax = 500;
    static readonly string[] Priorities = ["LOW", "MEDIUM", "HIGH"];
    static readonly string[] ItemStatuses = ["OPEN", "IN_PROGRESS", "DONE"];
    /// <summary>Minutes are written during or after the meeting, never for one that has not started or did not take place.</summary>
    static readonly string[] WritableMeetingStatuses = ["LIVE", "COMPLETED", "INCOMPLETE"];
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // Calendar dates travel as "yyyy-MM-dd" text: the API's global DateTime converter treats every DateTime as an instant and
    // converts it to UTC, which would move a date entered in India back by one day.
    public sealed record ActionItemInput(string? Id, string? Description, Guid? AssigneeId, string? DueDate, string? Priority, string? Status);
    public sealed record MinutesInput(int BaseVersion, string? DiscussionSummary, string? CustomerRequirements, string? Decisions,
        string? PendingActivities, string? FollowUpDate, ActionItemInput[]? ActionItems);
    public sealed record ApproveInput(int Version);
    public sealed record ReopenInput(int Version, string? Reason);

    public static RouteGroupBuilder MapMeetingMinutesEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/meetings/{id:guid}/minutes").RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapGet("", Get);
        g.MapPut("", Save);
        g.MapPost("/approve", Approve);
        g.MapPost("/reopen", Reopen);
        g.MapGet("/versions", Versions);
        g.MapGet("/versions/{version:int}", VersionDetail);
        return api;
    }

    // ---- Context -------------------------------------------------------------------------------------------------------------

    sealed record MeetingRow(long MeetingId, string MeetingCode, string Title, string Category, string Status, DateTime StartUtc, DateTime EndUtc,
        DateTime? ActualStartUtc, DateTime? ActualEndUtc, string TimeZoneId, long HostEmployeeId, string HostName, long CreatedByEmployeeId,
        string CreatedByName, string? CustomerName, string? PrarambhMainId);

    sealed record MinutesRow(long MinutesId, Guid PublicId, string Status, int Version, string? DiscussionSummary, string? CustomerRequirements,
        string? Decisions, string? PendingActivities, DateTime? FollowUpDate, DateTime CreatedUtc, string? CreatedBy, DateTime ModifiedUtc,
        string? ModifiedBy, DateTime? ApprovedUtc, string? ApprovedBy);

    sealed record ItemRow(Guid PublicId, string Description, Guid? AssigneeId, string? AssigneeName, DateTime? DueDate, string Priority, string Status);

    sealed record Ctx(Actor Me, MeetingRow M, bool CanEdit, bool CanApprove)
    {
        public bool CanSeeDraft => CanEdit || CanApprove;
        public bool MeetingWritable => WritableMeetingStatuses.Contains(M.Status);
    }

    static IResult Disabled() => Problems.Create(403, "FEATURE_DISABLED", "Minutes of meeting are switched off by your administrator.");
    static IResult NotFound() => Db_.NotFound("Meeting");
    static IResult NoMinutes() => Db_.NotFound("Minutes");
    static IResult Forbidden(string why) => Problems.Create(403, "FORBIDDEN", why);
    static IResult Stale() => Db_.Conflict("Someone else changed these minutes after you opened them. Reload to see the latest version, then make your change again.");

    /// <summary>Feature switch, visibility (404 when the meeting cannot be seen), and the caller's rights.</summary>
    static async Task<(Ctx? Ctx, IResult? Error)> LoadAsync(IDbConnection c, Guid id, HttpContext http)
    {
        if (!(await RoomFeatureEndpoints.EnabledAsync(c)).Contains(RoomFeatureEndpoints.Keys.MeetingMinutes)) return (null, Disabled());
        var me = await Actor.LoadAsync(c, http.User);
        var m = await c.QuerySingleOrDefaultAsync<MeetingRow>($"""
            SELECT m.MeetingId, m.MeetingCode, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc,
                   m.ActualStartUtc, m.ActualEndUtc, m.TimeZoneId, m.HostEmployeeId, h.DisplayName AS HostName, m.CreatedByEmployeeId,
                   cb.DisplayName AS CreatedByName, cu.FullName AS CustomerName, m.PrarambhMainId
            FROM mtg.Meetings m JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId JOIN org.Employees cb ON cb.EmployeeId = m.CreatedByEmployeeId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = m.CustomerId
            WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (m is null) return (null, NotFound());
        // Customer meetings: minutes describe the customer, so the customer-meetings permission is needed even to read them.
        if (MeetingEndpoints.IsCustomerCategory(m.Category) && !me.Customers)
            return (null, Forbidden("You do not have access to customer meeting minutes."));
        var coHost = me.EmployeeId is not null && await c.ExecuteScalarAsync<bool>("""
            SELECT CASE WHEN EXISTS (SELECT 1 FROM mtg.MeetingParticipants WHERE MeetingId = @mid AND EmployeeId = @emp AND [Role] IN ('HOST', 'COHOST'))
                        THEN 1 ELSE 0 END
            """, new { mid = m.MeetingId, emp = me.EmployeeId });
        var canEdit = me.ViewAll || coHost || (me.EmployeeId is { } e && (e == m.HostEmployeeId || e == m.CreatedByEmployeeId));
        return (new Ctx(me, m, canEdit, http.User.Can("minutes.approve")), null);
    }

    static Task<MinutesRow?> MinutesAsync(IDbConnection c, long meetingId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<MinutesRow>("""
            SELECT mm.MinutesId, mm.PublicId, mm.[Status], mm.[Version], mm.DiscussionSummary, mm.CustomerRequirements, mm.Decisions, mm.PendingActivities,
                   mm.FollowUpDate, mm.CreatedUtc, COALESCE(ce.DisplayName, cu.Email) AS CreatedBy, mm.ModifiedUtc, COALESCE(me.DisplayName, mu.Email) AS ModifiedBy,
                   mm.ApprovedUtc, COALESCE(ae.DisplayName, au.Email) AS ApprovedBy
            FROM mtg.MeetingMinutes mm
            JOIN auth.Users cu ON cu.UserId = mm.CreatedByUserId LEFT JOIN org.Employees ce ON ce.EmployeeId = cu.EmployeeId
            JOIN auth.Users mu ON mu.UserId = mm.ModifiedByUserId LEFT JOIN org.Employees me ON me.EmployeeId = mu.EmployeeId
            LEFT JOIN auth.Users au ON au.UserId = mm.ApprovedByUserId LEFT JOIN org.Employees ae ON ae.EmployeeId = au.EmployeeId
            WHERE mm.MeetingId = @meetingId
            """, new { meetingId }, tx);

    static async Task<List<ItemRow>> ItemsAsync(IDbConnection c, long minutesId, IDbTransaction? tx = null) =>
        (await c.QueryAsync<ItemRow>("""
            SELECT i.PublicId, i.[Description], e.PublicId AS AssigneeId, e.DisplayName AS AssigneeName, i.DueDate, i.[Priority], i.[Status]
            FROM mtg.MeetingMinutesActionItems i LEFT JOIN org.Employees e ON e.EmployeeId = i.AssignedEmployeeId
            WHERE i.MinutesId = @minutesId ORDER BY i.SortOrder
            """, new { minutesId }, tx)).ToList();

    static string? Day(DateTime? d) => d?.ToString("yyyy-MM-dd");

    static object ItemDto(ItemRow i) => new
    {
        id = i.PublicId, description = i.Description, assignee = i.AssigneeId is null ? null : new { id = i.AssigneeId, name = i.AssigneeName },
        dueDate = Day(i.DueDate), priority = i.Priority, status = i.Status,
    };

    /// <summary>The content of one version (also what the version history stores).</summary>
    static object Content(MinutesRow r, List<ItemRow> items) => new
    {
        discussionSummary = r.DiscussionSummary, customerRequirements = r.CustomerRequirements, decisions = r.Decisions,
        pendingActivities = r.PendingActivities, followUpDate = Day(r.FollowUpDate), actionItems = items.Select(ItemDto),
    };

    // ---- Read ------------------------------------------------------------------------------------------------------------------

    sealed record PeopleRow(string Name, string Type, string Role, DateTime? FirstJoinUtc, int? Seconds);

    static async Task<IResult> Get(Guid id, Db db, HttpContext http)
    {
        using var c = await db.OpenAsync(http.RequestAborted);
        var (x, error) = await LoadAsync(c, id, http);
        if (x is null) return error!;
        var m = x.M;
        var people = await c.QueryAsync<PeopleRow>("""
            SELECT COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name, p.ParticipantType AS Type, p.[Role],
                   a.FirstJoinUtc, a.Seconds
            FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            OUTER APPLY (SELECT MIN(t.JoinedUtc) AS FirstJoinUtc, SUM(t.DurationSeconds) AS Seconds FROM mtg.MeetingAttendance t WHERE t.ParticipantId = p.ParticipantId) a
            WHERE p.MeetingId = @mid
            ORDER BY CASE p.[Role] WHEN 'HOST' THEN 0 WHEN 'COHOST' THEN 1 ELSE 2 END, p.ParticipantId
            """, new { mid = m.MeetingId });

        var row = await MinutesAsync(c, m.MeetingId);
        var visible = row is not null && (row.Status == "APPROVED" || x.CanSeeDraft);
        var items = visible ? await ItemsAsync(c, row!.MinutesId) : [];
        return Results.Ok(new
        {
            canCreate = row is null && x.CanEdit && x.MeetingWritable,
            canEdit = row is { Status: "DRAFT" } && x.CanEdit && x.MeetingWritable,
            canApprove = row is { Status: "DRAFT" } && x.CanApprove,
            canReopen = row is { Status: "APPROVED" } && (x.CanEdit || x.CanApprove) && x.MeetingWritable,
            canSeeHistory = row is not null && x.CanSeeDraft,
            // Minutes exist but are still a draft this user may not read.
            draftInProgress = row is not null && !visible,
            writableMeeting = x.MeetingWritable,
            meeting = new
            {
                meetingCode = m.MeetingCode, title = m.Title, category = m.Category, status = m.Status, startUtc = m.StartUtc, endUtc = m.EndUtc,
                actualStartUtc = m.ActualStartUtc, actualEndUtc = m.ActualEndUtc, timeZoneId = m.TimeZoneId,
                host = m.HostName, organiser = m.CreatedByName, customerName = m.CustomerName, prarambhMainId = m.PrarambhMainId,
                participants = people.Select(p => new { name = p.Name, type = p.Type, role = p.Role, attended = p.FirstJoinUtc is not null, attendedSeconds = p.Seconds }),
            },
            minutes = !visible ? null : new
            {
                id = row!.PublicId, status = row.Status, version = row.Version, discussionSummary = row.DiscussionSummary,
                customerRequirements = row.CustomerRequirements, decisions = row.Decisions, pendingActivities = row.PendingActivities,
                followUpDate = Day(row.FollowUpDate), actionItems = items.Select(ItemDto),
                createdBy = row.CreatedBy, createdUtc = row.CreatedUtc, modifiedBy = row.ModifiedBy, modifiedUtc = row.ModifiedUtc,
                approvedBy = row.ApprovedBy, approvedUtc = row.ApprovedUtc,
            },
        });
    }

    // ---- Write -----------------------------------------------------------------------------------------------------------------

    sealed record CleanItem(Guid? KeepId, string Description, long? EmployeeId, DateTime? DueDate, string Priority, string Status);

    /// <summary>A calendar date "yyyy-MM-dd" (no time, no zone). Empty = none; anything else is a field error.</summary>
    static DateTime? CalendarDate(Validator v, string field, string? raw, string message)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (DateTime.TryParseExact(raw.Trim(), "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var d)
            && d.Year is >= 2000 and <= 2100)
            return d;
        v.Add(field, message);
        return null;
    }

    static async Task<IResult> Save(Guid id, MinutesInput input, Db db, HttpContext http)
    {
        using var c = await db.OpenAsync(http.RequestAborted);
        var (x, error) = await LoadAsync(c, id, http);
        if (x is null) return error!;
        if (!x.CanEdit) return Forbidden("Only the host, the organiser, a co-host or an administrator can write the minutes.");
        if (!x.MeetingWritable) return Db_.Conflict("Minutes can be written once the meeting has started.");

        var v = new Validator();
        var summary = v.Optional("discussionSummary", input.DiscussionSummary, SummaryMax, "Discussion summary");
        var requirements = v.Optional("customerRequirements", input.CustomerRequirements, TextMax, "Customer requirements");
        var decisions = v.Optional("decisions", input.Decisions, TextMax, "Decisions");
        var pending = v.Optional("pendingActivities", input.PendingActivities, TextMax, "Pending activities");
        var followUp = CalendarDate(v, "followUpDate", input.FollowUpDate, "Enter a valid follow-up date.");

        var raw = input.ActionItems ?? [];
        if (raw.Length > ItemsMax) v.Add("actionItems", $"At most {ItemsMax} action items.");
        var assigneeIds = raw.Where(a => a.AssigneeId is not null).Select(a => a.AssigneeId!.Value).Distinct().ToArray();
        var employees = assigneeIds.Length == 0 ? new Dictionary<Guid, long>() :
            (await c.QueryAsync<(Guid PublicId, long EmployeeId)>("SELECT PublicId, EmployeeId FROM org.Employees WHERE IsActive = 1 AND PublicId IN @assigneeIds",
                new { assigneeIds })).ToDictionary(e => e.PublicId, e => e.EmployeeId);
        var items = new List<CleanItem>();
        for (var i = 0; i < Math.Min(raw.Length, ItemsMax); i++)
        {
            var a = raw[i];
            var desc = v.Required($"actionItems[{i}].description", a.Description, ItemTextMax, "Action item");
            long? emp = null;
            if (a.AssigneeId is { } aid)
            {
                if (employees.TryGetValue(aid, out var e)) emp = e;
                else v.Add($"actionItems[{i}].assigneeId", "Choose an active employee.");
            }
            var due = CalendarDate(v, $"actionItems[{i}].dueDate", a.DueDate, "Enter a valid due date.");
            var pr = (a.Priority ?? "MEDIUM").Trim().ToUpperInvariant();
            if (!Priorities.Contains(pr)) v.Add($"actionItems[{i}].priority", "Priority must be Low, Medium or High.");
            var st = (a.Status ?? "OPEN").Trim().ToUpperInvariant();
            if (!ItemStatuses.Contains(st)) v.Add($"actionItems[{i}].status", "Status must be Open, In progress or Done.");
            if (desc is not null) items.Add(new CleanItem(Guid.TryParse(a.Id, out var g) ? g : null, desc, emp, due, pr, st));
        }
        if (!v.IsValid) return v.Problem();

        using var tx = c.BeginTransaction(IsolationLevel.Serializable);
        var current = await MinutesAsync(c, x.M.MeetingId, tx);
        long minutesId;
        int version;
        string action;
        if (current is null)
        {
            if (input.BaseVersion != 0) { tx.Rollback(); return Stale(); }
            try
            {
                minutesId = await c.ExecuteScalarAsync<long>("""
                    INSERT mtg.MeetingMinutes (MeetingId, DiscussionSummary, CustomerRequirements, Decisions, PendingActivities, FollowUpDate, CreatedByUserId, ModifiedByUserId)
                    OUTPUT INSERTED.MinutesId
                    VALUES (@mid, @summary, @requirements, @decisions, @pending, @followUp, @user, @user)
                    """, new { mid = x.M.MeetingId, summary, requirements, decisions, pending, followUp, user = x.Me.UserId }, tx);
            }
            catch (SqlException e) when (e.IsUniqueViolation()) { tx.Rollback(); return Stale(); }
            version = 1;
            action = "CREATED";
        }
        else
        {
            if (current.Status != "DRAFT") { tx.Rollback(); return Db_.Conflict("These minutes are approved and read-only. Reopen them to make changes."); }
            if (current.Version != input.BaseVersion) { tx.Rollback(); return Stale(); }
            minutesId = current.MinutesId;
            version = current.Version + 1;
            action = "SAVED";
            await c.ExecuteAsync("""
                UPDATE mtg.MeetingMinutes SET DiscussionSummary = @summary, CustomerRequirements = @requirements, Decisions = @decisions,
                       PendingActivities = @pending, FollowUpDate = @followUp, [Version] = @version, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                WHERE MinutesId = @minutesId
                """, new { summary, requirements, decisions, pending, followUp, version, user = x.Me.UserId, minutesId }, tx);
        }

        // Replace the action items; an item that already belonged to these minutes keeps its id.
        var existing = (await c.QueryAsync<Guid>("SELECT PublicId FROM mtg.MeetingMinutesActionItems WHERE MinutesId = @minutesId", new { minutesId }, tx)).ToHashSet();
        await c.ExecuteAsync("DELETE FROM mtg.MeetingMinutesActionItems WHERE MinutesId = @minutesId", new { minutesId }, tx);
        var used = new HashSet<Guid>();
        for (var i = 0; i < items.Count; i++)
        {
            var it = items[i];
            var keep = it.KeepId is { } k && existing.Contains(k) && used.Add(k) ? k : Guid.NewGuid();
            await c.ExecuteAsync("""
                INSERT mtg.MeetingMinutesActionItems (PublicId, MinutesId, SortOrder, [Description], AssignedEmployeeId, DueDate, [Priority], [Status])
                VALUES (@keep, @minutesId, @i, @Description, @EmployeeId, @DueDate, @Priority, @Status)
                """, new { keep, minutesId, i, it.Description, it.EmployeeId, it.DueDate, it.Priority, it.Status }, tx);
        }

        var saved = (await MinutesAsync(c, x.M.MeetingId, tx))!;
        await SnapshotAsync(c, tx, saved, action, null, x.Me.UserId);
        await Audit.WriteAsync(c, "USER", x.Me.UserId, action == "CREATED" ? "MINUTES_CREATED" : "MINUTES_SAVED", "MeetingMinutes", saved.PublicId.ToString(),
            $"Minutes of meeting {x.M.MeetingCode} {(action == "CREATED" ? "created" : "saved")} (version {version}, {items.Count} action item(s))",
            ClientInfo.From(http).Ip, tx, newValues: new { meeting = x.M.MeetingCode, version, actionItems = items.Count });
        tx.Commit();
        return Results.Ok(new { id = saved.PublicId, version });
    }

    static async Task SnapshotAsync(IDbConnection c, IDbTransaction tx, MinutesRow r, string action, string? note, long user)
    {
        var items = await ItemsAsync(c, r.MinutesId, tx);
        await c.ExecuteAsync("""
            INSERT mtg.MeetingMinutesVersions (MinutesId, [Version], [Action], [Status], SnapshotJson, Note, SavedByUserId)
            VALUES (@MinutesId, @Version, @action, @Status, @json, @note, @user)
            """, new { r.MinutesId, r.Version, action, r.Status, json = JsonSerializer.Serialize(Content(r, items), Json), note, user }, tx);
    }

    static async Task<IResult> Approve(Guid id, ApproveInput input, Db db, HttpContext http)
    {
        using var c = await db.OpenAsync(http.RequestAborted);
        var (x, error) = await LoadAsync(c, id, http);
        if (x is null) return error!;
        if (!x.CanApprove) return Forbidden("You are not allowed to approve minutes.");
        using var tx = c.BeginTransaction(IsolationLevel.Serializable);
        var r = await MinutesAsync(c, x.M.MeetingId, tx);
        if (r is null) { tx.Rollback(); return NoMinutes(); }
        if (r.Status != "DRAFT") { tx.Rollback(); return Db_.Conflict("These minutes are already approved."); }
        if (r.Version != input.Version) { tx.Rollback(); return Stale(); }
        var hasItems = await c.ExecuteScalarAsync<bool>("SELECT CASE WHEN EXISTS (SELECT 1 FROM mtg.MeetingMinutesActionItems WHERE MinutesId = @MinutesId) THEN 1 ELSE 0 END", new { r.MinutesId }, tx);
        if (r.DiscussionSummary is null && r.Decisions is null && r.CustomerRequirements is null && r.PendingActivities is null && !hasItems)
        { tx.Rollback(); return Problems.Create(400, "VALIDATION", "These minutes are empty. Write the discussion summary, decisions or action items before approving."); }

        await c.ExecuteAsync("""
            UPDATE mtg.MeetingMinutes SET [Status] = 'APPROVED', [Version] = [Version] + 1, ApprovedUtc = SYSUTCDATETIME(), ApprovedByUserId = @user
            WHERE MinutesId = @MinutesId
            """, new { user = x.Me.UserId, r.MinutesId }, tx);
        var after = (await MinutesAsync(c, x.M.MeetingId, tx))!;
        await SnapshotAsync(c, tx, after, "APPROVED", null, x.Me.UserId);
        await Audit.WriteAsync(c, "USER", x.Me.UserId, "MINUTES_APPROVED", "MeetingMinutes", r.PublicId.ToString(),
            $"Minutes of meeting {x.M.MeetingCode} approved (version {after.Version})", ClientInfo.From(http).Ip, tx,
            newValues: new { meeting = x.M.MeetingCode, version = after.Version });
        tx.Commit();
        return Results.Ok(new { version = after.Version });
    }

    static async Task<IResult> Reopen(Guid id, ReopenInput input, Db db, HttpContext http)
    {
        using var c = await db.OpenAsync(http.RequestAborted);
        var (x, error) = await LoadAsync(c, id, http);
        if (x is null) return error!;
        if (!x.CanEdit && !x.CanApprove) return Forbidden("Only the host, the organiser, a co-host, an approver or an administrator can reopen the minutes.");
        if (!x.MeetingWritable) return Db_.Conflict("The minutes of this meeting can no longer be changed.");
        var v = new Validator();
        var reason = v.Required("reason", input.Reason, NoteMax, "Reason");
        if (!v.IsValid) return v.Problem();
        using var tx = c.BeginTransaction(IsolationLevel.Serializable);
        var r = await MinutesAsync(c, x.M.MeetingId, tx);
        if (r is null) { tx.Rollback(); return NoMinutes(); }
        if (r.Status != "APPROVED") { tx.Rollback(); return Db_.Conflict("These minutes are not approved, so there is nothing to reopen."); }
        if (r.Version != input.Version) { tx.Rollback(); return Stale(); }
        await c.ExecuteAsync("""
            UPDATE mtg.MeetingMinutes SET [Status] = 'DRAFT', [Version] = [Version] + 1, ApprovedUtc = NULL, ApprovedByUserId = NULL
            WHERE MinutesId = @MinutesId
            """, new { r.MinutesId }, tx);
        var after = (await MinutesAsync(c, x.M.MeetingId, tx))!;
        await SnapshotAsync(c, tx, after, "REOPENED", reason, x.Me.UserId);
        await Audit.WriteAsync(c, "USER", x.Me.UserId, "MINUTES_REOPENED", "MeetingMinutes", r.PublicId.ToString(),
            $"Approved minutes of meeting {x.M.MeetingCode} reopened (version {after.Version})", ClientInfo.From(http).Ip, tx,
            newValues: new { meeting = x.M.MeetingCode, version = after.Version, reason });
        tx.Commit();
        return Results.Ok(new { version = after.Version });
    }

    // ---- History ---------------------------------------------------------------------------------------------------------------

    sealed record VersionRow(int Version, string Action, string Status, string? Note, DateTime SavedUtc, string? SavedBy, string SnapshotJson);

    const string VersionSql = """
        SELECT v.[Version], v.[Action], v.[Status], v.Note, v.SavedUtc, COALESCE(e.DisplayName, u.Email) AS SavedBy, {0} AS SnapshotJson
        FROM mtg.MeetingMinutesVersions v JOIN auth.Users u ON u.UserId = v.SavedByUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
        WHERE v.MinutesId = @minutesId
        """;

    static async Task<(Ctx? Ctx, MinutesRow? Row, IResult? Error)> HistoryAccessAsync(IDbConnection c, Guid id, HttpContext http)
    {
        var (x, error) = await LoadAsync(c, id, http);
        if (x is null) return (null, null, error);
        if (!x.CanSeeDraft) return (null, null, Forbidden("Only the people who write or approve the minutes can see their history."));
        var r = await MinutesAsync(c, x.M.MeetingId);
        return r is null ? (null, null, NoMinutes()) : (x, r, null);
    }

    static async Task<IResult> Versions(Guid id, Db db, HttpContext http)
    {
        using var c = await db.OpenAsync(http.RequestAborted);
        var (_, r, error) = await HistoryAccessAsync(c, id, http);
        if (r is null) return error!;
        var rows = await c.QueryAsync<VersionRow>(string.Format(VersionSql, "''") + " ORDER BY v.[Version] DESC", new { minutesId = r.MinutesId });
        return Results.Ok(new { items = rows.Select(v => new { version = v.Version, action = v.Action, status = v.Status, note = v.Note, savedUtc = v.SavedUtc, savedBy = v.SavedBy }) });
    }

    static async Task<IResult> VersionDetail(Guid id, int version, Db db, HttpContext http)
    {
        using var c = await db.OpenAsync(http.RequestAborted);
        var (_, r, error) = await HistoryAccessAsync(c, id, http);
        if (r is null) return error!;
        var v = await c.QuerySingleOrDefaultAsync<VersionRow>(string.Format(VersionSql, "v.SnapshotJson") + " AND v.[Version] = @version",
            new { minutesId = r.MinutesId, version });
        if (v is null) return Db_.NotFound("Version");
        return Results.Ok(new
        {
            version = v.Version, action = v.Action, status = v.Status, note = v.Note, savedUtc = v.SavedUtc, savedBy = v.SavedBy,
            content = JsonSerializer.Deserialize<JsonElement>(v.SnapshotJson),
        });
    }
}
