using System.Data;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Recording;

/// <summary>The signed-in user as the recording library sees them: employee link, role codes and recording permissions.</summary>
internal sealed record Viewer(long UserId, long? EmployeeId, string[] Roles, bool ViewOwn, bool ViewTeam, bool ViewDepartment, bool ViewAll,
    bool Download, bool LegalHold, bool AuditView, bool Ops)
{
    public static async Task<Viewer> LoadAsync(IDbConnection c, ClaimsPrincipal u)
    {
        var id = u.UserId();
        var emp = await c.QuerySingleOrDefaultAsync<long?>("""
            SELECT e.EmployeeId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1 WHERE u.UserId = @id
            """, new { id });
        var roles = (await c.QueryAsync<string>("SELECT r.Code FROM auth.UserRoles ur JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE ur.UserId = @id", new { id })).ToArray();
        return new Viewer(id, emp, roles, u.Can("recordings.view.own"), u.Can("recordings.view.team"), u.Can("recordings.view.department"),
            u.Can("recordings.view.all"), u.Can("recordings.download"), u.Can("recordings.legalhold"), u.Can("audit.view"), u.Can("admin.ops"));
    }

    public object Sql => new
    {
        emp = EmployeeId, roles = Roles, viewOwn = ViewOwn, viewTeam = ViewTeam, viewDept = ViewDepartment, viewAll = ViewAll,
    };
}

/// <summary>Per-recording access facts computed in SQL (see <see cref="RecordingAccess.FlagsSql"/>).</summary>
internal interface IAccessFlags
{
    bool IsOwner { get; }
    bool PlaybackRole { get; }
    bool DownloadRole { get; }
    bool LeadsOwner { get; }
    bool HeadsOwnerDepartment { get; }
    bool OwnerCanPlay { get; }
    bool OwnerCanDownload { get; }
    bool TeamLeaderCanPlay { get; }
    bool DepartmentHeadCanPlay { get; }
}

internal sealed record Access(bool Visible, bool CanPlay, bool CanDownload, string Via);

/// <summary>
/// Who may see, play and download a recording. A recording is visible to: its owner (meeting creator, recordings.view.own);
/// the team leader of the owner's team (recordings.view.team, or the policy's team-leader flag); the head of the owner's department
/// (recordings.view.department, or the policy's department-head flag); anyone with recordings.view.all or a role listed in the
/// policy's playback roles. The owner plays only when the policy allows it. Download needs recordings.download, a role listed in the
/// policy's download roles, or (owner) the policy's owner-download flag. Recordings a user cannot see answer 404.
/// The CURRENT policy of the recording's policy code applies, so an administrator's change takes effect at once.
/// </summary>
internal static class RecordingAccess
{
    /// <summary>Columns (alias r = rec.MeetingRecordings, p = rec.RecordingPolicies) with the facts behind every decision.</summary>
    public const string FlagsSql = """
        CAST(CASE WHEN @emp IS NOT NULL AND r.OwnerEmployeeId = @emp THEN 1 ELSE 0 END AS BIT) AS IsOwner,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(ISNULL(p.PlaybackRoles, N'[]')) j WHERE j.[value] IN @roles) THEN 1 ELSE 0 END AS BIT) AS PlaybackRole,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(ISNULL(p.DownloadRoles, N'[]')) j WHERE j.[value] IN @roles) THEN 1 ELSE 0 END AS BIT) AS DownloadRole,
        CAST(CASE WHEN @emp IS NOT NULL AND EXISTS (SELECT 1 FROM org.Teams t JOIN org.TeamMembers tm ON tm.TeamId = t.TeamId AND tm.ToUtc IS NULL
                  WHERE t.IsActive = 1 AND t.TeamLeaderEmployeeId = @emp AND tm.EmployeeId = r.OwnerEmployeeId) THEN 1 ELSE 0 END AS BIT) AS LeadsOwner,
        CAST(CASE WHEN @emp IS NOT NULL AND EXISTS (SELECT 1 FROM org.Employees oe JOIN org.Departments d ON d.DepartmentId = oe.DepartmentId
                  WHERE oe.EmployeeId = r.OwnerEmployeeId AND d.HeadEmployeeId = @emp) THEN 1 ELSE 0 END AS BIT) AS HeadsOwnerDepartment,
        ISNULL(p.OwnerCanPlay, 0) AS OwnerCanPlay, ISNULL(p.OwnerCanDownload, 0) AS OwnerCanDownload,
        ISNULL(p.TeamLeaderCanPlay, 0) AS TeamLeaderCanPlay, ISNULL(p.DepartmentHeadCanPlay, 0) AS DepartmentHeadCanPlay
        """;

