using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Threading.RateLimiting;
using Dapper;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Integrations;

/// <summary>Scopes an integration can be granted (mirrors CK_ApiIntegrationScopes_Scope, V023).</summary>
public static class IntegrationScopes
{
    public const string MeetingCreate = "meeting.create";
    public const string MeetingRead = "meeting.read";
    public const string MeetingSchedule = "meeting.schedule";
    public const string MeetingCancel = "meeting.cancel";
    public const string RecordingRead = "recording.read";
    public const string RecordingDownload = "recording.download";
    public const string MeetingJsonRead = "meeting.json.read";
    public const string WebhookManage = "webhook.manage";
    /// <summary>V024: create an UNIDENTIFIED Customer - PLVC instant meeting (no Prarambh Main ID, no customer).</summary>
    public const string PlvcUnidentified = "meeting.plvc.unidentified";

    public static readonly string[] All = [MeetingCreate, MeetingRead, MeetingSchedule, MeetingCancel, RecordingRead, RecordingDownload, MeetingJsonRead, WebhookManage, PlvcUnidentified];
}

/// <summary>Webhook event types (Module 12).</summary>
public static class IntegrationEventTypes
{
    public const string MeetingCreated = "meeting.created";
    public const string MeetingStarted = "meeting.started";
    public const string ParticipantJoined = "participant.joined";
    public const string ParticipantLeft = "participant.left";
    public const string ConsentRequested = "recording.consent_requested";
    public const string RecordingStarted = "recording.started";
    public const string RecordingStopped = "recording.stopped";
    public const string RecordingCompleted = "recording.completed";
    public const string RecordingFailed = "recording.failed";
    public const string MeetingCompleted = "meeting.completed";

    public static readonly string[] All = [MeetingCreated, MeetingStarted, ParticipantJoined, ParticipantLeft, ConsentRequested, RecordingStarted,
        RecordingStopped, RecordingCompleted, RecordingFailed, MeetingCompleted];
}

/// <summary>
/// API keys: <c>oic_live_&lt;16 hex&gt;_&lt;43 base64url&gt;</c>. The part before the last underscore is a non-secret lookup prefix (unique,
/// shown in the admin list); only SHA-256 of the WHOLE key is stored, compared in constant time. A key is shown exactly once.
/// </summary>
public static class ApiKeys
{
    public const string Scheme = "oic_live_";

    public static (string Key, string Prefix, byte[] Hash) New()
    {
        var prefix = Scheme + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var key = $"{prefix}_{Tokens.New(32)}";
        return (key, prefix, Tokens.Hash(key));
    }

    /// <summary>The lookup prefix of a presented key, or null if it is not in our format.</summary>
    public static string? PrefixOf(string key)
    {
        if (key.Length is < 40 or > 120 || !key.StartsWith(Scheme, StringComparison.Ordinal)) return null;
        var cut = key.IndexOf('_', Scheme.Length);
        return cut == Scheme.Length + 16 ? key[..cut] : null;
    }

    public static string NewIntegrationCode() => "INT-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(5));
}

/// <summary>The authenticated caller of an /api/ext request (set by <see cref="ExternalApiMiddleware"/>).</summary>
public sealed record IntegrationContext(long IntegrationId, Guid PublicId, string Code, string Name, long KeyId, int RateLimitPerMinute,
    long? DefaultHostEmployeeId, IReadOnlySet<string> Scopes)
{
    public const string ItemKey = "oic.integration";
    public bool Has(string scope) => Scopes.Contains(scope);
}

public static class IntegrationHttpExtensions
{
    public static IntegrationContext Integration(this HttpContext ctx) =>
        ctx.Items[IntegrationContext.ItemKey] as IntegrationContext ?? throw new InvalidOperationException("No integration on this request.");

