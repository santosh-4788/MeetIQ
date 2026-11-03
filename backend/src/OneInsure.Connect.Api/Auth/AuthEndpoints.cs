using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Auth;

/// <summary>/api/v1/auth/* — the contract used by frontend/src/api/index.ts (httpAuthApi).</summary>
public static class AuthEndpoints
{
    public const string LoginRateLimit = "login";
    public const string PasswordResetRateLimit = "password-reset";

    public static RouteGroupBuilder MapAuthEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/auth");

        g.MapPost("/login", async (LoginRequest req, AuthService auth, HttpContext ctx, IOptions<SecurityOptions> o, CancellationToken ct) =>
        {
            var result = await auth.LoginAsync(req, ClientInfo.From(ctx), ctx.Request.Cookies[Cookies.TrustedDevice], ct);
            return result switch
            {
                AuthOutcome.Failure f => Problems.Create(f.Status, f.Code, f.Message, f.Details),
                AuthOutcome.MfaRequired m => Results.Ok(new { status = "MFA_REQUIRED", mfaToken = m.MfaToken, methods = m.Methods, maskedEmail = m.MaskedEmail }),
                AuthOutcome.Success s => SignedIn(ctx, o.Value, s, s.MustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "SUCCESS"),
                _ => throw new InvalidOperationException(),
            };
        }).RequireRateLimiting(LoginRateLimit);

        g.MapPost("/mfa/verify", async (MfaVerifyRequest req, AuthService auth, HttpContext ctx, IOptions<SecurityOptions> o, CancellationToken ct) =>
        {
            var result = await auth.VerifyMfaAsync(req, ClientInfo.From(ctx), ct);
            if (result is AuthOutcome.Failure f) return Problems.Create(f.Status, f.Code, f.Message, f.Details);
            var s = (AuthOutcome.Success)result;
            if (s.TrustedDeviceToken is { } trust) Cookies.SetTrustedDevice(ctx.Response, o.Value, trust);
            SignedIn(ctx, o.Value, s, "");
            return Results.Ok(s.User); // the UI then routes on user.mustChangePassword
        }).RequireRateLimiting(LoginRateLimit);

        g.MapGet("/me", async (AuthService auth, HttpContext ctx, CancellationToken ct) =>
            await auth.GetUserSummaryAsync(ctx.User.UserId(), ct) is { } u ? Results.Ok(u) : Problems.Create(401, "UNAUTHORIZED", "Please sign in."))
            .RequireSession().WithMetadata(new AllowPendingPasswordChangeAttribute());

        g.MapPost("/logout", async (AuthService auth, HttpContext ctx, IOptions<SecurityOptions> o, CancellationToken ct) =>
        {
            if (ctx.User.Identity?.IsAuthenticated == true)
                await auth.LogoutAsync(ctx.User.UserId(), ctx.User.SessionId(), ClientInfo.From(ctx), ct);
            Cookies.ClearSession(ctx.Response, o.Value);
            Cookies.SetXsrf(ctx.Response, o.Value);
            return Results.NoContent();
        }).AllowAnonymous().WithMetadata(new AllowPendingPasswordChangeAttribute());

        g.MapPost("/change-password", async (ChangePasswordRequest req, AuthService auth, HttpContext ctx, CancellationToken ct) =>
            await auth.ChangePasswordAsync(ctx.User.UserId(), ctx.User.SessionId(), req, ClientInfo.From(ctx), ct) is { } f
                ? Problems.Create(f.Status, f.Code, f.Message, f.Details)
                : Results.NoContent())
            .RequireSession().WithMetadata(new AllowPendingPasswordChangeAttribute()).RequireRateLimiting(PasswordResetRateLimit);

        g.MapPost("/forgot-password", async (ForgotPasswordRequest req, AuthService auth, HttpContext ctx, CancellationToken ct) =>
        {
            await auth.ForgotPasswordAsync(req, ClientInfo.From(ctx), ct);
            return Results.NoContent(); // identical response whether or not the account exists
        }).RequireRateLimiting(PasswordResetRateLimit);

        g.MapPost("/reset-password", async (ResetPasswordRequest req, AuthService auth, HttpContext ctx, CancellationToken ct) =>
            await auth.ResetPasswordAsync(req, ClientInfo.From(ctx), ct) is { } f
                ? Problems.Create(f.Status, f.Code, f.Message, f.Details)
                : Results.NoContent())
            .RequireRateLimiting(PasswordResetRateLimit);

        g.MapPost("/mfa/resend", async (MfaResendRequest req, MfaService mfa) =>
        {
            if (mfa.ReadLoginToken(req.MfaToken) is not { } t) return Problems.Create(400, "MFA_EXPIRED", "The verification step has expired. Sign in again.");
            return await mfa.SendEmailOtpAsync(t) switch
            {
                null => Results.NoContent(),
                "RATE_LIMITED" => Problems.Create(429, "RATE_LIMITED", "A code was sent less than a minute ago. Please wait before requesting another."),
                _ => Problems.Create(400, "MFA_EXPIRED", "E-mail codes are not available. Use your authenticator app."),
            };
        }).RequireRateLimiting(PasswordResetRateLimit);

