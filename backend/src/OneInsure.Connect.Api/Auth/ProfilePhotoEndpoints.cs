using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Chat;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Auth;

/// <summary>
/// Profile pictures (24 Nov 2026). Each person changes only their own picture; it is kept in the existing private file storage
/// (Chat:StorageRoot, outside the website) and recorded in org.Employees.PhotoPath ("photos/&lt;random&gt;.jpg|png|webp").
/// Signed-in people can see colleagues' pictures through /api/v1/people/{userId}/photo; the storage path is never exposed.
/// The browser crops and shrinks the picture (256 px) before upload; the server checks size and the real file type
/// (magic bytes), stores it under a random name and tells everyone online ("photo.changed") so every avatar updates at once.
/// </summary>
public static partial class ProfilePhotoEndpoints
{
    public const int MaxBytes = 2 * 1024 * 1024;
    static readonly Dictionary<string, string> ContentTypes = new() { ["jpg"] = "image/jpeg", ["png"] = "image/png", ["webp"] = "image/webp" };

    [GeneratedRegex(@"^photos/[0-9a-f]{32}\.(jpg|png|webp)$")]
    private static partial Regex KeyRe();

    sealed record PhotoRow(Guid Id, Guid Emp, string PhotoPath);

    public static RouteGroupBuilder MapProfilePhotoEndpoints(this RouteGroupBuilder api)
    {
        var people = api.MapGroup("/people").RequireSession();
        people.MapGet("/photos", List);
        people.MapGet("/{id:guid}/photo", Get);
        var account = api.MapGroup("/account").RequireSession();
        account.MapPost("/photo", Upload).RequireRateLimiting(ChatEndpoints.UploadRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute(MaxBytes + 64 * 1024));
        account.MapDelete("/photo", Remove);
        return api;
    }

    /// <summary>Who has a picture, with a version token (the picture's file name) for the address.</summary>
    static async Task<IResult> List(Db db)
    {
        using var c = await db.OpenAsync();
        var rows = await c.QueryAsync<PhotoRow>("""
            SELECT u.PublicId AS Id, e.PublicId AS Emp, e.PhotoPath FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE u.IsActive = 1 AND e.PhotoPath IS NOT NULL
            """);
        return Results.Ok(rows.Where(r => KeyRe().IsMatch(r.PhotoPath)).Select(r => new { id = r.Id, emp = r.Emp, v = Version(r.PhotoPath) }));
    }

    static async Task<IResult> Get(Guid id, Db db, IOptions<ChatOptions> options, HttpContext ctx)
    {
        using var c = await db.OpenAsync();
        var key = await c.QuerySingleOrDefaultAsync<string?>("""
            SELECT e.PhotoPath FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.PublicId = @id AND u.IsActive = 1
            """, new { id });
        if (key is null || !KeyRe().IsMatch(key)) return Results.NotFound();
        var path = FullPath(options.Value, key);
        if (path is null || !File.Exists(path)) return Results.NotFound();
        ctx.Response.Headers.CacheControl = "private, max-age=86400"; // the address carries ?v=<version>, so a new picture is a new address
        ctx.Response.Headers.XContentTypeOptions = "nosniff";
        return Results.File(path, ContentTypes[Path.GetExtension(key).TrimStart('.')], enableRangeProcessing: false);
    }

