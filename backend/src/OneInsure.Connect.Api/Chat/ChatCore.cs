using System.Collections.Concurrent;
using System.Data;
using Dapper;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Caching.Memory;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Chat;

/// <summary>Chat settings (section "Chat"). Every value has a safe default; StorageRoot defaults to deploy\data\chat next to the API folder.</summary>
public sealed class ChatOptions
{
    /// <summary>Attachments root (outside the website). Empty: &lt;API folder&gt;\..\data\chat.</summary>
    public string StorageRoot { get; set; } = "";
    /// <summary>Scan every upload with Windows Defender before anyone can download it.</summary>
    public bool ScanEnabled { get; set; } = true;
    public string DefenderPath { get; set; } = @"C:\Program Files\Windows Defender\MpCmdRun.exe";
    public int ScanTimeoutSeconds { get; set; } = 120;
    public int ScanPollSeconds { get; set; } = 5;
    /// <summary>Upper bound for any attachment (approved decision D3: 25 MB); each file type may be lower (chat.MST_ChatFileType).</summary>
    public int MaxUploadMb { get; set; } = 25;
    /// <summary>Approved decision D5: edit own messages within 15 minutes, delete for everyone within 1 hour.</summary>
    public int EditWindowMinutes { get; set; } = 15;
    public int DeleteWindowMinutes { get; set; } = 60;
    public int MaxGroupMembers { get; set; } = 256;
    public int SendPermitPer10Seconds { get; set; } = 30;
    public int UploadPermitPerMinute { get; set; } = 20;
    public int SearchPermitPerMinute { get; set; } = 40;
    /// <summary>Approved decision D9: 0 = keep files; N = delete attachments older than N days (the message stays, marked removed).</summary>
    public int FileRetentionDays { get; set; } = 0;
    /// <summary>Audio calls (Phase 3): at most this many people connected in one call (approved decision D4: 10 until a load test).</summary>
    public int MaxCallParticipants { get; set; } = 10;
    /// <summary>How long a call rings before it counts as missed.</summary>
    public int RingSeconds { get; set; } = 45;
    /// <summary>Notes, tasks and reminders (Phase 4): how often the server looks for reminders that are due.</summary>
    public int ReminderPollSeconds { get; set; } = 15;
    /// <summary>Advanced chat (Phase 5): how often the server looks for scheduled messages that are due.</summary>
    public int ScheduledPollSeconds { get; set; } = 15;

    public string ResolvedStorageRoot() => Path.GetFullPath(string.IsNullOrWhiteSpace(StorageRoot)
        ? Path.Combine(AppContext.BaseDirectory, "..", "data", "chat")
        : StorageRoot);
}

/// <summary>The signed-in employee using Chat.</summary>
public sealed record ChatMe(long UserId, Guid Id, string Name);

/// <summary>Active membership of the caller in one conversation (the only way any conversation data is reached).</summary>
public sealed record ChatMembership(long ConversationId, Guid Id, string Type, string Role, long VisibleFrom, long LastRead, string? Name)
{
    public bool IsAdmin => Role == "ADMIN";
    public bool IsGroup => Type == "GROUP";
}

/// <summary>
/// Single place that answers "may this user see / act on this?". Every chat endpoint and hub method goes through it:
/// the feature switch, the chat.use permission (endpoint metadata), an active employee profile, and active membership of the
/// conversation. A conversation the caller is not in is reported as "not found" (its existence is not revealed).
/// </summary>
public static class ChatAccess
{
    public const string FeatureKey = "CHAT";
    public const string Permission = "chat.use";

    public static IResult Disabled() => Problems.Create(403, "FEATURE_DISABLED", "Chat is switched off by your administrator.");
    public static IResult NotEmployee() => Problems.Create(403, "FORBIDDEN", "Chat is available to employees with an active employee profile.");
    public static IResult NotFound() => Db_.NotFound("Conversation");

    /// <summary>The feature switch, cached for 10 s (the admin page change applies within seconds).</summary>
    public static async Task<bool> EnabledAsync(IDbConnection c, IMemoryCache cache)
    {
        if (cache.TryGetValue("chat:enabled", out bool on)) return on;
        on = (await RoomFeatureEndpoints.EnabledAsync(c)).Contains(FeatureKey);
        cache.Set("chat:enabled", on, TimeSpan.FromSeconds(10));
        return on;
    }

    public static Task<ChatMe?> LoadMeAsync(IDbConnection c, long userId) =>
        c.QuerySingleOrDefaultAsync<ChatMe>("""
            SELECT u.UserId, u.PublicId AS Id, e.DisplayName AS Name
            FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            WHERE u.UserId = @userId AND u.IsActive = 1
            """, new { userId });

    /// <summary>Feature on + employee profile. Returns the caller or the problem to answer with.</summary>
    public static async Task<(ChatMe? Me, IResult? Error)> MeAsync(IDbConnection c, HttpContext ctx, IMemoryCache cache)
    {
        if (!await EnabledAsync(c, cache)) return (null, Disabled());
        var me = await LoadMeAsync(c, ctx.User.UserId());
        return me is null ? (null, NotEmployee()) : (me, null);
    }

