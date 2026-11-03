using System.Security.Claims;
using System.Text.Encodings.Web;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Security;

public static class SessionClaims
{
    public const string Scheme = "OicSession";
    public const string UserId = "oic:uid";
    public const string SessionId = "oic:sid";
    public const string Permission = "oic:perm";
    public const string MustChangePassword = "oic:mcp";
}

public static class Cookies
{
    public const string Session = "oic_session";
    public const string Xsrf = "XSRF-TOKEN";
    public const string TrustedDevice = "oic_trusted_device";

    public static void SetTrustedDevice(HttpResponse r, SecurityOptions o, string token) =>
        r.Cookies.Append(TrustedDevice, token, new CookieOptions
        {
            HttpOnly = true, Secure = o.CookieSecure, SameSite = SameSiteMode.Strict, Path = "/api/v1/auth", IsEssential = true,
            Expires = DateTimeOffset.UtcNow.Add(OneInsure.Connect.Api.Auth.MfaService.TrustedDeviceLifetime),
        });

    public static void SetSession(HttpResponse r, SecurityOptions o, string token, DateTime? persistentUntilUtc) =>
        r.Cookies.Append(Session, token, new CookieOptions
        {
            HttpOnly = true, Secure = o.CookieSecure, SameSite = SameSiteMode.Strict, Path = "/", IsEssential = true,
            Expires = persistentUntilUtc is null ? null : new DateTimeOffset(persistentUntilUtc.Value, TimeSpan.Zero),
        });

    public static void ClearSession(HttpResponse r, SecurityOptions o) =>
        r.Cookies.Delete(Session, new CookieOptions { HttpOnly = true, Secure = o.CookieSecure, SameSite = SameSiteMode.Strict, Path = "/" });

    /// <summary>Double-submit CSRF token: readable by the SPA, echoed back in the X-XSRF-TOKEN header.</summary>
    public static void SetXsrf(HttpResponse r, SecurityOptions o) =>
        r.Cookies.Append(Xsrf, Tokens.New(), new CookieOptions
        {
            HttpOnly = false, Secure = o.CookieSecure, SameSite = SameSiteMode.Strict, Path = "/", IsEssential = true,
        });
}

/// <summary>
/// Validates the opaque session cookie against auth.UserSessions (by SHA-256), enforces idle and absolute
/// expiry, revocation and account state, slides the idle window, and loads the user's permissions.
/// </summary>
public sealed class SessionAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder,
    Db db, IClock clock, IOptions<SecurityOptions> security)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    sealed record Row(Guid SessionId, long UserId, DateTime ExpiresUtc, DateTime AbsoluteExpiryUtc, DateTime LastSeenUtc, bool MustChangePassword, string? Permissions);

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Cookies.TryGetValue(Cookies.Session, out var token) || string.IsNullOrEmpty(token) || token.Length > 200)
            return AuthenticateResult.NoResult();

        var now = clock.UtcNow;
        using var c = await db.OpenAsync(Context.RequestAborted);
        var row = await c.QuerySingleOrDefaultAsync<Row>("""
            SELECT s.SessionId, s.UserId, s.ExpiresUtc, s.AbsoluteExpiryUtc, s.LastSeenUtc, u.MustChangePassword,
                   (SELECT STRING_AGG(p.Code, ',') FROM (SELECT DISTINCT p.Code FROM auth.UserRoles ur
                        JOIN auth.RolePermissions rp ON rp.RoleId = ur.RoleId
                        JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE ur.UserId = u.UserId) p) AS Permissions
            FROM auth.UserSessions s JOIN auth.Users u ON u.UserId = s.UserId
            WHERE s.TokenHash = @hash AND s.RevokedUtc IS NULL AND s.ExpiresUtc > @now AND s.AbsoluteExpiryUtc > @now
              AND u.IsActive = 1 AND u.IsLocked = 0
            """, new { hash = Tokens.Hash(token), now });
        if (row is null)
            return AuthenticateResult.Fail("Session invalid or expired.");

        // Slide the idle window at most once a minute to keep writes low.
        if (now - row.LastSeenUtc > TimeSpan.FromMinutes(1))
        {
            var idle = now.AddMinutes(security.Value.SessionIdleMinutes);
            await c.ExecuteAsync("UPDATE auth.UserSessions SET LastSeenUtc = @now, ExpiresUtc = @exp WHERE SessionId = @id",
                new { now, exp = idle < row.AbsoluteExpiryUtc ? idle : row.AbsoluteExpiryUtc, id = row.SessionId });
        }

        var claims = new List<Claim>
        {
            new(SessionClaims.UserId, row.UserId.ToString()),
            new(SessionClaims.SessionId, row.SessionId.ToString()),
            new(SessionClaims.MustChangePassword, row.MustChangePassword ? "1" : "0"),
        };
        foreach (var p in (row.Permissions ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries))
            claims.Add(new Claim(SessionClaims.Permission, p));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, SessionClaims.Scheme)), SessionClaims.Scheme));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        Problems.WriteAsync(Context, 401, "UNAUTHORIZED", "Please sign in.");

    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>
        Problems.WriteAsync(Context, 403, "FORBIDDEN", "You do not have permission for this action.");
}

public static class PrincipalExtensions
{
    public static long UserId(this ClaimsPrincipal u) => long.Parse(u.FindFirstValue(SessionClaims.UserId)!);
    public static Guid SessionId(this ClaimsPrincipal u) => Guid.Parse(u.FindFirstValue(SessionClaims.SessionId)!);
    public static bool MustChangePassword(this ClaimsPrincipal u) => u.FindFirstValue(SessionClaims.MustChangePassword) == "1";
}

/// <summary>Endpoint metadata: reachable while the user must still change their password.</summary>
public sealed class AllowPendingPasswordChangeAttribute : Attribute;

public static class EndpointSecurity
{
    /// <summary>Requires a signed-in user holding the given permission code (auth.Permissions.Code).</summary>
    public static TBuilder RequirePermission<TBuilder>(this TBuilder b, string permission) where TBuilder : IEndpointConventionBuilder =>
        b.RequireAuthorization(p => p.AddAuthenticationSchemes(SessionClaims.Scheme).RequireAuthenticatedUser().RequireClaim(SessionClaims.Permission, permission));

    /// <summary>Requires a signed-in user holding at least one of the given permission codes.</summary>
    public static TBuilder RequireAnyPermission<TBuilder>(this TBuilder b, params string[] permissions) where TBuilder : IEndpointConventionBuilder =>
        b.RequireAuthorization(p => p.AddAuthenticationSchemes(SessionClaims.Scheme).RequireAuthenticatedUser()
            .RequireAssertion(ctx => permissions.Any(x => ctx.User.HasClaim(SessionClaims.Permission, x))));

    public static bool Can(this ClaimsPrincipal u, string permission) => u.HasClaim(SessionClaims.Permission, permission);

    public static TBuilder RequireSession<TBuilder>(this TBuilder b) where TBuilder : IEndpointConventionBuilder =>
        b.RequireAuthorization(p => p.AddAuthenticationSchemes(SessionClaims.Scheme).RequireAuthenticatedUser());
}
