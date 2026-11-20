using System.Data;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;
using static OneInsure.Connect.Api.Chat.ChatEndpoints;

namespace OneInsure.Connect.Api.Chat;

/// <summary>
/// Chat attachments. Nothing the browser says is trusted: the extension must be on the allowed list (chat.MST_ChatFileType), the
/// content must match it (file signature; Office files must be real Office packages without macros), the size is limited, and
/// the file is stored under a random name without extension outside the website. It can be downloaded only after Windows
/// Defender has checked it, only by members of the conversation, always through this API (attachment download; inline only for
/// images and PDF). Physical paths never leave the server.
/// </summary>
public static class ChatFileEndpoints
{
    const long Mb = 1024 * 1024;
    public const int GroupImageMaxMb = 5;

    public static void Map(RouteGroupBuilder g)
    {
        // Body limit: the largest allowed file plus room for the multipart envelope; each type's own limit is checked after.
        g.MapPost("/conversations/{id:guid}/files", Upload).RequireRateLimiting(UploadRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute(101 * Mb), new RequestFormLimitsAttribute { MultipartBodyLengthLimit = 101 * Mb });
        g.MapPost("/conversations/{id:guid}/image", UploadGroupImage).RequireRateLimiting(UploadRateLimit)
            .WithMetadata(new RequestSizeLimitAttribute((GroupImageMaxMb + 1) * Mb));
        g.MapDelete("/conversations/{id:guid}/image", RemoveGroupImage);
        g.MapGet("/files/{id:guid}", Download);
        g.MapGet("/file-types", FileTypes);
    }

    sealed record FileType(string Extension, string Category, string ContentType, string Signature, int MaxSizeMb, bool InlinePreview);

    static async Task<IResult> FileTypes(ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var types = await c.QueryAsync<FileType>("SELECT Extension, Category, ContentType, Signature, MaxSizeMb, InlinePreview FROM chat.MST_ChatFileType WHERE IsActive = 1 ORDER BY Category, Extension");
        return Results.Ok(types.Select(t => new { extension = t.Extension, category = t.Category, maxSizeMb = Math.Min(t.MaxSizeMb, s.Options.MaxUploadMb) }));
    }

    /// <summary>File name as shown to people: no folders, no control or reserved characters, at most 200 characters, extension kept.</summary>
    public static string SafeName(string? raw)
    {
        var name = Path.GetFileName((raw ?? "").Replace('\\', '/'));
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(name.Where(ch => !char.IsControl(ch) && !invalid.Contains(ch) && ch is not ('"' or '<' or '>' or '|' or '*' or '?' or ':')).ToArray()).Trim(' ', '.');
        if (clean.Length > 200)
        {
            var ext = Path.GetExtension(clean);
            clean = clean[..(200 - ext.Length)] + ext;
        }
        return clean.Length == 0 ? "file" : clean;
    }

    sealed record Stored(string StorageKey, string FullPath, long Size, string Sha256);

