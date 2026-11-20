using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// Chat Phase 4 (V030, requirement sections 14-16): personal notes, tasks / follow-ups, reminders and "My Day".
/// Everything is PRIVATE to its owner: every query is filtered by the caller's user id and any id that is not theirs is answered
/// with 404 (its existence is not revealed). Needs CHAT and CHAT_TASKS on. Reminders are fired by the server (ChatReminderWorker),
/// never by browser timers, exactly once; people who were offline get them from /chat/reminders/due when they return.
/// Note and task text is never written to logs or the audit log.
/// </summary>
public static partial class ChatWorkEndpoints
{
    public const string FeatureKey = RoomFeatureEndpoints.Keys.ChatTasks;
    public const string WriteRateLimit = ChatEndpoints.SendRateLimit;
    public const int TitleMax = 200;
    public const int TextMax = 8000;
    public const int CategoryNameMax = 40;
    public const int MaxCategoriesPerUser = 50;
    public const int MaxActiveNotes = 5000;
    public const int MaxOpenTasks = 5000;

    static readonly string[] Priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"];
    static readonly string[] Statuses = ["PENDING", "IN_PROGRESS", "COMPLETED", "POSTPONED", "CANCELLED"];
    static readonly string[] RepeatRules = ["NONE", "DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY"];

    public sealed class WorkServices(Db db, IMemoryCache cache, ChatPush push, IClock clock)
    {
        public Db Db => db;
        public IMemoryCache Cache => cache;
        public ChatPush Push => push;
        public IClock Clock => clock;
    }

    public static RouteGroupBuilder MapChatWorkEndpoints(this RouteGroupBuilder api)
    {
        // chat.tasks (V032): per-user module access can switch Notes & tasks off for one person.
        var g = api.MapGroup("/chat").RequirePermission(ChatAccess.Permission).RequirePermission(ModuleAccess.TasksPermission);
        g.MapGet("/categories", Categories);
        g.MapPost("/categories", CreateCategory).RequireRateLimiting(WriteRateLimit);
        g.MapDelete("/categories/{id:guid}", DeleteCategory);

        g.MapGet("/notes", Notes);
        g.MapPost("/notes", CreateNote).RequireRateLimiting(WriteRateLimit);
        g.MapGet("/notes/{id:guid}", GetNote);
        g.MapPatch("/notes/{id:guid}", PatchNote).RequireRateLimiting(WriteRateLimit);
        g.MapDelete("/notes/{id:guid}", DeleteNote);

        g.MapGet("/tasks", Tasks);
        g.MapGet("/tasks/followup-panel", FollowupPanel);
        g.MapPost("/tasks", CreateTask).RequireRateLimiting(WriteRateLimit);
        g.MapGet("/tasks/{id:guid}", GetTask);
        g.MapPatch("/tasks/{id:guid}", PatchTask).RequireRateLimiting(WriteRateLimit);
        g.MapDelete("/tasks/{id:guid}", DeleteTask);
        g.MapPost("/tasks/{id:guid}/status", SetStatus).RequireRateLimiting(WriteRateLimit);

        g.MapGet("/reminders/due", DueReminders);
        g.MapGet("/reminders/upcoming", UpcomingReminders);
        g.MapPost("/reminders/{id:guid}/snooze", Snooze).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/reminders/{id:guid}/done", ReminderDone).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/reminders/{id:guid}/dismiss", Dismiss).RequireRateLimiting(WriteRateLimit);

