using System.Data;
using Dapper;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Recording inside the meeting room. Employees (session): GET/POST /api/v1/meetings/{id}/recording[/start|/stop|/consent].
/// Customers and guests (invitation token, once admitted): GET/POST /api/v1/join/{token}/recording[/consent].
/// Only hosts and co-hosts start or stop; every participant sees the policy's notice and answers it (or acknowledges it).
/// </summary>
public static class RecordingRoomEndpoints
{
    public sealed record StartInput(bool AcceptNotice, string? NoticeVersion);
    public sealed record ConsentInput(string? Decision, string? NoticeVersion);

    public static RouteGroupBuilder MapRecordingRoomEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/meetings/{id:guid}/recording").RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapGet("", State);
        g.MapPost("/start", Start);
        g.MapPost("/stop", Stop);
        g.MapPost("/consent", Consent);

        var j = api.MapGroup("/join/{token}/recording");
        j.MapGet("", GuestState).RequireRateLimiting(RoomEndpoints.GuestRateLimit);
        j.MapPost("/consent", GuestConsent).RequireRateLimiting(RoomEndpoints.GuestRateLimit);
        return api;
    }

    sealed record Caller(Actor Me, RecMeeting Meeting, RecParticipant Participant, bool IsHost);

    static async Task<(Caller? Caller, IResult? Error)> CallerAsync(IDbConnection c, Guid id, HttpContext ctx)
    {
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await c.QuerySingleOrDefaultAsync<RecMeeting>($"""
            SELECT {RecordingService.MeetingColumns} FROM mtg.Meetings m WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (m is null) return (null, Db_.NotFound("Meeting"));
        var p = me.EmployeeId is null ? null : await c.QuerySingleOrDefaultAsync<RecParticipant>("""
            SELECT p.ParticipantId, p.LiveKitIdentity AS [Identity], p.[Role], p.ParticipantType AS Type, e.DisplayName AS Name
            FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = @m AND p.EmployeeId = @emp
            """, new { m = m.MeetingId, emp = me.EmployeeId });
        if (p is null) return (null, Problems.Create(403, "FORBIDDEN", "Only participants of this meeting can do this."));
        return (new Caller(me, m, p, p.Role is "HOST" or "COHOST"), null);
    }

    static async Task<IResult> State(Guid id, RecordingService s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx);
        if (caller is null) return error!;
        if (caller.IsHost) await s.TryAutoStartAsync(c, caller.Meeting, ct);
        return Results.Ok(await s.StateAsync(c, caller.Meeting, caller.Participant, caller.IsHost, ct));
    }

    static async Task<IResult> Start(Guid id, StartInput? input, RecordingService s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx);
        if (caller is null) return error!;
        if (!caller.IsHost) return Problems.Create(403, "FORBIDDEN", "Only the host or a co-host can start recording.");
        var r = await s.StartAsync(c, caller.Meeting, caller.Participant, caller.Me.UserId, input?.AcceptNotice ?? false, input?.NoticeVersion, ctx, ct);
        if (r.RecordingId is null) return Problems.Create(r.Status, r.Code, r.Message);
        return Results.Ok(await s.StateAsync(c, caller.Meeting, caller.Participant, true, ct));
    }

    static async Task<IResult> Stop(Guid id, RecordingService s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx);
        if (caller is null) return error!;
        if (!caller.IsHost) return Problems.Create(403, "FORBIDDEN", "Only the host or a co-host can stop recording.");
        var mp = await RecordingPolicyStore.ForMeetingAsync(c, caller.Meeting.Category, caller.Meeting.MeetingRecordingPolicy);
        if (mp?.EffectiveRequirement == "MANDATORY")
            return Problems.Create(409, "RECORDING_MANDATORY", "Recording is mandatory for this meeting and stops when the meeting ends.");
        if (!await s.StopAsync(c, caller.Meeting, "Stopped by the host", caller.Me.UserId, ClientInfo.From(ctx).Ip, ct))
            return Db_.Conflict("This meeting is not being recorded.");
        return Results.Ok(await s.StateAsync(c, caller.Meeting, caller.Participant, true, ct));
    }

    static async Task<IResult> Consent(Guid id, ConsentInput input, RecordingService s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (caller, error) = await CallerAsync(c, id, ctx);
        if (caller is null) return error!;
        if (await s.ConsentAsync(c, caller.Meeting, caller.Participant, input.Decision, input.NoticeVersion, ctx, "USER", caller.Me.UserId, ct) is { } problem) return problem;
        var m = (await RecordingService.MeetingAsync(c, caller.Meeting.MeetingId))!;
        return Results.Ok(await s.StateAsync(c, m, caller.Participant, caller.IsHost, ct));
    }

    // ---- Customers and guests ------------------------------------------------------------------------------------------

    /// <summary>The invitation's participant, once they are in the meeting (admitted, or no waiting room).</summary>
    static async Task<(RecMeeting M, RecParticipant P)?> GuestAsync(IDbConnection c, string token, DateTime now)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return null;
        var r = await c.QuerySingleOrDefaultAsync<(long MeetingId, long ParticipantId)?>("""
            SELECT i.MeetingId, i.ParticipantId FROM mtg.MeetingInvitations i
            WHERE i.TokenHash = @hash AND i.RevokedUtc IS NULL AND i.ExpiresUtc > @now
            """, new { hash = Tokens.Hash(token), now });
        if (r is null) return null;
        var m = await RecordingService.MeetingAsync(c, r.Value.MeetingId);
        var p = await c.QuerySingleOrDefaultAsync<RecParticipant>("""
            SELECT p.ParticipantId, p.LiveKitIdentity AS [Identity], p.[Role], p.ParticipantType AS Type, COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name
            FROM mtg.MeetingParticipants p LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            WHERE p.ParticipantId = @p AND p.IsBlocked = 0
            """, new { p = r.Value.ParticipantId });
        if (m is null || p is null) return null;
        var admission = m.WaitingRoomEnabled || await c.ExecuteScalarAsync<bool>("SELECT AdmissionRequired FROM mtg.MeetingParticipants WHERE ParticipantId = @p", new { p = p.ParticipantId });
        if (admission && await c.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM mtg.WaitingRoomEntries WHERE ParticipantId = @p AND [Status] = 'ADMITTED'", new { p = p.ParticipantId }) == 0)
            return null;
        return (m, p);
    }

    static IResult NotInMeeting() => Problems.Create(403, "FORBIDDEN", "The recording notice is available once you are in the meeting.");

    static async Task<IResult> GuestState(string token, RecordingService s, IClock clock, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var g = await GuestAsync(c, token, clock.UtcNow);
        if (g is null) return NotInMeeting();
        return Results.Ok(await s.StateAsync(c, g.Value.M, g.Value.P, false, ct));
    }

    static async Task<IResult> GuestConsent(string token, ConsentInput input, RecordingService s, IClock clock, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var g = await GuestAsync(c, token, clock.UtcNow);
        if (g is null) return NotInMeeting();
        if (await s.ConsentAsync(c, g.Value.M, g.Value.P, input.Decision, input.NoticeVersion, ctx, "CUSTOMER", null, ct) is { } problem) return problem;
        var m = (await RecordingService.MeetingAsync(c, g.Value.M.MeetingId))!;
        return Results.Ok(await s.StateAsync(c, m, g.Value.P, false, ct));
    }
}
