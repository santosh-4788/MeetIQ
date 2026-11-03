using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>Opaque, tamper-proof waiting-room entry ids (Data Protection), so internal ids never leave the database.</summary>
public sealed class WaitingRoomIds(IDataProtectionProvider dp)
{
    readonly IDataProtector protector = dp.CreateProtector("OneInsure.Connect.WaitingRoomEntry.v1");
    sealed record Payload(long E, string? N);

    /// <summary>The guest's chosen display name travels inside the id (the schema has no column for it).</summary>
    public string Protect(long entryId, string? displayName = null) => protector.Protect(JsonSerializer.Serialize(new Payload(entryId, displayName)));

    public bool TryUnprotect(string? id, out long entryId, out string? displayName)
    {
        (entryId, displayName) = (0, null);
        if (string.IsNullOrEmpty(id) || id.Length > 1000) return false;
        try
        {
            var p = JsonSerializer.Deserialize<Payload>(protector.Unprotect(id));
            if (p is null || p.E <= 0) return false;
            (entryId, displayName) = (p.E, p.N);
            return true;
        }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException) { return false; }
    }
}

/// <summary>
/// Phase 4 — the live meeting room. Joining (LiveKit tokens), the waiting room, host controls and chat persistence.
/// Only these calls touch SQL Server; the media itself flows browser ↔ LiveKit, so a slow database never drops a call.
/// </summary>
public static class RoomEndpoints
{
    /// <summary>Anonymous waiting-room polling, leave and guest chat (per client IP).</summary>
    public const string GuestRateLimit = "join-room";
    public const string WaitingTopic = "oic.waiting";
    public const int ChatMaxLength = 2000;

    public sealed record GuestEnterInput(string? DisplayName);
    public sealed record ChatInput(string? Body);
    public sealed record MuteInput(string? Source, string? TrackSid);
    public sealed record RemoveInput(bool? Block);

    internal sealed record RoomMeeting(long MeetingId, Guid PublicId, string MeetingCode, string Title, string Category, string Status, DateTime StartUtc,
        DateTime EndUtc, string TimeZoneId, bool WaitingRoomEnabled, string LiveKitRoomName, string HostName, string MeetingKind, bool IsAudioOnly);

    internal sealed record RoomParticipant(long ParticipantId, string Identity, string Type, string Role, bool CanPublish, bool CanScreenShare, string Name);

    sealed record GuestRow(long MeetingId, Guid PublicId, string MeetingCode, string Title, string Category, string Status, DateTime StartUtc,
        DateTime EndUtc, string TimeZoneId, bool WaitingRoomEnabled, string LiveKitRoomName, string HostName, string MeetingKind, bool IsAudioOnly,
        long InvitationId, long ParticipantId, string Identity, string Type, string Role, bool CanPublish, bool CanScreenShare, string Name, bool AdmissionRequired);

    const string MeetingColumns = """
        m.MeetingId, m.PublicId, m.MeetingCode, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc,
        m.TimeZoneId, m.WaitingRoomEnabled, m.LiveKitRoomName, h.DisplayName AS HostName, m.MeetingKind, m.IsAudioOnly
        """;

    public static RouteGroupBuilder MapRoomEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/meetings/{id:guid}").RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapPost("/join", Join);
        g.MapGet("/chat", ChatHistory);
        g.MapPost("/chat", PostChat);
        g.MapGet("/room/waiting", WaitingList);
        g.MapPost("/room/waiting/{entryId}/admit", (Guid id, string entryId, RoomServices s, HttpContext ctx) => Decide(id, entryId, "ADMITTED", s, ctx));
        g.MapPost("/room/waiting/{entryId}/reject", (Guid id, string entryId, RoomServices s, HttpContext ctx) => Decide(id, entryId, "REJECTED", s, ctx));
        g.MapPost("/room/participants/{identity}/mute", Mute);
        g.MapPost("/room/participants/{identity}/remove", Remove);
        g.MapPost("/room/end", End);

