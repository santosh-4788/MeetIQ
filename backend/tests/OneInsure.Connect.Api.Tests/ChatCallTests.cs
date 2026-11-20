using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Chat;
using OneInsure.Connect.Api.Meetings;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Chat audio calls, Phase 3 (V029): the CHAT_CALLS switch, microphone-only tokens for invited people only, ringing → accept /
/// decline / missed / busy, joining and leaving, adding people mid-call (becomes a group call), who may end a call, the
/// connection check against LiveKit's participant list, call lines in the chat, missed-call notifications and history.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ChatCallTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    async Task Switch(string key, bool on)
    {
        await Exec("UPDATE app.FeatureSettings SET IsEnabled = @on WHERE FeatureKey = @key", new { on, key });
        var cache = fx.Factory.Services.GetRequiredService<IMemoryCache>();
        cache.Remove("chat:enabled");
        cache.Remove("chat:calls-enabled");
    }

    /// <summary>No call left open between tests (each test starts from "nobody is in a call").</summary>
    async Task Reset()
    {
        await Exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')");
        await Switch("CHAT", true);
        await Switch("CHAT_CALLS", true);
    }

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    static async Task<Guid> PersonId(TestClient c, string search) =>
        (await Json(await c.Http.GetAsync($"/api/v1/chat/people?search={Uri.EscapeDataString(search)}"))).EnumerateArray().Single().GetProperty("id").GetGuid();

    static async Task<Guid> Direct(TestClient c, Guid userId) => (await Json(await c.PostAsync("/api/v1/chat/direct", new { userId }))).GetProperty("id").GetGuid();

    static async Task<JsonElement> StartCall(TestClient c, Guid conversationId)
    {
        var r = await c.PostAsync("/api/v1/chat/calls", new { conversationId });
        Assert.True(r.StatusCode == HttpStatusCode.OK, await r.Content.ReadAsStringAsync());
        return await Json(r);
    }

    static string State(JsonElement call, Guid userId) =>
        call.GetProperty("participants").EnumerateArray().Single(p => p.GetProperty("id").GetGuid() == userId).GetProperty("state").GetString()!;

    static JsonElement Claims(string jwt) => JsonDocument.Parse(LiveKitTokens.FromB64(jwt.Split('.')[1])).RootElement;

    Task<int> Count(string sql, object? p = null) => fx.QueryAsync<int>(sql, p);
    ChatCallWorker Worker => fx.Factory.Services.GetRequiredService<ChatCallWorker>();

    [Fact]
    public async Task Calls_are_off_until_switched_on_and_need_Chat_too()
    {
        await Reset();
        await Switch("CHAT_CALLS", false);
        try
        {
            var ana = await SignedIn("cana@test.invalid");
            var conv = await Direct(ana, await PersonId(ana, "Ben Chat"));
            var r = await ana.PostAsync("/api/v1/chat/calls", new { conversationId = conv });
            Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
            Assert.Equal("FEATURE_DISABLED", await Code(r));
            Assert.False((await Json(await ana.Http.GetAsync("/api/v1/chat/calls/current"))).GetProperty("enabled").GetBoolean());
        }
        finally { await Reset(); }
    }

    [Fact]
    public async Task Direct_call_rings_is_answered_tokens_are_microphone_only_outsiders_get_nothing_and_leaving_ends_it()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var benId = await PersonId(ana, "Ben Chat");
        var anaId = await PersonId(ben, "Ana Chat");
        var conv = await Direct(ana, benId);

        var started = await StartCall(ana, conv);
        var call = started.GetProperty("call");
        var callId = call.GetProperty("id").GetGuid();
        Assert.Equal("RINGING", call.GetProperty("status").GetString());
        Assert.Equal("RINGING", State(call, benId));
        var claims = Claims(started.GetProperty("connection").GetProperty("token").GetString()!);
        var video = claims.GetProperty("video");
        Assert.StartsWith(ChatCallEndpoints.RoomPrefix, video.GetProperty("room").GetString());
        Assert.Equal(["microphone"], video.GetProperty("canPublishSources").EnumerateArray().Select(x => x.GetString()).ToArray());
        Assert.False(video.GetProperty("roomAdmin").GetBoolean());
        var room = video.GetProperty("room").GetString()!;

        // Ben is being rung (after a reload too); Dan was not invited: "not found" for every action.
        var current = await Json(await ben.Http.GetAsync("/api/v1/chat/calls/current"));
        Assert.Contains(current.GetProperty("calls").EnumerateArray(), c => c.GetProperty("id").GetGuid() == callId);
        foreach (var action in new[] { "accept", "decline", "leave", "end", "token" })
            Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync($"/api/v1/chat/calls/{callId}/{action}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync($"/api/v1/chat/calls/{callId}/invite", new { userIds = new[] { anaId } })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync("/api/v1/chat/calls", new { conversationId = conv })).StatusCode);

        // Ben answers: active, with his own microphone-only token. Ana cannot start a second call meanwhile.
        var accepted = await Json(await ben.PostAsync($"/api/v1/chat/calls/{callId}/accept"));
        Assert.Equal("ACTIVE", accepted.GetProperty("call").GetProperty("status").GetString());
        Assert.Equal(ChatCallEndpoints.IdentityFor(benId), Claims(accepted.GetProperty("connection").GetProperty("token").GetString()!).GetProperty("sub").GetString());
        var second = await ana.PostAsync("/api/v1/chat/calls", new { conversationId = await Direct(ana, await PersonId(ana, "Cat Chat")) });
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);

        // Both connected (LiveKit lists them) …
        fx.LiveKit.Participants[room] = [ChatCallEndpoints.IdentityFor(anaId), ChatCallEndpoints.IdentityFor(benId)];
        await Worker.RunOnceAsync();
        Assert.Equal(2, await Count("SELECT COUNT(*) FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall c ON c.CallId = p.CallId WHERE c.PublicId = @callId AND p.JoinedUtc IS NOT NULL", new { callId }));
        // … then Ben's browser disappears: after 25 s unseen he counts as left, and the call ends with a line in the chat.
        fx.LiveKit.Participants[room] = [ChatCallEndpoints.IdentityFor(anaId)];
        await Exec("UPDATE p SET LastConnectedUtc = DATEADD(SECOND, -40, SYSUTCDATETIME()) FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall c ON c.CallId = p.CallId WHERE c.PublicId = @callId", new { callId });
        await Worker.RunOnceAsync();
        var history = await Json(await ana.Http.GetAsync("/api/v1/chat/calls"));
        var ended = history.GetProperty("items").EnumerateArray().First(c => c.GetProperty("id").GetGuid() == callId);
        Assert.Equal("ENDED", ended.GetProperty("status").GetString());
        var lines = (await Json(await ana.Http.GetAsync($"/api/v1/chat/conversations/{conv}/messages"))).GetProperty("items").EnumerateArray()
            .Where(m => m.GetProperty("kind").GetString() == "SYSTEM").Select(m => m.GetProperty("body").GetString()).ToList();
        Assert.Contains(lines, l => l!.StartsWith("📞 Audio call ·"));
        Assert.Contains(fx.LiveKit.Calls, c => c.Method == "DeleteRoom" && c.Body.GetProperty("room").GetString() == room);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'CHAT_CALL_STARTED' AND EntityId = @id", new { id = callId.ToString() }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'CHAT_CALL_ENDED' AND EntityId = @id", new { id = callId.ToString() }));
    }

    [Fact]
    public async Task Unanswered_calls_become_missed_declines_and_busy_people_are_handled()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var cat = await SignedIn("ccat@test.invalid");
        var benId = await PersonId(ana, "Ben Chat");
        var conv = await Direct(ana, benId);
        var benUser = await fx.QueryAsync<long>("SELECT UserId FROM auth.Users WHERE Email = 'cben@test.invalid'");

        // No answer within the ring time: missed, a bell notification and a chat line for Ben.
        var bellBefore = await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @benUser AND [Type] = 'MISSED_CALL'", new { benUser });
        var missedId = (await StartCall(ana, conv)).GetProperty("call").GetProperty("id").GetGuid();
        await Exec("UPDATE p SET InvitedUtc = DATEADD(SECOND, -60, InvitedUtc) FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall c ON c.CallId = p.CallId WHERE c.PublicId = @missedId", new { missedId });
        await Worker.RunOnceAsync();
        Assert.Equal("MISSED", await fx.QueryAsync<string>("SELECT [Status] FROM chat.TRN_ChatCall WHERE PublicId = @missedId", new { missedId }));
        Assert.Equal(bellBefore + 1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @benUser AND [Type] = 'MISSED_CALL'", new { benUser }));
        var link = await fx.QueryAsync<string>("SELECT TOP 1 LinkPath FROM mtg.MeetingNotifications WHERE RecipientUserId = @benUser AND [Type] = 'MISSED_CALL' ORDER BY NotificationId DESC", new { benUser });
        Assert.Equal($"/chat?c={conv}", link);
        Assert.Contains((await Json(await ben.Http.GetAsync($"/api/v1/chat/conversations/{conv}/messages"))).GetProperty("items").EnumerateArray(),
            m => m.GetProperty("body").GetString()?.StartsWith("📞 Missed audio call") == true);

        // Declined.
        var declinedId = (await StartCall(ana, conv)).GetProperty("call").GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await ben.PostAsync($"/api/v1/chat/calls/{declinedId}/decline")).StatusCode);
        Assert.Equal("DECLINED", await fx.QueryAsync<string>("SELECT [Status] FROM chat.TRN_ChatCall WHERE PublicId = @declinedId", new { declinedId }));

        // Ben is in a call with Cat: Ana's call is not rung through ("busy") and ends at once.
        var benCat = await Direct(cat, benId);
        var catCall = (await StartCall(cat, benCat)).GetProperty("call").GetProperty("id").GetGuid();
        await ben.PostAsync($"/api/v1/chat/calls/{catCall}/accept");
        var busy = (await StartCall(ana, conv)).GetProperty("call");
        Assert.Equal("BUSY", State(busy, benId));
        Assert.Equal("MISSED", busy.GetProperty("status").GetString());
        Assert.Equal("BUSY", busy.GetProperty("endReason").GetString());
        // Cat hangs up (direct call: either side may end it).
        Assert.Equal(HttpStatusCode.NoContent, (await ben.PostAsync($"/api/v1/chat/calls/{catCall}/end")).StatusCode);
        Assert.Equal("ENDED", await fx.QueryAsync<string>("SELECT [Status] FROM chat.TRN_ChatCall WHERE PublicId = @catCall", new { catCall }));
    }

    [Fact]
    public async Task People_can_be_added_mid_call_which_becomes_a_group_call_only_the_starter_ends_it_for_everyone()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var cat = await SignedIn("ccat@test.invalid");
        var benId = await PersonId(ana, "Ben Chat");
        var catId = await PersonId(ana, "Cat Chat");
        var conv = await Direct(ana, benId);
        var callId = (await StartCall(ana, conv)).GetProperty("call").GetProperty("id").GetGuid();

        // Ringing Ben cannot add people yet; after answering he can.
        Assert.Equal(HttpStatusCode.Conflict, (await ben.PostAsync($"/api/v1/chat/calls/{callId}/invite", new { userIds = new[] { catId } })).StatusCode);
        await ben.PostAsync($"/api/v1/chat/calls/{callId}/accept");
        var invited = await Json(await ben.PostAsync($"/api/v1/chat/calls/{callId}/invite", new { userIds = new[] { catId } }));
        Assert.Equal("GROUP", invited.GetProperty("type").GetString());
        Assert.Equal("RINGING", State(invited, catId));
        var joined = await Json(await cat.PostAsync($"/api/v1/chat/calls/{callId}/accept"));
        Assert.Equal(3, joined.GetProperty("call").GetProperty("participants").EnumerateArray().Count(p => p.GetProperty("state").GetString() == "ACCEPTED"));

        // Only the starter ends a group call for everyone; others leave and the call goes on.
        var endByCat = await cat.PostAsync($"/api/v1/chat/calls/{callId}/end");
        Assert.Equal(HttpStatusCode.Forbidden, endByCat.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await cat.PostAsync($"/api/v1/chat/calls/{callId}/leave")).StatusCode);
        Assert.Equal("ACTIVE", await fx.QueryAsync<string>("SELECT [Status] FROM chat.TRN_ChatCall WHERE PublicId = @callId", new { callId }));
        // Cat may come back while it is still going.
        Assert.Equal(HttpStatusCode.OK, (await cat.PostAsync($"/api/v1/chat/calls/{callId}/accept")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ana.PostAsync($"/api/v1/chat/calls/{callId}/end")).StatusCode);
        Assert.Equal("ENDED", await fx.QueryAsync<string>("SELECT [Status] FROM chat.TRN_ChatCall WHERE PublicId = @callId", new { callId }));
        Assert.Equal(HttpStatusCode.Conflict, (await cat.PostAsync($"/api/v1/chat/calls/{callId}/accept")).StatusCode);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall c ON c.CallId = p.CallId WHERE c.PublicId = @callId AND p.[State] = 'ACCEPTED'", new { callId }));
    }
}
