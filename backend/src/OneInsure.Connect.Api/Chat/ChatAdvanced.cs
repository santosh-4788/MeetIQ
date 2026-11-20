using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;
using static OneInsure.Connect.Api.Chat.ChatEndpoints;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// Chat Phase 5 - advanced chat (V031, requirement section 17): scheduled messages, saved ("starred") messages, pinned messages,
/// @mentions (with bell notifications), favourite colleagues, quiet hours and the "added to a group" bell. Every endpoint needs
/// CHAT and CHAT_ADVANCED on (403 FEATURE_DISABLED otherwise) and goes through the caller's active membership exactly like the
/// message endpoints: anything the caller cannot see is answered with 404. Scheduled messages are sent by the server
/// (ChatScheduledMessageWorker) exactly once, through the same code path as Send. Message text is never logged.
/// </summary>
public static class ChatAdvancedEndpoints
{
    public const string FeatureKey = RoomFeatureEndpoints.Keys.ChatAdvanced;
    public const int MaxMentions = 50;
    public const int MaxPinsPerConversation = 20;
    public const int MaxFavourites = 30;
    public const int MaxPendingScheduled = 100;
    public const int MentionExcerptMax = 140;
    static readonly string[] ScheduledStates = ["PENDING", "SENDING", "SENT", "CANCELLED", "FAILED"];

    public static RouteGroupBuilder MapChatAdvancedEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/chat").RequirePermission(ChatAccess.Permission);
        g.MapGet("/scheduled", Scheduled);
        g.MapPost("/conversations/{id:guid}/scheduled", CreateScheduled).RequireRateLimiting(SendRateLimit);
        g.MapPatch("/scheduled/{id:guid}", PatchScheduled).RequireRateLimiting(SendRateLimit);
        g.MapDelete("/scheduled/{id:guid}", CancelScheduled);

        g.MapPost("/messages/{id:guid}/save", (Guid id, ChatServices s, HttpContext ctx) => SetSaved(id, true, s, ctx)).RequireRateLimiting(SendRateLimit);
        g.MapDelete("/messages/{id:guid}/save", (Guid id, ChatServices s, HttpContext ctx) => SetSaved(id, false, s, ctx));
        g.MapGet("/saved", Saved).RequireRateLimiting(SearchRateLimit);

        g.MapPost("/messages/{id:guid}/pin", (Guid id, ChatServices s, HttpContext ctx) => SetPinned(id, true, s, ctx)).RequireRateLimiting(SendRateLimit);
        g.MapDelete("/messages/{id:guid}/pin", (Guid id, ChatServices s, HttpContext ctx) => SetPinned(id, false, s, ctx));
        g.MapGet("/conversations/{id:guid}/pins", Pins);

        g.MapGet("/mentions", Mentions);

