using System.Data;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// Chat REST API (/api/v1/chat, Phase 2 of documentation/CHAT_MODULE_PHASE1.md). Session + chat.use + the CHAT switch on every call;
/// every conversation, message and file is reached only through the caller's active membership (ChatAccess). Message text is
/// stored and returned as plain text (the website renders it as text, never HTML) and is never written to logs or the audit log.
/// </summary>
public static class ChatEndpoints
{
    public const string SendRateLimit = "chat-send";
    public const string UploadRateLimit = "chat-upload";
    public const string SearchRateLimit = "chat-search";
    public const int BodyMax = 4000;
    public const int GroupNameMax = 80;
    public const int GroupDescriptionMax = 500;
    public const int PageMax = 100;

    public sealed class ChatServices(Db db, IMemoryCache cache, ChatPush push, PresenceService presence, PresenceTracker tracker,
        IOptions<ChatOptions> options, IClock clock, ChatFileScanSignal scanSignal)
    {
        public Db Db => db;
        public IMemoryCache Cache => cache;
        public ChatPush Push => push;
        public PresenceService Presence => presence;
        public PresenceTracker Tracker => tracker;
        public ChatOptions Options => options.Value;
        public IClock Clock => clock;
        public ChatFileScanSignal ScanSignal => scanSignal;
    }

    static string UserPartition(HttpContext c) => c.User.Identity?.IsAuthenticated == true ? "u:" + c.User.UserId() : "ip:" + c.Connection.RemoteIpAddress;

