using System.Data;
using System.Globalization;
using System.Text;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Org;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Employees;

/// <summary>/api/v1/employees/* — employee master (independent of Prarambh). Addressed by PublicId. Writes: employees.manage.</summary>
public static class EmployeeEndpoints
{
    public sealed record EmployeeInput(string? EmployeeCode, string? FirstName, string? LastName, string? DisplayName, string? OfficialEmail,
        string? Mobile, string? DepartmentCode, string? DesignationCode, string? BranchCode, Guid? ReportingManagerId, DateOnly? DateOfJoining);
    public sealed record ImportInput(string? Csv, bool DryRun);

    const string ListColumns = """
        e.PublicId AS id, e.EmployeeCode AS employeeCode, e.FirstName AS firstName, e.LastName AS lastName, e.DisplayName AS displayName,
        e.OfficialEmail AS officialEmail, e.Mobile AS mobile, d.Code AS departmentCode, d.Name AS department, g.Code AS designationCode,
        g.Name AS designation, b.Code AS branchCode, b.Name AS branch, m.PublicId AS reportingManagerId, m.DisplayName AS reportingManagerName,
        e.DateOfJoining AS dateOfJoining, e.IsActive AS isActive,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM auth.Users u WHERE u.EmployeeId = e.EmployeeId) THEN 1 ELSE 0 END AS BIT) AS hasUserAccount
        """;
    const string ListFrom = """
        FROM org.Employees e JOIN org.Departments d ON d.DepartmentId = e.DepartmentId JOIN org.Designations g ON g.DesignationId = e.DesignationId
        LEFT JOIN org.Branches b ON b.BranchId = e.BranchId LEFT JOIN org.Employees m ON m.EmployeeId = e.ReportingManagerId
        """;

    public static RouteGroupBuilder MapEmployeeEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/employees");

        g.MapGet("", async (string? search, string? department, string? designation, string? branch, string? status, int? page, int? pageSize, string? sort, Db db) =>
        {
            var size = Math.Clamp(pageSize ?? 25, 5, 100);
            var p = Math.Max(page ?? 1, 1);
            var orderBy = sort switch { "code" => "e.EmployeeCode", "joined" => "e.DateOfJoining DESC, e.DisplayName", "department" => "d.Name, e.DisplayName", _ => "e.DisplayName" };
            var where = """
                WHERE (@search IS NULL OR e.DisplayName LIKE @like OR e.EmployeeCode LIKE @like OR e.OfficialEmail LIKE @like OR e.Mobile LIKE @like)
                  AND (@department IS NULL OR d.Code = @department) AND (@designation IS NULL OR g.Code = @designation)
                  AND (@branch IS NULL OR b.Code = @branch)
                  AND (@status = 'all' OR (@status = 'inactive' AND e.IsActive = 0) OR (@status = 'active' AND e.IsActive = 1))
                """;
            var term = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
            var prm = new
            {
                search = term, like = term is null ? null : "%" + term.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%",
                department = Blank(department), designation = Blank(designation), branch = Blank(branch),
                status = status is "inactive" or "all" ? status : "active", skip = (p - 1) * size, size,
            };
            using var c = await db.OpenAsync();
            using var multi = await c.QueryMultipleAsync($"""
                SELECT COUNT(*) {ListFrom} {where};
                SELECT {ListColumns} {ListFrom} {where} ORDER BY {orderBy} OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
                """, prm);
            var total = await multi.ReadSingleAsync<int>();
            var items = (await multi.ReadAsync()).ToList();
            return new Page<dynamic>(items, total, p, size);
        }).RequirePermission("employees.manage");