        g.MapGet("/favourites", Favourites);
        g.MapPut("/favourites/{userId:guid}", AddFavourite).RequireRateLimiting(SendRateLimit);
        g.MapDelete("/favourites/{userId:guid}", RemoveFavourite);
        g.MapPost("/favourites/order", OrderFavourites).RequireRateLimiting(SendRateLimit);
        return api;
    }

    // ---- Switch, schema, access --------------------------------------------------------------------------------------------

    public static IResult Disabled() => Problems.Create(403, "FEATURE_DISABLED", "Advanced chat features are switched off by your administrator.");
    public static IResult MentionAllNotAllowed() => Problems.Create(403, "MENTION_ALL_NOT_ALLOWED", "Only group admins can mention everyone, and only in a group.");
    static IResult LimitReached(string detail) => Problems.Create(400, "LIMIT_REACHED", detail);
    static IResult Invalid(string field, string message) { var v = new Validator(); v.Add(field, message); return v.Problem(); }

    /// <summary>The CHAT_ADVANCED switch, cached for 10 s like the other chat switches. A database without V031 means "off".</summary>
    public static async Task<bool> AdvancedEnabledAsync(IDbConnection c, IMemoryCache cache)
    {
        if (cache.TryGetValue("chat:advanced-enabled", out bool on)) return on;
        on = (await RoomFeatureEndpoints.EnabledAsync(c)).Contains(FeatureKey);
        cache.Set("chat:advanced-enabled", on, TimeSpan.FromSeconds(10));
        return on;
    }

    static int schemaState;          // 0 unknown, 1 present, 2 missing
    static long schemaCheckedMs;

    /// <summary>
    /// Whether the V031 tables exist (message DTO extras, mentionsUnread and quiet hours read them). Remembered for 5 minutes when present,
    /// 30 s when missing, so a database without V031 keeps working exactly as before.
    /// </summary>
    internal static async Task<bool> SchemaReadyAsync(IDbConnection c, IDbTransaction? tx = null)
    {
        var st = Volatile.Read(ref schemaState);
        var age = Environment.TickCount64 - Interlocked.Read(ref schemaCheckedMs);
        if (st != 0 && age < (st == 1 ? 300_000 : 30_000)) return st == 1;
        var ready = await c.ExecuteScalarAsync<int>("""
            SELECT CASE WHEN OBJECT_ID(N'chat.TRN_ChatMessageMention', N'U') IS NOT NULL AND OBJECT_ID(N'chat.TRN_ChatPinnedMessage', N'U') IS NOT NULL
                         AND OBJECT_ID(N'chat.TRN_ChatSavedMessage', N'U') IS NOT NULL AND COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietAllowUrgent') IS NOT NULL
                        THEN 1 ELSE 0 END
            """, null, tx) == 1;
        Interlocked.Exchange(ref schemaCheckedMs, Environment.TickCount64);
        Volatile.Write(ref schemaState, ready ? 1 : 2);
        return ready;
    }

    static async Task<IResult> Run(ChatServices s, HttpContext ctx, Func<IDbConnection, ChatMe, Task<IResult>> run)
    {
        using var c = await s.Db.OpenAsync(ctx.RequestAborted);
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (!await AdvancedEnabledAsync(c, s.Cache)) return Disabled();
        return await run(c, me);
    }

    public static DateTime? AsUtc(DateTime? d) => d is not { } x ? null : x.Kind switch
    {
        DateTimeKind.Local => x.ToUniversalTime(),
        DateTimeKind.Unspecified => DateTime.SpecifyKind(x, DateTimeKind.Utc),
        _ => x,
    };

    static string? Like(string? term) =>
        string.IsNullOrWhiteSpace(term) ? null : "%" + term.Trim()[..Math.Min(term.Trim().Length, 80)].Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";

    static string Excerpt(string s, int max)
    {
        var v = s.Replace("\r", " ").Replace('\n', ' ').Trim();
        return v.Length <= max ? v : v[..(max - 1)].TrimEnd() + "…";
    }

    static string Cut(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    /// <summary>The conversation's title as the caller sees it (group name, or the other person in a direct chat). Needs aliases cv and @me.</summary>
    const string TitleApply = """
        OUTER APPLY (SELECT TOP (1) te.DisplayName FROM chat.TRN_ChatConversationParticipant tp JOIN auth.Users tu ON tu.UserId = tp.UserId
                     JOIN org.Employees te ON te.EmployeeId = tu.EmployeeId
                     WHERE cv.[Type] = 'DIRECT' AND tp.ConversationId = cv.ConversationId AND tp.UserId <> @me) tt
        """;
    const string TitleColumn = "CASE WHEN cv.[Type] = 'GROUP' THEN cv.[Name] ELSE tt.DisplayName END";

    sealed record VisibleMsg(long MessageId, long ConversationId, Guid ConversationPublicId, string ConversationType, string Role, string Kind,
        DateTime? DeletedUtc, long VisibleFrom);

    /// <summary>A message in a conversation the caller is an active member of (and visible to them), or null.</summary>
    static Task<VisibleMsg?> VisibleAsync(IDbConnection c, Guid messageId, long userId) =>
        c.QuerySingleOrDefaultAsync<VisibleMsg>("""
            SELECT m.MessageId, m.ConversationId, cv.PublicId AS ConversationPublicId, cv.[Type] AS ConversationType, p.[Role], m.Kind, m.DeletedUtc,
                   p.VisibleFromMessageId AS VisibleFrom
            FROM chat.TRN_ChatMessage m JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = m.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = m.ConversationId AND p.UserId = @userId AND p.LeftUtc IS NULL
            WHERE m.PublicId = @messageId AND m.MessageId > p.VisibleFromMessageId
            """, new { messageId, userId });

    /// <summary>Messages as the viewer sees them, each with the reply-preview visibility of its own conversation.</summary>
    static async Task<Dictionary<long, MessageDto>> LoadForViewerAsync(IDbConnection c, IEnumerable<(long MessageId, long VisibleFrom)> items, long viewer)
    {
        var result = new Dictionary<long, MessageDto>();
        foreach (var grp in items.GroupBy(x => x.VisibleFrom))
            foreach (var dto in await LoadMessagesAsync(c, "WHERE m.MessageId IN @ids", new { ids = grp.Select(x => x.MessageId).Distinct().ToArray() }, grp.Key, null, viewer))
                result[dto.Seq] = dto;
        return result;
    }

    // ---- Message DTO extras (saved / pinned / mentions) --------------------------------------------------------------------

    internal sealed class MessageExtras(HashSet<long> pinned, HashSet<long> saved, ILookup<long, (long MessageId, long UserId, Guid Id, string? Name)> mentions, HashSet<long> all)
    {
        public MessageDto Apply(MessageDto d, long? senderUserId, long viewer)
        {
            if (d.Deleted) return d with { Saved = saved.Contains(d.Seq), Pinned = false, Mentions = [], MentionAll = false, MentionsMe = false };
            var ms = mentions[d.Seq].ToList();
            var isAll = all.Contains(d.Seq);
            return d with
            {
                Saved = saved.Contains(d.Seq),
                Pinned = pinned.Contains(d.Seq),
                Mentions = ms.Select(x => new MentionDto(x.Id, x.Name ?? "")).ToList(),
                MentionAll = isAll,
                MentionsMe = viewer > 0 && (ms.Any(x => x.UserId == viewer) || (isAll && senderUserId != viewer)),
            };
        }
    }

    /// <summary>Saved (for <paramref name="viewer"/>), pinned and mention data of messages; null on a database without V031.</summary>
    internal static async Task<MessageExtras?> ExtrasAsync(IDbConnection c, long[] ids, long viewer, IDbTransaction? tx)
    {
        if (ids.Length == 0 || !await SchemaReadyAsync(c, tx)) return null;
        using var multi = await c.QueryMultipleAsync("""
            SELECT MessageId FROM chat.TRN_ChatPinnedMessage WHERE MessageId IN @ids;
            SELECT MessageId FROM chat.TRN_ChatSavedMessage WHERE UserId = @viewer AND MessageId IN @ids;
            SELECT mm.MessageId, mm.MentionedUserId AS UserId, u.PublicId AS Id, e.DisplayName AS Name
            FROM chat.TRN_ChatMessageMention mm JOIN auth.Users u ON u.UserId = mm.MentionedUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE mm.MessageId IN @ids AND mm.IsAll = 0 ORDER BY mm.MentionId;
            SELECT DISTINCT MessageId FROM chat.TRN_ChatMessageMention WHERE MessageId IN @ids AND IsAll = 1;
            """, new { ids, viewer }, tx);
        var pinned = (await multi.ReadAsync<long>()).ToHashSet();
        var saved = (await multi.ReadAsync<long>()).ToHashSet();
        var mentions = (await multi.ReadAsync<(long MessageId, long UserId, Guid Id, string? Name)>()).ToLookup(x => x.MessageId);
        var all = (await multi.ReadAsync<long>()).ToHashSet();
        return new MessageExtras(pinned, saved, mentions, all);
    }

    /// <summary>
    /// message.new / message.updated to the members: people the message mentions (by id, or everyone but the sender for @all) get it
    /// with mentionsMe = true, everyone else with false. saved is false in pushes (each client keeps its own value).
    /// </summary>
    internal static async Task PushMessageAsync(IDbConnection c, ChatPush push, IEnumerable<long> userIds, string evt, MessageDto dto)
    {
        var ids = userIds.Distinct().ToList();
        if (dto.Mentions is not { Count: > 0 } && !dto.MentionAll) { await push.ToUsersAsync(ids, evt, dto); return; }
        HashSet<long> mentioned;
        if (dto.MentionAll)
        {
            var sender = await c.ExecuteScalarAsync<long?>("SELECT SenderUserId FROM chat.TRN_ChatMessage WHERE MessageId = @id", new { id = dto.Seq });
            mentioned = ids.Where(u => u != sender).ToHashSet();
        }
        else
            mentioned = (await c.QueryAsync<long>("SELECT MentionedUserId FROM chat.TRN_ChatMessageMention WHERE MessageId = @id AND MentionedUserId IS NOT NULL",
                new { id = dto.Seq })).ToHashSet();
        await push.ToUsersAsync(ids.Where(u => !mentioned.Contains(u)), evt, dto with { MentionsMe = false });
        await push.ToUsersAsync(ids.Where(mentioned.Contains), evt, dto with { MentionsMe = true });
    }

    /// <summary>Per conversation of the caller: unread messages that mention them (by id or @all), not their own, not deleted.</summary>
    internal static async Task<Dictionary<long, int>> MentionsUnreadAsync(IDbConnection c, long me, long? conversationId)
    {
        if (!await SchemaReadyAsync(c)) return [];
        return (await c.QueryAsync<(long ConversationId, int N)>("""
            SELECT p.ConversationId, COUNT(DISTINCT m.MessageId) AS N
            FROM chat.TRN_ChatConversationParticipant p
            JOIN chat.TRN_ChatMessage m ON m.ConversationId = p.ConversationId AND m.MessageId > p.LastReadMessageId AND m.MessageId > p.VisibleFromMessageId
                 AND m.DeletedUtc IS NULL AND m.SenderUserId <> @me
            JOIN chat.TRN_ChatMessageMention mm ON mm.MessageId = m.MessageId AND (mm.MentionedUserId = @me OR mm.IsAll = 1)
            WHERE p.UserId = @me AND p.LeftUtc IS NULL AND (@cid IS NULL OR p.ConversationId = @cid)
            GROUP BY p.ConversationId
            """, new { me, cid = conversationId })).ToDictionary(x => x.ConversationId, x => x.N);
    }

    // ---- Mentions on send --------------------------------------------------------------------------------------------------

    /// <summary>Who a new message mentions (members only, never the sender) and who gets a CHAT_MENTION bell.</summary>
    public sealed record MentionPlan(Guid ConversationPublicId, List<long> UserIds, bool All, List<long> Recipients, string Title);

    internal static async Task<MentionPlan?> PlanMentionsAsync(IDbConnection c, ChatMe me, ChatMembership m, Guid[] mentionIds, bool all)
    {
        var members = (await c.QueryAsync<(long UserId, Guid Id)>("""
            SELECT p.UserId, u.PublicId AS Id FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId
            WHERE p.ConversationId = @cid AND p.LeftUtc IS NULL
            """, new { cid = m.ConversationId })).ToList();
        var byId = members.ToDictionary(x => x.Id, x => x.UserId);
        var userIds = mentionIds.Distinct().Where(byId.ContainsKey).Select(g => byId[g]).Where(u => u != me.UserId).Take(MaxMentions).ToList();
        if (userIds.Count == 0 && !all) return null;
        var recipients = all ? members.Select(x => x.UserId).Where(u => u != me.UserId).ToList() : userIds;
        var where = m.IsGroup ? m.Name ?? "a group" : "a direct chat";
        return new MentionPlan(m.Id, userIds, all, recipients, Cut($"{me.Name} mentioned you in {where}", 200));
    }

    /// <summary>Inside the message's transaction: the mention rows and the bells (written even if the recipient muted the chat).</summary>
    internal static async Task SaveMentionsAsync(IDbConnection c, IDbTransaction tx, MentionPlan plan, long messageId, string body)
    {
        if (plan.UserIds.Count > 0)
            await c.ExecuteAsync("INSERT chat.TRN_ChatMessageMention (MessageId, MentionedUserId, IsAll) VALUES (@messageId, @u, 0)",
                plan.UserIds.Select(u => new { messageId, u }), tx);
        if (plan.All)
            await c.ExecuteAsync("INSERT chat.TRN_ChatMessageMention (MessageId, MentionedUserId, IsAll) VALUES (@messageId, NULL, 1)", new { messageId }, tx);
        if (plan.Recipients.Count > 0)
            await c.ExecuteAsync("""
                INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@u, NULL, 'CHAT_MENTION', @title, @body, @link)
                """, plan.Recipients.Select(u => new { u, title = plan.Title, body = Excerpt(body, MentionExcerptMax), link = $"/chat?c={plan.ConversationPublicId}&seq={messageId}" }), tx);
    }

    internal static Task PushMentionBellsAsync(ChatPush push, MentionPlan plan) =>
        push.ToUsersAsync(plan.Recipients, "notification.new", new { type = "CHAT_MENTION", title = plan.Title });

    // ---- Group added -------------------------------------------------------------------------------------------------------

    /// <summary>Bell GROUP_ADDED for each person added to a group (never the person who added them). Only with CHAT_ADVANCED on.</summary>
    internal static async Task NotifyGroupAddedAsync(IDbConnection c, ChatServices s, string actorName, Guid conversationId, string groupName, IEnumerable<long> added)
    {
        var ids = added.Distinct().ToList();
        if (ids.Count == 0 || !await AdvancedEnabledAsync(c, s.Cache)) return;
        var title = Cut($"{actorName} added you to {groupName}", 200);
        await c.ExecuteAsync("""
            INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@u, NULL, 'GROUP_ADDED', @title, NULL, @link)
            """, ids.Select(u => new { u, title, link = $"/chat?c={conversationId}" }));
        await s.Push.ToUsersAsync(ids, "notification.new", new { type = "GROUP_ADDED", title });
    }

    // ---- Quiet hours -------------------------------------------------------------------------------------------------------

    public sealed record QuietPrefs(bool Enabled, string Start, string End, int Days, string CallPolicy, bool AllowMentions, bool AllowUrgent, string? TimeZone, bool Now);
    public sealed record QuietInput(bool? Enabled, TimeSpan? Start, TimeSpan? End, int? Days, string? CallPolicy, bool? AllowMentions, bool? AllowUrgent);

    static TimeZoneInfo Zone(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Utc;
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }

    static string Hm(TimeSpan t) => t.ToString(@"hh\:mm", CultureInfo.InvariantCulture);

    /// <summary>
    /// Quiet hours in the person's local time: start &lt; end is a window within one day, start &gt; end runs overnight (the day the window
    /// STARTS on must be ticked), start = end means the whole of each ticked day. Days: bit 0 = Monday ... bit 6 = Sunday.
    /// </summary>
    internal static bool IsQuietNow(bool enabled, TimeSpan start, TimeSpan end, int days, DateTime localNow)
    {
        if (!enabled) return false;
        bool Ticked(DateTime d) => (days & (1 << (((int)d.DayOfWeek + 6) % 7))) != 0;
        var t = localNow.TimeOfDay;
        if (start == end) return Ticked(localNow);
        if (start < end) return Ticked(localNow) && t >= start && t < end;
        return (t >= start && Ticked(localNow)) || (t < end && Ticked(localNow.AddDays(-1)));
    }

    internal static async Task<QuietPrefs> QuietAsync(IDbConnection c, long userId, DateTime now)
    {
        var tzId = await c.QuerySingleOrDefaultAsync<string?>("SELECT TimeZoneId FROM auth.Users WHERE UserId = @userId", new { userId });
        (bool Enabled, TimeSpan Start, TimeSpan End, byte Days, string CallPolicy, bool AllowMentions, bool AllowUrgent)? row = null;
        if (await SchemaReadyAsync(c))
            row = await c.QuerySingleOrDefaultAsync<(bool, TimeSpan, TimeSpan, byte, string, bool, bool)?>("""
                SELECT QuietEnabled, QuietStart, QuietEnd, QuietDays, QuietCallPolicy, QuietAllowMentions, QuietAllowUrgent
                FROM chat.MST_ChatUserPreference WHERE UserId = @userId
                """, new { userId });
        var r = row ?? (false, new TimeSpan(22, 0, 0), new TimeSpan(7, 0, 0), (byte)127, "SILENT", true, true);
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(now, DateTimeKind.Utc), Zone(tzId));
        return new QuietPrefs(r.Enabled, Hm(r.Start), Hm(r.End), r.Days, r.CallPolicy, r.AllowMentions, r.AllowUrgent, tzId,
            IsQuietNow(r.Enabled, r.Start, r.End, r.Days, local));
    }

    /// <summary>Validates the quiet-hours fields of PUT /chat/me/preferences; null when none was sent.</summary>
    internal static QuietInput? ParseQuiet(PreferencesInput i, Validator v)
    {
        if (i.QuietEnabled is null && i.QuietStart is null && i.QuietEnd is null && i.QuietDays is null && i.QuietCallPolicy is null
            && i.QuietAllowMentions is null && i.QuietAllowUrgent is null) return null;
        TimeSpan? Time(string field, string? s)
        {
            if (s is null) return null;
            if (TimeSpan.TryParseExact(s.Trim(), @"hh\:mm", CultureInfo.InvariantCulture, out var t) && t >= TimeSpan.Zero && t < TimeSpan.FromDays(1)) return t;
            v.Add(field, "Use a time such as 22:00 (HH:mm, 24-hour).");
            return null;
        }
        var start = Time("quietStart", i.QuietStart);
        var end = Time("quietEnd", i.QuietEnd);
        if (i.QuietDays is { } d && (d < 0 || d > 127)) v.Add("quietDays", "Choose the days as a number from 0 to 127 (bit 0 = Monday ... bit 6 = Sunday).");
        var policy = i.QuietCallPolicy?.Trim().ToUpperInvariant();
        if (policy is not null and not ("RING" or "SILENT")) v.Add("quietCallPolicy", "Choose RING or SILENT.");
        return new QuietInput(i.QuietEnabled, start, end, i.QuietDays, policy, i.QuietAllowMentions, i.QuietAllowUrgent);
    }

    /// <summary>After the preference row exists (PutPreferences' MERGE): only the fields that were sent change.</summary>
    internal static Task SaveQuietAsync(IDbConnection c, long userId, QuietInput q) =>
        c.ExecuteAsync("""
            UPDATE chat.MST_ChatUserPreference SET QuietEnabled = COALESCE(@Enabled, QuietEnabled), QuietStart = COALESCE(@Start, QuietStart),
                QuietEnd = COALESCE(@End, QuietEnd), QuietDays = COALESCE(@Days, QuietDays), QuietCallPolicy = COALESCE(@CallPolicy, QuietCallPolicy),
                QuietAllowMentions = COALESCE(@AllowMentions, QuietAllowMentions), QuietAllowUrgent = COALESCE(@AllowUrgent, QuietAllowUrgent),
                ModifiedUtc = SYSUTCDATETIME()
            WHERE UserId = @userId
            """, new { userId, q.Enabled, q.Start, q.End, Days = q.Days is { } d ? (byte?)d : null, q.CallPolicy, q.AllowMentions, q.AllowUrgent });

    // ---- Scheduled messages ------------------------------------------------------------------------------------------------

    internal sealed class ScheduledRow
    {
        public long ScheduledMessageId { get; set; }
        public long SenderUserId { get; set; }
        public Guid Id { get; set; }
        public Guid ConversationId { get; set; }
        public string? ConversationTitle { get; set; }
        public string Body { get; set; } = "";
        public Guid? ReplyToId { get; set; }
        public DateTime SendAtUtc { get; set; }
        public string State { get; set; } = "";
        public Guid? SentMessageId { get; set; }
        public long? SentSeq { get; set; }
        public string? FailureReason { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime UpdatedUtc { get; set; }
    }

    internal static object ScheduledDto(ScheduledRow r) => new
    {
        id = r.Id, conversationId = r.ConversationId, conversationTitle = r.ConversationTitle, body = r.Body, replyToId = r.ReplyToId,
        sendAtUtc = r.SendAtUtc, state = r.State, sentMessageId = r.SentMessageId, sentSeq = r.SentSeq, failureReason = r.FailureReason,
        createdUtc = r.CreatedUtc, updatedUtc = r.UpdatedUtc,
    };

    internal static readonly string ScheduledSelect = $"""
        SELECT x.ScheduledMessageId, x.SenderUserId, x.PublicId AS Id, cv.PublicId AS ConversationId, {TitleColumn} AS ConversationTitle, x.Body,
               r.PublicId AS ReplyToId, x.SendAtUtc, x.[State], sm.PublicId AS SentMessageId, x.SentMessageId AS SentSeq, x.FailureReason, x.CreatedUtc, x.UpdatedUtc
        FROM chat.TRN_ChatScheduledMessage x
        JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = x.ConversationId
        LEFT JOIN chat.TRN_ChatMessage r ON r.MessageId = x.ReplyToMessageId
        LEFT JOIN chat.TRN_ChatMessage sm ON sm.MessageId = x.SentMessageId
        {TitleApply}
        WHERE x.SenderUserId = @me
        """;

    internal static async Task<ScheduledRow?> ScheduledByIdAsync(IDbConnection c, long me, long scheduledId) =>
        await c.QuerySingleOrDefaultAsync<ScheduledRow>($"{ScheduledSelect} AND x.ScheduledMessageId = @scheduledId", new { me, scheduledId });

    /// <summary>The caller's own scheduled messages: ?state= PENDING (default, soonest first) | SENDING | SENT | CANCELLED | FAILED | all (newest first); at most 200.</summary>
    static Task<IResult> Scheduled(Guid? conversationId, string? state, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var st = string.IsNullOrWhiteSpace(state) ? "PENDING" : state.Trim().ToUpperInvariant();
        if (st != "ALL" && !ScheduledStates.Contains(st)) return Invalid("state", "Use PENDING, SENDING, SENT, CANCELLED, FAILED or all.");
        var order = st == "PENDING" ? "x.SendAtUtc, x.ScheduledMessageId" : "x.CreatedUtc DESC, x.ScheduledMessageId DESC";
        var rows = await c.QueryAsync<ScheduledRow>($"""
            {ScheduledSelect} AND (@st = 'ALL' OR x.[State] = @st) AND (@conv IS NULL OR cv.PublicId = @conv)
            ORDER BY {order} OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY
            """, new { me = me.UserId, st, conv = conversationId });
        return Results.Ok(new { items = rows.Select(ScheduledDto).ToList() });
    });

    public sealed record ScheduleInput(string? Body, DateTime? SendAtUtc, Guid? ReplyToId);
    public sealed record SchedulePatch(string? Body, DateTime? SendAtUtc);

    static void CheckSendAt(Validator v, DateTime? sendAt, DateTime now)
    {
        if (sendAt is { } d && (d < now.AddMinutes(1) || d > now.AddDays(365)))
            v.Add("sendAtUtc", "Choose a time at least 1 minute from now and at most 365 days ahead.");
    }

    static async Task<bool> DirectBlockedAsync(IDbConnection c, ChatMembership m, long me) =>
        m.Type == "DIRECT" && await c.ExecuteScalarAsync<int>("""
            SELECT COUNT(*) FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE p.ConversationId = @cid AND p.UserId <> @me AND u.IsActive = 1 AND e.IsActive = 1
            """, new { cid = m.ConversationId, me }) == 0;

    static Task<IResult> CreateScheduled(Guid id, ScheduleInput input, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var now = s.Clock.UtcNow;
        var v = new Validator();
        var body = v.Required("body", ChatAccess.CleanText(input.Body, true), BodyMax, "Message");
        var sendAt = AsUtc(input.SendAtUtc);
        if (sendAt is null) v.Add("sendAtUtc", "Choose when to send the message.");
        CheckSendAt(v, sendAt, now);
        if (!v.IsValid) return v.Problem();
        if (await DirectBlockedAsync(c, m, me.UserId)) return Db_.Conflict("This colleague is no longer active, so messages cannot be sent to them.");
        long? replyTo = null;
        if (input.ReplyToId is { } rid)
        {
            replyTo = await c.QuerySingleOrDefaultAsync<long?>(
                "SELECT MessageId FROM chat.TRN_ChatMessage WHERE PublicId = @rid AND ConversationId = @cid AND MessageId > @visible AND Kind <> 'SYSTEM'",
                new { rid, cid = m.ConversationId, visible = m.VisibleFrom });
            if (replyTo is null) return Db_.NotFound("The message you are replying to");
        }
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatScheduledMessage WHERE SenderUserId = @me AND [State] = 'PENDING'", new { me = me.UserId })
            >= MaxPendingScheduled)
            return LimitReached($"You can have at most {MaxPendingScheduled} scheduled messages waiting to be sent.");
        var newId = await c.QuerySingleAsync<long>("""
            INSERT chat.TRN_ChatScheduledMessage (ConversationId, SenderUserId, Body, ReplyToMessageId, SendAtUtc, CreatedUtc, UpdatedUtc)
            OUTPUT inserted.ScheduledMessageId VALUES (@cid, @me, @body, @replyTo, @sendAt, @now, @now)
            """, new { cid = m.ConversationId, me = me.UserId, body, replyTo, sendAt, now });
        var dto = ScheduledDto((await ScheduledByIdAsync(c, me.UserId, newId))!);
        await s.Push.ToUsersAsync([me.UserId], "scheduled.updated", dto);
        return Results.Ok(dto);
    });

    static Task<long?> OwnScheduledIdAsync(IDbConnection c, long me, Guid id) =>
        c.QuerySingleOrDefaultAsync<long?>("SELECT ScheduledMessageId FROM chat.TRN_ChatScheduledMessage WHERE PublicId = @id AND SenderUserId = @me", new { id, me });

    static IResult NotPending() => Db_.Conflict("Only a scheduled message that has not been sent yet can be changed or cancelled.");

    static Task<IResult> PatchScheduled(Guid id, SchedulePatch input, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        if (await OwnScheduledIdAsync(c, me.UserId, id) is not { } sid) return Db_.NotFound("Scheduled message");
        var row = (await ScheduledByIdAsync(c, me.UserId, sid))!;
        if (row.State != "PENDING") return NotPending();
        var now = s.Clock.UtcNow;
        var v = new Validator();
        var body = input.Body is null ? null : v.Required("body", ChatAccess.CleanText(input.Body, true), BodyMax, "Message");
        var sendAt = AsUtc(input.SendAtUtc);
        CheckSendAt(v, sendAt, now);
        if (!v.IsValid) return v.Problem();
        var changed = await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatScheduledMessage SET Body = COALESCE(@body, Body), SendAtUtc = COALESCE(@sendAt, SendAtUtc), UpdatedUtc = @now
            WHERE ScheduledMessageId = @sid AND [State] = 'PENDING'
            """, new { body, sendAt, now, sid });
        if (changed == 0) return NotPending();
        var dto = ScheduledDto((await ScheduledByIdAsync(c, me.UserId, sid))!);
        await s.Push.ToUsersAsync([me.UserId], "scheduled.updated", dto);
        return Results.Ok(dto);
    });

    static Task<IResult> CancelScheduled(Guid id, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        if (await OwnScheduledIdAsync(c, me.UserId, id) is not { } sid) return Db_.NotFound("Scheduled message");
        var changed = await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatScheduledMessage SET [State] = 'CANCELLED', UpdatedUtc = @now WHERE ScheduledMessageId = @sid AND [State] = 'PENDING'
            """, new { now = s.Clock.UtcNow, sid });
        if (changed == 0) return NotPending();
        var dto = ScheduledDto((await ScheduledByIdAsync(c, me.UserId, sid))!);
        await s.Push.ToUsersAsync([me.UserId], "scheduled.updated", dto);
        return Results.Ok(dto);
    });

    // ---- Saved messages ----------------------------------------------------------------------------------------------------

    static Task<IResult> SetSaved(Guid id, bool save, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var msg = await VisibleAsync(c, id, me.UserId);
        if (msg is null)
        {
            // Unsave is idempotent, also for a message the caller can no longer see (nothing about it is returned).
            if (!save) await c.ExecuteAsync("""
                DELETE sv FROM chat.TRN_ChatSavedMessage sv JOIN chat.TRN_ChatMessage m ON m.MessageId = sv.MessageId WHERE sv.UserId = @me AND m.PublicId = @id
                """, new { me = me.UserId, id });
            return Db_.NotFound("Message");
        }
        if (save)
        {
            if (msg.Kind == "SYSTEM" || msg.DeletedUtc is not null) return Invalid("message", "This message cannot be saved.");
            try
            {
                await c.ExecuteAsync("""
                    INSERT chat.TRN_ChatSavedMessage (UserId, MessageId, SavedUtc)
                    SELECT @me, @mid, SYSUTCDATETIME() WHERE NOT EXISTS (SELECT 1 FROM chat.TRN_ChatSavedMessage WHERE UserId = @me AND MessageId = @mid)
                    """, new { me = me.UserId, mid = msg.MessageId });
            }
            catch (SqlException e) when (e.IsUniqueViolation()) { /* double click: already saved */ }
        }
        else
            await c.ExecuteAsync("DELETE FROM chat.TRN_ChatSavedMessage WHERE UserId = @me AND MessageId = @mid", new { me = me.UserId, mid = msg.MessageId });
        return Results.Ok(await LoadMessageAsync(c, msg.MessageId, null, me.UserId));
    });

    sealed record SavedRow(long SavedMessageId, DateTime SavedUtc, long MessageId, long VisibleFrom, Guid ConversationId, string? ConversationTitle, bool IsGroup);

    static bool ParseCursor(string? before, out long? value)
    {
        value = null;
        if (string.IsNullOrWhiteSpace(before)) return true;
        if (long.TryParse(before, NumberStyles.None, CultureInfo.InvariantCulture, out var v) && v > 0) { value = v; return true; }
        return false;
    }

    /// <summary>
    /// The caller's saved messages, most recently saved first. ?search= matches the text and file names; ?limit= 1-100 (30);
    /// ?before= is the opaque cursor from the previous page's nextBefore. Only messages the caller can still see; deleted ones are left out.
    /// </summary>
    static Task<IResult> Saved(string? search, string? before, int? limit, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        if (!ParseCursor(before, out var cursor)) return Invalid("before", "Use the nextBefore value of the previous page.");
        var take = Math.Clamp(limit ?? 30, 1, PageMax);
        var rows = (await c.QueryAsync<SavedRow>($"""
            SELECT TOP ({take + 1}) sv.SavedMessageId, sv.SavedUtc, m.MessageId, p.VisibleFromMessageId AS VisibleFrom, cv.PublicId AS ConversationId,
                   {TitleColumn} AS ConversationTitle, CAST(CASE WHEN cv.[Type] = 'GROUP' THEN 1 ELSE 0 END AS BIT) AS IsGroup
            FROM chat.TRN_ChatSavedMessage sv
            JOIN chat.TRN_ChatMessage m ON m.MessageId = sv.MessageId AND m.DeletedUtc IS NULL
            JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = m.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = m.ConversationId AND p.UserId = @me AND p.LeftUtc IS NULL AND m.MessageId > p.VisibleFromMessageId
            LEFT JOIN chat.TRN_ChatFile f ON f.MessageId = m.MessageId AND f.DeletedUtc IS NULL
            {TitleApply}
            WHERE sv.UserId = @me AND (@cursor IS NULL OR sv.SavedMessageId < @cursor)
              AND (@term IS NULL OR m.Body LIKE @term OR f.OriginalName LIKE @term)
            ORDER BY sv.SavedMessageId DESC
            """, new { me = me.UserId, cursor, term = Like(search) })).ToList();
        var page = rows.Take(take).ToList();
        var messages = await LoadForViewerAsync(c, page.Select(r => (r.MessageId, r.VisibleFrom)), me.UserId);
        return Results.Ok(new
        {
            items = page.Where(r => messages.ContainsKey(r.MessageId)).Select(r => new
            {
                savedUtc = r.SavedUtc, conversationId = r.ConversationId, conversationTitle = r.ConversationTitle, isGroup = r.IsGroup, message = messages[r.MessageId],
            }).ToList(),
            hasMore = rows.Count > take,
            nextBefore = rows.Count > take ? page[^1].SavedMessageId.ToString(CultureInfo.InvariantCulture) : null,
        });
    });

    // ---- Pinned messages ---------------------------------------------------------------------------------------------------

    static Task<IResult> SetPinned(Guid id, bool pin, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var msg = await VisibleAsync(c, id, me.UserId);
        if (msg is null) return Db_.NotFound("Message");
        var changed = false;
        if (pin)
        {
            if (msg.Kind == "SYSTEM" || msg.DeletedUtc is not null) return Invalid("message", "This message cannot be pinned.");
            if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatPinnedMessage WHERE MessageId = @mid", new { mid = msg.MessageId }) == 0)
            {
                using var tx = c.BeginTransaction();
                int inserted;
                try
                {
                    inserted = await c.ExecuteAsync($"""
                        INSERT chat.TRN_ChatPinnedMessage (ConversationId, MessageId, PinnedByUserId, PinnedUtc)
                        SELECT @cid, @mid, @me, SYSUTCDATETIME()
                        WHERE (SELECT COUNT(*) FROM chat.TRN_ChatPinnedMessage WITH (UPDLOCK, HOLDLOCK) WHERE ConversationId = @cid) < {MaxPinsPerConversation}
                        """, new { cid = msg.ConversationId, mid = msg.MessageId, me = me.UserId }, tx);
                    tx.Commit();
                }
                catch (SqlException e) when (e.IsUniqueViolation()) { tx.Rollback(); inserted = -1; /* pinned at the same moment by someone else */ }
                if (inserted == 0) return LimitReached($"A conversation can have at most {MaxPinsPerConversation} pinned messages. Unpin one first.");
                changed = inserted > 0;
            }
        }
        else
        {
            var by = await c.QuerySingleOrDefaultAsync<long?>("SELECT PinnedByUserId FROM chat.TRN_ChatPinnedMessage WHERE MessageId = @mid", new { mid = msg.MessageId });
            if (by is { } pinner)
            {
                if (msg.ConversationType == "GROUP" && pinner != me.UserId && msg.Role != "ADMIN")
                    return Problems.Create(403, "FORBIDDEN", "Only the person who pinned this message or a group admin can unpin it.");
                changed = await c.ExecuteAsync("DELETE FROM chat.TRN_ChatPinnedMessage WHERE MessageId = @mid", new { mid = msg.MessageId }) > 0;
            }
        }
        if (changed)
        {
            var members = await ChatAccess.MemberUserIdsAsync(c, msg.ConversationId);
            await PushMessageAsync(c, s.Push, members, "message.updated", await LoadMessageAsync(c, msg.MessageId));
            await s.Push.ToUsersAsync(members, "pins.updated", new { conversationId = msg.ConversationPublicId });
        }
        return Results.Ok(await LoadMessageAsync(c, msg.MessageId, null, me.UserId));
    });

    sealed record PinRow(DateTime PinnedUtc, Guid PinnedById, string? PinnedByName, long MessageId);

    static Task<IResult> Pins(Guid id, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        var rows = (await c.QueryAsync<PinRow>("""
            SELECT pm.PinnedUtc, pu.PublicId AS PinnedById, pe.DisplayName AS PinnedByName, pm.MessageId
            FROM chat.TRN_ChatPinnedMessage pm
            JOIN chat.TRN_ChatMessage msg ON msg.MessageId = pm.MessageId AND msg.DeletedUtc IS NULL AND msg.MessageId > @visible
            JOIN auth.Users pu ON pu.UserId = pm.PinnedByUserId LEFT JOIN org.Employees pe ON pe.EmployeeId = pu.EmployeeId
            WHERE pm.ConversationId = @cid
            ORDER BY pm.PinnedUtc DESC, pm.PinnedMessageId DESC
            """, new { cid = m.ConversationId, visible = m.VisibleFrom })).ToList();
        var messages = await LoadForViewerAsync(c, rows.Select(r => (r.MessageId, m.VisibleFrom)), me.UserId);
        return Results.Ok(rows.Where(r => messages.ContainsKey(r.MessageId)).Select(r => new
        {
            pinnedUtc = r.PinnedUtc, pinnedBy = new { id = r.PinnedById, name = r.PinnedByName ?? "" }, message = messages[r.MessageId],
        }).ToList());
    });

    // ---- Mentions list -----------------------------------------------------------------------------------------------------

    sealed record MentionRow(long MessageId, long VisibleFrom, string? ConversationTitle, bool IsGroup);

    /// <summary>
    /// Recent messages that mention the caller (by id, or @all in a group they belong to and did not write), newest first, 30 per page.
    /// ?before= seq of the last item shown. Each item is the message DTO plus conversationTitle and isGroup.
    /// </summary>
    static Task<IResult> Mentions(long? before, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        const int take = 30;
        var rows = (await c.QueryAsync<MentionRow>($"""
            SELECT TOP ({take + 1}) m.MessageId, p.VisibleFromMessageId AS VisibleFrom, {TitleColumn} AS ConversationTitle,
                   CAST(CASE WHEN cv.[Type] = 'GROUP' THEN 1 ELSE 0 END AS BIT) AS IsGroup
            FROM chat.TRN_ChatMessage m
            JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = m.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = m.ConversationId AND p.UserId = @me AND p.LeftUtc IS NULL AND m.MessageId > p.VisibleFromMessageId
            {TitleApply}
            WHERE m.DeletedUtc IS NULL AND (@before IS NULL OR m.MessageId < @before)
              AND EXISTS (SELECT 1 FROM chat.TRN_ChatMessageMention mm WHERE mm.MessageId = m.MessageId
                          AND (mm.MentionedUserId = @me OR (mm.IsAll = 1 AND m.SenderUserId <> @me)))
            ORDER BY m.MessageId DESC
            """, new { me = me.UserId, before })).ToList();
        var page = rows.Take(take).ToList();
        var messages = await LoadForViewerAsync(c, page.Select(r => (r.MessageId, r.VisibleFrom)), me.UserId);
        var json = ctx.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions;
        var items = new JsonArray();
        foreach (var r in page.Where(r => messages.ContainsKey(r.MessageId)))
        {
            var node = JsonSerializer.SerializeToNode(messages[r.MessageId], json)!.AsObject();
            node["conversationTitle"] = r.ConversationTitle;
            node["isGroup"] = r.IsGroup;
            items.Add(node);
        }
        return Results.Ok(new { items, hasMore = rows.Count > take });
    });

    // ---- Favourites --------------------------------------------------------------------------------------------------------

    sealed record FavouriteRow(int SortOrder, long UserId, Guid Id, string Name, string? Code, string? Department, string? Designation);

    static async Task<IResult> FavouritesResultAsync(IDbConnection c, ChatServices s, long me)
    {
        var rows = (await c.QueryAsync<FavouriteRow>("""
            SELECT f.SortOrder, u.UserId, u.PublicId AS Id, e.DisplayName AS Name, e.EmployeeCode AS Code, d.[Name] AS Department, g.[Name] AS Designation
            FROM chat.TRN_ChatFavourite f
            JOIN auth.Users u ON u.UserId = f.FavouriteUserId AND u.IsActive = 1
            JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId LEFT JOIN org.Designations g ON g.DesignationId = e.DesignationId
            WHERE f.UserId = @me
            ORDER BY f.SortOrder, e.DisplayName
            """, new { me })).ToList();
        var presence = await s.Presence.LoadAsync(c, rows.Select(r => r.UserId).ToList(), me);
        return Results.Ok(rows.Select(r => new
        {
            id = r.Id, name = r.Name, code = r.Code, department = r.Department, designation = r.Designation,
            presence = presence.GetValueOrDefault(r.UserId), sortOrder = r.SortOrder,
        }).ToList());
    }

    static Task<IResult> Favourites(ChatServices s, HttpContext ctx) => Run(s, ctx, (c, me) => FavouritesResultAsync(c, s, me.UserId));

    static Task<IResult> AddFavourite(Guid userId, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var target = await c.QuerySingleOrDefaultAsync<long?>("""
            SELECT u.UserId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1 WHERE u.PublicId = @userId AND u.IsActive = 1
            """, new { userId });
        if (target is null) return Db_.NotFound("Employee");
        if (target == me.UserId) return Invalid("userId", "You cannot add yourself to your favourites.");
        var exists = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatFavourite WHERE UserId = @me AND FavouriteUserId = @target", new { me = me.UserId, target }) > 0;
        if (!exists)
        {
            if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatFavourite WHERE UserId = @me", new { me = me.UserId }) >= MaxFavourites)
                return LimitReached($"You can have at most {MaxFavourites} favourites.");
            try
            {
                await c.ExecuteAsync("""
                    INSERT chat.TRN_ChatFavourite (UserId, FavouriteUserId, SortOrder)
                    SELECT @me, @target, ISNULL(MAX(SortOrder), -1) + 1 FROM chat.TRN_ChatFavourite WHERE UserId = @me
                    """, new { me = me.UserId, target });
            }
            catch (SqlException e) when (e.IsUniqueViolation()) { /* double click: already a favourite */ }
        }
        return await FavouritesResultAsync(c, s, me.UserId);
    });

    static Task<IResult> RemoveFavourite(Guid userId, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        await c.ExecuteAsync("""
            DELETE f FROM chat.TRN_ChatFavourite f JOIN auth.Users u ON u.UserId = f.FavouriteUserId WHERE f.UserId = @me AND u.PublicId = @userId
            """, new { me = me.UserId, userId });
        return await FavouritesResultAsync(c, s, me.UserId);
    });

    public sealed record OrderInput(Guid[]? Ids);

    /// <summary>Puts the listed favourites first, in that order; favourites not listed keep their order after them.</summary>
    static Task<IResult> OrderFavourites(OrderInput input, ChatServices s, HttpContext ctx) => Run(s, ctx, async (c, me) =>
    {
        var ids = (input.Ids ?? []).Distinct().ToArray();
        if (ids.Length > 100) return Invalid("ids", "Send at most 100 ids.");
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("UPDATE chat.TRN_ChatFavourite SET SortOrder = SortOrder + 1000 WHERE UserId = @me", new { me = me.UserId }, tx);
            for (var i = 0; i < ids.Length; i++)
                await c.ExecuteAsync("""
                    UPDATE f SET SortOrder = @i FROM chat.TRN_ChatFavourite f JOIN auth.Users u ON u.UserId = f.FavouriteUserId WHERE f.UserId = @me AND u.PublicId = @id
                    """, new { i, me = me.UserId, id = ids[i] }, tx);
            // Compact to 0..n-1 so the numbers stay small.
            await c.ExecuteAsync("""
                WITH o AS (SELECT SortOrder, ROW_NUMBER() OVER (ORDER BY SortOrder, FavouriteId) - 1 AS n FROM chat.TRN_ChatFavourite WHERE UserId = @me)
                UPDATE o SET SortOrder = n
                """, new { me = me.UserId }, tx);
            tx.Commit();
        }
        return await FavouritesResultAsync(c, s, me.UserId);
    });
}