    public static Task<ChatMembership?> MemberAsync(IDbConnection c, Guid conversationId, long userId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<ChatMembership>("""
            SELECT c.ConversationId, c.PublicId AS Id, c.[Type], p.[Role], p.VisibleFromMessageId AS VisibleFrom, p.LastReadMessageId AS LastRead, c.[Name]
            FROM chat.TRN_ChatConversation c JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = c.ConversationId
            WHERE c.PublicId = @conversationId AND p.UserId = @userId AND p.LeftUtc IS NULL AND c.IsActive = 1
            """, new { conversationId, userId }, tx);

    public static async Task<List<long>> MemberUserIdsAsync(IDbConnection c, long conversationId, IDbTransaction? tx = null) =>
        (await c.QueryAsync<long>("SELECT UserId FROM chat.TRN_ChatConversationParticipant WHERE ConversationId = @conversationId AND LeftUtc IS NULL",
            new { conversationId }, tx)).ToList();

    /// <summary>Everyone who shares at least one conversation with the user (who sees their presence).</summary>
    public static async Task<List<long>> ContactUserIdsAsync(IDbConnection c, long userId) =>
        (await c.QueryAsync<long>("""
            SELECT DISTINCT o.UserId FROM chat.TRN_ChatConversationParticipant p
            JOIN chat.TRN_ChatConversationParticipant o ON o.ConversationId = p.ConversationId AND o.LeftUtc IS NULL AND o.UserId <> p.UserId
            WHERE p.UserId = @userId AND p.LeftUtc IS NULL
            """, new { userId })).ToList();

    /// <summary>Strips control characters (keeps line breaks), trims; null when empty.</summary>
    public static string? CleanText(string? s, bool multiline)
    {
        if (s is null) return null;
        var chars = s.Replace("\r\n", "\n").Where(ch => !char.IsControl(ch) || (multiline && ch == '\n') || ch == '\t').ToArray();
        var v = new string(chars).Replace('\t', ' ').Trim();
        if (!multiline) v = v.Replace('\n', ' ');
        return v.Length == 0 ? null : v;
    }

    /// <summary>An emoji reaction: 1-16 UTF-16 units, no letters, digits, punctuation, spaces or control characters.</summary>
    public static bool IsEmoji(string? s)
    {
        if (string.IsNullOrEmpty(s) || s.Length > 16) return false;
        var hasSymbol = false;
        for (var i = 0; i < s.Length; i++)
        {
            var ch = s[i];
            if (char.IsLetterOrDigit(ch) || char.IsWhiteSpace(ch) || char.IsControl(ch) || char.IsPunctuation(ch)) return false;
            var cat = char.GetUnicodeCategory(ch);
            if (cat is System.Globalization.UnicodeCategory.OtherSymbol or System.Globalization.UnicodeCategory.Surrogate) hasSymbol = true;
            else if (cat is not (System.Globalization.UnicodeCategory.NonSpacingMark or System.Globalization.UnicodeCategory.EnclosingMark
                     or System.Globalization.UnicodeCategory.Format or System.Globalization.UnicodeCategory.ModifierSymbol
                     or System.Globalization.UnicodeCategory.MathSymbol))
                return false;
        }
        return hasSymbol;
    }
}

/// <summary>Live push to people's open tabs (SignalR group "u:&lt;UserId&gt;" per person). A push never fails the request.</summary>
public sealed class ChatPush(IHubContext<ChatHub> hub, ILogger<ChatPush> log)
{
    public static string UserGroup(long userId) => $"u:{userId}";

    public async Task ToUsersAsync(IEnumerable<long> userIds, string evt, object payload)
    {
        var groups = userIds.Distinct().Select(UserGroup).ToList();
        if (groups.Count == 0) return;
        try { await hub.Clients.Groups(groups).SendAsync(evt, payload); }
        catch (Exception e) { log.LogWarning(e, "Chat push {Event} failed", evt); }
    }
}

/// <summary>Who is connected right now (one entry per open tab). In memory: the API runs as a single instance.</summary>
public sealed class PresenceTracker
{
    public sealed record Conn(string ConnectionId, long UserId, Guid SessionId, HubCallerContext Context);

    readonly ConcurrentDictionary<string, Conn> conns = new();
    readonly object gate = new();
    readonly Dictionary<long, int> perUser = [];

    /// <summary>True when this is the person's first open tab (they just came online).</summary>
    public bool Add(Conn c)
    {
        conns[c.ConnectionId] = c;
        lock (gate)
        {
            perUser.TryGetValue(c.UserId, out var n);
            perUser[c.UserId] = n + 1;
            return n == 0;
        }
    }

    /// <summary>True when that was the person's last open tab (they just went offline).</summary>
    public bool Remove(string connectionId, out long userId)
    {
        userId = 0;
        if (!conns.TryRemove(connectionId, out var c)) return false;
        userId = c.UserId;
        lock (gate)
        {
            if (!perUser.TryGetValue(c.UserId, out var n)) return false;
            if (n <= 1) { perUser.Remove(c.UserId); return true; }
            perUser[c.UserId] = n - 1;
            return false;
        }
    }

