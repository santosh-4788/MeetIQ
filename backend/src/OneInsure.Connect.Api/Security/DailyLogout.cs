using System.Collections.Concurrent;
using System.Globalization;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Security;

/// <summary>Security:DailyLogout - every employee portal session ends at a fixed local time each day (default 23:30 Asia/Kolkata).</summary>
public sealed class DailyLogoutOptions
{
    public bool Enabled { get; set; } = true;
    /// <summary>Local time of day, "HH:mm".</summary>
    public string Time { get; set; } = "23:30";
    public string TimeZoneId { get; set; } = "Asia/Kolkata";
    /// <summary>How long before the cutoff the portal warns the user.</summary>
    public int WarningMinutes { get; set; } = 5;
}

/// <summary>
/// Daily security reset of portal sessions. A session created before the most recent cutoff (e.g. 23:30 IST) is no longer accepted
/// (enforced on every request by <see cref="SessionAuthenticationHandler"/>, so it takes effect at the cutoff itself) and is marked
/// revoked in auth.UserSessions by the sweep below (reason DAILY_LOGOUT), which also writes the audit entry. Users signing in after
/// the cutoff keep their new session. Meeting media (LiveKit) and server-side recordings do not use the portal session and are not
/// touched: someone in a call keeps their audio/video, while host controls need a fresh sign-in.
///
/// Test mode: an administrator (admin.ops) can schedule a cutoff a few minutes ahead FOR THEIR OWN ACCOUNT ONLY
/// (POST /admin/ops/daily-logout/test). It never changes the configured time or anyone else's session, and is kept in memory only.
/// </summary>
public sealed class DailyLogoutService(Db db, IClock clock, IOptionsMonitor<DailyLogoutOptions> options, ILogger<DailyLogoutService> log) : BackgroundService
{
    static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);
    readonly ConcurrentDictionary<long, DateTime> testCutoffs = new();

    DailyLogoutOptions O => options.CurrentValue;

    TimeZoneInfo Zone => TimeZoneInfo.TryFindSystemTimeZoneById(O.TimeZoneId, out var tz) ? tz
        : TimeZoneInfo.TryFindSystemTimeZoneById("India Standard Time", out var ist) ? ist : TimeZoneInfo.Utc;

    TimeSpan TimeOfDay => TimeSpan.TryParseExact(O.Time, @"hh\:mm", CultureInfo.InvariantCulture, out var t) ? t : new TimeSpan(23, 30, 0);

    /// <summary>The most recent cutoff at or before <paramref name="utc"/> (UTC), or null when the daily logout is switched off.</summary>
    public DateTime? LastCutoffUtc(DateTime utc)
    {
        if (!O.Enabled) return null;
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Zone);
        var cut = local.Date + TimeOfDay;
        if (cut > local) cut = cut.AddDays(-1);
        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(cut, DateTimeKind.Unspecified), Zone);
    }

    /// <summary>The next cutoff after <paramref name="utc"/>, or null when switched off.</summary>
    public DateTime? NextCutoffUtc(DateTime utc) => LastCutoffUtc(utc) is { } last ? NextAfter(last) : null;

    DateTime NextAfter(DateTime lastUtc)
    {
        var local = TimeZoneInfo.ConvertTimeFromUtc(lastUtc, Zone).AddDays(1);
        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), Zone);
    }

    /// <summary>The cutoff this user's session must have been created after to remain valid (real cutoff, or a due test cutoff).</summary>
    public DateTime? EffectiveCutoffUtc(long userId, DateTime nowUtc)
    {
        var real = LastCutoffUtc(nowUtc);
        if (testCutoffs.TryGetValue(userId, out var t) && t <= nowUtc && (real is null || t > real)) return t;
        return real;
    }

    /// <summary>The next cutoff this user will see (a pending test cutoff wins if it is earlier).</summary>
    public (DateTime? Utc, bool Test) NextForUser(long userId, DateTime nowUtc)
    {
        var real = NextCutoffUtc(nowUtc);
        if (testCutoffs.TryGetValue(userId, out var t) && t > nowUtc && (real is null || t < real)) return (t, true);
        return (real, false);
    }

    public int WarningMinutes => Math.Clamp(O.WarningMinutes, 1, 60);
    public string Describe() => $"{O.Time} {O.TimeZoneId}";

    public DateTime ScheduleTest(long userId, int minutes)
    {
        var at = clock.UtcNow.AddMinutes(Math.Clamp(minutes, 1, 60));
        testCutoffs[userId] = at;
        return at;
    }

    public bool CancelTest(long userId) => testCutoffs.TryRemove(userId, out _);

    /// <summary>Tests only: a test cutoff at an exact instant (may be in the past, to make it due at once).</summary>
    internal void ScheduleTestAtUtc(long userId, DateTime atUtc) => testCutoffs[userId] = atUtc;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        log.LogInformation("Daily logout: {Enabled} at {Time} ({Zone}).", O.Enabled ? "enabled" : "disabled", O.Time, O.TimeZoneId);
        while (!stop.IsCancellationRequested)
        {
            try { await RunOnceAsync(stop); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Daily logout sweep failed."); }
            try { await Task.Delay(PollInterval, stop); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// Marks sessions from before the last cutoff as revoked (idempotent: a session created after the cutoff is never touched,
    /// and an already-revoked one is skipped). Returns the number of sessions ended by this run.
    /// </summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        var now = clock.UtcNow;
        var total = 0;
        using var c = await db.OpenAsync(ct);
        if (LastCutoffUtc(now) is { } cutoff)
        {
            var n = await c.ExecuteAsync("""
                UPDATE auth.UserSessions SET RevokedUtc = @now, RevokedReason = 'DAILY_LOGOUT'
                WHERE RevokedUtc IS NULL AND CreatedUtc < @cutoff AND AbsoluteExpiryUtc > @now
                """, new { now, cutoff });
            if (n > 0)
            {
                total += n;
                log.LogInformation("Daily logout: {Count} session(s) ended (cutoff {Cutoff:O}).", n, cutoff);
                await Audit.WriteAsync(c, "SYSTEM", null, "SESSIONS_DAILY_LOGOUT", "Session", null,
                    $"Daily security reset: {n} portal session(s) ended at the {Describe()} cutoff", null, newValues: new { count = n, cutoffUtc = cutoff });
            }
        }
        foreach (var (userId, at) in testCutoffs.ToArray())
        {
            if (at > now) continue;
            var n = await c.ExecuteAsync("""
                UPDATE auth.UserSessions SET RevokedUtc = @now, RevokedReason = 'DAILY_LOGOUT_TEST'
                WHERE RevokedUtc IS NULL AND UserId = @userId AND CreatedUtc < @at AND AbsoluteExpiryUtc > @now
                """, new { now, userId, at });
            // Keep the entry for a while so a request racing the sweep is still rejected; then forget it.
            if (now - at > TimeSpan.FromMinutes(2)) testCutoffs.TryRemove(userId, out _);
            if (n > 0)
            {
                total += n;
                await Audit.WriteAsync(c, "SYSTEM", null, "SESSIONS_DAILY_LOGOUT_TEST", "User", userId.ToString(CultureInfo.InvariantCulture),
                    $"Daily logout TEST: {n} session(s) of this administrator ended (test mode, own account only)", null, newValues: new { count = n, cutoffUtc = at });
            }
        }
        return total;
    }

    /// <summary>How many active sessions the last real cutoff applies to right now (nothing is changed).</summary>
    public async Task<int> DryRunAsync(CancellationToken ct)
    {
        var now = clock.UtcNow;
        if (LastCutoffUtc(now) is not { } cutoff) return 0;
        using var c = await db.OpenAsync(ct);
        return await c.ExecuteScalarAsync<int>("""
            SELECT COUNT(*) FROM auth.UserSessions WHERE RevokedUtc IS NULL AND CreatedUtc < @cutoff AND AbsoluteExpiryUtc > @now AND ExpiresUtc > @now
            """, new { now, cutoff });
    }
}

public static class DailyLogoutEndpoints
{
    public sealed record TestInput(int Minutes);

    public static RouteGroupBuilder MapDailyLogoutEndpoints(this RouteGroupBuilder api)
    {
        // The portal's session facts: when it ends (idle / absolute / daily reset) and the server's clock, so the browser can warn
        // in time even if the PC's clock is off. Calling it also slides the idle window, like any authenticated request.
        api.MapGet("/auth/session", async (HttpContext ctx, DailyLogoutService daily, IClock clock, Db db, IOptions<SecurityOptions> sec, CancellationToken ct) =>
        {
            var now = clock.UtcNow;
            using var c = await db.OpenAsync(ct);
            var s = await c.QuerySingleOrDefaultAsync<(DateTime ExpiresUtc, DateTime AbsoluteExpiryUtc)?>(
                "SELECT ExpiresUtc, AbsoluteExpiryUtc FROM auth.UserSessions WHERE SessionId = @id", new { id = ctx.User.SessionId() });
            var (next, test) = daily.NextForUser(ctx.User.UserId(), now);
            return Results.Ok(new
            {
                serverNowUtc = now,
                idleMinutes = sec.Value.SessionIdleMinutes,
                idleExpiresUtc = s?.ExpiresUtc,
                absoluteExpiryUtc = s?.AbsoluteExpiryUtc,
                dailyLogoutUtc = next,
                dailyLogoutTest = test,
                dailyLogoutDescription = daily.Describe(),
                warningMinutes = daily.WarningMinutes,
            });
        }).RequireSession().WithMetadata(new AllowPendingPasswordChangeAttribute());

        var ops = api.MapGroup("/admin/ops/daily-logout").RequirePermission("admin.ops");
        ops.MapPost("/test", async (TestInput input, HttpContext ctx, DailyLogoutService daily, Db db, CancellationToken ct) =>
        {
            var userId = ctx.User.UserId();
            var at = daily.ScheduleTest(userId, input.Minutes);
            using var c = await db.OpenAsync(ct);
            await Audit.WriteAsync(c, "USER", userId, "DAILY_LOGOUT_TEST_SCHEDULED", "User", userId.ToString(CultureInfo.InvariantCulture),
                $"Daily logout test scheduled for the administrator's own sessions in {Math.Clamp(input.Minutes, 1, 60)} minute(s)", ClientInfo.From(ctx).Ip,
                newValues: new { atUtc = at });
            return Results.Ok(new { testLogoutUtc = at, scope = "your own sessions only", productionTime = daily.Describe() });
        });
        ops.MapDelete("/test", (HttpContext ctx, DailyLogoutService daily) => Results.Ok(new { cancelled = daily.CancelTest(ctx.User.UserId()) }));
        ops.MapGet("/status", async (DailyLogoutService daily, IClock clock, CancellationToken ct) =>
        {
            var now = clock.UtcNow;
            return Results.Ok(new
            {
                configured = daily.Describe(), lastCutoffUtc = daily.LastCutoffUtc(now), nextCutoffUtc = daily.NextCutoffUtc(now),
                warningMinutes = daily.WarningMinutes, activeSessionsFromBeforeLastCutoff = await daily.DryRunAsync(ct),
            });
        });
        return api;
    }
}