    /// <summary>Endpoint filter: the calling integration must hold <paramref name="scope"/> (403 INSUFFICIENT_SCOPE otherwise).</summary>
    public static TBuilder RequireScope<TBuilder>(this TBuilder b, string scope) where TBuilder : IEndpointConventionBuilder =>
        b.AddEndpointFilter(async (ctx, next) =>
        {
            var i = ctx.HttpContext.Items[IntegrationContext.ItemKey] as IntegrationContext;
            if (i is null) return Problems.Create(401, "UNAUTHORIZED", "A valid API key is required.");
            if (!i.Has(scope))
                return Problems.Create(403, "INSUFFICIENT_SCOPE", $"This integration is not allowed to use this endpoint (scope '{scope}' is required).",
                    new Dictionary<string, object?> { ["requiredScope"] = scope });
            return await next(ctx);
        });
}

/// <summary>
/// Everything under /api/ext: API-key authentication, per-integration rate limiting and the request log (app.ApiRequestLog).
/// The session cookie is never consulted on these paths (they are CSRF-exempt precisely because cookies grant nothing here).
/// Errors use the same problem+json shape as the rest of the API: { status, code, detail, ... }.
/// </summary>
public static class ExternalApiMiddleware
{
    public const string PathPrefix = "/api/ext";
    /// <summary>Paths under /api/ext that need no key: the OpenAPI document, and recording media (authorised by its own signed, short-lived token).</summary>
    static bool Anonymous(PathString p) => p.StartsWithSegments("/api/ext/openapi") || p.StartsWithSegments("/api/ext/v1/recordings/media");

    static readonly ConcurrentDictionary<long, (int Limit, FixedWindowRateLimiter Limiter)> Limiters = new();

    sealed record KeyRow(long KeyId, long IntegrationId, Guid PublicId, string IntegrationCode, string Name, bool IsActive, int RateLimitPerMinute,
        long? DefaultHostEmployeeId, byte[] SecretHash, DateTime? RevokedUtc, DateTime? LastUsedUtc, string? Scopes);

