using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;
using OneInsure.Connect.Api.Setup;

namespace OneInsure.Connect.Api.Admin;

/// <summary>
/// /api/v1/admin/users and /api/v1/admin/roles. users.manage administers accounts; anything touching the SuperAdmin role
/// (granting it, or acting on a SuperAdmin account) and the permission matrix need roles.manage. The last active SuperAdmin
/// cannot be removed, deactivated or demoted. All actions are audited as privileged.
/// </summary>
public static class UserAdminEndpoints
{
    public sealed record CreateUserInput(string? Email, Guid? EmployeeId, string[]? Roles);
    public sealed record RolesInput(string[]? Roles);
    public sealed record PermissionsInput(string[]? Permissions);
    public sealed record LinkEmployeeInput(Guid? EmployeeId);
    const string SuperAdmin = "SuperAdmin";

    sealed record Target(long UserId, Guid PublicId, string Email, bool IsActive, bool IsSuperAdmin, long? EmployeeId);

    public static RouteGroupBuilder MapUserAdminEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/admin");

        g.MapGet("/users", async (string? search, string? status, int? page, int? pageSize, Db db) =>
        {
            var size = Math.Clamp(pageSize ?? 25, 5, 100);
            var p = Math.Max(page ?? 1, 1);
            var term = string.IsNullOrWhiteSpace(search) ? null : "%" + search.Trim().Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";
            const string where = """
                WHERE (@term IS NULL OR u.Email LIKE @term OR e.DisplayName LIKE @term OR e.EmployeeCode LIKE @term OR u.EmployeeCode LIKE @term)
                  AND (@status = 'all' OR (@status = 'active' AND u.IsActive = 1) OR (@status = 'inactive' AND u.IsActive = 0)
                       OR (@status = 'locked' AND (u.IsLocked = 1 OR u.LockoutEndUtc > SYSUTCDATETIME())))
                """;
            using var c = await db.OpenAsync();
            using var multi = await c.QueryMultipleAsync($"""
                SELECT COUNT(*) FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId {where};
                SELECT u.PublicId AS id, u.Email AS email, COALESCE(e.DisplayName, u.Email) AS displayName, COALESCE(u.EmployeeCode, e.EmployeeCode) AS employeeCode,
                       e.PublicId AS employeeId, d.Name AS department,
                       (SELECT STRING_AGG(r.Code, ',') FROM auth.UserRoles ur JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = u.UserId) AS roles,
                       u.IsActive AS isActive, CAST(CASE WHEN u.IsLocked = 1 OR u.LockoutEndUtc > SYSUTCDATETIME() THEN 1 ELSE 0 END AS BIT) AS isLocked,
                       u.MfaEnabled AS mfaEnabled, u.MustChangePassword AS mustChangePassword, u.LastLoginUtc AS lastLoginUtc
                FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId LEFT JOIN org.Departments d ON d.DepartmentId = e.DepartmentId
                {where}
                ORDER BY COALESCE(e.DisplayName, u.Email) OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
                """, new { term, status = status is "inactive" or "locked" or "all" ? status : "active", skip = (p - 1) * size, size });
            var total = await multi.ReadSingleAsync<int>();
            var items = (await multi.ReadAsync()).Select(r => (object)new
            {
                r.id, r.email, r.displayName, r.employeeCode, r.employeeId, r.department,
                roles = ((string?)r.roles ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries),
                r.isActive, r.isLocked, r.mfaEnabled, r.mustChangePassword, r.lastLoginUtc,
            }).ToList();
            return new Page<object>(items, total, p, size);
        }).RequirePermission("users.manage");

