using System.Data;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Applies each recording policy's retention rule. NOTHING happens for a policy whose retention period is not set (the shipped default),
/// and nothing ever happens to a recording under legal hold. When a COMPLETED recording's retention has expired:
/// REVIEW_ONLY flags it for the review list; ARCHIVE moves the file to the policy's archive location (checksum verified, the row keeps
/// pointing at it); DELETE deletes the file and marks the row PURGED (the row, its audit trail and access log stay) — after two
/// different approvers agreed when the policy requires dual approval (rec.RecordingDeletions).
/// </summary>
public sealed class RetentionWorker(Db db, IClock clock, RecordingPaths paths, IOptions<RecordingOptions> options, ILogger<RetentionWorker> log) : BackgroundService
{
    RecordingOptions O => options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!O.RetentionEnabled) return;
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Retention run failed"); }
            try { await Task.Delay(TimeSpan.FromMinutes(Math.Max(1, O.RetentionPollMinutes)), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    sealed record Due(long RecordingId, Guid PublicId, string PolicyCode, string StorageKey, string StorageTier, string? ArchiveRoot, DateTime? RetentionReviewUtc,
        string ExpiryAction, string? ArchiveLocation, bool DualApprovalForDeletion, byte[] Sha256);

    public sealed record RunResult(int Reviewed, int Archived, int Purged, int DeletionRequests, int Errors);

    public async Task<RunResult> RunOnceAsync(CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var now = clock.UtcNow;
        // Keep RetainUntilUtc in step with the CURRENT policy (an administrator may set or change the period later).
        await c.ExecuteAsync("""
            UPDATE r SET RetainUntilUtc = CASE WHEN p.RetentionDays IS NULL THEN NULL ELSE DATEADD(DAY, p.RetentionDays, COALESCE(r.EndedUtc, r.CreatedUtc)) END
            FROM rec.MeetingRecordings r JOIN rec.RecordingPolicies p ON p.PolicyCode = r.PolicyCode
            WHERE r.[Status] = 'COMPLETED'
              AND ISNULL(r.RetainUntilUtc, '1900-01-01') <> ISNULL(CASE WHEN p.RetentionDays IS NULL THEN NULL ELSE DATEADD(DAY, p.RetentionDays, COALESCE(r.EndedUtc, r.CreatedUtc)) END, '1900-01-01')
            """);
        var due = (await c.QueryAsync<Due>("""
            SELECT r.RecordingId, r.PublicId, r.PolicyCode, r.StorageKey, r.StorageTier, r.ArchiveRoot, r.RetentionReviewUtc, p.ExpiryAction, p.ArchiveLocation,
                   p.DualApprovalForDeletion, r.Sha256
            FROM rec.MeetingRecordings r JOIN rec.RecordingPolicies p ON p.PolicyCode = r.PolicyCode
            WHERE r.[Status] = 'COMPLETED' AND r.LegalHold = 0 AND p.RetentionDays IS NOT NULL AND r.RetainUntilUtc IS NOT NULL AND r.RetainUntilUtc <= @now
            """, new { now })).ToList();
        int reviewed = 0, archived = 0, purged = 0, requests = 0, errors = 0;
        foreach (var d in due)
        {
            try
            {
                switch (d.ExpiryAction)
                {
                    case "REVIEW_ONLY" when d.RetentionReviewUtc is null:
                        await c.ExecuteAsync("UPDATE rec.MeetingRecordings SET RetentionReviewUtc = @now, ModifiedUtc = SYSUTCDATETIME() WHERE RecordingId = @id", new { now, id = d.RecordingId });
                        await Audit.WriteAsync(c, "SYSTEM", null, "RECORDING_RETENTION_REVIEW", "Recording", d.PublicId.ToString(), "Retention period expired: flagged for review", null);
                        reviewed++;
                        break;
                    case "ARCHIVE" when d.StorageTier == "PRIMARY" && !string.IsNullOrWhiteSpace(d.ArchiveLocation):
                        await ArchiveAsync(c, d, ct);
                        archived++;
                        break;
                    case "DELETE":
                        if (d.DualApprovalForDeletion)
                        {
                            requests += await c.ExecuteAsync("""
                                INSERT rec.RecordingDeletions (RecordingId, Source, Reason, RequiredApprovals)
                                SELECT @id, 'RETENTION', N'Retention period expired (policy action: delete). Two approvals are required.', 2
                                WHERE NOT EXISTS (SELECT 1 FROM rec.RecordingDeletions WHERE RecordingId = @id AND [Status] IN ('PENDING', 'REJECTED'))
                                """, new { id = d.RecordingId });
                        }
                        else
                        {
                            var deletionId = await c.QuerySingleAsync<long>("""
                                INSERT rec.RecordingDeletions (RecordingId, Source, Reason, RequiredApprovals) OUTPUT inserted.DeletionId
                                VALUES (@id, 'RETENTION', N'Retention period expired (policy action: delete, no approval required by the policy).', 0)
                                """, new { id = d.RecordingId });
                            if (await PurgeAsync(c, paths, d.RecordingId, deletionId, null, null)) purged++;
                        }
                        break;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                errors++;
                log.LogError(e, "Retention action {Action} failed for recording {Recording}", d.ExpiryAction, d.PublicId);
            }
        }
        return new RunResult(reviewed, archived, purged, requests, errors);
    }

    async Task ArchiveAsync(IDbConnection c, Due d, CancellationToken ct)
    {
        var src = RecordingPaths.Resolve(paths.StorageRoot ?? throw new InvalidOperationException("Recording:StorageRoot is not configured."), d.StorageKey);
        var archiveRoot = Path.GetFullPath(d.ArchiveLocation!);
        var dest = RecordingPaths.Resolve(archiveRoot, d.StorageKey);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        File.Copy(src, dest + ".partial", overwrite: true);
        var sha = Convert.FromHexString(await MediaVerifier.Sha256HexAsync(dest + ".partial", ct));
        if (!sha.AsSpan().SequenceEqual(d.Sha256))
        {
            File.Delete(dest + ".partial");
            throw new InvalidOperationException("Archive copy checksum mismatch.");
        }
        File.Move(dest + ".partial", dest, overwrite: true);
        await c.ExecuteAsync("""
            UPDATE rec.MeetingRecordings SET StorageTier = 'ARCHIVE', ArchiveRoot = @root, ArchivedUtc = SYSUTCDATETIME(), ModifiedUtc = SYSUTCDATETIME() WHERE RecordingId = @id
            """, new { root = archiveRoot, id = d.RecordingId });
        File.Delete(src);
        await Audit.WriteAsync(c, "SYSTEM", null, "RECORDING_ARCHIVED", "Recording", d.PublicId.ToString(), "Retention period expired: moved to the archive location (checksum verified)", null,
            newValues: new { archiveRoot });
    }

    /// <summary>Deletes the file and marks the recording PURGED (row, audit and access history stay). Refuses while a legal hold is set.</summary>
    internal static async Task<bool> PurgeAsync(IDbConnection c, RecordingPaths paths, long recordingId, long deletionId, long? userId, string? ip)
    {
        var r = await c.QuerySingleAsync<(Guid PublicId, string Status, bool LegalHold, string? StorageKey, string StorageTier, string? ArchiveRoot)>(
            "SELECT PublicId, [Status], LegalHold, StorageKey, StorageTier, ArchiveRoot FROM rec.MeetingRecordings WHERE RecordingId = @recordingId", new { recordingId });
        if (r.LegalHold || r.Status != "COMPLETED")
        {
            await c.ExecuteAsync("""
                UPDATE rec.RecordingDeletions SET [Status] = 'CANCELLED', Notes = @note, DecidedUtc = SYSUTCDATETIME() WHERE DeletionId = @deletionId AND [Status] = 'PENDING'
                """, new { deletionId, note = r.LegalHold ? "Cancelled: the recording is under legal hold." : $"Cancelled: recording status is {r.Status}." });
            return false;
        }
        var root = r.StorageTier == "ARCHIVE" ? r.ArchiveRoot : paths.StorageRoot;
        if (root is not null && r.StorageKey is not null)
        {
            var file = RecordingPaths.Resolve(root, r.StorageKey);
            if (File.Exists(file)) File.Delete(file);
        }
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("""
            UPDATE rec.MeetingRecordings SET [Status] = 'PURGED', PurgedUtc = SYSUTCDATETIME(), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @userId WHERE RecordingId = @recordingId;
            UPDATE rec.RecordingDeletions SET [Status] = 'EXECUTED', ExecutedUtc = SYSUTCDATETIME() WHERE DeletionId = @deletionId;
            """, new { recordingId, deletionId, userId }, tx);
        await Audit.WriteAsync(c, userId is null ? "SYSTEM" : "USER", userId, "RECORDING_PURGED", "Recording", r.PublicId.ToString(),
            "Recording file deleted under the retention policy; the record and its history are kept", ip, tx, privileged: true);
        tx.Commit();
        return true;
    }
}
