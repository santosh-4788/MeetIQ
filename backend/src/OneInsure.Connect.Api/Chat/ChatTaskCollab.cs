using System.Data;
using System.Globalization;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// Task collaboration (V033, 21 Nov 2026): give a task to colleagues (one copy per person, OwnerUserId = that person), accept /
/// decline / ask for a new date, "needs my review" (the owner sends it for review, the person who assigned it approves or sends it
/// back), checklists with required steps, comments and history, reminder nudges, proof files, Top 3 for today, shared notes and
/// task e-mails. Only the owner and the person who assigned a task can see it; anything else is answered with 404.
/// Assigning, review, comments, files, nudges and note sharing need TASK_COLLAB on (plus CHAT and CHAT_TASKS); checklists and Top 3
/// only need CHAT_TASKS. Task text is never written to logs or the audit log.
/// </summary>
public static partial class ChatWorkEndpoints
{
    public const string CollabKey = RoomFeatureEndpoints.Keys.TaskCollab;
    public const int MaxAssignees = 25;
    public const int MaxChecklistItems = 50;
    public const int ChecklistTextMax = 300;
    public const int CommentMax = 2000;
    public const int ReasonMax = 500;
    public const int MaxFocus = 3;
    public const int MaxShares = 25;
    public const int MaxTaskFiles = 20;
    public const int TaskFileMaxMb = 25;
    static readonly TimeSpan NudgeGap = TimeSpan.FromHours(4);

