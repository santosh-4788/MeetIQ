using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Org;

/// <summary>
/// /api/v1/org/* — departments, designations, branches and teams. Masters are addressed by their Code (immutable after
/// creation; internal ids never appear in URLs). Reads: any signed-in user (pick lists). Writes: org.manage. Every change is audited.
/// </summary>
public static class OrgEndpoints
{
    public sealed record DepartmentInput(string? Code, string? Name, string? ParentCode, Guid? HeadEmployeeId);
    public sealed record DesignationInput(string? Code, string? Name, int? Level);
    public sealed record BranchInput(string? Code, string? Name, string? City, string? State, string? TimeZoneId, string? Address);
    public sealed record TeamInput(string? Code, string? Name, string? DepartmentCode, Guid? TeamLeaderId);
    public sealed record TeamMembersInput(Guid[]? EmployeeIds);

    public static RouteGroupBuilder MapOrgEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/org");

        // ---- Departments --------------------------------------------------------------------------------------
        g.MapGet("/departments", async (bool? includeInactive, Db db) =>
        {
            using var c = await db.OpenAsync();
            return await c.QueryAsync("""
                SELECT d.Code AS code, d.Name AS name, p.Code AS parentCode, h.PublicId AS headEmployeeId, h.DisplayName AS headName,
                       (SELECT COUNT(*) FROM org.Employees e WHERE e.DepartmentId = d.DepartmentId AND e.IsActive = 1) AS employeeCount,
                       d.IsActive AS isActive
                FROM org.Departments d LEFT JOIN org.Departments p ON p.DepartmentId = d.ParentDepartmentId
                LEFT JOIN org.Employees h ON h.EmployeeId = d.HeadEmployeeId
                WHERE @all = 1 OR d.IsActive = 1 ORDER BY d.Name
                """, new { all = includeInactive == true });
        }).RequireSession();

        g.MapPost("/departments", (DepartmentInput input, Db db, HttpContext ctx) => SaveDepartment(null, input, db, ctx)).RequirePermission("org.manage");
        g.MapPut("/departments/{code}", (string code, DepartmentInput input, Db db, HttpContext ctx) => SaveDepartment(code, input, db, ctx)).RequirePermission("org.manage");
        g.MapPost("/departments/{code}/{action:regex(^(activate|deactivate)$)}", (string code, string action, Db db, HttpContext ctx) =>
            SetActive("org.Departments", "Department", code, action == "activate", db, ctx,
                "SELECT COUNT(*) FROM org.Employees e JOIN org.Departments d ON d.DepartmentId = e.DepartmentId WHERE d.Code = @code AND e.IsActive = 1",
                "Move or deactivate the department's active employees first.")).RequirePermission("org.manage");

        // ---- Designations -------------------------------------------------------------------------------------
        g.MapGet("/designations", async (bool? includeInactive, Db db) =>
        {
            using var c = await db.OpenAsync();
            return await c.QueryAsync("""
                SELECT d.Code AS code, d.Name AS name, d.[Level] AS level,
                       (SELECT COUNT(*) FROM org.Employees e WHERE e.DesignationId = d.DesignationId AND e.IsActive = 1) AS employeeCount,
                       d.IsActive AS isActive
                FROM org.Designations d WHERE @all = 1 OR d.IsActive = 1 ORDER BY d.[Level], d.Name
                """, new { all = includeInactive == true });
        }).RequireSession();

        g.MapPost("/designations", (DesignationInput input, Db db, HttpContext ctx) => SaveDesignation(null, input, db, ctx)).RequirePermission("org.manage");
        g.MapPut("/designations/{code}", (string code, DesignationInput input, Db db, HttpContext ctx) => SaveDesignation(code, input, db, ctx)).RequirePermission("org.manage");
        g.MapPost("/designations/{code}/{action:regex(^(activate|deactivate)$)}", (string code, string action, Db db, HttpContext ctx) =>
            SetActive("org.Designations", "Designation", code, action == "activate", db, ctx,
                "SELECT COUNT(*) FROM org.Employees e JOIN org.Designations d ON d.DesignationId = e.DesignationId WHERE d.Code = @code AND e.IsActive = 1",
                "Change the designation of its active employees first.")).RequirePermission("org.manage");

        // ---- Branches -----------------------------------------------------------------------------------------
        g.MapGet("/branches", async (bool? includeInactive, Db db) =>
        {
            using var c = await db.OpenAsync();
            return await c.QueryAsync("""
                SELECT b.Code AS code, b.Name AS name, b.City AS city, b.[State] AS state, b.TimeZoneId AS timeZoneId, b.Address AS address,
                       (SELECT COUNT(*) FROM org.Employees e WHERE e.BranchId = b.BranchId AND e.IsActive = 1) AS employeeCount,
                       b.IsActive AS isActive
                FROM org.Branches b WHERE @all = 1 OR b.IsActive = 1 ORDER BY b.Name
                """, new { all = includeInactive == true });
        }).RequireSession();