        g.MapPost("/users", async (CreateUserInput input, Db db, Passwords passwords, HttpContext ctx) =>
        {
            var v = new Validator();
            using var c = await db.OpenAsync();
            long? employeeId = null;
            string? email = v.Email("email", input.Email, "E-mail", required: input.EmployeeId is null);
            if (input.EmployeeId is { } eid)
            {
                var emp = await c.QuerySingleOrDefaultAsync<(long EmployeeId, string OfficialEmail, bool IsActive)>(
                    "SELECT EmployeeId, OfficialEmail, IsActive FROM org.Employees WHERE PublicId = @eid", new { eid });
                if (emp.EmployeeId == 0) v.Add("employeeId", "Employee not found.");
                else if (!emp.IsActive) v.Add("employeeId", "The employee is inactive.");
                else { employeeId = emp.EmployeeId; email ??= emp.OfficialEmail; }
            }
            var roles = (input.Roles ?? []).Distinct().ToArray();
            if (roles.Length == 0) v.Add("roles", "Choose at least one role.");
            if (!v.IsValid) return v.Problem();
            if (roles.Contains(SuperAdmin) && !CanManageRoles(ctx)) return Forbidden("Only a Super Administrator can grant the Super Administrator role.");
            var unknown = await UnknownRoles(c, roles);
            if (unknown.Length > 0) return Problems.Create(400, "VALIDATION", "Unknown role(s): " + string.Join(", ", unknown));

            // Explain the two duplicate cases precisely (the unique indexes are the final guard below).
            if (employeeId is not null && await c.QuerySingleOrDefaultAsync<string?>("SELECT Email FROM auth.Users WHERE EmployeeId = @employeeId", new { employeeId }) is { } linked)
                return Db_.Conflict($"This employee already has a user account ({linked}).");
            if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM auth.Users WHERE Email = @email AND EmployeeId IS NULL", new { email }) > 0)
                return Db_.Conflict(employeeId is null
                    ? "A user with this e-mail already exists."
                    : $"An account with the e-mail {email} already exists but is not linked to an employee. Link it instead: Administration → Users & roles → Link to employee.");

            var oneTime = AdminBootstrap.GeneratePassword();
            try
            {
                using var tx = c.BeginTransaction();
                var (userId, publicId) = await c.QuerySingleAsync<(long, Guid)>("""
                    INSERT auth.Users (Email, EmployeeId, PasswordHash, PasswordChangedUtc, MustChangePassword, CreatedByUserId)
                    OUTPUT inserted.UserId, inserted.PublicId
                    VALUES (@email, @employeeId, @hash, SYSUTCDATETIME(), 1, @actor)
                    """, new { email, employeeId, hash = passwords.Hash(oneTime), actor = ctx.User.UserId() }, tx);
                await c.ExecuteAsync("INSERT auth.UserRoles (UserId, RoleId, AssignedByUserId) SELECT @userId, RoleId, @actor FROM auth.Roles WHERE Code IN @roles",
                    new { userId, roles, actor = ctx.User.UserId() }, tx);
                await Audit.WriteUserAsync(c, "USER", ctx.User.UserId(), "USER_CREATED", userId, $"User account created with roles {string.Join(", ", roles)}", ClientInfo.From(ctx).Ip, tx, privileged: true);
                tx.Commit();
                return Results.Json(new { id = publicId, email, oneTimePassword = oneTime }, statusCode: 201);
            }
            catch (SqlException e) when (e.IsUniqueViolation())
            {
                return Db_.Conflict(employeeId is not null && e.Message.Contains("EmployeeId") ? "This employee already has a user account." : "A user with this e-mail already exists.");
            }
        }).RequirePermission("users.manage");