    public static void AddChatRateLimits(this RateLimiterOptions o)
    {
        static ChatOptions Opt(HttpContext c) => c.RequestServices.GetRequiredService<IOptions<ChatOptions>>().Value;
        o.AddPolicy(SendRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(UserPartition(c),
            _ => new FixedWindowRateLimiterOptions { PermitLimit = Opt(c).SendPermitPer10Seconds, Window = TimeSpan.FromSeconds(10), QueueLimit = 0 }));
        o.AddPolicy(UploadRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(UserPartition(c),
            _ => new FixedWindowRateLimiterOptions { PermitLimit = Opt(c).UploadPermitPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
        o.AddPolicy(SearchRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(UserPartition(c),
            _ => new FixedWindowRateLimiterOptions { PermitLimit = Opt(c).SearchPermitPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    }

    public static RouteGroupBuilder MapChatEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/chat").RequirePermission(ChatAccess.Permission);
        g.MapGet("/status", Status);
        g.MapGet("/people", People);
        g.MapGet("/presence", Presence);
        g.MapGet("/me/preferences", GetPreferences);
        g.MapPut("/me/preferences", PutPreferences);

        g.MapGet("/conversations", Conversations);
        g.MapPost("/direct", StartDirect);
        g.MapPost("/groups", CreateGroup);
        g.MapGet("/conversations/{id:guid}", Conversation);
        g.MapPut("/conversations/{id:guid}", UpdateGroup);
        g.MapPost("/conversations/{id:guid}/pin", (Guid id, FlagInput i, ChatServices s, HttpContext ctx) => SetFlag(id, "IsPinned", i.On, s, ctx));
        g.MapPost("/conversations/{id:guid}/archive", (Guid id, FlagInput i, ChatServices s, HttpContext ctx) => SetFlag(id, "IsArchived", i.On, s, ctx));
        g.MapPost("/conversations/{id:guid}/mute", Mute);
        g.MapPost("/conversations/{id:guid}/read", MarkRead);
        g.MapPost("/conversations/{id:guid}/mark-unread", MarkUnread);
        g.MapPost("/delivered", DeliveredAll);

        g.MapPost("/conversations/{id:guid}/members", AddMembers);
        g.MapDelete("/conversations/{id:guid}/members/{userId:guid}", RemoveMember);
        g.MapPut("/conversations/{id:guid}/members/{userId:guid}/role", SetRole);

        g.MapGet("/conversations/{id:guid}/messages", Messages);
        g.MapPost("/conversations/{id:guid}/messages", Send).RequireRateLimiting(SendRateLimit);
        g.MapPut("/messages/{id:guid}", Edit).RequireRateLimiting(SendRateLimit);
        g.MapDelete("/messages/{id:guid}", Delete);
        g.MapPost("/messages/{id:guid}/reactions", React).RequireRateLimiting(SendRateLimit);
        g.MapPost("/messages/{id:guid}/forward", Forward).RequireRateLimiting(SendRateLimit);
        g.MapGet("/search", Search).RequireRateLimiting(SearchRateLimit);

        ChatFileEndpoints.Map(g);
        return api;
    }

    // ---- DTOs ---------------------------------------------------------------------------------------------------------------

    public sealed record PersonDto(Guid Id, string Name, string? Code, string? Department, string? Designation, PresenceDto? Presence);
    public sealed record ReplyDto(Guid Id, long Seq, string Kind, string? Preview, bool Deleted, string? SenderName, string? FileName);
    public sealed record FileDto(Guid Id, string Name, long Size, string Extension, string Category, string Status, bool Inline);
    public sealed record ReactionDto(string Emoji, List<Guid> UserIds, List<string> Names);
    public sealed record MentionDto(Guid Id, string Name);
    /// <summary>
    /// Saved / Pinned / Mentions / MentionAll / MentionsMe were added with advanced chat (V031). Saved and MentionsMe are for the person
    /// the message was loaded for (false in pushes that go to many people, except message.new / message.updated pushes to the mentioned
    /// people, which carry MentionsMe = true).
    /// </summary>
    public sealed record MessageDto(Guid Id, long Seq, Guid ConversationId, Guid? ClientMessageId, string Kind, string? Body, DateTime CreatedUtc,
        DateTime? EditedUtc, bool Deleted, bool Forwarded, Guid? SenderId, string? SenderName, ReplyDto? ReplyTo, FileDto? File, List<ReactionDto> Reactions,
        bool Saved = false, bool Pinned = false, List<MentionDto>? Mentions = null, bool MentionAll = false, bool MentionsMe = false);

    sealed class MessageRow
    {
        public long MessageId { get; set; }
        public Guid PublicId { get; set; }
        public Guid ConversationPublicId { get; set; }
        public Guid? ClientMessageId { get; set; }
        public string Kind { get; set; } = "";
        public string? Body { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime? EditedUtc { get; set; }
        public DateTime? DeletedUtc { get; set; }
        public bool IsForwarded { get; set; }
        public long? SenderUserId { get; set; }
        public Guid? SenderId { get; set; }
        public string? SenderName { get; set; }
        public long? ReplyMessageId { get; set; }
        public Guid? ReplyId { get; set; }
        public string? ReplyKind { get; set; }
        public string? ReplyBody { get; set; }
        public DateTime? ReplyDeleted { get; set; }
        public string? ReplySender { get; set; }
        public string? ReplyFileName { get; set; }
        public Guid? FileId { get; set; }
        public string? FileName { get; set; }
        public long? FileSize { get; set; }
        public string? FileExtension { get; set; }
        public string? FileStatus { get; set; }
        public DateTime? FileDeleted { get; set; }
        public string? FileCategory { get; set; }
        public bool? FileInline { get; set; }
    }

    const string MessageSelect = """
        SELECT m.MessageId, m.PublicId, cv.PublicId AS ConversationPublicId, m.ClientMessageId, m.Kind, m.Body, m.CreatedUtc, m.EditedUtc, m.DeletedUtc, m.IsForwarded,
               m.SenderUserId, su.PublicId AS SenderId, se.DisplayName AS SenderName,
               r.MessageId AS ReplyMessageId, r.PublicId AS ReplyId, r.Kind AS ReplyKind, LEFT(r.Body, 160) AS ReplyBody, r.DeletedUtc AS ReplyDeleted,
               re.DisplayName AS ReplySender, rf.OriginalName AS ReplyFileName,
               f.PublicId AS FileId, f.OriginalName AS FileName, f.SizeBytes AS FileSize, f.Extension AS FileExtension, f.ScanStatus AS FileStatus,
               f.DeletedUtc AS FileDeleted, t.Category AS FileCategory, t.InlinePreview AS FileInline
        FROM chat.TRN_ChatMessage m
        JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = m.ConversationId
        LEFT JOIN auth.Users su ON su.UserId = m.SenderUserId LEFT JOIN org.Employees se ON se.EmployeeId = su.EmployeeId
        LEFT JOIN chat.TRN_ChatMessage r ON r.MessageId = m.ReplyToMessageId
        LEFT JOIN auth.Users ru ON ru.UserId = r.SenderUserId LEFT JOIN org.Employees re ON re.EmployeeId = ru.EmployeeId
        LEFT JOIN chat.TRN_ChatFile rf ON rf.MessageId = r.MessageId
        LEFT JOIN chat.TRN_ChatFile f ON f.MessageId = m.MessageId
        LEFT JOIN chat.MST_ChatFileType t ON t.Extension = f.Extension
        """;

    /// <summary>Messages by internal id, as anyone allowed to see them sees them (reply previews from before <paramref name="visibleFrom"/> are hidden).</summary>
    internal static async Task<List<MessageDto>> LoadMessagesAsync(IDbConnection c, string where, object param, long visibleFrom, IDbTransaction? tx = null,
        long viewerUserId = 0)
    {
        var rows = (await c.QueryAsync<MessageRow>($"{MessageSelect} {where}", param, tx)).ToList();
        if (rows.Count == 0) return [];
        var reactions = (await c.QueryAsync<(long MessageId, string Emoji, Guid UserId, string? Name)>("""
            SELECT x.MessageId, x.Emoji, u.PublicId AS UserId, e.DisplayName AS Name
            FROM chat.TRN_ChatMessageReaction x JOIN auth.Users u ON u.UserId = x.UserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE x.MessageId IN @ids ORDER BY x.CreatedUtc
            """, new { ids = rows.Select(r => r.MessageId).ToArray() }, tx)).ToLookup(x => x.MessageId);
        // Advanced chat (V031): saved / pinned / mentions. Null on a database without V031 (the fields keep their defaults).
        var extras = await ChatAdvancedEndpoints.ExtrasAsync(c, rows.Select(r => r.MessageId).ToArray(), viewerUserId, tx);
        return rows.Select(r =>
        {
            var dto = ToDto(r, visibleFrom, reactions[r.MessageId]);
            return extras is null ? dto : extras.Apply(dto, r.SenderUserId, viewerUserId);
        }).ToList();
    }

    static MessageDto ToDto(MessageRow r, long visibleFrom, IEnumerable<(long MessageId, string Emoji, Guid UserId, string? Name)> reactions)
    {
        var deleted = r.DeletedUtc is not null;
        var reply = r.ReplyId is { } rid && r.ReplyMessageId > visibleFrom
            ? new ReplyDto(rid, r.ReplyMessageId!.Value, r.ReplyKind!, r.ReplyDeleted is null ? r.ReplyBody : null, r.ReplyDeleted is not null, r.ReplySender, r.ReplyDeleted is null ? r.ReplyFileName : null)
            : null;
        var file = !deleted && r.FileId is { } fid
            ? new FileDto(fid, r.FileName!, r.FileSize ?? 0, r.FileExtension!, r.FileCategory ?? "OTHER", r.FileDeleted is not null ? "REMOVED" : r.FileStatus!, r.FileInline == true)
            : null;
        var rx = deleted ? [] : reactions.GroupBy(x => x.Emoji)
            .Select(gr => new ReactionDto(gr.Key, gr.Select(x => x.UserId).ToList(), gr.Select(x => x.Name ?? "").ToList())).ToList();
        return new MessageDto(r.PublicId, r.MessageId, r.ConversationPublicId, r.ClientMessageId, r.Kind, deleted ? null : r.Body, r.CreatedUtc, r.EditedUtc,
            deleted, r.IsForwarded, r.SenderId, r.SenderName, reply, file, rx, Mentions: []);
    }

    internal static async Task<MessageDto> LoadMessageAsync(IDbConnection c, long messageId, IDbTransaction? tx = null, long viewerUserId = 0) =>
        (await LoadMessagesAsync(c, "WHERE m.MessageId = @messageId", new { messageId }, 0, tx, viewerUserId)).Single();

    sealed class ConversationRow
    {
        public long ConversationId { get; set; }
        public Guid Id { get; set; }
        public string Type { get; set; } = "";
        public string? Name { get; set; }
        public string? Description { get; set; }
        public Guid? ImageId { get; set; }
        public DateTime CreatedUtc { get; set; }
        public string Role { get; set; } = "";
        public bool IsPinned { get; set; }
        public DateTime? MutedUntilUtc { get; set; }
        public bool IsArchived { get; set; }
        public bool MarkedUnread { get; set; }
        public long LastReadMessageId { get; set; }
        public Guid? LastId { get; set; }
        public long? LastSeq { get; set; }
        public string? LastKind { get; set; }
        public string? LastBody { get; set; }
        public DateTime? LastDeleted { get; set; }
        public DateTime? LastUtc { get; set; }
        public Guid? LastSenderId { get; set; }
        public string? LastSenderName { get; set; }
        public string? LastFileName { get; set; }
        public int Unread { get; set; }
        public long? OtherUserId { get; set; }
        public Guid? OtherId { get; set; }
        public string? OtherName { get; set; }
        public string? OtherCode { get; set; }
        public string? OtherDepartment { get; set; }
        public string? OtherDesignation { get; set; }
        public bool? OtherActive { get; set; }
        public int MemberCount { get; set; }
    }

    const string ConversationSelect = """
        SELECT c.ConversationId, c.PublicId AS Id, c.[Type], c.[Name], c.[Description], img.PublicId AS ImageId, c.CreatedUtc,
               p.[Role], p.IsPinned, p.MutedUntilUtc, p.IsArchived, p.MarkedUnread, p.LastReadMessageId,
               lm.PublicId AS LastId, lm.MessageId AS LastSeq, lm.Kind AS LastKind, LEFT(lm.Body, 160) AS LastBody, lm.DeletedUtc AS LastDeleted, lm.CreatedUtc AS LastUtc,
               lsu.PublicId AS LastSenderId, lse.DisplayName AS LastSenderName, lf.OriginalName AS LastFileName,
               (SELECT COUNT(*) FROM (SELECT TOP (100) 1 AS x FROM chat.TRN_ChatMessage um
                    WHERE um.ConversationId = c.ConversationId AND um.MessageId > p.LastReadMessageId AND um.MessageId > p.VisibleFromMessageId
                      AND um.Kind <> 'SYSTEM' AND um.SenderUserId <> @me AND um.DeletedUtc IS NULL) t) AS Unread,
               ou.UserId AS OtherUserId, ou.PublicId AS OtherId, oe.DisplayName AS OtherName, oe.EmployeeCode AS OtherCode, od.[Name] AS OtherDepartment,
               og.[Name] AS OtherDesignation, CAST(CASE WHEN c.[Type] = 'GROUP' OR (ou.IsActive = 1 AND oe.IsActive = 1) THEN 1 ELSE 0 END AS BIT) AS OtherActive,
               (SELECT COUNT(*) FROM chat.TRN_ChatConversationParticipant x WHERE x.ConversationId = c.ConversationId AND x.LeftUtc IS NULL) AS MemberCount
        FROM chat.TRN_ChatConversationParticipant p
        JOIN chat.TRN_ChatConversation c ON c.ConversationId = p.ConversationId AND c.IsActive = 1
        LEFT JOIN chat.TRN_ChatMessage lm ON lm.MessageId = c.LastMessageId AND lm.MessageId > p.VisibleFromMessageId
        LEFT JOIN auth.Users lsu ON lsu.UserId = lm.SenderUserId LEFT JOIN org.Employees lse ON lse.EmployeeId = lsu.EmployeeId
        LEFT JOIN chat.TRN_ChatFile lf ON lf.MessageId = lm.MessageId
        LEFT JOIN chat.TRN_ChatFile img ON img.FileId = c.ImageFileId AND img.DeletedUtc IS NULL AND img.ScanStatus = 'CLEAN'
        OUTER APPLY (SELECT TOP (1) x.UserId FROM chat.TRN_ChatConversationParticipant x WHERE c.[Type] = 'DIRECT' AND x.ConversationId = c.ConversationId AND x.UserId <> @me) o
        LEFT JOIN auth.Users ou ON ou.UserId = o.UserId LEFT JOIN org.Employees oe ON oe.EmployeeId = ou.EmployeeId
        LEFT JOIN org.Departments od ON od.DepartmentId = oe.DepartmentId LEFT JOIN org.Designations og ON og.DesignationId = oe.DesignationId
        WHERE p.UserId = @me AND p.LeftUtc IS NULL
        """;

    static async Task<List<object>> ConversationDtosAsync(IDbConnection c, ChatServices s, long me, long? conversationId)
    {
        var rows = (await c.QueryAsync<ConversationRow>($"""
            {ConversationSelect}
              AND (@cid IS NULL OR c.ConversationId = @cid)
              AND (@cid IS NOT NULL OR c.[Type] = 'GROUP' OR c.LastMessageId IS NOT NULL OR c.CreatedByUserId = @me)
            ORDER BY p.IsPinned DESC, COALESCE(c.LastMessageUtc, c.CreatedUtc) DESC
            OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY
            """, new { me, cid = conversationId })).ToList();
        var presence = await s.Presence.LoadAsync(c, rows.Where(r => r.OtherUserId is not null).Select(r => r.OtherUserId!.Value).ToList(), me);
        var mentionsUnread = await ChatAdvancedEndpoints.MentionsUnreadAsync(c, me, conversationId);
        var now = s.Clock.UtcNow;
        return rows.Select(r => (object)new
        {
            id = r.Id,
            type = r.Type,
            name = r.Type == "GROUP" ? r.Name : r.OtherName,
            description = r.Description,
            imageId = r.ImageId,
            createdUtc = r.CreatedUtc,
            role = r.Role,
            pinned = r.IsPinned,
            muted = r.MutedUntilUtc is { } mu && mu > now,
            mutedUntilUtc = r.MutedUntilUtc is { } m2 && m2 > now ? m2 : (DateTime?)null,
            archived = r.IsArchived,
            markedUnread = r.MarkedUnread,
            unread = r.Unread,
            mentionsUnread = mentionsUnread.GetValueOrDefault(r.ConversationId),
            readSeq = r.LastReadMessageId,
            memberCount = r.MemberCount,
            other = r.OtherId is { } oid
                ? new PersonDto(oid, r.OtherName ?? "", r.OtherCode, r.OtherDepartment, r.OtherDesignation, presence.GetValueOrDefault(r.OtherUserId!.Value))
                : null,
            otherActive = r.OtherActive ?? true,
            lastMessage = r.LastId is { } lid
                ? new
                {
                    id = lid,
                    seq = r.LastSeq,
                    kind = r.LastKind,
                    preview = r.LastDeleted is not null ? null : r.LastKind == "FILE" ? (r.LastBody ?? r.LastFileName) : r.LastBody,
                    fileName = r.LastDeleted is null ? r.LastFileName : null,
                    deleted = r.LastDeleted is not null,
                    createdUtc = r.LastUtc,
                    senderId = r.LastSenderId,
                    senderName = r.LastSenderName,
                }
                : null,
        }).ToList();
    }

    /// <summary>One conversation as a person sees it in their list (pushed as conversation.updated).</summary>
    static async Task<object?> ConversationDtoAsync(IDbConnection c, ChatServices s, long me, long conversationId) =>
        (await ConversationDtosAsync(c, s, me, conversationId)).FirstOrDefault();

    // ---- Status, people, presence, preferences -----------------------------------------------------------------------------

    static async Task<IResult> Status(ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        if (!await ChatAccess.EnabledAsync(c, s.Cache)) return Results.Ok(new { enabled = false, reason = "DISABLED" });
        var me = await ChatAccess.LoadMeAsync(c, ctx.User.UserId());
        if (me is null) return Results.Ok(new { enabled = false, reason = "NO_EMPLOYEE" });
        var now = s.Clock.UtcNow;
        var unread = await c.QuerySingleAsync<(int Conversations, int Messages)>("""
            SELECT COUNT(CASE WHEN n > 0 OR MarkedUnread = 1 THEN 1 END) AS Conversations, ISNULL(SUM(n), 0) AS Messages FROM (
                SELECT p.MarkedUnread, (SELECT COUNT(*) FROM (SELECT TOP (100) 1 AS x FROM chat.TRN_ChatMessage m
                        WHERE m.ConversationId = p.ConversationId AND m.MessageId > p.LastReadMessageId AND m.MessageId > p.VisibleFromMessageId
                          AND m.Kind <> 'SYSTEM' AND m.SenderUserId <> @me AND m.DeletedUtc IS NULL) t) AS n
                FROM chat.TRN_ChatConversationParticipant p JOIN chat.TRN_ChatConversation c ON c.ConversationId = p.ConversationId AND c.IsActive = 1
                WHERE p.UserId = @me AND p.LeftUtc IS NULL AND p.IsArchived = 0 AND (p.MutedUntilUtc IS NULL OR p.MutedUntilUtc <= @now)
            ) x
            """, new { me = me.UserId, now });
        return Results.Ok(new
        {
            enabled = true,
            me = new { id = me.Id, name = me.Name },
            unread = new { conversations = unread.Conversations, messages = unread.Messages },
            preferences = await PreferencesAsync(c, me.UserId, now),
            limits = new { bodyMax = BodyMax, maxUploadMb = s.Options.MaxUploadMb, editMinutes = s.Options.EditWindowMinutes, deleteMinutes = s.Options.DeleteWindowMinutes, maxGroupMembers = s.Options.MaxGroupMembers },
            // Switch on AND the person's own access (V032: chat.tasks / chat.calls after per-user module access).
            tasks = ctx.User.Can(ModuleAccess.TasksPermission) && await ChatWorkEndpoints.TasksEnabledAsync(c, s.Cache),
            calls = ctx.User.Can(ModuleAccess.CallsPermission) && await ChatCallEndpoints.CallsEnabledAsync(c, s.Cache),
            advanced = await ChatAdvancedEndpoints.AdvancedEnabledAsync(c, s.Cache),
            // Task collaboration (V033): assign tasks, review before close, comments, proof files, shared notes.
            taskCollab = ctx.User.Can(ModuleAccess.TasksPermission) && await ChatWorkEndpoints.TasksEnabledAsync(c, s.Cache)
                && await ChatWorkEndpoints.CollabEnabledAsync(c, s.Cache),
        });
    }

    static async Task<object> PreferencesAsync(IDbConnection c, long userId, DateTime now)
    {
        var p = await c.QuerySingleOrDefaultAsync<(string Availability, bool ShowLastSeen, bool SoundsOn)?>(
            "SELECT Availability, ShowLastSeen, SoundsOn FROM chat.MST_ChatUserPreference WHERE UserId = @userId", new { userId });
        // Quiet hours (V031): always present; defaults on a database without V031.
        var q = await ChatAdvancedEndpoints.QuietAsync(c, userId, now);
        return new
        {
            availability = p?.Availability ?? "AVAILABLE", showLastSeen = p?.ShowLastSeen ?? true, soundsOn = p?.SoundsOn ?? true,
            quietEnabled = q.Enabled, quietStart = q.Start, quietEnd = q.End, quietDays = q.Days, quietCallPolicy = q.CallPolicy,
            quietAllowMentions = q.AllowMentions, quietAllowUrgent = q.AllowUrgent, timeZone = q.TimeZone, quietNow = q.Now,
        };
    }

    static string? Like(string? term) =>
        string.IsNullOrWhiteSpace(term) ? null : "%" + term.Trim()[..Math.Min(term.Trim().Length, 80)].Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";

    sealed record PersonRow(long UserId, Guid Id, string Name, string? Code, string? Department, string? Designation);

    /// <summary>Colleagues by name, employee code, department or designation (no e-mail: decision D8). Active employees with an account.</summary>
    static async Task<IResult> People(string? search, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var term = Like(search);
        var rows = (await c.QueryAsync<PersonRow>("""
            SELECT TOP (30) u.UserId, u.PublicId AS Id, e.DisplayName AS Name, e.EmployeeCode AS Code, d.[Name] AS Department, g.[Name] AS Designation
            FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId LEFT JOIN org.Designations g ON g.DesignationId = e.DesignationId
            WHERE u.IsActive = 1 AND u.UserId <> @me
              AND (@term IS NULL OR e.DisplayName LIKE @term OR e.EmployeeCode LIKE @term OR d.[Name] LIKE @term OR g.[Name] LIKE @term)
            ORDER BY e.DisplayName
            """, new { me = me.UserId, term })).ToList();
        var presence = await s.Presence.LoadAsync(c, rows.Select(r => r.UserId).ToList(), me.UserId);
        // canCall (V032): the colleague can receive audio calls (holds chat.calls after per-user module access).
        var callable = await ModuleAccess.WhoHasAsync(c, rows.Select(r => r.UserId), ModuleAccess.CallsPermission);
        return Results.Ok(rows.Select(r => new
        {
            id = r.Id, name = r.Name, code = r.Code, department = r.Department, designation = r.Designation, presence = presence[r.UserId],
            canCall = callable.Contains(r.UserId),
        }));
    }

    /// <summary>Presence of up to 100 people the caller shares a conversation with (the website refreshes visible people every minute).</summary>
    static async Task<IResult> Presence(string? ids, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var wanted = (ids ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => Guid.TryParse(x, out var g) ? g : Guid.Empty)
            .Where(g => g != Guid.Empty).Distinct().Take(100).ToArray();
        if (wanted.Length == 0) return Results.Ok(Array.Empty<object>());
        var users = (await c.QueryAsync<(long UserId, Guid Id)>("""
            SELECT DISTINCT u.UserId, u.PublicId AS Id FROM auth.Users u
            JOIN chat.TRN_ChatConversationParticipant o ON o.UserId = u.UserId AND o.LeftUtc IS NULL
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = o.ConversationId AND p.UserId = @me AND p.LeftUtc IS NULL
            WHERE u.PublicId IN @wanted
            """, new { me = me.UserId, wanted })).ToList();
        var presence = await s.Presence.LoadAsync(c, users.Select(u => u.UserId).ToList(), me.UserId);
        return Results.Ok(users.Select(u => new { userId = u.Id, presence = presence[u.UserId] }));
    }

    static async Task<IResult> GetPreferences(ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        return me is null ? error! : Results.Ok(await PreferencesAsync(c, me.UserId, s.Clock.UtcNow));
    }

    /// <summary>The quiet-hours fields (V031) are applied only while CHAT_ADVANCED is on; otherwise they are ignored.</summary>
    public sealed record PreferencesInput(string? Availability, bool? ShowLastSeen, bool? SoundsOn,
        bool? QuietEnabled = null, string? QuietStart = null, string? QuietEnd = null, int? QuietDays = null, string? QuietCallPolicy = null,
        bool? QuietAllowMentions = null, bool? QuietAllowUrgent = null);

    static async Task<IResult> PutPreferences(PreferencesInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var availability = input.Availability?.Trim().ToUpperInvariant();
        var pv = new Validator();
        if (availability is not null and not ("AVAILABLE" or "BUSY" or "DND" or "AWAY"))
            pv.Add("availability", "Choose Available, Busy, Do not disturb or Away.");
        var quiet = await ChatAdvancedEndpoints.AdvancedEnabledAsync(c, s.Cache) ? ChatAdvancedEndpoints.ParseQuiet(input, pv) : null;
        if (!pv.IsValid) return pv.Problem();
        await c.ExecuteAsync("""
            MERGE chat.MST_ChatUserPreference WITH (HOLDLOCK) AS t
            USING (SELECT @userId AS UserId) AS s ON t.UserId = s.UserId
            WHEN MATCHED THEN UPDATE SET Availability = COALESCE(@availability, t.Availability), ShowLastSeen = COALESCE(@showLastSeen, t.ShowLastSeen),
                SoundsOn = COALESCE(@soundsOn, t.SoundsOn), ModifiedUtc = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (UserId, Availability, ShowLastSeen, SoundsOn)
                VALUES (s.UserId, COALESCE(@availability, 'AVAILABLE'), COALESCE(@showLastSeen, 1), COALESCE(@soundsOn, 1));
            """, new { userId = me.UserId, availability, showLastSeen = input.ShowLastSeen, soundsOn = input.SoundsOn });
        if (quiet is not null) await ChatAdvancedEndpoints.SaveQuietAsync(c, me.UserId, quiet);
        var contacts = (await ChatAccess.ContactUserIdsAsync(c, me.UserId)).Where(s.Tracker.IsOnline).ToList();
        if (contacts.Count > 0) await s.Push.ToUsersAsync(contacts, "presence", await s.Presence.PushPayloadAsync(c, me.UserId, me.Id));
        var prefs = await PreferencesAsync(c, me.UserId, s.Clock.UtcNow);
        await s.Push.ToUsersAsync([me.UserId], "preferences", prefs);
        return Results.Ok(prefs);
    }

    // ---- Conversations -----------------------------------------------------------------------------------------------------

    static async Task<IResult> Conversations(ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        return Results.Ok(await ConversationDtosAsync(c, s, me.UserId, null));
    }

    static async Task<IResult> Conversation(Guid id, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var dto = await ConversationDtoAsync(c, s, me.UserId, m.ConversationId);
        var members = (await c.QueryAsync<(long UserId, Guid Id, string Name, string? Code, string? Department, string? Designation, string Role, long ReadSeq, long DeliveredSeq, DateTime JoinedUtc, long VisibleFrom)>("""
            SELECT u.UserId, u.PublicId AS Id, e.DisplayName AS Name, e.EmployeeCode AS Code, d.[Name] AS Department, g.[Name] AS Designation,
                   p.[Role], p.LastReadMessageId AS ReadSeq, p.LastDeliveredMessageId AS DeliveredSeq, p.JoinedUtc, p.VisibleFromMessageId AS VisibleFrom
            FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId LEFT JOIN org.Designations g ON g.DesignationId = e.DesignationId
            WHERE p.ConversationId = @cid AND p.LeftUtc IS NULL
            ORDER BY CASE p.[Role] WHEN 'ADMIN' THEN 0 ELSE 1 END, e.DisplayName
            """, new { cid = m.ConversationId })).ToList();
        var presence = await s.Presence.LoadAsync(c, members.Select(x => x.UserId).ToList(), me.UserId);
        return Results.Ok(new
        {
            conversation = dto,
            members = members.Select(x => new
            {
                id = x.Id, name = x.Name, code = x.Code, department = x.Department, designation = x.Designation, role = x.Role,
                readSeq = x.ReadSeq, deliveredSeq = x.DeliveredSeq, visibleFromSeq = x.VisibleFrom, joinedUtc = x.JoinedUtc,
                presence = presence.GetValueOrDefault(x.UserId), me = x.UserId == me.UserId,
            }),
        });
    }

    public sealed record DirectInput(Guid UserId);

    static async Task<IResult> StartDirect(DirectInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var other = await c.QuerySingleOrDefaultAsync<long?>("""
            SELECT u.UserId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            WHERE u.PublicId = @id AND u.IsActive = 1
            """, new { id = input.UserId });
        if (other is null) return Db_.NotFound("Employee");
        if (other == me.UserId) return Db_.Conflict("You cannot start a chat with yourself.");
        var key = $"{Math.Min(me.UserId, other.Value)}:{Math.Max(me.UserId, other.Value)}";
        var existing = await c.QuerySingleOrDefaultAsync<long?>("SELECT ConversationId FROM chat.TRN_ChatConversation WHERE DirectKey = @key", new { key });
        if (existing is null)
        {
            using var tx = c.BeginTransaction();
            try
            {
                existing = await c.QuerySingleAsync<long>("""
                    INSERT chat.TRN_ChatConversation ([Type], DirectKey, CreatedByUserId) OUTPUT inserted.ConversationId VALUES ('DIRECT', @key, @me);
                    """, new { key, me = me.UserId }, tx);
                await c.ExecuteAsync("""
                    INSERT chat.TRN_ChatConversationParticipant (ConversationId, UserId, [Role], AddedByUserId) VALUES (@cid, @a, 'MEMBER', @a), (@cid, @b, 'MEMBER', @a);
                    """, new { cid = existing, a = me.UserId, b = other }, tx);
                tx.Commit();
            }
            catch (SqlException e) when (e.IsUniqueViolation())
            {
                tx.Rollback();
                existing = await c.QuerySingleAsync<long>("SELECT ConversationId FROM chat.TRN_ChatConversation WHERE DirectKey = @key", new { key });
            }
        }
        return Results.Ok(await ConversationDtoAsync(c, s, me.UserId, existing.Value));
    }

    public sealed record GroupInput(string? Name, string? Description, Guid[]? MemberIds);

    static async Task<List<long>?> ResolveUsersAsync(IDbConnection c, IEnumerable<Guid> ids, IDbTransaction? tx = null)
    {
        var wanted = ids.Distinct().ToArray();
        if (wanted.Length == 0) return [];
        var found = new List<long>();
        foreach (var chunk in wanted.Chunk(1000))
            found.AddRange(await c.QueryAsync<long>("""
                SELECT u.UserId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
                WHERE u.PublicId IN @chunk AND u.IsActive = 1
                """, new { chunk }, tx));
        return found.Count == wanted.Length ? found : null;
    }

    static async Task<IResult> CreateGroup(GroupInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var v = new Validator();
        var name = v.Required("name", ChatAccess.CleanText(input.Name, false), GroupNameMax, "Group name");
        var description = v.Optional("description", ChatAccess.CleanText(input.Description, true), GroupDescriptionMax, "Description");
        var memberIds = (input.MemberIds ?? []).Distinct().ToArray();
        if (memberIds.Length == 0) v.Add("memberIds", "Add at least one colleague.");
        if (memberIds.Length + 1 > s.Options.MaxGroupMembers) v.Add("memberIds", $"A group can have at most {s.Options.MaxGroupMembers} members.");
        if (!v.IsValid) return v.Problem();
        var users = await ResolveUsersAsync(c, memberIds);
        if (users is null) return Db_.NotFound("One or more employees");
        users.Remove(me.UserId);

        using var tx = c.BeginTransaction();
        var cid = await c.QuerySingleAsync<long>("""
            INSERT chat.TRN_ChatConversation ([Type], [Name], [Description], CreatedByUserId) OUTPUT inserted.ConversationId VALUES ('GROUP', @name, @description, @me)
            """, new { name, description, me = me.UserId }, tx);
        await c.ExecuteAsync("INSERT chat.TRN_ChatConversationParticipant (ConversationId, UserId, [Role], AddedByUserId) VALUES (@cid, @me, 'ADMIN', @me)",
            new { cid, me = me.UserId }, tx);
        await c.ExecuteAsync("INSERT chat.TRN_ChatConversationParticipant (ConversationId, UserId, [Role], AddedByUserId) VALUES (@cid, @u, 'MEMBER', @me)",
            users.Select(u => new { cid, u, me = me.UserId }), tx);
        var sys = await SystemMessageAsync(c, tx, cid, $"{me.Name} created the group \"{name}\"");
        var publicId = await c.ExecuteScalarAsync<Guid>("SELECT PublicId FROM chat.TRN_ChatConversation WHERE ConversationId = @cid", new { cid }, tx);
        await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_GROUP_CREATED", "ChatConversation", publicId.ToString(), $"Group created with {users.Count + 1} members",
            ClientInfo.From(ctx).Ip, tx, newValues: new { members = users.Count + 1 });
        tx.Commit();
        await PushLastSystemMessageAsync(c, s, cid);
        await PushConversationAsync(c, s, cid, users.Append(me.UserId), "conversation.added");
        await ChatAdvancedEndpoints.NotifyGroupAddedAsync(c, s, me.Name, publicId, name!, users);
        return Results.Ok(await ConversationDtoAsync(c, s, me.UserId, cid));
    }

    static async Task<IResult> UpdateGroup(Guid id, GroupInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!m.IsGroup) return Db_.Conflict("Only groups have a name and description.");
        if (!m.IsAdmin) return Problems.Create(403, "FORBIDDEN", "Only group admins can change the group details.");
        var v = new Validator();
        var name = v.Required("name", ChatAccess.CleanText(input.Name, false), GroupNameMax, "Group name");
        var description = v.Optional("description", ChatAccess.CleanText(input.Description, true), GroupDescriptionMax, "Description");
        if (!v.IsValid) return v.Problem();
        using var tx = c.BeginTransaction();
        var old = await c.QuerySingleAsync<(string Name, string? Description)>("SELECT [Name], [Description] FROM chat.TRN_ChatConversation WHERE ConversationId = @cid", new { cid = m.ConversationId }, tx);
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversation SET [Name] = @name, [Description] = @description, ModifiedUtc = SYSUTCDATETIME() WHERE ConversationId = @cid",
            new { name, description, cid = m.ConversationId }, tx);
        if (old.Name != name) await SystemMessageAsync(c, tx, m.ConversationId, $"{me.Name} renamed the group to \"{name}\"");
        else if (old.Description != description) await SystemMessageAsync(c, tx, m.ConversationId, $"{me.Name} changed the group description");
        await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_GROUP_UPDATED", "ChatConversation", id.ToString(), "Group details changed", ClientInfo.From(ctx).Ip, tx,
            newValues: new { renamed = old.Name != name, descriptionChanged = old.Description != description });
        tx.Commit();
        await PushLastSystemMessageAsync(c, s, m.ConversationId);
        await PushConversationAsync(c, s, m.ConversationId, await ChatAccess.MemberUserIdsAsync(c, m.ConversationId), "conversation.updated");
        return Results.Ok(await ConversationDtoAsync(c, s, me.UserId, m.ConversationId));
    }

    public sealed record FlagInput(bool On);

    static async Task<IResult> SetFlag(Guid id, string column, bool on, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var sql = column switch
        {
            "IsPinned" => "UPDATE chat.TRN_ChatConversationParticipant SET IsPinned = @on WHERE ConversationId = @cid AND UserId = @me",
            "IsArchived" => "UPDATE chat.TRN_ChatConversationParticipant SET IsArchived = @on WHERE ConversationId = @cid AND UserId = @me",
            _ => throw new ArgumentOutOfRangeException(nameof(column)),
        };
        await c.ExecuteAsync(sql, new { on, cid = m.ConversationId, me = me.UserId });
        return await SelfUpdatedAsync(c, s, me.UserId, m.ConversationId);
    }

    /// <summary>Mute: { minutes } (8 h, 1 week …), { forever: true }, or { minutes: 0 } to unmute.</summary>
    public sealed record MuteInput(int? Minutes, bool? Forever);

    static async Task<IResult> Mute(Guid id, MuteInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        DateTime? until = input.Forever == true ? new DateTime(9999, 12, 31, 0, 0, 0, DateTimeKind.Utc)
            : input.Minutes is > 0 and <= 525_600 ? s.Clock.UtcNow.AddMinutes(input.Minutes.Value) : null;
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversationParticipant SET MutedUntilUtc = @until WHERE ConversationId = @cid AND UserId = @me",
            new { until, cid = m.ConversationId, me = me.UserId });
        return await SelfUpdatedAsync(c, s, me.UserId, m.ConversationId);
    }

    public sealed record ReadInput(long Seq);

    static async Task<IResult> MarkRead(Guid id, ReadInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var changed = await c.ExecuteAsync("""
            UPDATE p SET LastReadMessageId = CASE WHEN @seq > p.LastReadMessageId THEN @seq ELSE p.LastReadMessageId END,
                         LastDeliveredMessageId = CASE WHEN @seq > p.LastDeliveredMessageId THEN @seq ELSE p.LastDeliveredMessageId END,
                         MarkedUnread = 0
            FROM chat.TRN_ChatConversationParticipant p JOIN chat.TRN_ChatConversation c ON c.ConversationId = p.ConversationId
            WHERE p.ConversationId = @cid AND p.UserId = @me AND @seq <= ISNULL(c.LastMessageId, 0)
              AND (p.LastReadMessageId < @seq OR p.MarkedUnread = 1)
            """, new { seq = input.Seq, cid = m.ConversationId, me = me.UserId });
        if (changed > 0)
        {
            await s.Push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, m.ConversationId), "receipt",
                new { conversationId = id, userId = me.Id, readSeq = input.Seq, deliveredSeq = input.Seq });
            await SelfUpdatedAsync(c, s, me.UserId, m.ConversationId);
        }
        return Results.NoContent();
    }

    static async Task<IResult> MarkUnread(Guid id, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversationParticipant SET MarkedUnread = 1 WHERE ConversationId = @cid AND UserId = @me",
            new { cid = m.ConversationId, me = me.UserId });
        return await SelfUpdatedAsync(c, s, me.UserId, m.ConversationId);
    }

    /// <summary>The website loaded the conversation list: everything in it has reached this person's device ("delivered" ticks).</summary>
    static async Task<IResult> DeliveredAll(ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var changed = (await c.QueryAsync<(long ConversationId, Guid Id, long Seq)>("""
            UPDATE p SET LastDeliveredMessageId = c.LastMessageId
            OUTPUT inserted.ConversationId, c.PublicId AS Id, inserted.LastDeliveredMessageId AS Seq
            FROM chat.TRN_ChatConversationParticipant p JOIN chat.TRN_ChatConversation c ON c.ConversationId = p.ConversationId
            WHERE p.UserId = @me AND p.LeftUtc IS NULL AND c.LastMessageId IS NOT NULL AND p.LastDeliveredMessageId < c.LastMessageId
            """, new { me = me.UserId })).ToList();
        foreach (var x in changed)
            await s.Push.ToUsersAsync((await ChatAccess.MemberUserIdsAsync(c, x.ConversationId)).Where(u => u != me.UserId), "receipt",
                new { conversationId = x.Id, userId = me.Id, deliveredSeq = x.Seq, readSeq = (long?)null });
        return Results.NoContent();
    }

    static async Task<IResult> SelfUpdatedAsync(IDbConnection c, ChatServices s, long me, long conversationId)
    {
        var dto = await ConversationDtoAsync(c, s, me, conversationId);
        await s.Push.ToUsersAsync([me], "conversation.updated", dto!);
        return Results.Ok(dto);
    }

    /// <summary>Each person gets the conversation as they see it (unread, pin, other person differ per person).</summary>
    static async Task PushConversationAsync(IDbConnection c, ChatServices s, long conversationId, IEnumerable<long> userIds, string evt)
    {
        foreach (var u in userIds.Distinct())
            if (await ConversationDtoAsync(c, s, u, conversationId) is { } dto) await s.Push.ToUsersAsync([u], evt, dto);
    }

    // ---- Members -----------------------------------------------------------------------------------------------------------

    public sealed record MembersInput(Guid[]? UserIds);

    static async Task<IResult> AddMembers(Guid id, MembersInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!m.IsGroup) return Db_.Conflict("People can be added to groups only. Create a group to chat with more people.");
        if (!m.IsAdmin) return Problems.Create(403, "FORBIDDEN", "Only group admins can add people.");
        var users = await ResolveUsersAsync(c, input.UserIds ?? []);
        if (users is null || users.Count == 0) return Db_.NotFound("One or more employees");
        var current = await ChatAccess.MemberUserIdsAsync(c, m.ConversationId);
        var adding = users.Except(current).ToList();
        if (adding.Count == 0) return Db_.Conflict("They are already in the group.");
        if (current.Count + adding.Count > s.Options.MaxGroupMembers) return Db_.Conflict($"A group can have at most {s.Options.MaxGroupMembers} members.");

        using var tx = c.BeginTransaction();
        var last = await c.ExecuteScalarAsync<long?>("SELECT LastMessageId FROM chat.TRN_ChatConversation WITH (UPDLOCK) WHERE ConversationId = @cid", new { cid = m.ConversationId }, tx) ?? 0;
        // New members see the conversation from now on, not its earlier history.
        await c.ExecuteAsync("""
            MERGE chat.TRN_ChatConversationParticipant AS t
            USING (SELECT @cid AS ConversationId, @u AS UserId) AS x ON t.ConversationId = x.ConversationId AND t.UserId = x.UserId
            WHEN MATCHED THEN UPDATE SET LeftUtc = NULL, [Role] = 'MEMBER', JoinedUtc = SYSUTCDATETIME(), AddedByUserId = @me, VisibleFromMessageId = @last,
                LastReadMessageId = @last, LastDeliveredMessageId = @last, IsArchived = 0, MarkedUnread = 0
            WHEN NOT MATCHED THEN INSERT (ConversationId, UserId, [Role], AddedByUserId, VisibleFromMessageId, LastReadMessageId, LastDeliveredMessageId)
                VALUES (@cid, @u, 'MEMBER', @me, @last, @last, @last);
            """, adding.Select(u => new { cid = m.ConversationId, u, me = me.UserId, last }), tx);
        var names = (await c.QueryAsync<string>("SELECT e.DisplayName FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId IN @adding ORDER BY e.DisplayName",
            new { adding }, tx)).ToList();
        await SystemMessageAsync(c, tx, m.ConversationId, $"{me.Name} added {JoinNames(names)}");
        await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_MEMBERS_ADDED", "ChatConversation", id.ToString(), $"{adding.Count} member(s) added to a group",
            ClientInfo.From(ctx).Ip, tx, newValues: new { added = adding.Count });
        tx.Commit();
        await PushLastSystemMessageAsync(c, s, m.ConversationId);
        await PushConversationAsync(c, s, m.ConversationId, adding, "conversation.added");
        await PushConversationAsync(c, s, m.ConversationId, current, "conversation.updated");
        await ChatAdvancedEndpoints.NotifyGroupAddedAsync(c, s, me.Name, m.Id, m.Name ?? "a group", adding);
        return Results.NoContent();
    }

    static string JoinNames(List<string> names) => names.Count switch
    {
        0 => "",
        1 => names[0],
        <= 4 => string.Join(", ", names[..^1]) + " and " + names[^1],
        _ => string.Join(", ", names.Take(3)) + $" and {names.Count - 3} others",
    };

    static async Task<IResult> RemoveMember(Guid id, Guid userId, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!m.IsGroup) return Db_.Conflict("You cannot leave a direct chat. Archive it instead.");
        var target = await c.QuerySingleOrDefaultAsync<(long UserId, string Role, string Name)?>("""
            SELECT p.UserId, p.[Role], e.DisplayName AS Name FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId
            JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE p.ConversationId = @cid AND u.PublicId = @userId AND p.LeftUtc IS NULL
            """, new { cid = m.ConversationId, userId });
        if (target is null) return Db_.NotFound("Member");
        var self = target.Value.UserId == me.UserId;
        if (!self && !m.IsAdmin) return Problems.Create(403, "FORBIDDEN", "Only group admins can remove people.");

        using var tx = c.BeginTransaction();
        var members = (await c.QueryAsync<(long UserId, string Role)>(
            "SELECT UserId, [Role] FROM chat.TRN_ChatConversationParticipant WITH (UPDLOCK) WHERE ConversationId = @cid AND LeftUtc IS NULL", new { cid = m.ConversationId }, tx)).ToList();
        // Approved: the last admin cannot leave a group that still has other members without choosing another admin first.
        if (target.Value.Role == "ADMIN" && members.Count(x => x.Role == "ADMIN") == 1 && members.Count > 1)
        {
            tx.Rollback();
            return Db_.Conflict(self ? "You are the only admin. Make someone else an admin before you leave the group." : "A group needs at least one admin.");
        }
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversationParticipant SET LeftUtc = SYSUTCDATETIME(), IsPinned = 0 WHERE ConversationId = @cid AND UserId = @u",
            new { cid = m.ConversationId, u = target.Value.UserId }, tx);
        await SystemMessageAsync(c, tx, m.ConversationId, self ? $"{me.Name} left the group" : $"{me.Name} removed {target.Value.Name}");
        await Audit.WriteAsync(c, "USER", me.UserId, self ? "CHAT_GROUP_LEFT" : "CHAT_MEMBER_REMOVED", "ChatConversation", id.ToString(),
            self ? "Left a group" : "Member removed from a group", ClientInfo.From(ctx).Ip, tx, newValues: new { member = userId });
        tx.Commit();
        await PushLastSystemMessageAsync(c, s, m.ConversationId);
        s.Cache.Remove($"chat:typing:{target.Value.UserId}:{id}");
        await s.Push.ToUsersAsync([target.Value.UserId], "conversation.removed", new { id });
        await PushConversationAsync(c, s, m.ConversationId, members.Select(x => x.UserId).Where(u => u != target.Value.UserId), "conversation.updated");
        return Results.NoContent();
    }

    public sealed record RoleInput(string? Role);

    static async Task<IResult> SetRole(Guid id, Guid userId, RoleInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!m.IsGroup || !m.IsAdmin) return Problems.Create(403, "FORBIDDEN", "Only group admins can change roles.");
        var role = input.Role?.Trim().ToUpperInvariant();
        if (role is not ("ADMIN" or "MEMBER")) { var v = new Validator(); v.Add("role", "Choose Admin or Member."); return v.Problem(); }
        var target = await c.QuerySingleOrDefaultAsync<(long UserId, string Role, string Name)?>("""
            SELECT p.UserId, p.[Role], e.DisplayName AS Name FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId
            JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE p.ConversationId = @cid AND u.PublicId = @userId AND p.LeftUtc IS NULL
            """, new { cid = m.ConversationId, userId });
        if (target is null) return Db_.NotFound("Member");
        if (target.Value.Role == role) return Results.NoContent();
        using var tx = c.BeginTransaction();
        if (role == "MEMBER" && await c.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM chat.TRN_ChatConversationParticipant WITH (UPDLOCK) WHERE ConversationId = @cid AND LeftUtc IS NULL AND [Role] = 'ADMIN'", new { cid = m.ConversationId }, tx) <= 1)
        {
            tx.Rollback();
            return Db_.Conflict("A group needs at least one admin.");
        }
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversationParticipant SET [Role] = @role WHERE ConversationId = @cid AND UserId = @u",
            new { role, cid = m.ConversationId, u = target.Value.UserId }, tx);
        await SystemMessageAsync(c, tx, m.ConversationId, role == "ADMIN" ? $"{me.Name} made {target.Value.Name} an admin" : $"{me.Name} removed {target.Value.Name} as admin");
        await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_MEMBER_ROLE_CHANGED", "ChatConversation", id.ToString(), $"Group role changed to {role}",
            ClientInfo.From(ctx).Ip, tx, privileged: true, newValues: new { member = userId, role, previous = target.Value.Role });
        tx.Commit();
        await PushLastSystemMessageAsync(c, s, m.ConversationId);
        await PushConversationAsync(c, s, m.ConversationId, await ChatAccess.MemberUserIdsAsync(c, m.ConversationId), "conversation.updated");
        return Results.NoContent();
    }

    // ---- Messages ----------------------------------------------------------------------------------------------------------

    /// <summary>
    /// After a group change has been committed: pushes its SYSTEM line ("X added Y") as message.new to the current members, so open
    /// conversations show it at once (the list already updates through conversation.updated). Repeats are harmless (clients merge by id).
    /// </summary>
    internal static async Task PushLastSystemMessageAsync(IDbConnection c, ChatServices s, long conversationId)
    {
        var last = await c.ExecuteScalarAsync<long?>("""
            SELECT cv.LastMessageId FROM chat.TRN_ChatConversation cv JOIN chat.TRN_ChatMessage m ON m.MessageId = cv.LastMessageId AND m.Kind = 'SYSTEM'
            WHERE cv.ConversationId = @conversationId
            """, new { conversationId });
        if (last is { } id) await s.Push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, conversationId), "message.new", await LoadMessageAsync(c, id));
    }

    /// <summary>Inserts a SYSTEM line ("X added Y"); the caller pushes it after committing (PushLastSystemMessageAsync).</summary>
    internal static async Task<long> SystemMessageAsync(IDbConnection c, IDbTransaction tx, long conversationId, string text)
    {
        var id = await c.QuerySingleAsync<long>("""
            INSERT chat.TRN_ChatMessage (ConversationId, Kind, Body) OUTPUT inserted.MessageId VALUES (@conversationId, 'SYSTEM', @text);
            """, new { conversationId, text = text.Length > BodyMax ? text[..BodyMax] : text }, tx);
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversation SET LastMessageId = @id, LastMessageUtc = SYSUTCDATETIME() WHERE ConversationId = @conversationId",
            new { id, conversationId }, tx);
        return id;
    }

    /// <summary>
    /// Page of messages, oldest first. ?before=seq (older, for scrolling up), ?after=seq (newer, for catching up after a reconnect),
    /// ?around=seq (a search result in context); default: the newest page.
    /// </summary>
    static async Task<IResult> Messages(Guid id, long? before, long? after, long? around, int? limit, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var take = Math.Clamp(limit ?? 50, 1, PageMax);
        List<MessageDto> items;
        bool hasOlder, hasNewer = false;
        if (after is { } a)
        {
            items = await LoadMessagesAsync(c, $"WHERE m.ConversationId = @cid AND m.MessageId > @floor ORDER BY m.MessageId OFFSET 0 ROWS FETCH NEXT {take + 1} ROWS ONLY",
                new { cid = m.ConversationId, floor = Math.Max(a, m.VisibleFrom) }, m.VisibleFrom, null, me.UserId);
            hasNewer = items.Count > take;
            items = items.Take(take).ToList();
            hasOlder = true;
        }
        else
        {
            var ceiling = around is { } ar ? ar + take / 2 + 1 : before ?? long.MaxValue;
            var older = await LoadMessagesAsync(c, $"WHERE m.ConversationId = @cid AND m.MessageId > @floor AND m.MessageId < @ceiling ORDER BY m.MessageId DESC OFFSET 0 ROWS FETCH NEXT {take + 1} ROWS ONLY",
                new { cid = m.ConversationId, floor = m.VisibleFrom, ceiling }, m.VisibleFrom, null, me.UserId);
            hasOlder = older.Count > take;
            items = older.Take(take).OrderBy(x => x.Seq).ToList();
            if (around is not null)
                hasNewer = await c.ExecuteScalarAsync<int>("SELECT CASE WHEN EXISTS (SELECT 1 FROM chat.TRN_ChatMessage WHERE ConversationId = @cid AND MessageId >= @ceiling) THEN 1 ELSE 0 END",
                    new { cid = m.ConversationId, ceiling }) == 1;
        }
        return Results.Ok(new { items, hasOlder, hasNewer });
    }

    /// <summary>MentionIds / MentionAll (V031) are used only while CHAT_ADVANCED is on; otherwise they are ignored.</summary>
    public sealed record SendInput(Guid? ClientMessageId, string? Body, Guid? ReplyToId, Guid[]? MentionIds = null, bool? MentionAll = null);

    static async Task<IResult> Send(Guid id, SendInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var v = new Validator();
        var body = v.Required("body", ChatAccess.CleanText(input.Body, true), BodyMax, "Message");
        if (!v.IsValid) return v.Problem();
        ChatAdvancedEndpoints.MentionPlan? mentions = null;
        if ((input.MentionIds is { Length: > 0 } || input.MentionAll == true) && await ChatAdvancedEndpoints.AdvancedEnabledAsync(c, s.Cache))
        {
            if (input.MentionAll == true && !(m.IsGroup && m.IsAdmin)) return ChatAdvancedEndpoints.MentionAllNotAllowed();
            mentions = await ChatAdvancedEndpoints.PlanMentionsAsync(c, me, m, input.MentionIds ?? [], input.MentionAll == true);
        }
        var result = await InsertMessageAsync(c, s, me, m, "TEXT", body, input.ClientMessageId, input.ReplyToId, false,
            mentions is null ? null : (tx, messageId) => ChatAdvancedEndpoints.SaveMentionsAsync(c, tx, mentions, messageId, body!));
        if (result.Created && mentions is not null) await ChatAdvancedEndpoints.PushMentionBellsAsync(s.Push, mentions);
        return result.Error ?? Results.Ok(result.Message is { } dto ? await LoadMessageAsync(c, dto.Seq, null, me.UserId) : null);
    }

    /// <summary>Created: false when the ClientMessageId was already saved (the earlier message is returned).</summary>
    internal sealed record InsertResult(MessageDto? Message, IResult? Error, bool Created = false);

    /// <summary>
    /// Saves a message (TEXT, or FILE with its file row via <paramref name="beforeCommit"/>), moves the conversation's last-message
    /// pointer, marks it read for the sender, commits, then pushes message.new to every current member's tabs. A repeated
    /// ClientMessageId returns the message already saved (retries after a network drop never duplicate).
    /// </summary>
    internal static async Task<InsertResult> InsertMessageAsync(IDbConnection c, ChatServices s, ChatMe me, ChatMembership m, string kind, string? body,
        Guid? clientMessageId, Guid? replyToId, bool forwarded, Func<IDbTransaction, long, Task>? beforeCommit)
    {
        if (clientMessageId is { } cmid && await c.QuerySingleOrDefaultAsync<long?>(
                "SELECT MessageId FROM chat.TRN_ChatMessage WHERE SenderUserId = @me AND ClientMessageId = @cmid", new { me = me.UserId, cmid }) is { } dup)
            return new InsertResult(await LoadMessageAsync(c, dup), null);
        if (m.Type == "DIRECT" && await c.ExecuteScalarAsync<int>("""
                SELECT COUNT(*) FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
                WHERE p.ConversationId = @cid AND p.UserId <> @me AND u.IsActive = 1 AND e.IsActive = 1
                """, new { cid = m.ConversationId, me = me.UserId }) == 0)
            return new InsertResult(null, Db_.Conflict("This colleague is no longer active, so messages cannot be sent to them."));
        long? replyTo = null;
        if (replyToId is { } rid)
        {
            replyTo = await c.QuerySingleOrDefaultAsync<long?>(
                "SELECT MessageId FROM chat.TRN_ChatMessage WHERE PublicId = @rid AND ConversationId = @cid AND MessageId > @visible AND Kind <> 'SYSTEM'",
                new { rid, cid = m.ConversationId, visible = m.VisibleFrom });
            if (replyTo is null) return new InsertResult(null, Db_.NotFound("The message you are replying to"));
        }

        long messageId;
        using (var tx = c.BeginTransaction())
        {
            try
            {
                messageId = await c.QuerySingleAsync<long>("""
                    INSERT chat.TRN_ChatMessage (ConversationId, SenderUserId, ClientMessageId, Kind, Body, ReplyToMessageId, IsForwarded)
                    OUTPUT inserted.MessageId VALUES (@cid, @me, @cmid, @kind, @body, @replyTo, @forwarded);
                    """, new { cid = m.ConversationId, me = me.UserId, cmid = clientMessageId, kind, body, replyTo, forwarded }, tx);
            }
            catch (SqlException e) when (e.IsUniqueViolation() && clientMessageId is not null)
            {
                tx.Rollback();
                var existing = await c.QuerySingleAsync<long>("SELECT MessageId FROM chat.TRN_ChatMessage WHERE SenderUserId = @me AND ClientMessageId = @cmid",
                    new { me = me.UserId, cmid = clientMessageId });
                return new InsertResult(await LoadMessageAsync(c, existing), null);
            }
            if (beforeCommit is not null) await beforeCommit(tx, messageId);
            await c.ExecuteAsync("UPDATE chat.TRN_ChatConversation SET LastMessageId = @messageId, LastMessageUtc = SYSUTCDATETIME() WHERE ConversationId = @cid AND (LastMessageId IS NULL OR LastMessageId < @messageId)",
                new { messageId, cid = m.ConversationId }, tx);
            await c.ExecuteAsync("""
                UPDATE chat.TRN_ChatConversationParticipant SET LastReadMessageId = @messageId, LastDeliveredMessageId = @messageId, MarkedUnread = 0
                WHERE ConversationId = @cid AND UserId = @me AND LastReadMessageId < @messageId
                """, new { messageId, cid = m.ConversationId, me = me.UserId }, tx);
            tx.Commit();
        }
        var dto = await LoadMessageAsync(c, messageId);
        await ChatAdvancedEndpoints.PushMessageAsync(c, s.Push, await ChatAccess.MemberUserIdsAsync(c, m.ConversationId), "message.new", dto);
        return new InsertResult(dto, null, true);
    }

    sealed record OwnMessage(long MessageId, long ConversationId, Guid ConversationPublicId, long? SenderUserId, string Kind, DateTime CreatedUtc, DateTime? DeletedUtc, long VisibleFrom);

    /// <summary>A message in a conversation the caller is an active member of (and visible to them), or null.</summary>
    static Task<OwnMessage?> VisibleMessageAsync(IDbConnection c, Guid messageId, long userId) =>
        c.QuerySingleOrDefaultAsync<OwnMessage>("""
            SELECT m.MessageId, m.ConversationId, cv.PublicId AS ConversationPublicId, m.SenderUserId, m.Kind, m.CreatedUtc, m.DeletedUtc, p.VisibleFromMessageId AS VisibleFrom
            FROM chat.TRN_ChatMessage m JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = m.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = m.ConversationId AND p.UserId = @userId AND p.LeftUtc IS NULL
            WHERE m.PublicId = @messageId AND m.MessageId > p.VisibleFromMessageId
            """, new { messageId, userId });

    public sealed record EditInput(string? Body);

    static async Task<IResult> Edit(Guid id, EditInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var msg = await VisibleMessageAsync(c, id, me.UserId);
        if (msg is null || msg.DeletedUtc is not null) return Db_.NotFound("Message");
        if (msg.SenderUserId != me.UserId) return Problems.Create(403, "FORBIDDEN", "You can edit only your own messages.");
        if (msg.Kind != "TEXT") return Db_.Conflict("Only text messages can be edited.");
        if (s.Clock.UtcNow - msg.CreatedUtc > TimeSpan.FromMinutes(s.Options.EditWindowMinutes))
            return Db_.Conflict($"Messages can be edited for {s.Options.EditWindowMinutes} minutes after sending.");
        var v = new Validator();
        var body = v.Required("body", ChatAccess.CleanText(input.Body, true), BodyMax, "Message");
        if (!v.IsValid) return v.Problem();
        await c.ExecuteAsync("UPDATE chat.TRN_ChatMessage SET Body = @body, EditedUtc = SYSUTCDATETIME() WHERE MessageId = @mid", new { body, mid = msg.MessageId });
        var dto = await LoadMessageAsync(c, msg.MessageId);
        await ChatAdvancedEndpoints.PushMessageAsync(c, s.Push, await ChatAccess.MemberUserIdsAsync(c, msg.ConversationId), "message.updated", dto);
        return Results.Ok(await LoadMessageAsync(c, msg.MessageId, null, me.UserId));
    }

    /// <summary>Delete for everyone (own messages, within the delete window): the text and any attachment are removed for good.</summary>
    static async Task<IResult> Delete(Guid id, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var msg = await VisibleMessageAsync(c, id, me.UserId);
        if (msg is null || msg.DeletedUtc is not null) return Db_.NotFound("Message");
        if (msg.SenderUserId != me.UserId) return Problems.Create(403, "FORBIDDEN", "You can delete only your own messages.");
        if (s.Clock.UtcNow - msg.CreatedUtc > TimeSpan.FromMinutes(s.Options.DeleteWindowMinutes))
            return Db_.Conflict($"Messages can be deleted for everyone within {s.Options.DeleteWindowMinutes} minutes of sending.");
        var unpinned = false;
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("UPDATE chat.TRN_ChatMessage SET Body = NULL, DeletedUtc = SYSUTCDATETIME(), DeletedByUserId = @me WHERE MessageId = @mid",
                new { me = me.UserId, mid = msg.MessageId }, tx);
            await c.ExecuteAsync("DELETE FROM chat.TRN_ChatMessageReaction WHERE MessageId = @mid", new { mid = msg.MessageId }, tx);
            // Advanced chat (V031): a deleted message is no longer pinned (the guard keeps this working on a database without V031).
            unpinned = await c.ExecuteAsync("""
                IF OBJECT_ID(N'chat.TRN_ChatPinnedMessage', N'U') IS NOT NULL DELETE FROM chat.TRN_ChatPinnedMessage WHERE MessageId = @mid
                """, new { mid = msg.MessageId }, tx) > 0;
            var files = (await c.QueryAsync<(Guid Id, string StorageKey)>(
                "UPDATE chat.TRN_ChatFile SET DeletedUtc = SYSUTCDATETIME() OUTPUT inserted.PublicId AS Id, inserted.StorageKey WHERE MessageId = @mid AND DeletedUtc IS NULL",
                new { mid = msg.MessageId }, tx)).ToList();
            foreach (var f in files)
                await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_FILE_DELETED", "ChatFile", f.Id.ToString(), "Attachment deleted with its message", ClientInfo.From(ctx).Ip, tx);
            tx.Commit();
            foreach (var f in files) await ChatFileEndpoints.DeletePhysicalIfUnusedAsync(c, s.Options, f.StorageKey);
        }
        var dto = await LoadMessageAsync(c, msg.MessageId);
        await s.Push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, msg.ConversationId), "message.updated", dto);
        if (unpinned) await s.Push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, msg.ConversationId), "pins.updated", new { conversationId = msg.ConversationPublicId });
        await PushConversationAsync(c, s, msg.ConversationId, await ChatAccess.MemberUserIdsAsync(c, msg.ConversationId), "conversation.updated");
        return Results.NoContent();
    }

    public sealed record ReactInput(string? Emoji);

    /// <summary>Toggles one emoji reaction of the caller on a message (at most 10 different emoji per person per message).</summary>
    static async Task<IResult> React(Guid id, ReactInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var emoji = input.Emoji?.Trim();
        if (!ChatAccess.IsEmoji(emoji)) { var v = new Validator(); v.Add("emoji", "Choose an emoji."); return v.Problem(); }
        var msg = await VisibleMessageAsync(c, id, me.UserId);
        if (msg is null || msg.DeletedUtc is not null || msg.Kind == "SYSTEM") return Db_.NotFound("Message");
        var removed = await c.ExecuteAsync("DELETE FROM chat.TRN_ChatMessageReaction WHERE MessageId = @mid AND UserId = @me AND Emoji = @emoji",
            new { mid = msg.MessageId, me = me.UserId, emoji });
        if (removed == 0)
        {
            if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatMessageReaction WHERE MessageId = @mid AND UserId = @me", new { mid = msg.MessageId, me = me.UserId }) >= 10)
                return Db_.Conflict("You can add at most 10 reactions to a message.");
            try
            {
                await c.ExecuteAsync("INSERT chat.TRN_ChatMessageReaction (MessageId, UserId, Emoji) VALUES (@mid, @me, @emoji)", new { mid = msg.MessageId, me = me.UserId, emoji });
            }
            catch (SqlException e) when (e.IsUniqueViolation()) { /* double click: already there */ }
        }
        var dto = await LoadMessageAsync(c, msg.MessageId);
        await ChatAdvancedEndpoints.PushMessageAsync(c, s.Push, await ChatAccess.MemberUserIdsAsync(c, msg.ConversationId), "message.updated", dto);
        return Results.Ok(await LoadMessageAsync(c, msg.MessageId, null, me.UserId));
    }

    public sealed record ForwardInput(Guid[]? ConversationIds);

    /// <summary>Forwards a text or file message to up to 10 of the caller's conversations (marked "Forwarded"; the original sender is not revealed).</summary>
    static async Task<IResult> Forward(Guid id, ForwardInput input, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var msg = await VisibleMessageAsync(c, id, me.UserId);
        if (msg is null || msg.DeletedUtc is not null || msg.Kind == "SYSTEM") return Db_.NotFound("Message");
        var targets = (input.ConversationIds ?? []).Distinct().ToArray();
        if (targets.Length is 0 or > 10) { var v = new Validator(); v.Add("conversationIds", "Choose between 1 and 10 chats."); return v.Problem(); }
        var source = await c.QuerySingleAsync<(string? Body, long? FileId)>(
            "SELECT m.Body, f.FileId FROM chat.TRN_ChatMessage m LEFT JOIN chat.TRN_ChatFile f ON f.MessageId = m.MessageId AND f.DeletedUtc IS NULL WHERE m.MessageId = @mid",
            new { mid = msg.MessageId });
        if (msg.Kind == "FILE" && source.FileId is null) return Db_.Conflict("This attachment is no longer available.");
        var memberships = new List<ChatMembership>();
        foreach (var t in targets)
        {
            if (await ChatAccess.MemberAsync(c, t, me.UserId) is not { } tm) return ChatAccess.NotFound();
            memberships.Add(tm);
        }
        var sent = new List<MessageDto>();
        foreach (var tm in memberships)
        {
            Func<IDbTransaction, long, Task>? copyFile = source.FileId is { } fid
                ? async (tx, newMessageId) => await c.ExecuteAsync("""
                    INSERT chat.TRN_ChatFile (ConversationId, MessageId, UploadedByUserId, OriginalName, Extension, ContentType, SizeBytes, Sha256, StorageKey, ScanStatus, ScanAttempts, ScannedUtc, ScanDetail)
                    SELECT @cid, @newMessageId, @me, OriginalName, Extension, ContentType, SizeBytes, Sha256, StorageKey, ScanStatus, ScanAttempts, ScannedUtc, ScanDetail
                    FROM chat.TRN_ChatFile WHERE FileId = @fid
                    """, new { cid = tm.ConversationId, newMessageId, me = me.UserId, fid }, tx)
                : null;
            var r = await InsertMessageAsync(c, s, me, tm, msg.Kind, source.Body, null, null, true, copyFile);
            if (r.Error is not null) return r.Error;
            sent.Add(r.Message!);
        }
        return Results.Ok(sent);
    }

    // ---- Search ------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Text and file-name search across the caller's own conversations (or one), newest first, 30 per page (?beforeSeq= for more),
    /// optionally by sender and date range. Only messages the caller can see; deleted messages never match.
    /// </summary>
    /// <remarks>
    /// Advanced chat (V031) adds the aliases ?from= / ?to= (UTC, same as fromUtc / toUtc) and ?before= (seq of the last item shown, same
    /// as beforeSeq); with CHAT_ADVANCED on, q may be empty when senderId, a date or files=true is given.
    /// </remarks>
    static async Task<IResult> Search(string? q, Guid? conversationId, Guid? senderId, DateTime? fromUtc, DateTime? toUtc, bool? files, long? beforeSeq,
        DateTime? from, DateTime? to, long? before, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var term = Like(q);
        fromUtc ??= ChatAdvancedEndpoints.AsUtc(from);
        toUtc ??= ChatAdvancedEndpoints.AsUtc(to);
        beforeSeq ??= before;
        var otherFilter = (senderId is not null || fromUtc is not null || toUtc is not null) && await ChatAdvancedEndpoints.AdvancedEnabledAsync(c, s.Cache);
        if (term is null && files != true && !otherFilter) { var v = new Validator(); v.Add("q", "Type something to search for."); return v.Problem(); }
        long? cid = null;
        if (conversationId is { } conv)
        {
            if (await ChatAccess.MemberAsync(c, conv, me.UserId) is not { } m) return ChatAccess.NotFound();
            cid = m.ConversationId;
        }
        var ids = (await c.QueryAsync<(long MessageId, long VisibleFrom)>("""
            SELECT TOP (31) m.MessageId, p.VisibleFromMessageId AS VisibleFrom
            FROM chat.TRN_ChatConversationParticipant p
            JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = p.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatMessage m ON m.ConversationId = p.ConversationId AND m.MessageId > p.VisibleFromMessageId
            LEFT JOIN chat.TRN_ChatFile f ON f.MessageId = m.MessageId AND f.DeletedUtc IS NULL
            LEFT JOIN auth.Users su ON su.UserId = m.SenderUserId
            WHERE p.UserId = @me AND p.LeftUtc IS NULL AND m.DeletedUtc IS NULL AND m.Kind <> 'SYSTEM'
              AND (@cid IS NULL OR p.ConversationId = @cid)
              AND (@beforeSeq IS NULL OR m.MessageId < @beforeSeq)
              AND (@senderId IS NULL OR su.PublicId = @senderId)
              AND (@fromUtc IS NULL OR m.CreatedUtc >= @fromUtc) AND (@toUtc IS NULL OR m.CreatedUtc < @toUtc)
              AND (@files = 0 OR f.FileId IS NOT NULL)
              AND (@term IS NULL OR m.Body LIKE @term OR f.OriginalName LIKE @term)
            ORDER BY m.MessageId DESC
            """, new { me = me.UserId, cid, beforeSeq, senderId, fromUtc, toUtc, files = files == true, term })).ToList();
        var page = ids.Take(30).ToList();
        // Results span conversations with different visibility: reply previews are left out (opening the result shows them in context).
        var items = page.Count == 0 ? [] : await LoadMessagesAsync(c, "WHERE m.MessageId IN @ids ORDER BY m.MessageId DESC", new { ids = page.Select(x => x.MessageId).ToArray() },
            long.MaxValue, null, me.UserId);
        return Results.Ok(new { items, hasMore = ids.Count > 30 });
    }
}
