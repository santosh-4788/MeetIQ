using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Tests;

/// <summary>Daily security reset of portal sessions (default 23:30 Asia/Kolkata): cutoff arithmetic and the administrator test mode.</summary>
public sealed class DailyLogoutCutoffTests
{
    sealed class Monitor(DailyLogoutOptions o) : IOptionsMonitor<DailyLogoutOptions>
    {
        public DailyLogoutOptions CurrentValue => o;
        public DailyLogoutOptions Get(string? name) => o;
        public IDisposable? OnChange(Action<DailyLogoutOptions, string?> listener) => null;
    }

    static DailyLogoutService Service(DailyLogoutOptions? o = null) =>
        new(new Db("Server=unused"), new SystemClock(), new Monitor(o ?? new DailyLogoutOptions()), NullLogger<DailyLogoutService>.Instance);

    static DateTime Utc(int y, int mo, int d, int h, int mi) => new(y, mo, d, h, mi, 0, DateTimeKind.Utc);

    [Fact]
    public void Cutoff_is_2330_india_standard_time_which_is_1800_utc()
    {
        var s = Service();
        // 11 Nov 15:00 IST (09:30 UTC): the last cutoff was 10 Nov 23:30 IST = 10 Nov 18:00 UTC, the next is 11 Nov 18:00 UTC.
        Assert.Equal(Utc(2026, 11, 10, 18, 0), s.LastCutoffUtc(Utc(2026, 11, 11, 9, 30)));
        Assert.Equal(Utc(2026, 11, 11, 18, 0), s.NextCutoffUtc(Utc(2026, 11, 11, 9, 30)));
        // One minute before / exactly at / after 23:30 IST.
        Assert.Equal(Utc(2026, 11, 10, 18, 0), s.LastCutoffUtc(Utc(2026, 11, 11, 17, 59)));
        Assert.Equal(Utc(2026, 11, 11, 18, 0), s.LastCutoffUtc(Utc(2026, 11, 11, 18, 0)));
        Assert.Equal(Utc(2026, 11, 12, 18, 0), s.NextCutoffUtc(Utc(2026, 11, 11, 18, 1)));
        // Just after midnight IST (18:31 UTC the previous day) the last cutoff is the one an hour earlier.
        Assert.Equal(Utc(2026, 11, 11, 18, 0), s.LastCutoffUtc(Utc(2026, 11, 11, 18, 31)));
    }

    [Fact]
    public void Time_and_zone_are_configurable_and_it_can_be_switched_off()
    {
        Assert.Equal(Utc(2026, 11, 11, 16, 30), Service(new DailyLogoutOptions { Time = "22:00" }).LastCutoffUtc(Utc(2026, 11, 11, 17, 0)));
        Assert.Null(Service(new DailyLogoutOptions { Enabled = false }).LastCutoffUtc(Utc(2026, 11, 11, 17, 0)));
        Assert.Null(Service(new DailyLogoutOptions { Enabled = false }).NextCutoffUtc(Utc(2026, 11, 11, 17, 0)));
    }

    [Fact]
    public void A_test_cutoff_applies_to_that_user_only_and_never_moves_the_real_time()
    {
        var s = Service();
        var now = DateTime.UtcNow;
        var at = s.ScheduleTest(userId: 7, minutes: 3);
        Assert.Equal((at, true), s.NextForUser(7, now));
        Assert.False(s.NextForUser(8, now).Test); // another user still sees the real 23:30 cutoff
        Assert.Equal(s.LastCutoffUtc(now), s.EffectiveCutoffUtc(8, now.AddMinutes(4)));
        Assert.Equal(at, s.EffectiveCutoffUtc(7, at.AddSeconds(1)));
        Assert.Equal(s.NextCutoffUtc(now), s.NextForUser(8, now).Utc);
        Assert.True(s.CancelTest(7));
        Assert.False(s.NextForUser(7, now).Test);
    }
}

[Collection(ApiCollection.Name)]
public sealed class DailyLogoutApiTests(ApiFixture fx)
{
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();

    [Fact]
    public async Task Session_info_reports_the_next_cutoff_and_an_admin_test_logout_ends_only_their_own_sessions()
    {
        var admin = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await admin.LoginAsync("second.super@test.invalid", ApiFixture.Password)).StatusCode);
        var other = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await other.LoginAsync("employee@test.invalid", ApiFixture.Password)).StatusCode);

        var info = await Json(await admin.Http.GetAsync("/api/v1/auth/session"));
        Assert.Equal("23:30 Asia/Kolkata", info.GetProperty("dailyLogoutDescription").GetString());
        Assert.False(info.GetProperty("dailyLogoutTest").GetBoolean());
        Assert.Equal(18, info.GetProperty("dailyLogoutUtc").GetDateTime().ToUniversalTime().Hour); // 23:30 IST = 18:00 UTC

        // Employees cannot use the test mode.
        Assert.Equal(HttpStatusCode.Forbidden, (await other.PostAsync("/api/v1/admin/ops/daily-logout/test", new { minutes = 1 })).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync("/api/v1/admin/ops/daily-logout/test", new { minutes = 1 })).StatusCode);
        Assert.True((await Json(await admin.Http.GetAsync("/api/v1/auth/session"))).GetProperty("dailyLogoutTest").GetBoolean());

        // Make the test cutoff due without waiting a minute (sessions dated 5 minutes back, cutoff 1 second ago), then sweep.
        var daily = fx.Factory.Services.GetRequiredService<DailyLogoutService>();
        var adminId = await fx.QueryAsync<long>("SELECT UserId FROM auth.Users WHERE Email = 'second.super@test.invalid'");
        await using (var c = new SqlConnection(fx.ConnectionString))
            await c.ExecuteAsync("UPDATE auth.UserSessions SET CreatedUtc = DATEADD(MINUTE, -5, CreatedUtc) WHERE UserId = @adminId AND RevokedUtc IS NULL", new { adminId });
        daily.ScheduleTestAtUtc(adminId, DateTime.UtcNow.AddSeconds(-1));
        Assert.True(await daily.RunOnceAsync(CancellationToken.None) >= 1);

        // The administrator's session no longer reaches protected APIs (the invalidated cookie is refused)...
        Assert.Equal(HttpStatusCode.Unauthorized, (await admin.Http.GetAsync("/api/v1/auth/session")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await admin.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);
        Assert.True(await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.UserSessions WHERE UserId = @adminId AND RevokedReason = 'DAILY_LOGOUT_TEST'", new { adminId }) >= 1);
        // ...while everyone else is untouched, and the administrator can sign in again at once.
        Assert.Equal(HttpStatusCode.OK, (await other.Http.GetAsync("/api/v1/auth/session")).StatusCode);
        var again = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await again.LoginAsync("second.super@test.invalid", ApiFixture.Password)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await again.Http.GetAsync("/api/v1/auth/session")).StatusCode);
    }
}
