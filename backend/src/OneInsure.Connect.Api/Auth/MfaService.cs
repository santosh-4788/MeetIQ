using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Caching.Memory;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;
using QRCoder;

namespace OneInsure.Connect.Api.Auth;

/// <summary>
/// TOTP (authenticator app) second factor. Secrets are encrypted with ASP.NET Core Data Protection (key ring protected
/// by Windows DPAPI); recovery codes are stored as SHA-256 hashes. E-mail OTP needs SMTP and is not offered yet.
/// </summary>
public sealed class MfaService(Db db, IDataProtectionProvider dp, IMemoryCache cache, IClock clock, Passwords passwords,
    Microsoft.Extensions.Options.IOptions<OneInsure.Connect.Api.Email.EmailOptions> email)
{
    static readonly TimeSpan EmailOtpLifetime = TimeSpan.FromMinutes(10);
    static readonly TimeSpan EmailOtpCooldown = TimeSpan.FromSeconds(60);

    /// <summary>Second-factor options at sign-in. E-mail codes are offered only when e-mail delivery is enabled.</summary>
    public string[] LoginMethods => email.Value.Enabled ? ["TOTP", "EMAIL_OTP"] : ["TOTP"];

    public static string MaskEmail(string address)
    {
        var at = address.IndexOf('@');
        if (at <= 0) return address;
        var name = address[..at];
        return (name.Length <= 2 ? name[..1] : name[..2]) + new string('*', Math.Max(3, name.Length - 2)) + address[at..];
    }

    /// <summary>Queues a 6-digit sign-in code by e-mail (10 minutes, one per minute). Returns an error code or null.</summary>
    public async Task<string?> SendEmailOtpAsync(LoginToken t)
    {
        if (!email.Value.Enabled) return "UNAVAILABLE";
        if (cache.TryGetValue("mfa-email-sent:" + t.Nonce, out _)) return "RATE_LIMITED";
        var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
        cache.Set("mfa-email:" + t.Nonce, HashRecoveryCode(code), EmailOtpLifetime);
        cache.Set("mfa-email-sent:" + t.Nonce, true, EmailOtpCooldown);
        using var c = await db.OpenAsync();
        var name = await c.QuerySingleOrDefaultAsync<string?>("""
            SELECT e.DisplayName FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @userId
            """, new { userId = t.UserId });
        await c.ExecuteAsync("""
            INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml)
            SELECT 'MFA_EMAIL_OTP', Email, 'Your OneInsure Connect sign-in code', @body
            FROM auth.Users WHERE UserId = @userId AND IsActive = 1
            """, new { body = AccountEmails.SignInCode(EmailBrand.From(email.Value), name, code, (int)EmailOtpLifetime.TotalMinutes), userId = t.UserId });
        return null;
    }

    public bool VerifyEmailOtp(string nonce, string code)
    {
        if (!cache.TryGetValue("mfa-email:" + nonce, out string? expected) || expected is null) return false;
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(HashRecoveryCode(code)))) return false;
        cache.Remove("mfa-email:" + nonce);
        return true;
    }

    public const string Issuer = "OneInsure Connect";
    const int MaxAttemptsPerLoginToken = 5;
    static readonly TimeSpan LoginTokenLifetime = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan TrustedDeviceLifetime = TimeSpan.FromDays(30);

    readonly IDataProtector secrets = dp.CreateProtector("OIC.Mfa.TotpSecret.v1");
    readonly ITimeLimitedDataProtector loginTokens = dp.CreateProtector("OIC.Mfa.LoginToken.v1").ToTimeLimitedDataProtector();
    readonly ITimeLimitedDataProtector trustTokens = dp.CreateProtector("OIC.Mfa.TrustedDevice.v1").ToTimeLimitedDataProtector();

    // ---- Sign-in step tokens -------------------------------------------------------------------------------

    public sealed record LoginToken(long UserId, bool RememberMe, string Nonce);

    public string IssueLoginToken(long userId, bool rememberMe) =>
        loginTokens.Protect($"{userId}|{(rememberMe ? 1 : 0)}|{Tokens.New(16)}", LoginTokenLifetime);

    public LoginToken? ReadLoginToken(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 2000) return null;
        try
        {
            var p = loginTokens.Unprotect(token).Split('|');
            var nonce = p[2];
            if (cache.TryGetValue("mfa-used:" + nonce, out _)) return null;
            if (cache.TryGetValue("mfa-fail:" + nonce, out int fails) && fails >= MaxAttemptsPerLoginToken) return null;
            return new LoginToken(long.Parse(p[0]), p[1] == "1", nonce);
        }
        catch (CryptographicException) { return null; }
    }

    public void CountFailedAttempt(string nonce) =>
        cache.Set("mfa-fail:" + nonce, (cache.TryGetValue("mfa-fail:" + nonce, out int n) ? n : 0) + 1, LoginTokenLifetime);

    public void ConsumeLoginToken(string nonce) => cache.Set("mfa-used:" + nonce, true, LoginTokenLifetime);

    /// <summary>"Trust this device for 30 days": bound to the user's SecurityStamp, so a password change or MFA reset revokes it.</summary>
    public string IssueTrustedDeviceToken(long userId, Guid securityStamp) => trustTokens.Protect($"{userId}|{securityStamp}", TrustedDeviceLifetime);

    public bool IsTrustedDevice(string? token, long userId, Guid securityStamp)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 2000) return false;
        try { return trustTokens.Unprotect(token) == $"{userId}|{securityStamp}"; }
        catch (CryptographicException) { return false; }
    }

    // ---- Verification ----------------------------------------------------------------------------------------

    sealed record MethodRow(long MfaMethodId, byte[]? SecretEncrypted, DateTime? VerifiedUtc, string? RecoveryCodesHash);

    static Task<MethodRow?> GetTotpAsync(IDbConnection c, long userId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<MethodRow>(
            "SELECT MfaMethodId, SecretEncrypted, VerifiedUtc, RecoveryCodesHash FROM auth.UserMfaMethods WHERE UserId = @userId AND [Type] = 'TOTP'",
            new { userId }, tx);

    public async Task<bool> VerifyTotpAsync(IDbConnection c, long userId, string code)
    {
        var m = await GetTotpAsync(c, userId);
        return m?.VerifiedUtc is not null && CheckCode(userId, m.SecretEncrypted!, code);
    }

    bool CheckCode(long userId, byte[] secretEncrypted, string code)
    {
        var step = Totp.Match(secrets.Unprotect(secretEncrypted), code.Trim(), clock.UtcNow);
        if (step is null) return false;
        // Each code is accepted once (replay protection across the ±1 step window).
        var key = $"totp-used:{userId}:{step}";
        if (cache.TryGetValue(key, out _)) return false;
        cache.Set(key, true, TimeSpan.FromSeconds(Totp.StepSeconds * 4));
        return true;
    }

    public async Task<bool> UseRecoveryCodeAsync(IDbConnection c, long userId, string code)
    {
        var m = await GetTotpAsync(c, userId);
        if (m?.VerifiedUtc is null || string.IsNullOrEmpty(m.RecoveryCodesHash)) return false;
        var hashes = JsonSerializer.Deserialize<List<string>>(m.RecoveryCodesHash) ?? [];
        var h = HashRecoveryCode(code);
        if (!hashes.Remove(h)) return false;
        // Optimistic: only succeeds if nobody used a code concurrently.
        var updated = await c.ExecuteAsync(
            "UPDATE auth.UserMfaMethods SET RecoveryCodesHash = @next WHERE MfaMethodId = @id AND RecoveryCodesHash = @prev",
            new { next = JsonSerializer.Serialize(hashes), id = m.MfaMethodId, prev = m.RecoveryCodesHash });
        return updated == 1;
    }

    // ---- Enrolment (signed-in user) -------------------------------------------------------------------------

    public sealed record MfaStatus(bool Enabled, string[] Methods, int RecoveryCodesRemaining, DateTime? EnabledUtc);
    public sealed record SetupResult(string Secret, string OtpAuthUri, string QrCodeDataUrl);

    public async Task<MfaStatus> StatusAsync(long userId)
    {
        using var c = await db.OpenAsync();
        var m = await GetTotpAsync(c, userId);
        var enabled = m?.VerifiedUtc is not null;
        var remaining = enabled && m!.RecoveryCodesHash is { } j ? (JsonSerializer.Deserialize<List<string>>(j)?.Count ?? 0) : 0;
        return new MfaStatus(enabled, enabled ? ["TOTP"] : [], remaining, m?.VerifiedUtc is { } v ? DateTime.SpecifyKind(v, DateTimeKind.Utc) : null);
    }

    /// <summary>Starts (or restarts) enrolment: a fresh secret, stored unverified until confirmed with a code.</summary>
    public async Task<(SetupResult? Result, string? Error)> SetupAsync(long userId, string currentPassword)
    {
        using var c = await db.OpenAsync();
        var u = await c.QuerySingleAsync<(string Email, string? PasswordHash)>("SELECT Email, PasswordHash FROM auth.Users WHERE UserId = @userId", new { userId });
        if (passwords.Verify(u.PasswordHash, currentPassword) == Microsoft.AspNetCore.Identity.PasswordVerificationResult.Failed)
            return (null, "INVALID_CREDENTIALS");
        var existing = await GetTotpAsync(c, userId);
        if (existing?.VerifiedUtc is not null) return (null, "ALREADY_ENABLED");

        var secret = RandomNumberGenerator.GetBytes(20);
        var encrypted = secrets.Protect(secret);
        await c.ExecuteAsync("""
            DELETE FROM auth.UserMfaMethods WHERE UserId = @userId AND [Type] = 'TOTP' AND VerifiedUtc IS NULL;
            INSERT auth.UserMfaMethods (UserId, [Type], SecretEncrypted, IsPrimary) VALUES (@userId, 'TOTP', @encrypted, 0);
            """, new { userId, encrypted });
        var uri = Totp.OtpAuthUri(Issuer, u.Email, secret);
        using var qr = new QRCodeGenerator().CreateQrCode(uri, QRCodeGenerator.ECCLevel.M);
        var svg = new SvgQRCode(qr).GetGraphic(6);
        return (new SetupResult(Totp.Base32(secret), uri, "data:image/svg+xml;base64," + Convert.ToBase64String(Encoding.UTF8.GetBytes(svg))), null);
    }

    /// <summary>Confirms enrolment with a first code; turns MFA on and returns one-time recovery codes (shown once).</summary>
    public async Task<string[]?> ConfirmAsync(long userId, string code, string? ip)
    {
        using var c = await db.OpenAsync();
        var m = await GetTotpAsync(c, userId);
        if (m is null || m.VerifiedUtc is not null || !CheckCode(userId, m.SecretEncrypted!, code)) return null;
        var codes = NewRecoveryCodes();
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("""
            UPDATE auth.UserMfaMethods SET VerifiedUtc = @now, IsPrimary = 1, RecoveryCodesHash = @hashes WHERE MfaMethodId = @id;
            UPDATE auth.Users SET MfaEnabled = 1, ModifiedUtc = @now WHERE UserId = @userId;
            """, new { now = clock.UtcNow, hashes = JsonSerializer.Serialize(codes.Select(HashRecoveryCode)), id = m.MfaMethodId, userId }, tx);
        await Audit.WriteUserAsync(c, "USER", userId, "MFA_ENABLED", userId, "Authenticator app enabled", ip, tx, privileged: true);
        tx.Commit();
        return codes;
    }

    public async Task<string[]?> RegenerateRecoveryCodesAsync(long userId, string code, string? ip)
    {
        using var c = await db.OpenAsync();
        var m = await GetTotpAsync(c, userId);
        if (m?.VerifiedUtc is null || !CheckCode(userId, m.SecretEncrypted!, code)) return null;
        var codes = NewRecoveryCodes();
        await c.ExecuteAsync("UPDATE auth.UserMfaMethods SET RecoveryCodesHash = @hashes WHERE MfaMethodId = @id",
            new { hashes = JsonSerializer.Serialize(codes.Select(HashRecoveryCode)), id = m.MfaMethodId });
        await Audit.WriteUserAsync(c, "USER", userId, "MFA_RECOVERY_CODES_REGENERATED", userId, "Recovery codes regenerated", ip, privileged: true);
        return codes;
    }

    /// <summary>Turns MFA off (self-service with password + code, or by an administrator) and revokes trusted devices.</summary>
    public static async Task DisableAsync(IDbConnection c, long userId, long actorUserId, string summary, string? ip, IDbTransaction? tx = null)
    {
        await c.ExecuteAsync("""
            DELETE FROM auth.UserMfaMethods WHERE UserId = @userId;
            UPDATE auth.Users SET MfaEnabled = 0, SecurityStamp = NEWID(), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @actorUserId WHERE UserId = @userId;
            """, new { userId, actorUserId }, tx);
        await Audit.WriteUserAsync(c, "USER", actorUserId, "MFA_DISABLED", userId, summary, ip, tx, privileged: true);
    }

    public async Task<string?> DisableSelfAsync(long userId, string currentPassword, string code, string? ip)
    {
        using var c = await db.OpenAsync();
        var hash = await c.QuerySingleAsync<string?>("SELECT PasswordHash FROM auth.Users WHERE UserId = @userId", new { userId });
        if (passwords.Verify(hash, currentPassword) == Microsoft.AspNetCore.Identity.PasswordVerificationResult.Failed) return "INVALID_CREDENTIALS";
        if (!await VerifyTotpAsync(c, userId, code) && !await UseRecoveryCodeAsync(c, userId, code)) return "INVALID_MFA_CODE";
        await DisableAsync(c, userId, userId, "Authenticator app disabled by the user", ip);
        return null;
    }

    static string[] NewRecoveryCodes()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        return Enumerable.Range(0, 10).Select(_ =>
        {
            var chars = Enumerable.Range(0, 10).Select(_ => alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)]).ToArray();
            return $"{new string(chars, 0, 5)}-{new string(chars, 5, 5)}";
        }).ToArray();
    }

    static string HashRecoveryCode(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code.Trim().ToUpperInvariant().Replace("-", "").Replace(" ", ""))));
}