        g.MapPut("/users/{id:guid}/roles", async (Guid id, RolesInput input, Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var t = await GetTarget(c, id);
            if (t is null) return Db_.NotFound("User");
            var roles = (input.Roles ?? []).Distinct().ToArray();
            if (roles.Length == 0) return Problems.Create(400, "VALIDATION", "Choose at least one role.");
            var unknown = await UnknownRoles(c, roles);
            if (unknown.Length > 0) return Problems.Create(400, "VALIDATION", "Unknown role(s): " + string.Join(", ", unknown));
            var grantsOrRevokesSuper = t.IsSuperAdmin != roles.Contains(SuperAdmin);
            if ((grantsOrRevokesSuper || t.IsSuperAdmin) && !CanManageRoles(ctx)) return Forbidden("Only a Super Administrator can change Super Administrator access.");
            if (t.IsSuperAdmin && !roles.Contains(SuperAdmin))
            {
                if (t.UserId == ctx.User.UserId()) return Db_.Conflict("You cannot remove your own Super Administrator role.");
                if (await ActiveSuperAdmins(c) <= 1) return Db_.Conflict("At least one active Super Administrator must remain.");
            }
            using var tx = c.BeginTransaction();
            await c.ExecuteAsync("""
                DELETE FROM auth.UserRoles WHERE UserId = @userId AND RoleId NOT IN (SELECT RoleId FROM auth.Roles WHERE Code IN @roles);
                INSERT auth.UserRoles (UserId, RoleId, AssignedByUserId)
                SELECT @userId, r.RoleId, @actor FROM auth.Roles r WHERE r.Code IN @roles AND NOT EXISTS (SELECT 1 FROM auth.UserRoles x WHERE x.UserId = @userId AND x.RoleId = r.RoleId);
                """, new { userId = t.UserId, roles, actor = ctx.User.UserId() }, tx);
            await Audit.WriteUserAsync(c, "USER", ctx.User.UserId(), "USER_ROLES_CHANGED", t.UserId, $"Roles set to {string.Join(", ", roles)}", ClientInfo.From(ctx).Ip, tx, privileged: true);
            tx.Commit();
            return Results.NoContent();
        }).RequirePermission("users.manage");