        // Customers and guests: the personal invitation token is their credential (no account, no session).
        var j = api.MapGroup("/join/{token}");
        j.MapPost("/enter", GuestEnter).RequireRateLimiting(NotificationEndpoints.JoinRateLimit);
        j.MapGet("/entry/{entryId}", GuestPoll).RequireRateLimiting(GuestRateLimit);
        j.MapPost("/entry/{entryId}/leave", GuestLeave).RequireRateLimiting(GuestRateLimit);
        j.MapGet("/chat", GuestChatHistory).RequireRateLimiting(GuestRateLimit);
        j.MapPost("/chat", GuestPostChat).RequireRateLimiting(GuestRateLimit);
        return api;
    }

    /// <summary>Everything the room endpoints need, resolved once per request.</summary>
    public sealed class RoomServices(Db db, IClock clock, LiveKitTokens tokens, LiveKitRoomService rooms, WaitingRoomIds ids,
        IOptions<LiveKitOptions> liveKit, IOptions<MeetingOptions> meetings)
    {
        public Db Db => db;
        public IClock Clock => clock;
        public LiveKitTokens Tokens => tokens;
        public LiveKitRoomService Rooms => rooms;
        public WaitingRoomIds Ids => ids;
        public LiveKitOptions LiveKit => liveKit.Value;
        public MeetingOptions Meetings => meetings.Value;
    }

    // ---- Shared ------------------------------------------------------------------------------------------------

    internal static IResult Unavailable(string? detail = null) =>
        Problems.Create(503, "SERVICE_UNAVAILABLE", detail ?? "Video meetings are not available: the video service is not configured on this server. Please contact IT support.");

    static IResult NotJoinable(JoinWindow.Result w) => Problems.Create(409, "CONFLICT", w.Message!,
        new Dictionary<string, object?> { ["reason"] = w.Reason, ["opensUtc"] = w.OpensUtc, ["closesUtc"] = w.ClosesUtc });

    static IResult MeetingNotFound() => Db_.NotFound("Meeting");
    static IResult InvalidLink() => Problems.Create(404, "NOT_FOUND", "This invitation link is invalid, has expired or was withdrawn.");
    static IResult HostOnly() => Problems.Create(403, "FORBIDDEN", "Only the host or a co-host can do this.");

    static bool IsHostRole(string role) => role is "HOST" or "COHOST";

    static async Task<RoomMeeting?> FindVisibleAsync(IDbConnection c, Guid id, Actor me) =>
        await c.QuerySingleOrDefaultAsync<RoomMeeting>($"""
            SELECT {MeetingColumns}
            FROM mtg.Meetings m JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
            WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });

    /// <summary>The signed-in employee's own participant row. Administrators who are not participants get none.</summary>
    static async Task<RoomParticipant?> EmployeeParticipantAsync(IDbConnection c, long meetingId, long? employeeId) =>
        employeeId is null ? null : await c.QuerySingleOrDefaultAsync<RoomParticipant>("""
            SELECT p.ParticipantId, p.LiveKitIdentity AS [Identity], p.ParticipantType AS Type, p.[Role], p.CanPublish, p.CanScreenShare, e.DisplayName AS Name
            FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            WHERE p.MeetingId = @meetingId AND p.EmployeeId = @employeeId AND p.IsBlocked = 0
            """, new { meetingId, employeeId });

    sealed record Caller(Actor Me, RoomMeeting Meeting, RoomParticipant? Participant);

    static async Task<(Caller? Caller, IResult? Error)> CallerAsync(IDbConnection c, Guid id, HttpContext ctx, bool hostOnly)
    {
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await FindVisibleAsync(c, id, me);
        if (m is null) return (null, MeetingNotFound());
        var p = await EmployeeParticipantAsync(c, m.MeetingId, me.EmployeeId);
        if (hostOnly && (p is null || !IsHostRole(p.Role))) return (null, HostOnly());
        if (!hostOnly && p is null) return (null, Problems.Create(403, "FORBIDDEN", "Only participants of this meeting can do this. Ask the host to add you."));
        return (new Caller(me, m, p), null);
    }

    static object MeetingDto(RoomMeeting m, string? status = null) => new
    {
        id = m.PublicId, title = m.Title, meetingCode = m.MeetingCode, category = m.Category, categoryGroup = MeetingEndpoints.CategoryGroup(m.Category),
        status = status ?? m.Status, startUtc = m.StartUtc, endUtc = m.EndUtc, timeZoneId = m.TimeZoneId, hostName = m.HostName, waitingRoomEnabled = m.WaitingRoomEnabled,
        kind = m.MeetingKind, audioOnly = m.IsAudioOnly,
    };

    static object Connection(RoomServices s, RoomMeeting m, RoomParticipant p, string name)
    {
        var isHost = IsHostRole(p.Role);
        var screen = p.CanPublish && (isHost || p.CanScreenShare);
        var metadata = JsonSerializer.Serialize(new { role = p.Role, type = p.Type });
        var (token, exp) = s.Tokens.CreateParticipantToken(new ParticipantGrant(m.LiveKitRoomName, p.Identity, name, metadata, p.CanPublish, screen, isHost, !m.IsAudioOnly), s.Clock.UtcNow);
        return new
        {
            url = s.LiveKit.PublicUrl, token, identity = p.Identity, name, role = p.Role, participantType = p.Type, isHost,
            canPublish = p.CanPublish, canScreenShare = screen, canPublishVideo = p.CanPublish && !m.IsAudioOnly, expiresUtc = exp,
        };
    }

    /// <summary>Creates the room with this deployment's timeouts before the first participant arrives (idempotent).</summary>
    static async Task<IResult?> EnsureRoomAsync(RoomServices s, RoomMeeting m, CancellationToken ct)
    {
        try
        {
            await s.Rooms.EnsureRoomAsync(m.LiveKitRoomName, ct);
            return null;
        }
        catch (LiveKitUnavailableException e) { return Unavailable(e.Message); }
    }

    static async Task<List<string>> HostIdentitiesAsync(IDbConnection c, long meetingId) =>
        (await c.QueryAsync<string>("SELECT LiveKitIdentity FROM mtg.MeetingParticipants WHERE MeetingId = @meetingId AND [Role] IN ('HOST', 'COHOST')", new { meetingId })).ToList();

    /// <summary>Tells the hosts in the room to refresh their waiting list (event-driven, no polling of the database).</summary>
    static async Task SignalWaitingChangedAsync(RoomServices s, IDbConnection c, RoomMeeting m, CancellationToken ct) =>
        await s.Rooms.TrySendDataAsync(m.LiveKitRoomName, WaitingTopic, new { type = "waiting-changed" }, await HostIdentitiesAsync(c, m.MeetingId), ct);

    // ---- Employee join -------------------------------------------------------------------------------------------

    /// <summary>
    /// POST /meetings/{id}/join — a short-lived LiveKit token for an invited employee. Administrators with meetings.view.all can see
    /// every meeting but can only join those they are a participant of. The first host/co-host join turns the meeting LIVE.
    /// </summary>
    static async Task<IResult> Join(Guid id, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        if (!s.LiveKit.IsConfigured) return Unavailable();
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: false);
        if (caller is null) return error!;
        var (me, m, p) = (caller.Me, caller.Meeting, caller.Participant!);
        var now = s.Clock.UtcNow;
        var w = JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, s.Meetings);
        if (!w.Joinable) return NotJoinable(w);
        // Colleagues who came in through the shared link (not invited) are let in by a host first, like guests.
        if (await c.ExecuteScalarAsync<int>("""
                SELECT COUNT(*) FROM mtg.MeetingParticipants p WHERE p.ParticipantId = @id AND p.AdmissionRequired = 1
                AND NOT EXISTS (SELECT 1 FROM mtg.WaitingRoomEntries w WHERE w.ParticipantId = p.ParticipantId AND w.[Status] = 'ADMITTED')
                """, new { id = p.ParticipantId }) > 0)
            return Problems.Create(403, "FORBIDDEN", "A host has to let you in first. Open the meeting link again and ask to join.",
                new Dictionary<string, object?> { ["reason"] = "ADMISSION_REQUIRED" });
        if (await EnsureRoomAsync(s, m, ct) is { } unavailable) return unavailable;

        var status = m.Status;
        var ip = ClientInfo.From(ctx).Ip;
        if (IsHostRole(p.Role) && m.Status == "SCHEDULED")
        {
            var started = await c.ExecuteAsync("""
                UPDATE mtg.Meetings SET [Status] = 'LIVE', ActualStartUtc = COALESCE(ActualStartUtc, @now), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                WHERE MeetingId = @id AND [Status] = 'SCHEDULED'
                """, new { now, user = me.UserId, id = m.MeetingId });
            if (started > 0)
                await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_STARTED", "Meeting", id.ToString(), "Meeting started (host joined)", ip);
            status = "LIVE";
        }
        var connection = Connection(s, m, p, p.Name);
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_JOIN_TOKEN_ISSUED", "Meeting", id.ToString(), $"Room access granted ({p.Role.ToLowerInvariant()})", ip,
            newValues: new { participantId = p.Identity, role = p.Role, ttlMinutes = s.LiveKit.TokenTtlMinutes });
        return Results.Ok(new { connection, meeting = MeetingDto(m, status) });
    }

    // ---- Waiting room (host side) --------------------------------------------------------------------------------

    sealed record WaitingRow(long EntryId, DateTime EnteredUtc, string Identity, string Type, string Name, string JoinSource);

    static async Task<IResult> WaitingList(Guid id, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: true);
        if (caller is null) return error!;
        var rows = await c.QueryAsync<WaitingRow>("""
            SELECT w.EntryId, w.EnteredUtc, p.LiveKitIdentity AS [Identity], p.ParticipantType AS Type, COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name,
                   p.JoinSource
            FROM mtg.WaitingRoomEntries w JOIN mtg.MeetingParticipants p ON p.ParticipantId = w.ParticipantId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            WHERE w.MeetingId = @m AND w.[Status] = 'WAITING'
            ORDER BY w.EnteredUtc, w.EntryId
            """, new { m = caller.Meeting.MeetingId });
        return Results.Ok(new
        {
            waitingRoomEnabled = caller.Meeting.WaitingRoomEnabled,
            items = rows.Select(r => new { id = s.Ids.Protect(r.EntryId), participantId = r.Identity, type = r.Type, name = r.Name, enteredUtc = r.EnteredUtc, viaLink = r.JoinSource == "LINK" }),
        });
    }

    static async Task<IResult> Decide(Guid id, string entryId, string decision, RoomServices s, HttpContext ctx)
    {
        var ct = ctx.RequestAborted;
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: true);
        if (caller is null) return error!;
        if (!s.Ids.TryUnprotect(entryId, out var entry, out _)) return Db_.NotFound("Waiting-room entry");
        var who = await c.QuerySingleOrDefaultAsync<string>("""
            UPDATE w SET [Status] = @decision, DecidedByEmployeeId = @emp, DecidedUtc = @now
            OUTPUT p.LiveKitIdentity
            FROM mtg.WaitingRoomEntries w JOIN mtg.MeetingParticipants p ON p.ParticipantId = w.ParticipantId
            WHERE w.EntryId = @entry AND w.MeetingId = @m AND w.[Status] = 'WAITING'
            """, new { decision, emp = caller.Me.EmployeeId, now = s.Clock.UtcNow, entry, m = caller.Meeting.MeetingId });
        if (who is null) return Db_.Conflict("This person is no longer waiting (they left, or another host already decided).");
        await Audit.WriteAsync(c, "USER", caller.Me.UserId, decision == "ADMITTED" ? "WAITING_ROOM_ADMITTED" : "WAITING_ROOM_REJECTED", "Meeting", id.ToString(),
            decision == "ADMITTED" ? "Waiting participant admitted" : "Waiting participant turned away", ClientInfo.From(ctx).Ip, newValues: new { participantId = who });
        await SignalWaitingChangedAsync(s, c, caller.Meeting, ct);
        return Results.NoContent();
    }

    // ---- Host controls ---------------------------------------------------------------------------------------------

    static readonly string[] MuteSources = ["MICROPHONE", "CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"];

    static async Task<IResult> Mute(Guid id, string identity, MuteInput input, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        if (!s.LiveKit.IsConfigured) return Unavailable();
        var source = MeetingEndpoints.Upper(input.Source) ?? "MICROPHONE";
        if (!MuteSources.Contains(source))
        {
            var v = new Validator();
            v.Add("source", "Source must be MICROPHONE, CAMERA, SCREEN_SHARE or SCREEN_SHARE_AUDIO.");
            return v.Problem();
        }
        var trackSid = input.TrackSid is { Length: > 0 and <= 64 } t ? t : null;
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: true);
        if (caller is null) return error!;
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM mtg.MeetingParticipants WHERE MeetingId = @m AND LiveKitIdentity = @identity",
                new { m = caller.Meeting.MeetingId, identity }) == 0)
            return Db_.NotFound("Participant");
        bool muted;
        try { muted = await s.Rooms.MuteTrackAsync(caller.Meeting.LiveKitRoomName, identity, trackSid, source, ct); }
        catch (LiveKitUnavailableException e) { return Unavailable(e.Message); }
        if (!muted) return Problems.Create(404, "NOT_FOUND", "That participant is not in the meeting or is not sharing this right now.");
        await Audit.WriteAsync(c, "USER", caller.Me.UserId, "ROOM_PARTICIPANT_MUTED", "Meeting", id.ToString(), $"Host muted a participant's {source.ToLowerInvariant().Replace('_', ' ')}",
            ClientInfo.From(ctx).Ip, newValues: new { participantId = identity, source });
        return Results.NoContent();
    }

    /// <summary>Removes a participant from the room. With "block": they cannot come back (personal link revoked, refused everywhere).</summary>
    static async Task<IResult> Remove(Guid id, string identity, RemoveInput? input, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        if (!s.LiveKit.IsConfigured) return Unavailable();
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: true);
        if (caller is null) return error!;
        var target = await c.QuerySingleOrDefaultAsync<(long ParticipantId, string Role)?>(
            "SELECT ParticipantId, [Role] FROM mtg.MeetingParticipants WHERE MeetingId = @m AND LiveKitIdentity = @identity", new { m = caller.Meeting.MeetingId, identity });
        if (target is null) return Db_.NotFound("Participant");
        if (target.Value.Role == "HOST") return Db_.Conflict("The host cannot be removed from the meeting.");
        bool removed;
        try { removed = await s.Rooms.RemoveParticipantAsync(caller.Meeting.LiveKitRoomName, identity, ct); }
        catch (LiveKitUnavailableException e) { return Unavailable(e.Message); }
        // A removed customer/guest must ask again: their earlier admission no longer lets them back in.
        await c.ExecuteAsync("UPDATE mtg.WaitingRoomEntries SET [Status] = 'LEFT' WHERE ParticipantId = @p AND [Status] IN ('WAITING', 'ADMITTED')", new { p = target.Value.ParticipantId });
        var block = input?.Block == true;
        if (block)
        {
            var now = s.Clock.UtcNow;
            await c.ExecuteAsync("""
                UPDATE mtg.MeetingParticipants SET IsBlocked = 1, BlockedUtc = @now, BlockedByEmployeeId = @emp, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                WHERE ParticipantId = @p;
                UPDATE mtg.MeetingInvitations SET RevokedUtc = @now, RevokeReason = 'Removed by the host' WHERE ParticipantId = @p AND RevokedUtc IS NULL;
                """, new { now, emp = caller.Me.EmployeeId, user = caller.Me.UserId, p = target.Value.ParticipantId });
        }
        if (!removed && !block) return Problems.Create(404, "NOT_FOUND", "That participant is not in the meeting right now.");
        await Audit.WriteAsync(c, "USER", caller.Me.UserId, block ? "ROOM_PARTICIPANT_BLOCKED" : "ROOM_PARTICIPANT_REMOVED", "Meeting", id.ToString(),
            block ? "Host removed a participant and blocked re-entry" : "Host removed a participant from the room",
            ClientInfo.From(ctx).Ip, newValues: new { participantId = identity, blocked = block });
        return Results.NoContent();
    }

    /// <summary>End for everyone: closes the LiveKit room (all participants are disconnected) and completes the meeting.</summary>
    static async Task<IResult> End(Guid id, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        if (!s.LiveKit.IsConfigured) return Unavailable();
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: true);
        if (caller is null) return error!;
        var m = caller.Meeting;
        if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("This meeting is not in progress.");
        try { await s.Rooms.DeleteRoomAsync(m.LiveKitRoomName, ct); }
        catch (LiveKitUnavailableException e) { return Unavailable(e.Message); }

        var now = s.Clock.UtcNow;
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualStartUtc = COALESCE(ActualStartUtc, @now),
                ActualEndUtc = CASE WHEN ActualStartUtc IS NOT NULL AND ActualStartUtc > @now THEN ActualStartUtc ELSE @now END,
                ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
            WHERE MeetingId = @m AND [Status] IN ('SCHEDULED', 'LIVE');
            UPDATE mtg.MeetingAttendance SET LeftUtc = CASE WHEN @now < JoinedUtc THEN JoinedUtc ELSE @now END, LeaveReason = 'MEETING_ENDED'
            WHERE MeetingId = @m AND LeftUtc IS NULL;
            UPDATE mtg.WaitingRoomEntries SET [Status] = 'LEFT' WHERE MeetingId = @m AND [Status] = 'WAITING';
            """, new { now, user = caller.Me.UserId, m = m.MeetingId }, tx);
        await Audit.WriteAsync(c, "USER", caller.Me.UserId, "MEETING_ENDED", "Meeting", id.ToString(), "Host ended the meeting for everyone", ClientInfo.From(ctx).Ip, tx);
        tx.Commit();
        return Results.NoContent();
    }

    // ---- Chat (persisted, decision D8) -------------------------------------------------------------------------------

    sealed record ChatRow(long MessageId, string Body, DateTime SentUtc, bool IsSystem, string? Identity, string? Name);

    static async Task<IResult> ChatListAsync(IDbConnection c, long meetingId)
    {
        var rows = await c.QueryAsync<ChatRow>("""
            SELECT x.MessageId, x.Body, x.SentUtc, x.IsSystem, x.[Identity], x.Name FROM (
                SELECT TOP (200) cm.MessageId, cm.Body, cm.SentUtc, cm.IsSystem, p.LiveKitIdentity AS [Identity], COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name
                FROM mtg.MeetingChatMessages cm
                LEFT JOIN mtg.MeetingParticipants p ON p.ParticipantId = cm.ParticipantId
                LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
                LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
                WHERE cm.MeetingId = @meetingId
                ORDER BY cm.SentUtc DESC, cm.MessageId DESC) x
            ORDER BY x.SentUtc, x.MessageId
            """, new { meetingId });
        return Results.Ok(new { items = rows.Select(r => new { identity = r.Identity, name = r.Name ?? "OneInsure Connect", body = r.Body, sentUtc = r.SentUtc, isSystem = r.IsSystem }) });
    }

    /// <summary>Plain text only: control characters are dropped (line breaks kept). The client renders it as text, never as HTML.</summary>
    internal static string? CleanChat(string? body)
    {
        if (body is null) return null;
        var sb = new StringBuilder(body.Length);
        foreach (var ch in body.Trim())
            if (!char.IsControl(ch) || ch == '\n' || ch == '\t') sb.Append(ch);
        var s = sb.ToString().Trim();
        return s.Length == 0 ? null : s;
    }

    static async Task<IResult> InsertChatAsync(IDbConnection c, RoomMeeting m, RoomParticipant p, string? displayName, ChatInput input)
    {
        var body = CleanChat(input.Body);
        var v = new Validator();
        if (body is null) v.Add("body", "Type a message.");
        else if (body.Length > ChatMaxLength) v.Add("body", $"A message can be at most {ChatMaxLength} characters.");
        if (!v.IsValid) return v.Problem();
        if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("This meeting is not in progress.");
        var sentUtc = await c.QuerySingleAsync<DateTime>("""
            INSERT mtg.MeetingChatMessages (MeetingId, ParticipantId, Body) OUTPUT inserted.SentUtc VALUES (@meetingId, @participantId, @body)
            """, new { meetingId = m.MeetingId, participantId = p.ParticipantId, body });
        return Results.Json(new { identity = p.Identity, name = displayName ?? p.Name, body, sentUtc, isSystem = false }, statusCode: 201);
    }

    static async Task<IResult> ChatHistory(Guid id, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: false);
        return caller is null ? error! : await ChatListAsync(c, caller.Meeting.MeetingId);
    }

    static async Task<IResult> PostChat(Guid id, ChatInput input, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: false);
        return caller is null ? error! : await InsertChatAsync(c, caller.Meeting, caller.Participant!, null, input);
    }

    // ---- Customers and guests --------------------------------------------------------------------------------------

    /// <summary>
    /// The personal invitation's meeting and participant. Admission: the waiting room applies when the meeting has one, and always to
    /// people who came in through the shared meeting link. Blocked participants (removed by a host) are not found.
    /// </summary>
    static async Task<(RoomMeeting M, RoomParticipant P, long InvitationId, bool Admission)?> GuestAsync(IDbConnection c, string token, DateTime now, bool countUse)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return null;
        var r = await c.QuerySingleOrDefaultAsync<GuestRow>($"""
            SELECT {MeetingColumns}, i.InvitationId, p.ParticipantId, p.LiveKitIdentity AS [Identity], p.ParticipantType AS Type, p.[Role], p.CanPublish, p.CanScreenShare,
                   COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name, p.AdmissionRequired
            FROM mtg.MeetingInvitations i
            JOIN mtg.Meetings m ON m.MeetingId = i.MeetingId
            JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
            JOIN mtg.MeetingParticipants p ON p.ParticipantId = i.ParticipantId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            WHERE i.TokenHash = @hash AND i.RevokedUtc IS NULL AND i.ExpiresUtc > @now AND (@countUse = 0 OR i.MaxUses IS NULL OR i.UseCount < i.MaxUses)
              AND p.IsBlocked = 0
            """, new { hash = Tokens.Hash(token), now, countUse });
        if (r is null) return null;
        return (new RoomMeeting(r.MeetingId, r.PublicId, r.MeetingCode, r.Title, r.Category, r.Status, r.StartUtc, r.EndUtc, r.TimeZoneId, r.WaitingRoomEnabled, r.LiveKitRoomName,
                r.HostName, r.MeetingKind, r.IsAudioOnly),
            new RoomParticipant(r.ParticipantId, r.Identity, r.Type, r.Role, r.CanPublish, r.CanScreenShare, r.Name), r.InvitationId, r.WaitingRoomEnabled || r.AdmissionRequired);
    }

    internal static string? CleanName(string? s)
    {
        var n = CleanChat(s)?.Replace('\n', ' ').Replace('\t', ' ');
        return string.IsNullOrWhiteSpace(n) ? null : n.Trim();
    }

    /// <summary>
    /// POST /join/{token}/enter — with a waiting room: a WAITING entry (202, poll it); without: the LiveKit connection at once.
    /// Guests may change the name shown in the room; customers appear under their customer record's name.
    /// </summary>
    static async Task<IResult> GuestEnter(string token, GuestEnterInput? input, RoomServices s, HttpContext ctx, CancellationToken ct)
    {
        if (!s.LiveKit.IsConfigured) return Unavailable();
        var now = s.Clock.UtcNow;
        using var c = await s.Db.OpenAsync(ct);
        var g = await GuestAsync(c, token, now, countUse: true);
        if (g is null) return InvalidLink();
        var (m, p, invitationId, admission) = g.Value;
        var w = JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, s.Meetings);
        if (!w.Joinable) return NotJoinable(w);

        var name = p.Name;
        if (p.Type == "GUEST" && input?.DisplayName is not null)
        {
            var typed = CleanName(input.DisplayName);
            var v = new Validator();
            if (typed is null) v.Add("displayName", "Enter your name.");
            else if (typed.Length > 80) v.Add("displayName", "Your name can be at most 80 characters.");
            if (!v.IsValid) return v.Problem();
            name = typed!;
        }
        await c.ExecuteAsync("UPDATE mtg.MeetingInvitations SET UseCount = UseCount + 1, LastUsedUtc = @now WHERE InvitationId = @invitationId", new { now, invitationId });

        if (!admission)
        {
            if (await EnsureRoomAsync(s, m, ct) is { } unavailable) return unavailable;
            return Results.Ok(new { status = "ADMITTED", connection = Connection(s, m, p, name), meeting = MeetingDto(m) });
        }

        var last = await c.QuerySingleOrDefaultAsync<(long EntryId, string Status, DateTime? DecidedUtc)?>("""
            SELECT TOP (1) EntryId, [Status], DecidedUtc FROM mtg.WaitingRoomEntries WHERE ParticipantId = @p ORDER BY EntryId DESC
            """, new { p = p.ParticipantId });
        if (last is { Status: "REJECTED" } rejected && rejected.DecidedUtc > now.AddMinutes(-2))
            return Problems.Create(403, "FORBIDDEN", "The host has not let you in. You can ask again in a couple of minutes, or contact the organiser.");

        long entryId;
        if (last is { Status: "WAITING" } waiting) entryId = waiting.EntryId;
        else
        {
            entryId = await c.QuerySingleAsync<long>("""
                INSERT mtg.WaitingRoomEntries (MeetingId, ParticipantId, EnteredUtc, [Status]) OUTPUT inserted.EntryId VALUES (@m, @p, @now, 'WAITING')
                """, new { m = m.MeetingId, p = p.ParticipantId, now });
            // The hosts get an ADMIT_REQUEST notification (bell) and, if they are already in the room, a live data message.
            var title = $"{name} is waiting to join: {m.Title}";
            await c.ExecuteAsync("""
                INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath)
                SELECT DISTINCT u.UserId, @m, 'ADMIT_REQUEST', @title, @body, @link
                FROM mtg.MeetingParticipants hp JOIN auth.Users u ON u.EmployeeId = hp.EmployeeId AND u.IsActive = 1
                WHERE hp.MeetingId = @m AND hp.[Role] IN ('HOST', 'COHOST')
                """, new
            {
                m = m.MeetingId, title = title.Length > 200 ? title[..199] + "…" : title,
                body = $"{p.Type switch { "CUSTOMER" => "Your customer", "EMPLOYEE" => "A colleague", _ => "A guest" }} is in the waiting room. Open the meeting room to admit them.",
                link = $"/meetings/{m.PublicId}/room",
            });
            await Audit.WriteAsync(c, "CUSTOMER", null, "WAITING_ROOM_ENTERED", "Meeting", m.PublicId.ToString(), $"{p.Type.ToLowerInvariant()} entered the waiting room",
                ClientInfo.From(ctx).Ip, newValues: new { participantId = p.Identity });
            await SignalWaitingChangedAsync(s, c, m, ct);
        }
        return Results.Json(new { status = "WAITING", entryId = s.Ids.Protect(entryId, name), pollAfterMs = 3000, name, meeting = MeetingDto(m) }, statusCode: 202);
    }

    /// <summary>GET /join/{token}/entry/{entryId} — WAITING, ADMITTED (with the LiveKit connection), REJECTED, LEFT or ENDED.</summary>
    static async Task<IResult> GuestPoll(string token, string entryId, RoomServices s, CancellationToken ct)
    {
        var now = s.Clock.UtcNow;
        using var c = await s.Db.OpenAsync(ct);
        var g = await GuestAsync(c, token, now, countUse: false);
        if (g is null) return InvalidLink();
        var (m, p, _, _) = g.Value;
        if (!s.Ids.TryUnprotect(entryId, out var entry, out var name)) return Db_.NotFound("Waiting-room entry");
        var status = await c.QuerySingleOrDefaultAsync<string>("SELECT [Status] FROM mtg.WaitingRoomEntries WHERE EntryId = @entry AND ParticipantId = @p",
            new { entry, p = p.ParticipantId });
        if (status is null) return Db_.NotFound("Waiting-room entry");
        var w = JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, s.Meetings);
        if (!w.Joinable) return Results.Ok(new { status = "ENDED", message = w.Message });
        switch (status)
        {
            case "WAITING": return Results.Ok(new { status, pollAfterMs = 3000 });
            case "REJECTED": return Results.Ok(new { status, message = "The host has not let you in to this meeting." });
            case "LEFT": return Results.Ok(new { status, message = "You are no longer in the waiting room." });
        }
        if (!s.LiveKit.IsConfigured) return Unavailable();
        if (await EnsureRoomAsync(s, m, ct) is { } unavailable) return unavailable;
        return Results.Ok(new { status = "ADMITTED", connection = Connection(s, m, p, name ?? p.Name), meeting = MeetingDto(m) });
    }

    static async Task<IResult> GuestLeave(string token, string entryId, RoomServices s, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var g = await GuestAsync(c, token, s.Clock.UtcNow, countUse: false);
        if (g is null) return InvalidLink();
        if (!s.Ids.TryUnprotect(entryId, out var entry, out _)) return Db_.NotFound("Waiting-room entry");
        var n = await c.ExecuteAsync("UPDATE mtg.WaitingRoomEntries SET [Status] = 'LEFT' WHERE EntryId = @entry AND ParticipantId = @p AND [Status] = 'WAITING'",
            new { entry, p = g.Value.P.ParticipantId });
        if (n > 0) await SignalWaitingChangedAsync(s, c, g.Value.M, ct);
        return Results.NoContent();
    }

    /// <summary>Guests may read and write the chat only once they are in the meeting (admitted, or no waiting room).</summary>
    static async Task<(RoomMeeting M, RoomParticipant P)?> AdmittedGuestAsync(IDbConnection c, RoomServices s, string token)
    {
        var g = await GuestAsync(c, token, s.Clock.UtcNow, countUse: false);
        if (g is null) return null;
        var (m, p, _, admission) = g.Value;
        if (admission && await c.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM mtg.WaitingRoomEntries WHERE ParticipantId = @p AND [Status] = 'ADMITTED'", new { p = p.ParticipantId }) == 0)
            return null;
        return (m, p);
    }

    static async Task<IResult> GuestChatHistory(string token, RoomServices s, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var g = await AdmittedGuestAsync(c, s, token);
        return g is null ? Problems.Create(403, "FORBIDDEN", "The chat is available once you are in the meeting.") : await ChatListAsync(c, g.Value.M.MeetingId);
    }

    static async Task<IResult> GuestPostChat(string token, ChatInput input, string? name, RoomServices s, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var g = await AdmittedGuestAsync(c, s, token);
        if (g is null) return Problems.Create(403, "FORBIDDEN", "The chat is available once you are in the meeting.");
        var shown = g.Value.P.Type == "GUEST" && CleanName(name) is { Length: <= 80 } n ? n : null;
        return await InsertChatAsync(c, g.Value.M, g.Value.P, shown, input);
    }
}
