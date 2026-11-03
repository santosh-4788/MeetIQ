using System.Data;
using Dapper;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Auth;

/// <summary>Shapes match frontend/src/api/types.ts (UserSummary, LoginResult).</summary>
public sealed record UserSummary(
    string Id, string DisplayName, string Email, string EmployeeCode, string Department, string Designation,
    string[] Roles, string[] Permissions, string TimeZone, bool MustChangePassword, bool EmployeeLinked);

public sealed record LoginRequest(string? Login, string? Password, bool RememberMe);
public sealed record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);
public sealed record ForgotPasswordRequest(string? Login);
public sealed record ResetPasswordRequest(string? Token, string? NewPassword);

public sealed record ClientInfo(string? Ip, string? UserAgent)
{
    public static ClientInfo From(HttpContext ctx) => new(
        ctx.Connection.RemoteIpAddress?.ToString(),
        ctx.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua[..Math.Min(ua.Length, 512)] : null);
}

public abstract record AuthOutcome
{
    public sealed record Success(UserSummary User, string SessionToken, DateTime? PersistentUntilUtc, bool MustChangePassword, string? TrustedDeviceToken = null) : AuthOutcome;
    public sealed record MfaRequired(string MfaToken, string[] Methods, string? MaskedEmail) : AuthOutcome;
    public sealed record Failure(int Status, string Code, string Message, IDictionary<string, object?>? Details = null) : AuthOutcome;
}

public sealed record MfaVerifyRequest(string? MfaToken, string? Code, string? Method, bool RememberDevice);

