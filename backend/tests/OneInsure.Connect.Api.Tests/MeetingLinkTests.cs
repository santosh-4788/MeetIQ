using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using OneInsure.Connect.Api.Meetings;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Advanced features, Phase B — instant meetings, the shareable meeting link, guests and non-invited colleagues asking to join
/// through it (always via the waiting room), join by code, link withdrawal, blocking and audio-only tokens.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class MeetingLinkTests(ApiFixture fx)
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

    static JsonElement Claims(string jwt) => JsonDocument.Parse(LiveKitTokens.FromB64(jwt.Split('.')[1])).RootElement;
    static string[] Sources(JsonElement claims) => claims.GetProperty("video").GetProperty("canPublishSources").EnumerateArray().Select(x => x.GetString()!).ToArray();
    static string LinkToken(JsonElement link) => link.GetProperty("path").GetString()!["/m/".Length..];

    sealed record Instant(Guid Id, string Code, string Token);

    async Task<Instant> StartInstant(TestClient host, object body)
    {
        var r = await host.PostAsync("/api/v1/meetings/instant", body);
        Assert.True(r.StatusCode == HttpStatusCode.Created, await r.Content.ReadAsStringAsync());
        var j = await Json(r);
        return new Instant(j.GetProperty("id").GetGuid(), j.GetProperty("meetingCode").GetString()!, LinkToken(j.GetProperty("link")));
    }

    [Fact]
    public async Task Instant_meeting_starts_now_without_invitations_and_is_marked_instant()
    {
        var host = await SignedIn("rhost@test.invalid");
        var outbox = await Count("SELECT COUNT(*) FROM app.EmailOutbox");
        var m = await StartInstant(host, new { title = "Quick sync", category = "group" });

        var detail = await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}"));
        Assert.Equal("INSTANT", detail.GetProperty("kind").GetString());
        Assert.Equal("Quick sync", detail.GetProperty("title").GetString());
        Assert.True(detail.GetProperty("my").GetProperty("canJoin").GetBoolean());
        Assert.True(detail.GetProperty("my").GetProperty("canShareLink").GetBoolean());
        Assert.True(detail.GetProperty("waitingRoomEnabled").GetBoolean());
        Assert.Equal(outbox, await Count("SELECT COUNT(*) FROM app.EmailOutbox")); // nobody to invite: no e-mails
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'MEETING_INSTANT_STARTED'", new { id = m.Id.ToString() }));

        // Host joins at once → LIVE; the list marks it as an instant meeting.
        var join = await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/join"));
        Assert.Equal("LIVE", join.GetProperty("meeting").GetProperty("status").GetString());
        Assert.Equal("INSTANT", join.GetProperty("meeting").GetProperty("kind").GetString());
        var list = await Json(await host.Http.GetAsync("/api/v1/meetings?scope=hosting&pageSize=100"));
        Assert.Contains(list.GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == m.Id && x.GetProperty("kind").GetString() == "INSTANT");

        // The same link comes back when the host copies it again.
        var again = await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/link"));
        Assert.Equal(m.Token, LinkToken(again));
        Assert.StartsWith("http", again.GetProperty("url").GetString());

        // Customer meetings cannot be instant; nonsense durations are refused.
        Assert.Equal("VALIDATION", await Code(await host.PostAsync("/api/v1/meetings/instant", new { category = "CUSTOMER_PLVC" })));
        Assert.Equal("VALIDATION", await Code(await host.PostAsync("/api/v1/meetings/instant", new { durationMinutes = 2 })));
        // Not signed in → 401.
        Assert.Equal(HttpStatusCode.Unauthorized, (await (await fx.NewClientAsync()).PostAsync("/api/v1/meetings/instant", new { })).StatusCode);
    }

    [Fact]
    public async Task Audio_only_meeting_tokens_do_not_allow_a_camera()
    {
        var host = await SignedIn("rhost@test.invalid");
        var m = await StartInstant(host, new { audioOnly = true });
        var conn = (await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/join"))).GetProperty("connection");
        Assert.False(conn.GetProperty("canPublishVideo").GetBoolean());
        var sources = Sources(Claims(conn.GetProperty("token").GetString()!));
        Assert.DoesNotContain("camera", sources);
        Assert.Contains("microphone", sources);
    }

    [Fact]
    public async Task Link_guests_always_wait_for_the_host_and_see_nothing_before_admission()
    {
        var host = await SignedIn("rhost@test.invalid");
        // Even with the meeting's waiting room switched off, people from the link must be admitted.
        var m = await StartInstant(host, new { title = "Open link test", waitingRoomEnabled = false });
        var guest = await fx.NewClientAsync();

        var info = await Json(await guest.Http.GetAsync($"/api/v1/m/{m.Token}"));
        Assert.Equal("Open link test", info.GetProperty("title").GetString());
        Assert.Equal("GUEST", info.GetProperty("participantType").GetString());
        Assert.True(info.GetProperty("waitingRoom").GetBoolean());
        Assert.True(info.GetProperty("joinableNow").GetBoolean());
        Assert.False(info.TryGetProperty("participants", out _));
        Assert.Equal(JsonValueKind.Null, info.GetProperty("meetingId").ValueKind);

        Assert.Equal("VALIDATION", await Code(await guest.PostAsync($"/api/v1/m/{m.Token}/request", new { displayName = "   " })));
        var req = await Json(await guest.PostAsync($"/api/v1/m/{m.Token}/request", new { displayName = "Lata Link" }));
        Assert.Equal("GUEST", req.GetProperty("participantType").GetString());
        var personal = req.GetProperty("joinToken").GetString()!;
        Assert.NotEqual(m.Token, personal);

        // The host has not joined: the guest waits (no LiveKit token), and cannot read the chat or recording state.
        var enter = await guest.PostAsync($"/api/v1/join/{personal}/enter", new { displayName = "Lata Link" });
        Assert.Equal(HttpStatusCode.Accepted, enter.StatusCode);
        var entryId = (await Json(enter)).GetProperty("entryId").GetString()!;
        Assert.Equal("WAITING", (await Json(await guest.Http.GetAsync($"/api/v1/join/{personal}/entry/{entryId}"))).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Http.GetAsync($"/api/v1/join/{personal}/chat")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.Http.GetAsync($"/api/v1/join/{personal}/recording")).StatusCode);

        var waiting = (await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/room/waiting"))).GetProperty("items");
        Assert.Equal(1, waiting.GetArrayLength());
        Assert.Equal("Lata Link", waiting[0].GetProperty("name").GetString());
        Assert.True(waiting[0].GetProperty("viaLink").GetBoolean());
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/waiting/{waiting[0].GetProperty("id").GetString()}/admit")).StatusCode);

        var admitted = await Json(await guest.Http.GetAsync($"/api/v1/join/{personal}/entry/{entryId}"));
        Assert.Equal("ADMITTED", admitted.GetProperty("status").GetString());
        var claims = Claims(admitted.GetProperty("connection").GetProperty("token").GetString()!);
        Assert.Equal("Lata Link", claims.GetProperty("name").GetString());
        Assert.False(claims.GetProperty("video").GetProperty("roomAdmin").GetBoolean());
        Assert.DoesNotContain("screen_share", Sources(claims));
        Assert.Equal(HttpStatusCode.OK, (await guest.Http.GetAsync($"/api/v1/join/{personal}/chat")).StatusCode);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants p JOIN mtg.Meetings m ON m.MeetingId = p.MeetingId WHERE m.PublicId = @id AND p.JoinSource = 'LINK' AND p.AdmissionRequired = 1 AND p.ParticipantType = 'GUEST'", new { id = m.Id }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'MEETING_LINK_USED'", new { id = m.Id.ToString() }));

        // Removed with "block": the personal link stops working everywhere.
        var identity = claims.GetProperty("sub").GetString()!;
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/participants/{identity}/remove", new { block = true })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await guest.Http.GetAsync($"/api/v1/join/{personal}/entry/{entryId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await guest.PostAsync($"/api/v1/join/{personal}/enter", new { })).StatusCode);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'ROOM_PARTICIPANT_BLOCKED'", new { id = m.Id.ToString() }));
    }

    [Fact]
    public async Task Non_invited_colleague_from_the_link_joins_as_employee_after_admission()
    {
        var host = await SignedIn("rhost@test.invalid");
        var colleague = await SignedIn("rout@test.invalid");
        var m = await StartInstant(host, new { title = "Colleague link test" });

        // Host opening the link: already a participant → sent to the normal room.
        Assert.Equal(m.Id, (await Json(await host.Http.GetAsync($"/api/v1/m/{m.Token}"))).GetProperty("meetingId").GetGuid());

        var info = await Json(await colleague.Http.GetAsync($"/api/v1/m/{m.Token}"));
        Assert.Equal("EMPLOYEE", info.GetProperty("participantType").GetString());
        Assert.Equal("Raj Outsider", info.GetProperty("displayName").GetString());
        var req = await Json(await colleague.PostAsync($"/api/v1/m/{m.Token}/request", new { displayName = "Someone Else" }));
        Assert.Equal("EMPLOYEE", req.GetProperty("participantType").GetString());
        var personal = req.GetProperty("joinToken").GetString()!;

        // Now a participant, but the normal join refuses until a host admits them.
        var early = await colleague.PostAsync($"/api/v1/meetings/{m.Id}/join");
        Assert.Equal(HttpStatusCode.Forbidden, early.StatusCode);
        Assert.Equal("ADMISSION_REQUIRED", (await Json(early)).GetProperty("reason").GetString());

        var entryId = (await Json(await colleague.PostAsync($"/api/v1/join/{personal}/enter", new { }))).GetProperty("entryId").GetString()!;
        var w = (await Json(await host.Http.GetAsync($"/api/v1/meetings/{m.Id}/room/waiting"))).GetProperty("items")[0];
        Assert.Equal("EMPLOYEE", w.GetProperty("type").GetString());
        Assert.Equal("Raj Outsider", w.GetProperty("name").GetString()); // their real name, not a typed one
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/waiting/{w.GetProperty("id").GetString()}/admit")).StatusCode);
        Assert.Equal("ADMITTED", (await Json(await colleague.Http.GetAsync($"/api/v1/join/{personal}/entry/{entryId}"))).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.OK, (await colleague.PostAsync($"/api/v1/meetings/{m.Id}/join")).StatusCode);
        Assert.Equal(m.Id, (await Json(await colleague.Http.GetAsync($"/api/v1/m/{m.Token}"))).GetProperty("meetingId").GetGuid());
    }

    [Fact]
    public async Task Only_hosts_manage_the_link_and_withdrawn_or_locked_links_refuse_entry()
    {
        var host = await SignedIn("rhost@test.invalid");
        var colleague = await SignedIn("rpeer@test.invalid");
        var outsider = await SignedIn("rout@test.invalid");
        var m = await StartInstant(host, new { title = "Link management" });
        var anon = await fx.NewClientAsync();

        // A colleague admitted through the link is an attendee: they cannot see or change the link.
        var personal = (await Json(await colleague.PostAsync($"/api/v1/m/{m.Token}/request", new { }))).GetProperty("joinToken").GetString()!;
        await colleague.PostAsync($"/api/v1/join/{personal}/enter", new { });
        Assert.Equal(HttpStatusCode.Forbidden, (await colleague.Http.GetAsync($"/api/v1/meetings/{m.Id}/link")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Http.GetAsync($"/api/v1/meetings/{m.Id}/link")).StatusCode);

        // Join by code: visible meetings only (outsider gets the same 404 as for a code that does not exist).
        Assert.Equal(m.Id, (await Json(await host.Http.GetAsync($"/api/v1/meetings/by-code/{m.Code.ToLowerInvariant()}"))).GetProperty("id").GetGuid());
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Http.GetAsync($"/api/v1/meetings/by-code/{m.Code}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await host.Http.GetAsync("/api/v1/meetings/by-code/OIC-000000-ZZZZ")).StatusCode);

        // Locked: nobody new can ask.
        await Exec("UPDATE mtg.Meetings SET IsLocked = 1 WHERE PublicId = @id", new { id = m.Id });
        var locked = await anon.PostAsync($"/api/v1/m/{m.Token}/request", new { displayName = "Late Larry" });
        Assert.Equal(HttpStatusCode.Forbidden, locked.StatusCode);
        Assert.Equal("LOCKED", (await Json(locked)).GetProperty("reason").GetString());
        await Exec("UPDATE mtg.Meetings SET IsLocked = 0 WHERE PublicId = @id", new { id = m.Id });

        // Replace: the old link stops working with an explanation; the new one works.
        var fresh = await Json(await host.PostAsync($"/api/v1/meetings/{m.Id}/link/regenerate"));
        var newToken = LinkToken(fresh);
        Assert.NotEqual(m.Token, newToken);
        var dead = await anon.Http.GetAsync($"/api/v1/m/{m.Token}");
        Assert.Equal(HttpStatusCode.NotFound, dead.StatusCode);
        Assert.Contains("withdrew or replaced", (await Json(dead)).GetProperty("detail").GetString());
        Assert.Equal(HttpStatusCode.OK, (await anon.Http.GetAsync($"/api/v1/m/{newToken}")).StatusCode);

        // Withdraw: no active link; unknown tokens are plain 404s.
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/link/revoke")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.PostAsync($"/api/v1/m/{newToken}/request", new { displayName = "Nobody" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Http.GetAsync("/api/v1/m/not-a-real-link")).StatusCode);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingLinks l JOIN mtg.Meetings m ON m.MeetingId = l.MeetingId WHERE m.PublicId = @id AND l.RevokedUtc IS NULL", new { id = m.Id }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityId = @id AND [Action] = 'MEETING_LINK_REVOKED'", new { id = m.Id.ToString() }));
    }

    [Fact]
    public async Task Link_page_and_requests_are_rate_limited_per_address()
    {
        await using var factory = fx.Factory.WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, cfg) =>
            cfg.AddInMemoryCollection(new Dictionary<string, string?> { ["Meetings:JoinPermitPerMinute"] = "3" })));
        var http = factory.CreateClient();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++) codes.Add((await http.GetAsync($"/api/v1/m/guess-{i}")).StatusCode);
        Assert.Equal([HttpStatusCode.NotFound, HttpStatusCode.NotFound, HttpStatusCode.NotFound, (HttpStatusCode)429, (HttpStatusCode)429], codes);
    }

    [Fact]
    public async Task Ended_meeting_links_cannot_be_used()
    {
        var host = await SignedIn("rhost@test.invalid");
        var m = await StartInstant(host, new { });
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{m.Id}/room/end")).StatusCode);
        var anon = await fx.NewClientAsync();
        Assert.Equal("ENDED", (await Json(await anon.Http.GetAsync($"/api/v1/m/{m.Token}"))).GetProperty("status").GetString());
        var r = await anon.PostAsync($"/api/v1/m/{m.Token}/request", new { displayName = "Too Late" });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("ENDED", (await Json(r)).GetProperty("reason").GetString());
    }
}