    /// <summary>Streams the upload to a new random key under the storage root (yyyy/MM/32-hex), computing SHA-256 on the way.</summary>
    static async Task<Stored> StoreAsync(IFormFile file, ChatOptions o, DateTime now, CancellationToken ct)
    {
        var root = o.ResolvedStorageRoot();
        var key = $"{now:yyyy}/{now:MM}/{Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant()}";
        var full = Resolve(root, key);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var part = full + ".part";
        using var sha = SHA256.Create();
        long size = 0;
        try
        {
            await using (var output = new FileStream(part, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            await using (var input = file.OpenReadStream())
            {
                var buffer = new byte[81920];
                int n;
                while ((n = await input.ReadAsync(buffer, ct)) > 0)
                {
                    sha.TransformBlock(buffer, 0, n, null, 0);
                    await output.WriteAsync(buffer.AsMemory(0, n), ct);
                    size += n;
                }
            }
            sha.TransformFinalBlock([], 0, 0);
            File.Move(part, full);
        }
        catch
        {
            TryDelete(part);
            throw;
        }
        return new Stored(key, full, size, Convert.ToHexString(sha.Hash!).ToLowerInvariant());
    }

    /// <summary>Storage key → full path, refusing anything that would land outside the storage root.</summary>
    public static string Resolve(string root, string key)
    {
        var full = Path.GetFullPath(Path.Combine(root, key.Replace('/', Path.DirectorySeparatorChar)));
        var rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Storage key outside the storage root.");
        return full;
    }

    static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// <summary>Deletes the stored file once no (forwarded) attachment row uses it any more.</summary>
    public static async Task DeletePhysicalIfUnusedAsync(IDbConnection c, ChatOptions o, string storageKey)
    {
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatFile WHERE StorageKey = @storageKey AND DeletedUtc IS NULL", new { storageKey }) > 0) return;
        try { TryDelete(Resolve(o.ResolvedStorageRoot(), storageKey)); } catch (InvalidOperationException) { }
    }

    static IResult Invalid(string field, string message)
    {
        var v = new Validator();
        v.Add(field, message);
        return v.Problem();
    }

    /// <summary>Common checks of an incoming file: allowed type, size, content. Returns the stored file or the problem to answer with.</summary>
    static async Task<(Stored? File, FileType? Type, string Name, IResult? Error)> ReceiveAsync(IDbConnection c, ChatServices s, ChatMe me, IFormFile? file,
        Func<FileType, bool> allowed, int maxMb, HttpContext ctx)
    {
        if (file is null || file.Length == 0) return (null, null, "", Invalid("file", "Choose a file to send."));
        var name = SafeName(file.FileName);
        var ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
        var type = ext.Length == 0 ? null : await c.QuerySingleOrDefaultAsync<FileType>(
            "SELECT Extension, Category, ContentType, Signature, MaxSizeMb, InlinePreview FROM chat.MST_ChatFileType WHERE Extension = @ext AND IsActive = 1", new { ext });
        if (type is null || !allowed(type))
            return (null, null, name, Invalid("file", $"Files of type .{(ext.Length == 0 ? "?" : ext)} cannot be shared. Allowed: images, PDF, Word, Excel, PowerPoint, text, CSV and ZIP."));
        var limitMb = Math.Min(Math.Min(type.MaxSizeMb, s.Options.MaxUploadMb), maxMb);
        if (file.Length > limitMb * Mb) return (null, type, name, Invalid("file", $"The file is larger than {limitMb} MB."));

        Stored stored;
        try { stored = await StoreAsync(file, s.Options, s.Clock.UtcNow, ctx.RequestAborted); }
        catch (IOException e) when ((e.HResult & 0xFFFF) == 225 || e.Message.Contains("virus", StringComparison.OrdinalIgnoreCase))
        {
            // Defender's real-time protection refused the write (ERROR_VIRUS_INFECTED).
            await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_FILE_BLOCKED", "ChatFile", null, "Upload blocked by the antivirus while saving", ClientInfo.From(ctx).Ip,
                newValues: new { extension = ext, size = file.Length });
            return (null, type, name, Invalid("file", "This file was blocked by the antivirus and was not shared."));
        }
        if (FileInspector.Check(stored.FullPath, type.Signature) is { } reason)
        {
            TryDelete(stored.FullPath);
            await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_FILE_REJECTED", "ChatFile", null, "Upload refused: content does not match its type", ClientInfo.From(ctx).Ip,
                newValues: new { extension = ext, size = file.Length, reason });
            return (null, type, name, Invalid("file", reason));
        }
        return (stored, type, name, null);
    }

    const string InsertFileSql = """
        INSERT chat.TRN_ChatFile (ConversationId, MessageId, UploadedByUserId, OriginalName, Extension, ContentType, SizeBytes, Sha256, StorageKey)
        OUTPUT inserted.FileId
        VALUES (@cid, @messageId, @me, @name, @ext, @contentType, @size, @sha, @key)
        """;

