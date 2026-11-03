using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Administration â†’ Recording policies: /api/v1/admin/recording-policies (+ /categories) and /api/v1/admin/recording/health.
/// Reading: recordings.policy.manage, admin.settings or audit.view. Changing: recordings.policy.manage only (V012, SuperAdmin by
/// default) â€” recording consent wording, retention and access are compliance decisions, not day-to-day settings, so the broader
/// admin.settings (also held by the Admin role) is deliberately not enough. Every change is audited (privileged, old + new values).
/// </summary>
public static partial class RecordingPolicyEndpoints
{
    public sealed record PolicyInput(string? PolicyName, string? PolicyVersion, string? EffectiveFrom, string? ApprovalStatus, string? PolicyReference,
        string? ApprovedBy, string? ApprovedOn, bool IsEnabled, string? Requirement, string? ConsentMode, string? NoticeText, string? NoticeVersion,
        bool ConsentFromAll, bool StopOnWithdrawal, int? RetentionDays, string? ExpiryAction, string? ArchiveLocation, bool LegalHoldEnabled,
        bool DualApprovalForDeletion, string[]? DeletionApproverRoles, string[]? PlaybackRoles, string[]? DownloadRoles, bool OwnerCanPlay,
        bool OwnerCanDownload, bool TeamLeaderCanPlay, bool DepartmentHeadCanPlay, int SignedUrlTtlSeconds, string? RowVersion);

    public sealed record CategoryInput(string? Category, string? PolicyCode);
    public sealed record CategoriesInput(CategoryInput[]? Items);