    /// <summary>SQL predicate (r, p) with the parameters of <see cref="Viewer.Sql"/>: may the viewer see recording r?</summary>
    public const string VisibleSql = """
        ((@emp IS NOT NULL AND @viewOwn = 1 AND r.OwnerEmployeeId = @emp)
         OR @viewAll = 1
         OR EXISTS (SELECT 1 FROM OPENJSON(ISNULL(p.PlaybackRoles, N'[]')) j WHERE j.[value] IN @roles)
         OR (@emp IS NOT NULL AND (@viewTeam = 1 OR p.TeamLeaderCanPlay = 1) AND EXISTS (SELECT 1 FROM org.Teams t JOIN org.TeamMembers tm ON tm.TeamId = t.TeamId AND tm.ToUtc IS NULL
                  WHERE t.IsActive = 1 AND t.TeamLeaderEmployeeId = @emp AND tm.EmployeeId = r.OwnerEmployeeId))
         OR (@emp IS NOT NULL AND (@viewDept = 1 OR p.DepartmentHeadCanPlay = 1) AND EXISTS (SELECT 1 FROM org.Employees oe JOIN org.Departments d ON d.DepartmentId = oe.DepartmentId
                  WHERE oe.EmployeeId = r.OwnerEmployeeId AND d.HeadEmployeeId = @emp)))
        """;

    public static Access Decide(Viewer v, IAccessFlags f)
    {
        var owner = f.IsOwner && v.ViewOwn;
        var team = f.LeadsOwner && (v.ViewTeam || f.TeamLeaderCanPlay);
        var dept = f.HeadsOwnerDepartment && (v.ViewDepartment || f.DepartmentHeadCanPlay);
        var all = v.ViewAll || f.PlaybackRole;
        var visible = owner || team || dept || all;
        var play = (owner && f.OwnerCanPlay) || team || dept || all;
        var download = visible && (v.Download || f.DownloadRole || (f.IsOwner && f.OwnerCanDownload));
        var via = all ? (v.ViewAll ? "permission:recordings.view.all" : "policy:playback-role") : team ? "team-leader" : dept ? "department-head" : owner ? "owner" : "none";
        return new Access(visible, play, download, via);
    }

    public static Task LogAsync(IDbConnection c, long recordingId, long userId, string action, HttpContext ctx, DateTime? signedUrlExpiresUtc = null)
    {
        var client = ClientInfo.From(ctx);
        return c.ExecuteAsync("""
            INSERT rec.RecordingAccessLog (RecordingId, UserId, [Action], IpAddress, UserAgent, SignedUrlExpiresUtc) VALUES (@recordingId, @userId, @action, @ip, @ua, @exp)
            """, new { recordingId, userId, action, ip = client.Ip, ua = client.UserAgent, exp = signedUrlExpiresUtc });
    }
}

/// <summary>
/// Short-lived signed media links (/api/v1/recordings/media/{token}). The token is encrypted and authenticated with ASP.NET Core
/// Data Protection, carries the recording, the user, the action (PLAY/DOWNLOAD) and its expiry, and is bound to the user's
/// session: a copied link is useless to anyone else and stops working after the policy's link lifetime.
/// </summary>
public sealed class RecordingMediaTokens(IDataProtectionProvider dp, IClock clock)
{
    readonly IDataProtector protector = dp.CreateProtector("OneInsure.Connect.RecordingMedia.v1");

    public sealed record Payload(Guid R, long U, string A, long Exp);

    public string Create(Guid recordingId, long userId, string action, DateTime expiresUtc) =>
        protector.Protect(JsonSerializer.Serialize(new Payload(recordingId, userId, action,
            new DateTimeOffset(DateTime.SpecifyKind(expiresUtc, DateTimeKind.Utc)).ToUnixTimeSeconds())));

    /// <summary>Null when the token is forged or corrupt. <paramref name="expired"/> is set for a genuine but expired token.</summary>
    public Payload? Read(string? token, out bool expired)
    {
        expired = false;
        if (string.IsNullOrEmpty(token) || token.Length > 2000) return null;
        try
        {
            var p = JsonSerializer.Deserialize<Payload>(protector.Unprotect(token));
            if (p is null) return null;
            expired = DateTimeOffset.FromUnixTimeSeconds(p.Exp) <= new DateTimeOffset(DateTime.SpecifyKind(clock.UtcNow, DateTimeKind.Utc));
            return p;
        }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException) { return null; }
    }
}
