using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Integrations;

/// <summary>
/// Outbound webhooks for external portals (Module 12).
/// <list type="number">
/// <item><b>Detect</b>: every few seconds, look at meetings created through an integration that has an active subscription and
/// enqueue one delivery per state change (meeting started/completed, participant joined/left, consent requested, recording
/// started/stopped/completed/failed). Each is keyed (IntegrationId, EventType, SourceRef) under a UNIQUE index, so a change is
/// enqueued exactly once however often it is seen - the meeting and recording code paths stay untouched.</item>
/// <item><b>Deliver</b>: POST the JSON with <c>X-OIC-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256(secret, "t.body")&gt;</c>; 2xx = delivered,
/// anything else retried with back-off (30 s → 6 h) up to WebhookMaxAttempts, then FAILED (visible in the admin delivery log).</item>
/// </list>
/// Payloads carry ids and statuses only - no names, e-mails or other personal data.
/// </summary>
public sealed class WebhookWorker(Db db, IClock clock, IHttpClientFactory http, IDataProtectionProvider dp, IOptions<IntegrationOptions> options,
    ILogger<WebhookWorker> log) : BackgroundService
{
    public const string SecretPurpose = "OneInsure.Connect.WebhookSecret.v1";
    public const string HttpClientName = "webhooks";
    static readonly int[] BackoffSeconds = [30, 120, 600, 1800, 7200, 21600];
    readonly IDataProtector secrets = dp.CreateProtector(SecretPurpose);
    IntegrationOptions O => options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RunOnceAsync(stoppingToken); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Webhook run failed"); }
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, O.WebhookPollSeconds)), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    public async Task<(int Detected, int Delivered, int Failed)> RunOnceAsync(CancellationToken ct)
    {
        var detected = await DetectAsync(ct);
        var (delivered, failed) = await DeliverAsync(ct);
        return (detected, delivered, failed);
    }

    // ---- Enqueue -----------------------------------------------------------------------------------------------------------

    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>Enqueue one event if the integration has an active subscription to it. Idempotent per (event type, sourceRef).</summary>
    public static async Task<bool> EnqueueAsync(IDbConnection c, long integrationId, string eventType, long? meetingId, string sourceRef, object data, string integrationCode,
        DateTime occurredUtc, IDbTransaction? tx = null)
    {
        var eventId = Guid.NewGuid();
        var payload = JsonSerializer.Serialize(new
        {
            eventId, eventType, occurredAt = ExternalApiEndpoints.ToIst(occurredUtc), integrationId = integrationCode, apiVersion = ExternalApiEndpoints.Version, data,
        }, Json);
        try
        {
            return await c.ExecuteAsync("""
                INSERT app.WebhookDeliveries (EventId, IntegrationId, SubscriptionId, EventType, MeetingId, SourceRef, PayloadJson)
                SELECT @eventId, s.IntegrationId, s.SubscriptionId, @eventType, @meetingId, @sourceRef, @payload
                FROM app.WebhookSubscriptions s JOIN app.ApiIntegrations i ON i.IntegrationId = s.IntegrationId
                WHERE s.IntegrationId = @integrationId AND s.IsActive = 1 AND i.IsActive = 1
                  AND (',' + s.Events + ',') LIKE '%,' + @eventType + ',%'
                  AND NOT EXISTS (SELECT 1 FROM app.WebhookDeliveries d WHERE d.IntegrationId = @integrationId AND d.EventType = @eventType AND d.SourceRef = @sourceRef)
                """, new { eventId, integrationId, eventType, meetingId, sourceRef, payload }, tx) > 0;
        }
        catch (SqlException e) when (e.IsUniqueViolation()) { return false; } // raced with another detector pass
    }

    public static async Task<Guid?> EnqueueTestAsync(IDbConnection c, long integrationId, string integrationCode, DateTime nowUtc)
    {
        var sub = await c.QuerySingleOrDefaultAsync<long?>("SELECT SubscriptionId FROM app.WebhookSubscriptions WHERE IntegrationId = @integrationId AND IsActive = 1", new { integrationId });
        if (sub is null) return null;
        var eventId = Guid.NewGuid();
        var payload = JsonSerializer.Serialize(new { eventId, eventType = "webhook.test", occurredAt = ExternalApiEndpoints.ToIst(nowUtc), integrationId = integrationCode,
            apiVersion = ExternalApiEndpoints.Version, data = new { message = "Test event from OneInsure Connect" } }, Json);
        await c.ExecuteAsync("""
            INSERT app.WebhookDeliveries (EventId, IntegrationId, SubscriptionId, EventType, SourceRef, PayloadJson) VALUES (@eventId, @integrationId, @sub, 'webhook.test', @src, @payload)
            """, new { eventId, integrationId, sub, src = $"test:{eventId:N}", payload });
        return eventId;
    }

    // ---- Detect --------------------------------------------------------------------------------------------------------------

    sealed record Candidate(long IntegrationId, string Code, DateTime SubscribedUtc, long MeetingId, string MeetingCode, string? ExternalReference, string Status,
        DateTime? ActualStartUtc, DateTime? ActualEndUtc, DateTime ModifiedUtc);

    async Task<int> DetectAsync(CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        // Meetings of integrations with an active subscription, recent enough to still change (30 days).
        var meetings = (await c.QueryAsync<Candidate>("""
            SELECT i.IntegrationId, i.IntegrationCode AS Code, s.CreatedUtc AS SubscribedUtc, m.MeetingId, m.MeetingCode, m.ExternalReference, m.[Status],
                   m.ActualStartUtc, m.ActualEndUtc, COALESCE(m.ModifiedUtc, m.CreatedUtc) AS ModifiedUtc
            FROM mtg.Meetings m JOIN app.ApiIntegrations i ON i.IntegrationId = m.IntegrationId AND i.IsActive = 1
            JOIN app.WebhookSubscriptions s ON s.IntegrationId = i.IntegrationId AND s.IsActive = 1
            WHERE m.IntegrationId IS NOT NULL AND m.CreatedUtc > DATEADD(DAY, -30, SYSUTCDATETIME())
            """)).ToList();
        var n = 0;
        foreach (var m in meetings)
        {
            if (m.ActualStartUtc is { } started && started >= m.SubscribedUtc.AddMinutes(-1))
                n += await Enq(m, IntegrationEventTypes.MeetingStarted, $"m:{m.MeetingId}", started, new { meetingId = m.MeetingCode, externalReference = m.ExternalReference, status = "Live", startTime = ExternalApiEndpoints.ToIst(started) });
            if (m.Status is "COMPLETED" or "INCOMPLETE")
            {
                var ended = m.ActualEndUtc ?? m.ModifiedUtc;
                n += await Enq(m, IntegrationEventTypes.MeetingCompleted, $"m:{m.MeetingId}", ended, new { meetingId = m.MeetingCode, externalReference = m.ExternalReference,
                    status = ExternalApiEndpoints.MeetingStatus(m.Status), endTime = ExternalApiEndpoints.ToIst(ended) });
            }
            if (m.ActualStartUtc is null) continue; // nothing below can exist before the meeting starts

            foreach (var a in await c.QueryAsync<(long AttendanceId, string Type, string Identity, DateTime JoinedUtc, DateTime? LeftUtc)>("""
                SELECT a.AttendanceId, p.ParticipantType, p.LiveKitIdentity, a.JoinedUtc, a.LeftUtc
                FROM mtg.MeetingAttendance a JOIN mtg.MeetingParticipants p ON p.ParticipantId = a.ParticipantId WHERE a.MeetingId = @id AND a.JoinedUtc >= @since
                """, new { id = m.MeetingId, since = m.SubscribedUtc.AddMinutes(-1) }))
            {
                var who = new { type = a.Type, participantRef = a.Identity };
                n += await Enq(m, IntegrationEventTypes.ParticipantJoined, $"a:{a.AttendanceId}", a.JoinedUtc, new { meetingId = m.MeetingCode, externalReference = m.ExternalReference, participant = who, joinedAt = ExternalApiEndpoints.ToIst(a.JoinedUtc) });
                if (a.LeftUtc is { } left)
                    n += await Enq(m, IntegrationEventTypes.ParticipantLeft, $"a:{a.AttendanceId}", left, new { meetingId = m.MeetingCode, externalReference = m.ExternalReference, participant = who, leftAt = ExternalApiEndpoints.ToIst(left) });
            }
            foreach (var q in await c.QueryAsync<(long RequestId, Guid PublicId, DateTime CreatedUtc)>(
                "SELECT RequestId, PublicId, CreatedUtc FROM rec.RecordingRequests WHERE MeetingId = @id AND CreatedUtc >= @since", new { id = m.MeetingId, since = m.SubscribedUtc.AddMinutes(-1) }))
                n += await Enq(m, IntegrationEventTypes.ConsentRequested, $"q:{q.RequestId}", q.CreatedUtc, new { meetingId = m.MeetingCode, externalReference = m.ExternalReference, requestId = q.PublicId });
            foreach (var r in await c.QueryAsync<(long RecordingId, Guid PublicId, string Status, DateTime? StartedUtc, DateTime? EndedUtc, DateTime CreatedUtc, DateTime? ModifiedUtc)>(
                "SELECT RecordingId, PublicId, [Status], StartedUtc, EndedUtc, CreatedUtc, ModifiedUtc FROM rec.MeetingRecordings WHERE MeetingId = @id AND CreatedUtc >= @since",
                new { id = m.MeetingId, since = m.SubscribedUtc.AddMinutes(-1) }))
            {
                object Rec(string status) => new { meetingId = m.MeetingCode, externalReference = m.ExternalReference, recordingId = r.PublicId, status };
                if (r.StartedUtc is { } rs) n += await Enq(m, IntegrationEventTypes.RecordingStarted, $"r:{r.RecordingId}", rs, Rec("Recording"));
                if (r.EndedUtc is { } re && r.Status is not "FAILED") n += await Enq(m, IntegrationEventTypes.RecordingStopped, $"r:{r.RecordingId}", re, Rec(ExternalApiEndpoints.RecordingStatus(r.Status)));
                if (r.Status is "COMPLETED" or "PURGED") n += await Enq(m, IntegrationEventTypes.RecordingCompleted, $"r:{r.RecordingId}", r.ModifiedUtc ?? r.CreatedUtc, Rec("Completed"));
                if (r.Status == "FAILED") n += await Enq(m, IntegrationEventTypes.RecordingFailed, $"r:{r.RecordingId}", r.ModifiedUtc ?? r.CreatedUtc, Rec("Failed"));
            }
        }
        return n;

        async Task<int> Enq(Candidate m, string type, string src, DateTime at, object data) =>
            await EnqueueAsync(c, m.IntegrationId, type, m.MeetingId, src, data, m.Code, at) ? 1 : 0;
    }

    // ---- Deliver -------------------------------------------------------------------------------------------------------------

    sealed record Due(long DeliveryId, Guid EventId, string EventType, string PayloadJson, int Attempts, string Url, string SecretProtected);

    async Task<(int Delivered, int Failed)> DeliverAsync(CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var now = clock.UtcNow;
        var due = (await c.QueryAsync<Due>("""
            UPDATE TOP (25) d SET LeaseUntilUtc = DATEADD(SECOND, 60, @now)
            OUTPUT inserted.DeliveryId, inserted.EventId, inserted.EventType, inserted.PayloadJson, inserted.Attempts, s.Url, s.SecretProtected
            FROM app.WebhookDeliveries d JOIN app.WebhookSubscriptions s ON s.SubscriptionId = d.SubscriptionId
            WHERE d.[Status] = 'PENDING' AND d.NextAttemptUtc <= @now AND (d.LeaseUntilUtc IS NULL OR d.LeaseUntilUtc < @now) AND s.IsActive = 1
            """, new { now })).ToList();
        int delivered = 0, failed = 0;
        foreach (var d in due)
        {
            int? status = null;
            string? error = null;
            try
            {
                var problem = await ExternalApiEndpoints.WebhookUrlProblemAsync(d.Url, O.AllowPrivateWebhookTargets);
                if (problem is not null) error = problem;
                else
                {
                    var ts = new DateTimeOffset(now).ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
                    var signature = Sign(secrets.Unprotect(d.SecretProtected), ts, d.PayloadJson);
                    using var req = new HttpRequestMessage(HttpMethod.Post, d.Url) { Content = new StringContent(d.PayloadJson, Encoding.UTF8, "application/json") };
                    req.Headers.Add("X-OIC-Event", d.EventType);
                    req.Headers.Add("X-OIC-Event-Id", d.EventId.ToString());
                    req.Headers.Add("X-OIC-Timestamp", ts);
                    req.Headers.Add("X-OIC-Signature", $"t={ts},v1={signature}");
                    req.Headers.UserAgent.ParseAdd("OneInsureConnect-Webhooks/1.0");
                    using var res = await http.CreateClient(HttpClientName).SendAsync(req, ct);
                    status = (int)res.StatusCode;
                    if (!res.IsSuccessStatusCode) error = $"HTTP {status}";
                }
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException or CryptographicException or InvalidOperationException)
            {
                error = e is TaskCanceledException ? "Timed out" : e.Message.Length > 300 ? e.Message[..300] : e.Message;
            }
            var attempts = d.Attempts + 1;
            if (error is null)
            {
                delivered++;
                await c.ExecuteAsync("""
                    UPDATE app.WebhookDeliveries SET [Status] = 'DELIVERED', Attempts = @attempts, LastAttemptUtc = @now, LastStatusCode = @status, LastError = NULL,
                        DeliveredUtc = @now, LeaseUntilUtc = NULL WHERE DeliveryId = @id
                    """, new { attempts, now, status, id = d.DeliveryId });
            }
            else
            {
                var giveUp = attempts >= Math.Max(1, O.WebhookMaxAttempts);
                if (giveUp) failed++;
                await c.ExecuteAsync("""
                    UPDATE app.WebhookDeliveries SET [Status] = @state, Attempts = @attempts, LastAttemptUtc = @now, LastStatusCode = @status, LastError = @error,
                        NextAttemptUtc = DATEADD(SECOND, @wait, @now), LeaseUntilUtc = NULL WHERE DeliveryId = @id
                    """, new { state = giveUp ? "FAILED" : "PENDING", attempts, now, status, error, wait = BackoffSeconds[Math.Min(attempts - 1, BackoffSeconds.Length - 1)], id = d.DeliveryId });
            }
        }
        return (delivered, failed);
    }

    /// <summary>Hex HMAC-SHA256 of "{timestamp}.{body}" with the subscription secret (documented for receivers).</summary>
    public static string Sign(string secret, string timestamp, string body) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{timestamp}.{body}")));
}