    public static RouteGroupBuilder MapRecordingPolicyEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/admin/recording-policies");
        g.MapGet("", List).RequireAnyPermission("recordings.policy.manage", "admin.settings", "audit.view");
        g.MapPut("/{code}", Update).RequirePermission("recordings.policy.manage");
        g.MapGet("/categories", Categories).RequireAnyPermission("recordings.policy.manage", "admin.settings", "audit.view");
        g.MapPut("/categories", UpdateCategories).RequirePermission("recordings.policy.manage");
        api.MapGet("/admin/recording/health", Health).RequireAnyPermission("admin.ops", "admin.settings", "recordings.policy.manage");
        // For the meeting form: which meeting categories can be recorded at all (no policy wording or roles exposed).
        api.MapGet("/meetings/recording-options", RecordingOptions).RequirePermission("meetings.create");
        return api;
    }

    sealed record RecordingOptionRow(string Category, string PolicyCode, string Title, bool IsEnabled, string Requirement);

    static async Task<IResult> RecordingOptions(Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var rows = await c.QueryAsync<RecordingOptionRow>("""
            SELECT m.Category, p.PolicyCode, p.Title, p.IsEnabled, p.Requirement
            FROM rec.RecordingPolicyCategories m JOIN rec.RecordingPolicies p ON p.PolicyCode = m.PolicyCode
            ORDER BY m.Category
            """);
        return Results.Ok(rows.Select(r => new
        {
            category = r.Category, policyCode = r.PolicyCode, policyTitle = r.Title,
            // Recording is possible only when the mapped policy is switched on and not set to Disabled.
            enabled = r.IsEnabled && r.Requirement != "DISABLED", requirement = r.Requirement,
        }));
    }

    internal static object Dto(PolicyRow p) => new
    {
        code = p.PolicyCode, title = p.Title, appliesTo = p.AppliesTo, policyName = p.PolicyName, policyVersion = p.PolicyVersion,
        effectiveFrom = p.EffectiveFrom?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), approvalStatus = p.ApprovalStatus, policyReference = p.PolicyReference,
        approvedBy = p.ApprovedBy, approvedOn = p.ApprovedOn?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), isEnabled = p.IsEnabled, requirement = p.Requirement,
        consentMode = p.ConsentMode, noticeText = p.NoticeText, noticeVersion = p.NoticeVersion, consentFromAll = p.ConsentFromAll, stopOnWithdrawal = p.StopOnWithdrawal,
        retentionDays = p.RetentionDays, expiryAction = p.ExpiryAction, archiveLocation = p.ArchiveLocation, legalHoldEnabled = p.LegalHoldEnabled,
        dualApprovalForDeletion = p.DualApprovalForDeletion, deletionApproverRoles = p.DeletionApprovers, playbackRoles = p.Playback, downloadRoles = p.Download,
        ownerCanPlay = p.OwnerCanPlay, ownerCanDownload = p.OwnerCanDownload, teamLeaderCanPlay = p.TeamLeaderCanPlay, departmentHeadCanPlay = p.DepartmentHeadCanPlay,
        signedUrlTtlSeconds = p.SignedUrlTtlSeconds, modifiedUtc = p.ModifiedUtc, modifiedBy = p.ModifiedBy, rowVersion = Convert.ToBase64String(p.RowVersion),
        confirmed = p.IsConfirmed, hasPlaceholders = p.HasPlaceholders, pending = PendingItems(p),
        configurationOnly = p.PolicyCode == "CUSTOMER_AUDIO_CALL",
    };

    /// <summary>What is still unconfirmed for this policy (shown in the "Not confirmed" banner).</summary>
    static List<string> PendingItems(PolicyRow p)
    {
        var items = new List<string>();
        if (!p.IsConfirmed) items.Add("Policy not confirmed: status is pending confirmation or the policy reference is missing.");
        if (string.IsNullOrWhiteSpace(p.PolicyName) || string.IsNullOrWhiteSpace(p.PolicyVersion)) items.Add("Policy name and version not entered.");
        if (p.NoticeText.Contains(RecordingPolicy.PlaceholderMarker, StringComparison.OrdinalIgnoreCase) || p.NoticeVersion.StartsWith("PLACEHOLDER", StringComparison.OrdinalIgnoreCase))
            items.Add("Consent/notification wording and its version are placeholders.");
        if (p.RetentionDays is null) items.Add("Retention period not set: recordings are never deleted or archived automatically.");
        if (p.Playback.Length == 0 && p.Download.Length == 0) items.Add("Playback and download roles not set (only the owner flags and explicit permissions apply).");
        return items;
    }

    static async Task<IResult> List(Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var policies = await RecordingPolicyStore.AllAsync(c);
        var roles = await c.QueryAsync<(string Code, string Name)>("SELECT Code, Name FROM auth.Roles ORDER BY Name");
        return Results.Ok(new
        {
            items = policies.Select(Dto),
            roles = roles.Select(r => new { code = r.Code, name = r.Name }),
            categories = (await RecordingPolicyStore.CategoriesAsync(c)).Select(x => new { category = x.Category, policyCode = x.PolicyCode }),
        });
    }

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._\-]{0,29}$")] private static partial Regex VersionRe();

    static DateTime? ParseDate(Validator v, string field, string? s, string label)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        if (DateTime.TryParseExact(s.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) return d;
        v.Add(field, $"{label} must be a date (YYYY-MM-DD).");
        return null;
    }

    static async Task<IResult> Update(string code, PolicyInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var old = await RecordingPolicyStore.GetAsync(c, code);
        if (old is null) return Db_.NotFound("Recording policy");

        var v = new Validator();
        var name = v.Optional("policyName", input.PolicyName, 200, "Policy name");
        var version = v.Optional("policyVersion", input.PolicyVersion, 50, "Policy version");
        var reference = v.Optional("policyReference", input.PolicyReference, 400, "Policy reference");
        var approvedBy = v.Optional("approvedBy", input.ApprovedBy, 200, "Approved by");
        var effective = ParseDate(v, "effectiveFrom", input.EffectiveFrom, "Effective date");
        var approvedOn = ParseDate(v, "approvedOn", input.ApprovedOn, "Approval date");
        var status = input.ApprovalStatus?.Trim().ToUpperInvariant() ?? "";
        if (!RecordingPolicyStore.Statuses.Contains(status)) v.Add("approvalStatus", "Choose pending confirmation, existing business policy or approved.");
        var requirement = input.Requirement?.Trim().ToUpperInvariant() ?? "";
        if (!RecordingPolicyStore.Requirements.Contains(requirement)) v.Add("requirement", "Choose disabled, optional or mandatory.");
        var consentMode = input.ConsentMode?.Trim().ToUpperInvariant() ?? "";
        if (!RecordingPolicyStore.ConsentModes.Contains(consentMode)) v.Add("consentMode", "Choose consent required or notification only.");
        var expiry = input.ExpiryAction?.Trim().ToUpperInvariant() ?? "";
        if (!RecordingPolicyStore.ExpiryActions.Contains(expiry)) v.Add("expiryAction", "Choose review only, archive or delete.");
        var notice = v.Required("noticeText", input.NoticeText, 4000, "Consent / notification wording");
        var noticeVersion = v.Required("noticeVersion", input.NoticeVersion, 30, "Wording version");
        if (noticeVersion is not null && !VersionRe().IsMatch(noticeVersion)) v.Add("noticeVersion", "Use letters, digits, '.', '-' or '_' (max 30).");
        if (input.RetentionDays is { } days && (days < 1 || days > 36500)) v.Add("retentionDays", "Retention must be between 1 and 36500 days, or empty (not set).");
        if (input.SignedUrlTtlSeconds is < 30 or > 3600) v.Add("signedUrlTtlSeconds", "Link lifetime must be between 30 and 3600 seconds.");
        var archive = v.Optional("archiveLocation", input.ArchiveLocation, 400, "Archive location");
        if (expiry == "ARCHIVE" && archive is null) v.Add("archiveLocation", "An archive location is required when the action at expiry is Archive.");
        if (archive is not null && !Path.IsPathFullyQualified(archive)) v.Add("archiveLocation", "Enter an absolute folder path (e.g. D:\\RecordingArchive or \\\\server\\share\\recordings).");

        var knownRoles = (await c.QueryAsync<string>("SELECT Code FROM auth.Roles")).ToHashSet(StringComparer.Ordinal);
        string[] Roles(string field, string[]? roles)
        {
            var list = (roles ?? []).Select(r => r?.Trim() ?? "").Where(r => r.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
            var unknown = list.Where(r => !knownRoles.Contains(r)).ToList();
            if (unknown.Count > 0) v.Add(field, $"Unknown role(s): {string.Join(", ", unknown)}.");
            return list;
        }
        var playback = Roles("playbackRoles", input.PlaybackRoles);
        var download = Roles("downloadRoles", input.DownloadRoles);
        var approvers = Roles("deletionApproverRoles", input.DeletionApproverRoles);

        byte[]? rowVersion = null;
        try { rowVersion = string.IsNullOrEmpty(input.RowVersion) ? null : Convert.FromBase64String(input.RowVersion); }
        catch (FormatException) { v.Add("rowVersion", "Invalid version token."); }
        if (rowVersion is null) v.Add("rowVersion", "Reload the policy before saving.");
        if (!v.IsValid) return v.Problem();

        var updated = new PolicyRow
        {
            PolicyCode = old.PolicyCode, PolicyName = name, PolicyVersion = version, EffectiveFrom = effective, ApprovalStatus = status, PolicyReference = reference,
            ApprovedBy = approvedBy, ApprovedOn = approvedOn, IsEnabled = input.IsEnabled, Requirement = requirement, ConsentMode = consentMode, NoticeText = notice!,
            NoticeVersion = noticeVersion!, ConsentFromAll = input.ConsentFromAll, StopOnWithdrawal = input.StopOnWithdrawal, RetentionDays = input.RetentionDays,
            ExpiryAction = expiry, ArchiveLocation = archive, LegalHoldEnabled = input.LegalHoldEnabled, DualApprovalForDeletion = input.DualApprovalForDeletion,
            DeletionApproverRoles = JsonSerializer.Serialize(approvers), PlaybackRoles = JsonSerializer.Serialize(playback), DownloadRoles = JsonSerializer.Serialize(download),
            OwnerCanPlay = input.OwnerCanPlay, OwnerCanDownload = input.OwnerCanDownload, TeamLeaderCanPlay = input.TeamLeaderCanPlay,
            DepartmentHeadCanPlay = input.DepartmentHeadCanPlay, SignedUrlTtlSeconds = input.SignedUrlTtlSeconds,
        };

        // Never "confirmed" with placeholder values: status ExistingBusinessPolicy/Approved needs the reference and the real values.
        if (status != "PENDING_CONFIRMATION")
        {
            if (reference is null) v.Add("policyReference", "Enter the reference of the policy document these values come from.");
            if (notice!.Contains(RecordingPolicy.PlaceholderMarker, StringComparison.OrdinalIgnoreCase)) v.Add("noticeText", "Replace the placeholder wording with the confirmed wording before confirming the policy.");
            if (noticeVersion!.StartsWith("PLACEHOLDER", StringComparison.OrdinalIgnoreCase)) v.Add("noticeVersion", "Enter the version of the confirmed wording.");
            if (input.RetentionDays is null) v.Add("retentionDays", "A confirmed policy needs its retention period.");
            if (name is null) v.Add("policyName", "Enter the policy name.");
            if (version is null) v.Add("policyVersion", "Enter the policy version.");
            if (status == "APPROVED" && (approvedBy is null || approvedOn is null)) v.Add("approvedBy", "An approved policy records who approved it and when.");
            if (v.IsValid)
                foreach (var error in RecordingPolicyGate.Validate(updated.ToGate(MeetingRecordingKind.Customer), DeploymentEnvironment.Production))
                    v.Add("approvalStatus", error);
            if (!v.IsValid) return v.Problem();
        }

        using var tx = c.BeginTransaction();
        var n = await c.ExecuteAsync("""
            UPDATE rec.RecordingPolicies SET PolicyName = @PolicyName, PolicyVersion = @PolicyVersion, EffectiveFrom = @EffectiveFrom, ApprovalStatus = @ApprovalStatus,
                PolicyReference = @PolicyReference, ApprovedBy = @ApprovedBy, ApprovedOn = @ApprovedOn, IsEnabled = @IsEnabled, Requirement = @Requirement,
                ConsentMode = @ConsentMode, NoticeText = @NoticeText, NoticeVersion = @NoticeVersion, ConsentFromAll = @ConsentFromAll, StopOnWithdrawal = @StopOnWithdrawal,
                RetentionDays = @RetentionDays, ExpiryAction = @ExpiryAction, ArchiveLocation = @ArchiveLocation, LegalHoldEnabled = @LegalHoldEnabled,
                DualApprovalForDeletion = @DualApprovalForDeletion, DeletionApproverRoles = @DeletionApproverRoles, PlaybackRoles = @PlaybackRoles,
                DownloadRoles = @DownloadRoles, OwnerCanPlay = @OwnerCanPlay, OwnerCanDownload = @OwnerCanDownload, TeamLeaderCanPlay = @TeamLeaderCanPlay,
                DepartmentHeadCanPlay = @DepartmentHeadCanPlay, SignedUrlTtlSeconds = @SignedUrlTtlSeconds, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
            WHERE PolicyCode = @code AND RowVersion = @rowVersion
            """, new
        {
            updated.PolicyName, updated.PolicyVersion, updated.EffectiveFrom, updated.ApprovalStatus, updated.PolicyReference, updated.ApprovedBy, updated.ApprovedOn,
            updated.IsEnabled, updated.Requirement, updated.ConsentMode, updated.NoticeText, updated.NoticeVersion, updated.ConsentFromAll, updated.StopOnWithdrawal,
            updated.RetentionDays, updated.ExpiryAction, updated.ArchiveLocation, updated.LegalHoldEnabled, updated.DualApprovalForDeletion, updated.DeletionApproverRoles,
            updated.PlaybackRoles, updated.DownloadRoles, updated.OwnerCanPlay, updated.OwnerCanDownload, updated.TeamLeaderCanPlay, updated.DepartmentHeadCanPlay,
            updated.SignedUrlTtlSeconds, user = ctx.User.UserId(), code, rowVersion,
        }, tx);
        if (n == 0)
        {
            tx.Rollback();
            return Db_.Conflict("Someone else changed this policy in the meantime. Reload it and apply your changes again.");
        }
        await AuditChangeAsync(c, tx, ctx, "RECORDING_POLICY_UPDATED", "RecordingPolicy", code, $"Recording policy '{old.Title}' changed", old.Snapshot(), updated.Snapshot());
        tx.Commit();
        return Results.Ok(Dto((await RecordingPolicyStore.GetAsync(c, code))!));
    }

    internal static Task AuditChangeAsync(IDbConnection c, IDbTransaction? tx, HttpContext ctx, string action, string entityType, string entityId, string summary, object? oldValues, object? newValues) =>
        c.ExecuteAsync("""
            INSERT app.AuditLog (ActorType, ActorUserId, [Action], EntityType, EntityId, Summary, OldValuesJson, NewValuesJson, IpAddress, IsPrivileged)
            VALUES ('USER', @user, @action, @entityType, @entityId, @summary, @old, @new, @ip, 1)
            """, new
        {
            user = ctx.User.UserId(), action, entityType, entityId, summary = summary.Length > 500 ? summary[..500] : summary,
            old = oldValues is null ? null : JsonSerializer.Serialize(oldValues), @new = newValues is null ? null : JsonSerializer.Serialize(newValues), ip = ClientInfo.From(ctx).Ip,
        }, tx);

    static async Task<IResult> Categories(Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        return Results.Ok((await RecordingPolicyStore.CategoriesAsync(c)).Select(x => new { category = x.Category, policyCode = x.PolicyCode }));
    }

    static async Task<IResult> UpdateCategories(CategoriesInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        var v = new Validator();
        var items = (input.Items ?? []).Select(i => (Category: i.Category?.Trim().ToUpperInvariant() ?? "", Policy: i.PolicyCode?.Trim().ToUpperInvariant() ?? "")).ToList();
        var categories = Meetings.MeetingEndpoints.Categories;
        if (items.Select(i => i.Category).Distinct().Count() != items.Count || !categories.All(cat => items.Any(i => i.Category == cat)) || items.Count != categories.Length)
            v.Add("items", "Map every meeting category exactly once.");
        foreach (var (cat, policy) in items)
        {
            var customer = Meetings.MeetingEndpoints.IsCustomerCategory(cat);
            if (!RecordingPolicyStore.Codes.Contains(policy) || policy == "CUSTOMER_AUDIO_CALL")
                v.Add(cat, "Choose a meeting policy (customer audio calls are not meetings).");
            else if (customer && policy != "CUSTOMER_MEETING")
                v.Add(cat, "Customer meeting categories must use the customer meetings policy.");
            else if (!customer && policy == "CUSTOMER_MEETING")
                v.Add(cat, "Internal meeting categories cannot use the customer meetings policy.");
        }
        if (!v.IsValid) return v.Problem();
        using var c = await db.OpenAsync(ct);
        using var tx = c.BeginTransaction();
        var before = (await c.QueryAsync<(string Category, string PolicyCode)>("SELECT Category, PolicyCode FROM rec.RecordingPolicyCategories WITH (UPDLOCK) ORDER BY Category", transaction: tx)).ToList();
        foreach (var (cat, policy) in items)
            await c.ExecuteAsync("UPDATE rec.RecordingPolicyCategories SET PolicyCode = @policy, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE Category = @cat AND PolicyCode <> @policy",
                new { policy, cat, user = ctx.User.UserId() }, tx);
        await AuditChangeAsync(c, tx, ctx, "RECORDING_POLICY_CATEGORIES_UPDATED", "RecordingPolicy", "categories", "Meeting category â†’ recording policy mapping changed",
            before.ToDictionary(x => x.Category, x => x.PolicyCode), items.ToDictionary(x => x.Category, x => x.Policy));
        tx.Commit();
        return Results.Ok((await RecordingPolicyStore.CategoriesAsync(c)).Select(x => new { category = x.Category, policyCode = x.PolicyCode }));
    }

    static async Task<IResult> Health(RecorderHealth health, IOptions<RecordingOptions> options, Db db, CancellationToken ct)
    {
        var items = health.Full();
        using var c = await db.OpenAsync(ct);
        var jobs = await c.QuerySingleAsync<(int Active, int Queued, int Failed24h)>("""
            SELECT (SELECT COUNT(*) FROM rec.RecordingJobs WHERE [State] IN ('STARTING', 'ACTIVE', 'STOPPING', 'POST_PROCESSING')),
                   (SELECT COUNT(*) FROM rec.RecordingJobs WHERE [State] = 'QUEUED'),
                   (SELECT COUNT(*) FROM rec.MeetingRecordings WHERE [Status] = 'FAILED' AND COALESCE(ModifiedUtc, CreatedUtc) > DATEADD(HOUR, -24, SYSUTCDATETIME()))
            """);
        return Results.Ok(new
        {
            available = items.All(i => i.Ok), environment = options.Value.DeploymentEnvironment.ToString(),
            recorder = "R2 recorder â€” proof of concept (headless Microsoft Edge + FFmpeg). Not production-ready.",
            items = items.Select(i => new { name = i.Name, ok = i.Ok, detail = i.Detail }),
            activeJobs = jobs.Active, queuedJobs = jobs.Queued, failedLast24h = jobs.Failed24h,
        });
    }
}