    public static IApplicationBuilder UseExternalApi(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        if (!ctx.Request.Path.StartsWithSegments(PathPrefix)) { await next(); return; }
        if (Anonymous(ctx.Request.Path)) { await next(); return; }
        var sw = Stopwatch.StartNew();
        var db = ctx.RequestServices.GetRequiredService<Db>();
        var clock = ctx.RequestServices.GetRequiredService<IClock>();
        long? integrationId = null, keyId = null;
        string? error = null;
        try
        {
            var presented = PresentedKey(ctx.Request);
            var prefix = presented is null ? null : ApiKeys.PrefixOf(presented);
            if (prefix is null)
            {
                error = "UNAUTHORIZED";
                ctx.Response.Headers.WWWAuthenticate = "Bearer";
                await Problems.WriteAsync(ctx, 401, "UNAUTHORIZED", "A valid API key is required: send it as 'Authorization: Bearer <key>' (or the X-Api-Key header).");
                return;
            }
            using var c = await db.OpenAsync(ctx.RequestAborted);
            var row = await c.QuerySingleOrDefaultAsync<KeyRow>("""
                SELECT k.KeyId, i.IntegrationId, i.PublicId, i.IntegrationCode, i.Name, i.IsActive, i.RateLimitPerMinute, i.DefaultHostEmployeeId, k.SecretHash,
                       k.RevokedUtc, k.LastUsedUtc, (SELECT STRING_AGG(s.Scope, ',') FROM app.ApiIntegrationScopes s WHERE s.IntegrationId = i.IntegrationId) AS Scopes
                FROM app.ApiKeys k JOIN app.ApiIntegrations i ON i.IntegrationId = k.IntegrationId
                WHERE k.KeyPrefix = @prefix
                """, new { prefix });
            if (row is null || !CryptographicOperations.FixedTimeEquals(row.SecretHash, Tokens.Hash(presented!)))
            {
                error = "UNAUTHORIZED";
                await Problems.WriteAsync(ctx, 401, "UNAUTHORIZED", "The API key is not valid.");
                return;
            }
            (integrationId, keyId) = (row.IntegrationId, row.KeyId);
            if (row.RevokedUtc is not null)
            {
                error = "KEY_REVOKED";
                await Problems.WriteAsync(ctx, 401, "KEY_REVOKED", "This API key has been revoked. Ask the OneInsure Connect administrator for a new key.");
                return;
            }
            if (!row.IsActive)
            {
                error = "INTEGRATION_INACTIVE";
                await Problems.WriteAsync(ctx, 403, "INTEGRATION_INACTIVE", "This integration is deactivated.");
                return;
            }
            var limiter = Limiter(row.IntegrationId, row.RateLimitPerMinute);
            using var lease = limiter.AttemptAcquire();
            if (!lease.IsAcquired)
            {
                error = "RATE_LIMITED";
                ctx.Response.Headers.RetryAfter = "60";
                await Problems.WriteAsync(ctx, 429, "RATE_LIMITED", $"Rate limit exceeded ({row.RateLimitPerMinute} requests per minute for this integration). Retry after a minute.");
                return;
            }
            var now = clock.UtcNow;
            if (row.LastUsedUtc is null || now - row.LastUsedUtc.Value > TimeSpan.FromMinutes(1))
                await c.ExecuteAsync("""
                    UPDATE app.ApiKeys SET LastUsedUtc = @now, LastUsedIp = @ip WHERE KeyId = @k;
                    UPDATE app.ApiIntegrations SET LastUsedUtc = @now WHERE IntegrationId = @i;
                    """, new { now, ip = Ip(ctx), k = row.KeyId, i = row.IntegrationId });
            ctx.Items[IntegrationContext.ItemKey] = new IntegrationContext(row.IntegrationId, row.PublicId, row.IntegrationCode, row.Name, row.KeyId,
                row.RateLimitPerMinute, row.DefaultHostEmployeeId, (row.Scopes ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal));
            await next();
        }
        finally
        {
            await LogAsync(db, integrationId, keyId, ctx, (int)sw.ElapsedMilliseconds, error);
        }
    });

    static string? PresentedKey(HttpRequest r)
    {
        var auth = r.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return auth[7..].Trim();
        var header = r.Headers["X-Api-Key"].ToString().Trim();
        return header.Length > 0 ? header : null;
    }

    static FixedWindowRateLimiter Limiter(long integrationId, int perMinute)
    {
        var entry = Limiters.AddOrUpdate(integrationId,
            _ => (perMinute, New(perMinute)),
            (_, old) => old.Limit == perMinute ? old : (perMinute, New(perMinute)));
        return entry.Limiter;
        static FixedWindowRateLimiter New(int n) => new(new FixedWindowRateLimiterOptions { PermitLimit = n, Window = TimeSpan.FromMinutes(1), QueueLimit = 0, AutoReplenishment = true });
    }

    static string? Ip(HttpContext ctx) => ctx.Connection.RemoteIpAddress?.ToString();

    static async Task LogAsync(Db db, long? integrationId, long? keyId, HttpContext ctx, int ms, string? error)
    {
        try
        {
            using var c = await db.OpenAsync();
            var path = ctx.Request.Path.Value ?? "";
            await c.ExecuteAsync("""
                INSERT app.ApiRequestLog (IntegrationId, KeyId, Method, Path, StatusCode, DurationMs, Ip, ErrorCode)
                VALUES (@integrationId, @keyId, @method, @path, @status, @ms, @ip, @error)
                """, new { integrationId, keyId, method = ctx.Request.Method, path = path.Length > 400 ? path[..400] : path, status = ctx.Response.StatusCode, ms, ip = Ip(ctx),
                    error = error ?? (ctx.Response.StatusCode >= 400 ? $"HTTP_{ctx.Response.StatusCode}" : null) });
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("ExternalApi").LogWarning(e, "Could not write the API request log");
        }
    }
}
