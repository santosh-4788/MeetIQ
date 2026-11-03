using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Recording;
using OneInsure.Connect.Api.Security;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Phase 5 — recording management: policy administration (validation, audit, never "confirmed" with placeholders), the policy gate per
/// environment, consent capture (append-only evidence), the recorder job lifecycle (recorder process faked, FFmpeg verification real),
/// COMPLETED only after verification, crash recovery, retry, the access matrix (404 + DENIED log), signed URLs (expiry, user binding,
/// HTTP ranges), download permission, legal hold and retention (review, archive, delete with dual approval).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class RecordingTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    const string Policy = "TRAINING_TEAM_MEETING"; // TEAM meetings map to it
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;
    Task<int> Count(string sql, object? p = null) => fx.QueryAsync<int>(sql, p);
    RecorderWorker Worker => fx.Factory.Services.GetRequiredService<RecorderWorker>();

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    static readonly SemaphoreSlim SeedGate = new(1, 1);
    static bool seeded;

    /// <summary>Own employees: a host (meeting creator) in department XDEPT and team XTEAM, a peer, the team leader, the department head,
    /// a compliance auditor and an outsider.</summary>
    async Task SeedAsync()
    {
        await SeedGate.WaitAsync();
        try
        {
            if (seeded || await Count("SELECT COUNT(*) FROM org.Employees WHERE EmployeeCode = 'X-HOST'") > 0) { seeded = true; return; }
            var hash = new Passwords().Hash(Pw);
            await Exec("""
                INSERT org.Departments (Code, Name) VALUES ('XDEPT', N'Recording Test Dept');
                INSERT org.Employees (EmployeeCode, FirstName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
                SELECT v.Code, v.Name, v.Name, v.Email, (SELECT DepartmentId FROM org.Departments WHERE Code = 'XDEPT'), (SELECT DesignationId FROM org.Designations WHERE Code = 'TEX')
                FROM (VALUES ('X-HOST', N'Xena Host', N'xhost@test.invalid'), ('X-PEER', N'Xavi Peer', N'xpeer@test.invalid'), ('X-LEAD', N'Xia Lead', N'xlead@test.invalid'),
                             ('X-HEAD', N'Xander Head', N'xhead@test.invalid'), ('X-AUD', N'Xiu Auditor', N'xaud@test.invalid'), ('X-OUT', N'Xerxes Out', N'xout@test.invalid')) v (Code, Name, Email);
                UPDATE org.Departments SET HeadEmployeeId = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'X-HEAD') WHERE Code = 'XDEPT';
                INSERT org.Teams (Code, Name, DepartmentId, TeamLeaderEmployeeId)
                VALUES ('XTEAM', N'Recording Test Team', (SELECT DepartmentId FROM org.Departments WHERE Code = 'XDEPT'), (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'X-LEAD'));
                INSERT org.TeamMembers (TeamId, EmployeeId) SELECT t.TeamId, e.EmployeeId FROM org.Teams t, org.Employees e WHERE t.Code = 'XTEAM' AND e.EmployeeCode IN ('X-HOST', 'X-PEER');
                INSERT auth.Users (Email, PasswordHash, EmployeeId) SELECT e.OfficialEmail, @hash, e.EmployeeId FROM org.Employees e WHERE e.EmployeeCode LIKE 'X-%';
                INSERT auth.UserRoles (UserId, RoleId)
                SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = CASE WHEN u.Email = N'xaud@test.invalid' THEN 'ComplianceAuditor' ELSE 'Employee' END
                WHERE u.Email LIKE N'x%@test.invalid';
                """, new { hash });
            seeded = true;
        }
        finally
        {
            SeedGate.Release();
        }
    }

    /// <summary>Puts the training/team policy into a known state (each test then adjusts what it needs).</summary>
    async Task ResetPolicy(string extra = "")
    {
        await Exec($"""
            UPDATE rec.RecordingPolicies SET IsEnabled = 1, Requirement = 'OPTIONAL', ConsentMode = 'CONSENT_REQUIRED', ConsentFromAll = 1, StopOnWithdrawal = 1,
                RetentionDays = NULL, ExpiryAction = 'REVIEW_ONLY', ArchiveLocation = NULL, LegalHoldEnabled = 1, DualApprovalForDeletion = 1, DeletionApproverRoles = N'[]',
                PlaybackRoles = N'[]', DownloadRoles = N'[]', OwnerCanPlay = 1, OwnerCanDownload = 0, TeamLeaderCanPlay = 0, DepartmentHeadCanPlay = 0, SignedUrlTtlSeconds = 300,
                ApprovalStatus = 'PENDING_CONFIRMATION', PolicyReference = NULL
            WHERE PolicyCode = '{Policy}'
            """);
        if (extra.Trim().TrimStart(',').Trim() is { Length: > 0 } set)
            await Exec($"UPDATE rec.RecordingPolicies SET {set} WHERE PolicyCode = '{Policy}'");
    }

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    Task<Guid> Emp(string code) => fx.QueryAsync<Guid>("SELECT PublicId FROM org.Employees WHERE EmployeeCode = @code", new { code });

    sealed record Booked(Guid Id, long Mid, string Room, string HostIdentity, string PeerIdentity);

    static int day = 700;

    /// <summary>A TEAM meeting of X-HOST with X-PEER, moved to "now", started by the host (LIVE); both are "in the room".</summary>
    async Task<Booked> LiveMeeting(TestClient host, string recordingPolicy = "OPTIONAL")
    {
        var start = DateTime.SpecifyKind(DateTime.UtcNow.Date.AddDays(Interlocked.Increment(ref day)).AddHours(5), DateTimeKind.Utc);
        var r = await host.PostAsync("/api/v1/meetings", new
        {
            title = "Recording test", category = "TEAM", startUtc = start, endUtc = start.AddHours(1), employeeIds = new[] { await Emp("X-PEER") }, status = "SCHEDULED",
            recordingPolicy, waitingRoomEnabled = false,
        });
        Assert.True(r.StatusCode == HttpStatusCode.Created, await r.Content.ReadAsStringAsync());
        var id = (await Json(r)).GetProperty("id").GetGuid();
        var mid = await fx.QueryAsync<long>("SELECT MeetingId FROM mtg.Meetings WHERE PublicId = @id", new { id });
        await Exec("UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, -1, SYSUTCDATETIME()), ScheduledEndUtc = DATEADD(MINUTE, 59, SYSUTCDATETIME()) WHERE MeetingId = @mid", new { mid });
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{id}/join")).StatusCode);
        var room = await fx.QueryAsync<string>("SELECT LiveKitRoomName FROM mtg.Meetings WHERE MeetingId = @mid", new { mid });
        string Ident(string code) => fx.QueryAsync<string>("SELECT p.LiveKitIdentity FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = @mid AND e.EmployeeCode = @code", new { mid, code }).Result;
        var b = new Booked(id, mid, room, Ident("X-HOST"), Ident("X-PEER"));
        fx.LiveKit.Participants[room] = [b.HostIdentity, b.PeerIdentity];
        return b;
    }

    async Task<string> NoticeVersion() => await fx.QueryAsync<string>("SELECT NoticeVersion FROM rec.RecordingPolicies WHERE PolicyCode = @Policy", new { Policy });

    /// <summary>Peer consents, host starts (accepting the notice); returns the recording id.</summary>
    async Task<Guid> Start(TestClient host, TestClient peer, Booked m)
    {
        var v = await NoticeVersion();
        Assert.Equal(HttpStatusCode.OK, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/recording/consent", new { decision = "GRANTED", noticeVersion = v })).StatusCode);
        var r = await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/start", new { acceptNotice = true, noticeVersion = v });
        Assert.True(r.StatusCode == HttpStatusCode.OK, await r.Content.ReadAsStringAsync());
        return (await Json(r)).GetProperty("recording").GetProperty("id").GetGuid();
    }

    /// <summary>Drives the worker until the recorder for <paramref name="rec"/> was launched and reports recording.</summary>
    async Task<FakeRun> Launched(Guid rec, int part = 1)
    {
        await Worker.RunOnceAsync(CancellationToken.None);
        var run = fx.Recorder.For(rec, part);
        Assert.NotNull(run);
        run!.Started = true;
        await Worker.RunOnceAsync(CancellationToken.None);
        return run;
    }

    async Task Finish()
    {
        await Worker.RunOnceAsync(CancellationToken.None);
        await Worker.DrainAsync();
    }

    Task<string> Status(Guid rec) => fx.QueryAsync<string>("SELECT [Status] FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec });

    /// <summary>A COMPLETED recording owned by X-HOST.</summary>
    async Task<(Guid Rec, Booked M, TestClient Host)> Completed()
    {
        await SeedAsync();
        await ResetPolicy();
        var host = await SignedIn("xhost@test.invalid");
        var peer = await SignedIn("xpeer@test.invalid");
        var m = await LiveMeeting(host);
        var rec = await Start(host, peer, m);
        var run = await Launched(rec);
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/stop")).StatusCode);
        await Worker.RunOnceAsync(CancellationToken.None);
        Assert.True(run.StopRequested);
        await run.CompleteAsync();
        await Finish();
        Assert.Equal("COMPLETED", await Status(rec));
        return (rec, m, host);
    }

    // ---- Policies ---------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Policies_are_listed_validated_never_confirmed_with_placeholders_and_audited()
    {
        await SeedAsync();
        await ResetPolicy();
        var super = await SignedIn("msuper@test.invalid");
        var admin = await SignedIn("orgadmin@test.invalid"); // Admin: admin.settings, but not recordings.policy.manage
        var employee = await SignedIn("xpeer@test.invalid");

        var list = await Json(await super.Http.GetAsync("/api/v1/admin/recording-policies"));
        var items = list.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(["CUSTOMER_MEETING", "CUSTOMER_AUDIO_CALL", "INTERNAL_MEETING", "TRAINING_TEAM_MEETING"], items.Select(i => i.GetProperty("code").GetString()));
        Assert.All(items, i => Assert.False(i.GetProperty("confirmed").GetBoolean()));
        Assert.All(items.Where(i => i.GetProperty("code").GetString() != Policy), i => Assert.True(i.GetProperty("hasPlaceholders").GetBoolean()));
        Assert.True(items[1].GetProperty("configurationOnly").GetBoolean());
        Assert.Equal(9, list.GetProperty("categories").GetArrayLength());
        Assert.Equal(HttpStatusCode.OK, (await admin.Http.GetAsync("/api/v1/admin/recording-policies")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await employee.Http.GetAsync("/api/v1/admin/recording-policies")).StatusCode);

        var p = items.Single(i => i.GetProperty("code").GetString() == "INTERNAL_MEETING");
        object Body(string status, string? reference, string notice, string version, int? retention, string rowVersion, string playback = "ComplianceAuditor") => new
        {
            policyName = "Call & meeting recording policy", policyVersion = "3.1", effectiveFrom = "2026-11-01", approvalStatus = status, policyReference = reference,
            isEnabled = true, requirement = "OPTIONAL", consentMode = "CONSENT_REQUIRED", noticeText = notice, noticeVersion = version, consentFromAll = true,
            stopOnWithdrawal = true, retentionDays = retention, expiryAction = "REVIEW_ONLY", legalHoldEnabled = true, dualApprovalForDeletion = true,
            deletionApproverRoles = new[] { "SuperAdmin" }, playbackRoles = new[] { playback }, downloadRoles = Array.Empty<string>(), ownerCanPlay = true,
            ownerCanDownload = false, teamLeaderCanPlay = true, departmentHeadCanPlay = false, signedUrlTtlSeconds = 300, rowVersion,
        };
        var rv = p.GetProperty("rowVersion").GetString()!;
        var placeholder = p.GetProperty("noticeText").GetString()!;

        // Confirming while the wording, version and retention are still placeholders is refused.
        var bad = await super.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("EXISTING_BUSINESS_POLICY", "POL-REC-7", placeholder, "PLACEHOLDER-0", null, rv));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var errors = (await Json(bad)).GetProperty("errors");
        Assert.True(errors.TryGetProperty("noticeText", out _) && errors.TryGetProperty("noticeVersion", out _) && errors.TryGetProperty("retentionDays", out _));
        Assert.Equal(HttpStatusCode.BadRequest, (await super.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("APPROVED", null, "Real text", "v1", 30, rv))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await super.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("PENDING_CONFIRMATION", null, placeholder, "PLACEHOLDER-0", null, rv, "NoSuchRole"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("PENDING_CONFIRMATION", null, placeholder, "PLACEHOLDER-0", null, rv))).StatusCode);

        // A pending policy may be edited freely; the change is audited with old and new values (privileged).
        var ok = await super.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("PENDING_CONFIRMATION", null, placeholder, "PLACEHOLDER-0", null, rv));
        Assert.True(ok.StatusCode == HttpStatusCode.OK, await ok.Content.ReadAsStringAsync());
        var saved = await Json(ok);
        Assert.True(saved.GetProperty("isEnabled").GetBoolean());
        Assert.False(saved.GetProperty("confirmed").GetBoolean());
        Assert.Equal(["ComplianceAuditor"], saved.GetProperty("playbackRoles").EnumerateArray().Select(x => x.GetString()));
        var audit = await fx.QueryAsync<(string Old, string New, bool Priv)>(
            "SELECT TOP (1) OldValuesJson, NewValuesJson, IsPrivileged FROM app.AuditLog WHERE [Action] = 'RECORDING_POLICY_UPDATED' AND EntityId = 'INTERNAL_MEETING' ORDER BY AuditId DESC");
        Assert.True(audit.Priv);
        Assert.Contains("\"enabled\":false", audit.Old);
        Assert.Contains("\"enabled\":true", audit.New);

        // The old version token is now stale.
        Assert.Equal(HttpStatusCode.Conflict, (await super.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("PENDING_CONFIRMATION", null, placeholder, "PLACEHOLDER-0", null, rv))).StatusCode);

        // Confirmed with real values and a reference: accepted.
        var rv2 = saved.GetProperty("rowVersion").GetString()!;
        var confirmed = await super.PutAsync("/api/v1/admin/recording-policies/INTERNAL_MEETING", Body("EXISTING_BUSINESS_POLICY", "POL-REC-7", "This meeting is recorded under policy POL-REC-7.", "EBP-1", 365, rv2));
        Assert.True(confirmed.StatusCode == HttpStatusCode.OK, await confirmed.Content.ReadAsStringAsync());
        Assert.True((await Json(confirmed)).GetProperty("confirmed").GetBoolean());
        // Put the shipped placeholder state back for the other tests.
        await Exec("""
            UPDATE rec.RecordingPolicies SET ApprovalStatus = 'PENDING_CONFIRMATION', PolicyReference = NULL, IsEnabled = 0, NoticeText = @placeholder, NoticeVersion = 'PLACEHOLDER-0',
                RetentionDays = NULL, PlaybackRoles = N'[]' WHERE PolicyCode = 'INTERNAL_MEETING'
            """, new { placeholder });

        // Category mapping: complete, and customer categories only on the customer policy.
        var cats = list.GetProperty("categories").EnumerateArray().Select(x => new { category = (string?)x.GetProperty("category").GetString(), policyCode = (string?)x.GetProperty("policyCode").GetString() }).ToList();
        var wrong = cats.Select(x => x.category == "CUSTOMER_PLVC" ? new { category = (string?)x.category, policyCode = (string?)"INTERNAL_MEETING" } : x).ToList();
        Assert.Equal(HttpStatusCode.BadRequest, (await super.PutAsync("/api/v1/admin/recording-policies/categories", new { items = wrong })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await super.PutAsync("/api/v1/admin/recording-policies/categories", new { items = cats.Take(5) })).StatusCode);
        var moved = cats.Select(x => x.category == "REVIEW" ? new { category = (string?)x.category, policyCode = (string?)"TRAINING_TEAM_MEETING" } : x).ToList();
        Assert.Equal(HttpStatusCode.OK, (await super.PutAsync("/api/v1/admin/recording-policies/categories", new { items = moved })).StatusCode);
        Assert.Equal("TRAINING_TEAM_MEETING", await fx.QueryAsync<string>("SELECT PolicyCode FROM rec.RecordingPolicyCategories WHERE Category = 'REVIEW'"));
        Assert.Equal(HttpStatusCode.OK, (await super.PutAsync("/api/v1/admin/recording-policies/categories", new { items = cats })).StatusCode);
        Assert.Equal(2, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'RECORDING_POLICY_CATEGORIES_UPDATED' AND IsPrivileged = 1"));

        var health = await Json(await super.Http.GetAsync("/api/v1/admin/recording/health"));
        Assert.Contains(health.GetProperty("items").EnumerateArray(), i => i.GetProperty("name").GetString()!.StartsWith("FFmpeg") && i.GetProperty("ok").GetBoolean());
        Assert.Equal("Test", health.GetProperty("environment").GetString());
    }

    [Fact]
    public void Gate_blocks_unconfirmed_policies_only_in_pilot_and_production()
    {
        var pending = new PolicyRow
        {
            PolicyCode = "CUSTOMER_MEETING", IsEnabled = true, Requirement = "OPTIONAL", ConsentMode = "CONSENT_REQUIRED", ConsentFromAll = true,
            NoticeText = "[PLACEHOLDER – NOT CONFIRMED] x", NoticeVersion = "PLACEHOLDER-0", SignedUrlTtlSeconds = 300,
        };
        var gate = pending.ToGate(MeetingRecordingKind.Customer);
        Assert.True(RecordingPolicyGate.Evaluate(gate, DeploymentEnvironment.Development, MeetingRecordingKind.Customer, true).Allowed);
        Assert.True(RecordingPolicyGate.Evaluate(gate, DeploymentEnvironment.Test, MeetingRecordingKind.Customer, true).Allowed);
        Assert.Equal("CONSENT_MISSING", RecordingPolicyGate.Evaluate(gate, DeploymentEnvironment.Development, MeetingRecordingKind.Customer, false).Code);
        Assert.False(RecordingPolicyGate.Evaluate(gate, DeploymentEnvironment.Production, MeetingRecordingKind.Customer, true).Allowed);
        Assert.False(RecordingPolicyGate.Evaluate(gate, DeploymentEnvironment.Pilot, MeetingRecordingKind.Customer, true).Allowed);
        Assert.False(pending.IsConfirmed);

        pending.IsEnabled = false;
        Assert.Equal("CUSTOMER_RECORDING_DISABLED", RecordingPolicyGate.Evaluate(pending.ToGate(MeetingRecordingKind.Customer), DeploymentEnvironment.Development, MeetingRecordingKind.Customer, true).Code);

        var confirmed = new PolicyRow
        {
            PolicyCode = "CUSTOMER_MEETING", IsEnabled = true, Requirement = "OPTIONAL", ConsentMode = "NOTIFICATION_ONLY", ApprovalStatus = "EXISTING_BUSINESS_POLICY",
            PolicyReference = "POL-1", NoticeText = "Recorded.", NoticeVersion = "v1", RetentionDays = 90, SignedUrlTtlSeconds = 300,
        };
        Assert.True(confirmed.IsConfirmed);
        Assert.True(RecordingPolicyGate.Evaluate(confirmed.ToGate(MeetingRecordingKind.Customer), DeploymentEnvironment.Production, MeetingRecordingKind.Customer, false).Allowed);
        Assert.Equal("MANDATORY", RecordingPolicyStore.EffectiveRequirement(confirmed, "REQUIRED"));
        Assert.Equal("OPTIONAL", RecordingPolicyStore.EffectiveRequirement(confirmed, "NONE"));
        confirmed.IsEnabled = false;
        Assert.Equal("DISABLED", RecordingPolicyStore.EffectiveRequirement(confirmed, "REQUIRED"));
        Assert.True(new RecordingOptions { Environment = "Production" }.IsRestrictedEnvironment);
        Assert.False(new RecordingOptions { Environment = "Development" }.IsRestrictedEnvironment);
    }

    // ---- Consent, start, lifecycle ------------------------------------------------------------------------------------

    [Fact]
    public async Task Consent_is_required_from_everyone_in_the_room_and_stored_append_only()
    {
        await SeedAsync();
        await ResetPolicy(", IsEnabled = 0");
        var host = await SignedIn("xhost@test.invalid");
        var peer = await SignedIn("xpeer@test.invalid");
        var outsider = await SignedIn("xout@test.invalid");
        var m = await LiveMeeting(host);

        var disabled = await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/start", new { acceptNotice = true, noticeVersion = await NoticeVersion() });
        Assert.Equal(HttpStatusCode.Conflict, disabled.StatusCode);
        Assert.Equal("RECORDING_DISABLED", await Code(disabled));
        await ResetPolicy();

        var state = await Json(await peer.Http.GetAsync($"/api/v1/meetings/{m.Id}/recording"));
        Assert.True(state.GetProperty("available").GetBoolean());
        Assert.False(state.GetProperty("policy").GetProperty("confirmed").GetBoolean());
        Assert.StartsWith("[PLACEHOLDER", state.GetProperty("policy").GetProperty("noticeText").GetString());
        Assert.False(state.GetProperty("canStart").GetBoolean()); // not a host
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Http.GetAsync($"/api/v1/meetings/{m.Id}/recording")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/recording/start", new { acceptNotice = true, noticeVersion = await NoticeVersion() })).StatusCode);

        // The peer has not answered: refused, naming who is missing.
        var missing = await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/start", new { acceptNotice = true, noticeVersion = await NoticeVersion() });
        Assert.Equal(HttpStatusCode.Conflict, missing.StatusCode);
        var missingBody = await Json(missing);
        Assert.Equal("CONSENT_MISSING", missingBody.GetProperty("code").GetString());
        Assert.Contains("Xavi Peer", missingBody.GetProperty("detail").GetString());
        Assert.Equal("NOTICE_CHANGED", await Code(await peer.PostAsync($"/api/v1/meetings/{m.Id}/recording/consent", new { decision = "GRANTED", noticeVersion = "old" })));
        Assert.Equal(HttpStatusCode.BadRequest, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/recording/consent", new { decision = "MAYBE", noticeVersion = await NoticeVersion() })).StatusCode);

        var rec = await Start(host, peer, m);
        Assert.Equal("PENDING", await Status(rec));
        var rows = await Count("SELECT COUNT(*) FROM mtg.MeetingConsent WHERE MeetingId = @mid AND Decision = 'GRANTED' AND EvidenceHash IS NOT NULL AND NoticeVersion = 'PLACEHOLDER-0'", new { mid = m.Mid });
        Assert.Equal(2, rows); // host (accepted the notice when starting) + peer
        var ex = await Assert.ThrowsAsync<SqlException>(() => Exec("UPDATE mtg.MeetingConsent SET Decision = 'DENIED' WHERE MeetingId = @mid", new { mid = m.Mid }));
        Assert.Contains("append-only", ex.Message);
        Assert.Equal(HttpStatusCode.Conflict, (await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/start", new { acceptNotice = true, noticeVersion = await NoticeVersion() })).StatusCode);
        Assert.Contains(fx.LiveKit.For(m.Room), c => c.Method == "UpdateRoomMetadata" && c.Body.GetProperty("metadata").GetString()!.Contains("PENDING"));

        // Withdrawal stops the recording (policy: stop on withdrawal).
        var run = await Launched(rec);
        Assert.Equal("RECORDING", await Status(rec));
        Assert.Equal(HttpStatusCode.OK, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/recording/consent", new { decision = "WITHDRAWN", noticeVersion = await NoticeVersion() })).StatusCode);
        Assert.Equal("STOPPING", await fx.QueryAsync<string>("SELECT j.[State] FROM rec.RecordingJobs j JOIN rec.MeetingRecordings r ON r.RecordingId = j.RecordingId WHERE r.PublicId = @rec", new { rec }));
        await Worker.RunOnceAsync(CancellationToken.None);
        Assert.True(run.StopRequested);
        Assert.Contains("withdrawn", await fx.QueryAsync<string>("SELECT StopReason FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec }));
        await run.CompleteAsync();
        await Finish();
        Assert.Equal("COMPLETED", await Status(rec));
    }

    [Fact]
    public async Task Recorder_job_lifecycle_completes_only_after_verification_and_notifies_the_owner()
    {
        await SeedAsync();
        await ResetPolicy();
        var host = await SignedIn("xhost@test.invalid");
        var peer = await SignedIn("xpeer@test.invalid");
        var m = await LiveMeeting(host);
        var rec = await Start(host, peer, m);
        await Worker.RunOnceAsync(CancellationToken.None);
        var run = fx.Recorder.For(rec)!;
        Assert.Equal("record", run.Launch.Mode);
        Assert.Equal(m.Room, run.Launch.Room);
        Assert.Equal("internal", run.Launch.Kind);
        Assert.True(run.Launch.ConsentGranted);
        Assert.Equal("true", run.Launch.Environment["OIC_RecordingPolicy__InternalRecordingEnabled"]);
        Assert.Equal("Test", run.Launch.Environment["OIC_Recorder__Environment"]);
        Assert.Equal("PLACEHOLDER-0", run.Launch.Environment["OIC_RecordingPolicy__ConsentNoticeVersion"]);
        Assert.DoesNotContain(ApiFixture.LiveKitSecret, run.Launch.Room + run.Launch.Title + run.Launch.JobKey); // secret only in the environment
        Assert.Equal("PENDING", await Status(rec)); // not yet recording
        run.Started = true;
        await Worker.RunOnceAsync(CancellationToken.None);
        Assert.Equal("RECORDING", await Status(rec));

        // The meeting ends → the worker asks the recorder to stop.
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/end")).StatusCode);
        await Worker.RunOnceAsync(CancellationToken.None);
        Assert.True(run.StopRequested);
        await run.CompleteAsync(expectedSeconds: 4);
        await Finish();

        var r = await fx.QueryAsync<(string Status, string Key, byte[] Sha, long Size, int Duration, string Vc, string Ac, int W, string Details, DateTime? Verified)>(
            "SELECT [Status], StorageKey, Sha256, FileSizeBytes, DurationSeconds, VideoCodec, AudioCodec, Width, VerificationDetails, VerifiedUtc FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec });
        Assert.Equal("COMPLETED", r.Status);
        Assert.Matches(@"^\d{4}/\d{2}/[0-9a-f]{32}\.mp4$", r.Key); // opaque, no meeting or customer data
        var file = Path.Combine(fx.RecordingRoot, "library", r.Key);
        Assert.True(File.Exists(file));
        Assert.Equal(Convert.ToHexStringLower(r.Sha), await MediaVerifier.Sha256HexAsync(file, CancellationToken.None));
        Assert.Equal(new FileInfo(file).Length, r.Size);
        Assert.Equal(("h264", "aac", 1280), (r.Vc, r.Ac, r.W));
        Assert.Equal(4, r.Duration);
        Assert.Contains("full decode", r.Details);
        Assert.NotNull(r.Verified);
        Assert.Equal("DONE", await fx.QueryAsync<string>("SELECT j.[State] FROM rec.RecordingJobs j JOIN rec.MeetingRecordings r ON r.RecordingId = j.RecordingId WHERE r.PublicId = @rec", new { rec }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = 'xhost@test.invalid' AND n.[Type] = 'RECORDING_AVAILABLE' AND n.LinkPath = @link", new { link = $"/recordings/{rec}" }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE Template = 'RECORDING_AVAILABLE' AND ToAddress = 'xhost@test.invalid' AND RelatedMeetingId = @mid", new { mid = m.Mid }));
        Assert.False(Directory.Exists(run.Launch.JobDir)); // spool cleaned after the verified copy

        // The dashboard counts it.
        var dash = await Json(await host.Http.GetAsync("/api/v1/dashboard/summary"));
        Assert.True(dash.GetProperty("recordingStatus").GetProperty("completed").GetInt32() >= 1);
        // The meeting page lists it.
        var forMeeting = await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/recordings"));
        Assert.Equal(rec, forMeeting.GetProperty("items")[0].GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Corrupt_output_fails_verification_and_retry_rebuilds_it()
    {
        await SeedAsync();
        await ResetPolicy();
        var host = await SignedIn("xhost@test.invalid");
        var peer = await SignedIn("xpeer@test.invalid");
        var super = await SignedIn("msuper@test.invalid"); // admin.ops; sees the recording? only with view rights → give it via playback role
        await ResetPolicy(", PlaybackRoles = N'[\"SuperAdmin\"]'");
        var m = await LiveMeeting(host);
        var rec = await Start(host, peer, m);
        var run = await Launched(rec);
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/stop")).StatusCode);
        await Worker.RunOnceAsync(CancellationToken.None);
        await run.CompleteAsync(corrupt: true); // the recorder claims success, but the bytes are damaged
        await Finish();
        var failed = await fx.QueryAsync<(string Status, string Reason, string? Key, DateTime? Verified)>("SELECT [Status], FailureReason, StorageKey, VerifiedUtc FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec });
        Assert.Equal("FAILED", failed.Status);
        Assert.StartsWith("Verification failed", failed.Reason);
        Assert.Contains("decode", failed.Reason);
        Assert.Null(failed.Key);
        Assert.Null(failed.Verified);
        Assert.Empty(Directory.GetFiles(Path.Combine(fx.RecordingRoot, "library"), "*.partial", SearchOption.AllDirectories));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN rec.MeetingRecordings r ON r.MeetingId = n.MeetingId WHERE r.PublicId = @rec AND n.[Type] = 'RECORDING_FAILED'", new { rec }));
        // COMPLETED without verification is impossible in the database itself.
        await Assert.ThrowsAsync<SqlException>(() => Exec("UPDATE rec.MeetingRecordings SET [Status] = 'COMPLETED', FailureReason = NULL WHERE PublicId = @rec", new { rec }));

        // Retry: the worker runs "recorder finalize" for the part, which now produces a good file.
        Assert.Equal(HttpStatusCode.Forbidden, (await host.PostAsync($"/api/v1/recordings/{rec}/retry")).StatusCode);
        fx.Recorder.OnFinalize = f => f.CompleteAsync().GetAwaiter().GetResult();
        try
        {
            Assert.Equal(HttpStatusCode.Accepted, (await super.PostAsync($"/api/v1/recordings/{rec}/retry")).StatusCode);
            Assert.Equal("PROCESSING", await Status(rec));
            await Worker.RunOnceAsync(CancellationToken.None);
            await Worker.DrainAsync();
        }
        finally { fx.Recorder.OnFinalize = null; }
        Assert.NotNull(fx.Recorder.For(rec, 1, "finalize"));
        Assert.Equal("COMPLETED", await Status(rec));
    }

    [Fact]
    public async Task A_dead_recorder_process_is_relaunched_while_the_meeting_is_live()
    {
        await SeedAsync();
        await ResetPolicy();
        var host = await SignedIn("xhost@test.invalid");
        var peer = await SignedIn("xpeer@test.invalid");
        var m = await LiveMeeting(host);
        var rec = await Start(host, peer, m);
        var first = await Launched(rec);
        first.Crash(); // no result.json, meeting still live
        await Worker.RunOnceAsync(CancellationToken.None);
        var second = fx.Recorder.For(rec, 2);
        Assert.NotNull(second);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'RECORDER_RELAUNCHED' AND EntityId = @id", new { id = rec.ToString() }));
        second!.Started = true;
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/stop")).StatusCode);
        await Worker.RunOnceAsync(CancellationToken.None);
        await second.CompleteAsync();
        await Finish();
        Assert.Equal("COMPLETED", await Status(rec));
        Assert.Equal(2, await fx.QueryAsync<int>("SELECT j.LaunchCount FROM rec.RecordingJobs j JOIN rec.MeetingRecordings r ON r.RecordingId = j.RecordingId WHERE r.PublicId = @rec", new { rec }));
    }

    [Fact]
    public async Task Mandatory_recording_starts_automatically_when_conditions_hold()
    {
        await SeedAsync();
        await ResetPolicy(", Requirement = 'MANDATORY', ConsentMode = 'NOTIFICATION_ONLY'");
        var host = await SignedIn("xhost@test.invalid");
        var m = await LiveMeeting(host);
        var state = await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/recording"));
        Assert.Equal("MANDATORY", state.GetProperty("policy").GetProperty("requirement").GetString());
        Assert.Equal("PENDING", state.GetProperty("recording").GetProperty("status").GetString());
        Assert.False(state.GetProperty("canStop").GetBoolean());
        Assert.Equal("RECORDING_MANDATORY", await Code(await host.PostAsync($"/api/v1/meetings/{m.Id}/recording/stop")));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'RECORDING_STARTED' AND ActorType = 'SYSTEM' AND EntityId = @id",
            new { id = state.GetProperty("recording").GetProperty("id").GetString() }));
        // End the meeting: the queued job is stopped by the worker.
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/end")).StatusCode);
        var rec = state.GetProperty("recording").GetProperty("id").GetGuid();
        await Worker.RunOnceAsync(CancellationToken.None);
        var run = fx.Recorder.For(rec);
        if (run is not null && !run.HasExited) { await Worker.RunOnceAsync(CancellationToken.None); run.Fail("no media"); }
        await Finish();
        Assert.Equal("FAILED", await Status(rec));
        await ResetPolicy();
    }

    // ---- Library access ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task Access_matrix_owner_team_leader_role_and_denied_with_access_log()
    {
        var (rec, _, host) = await Completed();
        await ResetPolicy();
        var peer = await SignedIn("xpeer@test.invalid");   // participant, not the owner
        var lead = await SignedIn("xlead@test.invalid");   // leads the owner's team
        var head = await SignedIn("xhead@test.invalid");   // heads the owner's department
        var aud = await SignedIn("xaud@test.invalid");     // ComplianceAuditor
        var recId = await fx.QueryAsync<long>("SELECT RecordingId FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec });
        Task<int> Logs(string email, string action) => Count("""
            SELECT COUNT(*) FROM rec.RecordingAccessLog l JOIN auth.Users u ON u.UserId = l.UserId WHERE l.RecordingId = @recId AND u.Email = @email AND l.[Action] = @action
            """, new { recId, email, action });

        // Owner: sees and plays (policy OwnerCanPlay), may not download (OwnerCanDownload off, no permission).
        var list = await Json(await host.Http.GetAsync("/api/v1/recordings"));
        var mine = list.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == rec);
        Assert.True(mine.GetProperty("canPlay").GetBoolean());
        Assert.False(mine.GetProperty("canDownload").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await host.Http.GetAsync($"/api/v1/recordings/{rec}")).StatusCode);
        Assert.Equal(1, await Logs("xhost@test.invalid", "VIEW_DETAILS"));
        Assert.Equal(HttpStatusCode.Forbidden, (await host.PostAsync($"/api/v1/recordings/{rec}/download")).StatusCode);
        Assert.Equal(1, await Logs("xhost@test.invalid", "DENIED"));
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/recordings/{rec}/play")).StatusCode);
        Assert.Equal(1, await Logs("xhost@test.invalid", "PLAY"));
        Assert.False((await Json(await host.Http.GetAsync($"/api/v1/recordings/{rec}"))).GetProperty("canSeeAccessHistory").GetBoolean());

        // Others: 404 (and a DENIED row), not listed.
        foreach (var (c, email) in new[] { (peer, "xpeer@test.invalid"), (lead, "xlead@test.invalid"), (head, "xhead@test.invalid"), (aud, "xaud@test.invalid") })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await c.Http.GetAsync($"/api/v1/recordings/{rec}")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await c.PostAsync($"/api/v1/recordings/{rec}/play")).StatusCode);
            Assert.DoesNotContain((await Json(await c.Http.GetAsync("/api/v1/recordings"))).GetProperty("items").EnumerateArray(), i => i.GetProperty("id").GetGuid() == rec);
            Assert.Equal(2, await Logs(email, "DENIED"));
        }

        // Policy: team leader access → the team leader (only) sees and plays.
        await ResetPolicy(", TeamLeaderCanPlay = 1");
        Assert.Equal(HttpStatusCode.OK, (await lead.PostAsync($"/api/v1/recordings/{rec}/play")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await head.Http.GetAsync($"/api/v1/recordings/{rec}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await peer.Http.GetAsync($"/api/v1/recordings/{rec}")).StatusCode);
        // Department head flag.
        await ResetPolicy(", DepartmentHeadCanPlay = 1");
        Assert.Equal(HttpStatusCode.OK, (await head.Http.GetAsync($"/api/v1/recordings/{rec}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await lead.Http.GetAsync($"/api/v1/recordings/{rec}")).StatusCode);

        // Roles from the policy: the auditor plays and sees the access history; download needs a download role.
        await ResetPolicy(", PlaybackRoles = N'[\"ComplianceAuditor\"]'");
        var detail = await Json(await aud.Http.GetAsync($"/api/v1/recordings/{rec}"));
        Assert.True(detail.GetProperty("canSeeAccessHistory").GetBoolean());
        Assert.Contains(detail.GetProperty("accessHistory").EnumerateArray(), h => h.GetProperty("action").GetString() == "DENIED");
        Assert.Equal(64, detail.GetProperty("sha256").GetString()!.Length);
        Assert.Equal(HttpStatusCode.Forbidden, (await aud.PostAsync($"/api/v1/recordings/{rec}/download")).StatusCode);
        await ResetPolicy(", PlaybackRoles = N'[\"ComplianceAuditor\"]', DownloadRoles = N'[\"ComplianceAuditor\"]'");
        Assert.Equal(HttpStatusCode.OK, (await aud.PostAsync($"/api/v1/recordings/{rec}/download")).StatusCode);
        Assert.Equal(1, await Logs("xaud@test.invalid", "DOWNLOAD"));
        // Owner download flag.
        await ResetPolicy(", OwnerCanDownload = 1");
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/recordings/{rec}/download")).StatusCode);
        // OwnerCanPlay off: the owner still sees the entry but cannot play it.
        await ResetPolicy(", OwnerCanPlay = 0");
        Assert.Equal(HttpStatusCode.Forbidden, (await host.PostAsync($"/api/v1/recordings/{rec}/play")).StatusCode);
        await ResetPolicy();

        // Employee-wise summary and filters.
        var byEmp = await Json(await host.Http.GetAsync("/api/v1/recordings/by-employee"));
        Assert.Contains(byEmp.EnumerateArray(), e => e.GetProperty("employee").GetProperty("employeeCode").GetString() == "X-HOST" && e.GetProperty("completed").GetInt32() >= 1);
        Assert.Equal(0, (await Json(await host.Http.GetAsync("/api/v1/recordings?category=CUSTOMER"))).GetProperty("total").GetInt32());
        Assert.True((await Json(await host.Http.GetAsync($"/api/v1/recordings?status=COMPLETED&employee={await Emp("X-HOST")}&department=XDEPT"))).GetProperty("total").GetInt32() >= 1);
        // The access log is append-only.
        await Assert.ThrowsAsync<SqlException>(() => Exec("UPDATE rec.RecordingAccessLog SET [Action] = 'PLAY' WHERE RecordingId = @recId", new { recId }));
    }

    [Fact]
    public async Task Signed_urls_stream_with_ranges_expire_and_are_bound_to_the_user()
    {
        var (rec, _, host) = await Completed();
        await ResetPolicy(", OwnerCanDownload = 1, PlaybackRoles = N'[\"ComplianceAuditor\"]'");
        var play = await Json(await host.PostAsync($"/api/v1/recordings/{rec}/play"));
        var url = play.GetProperty("url").GetString()!;
        var expires = play.GetProperty("expiresUtc").GetDateTime();
        Assert.InRange((expires - DateTime.UtcNow).TotalSeconds, 250, 310); // policy link lifetime (300 s)

        var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(100, 199);
        var part = await host.Http.SendAsync(req);
        Assert.Equal(HttpStatusCode.PartialContent, part.StatusCode);
        Assert.Equal(100, (await part.Content.ReadAsByteArrayAsync()).Length);
        Assert.Equal("video/mp4", part.Content.Headers.ContentType?.MediaType);
        Assert.StartsWith("bytes 100-199/", part.Content.Headers.ContentRange?.ToString());
        Assert.Contains("no-store", part.Headers.CacheControl?.ToString());
        var full = await host.Http.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, full.StatusCode);
        Assert.Equal("bytes", full.Headers.AcceptRanges.Single());

        // Bound to the user: the auditor (allowed to play on their own) cannot use the owner's link; anonymous cannot either.
        var aud = await SignedIn("xaud@test.invalid");
        Assert.Equal(HttpStatusCode.Forbidden, (await aud.Http.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await (await fx.NewClientAsync()).Http.GetAsync(url)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync("/api/v1/recordings/media/forged-token")).StatusCode);

        // Expired.
        var tokens = fx.Factory.Services.GetRequiredService<RecordingMediaTokens>();
        var hostUser = await fx.QueryAsync<long>("SELECT UserId FROM auth.Users WHERE Email = 'xhost@test.invalid'");
        var expired = tokens.Create(rec, hostUser, "PLAY", DateTime.UtcNow.AddSeconds(-1));
        var gone = await host.Http.GetAsync($"/api/v1/recordings/media/{Uri.EscapeDataString(expired)}");
        Assert.Equal(HttpStatusCode.Forbidden, gone.StatusCode);
        Assert.Contains("expired", (await Json(gone)).GetProperty("detail").GetString());

        // Download link: attachment with a neutral file name.
        var dl = await Json(await host.PostAsync($"/api/v1/recordings/{rec}/download"));
        var file = await host.Http.GetAsync(dl.GetProperty("url").GetString());
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        Assert.Matches(@"^recording-OIC-\d{6}-[A-Z0-9]{4}-\d{8}-\d{4}\.mp4$", file.Content.Headers.ContentDisposition?.FileName?.Trim('"') ?? "");
        await ResetPolicy();
    }

    // ---- Legal hold and retention -------------------------------------------------------------------------------------

    [Fact]
    public async Task Retention_review_archive_delete_with_legal_hold_and_dual_approval()
    {
        var retention = fx.Factory.Services.GetRequiredService<RetentionWorker>();
        var (rec, _, host) = await Completed();
        var (rec2, _, _) = await Completed();
        Task Age(Guid r) => Exec("UPDATE rec.MeetingRecordings SET EndedUtc = DATEADD(DAY, -10, SYSUTCDATETIME()) WHERE PublicId = @r", new { r });
        await Age(rec);
        await Age(rec2);
        string Key(Guid r) => fx.QueryAsync<string>("SELECT StorageKey FROM rec.MeetingRecordings WHERE PublicId = @r", new { r }).Result;

        // Retention not configured: nothing happens, ever.
        await ResetPolicy(", ExpiryAction = 'DELETE', DualApprovalForDeletion = 0");
        await retention.RunOnceAsync(CancellationToken.None);
        Assert.Equal("COMPLETED", await Status(rec));
        Assert.Null(await fx.QueryAsync<DateTime?>("SELECT RetainUntilUtc FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec }));

        // Review only.
        await ResetPolicy(", RetentionDays = 5");
        await retention.RunOnceAsync(CancellationToken.None);
        Assert.NotNull(await fx.QueryAsync<DateTime?>("SELECT RetentionReviewUtc FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec }));
        Assert.Equal("COMPLETED", await Status(rec));

        // Legal hold (needs recordings.legalhold, granted to nobody by default; give it to a test role here).
        var super = await SignedIn("msuper@test.invalid");
        Assert.Equal(HttpStatusCode.Forbidden, (await host.PutAsync($"/api/v1/recordings/{rec}/legal-hold", new { hold = true, reason = "Dispute" })).StatusCode);
        await Exec("INSERT auth.RolePermissions (RoleId, PermissionId) SELECT r.RoleId, p.PermissionId FROM auth.Roles r, auth.Permissions p WHERE r.Code = 'SuperAdmin' AND p.Code IN ('recordings.legalhold', 'recordings.view.all') AND NOT EXISTS (SELECT 1 FROM auth.RolePermissions x WHERE x.RoleId = r.RoleId AND x.PermissionId = p.PermissionId)");
        try
        {
            super = await SignedIn("msuper@test.invalid"); // new session: permissions are loaded per request, but keep it explicit
            Assert.Equal(HttpStatusCode.BadRequest, (await super.PutAsync($"/api/v1/recordings/{rec}/legal-hold", new { hold = true, reason = "" })).StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await super.PutAsync($"/api/v1/recordings/{rec}/legal-hold", new { hold = true, reason = "Customer dispute 42" })).StatusCode);
            Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'RECORDING_LEGAL_HOLD_PLACED' AND EntityId = @id AND IsPrivileged = 1", new { id = rec.ToString() }));

            // Delete without dual approval: rec2 is purged at once, rec (legal hold) is untouched.
            await ResetPolicy(", RetentionDays = 5, ExpiryAction = 'DELETE', DualApprovalForDeletion = 0");
            var key2 = Key(rec2);
            await retention.RunOnceAsync(CancellationToken.None);
            Assert.Equal("PURGED", await Status(rec2));
            Assert.False(File.Exists(Path.Combine(fx.RecordingRoot, "library", key2)));
            Assert.Equal(1, await Count("SELECT COUNT(*) FROM rec.MeetingRecordings WHERE PublicId = @rec2 AND PurgedUtc IS NOT NULL", new { rec2 })); // row kept
            Assert.Equal("COMPLETED", await Status(rec));
            Assert.True(File.Exists(Path.Combine(fx.RecordingRoot, "library", Key(rec))));

            // Release the hold; archive.
            Assert.Equal(HttpStatusCode.NoContent, (await super.PutAsync($"/api/v1/recordings/{rec}/legal-hold", new { hold = false, reason = "Dispute closed" })).StatusCode);
            var archive = Path.Combine(fx.RecordingRoot, "archive");
            await ResetPolicy($", RetentionDays = 5, ExpiryAction = 'ARCHIVE', ArchiveLocation = N'{archive}'");
            var key = Key(rec);
            await retention.RunOnceAsync(CancellationToken.None);
            Assert.Equal("ARCHIVE", await fx.QueryAsync<string>("SELECT StorageTier FROM rec.MeetingRecordings WHERE PublicId = @rec", new { rec }));
            Assert.True(File.Exists(Path.Combine(archive, key)));
            Assert.False(File.Exists(Path.Combine(fx.RecordingRoot, "library", key)));
            // Still playable from the archive.
            var play = await Json(await host.PostAsync($"/api/v1/recordings/{rec}/play"));
            Assert.Equal(HttpStatusCode.OK, (await host.Http.GetAsync(play.GetProperty("url").GetString())).StatusCode);

            // Delete with dual approval: two different approvers holding a deletion-approver role.
            await ResetPolicy($", RetentionDays = 5, ExpiryAction = 'DELETE', DualApprovalForDeletion = 1, DeletionApproverRoles = N'[\"SuperAdmin\"]'");
            await retention.RunOnceAsync(CancellationToken.None);
            Assert.Equal("COMPLETED", await Status(rec));
            var deletion = await fx.QueryAsync<Guid>("SELECT x.PublicId FROM rec.RecordingDeletions x JOIN rec.MeetingRecordings r ON r.RecordingId = x.RecordingId WHERE r.PublicId = @rec AND x.[Status] = 'PENDING'", new { rec });
            var list = await Json(await super.Http.GetAsync("/api/v1/recordings/retention"));
            Assert.Contains(list.GetProperty("deletions").EnumerateArray(), d => d.GetProperty("id").GetGuid() == deletion && d.GetProperty("canDecide").GetBoolean());
            Assert.Equal(HttpStatusCode.Forbidden, (await host.PostAsync($"/api/v1/recordings/deletions/{deletion}/approve")).StatusCode);
            var first = await Json(await super.PostAsync($"/api/v1/recordings/deletions/{deletion}/approve"));
            Assert.Equal("PENDING", first.GetProperty("status").GetString());
            Assert.Equal(HttpStatusCode.Conflict, (await super.PostAsync($"/api/v1/recordings/deletions/{deletion}/approve")).StatusCode); // same person twice
            Assert.Equal("COMPLETED", await Status(rec));
            var second = await SignedIn("admin@test.invalid"); // a different SuperAdmin
            var done = await Json(await second.PostAsync($"/api/v1/recordings/deletions/{deletion}/approve"));
            Assert.Equal("EXECUTED", done.GetProperty("status").GetString());
            Assert.Equal("PURGED", await Status(rec));
            Assert.False(File.Exists(Path.Combine(archive, key)));
            Assert.Equal(2, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'RECORDING_PURGED'"));
            Assert.Equal(HttpStatusCode.Conflict, (await host.PostAsync($"/api/v1/recordings/{rec}/play")).StatusCode);
        }
        finally
        {
            await Exec("DELETE rp FROM auth.RolePermissions rp JOIN auth.Roles r ON r.RoleId = rp.RoleId JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE r.Code = 'SuperAdmin' AND p.Code IN ('recordings.legalhold', 'recordings.view.all')");
            await ResetPolicy();
        }
    }
}
