using System.Data;
using System.Security.Cryptography;
using Dapper;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// Audio calls from Chat (Phase 3, documentation/CHAT_MODULE_PHASE1.md section 10), on the existing self-hosted LiveKit server:
/// every call is its own audio-only room ("oic_call_…"); tokens allow the microphone only and are issued only to people invited
/// to that call. Ringing reaches every open tab of the invitee (SignalR call.incoming); accepting in one tab stops the others.
/// Busy people (in another call or a live meeting) are not rung. Calls are never recorded; only metadata is kept.
/// The meeting code is not touched: who is connected comes from LiveKit's participant list (ChatCallWorker, every 5 s),
/// not from the meeting webhook.
/// </summary>
public static class ChatCallEndpoints
{
    public const string FeatureKey = "CHAT_CALLS";
    public const string RoomPrefix = "oic_call_";
    public const string StartRateLimit = ChatEndpoints.SendRateLimit;

    public static string IdentityFor(Guid userPublicId) => $"call-u-{userPublicId:N}";

    public sealed class CallServices(Db db, IMemoryCache cache, ChatPush push, PresenceService presence, PresenceTracker tracker, IOptions<ChatOptions> options,
        IOptions<LiveKitOptions> livekit, LiveKitTokens tokens, LiveKitRoomService rooms, IClock clock)
    {
        public Db Db => db;
        public IMemoryCache Cache => cache;
        public ChatPush Push => push;
        public PresenceService Presence => presence;
        public PresenceTracker Tracker => tracker;
        public ChatOptions Options => options.Value;
        public LiveKitOptions LiveKit => livekit.Value;
        public LiveKitTokens Tokens => tokens;
        public LiveKitRoomService Rooms => rooms;
        public IClock Clock => clock;
    }

    public static RouteGroupBuilder MapChatCallEndpoints(this RouteGroupBuilder api)
    {
        // chat.calls (V032): per-user module access can switch audio calls off for one person.
        var g = api.MapGroup("/chat/calls").RequirePermission(ChatAccess.Permission).RequirePermission(ModuleAccess.CallsPermission);
        g.MapGet("", History);
        g.MapGet("/current", Current);
        g.MapPost("", Start).RequireRateLimiting(StartRateLimit);
        g.MapPost("/{id:guid}/accept", Accept);
        g.MapPost("/{id:guid}/decline", Decline);
        g.MapPost("/{id:guid}/leave", Leave);
        g.MapPost("/{id:guid}/end", End);
        g.MapPost("/{id:guid}/invite", Invite).RequireRateLimiting(StartRateLimit);
        g.MapPost("/{id:guid}/token", Token);
        return api;
    }

    static IResult CallsDisabled() => Problems.Create(403, "FEATURE_DISABLED", "Audio calls are switched off by your administrator.");

    /// <summary>Chat on, calls on, LiveKit configured, employee profile. Returns the caller or the problem to answer with.</summary>
    static async Task<(ChatMe? Me, IResult? Error)> MeAsync(IDbConnection c, CallServices s, HttpContext ctx)
    {
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return (null, error);
        if (!await CallsEnabledAsync(c, s.Cache)) return (null, CallsDisabled());
        if (!s.LiveKit.IsConfigured) return (null, RoomEndpoints.Unavailable("Audio calls are not available: the video service is not configured on this server."));
        return (me, null);
    }

    public static async Task<bool> CallsEnabledAsync(IDbConnection c, IMemoryCache cache)
    {
        if (cache.TryGetValue("chat:calls-enabled", out bool on)) return on;
        on = (await RoomFeatureEndpoints.EnabledAsync(c)).Contains(FeatureKey);
        cache.Set("chat:calls-enabled", on, TimeSpan.FromSeconds(10));
        return on;
    }

    // ---- Data -------------------------------------------------------------------------------------------------------------

    public sealed record CallRow(long CallId, Guid Id, long? ConversationId, Guid? ConversationPublicId, string? ConversationName, string ConversationType,
        string Type, long StartedByUserId, string LiveKitRoomName, string Status, DateTime CreatedUtc, DateTime? AnsweredUtc, DateTime? EndedUtc, string? EndReason);

    public sealed record PartRow(long CallId, long UserId, Guid Id, string Name, string? Code, string State, DateTime InvitedUtc, DateTime? AnsweredUtc,
        DateTime? JoinedUtc, DateTime? LastConnectedUtc, DateTime? LeftUtc, long? InvitedByUserId);

    const string CallSelect = """
        SELECT cl.CallId, cl.PublicId AS Id, cl.ConversationId, cv.PublicId AS ConversationPublicId, cv.[Name] AS ConversationName, ISNULL(cv.[Type], 'GROUP') AS ConversationType,
               cl.[Type], cl.StartedByUserId, cl.LiveKitRoomName, cl.[Status], cl.CreatedUtc, cl.AnsweredUtc, cl.EndedUtc, cl.EndReason
        FROM chat.TRN_ChatCall cl LEFT JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = cl.ConversationId
        """;