        // Minimal pick-list for any signed-in user (managers, team leaders, meeting participants later).
        g.MapGet("/lookup", async (string? search, Db db) =>
        {
            var term = string.IsNullOrWhiteSpace(search) ? null : "%" + search.Trim().Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";
            using var c = await db.OpenAsync();
            return await c.QueryAsync("""
                SELECT TOP (20) e.PublicId AS id, e.EmployeeCode AS employeeCode, e.DisplayName AS displayName, d.Name AS department, g.Name AS designation
                FROM org.Employees e JOIN org.Departments d ON d.DepartmentId = e.DepartmentId JOIN org.Designations g ON g.DesignationId = e.DesignationId
                WHERE e.IsActive = 1 AND (@term IS NULL OR e.DisplayName LIKE @term OR e.EmployeeCode LIKE @term)
                ORDER BY e.DisplayName
                """, new { term });
        }).RequireSession();

        g.MapGet("/{id:guid}", async (Guid id, Db db) =>
        {
            using var c = await db.OpenAsync();
            var e = await c.QuerySingleOrDefaultAsync($"SELECT {ListColumns} {ListFrom} WHERE e.PublicId = @id", new { id });
            if (e is null) return Db_.NotFound("Employee");
            var teams = await c.QueryAsync("""
                SELECT t.Code AS code, t.Name AS name FROM org.TeamMembers m JOIN org.Teams t ON t.TeamId = m.TeamId
                JOIN org.Employees e ON e.EmployeeId = m.EmployeeId WHERE e.PublicId = @id AND m.ToUtc IS NULL ORDER BY t.Name
                """, new { id });
            var account = await c.QuerySingleOrDefaultAsync("""
                SELECT u.PublicId AS id, u.Email AS email, u.IsActive AS isActive, u.MfaEnabled AS mfaEnabled, u.LastLoginUtc AS lastLoginUtc,
                       (SELECT STRING_AGG(r.Code, ',') FROM auth.UserRoles ur JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = u.UserId) AS roles
                FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE e.PublicId = @id
                """, new { id });
            var directReports = await c.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM org.Employees r JOIN org.Employees e ON e.EmployeeId = r.ReportingManagerId WHERE e.PublicId = @id AND r.IsActive = 1", new { id });
            // No linked account, but one with the employee's official e-mail exists (e.g. the first SuperAdmin from setup-admin):
            // the UI offers to link it instead of creating a second account (which would fail on the unique e-mail).
            var matchingAccount = account is not null ? null : await c.QuerySingleOrDefaultAsync("""
                SELECT u.PublicId AS id, u.Email AS email, u.IsActive AS isActive, le.DisplayName AS linkedEmployeeName
                FROM auth.Users u JOIN org.Employees e ON e.OfficialEmail = u.Email LEFT JOIN org.Employees le ON le.EmployeeId = u.EmployeeId
                WHERE e.PublicId = @id
                """, new { id });
            return Results.Ok(new { employee = e, teams, userAccount = account, matchingAccount, directReports });
        }).RequirePermission("employees.manage");

        g.MapPost("", (EmployeeInput input, Db db, HttpContext ctx) => Save(null, input, db, ctx)).RequirePermission("employees.manage");
        g.MapPut("/{id:guid}", (Guid id, EmployeeInput input, Db db, HttpContext ctx) => Save(id, input, db, ctx)).RequirePermission("employees.manage");