        // Link an existing account to its employee record (e.g. the first SuperAdmin from setup-admin, or an account created
        // with "e-mail only"), change the link, or remove it (employeeId null). Meetings, calendar and availability need the link.
        g.MapPut("/users/{id:guid}/employee", (Guid id, LinkEmployeeInput input, Db db, IClock clock, HttpContext ctx) => Act(id, db, ctx, async (c, t, tx) =>
        {
            var oldEmployee = t.EmployeeId is null ? null
                : await c.QuerySingleOrDefaultAsync<Guid?>("SELECT PublicId FROM org.Employees WHERE EmployeeId = @e", new { e = t.EmployeeId }, tx);
            long? newEmployeeId = null;
            if (input.EmployeeId is { } eid)
            {
                var emp = await c.QuerySingleOrDefaultAsync<(long EmployeeId, bool IsActive, string DisplayName)>(
                    "SELECT EmployeeId, IsActive, DisplayName FROM org.Employees WHERE PublicId = @eid", new { eid }, tx);
                var v = new Validator();
                if (emp.EmployeeId == 0) v.Add("employeeId", "Employee not found.");
                else if (!emp.IsActive) v.Add("employeeId", "The employee is inactive. Activate the employee first.");
                if (!v.IsValid) return v.Problem();
                if (emp.EmployeeId == t.EmployeeId) return Results.NoContent();
                var owner = await c.QuerySingleOrDefaultAsync<string?>("SELECT Email FROM auth.Users WHERE EmployeeId = @e AND UserId <> @u",
                    new { e = emp.EmployeeId, u = t.UserId }, tx);
                if (owner is not null) return Db_.Conflict($"{emp.DisplayName} is already linked to the account {owner}. Unlink it there first.");
                newEmployeeId = emp.EmployeeId;
            }
            else
            {
                if (t.EmployeeId is null) return Results.NoContent();
                // Unlinking would orphan the account from meetings it organises: they stay with the employee record, but the
                // user could no longer see or manage them. Refuse while upcoming meetings exist (cancel or hand them over first).
                var upcoming = await c.ExecuteScalarAsync<int>("""
                    SELECT COUNT(*) FROM mtg.Meetings WHERE (HostEmployeeId = @e OR CreatedByEmployeeId = @e)
                      AND [Status] IN ('SCHEDULED', 'DRAFT') AND ScheduledEndUtc > @now
                    """, new { e = t.EmployeeId, now = clock.UtcNow }, tx);
                if (upcoming > 0)
                    return Db_.Conflict($"This account organises {upcoming} upcoming meeting(s) through its employee record. Link it to another employee instead, or cancel those meetings before unlinking.");
            }
            // The employee record's code becomes the sign-in code: an old account-level code would otherwise keep working.
            await c.ExecuteAsync("""
                UPDATE auth.Users SET EmployeeId = @newEmployeeId, EmployeeCode = CASE WHEN @newEmployeeId IS NULL THEN EmployeeCode ELSE NULL END,
                    ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @actor WHERE UserId = @userId
                """, new { newEmployeeId, actor = ctx.User.UserId(), userId = t.UserId }, tx);
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), newEmployeeId is null ? "USER_EMPLOYEE_UNLINKED" : "USER_EMPLOYEE_LINKED", "User", t.PublicId.ToString(),
                newEmployeeId is null ? "User account unlinked from its employee record" : "User account linked to an employee record",
                ClientInfo.From(ctx).Ip, tx, privileged: true, newValues: new { oldEmployeeId = oldEmployee, newEmployeeId = input.EmployeeId });
            return Results.NoContent();
        })).RequirePermission("users.manage");

        g.MapPost("/users/{id:guid}/reset-password",(Guid id, Db db, Passwords passwords, HttpContext ctx) => Act(id, db, ctx, async (c, t, tx) =>
        {
            var oneTime = AdminBootstrap.GeneratePassword();
            await c.ExecuteAsync("""
                UPDATE auth.Users SET PasswordHash = @hash, PasswordChangedUtc = SYSUTCDATETIME(), MustChangePassword = 1, SecurityStamp = NEWID(),
                    FailedLoginCount = 0, LockoutEndUtc = NULL, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @actor WHERE UserId = @userId;
                UPDATE auth.UserSessions SET RevokedUtc = SYSUTCDATETIME(), RevokedReason = 'ADMIN_PASSWORD_RESET' WHERE UserId = @userId AND RevokedUtc IS NULL;
                """, new { hash = passwords.Hash(oneTime), actor = ctx.User.UserId(), userId = t.UserId }, tx);
            await Audit.WriteUserAsync(c, "USER", ctx.User.UserId(), "USER_PASSWORD_RESET_BY_ADMIN", t.UserId, "One-time password issued; sessions revoked", ClientInfo.From(ctx).Ip, tx, privileged: true);
            return Results.Ok(new { oneTimePassword = oneTime });
        })).RequirePermission("users.manage");

        g.MapPost("/users/{id:guid}/unlock", (Guid id, Db db, HttpContext ctx) => Act(id, db, ctx, async (c, t, tx) =>
        {
            await c.ExecuteAsync("UPDATE auth.Users SET IsLocked = 0, FailedLoginCount = 0, LockoutEndUtc = NULL, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @actor WHERE UserId = @userId",
                new { actor = ctx.User.UserId(), userId = t.UserId }, tx);
            await Audit.WriteUserAsync(c, "USER", ctx.User.UserId(), "USER_UNLOCKED", t.UserId, "Account unlocked", ClientInfo.From(ctx).Ip, tx, privileged: true);
            return Results.NoContent();
        })).RequirePermission("users.manage");

        g.MapPost("/users/{id:guid}/reset-mfa", (Guid id, Db db, HttpContext ctx) => Act(id, db, ctx, async (c, t, tx) =>
        {
            await MfaService.DisableAsync(c, t.UserId, ctx.User.UserId(), "Authenticator app reset by an administrator", ClientInfo.From(ctx).Ip, tx);
            return Results.NoContent();
        })).RequirePermission("users.manage");

        g.MapPost("/users/{id:guid}/deactivate", (Guid id, Db db, HttpContext ctx) => Act(id, db, ctx, async (c, t, tx) =>
        {
            if (t.UserId == ctx.User.UserId()) return Db_.Conflict("You cannot deactivate your own account.");
            if (t.IsSuperAdmin && await ActiveSuperAdmins(c, tx) <= 1) return Db_.Conflict("At least one active Super Administrator must remain.");
            await c.ExecuteAsync("""
                UPDATE auth.Users SET IsActive = 0, DeactivatedUtc = SYSUTCDATETIME(), SecurityStamp = NEWID(), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @actor WHERE UserId = @userId;
                UPDATE auth.UserSessions SET RevokedUtc = SYSUTCDATETIME(), RevokedReason = 'USER_DEACTIVATED' WHERE UserId = @userId AND RevokedUtc IS NULL;
                """, new { actor = ctx.User.UserId(), userId = t.UserId }, tx);
            await Audit.WriteUserAsync(c, "USER", ctx.User.UserId(), "USER_DEACTIVATED", t.UserId, "Account deactivated; sessions revoked", ClientInfo.From(ctx).Ip, tx, privileged: true);
            return Results.NoContent();
        })).RequirePermission("users.manage");

        g.MapPost("/users/{id:guid}/activate", (Guid id, Db db, HttpContext ctx) => Act(id, db, ctx, async (c, t, tx) =>
        {
            if (t.EmployeeId is not null && !await c.ExecuteScalarAsync<bool>("SELECT IsActive FROM org.Employees WHERE EmployeeId = @e", new { e = t.EmployeeId }, tx))
                return Db_.Conflict("The linked employee is inactive. Re-activate the employee first.");
            await c.ExecuteAsync("UPDATE auth.Users SET IsActive = 1, DeactivatedUtc = NULL, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @actor WHERE UserId = @userId",
                new { actor = ctx.User.UserId(), userId = t.UserId }, tx);
            await Audit.WriteUserAsync(c, "USER", ctx.User.UserId(), "USER_ACTIVATED", t.UserId, "Account activated", ClientInfo.From(ctx).Ip, tx, privileged: true);
            return Results.NoContent();
        })).RequirePermission("users.manage");

        // ---- Roles & permission matrix ------------------------------------------------------------------------
        g.MapGet("/roles", async (Db db) =>
        {
            using var c = await db.OpenAsync();
            var rows = await c.QueryAsync("""
                SELECT r.Code AS code, r.Name AS name, r.Description AS description, r.IsSystem AS isSystem,
                       (SELECT COUNT(*) FROM auth.UserRoles ur JOIN auth.Users u ON u.UserId = ur.UserId WHERE ur.RoleId = r.RoleId AND u.IsActive = 1) AS userCount,
                       (SELECT STRING_AGG(p.Code, ',') FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE rp.RoleId = r.RoleId) AS permissions
                FROM auth.Roles r ORDER BY r.RoleId
                """);
            return rows.Select(r => new
            {
                r.code, r.name, r.description, r.isSystem, r.userCount,
                permissions = ((string?)r.permissions ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).Order().ToArray(),
            });
        }).RequirePermission("users.manage");

        g.MapGet("/permissions", async (Db db) =>
        {
            using var c = await db.OpenAsync();
            return await c.QueryAsync("SELECT Code AS code, Module AS module, Description AS description FROM auth.Permissions ORDER BY Module, Code");
        }).RequirePermission("users.manage");

        g.MapPut("/roles/{code}/permissions", async (string code, PermissionsInput input, Db db, HttpContext ctx) =>
        {
            var perms = (input.Permissions ?? []).Distinct().ToArray();
            using var c = await db.OpenAsync();
            var roleId = await c.QuerySingleOrDefaultAsync<int?>("SELECT RoleId FROM auth.Roles WHERE Code = @code", new { code });
            if (roleId is null) return Db_.NotFound("Role");
            var known = (await c.QueryAsync<string>("SELECT Code FROM auth.Permissions WHERE Code IN @perms", new { perms = perms.DefaultIfEmpty("") })).ToHashSet();
            var unknown = perms.Where(p => !known.Contains(p)).ToArray();
            if (unknown.Length > 0) return Problems.Create(400, "VALIDATION", "Unknown permission(s): " + string.Join(", ", unknown));
            if (code == SuperAdmin && !perms.Contains("roles.manage"))
                return Db_.Conflict("The Super Administrator role must keep roles.manage, otherwise nobody could administer roles.");
            using var tx = c.BeginTransaction();
            await c.ExecuteAsync("""
                DELETE FROM auth.RolePermissions WHERE RoleId = @roleId AND PermissionId NOT IN (SELECT PermissionId FROM auth.Permissions WHERE Code IN @perms);
                INSERT auth.RolePermissions (RoleId, PermissionId, GrantedByUserId)
                SELECT @roleId, p.PermissionId, @actor FROM auth.Permissions p
                WHERE p.Code IN @perms AND NOT EXISTS (SELECT 1 FROM auth.RolePermissions x WHERE x.RoleId = @roleId AND x.PermissionId = p.PermissionId);
                """, new { roleId, perms = perms.DefaultIfEmpty(""), actor = ctx.User.UserId() }, tx);
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "ROLE_PERMISSIONS_CHANGED", "Role", code, $"Permissions of {code} set ({perms.Length})",
                ClientInfo.From(ctx).Ip, tx, privileged: true, newValues: new { permissions = perms });
            tx.Commit();
            return Results.NoContent();
        }).RequirePermission("roles.manage");

        return api;
    }

    static bool CanManageRoles(HttpContext ctx) => ctx.User.HasClaim(SessionClaims.Permission, "roles.manage");
    static IResult Forbidden(string detail) => Problems.Create(403, "FORBIDDEN", detail);

    static async Task<string[]> UnknownRoles(IDbConnection c, string[] roles)
    {
        var known = (await c.QueryAsync<string>("SELECT Code FROM auth.Roles WHERE Code IN @roles", new { roles })).ToHashSet();
        return roles.Where(r => !known.Contains(r)).ToArray();
    }

    static Task<int> ActiveSuperAdmins(IDbConnection c, IDbTransaction? tx = null) => c.ExecuteScalarAsync<int>("""
        SELECT COUNT(*) FROM auth.Users u JOIN auth.UserRoles ur ON ur.UserId = u.UserId JOIN auth.Roles r ON r.RoleId = ur.RoleId
        WHERE r.Code = 'SuperAdmin' AND u.IsActive = 1
        """, transaction: tx);

    static Task<Target?> GetTarget(IDbConnection c, Guid id, IDbTransaction? tx = null) => c.QuerySingleOrDefaultAsync<Target>("""
        SELECT u.UserId, u.PublicId, u.Email, u.IsActive,
               CAST(CASE WHEN EXISTS (SELECT 1 FROM auth.UserRoles ur JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = u.UserId AND r.Code = 'SuperAdmin') THEN 1 ELSE 0 END AS BIT) AS IsSuperAdmin,
               u.EmployeeId
        FROM auth.Users u WHERE u.PublicId = @id
        """, new { id }, tx);

    /// <summary>Common shape of account actions: load target, refuse SuperAdmin targets without roles.manage, run in a transaction.</summary>
    static async Task<IResult> Act(Guid id, Db db, HttpContext ctx, Func<IDbConnection, Target, IDbTransaction, Task<IResult>> action)
    {
        using var c = await db.OpenAsync();
        using var tx = c.BeginTransaction();
        var t = await GetTarget(c, id, tx);
        if (t is null) return Db_.NotFound("User");
        if (t.IsSuperAdmin && t.UserId != ctx.User.UserId() && !CanManageRoles(ctx))
            return Forbidden("Only a Super Administrator can manage another Super Administrator's account.");
        var result = await action(c, t, tx);
        if (result is IStatusCodeHttpResult { StatusCode: < 300 }) tx.Commit();
        return result;
    }
}
