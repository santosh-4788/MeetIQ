using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// POST /api/v1/webhooks/livekit — signed LiveKit room events → attendance (mtg.MeetingAttendance) and room lifecycle.
/// Every event is stored once in app.WebhookEvents (event id = primary key) and processed under a row lock, so redelivery
/// and concurrent delivery never double-count. Anonymous: the signature (JWT over the body's SHA-256) is the authentication.
/// </summary>
public static class LiveKitWebhookEndpoints
{
    public const string Path = "/api/v1/webhooks/livekit";
    const int MaxBodyBytes = 1024 * 1024;

    public static RouteGroupBuilder MapLiveKitWebhook(this RouteGroupBuilder api)
    {
        api.MapPost("/webhooks/livekit", Receive);
        return api;
    }

    sealed class WebhookLog;

    static async Task<IResult> Receive(HttpContext ctx, Db db, LiveKitTokens tokens, IOptions<LiveKitOptions> lk, IClock clock, ILogger<WebhookLog> log)
    {
        if (!lk.Value.IsConfigured) return RoomEndpoints.Unavailable("LiveKit is not configured.");
        var body = await ReadBodyAsync(ctx.Request, ctx.RequestAborted);
        if (body is null) return Problems.Create(413, "VALIDATION", "Payload too large.");
        var error = tokens.VerifyWebhook(ctx.Request.Headers.Authorization.ToString(), body, clock.UtcNow);
        if (error is not null)
        {
            log.LogWarning("Rejected LiveKit webhook from {Ip}: {Reason}", ctx.Connection.RemoteIpAddress, error);
            return Problems.Create(401, "UNAUTHORIZED", "Invalid webhook signature.");
        }

        JsonElement root;
        try { root = JsonDocument.Parse(body).RootElement; }
        catch (JsonException) { return Problems.Create(400, "VALIDATION", "The payload is not JSON."); }
        var ev = Str(root, "event") ?? "";
        var eventId = Str(root, "id") is { Length: > 0 and <= 100 } i ? i : "sha256:" + Convert.ToHexStringLower(SHA256.HashData(body))[..56];

        using var c = await db.OpenAsync(ctx.RequestAborted);
        try
        {
            await c.ExecuteAsync("""
                INSERT app.WebhookEvents (EventId, Source, EventType, PayloadJson, SignatureValid) VALUES (@eventId, 'LIVEKIT', @ev, @payload, 1)
                """, new { eventId, ev = ev.Length > 50 ? ev[..50] : ev, payload = Encoding.UTF8.GetString(body) });
        }
        catch (SqlException e) when (e.IsUniqueViolation()) { } // redelivery: processed below only if the first attempt failed

        using var tx = c.BeginTransaction();
        var processed = await c.QuerySingleOrDefaultAsync<DateTime?>(
            "SELECT ProcessedUtc FROM app.WebhookEvents WITH (UPDLOCK, HOLDLOCK) WHERE EventId = @eventId", new { eventId }, tx);
        if (processed is not null)
        {
            tx.Commit();
            return Results.Ok(new { duplicate = true });
        }
        try
        {
            await ProcessAsync(c, tx, ev, root, clock.UtcNow);
            await c.ExecuteAsync("UPDATE app.WebhookEvents SET ProcessedUtc = SYSUTCDATETIME(), ProcessingError = NULL, Attempts = Attempts + 1 WHERE EventId = @eventId",
                new { eventId }, tx);
            tx.Commit();
            return Results.Ok(new { duplicate = false });
        }
        catch (Exception e) when (e is SqlException or InvalidOperationException or FormatException)
        {
            tx.Rollback();
            log.LogError(e, "LiveKit webhook {EventId} ({Event}) failed", eventId, ev);
            await c.ExecuteAsync("UPDATE app.WebhookEvents SET ProcessingError = @err, Attempts = Attempts + 1 WHERE EventId = @eventId",
                new { eventId, err = e.Message.Length > 1000 ? e.Message[..1000] : e.Message });
            return Problems.Create(500, "SERVER", "The event could not be processed; LiveKit will retry.");
        }
    }

    static async Task<byte[]?> ReadBodyAsync(HttpRequest req, CancellationToken ct)
    {
        if (req.ContentLength > MaxBodyBytes) return null;
        using var ms = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int n;
        while ((n = await req.Body.ReadAsync(buffer, ct)) > 0)
        {
            ms.Write(buffer, 0, n);
            if (ms.Length > MaxBodyBytes) return null;
        }
        return ms.ToArray();
    }