/// <summary>
/// Sends due scheduled messages every Chat:ScheduledPollSeconds (CHAT and CHAT_ADVANCED on). Rows are claimed with one atomic UPDATE
/// (UPDLOCK + READPAST) so each is sent once even with two API instances; the message goes through the same code path as Send with
/// ClientMessageId = the scheduled row's PublicId, so a retry (a row stuck in SENDING for more than 5 minutes after a crash) can never
/// create a second message. With a switch off nothing happens: rows wait and are sent when it is switched back on.
/// </summary>
public sealed class ChatScheduledMessageWorker(Db db, IServiceScopeFactory scopes, ChatPush push, IClock clock, IOptions<ChatOptions> options,
    IMemoryCache cache, ILogger<ChatScheduledMessageWorker> log) : BackgroundService
{
    public static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, options.Value.ScheduledPollSeconds)), stoppingToken); }
            catch (OperationCanceledException) { return; }
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning(e, "Chat scheduled-message pass failed"); }
        }
    }

    sealed record Claimed(long ScheduledMessageId, long ConversationId, Guid ConversationPublicId, long SenderUserId, Guid PublicId, string Body, long? ReplyToMessageId);

    /// <summary>One pass; returns how many scheduled messages were handled (sent or failed).</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct = default)
    {
        using var c = await db.OpenAsync(ct);
        if (!await ChatAccess.EnabledAsync(c, cache) || !await ChatAdvancedEndpoints.AdvancedEnabledAsync(c, cache)) return 0;
        var now = clock.UtcNow;
        var ids = (await c.QueryAsync<long>("""
            UPDATE TOP (50) chat.TRN_ChatScheduledMessage WITH (UPDLOCK, READPAST, ROWLOCK)
            SET [State] = 'SENDING', UpdatedUtc = @now
            OUTPUT inserted.ScheduledMessageId
            WHERE ([State] = 'PENDING' AND SendAtUtc <= @now) OR ([State] = 'SENDING' AND UpdatedUtc < @stale)
            """, new { now, stale = now - StaleAfter })).ToList();
        if (ids.Count == 0) return 0;
        using var scope = scopes.CreateScope();
        var s = scope.ServiceProvider.GetRequiredService<ChatEndpoints.ChatServices>();
        var handled = 0;
        foreach (var id in ids.Order())
        {
            try { if (await SendOneAsync(c, s, id)) handled++; }
            // Left in SENDING: retried after StaleAfter, safely (the ClientMessageId makes the send idempotent).
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning(e, "Scheduled chat message {Id} could not be sent; it will be retried", id); }
        }
        return handled;
    }

    async Task<bool> SendOneAsync(IDbConnection c, ChatEndpoints.ChatServices s, long id)
    {
        var row = await c.QuerySingleOrDefaultAsync<Claimed>("""
            SELECT x.ScheduledMessageId, x.ConversationId, cv.PublicId AS ConversationPublicId, x.SenderUserId, x.PublicId, x.Body, x.ReplyToMessageId
            FROM chat.TRN_ChatScheduledMessage x JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = x.ConversationId
            WHERE x.ScheduledMessageId = @id AND x.[State] = 'SENDING'
            """, new { id });
        if (row is null) return false;
        string? failure = null;
        long? sentId = null;
        var me = await ChatAccess.LoadMeAsync(c, row.SenderUserId);
        if (me is null) failure = "You no longer have an active employee profile.";
        else if (await ChatAccess.MemberAsync(c, row.ConversationPublicId, me.UserId) is not { } m) failure = "You are no longer a member of this conversation.";
        else
        {
            Guid? replyId = null;
            if (row.ReplyToMessageId is { } rid)
            {
                replyId = await c.QuerySingleOrDefaultAsync<Guid?>(
                    "SELECT PublicId FROM chat.TRN_ChatMessage WHERE MessageId = @rid AND ConversationId = @cid AND MessageId > @visible AND Kind <> 'SYSTEM'",
                    new { rid, cid = m.ConversationId, visible = m.VisibleFrom });
                if (replyId is null) failure = "The message you replied to is no longer available.";
            }
            if (failure is null)
            {
                var result = await ChatEndpoints.InsertMessageAsync(c, s, me, m, "TEXT", row.Body, row.PublicId, replyId, false, null);
                if (result.Error is not null || result.Message is null) failure = "This colleague is no longer active, so the message could not be sent.";
                else sentId = result.Message.Seq;
            }
        }
        await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatScheduledMessage SET [State] = @state, SentMessageId = @sentId, FailureReason = @failure, UpdatedUtc = @now
            WHERE ScheduledMessageId = @id AND [State] = 'SENDING'
            """, new { state = failure is null ? "SENT" : "FAILED", sentId, failure, now = clock.UtcNow, id });
        if (await ChatAdvancedEndpoints.ScheduledByIdAsync(c, row.SenderUserId, id) is { } updated)
            await push.ToUsersAsync([row.SenderUserId], "scheduled.updated", ChatAdvancedEndpoints.ScheduledDto(updated));
        return true;
    }
}
