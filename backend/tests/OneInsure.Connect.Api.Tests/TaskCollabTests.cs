using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Chat;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Task collaboration (V033): the TASK_COLLAB switch, assigning to colleagues (one copy each, private to the two people), what the
/// owner may and may not change, "needs my review" (send for review, send back, approve), required checklist steps, decline and
/// new-date requests, withdraw, comments, nudges, overdue alerts, Top 3 for today, shared notes and link privacy.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class TaskCollabTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    const string Api = "/api/v1/chat";

    static async Task<JsonElement> Json(HttpResponseMessage r)
    {
        await r.Content.LoadIntoBufferAsync();
        var text = await r.Content.ReadAsStringAsync();
        return text.Length == 0 ? default : JsonDocument.Parse(text).RootElement;
    }
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)) is { ValueKind: JsonValueKind.Object } j && j.TryGetProperty("code", out var c) ? c.GetString() : null;

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    async Task Switch(string key, bool on)
    {
        await Exec("UPDATE app.FeatureSettings SET IsEnabled = @on WHERE FeatureKey = @key", new { on, key });
        var cache = fx.Factory.Services.GetRequiredService<IMemoryCache>();
        foreach (var k in new[] { "chat:enabled", "chat:calls-enabled", "chat:tasks-enabled", "chat:task-collab" }) cache.Remove(k);
    }

    async Task Reset()
    {
        await Switch("CHAT", true);
        await Switch("CHAT_TASKS", true);
        await Switch("TASK_COLLAB", true);
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

    static async Task Fails(Task<HttpResponseMessage> call, HttpStatusCode status, string? code = null)
    {
        var r = await call;
        Assert.True(r.StatusCode == status, $"expected {(int)status}, got {(int)r.StatusCode}: {await r.Content.ReadAsStringAsync()}");
        if (code is not null) Assert.Equal(code, await Code(r));
    }

    static async Task<Guid> UserId(TestClient c, string search) =>
        (await Ok(c.Http.GetAsync($"{Api}/tasks/assignees?search={Uri.EscapeDataString(search)}"))).GetProperty("items").EnumerateArray().Single().GetProperty("id").GetGuid();

    static async Task<JsonElement[]> List(TestClient c, string filter) =>
        (await Ok(c.Http.GetAsync($"{Api}/tasks?filter={filter}"))).GetProperty("items").EnumerateArray().ToArray();

    static async Task<JsonElement> Find(TestClient c, string filter, string title) =>
        (await List(c, filter)).Single(t => t.GetProperty("title").GetString() == title);

    Task<int> Notifications(string email, string type, string titleLike) =>
        fx.QueryAsync<int>("""
            SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId
            WHERE u.Email = @email AND n.[Type] = @type AND n.Title LIKE @like
            """, new { email, type, like = "%" + titleLike + "%" });

    static string Unique(string s) => $"{s} {Guid.NewGuid().ToString("N")[..6]}";

    [Fact]
    public async Task Assigning_is_off_until_switched_on()
    {
        await Reset();
        try
        {
            var ana = await SignedIn("cana@test.invalid");
            var ben = await UserId(ana, "Ben Chat");
            Assert.True((await Ok(ana.Http.GetAsync($"{Api}/status"))).GetProperty("taskCollab").GetBoolean());
            await Switch("TASK_COLLAB", false);
            Assert.False((await Ok(ana.Http.GetAsync($"{Api}/status"))).GetProperty("taskCollab").GetBoolean());
            await Fails(ana.PostAsync($"{Api}/tasks", new { title = "x", assigneeIds = new[] { ben } }), HttpStatusCode.Forbidden, "FEATURE_DISABLED");
            await Fails(ana.Http.GetAsync($"{Api}/tasks/assignees"), HttpStatusCode.Forbidden, "FEATURE_DISABLED");
            // Personal tasks, checklists and Top 3 still work.
            var own = await Ok(ana.PostAsync($"{Api}/tasks", new { title = Unique("Own"), checklist = new[] { new { text = "Step", isRequired = true } } }));
            Assert.Equal("mine", own.GetProperty("role").GetString());
            Assert.Equal(1, own.GetProperty("checklist").GetProperty("requiredOpen").GetInt32());
        }
        finally { await Reset(); }
    }

    [Fact]
    public async Task Assigned_task_with_review_full_flow()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var benId = await UserId(ana, "Ben Chat");
        var catId = await UserId(ana, "Cat Chat");
        var title = Unique("Prepare renewal quote");
        var created = await Ok(ana.PostAsync($"{Api}/tasks", new
        {
            title, description = "For the Sharma account", priority = "HIGH", dueUtc = DateTime.UtcNow.AddDays(2), requiresReview = true,
            assigneeIds = new[] { benId, catId },
            checklist = new object[] { new { text = "Collect documents", isRequired = true }, new { text = "Nice to have", isRequired = false } },
        }));
        Assert.Equal("assigner", created.GetProperty("role").GetString());

        // One copy each, both visible to Ana; Dan sees neither.
        var mine = (await List(ana, "delegated")).Where(t => t.GetProperty("title").GetString() == title).ToArray();
        Assert.Equal(2, mine.Length);
        Assert.Single(mine.Select(t => t.GetProperty("assignmentKey").GetGuid()).Distinct());
        var task = await Find(ben, "all", title);
        var id = task.GetProperty("id").GetGuid();
        Assert.Equal("assignee", task.GetProperty("role").GetString());
        Assert.Equal("PENDING", task.GetProperty("assignState").GetString());
        Assert.Equal("Ana Chat", task.GetProperty("assignedBy").GetProperty("name").GetString());
        Assert.True(task.GetProperty("canSubmit").GetBoolean());
        Assert.False(task.GetProperty("canComplete").GetBoolean());
        await Fails(dan.Http.GetAsync($"{Api}/tasks/{id}"), HttpStatusCode.NotFound);
        await Fails(dan.Http.GetAsync($"{Api}/tasks/{id}/details"), HttpStatusCode.NotFound);
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_ASSIGNED", title));
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.EmailOutbox WHERE Template = 'TASK_ASSIGNED' AND ToAddress = N'cben@test.invalid' AND Subject LIKE @t",
            new { t = "%" + title + "%" }));

        // Ben's private notes stay private.
        await Ok(Patch(ben, $"{Api}/tasks/{id}", new { notes = "Call the client first" }));
        Assert.Equal(JsonValueKind.Null, (await Ok(ana.Http.GetAsync($"{Api}/tasks/{id}"))).GetProperty("notes").ValueKind);

        // What Ben may not do.
        await Fails(Patch(ben, $"{Api}/tasks/{id}", new { title = "Renamed" }), HttpStatusCode.Conflict, "ASSIGNED_TASK");
        await Fails(ben.PostAsync($"{Api}/tasks/{id}/status", new { status = "COMPLETED" }), HttpStatusCode.Conflict, "REVIEW_REQUIRED");
        await Fails(ben.PostAsync($"{Api}/tasks/{id}/status", new { status = "IN_REVIEW" }), HttpStatusCode.Conflict, "USE_SUBMIT");
        await Fails(ben.DeleteAsync($"{Api}/tasks/{id}"), HttpStatusCode.Conflict, "ASSIGNED_TASK");
        await Fails(ben.PostAsync($"{Api}/tasks/{id}/submit", new { }), HttpStatusCode.Conflict, "CHECKLIST_INCOMPLETE");
        await Fails(ben.PostAsync($"{Api}/tasks/{id}/review", new { approve = true }), HttpStatusCode.Forbidden);
        await Fails(ana.PostAsync($"{Api}/tasks/{id}/status", new { status = "IN_PROGRESS" }), HttpStatusCode.Forbidden);

        // Starting accepts it; Ana hears about it.
        Assert.Equal("ACCEPTED", (await Ok(ben.PostAsync($"{Api}/tasks/{id}/status", new { status = "IN_PROGRESS" }))).GetProperty("task").GetProperty("assignState").GetString());
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_UPDATE", "started: " + title));

        // Checklist: only Ben ticks; only Ana sets required steps.
        var details = await Ok(ben.Http.GetAsync($"{Api}/tasks/{id}/details"));
        var required = details.GetProperty("checklist").EnumerateArray().First(i => i.GetProperty("isRequired").GetBoolean()).GetProperty("id").GetGuid();
        await Fails(Patch(ana, $"{Api}/tasks/{id}/checklist/{required}", new { isDone = true }), HttpStatusCode.BadRequest);
        await Fails(ben.PostAsync($"{Api}/tasks/{id}/checklist", new { text = "Mine", isRequired = true }), HttpStatusCode.BadRequest);
        await Ok(ben.PostAsync($"{Api}/tasks/{id}/checklist", new { text = "My own step" }));
        await Ok(Patch(ben, $"{Api}/tasks/{id}/checklist/{required}", new { isDone = true }));

        // Send for review → Ana reviews.
        var sent = await Ok(ben.PostAsync($"{Api}/tasks/{id}/submit", new { note = "Quote attached" }));
        Assert.Equal("IN_REVIEW", sent.GetProperty("status").GetString());
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_REVIEW", title));
        Assert.Contains((await List(ana, "to-review")), t => t.GetProperty("id").GetGuid() == id);
        Assert.True((await Ok(ana.Http.GetAsync($"{Api}/tasks/{id}"))).GetProperty("canReview").GetBoolean());

        // Send back needs a comment.
        await Fails(ana.PostAsync($"{Api}/tasks/{id}/review", new { approve = false }), HttpStatusCode.BadRequest);
        var back = await Ok(ana.PostAsync($"{Api}/tasks/{id}/review", new { approve = false, comment = "Add the GST line" }));
        Assert.Equal("IN_PROGRESS", back.GetProperty("status").GetString());
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_UPDATE", "sent back: " + title));

        await Ok(ben.PostAsync($"{Api}/tasks/{id}/submit", new { }));
        var done = await Ok(ana.PostAsync($"{Api}/tasks/{id}/review", new { approve = true, comment = "Great" }));
        Assert.Equal("COMPLETED", done.GetProperty("status").GetString());
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_UPDATE", "approved and closed: " + title));

        // History tells the whole story, visible to both.
        var kinds = (await Ok(ben.Http.GetAsync($"{Api}/tasks/{id}/details"))).GetProperty("activity").EnumerateArray().Select(a => a.GetProperty("kind").GetString()).ToList();
        Assert.Equal(["ASSIGNED", "STARTED", "SUBMITTED", "RETURNED", "SUBMITTED", "APPROVED"], kinds);
    }

    [Fact]
    public async Task Decline_new_date_withdraw_and_assigner_edits()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var cat = await SignedIn("ccat@test.invalid");
        var catId = await UserId(ana, "Cat Chat");
        var title = Unique("Visit branch");
        var due = DateTime.UtcNow.AddDays(1);
        await Ok(ana.PostAsync($"{Api}/tasks", new { title, dueUtc = due, assigneeIds = new[] { catId } }));
        var id = (await Find(cat, "all", title)).GetProperty("id").GetGuid();

        // New date: asked by Cat, approved by Ana.
        var wanted = DateTime.UtcNow.AddDays(5);
        await Fails(cat.PostAsync($"{Api}/tasks/{id}/request-date", new { dueUtc = wanted }), HttpStatusCode.BadRequest);
        await Ok(cat.PostAsync($"{Api}/tasks/{id}/request-date", new { dueUtc = wanted, reason = "Branch closed this week" }));
        await Fails(cat.PostAsync($"{Api}/tasks/{id}/date-request", new { approve = true }), HttpStatusCode.Forbidden);
        var approved = await Ok(ana.PostAsync($"{Api}/tasks/{id}/date-request", new { approve = true }));
        Assert.True(Math.Abs((approved.GetProperty("dueUtc").GetDateTime().ToUniversalTime() - wanted).TotalSeconds) < 2);
        Assert.Equal(JsonValueKind.Null, approved.GetProperty("requestedDueUtc").ValueKind);

        // Ana edits; Cat is told.
        await Ok(Patch(ana, $"{Api}/tasks/{id}", new { priority = "URGENT" }));
        Assert.Equal("URGENT", (await Ok(cat.Http.GetAsync($"{Api}/tasks/{id}"))).GetProperty("priority").GetString());
        Assert.Equal(1, await Notifications("ccat@test.invalid", "TASK_UPDATE", "changed priority: " + title));

        // Decline needs a reason; afterwards it is closed for both.
        await Fails(cat.PostAsync($"{Api}/tasks/{id}/decline", new { }), HttpStatusCode.BadRequest);
        var declined = await Ok(cat.PostAsync($"{Api}/tasks/{id}/decline", new { reason = "Not my region" }));
        Assert.Equal("DECLINED", declined.GetProperty("assignState").GetString());
        Assert.Equal("CANCELLED", declined.GetProperty("status").GetString());
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_UPDATE", "declined: " + title));
        Assert.DoesNotContain(await List(cat, "all"), t => t.GetProperty("id").GetGuid() == id);

        // Withdraw: a second task, taken back by Ana.
        var title2 = Unique("Collect cheque");
        await Ok(ana.PostAsync($"{Api}/tasks", new { title = title2, assigneeIds = new[] { catId } }));
        var id2 = (await Find(cat, "all", title2)).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"{Api}/tasks/{id2}")).StatusCode);
        Assert.Equal("CANCELLED", (await Ok(cat.Http.GetAsync($"{Api}/tasks/{id2}"))).GetProperty("status").GetString());
        Assert.Equal(1, await Notifications("ccat@test.invalid", "TASK_UPDATE", "withdrew: " + title2));
    }

    [Fact]
    public async Task Without_review_the_owner_completes_and_comments_and_nudges_reach_the_other_person()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var benId = await UserId(ana, "Ben Chat");
        var title = Unique("Send brochure");
        await Ok(ana.PostAsync($"{Api}/tasks", new { title, assigneeIds = new[] { benId } }));
        var id = (await Find(ben, "assigned", title)).GetProperty("id").GetGuid();

        var commented = await Ok(ben.PostAsync($"{Api}/tasks/{id}/comments", new { body = "Which brochure?" }));
        Assert.Single(commented.GetProperty("activity").EnumerateArray(), a => a.GetProperty("kind").GetString() == "COMMENT");
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_COMMENT", title));
        await Ok(ana.PostAsync($"{Api}/tasks/{id}/comments", new { body = "Motor" }));
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_COMMENT", title));

        await Ok(ana.PostAsync($"{Api}/tasks/{id}/nudge"));
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_DUE", "waiting on: " + title));
        await Fails(ana.PostAsync($"{Api}/tasks/{id}/nudge"), (HttpStatusCode)429, "TOO_SOON");
        await Fails(ben.PostAsync($"{Api}/tasks/{id}/nudge"), HttpStatusCode.Forbidden);

        var done = await Ok(ben.PostAsync($"{Api}/tasks/{id}/status", new { status = "COMPLETED" }));
        Assert.Equal("COMPLETED", done.GetProperty("task").GetProperty("status").GetString());
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_UPDATE", "completed: " + title));
    }

    [Fact]
    public async Task Overdue_assigned_tasks_alert_both_people_once_then_daily()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var benId = await UserId(ana, "Ben Chat");
        var title = Unique("Overdue renewal");
        var soonTitle = Unique("Due soon renewal");
        await Ok(ana.PostAsync($"{Api}/tasks", new { title, dueUtc = DateTime.UtcNow.AddHours(-2), hasDueTime = true, assigneeIds = new[] { benId } }));
        await Ok(ana.PostAsync($"{Api}/tasks", new { title = soonTitle, dueUtc = DateTime.UtcNow.AddHours(5), hasDueTime = true, assigneeIds = new[] { benId } }));
        var worker = fx.Factory.Services.GetRequiredService<ChatReminderWorker>();
        await worker.RunOnceAsync();
        await worker.RunOnceAsync();
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_DUE", "Overdue: " + title));
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_DUE", "Overdue (assigned by you): " + title));
        Assert.Equal(1, await Notifications("cben@test.invalid", "TASK_DUE", "Due soon: " + soonTitle));
        Assert.Equal(0, await Notifications("cana@test.invalid", "TASK_DUE", soonTitle));
        var id = (await Find(ben, "all", title)).GetProperty("id").GetGuid();
        Assert.Contains((await Ok(ana.Http.GetAsync($"{Api}/tasks/{id}/details"))).GetProperty("activity").EnumerateArray(), a => a.GetProperty("kind").GetString() == "OVERDUE");
        // A day later: one more reminder to Ben only.
        await Exec("UPDATE chat.TRN_ChatTask SET OverdueSentUtc = DATEADD(HOUR, -24, OverdueSentUtc) WHERE PublicId = @id", new { id });
        await worker.RunOnceAsync();
        Assert.Equal(2, await Notifications("cben@test.invalid", "TASK_DUE", "Overdue: " + title));
        Assert.Equal(1, await Notifications("cana@test.invalid", "TASK_DUE", "Overdue (assigned by you): " + title));
    }

    [Fact]
    public async Task Top_three_for_today_and_my_day_sections()
    {
        await Reset();
        var dan = await SignedIn("cdan@test.invalid");
        await Exec("UPDATE chat.TRN_ChatTask SET FocusUtc = NULL WHERE OwnerUserId = (SELECT UserId FROM auth.Users WHERE Email = N'cdan@test.invalid')");
        var ids = new List<Guid>();
        for (var i = 0; i < 4; i++) ids.Add((await Ok(dan.PostAsync($"{Api}/tasks", new { title = Unique("Focus " + i) }))).GetProperty("id").GetGuid());
        for (var i = 0; i < 3; i++) await Ok(dan.PostAsync($"{Api}/tasks/{ids[i]}/focus", new { on = true }));
        await Fails(dan.PostAsync($"{Api}/tasks/{ids[3]}/focus", new { on = true }), HttpStatusCode.BadRequest, "LIMIT_REACHED");
        await Ok(dan.PostAsync($"{Api}/tasks/{ids[0]}/focus", new { on = false }));
        await Ok(dan.PostAsync($"{Api}/tasks/{ids[3]}/focus", new { on = true }));
        await Ok(dan.PostAsync($"{Api}/tasks/{ids[1]}/status", new { status = "COMPLETED" }));
        var day = await Ok(dan.Http.GetAsync($"{Api}/my-day"));
        Assert.Equal(3, day.GetProperty("focus").GetArrayLength());
        Assert.True(day.GetProperty("counts").GetProperty("completedToday").GetInt32() >= 1);
        Assert.True(day.TryGetProperty("toReview", out _));
        Assert.True(day.TryGetProperty("waitingOnOthers", out _));
        Assert.True(day.TryGetProperty("newAssigned", out _));
    }

    [Fact]
    public async Task Shared_notes_are_read_only_and_only_for_the_chosen_people()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var benId = await UserId(ana, "Ben Chat");
        var title = Unique("Client call notes");
        var note = await Ok(ana.PostAsync($"{Api}/notes", new { title, body = "- [ ] Send quote\n- [x] Call", color = "#FDE68A" }));
        Assert.Equal("#FDE68A", note.GetProperty("color").GetString());
        var id = note.GetProperty("id").GetGuid();
        Assert.Single((await Ok(ana.PutAsync($"{Api}/notes/{id}/shares", new { userIds = new[] { benId } }))).GetProperty("items").EnumerateArray());
        Assert.Equal(1, await Notifications("cben@test.invalid", "NOTE_SHARED", title));
        var shared = (await Ok(ben.Http.GetAsync($"{Api}/notes?filter=shared"))).GetProperty("items").EnumerateArray().Single(n => n.GetProperty("id").GetGuid() == id);
        Assert.True(shared.GetProperty("isShared").GetBoolean());
        Assert.Equal("Ana Chat", shared.GetProperty("ownerName").GetString());
        Assert.DoesNotContain((await Ok(dan.Http.GetAsync($"{Api}/notes?filter=shared"))).GetProperty("items").EnumerateArray(), n => n.GetProperty("id").GetGuid() == id);
        await Fails(Patch(ben, $"{Api}/notes/{id}", new { title = "Mine now" }), HttpStatusCode.NotFound);
        await Fails(ben.Http.GetAsync($"{Api}/notes/{id}"), HttpStatusCode.NotFound);
        await Fails(ben.PutAsync($"{Api}/notes/{id}/shares", new { userIds = Array.Empty<Guid>() }), HttpStatusCode.NotFound);
        Assert.Equal(1, (await Ok(ana.Http.GetAsync($"{Api}/notes/{id}"))).GetProperty("sharedCount").GetInt32());
        await Ok(ana.PutAsync($"{Api}/notes/{id}/shares", new { userIds = Array.Empty<Guid>() }));
        Assert.DoesNotContain((await Ok(ben.Http.GetAsync($"{Api}/notes?filter=shared"))).GetProperty("items").EnumerateArray(), n => n.GetProperty("id").GetGuid() == id);
    }

    [Fact]
    public async Task Links_must_be_visible_to_both_people_and_a_failed_assignment_leaves_nothing_behind()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var benId = await UserId(ana, "Ben Chat");
        var catId = await UserId(ana, "Cat Chat");
        var group = (await Ok(ana.PostAsync($"{Api}/groups", new { name = Unique("Ana-Ben only"), memberIds = new[] { benId } }))).GetProperty("id").GetGuid();
        var msg = (await Ok(ana.PostAsync($"{Api}/conversations/{group}/messages", new { body = "Private to Ana and Ben", clientMessageId = Guid.NewGuid() }))).GetProperty("id").GetGuid();
        var title = Unique("From a private message");
        // Ben (first) can see the message, Cat cannot: nothing is created for anyone.
        await Fails(ana.PostAsync($"{Api}/tasks", new { title, sourceMessageId = msg, assigneeIds = new[] { benId, catId } }), HttpStatusCode.NotFound, "LINK_NOT_FOUND");
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatTask WHERE Title = @title AND IsActive = 1", new { title }));
        // Ben alone: fine, and the copy links to the message.
        var ok = await Ok(ana.PostAsync($"{Api}/tasks", new { title, sourceMessageId = msg, assigneeIds = new[] { benId } }));
        Assert.Equal(msg, ok.GetProperty("message").GetProperty("id").GetGuid());
        // Personal fields cannot be set for someone else; nobody can assign to themselves.
        await Fails(ana.PostAsync($"{Api}/tasks", new { title = "x", reminderUtc = DateTime.UtcNow.AddDays(1), assigneeIds = new[] { benId } }), HttpStatusCode.BadRequest);
        var anaId = await fx.QueryAsync<Guid>("SELECT PublicId FROM auth.Users WHERE Email = N'cana@test.invalid'");
        await Fails(ana.PostAsync($"{Api}/tasks", new { title = "x", assigneeIds = new[] { anaId } }), HttpStatusCode.NotFound, "LINK_NOT_FOUND");
    }
}