    static async Task<IResult> Upload(Guid id, HttpRequest req, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!req.HasFormContentType) return Invalid("file", "Choose a file to send.");
        var form = await req.ReadFormAsync(ctx.RequestAborted);
        var caption = ChatAccess.CleanText(form["body"].ToString(), true);
        if (caption?.Length > BodyMax) return Invalid("body", $"The caption can be at most {BodyMax} characters.");
        Guid? clientId = Guid.TryParse(form["clientMessageId"].ToString(), out var cg) ? cg : null;
        Guid? replyTo = Guid.TryParse(form["replyToId"].ToString(), out var rg) ? rg : null;
        if (clientId is { } dupId && await c.QuerySingleOrDefaultAsync<long?>(
                "SELECT MessageId FROM chat.TRN_ChatMessage WHERE SenderUserId = @me AND ClientMessageId = @dupId", new { me = me.UserId, dupId }) is { } dup)
            return Results.Ok(await LoadMessageAsync(c, dup));

        var (stored, type, name, problem) = await ReceiveAsync(c, s, me, form.Files.GetFile("file"), _ => true, s.Options.MaxUploadMb, ctx);
        if (problem is not null) return problem;
        var used = false;
        var result = await InsertMessageAsync(c, s, me, m, "FILE", caption, clientId, replyTo, false, async (tx, messageId) =>
        {
            await c.ExecuteAsync(InsertFileSql, new
            {
                cid = m.ConversationId, messageId, me = me.UserId, name, ext = type!.Extension, contentType = type.ContentType,
                size = stored!.Size, sha = stored.Sha256, key = stored.StorageKey,
            }, tx);
            used = true;
        });
        if (!used) TryDelete(stored!.FullPath);
        if (result.Error is not null) return result.Error;
        s.ScanSignal.Kick();
        return Results.Ok(result.Message);
    }

    static async Task<IResult> UploadGroupImage(Guid id, HttpRequest req, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!m.IsGroup || !m.IsAdmin) return Problems.Create(403, "FORBIDDEN", "Only group admins can change the group picture.");
        if (!req.HasFormContentType) return Invalid("file", "Choose a picture.");
        var form = await req.ReadFormAsync(ctx.RequestAborted);
        var (stored, type, name, problem) = await ReceiveAsync(c, s, me, form.Files.GetFile("file"), t => t.Category == "IMAGE", GroupImageMaxMb, ctx);
        if (problem is not null) return problem;
        string? oldKey;
        using (var tx = c.BeginTransaction())
        {
            var fileId = await c.QuerySingleAsync<long>(InsertFileSql, new
            {
                cid = m.ConversationId, messageId = (long?)null, me = me.UserId, name, ext = type!.Extension, contentType = type.ContentType,
                size = stored!.Size, sha = stored.Sha256, key = stored.StorageKey,
            }, tx);
            oldKey = await ReplaceImageAsync(c, tx, m.ConversationId, fileId);
            await SystemMessageAsync(c, tx, m.ConversationId, $"{me.Name} changed the group picture");
            await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_GROUP_UPDATED", "ChatConversation", id.ToString(), "Group picture changed", ClientInfo.From(ctx).Ip, tx);
            tx.Commit();
        await PushLastSystemMessageAsync(c, s, m.ConversationId);
        }
        if (oldKey is not null) await DeletePhysicalIfUnusedAsync(c, s.Options, oldKey);
        s.ScanSignal.Kick();
        await PushMembersConversationAsync(c, s, m.ConversationId);
        return Results.NoContent();
    }

    static async Task<IResult> RemoveGroupImage(Guid id, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        if (await ChatAccess.MemberAsync(c, id, me.UserId) is not { } m) return ChatAccess.NotFound();
        if (!m.IsGroup || !m.IsAdmin) return Problems.Create(403, "FORBIDDEN", "Only group admins can change the group picture.");
        string? oldKey;
        using (var tx = c.BeginTransaction())
        {
            oldKey = await ReplaceImageAsync(c, tx, m.ConversationId, null);
            if (oldKey is not null) await SystemMessageAsync(c, tx, m.ConversationId, $"{me.Name} removed the group picture");
            tx.Commit();
        await PushLastSystemMessageAsync(c, s, m.ConversationId);
        }
        if (oldKey is not null) await DeletePhysicalIfUnusedAsync(c, s.Options, oldKey);
        await PushMembersConversationAsync(c, s, m.ConversationId);
        return Results.NoContent();
    }

    /// <summary>Points the group at a new picture (or none) and retires the old one; returns the old storage key.</summary>
    static async Task<string?> ReplaceImageAsync(IDbConnection c, IDbTransaction tx, long conversationId, long? fileId)
    {
        var old = await c.QuerySingleOrDefaultAsync<(long FileId, string StorageKey)?>("""
            SELECT f.FileId, f.StorageKey FROM chat.TRN_ChatConversation cv JOIN chat.TRN_ChatFile f ON f.FileId = cv.ImageFileId WHERE cv.ConversationId = @conversationId
            """, new { conversationId }, tx);
        await c.ExecuteAsync("UPDATE chat.TRN_ChatConversation SET ImageFileId = @fileId, ModifiedUtc = SYSUTCDATETIME() WHERE ConversationId = @conversationId",
            new { fileId, conversationId }, tx);
        if (old is null) return null;
        await c.ExecuteAsync("UPDATE chat.TRN_ChatFile SET DeletedUtc = SYSUTCDATETIME() WHERE FileId = @id", new { id = old.Value.FileId }, tx);
        return old.Value.StorageKey;
    }

    internal static async Task PushMembersConversationAsync(IDbConnection c, ChatServices s, long conversationId)
    {
        // Each member sees the conversation from their own side; the website reloads it on this signal.
        await s.Push.ToUsersAsync(await ChatAccess.MemberUserIdsAsync(c, conversationId), "conversation.changed",
            new { id = await c.ExecuteScalarAsync<Guid>("SELECT PublicId FROM chat.TRN_ChatConversation WHERE ConversationId = @conversationId", new { conversationId }) });
    }

    sealed record FileAccessRow(long FileId, string OriginalName, string Extension, string ContentType, long SizeBytes, string StorageKey, string ScanStatus, bool InlinePreview);

    /// <summary>
    /// Download for members only (the same "not found" for everyone else). ?inline=1 shows images and PDF in the browser; everything
    /// else is always an attachment. Files not yet checked by the antivirus, or blocked by it, are not served.
    /// </summary>
    static async Task<IResult> Download(Guid id, string? inline, ChatServices s, HttpContext ctx)
    {
        using var c = await s.Db.OpenAsync();
        var (me, error) = await ChatAccess.MeAsync(c, ctx, s.Cache);
        if (me is null) return error!;
        var f = await c.QuerySingleOrDefaultAsync<FileAccessRow>("""
            SELECT f.FileId, f.OriginalName, f.Extension, f.ContentType, f.SizeBytes, f.StorageKey, f.ScanStatus, ISNULL(t.InlinePreview, 0) AS InlinePreview
            FROM chat.TRN_ChatFile f
            JOIN chat.TRN_ChatConversation cv ON cv.ConversationId = f.ConversationId AND cv.IsActive = 1
            JOIN chat.TRN_ChatConversationParticipant p ON p.ConversationId = f.ConversationId AND p.UserId = @me AND p.LeftUtc IS NULL
            LEFT JOIN chat.TRN_ChatMessage m ON m.MessageId = f.MessageId
            LEFT JOIN chat.MST_ChatFileType t ON t.Extension = f.Extension
            WHERE f.PublicId = @id AND f.DeletedUtc IS NULL
              AND ((f.MessageId IS NULL AND cv.ImageFileId = f.FileId) OR (m.DeletedUtc IS NULL AND m.MessageId > p.VisibleFromMessageId))
            """, new { id, me = me.UserId });
        if (f is null) return Db_.NotFound("File");
        if (f.ScanStatus == "PENDING") return Problems.Create(409, "CONFLICT", "The file is still being checked by the antivirus. Try again in a moment.");
        if (f.ScanStatus != "CLEAN") return Problems.Create(403, "FORBIDDEN", "This file was blocked by the antivirus.");
        string path;
        try { path = Resolve(s.Options.ResolvedStorageRoot(), f.StorageKey); }
        catch (InvalidOperationException) { return Db_.NotFound("File"); }
        if (!File.Exists(path)) return Db_.NotFound("File");

        var showInline = inline is "1" or "true" && f.InlinePreview;
        var headers = ctx.Response.Headers;
        if (showInline)
        {
            headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(f.OriginalName)}";
            headers.CacheControl = "private, max-age=3600";
            // Pictures and PDFs only; a PDF opens in the browser's own viewer (no script of ours runs in it).
            headers.ContentSecurityPolicy = f.Extension == "pdf" ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; frame-ancestors 'none'";
            return Results.File(path, f.ContentType, enableRangeProcessing: true);
        }
        await Audit.WriteAsync(c, "USER", me.UserId, "CHAT_FILE_DOWNLOADED", "ChatFile", id.ToString(), "Chat attachment downloaded", ClientInfo.From(ctx).Ip,
            newValues: new { extension = f.Extension, size = f.SizeBytes });
        return Results.File(path, "application/octet-stream", f.OriginalName, enableRangeProcessing: true);
    }
}