        g.MapPost("/{id:guid}/deactivate", async (Guid id, Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var emp = await c.QuerySingleOrDefaultAsync<long?>("SELECT EmployeeId FROM org.Employees WHERE PublicId = @id", new { id });
            if (emp is null) return Db_.NotFound("Employee");
            var self = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM auth.Users WHERE UserId = @u AND EmployeeId = @emp", new { u = ctx.User.UserId(), emp });
            if (self > 0) return Db_.Conflict("You cannot deactivate your own employee record.");
            using var tx = c.BeginTransaction();
            // Leaving employees lose access immediately: linked account disabled and all sessions revoked.
            await c.ExecuteAsync("""
                UPDATE org.Employees SET IsActive = 0, DeactivatedUtc = SYSUTCDATETIME(), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @u WHERE EmployeeId = @emp;
                UPDATE auth.Users SET IsActive = 0, DeactivatedUtc = SYSUTCDATETIME(), SecurityStamp = NEWID(), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @u WHERE EmployeeId = @emp;
                UPDATE s SET RevokedUtc = SYSUTCDATETIME(), RevokedReason = 'EMPLOYEE_DEACTIVATED'
                FROM auth.UserSessions s JOIN auth.Users x ON x.UserId = s.UserId WHERE x.EmployeeId = @emp AND s.RevokedUtc IS NULL;
                UPDATE org.TeamMembers SET ToUtc = SYSUTCDATETIME() WHERE EmployeeId = @emp AND ToUtc IS NULL;
                """, new { emp, u = ctx.User.UserId() }, tx);
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "EMPLOYEE_DEACTIVATED", "Employee", id.ToString(), "Employee deactivated; user account disabled, sessions revoked", ClientInfo.From(ctx).Ip, tx, privileged: true);
            tx.Commit();
            return Results.NoContent();
        }).RequirePermission("employees.manage");

        g.MapPost("/{id:guid}/activate", async (Guid id, Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync("UPDATE org.Employees SET IsActive = 1, DeactivatedUtc = NULL, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @u WHERE PublicId = @id",
                new { id, u = ctx.User.UserId() });
            if (n == 0) return Db_.NotFound("Employee");
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "EMPLOYEE_ACTIVATED", "Employee", id.ToString(), "Employee re-activated (user account stays disabled until re-enabled)", ClientInfo.From(ctx).Ip);
            return Results.NoContent();
        }).RequirePermission("employees.manage");

        g.MapGet("/import/template", () => Results.Text(string.Join(',', ImportColumns) + "\r\n", "text/csv", Encoding.UTF8)).RequirePermission("employees.manage");
        g.MapPost("/import", (ImportInput input, Db db, HttpContext ctx) => Import(input, db, ctx)).RequirePermission("employees.manage");

        return api;
    }

    static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim().ToUpperInvariant();

    sealed record Ident(long EmployeeId, string EmployeeCode);
    sealed record Resolved(string Code, string First, string? Last, string Display, string Email, string? Mobile, long Dept, long Desig, long? Branch, long? Manager, DateOnly? Joined);

    static async Task<(Resolved? Value, Validator V)> Resolve(IDbConnection c, EmployeeInput i, string? fixedCode, long? selfId, IDbTransaction? tx = null)
    {
        var v = new Validator();
        var code = fixedCode ?? v.Code("employeeCode", i.EmployeeCode, "Employee code");
        var first = v.Required("firstName", i.FirstName, 100, "First name");
        var last = v.Optional("lastName", i.LastName, 100, "Last name");
        var display = v.Optional("displayName", i.DisplayName, 200, "Display name") ?? string.Join(' ', new[] { first, last }.Where(x => x is not null));
        var email = v.Email("officialEmail", i.OfficialEmail, "Official e-mail");
        var mobile = v.Mobile("mobile", i.Mobile);
        v.Required("departmentCode", i.DepartmentCode, 30, "Department");
        v.Required("designationCode", i.DesignationCode, 30, "Designation");
        if (i.DateOfJoining is { } d && (d.Year < 1950 || d > DateOnly.FromDateTime(DateTime.UtcNow.AddYears(1)))) v.Add("dateOfJoining", "Enter a realistic date of joining.");
        if (!v.IsValid) return (null, v);
        var dept = await OrgEndpoints.ResolveCode(c, "org.Departments", "DepartmentId", i.DepartmentCode, v, "departmentCode", "Department", tx);
        var desig = await OrgEndpoints.ResolveCode(c, "org.Designations", "DesignationId", i.DesignationCode, v, "designationCode", "Designation", tx);
        var branch = await OrgEndpoints.ResolveCode(c, "org.Branches", "BranchId", i.BranchCode, v, "branchCode", "Branch", tx);
        var manager = await OrgEndpoints.ResolveEmployee(c, i.ReportingManagerId, v, "reportingManagerId", "Reporting manager", tx);
        if (manager is not null && selfId is not null && await CreatesCycle(c, selfId.Value, manager.Value, tx))
            v.Add("reportingManagerId", "This reporting manager would create a reporting loop.");
        return v.IsValid ? (new Resolved(code!, first!, last, display, email!, mobile, dept!.Value, desig!.Value, branch, manager, i.DateOfJoining), v) : (null, v);
    }

    /// <summary>True when <paramref name="managerId"/> is the employee or reports (directly or indirectly) to the employee.</summary>
    static async Task<bool> CreatesCycle(IDbConnection c, long employeeId, long managerId, IDbTransaction? tx) =>
        await c.ExecuteScalarAsync<int>("""
            WITH chain AS (
                SELECT EmployeeId, ReportingManagerId, 1 AS depth FROM org.Employees WHERE EmployeeId = @managerId
                UNION ALL
                SELECT e.EmployeeId, e.ReportingManagerId, chain.depth + 1 FROM org.Employees e JOIN chain ON e.EmployeeId = chain.ReportingManagerId WHERE chain.depth < 50)
            SELECT COUNT(*) FROM chain WHERE EmployeeId = @employeeId
            """, new { employeeId, managerId }, tx) > 0;

    static async Task<IResult> Save(Guid? id, EmployeeInput input, Db db, HttpContext ctx)
    {
        using var c = await db.OpenAsync();
        long? selfId = null;
        string? existingCode = null;
        if (id is not null)
        {
            var row = await c.QuerySingleOrDefaultAsync<Ident>("SELECT EmployeeId, EmployeeCode FROM org.Employees WHERE PublicId = @id", new { id });
            if (row is null) return Db_.NotFound("Employee");
            (selfId, existingCode) = (row.EmployeeId, row.EmployeeCode);
        }
        var (r, v) = await Resolve(c, input, existingCode, selfId);
        if (r is null) return v.Problem();
        var p = new { id, r.Code, r.First, r.Last, r.Display, r.Email, r.Mobile, r.Dept, r.Desig, r.Branch, r.Manager, joined = r.Joined?.ToDateTime(TimeOnly.MinValue), user = ctx.User.UserId() };
        try
        {
            using var tx = c.BeginTransaction();
            Guid publicId;
            if (id is null)
                publicId = await c.QuerySingleAsync<Guid>("""
                    INSERT org.Employees (EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, Mobile, DepartmentId, DesignationId, BranchId, ReportingManagerId, DateOfJoining, CreatedByUserId)
                    OUTPUT inserted.PublicId
                    VALUES (@Code, @First, @Last, @Display, @Email, @Mobile, @Dept, @Desig, @Branch, @Manager, @joined, @user)
                    """, p, tx);
            else
            {
                await c.ExecuteAsync("""
                    UPDATE org.Employees SET FirstName = @First, LastName = @Last, DisplayName = @Display, OfficialEmail = @Email, Mobile = @Mobile,
                        DepartmentId = @Dept, DesignationId = @Desig, BranchId = @Branch, ReportingManagerId = @Manager, DateOfJoining = @joined,
                        ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                    WHERE PublicId = @id
                    """, p, tx);
                publicId = id.Value;
            }
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), id is null ? "EMPLOYEE_CREATED" : "EMPLOYEE_UPDATED", "Employee", publicId.ToString(),
                $"Employee {r.Code} {(id is null ? "created" : "updated")}", ClientInfo.From(ctx).Ip, tx, newValues: input);
            tx.Commit();
            return id is null ? Results.Json(new { id = publicId }, statusCode: 201) : Results.NoContent();
        }
        catch (SqlException e) when (e.IsUniqueViolation())
        {
            return Db_.Conflict(e.Message.Contains("OfficialEmail") ? "Another employee already uses this official e-mail." : $"Employee code {r.Code} already exists.");
        }
    }

    // ---- CSV import ---------------------------------------------------------------------------------------------

    static readonly string[] ImportColumns =
        ["EmployeeCode", "FirstName", "LastName", "DisplayName", "OfficialEmail", "Mobile", "DepartmentCode", "DesignationCode", "BranchCode", "ReportingManagerCode", "DateOfJoining"];
    const int MaxImportRows = 5000;

    public sealed record ImportRowResult(int Row, string? EmployeeCode, string Action, IReadOnlyDictionary<string, string> Errors);

    /// <summary>
    /// Upsert by EmployeeCode. Validates every row first; applies nothing unless all rows are valid (all-or-nothing).
    /// Reporting managers may reference employees in the same file. DateOfJoining: yyyy-MM-dd.
    /// </summary>
    static async Task<IResult> Import(ImportInput input, Db db, HttpContext ctx)
    {
        if (string.IsNullOrWhiteSpace(input.Csv)) return Problems.Create(400, "VALIDATION", "The file is empty.");
        if (input.Csv.Length > 2_000_000) return Problems.Create(400, "VALIDATION", "The file is larger than 2 MB. Split it into smaller files.");
        var rows = Csv.Parse(input.Csv);
        if (rows.Count < 2) return Problems.Create(400, "VALIDATION", "The file has no data rows.");
        var header = rows[0].Select(h => h.Trim()).ToList();
        var missing = new[] { "EmployeeCode", "FirstName", "OfficialEmail", "DepartmentCode", "DesignationCode" }.Where(m => !header.Contains(m, StringComparer.OrdinalIgnoreCase)).ToList();
        if (missing.Count > 0) return Problems.Create(400, "VALIDATION", "Missing columns: " + string.Join(", ", missing) + ". Download the template.");
        if (rows.Count - 1 > MaxImportRows) return Problems.Create(400, "VALIDATION", $"At most {MaxImportRows} rows per file.");
        string? Col(List<string> r, string name) { var i = header.FindIndex(h => h.Equals(name, StringComparison.OrdinalIgnoreCase)); return i >= 0 && i < r.Count ? r[i] : null; }

        using var c = await db.OpenAsync();
        using var tx = c.BeginTransaction();
        var results = new List<ImportRowResult>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pendingManagers = new List<(string Code, string ManagerCode, int Row)>();

        for (var n = 1; n < rows.Count; n++)
        {
            var r = rows[n];
            if (r.All(string.IsNullOrWhiteSpace)) continue;
            var code = Col(r, "EmployeeCode")?.Trim().ToUpperInvariant();
            DateOnly? joined = null;
            var v0 = new Validator();
            var rawDate = Col(r, "DateOfJoining")?.Trim();
            if (!string.IsNullOrEmpty(rawDate))
            {
                if (DateOnly.TryParseExact(rawDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) joined = d;
                else v0.Add("dateOfJoining", "Use the format yyyy-MM-dd.");
            }
            if (code is not null && !seen.Add(code)) v0.Add("employeeCode", "Duplicate employee code in this file.");

            var existing = code is null ? null : await c.QuerySingleOrDefaultAsync<long?>("SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = @code", new { code }, tx);
            var inputRow = new EmployeeInput(code, Col(r, "FirstName"), Col(r, "LastName"), Col(r, "DisplayName"), Col(r, "OfficialEmail"), Col(r, "Mobile"),
                Col(r, "DepartmentCode"), Col(r, "DesignationCode"), Col(r, "BranchCode"), null, joined);
            var (res, v) = await Resolve(c, inputRow, existing is null ? null : code, existing, tx);
            var errors = v.Errors.Concat(v0.Errors).GroupBy(e => e.Key).ToDictionary(e => e.Key, e => e.First().Value);
            if (res is not null && errors.Count == 0)
            {
                var emailOwner = await c.QuerySingleOrDefaultAsync<string?>("SELECT EmployeeCode FROM org.Employees WHERE OfficialEmail = @Email AND EmployeeCode <> @Code", res, tx);
                if (emailOwner is not null) errors["officialEmail"] = $"Already used by employee {emailOwner}.";
            }
            if (errors.Count == 0 && res is not null)
            {
                var p = new { res.Code, res.First, res.Last, res.Display, res.Email, res.Mobile, res.Dept, res.Desig, res.Branch, joined = res.Joined?.ToDateTime(TimeOnly.MinValue), user = ctx.User.UserId() };
                if (existing is null)
                    await c.ExecuteAsync("""
                        INSERT org.Employees (EmployeeCode, FirstName, LastName, DisplayName, OfficialEmail, Mobile, DepartmentId, DesignationId, BranchId, DateOfJoining, CreatedByUserId)
                        VALUES (@Code, @First, @Last, @Display, @Email, @Mobile, @Dept, @Desig, @Branch, @joined, @user)
                        """, p, tx);
                else
                    await c.ExecuteAsync("""
                        UPDATE org.Employees SET FirstName = @First, LastName = @Last, DisplayName = @Display, OfficialEmail = @Email, Mobile = @Mobile,
                            DepartmentId = @Dept, DesignationId = @Desig, BranchId = @Branch, DateOfJoining = @joined, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                        WHERE EmployeeCode = @Code
                        """, p, tx);
                if (Col(r, "ReportingManagerCode") is { Length: > 0 } mc) pendingManagers.Add((res.Code, mc.Trim().ToUpperInvariant(), n + 1));
            }
            results.Add(new ImportRowResult(n + 1, code, errors.Count > 0 ? "ERROR" : existing is null ? "CREATE" : "UPDATE", errors));
        }

        // Second pass: managers can be rows of this file.
        foreach (var (code, managerCode, row) in pendingManagers)
        {
            var ids = await c.QuerySingleAsync<(long Self, long? Manager)>("""
                SELECT (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = @code), (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = @managerCode AND IsActive = 1)
                """, new { code, managerCode }, tx);
            string? error = ids.Manager is null ? $"Reporting manager {managerCode} not found or inactive."
                : await CreatesCycle(c, ids.Self, ids.Manager.Value, tx) ? "Reporting manager would create a reporting loop." : null;
            if (error is null)
                await c.ExecuteAsync("UPDATE org.Employees SET ReportingManagerId = @m WHERE EmployeeId = @s", new { m = ids.Manager, s = ids.Self }, tx);
            else
            {
                var i = results.FindIndex(x => x.Row == row);
                results[i] = results[i] with { Action = "ERROR", Errors = new Dictionary<string, string>(results[i].Errors) { ["reportingManagerCode"] = error } };
            }
        }

        var failed = results.Count(x => x.Action == "ERROR");
        var summary = new { total = results.Count, created = results.Count(x => x.Action == "CREATE"), updated = results.Count(x => x.Action == "UPDATE"), failed };
        if (input.DryRun || failed > 0)
        {
            tx.Rollback();
            return Results.Ok(new { applied = false, dryRun = input.DryRun, summary, rows = results });
        }
        await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "EMPLOYEES_IMPORTED", "Employee", null,
            $"CSV import: {summary.created} created, {summary.updated} updated", ClientInfo.From(ctx).Ip, tx, privileged: true, newValues: summary);
        tx.Commit();
        return Results.Ok(new { applied = true, dryRun = false, summary, rows = results });
    }
}

/// <summary>RFC 4180 CSV: quoted fields, escaped quotes, commas and line breaks inside quotes, CRLF or LF. Strips a UTF-8 BOM.</summary>
public static class Csv
{
    public static List<List<string>> Parse(string text)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        var s = text.TrimStart('﻿');
        for (var i = 0; i < s.Length; i++)
        {
            var ch = s[i];
            if (quoted)
            {
                if (ch == '"' && i + 1 < s.Length && s[i + 1] == '"') { field.Append('"'); i++; }
                else if (ch == '"') quoted = false;
                else field.Append(ch);
            }
            else if (ch == '"' && field.Length == 0) quoted = true;
            else if (ch == ',') { row.Add(field.ToString()); field.Clear(); }
            else if (ch == '\r') { }
            else if (ch == '\n') { row.Add(field.ToString()); field.Clear(); rows.Add(row); row = []; }
            else field.Append(ch);
        }
        if (field.Length > 0 || row.Count > 0) { row.Add(field.ToString()); rows.Add(row); }
        return rows;
    }
}