    public bool IsOnline(long userId) { lock (gate) return perUser.ContainsKey(userId); }
    public long[] OnlineUsers() { lock (gate) return [.. perUser.Keys]; }
    public ICollection<Conn> Connections => conns.Values;
}

public sealed record PresenceDto(string State, DateTime? LastSeenUtc);

/// <summary>
/// Presence as another person sees it: OFFLINE, or AVAILABLE / BUSY / DND / AWAY (their choice), or IN_MEETING while they are in a
/// live meeting room (from the attendance that LiveKit webhooks keep). Last seen only when both people allow it (decision D7).
/// </summary>
public sealed class PresenceService(PresenceTracker tracker)
{
    sealed record PrefRow(long UserId, string Availability, bool ShowLastSeen, DateTime? LastSeenUtc);

    public async Task<Dictionary<long, PresenceDto>> LoadAsync(IDbConnection c, IReadOnlyCollection<long> userIds, long viewerUserId)
    {
        var result = new Dictionary<long, PresenceDto>();
        if (userIds.Count == 0) return result;
        var ids = userIds.Distinct().ToArray();
        var prefs = (await c.QueryAsync<PrefRow>("""
            SELECT UserId, Availability, ShowLastSeen, LastSeenUtc FROM chat.MST_ChatUserPreference WHERE UserId IN @all
            """, new { all = ids.Append(viewerUserId).Distinct().ToArray() })).ToDictionary(p => p.UserId);
        var viewerShows = !prefs.TryGetValue(viewerUserId, out var vp) || vp.ShowLastSeen;
        var online = ids.Where(tracker.IsOnline).ToArray();
        var inMeeting = online.Length == 0 ? [] : (await c.QueryAsync<long>("""
            SELECT DISTINCT u.UserId FROM auth.Users u
            JOIN mtg.MeetingParticipants mp ON mp.EmployeeId = u.EmployeeId
            JOIN mtg.MeetingAttendance a ON a.ParticipantId = mp.ParticipantId AND a.LeftUtc IS NULL
            JOIN mtg.Meetings m ON m.MeetingId = mp.MeetingId AND m.[Status] = 'LIVE'
            WHERE u.UserId IN @online
            """, new { online })).ToHashSet();
        var inCall = online.Length == 0 ? [] : await InCallSafeAsync(c, online);
        foreach (var id in ids)
        {
            prefs.TryGetValue(id, out var p);
            // "Appear offline" (V034): everyone else sees plain Offline, with no last seen and no in-call / in-meeting.
            if (p?.Availability == "APPEAR_OFFLINE" && id != viewerUserId)
                result[id] = new PresenceDto("OFFLINE", null);
            else if (tracker.IsOnline(id))
                result[id] = new PresenceDto(inCall.Contains(id) ? "IN_CALL" : inMeeting.Contains(id) ? "IN_MEETING" : p?.Availability ?? "AVAILABLE", null);
            else
                result[id] = new PresenceDto("OFFLINE", viewerShows && (p?.ShowLastSeen ?? true) ? p?.LastSeenUtc : null);
        }
        return result;
    }

    /// <summary>What a presence push carries (viewer independent: last seen only if the person allows it; the client applies its own setting).</summary>
    public async Task<object> PushPayloadAsync(IDbConnection c, long userId, Guid publicId)
    {
        var p = await c.QuerySingleOrDefaultAsync<PrefRow>(
            "SELECT UserId, Availability, ShowLastSeen, LastSeenUtc FROM chat.MST_ChatUserPreference WHERE UserId = @userId", new { userId });
        var online = tracker.IsOnline(userId);
        if (p?.Availability == "APPEAR_OFFLINE") return new { userId = publicId, state = "OFFLINE", lastSeenUtc = (DateTime?)null };
        return new
        {
            userId = publicId,
            state = !online ? "OFFLINE" : (await InCallSafeAsync(c, [userId])).Count > 0 ? "IN_CALL" : p?.Availability ?? "AVAILABLE",
            lastSeenUtc = !online && (p?.ShowLastSeen ?? true) ? p?.LastSeenUtc : null,
        };
    }

    /// <summary>People in an audio call right now (empty on a database without the call tables).</summary>
    static async Task<HashSet<long>> InCallSafeAsync(IDbConnection c, long[] userIds)
    {
        try { return await ChatCallEndpoints.InCallAsync(c, userIds); }
        catch (Microsoft.Data.SqlClient.SqlException e) when (e.Number == 208) { return []; }
    }

    public static Task TouchLastSeenAsync(IDbConnection c, IEnumerable<long> userIds, DateTime now) =>
        c.ExecuteAsync("""
            MERGE chat.MST_ChatUserPreference WITH (HOLDLOCK) AS t
            USING (SELECT @id AS UserId) AS s ON t.UserId = s.UserId
            WHEN MATCHED THEN UPDATE SET LastSeenUtc = @now
            WHEN NOT MATCHED THEN INSERT (UserId, LastSeenUtc) VALUES (s.UserId, @now);
            """, userIds.Distinct().Select(id => new { id, now }));
}
