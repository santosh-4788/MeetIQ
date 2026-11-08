using Dapper;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Admin;

/// <summary>
/// Read-only viewer over the existing append-only app.AuditLog table (V007, DENY UPDATE/DELETE to the app role).
/// This was previously a listed but unbuilt administration area ("Audit log viewer" in AdminPage.tsx). No new
/// migration: the table, its indexes and the audit.view permission (seeded to ComplianceAuditor, Admin, SuperAdmin -
/// see V010__seed_reference_data.sql) already existed; this only exposes what is already being recorded.
/// </summary>
public static class AuditEndpoints
{
    public static RouteGroupBuilder MapAuditEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/admin/audit").RequireAnyPermission("audit.view");
        g.MapGet("", List);
        g.MapGet("/filters", Filters);
        return api;
    }

    sealed record Row(long AuditId, DateTime Utc, string ActorType, string? ActorName, string? ActorEmail, string Action,
        string EntityType, string? EntityId, string? Summary, string? IpAddress, bool IsPrivileged, string? OldValuesJson, string? NewValuesJson);

    const string FromSql = """
        FROM app.AuditLog a
        LEFT JOIN auth.Users u ON u.UserId = a.ActorUserId
        LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
        """;

    static async Task<IResult> List(string? from, string? to, string? action, string? entityType, string? search, bool? privilegedOnly,
        int? page, int? pageSize, Db db)
    {
        if (!MeetingEndpoints.TryParseUtc(from, out var fromUtc)) { var v = new Validator(); v.Add("from", "from must be an ISO 8601 date-time."); return v.Problem(); }
        if (!MeetingEndpoints.TryParseUtc(to, out var toUtc)) { var v = new Validator(); v.Add("to", "to must be an ISO 8601 date-time."); return v.Problem(); }

        var term = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
        var like = term is null ? null : "%" + term.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";
        var size = Math.Clamp(pageSize ?? 25, 5, 200);
        var p = Math.Max(page ?? 1, 1);

        var prm = new DynamicParameters();
        prm.Add("from", fromUtc);
        prm.Add("to", toUtc);
        prm.Add("action", string.IsNullOrWhiteSpace(action) ? null : action.Trim());
        prm.Add("entityType", string.IsNullOrWhiteSpace(entityType) ? null : entityType.Trim());
        prm.Add("privileged", privilegedOnly == true ? (bool?)true : null);
        prm.Add("like", like);
        prm.Add("skip", (p - 1) * size);
        prm.Add("size", size);

        const string where = """
            WHERE (@from IS NULL OR a.Utc >= @from) AND (@to IS NULL OR a.Utc < @to)
              AND (@action IS NULL OR a.[Action] = @action)
              AND (@entityType IS NULL OR a.EntityType = @entityType)
              AND (@privileged IS NULL OR a.IsPrivileged = @privileged)
              AND (@like IS NULL OR a.Summary LIKE @like OR a.EntityId LIKE @like OR u.Email LIKE @like OR e.DisplayName LIKE @like)
            """;

        using var c = await db.OpenAsync();
        using var multi = await c.QueryMultipleAsync($"""
            SELECT COUNT(*) {FromSql} {where};

            SELECT a.AuditId, a.Utc, a.ActorType, e.DisplayName AS ActorName, u.Email AS ActorEmail, a.[Action], a.EntityType,
                   a.EntityId, a.Summary, a.IpAddress, a.IsPrivileged, a.OldValuesJson, a.NewValuesJson
            {FromSql} {where}
            ORDER BY a.Utc DESC, a.AuditId DESC
            OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
            """, prm);

        var total = await multi.ReadSingleAsync<int>();
        var rows = (await multi.ReadAsync<Row>()).Select(r => new
        {
            id = r.AuditId, utc = r.Utc, actorType = r.ActorType, actorName = r.ActorName ?? r.ActorEmail, actorEmail = r.ActorEmail,
            action = r.Action, entityType = r.EntityType, entityId = r.EntityId, summary = r.Summary, ipAddress = r.IpAddress,
            isPrivileged = r.IsPrivileged, oldValuesJson = r.OldValuesJson, newValuesJson = r.NewValuesJson,
        }).ToList();

        return Results.Ok(new Page<object>(rows, total, p, size));
    }

    static async Task<IResult> Filters(Db db)
    {
        using var c = await db.OpenAsync();
        using var multi = await c.QueryMultipleAsync("""
            SELECT DISTINCT [Action] FROM app.AuditLog ORDER BY [Action];
            SELECT DISTINCT EntityType FROM app.AuditLog ORDER BY EntityType;
            """);
        var actions = await multi.ReadAsync<string>();
        var entityTypes = await multi.ReadAsync<string>();
        return Results.Ok(new { actions, entityTypes });
    }
}
