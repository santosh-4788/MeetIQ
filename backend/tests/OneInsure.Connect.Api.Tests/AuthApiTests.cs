using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OneInsure.Connect.Api.Tests;

[Collection(ApiCollection.Name)]
public sealed class AuthApiTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;

    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;

    [Fact]
    public async Task Me_without_session_is_401_problem()
    {
        var c = await fx.NewClientAsync();
        var r = await c.Http.GetAsync("/api/v1/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        Assert.Equal("UNAUTHORIZED", await Code(r));
    }

    [Fact]
    public async Task Login_success_sets_hardened_session_cookie_and_me_returns_user_with_role_permissions()
    {
        var c = await fx.NewClientAsync();
        var r = await c.LoginAsync("admin@test.invalid", Pw);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var body = await Json(r);
        Assert.Equal("SUCCESS", body.GetProperty("status").GetString());
        Assert.Equal("admin@test.invalid", body.GetProperty("user").GetProperty("email").GetString());

        var setCookie = string.Join("\n", r.Headers.GetValues("Set-Cookie"));
        Assert.Matches(new Regex("oic_session=[^;]+;.*httponly", RegexOptions.IgnoreCase), setCookie);
        Assert.Matches(new Regex("oic_session=[^;]+;.*samesite=strict", RegexOptions.IgnoreCase), setCookie);
        Assert.DoesNotContain("expires", setCookie.Split('\n').First(l => l.StartsWith("oic_session")), StringComparison.OrdinalIgnoreCase); // not "remember me"

        var me = await Json(await c.Http.GetAsync("/api/v1/auth/me"));
        var perms = me.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()).ToList();
        Assert.Contains("roles.manage", perms);
        Assert.DoesNotContain("recordings.view.all", perms); // wider recording access pending Compliance
        Assert.Equal("Admin", me.GetProperty("displayName").GetString()); // no employee profile: derived from the e-mail
        Assert.Equal(new[] { "SuperAdmin" }, me.GetProperty("roles").EnumerateArray().Select(x => x.GetString()!).ToArray());
    }

    [Fact]
    public async Task Login_by_employee_code_resolves_employee_profile()
    {
        var c = await fx.NewClientAsync();
        var r = await c.LoginAsync("TST-0001", Pw);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var user = (await Json(r)).GetProperty("user");
        Assert.Equal("Test Employee", user.GetProperty("displayName").GetString());
        Assert.Equal("Test Department", user.GetProperty("department").GetString());
        Assert.Equal("Test Executive", user.GetProperty("designation").GetString());
    }

    [Fact]
    public async Task Wrong_password_and_unknown_user_get_the_same_generic_401()
    {
        var c = await fx.NewClientAsync();
        var bad = await c.LoginAsync("employee@test.invalid", "Wrong#Password99");
        var unknown = await c.LoginAsync("nobody@test.invalid", "Wrong#Password99");
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, unknown.StatusCode);
        var a = await Json(bad); var b = await Json(unknown);
        Assert.Equal("INVALID_CREDENTIALS", a.GetProperty("code").GetString());
        Assert.Equal(a.GetProperty("detail").GetString(), b.GetProperty("detail").GetString());
        Assert.False(b.TryGetProperty("remainingAttempts", out _));
    }

    [Fact]
    public async Task Five_failures_lock_the_account_with_423_and_correct_password_is_then_refused()
    {
        var c = await fx.NewClientAsync();
        for (var i = 0; i < 4; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await c.LoginAsync("lockout@test.invalid", "Wrong#Password99")).StatusCode);
        var fifth = await c.LoginAsync("lockout@test.invalid", "Wrong#Password99");
        Assert.Equal((HttpStatusCode)423, fifth.StatusCode);
        Assert.True((await Json(fifth)).TryGetProperty("lockedUntilUtc", out _));

        var correct = await c.LoginAsync("lockout@test.invalid", Pw);
        Assert.Equal((HttpStatusCode)423, correct.StatusCode);
        Assert.Equal("ACCOUNT_LOCKED", await Code(correct));
        Assert.True(await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'ACCOUNT_LOCKED'") >= 1);
    }

    [Fact]
    public async Task Inactive_account_is_refused_only_after_correct_password()
    {
        var c = await fx.NewClientAsync();
        Assert.Equal("INVALID_CREDENTIALS", await Code(await c.LoginAsync("inactive@test.invalid", "Wrong#Password99")));
        var r = await c.LoginAsync("inactive@test.invalid", Pw);
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Equal("ACCOUNT_DISABLED", await Code(r));
    }

    [Fact]
    public async Task State_changing_requests_need_the_xsrf_header_and_an_allowed_origin()
    {
        var c = await fx.NewClientAsync();
        var noHeader = await c.PostAsync("/api/v1/auth/login", new { login = "admin@test.invalid", password = Pw }, withXsrf: false);
        Assert.Equal(HttpStatusCode.Forbidden, noHeader.StatusCode);

        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/auth/login") { Content = JsonContent.Create(new { login = "admin@test.invalid", password = Pw }) };
        req.Headers.Add("X-XSRF-TOKEN", c.Cookie("XSRF-TOKEN")!);
        req.Headers.Add("Origin", "https://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await c.Http.SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task Logout_revokes_the_session_server_side()
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync("logout@test.invalid", Pw)).StatusCode);
        var token = c.Cookie("oic_session")!;
        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/v1/auth/logout")).StatusCode);

        // Replaying the old cookie must not work (revoked in auth.UserSessions, not just deleted in the browser).
        var replay = await fx.NewClientAsync();
        replay.Jar.Add(new Uri("http://localhost"), new System.Net.Cookie("oic_session", token));
        Assert.Equal(HttpStatusCode.Unauthorized, (await replay.Http.GetAsync("/api/v1/auth/me")).StatusCode);
    }

    [Fact]
    public async Task Must_change_password_user_is_gated_until_changed()
    {
        var c = await fx.NewClientAsync();
        var r = await c.LoginAsync("mustchange@test.invalid", Pw);
        Assert.Equal("PASSWORD_CHANGE_REQUIRED", (await Json(r)).GetProperty("status").GetString());
        // The flag is reported on every /auth/me, so a reload or new tab still lands on the change-password screen.
        var meBefore = await Json(await c.Http.GetAsync("/api/v1/auth/me"));
        Assert.True(meBefore.GetProperty("mustChangePassword").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await c.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/v1/auth/change-password", new { currentPassword = Pw, newPassword = "Brand#New9Password" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);
        Assert.False((await Json(await c.Http.GetAsync("/api/v1/auth/me"))).GetProperty("mustChangePassword").GetBoolean());
    }

    [Fact]
    public async Task Change_password_enforces_policy_and_revokes_other_sessions()
    {
        var a = await fx.NewClientAsync();
        var b = await fx.NewClientAsync();
        await a.LoginAsync("change@test.invalid", Pw);
        await b.LoginAsync("change@test.invalid", Pw);

        var weak = await a.PostAsync("/api/v1/auth/change-password", new { currentPassword = Pw, newPassword = "short" });
        Assert.Equal("PASSWORD_POLICY", await Code(weak));
        var wrongCurrent = await a.PostAsync("/api/v1/auth/change-password", new { currentPassword = "Nope#Nope1234", newPassword = "Another#Strong9Pw" });
        Assert.Equal(HttpStatusCode.BadRequest, wrongCurrent.StatusCode);
        var same = await a.PostAsync("/api/v1/auth/change-password", new { currentPassword = Pw, newPassword = Pw });
        Assert.Equal("PASSWORD_POLICY", await Code(same));

        Assert.Equal(HttpStatusCode.NoContent, (await a.PostAsync("/api/v1/auth/change-password", new { currentPassword = Pw, newPassword = "Another#Strong9Pw" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await a.Http.GetAsync("/api/v1/auth/me")).StatusCode);          // this session kept
        Assert.Equal(HttpStatusCode.Unauthorized, (await b.Http.GetAsync("/api/v1/auth/me")).StatusCode); // other session revoked

        var fresh = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await fresh.LoginAsync("change@test.invalid", Pw)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await fresh.LoginAsync("change@test.invalid", "Another#Strong9Pw")).StatusCode);
    }

    [Fact]
    public async Task Forgot_and_reset_password_flow_is_single_use_and_does_not_enumerate()
    {
        var c = await fx.NewClientAsync();
        var outboxBefore = await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.EmailOutbox");
        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/v1/auth/forgot-password", new { login = "ghost@test.invalid" })).StatusCode);
        Assert.Equal(outboxBefore, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.EmailOutbox"));

        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/v1/auth/forgot-password", new { login = "reset@test.invalid" })).StatusCode);
        var body = await fx.QueryAsync<string>("SELECT TOP (1) BodyHtml FROM app.EmailOutbox WHERE ToAddress = N'reset@test.invalid' ORDER BY OutboxId DESC");
        var token = Uri.UnescapeDataString(Regex.Match(body, "token=([^\"&]+)").Groups[1].Value);
        Assert.False(string.IsNullOrEmpty(token));
        // Only the SHA-256 of the token is stored.
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.PasswordResetTokens WHERE TokenHash = HASHBYTES('SHA2_256', CAST(@token AS VARCHAR(200))) AND UsedUtc IS NULL", new { token }));

        Assert.Equal("PASSWORD_POLICY", await Code(await c.PostAsync("/api/v1/auth/reset-password", new { token, newPassword = "weak" })));
        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync("/api/v1/auth/reset-password", new { token, newPassword = "Fresh#Start42Now" })).StatusCode);
        Assert.Equal("INVALID_RESET_TOKEN", await Code(await c.PostAsync("/api/v1/auth/reset-password", new { token, newPassword = "Fresh#Again42Now" })));

        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync("reset@test.invalid", "Fresh#Start42Now")).StatusCode);
    }

    [Fact]
    public async Task Dashboard_requires_permission_and_returns_contract_shape()
    {
        var anon = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);

        var noperm = await fx.NewClientAsync();
        await noperm.LoginAsync("noperm@test.invalid", Pw);
        Assert.Equal(HttpStatusCode.Forbidden, (await noperm.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);

        var emp = await fx.NewClientAsync();
        await emp.LoginAsync("employee@test.invalid", Pw);
        var r = await emp.Http.GetAsync("/api/v1/dashboard/summary");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var d = await Json(r);
        foreach (var key in new[] { "generatedUtc", "kpis", "todaySchedule", "nextMeeting", "upcoming", "recentActivity", "departmentMeetings", "weeklyTrend", "attendance", "recordingStatus" })
            Assert.True(d.TryGetProperty(key, out _), $"missing {key}");
        Assert.Equal(7, d.GetProperty("weeklyTrend").GetArrayLength());
        Assert.True(d.GetProperty("kpis").GetProperty("totalEmployees").GetInt32() >= 1);
    }

    [Fact]
    public async Task Dashboard_upcoming_kpi_and_list_cover_the_next_7_days_only()
    {
        var host = await fx.NewClientAsync();
        await host.LoginAsync("mhost@test.invalid", Pw);
        var before = await Json(await host.Http.GetAsync("/api/v1/dashboard/summary"));
        var start = DateTime.UtcNow.Date.AddDays(10).AddHours(4).AddMinutes(17);
        var r = await host.PostAsync("/api/v1/meetings", new { title = "Far away", category = "GROUP", startUtc = start, endUtc = start.AddMinutes(30) });
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var id = (await Json(r)).GetProperty("id").GetString();
        var after = await Json(await host.Http.GetAsync("/api/v1/dashboard/summary"));
        // The UI labels both "Next 7 days": a meeting in 10 days must not be counted or listed.
        Assert.Equal(before.GetProperty("kpis").GetProperty("upcomingMeetings").GetInt32(), after.GetProperty("kpis").GetProperty("upcomingMeetings").GetInt32());
        Assert.DoesNotContain(after.GetProperty("upcoming").EnumerateArray(), m => m.GetProperty("id").GetString() == id);
        Assert.All(after.GetProperty("upcoming").EnumerateArray(), m => Assert.True(m.GetProperty("startUtc").GetDateTime() < DateTime.UtcNow.AddDays(7).AddMinutes(1)));
        await host.PostAsync($"/api/v1/meetings/{id}/cancel", new { reason = "test" });
    }

    [Fact]
    public async Task Api_responses_carry_security_headers()
    {
        var c = await fx.NewClientAsync();
        var r = await c.Http.GetAsync("/api/v1/auth/me");
        Assert.Equal("nosniff", r.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("DENY", r.Headers.GetValues("X-Frame-Options").Single());
        Assert.Contains("no-store", r.Headers.CacheControl!.ToString());
    }

    [Theory]
    [InlineData("santosh.yadav@oneinsure.com", "Santosh Yadav")]
    [InlineData("it_support-team@x.invalid", "It Support Team")]
    public void Display_name_falls_back_to_the_email_name(string email, string expected) =>
        Assert.Equal(expected, OneInsure.Connect.Api.Auth.AuthService.NameFromEmail(email));
}
