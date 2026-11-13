using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Integrations;
using OneInsure.Connect.Api.Recording;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// 12 Nov 2026 enhancement batch: the external integration API (API keys, isolation between portals, scopes, revocation, rate limits,
/// idempotency, PLVC with Prarambh Main ID, completion report with independent recording status, secure downloads, webhooks with
/// signatures, OpenAPI), the PLVC participant rows in the portal, date-wise recording keys and the no-idle-timeout session policy.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class IntegrationTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;
    Task<int> Count(string sql, object? p = null) => fx.QueryAsync<int>(sql, p);

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    HttpClient Ext(string? key)
    {
        var h = fx.Factory.CreateClient();
        if (key is not null) h.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return h;
    }

    async Task<(Guid Id, string Key)> NewIntegration(TestClient admin, string name, string[] scopes, int rate = 1000)
    {
        var r = await admin.PostAsync("/api/v1/admin/integrations", new { name, portalName = name + " web", description = "test", scopes, rateLimitPerMinute = rate });
        Assert.True(r.StatusCode == HttpStatusCode.Created, await r.Content.ReadAsStringAsync());
        var j = await Json(r);
        return (j.GetProperty("integration").GetProperty("id").GetGuid(), j.GetProperty("apiKey").GetString()!);
    }

    static object Plvc(string? prarambh, string host = "mavail@test.invalid", string type = "INSTANT", DateTimeOffset? start = null) => new
    {
        category = "Customer-PLVC", meetingType = type, meetingTitle = "PLVC call", prarambhMainId = prarambh, host = new { email = host },
        participants = new[] { new { name = "Kavya Customer", email = "kavya.customer@test.invalid" }, new { name = "Arun Nominee", email = "arun.nominee@test.invalid" } },
        startTime = start, durationMinutes = 30, externalReference = "PORTAL-REF-1",
    };

    [Fact]
    public async Task Integrations_are_isolated_scoped_revocable_rate_limited_and_idempotent()
    {
        var admin = await SignedIn("admin@test.invalid");
        var (aId, aKey) = await NewIntegration(admin, "Portal A " + Guid.NewGuid().ToString("N")[..6], IntegrationScopes.All);
        var (_, bKey) = await NewIntegration(admin, "Portal B " + Guid.NewGuid().ToString("N")[..6], [IntegrationScopes.MeetingCreate, IntegrationScopes.MeetingRead], rate: 5);
        // Only a hash is stored, never the key.
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.ApiKeys WHERE KeyPrefix = @k", new { k = aKey }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.ApiKeys WHERE SecretHash = HASHBYTES('SHA2_256', CAST(@k AS VARCHAR(200)))", new { k = aKey }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'INTEGRATION_CREATED' AND EntityId = @id", new { id = aId.ToString() }));
        // Employees without integrations.manage cannot manage integrations.
        Assert.Equal(HttpStatusCode.Forbidden, (await (await SignedIn("mhost@test.invalid")).Http.GetAsync("/api/v1/admin/integrations")).StatusCode);

        // Authentication.
        Assert.Equal(HttpStatusCode.Unauthorized, (await Ext(null).GetAsync("/api/ext/v1/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Ext("oic_live_0123456789abcdef_" + new string('x', 43)).GetAsync("/api/ext/v1/me")).StatusCode);
        var a = Ext(aKey);
        var me = await Json(await a.GetAsync("/api/ext/v1/me"));
        Assert.StartsWith("INT-", me.GetProperty("integrationId").GetString());
        Assert.Equal(IntegrationScopes.All.Length, me.GetProperty("scopes").GetArrayLength());

        // PLVC: Prarambh Main ID mandatory and digits only; not allowed on other categories.
        var noId = await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc(null));
        Assert.Equal(HttpStatusCode.BadRequest, noId.StatusCode);
        Assert.True((await Json(noId)).GetProperty("errors").TryGetProperty("prarambhMainId", out _));
        Assert.Equal(HttpStatusCode.BadRequest, (await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("12AB34"))).StatusCode);
        var general = await a.PostAsJsonAsync("/api/ext/v1/meetings", new { category = "INTERNAL", meetingType = "INSTANT", prarambhMainId = "123", host = new { email = "mavail@test.invalid" } });
        Assert.Equal(HttpStatusCode.BadRequest, general.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("123", host: "nobody@test.invalid"))).StatusCode);

        // Create (instant PLVC) - first participant becomes the customer, everyone gets a personal join link.
        var created = await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("123456789"));
        Assert.True(created.StatusCode == HttpStatusCode.Created, await created.Content.ReadAsStringAsync());
        var m = await Json(created);
        var code = m.GetProperty("meetingId").GetString()!;
        Assert.StartsWith("OIC-", code);
        Assert.Equal("123456789", m.GetProperty("prarambhMainId").GetString());
        Assert.Equal("CUSTOMER_PLVC", m.GetProperty("category").GetString());
        Assert.Equal("PORTAL-REF-1", m.GetProperty("externalReference").GetString());
        Assert.Contains("/m/", m.GetProperty("meetingLink").GetString());
        var people = m.GetProperty("participants").EnumerateArray().ToList();
        Assert.Contains(people, p => p.GetProperty("type").GetString() == "CUSTOMER" && p.GetProperty("joinUrl").GetString()!.Contains("/join/"));
        Assert.Contains(people, p => p.GetProperty("type").GetString() == "GUEST" && p.GetProperty("joinUrl").GetString()!.Contains("/join/"));
        var mid = await fx.QueryAsync<long>("SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = @code", new { code });
        Assert.Equal(1, await Count("""
            SELECT COUNT(*) FROM mtg.Meetings m JOIN app.ApiIntegrations i ON i.IntegrationId = m.IntegrationId JOIN crm.Customers c ON c.CustomerId = m.CustomerId
            WHERE m.MeetingId = @mid AND i.PublicId = @aId AND m.PrarambhMainId = '123456789' AND c.Email = N'kavya.customer@test.invalid' AND c.ReferenceNumber = '123456789'
            """, new { mid, aId }));

        // Idempotency: same key + body → the same meeting (replayed); same key + other body → 422.
        var req1 = new HttpRequestMessage(HttpMethod.Post, "/api/ext/v1/meetings") { Content = JsonContent.Create(Plvc("555")) };
        req1.Headers.Add("Idempotency-Key", "order-42");
        var first = await Json(await a.SendAsync(req1));
        var req2 = new HttpRequestMessage(HttpMethod.Post, "/api/ext/v1/meetings") { Content = JsonContent.Create(Plvc("555")) };
        req2.Headers.Add("Idempotency-Key", "order-42");
        var again = await a.SendAsync(req2);
        Assert.Equal("true", again.Headers.GetValues("Idempotent-Replayed").Single());
        Assert.Equal(first.GetProperty("meetingId").GetString(), (await Json(again)).GetProperty("meetingId").GetString());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE PrarambhMainId = '555'"));
        var req3 = new HttpRequestMessage(HttpMethod.Post, "/api/ext/v1/meetings") { Content = JsonContent.Create(Plvc("556")) };
        req3.Headers.Add("Idempotency-Key", "order-42");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await a.SendAsync(req3)).StatusCode);

        // Read, list by external reference.
        var got = await Json(await a.GetAsync($"/api/ext/v1/meetings/{code}"));
        Assert.Equal("Scheduled", got.GetProperty("status").GetString());
        var list = await Json(await a.GetAsync("/api/ext/v1/meetings?externalReference=PORTAL-REF-1"));
        Assert.True(list.GetProperty("total").GetInt32() >= 2);

        // Isolation: Portal B cannot see, report on or download Portal A's meeting; missing scopes are refused.
        var b = Ext(bKey);
        Assert.Equal(HttpStatusCode.NotFound, (await b.GetAsync($"/api/ext/v1/meetings/{code}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await b.GetAsync($"/api/ext/v1/meetings/{m.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.Equal("INSUFFICIENT_SCOPE", await Code(await b.GetAsync($"/api/ext/v1/meetings/{code}/report")));
        Assert.Equal("INSUFFICIENT_SCOPE", await Code(await b.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("777", type: "SCHEDULED", start: DateTimeOffset.UtcNow.AddDays(3)))));
        Assert.DoesNotContain(code, await (await b.GetAsync("/api/ext/v1/meetings")).Content.ReadAsStringAsync());

        // Rate limit per integration (B: 5 per minute; 5 calls were made above, so the 6th is refused).
        Assert.Equal(HttpStatusCode.TooManyRequests, (await b.GetAsync("/api/ext/v1/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await a.GetAsync("/api/ext/v1/me")).StatusCode); // A is unaffected

        // Scheduled meeting (needs meeting.schedule; A has it): participants receive invitation e-mails.
        var start = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(4).AddHours(5).AddMinutes(30), TimeSpan.Zero);
        var sched = await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("424242", type: "SCHEDULED", start: start));
        Assert.True(sched.StatusCode == HttpStatusCode.Created, await sched.Content.ReadAsStringAsync());
        var sm = await Json(sched);
        Assert.Equal("Scheduled", sm.GetProperty("status").GetString());
        Assert.Equal(start, sm.GetProperty("startTime").GetDateTimeOffset());
        Assert.True(await Count("SELECT COUNT(*) FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.MeetingCode = @c AND o.ToAddress IN (N'kavya.customer@test.invalid', N'arun.nominee@test.invalid')",
            new { c = sm.GetProperty("meetingId").GetString() }) >= 2);
        // Cancel.
        Assert.Equal(HttpStatusCode.BadRequest, (await a.PostAsJsonAsync($"/api/ext/v1/meetings/{sm.GetProperty("meetingId").GetString()}/cancel", new { reason = "" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await a.PostAsJsonAsync($"/api/ext/v1/meetings/{sm.GetProperty("meetingId").GetString()}/cancel", new { reason = "Customer rescheduling" })).StatusCode);
        Assert.Equal("Cancelled", (await Json(await a.GetAsync($"/api/ext/v1/meetings/{sm.GetProperty("meetingId").GetString()}"))).GetProperty("status").GetString());

        // Request log.
        Assert.True(await Count("SELECT COUNT(*) FROM app.ApiRequestLog l JOIN app.ApiIntegrations i ON i.IntegrationId = l.IntegrationId WHERE i.PublicId = @aId", new { aId }) >= 10);
        Assert.True(await Count("SELECT COUNT(*) FROM app.ApiRequestLog WHERE StatusCode = 429") >= 1);

        // Revocation is immediate; rotation issues a working key and revokes the old ones.
        var detail = await Json(await admin.Http.GetAsync($"/api/v1/admin/integrations/{aId}"));
        var keyId = detail.GetProperty("keys")[0].GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/v1/admin/integrations/{aId}/keys/{keyId}/revoke", new { reason = "Leaked in a test" })).StatusCode);
        Assert.Equal("KEY_REVOKED", await Code(await a.GetAsync("/api/ext/v1/me")));
        var rotated = await Json(await admin.PostAsync($"/api/v1/admin/integrations/{aId}/keys/rotate"));
        Assert.Equal(HttpStatusCode.OK, (await Ext(rotated.GetProperty("apiKey").GetString()).GetAsync("/api/ext/v1/me")).StatusCode);
        // Deactivating the integration blocks every key.
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsync($"/api/v1/admin/integrations/{aId}", new { isActive = false })).StatusCode);
        Assert.Equal("INTEGRATION_INACTIVE", await Code(await Ext(rotated.GetProperty("apiKey").GetString()).GetAsync("/api/ext/v1/me")));
    }

    [Fact]
    public async Task Completion_report_keeps_recording_status_separate_and_downloads_are_signed_and_isolated()
    {
        var admin = await SignedIn("admin@test.invalid");
        var (_, key) = await NewIntegration(admin, "Portal R " + Guid.NewGuid().ToString("N")[..6], IntegrationScopes.All);
        var (_, otherKey) = await NewIntegration(admin, "Portal S " + Guid.NewGuid().ToString("N")[..6], IntegrationScopes.All);
        var a = Ext(key);
        var m = await Json(await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("987654321")));
        var code = m.GetProperty("meetingId").GetString()!;
        var mid = await fx.QueryAsync<long>("SELECT MeetingId FROM mtg.Meetings WHERE MeetingCode = @code", new { code });

        var report = await Json(await a.GetAsync($"/api/ext/v1/meetings/{code}/report"));
        Assert.Equal("Scheduled", report.GetProperty("meeting").GetProperty("status").GetString());
        Assert.False(report.GetProperty("meeting").GetProperty("completed").GetBoolean());
        Assert.Equal("NotStarted", report.GetProperty("recording").GetProperty("status").GetString());

        // The meeting ran (attendance) and ended; the recording is still being processed.
        var start = DateTime.UtcNow.AddMinutes(-40);
        await Exec("""
            UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualStartUtc = @start, ActualEndUtc = DATEADD(MINUTE, 35, @start) WHERE MeetingId = @mid;
            INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, LeftUtc)
            SELECT @mid, ParticipantId, DATEADD(MINUTE, 1, @start), DATEADD(MINUTE, 35, @start) FROM mtg.MeetingParticipants WHERE MeetingId = @mid AND ParticipantType = 'CUSTOMER';
            INSERT rec.MeetingRecordings (MeetingId, OwnerEmployeeId, [Status], StartedUtc, EndedUtc, PrarambhMainId)
            SELECT MeetingId, HostEmployeeId, 'PROCESSING', DATEADD(MINUTE, 2, @start), DATEADD(MINUTE, 35, @start), PrarambhMainId FROM mtg.Meetings WHERE MeetingId = @mid;
            """, new { mid, start });
        report = await Json(await a.GetAsync($"/api/ext/v1/meetings/{code}/report"));
        Assert.Equal("Completed", report.GetProperty("meeting").GetProperty("status").GetString());
        Assert.Equal(35, report.GetProperty("meeting").GetProperty("durationMinutes").GetInt32());
        Assert.Equal("987654321", report.GetProperty("meeting").GetProperty("prarambhMainId").GetString());
        Assert.Equal("Processing", report.GetProperty("recording").GetProperty("status").GetString());
        Assert.False(report.GetProperty("recording").GetProperty("downloadAvailable").GetBoolean());
        var customer = report.GetProperty("participants").EnumerateArray().Single(p => p.GetProperty("type").GetString() == "CUSTOMER");
        Assert.Equal("kavya.customer@test.invalid", customer.GetProperty("email").GetString());
        Assert.Equal(34 * 60, customer.GetProperty("attendedSeconds").GetInt32());
        Assert.EndsWith("+05:30", customer.GetProperty("joinedAt").GetString());
        var recId = report.GetProperty("recording").GetProperty("recordingId").GetString()!;
        Assert.Equal("RECORDING_NOT_READY", await Code(await a.PostAsync($"/api/ext/v1/meetings/{code}/recordings/{recId}/download-link", null)));

        // Failed.
        await Exec("UPDATE rec.MeetingRecordings SET [Status] = 'FAILED', FailureReason = N'test' WHERE PublicId = @recId", new { recId });
        Assert.Equal("Failed", (await Json(await a.GetAsync($"/api/ext/v1/meetings/{code}/report"))).GetProperty("recording").GetProperty("status").GetString());

        // Completed: a file in the library under the date-wise key.
        var bytes = Encoding.ASCII.GetBytes(string.Concat(Enumerable.Repeat("OIC-TEST-MP4-", 400)));
        var storageKey = RecordingStorageKeys.Build(DateTime.UtcNow, code, 1, "987654321", 900 + (int)(mid % 50));
        var path = Path.Combine(fx.RecordingRoot, "library", storageKey);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, bytes);
        await Exec("""
            UPDATE rec.MeetingRecordings SET [Status] = 'COMPLETED', FailureReason = NULL, StorageKey = @storageKey, FileSizeBytes = @size, Sha256 = @sha, VerifiedUtc = SYSUTCDATETIME(),
                DurationSeconds = 1980 WHERE PublicId = @recId
            """, new { storageKey, size = bytes.Length, sha = SHA256.HashData(bytes), recId });
        var recs = await Json(await a.GetAsync($"/api/ext/v1/meetings/{code}/recordings"));
        var rec = recs.GetProperty("recordings")[0];
        Assert.Equal("Completed", rec.GetProperty("status").GetString());
        Assert.StartsWith("987654321-" + code, rec.GetProperty("fileName").GetString());
        Assert.DoesNotContain(fx.RecordingRoot, await (await a.GetAsync($"/api/ext/v1/meetings/{code}/recordings")).Content.ReadAsStringAsync()); // no server paths

        // Another portal cannot get a link for it.
        Assert.Equal(HttpStatusCode.NotFound, (await Ext(otherKey).PostAsync($"/api/ext/v1/meetings/{code}/recordings/{recId}/download-link", null)).StatusCode);
        var link = await Json(await a.PostAsync($"/api/ext/v1/meetings/{code}/recordings/{recId}/download-link", null));
        var url = new Uri(link.GetProperty("url").GetString()!).PathAndQuery;
        var anonymous = fx.Factory.CreateClient(); // the link itself is the authorisation
        var file = await anonymous.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        Assert.Equal(bytes, await file.Content.ReadAsByteArrayAsync());
        var range = new HttpRequestMessage(HttpMethod.Get, url);
        range.Headers.Range = new RangeHeaderValue(0, 9);
        Assert.Equal(HttpStatusCode.PartialContent, (await anonymous.SendAsync(range)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await anonymous.GetAsync(url[..^4] + "AAAA")).StatusCode); // tampered
        Assert.True(await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'RECORDING_DOWNLOADED' AND EntityId = @recId", new { recId }) >= 1);

        // Deleted (manually): 410.
        await Exec("UPDATE rec.MeetingRecordings SET [Status] = 'PURGED', PurgedUtc = SYSUTCDATETIME() WHERE PublicId = @recId", new { recId });
        Assert.Equal(HttpStatusCode.Gone, (await a.PostAsync($"/api/ext/v1/meetings/{code}/recordings/{recId}/download-link", null)).StatusCode);
        Assert.Equal("Deleted", (await Json(await a.GetAsync($"/api/ext/v1/meetings/{code}/report"))).GetProperty("recording").GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.Gone, (await anonymous.GetAsync(url)).StatusCode);
    }

    [Fact]
    public async Task Webhooks_are_signed_delivered_once_and_retried_on_failure()
    {
        var admin = await SignedIn("admin@test.invalid");
        var (iid, key) = await NewIntegration(admin, "Portal W " + Guid.NewGuid().ToString("N")[..6], IntegrationScopes.All);
        var a = Ext(key);
        var port = FreePort();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://localhost:{port}/hook/");
        listener.Start();
        var received = new List<(string Event, string Sig, string Body)>();
        var loop = Task.Run(async () =>
        {
            while (listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = await listener.GetContextAsync(); } catch (Exception) { break; }
                using var sr = new StreamReader(ctx.Request.InputStream);
                var body = await sr.ReadToEndAsync();
                lock (received) received.Add((ctx.Request.Headers["X-OIC-Event"]!, ctx.Request.Headers["X-OIC-Signature"]!, body));
                ctx.Response.StatusCode = 200;
                ctx.Response.Close();
            }
        });

        Assert.Equal(HttpStatusCode.BadRequest, (await a.PutAsJsonAsync("/api/ext/v1/webhook", new { url = "ftp://example.test/x" })).StatusCode);
        var put = await Json(await a.PutAsJsonAsync("/api/ext/v1/webhook", new { url = $"http://localhost:{port}/hook/", events = IntegrationEventTypes.All }));
        var secret = put.GetProperty("secret").GetString()!;
        Assert.StartsWith("whsec_", secret);
        Assert.False((await Json(await a.GetAsync("/api/ext/v1/webhook"))).TryGetProperty("secret", out var s) && s.ValueKind == JsonValueKind.String); // never shown again

        var worker = fx.Factory.Services.GetRequiredService<WebhookWorker>();
        Assert.Equal(HttpStatusCode.OK, (await a.PostAsync("/api/ext/v1/webhook/test", null)).StatusCode);
        var m = await Json(await a.PostAsJsonAsync("/api/ext/v1/meetings", Plvc("31337")));
        var code = m.GetProperty("meetingId").GetString()!;
        await Exec("UPDATE mtg.Meetings SET [Status] = 'LIVE', ActualStartUtc = SYSUTCDATETIME() WHERE MeetingCode = @code", new { code });
        await worker.RunOnceAsync(CancellationToken.None);
        await worker.RunOnceAsync(CancellationToken.None); // a second pass must not duplicate anything
        await Task.Delay(300);
        List<(string Event, string Sig, string Body)> got;
        lock (received) got = received.ToList();
        Assert.Contains(got, r => r.Event == "webhook.test");
        Assert.Single(got, r => r.Event == "meeting.created");
        Assert.Single(got, r => r.Event == "meeting.started");
        foreach (var r in got)
        {
            var parts = r.Sig.Split(',').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
            Assert.Equal(WebhookWorker.Sign(secret, parts["t"], r.Body), parts["v1"]); // receivers can verify
            Assert.DoesNotContain("kavya", r.Body, StringComparison.OrdinalIgnoreCase); // no personal data in payloads
        }
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.WebhookDeliveries d JOIN app.ApiIntegrations i ON i.IntegrationId = d.IntegrationId WHERE i.PublicId = @iid AND d.EventType = 'meeting.started' AND d.[Status] = 'DELIVERED'", new { iid }));

        // Receiver down: the delivery stays PENDING with the error and a later retry time; the admin can see it.
        listener.Stop();
        await Exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = SYSUTCDATETIME() WHERE MeetingCode = @code", new { code });
        await worker.RunOnceAsync(CancellationToken.None);
        var failed = await fx.QueryAsync<(string Status, int Attempts, string? LastError)>(
            "SELECT [Status], Attempts, LastError FROM app.WebhookDeliveries d JOIN app.ApiIntegrations i ON i.IntegrationId = d.IntegrationId WHERE i.PublicId = @iid AND d.EventType = 'meeting.completed'", new { iid });
        Assert.Equal("PENDING", failed.Status);
        Assert.Equal(1, failed.Attempts);
        Assert.False(string.IsNullOrEmpty(failed.LastError));
        var deliveries = await Json(await admin.Http.GetAsync($"/api/v1/admin/integrations/{iid}/webhook/deliveries"));
        Assert.Contains(deliveries.GetProperty("items").EnumerateArray(), d => d.GetProperty("eventType").GetString() == "meeting.completed" && d.GetProperty("attempts").GetInt32() == 1);
        await loop.WaitAsync(TimeSpan.FromSeconds(5)).ContinueWith(_ => { });
    }

    static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    [Fact]
    public async Task OpenApi_document_lists_only_the_external_endpoints()
    {
        // V025: only for people with the API Documentation page (api.docs.view) or integration admins - not anonymous, not employees.
        Assert.Equal(HttpStatusCode.Unauthorized, (await fx.Factory.CreateClient().GetAsync("/api/ext/openapi/ext-v1.json")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await (await SignedIn("mthird@test.invalid")).Http.GetAsync("/api/ext/openapi/ext-v1.json")).StatusCode);
        var r = await (await SignedIn("admin@test.invalid")).Http.GetAsync("/api/ext/openapi/ext-v1.json");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var text = await r.Content.ReadAsStringAsync();
        var doc = JsonDocument.Parse(text).RootElement;
        Assert.StartsWith("3.", doc.GetProperty("openapi").GetString());
        var paths = doc.GetProperty("paths").EnumerateObject().Select(p => p.Name).ToList();
        foreach (var p in new[] { "/api/ext/v1/meetings", "/api/ext/v1/meetings/{meetingId}", "/api/ext/v1/meetings/{meetingId}/report", "/api/ext/v1/meetings/{meetingId}/recordings",
                     "/api/ext/v1/meetings/{meetingId}/recordings/{recordingId}/download-link", "/api/ext/v1/webhook", "/api/ext/v1/me" })
            Assert.Contains(p, paths);
        Assert.DoesNotContain(paths, p => p.StartsWith("/api/v1/", StringComparison.Ordinal)); // internal/admin APIs are never published
        Assert.True(doc.GetProperty("components").GetProperty("securitySchemes").TryGetProperty("ApiKey", out _));
        Assert.Contains("prarambhMainId", text);
    }

    [Fact]
    public void Recording_keys_are_date_wise_in_IST_and_PLVC_files_start_with_the_Prarambh_ID()
    {
        // 20:00 UTC on 12 Nov = 01:30 IST on 13 Nov: the IST date decides the folder.
        Assert.Equal("20261113/123456789-OIC-261112-ABCD-REC17.mp4", RecordingStorageKeys.Build(new DateTime(2026, 11, 12, 20, 0, 0, DateTimeKind.Utc), "OIC-261112-ABCD", 17, "123456789"));
        Assert.Equal("20261112/OIC-261112-ABCD-REC18.mp4", RecordingStorageKeys.Build(new DateTime(2026, 11, 12, 5, 0, 0, DateTimeKind.Utc), "OIC-261112-ABCD", 18, null));
        Assert.Equal("20261112/OIC-261112-ABCD-REC18-2.mp4", RecordingStorageKeys.Build(new DateTime(2026, 11, 12, 5, 0, 0, DateTimeKind.Utc), "OIC-261112-ABCD", 18, null, 2));
        // Anything that is not a valid Prarambh ID is never put in a file name; the meeting code is sanitised.
        Assert.Equal("20261112/OIC-261112-ABCD-REC19.mp4", RecordingStorageKeys.Build(new DateTime(2026, 11, 12, 5, 0, 0, DateTimeKind.Utc), "OIC-261112-ABCD", 19, "../evil"));
        Assert.Equal("20261112/OIC-261112ABCD-REC20.mp4", RecordingStorageKeys.Build(new DateTime(2026, 11, 12, 5, 0, 0, DateTimeKind.Utc), "OIC-261112/../ABCD", 20, null));
    }

    [Fact]
    public async Task Portal_PLVC_meetings_take_participant_rows_and_a_digits_only_Prarambh_ID()
    {
        var host = await SignedIn("mavail@test.invalid");
        var missing = await Json(await host.PostAsync("/api/v1/meetings/instant", new { category = "CUSTOMER_PLVC", participants = new[] { new { name = "C", email = "c@test.invalid" } } }));
        Assert.True(missing.GetProperty("errors").TryGetProperty("prarambhMainId", out _));
        var letters = await Json(await host.PostAsync("/api/v1/meetings/instant", new { category = "CUSTOMER_PLVC", prarambhMainId = "PR-1", participants = new[] { new { name = "C", email = "c@test.invalid" } } }));
        Assert.True(letters.GetProperty("errors").TryGetProperty("prarambhMainId", out _));
        var dup = await Json(await host.PostAsync("/api/v1/meetings/instant", new { category = "CUSTOMER_PLVC", prarambhMainId = "1", participants = new[] { new { name = "C", email = "c@test.invalid" }, new { name = "D", email = "C@test.invalid" } } }));
        Assert.True(dup.GetProperty("errors").TryGetProperty("participants[1].email", out _));
        var internalWithId = await Json(await host.PostAsync("/api/v1/meetings/instant", new { category = "GROUP", prarambhMainId = "1" }));
        Assert.True(internalWithId.GetProperty("errors").TryGetProperty("prarambhMainId", out _));

        var ok = await host.PostAsync("/api/v1/meetings/instant", new
        {
            category = "CUSTOMER_PLVC", prarambhMainId = "000123", waitingRoomEnabled = false,
            participants = new[] { new { name = "Zoya Customer", email = "zoya.customer@test.invalid" }, new { name = "Yash Guest", email = "yash.guest@test.invalid" } },
        });
        Assert.True(ok.StatusCode == HttpStatusCode.Created, await ok.Content.ReadAsStringAsync());
        var j = await Json(ok);
        Assert.Equal("000123", j.GetProperty("prarambhMainId").GetString()); // stored exactly, leading zeros kept
        Assert.Equal("Zoya Customer", j.GetProperty("customer").GetProperty("name").GetString());
        Assert.Equal(2, j.GetProperty("participants").GetArrayLength());
        var id = j.GetProperty("id").GetGuid();
        var detail = await Json(await host.Http.GetAsync($"/api/v1/meetings/{id}"));
        Assert.Equal("000123", detail.GetProperty("prarambhMainId").GetString());
        // A second PLVC meeting for the same customer e-mail reuses the customer record.
        await host.PostAsync("/api/v1/meetings/instant", new { category = "CUSTOMER_PLVC", prarambhMainId = "000124", participants = new[] { new { name = "Zoya C.", email = "zoya.customer@test.invalid" } } });
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM crm.Customers WHERE Email = N'zoya.customer@test.invalid'"));
        // Guests and customers may present (screen share in every meeting).
        Assert.Equal(2, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants p JOIN mtg.Meetings m ON m.MeetingId = p.MeetingId WHERE m.PublicId = @id AND p.ParticipantType IN ('CUSTOMER', 'GUEST') AND p.CanScreenShare = 1", new { id }));
        // A PLVC meeting cannot switch category (it carries a Prarambh ID).
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE PublicId = @id AND PrarambhMainId = '000123' AND Category = 'CUSTOMER_PLVC'", new { id }));
    }

    [Fact]
    public async Task Skipped_PLVC_details_create_an_unidentified_meeting_that_can_be_identified_later_and_the_API_needs_explicit_scope()
    {
        // V024 (13 Nov 2026). Portal: "Skip details & start meeting" - no ID invented, no customer, no participants, no e-mail.
        var host = await SignedIn("mavail@test.invalid");
        var bad = await host.PostAsync("/api/v1/meetings/instant", new { category = "GROUP", skipPlvcDetails = true });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var r = await host.PostAsync("/api/v1/meetings/instant", new
        {
            category = "CUSTOMER_PLVC", skipPlvcDetails = true, prarambhMainId = "999", // typed, then skipped: not used
            participants = new[] { new { name = "Half filled", email = "" } },
        });
        Assert.True(r.StatusCode == HttpStatusCode.Created, await r.Content.ReadAsStringAsync());
        var j = await Json(r);
        var id = j.GetProperty("id").GetGuid();
        Assert.Equal("UNIDENTIFIED", j.GetProperty("plvcIdentification").GetString());
        Assert.Equal(JsonValueKind.Null, j.GetProperty("prarambhMainId").ValueKind);
        Assert.Equal(0, j.GetProperty("participants").GetArrayLength());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE PublicId = @id AND PrarambhMainId IS NULL AND CustomerId IS NULL AND PlvcIdentification = 'UNIDENTIFIED'", new { id }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.PublicId = @id", new { id }));
        Assert.Equal("UNIDENTIFIED", (await Json(await host.Http.GetAsync($"/api/v1/meetings/{id}"))).GetProperty("plvcIdentification").GetString());
        // The database still refuses a SCHEDULED customer meeting without a customer.
        await Assert.ThrowsAsync<SqlException>(() => Exec("UPDATE mtg.Meetings SET MeetingKind = 'SCHEDULED' WHERE PublicId = @id", new { id }));

        // Reports separate the two states.
        var unident = await Json(await (await SignedIn("admin@test.invalid")).Http.GetAsync("/api/v1/reports/meetings?category=CUSTOMER_PLVC_UNIDENTIFIED&pageSize=100"));
        Assert.Contains(unident.GetProperty("page").GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        var ident = await Json(await (await SignedIn("admin@test.invalid")).Http.GetAsync("/api/v1/reports/meetings?category=CUSTOMER_PLVC_IDENTIFIED&pageSize=100"));
        Assert.DoesNotContain(ident.GetProperty("page").GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);

        // Authorised correction: validated, audited, never overwrites, someone else's meeting refused.
        var other = await SignedIn("mthird@test.invalid");
        Assert.Equal(HttpStatusCode.Forbidden, (await other.PostAsync($"/api/v1/meetings/{id}/prarambh", new { prarambhMainId = "4455" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await host.PostAsync($"/api/v1/meetings/{id}/prarambh", new { prarambhMainId = "44A5" })).StatusCode);
        var fix = await host.PostAsync($"/api/v1/meetings/{id}/prarambh", new { prarambhMainId = "4455" });
        Assert.True(fix.StatusCode == HttpStatusCode.OK, await fix.Content.ReadAsStringAsync());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE PublicId = @id AND PrarambhMainId = '4455' AND PlvcIdentification = 'IDENTIFIED'", new { id }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'MEETING_PRARAMBH_ADDED' AND EntityId = @id", new { id = id.ToString() }));
        Assert.Equal(HttpStatusCode.Conflict, (await host.PostAsync($"/api/v1/meetings/{id}/prarambh", new { prarambhMainId = "7777" })).StatusCode);

        // Normal instant PLVC: each participant is e-mailed their own link.
        var normal = await Json(await host.PostAsync("/api/v1/meetings/instant", new
        {
            category = "CUSTOMER_PLVC", prarambhMainId = "5566",
            participants = new[] { new { name = "Mail One", email = "mail.one@test.invalid" }, new { name = "Mail Two", email = "mail.two@test.invalid" } },
        }));
        Assert.Equal(2, await Count("SELECT COUNT(*) FROM app.EmailOutbox o JOIN mtg.Meetings m ON m.MeetingId = o.RelatedMeetingId WHERE m.PublicId = @id AND o.Template = 'MEETING_INSTANT_INVITED'",
            new { id = normal.GetProperty("id").GetGuid() }));

        // External API: UNIDENTIFIED must be asked for explicitly AND granted.
        var admin = await SignedIn("admin@test.invalid");
        var (_, plainKey) = await NewIntegration(admin, "NoUnident " + Guid.NewGuid().ToString("N")[..6], [IntegrationScopes.MeetingCreate]);
        var (_, fullKey) = await NewIntegration(admin, "Unident " + Guid.NewGuid().ToString("N")[..6], [IntegrationScopes.MeetingCreate, IntegrationScopes.PlvcUnidentified]);
        var body = new { category = "CUSTOMER_PLVC", meetingType = "INSTANT", plvcIdentification = "UNIDENTIFIED", host = new { email = "mavail@test.invalid" } };
        Assert.Equal(HttpStatusCode.Forbidden, (await Ext(plainKey).PostAsJsonAsync("/api/ext/v1/meetings", body)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Ext(fullKey).PostAsJsonAsync("/api/ext/v1/meetings",
            new { category = "CUSTOMER_PLVC", meetingType = "INSTANT", plvcIdentification = "UNIDENTIFIED", prarambhMainId = "1", host = new { email = "mavail@test.invalid" } })).StatusCode);
        var ext = await Ext(fullKey).PostAsJsonAsync("/api/ext/v1/meetings", body);
        Assert.True(ext.StatusCode == HttpStatusCode.Created, await ext.Content.ReadAsStringAsync());
        var e = await Json(ext);
        Assert.Equal("UNIDENTIFIED", e.GetProperty("plvcIdentification").GetString());
        Assert.Equal(JsonValueKind.Null, e.GetProperty("prarambhMainId").ValueKind);
        // Without the flag, the ID is still required.
        Assert.Equal(HttpStatusCode.BadRequest, (await Ext(fullKey).PostAsJsonAsync("/api/ext/v1/meetings", new { category = "CUSTOMER_PLVC", meetingType = "INSTANT", host = new { email = "mavail@test.invalid" } })).StatusCode);
    }

    [Fact]
    public async Task Sessions_have_no_idle_timeout_and_end_at_the_next_daily_logout()
    {
        var c = await SignedIn("mthird@test.invalid");
        var s = await Json(await c.Http.GetAsync("/api/v1/auth/session"));
        Assert.Equal(0, s.GetProperty("idleMinutes").GetInt32());
        var daily = s.GetProperty("dailyLogoutUtc").GetDateTime();
        Assert.Equal(daily, s.GetProperty("absoluteExpiryUtc").GetDateTime(), TimeSpan.FromSeconds(1));
        Assert.Equal(daily, s.GetProperty("idleExpiresUtc").GetDateTime(), TimeSpan.FromSeconds(1)); // no earlier idle cut-off
        var ist = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(daily, DateTimeKind.Utc), TimeZoneInfo.FindSystemTimeZoneById("India Standard Time"));
        Assert.Equal(new TimeSpan(23, 30, 0), ist.TimeOfDay);
        // Simulate 3 hours without any request: the session is still valid (it used to expire after 30 idle minutes).
        await Exec("UPDATE auth.UserSessions SET LastSeenUtc = DATEADD(HOUR, -3, SYSUTCDATETIME()), CreatedUtc = CASE WHEN CreatedUtc < DATEADD(HOUR, -3, SYSUTCDATETIME()) THEN CreatedUtc ELSE SYSUTCDATETIME() END WHERE UserId = (SELECT UserId FROM auth.Users WHERE Email = N'mthird@test.invalid') AND RevokedUtc IS NULL");
        Assert.Equal(HttpStatusCode.OK, (await c.Http.GetAsync("/api/v1/auth/me")).StatusCode);
    }
}
