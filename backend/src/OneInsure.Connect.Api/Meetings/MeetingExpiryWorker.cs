using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Periodically closes out meetings nobody ever acted on (feature-gap report, section 03: nothing previously ever set
/// EXPIRED or INCOMPLETE, so stale meetings lingered as SCHEDULED/LIVE forever). A SCHEDULED meeting whose join window
/// has fully closed and that nobody ever joined becomes EXPIRED. A LIVE meeting left open long past its scheduled end
/// (the host never ended it, and LiveKit's "room finished" webhook never arrived - e.g. the server restarted mid-call)
/// becomes INCOMPLETE. Plain idempotent UPDATE statements: safe to run from more than one API instance without a lease.
/// </summary>
public sealed class MeetingExpiryWorker(Db db, IOptions<MeetingOptions> options, IClock clock, ILogger<MeetingExpiryWorker> log) : BackgroundService
{
    static readonly TimeSpan PollInterval = TimeSpan.FromMinutes(5);
    // A LIVE meeting is only swept up well after its join window would in any case have closed (JoinWindow.Evaluate
    // already lets a genuinely overrunning LIVE call stay joinable indefinitely) - this is a crash/stuck-row safety
    // net, not a limit on how long a real meeting may run.
    const int IncompleteAfterExtraMinutes = 180;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        log.LogInformation("Meeting expiry worker started (sweep every {Minutes} min).", PollInterval.TotalMinutes);
        while (!stop.IsCancellationRequested)
        {
            try { await RunOnceAsync(stop); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Meeting expiry worker cycle failed."); }
            try { await Task.Delay(PollInterval, stop); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>One sweep. Returns (expired, incomplete) counts.</summary>
    public async Task<(int Expired, int Incomplete)> RunOnceAsync(CancellationToken ct)
    {
        var o = options.Value;
        var now = clock.UtcNow;
        using var c = await db.OpenAsync(ct);
        using var tx = c.BeginTransaction();

        // Nobody ever joined and the late-join window has fully closed: this meeting never happened.
        var expired = await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET [Status] = 'EXPIRED', ModifiedUtc = SYSUTCDATETIME()
            WHERE [Status] = 'SCHEDULED' AND ActualStartUtc IS NULL
              AND DATEADD(MINUTE, @lateMinutes, ScheduledEndUtc) <= @now
            """, new { lateMinutes = o.JoinLateMinutes, now }, tx);

        // Went live but was never properly ended and the webhook-driven auto-complete never fired either: stuck,
        // not merely running long.
        var incomplete = await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET [Status] = 'INCOMPLETE', ActualEndUtc = COALESCE(ActualEndUtc, @now), ModifiedUtc = SYSUTCDATETIME()
            WHERE [Status] = 'LIVE'
              AND DATEADD(MINUTE, @lateMinutes + @extra, ScheduledEndUtc) <= @now
            """, new { lateMinutes = o.JoinLateMinutes, extra = IncompleteAfterExtraMinutes, now }, tx);

        tx.Commit();
        if (expired > 0 || incomplete > 0) log.LogInformation("Meeting expiry sweep: {Expired} expired, {Incomplete} incomplete.", expired, incomplete);
        return (expired, incomplete);
    }
}
