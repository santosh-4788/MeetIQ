using System.Data;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Recording;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Ending a meeting for everyone, shared by the host's "End for all" (RoomEndpoints.End) and the automatic end at the
/// scheduled time (GoodDay #14208): stop any recording cleanly, close the LiveKit room (everyone is disconnected), and
/// complete the meeting, attendance and waiting room.
/// </summary>
public static class MeetingAutoEnd
{
    /// <summary>When a meeting with this scheduled end is ended automatically; null when automatic ending is off.</summary>
    public static DateTime? AutoEndUtc(DateTime endUtc, MeetingOptions o) => o.AutoEndGraceMinutes > 0 ? endUtc.AddMinutes(o.AutoEndGraceMinutes) : null;

    /// <summary>Stops the recording and closes the room. Throws <see cref="LiveKitUnavailableException"/> when the video server cannot be reached.</summary>
    internal static async Task CloseRoomAsync(IDbConnection c, long meetingId, string roomName, LiveKitRoomService rooms, RecordingService recording,
        long? userId, string? ip, CancellationToken ct, string endedBy = "host")
    {
        // Explicit stop rather than relying on the recorder noticing the room closed: a recording must never be left
        // dangling in PROCESSING when the meeting ends.
        if (await RecordingService.MeetingAsync(c, meetingId) is { } recMeeting)
            await recording.StopAsync(c, recMeeting, "Meeting ended", userId, ip, ct);
        // Tell everyone first, in-band (13 Nov 2026): a phone that misses LiveKit's own "room deleted" signal (app in the
        // background, a network blip) otherwise sits on "Reconnecting..." - the client shows "Meeting ended" on this message,
        // and while reconnecting it also asks the API (the source of truth) whether the meeting has ended.
        await rooms.TrySendDataAsync(roomName, MeetingEndedTopic, new { type = "meeting-ended", endedBy, endedUtc = DateTime.UtcNow }, null, ct);
        await rooms.DeleteRoomAsync(roomName, ct);
    }

    /// <summary>LiveKit data topic of the "meeting ended for everyone" message (endedBy: host | auto).</summary>
    public const string MeetingEndedTopic = "oic.meeting";

    /// <summary>Marks the meeting COMPLETED and closes attendance and the waiting room. Returns false if it was no longer in progress.</summary>
    internal static async Task<bool> CompleteAsync(IDbConnection c, IDbTransaction tx, long meetingId, DateTime now, long? userId)
    {
        var n = await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualStartUtc = COALESCE(ActualStartUtc, @now),
                ActualEndUtc = CASE WHEN ActualStartUtc IS NOT NULL AND ActualStartUtc > @now THEN ActualStartUtc ELSE @now END,
                ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
            WHERE MeetingId = @m AND [Status] IN ('SCHEDULED', 'LIVE');
            """, new { now, user = userId, m = meetingId }, tx);
        await c.ExecuteAsync("""
            UPDATE mtg.MeetingAttendance SET LeftUtc = CASE WHEN @now < JoinedUtc THEN JoinedUtc ELSE @now END, LeaveReason = 'MEETING_ENDED'
            WHERE MeetingId = @m AND LeftUtc IS NULL;
            UPDATE mtg.WaitingRoomEntries SET [Status] = 'LEFT' WHERE MeetingId = @m AND [Status] = 'WAITING';
            """, new { now, m = meetingId }, tx);
        return n > 0;
    }
}

/// <summary>
/// Ends LIVE meetings whose scheduled end + <see cref="MeetingOptions.AutoEndGraceMinutes"/> has passed (a host can extend from
/// the room). Runs every 30 s; each meeting is re-checked inside its own update, so two API instances cannot end one twice.
/// </summary>
public sealed class MeetingAutoEndWorker(Db db, IServiceScopeFactory scopes, IOptions<MeetingOptions> options, IClock clock, ILogger<MeetingAutoEndWorker> log) : BackgroundService
{
    TimeSpan PollInterval => TimeSpan.FromSeconds(Math.Max(5, options.Value.AutoEndPollSeconds));

    sealed record Due(long MeetingId, Guid PublicId, string LiveKitRoomName, DateTime EndUtc);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        log.LogInformation("Meeting auto-end worker started (grace {Grace} min after the scheduled end; 0 = off).", options.Value.AutoEndGraceMinutes);
        while (!stop.IsCancellationRequested)
        {
            try { await RunOnceAsync(stop); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Meeting auto-end cycle failed."); }
            try { await Task.Delay(PollInterval, stop); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>One sweep. Returns how many meetings were ended.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        var grace = options.Value.AutoEndGraceMinutes;
        if (grace <= 0) return 0;
        var now = clock.UtcNow;
        using var c = await db.OpenAsync(ct);
        var due = (await c.QueryAsync<Due>("""
            SELECT MeetingId, PublicId, LiveKitRoomName, ScheduledEndUtc AS EndUtc FROM mtg.Meetings
            WHERE [Status] = 'LIVE' AND DATEADD(MINUTE, @grace, ScheduledEndUtc) <= @now
            """, new { grace, now })).ToList();
        var ended = 0;
        foreach (var m in due)
        {
            // Claim first, atomically: completes the meeting only if it is still LIVE and still past its (possibly just
            // extended) end + grace. Once COMPLETED it can no longer be extended, so a host's extension never races this.
            using (var tx = c.BeginTransaction())
            {
                var claimed = await c.ExecuteAsync("""
                    UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualStartUtc = COALESCE(ActualStartUtc, @now),
                        ActualEndUtc = CASE WHEN ActualStartUtc IS NOT NULL AND ActualStartUtc > @now THEN ActualStartUtc ELSE @now END, ModifiedUtc = SYSUTCDATETIME()
                    WHERE MeetingId = @m AND [Status] = 'LIVE' AND DATEADD(MINUTE, @grace, ScheduledEndUtc) <= @now
                    """, new { m = m.MeetingId, grace, now }, tx);
                if (claimed == 0) { tx.Rollback(); continue; }
                await MeetingAutoEnd.CompleteAsync(c, tx, m.MeetingId, now, null);
                await Audit.WriteAsync(c, "SYSTEM", null, "MEETING_AUTO_ENDED", "Meeting", m.PublicId.ToString(),
                    $"Meeting ended automatically {grace} min after its scheduled end ({m.EndUtc:yyyy-MM-dd HH:mm} UTC); no host extended it", null, tx);
                tx.Commit();
            }
            ended++;
            using var scope = scopes.CreateScope();
            var rooms = scope.ServiceProvider.GetRequiredService<LiveKitRoomService>();
            var recording = scope.ServiceProvider.GetRequiredService<RecordingService>();
            try { await MeetingAutoEnd.CloseRoomAsync(c, m.MeetingId, m.LiveKitRoomName, rooms, recording, null, null, ct, "auto"); }
            catch (LiveKitUnavailableException e) { log.LogWarning("Meeting {Id} auto-ended, but the video room could not be closed: {Message}", m.PublicId, e.Message); }
        }
        if (ended > 0) log.LogInformation("Meeting auto-end: {Count} meeting(s) ended.", ended);
        return ended;
    }
}