    const string PartSelect = """
        SELECT p.CallId, p.UserId, u.PublicId AS Id, e.DisplayName AS Name, e.EmployeeCode AS Code, p.[State], p.InvitedUtc, p.AnsweredUtc, p.JoinedUtc,
               p.LastConnectedUtc, p.LeftUtc, p.InvitedByUserId
        FROM chat.TRN_ChatCallParticipant p JOIN auth.Users u ON u.UserId = p.UserId JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
        """;

    internal static Task<CallRow?> LoadCallAsync(IDbConnection c, long callId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<CallRow>($"{CallSelect} WHERE cl.CallId = @callId", new { callId }, tx);

    internal static async Task<List<PartRow>> LoadPartsAsync(IDbConnection c, long callId, IDbTransaction? tx = null) =>
        (await c.QueryAsync<PartRow>($"{PartSelect} WHERE p.CallId = @callId ORDER BY p.InvitedUtc, e.DisplayName", new { callId }, tx)).ToList();

    /// <summary>The call as everyone in it sees it (viewer independent; the website finds itself by its user id).</summary>
    internal static object Dto(CallRow call, List<PartRow> parts, DateTime now) => new
    {
        id = call.Id,
        type = call.Type,
        status = call.Status,
        conversationId = call.ConversationPublicId,
        conversationType = call.ConversationType,
        title = call.Type == "GROUP" || call.ConversationType == "GROUP" ? call.ConversationName ?? "Group call" : null,
        startedBy = parts.Where(p => p.UserId == call.StartedByUserId).Select(p => new { id = p.Id, name = p.Name, code = p.Code }).FirstOrDefault(),
        createdUtc = call.CreatedUtc,
        answeredUtc = call.AnsweredUtc,
        endedUtc = call.EndedUtc,
        endReason = call.EndReason,
        serverUtc = now,
        participants = parts.Select(p => new
        {
            id = p.Id, name = p.Name, code = p.Code, state = p.State, invitedUtc = p.InvitedUtc, answeredUtc = p.AnsweredUtc, leftUtc = p.LeftUtc,
            connected = p.State == "ACCEPTED" && p.LastConnectedUtc is { } lc && now - lc < TimeSpan.FromSeconds(20),
        }),
    };

    static object Connection(CallServices s, CallRow call, ChatMe me)
    {
        var (token, exp) = s.Tokens.CreateParticipantToken(new ParticipantGrant(call.LiveKitRoomName, IdentityFor(me.Id), me.Name,
            System.Text.Json.JsonSerializer.Serialize(new { type = "CALL", userId = me.Id }), CanPublish: true, CanScreenShare: false, RoomAdmin: false, CanPublishCamera: false),
            s.Clock.UtcNow);
        return new { url = s.LiveKit.PublicUrl, token, identity = IdentityFor(me.Id), expiresUtc = exp };
    }

    /// <summary>People who are in an open call right now (accepted, not left).</summary>
    internal static async Task<HashSet<long>> InCallAsync(IDbConnection c, IEnumerable<long> userIds, IDbTransaction? tx = null)
    {
        var ids = userIds.Distinct().ToArray();
        if (ids.Length == 0) return [];
        return (await c.QueryAsync<long>("""
            SELECT DISTINCT p.UserId FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall cl ON cl.CallId = p.CallId AND cl.[Status] IN ('RINGING', 'ACTIVE')
            WHERE p.UserId IN @ids AND p.[State] = 'ACCEPTED' AND p.LeftUtc IS NULL
            """, new { ids }, tx)).ToHashSet();
    }

    static async Task<HashSet<long>> InMeetingAsync(IDbConnection c, IEnumerable<long> userIds, IDbTransaction? tx = null)
    {
        var ids = userIds.Distinct().ToArray();
        if (ids.Length == 0) return [];
        return (await c.QueryAsync<long>("""
            SELECT DISTINCT u.UserId FROM auth.Users u
            JOIN mtg.MeetingParticipants mp ON mp.EmployeeId = u.EmployeeId
            JOIN mtg.MeetingAttendance a ON a.ParticipantId = mp.ParticipantId AND a.LeftUtc IS NULL
            JOIN mtg.Meetings m ON m.MeetingId = mp.MeetingId AND m.[Status] = 'LIVE'
            WHERE u.UserId IN @ids
            """, new { ids }, tx)).ToHashSet();
    }

    sealed record MyPart(long CallId, string State, string Status, long StartedByUserId, string Type);

    static Task<MyPart?> MyPartAsync(IDbConnection c, Guid callId, long userId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<MyPart>("""
            SELECT cl.CallId, p.[State], cl.[Status], cl.StartedByUserId, cl.[Type] FROM chat.TRN_ChatCall cl
            JOIN chat.TRN_ChatCallParticipant p ON p.CallId = cl.CallId AND p.UserId = @userId WHERE cl.PublicId = @callId
            """, new { callId, userId }, tx);

    static IResult NotFound() => Db_.NotFound("Call");

    sealed record Callee(long UserId, Guid Id, string Name);

    static Task<IEnumerable<Callee>> CalleesAsync(IDbConnection c, IEnumerable<long> userIds) =>
        c.QueryAsync<Callee>("""
            SELECT u.UserId, u.PublicId AS Id, e.DisplayName AS Name FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId IN @ids
            """, new { ids = userIds.Distinct().DefaultIfEmpty(0L).ToArray() });

    /// <summary>
    /// Splits invitees into people who can receive audio calls (chat.calls, effective) and people who cannot (never rung).
    /// Error = 409 CALLS_NOT_AVAILABLE when nobody can.
    /// </summary>
    static async Task<(List<long> Callable, List<Callee> Skipped, IResult? Error)> CallableAsync(IDbConnection c, List<long> invitees)
    {
        var can = await ModuleAccess.WhoHasAsync(c, invitees, ModuleAccess.CallsPermission);
        var callable = invitees.Where(can.Contains).ToList();
        List<Callee> skipped = invitees.Count == callable.Count ? [] : (await CalleesAsync(c, invitees.Where(u => !can.Contains(u)))).OrderBy(x => x.Name).ToList();
        if (callable.Count > 0) return (callable, skipped, null);
        var detail = skipped.Count == 1 ? $"{skipped[0].Name} cannot receive audio calls." : "None of these colleagues can receive audio calls.";
        return (callable, skipped, Problems.Create(409, "CALLS_NOT_AVAILABLE", detail));
    }

    static object SkippedDto(List<Callee> skipped) => skipped.Select(x => new { id = x.Id, name = x.Name }).ToArray();

    internal static async Task PushCallAsync(IDbConnection c, ChatPush push, IClock clock, long callId, string evt = "call.updated", IEnumerable<long>? onlyTo = null)
    {
        var call = await LoadCallAsync(c, callId);
        if (call is null) return;
        var parts = await LoadPartsAsync(c, callId);
        await push.ToUsersAsync(onlyTo ?? parts.Select(p => p.UserId), evt, Dto(call, parts, clock.UtcNow));
    }

    static async Task PushPresenceAsync(IDbConnection c, CallServices s, IEnumerable<long> userIds)
    {
        foreach (var u in userIds.Distinct())
        {
            var me = await ChatAccess.LoadMeAsync(c, u);
            if (me is null) continue;
            var contacts = (await ChatAccess.ContactUserIdsAsync(c, u)).Where(s.Tracker.IsOnline).ToList();
            if (contacts.Count > 0) await s.Push.ToUsersAsync(contacts, "presence", await s.Presence.PushPayloadAsync(c, u, me.Id));
        }
    }

    // ---- Endpoints --------------------------------------------------------------------------------------------------------

    public sealed record StartInput(Guid ConversationId);

    static async Task<IResult> Start(StartInput input, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, input.ConversationId, me.UserId) is not { } m) return ChatAccess.NotFound();
        if ((await InCallAsync(c, [me.UserId])).Count > 0) return Db_.Conflict("You are already in a call. Leave it first.");
        var members = (await c.QueryAsync<long>("""
            SELECT p.UserId FROM chat.TRN_ChatConversationParticipant p JOIN auth.Users u ON u.UserId = p.UserId AND u.IsActive = 1
            JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            WHERE p.ConversationId = @cid AND p.LeftUtc IS NULL AND p.UserId <> @me
            """, new { cid = m.ConversationId, me = me.UserId })).ToList();
        if (members.Count == 0) return Db_.Conflict(m.IsGroup ? "There is nobody else in this group to call." : "This colleague is no longer active, so they cannot be called.");
        // People without chat.calls (V032 per-user module access) are never rung.
        var (callable, skipped, notAvailable) = await CallableAsync(c, members);
        if (notAvailable is not null) return notAvailable;
        members = callable;

        var busy = new HashSet<long>(await InCallAsync(c, members));
        busy.UnionWith(await InMeetingAsync(c, members));
        var room = RoomPrefix + Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
        try { await s.Rooms.EnsureRoomAsync(room, ctx.RequestAborted); }
        catch (LiveKitUnavailableException e) { return RoomEndpoints.Unavailable(e.Message); }

        var now = s.Clock.UtcNow;
        long callId;
        using (var tx = c.BeginTransaction())
        {
            callId = await c.QuerySingleAsync<long>("""
                INSERT chat.TRN_ChatCall (ConversationId, [Type], StartedByUserId, LiveKitRoomName) OUTPUT inserted.CallId VALUES (@cid, @type, @me, @room)
                """, new { cid = m.ConversationId, type = m.IsGroup ? "GROUP" : "DIRECT", me = me.UserId, room }, tx);
            await c.ExecuteAsync("INSERT chat.TRN_ChatCallParticipant (CallId, UserId, [State], AnsweredUtc) VALUES (@callId, @me, 'ACCEPTED', @now)",
                new { callId, me = me.UserId, now }, tx);
            await c.ExecuteAsync("INSERT chat.TRN_ChatCallParticipant (CallId, UserId, InvitedByUserId, [State]) VALUES (@callId, @u, @me, @state)",
                members.Select(u => new { callId, u, me = me.UserId, state = busy.Contains(u) ? "BUSY" : "RINGING" }), tx);
            var publicId = await c.ExecuteScalarAsync<Guid>("SELECT PublicId FROM chat.TRN_ChatCall WHERE CallId = @callId", new { callId }, tx);
            await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_CALL_STARTED", "ChatCall", publicId.ToString(), m.IsGroup ? "Group audio call started" : "Audio call started",
                ClientInfo.From(ctx).Ip, tx, newValues: new { invited = members.Count, busy = busy.Count });
            tx.Commit();
        }
        await NotifyMissedAsync(c, s.Push, callId, busy, me.Name);
        await RecomputeAsync(c, s.Push, s.Rooms, s.Clock, callId);
        var call = (await LoadCallAsync(c, callId))!;
        var parts = await LoadPartsAsync(c, callId);
        var dto = Dto(call, parts, s.Clock.UtcNow);
        await s.Push.ToUsersAsync(parts.Where(p => p.State == "RINGING").Select(p => p.UserId), "call.incoming", dto);
        await s.Push.ToUsersAsync([me.UserId], "call.updated", dto);
        await PushPresenceAsync(c, s, [me.UserId]);
        return Results.Ok(new { call = dto, connection = call.Status is "RINGING" or "ACTIVE" ? Connection(s, call, me) : null, skipped = SkippedDto(skipped) });
    }

    static async Task<IResult> Accept(Guid id, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        var mine = await MyPartAsync(c, id, me.UserId);
        if (mine is null) return NotFound();
        if (mine.Status is not ("RINGING" or "ACTIVE")) return Db_.Conflict("This call has ended.");
        if (mine.State == "ACCEPTED") return await WithConnection(c, s, mine.CallId, me);
        // Ringing: answer. Missed / declined / left a call that is still going on: join it.
        if (mine.State is not ("RINGING" or "MISSED" or "DECLINED" or "LEFT" or "BUSY") || (mine.State != "RINGING" && mine.Status != "ACTIVE"))
            return Db_.Conflict("You cannot join this call.");
        if ((await InCallAsync(c, [me.UserId])).Count > 0) return Db_.Conflict("You are already in another call. Leave it first.");
        using (var tx = c.BeginTransaction())
        {
            var connected = await c.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM chat.TRN_ChatCallParticipant WITH (UPDLOCK, HOLDLOCK) WHERE CallId = @id AND [State] = 'ACCEPTED' AND LeftUtc IS NULL", new { id = mine.CallId }, tx);
            if (connected >= s.Options.MaxCallParticipants)
            {
                tx.Rollback();
                return Db_.Conflict($"This call is full ({s.Options.MaxCallParticipants} people).");
            }
            var now = s.Clock.UtcNow;
            await c.ExecuteAsync("""
                UPDATE chat.TRN_ChatCallParticipant SET [State] = 'ACCEPTED', AnsweredUtc = @now, LeftUtc = NULL, LastConnectedUtc = NULL WHERE CallId = @id AND UserId = @me;
                UPDATE chat.TRN_ChatCall SET [Status] = 'ACTIVE', AnsweredUtc = COALESCE(AnsweredUtc, @now) WHERE CallId = @id AND [Status] IN ('RINGING', 'ACTIVE');
                """, new { id = mine.CallId, me = me.UserId, now }, tx);
            await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_CALL_ACCEPTED", "ChatCall", id.ToString(), mine.State == "RINGING" ? "Audio call answered" : "Joined an audio call",
                ClientInfo.From(ctx).Ip, tx);
            tx.Commit();
        }
        await PushCallAsync(c, s.Push, s.Clock, mine.CallId);
        await PushPresenceAsync(c, s, [me.UserId]);
        return await WithConnection(c, s, mine.CallId, me);
    }

    static async Task<IResult> WithConnection(IDbConnection c, CallServices s, long callId, ChatMe me)
    {
        var call = (await LoadCallAsync(c, callId))!;
        return Results.Ok(new { call = Dto(call, await LoadPartsAsync(c, callId), s.Clock.UtcNow), connection = Connection(s, call, me) });
    }

    static async Task<IResult> Decline(Guid id, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        var mine = await MyPartAsync(c, id, me.UserId);
        if (mine is null) return NotFound();
        if (mine.State == "RINGING")
        {
            await c.ExecuteAsync("UPDATE chat.TRN_ChatCallParticipant SET [State] = 'DECLINED', AnsweredUtc = @now WHERE CallId = @id AND UserId = @me AND [State] = 'RINGING'",
                new { id = mine.CallId, me = me.UserId, now = s.Clock.UtcNow });
            await RecomputeAsync(c, s.Push, s.Rooms, s.Clock, mine.CallId);
            await PushCallAsync(c, s.Push, s.Clock, mine.CallId);
        }
        return Results.NoContent();
    }

    static async Task<IResult> Leave(Guid id, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        var mine = await MyPartAsync(c, id, me.UserId);
        if (mine is null) return NotFound();
        if (mine.State == "ACCEPTED")
        {
            await MarkLeftAsync(c, s.Rooms, mine.CallId, me.UserId, me.Id, s.Clock.UtcNow);
            await RecomputeAsync(c, s.Push, s.Rooms, s.Clock, mine.CallId);
            await PushCallAsync(c, s.Push, s.Clock, mine.CallId);
            await PushPresenceAsync(c, s, [me.UserId]);
        }
        return Results.NoContent();
    }

    internal static async Task MarkLeftAsync(IDbConnection c, LiveKitRoomService rooms, long callId, long userId, Guid userPublicId, DateTime now)
    {
        var room = await c.ExecuteScalarAsync<string>("SELECT LiveKitRoomName FROM chat.TRN_ChatCall WHERE CallId = @callId", new { callId });
        await c.ExecuteAsync("UPDATE chat.TRN_ChatCallParticipant SET [State] = 'LEFT', LeftUtc = @now WHERE CallId = @callId AND UserId = @userId AND [State] = 'ACCEPTED'",
            new { callId, userId, now });
        try { await rooms.RemoveParticipantAsync(room!, IdentityFor(userPublicId), CancellationToken.None); } catch (LiveKitUnavailableException) { }
    }

    /// <summary>End for everyone: anyone in a direct call; in a group call the person who started it (others simply leave).</summary>
    static async Task<IResult> End(Guid id, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        var mine = await MyPartAsync(c, id, me.UserId);
        if (mine is null) return NotFound();
        if (mine.Status is not ("RINGING" or "ACTIVE")) return Results.NoContent();
        if (mine.Type == "GROUP" && mine.StartedByUserId != me.UserId)
            return Problems.Create(403, "FORBIDDEN", "Only the person who started the group call can end it for everyone. Use Leave instead.");
        await FinishAsync(c, s.Push, s.Rooms, s.Clock, mine.CallId, mine.Status == "RINGING" ? "CANCELLED_BY_CALLER" : "ENDED_BY_USER");
        await PushPresenceAsync(c, s, (await LoadPartsAsync(c, mine.CallId)).Select(p => p.UserId));
        return Results.NoContent();
    }

    public sealed record InviteInput(Guid[]? UserIds);

    static async Task<IResult> Invite(Guid id, InviteInput input, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        var mine = await MyPartAsync(c, id, me.UserId);
        if (mine is null) return NotFound();
        if (mine.State != "ACCEPTED" || mine.Status is not ("RINGING" or "ACTIVE")) return Db_.Conflict("Join the call before adding people.");
        var wanted = (input.UserIds ?? []).Distinct().Take(20).ToArray();
        if (wanted.Length == 0) { var v = new Validator(); v.Add("userIds", "Choose who to add."); return v.Problem(); }
        var users = (await c.QueryAsync<long>("""
            SELECT u.UserId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1 WHERE u.PublicId IN @wanted AND u.IsActive = 1
            """, new { wanted })).ToList();
        if (users.Count != wanted.Length) return Db_.NotFound("One or more employees");
        var parts = await LoadPartsAsync(c, mine.CallId);
        var adding = users.Where(u => !parts.Any(p => p.UserId == u && p.State is "ACCEPTED" or "RINGING")).ToList();
        if (adding.Count == 0) return Db_.Conflict("They are already in the call or being called.");
        // People without chat.calls (V032 per-user module access) are never rung.
        var (callable, skipped, notAvailable) = await CallableAsync(c, adding);
        if (notAvailable is not null) return notAvailable;
        adding = callable;
        var open =parts.Count(p => p.State is "ACCEPTED" or "RINGING");
        if (open + adding.Count > s.Options.MaxCallParticipants) return Db_.Conflict($"A call can have at most {s.Options.MaxCallParticipants} people.");
        var busy = new HashSet<long>(await InCallAsync(c, adding));
        busy.UnionWith(await InMeetingAsync(c, adding));
        using (var tx = c.BeginTransaction())
        {
            await c.ExecuteAsync("""
                MERGE chat.TRN_ChatCallParticipant AS t
                USING (SELECT @callId AS CallId, @u AS UserId) AS x ON t.CallId = x.CallId AND t.UserId = x.UserId
                WHEN MATCHED THEN UPDATE SET [State] = @state, InvitedByUserId = @me, InvitedUtc = SYSUTCDATETIME(), AnsweredUtc = NULL, LeftUtc = NULL, LastConnectedUtc = NULL
                WHEN NOT MATCHED THEN INSERT (CallId, UserId, InvitedByUserId, [State]) VALUES (@callId, @u, @me, @state);
                """, adding.Select(u => new { callId = mine.CallId, u, me = me.UserId, state = busy.Contains(u) ? "BUSY" : "RINGING" }), tx);
            await c.ExecuteAsync("UPDATE chat.TRN_ChatCall SET [Type] = 'GROUP' WHERE CallId = @id", new { id = mine.CallId }, tx);
            await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_CALL_INVITED", "ChatCall", id.ToString(), $"{adding.Count} person(s) added to an audio call",
                ClientInfo.From(ctx).Ip, tx, newValues: new { added = adding.Count, busy = busy.Count });
            tx.Commit();
        }
        await NotifyMissedAsync(c, s.Push, mine.CallId, busy, me.Name);
        var call = (await LoadCallAsync(c, mine.CallId))!;
        var all = await LoadPartsAsync(c, mine.CallId);
        var dto = Dto(call, all, s.Clock.UtcNow);
        await s.Push.ToUsersAsync(adding.Where(u => !busy.Contains(u)), "call.incoming", dto);
        await s.Push.ToUsersAsync(all.Select(p => p.UserId), "call.updated", dto);
        // The call as before, plus skipped (V032): invitees who cannot receive audio calls and were not rung.
        var result = dto.GetType().GetProperties().ToDictionary(p => p.Name, p => p.GetValue(dto));
        result["skipped"] = SkippedDto(skipped);
        return Results.Ok(result);
    }

    static async Task<IResult> Token(Guid id, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await MeAsync(c, s, ctx);
        if (me is null) return error!;
        var mine = await MyPartAsync(c, id, me.UserId);
        if (mine is null) return NotFound();
        if (mine.State != "ACCEPTED" || mine.Status is not ("RINGING" or "ACTIVE")) return Db_.Conflict("This call has ended.");
        return await WithConnection(c, s, mine.CallId, me);
    }

    /// <summary>The call I am in or being rung for (after a page reload).</summary>
    static async Task<IResult> Current(CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (!await CallsEnabledAsync(c, s.Cache)) return Results.Ok(new { enabled = false, maxParticipants = s.Options.MaxCallParticipants });
        var open = (await c.QueryAsync<long>("""
            SELECT cl.CallId FROM chat.TRN_ChatCall cl JOIN chat.TRN_ChatCallParticipant p ON p.CallId = cl.CallId AND p.UserId = @me
            WHERE cl.[Status] IN ('RINGING', 'ACTIVE') AND (p.[State] = 'RINGING' OR (p.[State] = 'ACCEPTED' AND p.LeftUtc IS NULL))
            ORDER BY cl.CallId DESC
            """, new { me = me.UserId })).ToList();
        var calls = new List<object>();
        foreach (var id in open)
            if (await LoadCallAsync(c, id) is { } call) calls.Add(Dto(call, await LoadPartsAsync(c, id), s.Clock.UtcNow));
        return Results.Ok(new { enabled = s.LiveKit.IsConfigured, maxParticipants = s.Options.MaxCallParticipants, calls });
    }

    /// <summary>Call history (newest first, 40 per page; ?beforeId= for more, ?search= by name).</summary>
    static async Task<IResult> History(Guid? beforeId, string? search, CallServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        long? before = beforeId is { } b ? await c.ExecuteScalarAsync<long?>("SELECT CallId FROM chat.TRN_ChatCall WHERE PublicId = @b", new { b }) : null;
        var term = string.IsNullOrWhiteSpace(search) ? null : "%" + search.Trim()[..Math.Min(search.Trim().Length, 80)].Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";
        var ids = (await c.QueryAsync<long>("""
            SELECT TOP (41) cl.CallId FROM chat.TRN_ChatCall cl
            JOIN chat.TRN_ChatCallParticipant mine ON mine.CallId = cl.CallId AND mine.UserId = @me
            LEFT JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = cl.ConversationId
            WHERE (@before IS NULL OR cl.CallId < @before)
              AND (@term IS NULL OR cv.[Name] LIKE @term OR EXISTS (
                    SELECT 1 FROM chat.TRN_ChatCallParticipant o JOIN auth.Users u ON u.UserId = o.UserId JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
                    WHERE o.CallId = cl.CallId AND o.UserId <> @me AND (e.DisplayName LIKE @term OR e.EmployeeCode LIKE @term)))
            ORDER BY cl.CallId DESC
            """, new { me = me.UserId, before, term })).ToList();
        var items = new List<object>();
        var now = s.Clock.UtcNow;
        foreach (var id in ids.Take(40))
            if (await LoadCallAsync(c, id) is { } call) items.Add(Dto(call, await LoadPartsAsync(c, id), now));
        return Results.Ok(new { items, hasMore = ids.Count > 40 });
    }

    // ---- Lifecycle --------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Settles the call after any change: a ringing call with nobody left to answer ends (missed / declined / busy); an active
    /// call with fewer than two people connected and nobody ringing ends.
    /// </summary>
    internal static async Task RecomputeAsync(IDbConnection c, ChatPush push, LiveKitRoomService rooms, IClock clock, long callId)
    {
        var call = await LoadCallAsync(c, callId);
        if (call is null || call.Status is not ("RINGING" or "ACTIVE")) return;
        var parts = await LoadPartsAsync(c, callId);
        var ringing = parts.Count(p => p.State == "RINGING");
        var accepted = parts.Count(p => p.State == "ACCEPTED" && p.LeftUtc is null);
        if (call.Status == "RINGING" && ringing == 0 && accepted <= 1)
        {
            var others = parts.Where(p => p.UserId != call.StartedByUserId).ToList();
            var reason = others.All(p => p.State == "BUSY") ? "BUSY" : others.Any(p => p.State == "DECLINED") && others.All(p => p.State is "DECLINED" or "BUSY") ? "DECLINED" : "NO_ANSWER";
            await FinishAsync(c, push, rooms, clock, callId, reason);
        }
        else if (call.Status == "ACTIVE" && accepted <= 1 && ringing == 0)
            await FinishAsync(c, push, rooms, clock, callId, "EVERYONE_LEFT");
    }

    /// <summary>Ends a call: status, everyone's state, the audio room, a line in the conversation, missed-call notifications, push.</summary>
    internal static async Task FinishAsync(IDbConnection c, ChatPush push, LiveKitRoomService rooms, IClock clock, long callId, string reason)
    {
        var now = clock.UtcNow;
        CallRow? call;
        List<long> missed;
        using (var tx = c.BeginTransaction())
        {
            call = await LoadCallAsync(c, callId, tx);
            if (call is null || call.Status is not ("RINGING" or "ACTIVE")) { tx.Rollback(); return; }
            var status = call.AnsweredUtc is not null ? "ENDED" : reason == "DECLINED" ? "DECLINED" : reason == "FAILED" ? "FAILED" : "MISSED";
            var changed = await c.ExecuteAsync("UPDATE chat.TRN_ChatCall SET [Status] = @status, EndedUtc = @now, EndReason = @reason WHERE CallId = @callId AND [Status] IN ('RINGING', 'ACTIVE')",
                new { status, now, reason, callId }, tx);
            if (changed == 0) { tx.Rollback(); return; }
            missed = (await c.QueryAsync<long>(
                "UPDATE chat.TRN_ChatCallParticipant SET [State] = 'MISSED' OUTPUT inserted.UserId WHERE CallId = @callId AND [State] = 'RINGING'", new { callId }, tx)).ToList();
            await c.ExecuteAsync("UPDATE chat.TRN_ChatCallParticipant SET [State] = 'LEFT', LeftUtc = @now WHERE CallId = @callId AND [State] = 'ACCEPTED' AND LeftUtc IS NULL",
                new { callId, now }, tx);
            if (call.ConversationId is { } cid)
            {
                var starter = await c.ExecuteScalarAsync<string>("SELECT e.DisplayName FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @u",
                    new { u = call.StartedByUserId }, tx);
                var kind = call.Type == "GROUP" ? "Group audio call" : "Audio call";
                var line = status switch
                {
                    "ENDED" => $"📞 {kind} · {Duration(now - call.AnsweredUtc!.Value)}",
                    "DECLINED" => $"📞 {kind} from {starter} declined",
                    _ => reason == "BUSY" ? $"📞 {kind} from {starter} not answered (busy)" : $"📞 Missed {kind.ToLowerInvariant()} from {starter}",
                };
                await ChatEndpoints.SystemMessageAsync(c, tx, cid, line);
            }
            await Audit.WriteAsync(c, "SYSTEM", null, "CHAT_CALL_ENDED", "ChatCall", call.Id.ToString(), $"Audio call {status.ToLowerInvariant()} ({reason})", null, tx,
                newValues: new { status, reason, seconds = call.AnsweredUtc is { } a ? (int)(now - a).TotalSeconds : 0 });
            tx.Commit();
        }
        var starterName = await c.ExecuteScalarAsync<string>("SELECT e.DisplayName FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @u", new { u = call.StartedByUserId });
        await NotifyMissedAsync(c, push, callId, missed, starterName ?? "a colleague");
        if (call.ConversationId is { } conv)
            await push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, conv), "message.new",
                await ChatEndpoints.LoadMessageAsync(c, await c.ExecuteScalarAsync<long>("SELECT LastMessageId FROM chat.TRN_ChatConversation WHERE ConversationId = @conv", new { conv })));
        await PushCallAsync(c, push, clock, callId, "call.ended");
        // Closed after the push, so browsers learn why the call ended before their audio connection drops.
        try { await rooms.DeleteRoomAsync(call.LiveKitRoomName, CancellationToken.None); } catch (LiveKitUnavailableException) { }
    }

    static string Duration(TimeSpan t) => t.TotalHours >= 1 ? $"{(int)t.TotalHours} h {t.Minutes} min" : t.TotalMinutes >= 1 ? $"{(int)t.TotalMinutes} min {t.Seconds:00} s" : $"{Math.Max(0, t.Seconds)} s";

    /// <summary>The bell: "Missed call from X" (people who were busy or did not answer).</summary>
    internal static async Task NotifyMissedAsync(IDbConnection c, ChatPush push, long callId, IEnumerable<long> userIds, string fromName)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return;
        var conv = await c.ExecuteScalarAsync<Guid?>("SELECT cv.PublicId FROM chat.TRN_ChatCall cl JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = cl.ConversationId WHERE cl.CallId = @callId", new { callId });
        var title = $"Missed call from {fromName}";
        await c.ExecuteAsync("""
            INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@u, NULL, 'MISSED_CALL', @title, @body, @link)
            """, ids.Select(u => new { u, title = title.Length > 200 ? title[..199] + "…" : title, body = "Audio call in Chat. Open the chat to call back.", link = conv is { } g ? $"/chat?c={g}" : "/chat" }));
        await push.ToUsersAsync(ids, "notification.new", new { type = "MISSED_CALL", title });
    }
}