        g.MapPost("/branches", (BranchInput input, Db db, HttpContext ctx) => SaveBranch(null, input, db, ctx)).RequirePermission("org.manage");
        g.MapPut("/branches/{code}", (string code, BranchInput input, Db db, HttpContext ctx) => SaveBranch(code, input, db, ctx)).RequirePermission("org.manage");
        // Like departments and designations: an inactive branch is refused when an employee is saved, so a branch that
        // still has active employees would make those employees impossible to edit.
        g.MapPost("/branches/{code}/{action:regex(^(activate|deactivate)$)}", (string code, string action, Db db, HttpContext ctx) =>
            SetActive("org.Branches", "Branch", code, action == "activate", db, ctx,
                "SELECT COUNT(*) FROM org.Employees e JOIN org.Branches b ON b.BranchId = e.BranchId WHERE b.Code = @code AND e.IsActive = 1",
                "Move the branch's active employees to another branch first.")).RequirePermission("org.manage");

        // ---- Teams --------------------------------------------------------------------------------------------
        g.MapGet("/teams", async (bool? includeInactive, Db db) =>
        {
            using var c = await db.OpenAsync();
            return await c.QueryAsync("""
                SELECT t.Code AS code, t.Name AS name, d.Code AS departmentCode, d.Name AS departmentName,
                       l.PublicId AS teamLeaderId, l.DisplayName AS teamLeaderName,
                       (SELECT COUNT(*) FROM org.TeamMembers m JOIN org.Employees e ON e.EmployeeId = m.EmployeeId
                        WHERE m.TeamId = t.TeamId AND m.ToUtc IS NULL AND e.IsActive = 1) AS memberCount,
                       t.IsActive AS isActive
                FROM org.Teams t JOIN org.Departments d ON d.DepartmentId = t.DepartmentId LEFT JOIN org.Employees l ON l.EmployeeId = t.TeamLeaderEmployeeId
                WHERE @all = 1 OR t.IsActive = 1 ORDER BY t.Name
                """, new { all = includeInactive == true });
        }).RequireSession();

        g.MapPost("/teams", (TeamInput input, Db db, HttpContext ctx) => SaveTeam(null, input, db, ctx)).RequirePermission("org.manage");
        g.MapPut("/teams/{code}", (string code, TeamInput input, Db db, HttpContext ctx) => SaveTeam(code, input, db, ctx)).RequirePermission("org.manage");
        g.MapPost("/teams/{code}/{action:regex(^(activate|deactivate)$)}", (string code, string action, Db db, HttpContext ctx) =>
            SetActive("org.Teams", "Team", code, action == "activate", db, ctx, null, null)).RequirePermission("org.manage");

        g.MapGet("/teams/{code}/members", async (string code, Db db) =>
        {
            using var c = await db.OpenAsync();
            return await c.QueryAsync("""
                SELECT e.PublicId AS id, e.EmployeeCode AS employeeCode, e.DisplayName AS displayName, g.Name AS designation
                FROM org.TeamMembers m JOIN org.Teams t ON t.TeamId = m.TeamId JOIN org.Employees e ON e.EmployeeId = m.EmployeeId
                JOIN org.Designations g ON g.DesignationId = e.DesignationId
                WHERE t.Code = @code AND m.ToUtc IS NULL ORDER BY e.DisplayName
                """, new { code });
        }).RequireSession();

