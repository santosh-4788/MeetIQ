using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using OneInsure.Connect.Api.Meetings;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Phase 4 — video room: LiveKit token issuance (claims, TTL, permissions, joinable window), waiting room, host controls
/// (LiveKit RoomService mocked by FakeLiveKit), signed webhooks (attendance, idempotency, room lifecycle) and chat persistence.
/// Meetings are booked far ahead (no calendar clashes) and then moved to "now" with SQL.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class RoomTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;
    Task<int> Count(string sql, object? p = null) => fx.QueryAsync<int>(sql, p);
    Task<Guid> Emp(string code) => fx.QueryAsync<Guid>("SELECT PublicId FROM org.Employees WHERE EmployeeCode = @code", new { code });

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

    sealed record Booked(Guid Id, long Mid, string Room);

    /// <summary>Books on day +<paramref name="day"/> (500+, unused by other tests), then moves the meeting to start in <paramref name="startsInMinutes"/>.</summary>
    async Task<Booked> Book(TestClient host, int day, string title, Guid[]? employees = null, object[]? guests = null, bool waitingRoom = true,
        int startsInMinutes = 5, int durationMinutes = 30)
    {
        var start = DateTime.SpecifyKind(DateTime.UtcNow.Date.AddDays(day).AddHours(5), DateTimeKind.Utc);
        var r = await host.PostAsync("/api/v1/meetings", new
        {
            title, category = "TEAM", startUtc = start, endUtc = start.AddHours(1), employeeIds = employees ?? [], guests, status = "SCHEDULED",
            recordingPolicy = "NONE", waitingRoomEnabled = waitingRoom,
        });
        Assert.True(r.StatusCode == HttpStatusCode.Created, await r.Content.ReadAsStringAsync());
        var id = (await Json(r)).GetProperty("id").GetGuid();
        var mid = await fx.QueryAsync<long>("SELECT MeetingId FROM mtg.Meetings WHERE PublicId = @id", new { id });
        await Move(mid, startsInMinutes, durationMinutes);
        return new Booked(id, mid, await fx.QueryAsync<string>("SELECT LiveKitRoomName FROM mtg.Meetings WHERE MeetingId = @mid", new { mid }));
    }

    Task Move(long mid, int startsInMinutes, int durationMinutes) => Exec("""
        UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(MINUTE, @startsInMinutes, SYSUTCDATETIME()),
                                ScheduledEndUtc = DATEADD(MINUTE, @startsInMinutes + @durationMinutes, SYSUTCDATETIME()) WHERE MeetingId = @mid
        """, new { mid, startsInMinutes, durationMinutes });

    async Task<string> GuestToken(long mid, string email) =>
        Regex.Match(await fx.QueryAsync<string>("SELECT TOP (1) BodyHtml FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = @email ORDER BY OutboxId DESC",
            new { mid, email }), @"/join/([A-Za-z0-9_\-]+)").Groups[1].Value;

    static JsonElement Claims(string jwt) => JsonDocument.Parse(LiveKitTokens.FromB64(jwt.Split('.')[1])).RootElement;

    static bool SignedWithTestSecret(string jwt)
    {
        var p = jwt.Split('.');
        return LiveKitTokens.B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(ApiFixture.LiveKitSecret), Encoding.ASCII.GetBytes($"{p[0]}.{p[1]}"))) == p[2];
    }

    static string[] Sources(JsonElement claims) => claims.GetProperty("video").GetProperty("canPublishSources").EnumerateArray().Select(x => x.GetString()!).ToArray();

    // ---- Token issuance ------------------------------------------------------------------------------------------

    [Fact]
    public async Task Join_issues_short_lived_least_privilege_tokens_and_starts_the_meeting()
    {
        var host = await SignedIn("rhost@test.invalid");
        var peer = await SignedIn("rpeer@test.invalid");
        var outsider = await SignedIn("rout@test.invalid");
        var super = await SignedIn("msuper@test.invalid"); // meetings.view.all, but not a participant
        var m = await Book(host, 501, "Room token test", [await Emp("R-PEER")]);

        var detail = await Json(await peer.Http.GetAsync($"/api/v1/meetings/{m.Id}"));
        Assert.True(detail.GetProperty("join").GetProperty("joinable").GetBoolean());
        Assert.True(detail.GetProperty("my").GetProperty("canJoin").GetBoolean());
        Assert.False(detail.GetProperty("my").GetProperty("canHostRoom").GetBoolean());
        var superDetail = await Json(await super.Http.GetAsync($"/api/v1/meetings/{m.Id}"));
        Assert.Equal("NOT_PARTICIPANT", superDetail.GetProperty("join").GetProperty("reason").GetString());
        var dash = await Json(await peer.Http.GetAsync("/api/v1/dashboard/summary"));
        Assert.Contains(dash.GetProperty("todaySchedule").EnumerateArray().Concat(dash.GetProperty("upcoming").EnumerateArray()),
            x => x.GetProperty("id").GetString() == m.Id.ToString() && x.GetProperty("joinable").GetBoolean());

        // Attendee first: the meeting stays SCHEDULED until a host arrives.
        var r = await peer.PostAsync($"/api/v1/meetings/{m.Id}/join");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var body = await Json(r);
        var conn = body.GetProperty("connection");
        Assert.Equal(ApiFixture.LiveKitPublicUrl, conn.GetProperty("url").GetString());
        Assert.False(conn.GetProperty("isHost").GetBoolean());
        var peerIdentity = await fx.QueryAsync<string>("SELECT p.LiveKitIdentity FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = @mid AND e.EmployeeCode = 'R-PEER'", new { mid = m.Mid });
        var token = conn.GetProperty("token").GetString()!;
        Assert.True(SignedWithTestSecret(token));
        var claims = Claims(token);
        Assert.Equal(ApiFixture.LiveKitKey, claims.GetProperty("iss").GetString());
        Assert.Equal(peerIdentity, claims.GetProperty("sub").GetString());
        Assert.Equal("Riya Peer", claims.GetProperty("name").GetString());
        Assert.Equal("ATTENDEE", JsonDocument.Parse(claims.GetProperty("metadata").GetString()!).RootElement.GetProperty("role").GetString());
        var video = claims.GetProperty("video");
        Assert.Equal(m.Room, video.GetProperty("room").GetString());
        Assert.True(video.GetProperty("roomJoin").GetBoolean());
        Assert.True(video.GetProperty("canSubscribe").GetBoolean());
        Assert.True(video.GetProperty("canPublish").GetBoolean());
        Assert.True(video.GetProperty("canPublishData").GetBoolean());
        Assert.False(video.GetProperty("roomAdmin").GetBoolean());
        Assert.False(video.TryGetProperty("roomCreate", out _));
        Assert.Contains("screen_share", Sources(claims)); // employees get CanScreenShare = 1
        var ttl = claims.GetProperty("exp").GetInt64() - claims.GetProperty("iat").GetInt64();
        Assert.InRange(ttl, 9 * 60, 10 * 60);
        Assert.Equal("SCHEDULED", await fx.QueryAsync<string>("SELECT [Status] FROM mtg.Meetings WHERE MeetingId = @mid", new { mid = m.Mid }));

        // Host: roomAdmin, and the meeting goes LIVE with ActualStartUtc. The room is created on LiveKit with a server token.
        var h = await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/join"));
        Assert.True(h.GetProperty("connection").GetProperty("isHost").GetBoolean());
        Assert.Equal("LIVE", h.GetProperty("meeting").GetProperty("status").GetString());
        var hostClaims = Claims(h.GetProperty("connection").GetProperty("token").GetString()!);
        Assert.True(hostClaims.GetProperty("video").GetProperty("roomAdmin").GetBoolean());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE MeetingId = @mid AND [Status] = 'LIVE' AND ActualStartUtc IS NOT NULL", new { mid = m.Mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'MEETING_STARTED'", new { id = m.Id.ToString() }));
        Assert.Equal(2, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'MEETING_JOIN_TOKEN_ISSUED'", new { id = m.Id.ToString() }));
        var create = fx.LiveKit.For(m.Room).First(c => c.Method == "CreateRoom");
        Assert.StartsWith("Bearer ", create.Authorization);
        var admin = Claims(create.Authorization!["Bearer ".Length..]);
        Assert.Equal(m.Room, admin.GetProperty("video").GetProperty("room").GetString());
        Assert.True(create.Body.GetProperty("departure_timeout").GetInt32() > 20);

        // Not visible → 404; an administrator who can see every meeting but is not a participant → 403 (no silent entry).
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.PostAsync($"/api/v1/meetings/{m.Id}/join")).StatusCode);
        var adminJoin = await super.PostAsync($"/api/v1/meetings/{m.Id}/join");
        Assert.Equal(HttpStatusCode.Forbidden, adminJoin.StatusCode);
        // Anonymous → 401; missing XSRF header → 403 (CSRF protection still applies).
        Assert.Equal(HttpStatusCode.Unauthorized, (await (await fx.NewClientAsync()).PostAsync($"/api/v1/meetings/{m.Id}/join")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/join", withXsrf: false)).StatusCode);
    }

    [Fact]
    public async Task Join_window_and_meeting_state_are_enforced()
    {
        var host = await SignedIn("rhost@test.invalid");
        var m = await Book(host, 502, "Window test");

        await Move(m.Mid, 60, 30); // opens 15 minutes before the start
        var early = await host.PostAsync($"/api/v1/meetings/{m.Id}/join");
        Assert.Equal(HttpStatusCode.Conflict, early.StatusCode);
        var e = await Json(early);
        Assert.Equal("TOO_EARLY", e.GetProperty("reason").GetString());
        Assert.True(e.GetProperty("opensUtc").GetDateTime() > DateTime.UtcNow.AddMinutes(40));
        Assert.Equal("TOO_EARLY", (await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}"))).GetProperty("join").GetProperty("reason").GetString());

        await Move(m.Mid, -200, 60); // ended more than JoinLateMinutes (60) ago
        Assert.Equal("TOO_LATE", (await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/join"))).GetProperty("reason").GetString());

        await Move(m.Mid, -70, 60); // ended 10 minutes ago: still inside the grace period
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{m.Id}/join")).StatusCode);

        await Exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED', ActualEndUtc = SYSUTCDATETIME() WHERE MeetingId = @mid", new { mid = m.Mid });
        Assert.Equal("ENDED", (await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/join"))).GetProperty("reason").GetString());

        var c = await Book(host, 503, "Cancelled test");
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{c.Id}/cancel", new { reason = "Not needed" })).StatusCode);
        var cancelled = await host.PostAsync($"/api/v1/meetings/{c.Id}/join");
        Assert.Equal(HttpStatusCode.Conflict, cancelled.StatusCode);
        Assert.Equal("CANCELLED", (await Json(cancelled)).GetProperty("reason").GetString());

        var d = await Book(host, 504, "Draft test");
        await Exec("UPDATE mtg.Meetings SET [Status] = 'DRAFT' WHERE MeetingId = @mid", new { mid = d.Mid });
        Assert.Equal("DRAFT", (await Json(await host.PostAsync($"/api/v1/meetings/{d.Id}/join"))).GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Without_LiveKit_configuration_join_answers_503()
    {
        await using var factory = fx.Factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, cfg) =>
            cfg.AddInMemoryCollection(new Dictionary<string, string?> { ["LiveKit:ApiKey"] = "", ["LiveKit:ApiSecret"] = "" })));
        var jar = new CookieContainer();
        var http = factory.CreateDefaultClient(new Uri("http://localhost"), new Microsoft.AspNetCore.Mvc.Testing.Handlers.CookieContainerHandler(jar));
        var client = new TestClient(http, jar);
        (await http.GetAsync("/api/v1/health")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.OK, (await client.LoginAsync("rhost@test.invalid", Pw)).StatusCode);
        var host = await SignedIn("rhost@test.invalid");
        var m = await Book(host, 505, "No video service");
        var r = await client.PostAsync($"/api/v1/meetings/{m.Id}/join");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
        Assert.Equal("SERVICE_UNAVAILABLE", await Code(r));
        Assert.Equal("UNAVAILABLE", (await Json(await client.Http.GetAsync($"/api/v1/meetings/{m.Id}"))).GetProperty("join").GetProperty("reason").GetString());
    }

    // ---- Waiting room --------------------------------------------------------------------------------------------

    [Fact]
    public async Task Guests_wait_until_the_host_admits_or_rejects_them()
    {
        var host = await SignedIn("rhost@test.invalid");
        var peer = await SignedIn("rpeer@test.invalid");
        var m = await Book(host, 506, "Customer review", [await Emp("R-PEER")],
            guests: [new { name = "Gita Guest", email = "gita.room@test.invalid" }, new { name = "Uma Unwanted", email = "uma.room@test.invalid" }]);
        var gita = await fx.NewClientAsync();
        var gitaToken = await GuestToken(m.Mid, "gita.room@test.invalid");

        // The public page tells the guest the room is open and that a waiting room is on.
        var info = await Json(await gita.Http.GetAsync($"/api/v1/join/{gitaToken}"));
        Assert.True(info.GetProperty("joinableNow").GetBoolean());
        Assert.True(info.GetProperty("waitingRoom").GetBoolean());
        Assert.Equal("GUEST", info.GetProperty("participantType").GetString());

        var enter = await gita.PostAsync($"/api/v1/join/{gitaToken}/enter", new { displayName = "Gita G." });
        Assert.Equal(HttpStatusCode.Accepted, enter.StatusCode);
        var entered = await Json(enter);
        Assert.Equal("WAITING", entered.GetProperty("status").GetString());
        Assert.False(entered.TryGetProperty("connection", out _));
        var entryId = entered.GetProperty("entryId").GetString()!;
        Assert.DoesNotMatch(@"^\d+$", entryId); // opaque, not the row id
        // Entering again while waiting reuses the entry; the hosts were notified once (bell + live data message to the room).
        var again = await Json(await gita.PostAsync($"/api/v1/join/{gitaToken}/enter", new { displayName = "Gita G." }));
        Assert.Equal("WAITING", again.GetProperty("status").GetString());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.WaitingRoomEntries WHERE MeetingId = @mid AND [Status] = 'WAITING'", new { mid = m.Mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE n.MeetingId = @mid AND n.[Type] = 'ADMIT_REQUEST' AND u.Email = N'rhost@test.invalid' AND n.LinkPath = @link",
            new { mid = m.Mid, link = $"/meetings/{m.Id}/room" }));
        Assert.Contains(fx.LiveKit.For(m.Room), c => c.Method == "SendData" && c.Body.GetProperty("topic").GetString() == RoomEndpoints.WaitingTopic);

        Assert.Equal("WAITING", (await Json(await gita.Http.GetAsync($"/api/v1/join/{gitaToken}/entry/{entryId}"))).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await gita.Http.GetAsync($"/api/v1/join/{gitaToken}/chat")).StatusCode); // not in the meeting yet
        Assert.Equal(HttpStatusCode.NotFound, (await gita.Http.GetAsync($"/api/v1/join/{gitaToken}/entry/forged-entry-id")).StatusCode);

        // Only hosts see and decide; an attendee cannot.
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.Http.GetAsync($"/api/v1/meetings/{m.Id}/room/waiting")).StatusCode);
        var list = (await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/room/waiting"))).GetProperty("items");
        Assert.Equal(1, list.GetArrayLength());
        Assert.Equal("Gita Guest", list[0].GetProperty("name").GetString());
        var hostEntryId = list[0].GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/room/waiting/{hostEntryId}/admit")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/waiting/{hostEntryId}/admit")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/waiting/{hostEntryId}/admit")).StatusCode);

        // Admitted: the poll now carries the LiveKit connection — no roomAdmin, no screen share, the chosen name.
        var admitted = await Json(await gita.Http.GetAsync($"/api/v1/join/{gitaToken}/entry/{entryId}"));
        Assert.Equal("ADMITTED", admitted.GetProperty("status").GetString());
        var guestClaims = Claims(admitted.GetProperty("connection").GetProperty("token").GetString()!);
        Assert.False(guestClaims.GetProperty("video").GetProperty("roomAdmin").GetBoolean());
        Assert.True(guestClaims.GetProperty("video").GetProperty("canPublish").GetBoolean());
        Assert.DoesNotContain("screen_share", Sources(guestClaims));
        Assert.Equal("Gita G.", guestClaims.GetProperty("name").GetString());
        Assert.Equal(m.Room, guestClaims.GetProperty("video").GetProperty("room").GetString());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'WAITING_ROOM_ADMITTED'", new { id = m.Id.ToString() }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations i JOIN mtg.MeetingParticipants p ON p.ParticipantId = i.ParticipantId WHERE p.MeetingId = @mid AND p.GuestEmail = N'gita.room@test.invalid' AND i.UseCount = 2 AND i.LastUsedUtc IS NOT NULL", new { mid = m.Mid }));

        // Admitted guests may chat (persisted under their participant row).
        var chat = await gita.PostAsync($"/api/v1/join/{gitaToken}/chat?name=Gita%20G.", new { body = "Hello from the guest" });
        Assert.Equal(HttpStatusCode.Created, chat.StatusCode);
        Assert.Equal("Gita G.", (await Json(chat)).GetProperty("name").GetString());
        Assert.Contains((await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/chat"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("body").GetString() == "Hello from the guest");

        // Rejected guest: told so, and cannot immediately ask again.
        var uma = await fx.NewClientAsync();
        var umaToken = await GuestToken(m.Mid, "uma.room@test.invalid");
        var umaEntry = (await Json(await uma.PostAsync($"/api/v1/join/{umaToken}/enter", new { }))).GetProperty("entryId").GetString()!;
        var umaHostId = (await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/room/waiting"))).GetProperty("items")[0].GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/waiting/{umaHostId}/reject")).StatusCode);
        Assert.Equal("REJECTED", (await Json(await uma.Http.GetAsync($"/api/v1/join/{umaToken}/entry/{umaEntry}"))).GetProperty("status").GetString());
        var retry = await uma.PostAsync($"/api/v1/join/{umaToken}/enter", new { });
        Assert.Equal(HttpStatusCode.Forbidden, retry.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await uma.PostAsync($"/api/v1/join/{umaToken}/chat", new { body = "let me in" })).StatusCode);

        // Leaving the waiting room: a fresh entry → leave → LEFT.
        await Exec("UPDATE mtg.WaitingRoomEntries SET DecidedUtc = DATEADD(MINUTE, -5, DecidedUtc) WHERE MeetingId = @mid AND [Status] = 'REJECTED'", new { mid = m.Mid });
        var umaEntry2 = (await Json(await uma.PostAsync($"/api/v1/join/{umaToken}/enter", new { }))).GetProperty("entryId").GetString()!;
        Assert.Equal(HttpStatusCode.NoContent, (await uma.PostAsync($"/api/v1/join/{umaToken}/entry/{umaEntry2}/leave")).StatusCode);
        Assert.Equal("LEFT", (await Json(await uma.Http.GetAsync($"/api/v1/join/{umaToken}/entry/{umaEntry2}"))).GetProperty("status").GetString());

        // Bad links stay 404.
        Assert.Equal(HttpStatusCode.NotFound, (await uma.PostAsync("/api/v1/join/not-a-real-token/enter", new { })).StatusCode);
    }

    [Fact]
    public async Task Without_a_waiting_room_guests_get_a_token_at_once_but_not_outside_the_window()
    {
        var host = await SignedIn("rhost@test.invalid");
        var m = await Book(host, 507, "Open meeting", guests: [new { name = "Omar Open", email = "omar.room@test.invalid" }], waitingRoom: false);
        var guest = await fx.NewClientAsync();
        var token = await GuestToken(m.Mid, "omar.room@test.invalid");
        var r = await guest.PostAsync($"/api/v1/join/{token}/enter", new { displayName = "  " });
        Assert.Equal("VALIDATION", await Code(r)); // a blank name is refused
        var ok = await Json(await guest.PostAsync($"/api/v1/join/{token}/enter", new { }));
        Assert.Equal("ADMITTED", ok.GetProperty("status").GetString());
        Assert.Equal("Omar Open", Claims(ok.GetProperty("connection").GetProperty("token").GetString()!).GetProperty("name").GetString());
        Assert.Equal(HttpStatusCode.OK, (await guest.Http.GetAsync($"/api/v1/join/{token}/chat")).StatusCode);

        await Move(m.Mid, 120, 30);
        var early = await guest.PostAsync($"/api/v1/join/{token}/enter", new { });
        Assert.Equal(HttpStatusCode.Conflict, early.StatusCode);
        Assert.Equal("TOO_EARLY", (await Json(early)).GetProperty("reason").GetString());
    }

    // ---- Host controls -------------------------------------------------------------------------------------------

    [Fact]
    public async Task Host_controls_are_host_only_audited_and_call_the_LiveKit_RoomService()
    {
        var host = await SignedIn("rhost@test.invalid");
        var peer = await SignedIn("rpeer@test.invalid");
        var m = await Book(host, 508, "Controls test", [await Emp("R-PEER")], guests: [new { name = "Gopal Guest", email = "gopal.room@test.invalid" }]);
        var identities = (await new SqlConnection(fx.ConnectionString).QueryAsync<(string Identity, string Type, string Role)>(
            "SELECT LiveKitIdentity, ParticipantType, [Role] FROM mtg.MeetingParticipants WHERE MeetingId = @mid", new { mid = m.Mid })).ToList();
        var peerId = identities.Single(x => x.Type == "EMPLOYEE" && x.Role == "ATTENDEE").Identity;
        var hostId = identities.Single(x => x.Role == "HOST").Identity;
        var guestId = identities.Single(x => x.Type == "GUEST").Identity;
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{m.Id}/join")).StatusCode);

        // Mute: attendee → 403; host → MutePublishedTrack on the microphone track found via GetParticipant.
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{hostId}/mute", new { source = "MICROPHONE" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{peerId}/mute", new { source = "MICROPHONE" })).StatusCode);
        var mute = fx.LiveKit.For(m.Room).Last(c => c.Method == "MutePublishedTrack");
        Assert.Equal(peerId, mute.Body.GetProperty("identity").GetString());
        Assert.Equal($"TR_MIC_{peerId}", mute.Body.GetProperty("track_sid").GetString());
        Assert.True(mute.Body.GetProperty("muted").GetBoolean());
        Assert.Equal("VALIDATION", await Code(await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{peerId}/mute", new { source = "KEYBOARD" })));
        Assert.Equal(HttpStatusCode.NotFound, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/p_not_in_meeting/mute", new { source = "MICROPHONE" })).StatusCode);

        // Remove: the host cannot be removed; a removed guest's admission is withdrawn; someone not in the room → 404.
        Assert.Equal(HttpStatusCode.Conflict, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{hostId}/remove")).StatusCode);
        await Exec("INSERT mtg.WaitingRoomEntries (MeetingId, ParticipantId, [Status], DecidedByEmployeeId, DecidedUtc) SELECT @mid, ParticipantId, 'ADMITTED', (SELECT HostEmployeeId FROM mtg.Meetings WHERE MeetingId = @mid), SYSUTCDATETIME() FROM mtg.MeetingParticipants WHERE MeetingId = @mid AND LiveKitIdentity = @guestId",
            new { mid = m.Mid, guestId });
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{guestId}/remove")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{guestId}/remove")).StatusCode);
        Assert.Contains(fx.LiveKit.For(m.Room), c => c.Method == "RemoveParticipant" && c.Body.GetProperty("identity").GetString() == guestId);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.WaitingRoomEntries w JOIN mtg.MeetingParticipants p ON p.ParticipantId = w.ParticipantId WHERE p.LiveKitIdentity = @guestId AND w.[Status] = 'ADMITTED'", new { guestId }));
        fx.LiveKit.Absent[peerId] = true;
        Assert.Equal(HttpStatusCode.NotFound, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{peerId}/remove")).StatusCode);
        fx.LiveKit.Absent.TryRemove(peerId, out _);

        // End for all: attendee → 403; host → DeleteRoom, COMPLETED, open attendance closed, audited.
        await Exec("INSERT mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc, ClientInfo) SELECT @mid, ParticipantId, DATEADD(MINUTE, -1, SYSUTCDATETIME()), 'livekit:PA_end' FROM mtg.MeetingParticipants WHERE MeetingId = @mid AND LiveKitIdentity = @peerId",
            new { mid = m.Mid, peerId });
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/room/end")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/end")).StatusCode);
        Assert.Contains(fx.LiveKit.For(m.Room), c => c.Method == "DeleteRoom");
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE MeetingId = @mid AND [Status] = 'COMPLETED' AND ActualEndUtc IS NOT NULL AND ActualEndUtc >= ActualStartUtc", new { mid = m.Mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingAttendance WHERE MeetingId = @mid AND LeftUtc IS NULL", new { mid = m.Mid }));
        Assert.Equal(HttpStatusCode.Conflict, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/end")).StatusCode);
        foreach (var action in new[] { "ROOM_PARTICIPANT_MUTED", "ROOM_PARTICIPANT_REMOVED", "MEETING_ENDED" })
            Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog a JOIN auth.Users u ON u.UserId = a.ActorUserId WHERE a.EntityId = @id AND a.[Action] = @action AND u.Email = N'rhost@test.invalid'",
                new { id = m.Id.ToString(), action }));
        Assert.Equal("ENDED", (await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/join"))).GetProperty("reason").GetString());
    }

    // ---- Webhooks --------------------------------------------------------------------------------------------------

    static string B64(byte[] b) => LiveKitTokens.B64(b);

    static string Sign(string body, string secret = ApiFixture.LiveKitSecret, string issuer = ApiFixture.LiveKitKey)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = B64(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}"""));
        var claims = B64(JsonSerializer.SerializeToUtf8Bytes(new { iss = issuer, nbf = now - 5, exp = now + 300, sha256 = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(body))) }));
        return $"{header}.{claims}.{B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.ASCII.GetBytes($"{header}.{claims}")))}";
    }

    async Task<HttpResponseMessage> PostWebhook(string body, string? authorization)
    {
        var anon = await fx.NewClientAsync();
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/webhooks/livekit") { Content = new StringContent(body, Encoding.UTF8, "application/webhook+json") };
        if (authorization is not null) req.Headers.TryAddWithoutValidation("Authorization", authorization);
        return await anon.Http.SendAsync(req); // no XSRF header: webhooks are exempt, the signature authenticates them
    }

    static string Event(string id, string ev, string room, string? identity = null, string sid = "PA_1", long? at = null) => JsonSerializer.Serialize(new
    {
        id, @event = ev, createdAt = (at ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString(),
        room = new { sid = "RM_1", name = room },
        participant = identity is null ? null : new { sid, identity, name = "Someone", joinedAt = (DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 30).ToString(), disconnectReason = ev == "participant_left" ? "CLIENT_INITIATED" : null },
    });

    [Fact]
    public async Task Webhooks_are_verified_idempotent_and_record_attendance_and_room_end()
    {
        var host = await SignedIn("rhost@test.invalid");
        var m = await Book(host, 509, "Webhook test", [await Emp("R-PEER")]);
        Assert.Equal(HttpStatusCode.OK, (await host.PostAsync($"/api/v1/meetings/{m.Id}/join")).StatusCode); // LIVE
        var peerId = await fx.QueryAsync<string>("SELECT p.LiveKitIdentity FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = @mid AND e.EmployeeCode = 'R-PEER'", new { mid = m.Mid });
        var suffix = Guid.NewGuid().ToString("N")[..8];

        // Signature checks: none, wrong secret, wrong issuer, body changed after signing.
        var joined = Event($"EV_join_{suffix}", "participant_joined", m.Room, peerId);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostWebhook(joined, null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostWebhook(joined, Sign(joined, secret: "another-secret-0123456789-abcdefghijk"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostWebhook(joined, Sign(joined, issuer: "APIother"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await PostWebhook(joined.Replace("participant_joined", "room_finished"), Sign(joined))).StatusCode);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.WebhookEvents WHERE EventId = @id", new { id = $"EV_join_{suffix}" }));

        // Valid → one attendance row; delivered twice → still one (app.WebhookEvents).
        Assert.Equal(HttpStatusCode.OK, (await PostWebhook(joined, Sign(joined))).StatusCode);
        var dup = await PostWebhook(joined, Sign(joined));
        Assert.Equal(HttpStatusCode.OK, dup.StatusCode);
        Assert.True((await Json(dup)).GetProperty("duplicate").GetBoolean());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingAttendance WHERE MeetingId = @mid AND LeftUtc IS NULL AND ClientInfo = 'livekit:PA_1'", new { mid = m.Mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.WebhookEvents WHERE EventId = @id AND ProcessedUtc IS NOT NULL AND SignatureValid = 1 AND Source = 'LIVEKIT'", new { id = $"EV_join_{suffix}" }));

        // A participant who is not ours (e.g. the hidden recorder) is ignored.
        var stranger = Event($"EV_rec_{suffix}", "participant_joined", m.Room, "rec-hidden", "PA_rec");
        Assert.Equal(HttpStatusCode.OK, (await PostWebhook(stranger, Sign(stranger))).StatusCode);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingAttendance WHERE MeetingId = @mid", new { mid = m.Mid }));

        // Left → the interval closes with the reason.
        var left = Event($"EV_left_{suffix}", "participant_left", m.Room, peerId);
        Assert.Equal(HttpStatusCode.OK, (await PostWebhook(left, Sign(left))).StatusCode);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingAttendance WHERE MeetingId = @mid AND LeftUtc IS NOT NULL AND LeaveReason = 'CLIENT_INITIATED' AND DurationSeconds >= 0", new { mid = m.Mid }));

        // Room finished → COMPLETED (system actor), audited.
        var finished = Event($"EV_fin_{suffix}", "room_finished", m.Room);
        Assert.Equal(HttpStatusCode.OK, (await PostWebhook(finished, Sign(finished))).StatusCode);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings WHERE MeetingId = @mid AND [Status] = 'COMPLETED' AND ActualEndUtc IS NOT NULL", new { mid = m.Mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'MEETING_COMPLETED' AND ActorType = 'SYSTEM'", new { id = m.Id.ToString() }));
    }

    // ---- Chat --------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Chat_is_persisted_for_participants_only_and_kept_as_plain_text()
    {
        var host = await SignedIn("rhost@test.invalid");
        var peer = await SignedIn("rpeer@test.invalid");
        var outsider = await SignedIn("rout@test.invalid");
        var super = await SignedIn("msuper@test.invalid");
        var m = await Book(host, 510, "Chat test", [await Emp("R-PEER")]);

        var r = await peer.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = "  <b>Hi</b> <script>alert(1)</script>\u0007 team  " });
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var msg = await Json(r);
        Assert.Equal("<b>Hi</b> <script>alert(1)</script> team", msg.GetProperty("body").GetString()); // stored verbatim (control chars dropped); rendered as text
        Assert.Equal("Riya Peer", msg.GetProperty("name").GetString());
        Assert.Equal(HttpStatusCode.Created, (await host.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = "Second line\nwith a break" })).StatusCode);

        Assert.Equal("VALIDATION", await Code(await peer.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = "   " })));
        Assert.Equal("VALIDATION", await Code(await peer.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = new string('x', 2001) })));
        Assert.Equal(HttpStatusCode.Created, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = new string('y', 2000) })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = "hi" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await super.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = "hi" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await super.Http.GetAsync($"/api/v1/meetings/{m.Id}/chat")).StatusCode);

        var items = (await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/chat"))).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(3, items.Count);
        Assert.Equal("Riya Peer", items[0].GetProperty("name").GetString());
        Assert.Equal("Second line\nwith a break", items[1].GetProperty("body").GetString());
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM mtg.MeetingChatMessages WHERE MeetingId = @mid", new { mid = m.Mid }));

        await Exec("UPDATE mtg.Meetings SET [Status] = 'COMPLETED' WHERE MeetingId = @mid", new { mid = m.Mid });
        Assert.Equal(HttpStatusCode.Conflict, (await peer.PostAsync($"/api/v1/meetings/{m.Id}/chat", new { body = "too late" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await peer.Http.GetAsync($"/api/v1/meetings/{m.Id}/chat")).StatusCode); // history stays readable
    }
}