/// <summary>
/// Every 5 s: rings that were not answered within Chat:RingSeconds become "missed"; who is connected comes from LiveKit's
/// participant list (people who closed the browser or lost the network are marked as left); calls that settle are ended.
/// </summary>
public sealed class ChatCallWorker(Db db, IServiceScopeFactory scopes, ChatPush push, IClock clock, IOptions<ChatOptions> options, IMemoryCache cache,
    ILogger<ChatCallWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); }
            catch (OperationCanceledException) { return; }
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning(e, "Chat call pass failed"); }
        }
    }

    sealed record OpenPart(long CallId, string Room, long UserId, Guid UserPublicId, string State, DateTime InvitedUtc, DateTime? AnsweredUtc, DateTime? JoinedUtc, DateTime? LastConnectedUtc, DateTime CallCreatedUtc, bool CanCall);

    public async Task RunOnceAsync(CancellationToken ct = default)
    {
        using var c = await db.OpenAsync(ct);
        var open = (await c.QueryAsync<OpenPart>("""
            SELECT cl.CallId, cl.LiveKitRoomName AS Room, p.UserId, u.PublicId AS UserPublicId, p.[State], p.InvitedUtc, p.AnsweredUtc, p.JoinedUtc, p.LastConnectedUtc, cl.CreatedUtc AS CallCreatedUtc,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM auth.EffectivePermissions(p.UserId) ep WHERE ep.Code = 'chat.calls') THEN 1 ELSE 0 END AS BIT) AS CanCall
            FROM chat.TRN_ChatCall cl JOIN chat.TRN_ChatCallParticipant p ON p.CallId = cl.CallId JOIN auth.Users u ON u.UserId = p.UserId
            WHERE cl.[Status] IN ('RINGING', 'ACTIVE') AND (p.[State] = 'RINGING' OR (p.[State] = 'ACCEPTED' AND p.LeftUtc IS NULL))
            """)).ToList();
        if (open.Count == 0) return;
        using var scope = scopes.CreateScope();
        var rooms = scope.ServiceProvider.GetRequiredService<LiveKitRoomService>();
        var now = clock.UtcNow;
        var o = options.Value;
        var calls = open.GroupBy(x => x.CallId).ToList();
        var callsOff = !await ChatCallEndpoints.CallsEnabledAsync(c, cache);
        foreach (var call in calls)
        {
            ct.ThrowIfCancellationRequested();
            if (callsOff || now - call.First().CallCreatedUtc > TimeSpan.FromHours(12))
            {
                await ChatCallEndpoints.FinishAsync(c, push, rooms, clock, call.Key, callsOff ? "CALLS_SWITCHED_OFF" : "TOO_LONG");
                continue;
            }
            var changed = false;
            List<string> connected;
            try { connected = await rooms.ListParticipantIdentitiesAsync(call.First().Room, ct); }
            catch (LiveKitUnavailableException) { continue; }
            foreach (var p in call)
            {
                // Also stop ringing at once for someone whose audio calls were switched off meanwhile (V032 module access).
                if (p.State == "RINGING" && (now - p.InvitedUtc > TimeSpan.FromSeconds(o.RingSeconds) || !p.CanCall))
                {
                    await c.ExecuteAsync("UPDATE chat.TRN_ChatCallParticipant SET [State] = 'MISSED' WHERE CallId = @callId AND UserId = @u AND [State] = 'RINGING'",
                        new { callId = p.CallId, u = p.UserId });
                    var starter = await c.ExecuteScalarAsync<string>("""
                        SELECT e.DisplayName FROM chat.TRN_ChatCall cl JOIN auth.Users u ON u.UserId = cl.StartedByUserId JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE cl.CallId = @id
                        """, new { id = p.CallId });
                    // Marked missed here, so FinishAsync (which notifies people still ringing) will not: notify now.
                    await ChatCallEndpoints.NotifyMissedAsync(c, push, p.CallId, [p.UserId], starter ?? "a colleague");
                    changed = true;
                    continue;
                }
                if (p.State != "ACCEPTED") continue;
                if (connected.Contains(ChatCallEndpoints.IdentityFor(p.UserPublicId)))
                {
                    await c.ExecuteAsync("UPDATE chat.TRN_ChatCallParticipant SET JoinedUtc = COALESCE(JoinedUtc, @now), LastConnectedUtc = @now WHERE CallId = @callId AND UserId = @u",
                        new { now, callId = p.CallId, u = p.UserId });
                    if (p.JoinedUtc is null || p.LastConnectedUtc is null || now - p.LastConnectedUtc > TimeSpan.FromSeconds(15)) changed = true;
                }
                else
                {
                    // Gone: never connected within a minute of answering, or not seen for 25 s (closed the browser, lost the network).
                    var lastSeen = p.LastConnectedUtc ?? p.AnsweredUtc ?? p.InvitedUtc;
                    if (now - lastSeen > TimeSpan.FromSeconds(p.JoinedUtc is null ? 60 : 25))
                    {
                        await ChatCallEndpoints.MarkLeftAsync(c, rooms, p.CallId, p.UserId, p.UserPublicId, now);
                        changed = true;
                    }
                }
            }
            if (!changed) continue;
            await ChatCallEndpoints.RecomputeAsync(c, push, rooms, clock, call.Key);
            await ChatCallEndpoints.PushCallAsync(c, push, clock, call.Key);
        }
    }
}
