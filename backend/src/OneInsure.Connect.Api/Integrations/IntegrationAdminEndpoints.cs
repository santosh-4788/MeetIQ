using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Integrations;

/// <summary>
/// Organisation → System → API Documentation → Integrations (permission integrations.manage): create portals, issue / rotate /
/// revoke API keys (a key is shown once), scopes, activation, default host, rate limit, webhook, request log and delivery history.
/// Every change is audited. Secrets never appear in responses after the call that created them.
/// </summary>
public static class IntegrationAdminEndpoints
{
    public sealed record IntegrationInput(string? Name, string? PortalName, string? Description, string[]? Scopes, int? RateLimitPerMinute, Guid? DefaultHostEmployeeId, bool? IsActive);
    public sealed record RevokeInput(string? Reason);

    public static RouteGroupBuilder MapIntegrationAdminEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/admin/integrations").RequirePermission("integrations.manage");
        g.MapGet("", List);
        g.MapPost("", Create);
        g.MapGet("/{id:guid}", Get);
        g.MapPut("/{id:guid}", Update);
        g.MapPost("/{id:guid}/keys", (Guid id, Db db, HttpContext ctx, CancellationToken ct) => IssueKey(id, db, ctx, revokeOthers: false, ct));
        g.MapPost("/{id:guid}/keys/rotate", (Guid id, Db db, HttpContext ctx, CancellationToken ct) => IssueKey(id, db, ctx, revokeOthers: true, ct));
        g.MapPost("/{id:guid}/keys/{keyId:guid}/revoke", RevokeKey);
        g.MapGet("/{id:guid}/logs", Logs);
        g.MapGet("/{id:guid}/webhook/deliveries", Deliveries);
        g.MapPut("/{id:guid}/webhook", SaveWebhook);
        g.MapPost("/{id:guid}/webhook/test", TestWebhook);
        g.MapPost("/webhook/deliveries/{deliveryId:long}/retry", Retry);
        return api;
    }

    sealed record Row(long IntegrationId, Guid Id, string IntegrationCode, string Name, string PortalName, string? Description, bool IsActive, int RateLimitPerMinute,
        Guid? DefaultHostId, string? DefaultHostName, DateTime? LastUsedUtc, DateTime CreatedUtc, string? Scopes, int ActiveKeys, int Meetings,
        string? WebhookUrl, bool? WebhookActive, string? WebhookEvents);

    const string Select = """
        SELECT i.IntegrationId, i.PublicId AS Id, i.IntegrationCode, i.Name, i.PortalName, i.Description, i.IsActive, i.RateLimitPerMinute,
               e.PublicId AS DefaultHostId, e.DisplayName AS DefaultHostName, i.LastUsedUtc, i.CreatedUtc,
               (SELECT STRING_AGG(s.Scope, ',') FROM app.ApiIntegrationScopes s WHERE s.IntegrationId = i.IntegrationId) AS Scopes,
               (SELECT COUNT(*) FROM app.ApiKeys k WHERE k.IntegrationId = i.IntegrationId AND k.RevokedUtc IS NULL) AS ActiveKeys,
               (SELECT COUNT(*) FROM mtg.Meetings m WHERE m.IntegrationId = i.IntegrationId) AS Meetings,
               w.Url AS WebhookUrl, w.IsActive AS WebhookActive, w.Events AS WebhookEvents
        FROM app.ApiIntegrations i LEFT JOIN org.Employees e ON e.EmployeeId = i.DefaultHostEmployeeId
        LEFT JOIN app.WebhookSubscriptions w ON w.IntegrationId = i.IntegrationId
        """;

    static object Dto(Row r) => new
    {
        id = r.Id, integrationId = r.IntegrationCode, name = r.Name, portalName = r.PortalName, description = r.Description, isActive = r.IsActive,
        rateLimitPerMinute = r.RateLimitPerMinute, defaultHost = r.DefaultHostId is null ? null : new { id = r.DefaultHostId, name = r.DefaultHostName },
        lastUsedUtc = r.LastUsedUtc, createdUtc = r.CreatedUtc, scopes = (r.Scopes ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Order().ToArray(),
        activeKeys = r.ActiveKeys, meetings = r.Meetings,
        webhook = r.WebhookUrl is null ? null : new { url = r.WebhookUrl, active = r.WebhookActive == true, events = (r.WebhookEvents ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries) },
    };

    static async Task<Row?> FindAsync(IDbConnection c, Guid id, IDbTransaction? tx = null) =>
        await c.QuerySingleOrDefaultAsync<Row>($"{Select} WHERE i.PublicId = @id", new { id }, tx);

    static IResult NotFound() => Problems.Create(404, "NOT_FOUND", "Integration not found.");

    static async Task<IResult> List(Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var rows = await c.QueryAsync<Row>($"{Select} ORDER BY i.IsActive DESC, i.Name");
        return Results.Ok(new { items = rows.Select(Dto), scopes = IntegrationScopes.All, events = IntegrationEventTypes.All });
    }

    static async Task<IResult> Get(Guid id, Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var keys = await c.QueryAsync<(Guid Id, string KeyPrefix, DateTime CreatedUtc, string? CreatedBy, DateTime? RevokedUtc, string? RevokedReason, DateTime? LastUsedUtc, string? LastUsedIp)>("""
            SELECT k.PublicId, k.KeyPrefix, k.CreatedUtc, u.Email, k.RevokedUtc, k.RevokedReason, k.LastUsedUtc, k.LastUsedIp
            FROM app.ApiKeys k LEFT JOIN auth.Users u ON u.UserId = k.CreatedByUserId WHERE k.IntegrationId = @i ORDER BY k.KeyId DESC
            """, new { i = r.IntegrationId });
        return Results.Ok(new
        {
            integration = Dto(r),
            keys = keys.Select(k => new { id = k.Id, prefix = k.KeyPrefix + "_…", createdUtc = k.CreatedUtc, createdBy = k.CreatedBy, revokedUtc = k.RevokedUtc,
                revokedReason = k.RevokedReason, lastUsedUtc = k.LastUsedUtc, lastUsedIp = k.LastUsedIp, active = k.RevokedUtc is null }),
        });
    }

    sealed record Valid(string Name, string PortalName, string? Description, string[] Scopes, int Rate, long? HostId, bool IsActive);

    static async Task<(Valid? V, IResult? Error)> ValidateAsync(IDbConnection c, IntegrationInput i, Row? existing)
    {
        var v = new Validator();
        var name = v.Required("name", i.Name ?? existing?.Name, 100, "Integration name");
        var portal = v.Required("portalName", i.PortalName ?? existing?.PortalName, 200, "Portal / application name");
        var description = v.Optional("description", i.Description ?? existing?.Description, 1000, "Description");
        var scopes = (i.Scopes ?? (existing?.Scopes ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries)).Select(s => s.Trim()).Distinct().ToArray();
        var unknown = scopes.Where(s => !IntegrationScopes.All.Contains(s)).ToList();
        if (unknown.Count > 0) v.Add("scopes", $"Unknown scope(s): {string.Join(", ", unknown)}.");
        var rate = i.RateLimitPerMinute ?? existing?.RateLimitPerMinute ?? 60;
        if (rate is < 1 or > 6000) v.Add("rateLimitPerMinute", "Choose 1 to 6000 requests per minute.");
        long? hostId = null;
        var hostPublic = i.DefaultHostEmployeeId ?? existing?.DefaultHostId;
        if (hostPublic is { } hp)
        {
            hostId = await c.QuerySingleOrDefaultAsync<long?>("""
                SELECT e.EmployeeId FROM org.Employees e WHERE e.PublicId = @hp AND e.IsActive = 1
                  AND EXISTS (SELECT 1 FROM auth.Users u WHERE u.EmployeeId = e.EmployeeId AND u.IsActive = 1)
                """, new { hp });
            if (hostId is null) v.Add("defaultHostEmployeeId", "The default host must be an active employee with an active login.");
        }
        if (!v.IsValid) return (null, v.Problem());
        return (new Valid(name!, portal!, description, scopes, rate, hostId, i.IsActive ?? existing?.IsActive ?? true), null);
    }

    static async Task<IResult> Create(IntegrationInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var (v, error) = await ValidateAsync(c, input, null);
        if (error is not null) return error;
        var userId = ctx.User.UserId();
        using var tx = c.BeginTransaction();
        long integrationId = 0;
        Guid publicId = default;
        string code = "";
        try
        {
            for (var attempt = 0; integrationId == 0; attempt++)
            {
                code = ApiKeys.NewIntegrationCode();
                try
                {
                    (integrationId, publicId) = await c.QuerySingleAsync<(long, Guid)>("""
                        INSERT app.ApiIntegrations (IntegrationCode, Name, PortalName, Description, IsActive, RateLimitPerMinute, DefaultHostEmployeeId, CreatedByUserId)
                        OUTPUT inserted.IntegrationId, inserted.PublicId
                        VALUES (@code, @Name, @PortalName, @Description, @IsActive, @Rate, @HostId, @userId)
                        """, new { code, v!.Name, v.PortalName, v.Description, v.IsActive, v.Rate, v.HostId, userId }, tx);
                }
                catch (SqlException e) when (e.IsUniqueViolation() && e.Message.Contains("UQ_ApiIntegrations_Code") && attempt < 5) { }
            }
        }
        catch (SqlException e) when (e.IsUniqueViolation())
        {
            tx.Rollback();
            return Problems.Create(409, "CONFLICT", "An integration with this name already exists.");
        }
        await SetScopesAsync(c, tx, integrationId, v!.Scopes);
        var (key, prefix, hash) = ApiKeys.New();
        await c.ExecuteAsync("INSERT app.ApiKeys (IntegrationId, KeyPrefix, SecretHash, CreatedByUserId) VALUES (@integrationId, @prefix, @hash, @userId)",
            new { integrationId, prefix, hash, userId }, tx);
        await Audit.WriteAsync(c, "USER", userId, "INTEGRATION_CREATED", "Integration", publicId.ToString(), $"Integration {v.Name} ({code}) created with an API key",
            ClientInfo.From(ctx).Ip, tx, privileged: true, newValues: new { code, v.Name, v.PortalName, scopes = v.Scopes, v.Rate, keyPrefix = prefix });
        tx.Commit();
        return Results.Json(new { integration = Dto((await FindAsync(c, publicId))!), apiKey = key, keyNotice = "Copy this API key now. It is shown only once and cannot be retrieved later." }, statusCode: 201);
    }

    static async Task SetScopesAsync(IDbConnection c, IDbTransaction tx, long integrationId, string[] scopes)
    {
        await c.ExecuteAsync("DELETE app.ApiIntegrationScopes WHERE IntegrationId = @integrationId AND Scope NOT IN @scopes", new { integrationId, scopes = scopes.Length == 0 ? [""] : scopes }, tx);
        foreach (var s in scopes)
            await c.ExecuteAsync("""
                INSERT app.ApiIntegrationScopes (IntegrationId, Scope) SELECT @integrationId, @s
                WHERE NOT EXISTS (SELECT 1 FROM app.ApiIntegrationScopes WHERE IntegrationId = @integrationId AND Scope = @s)
                """, new { integrationId, s }, tx);
    }

    static async Task<IResult> Update(Guid id, IntegrationInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var existing = await FindAsync(c, id);
        if (existing is null) return NotFound();
        var (v, error) = await ValidateAsync(c, input, existing);
        if (error is not null) return error;
        var userId = ctx.User.UserId();
        using var tx = c.BeginTransaction();
        try
        {
            await c.ExecuteAsync("""
                UPDATE app.ApiIntegrations SET Name = @Name, PortalName = @PortalName, Description = @Description, IsActive = @IsActive, RateLimitPerMinute = @Rate,
                    DefaultHostEmployeeId = @HostId, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @userId,
                    DeactivatedUtc = CASE WHEN @IsActive = 0 THEN COALESCE(DeactivatedUtc, SYSUTCDATETIME()) ELSE NULL END
                WHERE IntegrationId = @id
                """, new { v!.Name, v.PortalName, v.Description, v.IsActive, v.Rate, v.HostId, userId, id = existing.IntegrationId }, tx);
        }
        catch (SqlException e) when (e.IsUniqueViolation())
        {
            tx.Rollback();
            return Problems.Create(409, "CONFLICT", "An integration with this name already exists.");
        }
        await SetScopesAsync(c, tx, existing.IntegrationId, v.Scopes);
        await Audit.WriteAsync(c, "USER", userId, existing.IsActive && !v.IsActive ? "INTEGRATION_DEACTIVATED" : "INTEGRATION_UPDATED", "Integration", id.ToString(),
            $"Integration {v.Name} updated", ClientInfo.From(ctx).Ip, tx, privileged: true,
            newValues: new { v.Name, v.PortalName, scopes = v.Scopes, v.Rate, v.IsActive, oldScopes = existing.Scopes, wasActive = existing.IsActive });
        tx.Commit();
        return Results.Ok(new { integration = Dto((await FindAsync(c, id))!) });
    }

    static async Task<IResult> IssueKey(Guid id, Db db, HttpContext ctx, bool revokeOthers, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var userId = ctx.User.UserId();
        var (key, prefix, hash) = ApiKeys.New();
        using var tx = c.BeginTransaction();
        var revoked = revokeOthers
            ? await c.ExecuteAsync("UPDATE app.ApiKeys SET RevokedUtc = SYSUTCDATETIME(), RevokedByUserId = @userId, RevokedReason = N'Rotated' WHERE IntegrationId = @i AND RevokedUtc IS NULL",
                new { userId, i = r.IntegrationId }, tx)
            : 0;
        await c.ExecuteAsync("INSERT app.ApiKeys (IntegrationId, KeyPrefix, SecretHash, CreatedByUserId) VALUES (@i, @prefix, @hash, @userId)", new { i = r.IntegrationId, prefix, hash, userId }, tx);
        await Audit.WriteAsync(c, "USER", userId, revokeOthers ? "INTEGRATION_KEY_ROTATED" : "INTEGRATION_KEY_CREATED", "Integration", id.ToString(),
            revokeOthers ? $"API key rotated for {r.Name}: {revoked} old key(s) revoked" : $"API key created for {r.Name}", ClientInfo.From(ctx).Ip, tx, privileged: true,
            newValues: new { keyPrefix = prefix, revoked });
        tx.Commit();
        return Results.Json(new { apiKey = key, prefix = prefix + "_…", revokedKeys = revoked, keyNotice = "Copy this API key now. It is shown only once and cannot be retrieved later." }, statusCode: 201);
    }

    static async Task<IResult> RevokeKey(Guid id, Guid keyId, RevokeInput? input, Db db, HttpContext ctx, CancellationToken ct)
    {
        var v = new Validator();
        var reason = v.Required("reason", input?.Reason, 200, "Reason");
        if (!v.IsValid) return v.Problem();
        using var c = await db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var userId = ctx.User.UserId();
        var n = await c.ExecuteAsync("""
            UPDATE app.ApiKeys SET RevokedUtc = SYSUTCDATETIME(), RevokedByUserId = @userId, RevokedReason = @reason
            WHERE PublicId = @keyId AND IntegrationId = @i AND RevokedUtc IS NULL
            """, new { userId, reason, keyId, i = r.IntegrationId });
        if (n == 0) return Problems.Create(404, "NOT_FOUND", "Active key not found.");
        await Audit.WriteAsync(c, "USER", userId, "INTEGRATION_KEY_REVOKED", "Integration", id.ToString(), $"API key revoked for {r.Name}: {reason}", ClientInfo.From(ctx).Ip,
            privileged: true, newValues: new { keyId, reason });
        return Results.NoContent();
    }

    static async Task<IResult> Logs(Guid id, int? page, Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var p = Math.Max(1, page ?? 1);
        var rows = await c.QueryAsync<(DateTime Utc, string Method, string Path, int StatusCode, int DurationMs, string? Ip, string? ErrorCode)>("""
            SELECT Utc, Method, Path, StatusCode, DurationMs, Ip, ErrorCode FROM app.ApiRequestLog WHERE IntegrationId = @i
            ORDER BY LogId DESC OFFSET @skip ROWS FETCH NEXT 100 ROWS ONLY
            """, new { i = r.IntegrationId, skip = (p - 1) * 100 });
        var total = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM app.ApiRequestLog WHERE IntegrationId = @i", new { i = r.IntegrationId });
        return Results.Ok(new { total, page = p, items = rows.Select(x => new { utc = x.Utc, method = x.Method, path = x.Path, status = x.StatusCode, durationMs = x.DurationMs, ip = x.Ip, error = x.ErrorCode }) });
    }

    static async Task<IResult> Deliveries(Guid id, Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var rows = await c.QueryAsync<(long DeliveryId, Guid EventId, string EventType, string Status, int Attempts, DateTime CreatedUtc, DateTime? LastAttemptUtc,
            int? LastStatusCode, string? LastError, DateTime? DeliveredUtc, DateTime NextAttemptUtc)>("""
            SELECT TOP (200) DeliveryId, EventId, EventType, [Status], Attempts, CreatedUtc, LastAttemptUtc, LastStatusCode, LastError, DeliveredUtc, NextAttemptUtc
            FROM app.WebhookDeliveries WHERE IntegrationId = @i ORDER BY DeliveryId DESC
            """, new { i = r.IntegrationId });
        return Results.Ok(new
        {
            items = rows.Select(d => new { id = d.DeliveryId, eventId = d.EventId, eventType = d.EventType, status = d.Status, attempts = d.Attempts, createdUtc = d.CreatedUtc,
                lastAttemptUtc = d.LastAttemptUtc, lastStatusCode = d.LastStatusCode, lastError = d.LastError, deliveredUtc = d.DeliveredUtc,
                nextAttemptUtc = d.Status == "PENDING" ? d.NextAttemptUtc : (DateTime?)null }),
        });
    }

    static async Task<IResult> SaveWebhook(Guid id, ExtWebhookInput input, ExternalApiEndpoints.ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var (sub, secret, error) = await ExternalApiEndpoints.SaveWebhookAsync(c, s, r.IntegrationId, input, ctx.User.UserId(), ClientInfo.From(ctx).Ip);
        if (error is not null) return error;
        return Results.Ok(new { url = sub!.Url, events = sub.Events.Split(','), active = sub.IsActive, secret,
            secretNotice = secret is null ? null : "Copy this signing secret now. It is shown only once." });
    }

    static async Task<IResult> TestWebhook(Guid id, Db db, IClock clock, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var r = await FindAsync(c, id);
        if (r is null) return NotFound();
        var eventId = await WebhookWorker.EnqueueTestAsync(c, r.IntegrationId, r.IntegrationCode, clock.UtcNow);
        return eventId is null ? Problems.Create(409, "CONFLICT", "Configure and activate the webhook first.") : Results.Ok(new { eventId, status = "Queued" });
    }

    static async Task<IResult> Retry(long deliveryId, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var n = await c.ExecuteAsync("""
            UPDATE app.WebhookDeliveries SET [Status] = 'PENDING', NextAttemptUtc = SYSUTCDATETIME(), LeaseUntilUtc = NULL WHERE DeliveryId = @deliveryId AND [Status] = 'FAILED'
            """, new { deliveryId });
        if (n == 0) return Problems.Create(404, "NOT_FOUND", "No failed delivery with this id.");
        await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "WEBHOOK_DELIVERY_RETRIED", "WebhookDelivery", deliveryId.ToString(), "Failed webhook delivery queued again", ClientInfo.From(ctx).Ip);
        return Results.NoContent();
    }
}
