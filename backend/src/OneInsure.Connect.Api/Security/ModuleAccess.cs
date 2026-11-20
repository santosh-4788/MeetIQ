using System.Data;
using Dapper;

namespace OneInsure.Connect.Api.Security;

/// <summary>
/// Per-user module access (V032). An administrator switches modules off per user (auth.UserModuleBlocks); a module that is off
/// removes its permissions (auth.ModulePermissions) from the user even when the user's roles grant them. No block = everything
/// the roles allow. Every permission check goes through auth.EffectivePermissions, so a change applies on the user's next request.
/// </summary>
public static class ModuleAccess
{
    public const string Meetings = "MEETINGS";
    public const string Chat = "CHAT";
    public const string Calls = "CALLS";
    public const string Tasks = "TASKS";

    /// <summary>All modules, in display order.</summary>
    public static readonly string[] All = [Meetings, Chat, Calls, Tasks];

    public const string CallsPermission = "chat.calls";
    public const string TasksPermission = "chat.tasks";

    /// <summary>The user's effective permission (roles minus switched-off modules).</summary>
    public static Task<bool> HasAsync(IDbConnection c, long userId, string permission, IDbTransaction? tx = null) =>
        c.ExecuteScalarAsync<bool>("SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM auth.EffectivePermissions(@userId) WHERE Code = @permission) THEN 1 ELSE 0 END AS BIT)",
            new { userId, permission }, tx);

    /// <summary>Which of these users hold the permission (effective).</summary>
    public static async Task<HashSet<long>> WhoHasAsync(IDbConnection c, IEnumerable<long> userIds, string permission, IDbTransaction? tx = null)
    {
        var ids = userIds.Distinct().ToArray();
        if (ids.Length == 0) return [];
        return (await c.QueryAsync<long>("""
            SELECT u.UserId FROM auth.Users u
            WHERE u.UserId IN @ids AND EXISTS (SELECT 1 FROM auth.EffectivePermissions(u.UserId) ep WHERE ep.Code = @permission)
            """, new { ids, permission }, tx)).ToHashSet();
    }

    /// <summary>Enabled modules from a comma-separated list of blocked ones (all four when nothing is blocked).</summary>
    public static string[] EnabledFromBlocked(string? blockedCsv)
    {
        var blocked = (blockedCsv ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return All.Where(m => !blocked.Contains(m)).ToArray();
    }

    public static async Task<string[]> EnabledAsync(IDbConnection c, long userId, IDbTransaction? tx = null)
    {
        var blocked = await c.QueryAsync<string>("SELECT ModuleCode FROM auth.UserModuleBlocks WHERE UserId = @userId", new { userId }, tx);
        return All.Where(m => !blocked.Contains(m)).ToArray();
    }

    /// <summary>Normalises an "enabled modules" list. Returns the error for the <c>access</c> field, or null when valid.</summary>
    public static string? Validate(string[]? access, out string[] enabled)
    {
        enabled = [];
        if (access is null) return "Choose which modules the user may use.";
        var codes = access.Where(a => !string.IsNullOrWhiteSpace(a)).Select(a => a.Trim().ToUpperInvariant()).Distinct().ToArray();
        var unknown = codes.Where(a => !All.Contains(a)).ToArray();
        if (unknown.Length > 0) return "Unknown module(s): " + string.Join(", ", unknown) + ". Use MEETINGS, CHAT, CALLS or TASKS.";
        if ((codes.Contains(Calls) || codes.Contains(Tasks)) && !codes.Contains(Chat))
            return "Audio calls and Notes & tasks are part of Chat: switch Chat on as well.";
        enabled = All.Where(codes.Contains).ToArray();
        return null;
    }

    /// <summary>Replaces the user's blocks so exactly <paramref name="enabled"/> are on.</summary>
    public static async Task SetAsync(IDbConnection c, long userId, string[] enabled, long? actorUserId, IDbTransaction? tx = null)
    {
        var blocked = All.Where(m => !enabled.Contains(m)).ToArray();
        await c.ExecuteAsync("DELETE FROM auth.UserModuleBlocks WHERE UserId = @userId AND ModuleCode NOT IN @blocked",
            new { userId, blocked = blocked.DefaultIfEmpty("") }, tx);
        if (blocked.Length > 0)
            await c.ExecuteAsync("""
                INSERT auth.UserModuleBlocks (UserId, ModuleCode, CreatedByUserId)
                SELECT @userId, @module, @actorUserId
                WHERE NOT EXISTS (SELECT 1 FROM auth.UserModuleBlocks x WHERE x.UserId = @userId AND x.ModuleCode = @module)
                """, blocked.Select(module => new { userId, module, actorUserId }), tx);
    }
}
