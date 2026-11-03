using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Recording;

internal sealed record RecMeeting(long MeetingId, Guid PublicId, string MeetingCode, string Title, string Category, string Status, long CreatedByEmployeeId,
    long? CustomerId, string LiveKitRoomName, string MeetingRecordingPolicy, DateTime EndUtc, bool WaitingRoomEnabled);

internal sealed record RecParticipant(long ParticipantId, string Identity, string Role, string Type, string Name);

internal sealed record ActiveRecording(long RecordingId, Guid PublicId, string Status, DateTime? StartedUtc, DateTime CreatedUtc, string? PolicyCode);

internal sealed record ConsentRow(long ParticipantId, string Identity, string Role, string Type, string Name, string? Decision);

/// <summary>Outcome of a start attempt: either a recording id or a refusal (HTTP status, problem code, message).</summary>
internal sealed record StartResult(Guid? RecordingId, int Status, string Code, string Message)
{
    public static StartResult Ok(Guid id) => new(id, 200, "STARTED", "Recording started.");
    public static StartResult No(int status, string code, string message) => new(null, status, code, message);
}

/// <summary>
/// Recording control inside a meeting: the meeting's policy, consent/notification capture (mtg.MeetingConsent, append-only, with
/// IP, user agent and an evidence hash), start/stop, automatic start for mandatory recording, and the live REC state pushed to every
/// participant over LiveKit (room metadata for late joiners + a data message on topic "oic.recording").
/// </summary>
public sealed class RecordingService(Db db, IClock clock, LiveKitRoomService rooms, RecorderHealth health, RecorderWorker worker,
    IOptions<RecordingOptions> options, IOptions<LiveKitOptions> liveKit, ILogger<RecordingService> log)
{
    public const string Topic = "oic.recording";
    internal Db Db => db;
    RecordingOptions O => options.Value;

    internal const string MeetingColumns = """
        m.MeetingId, m.PublicId, m.MeetingCode, m.Title, m.Category, m.[Status], m.CreatedByEmployeeId, m.CustomerId, m.LiveKitRoomName,
        m.RecordingPolicy AS MeetingRecordingPolicy, m.ScheduledEndUtc AS EndUtc, m.WaitingRoomEnabled
        """;

    internal static Task<RecMeeting?> MeetingAsync(IDbConnection c, long meetingId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<RecMeeting>($"SELECT {MeetingColumns} FROM mtg.Meetings m WHERE m.MeetingId = @meetingId", new { meetingId }, tx);

    internal static Task<ActiveRecording?> ActiveAsync(IDbConnection c, long meetingId, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<ActiveRecording>("""
            SELECT RecordingId, PublicId, [Status], StartedUtc, CreatedUtc, PolicyCode FROM rec.MeetingRecordings
            WHERE MeetingId = @meetingId AND [Status] IN ('PENDING', 'RECORDING')
            """, new { meetingId }, tx);

    /// <summary>Every participant of the meeting with their latest consent decision for the CURRENT notice version.</summary>
    internal static async Task<List<ConsentRow>> ConsentRowsAsync(IDbConnection c, long meetingId, string noticeVersion, IDbTransaction? tx = null) =>
        (await c.QueryAsync<ConsentRow>("""
            SELECT p.ParticipantId, p.LiveKitIdentity AS [Identity], p.[Role], p.ParticipantType AS Type, COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name,
                   (SELECT TOP (1) x.Decision FROM mtg.MeetingConsent x WHERE x.MeetingId = p.MeetingId AND x.ParticipantId = p.ParticipantId
                      AND x.ConsentType = 'RECORDING' AND x.NoticeVersion = @noticeVersion ORDER BY x.DecisionUtc DESC, x.ConsentId DESC) AS Decision
            FROM mtg.MeetingParticipants p
            LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE p.MeetingId = @meetingId
            """, new { meetingId, noticeVersion }, tx)).ToList();

    /// <summary>Identities in the LiveKit room right now (the hidden recorder is not a meeting participant and is ignored by callers).
    /// If LiveKit cannot be asked, open attendance rows (webhooks) stand in.</summary>
    internal async Task<HashSet<string>> PresentAsync(IDbConnection c, RecMeeting m, CancellationToken ct)
    {
        try
        {
            return (await rooms.ListParticipantIdentitiesAsync(m.LiveKitRoomName, ct)).ToHashSet(StringComparer.Ordinal);
        }
        catch (LiveKitUnavailableException)
        {
            return (await c.QueryAsync<string>("""
                SELECT DISTINCT p.LiveKitIdentity FROM mtg.MeetingAttendance a JOIN mtg.MeetingParticipants p ON p.ParticipantId = a.ParticipantId
                WHERE a.MeetingId = @m AND a.LeftUtc IS NULL
                """, new { m = m.MeetingId })).ToHashSet(StringComparer.Ordinal);
        }
    }

    internal sealed record ConsentCheck(bool Ok, List<ConsentRow> Required, List<ConsentRow> Pending, List<ConsentRow> Declined);

    /// <summary>
    /// Consent conditions for starting: notification-only policies need none; "consent from all participants" needs a GRANTED decision
    /// (current notice version) from everyone in the room plus the person starting; otherwise the person starting (or, for an automatic
    /// start, the hosts in the room) must have granted it.
    /// </summary>
    internal static ConsentCheck CheckConsent(PolicyRow p, List<ConsentRow> rows, HashSet<string> present, long? starterParticipantId)
    {
        var inRoom = rows.Where(r => present.Contains(r.Identity) || r.ParticipantId == starterParticipantId).ToList();
        List<ConsentRow> required = p.ConsentMode != "CONSENT_REQUIRED" ? []
            : p.ConsentFromAll ? inRoom
            : starterParticipantId is { } s ? inRoom.Where(r => r.ParticipantId == s).ToList()
            : inRoom.Where(r => r.Role is "HOST" or "COHOST").ToList();
        var pending = required.Where(r => r.Decision is null).ToList();
        var declined = required.Where(r => r.Decision is "DENIED" or "WITHDRAWN").ToList();
        var ok = p.ConsentMode != "CONSENT_REQUIRED" || (required.Count > 0 && pending.Count == 0 && declined.Count == 0);
        return new ConsentCheck(ok, required, pending, declined);
    }

    // ---- State ------------------------------------------------------------------------------------------------------

    internal async Task<object> StateAsync(IDbConnection c, RecMeeting m, RecParticipant? me, bool isHost, CancellationToken ct)
    {
        var mp = await RecordingPolicyStore.ForMeetingAsync(c, m.Category, m.MeetingRecordingPolicy);
        var active = await ActiveAsync(c, m.MeetingId);
        var last = active is null ? await c.QuerySingleOrDefaultAsync<(Guid PublicId, string Status, string? FailureReason, string? StopReason)?>("""
            SELECT TOP (1) PublicId, [Status], FailureReason, StopReason FROM rec.MeetingRecordings WHERE MeetingId = @m ORDER BY RecordingId DESC
            """, new { m = m.MeetingId }) : null;
        if (mp is null)
            return new { available = false, unavailableReason = "No recording policy is mapped to this meeting category.", policy = (object?)null, recording = (object?)null };
        var p = mp.Policy;
        var rows = await ConsentRowsAsync(c, m.MeetingId, p.NoticeVersion);
        var mine = me is null ? null : rows.FirstOrDefault(r => r.ParticipantId == me.ParticipantId)?.Decision;
        var refusal = await RefusalAsync(c, m, mp);
        object? consent = null;
        if (isHost)
        {
            var present = await PresentAsync(c, m, ct);
            var check = CheckConsent(p, rows, present, me?.ParticipantId);
            consent = new
            {
                ok = check.Ok, required = check.Required.Count,
                granted = check.Required.Count(r => r.Decision == "GRANTED"),
                pending = check.Pending.Select(r => r.Name), declined = check.Declined.Select(r => r.Name),
            };
        }
        return new
        {
            available = refusal is null,
            unavailableReason = refusal?.Message,
            unavailableCode = refusal?.Code,
            policy = new
            {
                code = p.PolicyCode, title = p.Title, name = p.PolicyName, version = p.PolicyVersion, confirmed = p.IsConfirmed,
                requirement = mp.EffectiveRequirement, consentMode = p.ConsentMode, noticeText = p.NoticeText, noticeVersion = p.NoticeVersion,
                consentFromAll = p.ConsentFromAll, stopOnWithdrawal = p.StopOnWithdrawal,
            },
            recording = active is null ? null : new { id = active.PublicId, status = active.Status, startedUtc = active.StartedUtc, createdUtc = active.CreatedUtc },
            lastRecording = last is null ? null : new { id = last.Value.PublicId, status = last.Value.Status, reason = last.Value.FailureReason ?? last.Value.StopReason },
            myConsent = mine,
            isHost,
            canStart = isHost && active is null && refusal is null && m.Status == "LIVE",
            canStop = isHost && active is not null && mp.EffectiveRequirement != "MANDATORY",
            consent,
        };
    }

    /// <summary>Why recording cannot be used in this meeting at all (policy disabled, unconfirmed policy in Pilot/Production, recorder missing).</summary>
    internal async Task<StartResult?> RefusalAsync(IDbConnection c, RecMeeting m, MeetingPolicy mp)
    {
        await Task.CompletedTask;
        if (mp.EffectiveRequirement == "DISABLED")
            return StartResult.No(409, "RECORDING_DISABLED", $"Recording is switched off by the \"{mp.Policy.Title}\" recording policy.");
        if (O.IsRestrictedEnvironment && !mp.Policy.IsConfirmed)
            return StartResult.No(409, "POLICY_NOT_CONFIRMED", $"The \"{mp.Policy.Title}\" recording policy has not been confirmed yet. Recording stays off in {O.DeploymentEnvironment} until it is.");
        if (!liveKit.Value.IsConfigured) return StartResult.No(503, "SERVICE_UNAVAILABLE", "The video service is not configured.");
        if (RecorderHealth.Problem(health.Quick()) is { } problem)
            return StartResult.No(503, "SERVICE_UNAVAILABLE", $"The recorder is not available on this server ({problem}). Please contact IT support.");
        return null;
    }

    // ---- Consent --------------------------------------------------------------------------------------------------------

    /// <summary>Appends a decision to mtg.MeetingConsent. The evidence hash covers who, what, which wording (its SHA-256), when, IP and user agent.</summary>
    internal async Task RecordConsentAsync(IDbConnection c, IDbTransaction? tx, RecMeeting m, RecParticipant p, PolicyRow policy, string decision, ClientInfo client, string actorType, long? userId)
    {
        var at = clock.UtcNow;
        var evidence = JsonSerializer.Serialize(new
        {
            meeting = m.PublicId, participant = p.Identity, type = p.Type, decision, noticeVersion = policy.NoticeVersion,
            noticeSha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(policy.NoticeText))), policy = policy.PolicyCode,
            utc = at.ToString("O"), ip = client.Ip, userAgent = client.UserAgent,
        });
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(evidence));
        await c.ExecuteAsync("""
            INSERT mtg.MeetingConsent (MeetingId, ParticipantId, ConsentType, NoticeVersion, Decision, DecisionUtc, IpAddress, UserAgent, EvidenceHash)
            VALUES (@m, @p, 'RECORDING', @version, @decision, @at, @ip, @ua, @hash)
            """, new { m = m.MeetingId, p = p.ParticipantId, version = policy.NoticeVersion, decision, at, ip = client.Ip, ua = client.UserAgent, hash }, tx);
        await Audit.WriteAsync(c, actorType, userId, "RECORDING_CONSENT_" + decision, "Meeting", m.PublicId.ToString(),
            $"Recording {(policy.ConsentMode == "CONSENT_REQUIRED" ? "consent" : "notice acknowledgement")}: {decision.ToLowerInvariant()} ({p.Type.ToLowerInvariant()})", client.Ip, tx,
            newValues: new { participantId = p.Identity, decision, noticeVersion = policy.NoticeVersion, evidenceSha256 = Convert.ToHexStringLower(hash) });
    }

    /// <summary>A participant's decision; withdrawal/denial stops a running recording when the policy says so; a grant may auto-start a mandatory recording.</summary>
    internal async Task<IResult?> ConsentAsync(IDbConnection c, RecMeeting m, RecParticipant p, string? decisionInput, string? noticeVersion, HttpContext ctx, string actorType, long? userId, CancellationToken ct)
    {
        var decision = decisionInput?.Trim().ToUpperInvariant();
        if (decision is not ("GRANTED" or "DENIED" or "WITHDRAWN"))
        {
            var v = new Validator();
            v.Add("decision", "Decision must be GRANTED, DENIED or WITHDRAWN.");
            return v.Problem();
        }
        var mp = await RecordingPolicyStore.ForMeetingAsync(c, m.Category, m.MeetingRecordingPolicy);
        if (mp is null) return Problems.Create(409, "RECORDING_DISABLED", "No recording policy applies to this meeting.");
        if (!string.Equals(noticeVersion, mp.Policy.NoticeVersion, StringComparison.Ordinal))
            return Problems.Create(409, "NOTICE_CHANGED", "The recording notice has changed. Please read the current notice and answer again.",
                new Dictionary<string, object?> { ["noticeVersion"] = mp.Policy.NoticeVersion });
        if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("This meeting is not in progress.");
        await RecordConsentAsync(c, null, m, p, mp.Policy, decision, ClientInfo.From(ctx), actorType, userId);

        if (decision != "GRANTED" && mp.Policy.ConsentMode == "CONSENT_REQUIRED" && mp.Policy.StopOnWithdrawal && await ActiveAsync(c, m.MeetingId) is not null)
            await StopAsync(c, m, $"Recording consent {(decision == "WITHDRAWN" ? "withdrawn" : "declined")} by a participant", null, ClientInfo.From(ctx).Ip, ct);
        else if (decision == "GRANTED")
            await TryAutoStartAsync(c, m, ct);
        return null;
    }

    // ---- Start / stop ---------------------------------------------------------------------------------------------------

    internal async Task<StartResult> StartAsync(IDbConnection c, RecMeeting m, RecParticipant? starter, long? userId, bool acceptNotice, string? noticeVersion, HttpContext? ctx, CancellationToken ct)
    {
        if (m.Status != "LIVE") return StartResult.No(409, "CONFLICT", "Recording can start once the meeting is live (a host has joined).");
        var mp = await RecordingPolicyStore.ForMeetingAsync(c, m.Category, m.MeetingRecordingPolicy);
        if (mp is null) return StartResult.No(409, "RECORDING_DISABLED", "No recording policy is mapped to this meeting category.");
        if (await RefusalAsync(c, m, mp) is { } refusal) return refusal;
        var p = mp.Policy;
        if (starter is not null && acceptNotice)
        {
            if (!string.Equals(noticeVersion, p.NoticeVersion, StringComparison.Ordinal))
                return StartResult.No(409, "NOTICE_CHANGED", "The recording notice has changed. Please read the current notice and start again.");
            var rows0 = await ConsentRowsAsync(c, m.MeetingId, p.NoticeVersion);
            if (rows0.FirstOrDefault(r => r.ParticipantId == starter.ParticipantId)?.Decision != "GRANTED")
                await RecordConsentAsync(c, null, m, starter, p, "GRANTED", ctx is null ? new ClientInfo(null, null) : ClientInfo.From(ctx), "USER", userId);
        }
        if (await ActiveAsync(c, m.MeetingId) is not null) return StartResult.No(409, "ALREADY_RECORDING", "This meeting is already being recorded.");

        var present = await PresentAsync(c, m, ct);
        var rows = await ConsentRowsAsync(c, m.MeetingId, p.NoticeVersion);
        var check = CheckConsent(p, rows, present, starter?.ParticipantId);
        // The shared policy gate (the same code the R2 recorder runs again before it joins the room).
        var decision = RecordingPolicyGate.Evaluate(p.ToGate(mp.Kind), O.DeploymentEnvironment, mp.Kind, check.Ok);
        if (!decision.Allowed)
        {
            var who = check.Pending.Count + check.Declined.Count > 0
                ? $" Waiting for: {string.Join(", ", check.Pending.Concat(check.Declined).Select(r => r.Name).Distinct())}." : "";
            return StartResult.No(409, decision.Code, decision.Code == "CONSENT_MISSING" ? $"Recording consent has not been given by everyone required.{who}" : decision.Message);
        }

        Guid publicId;
        using (var tx = c.BeginTransaction())
        {
            try
            {
                var created = await c.QuerySingleAsync<(long Id, Guid PublicId)>("""
                    DECLARE @out TABLE (RecordingId BIGINT, PublicId UNIQUEIDENTIFIER); -- OUTPUT INTO: the table has a trigger
                    INSERT rec.MeetingRecordings (MeetingId, OwnerEmployeeId, CustomerId, [Status], CreatedByUserId, StartedByUserId, PolicyCode, PolicyVersion, PolicySnapshotJson)
                    OUTPUT inserted.RecordingId, inserted.PublicId INTO @out
                    VALUES (@m, @owner, @customer, 'PENDING', @user, @user, @code, @version, @snapshot);
                    SELECT RecordingId, PublicId FROM @out;
                    """, new
                {
                    m = m.MeetingId, owner = m.CreatedByEmployeeId, customer = m.CustomerId, user = userId, code = p.PolicyCode, version = p.PolicyVersion,
                    snapshot = JsonSerializer.Serialize(new { policy = p.Snapshot(), effectiveRequirement = mp.EffectiveRequirement, kind = mp.Kind.ToString(), environment = O.DeploymentEnvironment.ToString(),
                        consent = new { check.Ok, required = check.Required.Select(r => new { r.Identity, r.Decision }) } }),
                }, tx);
                await c.ExecuteAsync("INSERT rec.RecordingJobs (RecordingId, IdempotencyKey, Engine) VALUES (@id, @key, 'R2_CHROMIUM')",
                    new { id = created.Id, key = $"rec:{created.PublicId:N}" }, tx);
                await Audit.WriteAsync(c, userId is null ? "SYSTEM" : "USER", userId, "RECORDING_STARTED", "Recording", created.PublicId.ToString(),
                    userId is null ? "Mandatory recording started automatically" : "Host started recording", ctx is null ? null : ClientInfo.From(ctx).Ip, tx,
                    newValues: new { meeting = m.PublicId, policy = p.PolicyCode, requirement = mp.EffectiveRequirement });
                tx.Commit();
                publicId = created.PublicId;
            }
            catch (SqlException e) when (e.IsUniqueViolation())
            {
                tx.Rollback();
                return StartResult.No(409, "ALREADY_RECORDING", "This meeting is already being recorded.");
            }
        }
        await BroadcastAsync(c, rooms, m.MeetingId, ct);
        worker.Kick();
        return StartResult.Ok(publicId);
    }

    /// <summary>Asks the recorder to stop (it finalises and verifies the file), or cancels a job the recorder has not picked up yet.</summary>
    internal async Task<bool> StopAsync(IDbConnection c, RecMeeting m, string reason, long? userId, string? ip, CancellationToken ct)
    {
        var active = await ActiveAsync(c, m.MeetingId);
        if (active is null) return false;
        using (var tx = c.BeginTransaction())
        {
            var cancelled = await c.ExecuteAsync("""
                UPDATE rec.RecordingJobs SET [State] = 'FAILED', LastError = @reason, ModifiedUtc = SYSUTCDATETIME() WHERE RecordingId = @r AND [State] = 'QUEUED';
                """, new { r = active.RecordingId, reason }, tx);
            if (cancelled > 0)
                await c.ExecuteAsync("""
                    UPDATE rec.MeetingRecordings SET [Status] = 'FAILED', FailureReason = N'Stopped before the recorder started.', StopReason = @reason, EndedUtc = SYSUTCDATETIME(), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @userId
                    WHERE RecordingId = @r AND [Status] = 'PENDING'
                    """, new { r = active.RecordingId, reason, userId }, tx);
            else
                await c.ExecuteAsync("""
                    UPDATE rec.RecordingJobs SET [State] = 'STOPPING', ModifiedUtc = SYSUTCDATETIME() WHERE RecordingId = @r AND [State] IN ('STARTING', 'ACTIVE');
                    UPDATE rec.MeetingRecordings SET StopReason = COALESCE(StopReason, @reason), ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @userId WHERE RecordingId = @r;
                    """, new { r = active.RecordingId, reason, userId }, tx);
            await Audit.WriteAsync(c, userId is null ? "SYSTEM" : "USER", userId, "RECORDING_STOP_REQUESTED", "Recording", active.PublicId.ToString(), reason.Length > 400 ? reason[..400] : reason, ip, tx);
            tx.Commit();
        }
        await BroadcastAsync(c, rooms, m.MeetingId, ct, stopping: true);
        worker.Kick();
        return true;
    }

    /// <summary>Mandatory recording starts by itself as soon as the meeting is live and the consent conditions hold.</summary>
    internal async Task TryAutoStartAsync(IDbConnection c, RecMeeting m, CancellationToken ct)
    {
        if (m.Status != "LIVE") return;
        var mp = await RecordingPolicyStore.ForMeetingAsync(c, m.Category, m.MeetingRecordingPolicy);
        if (mp is null || mp.EffectiveRequirement != "MANDATORY") return;
        if (await ActiveAsync(c, m.MeetingId) is not null) return;
        // Never loop on a failing recorder: no automatic restart within 5 minutes of a failure or a consent-based stop.
        if (await c.ExecuteScalarAsync<int>("""
                SELECT COUNT(*) FROM rec.MeetingRecordings WHERE MeetingId = @m
                  AND ((Status = 'FAILED' AND COALESCE(ModifiedUtc, CreatedUtc) > DATEADD(MINUTE, -5, SYSUTCDATETIME())) OR (StopReason LIKE N'Recording consent%' AND COALESCE(EndedUtc, ModifiedUtc, CreatedUtc) > DATEADD(MINUTE, -5, SYSUTCDATETIME())))
                """, new { m = m.MeetingId }) > 0) return;
        var r = await StartAsync(c, m, null, null, false, null, null, ct);
        if (r.RecordingId is not null) log.LogInformation("Mandatory recording {Recording} started automatically for meeting {Meeting}", r.RecordingId, m.PublicId);
    }

    /// <summary>Pushes the meeting's recording state to everyone in the room: room metadata (late joiners) + a data message (now).</summary>
    internal static async Task BroadcastAsync(IDbConnection c, LiveKitRoomService rooms, long meetingId, CancellationToken ct, bool stopping = false)
    {
        var m = await MeetingAsync(c, meetingId);
        if (m is null) return;
        var active = await ActiveAsync(c, meetingId);
        var status = active is null ? "OFF" : stopping ? "STOPPING" : active.Status;
        var state = new { oicRecording = new { status, id = active?.PublicId, startedUtc = active?.StartedUtc, atUtc = DateTime.UtcNow } };
        await rooms.TryUpdateRoomMetadataAsync(m.LiveKitRoomName, JsonSerializer.Serialize(state), ct);
        await rooms.TrySendDataAsync(m.LiveKitRoomName, Topic, new { type = "recording-changed", status }, null, ct);
    }
}