        g.MapPut("/teams/{code}/members", async (string code, TeamMembersInput input, Db db, HttpContext ctx) =>
        {
            var ids = (input.EmployeeIds ?? []).Distinct().ToArray();
            if (ids.Length > 500) return Problems.Create(400, "VALIDATION", "A team can have at most 500 members.");
            using var c = await db.OpenAsync();
            var teamId = await c.QuerySingleOrDefaultAsync<long?>("SELECT TeamId FROM org.Teams WHERE Code = @code", new { code });
            if (teamId is null) return Db_.NotFound("Team");
            var found = (await c.QueryAsync<long>("SELECT EmployeeId FROM org.Employees WHERE PublicId IN @ids AND IsActive = 1", new { ids })).ToList();
            if (found.Count != ids.Length) return Problems.Create(400, "VALIDATION", "One or more employees were not found or are inactive.");
            using var tx = c.BeginTransaction();
            // Membership history is kept: removed members get ToUtc, new members get a fresh row.
            await c.ExecuteAsync("UPDATE org.TeamMembers SET ToUtc = SYSUTCDATETIME() WHERE TeamId = @teamId AND ToUtc IS NULL AND EmployeeId NOT IN @found",
                new { teamId, found = found.DefaultIfEmpty(-1) }, tx);
            if (found.Count > 0)
                await c.ExecuteAsync("""
                MERGE org.TeamMembers AS t USING (SELECT @teamId AS TeamId, value AS EmployeeId FROM STRING_SPLIT(@list, ',')) AS s
                ON t.TeamId = s.TeamId AND t.EmployeeId = s.EmployeeId
                WHEN MATCHED AND t.ToUtc IS NOT NULL THEN UPDATE SET FromUtc = SYSUTCDATETIME(), ToUtc = NULL
                WHEN NOT MATCHED THEN INSERT (TeamId, EmployeeId) VALUES (s.TeamId, s.EmployeeId);
                """, new { teamId, list = string.Join(',', found) }, tx);
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "TEAM_MEMBERS_SET", "Team", code, $"Team members set ({found.Count})", ClientInfo.From(ctx).Ip, tx, newValues: new { employeeIds = ids });
            tx.Commit();
            return Results.NoContent();
        }).RequirePermission("org.manage");

        return api;
    }

    // ---- Writers --------------------------------------------------------------------------------------------

    static async Task<IResult> SaveDepartment(string? existingCode, DepartmentInput input, Db db, HttpContext ctx)
    {
        var v = new Validator();
        var code = existingCode ?? v.Code("code", input.Code, "Code");
        var name = v.Required("name", input.Name, 150, "Name");
        if (!v.IsValid) return v.Problem();
        using var c = await db.OpenAsync();
        var parentId = await ResolveCode(c, "org.Departments", "DepartmentId", input.ParentCode, v, "parentCode", "Parent department");
        var headId = await ResolveEmployee(c, input.HeadEmployeeId, v, "headEmployeeId", "Department head");
        if (existingCode is not null && input.ParentCode?.Trim().ToUpperInvariant() == existingCode) v.Add("parentCode", "A department cannot be its own parent.");
        if (!v.IsValid) return v.Problem();
        return await Write(c, ctx, existingCode is null ? "DEPARTMENT_CREATED" : "DEPARTMENT_UPDATED", "Department", code!, input, existingCode is null
            ? ("INSERT org.Departments (Code, Name, ParentDepartmentId, HeadEmployeeId, CreatedByUserId) VALUES (@code, @name, @parentId, @headId, @user)", new { code, name, parentId, headId, user = ctx.User.UserId() })
            : ("UPDATE org.Departments SET Name = @name, ParentDepartmentId = @parentId, HeadEmployeeId = @headId, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE Code = @code", new { code, name, parentId, headId, user = ctx.User.UserId() }),
            existingCode is null);
    }

    static async Task<IResult> SaveDesignation(string? existingCode, DesignationInput input, Db db, HttpContext ctx)
    {
        var v = new Validator();
        var code = existingCode ?? v.Code("code", input.Code, "Code");
        var name = v.Required("name", input.Name, 150, "Name");
        if (input.Level is < 0 or > 100) v.Add("level", "Level must be between 0 and 100.");
        if (!v.IsValid) return v.Problem();
        using var c = await db.OpenAsync();
        var p = new { code, name, level = input.Level, user = ctx.User.UserId() };
        return await Write(c, ctx, existingCode is null ? "DESIGNATION_CREATED" : "DESIGNATION_UPDATED", "Designation", code!, input, existingCode is null
            ? ("INSERT org.Designations (Code, Name, [Level], CreatedByUserId) VALUES (@code, @name, @level, @user)", p)
            : ("UPDATE org.Designations SET Name = @name, [Level] = @level, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE Code = @code", p),
            existingCode is null);
    }

    static async Task<IResult> SaveBranch(string? existingCode, BranchInput input, Db db, HttpContext ctx)
    {
        var v = new Validator();
        var code = existingCode ?? v.Code("code", input.Code, "Code");
        var name = v.Required("name", input.Name, 150, "Name");
        var city = v.Optional("city", input.City, 100, "City");
        var state = v.Optional("state", input.State, 100, "State");
        var address = v.Optional("address", input.Address, 500, "Address");
        var tz = v.Optional("timeZoneId", input.TimeZoneId, 64, "Time zone") ?? "Asia/Kolkata";
        if (!TimeZoneInfo.TryFindSystemTimeZoneById(tz, out _)) v.Add("timeZoneId", "Unknown time zone (use an IANA id such as Asia/Kolkata).");
        if (!v.IsValid) return v.Problem();
        using var c = await db.OpenAsync();
        var p = new { code, name, city, state, address, tz, user = ctx.User.UserId() };
        return await Write(c, ctx, existingCode is null ? "BRANCH_CREATED" : "BRANCH_UPDATED", "Branch", code!, input, existingCode is null
            ? ("INSERT org.Branches (Code, Name, City, [State], TimeZoneId, Address, CreatedByUserId) VALUES (@code, @name, @city, @state, @tz, @address, @user)", p)
            : ("UPDATE org.Branches SET Name = @name, City = @city, [State] = @state, TimeZoneId = @tz, Address = @address, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE Code = @code", p),
            existingCode is null);
    }

    static async Task<IResult> SaveTeam(string? existingCode, TeamInput input, Db db, HttpContext ctx)
    {
        var v = new Validator();
        var code = existingCode ?? v.Code("code", input.Code, "Code");
        var name = v.Required("name", input.Name, 150, "Name");
        v.Required("departmentCode", input.DepartmentCode, 30, "Department");
        if (!v.IsValid) return v.Problem();
        using var c = await db.OpenAsync();
        var deptId = await ResolveCode(c, "org.Departments", "DepartmentId", input.DepartmentCode, v, "departmentCode", "Department");
        var leaderId = await ResolveEmployee(c, input.TeamLeaderId, v, "teamLeaderId", "Team leader");
        if (!v.IsValid) return v.Problem();
        var p = new { code, name, deptId, leaderId, user = ctx.User.UserId() };
        return await Write(c, ctx, existingCode is null ? "TEAM_CREATED" : "TEAM_UPDATED", "Team", code!, input, existingCode is null
            ? ("INSERT org.Teams (Code, Name, DepartmentId, TeamLeaderEmployeeId, CreatedByUserId) VALUES (@code, @name, @deptId, @leaderId, @user)", p)
            : ("UPDATE org.Teams SET Name = @name, DepartmentId = @deptId, TeamLeaderEmployeeId = @leaderId, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE Code = @code", p),
            existingCode is null);
    }

    static async Task<IResult> Write(IDbConnection c, HttpContext ctx, string action, string entity, string code, object input, (string Sql, object Params) cmd, bool create)
    {
        try
        {
            using var tx = c.BeginTransaction();
            var n = await c.ExecuteAsync(cmd.Sql, cmd.Params, tx);
            if (n == 0) return Db_.NotFound(entity);
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), action, entity, code, $"{entity} {code} {(create ? "created" : "updated")}", ClientInfo.From(ctx).Ip, tx, newValues: input);
            tx.Commit();
            return create ? Results.Json(new { code }, statusCode: 201) : Results.NoContent();
        }
        catch (SqlException e) when (e.IsUniqueViolation())
        {
            return Db_.Conflict($"A {entity.ToLowerInvariant()} with code {code} already exists.");
        }
    }

    static async Task<IResult> SetActive(string table, string entity, string code, bool active, Db db, HttpContext ctx, string? blockerSql, string? blockerMessage)
    {
        using var c = await db.OpenAsync();
        if (!active && blockerSql is not null && await c.ExecuteScalarAsync<int>(blockerSql, new { code }) > 0)
            return Db_.Conflict(blockerMessage!);
        var n = await c.ExecuteAsync($"""
            UPDATE {table} SET IsActive = @active, DeactivatedUtc = CASE WHEN @active = 1 THEN NULL ELSE SYSUTCDATETIME() END,
                   ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
            WHERE Code = @code
            """, new { active, code, user = ctx.User.UserId() });
        if (n == 0) return Db_.NotFound(entity);
        await Audit.WriteAsync(c, "USER", ctx.User.UserId(), $"{entity.ToUpperInvariant()}_{(active ? "ACTIVATED" : "DEACTIVATED")}", entity, code,
            $"{entity} {code} {(active ? "activated" : "deactivated")}", ClientInfo.From(ctx).Ip);
        return Results.NoContent();
    }

    internal static async Task<long?> ResolveCode(IDbConnection c, string table, string idColumn, string? code, Validator v, string field, string label, IDbTransaction? tx = null)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var id = await c.QuerySingleOrDefaultAsync<long?>($"SELECT {idColumn} FROM {table} WHERE Code = @code AND IsActive = 1", new { code = code.Trim().ToUpperInvariant() }, tx);
        if (id is null) v.Add(field, $"{label} '{code}' was not found or is inactive.");
        return id;
    }

    internal static async Task<long?> ResolveEmployee(IDbConnection c, Guid? publicId, Validator v, string field, string label, IDbTransaction? tx = null)
    {
        if (publicId is null) return null;
        var id = await c.QuerySingleOrDefaultAsync<long?>("SELECT EmployeeId FROM org.Employees WHERE PublicId = @publicId AND IsActive = 1", new { publicId }, tx);
        if (id is null) v.Add(field, $"{label} was not found or is inactive.");
        return id;
    }
}