/// <summary>Checks that a stored file really is what its extension says. Returns null when it is, or the reason shown to the person.</summary>
public static class FileInspector
{
    public static string? Check(string path, string signature)
    {
        try
        {
            using var fs = File.OpenRead(path);
            var head = new byte[1024];
            var n = fs.Read(head, 0, head.Length);
            bool Starts(params byte[] sig) => n >= sig.Length && head.AsSpan(0, sig.Length).SequenceEqual(sig);
            const string mismatch = "The file's content does not match its type, so it was not shared.";
            switch (signature)
            {
                case "PNG": return Starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) ? null : mismatch;
                case "JPEG": return Starts(0xFF, 0xD8, 0xFF) ? null : mismatch;
                case "GIF": return Starts("GIF87a"u8.ToArray()) || Starts("GIF89a"u8.ToArray()) ? null : mismatch;
                case "WEBP": return Starts("RIFF"u8.ToArray()) && n >= 12 && head.AsSpan(8, 4).SequenceEqual("WEBP"u8) ? null : mismatch;
                case "PDF": return head.AsSpan(0, n).IndexOf("%PDF-"u8) >= 0 ? null : mismatch;
                case "OLE": return Starts(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1) ? null : mismatch;
                case "TEXT":
                {
                    fs.Position = 0;
                    var buf = new byte[65536];
                    var m = fs.Read(buf, 0, buf.Length);
                    if (buf.AsSpan(0, m).IndexOf((byte)0) >= 0) return mismatch;
                    if (m >= 2 && buf[0] == (byte)'M' && buf[1] == (byte)'Z') return mismatch;
                    return null;
                }
                case "ZIP":
                case "OOXML":
                {
                    if (!(Starts(0x50, 0x4B, 0x03, 0x04) || Starts(0x50, 0x4B, 0x05, 0x06))) return mismatch;
                    fs.Position = 0;
                    using var zip = new ZipArchive(fs, ZipArchiveMode.Read, leaveOpen: true);
                    var names = zip.Entries.Select(e => e.FullName).ToList();
                    if (signature == "ZIP") return null;
                    if (!names.Any(x => x.Equals("[Content_Types].xml", StringComparison.OrdinalIgnoreCase))) return mismatch;
                    if (names.Any(x => x.EndsWith("vbaProject.bin", StringComparison.OrdinalIgnoreCase) || x.EndsWith(".bin", StringComparison.OrdinalIgnoreCase) && x.Contains("activeX", StringComparison.OrdinalIgnoreCase)))
                        return "Office files with macros cannot be shared. Save it without macros (.docx, .xlsx, .pptx) and try again.";
                    var ct = zip.GetEntry("[Content_Types].xml") ?? zip.Entries.First(e => e.FullName.Equals("[Content_Types].xml", StringComparison.OrdinalIgnoreCase));
                    using var r = new StreamReader(ct.Open(), Encoding.UTF8);
                    var types = r.ReadToEnd();
                    return types.Contains("macroEnabled", StringComparison.OrdinalIgnoreCase)
                        ? "Office files with macros cannot be shared. Save it without macros (.docx, .xlsx, .pptx) and try again."
                        : null;
                }
                default: return mismatch;
            }
        }
        catch (InvalidDataException) { return "The file is damaged or not a valid archive, so it was not shared."; }
        catch (IOException) { return "This file was blocked by the antivirus and was not shared."; }
    }
}

