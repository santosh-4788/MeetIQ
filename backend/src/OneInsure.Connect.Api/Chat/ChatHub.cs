using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// The live channel for Chat (/api/v1/hubs/chat, WebSocket through the existing IIS /api rule). Signed in with the normal session
/// cookie; the negotiate request passes the normal CSRF check, and the connection itself must come from our own origin.
/// Every change of data goes through the REST endpoints (validation, rate limits, audit); the hub only carries pushes plus two
/// tiny client signals: typing and "delivered". A person's tabs share the group "u:&lt;UserId&gt;", so a removal from a conversation
/// takes effect at once (pushes go to the current member list, read from the database each time).
/// </summary>
[Authorize(AuthenticationSchemes = SessionClaims.Scheme)]
public sealed class ChatHub(Db db, IMemoryCache cache, PresenceTracker tracker, PresenceService presence, ChatPush push,
    IOptions<SecurityOptions> security, IClock clock, ILogger<ChatHub> log) : Hub
{
    public override async Task OnConnectedAsync()
    {
        var http = Context.GetHttpContext();
        var user = Context.User;
        if (http is null || user is null || !user.Can(ChatAccess.Permission) || !OriginAllowed(http))
        {
            Context.Abort();
            return;
        }
        using var c = await db.OpenAsync();
        if (!await ChatAccess.EnabledAsync(c, cache) || await ChatAccess.LoadMeAsync(c, user.UserId()) is not { } me)
        {
            Context.Abort();
            return;
        }
        await Groups.AddToGroupAsync(Context.ConnectionId, ChatPush.UserGroup(me.UserId));
        if (tracker.Add(new PresenceTracker.Conn(Context.ConnectionId, me.UserId, user.SessionId(), Context)))
            await AnnouncePresenceAsync(c, me);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (tracker.Remove(Context.ConnectionId, out var userId))
        {
            try
            {
                using var c = await db.OpenAsync();
                await PresenceService.TouchLastSeenAsync(c, [userId], clock.UtcNow);
                if (await ChatAccess.LoadMeAsync(c, userId) is { } me) await AnnouncePresenceAsync(c, me);
            }
            catch (Exception e) { log.LogWarning(e, "Chat presence update on disconnect failed"); }
        }
        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>"I am typing" in a conversation (the client sends it at most every 3 s while typing).</summary>
    public async Task Typing(string conversationId)
    {
        if (!Guid.TryParse(conversationId, out var cid)) return;
        var userId = Context.User!.UserId();
        var key = $"chat:typing:{userId}:{cid}";
        if (!cache.TryGetValue(key, out (long ConversationId, List<long> Others, string Name)? target))
        {
            using var c = await db.OpenAsync();
            if (await ChatAccess.MemberAsync(c, cid, userId) is not { } m || await ChatAccess.LoadMeAsync(c, userId) is not { } me) return;
            target = (m.ConversationId, (await ChatAccess.MemberUserIdsAsync(c, m.ConversationId)).Where(u => u != userId).ToList(), me.Name);
            cache.Set(key, target, TimeSpan.FromSeconds(30));
        }
        var t = target!.Value;
        await push.ToUsersAsync(t.Others, "typing", new { conversationId = cid, userId = await PublicIdAsync(userId), name = t.Name });
    }

    /// <summary>This tab has received messages up to <paramref name="seq"/> (the "delivered" tick for the senders).</summary>
    public async Task Delivered(string conversationId, long seq)
    {
        if (!Guid.TryParse(conversationId, out var cid) || seq <= 0) return;
        var userId = Context.User!.UserId();
        using var c = await db.OpenAsync();
        if (await ChatAccess.MemberAsync(c, cid, userId) is not { } m) return;
        var changed = await c.ExecuteAsync("""
            UPDATE chat.TRN_ChatConversationParticipant SET LastDeliveredMessageId = @seq
            WHERE ConversationId = @cid AND UserId = @userId AND LastDeliveredMessageId < @seq
              AND @seq <= (SELECT ISNULL(LastMessageId, 0) FROM chat.TRN_ChatConversation WHERE ConversationId = @cid)
            """, new { cid = m.ConversationId, userId, seq });
        if (changed > 0)
            await push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, m.ConversationId), "receipt",
                new { conversationId = cid, userId = await PublicIdAsync(userId), deliveredSeq = seq, readSeq = (long?)null });
    }

    async Task<Guid> PublicIdAsync(long userId)
    {
        var key = $"chat:pub:{userId}";
        if (cache.TryGetValue(key, out Guid id)) return id;
        using var c = await db.OpenAsync();
        id = await c.ExecuteScalarAsync<Guid>("SELECT PublicId FROM auth.Users WHERE UserId = @userId", new { userId });
        cache.Set(key, id, TimeSpan.FromHours(1));
        return id;
    }

    async Task AnnouncePresenceAsync(System.Data.IDbConnection c, ChatMe me)
    {
        var contacts = (await ChatAccess.ContactUserIdsAsync(c, me.UserId)).Where(tracker.IsOnline).ToList();
        if (contacts.Count == 0) return;
        await push.ToUsersAsync(contacts, "presence", await presence.PushPayloadAsync(c, me.UserId, me.Id));
    }

    bool OriginAllowed(HttpContext http)
    {
        var origin = http.Request.Headers.Origin.ToString();
        if (origin.Length == 0) return true; // non-browser clients send none; the session cookie is SameSite=Strict anyway
        var self = $"{http.Request.Scheme}://{http.Request.Host}";
        return string.Equals(origin, self, StringComparison.OrdinalIgnoreCase)
            || security.Value.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase);
    }
}