        return api;
    }

    static IResult SignedIn(HttpContext ctx, SecurityOptions o, AuthOutcome.Success s, string status)
    {
        Cookies.SetSession(ctx.Response, o, s.SessionToken, s.PersistentUntilUtc);
        Cookies.SetXsrf(ctx.Response, o); // rotate on privilege change
        return Results.Ok(new { status, user = s.User });
    }

    /// <summary>/api/v1/account/* — the signed-in user's own security settings (Settings page).</summary>
    public static RouteGroupBuilder MapAccountEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/account").RequireSession();

        g.MapGet("/mfa", (MfaService mfa, HttpContext ctx) => mfa.StatusAsync(ctx.User.UserId()));

        g.MapPost("/mfa/totp/setup", async (PasswordConfirm req, MfaService mfa, HttpContext ctx) =>
        {
            var (result, error) = await mfa.SetupAsync(ctx.User.UserId(), req.CurrentPassword ?? "");
            return error switch
            {
                null => Results.Ok(result),
                "INVALID_CREDENTIALS" => Problems.Create(400, "INVALID_CREDENTIALS", "The current password is incorrect."),
                _ => Problems.Create(409, "CONFLICT", "The authenticator app is already enabled. Disable it first to set up a new one."),
            };
        }).RequireRateLimiting(PasswordResetRateLimit);

        g.MapPost("/mfa/totp/confirm", async (CodeConfirm req, MfaService mfa, HttpContext ctx) =>
            await mfa.ConfirmAsync(ctx.User.UserId(), req.Code ?? "", ClientInfo.From(ctx).Ip) is { } codes
                ? Results.Ok(new { recoveryCodes = codes })
                : Problems.Create(400, "INVALID_MFA_CODE", "The verification code is incorrect or expired. Check the time on your phone and try again."))
            .RequireRateLimiting(LoginRateLimit);

        g.MapPost("/mfa/recovery-codes", async (CodeConfirm req, MfaService mfa, HttpContext ctx) =>
            await mfa.RegenerateRecoveryCodesAsync(ctx.User.UserId(), req.Code ?? "", ClientInfo.From(ctx).Ip) is { } codes
                ? Results.Ok(new { recoveryCodes = codes })
                : Problems.Create(400, "INVALID_MFA_CODE", "The verification code is incorrect."))
            .RequireRateLimiting(LoginRateLimit);

        g.MapPost("/mfa/disable", async (DisableMfa req, MfaService mfa, HttpContext ctx) =>
            await mfa.DisableSelfAsync(ctx.User.UserId(), req.CurrentPassword ?? "", req.Code ?? "", ClientInfo.From(ctx).Ip) switch
            {
                null => Results.NoContent(),
                "INVALID_CREDENTIALS" => Problems.Create(400, "INVALID_CREDENTIALS", "The current password is incorrect."),
                _ => Problems.Create(400, "INVALID_MFA_CODE", "The verification code is incorrect."),
            }).RequireRateLimiting(LoginRateLimit);

        g.MapGet("/sessions", async (Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var current = ctx.User.SessionId();
            var rows = await Dapper.SqlMapper.QueryAsync<SessionRow>(c, """
                SELECT SessionId, CreatedUtc, LastSeenUtc, IpAddress, UserAgent FROM auth.UserSessions
                WHERE UserId = @userId AND RevokedUtc IS NULL AND ExpiresUtc > SYSUTCDATETIME() AND AbsoluteExpiryUtc > SYSUTCDATETIME()
                ORDER BY LastSeenUtc DESC
                """, new { userId = ctx.User.UserId() });
            return rows.Select(r => new
            {
                id = r.SessionId, createdUtc = Utc(r.CreatedUtc), lastSeenUtc = Utc(r.LastSeenUtc), ipAddress = r.IpAddress, userAgent = r.UserAgent,
                current = r.SessionId == current,
            });
        });

        g.MapPost("/sessions/{id:guid}/revoke", async (Guid id, Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var n = await Dapper.SqlMapper.ExecuteAsync(c,
                "UPDATE auth.UserSessions SET RevokedUtc = SYSUTCDATETIME(), RevokedReason = 'USER_REVOKED' WHERE SessionId = @id AND UserId = @userId AND RevokedUtc IS NULL",
                new { id, userId = ctx.User.UserId() });
            return n == 1 ? Results.NoContent() : Problems.Create(404, "NOT_FOUND", "Session not found.");
        });

        return api;
    }

    sealed record SessionRow(Guid SessionId, DateTime CreatedUtc, DateTime LastSeenUtc, string? IpAddress, string? UserAgent);
    public sealed record PasswordConfirm(string? CurrentPassword);
    public sealed record MfaResendRequest(string? MfaToken, string? Method);
    public sealed record CodeConfirm(string? Code);
    public sealed record DisableMfa(string? CurrentPassword, string? Code);
    static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);
}