/// <summary>Wakes the scan worker as soon as a file arrives (it also polls every few seconds).</summary>
public sealed class ChatFileScanSignal
{
    readonly SemaphoreSlim signal = new(0, 1);
    public void Kick() { try { if (signal.CurrentCount == 0) signal.Release(); } catch (SemaphoreFullException) { } }
    public Task<bool> WaitAsync(TimeSpan timeout, CancellationToken ct) => signal.WaitAsync(timeout, ct);
}

/// <summary>
/// Checks every new attachment with Windows Defender (MpCmdRun -Scan -ScanType 3 -File, already on this server; free). Clean →
/// downloadable; threat → the file is deleted, the attachment shows as blocked and the event is audited. Members' open chats are
/// updated live. Also applies the optional retention period (Chat:FileRetentionDays, decision D9).
/// </summary>
public sealed class ChatFileScanWorker(Db db, IOptions<ChatOptions> options, ChatFileScanSignal signal, ChatPush push, ILogger<ChatFileScanWorker> log) : BackgroundService
{
    DateTime lastRetention = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogWarning(e, "Chat file scan pass failed"); }
            try { await signal.WaitAsync(TimeSpan.FromSeconds(Math.Max(1, options.Value.ScanPollSeconds)), stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    sealed record PendingRow(string StorageKey, int Attempts);

    public async Task RunOnceAsync(CancellationToken ct = default)
    {
        var o = options.Value;
        using var c = await db.OpenAsync(ct);
        var pending = (await c.QueryAsync<PendingRow>("""
            SELECT TOP (10) StorageKey, MAX(ScanAttempts) AS Attempts FROM chat.TRN_ChatFile WHERE ScanStatus = 'PENDING' AND DeletedUtc IS NULL
            GROUP BY StorageKey ORDER BY MIN(FileId)
            """)).ToList();
        foreach (var p in pending)
        {
            ct.ThrowIfCancellationRequested();
            var (status, detail) = await ScanAsync(o, p, ct);
            if (status is null)
            {
                await c.ExecuteAsync("UPDATE chat.TRN_ChatFile SET ScanAttempts = ScanAttempts + 1, ScanDetail = @detail WHERE StorageKey = @key AND ScanStatus = 'PENDING'",
                    new { key = p.StorageKey, detail });
                continue;
            }
            var rows = (await c.QueryAsync<(Guid Id, long? MessageId, long ConversationId)>("""
                UPDATE chat.TRN_ChatFile SET ScanStatus = @status, ScannedUtc = SYSUTCDATETIME(), ScanDetail = @detail, ScanAttempts = ScanAttempts + 1
                OUTPUT inserted.PublicId AS Id, inserted.MessageId, inserted.ConversationId
                WHERE StorageKey = @key AND ScanStatus = 'PENDING'
                """, new { status, detail, key = p.StorageKey })).ToList();
            if (status == "BLOCKED")
            {
                try { File.Delete(ChatFileEndpoints.Resolve(o.ResolvedStorageRoot(), p.StorageKey)); } catch (Exception) { /* already removed by the antivirus */ }
                foreach (var r in rows)
                    await Audit.WriteAsync(c, "SYSTEM", null, "CHAT_FILE_BLOCKED", "ChatFile", r.Id.ToString(), "Attachment blocked by the antivirus", null, newValues: new { detail });
            }
            await PushRowsAsync(c, rows);
        }
        await RetentionAsync(c, o, ct);
    }

    async Task PushRowsAsync(IDbConnection c, IEnumerable<(Guid Id, long? MessageId, long ConversationId)> rows)
    {
        foreach (var r in rows)
        {
            var members = await ChatAccess.MemberUserIdsAsync(c, r.ConversationId);
            if (r.MessageId is { } mid) await push.ToUsersAsync(members, "message.updated", await LoadMessageAsync(c, mid));
            else await push.ToUsersAsync(members, "conversation.changed",
                new { id = await c.ExecuteScalarAsync<Guid>("SELECT PublicId FROM chat.TRN_ChatConversation WHERE ConversationId = @id", new { id = r.ConversationId }) });
        }
    }

    /// <summary>(status, detail): CLEAN, BLOCKED or ERROR; null status = try again on the next pass.</summary>
    async Task<(string? Status, string Detail)> ScanAsync(ChatOptions o, PendingRow p, CancellationToken ct)
    {
        string path;
        try { path = ChatFileEndpoints.Resolve(o.ResolvedStorageRoot(), p.StorageKey); }
        catch (InvalidOperationException) { return ("ERROR", "Invalid storage key"); }
        if (!File.Exists(path)) return ("BLOCKED", "Removed by the antivirus");
        if (!o.ScanEnabled) return ("CLEAN", "Not scanned (scanning switched off)");
        if (!File.Exists(o.DefenderPath)) return p.Attempts >= 2 ? ("ERROR", "Antivirus not available") : (null, "Antivirus not available");
        try
        {
            using var proc = new Process
            {
                StartInfo = new ProcessStartInfo(o.DefenderPath)
                {
                    ArgumentList = { "-Scan", "-ScanType", "3", "-File", path, "-DisableRemediation" },
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                },
            };
            proc.Start();
            var output = proc.StandardOutput.ReadToEndAsync(ct);
            _ = proc.StandardError.ReadToEndAsync(ct);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Max(10, o.ScanTimeoutSeconds)));
            try { await proc.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                try { proc.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                return p.Attempts >= 2 ? ("ERROR", "Antivirus check timed out") : (null, "Antivirus check timed out");
            }
            var text = await output;
            if (!File.Exists(path)) return ("BLOCKED", "Removed by the antivirus");
            return proc.ExitCode switch
            {
                0 => ("CLEAN", "Windows Defender: no threats"),
                2 => ("BLOCKED", Trim("Windows Defender: " + LastLine(text))),
                _ => p.Attempts >= 2 ? ("ERROR", Trim($"Antivirus exit code {proc.ExitCode}")) : (null, Trim($"Antivirus exit code {proc.ExitCode}")),
            };
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            log.LogWarning(e, "Running the antivirus failed");
            return p.Attempts >= 2 ? ("ERROR", "Antivirus could not be run") : (null, "Antivirus could not be run");
        }
    }

    static string LastLine(string s) => s.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? "threat found";
    static string Trim(string s) => s.Length > 200 ? s[..200] : s;

    async Task RetentionAsync(IDbConnection c, ChatOptions o, CancellationToken ct)
    {
        if (o.FileRetentionDays <= 0 || DateTime.UtcNow - lastRetention < TimeSpan.FromHours(1)) return;
        lastRetention = DateTime.UtcNow;
        var expired = (await c.QueryAsync<(Guid Id, long? MessageId, long ConversationId, string StorageKey)>("""
            UPDATE TOP (500) chat.TRN_ChatFile SET DeletedUtc = SYSUTCDATETIME()
            OUTPUT inserted.PublicId AS Id, inserted.MessageId, inserted.ConversationId, inserted.StorageKey
            WHERE DeletedUtc IS NULL AND MessageId IS NOT NULL AND CreatedUtc < DATEADD(DAY, -@days, SYSUTCDATETIME())
            """, new { days = o.FileRetentionDays })).ToList();
        if (expired.Count == 0) return;
        foreach (var key in expired.Select(x => x.StorageKey).Distinct()) await ChatFileEndpoints.DeletePhysicalIfUnusedAsync(c, o, key);
        await Audit.WriteAsync(c, "SYSTEM", null, "CHAT_FILES_RETENTION", "ChatFile", null, $"{expired.Count} attachment(s) removed by the retention period ({o.FileRetentionDays} days)", null);
        await PushRowsAsync(c, expired.Select(x => (x.Id, x.MessageId, x.ConversationId)));
    }
}