    static void MapCollaboration(RouteGroupBuilder g)
    {
        g.MapGet("/tasks/assignees", Assignees);
        g.MapGet("/tasks/settings", GetTaskSettings);
        g.MapPut("/tasks/settings", PutTaskSettings).RequireRateLimiting(WriteRateLimit);
        g.MapGet("/tasks/{id:guid}/details", TaskDetails);
        g.MapPost("/tasks/{id:guid}/focus", Focus).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/checklist", AddChecklistItem).RequireRateLimiting(WriteRateLimit);
        g.MapPatch("/tasks/{id:guid}/checklist/{itemId:guid}", PatchChecklistItem).RequireRateLimiting(WriteRateLimit);
        g.MapDelete("/tasks/{id:guid}/checklist/{itemId:guid}", DeleteChecklistItem).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/accept", Accept).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/decline", Decline).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/request-date", RequestDate).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/date-request", AnswerDateRequest).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/submit", Submit).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/review", Review).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/comments", Comment).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/nudge", Nudge).RequireRateLimiting(WriteRateLimit);
        g.MapPost("/tasks/{id:guid}/files", UploadTaskFile).RequireRateLimiting(ChatEndpoints.UploadRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute((TaskFileMaxMb + 1) * 1024L * 1024L),
                new RequestFormLimitsAttribute { MultipartBodyLengthLimit = (TaskFileMaxMb + 1) * 1024L * 1024L });
        g.MapGet("/task-files/{id:guid}", DownloadTaskFile);
        g.MapDelete("/task-files/{id:guid}", DeleteTaskFile);
        g.MapGet("/notes/{id:guid}/shares", NoteShares);
        g.MapPut("/notes/{id:guid}/shares", ShareNote).RequireRateLimiting(WriteRateLimit);
    }

    // ---- Switch and access -------------------------------------------------------------------------------------------------

    /// <summary>The TASK_COLLAB switch, cached for 10 s. A database without V033 means "off".</summary>
    public static async Task<bool> CollabEnabledAsync(IDbConnection c, IMemoryCache cache)
    {
        if (cache.TryGetValue("chat:task-collab", out bool on)) return on;
        on = (await RoomFeatureEndpoints.EnabledAsync(c)).Contains(CollabKey);
        cache.Set("chat:task-collab", on, TimeSpan.FromSeconds(10));
        return on;
    }

    static IResult CollabDisabled() =>
        Problems.Create(403, "FEATURE_DISABLED", "Assigning tasks, reviews, comments and sharing are switched off by your administrator.");

    static Task<IResult> RunCollab(WorkServices s, HttpContext ctx, Func<IDbConnection, Caller, Task<IResult>> run) =>
        Run(s, ctx, async (c, me) => await CollabEnabledAsync(c, s.Cache) ? await run(c, me) : CollabDisabled());

    internal sealed class TaskAccess
    {
        public long TaskId { get; set; }
        public Guid Id { get; set; }
        public long OwnerUserId { get; set; }
        public long? AssignedByUserId { get; set; }
        public bool IsOwner { get; set; }
        public string Status { get; set; } = "";
        public string? AssignState { get; set; }
        public bool RequiresReview { get; set; }
        public string Title { get; set; } = "";
        public DateTime? DueUtc { get; set; }
        public bool HasDueTime { get; set; }
        public DateTime? RequestedDueUtc { get; set; }
        public string? OwnerName { get; set; }
        public bool IsClosed => Status is "COMPLETED" or "CANCELLED";
        public bool IsAssigned => AssignedByUserId is not null;
        /// <summary>The other person on an assigned task (owner ↔ assigner); null for a personal task.</summary>
        public long? Other => AssignedByUserId is { } ab ? (IsOwner ? ab : OwnerUserId) : null;
    }

    /// <summary>A task the caller owns or assigned (else null → 404).</summary>
    static Task<TaskAccess?> VisibleTaskAsync(IDbConnection c, Caller me, Guid id, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<TaskAccess>("""
            SELECT t.TaskId, t.PublicId AS Id, t.OwnerUserId, t.AssignedByUserId, CAST(CASE WHEN t.OwnerUserId = @me THEN 1 ELSE 0 END AS BIT) AS IsOwner,
                   t.[Status], t.AssignState, t.RequiresReview, t.Title, t.DueUtc, t.HasDueTime, t.RequestedDueUtc, e.DisplayName AS OwnerName
            FROM chat.TRN_ChatTask t JOIN auth.Users u ON u.UserId = t.OwnerUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE t.PublicId = @id AND t.IsActive = 1 AND (t.OwnerUserId = @me OR t.AssignedByUserId = @me)
            """, new { id, me = me.UserId }, tx);

    static IResult OnlyOwner(TaskAccess t) =>
        Problems.Create(403, "FORBIDDEN", $"Only {t.OwnerName ?? "the person doing this task"} can change its status. You can review it when it is sent to you.");
    static IResult OnlyAssigner() => Problems.Create(403, "FORBIDDEN", "Only the person who assigned this task can do this.");
    static IResult NotAssigned() => Problems.Create(409, "NOT_ASSIGNED", "This is a personal task; nobody assigned it.");
    static IResult Closed() => Db_.Conflict("This task is already closed.");

    static Task<int> RequiredOpenAsync(IDbConnection c, long taskId, IDbTransaction? tx = null) =>
        c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatTaskChecklist WHERE TaskId = @taskId AND IsActive = 1 AND IsRequired = 1 AND IsDone = 0", new { taskId }, tx);

    static Task AddActivityAsync(IDbConnection c, IDbTransaction? tx, long taskId, long? actor, string kind, string? body, DateTime? dueUtc, DateTime now) =>
        c.ExecuteAsync("INSERT chat.TRN_ChatTaskActivity (TaskId, ActorUserId, Kind, Body, DueUtc, CreatedUtc) VALUES (@taskId, @actor, @kind, @body, @dueUtc, @now)",
            new { taskId, actor, kind, body, dueUtc, now }, tx);

    /// <summary>Active colleagues who may use tasks (V032 chat.tasks), never the caller.</summary>
    static async Task<Dictionary<Guid, long>> ResolveColleaguesAsync(IDbConnection c, Caller me, IEnumerable<Guid> ids) =>
        (await c.QueryAsync<(Guid Id, long UserId)>("""
            SELECT u.PublicId AS Id, u.UserId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            WHERE u.PublicId IN @ids AND u.IsActive = 1 AND u.UserId <> @me
              AND EXISTS (SELECT 1 FROM auth.EffectivePermissions(u.UserId) ep WHERE ep.Code = 'chat.tasks')
            """, new { ids = ids.Distinct().ToArray(), me = me.UserId })).ToDictionary(r => r.Id, r => r.UserId);

    static List<Guid>? ReadIds(Input inp, string field, int max, string what)
    {
        var list = inp.Array(field);
        if (list is null) return null;
        var ids = new List<Guid>();
        foreach (var e in list)
        {
            if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)) { if (!ids.Contains(g)) ids.Add(g); }
            else { inp.V.Add(field, $"Not a valid {what} id."); return null; }
        }
        if (ids.Count > max) inp.V.Add(field, $"Choose at most {max} {what}s.");
        return ids;
    }

    // ---- Notifications and e-mail ------------------------------------------------------------------------------------------

    sealed record NotifyTask(Guid Id, string Title, DateTime? DueUtc, bool HasDueTime, string Priority, string? AssignerName, string? OwnerName);

    /// <summary>
    /// Bell + live pop-up (and, when asked and the person wants task e-mails, an e-mail) for one person about one task. People who
    /// lost Notes &amp; tasks access (V032) get nothing. Both people on the task also get "task.changed" so open screens refresh.
    /// </summary>
    internal static async Task NotifyTaskAsync(IDbConnection c, WorkServices s, long userId, string type, long taskId, string title, string? body, bool email,
        string? emailIntro = null) =>
        await NotifyTaskAsync(c, s.Push, s.Email, s.WebBaseUrl, userId, type, taskId, title, body, email, emailIntro);

    internal static async Task NotifyTaskAsync(IDbConnection c, ChatPush push, EmailOptions emailOptions, string webBaseUrl, long userId, string type, long taskId,
        string title, string? body, bool email, string? emailIntro = null)
    {
        var t = await c.QuerySingleOrDefaultAsync<NotifyTask>("""
            SELECT t.PublicId AS Id, t.Title, t.DueUtc, t.HasDueTime, t.[Priority] AS Priority, ae.DisplayName AS AssignerName, oe.DisplayName AS OwnerName
            FROM chat.TRN_ChatTask t
            JOIN auth.Users ou ON ou.UserId = t.OwnerUserId LEFT JOIN org.Employees oe ON oe.EmployeeId = ou.EmployeeId
            LEFT JOIN auth.Users au ON au.UserId = t.AssignedByUserId LEFT JOIN org.Employees ae ON ae.EmployeeId = au.EmployeeId
            WHERE t.TaskId = @taskId
            """, new { taskId });
        if (t is null) return;
        var allowed = await c.ExecuteScalarAsync<int>("""
            SELECT COUNT(*) FROM auth.Users u WHERE u.UserId = @userId AND u.IsActive = 1 AND EXISTS (SELECT 1 FROM auth.EffectivePermissions(u.UserId) ep WHERE ep.Code = 'chat.tasks')
            """, new { userId }) > 0;
        if (!allowed) return;
        var link = $"/tasks?task={t.Id}";
        await c.ExecuteAsync("""
            INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@userId, NULL, @type, @title, @body, @link)
            """, new { userId, type, title = Cut(title, 200), body = body is null ? null : Cut(body.Replace('\n', ' '), 1000), link });
        await push.ToUsersAsync([userId], "notification.new", new { type, title = Cut(title, 200), body = body is null ? null : Cut(body, 200), link, taskId = t.Id });
        if (email) await QueueTaskEmailAsync(c, emailOptions, webBaseUrl, userId, type, t, title, emailIntro ?? body);
    }

    static string Cut(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    static async Task QueueTaskEmailAsync(IDbConnection c, EmailOptions o, string webBaseUrl, long userId, string type, NotifyTask t, string subject, string? intro)
    {
        var who = await c.QuerySingleOrDefaultAsync<(string Email, string? Name, string? TimeZoneId, bool Wants)?>("""
            SELECT u.Email, e.DisplayName AS Name, u.TimeZoneId, CAST(COALESCE(p.TaskEmails, 1) AS BIT) AS Wants
            FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId LEFT JOIN chat.MST_ChatUserPreference p ON p.UserId = u.UserId
            WHERE u.UserId = @userId AND u.IsActive = 1
            """, new { userId });
        if (who is not { Wants: true } w || string.IsNullOrWhiteSpace(w.Email)) return;
        var details = new List<(string, string)> { ("Task", t.Title) };
        if (t.DueUtc is { } due)
        {
            var local = TimeZoneInfo.ConvertTimeFromUtc(AsUtc(due), Zone(w.TimeZoneId));
            details.Add(("Due", local.ToString(t.HasDueTime ? "ddd d MMM yyyy, h:mm tt" : "ddd d MMM yyyy", CultureInfo.GetCultureInfo("en-IN"))));
        }
        details.Add(("Priority", t.Priority[..1] + t.Priority[1..].ToLowerInvariant()));
        if (t.AssignerName is { } an) details.Add(("Assigned by", an));
        if (t.OwnerName is { } on && type is "TASK_REVIEW") details.Add(("Done by", on));
        var html = EmailLayout.Render(EmailBrand.From(o), new EmailContent
        {
            Preheader = Cut(intro ?? subject, 150),
            Eyebrow = type switch { "TASK_ASSIGNED" => "New task for you", "TASK_REVIEW" => "Waiting for your review", "TASK_DUE" => "Task is overdue", _ => "Task update" },
            Title = Cut(subject, 150),
            RecipientName = w.Name,
            Paragraphs = intro is null ? [] : [Cut(intro, 1000)],
            Details = details,
            ButtonUrl = $"{webBaseUrl}/tasks?task={t.Id}",
            ButtonText = type == "TASK_REVIEW" ? "Review task" : "Open task",
            Note = "You can turn task e-mails off in Tasks → Settings.",
        });
        await c.ExecuteAsync("INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml) VALUES (@template, @to, @subject, @html)",
            new { template = type, to = w.Email, subject = Cut(subject, 200), html });
    }

    static Task PushChangedAsync(WorkServices s, TaskAccess t) =>
        s.Push.ToUsersAsync(t.AssignedByUserId is { } ab ? new[] { t.OwnerUserId, ab } : new[] { t.OwnerUserId }, "task.changed", new { id = t.Id });

    static async Task<IResult> TaskResult(IDbConnection c, WorkServices s, Caller me, TaskAccess t)
    {
        await PushChangedAsync(s, t);
        return Results.Ok(await TaskByIdAsync(c, me, t.TaskId, s.Clock.UtcNow));
    }

    // ---- People and settings -----------------------------------------------------------------------------------------------

    static Task<IResult> Assignees(string? search, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var rows = await c.QueryAsync<(Guid Id, string Name, string? Code, string? Department, string? Designation)>("""
            SELECT TOP (20) u.PublicId AS Id, e.DisplayName AS Name, e.EmployeeCode AS Code, d.[Name] AS Department, g.[Name] AS Designation
            FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId LEFT JOIN org.Designations g ON g.DesignationId = e.DesignationId
            WHERE u.IsActive = 1 AND u.UserId <> @me
              AND (@term IS NULL OR e.DisplayName LIKE @term OR e.EmployeeCode LIKE @term OR e.OfficialEmail LIKE @term)
              AND EXISTS (SELECT 1 FROM auth.EffectivePermissions(u.UserId) ep WHERE ep.Code = 'chat.tasks')
            ORDER BY e.DisplayName
            """, new { me = me.UserId, term = Like(search) });
        return Results.Ok(new { items = rows.Select(r => new { id = r.Id, name = r.Name, code = r.Code, department = r.Department, designation = r.Designation }) });
    });

    static Task<IResult> GetTaskSettings(WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var on = await c.QuerySingleOrDefaultAsync<bool?>("SELECT TaskEmails FROM chat.MST_ChatUserPreference WHERE UserId = @me", new { me = me.UserId }) ?? true;
        return Results.Ok(new { taskEmails = on, collab = await CollabEnabledAsync(c, s.Cache) });
    });

    static Task<IResult> PutTaskSettings(JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var inp = new Input(body);
        var on = inp.Bool("taskEmails");
        if (on is null) inp.V.Add("taskEmails", "Send true or false.");
        if (!inp.V.IsValid) return inp.V.Problem();
        await c.ExecuteAsync("""
            MERGE chat.MST_ChatUserPreference WITH (HOLDLOCK) AS t
            USING (SELECT @me AS UserId) AS src ON t.UserId = src.UserId
            WHEN MATCHED THEN UPDATE SET TaskEmails = @on, ModifiedUtc = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (UserId, TaskEmails) VALUES (src.UserId, @on);
            """, new { me = me.UserId, on });
        return Results.Ok(new { taskEmails = on, collab = await CollabEnabledAsync(c, s.Cache) });
    });

    // ---- Create an assigned task -------------------------------------------------------------------------------------------

    internal sealed record ChecklistInput(string Text, bool IsRequired);

    static List<ChecklistInput> ReadChecklist(Input inp)
    {
        var result = new List<ChecklistInput>();
        var list = inp.Array("checklist");
        if (list is null) return result;
        if (list.Count > MaxChecklistItems) { inp.V.Add("checklist", $"A checklist can have at most {MaxChecklistItems} steps."); return result; }
        foreach (var e in list)
        {
            var text = e.ValueKind == JsonValueKind.String ? e.GetString()
                : e.ValueKind == JsonValueKind.Object && e.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String ? tx.GetString() : null;
            var required = e.ValueKind == JsonValueKind.Object && e.TryGetProperty("isRequired", out var rq) && rq.ValueKind == JsonValueKind.True;
            var clean = ChatAccess.CleanText(text, false)?.Trim();
            if (string.IsNullOrEmpty(clean)) continue;
            if (clean.Length > ChecklistTextMax) { inp.V.Add("checklist", $"A checklist step can be at most {ChecklistTextMax} characters."); return result; }
            result.Add(new ChecklistInput(clean, required));
        }
        return result;
    }

    static async Task AddChecklistAsync(IDbConnection c, Caller by, long taskId, List<ChecklistInput> items, bool allowRequired, DateTime now, IDbTransaction? tx = null)
    {
        var start = await c.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(SortOrder), 0) FROM chat.TRN_ChatTaskChecklist WHERE TaskId = @taskId AND IsActive = 1", new { taskId }, tx);
        await c.ExecuteAsync("""
            INSERT chat.TRN_ChatTaskChecklist (TaskId, [Text], IsRequired, SortOrder, CreatedByUserId, CreatedUtc, UpdatedUtc) VALUES (@taskId, @Text, @IsRequired, @SortOrder, @by, @now, @now)
            """, items.Select((i, n) => new { taskId, i.Text, IsRequired = allowRequired && i.IsRequired, SortOrder = start + n + 1, by = by.UserId, now }), tx);
    }

    /// <summary>
    /// One copy per colleague: the copy is created exactly like that person's own task (links are checked against BOTH people, so
    /// nobody can attach something the other may not see), then marked as assigned. Category, reminder, private notes, linked note and
    /// repeat are personal and are not set by the person assigning. If any copy fails, the copies made so far are removed.
    /// </summary>
    static async Task<IResult> CreateAssignedAsync(IDbConnection c, WorkServices s, Caller me, Input inp)
    {
        if (!await CollabEnabledAsync(c, s.Cache)) return CollabDisabled();
        var v = inp.V;
        var ids = ReadIds(inp, "assigneeIds", MaxAssignees, "colleague") ?? [];
        var checklist = ReadChecklist(inp);
        var requiresReview = inp.Bool("requiresReview") ?? false;
        foreach (var personal in new[] { "categoryId", "reminderUtc", "notes", "noteId" })
            if (inp.Has(personal) && !IsNullValue(inp, personal)) v.Add(personal, "This is personal to the person doing the task; they can set it themselves.");
        if (inp.Has("repeatRule") && (inp.Str("repeatRule") ?? "NONE").ToUpperInvariant() != "NONE") v.Add("repeatRule", "Assigned tasks cannot repeat.");
        if (inp.Has("status") && (inp.Str("status") ?? "PENDING").ToUpperInvariant() != "PENDING") v.Add("status", "A new assigned task starts as not started.");
        if (!v.IsValid) return v.Problem();
        var people = await ResolveColleaguesAsync(c, me, ids);
        if (people.Count != ids.Count) return LinkNotFound("assigneeIds", "Colleague (who can use tasks)");

        // Links: the person assigning must be able to see them too.
        if (inp.Id("meetingId") is { } mg && await MeetingIdAsync(c, me, mg) is null) return LinkNotFound("meetingId", "Meeting");
        if (inp.Id("conversationId") is { } cg && await ChatAccess.MemberAsync(c, cg, me.UserId) is null) return LinkNotFound("conversationId", "Conversation");
        if (inp.Id("sourceMessageId") is { } msg && await VisibleMessageAsync(c, me, msg) is null) return LinkNotFound("sourceMessageId", "Message");
        if (inp.Id("sourceCallId") is { } call && await MyCallAsync(c, me, call) is null) return LinkNotFound("sourceCallId", "Call");
        if (!v.IsValid) return v.Problem();

        var fields = new Dictionary<string, object?>();
        foreach (var f in new[] { "title", "description", "priority", "dueUtc", "hasDueTime", "meetingId", "employeeId", "conversationId", "sourceMessageId", "sourceCallId" })
            if (inp.Has(f)) fields[f] = inp.Raw(f);
        var key = Guid.NewGuid();
        var now = s.Clock.UtcNow;
        var created = new List<long>();
        foreach (var userId in ids.Select(i => people[i]))
        {
            var u = await c.QuerySingleAsync<(Guid Id, string? Name, long? EmployeeId, string? TimeZoneId)>("""
                SELECT u.PublicId AS Id, e.DisplayName AS Name, u.EmployeeId, u.TimeZoneId FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @userId
                """, new { userId });
            var owner = new Caller(userId, u.Id, u.Name ?? "", u.EmployeeId ?? 0, u.TimeZoneId);
            var r = await SaveTaskAsync(c, s, owner, null, Input.Of(fields));
            if (r.Error is not null)
            {
                if (created.Count > 0)
                    await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET IsActive = 0, UpdatedUtc = @now WHERE TaskId IN @created", new { created, now });
                return r.Error is IStatusCodeHttpResult { StatusCode: 404 }
                    ? Problems.Create(404, "LINK_NOT_FOUND", $"{u.Name ?? "This colleague"} cannot see the linked item, so the task was not assigned.")
                    : r.Error;
            }
            created.Add(r.TaskId);
            using (var tx = c.BeginTransaction())
            {
                await c.ExecuteAsync("""
                    UPDATE chat.TRN_ChatTask SET AssignedByUserId = @me, AssignmentKey = @key, AssignState = 'PENDING', RequiresReview = @requiresReview WHERE TaskId = @id
                    """, new { me = me.UserId, key, requiresReview, id = r.TaskId }, tx);
                await AddActivityAsync(c, tx, r.TaskId, me.UserId, "ASSIGNED", requiresReview ? "Needs review before it can be closed" : null, null, now);
                if (checklist.Count > 0) await AddChecklistAsync(c, me, r.TaskId, checklist, true, now, tx);
                tx.Commit();
            }
        }
        var title = ChatAccess.CleanText(inp.Str("title"), false) ?? "";
        foreach (var (taskId, userId) in created.Zip(ids.Select(i => people[i])))
        {
            await NotifyTaskAsync(c, s, userId, "TASK_ASSIGNED", taskId, $"{me.Name} assigned you: {title}",
                requiresReview ? $"{me.Name} will review it before it is closed." : null, email: true,
                emailIntro: $"{me.Name} assigned you a task{(requiresReview ? " and will review it before it is closed" : "")}. Open it to accept it, ask for a new date or decline it.");
            await s.Push.ToUsersAsync([userId, me.UserId], "task.changed", new { id = await c.ExecuteScalarAsync<Guid>("SELECT PublicId FROM chat.TRN_ChatTask WHERE TaskId = @taskId", new { taskId }) });
        }
        var first = await TaskByIdAsync(c, me, created[0], now);
        return Results.Ok(first);
    }

    static bool IsNullValue(Input inp, string field) => inp.Raw(field) is JsonElement { ValueKind: JsonValueKind.Null };

    // ---- Changes by the person who assigned it -----------------------------------------------------------------------------

    /// <summary>The person who assigned a task changes what it is: title, details, priority, due date, "needs my review".</summary>
    static async Task<IResult> PatchAssignedAsync(IDbConnection c, WorkServices s, Caller me, TaskAccess t, Input inp)
    {
        if (!await CollabEnabledAsync(c, s.Cache)) return CollabDisabled();
        if (t.IsClosed) return Closed();
        var old = await c.QuerySingleAsync<TaskRaw>(TaskRawSelect, new { taskId = t.TaskId });
        var n = old.Copy();
        var v = inp.V;
        var now = s.Clock.UtcNow;
        if (inp.Has("title")) n.Title = v.Required("title", ChatAccess.CleanText(inp.Str("title"), false), TitleMax, "Title") ?? "";
        if (inp.Has("description")) n.Description = v.Optional("description", ChatAccess.CleanText(inp.Str("description"), true), TextMax, "Description");
        if (inp.Has("priority")) n.Priority = inp.Choice("priority", Priorities, "Use LOW, MEDIUM, HIGH or URGENT.") ?? n.Priority;
        if (inp.Has("dueUtc")) { n.DueUtc = inp.Utc("dueUtc"); CheckDate(v, "dueUtc", n.DueUtc, now); }
        if (inp.Has("hasDueTime")) n.HasDueTime = inp.Bool("hasDueTime") ?? false;
        if (inp.Has("requiresReview")) n.RequiresReview = inp.Bool("requiresReview") ?? false;
        if (!v.IsValid) return v.Problem();
        if (!n.RequiresReview && old.RequiresReview && t.Status == "IN_REVIEW")
            return Db_.Conflict("This task is waiting for your review. Approve it or send it back first.");

        var changed = new List<string>();
        if (n.Title != old.Title) changed.Add("title");
        if (n.Description != old.Description) changed.Add("details");
        if (n.Priority != old.Priority) changed.Add("priority");
        if (n.DueUtc != old.DueUtc || n.HasDueTime != old.HasDueTime) changed.Add("due date");
        if (n.RequiresReview != old.RequiresReview) changed.Add(n.RequiresReview ? "now needs review" : "no longer needs review");
        if (changed.Count == 0) return Results.Ok(await TaskByIdAsync(c, me, t.TaskId, now));
        var dueChanged = n.DueUtc != old.DueUtc;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync($"""
                UPDATE chat.TRN_ChatTask SET Title = @Title, [Description] = @Description, [Priority] = @Priority, DueUtc = @DueUtc, HasDueTime = @HasDueTime,
                    RequiresReview = @RequiresReview, UpdatedUtc = @now
                    {(dueChanged ? ", RequestedDueUtc = NULL, RequestReason = NULL, DueSoonSentUtc = NULL, OverdueSentUtc = NULL" : "")}
                WHERE TaskId = @TaskId
                """, new { n.Title, n.Description, n.Priority, n.DueUtc, n.HasDueTime, n.RequiresReview, now, n.TaskId }, tx);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "EDITED", "Changed: " + string.Join(", ", changed), dueChanged ? n.DueUtc : null, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.OwnerUserId, "TASK_UPDATE", t.TaskId, $"{me.Name} changed {string.Join(", ", changed)}: {n.Title}", null, email: false);
        return await TaskResult(c, s, me, t);
    }

    static async Task<IResult> WithdrawAssignedAsync(IDbConnection c, WorkServices s, Caller me, TaskAccess t)
    {
        if (t.IsClosed) return Closed();
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET [Status] = 'CANCELLED', CompletedUtc = NULL, SubmittedUtc = NULL, UpdatedUtc = @now WHERE TaskId = @id",
                new { id = t.TaskId, now }, tx);
            await CloseRemindersAsync(c, tx, "TaskId", t.TaskId, "CANCELLED", now);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "CANCELLED", "Withdrawn by the person who assigned it", null, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.OwnerUserId, "TASK_UPDATE", t.TaskId, $"{me.Name} withdrew: {t.Title}", "You no longer need to do this task.", email: false);
        await PushChangedAsync(s, t);
        return Results.NoContent();
    }

    // ---- Owner answers -----------------------------------------------------------------------------------------------------

    static Task<IResult> Accept(Guid id, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (!t.IsOwner) return OnlyOwner(t);
        if (t.IsClosed) return Closed();
        if (t.AssignState == "ACCEPTED") return Results.Ok(await TaskByIdAsync(c, me, t.TaskId, s.Clock.UtcNow));
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET AssignState = 'ACCEPTED', UpdatedUtc = @now WHERE TaskId = @id", new { id = t.TaskId, now }, tx);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "ACCEPTED", null, null, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.AssignedByUserId!.Value, "TASK_UPDATE", t.TaskId, $"{me.Name} accepted: {t.Title}", null, email: false);
        return await TaskResult(c, s, me, t);
    });

    static Task<IResult> Decline(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (!t.IsOwner) return OnlyOwner(t);
        if (t.IsClosed) return Closed();
        var inp = new Input(body);
        var reason = inp.V.Required("reason", ChatAccess.CleanText(inp.Str("reason"), true), ReasonMax, "Reason");
        if (!inp.V.IsValid) return inp.V.Problem();
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("""
                UPDATE chat.TRN_ChatTask SET AssignState = 'DECLINED', [Status] = 'CANCELLED', SubmittedUtc = NULL, FocusUtc = NULL, UpdatedUtc = @now WHERE TaskId = @id
                """, new { id = t.TaskId, now }, tx);
            await CloseRemindersAsync(c, tx, "TaskId", t.TaskId, "CANCELLED", now);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "DECLINED", reason, null, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.AssignedByUserId!.Value, "TASK_UPDATE", t.TaskId, $"{me.Name} declined: {t.Title}", reason, email: true,
            emailIntro: $"{me.Name} declined the task. Reason: {reason}");
        return await TaskResult(c, s, me, t);
    });

    static Task<IResult> RequestDate(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (!t.IsOwner) return OnlyOwner(t);
        if (t.IsClosed) return Closed();
        var inp = new Input(body);
        var now = s.Clock.UtcNow;
        var due = inp.Utc("dueUtc");
        if (due is null) inp.V.Add("dueUtc", "Choose the date you need.");
        else if (due < now.AddMinutes(-1) || due > now.AddYears(2)) inp.V.Add("dueUtc", "Choose a date in the future.");
        var reason = inp.V.Required("reason", ChatAccess.CleanText(inp.Str("reason"), true), ReasonMax, "Reason");
        if (!inp.V.IsValid) return inp.V.Problem();
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("""
                UPDATE chat.TRN_ChatTask SET RequestedDueUtc = @due, RequestReason = @reason, AssignState = CASE WHEN AssignState = 'PENDING' THEN 'ACCEPTED' ELSE AssignState END,
                    UpdatedUtc = @now WHERE TaskId = @id
                """, new { id = t.TaskId, due, reason, now }, tx);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "DATE_REQUESTED", reason, due, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.AssignedByUserId!.Value, "TASK_UPDATE", t.TaskId, $"{me.Name} asks for a new date: {t.Title}", reason, email: false);
        return await TaskResult(c, s, me, t);
    });

    static Task<IResult> AnswerDateRequest(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (t.IsOwner) return OnlyAssigner();
        if (t.IsClosed) return Closed();
        if (t.RequestedDueUtc is null) return Db_.Conflict("There is no date request to answer.");
        var inp = new Input(body);
        var approve = inp.Bool("approve");
        if (approve is null) inp.V.Add("approve", "Send true (approve) or false (keep the current date).");
        var reason = inp.V.Optional("reason", ChatAccess.CleanText(inp.Str("reason"), true), ReasonMax, "Reason");
        if (!inp.V.IsValid) return inp.V.Problem();
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync($"""
                UPDATE chat.TRN_ChatTask SET {(approve == true ? "DueUtc = RequestedDueUtc, DueSoonSentUtc = NULL, OverdueSentUtc = NULL," : "")}
                    RequestedDueUtc = NULL, RequestReason = NULL, UpdatedUtc = @now WHERE TaskId = @id
                """, new { id = t.TaskId, now }, tx);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, approve == true ? "DATE_APPROVED" : "DATE_REJECTED", reason, approve == true ? t.RequestedDueUtc : null, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.OwnerUserId, "TASK_UPDATE", t.TaskId,
            approve == true ? $"{me.Name} approved your new date: {t.Title}" : $"{me.Name} kept the original date: {t.Title}", reason, email: false);
        return await TaskResult(c, s, me, t);
    });

    // ---- Review ------------------------------------------------------------------------------------------------------------

    static Task<IResult> Submit(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (!t.IsOwner) return OnlyOwner(t);
        if (t.IsClosed) return Closed();
        if (!t.RequiresReview) return Db_.Conflict("This task does not need a review; mark it as completed.");
        if (t.Status == "IN_REVIEW") return Db_.Conflict("This task is already waiting for review.");
        if (t.AssignState == "DECLINED") return Closed();
        var inp = new Input(body);
        var note = inp.V.Optional("note", ChatAccess.CleanText(inp.Str("note"), true), CommentMax, "Note");
        if (!inp.V.IsValid) return inp.V.Problem();
        if (await RequiredOpenAsync(c, t.TaskId) > 0) return Problems.Create(409, "CHECKLIST_INCOMPLETE", "Finish the required checklist steps first.");
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("""
                UPDATE chat.TRN_ChatTask SET [Status] = 'IN_REVIEW', SubmittedUtc = @now, AssignState = 'ACCEPTED', UpdatedUtc = @now WHERE TaskId = @id
                """, new { id = t.TaskId, now }, tx);
            await CloseRemindersAsync(c, tx, "TaskId", t.TaskId, "DONE", now);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "SUBMITTED", note, null, now);
            tx.Commit();
        }
        await NotifyTaskAsync(c, s, t.AssignedByUserId!.Value, "TASK_REVIEW", t.TaskId, $"{me.Name} sent for your review: {t.Title}", note, email: true,
            emailIntro: $"{me.Name} finished the task and sent it to you for review.{(note is null ? "" : " Note: " + note)} Approve it to close it, or send it back with a comment.");
        return await TaskResult(c, s, me, t);
    });

    static Task<IResult> Review(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (t.IsOwner) return OnlyAssigner();
        if (t.Status != "IN_REVIEW") return Db_.Conflict("This task is not waiting for review.");
        var inp = new Input(body);
        var approve = inp.Bool("approve");
        if (approve is null) inp.V.Add("approve", "Send true (approve and close) or false (send back).");
        var comment = approve == false
            ? inp.V.Required("comment", ChatAccess.CleanText(inp.Str("comment"), true), CommentMax, "Comment")
            : inp.V.Optional("comment", ChatAccess.CleanText(inp.Str("comment"), true), CommentMax, "Comment");
        if (!inp.V.IsValid) return inp.V.Problem();
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            if (approve == true)
                await c.ExecuteAsync("""
                    UPDATE chat.TRN_ChatTask SET [Status] = 'COMPLETED', CompletedUtc = @now, ReviewedUtc = @now, UpdatedUtc = @now WHERE TaskId = @id
                    """, new { id = t.TaskId, now }, tx);
            else
                await c.ExecuteAsync("""
                    UPDATE chat.TRN_ChatTask SET [Status] = 'IN_PROGRESS', SubmittedUtc = NULL, ReviewedUtc = @now, UpdatedUtc = @now WHERE TaskId = @id
                    """, new { id = t.TaskId, now }, tx);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, approve == true ? "APPROVED" : "RETURNED", comment, null, now);
            tx.Commit();
        }
        if (approve == true)
            await NotifyTaskAsync(c, s, t.OwnerUserId, "TASK_UPDATE", t.TaskId, $"{me.Name} approved and closed: {t.Title}", comment, email: true,
                emailIntro: $"{me.Name} reviewed your work and closed the task.{(comment is null ? "" : " Comment: " + comment)}");
        else
            await NotifyTaskAsync(c, s, t.OwnerUserId, "TASK_UPDATE", t.TaskId, $"{me.Name} sent back: {t.Title}", comment, email: true,
                emailIntro: $"{me.Name} reviewed the task and sent it back for more work. Comment: {comment}");
        return await TaskResult(c, s, me, t);
    });

    // ---- Comments and nudges -----------------------------------------------------------------------------------------------

    static Task<IResult> Comment(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        var inp = new Input(body);
        var text = inp.V.Required("body", ChatAccess.CleanText(inp.Str("body"), true), CommentMax, "Comment");
        if (!inp.V.IsValid) return inp.V.Problem();
        var now = s.Clock.UtcNow;
        await AddActivityAsync(c, null, t.TaskId, me.UserId, "COMMENT", text, null, now);
        await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET UpdatedUtc = @now WHERE TaskId = @id", new { id = t.TaskId, now });
        if (t.Other is { } other) await NotifyTaskAsync(c, s, other, "TASK_COMMENT", t.TaskId, $"{me.Name} commented: {t.Title}", text, email: false);
        await PushChangedAsync(s, t);
        return Results.Ok(await DetailsAsync(c, s, me, t));
    });

    /// <summary>The person who assigned a task reminds the owner about it; at most once every 4 hours.</summary>
    static Task<IResult> Nudge(Guid id, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsAssigned) return NotAssigned();
        if (t.IsOwner) return OnlyAssigner();
        if (t.IsClosed || t.Status == "IN_REVIEW") return Db_.Conflict(t.Status == "IN_REVIEW" ? "This task is waiting for your review." : "This task is already closed.");
        var now = s.Clock.UtcNow;
        var last = await c.QuerySingleOrDefaultAsync<DateTime?>("SELECT MAX(CreatedUtc) FROM chat.TRN_ChatTaskActivity WHERE TaskId = @id AND Kind = 'NUDGED'", new { id = t.TaskId });
        if (last is { } l && now - AsUtc(l) < NudgeGap)
            return Problems.Create(429, "TOO_SOON", $"You reminded {t.OwnerName ?? "them"} recently. You can send another reminder after {Math.Ceiling((NudgeGap - (now - AsUtc(l))).TotalMinutes)} minutes.");
        await AddActivityAsync(c, null, t.TaskId, me.UserId, "NUDGED", null, null, now);
        await NotifyTaskAsync(c, s, t.OwnerUserId, "TASK_DUE", t.TaskId, $"{me.Name} is waiting on: {t.Title}", "A gentle reminder about this task.", email: false);
        return await TaskResult(c, s, me, t);
    });

    // ---- Details (checklist, history, files) -------------------------------------------------------------------------------

    sealed record ChecklistRow(Guid Id, string Text, bool IsRequired, bool IsDone, DateTime? DoneUtc, Guid CreatedById, string? CreatedByName);
    sealed record ActivityRow(Guid Id, string Kind, string? Body, DateTime? DueUtc, DateTime CreatedUtc, Guid? ActorId, string? ActorName);
    sealed record FileRow(Guid Id, string Name, string Extension, long SizeBytes, string ScanStatus, DateTime CreatedUtc, Guid UploadedById, string? UploadedByName, bool InlinePreview);

    static async Task<object> DetailsAsync(IDbConnection c, WorkServices s, Caller me, TaskAccess t)
    {
        var checklist = await c.QueryAsync<ChecklistRow>("""
            SELECT i.PublicId AS Id, i.[Text], i.IsRequired, i.IsDone, i.DoneUtc, u.PublicId AS CreatedById, e.DisplayName AS CreatedByName
            FROM chat.TRN_ChatTaskChecklist i JOIN auth.Users u ON u.UserId = i.CreatedByUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE i.TaskId = @id AND i.IsActive = 1 ORDER BY i.SortOrder, i.ItemId
            """, new { id = t.TaskId });
        var activity = await c.QueryAsync<ActivityRow>("""
            SELECT TOP (300) a.PublicId AS Id, a.Kind, a.Body, a.DueUtc, a.CreatedUtc, u.PublicId AS ActorId, e.DisplayName AS ActorName
            FROM chat.TRN_ChatTaskActivity a LEFT JOIN auth.Users u ON u.UserId = a.ActorUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE a.TaskId = @id ORDER BY a.ActivityId
            """, new { id = t.TaskId });
        var files = await c.QueryAsync<FileRow>("""
            SELECT f.PublicId AS Id, f.OriginalName AS Name, f.Extension, f.SizeBytes, f.ScanStatus, f.CreatedUtc, u.PublicId AS UploadedById, e.DisplayName AS UploadedByName,
                   CAST(ISNULL(ft.InlinePreview, 0) AS BIT) AS InlinePreview
            FROM chat.TRN_ChatTaskFile f JOIN auth.Users u ON u.UserId = f.UploadedByUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            LEFT JOIN chat.MST_ChatFileType ft ON ft.Extension = f.Extension
            WHERE f.TaskId = @id AND f.DeletedUtc IS NULL ORDER BY f.FileId
            """, new { id = t.TaskId });
        var canManage = !t.IsAssigned ? t.IsOwner : !t.IsOwner;   // personal: the owner; assigned: the person who assigned it
        return new
        {
            checklist = checklist.Select(i => new
            {
                id = i.Id, text = i.Text, isRequired = i.IsRequired, isDone = i.IsDone, doneUtc = i.DoneUtc, createdBy = new { id = i.CreatedById, name = i.CreatedByName },
                canEdit = canManage || i.CreatedById == me.Id, canTick = t.IsOwner,
            }),
            activity = activity.Select(a => new { id = a.Id, kind = a.Kind, body = a.Body, dueUtc = a.DueUtc, createdUtc = a.CreatedUtc,
                actor = a.ActorId is { } aid ? new { id = aid, name = a.ActorName, isMe = aid == me.Id } : null }),
            files = files.Select(f => new { id = f.Id, name = f.Name, extension = f.Extension, sizeBytes = f.SizeBytes, scanStatus = f.ScanStatus, createdUtc = f.CreatedUtc,
                inlinePreview = f.InlinePreview, uploadedBy = new { id = f.UploadedById, name = f.UploadedByName }, canDelete = f.UploadedById == me.Id }),
            canAddRequired = canManage,
            collab = await CollabEnabledAsync(c, s.Cache),
        };
    }

    static Task<IResult> TaskDetails(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        return t is null ? NotFound("Task") : Results.Ok(await DetailsAsync(c, s, me, t));
    });

    // ---- Checklist (CHAT_TASKS; required steps on assigned tasks are set by the person who assigned it) ----------------------

    static Task<IResult> AddChecklistItem(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (t.IsClosed) return Closed();
        var inp = new Input(body);
        var text = inp.V.Required("text", ChatAccess.CleanText(inp.Str("text"), false)?.Trim(), ChecklistTextMax, "Step");
        var required = inp.Bool("isRequired") ?? false;
        var canManage = !t.IsAssigned ? t.IsOwner : !t.IsOwner;
        if (required && !canManage) inp.V.Add("isRequired", "Only the person who assigned this task can add required steps.");
        if (!inp.V.IsValid) return inp.V.Problem();
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatTaskChecklist WHERE TaskId = @id AND IsActive = 1", new { id = t.TaskId }) >= MaxChecklistItems)
            return LimitReached($"A checklist can have at most {MaxChecklistItems} steps.");
        await AddChecklistAsync(c, me, t.TaskId, [new ChecklistInput(text!, required)], canManage, s.Clock.UtcNow);
        await PushChangedAsync(s, t);
        return Results.Ok(await DetailsAsync(c, s, me, t));
    });

    static Task<IResult> PatchChecklistItem(Guid id, Guid itemId, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        var item = await c.QuerySingleOrDefaultAsync<(long ItemId, long CreatedByUserId, bool IsDone, string Text)?>(
            "SELECT ItemId, CreatedByUserId, IsDone, [Text] FROM chat.TRN_ChatTaskChecklist WHERE PublicId = @itemId AND TaskId = @id AND IsActive = 1", new { itemId, id = t.TaskId });
        if (item is null) return NotFound("Checklist step");
        if (t.IsClosed) return Closed();
        var inp = new Input(body);
        var canManage = !t.IsAssigned ? t.IsOwner : !t.IsOwner;
        var canEdit = canManage || item.Value.CreatedByUserId == me.UserId;
        var isDone = inp.Bool("isDone");
        var text = inp.Has("text") ? inp.V.Required("text", ChatAccess.CleanText(inp.Str("text"), false)?.Trim(), ChecklistTextMax, "Step") : null;
        var required = inp.Bool("isRequired");
        if (isDone is not null && !t.IsOwner) inp.V.Add("isDone", "Only the person doing the task ticks its steps.");
        if ((text is not null || required is not null) && !canEdit) inp.V.Add("text", "Only the person who added this step can change it.");
        if (required is not null && !canManage) inp.V.Add("isRequired", "Only the person who assigned this task decides which steps are required.");
        if (!inp.V.IsValid) return inp.V.Problem();
        var now = s.Clock.UtcNow;
        await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatTaskChecklist SET IsDone = COALESCE(@isDone, IsDone),
                DoneUtc = CASE WHEN @isDone = 1 AND IsDone = 0 THEN @now WHEN @isDone = 0 THEN NULL ELSE DoneUtc END,
                [Text] = COALESCE(@text, [Text]), IsRequired = COALESCE(@required, IsRequired), UpdatedUtc = @now
            WHERE ItemId = @itemId
            """, new { isDone, text, required, now, itemId = item.Value.ItemId });
        await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET UpdatedUtc = @now WHERE TaskId = @id", new { id = t.TaskId, now });
        await PushChangedAsync(s, t);
        return Results.Ok(await DetailsAsync(c, s, me, t));
    });

    static Task<IResult> DeleteChecklistItem(Guid id, Guid itemId, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        var item = await c.QuerySingleOrDefaultAsync<(long ItemId, long CreatedByUserId)?>(
            "SELECT ItemId, CreatedByUserId FROM chat.TRN_ChatTaskChecklist WHERE PublicId = @itemId AND TaskId = @id AND IsActive = 1", new { itemId, id = t.TaskId });
        if (item is null) return NotFound("Checklist step");
        if (t.IsClosed) return Closed();
        var canManage = !t.IsAssigned ? t.IsOwner : !t.IsOwner;
        if (!canManage && item.Value.CreatedByUserId != me.UserId) return Problems.Create(403, "FORBIDDEN", "Only the person who added this step can remove it.");
        await c.ExecuteAsync("UPDATE chat.TRN_ChatTaskChecklist SET IsActive = 0, UpdatedUtc = @now WHERE ItemId = @itemId", new { itemId = item.Value.ItemId, now = s.Clock.UtcNow });
        await PushChangedAsync(s, t);
        return Results.Ok(await DetailsAsync(c, s, me, t));
    });

    // ---- Top 3 for today ---------------------------------------------------------------------------------------------------

    static Task<IResult> Focus(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (!t.IsOwner) return OnlyOwner(t);
        var inp = new Input(body);
        var on = inp.Bool("on");
        if (on is null) inp.V.Add("on", "Send true (add to Top 3) or false (remove).");
        var dsIn = inp.Utc("dayStartUtc");
        var deIn = inp.Utc("dayEndUtc");
        if (!inp.V.IsValid) return inp.V.Problem();
        var now = s.Clock.UtcNow;
        var (ds, de, dayError) = Day(dsIn, deIn, me, now);
        if (dayError is not null) return dayError;
        if (on == true)
        {
            if (t.IsClosed) return Closed();
            var count = await c.ExecuteScalarAsync<int>("""
                SELECT COUNT(*) FROM chat.TRN_ChatTask WHERE OwnerUserId = @me AND IsActive = 1 AND FocusUtc >= @ds AND FocusUtc < @de AND [Status] <> 'CANCELLED' AND TaskId <> @id
                """, new { me = me.UserId, ds, de, id = t.TaskId });
            if (count >= MaxFocus) return LimitReached($"Your Top {MaxFocus} for today is full. Remove one first.");
            await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET FocusUtc = @now WHERE TaskId = @id", new { id = t.TaskId, now });
        }
        else await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET FocusUtc = NULL WHERE TaskId = @id", new { id = t.TaskId });
        return Results.Ok(await TaskByIdAsync(c, me, t.TaskId, now));
    });

    // ---- Proof files -------------------------------------------------------------------------------------------------------

    static Task<IResult> UploadTaskFile(Guid id, HttpRequest req, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var t = await VisibleTaskAsync(c, me, id);
        if (t is null) return NotFound("Task");
        if (t.IsClosed) return Closed();
        if (!req.HasFormContentType) { var fv = new Validator(); fv.Add("file", "Choose a file."); return fv.Problem(); }
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatTaskFile WHERE TaskId = @id AND DeletedUtc IS NULL", new { id = t.TaskId }) >= MaxTaskFiles)
            return LimitReached($"A task can have at most {MaxTaskFiles} files.");
        var form = await req.ReadFormAsync(ctx.RequestAborted);
        var now = s.Clock.UtcNow;
        var (file, error) = await ChatFileEndpoints.ReceiveTaskFileAsync(c, s.ChatOptions, now, me.UserId, form.Files.GetFile("file"), TaskFileMaxMb, ctx);
        if (error is not null) return error;
        try
        {
            using var tx = c.BeginTransaction();
            await c.ExecuteAsync("""
                INSERT chat.TRN_ChatTaskFile (TaskId, UploadedByUserId, OriginalName, Extension, ContentType, SizeBytes, Sha256, StorageKey, CreatedUtc)
                VALUES (@taskId, @me, @Name, @Extension, @ContentType, @Size, @Sha256, @StorageKey, @now)
                """, new { taskId = t.TaskId, me = me.UserId, file!.Name, file.Extension, file.ContentType, file.Size, file.Sha256, file.StorageKey, now }, tx);
            await AddActivityAsync(c, tx, t.TaskId, me.UserId, "FILE", file.Name, null, now);
            await c.ExecuteAsync("UPDATE chat.TRN_ChatTask SET UpdatedUtc = @now WHERE TaskId = @id", new { id = t.TaskId, now }, tx);
            tx.Commit();
        }
        catch
        {
            ChatFileEndpoints.DeleteStored(file!.FullPath);
            throw;
        }
        s.ScanSignal.Kick();
        if (t.Other is { } other) await NotifyTaskAsync(c, s, other, "TASK_COMMENT", t.TaskId, $"{me.Name} added a file: {t.Title}", file.Name, email: false);
        await PushChangedAsync(s, t);
        return Results.Ok(await DetailsAsync(c, s, me, t));
    });

    sealed record TaskFileAccess(long FileId, Guid TaskPublicId, long TaskId, long UploadedByUserId, string OriginalName, string Extension, string ContentType,
        long SizeBytes, string StorageKey, string ScanStatus, bool InlinePreview);

    static Task<TaskFileAccess?> TaskFileAsync(IDbConnection c, Caller me, Guid id) =>
        c.QuerySingleOrDefaultAsync<TaskFileAccess>("""
            SELECT f.FileId, t.PublicId AS TaskPublicId, t.TaskId, f.UploadedByUserId, f.OriginalName, f.Extension, f.ContentType, f.SizeBytes, f.StorageKey, f.ScanStatus,
                   CAST(ISNULL(ft.InlinePreview, 0) AS BIT) AS InlinePreview
            FROM chat.TRN_ChatTaskFile f JOIN chat.TRN_ChatTask t ON t.TaskId = f.TaskId AND t.IsActive = 1
            LEFT JOIN chat.MST_ChatFileType ft ON ft.Extension = f.Extension
            WHERE f.PublicId = @id AND f.DeletedUtc IS NULL AND (t.OwnerUserId = @me OR t.AssignedByUserId = @me)
            """, new { id, me = me.UserId });

    static Task<IResult> DownloadTaskFile(Guid id, string? inline, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var f = await TaskFileAsync(c, me, id);
        if (f is null) return Db_.NotFound("File");
        if (f.ScanStatus == "PENDING") return Problems.Create(409, "CONFLICT", "The file is still being checked by the antivirus. Try again in a moment.");
        if (f.ScanStatus != "CLEAN") return Problems.Create(403, "FORBIDDEN", "This file was blocked by the antivirus.");
        string path;
        try { path = ChatFileEndpoints.Resolve(s.ChatOptions.ResolvedStorageRoot(), f.StorageKey); }
        catch (InvalidOperationException) { return Db_.NotFound("File"); }
        if (!File.Exists(path)) return Db_.NotFound("File");
        var headers = ctx.Response.Headers;
        if (inline is "1" or "true" && f.InlinePreview)
        {
            headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(f.OriginalName)}";
            headers.CacheControl = "private, max-age=3600";
            headers.ContentSecurityPolicy = f.Extension == "pdf" ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; frame-ancestors 'none'";
            return Results.File(path, f.ContentType, enableRangeProcessing: true);
        }
        await Audit.WriteAsync(c, "USER", me.UserId, "TASK_FILE_DOWNLOADED", "ChatTaskFile", id.ToString(), "Task file downloaded", ClientInfo.From(ctx).Ip,
            newValues: new { extension = f.Extension, size = f.SizeBytes });
        headers.ContentDisposition = ChatFileEndpoints.AttachmentDisposition(f.OriginalName);
        return Results.File(path, ChatFileEndpoints.DownloadContentType(f.ContentType), enableRangeProcessing: true);
    });

    static Task<IResult> DeleteTaskFile(Guid id, WorkServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var f = await TaskFileAsync(c, me, id);
        if (f is null) return Db_.NotFound("File");
        if (f.UploadedByUserId != me.UserId) return Problems.Create(403, "FORBIDDEN", "Only the person who added this file can remove it.");
        var now = s.Clock.UtcNow;
        await c.ExecuteAsync("UPDATE chat.TRN_ChatTaskFile SET DeletedUtc = @now WHERE FileId = @fileId", new { fileId = f.FileId, now });
        try { ChatFileEndpoints.DeleteStored(ChatFileEndpoints.Resolve(s.ChatOptions.ResolvedStorageRoot(), f.StorageKey)); } catch (InvalidOperationException) { }
        var t = await VisibleTaskAsync(c, me, f.TaskPublicId);
        if (t is not null) await PushChangedAsync(s, t);
        return Results.NoContent();
    });

    // ---- Shared notes (read-only for the people they are shared with) ------------------------------------------------------

    static async Task<IResult> SharedNotesAsync(IDbConnection c, WorkServices s, Caller me, string? search)
    {
        if (!await CollabEnabledAsync(c, s.Cache)) return Results.Ok(new { items = Array.Empty<object>() });
        var rows = await c.QueryAsync<(Guid Id, string Title, string? Body, string? Color, DateTime CreatedUtc, DateTime UpdatedUtc, string? OwnerName, DateTime SharedUtc)>("""
            SELECT TOP (300) n.PublicId AS Id, n.Title, n.Body, n.Color, n.CreatedUtc, n.UpdatedUtc, oe.DisplayName AS OwnerName, sh.CreatedUtc AS SharedUtc
            FROM chat.TRN_ChatNoteShare sh
            JOIN chat.TRN_ChatNote n ON n.NoteId = sh.NoteId AND n.IsActive = 1 AND n.IsArchived = 0
            JOIN auth.Users ou ON ou.UserId = n.OwnerUserId AND ou.IsActive = 1 LEFT JOIN org.Employees oe ON oe.EmployeeId = ou.EmployeeId
            WHERE sh.UserId = @me AND (@term IS NULL OR n.Title LIKE @term OR n.Body LIKE @term)
            ORDER BY n.UpdatedUtc DESC
            """, new { me = me.UserId, term = Like(search) });
        return Results.Ok(new
        {
            items = rows.Select(r => new
            {
                id = r.Id, title = r.Title, body = r.Body, color = r.Color, isShared = true, ownerName = r.OwnerName, sharedUtc = r.SharedUtc,
                isPinned = false, isCompleted = false, isArchived = false, sharedCount = 0,
                categoryId = (Guid?)null, categoryName = (string?)null, categoryColor = (string?)null, noteDateUtc = (DateTime?)null,
                reminderId = (Guid?)null, reminderUtc = (DateTime?)null, reminderState = (string?)null,
                meeting = (object?)null, task = (object?)null, employee = (object?)null, conversation = (object?)null,
                createdUtc = r.CreatedUtc, updatedUtc = r.UpdatedUtc,
            }),
        });
    }

    static async Task<object> SharesAsync(IDbConnection c, long noteId) =>
        (await c.QueryAsync<(Guid Id, string? Name, DateTime SharedUtc)>("""
            SELECT u.PublicId AS Id, e.DisplayName AS Name, sh.CreatedUtc AS SharedUtc FROM chat.TRN_ChatNoteShare sh
            JOIN auth.Users u ON u.UserId = sh.UserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE sh.NoteId = @noteId ORDER BY e.DisplayName
            """, new { noteId })).Select(r => new { id = r.Id, name = r.Name, sharedUtc = r.SharedUtc }).ToList();

    static Task<IResult> NoteShares(Guid id, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var noteId = await OwnNoteIdAsync(c, me, id);
        return noteId is null ? NotFound("Note") : Results.Ok(new { items = await SharesAsync(c, noteId.Value) });
    });

    /// <summary>Replaces the list of colleagues a note is shared with (read-only). Newly added people are notified.</summary>
    static Task<IResult> ShareNote(Guid id, JsonElement body, WorkServices s, HttpContext ctx) => RunCollab(s, ctx, async (c, me) =>
    {
        var noteId = await OwnNoteIdAsync(c, me, id);
        if (noteId is null) return NotFound("Note");
        var inp = new Input(body);
        var ids = ReadIds(inp, "userIds", MaxShares, "colleague");
        if (ids is null && inp.V.IsValid) inp.V.Add("userIds", "Send the list of colleagues (empty to stop sharing).");
        if (!inp.V.IsValid) return inp.V.Problem();
        var people = await ResolveColleaguesAsync(c, me, ids!);
        if (people.Count != ids!.Count) return LinkNotFound("userIds", "Colleague (who can use notes)");
        var before = (await c.QueryAsync<long>("SELECT UserId FROM chat.TRN_ChatNoteShare WHERE NoteId = @noteId", new { noteId })).ToHashSet();
        var after = people.Values.ToHashSet();
        var now = s.Clock.UtcNow;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("DELETE FROM chat.TRN_ChatNoteShare WHERE NoteId = @noteId AND UserId NOT IN @keep", new { noteId, keep = after.DefaultIfEmpty(-1).ToArray() }, tx);
            await c.ExecuteAsync("INSERT chat.TRN_ChatNoteShare (NoteId, UserId, CreatedUtc) VALUES (@noteId, @userId, @now)",
                after.Except(before).Select(userId => new { noteId, userId, now }), tx);
            tx.Commit();
        }
        var note = await c.QuerySingleAsync<(Guid Id, string Title)>("SELECT PublicId AS Id, Title FROM chat.TRN_ChatNote WHERE NoteId = @noteId", new { noteId });
        foreach (var userId in after.Except(before))
        {
            await c.ExecuteAsync("""
                INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@userId, NULL, 'NOTE_SHARED', @title, NULL, @link)
                """, new { userId, title = Cut($"{me.Name} shared a note: {note.Title}", 200), link = $"/notes?shared={note.Id}" });
            await s.Push.ToUsersAsync([userId], "notification.new", new { type = "NOTE_SHARED", title = Cut($"{me.Name} shared a note: {note.Title}", 200), link = $"/notes?shared={note.Id}" });
        }
        await s.Push.ToUsersAsync(before.Union(after), "note.changed", new { id = note.Id });
        return Results.Ok(new { items = await SharesAsync(c, noteId.Value) });
    });
}

/// <summary>
/// Due-date alerts for ASSIGNED tasks (V033, TASK_COLLAB on). Run by <see cref="ChatReminderWorker"/>:
/// one "due tomorrow" alert to the owner 24 h before; when it becomes overdue, the owner and the person who assigned it are both told
/// (bell + e-mail); after that one reminder a day to the owner for up to 7 days. Each alert is claimed with one atomic UPDATE.
/// </summary>
public static class TaskDueAlerts
{
    sealed record Row(long TaskId, long OwnerUserId, long AssignedByUserId, string Title, DateTime? Previous);

    public static async Task<int> RunAsync(IDbConnection c, ChatPush push, EmailOptions email, string webBaseUrl, DateTime now)
    {
        var soon = (await c.QueryAsync<Row>("""
            UPDATE TOP (200) chat.TRN_ChatTask WITH (UPDLOCK, READPAST, ROWLOCK) SET DueSoonSentUtc = @now
            OUTPUT inserted.TaskId, inserted.OwnerUserId, inserted.AssignedByUserId, inserted.Title, deleted.DueSoonSentUtc AS Previous
            WHERE IsActive = 1 AND AssignedByUserId IS NOT NULL AND [Status] IN ('PENDING', 'IN_PROGRESS', 'POSTPONED') AND AssignState <> 'DECLINED'
              AND DueUtc > @now AND DueUtc <= @soon AND DueSoonSentUtc IS NULL
            """, new { now, soon = now.AddHours(24) })).ToList();
        foreach (var r in soon)
            await ChatWorkEndpoints.NotifyTaskAsync(c, push, email, webBaseUrl, r.OwnerUserId, "TASK_DUE", r.TaskId, $"Due soon: {r.Title}", "This task is due within a day.", email: false);

        var overdue = (await c.QueryAsync<Row>("""
            UPDATE TOP (200) chat.TRN_ChatTask WITH (UPDLOCK, READPAST, ROWLOCK) SET OverdueSentUtc = @now
            OUTPUT inserted.TaskId, inserted.OwnerUserId, inserted.AssignedByUserId, inserted.Title, deleted.OverdueSentUtc AS Previous
            WHERE IsActive = 1 AND AssignedByUserId IS NOT NULL AND [Status] IN ('PENDING', 'IN_PROGRESS', 'POSTPONED') AND AssignState <> 'DECLINED'
              AND DueUtc <= @now AND DueUtc > @stop AND (OverdueSentUtc IS NULL OR OverdueSentUtc <= @dayAgo)
            """, new { now, dayAgo = now.AddHours(-23), stop = now.AddDays(-7) })).ToList();
        foreach (var r in overdue)
        {
            var first = r.Previous is null;
            if (first)
                await c.ExecuteAsync("INSERT chat.TRN_ChatTaskActivity (TaskId, ActorUserId, Kind, CreatedUtc) VALUES (@id, NULL, 'OVERDUE', @now)", new { id = r.TaskId, now });
            await ChatWorkEndpoints.NotifyTaskAsync(c, push, email, webBaseUrl, r.OwnerUserId, "TASK_DUE", r.TaskId, $"Overdue: {r.Title}",
                "This task is past its due date. Finish it, or ask for a new date.", email: first);
            if (first)
                await ChatWorkEndpoints.NotifyTaskAsync(c, push, email, webBaseUrl, r.AssignedByUserId, "TASK_DUE", r.TaskId, $"Overdue (assigned by you): {r.Title}",
                    "A task you assigned is past its due date. You can remind them, or change the date.", email: true);
        }
        return soon.Count + overdue.Count;
    }
}