        g.MapGet("/my-day", MyDay);
        g.MapGet("/work/meetings", WorkMeetings);
        return api;
    }

    // ---- Access ------------------------------------------------------------------------------------------------------------

    static IResult TasksDisabled() => Problems.Create(403, "FEATURE_DISABLED", "Notes, tasks and reminders are switched off by your administrator.");
    static IResult NotFound(string what) => Db_.NotFound(what);
    static IResult LinkNotFound(string field, string what) =>
        Problems.Create(404, "LINK_NOT_FOUND", $"{what} not found, or you do not have access to it.", new Dictionary<string, object?> { ["field"] = field });
    static IResult LimitReached(string detail) => Problems.Create(400, "LIMIT_REACHED", detail);

    /// <summary>The CHAT_TASKS switch, cached for 10 s like the other chat switches. A database without V030 means "off".</summary>
    public static async Task<bool> TasksEnabledAsync(IDbConnection c, IMemoryCache cache)
    {
        if (cache.TryGetValue("chat:tasks-enabled", out bool on)) return on;
        on = (await RoomFeatureEndpoints.EnabledAsync(c)).Contains(FeatureKey);
        cache.Set("chat:tasks-enabled", on, TimeSpan.FromSeconds(10));
        return on;
    }

    sealed record Caller(long UserId, Guid Id, string Name, long EmployeeId, string? TimeZoneId);

    static async Task<IResult> Run(WorkServices s, HttpContext ctx, Func<IDbConnection, Caller, Task<IResult>> run)
    {
        using var c = await s.Db.OpenAsync(ctx.RequestAborted);
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (!await TasksEnabledAsync(c, s.Cache)) return TasksDisabled();
        var u = await c.QuerySingleAsync<(long? EmployeeId, string? TimeZoneId)>("SELECT EmployeeId, TimeZoneId FROM auth.Users WHERE UserId = @u", new { u = me.UserId });
        return await run(c, new Caller(me.UserId, me.Id, me.Name, u.EmployeeId ?? 0, u.TimeZoneId));
    }

    // ---- Small helpers -----------------------------------------------------------------------------------------------------

    static DateTime AsUtc(DateTime d) => d.Kind switch
    {
        DateTimeKind.Local => d.ToUniversalTime(),
        DateTimeKind.Unspecified => DateTime.SpecifyKind(d, DateTimeKind.Utc),
        _ => d,
    };

    static TimeZoneInfo Zone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }

    static DateTime LocalToUtc(DateTime local, TimeZoneInfo tz)
    {
        local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
        if (tz.IsInvalidTime(local)) local = local.AddHours(1);
        return DateTime.SpecifyKind(TimeZoneInfo.ConvertTimeToUtc(local, tz), DateTimeKind.Utc);
    }

    /// <summary>The caller's day: [dayStartUtc, dayEndUtc) from the browser (local midnight to midnight), else today in their profile time zone.</summary>
    static (DateTime Start, DateTime End, IResult? Error) Day(DateTime? start, DateTime? end, Caller me, DateTime now)
    {
        if (start is null && end is null)
        {
            var tz = Zone(me.TimeZoneId);
            var today = TimeZoneInfo.ConvertTimeFromUtc(AsUtc(now), tz).Date;
            return (LocalToUtc(today, tz), LocalToUtc(today.AddDays(1), tz), null);
        }
        if (start is { } a && end is { } b && AsUtc(b) > AsUtc(a) && AsUtc(b) - AsUtc(a) <= TimeSpan.FromDays(7)) return (AsUtc(a), AsUtc(b), null);
        var v = new Validator();
        v.Add("dayStartUtc", "Send dayStartUtc and dayEndUtc together (dayEndUtc after dayStartUtc, at most 7 days apart).");
        return (default, default, v.Problem());
    }

    static string? Like(string? term) =>
        string.IsNullOrWhiteSpace(term) ? null : "%" + term.Trim()[..Math.Min(term.Trim().Length, 80)].Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";

    static string? Excerpt(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var v = s.Replace("\r", " ").Replace('\n', ' ').Trim();
        return v.Length <= max ? v : v[..(max - 1)].TrimEnd() + "…";
    }

    [GeneratedRegex("^#[0-9A-Fa-f]{6}$")] private static partial Regex ColorRe();

    /// <summary>A JSON body read field by field, so PATCH can tell "absent" (keep) from null (clear).</summary>
    sealed class Input
    {
        readonly Dictionary<string, JsonElement> props = new(StringComparer.OrdinalIgnoreCase);
        public Validator V { get; } = new();

        public Input(JsonElement e)
        {
            if (e.ValueKind == JsonValueKind.Object)
                foreach (var p in e.EnumerateObject()) props[p.Name] = p.Value;
            else if (e.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null)) V.Add("body", "Send a JSON object.");
        }

        public static Input Of(object o) => new(JsonSerializer.SerializeToElement(o));

        public bool Has(string n) => props.ContainsKey(n);
        bool Get(string n, out JsonElement v) => props.TryGetValue(n, out v) && v.ValueKind != JsonValueKind.Null;

        public string? Str(string n)
        {
            if (!Get(n, out var v)) return null;
            if (v.ValueKind == JsonValueKind.String) return v.GetString();
            V.Add(n, "Must be text."); return null;
        }

        public bool? Bool(string n)
        {
            if (!Get(n, out var v)) return null;
            if (v.ValueKind is JsonValueKind.True or JsonValueKind.False) return v.GetBoolean();
            V.Add(n, "Must be true or false."); return null;
        }

        public int? Int(string n)
        {
            if (!Get(n, out var v)) return null;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)) return i;
            V.Add(n, "Must be a whole number."); return null;
        }

        public Guid? Id(string n)
        {
            if (!Get(n, out var v)) return null;
            if (v.ValueKind == JsonValueKind.String && Guid.TryParse(v.GetString(), out var g)) return g;
            V.Add(n, "Not a valid id."); return null;
        }

        public DateTime? Utc(string n)
        {
            if (!Get(n, out var v)) return null;
            if (v.ValueKind == JsonValueKind.String && DateTime.TryParse(v.GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d))
                return DateTime.SpecifyKind(d, DateTimeKind.Utc);
            V.Add(n, "Must be a date and time (ISO 8601, UTC)."); return null;
        }

        public string? Choice(string n, string[] allowed, string message)
        {
            var s = Str(n)?.Trim().ToUpperInvariant();
            if (s is null) return null;
            if (allowed.Contains(s)) return s;
            V.Add(n, message); return null;
        }
    }

    static void CheckDate(Validator v, string field, DateTime? d, DateTime now)
    {
        if (d is { } x && (x < new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc) || x > now.AddYears(20))) v.Add(field, "This date is out of range.");
    }

    static void CheckReminder(Validator v, DateTime? d, DateTime now)
    {
        if (d is { } x && (x < now.AddMinutes(-1) || x > now.AddYears(5))) v.Add("reminderUtc", "Choose a reminder time in the future (at most 5 years ahead).");
    }

    // ---- Link resolution (only things the caller may access) ---------------------------------------------------------------

    static Task<long?> MeetingIdAsync(IDbConnection c, Caller me, Guid id, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<long?>($"SELECT m.MeetingId FROM mtg.Meetings m WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}",
            new { id, all = false, emp = me.EmployeeId }, tx);

    static Task<long?> EmployeeUserIdAsync(IDbConnection c, Guid id) =>
        c.QuerySingleOrDefaultAsync<long?>("""
            SELECT u.UserId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1 WHERE u.PublicId = @id AND u.IsActive = 1
            """, new { id });

    static Task<long?> OwnTaskIdAsync(IDbConnection c, Caller me, Guid id) =>
        c.QuerySingleOrDefaultAsync<long?>("SELECT TaskId FROM chat.TRN_ChatTask WHERE PublicId = @id AND OwnerUserId = @me AND IsActive = 1", new { id, me = me.UserId });

    static Task<long?> OwnNoteIdAsync(IDbConnection c, Caller me, Guid id) =>
        c.QuerySingleOrDefaultAsync<long?>("SELECT NoteId FROM chat.TRN_ChatNote WHERE PublicId = @id AND OwnerUserId = @me AND IsActive = 1", new { id, me = me.UserId });

    static Task<long?> OwnCategoryIdAsync(IDbConnection c, Caller me, Guid id) =>
        c.QuerySingleOrDefaultAsync<long?>("""
            SELECT CategoryId FROM chat.MST_TaskCategory WHERE PublicId = @id AND IsActive = 1 AND (OwnerUserId IS NULL OR OwnerUserId = @me)
            """, new { id, me = me.UserId });

    /// <summary>A chat message the caller can see (active member, not before their VisibleFromMessageId).</summary>
    static Task<(long MessageId, long ConversationId)?> VisibleMessageAsync(IDbConnection c, Caller me, Guid id) =>
        c.QuerySingleOrDefaultAsync<(long MessageId, long ConversationId)?>("""
            SELECT m.MessageId, m.ConversationId FROM chat.TRN_ChatMessage m
            JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = m.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = m.ConversationId AND p.UserId = @me AND p.LeftUtc IS NULL
            WHERE m.PublicId = @id AND m.MessageId > p.VisibleFromMessageId
            """, new { id, me = me.UserId });

    /// <summary>A call the caller took part in; its conversation only while they are still an active member of it.</summary>
    static Task<(long CallId, long? ConversationId)?> MyCallAsync(IDbConnection c, Caller me, Guid id) =>
        c.QuerySingleOrDefaultAsync<(long CallId, long? ConversationId)?>("""
            SELECT cl.CallId, CASE WHEN EXISTS (SELECT 1 FROM chat.TRN_ChatConversationParticipant cp JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = cp.ConversationId AND cv.IsActive = 1
                                                WHERE cp.ConversationId = cl.ConversationId AND cp.UserId = @me AND cp.LeftUtc IS NULL) THEN cl.ConversationId END AS ConversationId
            FROM chat.TRN_ChatCall cl JOIN chat.TRN_ChatCallParticipant p ON p.CallId = cl.CallId AND p.UserId = @me
            WHERE cl.PublicId = @id
            """, new { id, me = me.UserId });

    // ---- Shared SELECT parts (x = the task or note, owned by the caller) ---------------------------------------------------

    static string ReminderApply(string column, string key) => $"""
        OUTER APPLY (SELECT TOP (1) rr.PublicId, rr.DueUtc, rr.[State] FROM chat.TRN_ChatReminder rr
                     WHERE rr.{column} = x.{key} AND rr.IsActive = 1 AND (rr.[State] = 'PENDING' OR (rr.[State] = 'FIRED' AND rr.AcknowledgedUtc IS NULL))
                     ORDER BY rr.ReminderId DESC) rm
        """;

    const string LinkJoins = """
        JOIN auth.Users ow ON ow.UserId = x.OwnerUserId
        LEFT JOIN chat.MST_TaskCategory cat ON cat.CategoryId = x.CategoryId AND cat.IsActive = 1
        LEFT JOIN mtg.Meetings lm ON lm.MeetingId = x.MeetingId AND (lm.HostEmployeeId = ow.EmployeeId OR lm.CreatedByEmployeeId = ow.EmployeeId
             OR (lm.[Status] <> 'DRAFT' AND EXISTS (SELECT 1 FROM mtg.MeetingParticipants lmp WHERE lmp.MeetingId = lm.MeetingId AND lmp.EmployeeId = ow.EmployeeId)))
        LEFT JOIN auth.Users leu ON leu.UserId = x.EmployeeUserId LEFT JOIN org.Employees lee ON lee.EmployeeId = leu.EmployeeId
        LEFT JOIN chat.TRN_ChatConversationParticipant lcp ON lcp.ConversationId = x.ConversationId AND lcp.UserId = x.OwnerUserId AND lcp.LeftUtc IS NULL
        LEFT JOIN chat.TRN_ChatConversation lcv ON lcv.ConversationId = lcp.ConversationId AND lcv.IsActive = 1
        OUTER APPLY (SELECT TOP (1) oe.DisplayName FROM chat.TRN_ChatConversationParticipant op JOIN auth.Users ou ON ou.UserId = op.UserId
                     JOIN org.Employees oe ON oe.EmployeeId = ou.EmployeeId
                     WHERE lcv.[Type] = 'DIRECT' AND op.ConversationId = lcv.ConversationId AND op.UserId <> x.OwnerUserId) lco
        """;

    const string LinkColumns = """
        cat.PublicId AS CategoryId, cat.[Name] AS CategoryName, cat.Color AS CategoryColor,
        rm.PublicId AS ReminderId, rm.DueUtc AS ReminderUtc, rm.[State] AS ReminderState,
        lm.PublicId AS MeetingId, lm.Title AS MeetingTitle, lm.ScheduledStartUtc AS MeetingStartUtc,
        leu.PublicId AS EmployeeId, lee.DisplayName AS EmployeeName, lee.EmployeeCode AS EmployeeCode,
        lcv.PublicId AS ConversationId, CASE WHEN lcv.[Type] = 'GROUP' THEN lcv.[Name] ELSE lco.DisplayName END AS ConversationTitle,
        CAST(CASE WHEN lcv.[Type] = 'GROUP' THEN 1 ELSE 0 END AS BIT) AS ConversationIsGroup,
        x.CreatedUtc, x.UpdatedUtc
        """;

    class LinkRow
    {
        public Guid? CategoryId { get; set; }
        public string? CategoryName { get; set; }
        public string? CategoryColor { get; set; }
        public Guid? ReminderId { get; set; }
        public DateTime? ReminderUtc { get; set; }
        public string? ReminderState { get; set; }
        public Guid? MeetingId { get; set; }
        public string? MeetingTitle { get; set; }
        public DateTime? MeetingStartUtc { get; set; }
        public Guid? EmployeeId { get; set; }
        public string? EmployeeName { get; set; }
        public string? EmployeeCode { get; set; }
        public Guid? ConversationId { get; set; }
        public string? ConversationTitle { get; set; }
        public bool ConversationIsGroup { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime UpdatedUtc { get; set; }

        public object? Meeting => MeetingId is { } id ? new { id, title = MeetingTitle, startUtc = MeetingStartUtc } : null;
        public object? Employee => EmployeeId is { } id ? new { id, name = EmployeeName, code = EmployeeCode } : null;
        public object? Conversation => ConversationId is { } id ? new { id, title = ConversationTitle, isGroup = ConversationIsGroup } : null;
    }

    // ---- Categories --------------------------------------------------------------------------------------------------------

    sealed record CategoryRow(Guid Id, string Name, string Color, bool IsDefault);

    static object CategoryDto(CategoryRow r) => new { id = r.Id, name = r.Name, color = r.Color, isDefault = r.IsDefault };

    static Task<IResult> Categories(WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var rows = await c.QueryAsync<CategoryRow>("""
            SELECT PublicId AS Id, [Name], Color, CAST(CASE WHEN OwnerUserId IS NULL THEN 1 ELSE 0 END AS BIT) AS IsDefault
            FROM chat.MST_TaskCategory WHERE IsActive = 1 AND (OwnerUserId IS NULL OR OwnerUserId = @me)
            ORDER BY CASE WHEN OwnerUserId IS NULL THEN 0 ELSE 1 END, SortOrder, [Name]
            """, new { me = me.UserId });
        return Results.Ok(rows.Select(CategoryDto));
    });

    static Task<IResult> CreateCategory(JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var inp = new Input(body);
        var v = inp.V;
        var name = v.Required("name", ChatAccess.CleanText(inp.Str("name"), false), CategoryNameMax, "Name");
        var color = inp.Str("color")?.Trim() ?? "#64748B";
        if (!ColorRe().IsMatch(color)) v.Add("color", "Choose a colour such as #2563EB.");
        if (!v.IsValid) return v.Problem();
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.MST_TaskCategory WHERE OwnerUserId = @me AND IsActive = 1", new { me = me.UserId }) >= MaxCategoriesPerUser)
            return LimitReached($"You can have at most {MaxCategoriesPerUser} categories of your own.");
        if (await c.ExecuteScalarAsync<int>("""
                SELECT COUNT(*) FROM chat.MST_TaskCategory WHERE IsActive = 1 AND (OwnerUserId IS NULL OR OwnerUserId = @me) AND LOWER([Name]) = LOWER(@name)
                """, new { me = me.UserId, name }) > 0)
            return Db_.Conflict("A category with this name already exists.");
        var row = await c.QuerySingleAsync<CategoryRow>("""
            INSERT chat.MST_TaskCategory (OwnerUserId, [Name], Color) OUTPUT inserted.PublicId AS Id, inserted.[Name], inserted.Color, CAST(0 AS BIT) AS IsDefault
            VALUES (@me, @name, @color)
            """, new { me = me.UserId, name, color = color.ToUpperInvariant() });
        return Results.Ok(CategoryDto(row));
    });

    static Task<IResult> DeleteCategory(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var cat = await c.QuerySingleOrDefaultAsync<(long CategoryId, long? OwnerUserId)?>(
            "SELECT CategoryId, OwnerUserId FROM chat.MST_TaskCategory WHERE PublicId = @id AND IsActive = 1", new { id });
        if (cat is null || (cat.Value.OwnerUserId is { } o && o != me.UserId)) return NotFound("Category");
        if (cat.Value.OwnerUserId is null) return Db_.Conflict("Default categories cannot be deleted.");
        var now = s.Clock.UtcNow;
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatTask SET CategoryId = NULL, UpdatedUtc = @now WHERE CategoryId = @cid AND OwnerUserId = @me;
            UPDATE chat.TRN_ChatNote SET CategoryId = NULL, UpdatedUtc = @now WHERE CategoryId = @cid AND OwnerUserId = @me;
            UPDATE chat.MST_TaskCategory SET IsActive = 0, UpdatedUtc = @now WHERE CategoryId = @cid;
            """, new { cid = cat.Value.CategoryId, me = me.UserId, now }, tx);
        tx.Commit();
        return Results.NoContent();
    });

    // ---- Reminders (shared) ------------------------------------------------------------------------------------------------

    internal sealed class ReminderRow
    {
        public long ReminderId { get; set; }
        public Guid Id { get; set; }
        public long OwnerUserId { get; set; }
        public long? TaskId { get; set; }
        public long? NoteId { get; set; }
        public string Kind { get; set; } = "";
        public Guid ItemId { get; set; }
        public string Title { get; set; } = "";
        public string? Details { get; set; }
        public string? Priority { get; set; }
        public DateTime DueUtc { get; set; }
        public DateTime? FiredUtc { get; set; }
        public string State { get; set; } = "";
        public int SnoozeCount { get; set; }
        public DateTime? TaskDueUtc { get; set; }
        public string? TaskStatus { get; set; }
    }

    internal const string ReminderSelect = """
        SELECT r.ReminderId, r.PublicId AS Id, r.OwnerUserId, r.TaskId, r.NoteId, CASE WHEN r.TaskId IS NOT NULL THEN 'TASK' ELSE 'NOTE' END AS Kind,
               COALESCE(t.PublicId, n.PublicId) AS ItemId, COALESCE(t.Title, n.Title) AS Title, LEFT(COALESCE(t.[Description], n.Body), 260) AS Details,
               t.[Priority] AS Priority, r.DueUtc, r.FiredUtc, r.[State], r.SnoozeCount, t.DueUtc AS TaskDueUtc, t.[Status] AS TaskStatus
        FROM chat.TRN_ChatReminder r
        LEFT JOIN chat.TRN_ChatTask t ON t.TaskId = r.TaskId AND t.IsActive = 1
        LEFT JOIN chat.TRN_ChatNote n ON n.NoteId = r.NoteId AND n.IsActive = 1
        """;

    internal static object ReminderDto(ReminderRow r) => new
    {
        id = r.Id, kind = r.Kind, itemId = r.ItemId, title = r.Title, details = Excerpt(r.Details, 200), priority = r.Priority,
        dueUtc = r.DueUtc, firedUtc = r.FiredUtc, state = r.State, snoozeCount = r.SnoozeCount, taskDueUtc = r.TaskDueUtc,
    };

    static async Task<List<ReminderRow>> RemindersAsync(IDbConnection c, string where, object param, IDbTransaction? tx = null) =>
        (await c.QueryAsync<ReminderRow>($"{ReminderSelect} WHERE r.IsActive = 1 AND (t.TaskId IS NOT NULL OR n.NoteId IS NOT NULL) {where}", param, tx)).ToList();

    /// <summary>Closes the open reminder(s) of a task or note (PENDING, or FIRED and not yet acknowledged).</summary>
    static Task CloseRemindersAsync(IDbConnection c, IDbTransaction tx, string column, long itemId, string state, DateTime now, long? exceptReminderId = null) =>
        c.ExecuteAsync($"""
            UPDATE chat.TRN_ChatReminder SET [State] = @state, AcknowledgedUtc = COALESCE(AcknowledgedUtc, @now), UpdatedUtc = @now
            WHERE {column} = @itemId AND IsActive = 1 AND ([State] = 'PENDING' OR ([State] = 'FIRED' AND AcknowledgedUtc IS NULL))
              AND (@except IS NULL OR ReminderId <> @except)
            """, new { state, itemId, now, except = exceptReminderId }, tx);

    static Task AddReminderAsync(IDbConnection c, IDbTransaction tx, long owner, string column, long itemId, DateTime dueUtc, DateTime now) =>
        c.ExecuteAsync($"INSERT chat.TRN_ChatReminder (OwnerUserId, {column}, DueUtc, CreatedUtc, UpdatedUtc) VALUES (@owner, @itemId, @dueUtc, @now, @now)",
            new { owner, itemId, dueUtc, now }, tx);

    // ---- Notes -------------------------------------------------------------------------------------------------------------

    sealed class NoteRow : LinkRow
    {
        public long NoteId { get; set; }
        public Guid Id { get; set; }
        public string Title { get; set; } = "";
        public string? Body { get; set; }
        public bool IsPinned { get; set; }
        public bool IsCompleted { get; set; }
        public bool IsArchived { get; set; }
        public DateTime? NoteDateUtc { get; set; }
        public Guid? TaskId { get; set; }
        public string? TaskTitle { get; set; }
        public string? TaskStatus { get; set; }
    }

    static readonly string NoteSelect = $"""
        SELECT x.NoteId, x.PublicId AS Id, x.Title, x.Body, x.IsPinned, x.IsCompleted, x.IsArchived, x.NoteDateUtc,
               lt.PublicId AS TaskId, lt.Title AS TaskTitle, lt.[Status] AS TaskStatus,
               {LinkColumns}
        FROM chat.TRN_ChatNote x
        {LinkJoins}
        LEFT JOIN chat.TRN_ChatTask lt ON lt.TaskId = x.TaskId AND lt.IsActive = 1
        {ReminderApply("NoteId", "NoteId")}
        WHERE x.IsActive = 1 AND x.OwnerUserId = @me
        """;

    static object NoteDto(NoteRow r) => new
    {
        id = r.Id, title = r.Title, body = r.Body, categoryId = r.CategoryId, categoryName = r.CategoryName, categoryColor = r.CategoryColor,
        isPinned = r.IsPinned, isCompleted = r.IsCompleted, isArchived = r.IsArchived, noteDateUtc = r.NoteDateUtc,
        reminderId = r.ReminderId, reminderUtc = r.ReminderUtc, reminderState = r.ReminderState,
        meeting = r.Meeting,
        task = r.TaskId is { } tid ? new { id = tid, title = r.TaskTitle, status = r.TaskStatus } : null,
        employee = r.Employee,
        conversation = r.Conversation,
        createdUtc = r.CreatedUtc, updatedUtc = r.UpdatedUtc,
    };

    static async Task<object?> NoteByIdAsync(IDbConnection c, Caller me, long noteId) =>
        (await c.QueryAsync<NoteRow>($"{NoteSelect} AND x.NoteId = @noteId", new { me = me.UserId, noteId })).Select(NoteDto).FirstOrDefault();

    const string NoteToday = """
        ((x.NoteDateUtc >= @ds AND x.NoteDateUtc < @de) OR (rm.DueUtc >= @ds AND rm.DueUtc < @de) OR (x.CreatedUtc >= @ds AND x.CreatedUtc < @de))
        """;

    static async Task<(List<object>? Items, IResult? Error)> QueryNotesAsync(IDbConnection c, Caller me, string? filter, string? search, DateTime? from, DateTime? to,
        DateTime ds, DateTime de, int top)
    {
        var f = string.IsNullOrWhiteSpace(filter) ? "all" : filter.Trim().ToLowerInvariant();
        var where = f switch
        {
            "all" => "AND x.IsArchived = 0",
            "today" => $"AND x.IsArchived = 0 AND {NoteToday}",
            "pinned" => "AND x.IsArchived = 0 AND x.IsPinned = 1",
            "completed" => "AND x.IsArchived = 0 AND x.IsCompleted = 1",
            "archived" => "AND x.IsArchived = 1",
            "reminders" => "AND x.IsArchived = 0 AND rm.[State] = 'PENDING'",
            "pinned-today" => $"AND x.IsArchived = 0 AND (x.IsPinned = 1 OR {NoteToday})",
            _ => null,
        };
        if (where is null)
        {
            var v = new Validator();
            v.Add("filter", "Use all, today, pinned, completed, archived or reminders.");
            return (null, v.Problem());
        }
        var term = Like(search);
        if (term is not null) where += " AND (x.Title LIKE @term OR x.Body LIKE @term)";
        DateTime? fromUtc = from is { } a ? AsUtc(a) : null, toUtc = to is { } b ? AsUtc(b) : null;
        if (fromUtc is not null || toUtc is not null)
            where += """
                 AND ((x.NoteDateUtc IS NOT NULL AND (@from IS NULL OR x.NoteDateUtc >= @from) AND (@to IS NULL OR x.NoteDateUtc < @to))
                   OR (rm.DueUtc IS NOT NULL AND (@from IS NULL OR rm.DueUtc >= @from) AND (@to IS NULL OR rm.DueUtc < @to))
                   OR ((@from IS NULL OR x.CreatedUtc >= @from) AND (@to IS NULL OR x.CreatedUtc < @to)))
                """;
        var order = f == "reminders" ? "rm.DueUtc, x.NoteId" : "x.IsPinned DESC, x.UpdatedUtc DESC, x.NoteId DESC";
        var rows = await c.QueryAsync<NoteRow>($"{NoteSelect} {where} ORDER BY {order} OFFSET 0 ROWS FETCH NEXT {top} ROWS ONLY",
            new { me = me.UserId, ds, de, term, from = fromUtc, to = toUtc });
        return (rows.Select(NoteDto).ToList(), null);
    }

    static Task<IResult> Notes(string? filter, string? search, DateTime? from, DateTime? to, DateTime? dayStartUtc, DateTime? dayEndUtc, WorkServices s, HttpContext ctx) =>
        Run(s, ctx, async (c, me) =>
        {
            var (ds, de, dayError) = Day(dayStartUtc, dayEndUtc, me, s.Clock.UtcNow);
            if (dayError is not null) return dayError;
            var (items, error) = await QueryNotesAsync(c, me, filter, search, from, to, ds, de, 500);
            return error ?? Results.Ok(new { items });
        });

    static Task<IResult> GetNote(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var noteId = await OwnNoteIdAsync(c, me, id);
        return noteId is null ? NotFound("Note") : Results.Ok(await NoteByIdAsync(c, me, noteId.Value));
    });

    static Task<IResult> CreateNote(JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, (c, me) => SaveNoteAsync(c, s, me, null, new Input(body)));

    static Task<IResult> PatchNote(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var noteId = await OwnNoteIdAsync(c, me, id);
        return noteId is null ? NotFound("Note") : await SaveNoteAsync(c, s, me, noteId, new Input(body));
    });

    sealed class NoteRaw
    {
        public long NoteId { get; set; }
        public string Title { get; set; } = "";
        public string? Body { get; set; }
        public long? CategoryId { get; set; }
        public bool IsPinned { get; set; }
        public bool IsCompleted { get; set; }
        public DateTime? CompletedUtc { get; set; }
        public bool IsArchived { get; set; }
        public DateTime? NoteDateUtc { get; set; }
        public long? MeetingId { get; set; }
        public long? TaskId { get; set; }
        public long? EmployeeUserId { get; set; }
        public long? ConversationId { get; set; }
    }

    static async Task<IResult> SaveNoteAsync(IDbConnection c, WorkServices s, Caller me, long? noteId, Input inp)
    {
        var now = s.Clock.UtcNow;
        var create = noteId is null;
        var old = create ? null : await c.QuerySingleAsync<NoteRaw>("""
            SELECT NoteId, Title, Body, CategoryId, IsPinned, IsCompleted, CompletedUtc, IsArchived, NoteDateUtc, MeetingId, TaskId, EmployeeUserId, ConversationId
            FROM chat.TRN_ChatNote WHERE NoteId = @noteId
            """, new { noteId });
        var n = create ? new NoteRaw() : old!.MemberwiseCloneNote();
        var v = inp.V;
        if (create || inp.Has("title")) n.Title = v.Required("title", ChatAccess.CleanText(inp.Str("title"), false), TitleMax, "Title") ?? "";
        if (inp.Has("body")) n.Body = v.Optional("body", ChatAccess.CleanText(inp.Str("body"), true), TextMax, "Note");
        if (inp.Has("isPinned")) n.IsPinned = inp.Bool("isPinned") ?? false;
        if (inp.Has("isCompleted")) n.IsCompleted = inp.Bool("isCompleted") ?? false;
        if (inp.Has("isArchived")) n.IsArchived = inp.Bool("isArchived") ?? false;
        if (inp.Has("noteDateUtc")) { n.NoteDateUtc = inp.Utc("noteDateUtc"); CheckDate(v, "noteDateUtc", n.NoteDateUtc, now); }
        var reminderGiven = inp.Has("reminderUtc");
        var reminderUtc = inp.Utc("reminderUtc");
        CheckReminder(v, reminderUtc, now);
        var categoryId = inp.Id("categoryId");
        var meetingId = inp.Id("meetingId");
        var taskId = inp.Id("taskId");
        var employeeId = inp.Id("employeeId");
        var conversationId = inp.Id("conversationId");
        if (reminderUtc is not null && n.IsCompleted) v.Add("reminderUtc", "Mark the note as not completed to set a reminder.");
        if (!v.IsValid) return v.Problem();

        if (inp.Has("categoryId")) n.CategoryId = categoryId is { } cg ? await OwnCategoryIdAsync(c, me, cg) ?? -1 : null;
        if (n.CategoryId == -1) return LinkNotFound("categoryId", "Category");
        if (inp.Has("meetingId")) n.MeetingId = meetingId is { } mg ? await MeetingIdAsync(c, me, mg) ?? -1 : null;
        if (n.MeetingId == -1) return LinkNotFound("meetingId", "Meeting");
        if (inp.Has("taskId")) n.TaskId = taskId is { } tg ? await OwnTaskIdAsync(c, me, tg) ?? -1 : null;
        if (n.TaskId == -1) return LinkNotFound("taskId", "Task");
        if (inp.Has("employeeId")) n.EmployeeUserId = employeeId is { } eg ? await EmployeeUserIdAsync(c, eg) ?? -1 : null;
        if (n.EmployeeUserId == -1) return LinkNotFound("employeeId", "Employee");
        if (inp.Has("conversationId")) n.ConversationId = conversationId is { } cv ? (await ChatAccess.MemberAsync(c, cv, me.UserId))?.ConversationId ?? -1 : null;
        if (n.ConversationId == -1) return LinkNotFound("conversationId", "Conversation");

        if (create && await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatNote WHERE OwnerUserId = @me AND IsActive = 1", new { me = me.UserId }) >= MaxActiveNotes)
            return LimitReached($"You can keep at most {MaxActiveNotes} notes. Delete notes you no longer need.");

        var becameCompleted = n.IsCompleted && (create || !old!.IsCompleted);
        n.CompletedUtc = !n.IsCompleted ? null : becameCompleted ? now : n.CompletedUtc ?? now;
        long id;
        using (var tx = c.BeginTransaction())
        {
            var p = new DynamicParameters(n);
            p.Add("me", me.UserId);
            p.Add("now", now);
            if (create)
                id = await c.QuerySingleAsync<long>("""
                    INSERT chat.TRN_ChatNote (OwnerUserId, Title, Body, CategoryId, IsPinned, IsCompleted, CompletedUtc, IsArchived, NoteDateUtc, MeetingId, TaskId, EmployeeUserId, ConversationId, CreatedUtc, UpdatedUtc)
                    OUTPUT inserted.NoteId
                    VALUES (@me, @Title, @Body, @CategoryId, @IsPinned, @IsCompleted, @CompletedUtc, @IsArchived, @NoteDateUtc, @MeetingId, @TaskId, @EmployeeUserId, @ConversationId, @now, @now)
                    """, p, tx);
            else
            {
                id = noteId!.Value;
                await c.ExecuteAsync("""
                    UPDATE chat.TRN_ChatNote SET Title = @Title, Body = @Body, CategoryId = @CategoryId, IsPinned = @IsPinned, IsCompleted = @IsCompleted, CompletedUtc = @CompletedUtc,
                        IsArchived = @IsArchived, NoteDateUtc = @NoteDateUtc, MeetingId = @MeetingId, TaskId = @TaskId, EmployeeUserId = @EmployeeUserId,
                        ConversationId = @ConversationId, UpdatedUtc = @now
                    WHERE NoteId = @NoteId AND OwnerUserId = @me
                    """, p, tx);
            }
            if (becameCompleted) await CloseRemindersAsync(c, tx, "NoteId", id, "DONE", now);
            if (reminderGiven)
            {
                await CloseRemindersAsync(c, tx, "NoteId", id, "CANCELLED", now);
                if (reminderUtc is { } due) await AddReminderAsync(c, tx, me.UserId, "NoteId", id, due, now);
            }
            tx.Commit();
        }
        return Results.Ok(await NoteByIdAsync(c, me, id));
    }

    static NoteRaw MemberwiseCloneNote(this NoteRaw n) => new()
    {
        NoteId = n.NoteId, Title = n.Title, Body = n.Body, CategoryId = n.CategoryId, IsPinned = n.IsPinned, IsCompleted = n.IsCompleted, CompletedUtc = n.CompletedUtc,
        IsArchived = n.IsArchived, NoteDateUtc = n.NoteDateUtc, MeetingId = n.MeetingId, TaskId = n.TaskId, EmployeeUserId = n.EmployeeUserId, ConversationId = n.ConversationId,
    };

    static Task<IResult> DeleteNote(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var noteId = await OwnNoteIdAsync(c, me, id);
        if (noteId is null) return NotFound("Note");
        var now = s.Clock.UtcNow;
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("UPDATE chat.TRN_ChatNote SET IsActive = 0, UpdatedUtc = @now WHERE NoteId = @noteId", new { noteId, now }, tx);
        await CloseRemindersAsync(c, tx, "NoteId", noteId.Value, "CANCELLED", now);
        tx.Commit();
        return Results.NoContent();
    });

    // ---- Tasks -------------------------------------------------------------------------------------------------------------

    sealed class TaskRow : LinkRow
    {
        public long TaskId { get; set; }
        public Guid Id { get; set; }
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public string? Notes { get; set; }
        public string Priority { get; set; } = "";
        public string Status { get; set; } = "";
        public DateTime? DueUtc { get; set; }
        public bool HasDueTime { get; set; }
        public string RepeatRule { get; set; } = "";
        public DateTime? CompletedUtc { get; set; }
        public Guid? MessageId { get; set; }
        public Guid? MessageConversationId { get; set; }
        public string? MessageSenderName { get; set; }
        public string? MessageBody { get; set; }
        public string? MessageKind { get; set; }
        public DateTime? MessageDeletedUtc { get; set; }
        public DateTime? MessageSentUtc { get; set; }
        public string? MessageFileName { get; set; }
        public bool MessageVisible { get; set; }
        public Guid? CallId { get; set; }
        public string? CallType { get; set; }
        public DateTime? CallStartedUtc { get; set; }
        public string? CallOtherName { get; set; }
        public Guid? NoteId { get; set; }
        public string? NoteTitle { get; set; }
    }

    static readonly string TaskSelect = $"""
        SELECT x.TaskId, x.PublicId AS Id, x.Title, x.[Description], x.Notes, x.[Priority], x.[Status], x.DueUtc, x.HasDueTime, x.RepeatRule, x.CompletedUtc,
               lmsg.PublicId AS MessageId, lmcv.PublicId AS MessageConversationId, CASE WHEN lmp.UserId IS NULL THEN NULL ELSE lmse.DisplayName END AS MessageSenderName,
               CASE WHEN lmp.UserId IS NULL THEN NULL ELSE LEFT(lmsg.Body, 200) END AS MessageBody, lmsg.Kind AS MessageKind, lmsg.DeletedUtc AS MessageDeletedUtc,
               lmsg.CreatedUtc AS MessageSentUtc, CASE WHEN lmp.UserId IS NULL THEN NULL ELSE lmf.OriginalName END AS MessageFileName,
               CAST(CASE WHEN lmp.UserId IS NULL THEN 0 ELSE 1 END AS BIT) AS MessageVisible,
               lcl.PublicId AS CallId, lcl.[Type] AS CallType, lcl.CreatedUtc AS CallStartedUtc,
               CASE WHEN lcl.[Type] = 'GROUP' THEN COALESCE(lclcv.[Name], 'Group call') ELSE lclo.DisplayName END AS CallOtherName,
               ln.PublicId AS NoteId, ln.Title AS NoteTitle,
               {LinkColumns}
        FROM chat.TRN_ChatTask x
        {LinkJoins}
        LEFT JOIN chat.TRN_ChatMessage lmsg ON lmsg.MessageId = x.SourceMessageId
        LEFT JOIN chat.TRN_ChatConversation lmcv ON lmcv.ConversationId = lmsg.ConversationId
        LEFT JOIN chat.TRN_ChatConversationParticipant lmp ON lmp.ConversationId = lmsg.ConversationId AND lmp.UserId = x.OwnerUserId AND lmp.LeftUtc IS NULL
             AND lmsg.MessageId > lmp.VisibleFromMessageId
        LEFT JOIN auth.Users lmsu ON lmsu.UserId = lmsg.SenderUserId LEFT JOIN org.Employees lmse ON lmse.EmployeeId = lmsu.EmployeeId
        LEFT JOIN chat.TRN_ChatFile lmf ON lmf.MessageId = lmsg.MessageId
        LEFT JOIN chat.TRN_ChatCall lcl ON lcl.CallId = x.SourceCallId
             AND EXISTS (SELECT 1 FROM chat.TRN_ChatCallParticipant lclp WHERE lclp.CallId = lcl.CallId AND lclp.UserId = x.OwnerUserId)
        LEFT JOIN chat.TRN_ChatConversation lclcv ON lclcv.ConversationId = lcl.ConversationId
        OUTER APPLY (SELECT TOP (1) ce.DisplayName FROM chat.TRN_ChatCallParticipant cp2 JOIN auth.Users cu ON cu.UserId = cp2.UserId
                     JOIN org.Employees ce ON ce.EmployeeId = cu.EmployeeId
                     WHERE cp2.CallId = lcl.CallId AND cp2.UserId <> x.OwnerUserId ORDER BY cp2.InvitedUtc) lclo
        LEFT JOIN chat.TRN_ChatNote ln ON ln.NoteId = x.NoteId AND ln.IsActive = 1
        {ReminderApply("TaskId", "TaskId")}
        WHERE x.IsActive = 1 AND x.OwnerUserId = @me
        """;

    static string MessageExcerpt(TaskRow r)
    {
        if (!r.MessageVisible) return "Message not available";
        if (r.MessageDeletedUtc is not null) return "Message deleted";
        var text = r.MessageKind == "FILE" && string.IsNullOrWhiteSpace(r.MessageBody) ? (r.MessageFileName is { } f ? "Attachment: " + f : "Attachment") : r.MessageBody;
        return Excerpt(text, 140) ?? "";
    }

    static object TaskDto(TaskRow r, DateTime now) => new
    {
        id = r.Id, title = r.Title, description = r.Description, notes = r.Notes, priority = r.Priority, status = r.Status,
        dueUtc = r.DueUtc, hasDueTime = r.HasDueTime, isOverdue = r.DueUtc is { } d && d < now && r.Status is not ("COMPLETED" or "CANCELLED"),
        categoryId = r.CategoryId, categoryName = r.CategoryName, categoryColor = r.CategoryColor, repeatRule = r.RepeatRule,
        reminderId = r.ReminderId, reminderUtc = r.ReminderUtc, reminderState = r.ReminderState, completedUtc = r.CompletedUtc,
        meeting = r.Meeting,
        employee = r.Employee,
        conversation = r.Conversation,
        message = r.MessageId is { } mid
            ? new { id = mid, conversationId = r.MessageVisible ? r.MessageConversationId : null, senderName = r.MessageSenderName, excerpt = MessageExcerpt(r), sentUtc = r.MessageSentUtc }
            : null,
        call = r.CallId is { } cid ? new { id = cid, type = r.CallType, startedUtc = r.CallStartedUtc, otherName = r.CallOtherName } : null,
        note = r.NoteId is { } nid ? new { id = nid, title = r.NoteTitle } : null,
        createdUtc = r.CreatedUtc, updatedUtc = r.UpdatedUtc,
    };

    static async Task<object?> TaskByIdAsync(IDbConnection c, Caller me, long taskId, DateTime now) =>
        (await c.QueryAsync<TaskRow>($"{TaskSelect} AND x.TaskId = @taskId", new { me = me.UserId, taskId })).Select(r => TaskDto(r, now)).FirstOrDefault();

    const string OpenTask = "x.[Status] NOT IN ('COMPLETED', 'CANCELLED')";
    const string PriorityOrder = "CASE x.[Priority] WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END";

    static string? TaskFilterSql(string f) => f switch
    {
        "all" => $"AND {OpenTask}",
        "today" => $"AND {OpenTask} AND ((x.DueUtc >= @ds AND x.DueUtc < @de) OR (rm.DueUtc >= @ds AND rm.DueUtc < @de))",
        "overdue" => $"AND {OpenTask} AND x.DueUtc < @now",
        "upcoming" => $"AND {OpenTask} AND x.DueUtc >= @de AND x.DueUtc < @upTo",
        "completed" => "AND x.[Status] = 'COMPLETED'",
        "followups" => $"AND {OpenTask} AND (x.SourceMessageId IS NOT NULL OR x.SourceCallId IS NOT NULL OR x.ConversationId IS NOT NULL OR x.MeetingId IS NOT NULL)",
        // Advanced chat (V031): open tasks due in the 7 days from the start of the caller's day; "week-rest" (follow-up panel) leaves today out.
        "week" => $"AND {OpenTask} AND x.DueUtc >= @ds AND x.DueUtc < @weekEnd",
        "week-rest" => $"AND {OpenTask} AND x.DueUtc >= @de AND x.DueUtc < @weekEnd",
        _ => null,
    };

    static async Task<(List<object>? Items, IResult? Error)> QueryTasksAsync(IDbConnection c, Caller me, string? filter, string? search, string? status,
        DateTime ds, DateTime de, DateTime now, int top, bool allowInternal = false)
    {
        var f = string.IsNullOrWhiteSpace(filter) ? "all" : filter.Trim().ToLowerInvariant();
        var where = TaskFilterSql(f);
        var v = new Validator();
        if (where is null || (f == "week-rest" && !allowInternal)) v.Add("filter", "Use all, today, week, overdue, upcoming, completed or followups.");
        var st = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToUpperInvariant();
        if (st is not null && !Statuses.Contains(st)) v.Add("status", "Use PENDING, IN_PROGRESS, COMPLETED, POSTPONED or CANCELLED.");
        if (!v.IsValid) return (null, v.Problem());
        // ?status= narrows the list; with the default "all" filter it replaces the "open only" rule (so status=COMPLETED works).
        if (st is not null) where = (f == "all" ? "" : where) + " AND x.[Status] = @status";
        var term = Like(search);
        if (term is not null) where += " AND (x.Title LIKE @term OR x.[Description] LIKE @term OR x.Notes LIKE @term)";
        string order;
        if (f == "completed") { order = "x.CompletedUtc DESC, x.TaskId DESC"; top = Math.Min(top, 200); }
        else order = $"CASE WHEN x.DueUtc IS NULL THEN 1 ELSE 0 END, x.DueUtc, {PriorityOrder}, x.CreatedUtc DESC";
        var rows = await c.QueryAsync<TaskRow>($"{TaskSelect} {where} ORDER BY {order} OFFSET 0 ROWS FETCH NEXT {top} ROWS ONLY",
            new { me = me.UserId, ds, de, now, upTo = de.AddDays(30), term, status = st, weekEnd = ds.AddDays(7) });
        return (rows.Select(r => TaskDto(r, now)).ToList(), null);
    }

    static Task<int> CountTasksAsync(IDbConnection c, Caller me, string filter, DateTime ds, DateTime de, DateTime now) =>
        c.ExecuteScalarAsync<int>($"""
            SELECT COUNT(*) FROM chat.TRN_ChatTask x {ReminderApply("TaskId", "TaskId")}
            WHERE x.IsActive = 1 AND x.OwnerUserId = @me {TaskFilterSql(filter)}
            """, new { me = me.UserId, ds, de, now, upTo = de.AddDays(30), weekEnd = ds.AddDays(7) });

    static Task<IResult> Tasks(string? filter, string? search, string? status, DateTime? dayStartUtc, DateTime? dayEndUtc, WorkServices s, HttpContext ctx) =>
        Run(s, ctx, async (c, me) =>
        {
            var now = s.Clock.UtcNow;
            var (ds, de, dayError) = Day(dayStartUtc, dayEndUtc, me, now);
            if (dayError is not null) return dayError;
            var (items, error) = await QueryTasksAsync(c, me, filter, search, status, ds, de, now, 500);
            return error ?? Results.Ok(new { items });
        });

    /// <summary>
    /// Quick follow-up panel (advanced chat, V031; needs CHAT_TASKS and CHAT_ADVANCED): open tasks that are overdue, due today, and due
    /// later this week (the 7 days from the start of the caller's day, today left out); at most 50 each.
    /// </summary>
    static Task<IResult> FollowupPanel(DateTime? dayStartUtc, DateTime? dayEndUtc, WorkServices s, HttpContext ctx) =>
        Run(s, ctx, async (c, me) =>
        {
            if (!await ChatAdvancedEndpoints.AdvancedEnabledAsync(c, s.Cache)) return ChatAdvancedEndpoints.Disabled();
            var now = s.Clock.UtcNow;
            var (ds, de, dayError) = Day(dayStartUtc, dayEndUtc, me, now);
            if (dayError is not null) return dayError;
            return Results.Ok(new
            {
                overdue = (await QueryTasksAsync(c, me, "overdue", null, null, ds, de, now, 50)).Items,
                today = (await QueryTasksAsync(c, me, "today", null, null, ds, de, now, 50)).Items,
                week = (await QueryTasksAsync(c, me, "week-rest", null, null, ds, de, now, 50, allowInternal: true)).Items,
            });
        });

    static Task<IResult> GetTask(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var taskId = await OwnTaskIdAsync(c, me, id);
        return taskId is null ? NotFound("Task") : Results.Ok(await TaskByIdAsync(c, me, taskId.Value, s.Clock.UtcNow));
    });

    static Task<IResult> CreateTask(JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var r = await SaveTaskAsync(c, s, me, null, new Input(body));
        return r.Error ?? Results.Ok(await TaskByIdAsync(c, me, r.TaskId, s.Clock.UtcNow));
    });

    static Task<IResult> PatchTask(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var taskId = await OwnTaskIdAsync(c, me, id);
        if (taskId is null) return NotFound("Task");
        var r = await SaveTaskAsync(c, s, me, taskId, new Input(body));
        return r.Error ?? Results.Ok(await TaskByIdAsync(c, me, r.TaskId, s.Clock.UtcNow));
    });

    static Task<IResult> SetStatus(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var taskId = await OwnTaskIdAsync(c, me, id);
        if (taskId is null) return NotFound("Task");
        var inp = new Input(body);
        if (!inp.Has("status") || inp.Str("status") is null) inp.V.Add("status", "Choose a status.");
        if (!inp.V.IsValid) return inp.V.Problem();
        var r = await SaveTaskAsync(c, s, me, taskId, Input.Of(new { status = inp.Str("status") }));
        if (r.Error is not null) return r.Error;
        var now = s.Clock.UtcNow;
        return Results.Ok(new { task = await TaskByIdAsync(c, me, r.TaskId, now), next = r.NextTaskId is { } nx ? await TaskByIdAsync(c, me, nx, now) : null });
    });

    sealed class TaskRaw
    {
        public long TaskId { get; set; }
        public string Title { get; set; } = "";
        public string? Description { get; set; }
        public string? Notes { get; set; }
        public string Priority { get; set; } = "MEDIUM";
        public string Status { get; set; } = "PENDING";
        public DateTime? DueUtc { get; set; }
        public bool HasDueTime { get; set; }
        public long? CategoryId { get; set; }
        public string RepeatRule { get; set; } = "NONE";
        public DateTime? CompletedUtc { get; set; }
        public long? MeetingId { get; set; }
        public long? EmployeeUserId { get; set; }
        public long? ConversationId { get; set; }
        public long? SourceMessageId { get; set; }
        public long? SourceCallId { get; set; }
        public long? NoteId { get; set; }
        public long? RepeatedFromTaskId { get; set; }

        public TaskRaw Copy() => (TaskRaw)MemberwiseClone();
    }

    const string TaskRawSelect = """
        SELECT TaskId, Title, [Description], Notes, [Priority], [Status], DueUtc, HasDueTime, CategoryId, RepeatRule, CompletedUtc, MeetingId, EmployeeUserId,
               ConversationId, SourceMessageId, SourceCallId, NoteId, RepeatedFromTaskId
        FROM chat.TRN_ChatTask WHERE TaskId = @taskId
        """;

    const string TaskInsert = """
        INSERT chat.TRN_ChatTask (OwnerUserId, Title, [Description], Notes, [Priority], [Status], DueUtc, HasDueTime, CategoryId, RepeatRule, CompletedUtc, MeetingId,
            EmployeeUserId, ConversationId, SourceMessageId, SourceCallId, NoteId, RepeatedFromTaskId, CreatedUtc, UpdatedUtc)
        OUTPUT inserted.TaskId
        VALUES (@me, @Title, @Description, @Notes, @Priority, @Status, @DueUtc, @HasDueTime, @CategoryId, @RepeatRule, @CompletedUtc, @MeetingId,
            @EmployeeUserId, @ConversationId, @SourceMessageId, @SourceCallId, @NoteId, @RepeatedFromTaskId, @now, @now)
        """;

    internal sealed record SaveResult(IResult? Error, long TaskId, long? NextTaskId);

    /// <summary>
    /// Create (taskId null) or change a task from a JSON body: validation, links the caller may use, status rules (CompletedUtc),
    /// reminder replace/cancel, closing reminders on complete/cancel, and the next occurrence of a repeating task.
    /// </summary>
    static async Task<SaveResult> SaveTaskAsync(IDbConnection c, WorkServices s, Caller me, long? taskId, Input inp)
    {
        var now = s.Clock.UtcNow;
        var create = taskId is null;
        var old = create ? null : await c.QuerySingleAsync<TaskRaw>(TaskRawSelect, new { taskId });
        var t = old?.Copy() ?? new TaskRaw();
        var v = inp.V;
        if (create || inp.Has("title")) t.Title = v.Required("title", ChatAccess.CleanText(inp.Str("title"), false), TitleMax, "Title") ?? "";
        if (inp.Has("description")) t.Description = v.Optional("description", ChatAccess.CleanText(inp.Str("description"), true), TextMax, "Description");
        if (inp.Has("notes")) t.Notes = v.Optional("notes", ChatAccess.CleanText(inp.Str("notes"), true), TextMax, "Notes");
        if (inp.Has("priority")) t.Priority = inp.Choice("priority", Priorities, "Use LOW, MEDIUM, HIGH or URGENT.") ?? (inp.Str("priority") is null ? "MEDIUM" : t.Priority);
        if (inp.Has("status")) t.Status = inp.Choice("status", Statuses, "Use PENDING, IN_PROGRESS, COMPLETED, POSTPONED or CANCELLED.") ?? (inp.Str("status") is null ? "PENDING" : t.Status);
        if (inp.Has("repeatRule")) t.RepeatRule = inp.Choice("repeatRule", RepeatRules, "Use NONE, DAILY, WEEKDAYS, WEEKLY or MONTHLY.") ?? (inp.Str("repeatRule") is null ? "NONE" : t.RepeatRule);
        if (inp.Has("dueUtc")) { t.DueUtc = inp.Utc("dueUtc"); CheckDate(v, "dueUtc", t.DueUtc, now); }
        if (inp.Has("hasDueTime")) t.HasDueTime = inp.Bool("hasDueTime") ?? false;
        var reminderGiven = inp.Has("reminderUtc");
        var reminderUtc = inp.Utc("reminderUtc");
        CheckReminder(v, reminderUtc, now);
        var categoryId = inp.Id("categoryId");
        var meetingId = inp.Id("meetingId");
        var employeeId = inp.Id("employeeId");
        var conversationId = inp.Id("conversationId");
        var messageId = inp.Id("sourceMessageId");
        var callId = inp.Id("sourceCallId");
        var noteId = inp.Id("noteId");
        if (t.RepeatRule != "NONE" && t.DueUtc is null) v.Add("repeatRule", "Set a due date to repeat a task.");
        var closed = t.Status is "COMPLETED" or "CANCELLED";
        if (reminderUtc is not null && closed) v.Add("reminderUtc", "Reopen the task to set a reminder.");
        if (!v.IsValid) return new SaveResult(v.Problem(), 0, null);

        if (inp.Has("categoryId")) t.CategoryId = categoryId is { } cg ? await OwnCategoryIdAsync(c, me, cg) ?? -1 : null;
        if (t.CategoryId == -1) return new SaveResult(LinkNotFound("categoryId", "Category"), 0, null);
        if (inp.Has("meetingId")) t.MeetingId = meetingId is { } mg ? await MeetingIdAsync(c, me, mg) ?? -1 : null;
        if (t.MeetingId == -1) return new SaveResult(LinkNotFound("meetingId", "Meeting"), 0, null);
        if (inp.Has("employeeId")) t.EmployeeUserId = employeeId is { } eg ? await EmployeeUserIdAsync(c, eg) ?? -1 : null;
        if (t.EmployeeUserId == -1) return new SaveResult(LinkNotFound("employeeId", "Employee"), 0, null);
        if (inp.Has("conversationId")) t.ConversationId = conversationId is { } cv ? (await ChatAccess.MemberAsync(c, cv, me.UserId))?.ConversationId ?? -1 : null;
        if (t.ConversationId == -1) return new SaveResult(LinkNotFound("conversationId", "Conversation"), 0, null);
        if (inp.Has("noteId")) t.NoteId = noteId is { } ng ? await OwnNoteIdAsync(c, me, ng) ?? -1 : null;
        if (t.NoteId == -1) return new SaveResult(LinkNotFound("noteId", "Note"), 0, null);
        if (inp.Has("sourceCallId"))
        {
            if (callId is { } clg)
            {
                if (await MyCallAsync(c, me, clg) is not { } call) return new SaveResult(LinkNotFound("sourceCallId", "Call"), 0, null);
                t.SourceCallId = call.CallId;
                if (call.ConversationId is { } callConv && !inp.Has("conversationId")) t.ConversationId = callConv;
            }
            else t.SourceCallId = null;
        }
        if (inp.Has("sourceMessageId"))
        {
            if (messageId is { } msg)
            {
                if (await VisibleMessageAsync(c, me, msg) is not { } m) return new SaveResult(LinkNotFound("sourceMessageId", "Message"), 0, null);
                t.SourceMessageId = m.MessageId;
                t.ConversationId = m.ConversationId;
            }
            else t.SourceMessageId = null;
        }

        if (create && await c.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM chat.TRN_ChatTask x WHERE x.OwnerUserId = @me AND x.IsActive = 1 AND {OpenTask}",
                new { me = me.UserId }) >= MaxOpenTasks)
            return new SaveResult(LimitReached($"You can have at most {MaxOpenTasks} open tasks. Complete or delete some first."), 0, null);

        var statusChanged = create || old!.Status != t.Status;
        var becameCompleted = t.Status == "COMPLETED" && statusChanged;
        t.CompletedUtc = t.Status != "COMPLETED" ? null : becameCompleted ? now : t.CompletedUtc ?? now;

        long id;
        long? nextId = null;
        using (var tx = c.BeginTransaction())
        {
            var p = new DynamicParameters(t);
            p.Add("me", me.UserId);
            p.Add("now", now);
            if (create) id = await c.QuerySingleAsync<long>(TaskInsert, p, tx);
            else
            {
                id = taskId!.Value;
                await c.ExecuteAsync("""
                    UPDATE chat.TRN_ChatTask SET Title = @Title, [Description] = @Description, Notes = @Notes, [Priority] = @Priority, [Status] = @Status, DueUtc = @DueUtc,
                        HasDueTime = @HasDueTime, CategoryId = @CategoryId, RepeatRule = @RepeatRule, CompletedUtc = @CompletedUtc, MeetingId = @MeetingId,
                        EmployeeUserId = @EmployeeUserId, ConversationId = @ConversationId, SourceMessageId = @SourceMessageId, SourceCallId = @SourceCallId,
                        NoteId = @NoteId, UpdatedUtc = @now
                    WHERE TaskId = @TaskId AND OwnerUserId = @me
                    """, p, tx);
            }

            // The reminder offset of a repeating task is read before its reminder is closed.
            DateTime? lastReminderDue = null;
            if (becameCompleted && t.RepeatRule != "NONE" && t.DueUtc is not null && !create)
                lastReminderDue = await c.QuerySingleOrDefaultAsync<DateTime?>(
                    "SELECT TOP (1) DueUtc FROM chat.TRN_ChatReminder WHERE TaskId = @id AND IsActive = 1 AND [State] <> 'CANCELLED' ORDER BY ReminderId DESC", new { id }, tx);

            if (statusChanged && t.Status is "COMPLETED" or "CANCELLED")
                await CloseRemindersAsync(c, tx, "TaskId", id, t.Status == "COMPLETED" ? "DONE" : "CANCELLED", now);
            if (reminderGiven && !closed)
            {
                await CloseRemindersAsync(c, tx, "TaskId", id, "CANCELLED", now);
                if (reminderUtc is { } due) await AddReminderAsync(c, tx, me.UserId, "TaskId", id, due, now);
            }

            if (becameCompleted && t.RepeatRule != "NONE" && t.DueUtc is { } dueUtc
                && await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatTask WHERE RepeatedFromTaskId = @id AND IsActive = 1", new { id }, tx) == 0)
            {
                var next = t.Copy();
                next.Status = "PENDING";
                next.CompletedUtc = null;
                next.DueUtc = NextDue(dueUtc, t.RepeatRule, Zone(me.TimeZoneId));
                next.RepeatedFromTaskId = id;
                var np = new DynamicParameters(next);
                np.Add("me", me.UserId);
                np.Add("now", now);
                nextId = await c.QuerySingleAsync<long>(TaskInsert, np, tx);
                var offset = (reminderGiven ? reminderUtc : lastReminderDue) is { } rd ? AsUtc(dueUtc) - AsUtc(rd) : (TimeSpan?)null;
                if (offset is { } off) await AddReminderAsync(c, tx, me.UserId, "TaskId", nextId.Value, next.DueUtc.Value - off, now);
            }
            tx.Commit();
        }
        return new SaveResult(null, id, nextId);
    }

    /// <summary>The next due time of a repeating task, in the owner's time zone (so "weekdays" and "monthly" follow their calendar).</summary>
    internal static DateTime NextDue(DateTime dueUtc, string rule, TimeZoneInfo tz)
    {
        var local = TimeZoneInfo.ConvertTimeFromUtc(AsUtc(dueUtc), tz);
        var next = rule switch
        {
            "DAILY" => local.AddDays(1),
            "WEEKLY" => local.AddDays(7),
            "MONTHLY" => local.AddMonths(1),
            "WEEKDAYS" => local.AddDays(local.DayOfWeek switch { DayOfWeek.Friday => 3, DayOfWeek.Saturday => 2, _ => 1 }),
            _ => local,
        };
        return LocalToUtc(next, tz);
    }

    static Task<IResult> DeleteTask(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var taskId = await OwnTaskIdAsync(c, me, id);
        if (taskId is null) return NotFound("Task");
        var now = s.Clock.UtcNow;
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET IsActive = 0, UpdatedUtc = @now WHERE TaskId = @taskId", new { taskId, now }, tx);
        await CloseRemindersAsync(c, tx, "TaskId", taskId.Value, "CANCELLED", now);
        tx.Commit();
        return Results.NoContent();
    });

    // ---- Reminder endpoints ------------------------------------------------------------------------------------------------

    static Task<IResult> DueReminders(WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
        Results.Ok((await RemindersAsync(c, "AND r.OwnerUserId = @me AND r.[State] = 'FIRED' AND r.AcknowledgedUtc IS NULL ORDER BY r.DueUtc, r.ReminderId OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY",
            new { me = me.UserId })).Select(ReminderDto)));

    static Task<IResult> UpcomingReminders(int? days, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var until = s.Clock.UtcNow.AddDays(Math.Clamp(days ?? 7, 1, 60));
        return Results.Ok((await RemindersAsync(c, "AND r.OwnerUserId = @me AND r.[State] = 'PENDING' AND r.DueUtc < @until ORDER BY r.DueUtc, r.ReminderId OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY",
            new { me = me.UserId, until })).Select(ReminderDto));
    });

    static async Task<ReminderRow?> OwnReminderAsync(IDbConnection c, Caller me, Guid id) =>
        (await RemindersAsync(c, "AND r.PublicId = @id AND r.OwnerUserId = @me", new { id, me = me.UserId })).FirstOrDefault();

    static async Task<ReminderRow> ReloadReminderAsync(IDbConnection c, long reminderId) =>
        (await c.QueryAsync<ReminderRow>($"{ReminderSelect} WHERE r.ReminderId = @reminderId", new { reminderId })).Single();

    static Task<IResult> Snooze(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var r = await OwnReminderAsync(c, me, id);
        if (r is null) return NotFound("Reminder");
        var inp = new Input(body);
        var v = inp.V;
        var minutes = inp.Int("minutes");
        var until = inp.Utc("untilUtc");
        var now = s.Clock.UtcNow;
        if ((minutes is null) == (until is null)) v.Add("minutes", "Send either minutes or untilUtc.");
        if (minutes is { } m && (m < 1 || m > 10080)) v.Add("minutes", "Choose between 1 minute and 7 days.");
        if (until is { } u && (u <= now || u > now.AddYears(1))) v.Add("untilUtc", "Choose a time in the future, at most one year ahead.");
        if (!v.IsValid) return v.Problem();
        if (r.State is not ("PENDING" or "FIRED" or "DISMISSED")) return Db_.Conflict("This reminder is already closed.");
        if (r.TaskStatus is "COMPLETED" or "CANCELLED") return Db_.Conflict("This task is already closed. Reopen it to set a reminder.");
        var due = until ?? now.AddMinutes(minutes!.Value);
        using (var tx = c.BeginTransaction())
        {
            await CloseRemindersAsync(c, tx, r.TaskId is not null ? "TaskId" : "NoteId", r.TaskId ?? r.NoteId!.Value, "CANCELLED", now, r.ReminderId);
            await c.ExecuteAsync("""
                UPDATE chat.TRN_ChatReminder SET [State] = 'PENDING', DueUtc = @due, FiredUtc = NULL, AcknowledgedUtc = NULL, SnoozeCount = SnoozeCount + 1, UpdatedUtc = @now
                WHERE ReminderId = @rid
                """, new { due, now, rid = r.ReminderId }, tx);
            tx.Commit();
        }
        var dto = ReminderDto(await ReloadReminderAsync(c, r.ReminderId));
        await s.Push.ToUsersAsync([me.UserId], "reminder.updated", dto);
        return Results.Ok(dto);
    });

    static Task<IResult> ReminderDone(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var r = await OwnReminderAsync(c, me, id);
        if (r is null) return NotFound("Reminder");
        var now = s.Clock.UtcNow;
        object? task = null, note = null, next = null;
        if (r.TaskId is { } taskId)
        {
            long? nextId = null;
            if (r.TaskStatus != "COMPLETED")
            {
                var res = await SaveTaskAsync(c, s, me, taskId, Input.Of(new { status = "COMPLETED" }));
                if (res.Error is not null) return res.Error;
                nextId = res.NextTaskId;
            }
            task = await TaskByIdAsync(c, me, taskId, now);
            if (nextId is { } nx) next = await TaskByIdAsync(c, me, nx, now);
        }
        else
        {
            await c.ExecuteAsync("UPDATE chat.TRN_ChatNote SET IsCompleted = 1, CompletedUtc = COALESCE(CompletedUtc, @now), UpdatedUtc = @now WHERE NoteId = @noteId AND IsCompleted = 0",
                new { noteId = r.NoteId, now });
            note = await NoteByIdAsync(c, me, r.NoteId!.Value);
        }
        await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatReminder SET [State] = 'DONE', AcknowledgedUtc = COALESCE(AcknowledgedUtc, @now), UpdatedUtc = @now
            WHERE ReminderId = @rid AND [State] IN ('PENDING', 'FIRED', 'DISMISSED', 'DONE')
            """, new { rid = r.ReminderId, now });
        var dto = ReminderDto(await ReloadReminderAsync(c, r.ReminderId));
        await s.Push.ToUsersAsync([me.UserId], "reminder.updated", dto);
        return Results.Ok(new { reminder = dto, task, note, next });
    });

    static Task<IResult> Dismiss(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var r = await OwnReminderAsync(c, me, id);
        if (r is null) return NotFound("Reminder");
        var now = s.Clock.UtcNow;
        await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatReminder SET [State] = 'DISMISSED', AcknowledgedUtc = COALESCE(AcknowledgedUtc, @now), UpdatedUtc = @now
            WHERE ReminderId = @rid AND [State] IN ('PENDING', 'FIRED')
            """, new { rid = r.ReminderId, now });
        var dto = ReminderDto(await ReloadReminderAsync(c, r.ReminderId));
        await s.Push.ToUsersAsync([me.UserId], "reminder.updated", dto);
        return Results.Ok(dto);
    });

    // ---- My Day ------------------------------------------------------------------------------------------------------------

    sealed record MeetingRow(Guid Id, string Title, DateTime StartUtc, DateTime EndUtc, string Status, string Category);

    sealed class ChatRow
    {
        public Guid Id { get; set; }
        public string Type { get; set; } = "";
        public string? Title { get; set; }
        public bool IsPinned { get; set; }
        public bool MarkedUnread { get; set; }
        public int Unread { get; set; }
        public string? LastBody { get; set; }
        public string? LastKind { get; set; }
        public DateTime? LastDeleted { get; set; }
        public DateTime? LastUtc { get; set; }
        public string? LastFileName { get; set; }
    }

    static Task<IResult> MyDay(DateTime? dayStartUtc, DateTime? dayEndUtc, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var now = s.Clock.UtcNow;
        var (ds, de, dayError) = Day(dayStartUtc, dayEndUtc, me, now);
        if (dayError is not null) return dayError;

        var todayTasks = (await QueryTasksAsync(c, me, "today", null, null, ds, de, now, 50)).Items!;
        var overdueTasks = (await QueryTasksAsync(c, me, "overdue", null, null, ds, de, now, 50)).Items!;
        var followUps = (await QueryTasksAsync(c, me, "followups", null, null, ds, de, now, 10)).Items!;
        var notes = (await QueryNotesAsync(c, me, "pinned-today", null, null, null, ds, de, 8)).Items!;
        var upcoming = (await RemindersAsync(c, "AND r.OwnerUserId = @me AND r.[State] = 'PENDING' AND r.DueUtc < @until ORDER BY r.DueUtc, r.ReminderId OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
            new { me = me.UserId, until = now.AddDays(7) })).Select(ReminderDto).ToList();
        var missedRows = await RemindersAsync(c, "AND r.OwnerUserId = @me AND r.[State] = 'FIRED' AND r.AcknowledgedUtc IS NULL ORDER BY r.DueUtc, r.ReminderId OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY",
            new { me = me.UserId });

        var meetings = (await c.QueryAsync<MeetingRow>($"""
            SELECT TOP (30) m.PublicId AS Id, m.Title, m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc, m.[Status], m.Category
            FROM mtg.Meetings m
            WHERE m.ScheduledStartUtc < @de AND m.ScheduledEndUtc > @ds AND m.[Status] <> 'DRAFT' AND {MeetingEndpoints.Visible}
            ORDER BY CASE WHEN m.[Status] = 'CANCELLED' THEN 1 ELSE 0 END, m.ScheduledStartUtc
            """, new { ds, de, all = false, emp = me.EmployeeId })).Select(m => new
        {
            id = m.Id, title = m.Title, startUtc = m.StartUtc, endUtc = m.EndUtc, status = m.Status,
            kind = m.Category.StartsWith("CUSTOMER", StringComparison.Ordinal) ? "customer" : "internal",
            joinPath = $"/meetings/{m.Id}",
        }).ToList();

        var chats = (await c.QueryAsync<ChatRow>("""
            SELECT TOP (6) cv.PublicId AS Id, cv.[Type], CASE WHEN cv.[Type] = 'GROUP' THEN cv.[Name] ELSE oe.DisplayName END AS Title, p.IsPinned, p.MarkedUnread,
                   un.n AS Unread, LEFT(lm.Body, 200) AS LastBody, lm.Kind AS LastKind, lm.DeletedUtc AS LastDeleted, lm.CreatedUtc AS LastUtc, lf.OriginalName AS LastFileName
            FROM chat.TRN_ChatConversationParticipant p
            JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = p.ConversationId AND cv.IsActive = 1
            CROSS APPLY (SELECT COUNT(*) AS n FROM (SELECT TOP (100) 1 AS x FROM chat.TRN_ChatMessage um
                    WHERE um.ConversationId = cv.ConversationId AND um.MessageId > p.LastReadMessageId AND um.MessageId > p.VisibleFromMessageId
                      AND um.Kind <> 'SYSTEM' AND um.SenderUserId <> @me AND um.DeletedUtc IS NULL) t) un
            LEFT JOIN chat.TRN_ChatMessage lm ON lm.MessageId = cv.LastMessageId AND lm.MessageId > p.VisibleFromMessageId
            LEFT JOIN chat.TRN_ChatFile lf ON lf.MessageId = lm.MessageId
            OUTER APPLY (SELECT TOP (1) x.UserId FROM chat.TRN_ChatConversationParticipant x WHERE cv.[Type] = 'DIRECT' AND x.ConversationId = cv.ConversationId AND x.UserId <> @me) o
            LEFT JOIN auth.Users ou ON ou.UserId = o.UserId LEFT JOIN org.Employees oe ON oe.EmployeeId = ou.EmployeeId
            WHERE p.UserId = @me AND p.LeftUtc IS NULL AND p.IsArchived = 0 AND (p.IsPinned = 1 OR p.MarkedUnread = 1 OR un.n > 0)
            ORDER BY p.IsPinned DESC, COALESCE(cv.LastMessageUtc, cv.CreatedUtc) DESC
            """, new { me = me.UserId })).Select(r => new
        {
            id = r.Id, title = r.Title, isGroup = r.Type == "GROUP", unread = Math.Max(r.Unread, r.MarkedUnread ? 1 : 0),
            lastMessageExcerpt = r.LastUtc is null ? null : r.LastDeleted is not null ? "Message deleted"
                : r.LastKind == "FILE" && string.IsNullOrWhiteSpace(r.LastBody) ? (r.LastFileName is { } f ? "Attachment: " + f : "Attachment") : Excerpt(r.LastBody, 140),
            lastMessageUtc = r.LastUtc, isPinned = r.IsPinned,
        }).ToList();

        var recentCalls = new List<object>();
        if (await ChatCallEndpoints.CallsEnabledAsync(c, s.Cache))
        {
            var ids = await c.QueryAsync<long>("""
                SELECT TOP (5) cl.CallId FROM chat.TRN_ChatCall cl JOIN chat.TRN_ChatCallParticipant mine ON mine.CallId = cl.CallId AND mine.UserId = @me ORDER BY cl.CallId DESC
                """, new { me = me.UserId });
            foreach (var callId in ids)
                if (await ChatCallEndpoints.LoadCallAsync(c, callId) is { } call)
                    recentCalls.Add(ChatCallEndpoints.Dto(call, await ChatCallEndpoints.LoadPartsAsync(c, callId), now));
        }

        return Results.Ok(new
        {
            todayTasks, overdueTasks,
            upcomingReminders = upcoming,
            missedReminders = missedRows.Select(ReminderDto).ToList(),
            meetings, notes, followUps,
            importantChats = chats,
            recentCalls,
            counts = new
            {
                todayTasks = await CountTasksAsync(c, me, "today", ds, de, now),
                overdue = await CountTasksAsync(c, me, "overdue", ds, de, now),
                missed = missedRows.Count,
                followUps = await CountTasksAsync(c, me, "followups", ds, de, now),
            },
        });
    });

    /// <summary>Meeting picker: up to 20 meetings the caller organises or is invited to (upcoming first, then the last 30 days).</summary>
    static Task<IResult> WorkMeetings(string? search, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var now = s.Clock.UtcNow;
        var rows = await c.QueryAsync<(Guid Id, string Title, DateTime StartUtc)>($"""
            SELECT TOP (20) m.PublicId AS Id, m.Title, m.ScheduledStartUtc AS StartUtc FROM mtg.Meetings m
            WHERE {MeetingEndpoints.Visible} AND m.[Status] <> 'CANCELLED' AND m.ScheduledEndUtc >= @monthAgo
              AND (@term IS NULL OR m.Title LIKE @term OR m.MeetingCode LIKE @term)
            ORDER BY CASE WHEN m.ScheduledEndUtc >= @now THEN 0 ELSE 1 END,
                     CASE WHEN m.ScheduledEndUtc >= @now THEN m.ScheduledStartUtc END ASC, m.ScheduledStartUtc DESC
            """, new { all = false, emp = me.EmployeeId, now, monthAgo = now.AddDays(-30), term = Like(search) });
        return Results.Ok(rows.Select(r => new { id = r.Id, title = r.Title, startUtc = r.StartUtc }));
    });
}

/// <summary>
/// Fires due reminders every Chat:ReminderPollSeconds (CHAT and CHAT_TASKS on). Each reminder is claimed with one atomic UPDATE
/// (UPDLOCK + READPAST) so it fires exactly once even with two API instances; the bell notification is written in the same
/// transaction. With the switch off nothing happens: reminders stay PENDING and fire when it is switched back on.
/// </summary>
public sealed class ChatReminderWorker(Db db, ChatPush push, IClock clock, IOptions<ChatOptions> options, IMemoryCache cache,
    ILogger<ChatReminderWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, options.Value.ReminderPollSeconds)), stoppingToken); }
            catch (OperationCanceledException) { return; }
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning(e, "Chat reminder pass failed"); }
        }
    }

    /// <summary>One pass; returns how many reminders fired.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct = default)
    {
        using var c = await db.OpenAsync(ct);
        if (!await ChatAccess.EnabledAsync(c, cache) || !await ChatWorkEndpoints.TasksEnabledAsync(c, cache)) return 0;
        var now = clock.UtcNow;
        // Reminders of tasks that were completed / cancelled / deleted (or notes completed / deleted) are not shown.
        await c.ExecuteAsync("""
            UPDATE r SET r.[State] = 'CANCELLED', r.UpdatedUtc = @now
            FROM chat.TRN_ChatReminder r
            LEFT JOIN chat.TRN_ChatTask t ON t.TaskId = r.TaskId
            LEFT JOIN chat.TRN_ChatNote n ON n.NoteId = r.NoteId
            WHERE r.[State] = 'PENDING' AND r.IsActive = 1 AND r.DueUtc <= @now
              AND ((r.TaskId IS NOT NULL AND (t.IsActive = 0 OR t.[Status] IN ('COMPLETED', 'CANCELLED'))) OR (r.NoteId IS NOT NULL AND (n.IsActive = 0 OR n.IsCompleted = 1)))
            """, new { now });

        List<ChatWorkEndpoints.ReminderRow> fired;
        using (var tx = c.BeginTransaction())
        {
            var ids = (await c.QueryAsync<long>("""
                UPDATE TOP (200) chat.TRN_ChatReminder WITH (UPDLOCK, READPAST, ROWLOCK)
                SET [State] = 'FIRED', FiredUtc = @now, UpdatedUtc = @now
                OUTPUT inserted.ReminderId
                WHERE [State] = 'PENDING' AND DueUtc <= @now AND IsActive = 1
                  AND EXISTS (SELECT 1 FROM auth.EffectivePermissions(OwnerUserId) ep WHERE ep.Code = 'chat.tasks')
                """, new { now }, tx)).ToList();
            fired = ids.Count == 0 ? [] : (await c.QueryAsync<ChatWorkEndpoints.ReminderRow>($"{ChatWorkEndpoints.ReminderSelect} WHERE r.ReminderId IN @ids ORDER BY r.DueUtc",
                new { ids }, tx)).ToList();
            if (fired.Count > 0)
                await c.ExecuteAsync("""
                    INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@u, NULL, @type, @title, @body, @link)
                    """, fired.Select(r => new
                {
                    u = r.OwnerUserId,
                    type = Type(r),
                    title = Title(r),
                    body = r.Details is { Length: > 0 } d ? (d.Length > 200 ? d[..199] + "…" : d).Replace('\n', ' ') : null,
                    link = r.Kind == "TASK" ? $"/chat?tab=tasks&task={r.ItemId}" : $"/chat?tab=notes&note={r.ItemId}",
                }), tx);
            tx.Commit();
        }
        foreach (var r in fired)
        {
            await push.ToUsersAsync([r.OwnerUserId], "notification.new", new { type = Type(r), title = Title(r) });
            await push.ToUsersAsync([r.OwnerUserId], "reminder.due", ChatWorkEndpoints.ReminderDto(r));
        }
        return fired.Count;
    }

    static string Type(ChatWorkEndpoints.ReminderRow r) => r.Kind == "TASK" ? "TASK_REMINDER" : "NOTE_REMINDER";

    static string Title(ChatWorkEndpoints.ReminderRow r)
    {
        var t = $"Reminder: {(string.IsNullOrWhiteSpace(r.Title) ? (r.Kind == "TASK" ? "task" : "note") : r.Title)}";
        return t.Length > 200 ? t[..199] + "…" : t;
    }
}
