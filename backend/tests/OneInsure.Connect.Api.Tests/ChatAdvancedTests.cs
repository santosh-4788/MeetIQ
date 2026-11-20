using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Chat;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Chat Phase 5 (V031): the CHAT_ADVANCED switch, scheduled messages (validation, privacy, sent exactly once by the worker, failure
/// when the sender left), saved and pinned messages, @mentions with bells and unread counts, the "added to a group" bell, the extra
/// search filters, favourites, quiet hours and the task week filter / follow-up panel. Every test uses its own group chats.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ChatAdvancedTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    const string Api = "/api/v1/chat";

    static async Task<JsonElement> Json(HttpResponseMessage r)
    {
        await r.Content.LoadIntoBufferAsync();
        var text = await r.Content.ReadAsStringAsync();
        return text.Length == 0 ? default : JsonDocument.Parse(text).RootElement;
    }
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;
    static string Iso(DateTime d) => Uri.EscapeDataString(d.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"));

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    Task<int> Count(string sql, object? p = null) => fx.QueryAsync<int>(sql, p);

    async Task Switch(string key, bool on)
    {
        await Exec("UPDATE app.FeatureSettings SET IsEnabled = @on WHERE FeatureKey = @key", new { on, key });
        var cache = fx.Factory.Services.GetRequiredService<IMemoryCache>();
        foreach (var k in new[] { "chat:enabled", "chat:calls-enabled", "chat:tasks-enabled", "chat:advanced-enabled" }) cache.Remove(k);
    }

    async Task Reset()
    {
        await Switch("CHAT", true);
        await Switch("CHAT_TASKS", true);
        await Switch("CHAT_ADVANCED", true);
    }

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    static Task<HttpResponseMessage> Patch(TestClient c, string path, object body)
    {
        var req = new HttpRequestMessage(HttpMethod.Patch, path) { Content = JsonContent.Create(body) };
        if (c.Cookie("XSRF-TOKEN") is { } t) req.Headers.Add("X-XSRF-TOKEN", t);
        return c.Http.SendAsync(req);
    }

    static async Task<JsonElement> Ok(Task<HttpResponseMessage> call)
    {
        var r = await call;
        Assert.True(r.StatusCode == HttpStatusCode.OK, $"{(int)r.StatusCode}: {await r.Content.ReadAsStringAsync()}");
        return await Json(r);
    }

    static async Task Status(HttpStatusCode expected, string? code, Task<HttpResponseMessage> call)
    {
        var r = await call;
        Assert.True(r.StatusCode == expected, $"expected {(int)expected}, got {(int)r.StatusCode}: {await r.Content.ReadAsStringAsync()}");
        if (code is not null) Assert.Equal(code, await Code(r));
    }

    static async Task<Guid> PersonId(TestClient c, string search) =>
        (await Ok(c.Http.GetAsync($"{Api}/people?search={Uri.EscapeDataString(search)}"))).EnumerateArray().Single().GetProperty("id").GetGuid();

    static async Task<Guid> Group(TestClient c, string name, params Guid[] memberIds) =>
        (await Ok(c.PostAsync($"{Api}/groups", new { name, memberIds }))).GetProperty("id").GetGuid();

    static Task<JsonElement> Send(TestClient c, Guid conv, string body, Guid[]? mentionIds = null, bool? mentionAll = null) =>
        Ok(c.PostAsync($"{Api}/conversations/{conv}/messages", new { clientMessageId = Guid.NewGuid(), body, mentionIds, mentionAll }));

    static async Task<JsonElement[]> Messages(TestClient c, Guid conv) =>
        (await Ok(c.Http.GetAsync($"{Api}/conversations/{conv}/messages"))).GetProperty("items").EnumerateArray().ToArray();

    static async Task<JsonElement> ConversationOf(TestClient c, Guid conv) =>
        (await Ok(c.Http.GetAsync($"{Api}/conversations/{conv}"))).GetProperty("conversation");

    static async Task<HttpResponseMessage> Upload(TestClient c, Guid conversation, string fileName, byte[] content)
    {
        using var form = new MultipartFormDataContent();
        var part = new ByteArrayContent(content);
        part.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(part, "file", fileName);
        form.Add(new StringContent(Guid.NewGuid().ToString()), "clientMessageId");
        var req = new HttpRequestMessage(HttpMethod.Post, $"{Api}/conversations/{conversation}/files") { Content = form };
        req.Headers.Add("X-XSRF-TOKEN", c.Cookie("XSRF-TOKEN"));
        var r = await c.Http.SendAsync(req);
        await r.Content.LoadIntoBufferAsync();
        return r;
    }

    Task<long> UserIdOf(string email) => fx.QueryAsync<long>("SELECT UserId FROM auth.Users WHERE Email = @email", new { email });

    static string Tag() => Guid.NewGuid().ToString("N")[..8];

    ChatScheduledMessageWorker Worker => fx.Factory.Services.GetRequiredService<ChatScheduledMessageWorker>();

    async Task<string> WaitState(Guid scheduledId, params string[] states)
    {
        for (var i = 0; i < 100; i++)
        {
            var st = await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatScheduledMessage WHERE PublicId = @scheduledId", new { scheduledId });
            if (states.Contains(st)) return st;
            await Worker.RunOnceAsync();
            await Task.Delay(100);
        }
        Assert.Fail("The scheduled message was not handled.");
        return "";
    }

    [Fact]
    public async Task Advanced_features_are_off_until_switched_on_and_existing_endpoints_are_unchanged()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await PersonId(ana, "C-BEN");
        var g = await Group(ana, "Adv off " + Tag(), ben);
        var msg = await Send(ana, g, "Before the switch");
        var msgId = msg.GetProperty("id").GetGuid();
        Assert.True((await Ok(ana.Http.GetAsync($"{Api}/status"))).GetProperty("advanced").GetBoolean());
        try
        {
            await Switch("CHAT_ADVANCED", false);
            Assert.False((await Ok(ana.Http.GetAsync($"{Api}/status"))).GetProperty("advanced").GetBoolean());
            foreach (var call in new Func<Task<HttpResponseMessage>>[]
                     {
                         () => ana.Http.GetAsync($"{Api}/scheduled"),
                         () => ana.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "x", sendAtUtc = DateTime.UtcNow.AddHours(1) }),
                         () => ana.PostAsync($"{Api}/messages/{msgId}/save"), () => ana.DeleteAsync($"{Api}/messages/{msgId}/save"),
                         () => ana.Http.GetAsync($"{Api}/saved"),
                         () => ana.PostAsync($"{Api}/messages/{msgId}/pin"), () => ana.Http.GetAsync($"{Api}/conversations/{g}/pins"),
                         () => ana.Http.GetAsync($"{Api}/mentions"), () => ana.Http.GetAsync($"{Api}/favourites"),
                         () => ana.PutAsync($"{Api}/favourites/{ben}", new { }), () => ana.PostAsync($"{Api}/favourites/order", new { ids = new[] { ben } }),
                         () => ana.Http.GetAsync($"{Api}/tasks/followup-panel"),
                     })
                await Status(HttpStatusCode.Forbidden, "FEATURE_DISABLED", call());

            // Send with mentions still works but stores no mentions; @all is ignored (not refused) while the switch is off.
            var sent = await Send(ana, g, "Hello @Ben", [ben], true);
            Assert.Equal(0, await Count("SELECT COUNT(*) FROM chat.TRN_ChatMessageMention WHERE MessageId = @seq", new { seq = sent.GetProperty("seq").GetInt64() }));
            Assert.Empty(sent.GetProperty("mentions").EnumerateArray());
            Assert.False(sent.GetProperty("mentionAll").GetBoolean());
            // Search keeps requiring q (or files=true) while the switch is off.
            await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.Http.GetAsync($"{Api}/search?senderId={ben}"));
            // Preferences always show the quiet-hours fields; PUT ignores them while the switch is off.
            var prefs = await Ok(ana.PutAsync($"{Api}/me/preferences", new { quietEnabled = true, quietStart = "nonsense" }));
            Assert.False(prefs.GetProperty("quietEnabled").GetBoolean());
            Assert.Equal("22:00", prefs.GetProperty("quietStart").GetString());
            // No GROUP_ADDED bell while off.
            var cat = await PersonId(ana, "C-CAT");
            var catUser = await UserIdOf("ccat@test.invalid");
            var bells = await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @catUser AND [Type] = 'GROUP_ADDED'", new { catUser });
            Assert.Equal(HttpStatusCode.NoContent, (await ana.PostAsync($"{Api}/conversations/{g}/members", new { userIds = new[] { cat } })).StatusCode);
            Assert.Equal(bells, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @catUser AND [Type] = 'GROUP_ADDED'", new { catUser }));
        }
        finally { await Reset(); }
    }

    [Fact]
    public async Task Scheduled_messages_can_be_created_validated_changed_and_cancelled_and_are_private()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benC = await SignedIn("cben@test.invalid");
        var danC = await SignedIn("cdan@test.invalid");
        var ben = await PersonId(ana, "C-BEN");
        var name = "Sched " + Tag();
        var g = await Group(ana, name, ben);
        var now = DateTime.UtcNow;

        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "Too soon", sendAtUtc = now.AddSeconds(10) }));
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "Too late", sendAtUtc = now.AddDays(400) }));
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "  ", sendAtUtc = now.AddHours(1) }));
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "No time" }));
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", danC.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "Not a member", sendAtUtc = now.AddHours(1) }));

        var item = await Ok(ana.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "Monday update", sendAtUtc = now.AddHours(2) }));
        var id = item.GetProperty("id").GetGuid();
        Assert.Equal("PENDING", item.GetProperty("state").GetString());
        Assert.Equal(g, item.GetProperty("conversationId").GetGuid());
        Assert.Equal(name, item.GetProperty("conversationTitle").GetString());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("sentMessageId").ValueKind);
        Assert.Contains((await Ok(ana.Http.GetAsync($"{Api}/scheduled?conversationId={g}"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);

        // Private: Ben (a member of the chat) and Dan see nothing and cannot change it.
        Assert.DoesNotContain((await Ok(benC.Http.GetAsync($"{Api}/scheduled?state=all"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", Patch(benC, $"{Api}/scheduled/{id}", new { body = "Hijack" }));
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", danC.DeleteAsync($"{Api}/scheduled/{id}"));

        var newTime = now.AddHours(5);
        var changed = await Ok(Patch(ana, $"{Api}/scheduled/{id}", new { body = "Monday update (v2)", sendAtUtc = newTime }));
        Assert.Equal("Monday update (v2)", changed.GetProperty("body").GetString());
        Assert.True(Math.Abs((changed.GetProperty("sendAtUtc").GetDateTime().ToUniversalTime() - newTime).TotalSeconds) < 1);
        await Status(HttpStatusCode.BadRequest, "VALIDATION", Patch(ana, $"{Api}/scheduled/{id}", new { sendAtUtc = now.AddSeconds(5) }));
        Assert.Equal("Monday update (v2)", (await Ok(Patch(ana, $"{Api}/scheduled/{id}", new { sendAtUtc = newTime }))).GetProperty("body").GetString());

        var cancelled = await Ok(ana.DeleteAsync($"{Api}/scheduled/{id}"));
        Assert.Equal("CANCELLED", cancelled.GetProperty("state").GetString());
        await Status(HttpStatusCode.Conflict, "CONFLICT", Patch(ana, $"{Api}/scheduled/{id}", new { body = "Too late" }));
        await Status(HttpStatusCode.Conflict, "CONFLICT", ana.DeleteAsync($"{Api}/scheduled/{id}"));
        Assert.DoesNotContain((await Ok(ana.Http.GetAsync($"{Api}/scheduled"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        Assert.Contains((await Ok(ana.Http.GetAsync($"{Api}/scheduled?state=all"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        Assert.Contains((await Ok(ana.Http.GetAsync($"{Api}/scheduled?state=CANCELLED"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.Http.GetAsync($"{Api}/scheduled?state=WHATEVER"));

        // At most 100 waiting per person.
        var cat = await PersonId(danC, "C-CAT");
        var dg = await Group(danC, "Sched limit " + Tag(), cat);
        var danUser = await UserIdOf("cdan@test.invalid");
        await Exec("""
            INSERT chat.TRN_ChatScheduledMessage (ConversationId, SenderUserId, Body, SendAtUtc)
            SELECT TOP (100) c.ConversationId, @danUser, N'Filler', DATEADD(DAY, 300, SYSUTCDATETIME())
            FROM chat.TRN_ChatConversation c CROSS JOIN sys.all_objects o WHERE c.PublicId = @dg
            """, new { danUser, dg });
        try
        {
            await Status(HttpStatusCode.BadRequest, "LIMIT_REACHED", danC.PostAsync($"{Api}/conversations/{dg}/scheduled", new { body = "One more", sendAtUtc = now.AddHours(1) }));
        }
        finally
        {
            await Exec("UPDATE chat.TRN_ChatScheduledMessage SET [State] = 'CANCELLED' WHERE SenderUserId = @danUser AND Body = N'Filler'", new { danUser });
        }
    }

    [Fact]
    public async Task Scheduled_messages_are_sent_exactly_once_and_fail_when_the_sender_left()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benC = await SignedIn("cben@test.invalid");
        var catC = await SignedIn("ccat@test.invalid");
        var (ben, cat) = (await PersonId(ana, "C-BEN"), await PersonId(ana, "C-CAT"));
        var g = await Group(ana, "Sched send " + Tag(), ben, cat);
        var reply = await Send(ana, g, "Please confirm by Monday");
        var benUser = await UserIdOf("cben@test.invalid");

        var item = await Ok(benC.PostAsync($"{Api}/conversations/{g}/scheduled",
            new { body = "Confirmed - scheduled", sendAtUtc = DateTime.UtcNow.AddMinutes(30), replyToId = reply.GetProperty("id").GetGuid() }));
        var id = item.GetProperty("id").GetGuid();

        // Switched off: a due row waits.
        await Switch("CHAT_ADVANCED", false);
        try
        {
            await Exec("UPDATE chat.TRN_ChatScheduledMessage SET SendAtUtc = DATEADD(SECOND, -5, SYSUTCDATETIME()) WHERE PublicId = @id", new { id });
            Assert.Equal(0, await Worker.RunOnceAsync());
            Assert.Equal("PENDING", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatScheduledMessage WHERE PublicId = @id", new { id }));
        }
        finally { await Switch("CHAT_ADVANCED", true); }

        Assert.Equal("SENT", await WaitState(id, "SENT", "FAILED"));
        for (var i = 0; i < 3; i++) await Worker.RunOnceAsync();
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM chat.TRN_ChatMessage WHERE SenderUserId = @benUser AND ClientMessageId = @id", new { benUser, id }));
        var sentSeq = await fx.QueryAsync<long>("SELECT MessageId FROM chat.TRN_ChatMessage WHERE SenderUserId = @benUser AND ClientMessageId = @id", new { benUser, id });
        var listed = (await Ok(benC.Http.GetAsync($"{Api}/scheduled?state=SENT"))).GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(sentSeq, listed.GetProperty("sentSeq").GetInt64());
        Assert.NotEqual(JsonValueKind.Null, listed.GetProperty("sentMessageId").ValueKind);
        var delivered = (await Messages(ana, g)).Single(x => x.GetProperty("seq").GetInt64() == sentSeq);
        Assert.Equal("Confirmed - scheduled", delivered.GetProperty("body").GetString());
        Assert.Equal(id, delivered.GetProperty("clientMessageId").GetGuid());
        Assert.Equal(reply.GetProperty("id").GetGuid(), delivered.GetProperty("replyTo").GetProperty("id").GetGuid());
        Assert.Equal(ben, delivered.GetProperty("senderId").GetGuid());

        // A crash left it in SENDING: the retry after 5 minutes never creates a second message.
        await Exec("UPDATE chat.TRN_ChatScheduledMessage SET [State] = 'SENDING', SentMessageId = NULL, UpdatedUtc = DATEADD(MINUTE, -10, SYSUTCDATETIME()) WHERE PublicId = @id", new { id });
        Assert.Equal("SENT", await WaitState(id, "SENT", "FAILED"));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM chat.TRN_ChatMessage WHERE SenderUserId = @benUser AND ClientMessageId = @id", new { benUser, id }));
        Assert.Equal(sentSeq, await fx.QueryAsync<long>("SELECT SentMessageId FROM chat.TRN_ChatScheduledMessage WHERE PublicId = @id", new { id }));

        // Cat schedules, then is removed from the group: FAILED with a reason, nothing sent.
        var catItem = await Ok(catC.PostAsync($"{Api}/conversations/{g}/scheduled", new { body = "I will not arrive", sendAtUtc = DateTime.UtcNow.AddMinutes(30) }));
        var catId = catItem.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"{Api}/conversations/{g}/members/{cat}")).StatusCode);
        await Exec("UPDATE chat.TRN_ChatScheduledMessage SET SendAtUtc = DATEADD(SECOND, -5, SYSUTCDATETIME()) WHERE PublicId = @catId", new { catId });
        Assert.Equal("FAILED", await WaitState(catId, "SENT", "FAILED"));
        var failed = (await Ok(catC.Http.GetAsync($"{Api}/scheduled?state=FAILED"))).GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == catId);
        Assert.False(string.IsNullOrWhiteSpace(failed.GetProperty("failureReason").GetString()));
        Assert.Equal(JsonValueKind.Null, failed.GetProperty("sentMessageId").ValueKind);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM chat.TRN_ChatMessage WHERE ClientMessageId = @catId", new { catId }));
    }

    [Fact]
    public async Task Saved_messages_are_private_searchable_paged_and_dropped_when_no_longer_visible()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benC = await SignedIn("cben@test.invalid");
        var danC = await SignedIn("cdan@test.invalid");
        var ben = await PersonId(ana, "C-BEN");
        var tag = Tag();
        var g = await Group(ana, "Saved " + tag, ben);
        var m1 = (await Send(ana, g, $"alpha {tag} quote figures")).GetProperty("id").GetGuid();
        var m2 = (await Send(ana, g, $"beta {tag} to be deleted")).GetProperty("id").GetGuid();
        var up = await Upload(benC, g, $"report-{tag}.txt", Encoding.UTF8.GetBytes("Quarterly numbers"));
        Assert.True(up.StatusCode == HttpStatusCode.OK, await up.Content.ReadAsStringAsync());
        var fileMsg = (await Json(up)).GetProperty("id").GetGuid();

        var saved = await Ok(benC.PostAsync($"{Api}/messages/{m1}/save"));
        Assert.True(saved.GetProperty("saved").GetBoolean());
        Assert.True((await Ok(benC.PostAsync($"{Api}/messages/{m1}/save"))).GetProperty("saved").GetBoolean());   // idempotent
        await Ok(benC.PostAsync($"{Api}/messages/{fileMsg}/save"));
        await Ok(benC.PostAsync($"{Api}/messages/{m2}/save"));
        // Only for Ben: in Ana's view the message is not saved.
        Assert.False((await Messages(ana, g)).Single(x => x.GetProperty("id").GetGuid() == m1).GetProperty("saved").GetBoolean());
        Assert.True((await Messages(benC, g)).Single(x => x.GetProperty("id").GetGuid() == m1).GetProperty("saved").GetBoolean());
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", danC.PostAsync($"{Api}/messages/{m1}/save"));
        var system = (await Messages(ana, g)).First(x => x.GetProperty("kind").GetString() == "SYSTEM").GetProperty("id").GetGuid();
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/messages/{system}/save"));

        async Task<Guid[]> SavedIds(TestClient c, string query = "") =>
            (await Ok(c.Http.GetAsync($"{Api}/saved?search={Uri.EscapeDataString(tag)}{query}"))).GetProperty("items").EnumerateArray()
                .Select(x => x.GetProperty("message").GetProperty("id").GetGuid()).ToArray();

        Assert.Equal([m2, fileMsg, m1], await SavedIds(benC));   // most recently saved first
        Assert.Empty(await SavedIds(ana));
        Assert.Equal([fileMsg], (await Ok(benC.Http.GetAsync($"{Api}/saved?search=report-{tag}"))).GetProperty("items").EnumerateArray()
            .Select(x => x.GetProperty("message").GetProperty("id").GetGuid()).ToArray());
        var first = (await Ok(benC.Http.GetAsync($"{Api}/saved?search=alpha%20{tag}"))).GetProperty("items").EnumerateArray().Single();
        Assert.Equal(m1, first.GetProperty("message").GetProperty("id").GetGuid());
        Assert.Equal(g, first.GetProperty("conversationId").GetGuid());
        Assert.Equal("Saved " + tag, first.GetProperty("conversationTitle").GetString());
        Assert.True(first.GetProperty("isGroup").GetBoolean());

        // Paging with the opaque cursor.
        var p1 = await Ok(benC.Http.GetAsync($"{Api}/saved?search={tag}&limit=2"));
        Assert.True(p1.GetProperty("hasMore").GetBoolean());
        Assert.Equal(2, p1.GetProperty("items").GetArrayLength());
        var p2 = await Ok(benC.Http.GetAsync($"{Api}/saved?search={tag}&limit=2&before={p1.GetProperty("nextBefore").GetString()}"));
        Assert.False(p2.GetProperty("hasMore").GetBoolean());
        Assert.Equal(m1, p2.GetProperty("items")[0].GetProperty("message").GetProperty("id").GetGuid());
        await Status(HttpStatusCode.BadRequest, "VALIDATION", benC.Http.GetAsync($"{Api}/saved?before=abc"));

        // Deleted messages drop out.
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"{Api}/messages/{m2}")).StatusCode);
        Assert.Equal([fileMsg, m1], await SavedIds(benC));

        // Unsave (idempotent).
        Assert.False((await Ok(benC.DeleteAsync($"{Api}/messages/{fileMsg}/save"))).GetProperty("saved").GetBoolean());
        Assert.False((await Ok(benC.DeleteAsync($"{Api}/messages/{fileMsg}/save"))).GetProperty("saved").GetBoolean());
        Assert.Equal([m1], await SavedIds(benC));

        // After leaving the group nothing from it is listed.
        Assert.Equal(HttpStatusCode.NoContent, (await benC.DeleteAsync($"{Api}/conversations/{g}/members/{ben}")).StatusCode);
        Assert.Empty(await SavedIds(benC));
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", benC.PostAsync($"{Api}/messages/{m1}/save"));
    }

    [Fact]
    public async Task Pinned_messages_follow_the_rules_and_limit()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benC = await SignedIn("cben@test.invalid");
        var catC = await SignedIn("ccat@test.invalid");
        var danC = await SignedIn("cdan@test.invalid");
        var (ben, cat) = (await PersonId(ana, "C-BEN"), await PersonId(ana, "C-CAT"));
        var g = await Group(ana, "Pins " + Tag(), ben, cat);
        var m1 = (await Send(benC, g, "Agenda for Friday")).GetProperty("id").GetGuid();

        var pinned = await Ok(benC.PostAsync($"{Api}/messages/{m1}/pin"));
        Assert.True(pinned.GetProperty("pinned").GetBoolean());
        Assert.True((await Ok(benC.PostAsync($"{Api}/messages/{m1}/pin"))).GetProperty("pinned").GetBoolean());   // idempotent
        var pins = (await Ok(catC.Http.GetAsync($"{Api}/conversations/{g}/pins"))).EnumerateArray().ToList();
        Assert.Single(pins);
        Assert.Equal(ben, pins[0].GetProperty("pinnedBy").GetProperty("id").GetGuid());
        Assert.Equal("Ben Chat", pins[0].GetProperty("pinnedBy").GetProperty("name").GetString());
        Assert.Equal(m1, pins[0].GetProperty("message").GetProperty("id").GetGuid());
        Assert.True((await Messages(ana, g)).Single(x => x.GetProperty("id").GetGuid() == m1).GetProperty("pinned").GetBoolean());

        // Unpin: the pinner or a group admin; another member is refused. Outsiders see nothing.
        await Status(HttpStatusCode.Forbidden, "FORBIDDEN", catC.DeleteAsync($"{Api}/messages/{m1}/pin"));
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", danC.Http.GetAsync($"{Api}/conversations/{g}/pins"));
        await Status(HttpStatusCode.NotFound, "NOT_FOUND", danC.PostAsync($"{Api}/messages/{m1}/pin"));
        Assert.False((await Ok(ana.DeleteAsync($"{Api}/messages/{m1}/pin"))).GetProperty("pinned").GetBoolean());
        await Ok(benC.PostAsync($"{Api}/messages/{m1}/pin"));
        Assert.False((await Ok(benC.DeleteAsync($"{Api}/messages/{m1}/pin"))).GetProperty("pinned").GetBoolean());
        Assert.False((await Ok(benC.DeleteAsync($"{Api}/messages/{m1}/pin"))).GetProperty("pinned").GetBoolean());   // idempotent

        // Not for SYSTEM lines; deleting a message removes its pin.
        var system = (await Messages(ana, g)).First(x => x.GetProperty("kind").GetString() == "SYSTEM").GetProperty("id").GetGuid();
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/messages/{system}/pin"));
        var doomed = (await Send(ana, g, "Wrong agenda")).GetProperty("id").GetGuid();
        await Ok(catC.PostAsync($"{Api}/messages/{doomed}/pin"));
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"{Api}/messages/{doomed}")).StatusCode);
        Assert.Empty((await Ok(ana.Http.GetAsync($"{Api}/conversations/{g}/pins"))).EnumerateArray());
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.PostAsync($"{Api}/messages/{doomed}/pin"));

        // At most 20 per conversation; newest first.
        var ids = new List<Guid>();
        for (var i = 0; i < 21; i++) ids.Add((await Send(ana, g, $"Pin me {i}")).GetProperty("id").GetGuid());
        foreach (var id in ids.Take(20)) await Ok(ana.PostAsync($"{Api}/messages/{id}/pin"));
        await Status(HttpStatusCode.BadRequest, "LIMIT_REACHED", ana.PostAsync($"{Api}/messages/{ids[20]}/pin"));
        var list = (await Ok(benC.Http.GetAsync($"{Api}/conversations/{g}/pins"))).EnumerateArray().ToList();
        Assert.Equal(20, list.Count);
        Assert.Equal(ids[19], list[0].GetProperty("message").GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Mentions_are_filtered_to_members_create_bells_and_count_as_unread_until_read()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benC = await SignedIn("cben@test.invalid");
        var catC = await SignedIn("ccat@test.invalid");
        var (ben, cat, dan) = (await PersonId(ana, "C-BEN"), await PersonId(ana, "C-CAT"), await PersonId(ana, "C-DAN"));
        var (benUser, catUser) = (await UserIdOf("cben@test.invalid"), await UserIdOf("ccat@test.invalid"));
        var name = "Mentions " + Tag();
        var g = await Group(ana, name, ben, cat);

        // Cat mutes the group: mention bells are still written.
        await Ok(catC.PostAsync($"{Api}/conversations/{g}/mute", new { forever = true }));
        async Task<int> Bells(long user) => await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @user AND [Type] = 'CHAT_MENTION' AND LinkPath LIKE @link",
            new { user, link = $"/chat?c={g}&seq=%" });

        var m1 = await Send(benC, g, "@Cat can you check the figures?", [cat, dan, ben, Guid.NewGuid()]);
        var mentions = m1.GetProperty("mentions").EnumerateArray().ToList();
        Assert.Single(mentions);
        Assert.Equal(cat, mentions[0].GetProperty("id").GetGuid());
        Assert.Equal("Cat Chat", mentions[0].GetProperty("name").GetString());
        Assert.False(m1.GetProperty("mentionsMe").GetBoolean());
        Assert.Equal(1, await Bells(catUser));
        Assert.Equal(0, await Bells(benUser));
        var bell = await fx.QueryAsync<(string Title, string Body, string LinkPath)>(
            "SELECT TOP 1 Title, Body, LinkPath FROM mtg.MeetingNotifications WHERE RecipientUserId = @catUser AND [Type] = 'CHAT_MENTION' ORDER BY NotificationId DESC", new { catUser });
        Assert.Equal($"Ben Chat mentioned you in {name}", bell.Title);
        Assert.Equal("@Cat can you check the figures?", bell.Body);
        Assert.Equal($"/chat?c={g}&seq={m1.GetProperty("seq").GetInt64()}", bell.LinkPath);
        Assert.True((await Messages(catC, g)).Single(x => x.GetProperty("seq").GetInt64() == m1.GetProperty("seq").GetInt64()).GetProperty("mentionsMe").GetBoolean());
        Assert.False((await Messages(ana, g)).Single(x => x.GetProperty("seq").GetInt64() == m1.GetProperty("seq").GetInt64()).GetProperty("mentionsMe").GetBoolean());

        // @all: group admins only, never in a direct chat; the message is not sent.
        var before = (await Messages(ana, g)).Length;
        await Status(HttpStatusCode.Forbidden, "MENTION_ALL_NOT_ALLOWED", benC.PostAsync($"{Api}/conversations/{g}/messages", new { body = "@all hello", mentionAll = true }));
        Assert.Equal(before, (await Messages(ana, g)).Length);
        var direct = (await Ok(ana.PostAsync($"{Api}/direct", new { userId = ben }))).GetProperty("id").GetGuid();
        await Status(HttpStatusCode.Forbidden, "MENTION_ALL_NOT_ALLOWED", ana.PostAsync($"{Api}/conversations/{direct}/messages", new { body = "@all hello", mentionAll = true }));

        var all = await Send(ana, g, "@all meeting moved to 4 pm", mentionAll: true);
        Assert.True(all.GetProperty("mentionAll").GetBoolean());
        Assert.False(all.GetProperty("mentionsMe").GetBoolean());   // the sender is not mentioned by @all
        Assert.Equal(2, await Bells(catUser));
        Assert.Equal(1, await Bells(benUser));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = 'cana@test.invalid' AND n.LinkPath LIKE @link",
            new { link = $"/chat?c={g}&seq=%" }));

        Assert.Equal(2, (await ConversationOf(catC, g)).GetProperty("mentionsUnread").GetInt32());
        Assert.Equal(1, (await ConversationOf(benC, g)).GetProperty("mentionsUnread").GetInt32());
        Assert.Equal(0, (await ConversationOf(ana, g)).GetProperty("mentionsUnread").GetInt32());
        Assert.Contains((await Ok(catC.Http.GetAsync($"{Api}/conversations"))).EnumerateArray(),
            x => x.GetProperty("id").GetGuid() == g && x.GetProperty("mentionsUnread").GetInt32() == 2);

        // Mentions list: newest first, with the conversation title; Ana's own @all is not in hers.
        var list = (await Ok(catC.Http.GetAsync($"{Api}/mentions"))).GetProperty("items").EnumerateArray().Take(2).ToList();
        Assert.Equal(all.GetProperty("id").GetGuid(), list[0].GetProperty("id").GetGuid());
        Assert.Equal(m1.GetProperty("id").GetGuid(), list[1].GetProperty("id").GetGuid());
        Assert.Equal(name, list[0].GetProperty("conversationTitle").GetString());
        Assert.True(list[0].GetProperty("mentionsMe").GetBoolean());
        Assert.DoesNotContain((await Ok(ana.Http.GetAsync($"{Api}/mentions"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == all.GetProperty("id").GetGuid());
        var older = await Ok(catC.Http.GetAsync($"{Api}/mentions?before={all.GetProperty("seq").GetInt64()}"));
        Assert.Equal(m1.GetProperty("id").GetGuid(), older.GetProperty("items")[0].GetProperty("id").GetGuid());

        // Reading clears the count.
        Assert.Equal(HttpStatusCode.NoContent, (await catC.PostAsync($"{Api}/conversations/{g}/read", new { seq = all.GetProperty("seq").GetInt64() })).StatusCode);
        Assert.Equal(0, (await ConversationOf(catC, g)).GetProperty("mentionsUnread").GetInt32());
    }

    [Fact]
    public async Task People_added_to_a_group_get_a_bell()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var (ben, cat, dan) = (await PersonId(ana, "C-BEN"), await PersonId(ana, "C-CAT"), await PersonId(ana, "C-DAN"));
        var name = "Added " + Tag();
        var g = await Group(ana, name, ben, cat);
        async Task<int> Bells(string email) => await Count("""
            SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId
            WHERE u.Email = @email AND n.[Type] = 'GROUP_ADDED' AND n.LinkPath = @link
            """, new { email, link = $"/chat?c={g}" });
        Assert.Equal(1, await Bells("cben@test.invalid"));
        Assert.Equal(1, await Bells("ccat@test.invalid"));
        Assert.Equal(0, await Bells("cana@test.invalid"));
        Assert.Equal(0, await Bells("cdan@test.invalid"));
        Assert.Equal($"Ana Chat added you to {name}", await fx.QueryAsync<string>(
            "SELECT TOP 1 n.Title FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE u.Email = 'cben@test.invalid' AND n.LinkPath = @link",
            new { link = $"/chat?c={g}" }));
        Assert.Equal(HttpStatusCode.NoContent, (await ana.PostAsync($"{Api}/conversations/{g}/members", new { userIds = new[] { dan } })).StatusCode);
        Assert.Equal(1, await Bells("cdan@test.invalid"));
        Assert.Equal(1, await Bells("cben@test.invalid"));
    }

    [Fact]
    public async Task Search_filters_by_sender_date_and_files_with_paging()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benC = await SignedIn("cben@test.invalid");
        var ben = await PersonId(ana, "C-BEN");
        var tag = Tag();
        var start = DateTime.UtcNow.AddSeconds(-2);
        var g = await Group(ana, "Search " + tag, ben);
        var b1 = await Send(benC, g, $"{tag} renewal one");
        var a1 = await Send(ana, g, $"{tag} renewal two");
        var up = await Upload(benC, g, $"policy-{tag}.txt", Encoding.UTF8.GetBytes("Policy text"));
        Assert.True(up.StatusCode == HttpStatusCode.OK, await up.Content.ReadAsStringAsync());
        var file = (await Json(up)).GetProperty("id").GetGuid();

        async Task<(Guid[] Ids, bool HasMore)> Find(string query)
        {
            var r = await Ok(ana.Http.GetAsync($"{Api}/search?conversationId={g}&{query}"));
            return (r.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray(), r.GetProperty("hasMore").GetBoolean());
        }

        Assert.Equal([file, b1.GetProperty("id").GetGuid()], (await Find($"senderId={ben}")).Ids);   // q may be empty with another filter
        Assert.Equal([file], (await Find("files=true")).Ids);
        Assert.Equal([file], (await Find($"files=true&q=policy-{tag}")).Ids);
        Assert.Equal([a1.GetProperty("id").GetGuid(), b1.GetProperty("id").GetGuid()], (await Find($"q=renewal&from={Iso(start)}")).Ids);
        Assert.Empty((await Find($"q={tag}&to={Iso(start)}")).Ids);
        Assert.Empty((await Find($"from={Iso(DateTime.UtcNow.AddMinutes(5))}")).Ids);
        // Paging: before = seq of the last item shown.
        var (all, more) = await Find($"q={tag}");
        Assert.False(more);
        Assert.Equal(3, all.Length);
        Assert.Equal([a1.GetProperty("id").GetGuid(), b1.GetProperty("id").GetGuid()], (await Find($"q={tag}&before={(await Messages(ana, g)).Single(x => x.GetProperty("id").GetGuid() == file).GetProperty("seq").GetInt64()}")).Ids);
        // Old parameter names still work; with no filter at all the search is refused.
        Assert.Single((await Find($"q={tag}&fromUtc={Iso(start)}&senderId={ben}&files=true")).Ids);
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.Http.GetAsync($"{Api}/search"));
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.Http.GetAsync($"{Api}/search?q=%20"));
        // Results carry the new message fields.
        var item = (await Ok(ana.Http.GetAsync($"{Api}/search?conversationId={g}&q=renewal%20two"))).GetProperty("items")[0];
        Assert.False(item.GetProperty("saved").GetBoolean());
        Assert.Equal(JsonValueKind.Array, item.GetProperty("mentions").ValueKind);
    }

    [Fact]
    public async Task Favourites_can_be_added_ordered_removed_and_are_limited()
    {
        await Reset();
        var danC = await SignedIn("cdan@test.invalid");
        var danUser = await UserIdOf("cdan@test.invalid");
        await Exec("DELETE FROM chat.TRN_ChatFavourite WHERE UserId = @danUser", new { danUser });
        var (ana, ben, cat, dan) = (await PersonId(danC, "C-ANA"), await PersonId(danC, "C-BEN"), await PersonId(danC, "C-CAT"), (await Ok(danC.Http.GetAsync($"{Api}/status"))).GetProperty("me").GetProperty("id").GetGuid());
        try
        {
            static Guid[] Ids(JsonElement list) => list.EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray();
            await Ok(danC.PutAsync($"{Api}/favourites/{ana}", new { }));
            await Ok(danC.PutAsync($"{Api}/favourites/{ben}", new { }));
            var list = await Ok(danC.PutAsync($"{Api}/favourites/{cat}", new { }));
            Assert.Equal([ana, ben, cat], Ids(list));
            Assert.Equal([ana, ben, cat], Ids(await Ok(danC.PutAsync($"{Api}/favourites/{ben}", new { }))));   // idempotent
            var first = list[0];
            Assert.Equal("Ana Chat", first.GetProperty("name").GetString());
            Assert.Equal("C-ANA", first.GetProperty("code").GetString());
            Assert.Equal(0, first.GetProperty("sortOrder").GetInt32());
            Assert.True(first.TryGetProperty("presence", out _));
            Assert.True(first.TryGetProperty("department", out _));

            Assert.Equal([cat, ana, ben], Ids(await Ok(danC.PostAsync($"{Api}/favourites/order", new { ids = new[] { cat, ana } }))));
            Assert.Equal([cat, ana, ben], Ids(await Ok(danC.Http.GetAsync($"{Api}/favourites"))));
            Assert.Equal([cat, ben], Ids(await Ok(danC.DeleteAsync($"{Api}/favourites/{ana}"))));
            Assert.Equal([cat, ben], Ids(await Ok(danC.DeleteAsync($"{Api}/favourites/{ana}"))));   // idempotent

            await Status(HttpStatusCode.BadRequest, "VALIDATION", danC.PutAsync($"{Api}/favourites/{dan}", new { }));
            await Status(HttpStatusCode.NotFound, "NOT_FOUND", danC.PutAsync($"{Api}/favourites/{Guid.NewGuid()}", new { }));

            // At most 30 (filled directly with other accounts, active or not; a few inactive placeholder accounts make sure there are enough).
            await Exec("""
                INSERT auth.Users (Email, PasswordHash, IsActive)
                SELECT v.Email, (SELECT PasswordHash FROM auth.Users WHERE UserId = @danUser), 0
                FROM (VALUES (N'favfill1@test.invalid'), (N'favfill2@test.invalid'), (N'favfill3@test.invalid'), (N'favfill4@test.invalid'), (N'favfill5@test.invalid')) v (Email)
                WHERE NOT EXISTS (SELECT 1 FROM auth.Users u WHERE u.Email = v.Email)
                """, new { danUser });
            await Exec("""
                INSERT chat.TRN_ChatFavourite (UserId, FavouriteUserId, SortOrder)
                SELECT TOP (28) @danUser, u.UserId, 100 FROM auth.Users u
                WHERE u.UserId <> @danUser AND NOT EXISTS (SELECT 1 FROM chat.TRN_ChatFavourite f WHERE f.UserId = @danUser AND f.FavouriteUserId = u.UserId)
                  AND u.Email <> 'cana@test.invalid'
                """, new { danUser });
            Assert.Equal(30, await Count("SELECT COUNT(*) FROM chat.TRN_ChatFavourite WHERE UserId = @danUser", new { danUser }));
            await Status(HttpStatusCode.BadRequest, "LIMIT_REACHED", danC.PutAsync($"{Api}/favourites/{ana}", new { }));
        }
        finally { await Exec("DELETE FROM chat.TRN_ChatFavourite WHERE UserId = @danUser", new { danUser }); }
    }

    [Fact]
    public async Task Quiet_hours_round_trip_validate_and_compute_quiet_now()
    {
        await Reset();
        var danC = await SignedIn("cdan@test.invalid");
        try
        {
            var prefs = await Ok(danC.Http.GetAsync($"{Api}/me/preferences"));
            Assert.False(prefs.GetProperty("quietEnabled").GetBoolean());
            Assert.Equal("22:00", prefs.GetProperty("quietStart").GetString());
            Assert.Equal("07:00", prefs.GetProperty("quietEnd").GetString());
            Assert.Equal(127, prefs.GetProperty("quietDays").GetInt32());
            Assert.Equal("SILENT", prefs.GetProperty("quietCallPolicy").GetString());
            Assert.True(prefs.GetProperty("quietAllowMentions").GetBoolean());
            Assert.True(prefs.GetProperty("quietAllowUrgent").GetBoolean());
            Assert.Equal("Asia/Kolkata", prefs.GetProperty("timeZone").GetString());
            Assert.False(prefs.GetProperty("quietNow").GetBoolean());
            Assert.Equal("AVAILABLE", prefs.GetProperty("availability").GetString());

            var set = await Ok(danC.PutAsync($"{Api}/me/preferences",
                new { quietEnabled = true, quietStart = "21:30", quietEnd = "06:15", quietDays = 31, quietCallPolicy = "ring", quietAllowMentions = false, quietAllowUrgent = false }));
            Assert.True(set.GetProperty("quietEnabled").GetBoolean());
            Assert.Equal("21:30", set.GetProperty("quietStart").GetString());
            Assert.Equal("06:15", set.GetProperty("quietEnd").GetString());
            Assert.Equal(31, set.GetProperty("quietDays").GetInt32());
            Assert.Equal("RING", set.GetProperty("quietCallPolicy").GetString());
            Assert.False(set.GetProperty("quietAllowMentions").GetBoolean());
            Assert.False(set.GetProperty("quietAllowUrgent").GetBoolean());
            // Fields not sent are kept; status carries the same preferences.
            var kept = await Ok(danC.PutAsync($"{Api}/me/preferences", new { soundsOn = true }));
            Assert.Equal("21:30", kept.GetProperty("quietStart").GetString());
            Assert.Equal("21:30", (await Ok(danC.Http.GetAsync($"{Api}/status"))).GetProperty("preferences").GetProperty("quietStart").GetString());

            foreach (var bad in new object[] { new { quietStart = "25:00" }, new { quietEnd = "7pm" }, new { quietDays = 128 }, new { quietDays = -1 }, new { quietCallPolicy = "LOUD" } })
                await Status(HttpStatusCode.BadRequest, "VALIDATION", danC.PutAsync($"{Api}/me/preferences", bad));
            Assert.Equal("21:30", (await Ok(danC.Http.GetAsync($"{Api}/me/preferences"))).GetProperty("quietStart").GetString());

            // quietNow: start = end is the whole of each ticked day.
            Assert.True((await Ok(danC.PutAsync($"{Api}/me/preferences", new { quietEnabled = true, quietStart = "00:00", quietEnd = "00:00", quietDays = 127 }))).GetProperty("quietNow").GetBoolean());
            Assert.False((await Ok(danC.PutAsync($"{Api}/me/preferences", new { quietDays = 0 }))).GetProperty("quietNow").GetBoolean());
            Assert.False((await Ok(danC.PutAsync($"{Api}/me/preferences", new { quietDays = 127, quietEnabled = false }))).GetProperty("quietNow").GetBoolean());
        }
        finally
        {
            await Ok(danC.PutAsync($"{Api}/me/preferences", new
            {
                quietEnabled = false, quietStart = "22:00", quietEnd = "07:00", quietDays = 127, quietCallPolicy = "SILENT", quietAllowMentions = true, quietAllowUrgent = true,
            }));
        }

        // The overnight window 22:00-07:00 with only Monday ticked (bit 0): the day the window starts on counts.
        var start = new TimeSpan(22, 0, 0);
        var end = new TimeSpan(7, 0, 0);
        var monday = new DateTime(2026, 11, 16);   // a Monday
        Assert.True(ChatAdvancedEndpoints.IsQuietNow(true, start, end, 1, monday.AddHours(23)));
        Assert.True(ChatAdvancedEndpoints.IsQuietNow(true, start, end, 1, monday.AddDays(1).AddHours(2)));     // Tuesday 02:00, started Monday
        Assert.False(ChatAdvancedEndpoints.IsQuietNow(true, start, end, 1, monday.AddHours(2)));               // Monday 02:00, started Sunday
        Assert.False(ChatAdvancedEndpoints.IsQuietNow(true, start, end, 1, monday.AddDays(1).AddHours(23)));   // Tuesday 23:00
        Assert.False(ChatAdvancedEndpoints.IsQuietNow(true, start, end, 1, monday.AddHours(12)));
        Assert.False(ChatAdvancedEndpoints.IsQuietNow(false, start, end, 127, monday.AddHours(23)));
        // A daytime window.
        Assert.True(ChatAdvancedEndpoints.IsQuietNow(true, new TimeSpan(13, 0, 0), new TimeSpan(14, 0, 0), 1 << 6, monday.AddDays(6).AddHours(13.5)));   // Sunday
        Assert.False(ChatAdvancedEndpoints.IsQuietNow(true, new TimeSpan(13, 0, 0), new TimeSpan(14, 0, 0), 1 << 6, monday.AddDays(6).AddHours(14)));
    }

    [Fact]
    public async Task Tasks_week_filter_and_follow_up_panel()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var now = DateTime.UtcNow;
        var (ds, de) = (now.AddHours(-1), now.AddHours(5));
        var tag = Tag();
        async Task<Guid> NewTask(string title, DateTime? due) =>
            (await Ok(ana.PostAsync($"{Api}/tasks", new { title = $"{title} {tag}", dueUtc = due }))).GetProperty("id").GetGuid();
        var overdue = await NewTask("Overdue", now.AddDays(-1));
        var today = await NewTask("Today", now.AddHours(2));
        var week = await NewTask("Week", now.AddDays(3));
        var later = await NewTask("Later", now.AddDays(10));
        var done = await NewTask("Done", now.AddDays(2));
        await Ok(ana.PostAsync($"{Api}/tasks/{done}/status", new { status = "COMPLETED" }));
        var window = $"dayStartUtc={Iso(ds)}&dayEndUtc={Iso(de)}";

        var weekIds = (await Ok(ana.Http.GetAsync($"{Api}/tasks?filter=week&search={tag}&{window}"))).GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray();
        Assert.Equal([today, week], weekIds);
        await Status(HttpStatusCode.BadRequest, "VALIDATION", ana.Http.GetAsync($"{Api}/tasks?filter=week-rest"));

        var panel = await Ok(ana.Http.GetAsync($"{Api}/tasks/followup-panel?{window}"));
        Guid[] Of(string key) => panel.GetProperty(key).EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray();
        Assert.Contains(overdue, Of("overdue"));
        Assert.Contains(today, Of("today"));
        Assert.Contains(week, Of("week"));
        Assert.DoesNotContain(today, Of("week"));
        foreach (var key in new[] { "overdue", "today", "week" })
        {
            Assert.DoesNotContain(later, Of(key));
            Assert.DoesNotContain(done, Of(key));
        }
    }
}