    static async Task<IResult> Upload(HttpRequest req, Db db, IOptions<ChatOptions> options, ChatPush push, HttpContext ctx)
    {
        var userId = ctx.User.UserId();
        if (!req.HasFormContentType) return Invalid("Choose a picture.");
        var form = await req.ReadFormAsync(ctx.RequestAborted);
        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0) return Invalid("Choose a picture.");
        if (file.Length > MaxBytes) return Invalid("The picture is too large (2 MB at most).");
        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ctx.RequestAborted);
            bytes = ms.ToArray();
        }
        var ext = Sniff(bytes);
        if (ext is null) return Invalid("Use a JPG, PNG or WEBP picture.");

        using var c = await db.OpenAsync();
        var emp = await c.QuerySingleOrDefaultAsync<(long EmployeeId, string? PhotoPath, Guid PublicId, Guid EmpId)?>("""
            SELECT e.EmployeeId, e.PhotoPath, u.PublicId, e.PublicId AS EmpId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @userId
            """, new { userId });
        if (emp is null) return Problems.Create(409, "NO_EMPLOYEE", "Your account has no employee profile, so it cannot have a picture.");

        var key = $"photos/{Guid.NewGuid():N}.{ext}";
        var path = FullPath(options.Value, key)!;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, bytes, ctx.RequestAborted);
        await c.ExecuteAsync("UPDATE org.Employees SET PhotoPath = @key, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @userId WHERE EmployeeId = @emp",
            new { key, userId, emp = emp.Value.EmployeeId });
        await Audit.WriteAsync(c, "USER", userId, "PROFILE_PHOTO_CHANGED", "Employee", emp.Value.EmployeeId.ToString(), "Profile picture changed", ClientInfo.From(ctx).Ip);
        DeleteOld(options.Value, emp.Value.PhotoPath);
        await TellEveryoneAsync(c, push, emp.Value.PublicId, emp.Value.EmpId, Version(key));
        return Results.Ok(new { id = emp.Value.PublicId, emp = emp.Value.EmpId, v = Version(key) });
    }

    static async Task<IResult> Remove(Db db, IOptions<ChatOptions> options, ChatPush push, HttpContext ctx)
    {
        var userId = ctx.User.UserId();
        using var c = await db.OpenAsync();
        var emp = await c.QuerySingleOrDefaultAsync<(long EmployeeId, string? PhotoPath, Guid PublicId, Guid EmpId)?>("""
            SELECT e.EmployeeId, e.PhotoPath, u.PublicId, e.PublicId AS EmpId FROM auth.Users u JOIN org.Employees e ON e.EmployeeId = u.EmployeeId WHERE u.UserId = @userId
            """, new { userId });
        if (emp is null || emp.Value.PhotoPath is null) return Results.NoContent();
        await c.ExecuteAsync("UPDATE org.Employees SET PhotoPath = NULL, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @userId WHERE EmployeeId = @emp",
            new { userId, emp = emp.Value.EmployeeId });
        await Audit.WriteAsync(c, "USER", userId, "PROFILE_PHOTO_REMOVED", "Employee", emp.Value.EmployeeId.ToString(), "Profile picture removed", ClientInfo.From(ctx).Ip);
        DeleteOld(options.Value, emp.Value.PhotoPath);
        await TellEveryoneAsync(c, push, emp.Value.PublicId, emp.Value.EmpId, null);
        return Results.NoContent();
    }

    /// <summary>JPG, PNG or WEBP by content (not by the name the browser sent); null for anything else.</summary>
    internal static string? Sniff(byte[] b)
    {
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "jpg";
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A) return "png";
        if (b.Length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null;
    }

    static string Version(string key) => Path.GetFileNameWithoutExtension(key)[..12];

    static string? FullPath(ChatOptions o, string key)
    {
        if (!KeyRe().IsMatch(key)) return null;
        var root = o.ResolvedStorageRoot();
        var full = Path.GetFullPath(Path.Combine(root, key.Replace('/', Path.DirectorySeparatorChar)));
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    static void DeleteOld(ChatOptions o, string? oldKey)
    {
        if (oldKey is null || FullPath(o, oldKey) is not { } p) return;
        try { File.Delete(p); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    static async Task TellEveryoneAsync(System.Data.IDbConnection c, ChatPush push, Guid id, Guid emp, string? v)
    {
        var everyone = await c.QueryAsync<long>("SELECT UserId FROM auth.Users WHERE IsActive = 1");
        await push.ToUsersAsync(everyone, "photo.changed", new { id, emp, v });
    }

    static IResult Invalid(string message) => Problems.Create(400, "VALIDATION", message, new Dictionary<string, object?> { ["errors"] = new { file = new[] { message } } });
}