public sealed class AuthService(Db db, Passwords passwords, IClock clock, IOptions<SecurityOptions> securityOptions,
    IOptions<PublicEndpointOptions> endpoints, IOptions<EmailOptions> emailOptions, MfaService mfa, ILogger<AuthService> log)
{
    const string InvalidCredentials = "The login ID or password is incorrect.";
    SecurityOptions Sec => securityOptions.Value;

    sealed record LoginRow(long UserId, string Email, string? EmployeeCode, string? PasswordHash, bool IsActive, bool IsLocked,
        DateTime? LockoutEndUtc, int FailedLoginCount, bool MustChangePassword, bool MfaEnabled, Guid SecurityStamp);

    public async Task<AuthOutcome> LoginAsync(LoginRequest req, ClientInfo client, string? trustedDeviceToken, CancellationToken ct)
    {
        var login = (req.Login ?? "").Trim();
        var password = req.Password ?? "";
        if (login.Length is 0 or > 254 || password.Length is 0 or > PasswordPolicy.MaxLength)
            return new AuthOutcome.Failure(401, "INVALID_CREDENTIALS", InvalidCredentials);

        using var c = await db.OpenAsync(ct);
        var u = await c.QuerySingleOrDefaultAsync<LoginRow>("""
            SELECT TOP (1) u.UserId, u.Email, COALESCE(u.EmployeeCode, e.EmployeeCode) AS EmployeeCode, u.PasswordHash, u.IsActive,
                   u.IsLocked, u.LockoutEndUtc, u.FailedLoginCount, u.MustChangePassword, u.MfaEnabled, u.SecurityStamp
            FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE (@isEmail = 1 AND u.Email = @login) OR (@isEmail = 0 AND (u.EmployeeCode = @login OR e.EmployeeCode = @login))
            """, new { login, isEmail = login.Contains('@') });
        var now = clock.UtcNow;

        if (u is null)
        {
            passwords.Verify(null, password); // equalise timing with the known-user path
            await RecordAttemptAsync(c, login, null, false, "UNKNOWN_LOGIN", client);
            return new AuthOutcome.Failure(401, "INVALID_CREDENTIALS", InvalidCredentials);
        }

        if (u.IsLocked || u.LockoutEndUtc > now)
        {
            await RecordAttemptAsync(c, login, u.UserId, false, "LOCKED", client);
            return Locked(u.IsLocked ? null : u.LockoutEndUtc);
        }

        var verify = passwords.Verify(u.PasswordHash, password);
        if (verify == PasswordVerificationResult.Failed)
            return await RegisterFailureAsync(c, login, u.UserId, "BAD_PASSWORD", client, new AuthOutcome.Failure(401, "INVALID_CREDENTIALS", InvalidCredentials));

        if (!u.IsActive)
        {
            await RecordAttemptAsync(c, login, u.UserId, false, "DISABLED", client);
            return new AuthOutcome.Failure(403, "ACCOUNT_DISABLED", "Your account has been deactivated.");
        }

        if (verify == PasswordVerificationResult.SuccessRehashNeeded)
            await c.ExecuteAsync("UPDATE auth.Users SET PasswordHash = @h WHERE UserId = @id", new { h = passwords.Hash(password), id = u.UserId });

        // Second factor: the session is only created after the code is verified (unless this browser is trusted).
        if (u.MfaEnabled && !mfa.IsTrustedDevice(trustedDeviceToken, u.UserId, u.SecurityStamp))
            return new AuthOutcome.MfaRequired(mfa.IssueLoginToken(u.UserId, req.RememberMe), mfa.LoginMethods, MfaService.MaskEmail(u.Email));

        return await CompleteLoginAsync(c, login, u.UserId, req.RememberMe, u.MustChangePassword, client, "Signed in");
    }

    async Task<AuthOutcome.Success> CompleteLoginAsync(IDbConnection c, string login, long userId, bool rememberMe, bool mustChangePassword,
        ClientInfo client, string summary, string? trustedDeviceToken = null)
    {
        await c.ExecuteAsync("UPDATE auth.Users SET FailedLoginCount = 0, LockoutEndUtc = NULL, LastLoginUtc = @now WHERE UserId = @id",
            new { now = clock.UtcNow, id = userId });
        await RecordAttemptAsync(c, login, userId, true, null, client);
        var (token, persistentUntil) = await CreateSessionAsync(c, userId, rememberMe, client);
        await Audit.WriteUserAsync(c, "USER", userId, "LOGIN", userId, summary, client.Ip);
        var user = (await GetUserSummaryAsync(c, userId))!;
        return new AuthOutcome.Success(user, token, persistentUntil, mustChangePassword, trustedDeviceToken);
    }

    /// <summary>Counts a failed password or MFA code; the threshold-th failure locks the account for LockoutMinutes (atomic).</summary>
    async Task<AuthOutcome.Failure> RegisterFailureAsync(IDbConnection c, string login, long userId, string reason, ClientInfo client, AuthOutcome.Failure failure)
    {
        var now = clock.UtcNow;
        var lockedUntil = await c.QuerySingleAsync<DateTime?>("""
            UPDATE auth.Users
            SET FailedLoginCount = CASE WHEN FailedLoginCount + 1 >= @threshold THEN 0 ELSE FailedLoginCount + 1 END,
                LockoutEndUtc    = CASE WHEN FailedLoginCount + 1 >= @threshold THEN @until ELSE LockoutEndUtc END
            OUTPUT inserted.LockoutEndUtc
            WHERE UserId = @id
            """, new { id = userId, threshold = Sec.LockoutThreshold, until = now.AddMinutes(Sec.LockoutMinutes) });
        var nowLocked = lockedUntil > now;
        await RecordAttemptAsync(c, login, userId, false, nowLocked ? "LOCKED_OUT" : reason, client);
        if (!nowLocked) return failure;
        await Audit.WriteUserAsync(c, "SYSTEM", null, "ACCOUNT_LOCKED", userId, "Locked after repeated failed sign-in attempts", client.Ip);
        return Locked(lockedUntil);
    }

    sealed record MfaUserRow(string Email, bool IsActive, bool IsLocked, DateTime? LockoutEndUtc, bool MustChangePassword, bool MfaEnabled, Guid SecurityStamp);

    /// <summary>Second sign-in step: TOTP code or a one-time recovery code. Failures count toward the account lockout.</summary>
    public async Task<AuthOutcome> VerifyMfaAsync(MfaVerifyRequest req, ClientInfo client, CancellationToken ct)
    {
        var expired = new AuthOutcome.Failure(400, "MFA_EXPIRED", "The verification step has expired. Sign in again.");
        if (mfa.ReadLoginToken(req.MfaToken) is not { } t) return expired;
        using var c = await db.OpenAsync(ct);
        var u = await c.QuerySingleOrDefaultAsync<MfaUserRow>(
            "SELECT Email, IsActive, IsLocked, LockoutEndUtc, MustChangePassword, MfaEnabled, SecurityStamp FROM auth.Users WHERE UserId = @id", new { id = t.UserId });
        if (u is null || !u.IsActive || !u.MfaEnabled) return expired;
        if (u.IsLocked || u.LockoutEndUtc > clock.UtcNow) return Locked(u.IsLocked ? null : u.LockoutEndUtc);

        var recovery = req.Method == "RECOVERY_CODE";
        var ok = req.Method switch
        {
            "RECOVERY_CODE" => await mfa.UseRecoveryCodeAsync(c, t.UserId, req.Code ?? ""),
            "EMAIL_OTP" => mfa.VerifyEmailOtp(t.Nonce, req.Code ?? ""),
            _ => await mfa.VerifyTotpAsync(c, t.UserId, req.Code ?? ""),
        };
        if (!ok)
        {
            mfa.CountFailedAttempt(t.Nonce);
            return await RegisterFailureAsync(c, u.Email, t.UserId, "BAD_MFA_CODE", client,
                new AuthOutcome.Failure(400, "INVALID_MFA_CODE", "The verification code is incorrect."));
        }
        mfa.ConsumeLoginToken(t.Nonce);
        var trust = req.RememberDevice ? mfa.IssueTrustedDeviceToken(t.UserId, u.SecurityStamp) : null;
        return await CompleteLoginAsync(c, u.Email, t.UserId, t.RememberMe, u.MustChangePassword, client,
            recovery ? "Signed in with a recovery code" : req.Method == "EMAIL_OTP" ? "Signed in with an e-mail code" : "Signed in with an authenticator code", trust);
    }

    AuthOutcome.Failure Locked(DateTime? untilUtc) => new(423, "ACCOUNT_LOCKED", "This account is temporarily locked.",
        new Dictionary<string, object?> { ["lockedUntilUtc"] = untilUtc is null ? null : DateTime.SpecifyKind(untilUtc.Value, DateTimeKind.Utc) });

    async Task<(string Token, DateTime? PersistentUntil)> CreateSessionAsync(IDbConnection c, long userId, bool rememberMe, ClientInfo client)
    {
        var now = clock.UtcNow;
        var absolute = rememberMe ? now.AddDays(Sec.RememberMeDays) : now.AddHours(Sec.SessionAbsoluteHours);
        var idle = now.AddMinutes(Sec.SessionIdleMinutes);
        var token = Tokens.New();
        await c.ExecuteAsync("""
            INSERT auth.UserSessions (SessionId, TokenHash, UserId, CreatedUtc, LastSeenUtc, ExpiresUtc, AbsoluteExpiryUtc, IpAddress, UserAgent)
            VALUES (NEWID(), @hash, @userId, @now, @now, @exp, @abs, @ip, @ua)
            """, new { hash = Tokens.Hash(token), userId, now, exp = idle < absolute ? idle : absolute, abs = absolute, ip = client.Ip, ua = client.UserAgent });
        return (token, rememberMe ? absolute : null);
    }

    public async Task LogoutAsync(long userId, Guid sessionId, ClientInfo client, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        await c.ExecuteAsync("UPDATE auth.UserSessions SET RevokedUtc = @now, RevokedReason = 'LOGOUT' WHERE SessionId = @sessionId AND RevokedUtc IS NULL",
            new { now = clock.UtcNow, sessionId });
        await Audit.WriteUserAsync(c, "USER", userId, "LOGOUT", userId, "Signed out", client.Ip);
    }

    public async Task<UserSummary?> GetUserSummaryAsync(long userId, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        return await GetUserSummaryAsync(c, userId);
    }

    sealed record SummaryRow(Guid PublicId, string? DisplayName, string Email, string? EmployeeCode, string? Department,
        string? Designation, string? Roles, string? Permissions, string TimeZoneId, bool MustChangePassword, bool EmployeeLinked);

    static async Task<UserSummary?> GetUserSummaryAsync(IDbConnection c, long userId)
    {
        var r = await c.QuerySingleOrDefaultAsync<SummaryRow>("""
            SELECT u.PublicId, e.DisplayName, u.Email,
                   COALESCE(u.EmployeeCode, e.EmployeeCode) AS EmployeeCode, d.Name AS Department, g.Name AS Designation,
                   (SELECT STRING_AGG(r.Code, ',') FROM auth.UserRoles ur JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = u.UserId) AS Roles,
                   (SELECT STRING_AGG(x.Code, ',') FROM (SELECT DISTINCT p.Code FROM auth.UserRoles ur
                        JOIN auth.RolePermissions rp ON rp.RoleId = ur.RoleId JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId
                        WHERE ur.UserId = u.UserId) x) AS Permissions,
                   u.TimeZoneId, u.MustChangePassword, CAST(CASE WHEN e.EmployeeId IS NULL THEN 0 ELSE 1 END AS BIT) AS EmployeeLinked
            FROM auth.Users u
            LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId
            LEFT JOIN org.Designations g ON g.DesignationId = e.DesignationId
            WHERE u.UserId = @userId
            """, new { userId });
        if (r is null) return null;
        static string[] Split(string? s) => (s ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Order().ToArray();
        return new UserSummary(r.PublicId.ToString(), r.DisplayName ?? NameFromEmail(r.Email), r.Email, r.EmployeeCode ?? "", r.Department ?? "",
            r.Designation ?? "", Split(r.Roles), Split(r.Permissions), r.TimeZoneId, r.MustChangePassword, r.EmployeeLinked);
    }

    sealed record PasswordRow(string? PasswordHash, string Email, string? EmployeeCode);
    sealed record ForgotRow(long UserId, string Email, string? Name);
    sealed record ResetRow(long TokenId, long UserId, string Email, string? EmployeeCode);

    /// <summary>Accounts without an employee profile (e.g. the first SuperAdmin): "santosh.yadav@x" -> "Santosh Yadav".</summary>
    internal static string NameFromEmail(string email)
    {
        var parts = email.Split('@')[0].Split(['.', '_', '-'], StringSplitOptions.RemoveEmptyEntries);
        var name = string.Join(' ', parts.Select(p => char.ToUpperInvariant(p[0]) + p[1..]));
        return name.Length > 0 ? name : email;
    }

    public async Task<AuthOutcome.Failure?> ChangePasswordAsync(long userId, Guid currentSessionId, ChangePasswordRequest req, ClientInfo client, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var u = await c.QuerySingleAsync<PasswordRow>(
            "SELECT u.PasswordHash, u.Email, COALESCE(u.EmployeeCode, e.EmployeeCode) AS EmployeeCode FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @userId",
            new { userId });
        if (passwords.Verify(u.PasswordHash, req.CurrentPassword ?? "") == PasswordVerificationResult.Failed)
            return new AuthOutcome.Failure(400, "INVALID_CREDENTIALS", "The current password is incorrect.");
        var newPassword = req.NewPassword ?? "";
        if (PolicyFailure(newPassword, u.Email, u.EmployeeCode) is { } bad) return bad;
        if (passwords.Verify(u.PasswordHash, newPassword) != PasswordVerificationResult.Failed)
            return new AuthOutcome.Failure(400, "PASSWORD_POLICY", "The new password must be different from the current one.",
                new Dictionary<string, object?> { ["violations"] = new[] { "Must differ from the current password" } });

        await SetPasswordAsync(c, userId, newPassword, keepSessionId: currentSessionId, reason: "PASSWORD_CHANGED");
        await Audit.WriteUserAsync(c, "USER", userId, "PASSWORD_CHANGED", userId, "Password changed; other sessions revoked", client.Ip);
        return null;
    }

    public async Task ForgotPasswordAsync(ForgotPasswordRequest req, ClientInfo client, CancellationToken ct)
    {
        var login = (req.Login ?? "").Trim();
        if (login.Length is 0 or > 254) return;
        using var c = await db.OpenAsync(ct);
        var u = await c.QuerySingleOrDefaultAsync<ForgotRow>("""
            SELECT TOP (1) u.UserId, u.Email, e.DisplayName AS Name FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE u.IsActive = 1 AND ((@isEmail = 1 AND u.Email = @login) OR (@isEmail = 0 AND (u.EmployeeCode = @login OR e.EmployeeCode = @login)))
            """, new { login, isEmail = login.Contains('@') });
        if (u is null) return; // same response either way: no account enumeration

        var now = clock.UtcNow;
        var token = Tokens.New();
        var link = $"{endpoints.Value.WebBaseUrl.TrimEnd('/')}/reset-password?token={Uri.EscapeDataString(token)}";
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("UPDATE auth.PasswordResetTokens SET UsedUtc = @now WHERE UserId = @id AND UsedUtc IS NULL", new { now, id = u.UserId }, tx);
        await c.ExecuteAsync("""
            INSERT auth.PasswordResetTokens (UserId, TokenHash, CreatedUtc, ExpiresUtc, RequestIp) VALUES (@id, @hash, @now, @exp, @ip)
            """, new { id = u.UserId, hash = Tokens.Hash(token), now, exp = now.AddMinutes(Sec.PasswordResetMinutes), ip = client.Ip }, tx);
        // Delivered by the e-mail worker (Phase 3). The outbox row holds the only copy of the raw token.
        await c.ExecuteAsync("""
            INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml) VALUES ('PASSWORD_RESET', @to, @subject, @body)
            """, new
        {
            to = u.Email,
            subject = "Reset your OneInsure Connect password",
            body = AccountEmails.PasswordReset(EmailBrand.From(emailOptions.Value), u.Name, link, Sec.PasswordResetMinutes),
        }, tx);
        await Audit.WriteUserAsync(c, "USER", u.UserId, "PASSWORD_RESET_REQUESTED", u.UserId, "Password reset requested", client.Ip, tx);
        tx.Commit();
        log.LogInformation("Password reset e-mail queued for user {UserId}", u.UserId);
    }

    public async Task<AuthOutcome.Failure?> ResetPasswordAsync(ResetPasswordRequest req, ClientInfo client, CancellationToken ct)
    {
        var invalid = new AuthOutcome.Failure(400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired. Request a new one.");
        if (string.IsNullOrEmpty(req.Token) || req.Token.Length > 200) return invalid;
        using var c = await db.OpenAsync(ct);
        var t = await c.QuerySingleOrDefaultAsync<ResetRow>("""
            SELECT t.TokenId, u.UserId, u.Email, COALESCE(u.EmployeeCode, e.EmployeeCode) AS EmployeeCode
            FROM auth.PasswordResetTokens t JOIN auth.Users u ON u.UserId = t.UserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE t.TokenHash = @hash AND t.UsedUtc IS NULL AND t.ExpiresUtc > @now AND u.IsActive = 1
            """, new { hash = Tokens.Hash(req.Token), now = clock.UtcNow });
        if (t is null) return invalid;
        var newPassword = req.NewPassword ?? "";
        if (PolicyFailure(newPassword, t.Email, t.EmployeeCode) is { } bad) return bad;

        // Single use, even under concurrent submits.
        var claimed = await c.ExecuteAsync("UPDATE auth.PasswordResetTokens SET UsedUtc = @now WHERE TokenId = @id AND UsedUtc IS NULL",
            new { now = clock.UtcNow, id = t.TokenId });
        if (claimed == 0) return invalid;
        await SetPasswordAsync(c, t.UserId, newPassword, keepSessionId: null, reason: "PASSWORD_RESET");
        await c.ExecuteAsync("UPDATE auth.Users SET FailedLoginCount = 0, LockoutEndUtc = NULL WHERE UserId = @id", new { id = t.UserId });
        await Audit.WriteUserAsync(c, "USER", t.UserId, "PASSWORD_RESET", t.UserId, "Password reset via e-mail link; all sessions revoked", client.Ip);
        return null;
    }

    static AuthOutcome.Failure? PolicyFailure(string password, params string?[] personal)
    {
        var v = PasswordPolicy.Violations(password, personal);
        return v.Count == 0 ? null : new AuthOutcome.Failure(400, "PASSWORD_POLICY", "The new password does not meet the password policy.",
            new Dictionary<string, object?> { ["violations"] = v });
    }

    async Task SetPasswordAsync(IDbConnection c, long userId, string newPassword, Guid? keepSessionId, string reason)
    {
        var now = clock.UtcNow;
        await c.ExecuteAsync("""
            UPDATE auth.Users SET PasswordHash = @hash, PasswordChangedUtc = @now, MustChangePassword = 0, SecurityStamp = NEWID(), ModifiedUtc = @now, ModifiedByUserId = @userId
            WHERE UserId = @userId;
            UPDATE auth.UserSessions SET RevokedUtc = @now, RevokedReason = @reason
            WHERE UserId = @userId AND RevokedUtc IS NULL AND (@keep IS NULL OR SessionId <> @keep);
            """, new { hash = passwords.Hash(newPassword), now, userId, keep = keepSessionId, reason });
    }

    static Task RecordAttemptAsync(IDbConnection c, string login, long? userId, bool ok, string? reason, ClientInfo client) =>
        c.ExecuteAsync("""
            INSERT auth.LoginAttempts (LoginName, UserId, Succeeded, FailureReason, IpAddress, UserAgent) VALUES (@login, @userId, @ok, @reason, @ip, @ua)
            """, new { login = login.Length > 254 ? login[..254] : login, userId, ok, reason, ip = client.Ip, ua = client.UserAgent });
}

public static class Audit
{
    /// <summary>Audit entry about a user account; EntityId is the user's PublicId (schema convention, V008).</summary>
    public static Task WriteUserAsync(IDbConnection c, string actorType, long? actorUserId, string action, long targetUserId,
        string summary, string? ip, IDbTransaction? tx = null, bool privileged = false) =>
        c.ExecuteAsync("""
            INSERT app.AuditLog (ActorType, ActorUserId, [Action], EntityType, EntityId, Summary, IpAddress, IsPrivileged)
            SELECT @actorType, @actorUserId, @action, 'User', CONVERT(VARCHAR(64), PublicId), @summary, @ip, @privileged
            FROM auth.Users WHERE UserId = @targetUserId
            """, new { actorType, actorUserId, action, targetUserId, summary, ip, privileged }, tx);

    /// <summary>Appends to app.AuditLog (append-only). Pass the entity's PublicId as EntityId when it has one.</summary>
    public static Task WriteAsync(IDbConnection c, string actorType, long? actorUserId, string action, string entityType, string? entityId,
        string summary, string? ip, IDbTransaction? tx = null, bool privileged = false, object? newValues = null) =>
        c.ExecuteAsync("""
            INSERT app.AuditLog (ActorType, ActorUserId, [Action], EntityType, EntityId, Summary, NewValuesJson, IpAddress, IsPrivileged)
            VALUES (@actorType, @actorUserId, @action, @entityType, @entityId, @summary, @newValues, @ip, @privileged)
            """, new { actorType, actorUserId, action, entityType, entityId, summary, newValues = newValues is null ? null : System.Text.Json.JsonSerializer.Serialize(newValues), ip, privileged }, tx);
}
