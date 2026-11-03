using System.Data;
using System.Globalization;
using System.Text.Json;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Recording library: /api/v1/recordings (list, by-employee summary, detail, access history, play/download links, media, legal hold,
/// retry, retention review and deletion approvals) and /api/v1/meetings/{id}/recordings. Visibility rules: <see cref="RecordingAccess"/>.
/// Every detail view, playback link, download link and refusal is written to rec.RecordingAccessLog (append-only).
/// </summary>
public static class RecordingLibraryEndpoints
{
    public sealed record LegalHoldInput(bool Hold, string? Reason);
    public sealed record DecisionInput(string? Note);

    public static RouteGroupBuilder MapRecordingLibraryEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/recordings").RequireSession();
        g.MapGet("", List);
        g.MapGet("/by-employee", ByEmployee);
        g.MapGet("/retention", Retention);
        g.MapPost("/deletions/{deletionId:guid}/approve", (Guid deletionId, DecisionInput? input, Db db, RecordingPaths paths, HttpContext ctx, CancellationToken ct) =>
            Decide(deletionId, true, input?.Note, db, paths, ctx, ct));
        g.MapPost("/deletions/{deletionId:guid}/reject", (Guid deletionId, DecisionInput? input, Db db, RecordingPaths paths, HttpContext ctx, CancellationToken ct) =>
            Decide(deletionId, false, input?.Note, db, paths, ctx, ct));
        g.MapGet("/media/{token}", Media);
        g.MapGet("/{id:guid}", Detail);
        g.MapGet("/{id:guid}/access-log", AccessLog);
        g.MapPost("/{id:guid}/play", (Guid id, Db db, RecordingMediaTokens tokens, IClock clock, HttpContext ctx, CancellationToken ct) => Link(id, "PLAY", db, tokens, clock, ctx, ct));
        g.MapPost("/{id:guid}/download", (Guid id, Db db, RecordingMediaTokens tokens, IClock clock, HttpContext ctx, CancellationToken ct) => Link(id, "DOWNLOAD", db, tokens, clock, ctx, ct));
        g.MapPut("/{id:guid}/legal-hold", LegalHold).RequirePermission("recordings.legalhold");
        g.MapPost("/{id:guid}/retry", Retry).RequirePermission("admin.ops");
        api.MapGet("/meetings/{id:guid}/recordings", ForMeeting).RequireAnyPermission("meetings.view.own", "meetings.view.all");
        return api;
    }

    internal sealed class Row : IAccessFlags
    {
        public long RecordingId { get; set; }
        public Guid Id { get; set; }
        public string Status { get; set; } = "";
        public DateTime CreatedUtc { get; set; }
        public DateTime? StartedUtc { get; set; }
        public DateTime? EndedUtc { get; set; }
        public int? DurationSeconds { get; set; }
        public long? FileSizeBytes { get; set; }
        public bool LegalHold { get; set; }
        public DateTime? RetainUntilUtc { get; set; }
        public string StorageTier { get; set; } = "PRIMARY";
        public string? StorageKey { get; set; }
        public string? ArchiveRoot { get; set; }
        public Guid MeetingId { get; set; }
        public string MeetingTitle { get; set; } = "";
        public string MeetingCode { get; set; } = "";
        public string Category { get; set; } = "";
        public Guid OwnerId { get; set; }
        public string OwnerName { get; set; } = "";
        public string? OwnerCode { get; set; }
        public string? Department { get; set; }
        public string? CustomerName { get; set; }
        public string? CustomerRef { get; set; }
        public string? PolicyCode { get; set; }
        public string? PolicyTitle { get; set; }
        public bool LegalHoldEnabled { get; set; }
        public int SignedUrlTtlSeconds { get; set; }
        public bool IsOwner { get; set; }
        public bool PlaybackRole { get; set; }
        public bool DownloadRole { get; set; }
        public bool LeadsOwner { get; set; }
        public bool HeadsOwnerDepartment { get; set; }
        public bool OwnerCanPlay { get; set; }
        public bool OwnerCanDownload { get; set; }
        public bool TeamLeaderCanPlay { get; set; }
        public bool DepartmentHeadCanPlay { get; set; }
    }

    const string From = """
        FROM rec.MeetingRecordings r
        JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId
        JOIN org.Employees o ON o.EmployeeId = r.OwnerEmployeeId
        LEFT JOIN org.Departments d ON d.DepartmentId = o.DepartmentId
        LEFT JOIN crm.Customers cu ON cu.CustomerId = r.CustomerId
        LEFT JOIN rec.RecordingPolicies p ON p.PolicyCode = r.PolicyCode
        """;

    const string Select = $"""
        SELECT r.RecordingId, r.PublicId AS Id, r.[Status], r.CreatedUtc, r.StartedUtc, r.EndedUtc, r.DurationSeconds, r.FileSizeBytes, r.LegalHold, r.RetainUntilUtc,
               r.StorageTier, r.StorageKey, r.ArchiveRoot, m.PublicId AS MeetingId, m.Title AS MeetingTitle, m.MeetingCode, m.Category,
               o.PublicId AS OwnerId, o.DisplayName AS OwnerName, o.EmployeeCode AS OwnerCode, d.Name AS Department, cu.FullName AS CustomerName, cu.CustomerRef,
               r.PolicyCode, p.Title AS PolicyTitle, ISNULL(p.LegalHoldEnabled, 0) AS LegalHoldEnabled, ISNULL(p.SignedUrlTtlSeconds, 300) AS SignedUrlTtlSeconds,
               {RecordingAccess.FlagsSql}
        """;

    static object Item(Row r, Access a) => new
    {
        id = r.Id, status = r.Status, createdUtc = r.CreatedUtc, startedUtc = r.StartedUtc, endedUtc = r.EndedUtc, durationSeconds = r.DurationSeconds,
        fileSizeBytes = r.FileSizeBytes, legalHold = r.LegalHold, retainUntilUtc = r.RetainUntilUtc, storageTier = r.StorageTier,
        meeting = new { id = r.MeetingId, title = r.MeetingTitle, meetingCode = r.MeetingCode, category = r.Category, categoryGroup = MeetingEndpoints.CategoryGroup(r.Category) },
        owner = new { id = r.OwnerId, name = r.OwnerName, employeeCode = r.OwnerCode, department = r.Department },
        customer = r.CustomerName is null ? null : new { name = r.CustomerName, reference = r.CustomerRef },
        policy = r.PolicyCode is null ? null : new { code = r.PolicyCode, title = r.PolicyTitle },
        canPlay = a.CanPlay && r.Status == "COMPLETED", canDownload = a.CanDownload && r.Status == "COMPLETED", access = a.Via,
    };

    sealed record Filters(string Where, DynamicParameters Args);

    static Filters BuildFilters(Viewer v, HttpRequest q)
    {
        var args = new DynamicParameters(v.Sql);
        var where = new List<string> { RecordingAccess.VisibleSql };
        string? S(string k) => q.Query[k].ToString() is { Length: > 0 } s ? s.Trim() : null;
        if (S("from") is { } f && DateTime.TryParse(f, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var from))
        { where.Add("COALESCE(r.StartedUtc, r.CreatedUtc) >= @from"); args.Add("from", from); }
        if (S("to") is { } t && DateTime.TryParse(t, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var to))
        { where.Add("COALESCE(r.StartedUtc, r.CreatedUtc) < @to"); args.Add("to", to); }
        if (Guid.TryParse(S("employee"), out var emp)) { where.Add("o.PublicId = @employee"); args.Add("employee", emp); }
        if (S("department") is { Length: <= 30 } dept) { where.Add("d.Code = @department"); args.Add("department", dept); }
        if (S("category") is { } cat)
        {
            // A database category (e.g. TEAM) or a dashboard group (CUSTOMER, INTERNAL, TRAINING, REVIEW, MANAGEMENT).
            var x = cat.ToUpperInvariant();
            var cats = MeetingEndpoints.Categories.Contains(x) ? [x] : MeetingEndpoints.Categories.Where(c => MeetingEndpoints.CategoryGroup(c) == x).ToArray();
            where.Add("m.Category IN @cats");
            args.Add("cats", cats.Length == 0 ? ["-"] : cats);
        }
        if (S("status") is { } st) { where.Add("r.[Status] = @status"); args.Add("status", st.ToUpperInvariant()); }
        else where.Add("r.[Status] <> 'PURGED'");
        if (S("customerRef") is { Length: <= 100 } cref)
        { where.Add("(cu.CustomerRef LIKE @cref OR cu.ReferenceNumber LIKE @cref OR cu.PolicyNumber LIKE @cref OR m.PolicyNumber LIKE @cref OR cu.FullName LIKE @cref)"); args.Add("cref", $"%{Like(cref)}%"); }
        if (Guid.TryParse(S("meeting"), out var mid)) { where.Add("m.PublicId = @meeting"); args.Add("meeting", mid); }
        if (S("search") is { Length: <= 100 } search)
        { where.Add("(m.Title LIKE @search OR m.MeetingCode LIKE @search OR o.DisplayName LIKE @search OR o.EmployeeCode LIKE @search)"); args.Add("search", $"%{Like(search)}%"); }
        if (S("legalHold") == "true") where.Add("r.LegalHold = 1");
        return new Filters(string.Join(" AND ", where), args);
    }

    static string Like(string s) => s.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]");

    static async Task<IResult> List(Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var v = await Viewer.LoadAsync(c, ctx.User);
        var f = BuildFilters(v, ctx.Request);
        var page = int.TryParse(ctx.Request.Query["page"], out var pg) && pg > 0 ? pg : 1;
        var size = int.TryParse(ctx.Request.Query["pageSize"], out var ps) ? Math.Clamp(ps, 1, 100) : 25;
        f.Args.Add("skip", (page - 1) * size);
        f.Args.Add("take", size);
        using var multi = await c.QueryMultipleAsync($"""
            {Select} {From} WHERE {f.Where}
            ORDER BY COALESCE(r.StartedUtc, r.CreatedUtc) DESC, r.RecordingId DESC OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
            SELECT COUNT(*) {From} WHERE {f.Where};
            """, f.Args);
        var rows = (await multi.ReadAsync<Row>()).ToList();
        var total = await multi.ReadSingleAsync<int>();
        return Results.Ok(new Page<object>(rows.Select(r => Item(r, RecordingAccess.Decide(v, r))).ToList(), total, page, size));
    }

    static async Task<IResult> ByEmployee(Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var v = await Viewer.LoadAsync(c, ctx.User);
        var f = BuildFilters(v, ctx.Request);
        var rows = await c.QueryAsync<(Guid Id, string Name, string? Code, string? Department, int Recordings, int Completed, int Failed, long Seconds, long Bytes, DateTime? LastUtc)>($"""
            SELECT TOP (200) o.PublicId, o.DisplayName, o.EmployeeCode, d.Name, COUNT(*), SUM(CASE WHEN r.[Status] = 'COMPLETED' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN r.[Status] = 'FAILED' THEN 1 ELSE 0 END), ISNULL(SUM(CAST(r.DurationSeconds AS BIGINT)), 0), ISNULL(SUM(r.FileSizeBytes), 0),
                   MAX(COALESCE(r.StartedUtc, r.CreatedUtc))
            {From} WHERE {f.Where}
            GROUP BY o.PublicId, o.DisplayName, o.EmployeeCode, d.Name
            ORDER BY MAX(COALESCE(r.StartedUtc, r.CreatedUtc)) DESC
            """, f.Args);
        return Results.Ok(rows.Select(r => new
        {
            employee = new { id = r.Id, name = r.Name, employeeCode = r.Code, department = r.Department },
            recordings = r.Recordings, completed = r.Completed, failed = r.Failed, totalSeconds = r.Seconds, totalBytes = r.Bytes, lastUtc = r.LastUtc,
        }));
    }

    static async Task<IResult> ForMeeting(Guid id, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var exists = await c.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM mtg.Meetings m WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}", new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (exists == 0) return Db_.NotFound("Meeting");
        var v = await Viewer.LoadAsync(c, ctx.User);
        var args = new DynamicParameters(v.Sql);
        args.Add("id", id);
        var rows = await c.QueryAsync<Row>($"{Select} {From} WHERE m.PublicId = @id AND r.[Status] <> 'PURGED' AND {RecordingAccess.VisibleSql} ORDER BY r.RecordingId DESC", args);
        var hidden = await c.ExecuteScalarAsync<int>($"SELECT COUNT(*) {From} WHERE m.PublicId = @id AND r.[Status] <> 'PURGED' AND NOT {RecordingAccess.VisibleSql}", args);
        return Results.Ok(new { items = rows.Select(r => Item(r, RecordingAccess.Decide(v, r))), hiddenCount = hidden });
    }

    /// <summary>The recording if the viewer may see it; otherwise null (after logging DENIED when it exists).</summary>
    static async Task<(Row? Row, Access? Access, Viewer V)> FindAsync(IDbConnection c, Guid id, HttpContext ctx)
    {
        var v = await Viewer.LoadAsync(c, ctx.User);
        var args = new DynamicParameters(v.Sql);
        args.Add("id", id);
        var row = await c.QuerySingleOrDefaultAsync<Row>($"{Select} {From} WHERE r.PublicId = @id", args);
        if (row is null) return (null, null, v);
        var a = RecordingAccess.Decide(v, row);
        if (!a.Visible)
        {
            await RecordingAccess.LogAsync(c, row.RecordingId, v.UserId, "DENIED", ctx);
            return (null, null, v);
        }
        return (row, a, v);
    }

    static IResult NotFound() => Db_.NotFound("Recording");

    static bool CanSeeHistory(Viewer v, Access a) => v.AuditView || v.ViewAll || v.LegalHold || a.Via is "policy:playback-role";

    static async Task<IResult> Detail(Guid id, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var (row, access, v) = await FindAsync(c, id, ctx);
        if (row is null) return NotFound();
        await RecordingAccess.LogAsync(c, row.RecordingId, v.UserId, "VIEW_DETAILS", ctx);
        var x = await c.QuerySingleAsync<(byte[]? Sha256, string? VerificationDetails, string? Container, string? VideoCodec, string? AudioCodec, int? Width, int? Height,
            DateTime? VerifiedUtc, string? FailureReason, string? StopReason, string? PolicyVersion, string? PolicySnapshotJson, DateTime? ArchivedUtc, DateTime? RetentionReviewUtc,
            DateTime? PurgedUtc, string? StartedBy)>("""
            SELECT r.Sha256, r.VerificationDetails, r.Container, r.VideoCodec, r.AudioCodec, r.Width, r.Height, r.VerifiedUtc, r.FailureReason, r.StopReason, r.PolicyVersion,
                   r.PolicySnapshotJson, r.ArchivedUtc, r.RetentionReviewUtc, r.PurgedUtc, COALESCE(se.DisplayName, su.Email) AS StartedBy
            FROM rec.MeetingRecordings r LEFT JOIN auth.Users su ON su.UserId = r.StartedByUserId LEFT JOIN org.Employees se ON se.EmployeeId = su.EmployeeId
            WHERE r.RecordingId = @id
            """, new { id = row.RecordingId });
        var consents = await c.QueryAsync<(string Name, string Type, string Decision, string NoticeVersion, DateTime DecisionUtc)>("""
            SELECT COALESCE(e.DisplayName, cu.FullName, p.GuestName), p.ParticipantType, mc.Decision, mc.NoticeVersion, mc.DecisionUtc
            FROM mtg.MeetingConsent mc JOIN mtg.MeetingParticipants p ON p.ParticipantId = mc.ParticipantId
            JOIN rec.MeetingRecordings r ON r.MeetingId = mc.MeetingId
            LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE r.RecordingId = @id ORDER BY mc.DecisionUtc, mc.ConsentId
            """, new { id = row.RecordingId });
        object? verification = null;
        if (x.VerificationDetails is { } vd)
            try { verification = JsonDocument.Parse(vd).RootElement.Clone(); } catch (JsonException) { }
        var showHistory = CanSeeHistory(v, access!);
        return Results.Ok(new
        {
            recording = Item(row, access!),
            sha256 = x.Sha256 is null ? null : Convert.ToHexStringLower(x.Sha256),
            container = x.Container, videoCodec = x.VideoCodec, audioCodec = x.AudioCodec, width = x.Width, height = x.Height, verifiedUtc = x.VerifiedUtc,
            verification, failureReason = x.FailureReason, stopReason = x.StopReason, startedBy = x.StartedBy, policyVersion = x.PolicyVersion,
            archivedUtc = x.ArchivedUtc, retentionReviewUtc = x.RetentionReviewUtc, purgedUtc = x.PurgedUtc,
            consents = consents.Select(k => new { name = k.Name, participantType = k.Type, decision = k.Decision, noticeVersion = k.NoticeVersion, decisionUtc = k.DecisionUtc }),
            canSetLegalHold = v.LegalHold && row.LegalHoldEnabled && row.Status is "COMPLETED" or "FAILED",
            canRetry = v.Ops && row.Status == "FAILED",
            canSeeAccessHistory = showHistory,
            accessHistory = showHistory ? await HistoryAsync(c, row.RecordingId) : null,
        });
    }

    static async Task<object> HistoryAsync(IDbConnection c, long recordingId) =>
        (await c.QueryAsync<(string Action, DateTime Utc, string User, string? Ip, DateTime? Expires)>("""
            SELECT TOP (200) l.[Action], l.Utc, COALESCE(e.DisplayName, u.Email), l.IpAddress, l.SignedUrlExpiresUtc
            FROM rec.RecordingAccessLog l JOIN auth.Users u ON u.UserId = l.UserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
            WHERE l.RecordingId = @recordingId ORDER BY l.Utc DESC, l.AccessId DESC
            """, new { recordingId })).Select(h => new { action = h.Action, utc = h.Utc, user = h.User, ipAddress = h.Ip, linkExpiresUtc = h.Expires }).ToList();

    static async Task<IResult> AccessLog(Guid id, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var (row, access, v) = await FindAsync(c, id, ctx);
        if (row is null) return NotFound();
        if (!CanSeeHistory(v, access!)) return Problems.Create(403, "FORBIDDEN", "Access history is visible to auditors and recording administrators.");
        return Results.Ok(await HistoryAsync(c, row.RecordingId));
    }

    /// <summary>POST /recordings/{id}/play|download → a short-lived signed URL (policy link lifetime), logged with its expiry.</summary>
    static async Task<IResult> Link(Guid id, string action, Db db, RecordingMediaTokens tokens, IClock clock, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var (row, access, v) = await FindAsync(c, id, ctx);
        if (row is null) return NotFound();
        var allowed = action == "PLAY" ? access!.CanPlay : access!.CanDownload;
        if (!allowed || row.Status != "COMPLETED")
        {
            await RecordingAccess.LogAsync(c, row.RecordingId, v.UserId, "DENIED", ctx);
            return row.Status != "COMPLETED"
                ? Db_.Conflict("This recording is not available for playback.")
                : Problems.Create(403, "FORBIDDEN", action == "PLAY" ? "The recording policy does not allow you to play this recording." : "The recording policy does not allow you to download this recording.");
        }
        var expires = clock.UtcNow.AddSeconds(Math.Clamp(row.SignedUrlTtlSeconds, 30, 3600));
        var token = tokens.Create(row.Id, v.UserId, action, expires);
        await RecordingAccess.LogAsync(c, row.RecordingId, v.UserId, action, ctx, expires);
        return Results.Ok(new { url = $"/api/v1/recordings/media/{Uri.EscapeDataString(token)}", expiresUtc = expires });
    }

    /// <summary>
    /// GET /recordings/media/{token}: streams the MP4 with HTTP range support (seeking). The token must be genuine, unexpired and issued
    /// to the signed-in user. Never a static file: the library folder is not under the web root.
    /// </summary>
    static async Task<IResult> Media(string token, Db db, RecordingMediaTokens tokens, RecordingPaths paths, HttpContext ctx, CancellationToken ct)
    {
        var p = tokens.Read(token, out var expired);
        var userId = ctx.User.UserId();
        if (p is null) return Problems.Create(403, "FORBIDDEN", "This link is not valid.");
        using var c = await db.OpenAsync(ct);
        var r = await c.QuerySingleOrDefaultAsync<(long RecordingId, string Status, string? StorageKey, string StorageTier, string? ArchiveRoot, string MeetingCode, DateTime? StartedUtc)?>("""
            SELECT r.RecordingId, r.[Status], r.StorageKey, r.StorageTier, r.ArchiveRoot, m.MeetingCode, r.StartedUtc
            FROM rec.MeetingRecordings r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId WHERE r.PublicId = @id
            """, new { id = p.R });
        if (r is null) return Problems.Create(403, "FORBIDDEN", "This link is not valid.");
        if (expired || p.U != userId)
        {
            // Range requests of one playback arrive many times: log a refusal only for the first byte range.
            if (ctx.Request.Headers.Range.Count == 0 || ctx.Request.Headers.Range.ToString().StartsWith("bytes=0-", StringComparison.Ordinal))
                await RecordingAccess.LogAsync(c, r.Value.RecordingId, userId, "DENIED", ctx);
            return Problems.Create(403, "FORBIDDEN", expired ? "This link has expired. Open the recording again." : "This link was issued to another user.");
        }
        if (r.Value.Status != "COMPLETED" || r.Value.StorageKey is null) return Problems.Create(404, "NOT_FOUND", "Recording not found.");
        var root = r.Value.StorageTier == "ARCHIVE" ? r.Value.ArchiveRoot : paths.StorageRoot;
        if (root is null) return Problems.Create(503, "SERVICE_UNAVAILABLE", "The recording storage is not configured.");
        var file = RecordingPaths.Resolve(root, r.Value.StorageKey);
        if (!File.Exists(file)) return Problems.Create(404, "NOT_FOUND", "The recording file is not available.");
        ctx.Response.Headers.CacheControl = "private, no-store";
        ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
        var name = p.A == "DOWNLOAD" ? $"recording-{r.Value.MeetingCode}-{(r.Value.StartedUtc ?? DateTime.UtcNow):yyyyMMdd-HHmm}.mp4" : null;
        return Results.File(file, "video/mp4", fileDownloadName: name, enableRangeProcessing: true);
    }

    static async Task<IResult> LegalHold(Guid id, LegalHoldInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        var reason = input.Reason?.Trim();
        if (string.IsNullOrEmpty(reason) || reason.Length > 400)
        {
            var val = new Validator();
            val.Add("reason", "Enter the reason for the change (max 400 characters).");
            return val.Problem();
        }
        using var c = await db.OpenAsync(ct);
        var (row, _, v) = await FindAsync(c, id, ctx);
        if (row is null) return NotFound();
        if (!row.LegalHoldEnabled) return Problems.Create(409, "CONFLICT", "Legal hold is switched off in this recording's policy.");
        if (row.Status is not ("COMPLETED" or "FAILED")) return Db_.Conflict("Legal hold can be set on completed or failed recordings.");
        if (row.LegalHold == input.Hold) return Results.NoContent();
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("UPDATE rec.MeetingRecordings SET LegalHold = @hold, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE RecordingId = @id",
            new { hold = input.Hold, user = v.UserId, id = row.RecordingId }, tx);
        if (input.Hold)
            await c.ExecuteAsync("""
                UPDATE rec.RecordingDeletions SET [Status] = 'CANCELLED', Notes = N'Cancelled: legal hold placed.', DecidedUtc = SYSUTCDATETIME(), DecidedByUserId = @user
                WHERE RecordingId = @id AND [Status] = 'PENDING'
                """, new { user = v.UserId, id = row.RecordingId }, tx);
        await RecordingPolicyEndpoints.AuditChangeAsync(c, tx, ctx, input.Hold ? "RECORDING_LEGAL_HOLD_PLACED" : "RECORDING_LEGAL_HOLD_RELEASED", "Recording", id.ToString(),
            (input.Hold ? "Legal hold placed: " : "Legal hold released: ") + reason, new { legalHold = row.LegalHold }, new { legalHold = input.Hold, reason });
        tx.Commit();
        return Results.NoContent();
    }

    /// <summary>Safe retry of a FAILED recording's post-processing: the worker rebuilds from the spooled media and verifies again.</summary>
    static async Task<IResult> Retry(Guid id, Db db, RecorderWorker worker, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var (row, _, v) = await FindAsync(c, id, ctx);
        if (row is null) return NotFound();
        if (row.Status != "FAILED") return Db_.Conflict("Only failed recordings can be retried.");
        using var tx = c.BeginTransaction();
        var n = await c.ExecuteAsync("""
            UPDATE rec.RecordingJobs SET [State] = 'POST_PROCESSING', LeaseOwner = NULL, LeaseExpiresUtc = '2000-01-01', LastError = NULL, ModifiedUtc = SYSUTCDATETIME()
            WHERE RecordingId = @id AND [State] = 'FAILED' AND LaunchCount > 0;
            """, new { id = row.RecordingId }, tx);
        if (n == 0)
        {
            tx.Rollback();
            return Db_.Conflict("Nothing to retry: the recorder never produced media for this recording.");
        }
        await c.ExecuteAsync("UPDATE rec.MeetingRecordings SET [Status] = 'PROCESSING', ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE RecordingId = @id",
            new { id = row.RecordingId, user = v.UserId }, tx);
        await Audit.WriteAsync(c, "USER", v.UserId, "RECORDING_RETRY", "Recording", id.ToString(), "Post-processing retried", ClientInfo.From(ctx).Ip, tx, privileged: true);
        tx.Commit();
        worker.Kick();
        return Results.Accepted();
    }

    // ---- Retention review and deletion approvals ------------------------------------------------------------------------

    static async Task<IResult> Retention(Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var v = await Viewer.LoadAsync(c, ctx.User);
        var args = new DynamicParameters(v.Sql);
        var approverPolicies = (await c.QueryAsync<string>("SELECT PolicyCode FROM rec.RecordingPolicies p WHERE EXISTS (SELECT 1 FROM OPENJSON(p.DeletionApproverRoles) j WHERE j.[value] IN @roles)",
            new { roles = v.Roles })).ToArray();
        var auditor = v.AuditView || v.ViewAll;
        if (!auditor && approverPolicies.Length == 0) return Results.Ok(new { review = Array.Empty<object>(), deletions = Array.Empty<object>(), canApproveFor = approverPolicies });
        args.Add("policies", approverPolicies.Length == 0 ? ["-"] : approverPolicies);
        args.Add("auditor", auditor);
        var review = await c.QueryAsync<Row>($"""
            {Select} {From} WHERE r.[Status] = 'COMPLETED' AND r.RetentionReviewUtc IS NOT NULL AND (@auditor = 1 OR r.PolicyCode IN @policies)
            ORDER BY r.RetainUntilUtc
            """, args);
        var deletions = await c.QueryAsync<(Guid Id, Guid RecordingId, string MeetingTitle, string MeetingCode, string Owner, string Source, string Reason, int RequiredApprovals,
            string Status, DateTime RequestedUtc, string? FirstApprover, DateTime? FirstApprovedUtc, string? SecondApprover, string? Notes, string PolicyCode, DateTime? ExecutedUtc)>("""
            SELECT TOP (200) x.PublicId, r.PublicId, m.Title, m.MeetingCode, o.DisplayName, x.Source, x.Reason, x.RequiredApprovals, x.[Status], x.RequestedUtc,
                   COALESCE(e1.DisplayName, u1.Email), x.FirstApprovedUtc, COALESCE(e2.DisplayName, u2.Email), x.Notes, r.PolicyCode, x.ExecutedUtc
            FROM rec.RecordingDeletions x JOIN rec.MeetingRecordings r ON r.RecordingId = x.RecordingId JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId
            JOIN org.Employees o ON o.EmployeeId = r.OwnerEmployeeId
            LEFT JOIN auth.Users u1 ON u1.UserId = x.FirstApproverUserId LEFT JOIN org.Employees e1 ON e1.EmployeeId = u1.EmployeeId
            LEFT JOIN auth.Users u2 ON u2.UserId = x.SecondApproverUserId LEFT JOIN org.Employees e2 ON e2.EmployeeId = u2.EmployeeId
            WHERE (@auditor = 1 OR r.PolicyCode IN @policies)
            ORDER BY CASE WHEN x.[Status] = 'PENDING' THEN 0 ELSE 1 END, x.RequestedUtc DESC
            """, args);
        return Results.Ok(new
        {
            review = review.Select(r => Item(r, RecordingAccess.Decide(v, r))),
            deletions = deletions.Select(d => new
            {
                id = d.Id, recordingId = d.RecordingId, meetingTitle = d.MeetingTitle, meetingCode = d.MeetingCode, owner = d.Owner, source = d.Source, reason = d.Reason,
                requiredApprovals = d.RequiredApprovals, status = d.Status, requestedUtc = d.RequestedUtc, firstApprover = d.FirstApprover, firstApprovedUtc = d.FirstApprovedUtc,
                secondApprover = d.SecondApprover, notes = d.Notes, executedUtc = d.ExecutedUtc, canDecide = d.Status == "PENDING" && approverPolicies.Contains(d.PolicyCode),
            }),
            canApproveFor = approverPolicies,
        });
    }

    /// <summary>Approve (two different approvers when the policy requires dual approval) or reject a pending deletion.</summary>
    static async Task<IResult> Decide(Guid deletionId, bool approve, string? note, Db db, RecordingPaths paths, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var v = await Viewer.LoadAsync(c, ctx.User);
        var d = await c.QuerySingleOrDefaultAsync<(long DeletionId, long RecordingId, Guid RecordingPublicId, string Status, int RequiredApprovals, long? FirstApproverUserId, long? RequestedByUserId, string ApproverRoles)?>("""
            SELECT x.DeletionId, x.RecordingId, r.PublicId, x.[Status], x.RequiredApprovals, x.FirstApproverUserId, x.RequestedByUserId, p.DeletionApproverRoles
            FROM rec.RecordingDeletions x JOIN rec.MeetingRecordings r ON r.RecordingId = x.RecordingId JOIN rec.RecordingPolicies p ON p.PolicyCode = r.PolicyCode
            WHERE x.PublicId = @deletionId
            """, new { deletionId });
        if (d is null) return Db_.NotFound("Deletion request");
        var roles = JsonSerializer.Deserialize<string[]>(d.Value.ApproverRoles) ?? [];
        if (!roles.Intersect(v.Roles).Any()) return Problems.Create(403, "FORBIDDEN", "Your role is not a deletion approver in this recording's policy.");
        if (d.Value.Status != "PENDING") return Db_.Conflict("This deletion request has already been decided.");
        if (d.Value.RequestedByUserId == v.UserId) return Problems.Create(409, "CONFLICT", "The person who requested a deletion cannot approve it.");
        note = note?.Trim() is { Length: > 0 } nn ? (nn.Length > 1000 ? nn[..1000] : nn) : null;
        var ip = ClientInfo.From(ctx).Ip;
        if (!approve)
        {
            await c.ExecuteAsync("""
                UPDATE rec.RecordingDeletions SET [Status] = 'REJECTED', DecidedByUserId = @user, DecidedUtc = SYSUTCDATETIME(), Notes = @note WHERE DeletionId = @id AND [Status] = 'PENDING'
                """, new { user = v.UserId, id = d.Value.DeletionId, note });
            await Audit.WriteAsync(c, "USER", v.UserId, "RECORDING_DELETION_REJECTED", "Recording", d.Value.RecordingPublicId.ToString(), "Retention deletion rejected", ip, privileged: true);
            return Results.NoContent();
        }
        if (d.Value.FirstApproverUserId == v.UserId) return Problems.Create(409, "CONFLICT", "A second, different approver must approve this deletion.");
        int n;
        bool execute;
        if (d.Value.FirstApproverUserId is null)
        {
            n = await c.ExecuteAsync("""
                UPDATE rec.RecordingDeletions SET FirstApproverUserId = @user, FirstApprovedUtc = SYSUTCDATETIME(), Notes = COALESCE(@note, Notes)
                WHERE DeletionId = @id AND [Status] = 'PENDING' AND FirstApproverUserId IS NULL
                """, new { user = v.UserId, id = d.Value.DeletionId, note });
            execute = d.Value.RequiredApprovals <= 1;
        }
        else
        {
            n = await c.ExecuteAsync("""
                UPDATE rec.RecordingDeletions SET SecondApproverUserId = @user, SecondApprovedUtc = SYSUTCDATETIME(), Notes = COALESCE(@note, Notes)
                WHERE DeletionId = @id AND [Status] = 'PENDING' AND SecondApproverUserId IS NULL AND FirstApproverUserId <> @user
                """, new { user = v.UserId, id = d.Value.DeletionId, note });
            execute = true;
        }
        if (n == 0) return Db_.Conflict("This deletion request changed in the meantime. Reload and try again.");
        await Audit.WriteAsync(c, "USER", v.UserId, "RECORDING_DELETION_APPROVED", "Recording", d.Value.RecordingPublicId.ToString(),
            execute ? "Retention deletion approved (final approval)" : "Retention deletion approved (first of two approvals)", ip, privileged: true);
        if (!execute) return Results.Ok(new { status = "PENDING", approvals = 1, required = d.Value.RequiredApprovals });
        var purged = await RetentionWorker.PurgeAsync(c, paths, d.Value.RecordingId, d.Value.DeletionId, v.UserId, ip);
        return Results.Ok(new { status = purged ? "EXECUTED" : "CANCELLED", approvals = d.Value.RequiredApprovals, required = d.Value.RequiredApprovals });
    }
}