    static async Task ProcessAsync(IDbConnection c, IDbTransaction tx, string ev, JsonElement root, DateTime nowUtc)
    {
        var at = Seconds(root, "createdAt") ?? nowUtc;
        var room = root.TryGetProperty("room", out var r) ? Str(r, "name") : null;
        if (string.IsNullOrEmpty(room)) return;
        switch (ev)
        {
            case "participant_joined":
            case "participant_left":
            case "participant_connection_aborted":
                if (!root.TryGetProperty("participant", out var p)) return;
                var identity = Str(p, "identity");
                var sid = Str(p, "sid");
                if (string.IsNullOrEmpty(identity) || string.IsNullOrEmpty(sid)) return;
                var row = await c.QuerySingleOrDefaultAsync<(long MeetingId, long ParticipantId)?>("""
                    SELECT m.MeetingId, p.ParticipantId FROM mtg.Meetings m JOIN mtg.MeetingParticipants p ON p.MeetingId = m.MeetingId
                    WHERE m.LiveKitRoomName = @room AND p.LiveKitIdentity = @identity
                    """, new { room, identity }, tx);
                if (row is null) return; // not one of ours (e.g. the hidden recorder)
                var joined = Millis(p, "joinedAtMs") ?? Seconds(p, "joinedAt") ?? at;
                var tag = $"livekit:{sid}";
                if (ev == "participant_joined")
                    await c.ExecuteAsync("""
                        INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, ClientInfo)
                        SELECT @m, @p, @joined, @tag WHERE NOT EXISTS (SELECT 1 FROM mtg.MeetingAttendance WHERE ParticipantId = @p AND ClientInfo = @tag)
                        """, new { m = row.Value.MeetingId, p = row.Value.ParticipantId, joined, tag }, tx);
                else
                {
                    var reason = Str(p, "disconnectReason") ?? (ev == "participant_left" ? "LEFT" : "CONNECTION_ABORTED");
                    await c.ExecuteAsync("""
                        UPDATE mtg.MeetingAttendance SET LeftUtc = CASE WHEN @left < JoinedUtc THEN JoinedUtc ELSE @left END, LeaveReason = @reason
                        WHERE ParticipantId = @p AND ClientInfo = @tag AND LeftUtc IS NULL;
                        IF NOT EXISTS (SELECT 1 FROM mtg.MeetingAttendance WHERE ParticipantId = @p AND ClientInfo = @tag)
                            INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, LeftUtc, LeaveReason, ClientInfo)
                            VALUES (@m, @p, @joined, CASE WHEN @left < @joined THEN @joined ELSE @left END, @reason, @tag);
                        """, new { m = row.Value.MeetingId, p = row.Value.ParticipantId, joined, left = at, reason = reason.Length > 30 ? reason[..30] : reason, tag }, tx);
                }
                return;

            case "room_finished":
                // Everyone left (after LiveKit:DepartureTimeoutSeconds) or the room was deleted: the meeting is over.
                var meeting = await c.QuerySingleOrDefaultAsync<(long MeetingId, Guid PublicId, string Status)?>(
                    "SELECT MeetingId, PublicId, [Status] FROM mtg.Meetings WHERE LiveKitRoomName = @room", new { room }, tx);
                if (meeting is null) return;
                await c.ExecuteAsync("""
                    UPDATE mtg.MeetingAttendance SET LeftUtc = CASE WHEN @at < JoinedUtc THEN JoinedUtc ELSE @at END, LeaveReason = 'ROOM_FINISHED'
                    WHERE MeetingId = @m AND LeftUtc IS NULL;
                    UPDATE mtg.WaitingRoomEntries SET [Status] = 'LEFT' WHERE MeetingId = @m AND [Status] = 'WAITING';
                    """, new { m = meeting.Value.MeetingId, at }, tx);
                if (meeting.Value.Status == "LIVE")
                {
                    await c.ExecuteAsync("""
                        UPDATE mtg.Meetings SET [Status] = 'COMPLETED',
                            ActualEndUtc = CASE WHEN ActualStartUtc IS NOT NULL AND ActualStartUtc > @at THEN ActualStartUtc ELSE @at END, ModifiedUtc = SYSUTCDATETIME()
                        WHERE MeetingId = @m AND [Status] = 'LIVE'
                        """, new { m = meeting.Value.MeetingId, at }, tx);
                    await Audit.WriteAsync(c, "SYSTEM", null, "MEETING_COMPLETED", "Meeting", meeting.Value.PublicId.ToString(), "Meeting completed (video room closed)", null, tx);
                }
                return;
        }
    }

    static string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>protojson writes int64 as a string; accept both forms.</summary>
    static long? Int64(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
        if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s)) return s;
        return null;
    }

    static DateTime? Seconds(JsonElement e, string name) => Int64(e, name) is > 0 and < 32503680000 and var s ? DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime : null;
    static DateTime? Millis(JsonElement e, string name) => Int64(e, name) is > 0 and < 32503680000000 and var s ? DateTimeOffset.FromUnixTimeMilliseconds(s).UtcDateTime : null;
}
