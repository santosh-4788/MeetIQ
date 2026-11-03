using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Tests;

[Collection(ApiCollection.Name)]
public sealed class EmailTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    Task<int> RunWorker() => fx.Factory.Services.GetRequiredService<EmailOutboxWorker>().RunOnceAsync(CancellationToken.None);

    [Fact]
    public async Task Outbox_is_delivered_through_the_mail_procedure_with_its_parameters()
    {
        var c = await fx.NewClientAsync();
        await c.PostAsync("/api/v1/auth/forgot-password", new { login = "victim@test.invalid" });
        Assert.True(await RunWorker() >= 1);

        Assert.Equal(1, await fx.QueryAsync<int>("""
            SELECT COUNT(*) FROM dbo.TestSentMail WHERE [To] = 'victim@test.invalid' AND Subject = 'Reset your OneInsure Connect password'
              AND [From] = 'support@oneinsure.com' AND ReplyTo = 'support@oneinsure.com' AND TemplateId = 103 AND Body LIKE '%reset-password?token=%'
            """));
        Assert.Equal("SENT", await fx.QueryAsync<string>("SELECT TOP (1) [Status] FROM app.EmailOutbox WHERE ToAddress = N'victim@test.invalid' ORDER BY OutboxId DESC"));
        Assert.True(await fx.QueryAsync<bool>("SELECT TOP (1) d.Succeeded FROM app.EmailDeliveryLog d JOIN app.EmailOutbox o ON o.OutboxId = d.OutboxId WHERE o.ToAddress = N'victim@test.invalid' ORDER BY d.DeliveryId DESC"));
        Assert.Equal(0, await RunWorker()); // nothing is sent twice
    }

    [Fact]
    public async Task Failed_delivery_is_logged_and_retried_later_not_immediately()
    {
        await fx.QueryAsync<int>("""
            INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml) VALUES ('TEST', N'fail.me@test.invalid', N'Retry test', N'<p>x</p>');
            SELECT 1;
            """);
        await RunWorker();
        Assert.Equal("FAILED", await fx.QueryAsync<string>("SELECT [Status] FROM app.EmailOutbox WHERE ToAddress = N'fail.me@test.invalid'"));
        Assert.True(await fx.QueryAsync<bool>("SELECT CASE WHEN NextAttemptUtc > SYSUTCDATETIME() THEN 1 ELSE 0 END FROM app.EmailOutbox WHERE ToAddress = N'fail.me@test.invalid'"));
        Assert.Contains("rejected", await fx.QueryAsync<string>("SELECT TOP (1) d.ErrorMessage FROM app.EmailDeliveryLog d JOIN app.EmailOutbox o ON o.OutboxId = d.OutboxId WHERE o.ToAddress = N'fail.me@test.invalid'"));
        await RunWorker();
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT Attempts FROM app.EmailOutbox WHERE ToAddress = N'fail.me@test.invalid'")); // back-off respected
    }

    [Fact]
    public async Task Email_code_works_as_second_factor_with_resend_cooldown()
    {
        // Enrol the authenticator first (two-factor is opt-in through the authenticator app).
        var c = await fx.NewClientAsync();
        await c.LoginAsync("otp@test.invalid", Pw);
        var setup = await Json(await c.PostAsync("/api/v1/account/mfa/totp/setup", new { currentPassword = Pw }));
        var secret = Base32Decode(setup.GetProperty("secret").GetString()!);
        await c.PostAsync("/api/v1/account/mfa/totp/confirm", new { code = Totp.Code(secret, Totp.TimeStep(DateTime.UtcNow)) });

        var b = await fx.NewClientAsync();
        var step = await Json(await b.LoginAsync("otp@test.invalid", Pw));
        Assert.Contains("EMAIL_OTP", step.GetProperty("methods").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal("ot***@test.invalid", step.GetProperty("maskedEmail").GetString());
        var token = step.GetProperty("mfaToken").GetString()!;

        Assert.Equal(HttpStatusCode.NoContent, (await b.PostAsync("/api/v1/auth/mfa/resend", new { mfaToken = token, method = "EMAIL_OTP" })).StatusCode);
        Assert.Equal((HttpStatusCode)429, (await b.PostAsync("/api/v1/auth/mfa/resend", new { mfaToken = token, method = "EMAIL_OTP" })).StatusCode);
        await RunWorker();
        var body = await fx.QueryAsync<string>("SELECT TOP (1) Body FROM dbo.TestSentMail WHERE [To] = 'otp@test.invalid' ORDER BY Id DESC");
        var code = Regex.Match(body, @"<b[^>]*>(\d{6})</b>").Groups[1].Value;

        Assert.Equal(HttpStatusCode.BadRequest, (await b.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = token, code = code == "000000" ? "111111" : "000000", method = "EMAIL_OTP" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await b.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = token, code, method = "EMAIL_OTP" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await b.Http.GetAsync("/api/v1/auth/me")).StatusCode);
    }

    [Theory]
    [InlineData("dbo.Util_SendEmail2", true)]
    [InlineData("[MailDb].dbo.Util_SendEmail2", true)]
    [InlineData("dbo.Util_SendEmail2; DROP TABLE x", false)]
    [InlineData("a.b.c.d", false)]
    public void Procedure_name_is_validated(string name, bool ok) => Assert.Equal(ok, new EmailOptions { Procedure = name }.ProcedureNameIsSafe());

    static byte[] Base32Decode(string s)
    {
        const string a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var bytes = new List<byte>(); int buffer = 0, bits = 0;
        foreach (var ch in s) { buffer = (buffer << 5) | a.IndexOf(ch); bits += 5; if (bits >= 8) { bytes.Add((byte)(buffer >> (bits - 8))); bits -= 8; } }
        return bytes.ToArray();
    }
}
