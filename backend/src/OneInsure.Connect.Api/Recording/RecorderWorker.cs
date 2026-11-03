using System.Collections.Concurrent;
using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Runs recording jobs (rec.RecordingJobs) with the R2 recorder. Hosted in the API process for this single-server deployment: it shares
/// the API's configuration and database access, while the recorder itself is a SEPARATE process (and the media server is LiveKit), so
/// a browser or FFmpeg crash never affects the API. Jobs are leased through rec.usp_ClaimRecordingJobs with a heartbeat, so the worker
/// can later move to its own Windows service (or several hosts) without code changes.
///
/// Lifecycle: QUEUED → STARTING (claimed) → ACTIVE (recorder launched; the recording becomes RECORDING once the recorder reports it is
/// recording) → STOPPING (host stop, consent withdrawn, meeting ended) → POST_PROCESSING (recording PROCESSING → VERIFYING) → DONE
/// (COMPLETED) or FAILED (with the reason). If the recorder PROCESS dies while the meeting is still live, a new recorder is launched
/// (a new part; the recorder itself already restarts its browser into new segments); the verified parts are joined at the end.
/// A recording is COMPLETED only after the MP4 is in the library, re-verified there (codecs, duration vs recorded wall time, full decode,
/// faststart, SHA-256) and the CHECK constraint on rec.MeetingRecordings accepts it.
/// </summary>
public sealed class RecorderWorker(IServiceScopeFactory scopes, Db db, IClock clock, IRecorderLauncher launcher, RecordingPaths paths,
    IOptions<RecordingOptions> options, IOptions<LiveKitOptions> liveKit, IOptions<MeetingOptions> meetingOptions, IOptions<PublicEndpointOptions> pub,
    IOptions<EmailOptions> emailOptions, ILogger<RecorderWorker> log) : BackgroundService
{
    readonly string instance = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid().ToString("N")[..8]}";
    readonly ConcurrentDictionary<long, Running> running = new();
    readonly SemaphoreSlim kick = new(0, 1);
    readonly SemaphoreSlim once = new(1, 1);
    RecordingOptions O => options.Value;

    public string Instance => instance;

    sealed class Running(long jobId, long recordingId, Guid recordingPublicId, long meetingId)
    {
        public long JobId => jobId;
        public long RecordingId => recordingId;
        public Guid RecordingPublicId => recordingPublicId;
        public long MeetingId => meetingId;
        public IRecorderRun? Run { get; set; }
        public DateTime LaunchedUtc { get; set; }
        public DateTime? StopRequestedUtc { get; set; }
        public bool Killed { get; set; }
        public Task? Processing { get; set; }
    }

    sealed record JobRow(long JobId, long RecordingId, string IdempotencyKey, string Engine, string State, int Attempt, string? SpoolPath);
    sealed record JobInfo(long JobId, long RecordingId, Guid RecordingPublicId, long MeetingId, string JobState, string RecordingStatus, int LaunchCount,
        int? RecorderPid, string MeetingStatus, string? PolicyCode, DateTime? StartedUtc, long OwnerEmployeeId);

    /// <summary>Wakes the worker (a recording was started or stopped).</summary>
    public void Kick()
    {
        try { kick.Release(); } catch (SemaphoreFullException) { }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!O.WorkerEnabled)
        {
            log.LogInformation("Recorder worker disabled (Recording:WorkerEnabled=false).");
            return;
        }
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Recorder worker run failed"); }
            try { await kick.WaitAsync(TimeSpan.FromSeconds(Math.Max(1, O.PollSeconds)), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Waits for post-processing started by earlier runs (tests).</summary>
    public async Task DrainAsync()
    {
        foreach (var r in running.Values.ToList())
            if (r.Processing is { } t) await t;
        foreach (var (k, r) in running.ToList())
            if (r.Processing is { IsCompleted: true }) running.TryRemove(k, out _);
    }

    public async Task RunOnceAsync(CancellationToken ct)
    {
        await once.WaitAsync(ct);
        try
        {
            using var c = await db.OpenAsync(ct);
            foreach (var (k, r) in running.ToList())
                if (r.Processing is { IsCompleted: true }) running.TryRemove(k, out _);
            if (!running.IsEmpty)
                await c.ExecuteAsync("""
                    UPDATE rec.RecordingJobs SET LeaseExpiresUtc = DATEADD(SECOND, @lease, SYSUTCDATETIME()), HeartbeatUtc = SYSUTCDATETIME()
                    WHERE JobId IN @ids AND LeaseOwner = @me
                    """, new { ids = running.Keys.ToArray(), me = instance, lease = O.LeaseSeconds });

            var claimed = (await c.QueryAsync<JobRow>("rec.usp_ClaimRecordingJobs", new { Owner = instance, Batch = 5, LeaseSeconds = O.LeaseSeconds },
                commandType: CommandType.StoredProcedure)).ToList();
            foreach (var job in claimed)
            {
                if (running.ContainsKey(job.JobId)) continue;
                try { await TakeOverAsync(c, job, ct); }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    log.LogError(e, "Recording job {Job} could not be started", job.JobId);
                    await FailAsync(c, job.RecordingId, job.JobId, $"The recorder could not be started: {e.Message}", ct);
                }
            }

            foreach (var r in running.Values.Where(r => r.Processing is null).ToList())
            {
                try { await SuperviseAsync(c, r, ct); }
                catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Supervising recording job {Job} failed", r.JobId); }
            }
        }
        finally
        {
            once.Release();
        }
    }

    async Task<JobInfo?> InfoAsync(IDbConnection c, long jobId) =>
        await c.QuerySingleOrDefaultAsync<JobInfo>("""
            SELECT j.JobId, j.RecordingId, r.PublicId AS RecordingPublicId, r.MeetingId, j.[State] AS JobState, r.[Status] AS RecordingStatus, j.LaunchCount,
                   j.RecorderPid, m.[Status] AS MeetingStatus, r.PolicyCode, r.StartedUtc, r.OwnerEmployeeId
            FROM rec.RecordingJobs j JOIN rec.MeetingRecordings r ON r.RecordingId = j.RecordingId JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId
            WHERE j.JobId = @jobId
            """, new { jobId });

    string JobDir(Guid recording, int launch) => Path.Combine(paths.SpoolRoot!, $"{recording:N}-{launch}");

    /// <summary>A job this instance just claimed: new, abandoned by a dead host, or queued for (re-)processing.</summary>
    async Task TakeOverAsync(IDbConnection c, JobRow job, CancellationToken ct)
    {
        var info = await InfoAsync(c, job.JobId);
        if (info is null) return;
        var r = new Running(info.JobId, info.RecordingId, info.RecordingPublicId, info.MeetingId);
        if (info.RecordingStatus is "COMPLETED" or "FAILED" or "PURGED" && info.JobState != "POST_PROCESSING")
        {
            await c.ExecuteAsync("UPDATE rec.RecordingJobs SET [State] = CASE WHEN @s = 'COMPLETED' THEN 'DONE' ELSE 'FAILED' END, LeaseOwner = NULL WHERE JobId = @j",
                new { s = info.RecordingStatus, j = info.JobId });
            return;
        }
        switch (info.JobState)
        {
            case "STARTING":
                if (info.MeetingStatus != "LIVE")
                {
                    await FailAsync(c, info.RecordingId, info.JobId, "The meeting ended before the recorder started.", ct);
                    return;
                }
                running[info.JobId] = r;
                await LaunchAsync(c, r, info, ct);
                break;
            case "ACTIVE" or "STOPPING":
                running[info.JobId] = r;
                // The previous host died. Re-attach to its recorder if that process still runs; otherwise continue in a new part.
                if (info.RecorderPid is { } pid && launcher.Adopt(pid, JobDir(info.RecordingPublicId, info.LaunchCount)) is { } adopted)
                {
                    r.Run = adopted;
                    r.LaunchedUtc = clock.UtcNow;
                    log.LogInformation("Recording job {Job}: re-attached to recorder pid {Pid}", info.JobId, pid);
                }
                else if (info.JobState == "ACTIVE" && info.MeetingStatus == "LIVE" && info.LaunchCount < O.MaxLaunches)
                    await LaunchAsync(c, r, info, ct);
                else
                    await BeginProcessingAsync(c, r, retry: false, ct);
                break;
            case "POST_PROCESSING":
                running[info.JobId] = r;
                await BeginProcessingAsync(c, r, retry: info.RecordingStatus == "PROCESSING", ct);
                break;
        }
    }

    async Task LaunchAsync(IDbConnection c, Running r, JobInfo info, CancellationToken ct)
    {
        var m = await RecordingService.MeetingAsync(c, info.MeetingId) ?? throw new InvalidOperationException("Meeting not found.");
        var mp = await RecordingPolicyStore.ForMeetingAsync(c, m.Category, m.MeetingRecordingPolicy) ?? throw new InvalidOperationException("No recording policy applies to this meeting.");
        if (paths.SpoolRoot is null) throw new InvalidOperationException("Recording:SpoolRoot is not configured.");
        bool consentOk;
        using (var scope = scopes.CreateScope())
        {
            var svc = scope.ServiceProvider.GetRequiredService<RecordingService>();
            var present = await svc.PresentAsync(c, m, ct);
            var rows = await RecordingService.ConsentRowsAsync(c, m.MeetingId, mp.Policy.NoticeVersion);
            var starter = await c.QuerySingleOrDefaultAsync<long?>("""
                SELECT TOP (1) p.ParticipantId FROM rec.MeetingRecordings r JOIN auth.Users u ON u.UserId = r.StartedByUserId
                JOIN mtg.MeetingParticipants p ON p.MeetingId = r.MeetingId AND p.EmployeeId = u.EmployeeId WHERE r.RecordingId = @id
                """, new { id = info.RecordingId });
            consentOk = RecordingService.CheckConsent(mp.Policy, rows, present, starter).Ok;
        }
        var launchNo = info.LaunchCount + 1;
        var jobKey = $"{info.RecordingPublicId:N}-{launchNo}";
        var dir = JobDir(info.RecordingPublicId, launchNo);
        var late = DateTime.SpecifyKind(m.EndUtc, DateTimeKind.Utc).AddMinutes(meetingOptions.Value.JoinLateMinutes) - clock.UtcNow;
        var maxMinutes = (int)Math.Clamp(Math.Ceiling(late.TotalMinutes), 1, O.MaxDurationMinutes);
        var launch = new RecorderLaunch("record", jobKey, dir, m.LiveKitRoomName, m.Title, mp.Kind == MeetingRecordingKind.Customer ? "customer" : "internal",
            consentOk, maxMinutes, RecorderEnvironment(mp));
        await c.ExecuteAsync("UPDATE rec.RecordingJobs SET LaunchCount = @launchNo, EngineJobId = @jobKey, SpoolPath = @dir, ModifiedUtc = SYSUTCDATETIME() WHERE JobId = @j",
            new { launchNo, jobKey, dir, j = info.JobId });
        var run = launcher.Start(launch);
        r.Run = run;
        r.LaunchedUtc = clock.UtcNow;
        r.StopRequestedUtc = null;
        r.Killed = false;
        await c.ExecuteAsync("""
            UPDATE rec.RecordingJobs SET [State] = CASE WHEN [State] = 'STARTING' THEN 'ACTIVE' ELSE [State] END, RecorderPid = @pid, LastError = NULL, ModifiedUtc = SYSUTCDATETIME()
            WHERE JobId = @j
            """, new { pid = run.ProcessId, j = info.JobId });
        await Audit.WriteAsync(c, "SYSTEM", null, launchNo == 1 ? "RECORDER_LAUNCHED" : "RECORDER_RELAUNCHED", "Recording", info.RecordingPublicId.ToString(),
            launchNo == 1 ? "R2 recorder launched" : $"R2 recorder relaunched (part {launchNo}) after the previous recorder process ended", null,
            newValues: new { jobKey, consent = consentOk, maxMinutes, pid = run.ProcessId });
    }

    /// <summary>
    /// Everything the recorder needs, passed as its process environment: LiveKit (incl. the API secret — never on the command line),
    /// tool paths, and the meeting's CURRENT recording policy, which the recorder evaluates again with the shared policy gate before it
    /// joins the room (defence in depth).
    /// </summary>
    Dictionary<string, string> RecorderEnvironment(MeetingPolicy mp)
    {
        var lk = liveKit.Value;
        var gate = mp.Policy.ToGate(mp.Kind);
        var env = new Dictionary<string, string>
        {
            ["OIC_ENVIRONMENT"] = "ApiManaged", // no appsettings.{env}.json overlay: everything below is authoritative
            ["LIVEKIT_URL"] = string.IsNullOrWhiteSpace(O.LiveKitUrl) ? lk.PublicUrl : O.LiveKitUrl,
            ["LIVEKIT_API_KEY"] = lk.ApiKey,
            ["LIVEKIT_API_SECRET"] = lk.ApiSecret,
            ["OIC_Recorder__Environment"] = O.DeploymentEnvironment.ToString(),
            ["OIC_Recorder__Storage__SpoolRoot"] = paths.SpoolRoot!,
            ["OIC_Recorder__Storage__OutputRoot"] = paths.RecorderOutputRoot!,
            ["OIC_Recorder__Storage__KeepSpoolAfterSuccess"] = "true", // the API removes the spool after the library copy is verified
            ["OIC_Recorder__Ffmpeg__FfmpegPath"] = paths.Ffmpeg,
            ["OIC_Recorder__Ffmpeg__FfprobePath"] = paths.Ffprobe,
            ["OIC_Recorder__Layout__Width"] = O.Width.ToString(CultureInfo.InvariantCulture),
            ["OIC_Recorder__Layout__Height"] = O.Height.ToString(CultureInfo.InvariantCulture),
            ["OIC_RecordingPolicy__ApprovalStatus"] = gate.ApprovalStatus.ToString(),
            ["OIC_RecordingPolicy__ApprovalReference"] = gate.ApprovalReference ?? "",
            ["OIC_RecordingPolicy__ApprovedBy"] = gate.ApprovedBy ?? "",
            ["OIC_RecordingPolicy__CustomerRecordingEnabled"] = gate.CustomerRecordingEnabled ? "true" : "false",
            ["OIC_RecordingPolicy__InternalRecordingEnabled"] = gate.InternalRecordingEnabled ? "true" : "false",
            ["OIC_RecordingPolicy__CustomerMeetingRecording"] = gate.CustomerMeetingRecording.ToString(),
            ["OIC_RecordingPolicy__InternalMeetingRecording"] = gate.InternalMeetingRecording.ToString(),
            ["OIC_RecordingPolicy__ConsentNoticeVersion"] = gate.ConsentNoticeVersion,
            ["OIC_RecordingPolicy__ConsentNoticeText"] = gate.ConsentNoticeText,
            ["OIC_RecordingPolicy__ConsentRequiredFromAllParticipants"] = gate.ConsentRequiredFromAllParticipants ? "true" : "false",
            ["OIC_RecordingPolicy__StopRecordingOnConsentWithdrawal"] = gate.StopRecordingOnConsentWithdrawal ? "true" : "false",
            ["OIC_RecordingPolicy__ActionOnRetentionExpiry"] = gate.ActionOnRetentionExpiry.ToString(),
            ["OIC_RecordingPolicy__ArchiveLocation"] = gate.ArchiveLocation ?? "",
            ["OIC_RecordingPolicy__SignedUrlTtlSeconds"] = gate.SignedUrlTtlSeconds.ToString(CultureInfo.InvariantCulture),
        };
        if (gate.RetentionDays is { } days) env["OIC_RecordingPolicy__RetentionDays"] = days.ToString(CultureInfo.InvariantCulture);
        if (gate.ApprovedOnUtc is { } on) env["OIC_RecordingPolicy__ApprovedOnUtc"] = on.ToString("O", CultureInfo.InvariantCulture);
        if (paths.LayoutDist is { } layout) env["OIC_Recorder__Layout__DistPath"] = layout;
        if (!string.IsNullOrWhiteSpace(O.EdgePath) && paths.EdgeExe is { } edge) env["OIC_Recorder__Browser__ExecutablePath"] = edge;
        return env;
    }

    async Task SuperviseAsync(IDbConnection c, Running r, CancellationToken ct)
    {
        var info = await InfoAsync(c, r.JobId);
        if (info is null || r.Run is null)
        {
            running.TryRemove(r.JobId, out _);
            return;
        }
        var now = clock.UtcNow;
        var run = r.Run;
        if (run.Started && info.RecordingStatus == "PENDING")
        {
            await c.ExecuteAsync("""
                UPDATE rec.MeetingRecordings SET [Status] = 'RECORDING', StartedUtc = COALESCE(StartedUtc, @now), ModifiedUtc = SYSUTCDATETIME() WHERE RecordingId = @id AND [Status] = 'PENDING'
                """, new { now, id = r.RecordingId });
            await BroadcastAsync(c, r.MeetingId, ct);
        }
        var stopWanted = info.JobState == "STOPPING" || info.MeetingStatus != "LIVE" || (!run.Started && now - r.LaunchedUtc > TimeSpan.FromSeconds(O.StartTimeoutSeconds));
        if (stopWanted && r.StopRequestedUtc is null && !run.HasExited)
        {
            r.StopRequestedUtc = now;
            run.RequestStop();
            if (info.JobState == "ACTIVE")
                await c.ExecuteAsync("UPDATE rec.RecordingJobs SET [State] = 'STOPPING', ModifiedUtc = SYSUTCDATETIME() WHERE JobId = @j AND [State] = 'ACTIVE'", new { j = r.JobId });
            if (!run.Started) await c.ExecuteAsync("UPDATE rec.RecordingJobs SET LastError = N'The recorder did not start recording in time.' WHERE JobId = @j", new { j = r.JobId });
        }
        if (r.StopRequestedUtc is { } asked && !run.HasExited && !r.Killed && now - asked > TimeSpan.FromSeconds(O.StopTimeoutSeconds))
        {
            log.LogWarning("Recorder for job {Job} did not stop within {Seconds}s: terminating it", r.JobId, O.StopTimeoutSeconds);
            r.Killed = true;
            run.Kill();
        }
        if (!run.HasExited) return;

        // The recorder process ended. If it died on its own while the meeting is still live, continue in a new part.
        var result = ReadResult(JobDir(info.RecordingPublicId, info.LaunchCount));
        var crashed = result is null && r.StopRequestedUtc is null;
        if (crashed && info.JobState == "ACTIVE" && info.MeetingStatus == "LIVE" && info.LaunchCount < O.MaxLaunches)
        {
            log.LogWarning("Recorder process for job {Job} ended unexpectedly: relaunching (part {Part})", r.JobId, info.LaunchCount + 1);
            run.Dispose();
            await LaunchAsync(c, r, info, ct);
            return;
        }
        await BeginProcessingAsync(c, r, retry: false, ct);
    }

    async Task BeginProcessingAsync(IDbConnection c, Running r, bool retry, CancellationToken ct)
    {
        await c.ExecuteAsync("""
            UPDATE rec.RecordingJobs SET [State] = 'POST_PROCESSING', ModifiedUtc = SYSUTCDATETIME() WHERE JobId = @j;
            UPDATE rec.MeetingRecordings SET [Status] = 'PROCESSING', EndedUtc = COALESCE(EndedUtc, SYSUTCDATETIME()), ModifiedUtc = SYSUTCDATETIME()
            WHERE RecordingId = @id AND [Status] IN ('PENDING', 'RECORDING', 'PROCESSING', 'VERIFYING');
            """, new { j = r.JobId, id = r.RecordingId });
        await BroadcastAsync(c, r.MeetingId, ct);
        r.Run?.Dispose();
        r.Processing = Task.Run(() => PostProcessAsync(r, retry, CancellationToken.None), CancellationToken.None);
    }

    static JsonElement? ReadResult(string jobDir)
    {
        var f = Path.Combine(jobDir, "result.json");
        if (!File.Exists(f)) return null;
        try { return JsonDocument.Parse(File.ReadAllText(f)).RootElement.Clone(); }
        catch (Exception e) when (e is JsonException or IOException) { return null; }
    }

    static string? Str(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    sealed record Part(int Launch, string File, double ExpectedSeconds, int Restarts);

    /// <summary>Collects the verified part(s), joins them, copies the result into the library, verifies it there, and only then marks it COMPLETED.</summary>
    async Task PostProcessAsync(Running r, bool retry, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        try
        {
            var info = await InfoAsync(c, r.JobId) ?? throw new InvalidOperationException("Job disappeared.");
            var parts = new List<Part>();
            var problems = new List<string>();
            for (var i = 1; i <= Math.Max(1, info.LaunchCount); i++)
            {
                var dir = JobDir(info.RecordingPublicId, i);
                var result = ReadResult(dir);
                var hasSegments = Directory.Exists(dir) && Directory.GetFiles(dir, "segment-*.webm").Any(f => new FileInfo(f).Length > 0);
                // No result (recorder killed), or an administrator's retry after a failed build/verification, with media on disk:
                // rebuild from the WebM segments with "recorder finalize" (safe: FFmpeg only, joins no room).
                if (hasSegments && (result is null || retry))
                {
                    result = await FinalizeAsync(info, i, dir, ct) ?? result;
                }
                if (result is null)
                {
                    if (Directory.Exists(dir) || i == 1) problems.Add($"Part {i}: the recorder produced no result{(hasSegments ? "" : " and no media")}.");
                    continue;
                }
                var status = Str(result.Value, "status");
                var file = Str(result.Value, "file");
                if (status == "COMPLETED" && file is not null && File.Exists(file))
                {
                    var expected = result.Value.TryGetProperty("verification", out var v) && v.TryGetProperty("ExpectedSeconds", out var es) ? es.GetDouble() : 0;
                    var restarts = result.Value.TryGetProperty("Restarts", out var rs) && rs.ValueKind == JsonValueKind.Number ? rs.GetInt32() : 0;
                    parts.Add(new Part(i, file, expected, restarts));
                }
                else if (status == "REFUSED")
                    problems.Add($"Part {i}: refused by the recording policy ({Str(result.Value, "Code")}: {Str(result.Value, "Message")}).");
                else
                {
                    var reasons = result.Value.TryGetProperty("verification", out var vf) && vf.TryGetProperty("Failures", out var fl) && fl.ValueKind == JsonValueKind.Array
                        ? string.Join(" ", fl.EnumerateArray().Select(x => x.GetString())) : Str(result.Value, "reason") ?? "unknown error";
                    problems.Add($"Part {i}: {status ?? "no status"} — {reasons}");
                }
            }
            if (parts.Count == 0)
            {
                await FailAsync(c, r.RecordingId, r.JobId, problems.Count > 0 ? string.Join(" ", problems) : "The recorder produced no recording.", ct);
                return;
            }

            var verifier = new MediaVerifier(paths.Ffmpeg, paths.Ffprobe);
            var source = parts[0].File;
            var expectedSeconds = parts.Sum(p => p.ExpectedSeconds);
            string? merged = null;
            if (parts.Count > 1)
            {
                merged = Path.Combine(paths.SpoolRoot!, "_merge", $"{info.RecordingPublicId:N}.mp4");
                Directory.CreateDirectory(Path.GetDirectoryName(merged)!);
                var ff = await verifier.ConcatAsync(parts.Select(p => p.File).ToList(), merged, ct);
                if (ff.ExitCode != 0)
                {
                    await FailAsync(c, r.RecordingId, r.JobId, $"Joining the {parts.Count} recorded parts failed: {ff.StdErrTail}", ct);
                    return;
                }
                source = merged;
            }

            await c.ExecuteAsync("UPDATE rec.MeetingRecordings SET [Status] = 'VERIFYING', ModifiedUtc = SYSUTCDATETIME() WHERE RecordingId = @id", new { id = r.RecordingId });
            var root = paths.StorageRoot ?? throw new InvalidOperationException("Recording:StorageRoot is not configured.");
            var now = clock.UtcNow;
            // Opaque key: no meeting, customer or employee data in folder or file names.
            var key = $"{now:yyyy}/{now:MM}/{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16))}.mp4";
            var dest = RecordingPaths.Resolve(root, key);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            var partial = dest + ".partial";
            File.Copy(source, partial, overwrite: true);
            var verification = await verifier.VerifyAsync(partial, new MediaExpectations(O.Width, O.Height, expectedSeconds, O.DurationTolerancePercent, O.DurationToleranceMinSeconds), ct);
            if (!verification.Passed)
            {
                TryDelete(partial);
                await FailAsync(c, r.RecordingId, r.JobId, "Verification failed: " + string.Join(" ", verification.Failures), ct, verification);
                return;
            }
            File.Move(partial, dest);
            var sha = await MediaVerifier.Sha256HexAsync(dest, ct);
            if (sha != verification.Sha256)
            {
                TryDelete(dest);
                await FailAsync(c, r.RecordingId, r.JobId, "The file changed while it was moved into the library (SHA-256 mismatch).", ct, verification);
                return;
            }

            var policy = info.PolicyCode is null ? null : await RecordingPolicyStore.GetAsync(c, info.PolicyCode);
            var details = JsonSerializer.Serialize(new
            {
                verifiedBy = "api", verifiedUtc = now, verification.DurationSeconds, verification.ExpectedSeconds, verification.SizeBytes, verification.Sha256,
                verification.VideoCodec, verification.AudioCodec, verification.Width, verification.Height, fps = Math.Round(verification.Fps, 2), verification.FastStart,
                verification.DecodeErrors, checks = new[] { "codecs h264/aac", "resolution", "duration vs recorded wall time", "full decode", "faststart (moov before mdat)", "sha256 after move" },
                parts = parts.Select(p => new { part = p.Launch, recorderVerified = true, p.ExpectedSeconds, browserRestarts = p.Restarts }),
                joinedParts = parts.Count > 1,
                recorder = "R2 proof of concept",
            });
            var n = await c.ExecuteAsync("""
                UPDATE rec.MeetingRecordings SET [Status] = 'COMPLETED', DurationSeconds = @duration, FileSizeBytes = @size, StorageKey = @key, Sha256 = @sha, Container = 'mp4',
                    VideoCodec = @vc, AudioCodec = @ac, Width = @w, Height = @h, VerifiedUtc = @now, VerificationDetails = @details, FailureReason = NULL,
                    StorageTier = 'PRIMARY', EndedUtc = COALESCE(EndedUtc, @now),
                    RetainUntilUtc = CASE WHEN @days IS NULL THEN NULL ELSE DATEADD(DAY, @days, COALESCE(EndedUtc, @now)) END, ModifiedUtc = SYSUTCDATETIME()
                WHERE RecordingId = @id AND [Status] = 'VERIFYING';
                UPDATE rec.RecordingJobs SET [State] = 'DONE', LeaseOwner = NULL, LeaseExpiresUtc = NULL, ModifiedUtc = SYSUTCDATETIME() WHERE JobId = @j;
                """, new
            {
                duration = (int)Math.Round(verification.DurationSeconds), size = verification.SizeBytes, key, sha = Convert.FromHexString(verification.Sha256),
                vc = verification.VideoCodec, ac = verification.AudioCodec, w = verification.Width, h = verification.Height, now, details, days = policy?.RetentionDays,
                id = r.RecordingId, j = r.JobId,
            });
            if (n == 0) { TryDelete(dest); return; }
            await Audit.WriteAsync(c, "SYSTEM", null, "RECORDING_COMPLETED", "Recording", info.RecordingPublicId.ToString(),
                $"Recording verified and stored ({verification.DurationSeconds:F0}s, {verification.SizeBytes / 1024 / 1024.0:F1} MB)", null,
                newValues: new { sha256 = verification.Sha256, parts = parts.Count });
            await NotifyOwnerAsync(c, r.RecordingId, available: true, null);
            await BroadcastAsync(c, r.MeetingId, ct);
            if (!O.KeepSpoolAfterSuccess)
            {
                for (var i = 1; i <= info.LaunchCount; i++) TryDeleteDir(JobDir(info.RecordingPublicId, i));
                foreach (var p in parts) TryDelete(p.File);
                if (merged is not null) TryDelete(merged);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or JsonException)
        {
            log.LogError(e, "Post-processing of recording job {Job} failed", r.JobId);
            await FailAsync(c, r.RecordingId, r.JobId, $"Post-processing failed: {e.Message}", ct);
        }
    }

    /// <summary>Runs "recorder finalize" for one part and waits for it (it joins no room; FFmpeg only).</summary>
    async Task<JsonElement?> FinalizeAsync(JobInfo info, int part, string dir, CancellationToken ct)
    {
        var jobKey = $"{info.RecordingPublicId:N}-{part}";
        using var run = launcher.Start(new RecorderLaunch("finalize", jobKey, dir, null, null, null, true, 1, new Dictionary<string, string>
        {
            ["OIC_ENVIRONMENT"] = "ApiManaged",
            ["OIC_Recorder__Storage__SpoolRoot"] = paths.SpoolRoot!,
            ["OIC_Recorder__Storage__OutputRoot"] = paths.RecorderOutputRoot!,
            ["OIC_Recorder__Ffmpeg__FfmpegPath"] = paths.Ffmpeg,
            ["OIC_Recorder__Ffmpeg__FfprobePath"] = paths.Ffprobe,
            ["OIC_Recorder__Layout__Width"] = O.Width.ToString(CultureInfo.InvariantCulture),
            ["OIC_Recorder__Layout__Height"] = O.Height.ToString(CultureInfo.InvariantCulture),
        }));
        var until = DateTime.UtcNow.AddMinutes(Math.Max(10, O.MaxDurationMinutes / 2));
        while (!run.HasExited && DateTime.UtcNow < until) await Task.Delay(500, ct);
        if (!run.HasExited) run.Kill();
        return ReadResult(dir);
    }

    async Task FailAsync(IDbConnection c, long recordingId, long jobId, string reason, CancellationToken ct, VerificationResult? verification = null)
    {
        reason = reason.Length > 1000 ? reason[..997] + "…" : reason;
        var n = await c.ExecuteAsync("""
            UPDATE rec.MeetingRecordings SET [Status] = 'FAILED', FailureReason = @reason, EndedUtc = COALESCE(EndedUtc, SYSUTCDATETIME()),
                VerificationDetails = COALESCE(@details, VerificationDetails), ModifiedUtc = SYSUTCDATETIME()
            WHERE RecordingId = @recordingId AND [Status] NOT IN ('COMPLETED', 'PURGED', 'FAILED');
            UPDATE rec.RecordingJobs SET [State] = 'FAILED', LastError = LEFT(@reason, 2000), LeaseOwner = NULL, LeaseExpiresUtc = NULL, ModifiedUtc = SYSUTCDATETIME() WHERE JobId = @jobId;
            """, new { reason, recordingId, jobId, details = verification is null ? null : JsonSerializer.Serialize(new { verifiedBy = "api", passed = false, verification }) });
        if (n == 0) return;
        var row = await c.QuerySingleAsync<(Guid PublicId, long MeetingId)>("SELECT PublicId, MeetingId FROM rec.MeetingRecordings WHERE RecordingId = @recordingId", new { recordingId });
        await Audit.WriteAsync(c, "SYSTEM", null, "RECORDING_FAILED", "Recording", row.PublicId.ToString(), reason.Length > 480 ? reason[..480] : reason, null);
        await NotifyOwnerAsync(c, recordingId, available: false, reason);
        await BroadcastAsync(c, row.MeetingId, ct);
    }

    /// <summary>RECORDING_AVAILABLE / RECORDING_FAILED in-app notification and e-mail (outbox) to the recording's owner (the meeting creator).</summary>
    async Task NotifyOwnerAsync(IDbConnection c, long recordingId, bool available, string? reason)
    {
        var o = await c.QuerySingleOrDefaultAsync<(Guid PublicId, long MeetingId, string Name, string? Email, long? UserId)?>("""
            SELECT r.PublicId, r.MeetingId, e.DisplayName AS Name, e.OfficialEmail AS Email, u.UserId
            FROM rec.MeetingRecordings r JOIN org.Employees e ON e.EmployeeId = r.OwnerEmployeeId
            LEFT JOIN auth.Users u ON u.EmployeeId = e.EmployeeId AND u.IsActive = 1
            WHERE r.RecordingId = @recordingId
            """, new { recordingId });
        if (o is null) return;
        var m = await MeetingMessaging.LoadAsync(c, null, o.Value.MeetingId);
        var title = available ? $"Recording ready: {m.Title}" : $"Recording failed: {m.Title}";
        var body = available
            ? "The recording was verified (codecs, duration, full decode, checksum) and is in the Recording Library."
            : $"The recording could not be completed. {reason}";
        var link = $"/recordings/{o.Value.PublicId}";
        if (o.Value.UserId is { } userId)
            await c.ExecuteAsync("""
                INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@userId, @m, @type, @title, @body, @link)
                """, new { userId, m = o.Value.MeetingId, type = available ? "RECORDING_AVAILABLE" : "RECORDING_FAILED", title = title.Length > 200 ? title[..199] + "…" : title,
                body = body.Length > 1000 ? body[..999] + "…" : body, link });
        if (o.Value.Email is { Length: > 0 } email)
            await c.ExecuteAsync("""
                INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml, RelatedMeetingId) VALUES (@template, @to, @subject, @html, @m)
                """, new
            {
                template = available ? "RECORDING_AVAILABLE" : "RECORDING_FAILED", to = email, subject = title.Length > 300 ? title[..300] : title, m = o.Value.MeetingId,
                html = EmailTemplates.Meeting(EmailBrand.From(emailOptions.Value), available ? "Recording available" : "Recording failed", m, o.Value.Name, body,
                    $"{pub.Value.WebBaseUrl.TrimEnd('/')}{link}", available ? "Open the recording" : "View details",
                    "Recordings are available only to authorised users after signing in. Do not forward this e-mail."),
            });
    }

    async Task BroadcastAsync(IDbConnection c, long meetingId, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        await RecordingService.BroadcastAsync(c, scope.ServiceProvider.GetRequiredService<LiveKitRoomService>(), meetingId, ct);
    }

    static void TryDelete(string f)
    {
        try { if (File.Exists(f)) File.Delete(f); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    static void TryDeleteDir(string d)
    {
        try { if (Directory.Exists(d)) Directory.Delete(d, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