/// <summary>
/// Every 30 s: closes live connections whose session ended (sign-out, daily logout, disabled account), whose user no longer
/// holds chat.use (roles or per-user module access, V032), or when Chat is switched off, and records "last seen" for everyone online (so a server restart never leaves a stale time).
/// </summary>
public sealed class ChatPresenceSweeper(Db db, IMemoryCache cache, PresenceTracker tracker, DailyLogoutService daily, IClock clock,
    ILogger<ChatPresenceSweeper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken); }
            catch (OperationCanceledException) { return; }
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning(e, "Chat presence sweep failed"); }
        }
    }

    sealed record SessionRow(Guid SessionId, long UserId, DateTime CreatedUtc);

    public async Task RunOnceAsync(CancellationToken ct = default)
    {
        var conns = tracker.Connections.ToList();
        if (conns.Count == 0) return;
        using var c = await db.OpenAsync(ct);
        var now = clock.UtcNow;
        if (!await ChatAccess.EnabledAsync(c, cache))
        {
            foreach (var x in conns) x.Context.Abort();
            return;
        }
        var live = new Dictionary<Guid, SessionRow>();
        foreach (var chunk in conns.Select(x => x.SessionId).Distinct().Chunk(1000)) // SQL Server allows ~2100 parameters
            foreach (var s in await c.QueryAsync<SessionRow>("""
                SELECT s.SessionId, s.UserId, s.CreatedUtc FROM auth.UserSessions s JOIN auth.Users u ON u.UserId = s.UserId
                WHERE s.SessionId IN @ids AND s.RevokedUtc IS NULL AND s.ExpiresUtc > @now AND s.AbsoluteExpiryUtc > @now AND u.IsActive = 1 AND u.IsLocked = 0
                  AND EXISTS (SELECT 1 FROM auth.EffectivePermissions(s.UserId) ep WHERE ep.Code = 'chat.use')
                """, new { ids = chunk, now }))
                live[s.SessionId] = s;
        foreach (var x in conns)
        {
            var ok = live.TryGetValue(x.SessionId, out var s)
                && !(daily.EffectiveCutoffUtc(s.UserId, now) is { } cutoff && s.CreatedUtc < cutoff);
            if (!ok) x.Context.Abort();
        }
        await PresenceService.TouchLastSeenAsync(c, tracker.OnlineUsers(), now);
    }
}
