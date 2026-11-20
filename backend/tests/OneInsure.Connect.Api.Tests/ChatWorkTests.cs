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
/// Chat Phase 4 (V030): the CHAT_TASKS switch, privacy of notes / tasks / reminders, notes and tasks with their filters, status
/// changes and repeating tasks, follow-ups from a chat message or a call, server-side reminders that fire exactly once (snooze,
/// dismiss, done, catch-up after the switch was off) and My Day.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ChatWorkTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r)
    {
        await r.Content.LoadIntoBufferAsync();   // read more than once (code + field)
        return JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
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
        cache.Remove("chat:enabled");
        cache.Remove("chat:calls-enabled");
        cache.Remove("chat:tasks-enabled");
    }

    async Task Reset()
    {
        await Switch("CHAT", true);
        await Switch("CHAT_CALLS", true);
        await Switch("CHAT_TASKS", true);
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

    static Task<JsonElement> NewNote(TestClient c, object body) => Ok(c.PostAsync("/api/v1/chat/notes", body));
    static Task<JsonElement> NewTask(TestClient c, object body) => Ok(c.PostAsync("/api/v1/chat/tasks", body));

    static async Task<Guid[]> Ids(TestClient c, string path) =>
        (await Ok(c.Http.GetAsync(path))).GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray();

    static async Task<Guid> PersonId(TestClient c, string search) =>
        (await Ok(c.Http.GetAsync($"/api/v1/chat/people?search={Uri.EscapeDataString(search)}"))).EnumerateArray().Single().GetProperty("id").GetGuid();

    static async Task<Guid> Direct(TestClient c, Guid userId) => (await Ok(c.PostAsync("/api/v1/chat/direct", new { userId }))).GetProperty("id").GetGuid();

    /// <summary>A fresh group per test, so messages and pins here never show up in the direct chats other test classes inspect.</summary>
    static async Task<Guid> Group(TestClient c, string name, params Guid[] memberIds) =>
        (await Ok(c.PostAsync("/api/v1/chat/groups", new { name, memberIds }))).GetProperty("id").GetGuid();

    ChatReminderWorker Worker => fx.Factory.Services.GetRequiredService<ChatReminderWorker>();

    async Task WaitFired(Guid reminderId)
    {
        for (var i = 0; i < 100; i++)
        {
            if (await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @reminderId", new { reminderId }) == "FIRED") return;
            await Task.Delay(200);
        }
        Assert.Fail("The reminder did not fire.");
    }

    [Fact]
    public async Task Notes_tasks_and_reminders_are_off_until_switched_on()
    {
        await Reset();
        try
        {
            var ana = await SignedIn("cana@test.invalid");
            Assert.True((await Ok(ana.Http.GetAsync("/api/v1/chat/status"))).GetProperty("tasks").GetBoolean());
            await Switch("CHAT_TASKS", false);
            Assert.False((await Ok(ana.Http.GetAsync("/api/v1/chat/status"))).GetProperty("tasks").GetBoolean());
            foreach (var r in new[]
                     {
                         await ana.Http.GetAsync("/api/v1/chat/notes"), await ana.Http.GetAsync("/api/v1/chat/tasks"), await ana.Http.GetAsync("/api/v1/chat/my-day"),
                         await ana.Http.GetAsync("/api/v1/chat/reminders/due"), await ana.Http.GetAsync("/api/v1/chat/categories"),
                         await ana.PostAsync("/api/v1/chat/tasks", new { title = "x" }), await ana.PostAsync("/api/v1/chat/notes", new { title = "x" }),
                     })
            {
                Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
                Assert.Equal("FEATURE_DISABLED", await Code(r));
            }
            // CHAT off switches it off too.
            await Switch("CHAT_TASKS", true);
            await Switch("CHAT", false);
            var off = await ana.Http.GetAsync("/api/v1/chat/tasks");
            Assert.Equal(HttpStatusCode.Forbidden, off.StatusCode);
            Assert.Equal("FEATURE_DISABLED", await Code(off));
        }
        finally { await Reset(); }
    }

    [Fact]
    public async Task Everything_is_private_to_its_owner()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var cat = await Ok(ana.PostAsync("/api/v1/chat/categories", new { name = "Ana private " + Guid.NewGuid().ToString("N")[..6], color = "#123abc" }));
        var catId = cat.GetProperty("id").GetGuid();
        Assert.False(cat.GetProperty("isDefault").GetBoolean());
        var note = await NewNote(ana, new { title = "Ana's secret note", body = "Private", reminderUtc = DateTime.UtcNow.AddDays(3) });
        var task = await NewTask(ana, new { title = "Ana's secret task", reminderUtc = DateTime.UtcNow.AddDays(3), categoryId = catId });
        var noteId = note.GetProperty("id").GetGuid();
        var taskId = task.GetProperty("id").GetGuid();
        var reminderId = task.GetProperty("reminderId").GetGuid();
        Assert.Equal("PENDING", task.GetProperty("reminderState").GetString());

        foreach (var r in new[]
                 {
                     await ben.Http.GetAsync($"/api/v1/chat/notes/{noteId}"), await Patch(ben, $"/api/v1/chat/notes/{noteId}", new { title = "x" }),
                     await ben.DeleteAsync($"/api/v1/chat/notes/{noteId}"),
                     await ben.Http.GetAsync($"/api/v1/chat/tasks/{taskId}"), await Patch(ben, $"/api/v1/chat/tasks/{taskId}", new { title = "x" }),
                     await ben.DeleteAsync($"/api/v1/chat/tasks/{taskId}"), await ben.PostAsync($"/api/v1/chat/tasks/{taskId}/status", new { status = "COMPLETED" }),
                     await ben.PostAsync($"/api/v1/chat/reminders/{reminderId}/snooze", new { minutes = 5 }),
                     await ben.PostAsync($"/api/v1/chat/reminders/{reminderId}/done"), await ben.PostAsync($"/api/v1/chat/reminders/{reminderId}/dismiss"),
                     await ben.DeleteAsync($"/api/v1/chat/categories/{catId}"),
                 })
        {
            Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
            Assert.Equal("NOT_FOUND", await Code(r));
        }
        // Ben cannot link Ana's things to his own items, and never sees them in any list.
        var link = await ben.PostAsync("/api/v1/chat/notes", new { title = "Ben", taskId });
        Assert.Equal(HttpStatusCode.NotFound, link.StatusCode);
        Assert.Equal("LINK_NOT_FOUND", await Code(link));
        Assert.Equal("taskId", (await Json(link)).GetProperty("field").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await ben.PostAsync("/api/v1/chat/tasks", new { title = "Ben", categoryId = catId })).StatusCode);
        Assert.DoesNotContain(noteId, await Ids(ben, "/api/v1/chat/notes"));
        Assert.DoesNotContain(taskId, await Ids(ben, "/api/v1/chat/tasks"));
        Assert.DoesNotContain((await Ok(ben.Http.GetAsync("/api/v1/chat/reminders/upcoming?days=7"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == reminderId);
        Assert.DoesNotContain((await Ok(ben.Http.GetAsync("/api/v1/chat/categories"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == catId);
        // Unchanged for Ana.
        Assert.Equal("Ana's secret task", (await Ok(ana.Http.GetAsync($"/api/v1/chat/tasks/{taskId}"))).GetProperty("title").GetString());
        Assert.Contains((await Ok(ana.Http.GetAsync("/api/v1/chat/reminders/upcoming?days=7"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == reminderId);

        // Deleting her category leaves the task without one; default categories cannot be deleted.
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/categories/{catId}")).StatusCode);
        Assert.Equal(JsonValueKind.Null, (await Ok(ana.Http.GetAsync($"/api/v1/chat/tasks/{taskId}"))).GetProperty("categoryId").ValueKind);
        var cats = (await Ok(ana.Http.GetAsync("/api/v1/chat/categories"))).EnumerateArray().ToList();
        Assert.Contains(cats, x => x.GetProperty("name").GetString() == "Follow-up" && x.GetProperty("isDefault").GetBoolean());
        var work = cats.First(x => x.GetProperty("name").GetString() == "Work").GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Conflict, (await ana.DeleteAsync($"/api/v1/chat/categories/{work}")).StatusCode);
    }

    [Fact]
    public async Task Notes_can_be_created_changed_filtered_searched_and_deleted()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var tag = Guid.NewGuid().ToString("N")[..8];
        var now = DateTime.UtcNow;
        var (ds, de) = (now.AddHours(-1), now.AddHours(10));
        var work = (await Ok(ana.Http.GetAsync("/api/v1/chat/categories"))).EnumerateArray().First(x => x.GetProperty("name").GetString() == "Work").GetProperty("id").GetGuid();

        var pinned = await NewNote(ana, new { title = $"Pinned {tag}", body = "Prepare the renewal deck", isPinned = true, categoryId = work });
        Assert.Equal("Work", pinned.GetProperty("categoryName").GetString());
        Assert.True(pinned.GetProperty("isPinned").GetBoolean());
        var dated = await NewNote(ana, new { title = $"Dated {tag}", noteDateUtc = now.AddDays(5) });
        var withReminder = await NewNote(ana, new { title = $"Reminder {tag}", body = "Call the customer", reminderUtc = now.AddHours(2) });
        var archived = await NewNote(ana, new { title = $"Old {tag}" });
        var (pinnedId, datedId, remId, archId) = (pinned.GetProperty("id").GetGuid(), dated.GetProperty("id").GetGuid(), withReminder.GetProperty("id").GetGuid(), archived.GetProperty("id").GetGuid());

        // Validation: title required, body length, control characters stripped.
        var bad = await ana.PostAsync("/api/v1/chat/notes", new { body = "no title" });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("VALIDATION", await Code(bad));
        Assert.Equal(HttpStatusCode.BadRequest, (await ana.PostAsync("/api/v1/chat/notes", new { title = "x", body = new string('a', 8001) })).StatusCode);
        Assert.Equal("Clean title", (await NewNote(ana, new { title = "  Clean\u0007 title " })).GetProperty("title").GetString());

        // Patch: archive one, complete one, rename.
        var arch = await Ok(Patch(ana, $"/api/v1/chat/notes/{archId}", new { isArchived = true }));
        Assert.True(arch.GetProperty("isArchived").GetBoolean());
        var renamed = await Ok(Patch(ana, $"/api/v1/chat/notes/{datedId}", new { title = $"Renamed {tag}", isCompleted = true }));
        Assert.Equal($"Renamed {tag}", renamed.GetProperty("title").GetString());
        Assert.True(renamed.GetProperty("isCompleted").GetBoolean());

        var all = await Ids(ana, $"/api/v1/chat/notes?search={tag}");
        Assert.Contains(pinnedId, all);
        Assert.DoesNotContain(archId, all);                          // "all" leaves archived notes out
        Assert.Equal(pinnedId, all[0]);                              // pinned first
        Assert.Equal([pinnedId], await Ids(ana, $"/api/v1/chat/notes?filter=pinned&search={tag}"));
        Assert.Equal([archId], await Ids(ana, $"/api/v1/chat/notes?filter=archived&search={tag}"));
        Assert.Equal([datedId], await Ids(ana, $"/api/v1/chat/notes?filter=completed&search={tag}"));
        Assert.Equal([remId], await Ids(ana, $"/api/v1/chat/notes?filter=reminders&search={tag}"));
        Assert.Contains(remId, await Ids(ana, "/api/v1/chat/notes?filter=all&search=" + Uri.EscapeDataString("call the CUSTOMER")));   // body search
        // Today: created in the window (all four), but not the one dated in five days if the window is moved there.
        var today = await Ids(ana, $"/api/v1/chat/notes?filter=today&search={tag}&dayStartUtc={Iso(ds)}&dayEndUtc={Iso(de)}");
        Assert.Contains(remId, today);
        var later = await Ids(ana, $"/api/v1/chat/notes?filter=today&search={tag}&dayStartUtc={Iso(now.AddDays(5).AddHours(-1))}&dayEndUtc={Iso(now.AddDays(5).AddHours(1))}");
        Assert.Equal([datedId], later);
        // Date view (from/to) on the note date.
        Assert.Contains(datedId, await Ids(ana, $"/api/v1/chat/notes?filter=completed&search={tag}&from={Iso(now.AddDays(4))}&to={Iso(now.AddDays(6))}"));
        Assert.Equal(HttpStatusCode.BadRequest, (await ana.Http.GetAsync("/api/v1/chat/notes?filter=nonsense")).StatusCode);

        // Reminder: replaced by a new time, cleared with null.
        var rem1 = withReminder.GetProperty("reminderId").GetGuid();
        var moved = await Ok(Patch(ana, $"/api/v1/chat/notes/{remId}", new { reminderUtc = now.AddHours(5) }));
        var rem2 = moved.GetProperty("reminderId").GetGuid();
        Assert.NotEqual(rem1, rem2);
        Assert.Equal("CANCELLED", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @rem1", new { rem1 }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM chat.TRN_ChatReminder r JOIN chat.TRN_ChatNote n ON n.NoteId = r.NoteId WHERE n.PublicId = @remId AND r.[State] = 'PENDING'", new { remId }));
        var cleared = await Ok(Patch(ana, $"/api/v1/chat/notes/{remId}", new { reminderUtc = (DateTime?)null }));
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("reminderId").ValueKind);
        Assert.Equal("Call the customer", cleared.GetProperty("body").GetString());   // untouched fields stay

        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/notes/{pinnedId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ana.Http.GetAsync($"/api/v1/chat/notes/{pinnedId}")).StatusCode);
        Assert.DoesNotContain(pinnedId, await Ids(ana, $"/api/v1/chat/notes?search={tag}"));
    }

    [Fact]
    public async Task Tasks_are_filtered_by_day_overdue_upcoming_completed_and_follow_ups_and_change_status()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var conv = await Direct(ana, await PersonId(ana, "Ben Chat"));
        var tag = Guid.NewGuid().ToString("N")[..8];
        var now = DateTime.UtcNow;
        var window = $"dayStartUtc={Iso(now.AddMinutes(-30))}&dayEndUtc={Iso(now.AddHours(12))}";

        var today = await NewTask(ana, new { title = $"Today {tag}", dueUtc = now.AddHours(1), hasDueTime = true, priority = "high" });
        var overdue = await NewTask(ana, new { title = $"Overdue {tag}", dueUtc = now.AddHours(-2), hasDueTime = true });
        var upcoming = await NewTask(ana, new { title = $"Upcoming {tag}", dueUtc = now.AddDays(3) });
        var undated = await NewTask(ana, new { title = $"Someday {tag}", description = "No due date", notes = "Internal notes" });
        var follow = await NewTask(ana, new { title = $"Follow {tag}", conversationId = conv, priority = "URGENT" });
        var (todayId, overdueId, upId, undatedId, followId) = (today.GetProperty("id").GetGuid(), overdue.GetProperty("id").GetGuid(),
            upcoming.GetProperty("id").GetGuid(), undated.GetProperty("id").GetGuid(), follow.GetProperty("id").GetGuid());

        Assert.Equal("HIGH", today.GetProperty("priority").GetString());
        Assert.Equal("PENDING", today.GetProperty("status").GetString());
        Assert.True(overdue.GetProperty("isOverdue").GetBoolean());
        Assert.False(today.GetProperty("isOverdue").GetBoolean());
        Assert.Equal(conv, follow.GetProperty("conversation").GetProperty("id").GetGuid());
        Assert.Equal("Ben Chat", follow.GetProperty("conversation").GetProperty("title").GetString());
        Assert.False(follow.GetProperty("conversation").GetProperty("isGroup").GetBoolean());
        var badPriority = await ana.PostAsync("/api/v1/chat/tasks", new { title = "x", priority = "SOON" });
        Assert.Equal(HttpStatusCode.BadRequest, badPriority.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ana.PostAsync("/api/v1/chat/tasks", new { title = "x", repeatRule = "DAILY" })).StatusCode); // repeat needs a due date

        var all = await Ids(ana, $"/api/v1/chat/tasks?search={tag}&{window}");
        Assert.Equal([overdueId, todayId, upId], all.Take(3).ToArray());             // due first (oldest first), undated last
        Assert.Equal(new[] { followId, undatedId }.Order(), all.Skip(3).Order());
        Assert.Equal([todayId], await Ids(ana, $"/api/v1/chat/tasks?filter=today&search={tag}&{window}"));
        Assert.Equal([overdueId], await Ids(ana, $"/api/v1/chat/tasks?filter=overdue&search={tag}&{window}"));
        Assert.Equal([upId], await Ids(ana, $"/api/v1/chat/tasks?filter=upcoming&search={tag}&{window}"));
        Assert.Equal([followId], await Ids(ana, $"/api/v1/chat/tasks?filter=followups&search={tag}&{window}"));
        Assert.Contains(undatedId, await Ids(ana, $"/api/v1/chat/tasks?search={Uri.EscapeDataString("internal notes")}&{window}"));   // searches the notes field too

        // Status changes: completed (CompletedUtc set, leaves the open lists), reopened (cleared).
        var done = await Ok(ana.PostAsync($"/api/v1/chat/tasks/{todayId}/status", new { status = "COMPLETED" }));
        Assert.Equal("COMPLETED", done.GetProperty("task").GetProperty("status").GetString());
        Assert.NotEqual(JsonValueKind.Null, done.GetProperty("task").GetProperty("completedUtc").ValueKind);
        Assert.Equal(JsonValueKind.Null, done.GetProperty("next").ValueKind);
        Assert.Equal([todayId], await Ids(ana, $"/api/v1/chat/tasks?filter=completed&search={tag}"));
        Assert.Empty(await Ids(ana, $"/api/v1/chat/tasks?filter=today&search={tag}&{window}"));
        Assert.Equal([todayId], await Ids(ana, $"/api/v1/chat/tasks?status=COMPLETED&search={tag}"));
        var reopened = await Ok(Patch(ana, $"/api/v1/chat/tasks/{todayId}", new { status = "IN_PROGRESS" }));
        Assert.Equal(JsonValueKind.Null, reopened.GetProperty("completedUtc").ValueKind);
        Assert.Equal(HttpStatusCode.BadRequest, (await ana.PostAsync($"/api/v1/chat/tasks/{todayId}/status", new { status = "FINISHED" })).StatusCode);

        // Cancelling closes its reminder; PATCH keeps fields it was not sent.
        var withRem = await Ok(Patch(ana, $"/api/v1/chat/tasks/{upId}", new { reminderUtc = now.AddDays(2) }));
        var remId = withRem.GetProperty("reminderId").GetGuid();
        await Ok(Patch(ana, $"/api/v1/chat/tasks/{upId}", new { status = "CANCELLED" }));
        Assert.Equal("CANCELLED", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @remId", new { remId }));
        Assert.Equal($"Upcoming {tag}", (await Ok(ana.Http.GetAsync($"/api/v1/chat/tasks/{upId}"))).GetProperty("title").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/tasks/{overdueId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ana.Http.GetAsync($"/api/v1/chat/tasks/{overdueId}")).StatusCode);
    }

    [Fact]
    public async Task Completing_a_repeating_task_creates_the_next_occurrence_with_the_same_reminder_offset()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var due = DateTime.UtcNow.AddHours(3);
        due = new DateTime(due.Year, due.Month, due.Day, due.Hour, due.Minute, 0, DateTimeKind.Utc);
        var task = await NewTask(ana, new { title = "Daily report", dueUtc = due, hasDueTime = true, repeatRule = "DAILY", reminderUtc = due.AddMinutes(-30), priority = "HIGH" });
        var taskId = task.GetProperty("id").GetGuid();
        var firstReminder = task.GetProperty("reminderId").GetGuid();

        var result = await Ok(ana.PostAsync($"/api/v1/chat/tasks/{taskId}/status", new { status = "COMPLETED" }));
        Assert.Equal(JsonValueKind.Null, result.GetProperty("task").GetProperty("reminderId").ValueKind);
        Assert.Equal("DONE", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @firstReminder", new { firstReminder }));
        var next = result.GetProperty("next");
        Assert.Equal("Daily report", next.GetProperty("title").GetString());
        Assert.Equal("PENDING", next.GetProperty("status").GetString());
        Assert.Equal("DAILY", next.GetProperty("repeatRule").GetString());
        Assert.Equal("HIGH", next.GetProperty("priority").GetString());
        var nextDue = next.GetProperty("dueUtc").GetDateTime().ToUniversalTime();
        Assert.Equal(due.AddDays(1), nextDue);
        Assert.Equal(nextDue.AddMinutes(-30), next.GetProperty("reminderUtc").GetDateTime().ToUniversalTime());

        // Reopening and completing again does not create a second occurrence.
        await Ok(ana.PostAsync($"/api/v1/chat/tasks/{taskId}/status", new { status = "PENDING" }));
        var again = await Ok(ana.PostAsync($"/api/v1/chat/tasks/{taskId}/status", new { status = "COMPLETED" }));
        Assert.Equal(JsonValueKind.Null, again.GetProperty("next").ValueKind);

        // Weekdays skip the weekend, monthly keeps the day of the month (in the owner's time zone).
        var ist = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");
        var friday = TimeZoneInfo.ConvertTimeToUtc(new DateTime(2026, 11, 20, 10, 0, 0), ist);
        Assert.Equal(TimeZoneInfo.ConvertTimeToUtc(new DateTime(2026, 11, 23, 10, 0, 0), ist), ChatWorkEndpoints.NextDue(friday, "WEEKDAYS", ist));
        Assert.Equal(friday.AddDays(7), ChatWorkEndpoints.NextDue(friday, "WEEKLY", ist));
        Assert.Equal(TimeZoneInfo.ConvertTimeToUtc(new DateTime(2026, 12, 20, 10, 0, 0), ist), ChatWorkEndpoints.NextDue(friday, "MONTHLY", ist));
    }

    [Fact]
    public async Task Follow_ups_can_be_created_from_a_message_and_a_call_only_by_people_who_were_there()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var conv = await Group(ana, "Follow-up test", await PersonId(ana, "Ben Chat"));
        var msg = await Ok(ben.PostAsync($"/api/v1/chat/conversations/{conv}/messages", new { clientMessageId = Guid.NewGuid(), body = "Please share the report tomorrow." }));
        var msgId = msg.GetProperty("id").GetGuid();

        var task = await NewTask(ana, new { title = "Share the report", sourceMessageId = msgId, dueUtc = DateTime.UtcNow.AddDays(1) });
        Assert.Equal(conv, task.GetProperty("conversation").GetProperty("id").GetGuid());
        var m = task.GetProperty("message");
        Assert.Equal(msgId, m.GetProperty("id").GetGuid());
        Assert.Equal(conv, m.GetProperty("conversationId").GetGuid());
        Assert.Equal("Ben Chat", m.GetProperty("senderName").GetString());
        Assert.Equal("Please share the report tomorrow.", m.GetProperty("excerpt").GetString());
        Assert.Contains(task.GetProperty("id").GetGuid(), await Ids(ana, "/api/v1/chat/tasks?filter=followups"));

        // Dan is not in the conversation: the message does not exist for him.
        var outsider = await dan.PostAsync("/api/v1/chat/tasks", new { title = "Steal", sourceMessageId = msgId });
        Assert.Equal(HttpStatusCode.NotFound, outsider.StatusCode);
        Assert.Equal("LINK_NOT_FOUND", await Code(outsider));
        Assert.Equal("sourceMessageId", (await Json(outsider)).GetProperty("field").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync("/api/v1/chat/notes", new { title = "Steal", conversationId = conv })).StatusCode);

        // The message is deleted for everyone: the link stays, its text does not.
        Assert.Equal(HttpStatusCode.NoContent, (await ben.DeleteAsync($"/api/v1/chat/messages/{msgId}")).StatusCode);
        var after = await Ok(ana.Http.GetAsync($"/api/v1/chat/tasks/{task.GetProperty("id").GetGuid()}"));
        Assert.Equal("Message deleted", after.GetProperty("message").GetProperty("excerpt").GetString());

        // From a call log: only people who took part.
        var callId = Guid.NewGuid();
        await Exec("""
            DECLARE @cid BIGINT = (SELECT ConversationId FROM chat.TRN_ChatConversation WHERE PublicId = @conv);
            DECLARE @ana BIGINT = (SELECT UserId FROM auth.Users WHERE Email = 'cana@test.invalid'), @ben BIGINT = (SELECT UserId FROM auth.Users WHERE Email = 'cben@test.invalid');
            INSERT chat.TRN_ChatCall (PublicId, ConversationId, [Type], StartedByUserId, LiveKitRoomName, [Status], AnsweredUtc, EndedUtc, EndReason)
            VALUES (@callId, @cid, 'DIRECT', @ben, @room, 'ENDED', SYSUTCDATETIME(), SYSUTCDATETIME(), 'ENDED_BY_USER');
            DECLARE @id BIGINT = SCOPE_IDENTITY();
            INSERT chat.TRN_ChatCallParticipant (CallId, UserId, [State]) VALUES (@id, @ben, 'LEFT'), (@id, @ana, 'LEFT');
            """, new { conv, callId, room = "oic_call_test_" + callId.ToString("N")[..12] });
        var fromCall = await NewTask(ana, new { title = "Call back about the claim", sourceCallId = callId });
        Assert.Equal(callId, fromCall.GetProperty("call").GetProperty("id").GetGuid());
        Assert.Equal("Ben Chat", fromCall.GetProperty("call").GetProperty("otherName").GetString());
        Assert.Equal("DIRECT", fromCall.GetProperty("call").GetProperty("type").GetString());
        Assert.Equal(conv, fromCall.GetProperty("conversation").GetProperty("id").GetGuid());
        var notThere = await dan.PostAsync("/api/v1/chat/tasks", new { title = "x", sourceCallId = callId });
        Assert.Equal(HttpStatusCode.NotFound, notThere.StatusCode);
        Assert.Equal("LINK_NOT_FOUND", await Code(notThere));
    }

    [Fact]
    public async Task Reminders_fire_exactly_once_can_be_dismissed_snoozed_and_done_and_catch_up_after_the_switch_was_off()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var anaUser = await fx.QueryAsync<long>("SELECT UserId FROM auth.Users WHERE Email = 'cana@test.invalid'");
        var task = await NewTask(ana, new { title = "Send the quote", description = "Motor policy quote for the customer", priority = "URGENT", reminderUtc = DateTime.UtcNow.AddHours(1) });
        var taskId = task.GetProperty("id").GetGuid();
        var reminderId = task.GetProperty("reminderId").GetGuid();
        var link = $"/chat?tab=tasks&task={taskId}";
        async Task<int> Bells() => await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @anaUser AND [Type] = 'TASK_REMINDER' AND LinkPath = @link", new { anaUser, link });

        // Due now: the background worker and several extra passes race for it; it fires once.
        await Exec("UPDATE chat.TRN_ChatReminder SET DueUtc = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE PublicId = @reminderId", new { reminderId });
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Worker.RunOnceAsync()));
        await WaitFired(reminderId);
        await Task.Delay(1500);   // let the background worker pass again
        Assert.Equal(1, await Bells());
        Assert.Equal("Reminder: Send the quote", await fx.QueryAsync<string>("SELECT TOP 1 Title FROM mtg.MeetingNotifications WHERE LinkPath = @link", new { link }));
        var due = (await Ok(ana.Http.GetAsync("/api/v1/chat/reminders/due"))).EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == reminderId);
        Assert.Equal("TASK", due.GetProperty("kind").GetString());
        Assert.Equal(taskId, due.GetProperty("itemId").GetGuid());
        Assert.Equal("Send the quote", due.GetProperty("title").GetString());
        Assert.Equal("Motor policy quote for the customer", due.GetProperty("details").GetString());
        Assert.Equal("URGENT", due.GetProperty("priority").GetString());
        Assert.Equal("FIRED", due.GetProperty("state").GetString());
        Assert.Equal(1, (await Ok(ana.Http.GetAsync("/api/v1/chat/my-day"))).GetProperty("missedReminders").EnumerateArray().Count(x => x.GetProperty("id").GetGuid() == reminderId));

        // Dismiss: gone from the catch-up list, the task is untouched.
        var dismissed = await Ok(ana.PostAsync($"/api/v1/chat/reminders/{reminderId}/dismiss"));
        Assert.Equal("DISMISSED", dismissed.GetProperty("state").GetString());
        Assert.DoesNotContain((await Ok(ana.Http.GetAsync("/api/v1/chat/reminders/due"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == reminderId);
        Assert.Equal("PENDING", (await Ok(ana.Http.GetAsync($"/api/v1/chat/tasks/{taskId}"))).GetProperty("status").GetString());

        // Snooze: back to pending, and it fires again.
        Assert.Equal(HttpStatusCode.BadRequest, (await ana.PostAsync($"/api/v1/chat/reminders/{reminderId}/snooze", new { minutes = 0 })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ana.PostAsync($"/api/v1/chat/reminders/{reminderId}/snooze", new { untilUtc = DateTime.UtcNow.AddMinutes(-5) })).StatusCode);
        var snoozed = await Ok(ana.PostAsync($"/api/v1/chat/reminders/{reminderId}/snooze", new { minutes = 15 }));
        Assert.Equal("PENDING", snoozed.GetProperty("state").GetString());
        Assert.Equal(1, snoozed.GetProperty("snoozeCount").GetInt32());
        Assert.Equal(JsonValueKind.Null, snoozed.GetProperty("firedUtc").ValueKind);
        Assert.Contains((await Ok(ana.Http.GetAsync("/api/v1/chat/reminders/upcoming?days=1"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == reminderId);
        await Exec("UPDATE chat.TRN_ChatReminder SET DueUtc = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE PublicId = @reminderId", new { reminderId });
        await WaitFired(reminderId);
        Assert.Equal(2, await Bells());

        // Done: the task is completed and the reminder closed.
        var done = await Ok(ana.PostAsync($"/api/v1/chat/reminders/{reminderId}/done"));
        Assert.Equal("DONE", done.GetProperty("reminder").GetProperty("state").GetString());
        Assert.Equal("COMPLETED", done.GetProperty("task").GetProperty("status").GetString());
        Assert.DoesNotContain((await Ok(ana.Http.GetAsync("/api/v1/chat/reminders/due"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == reminderId);

        // Notes: NOTE_REMINDER with a link to the note. With the switch off nothing fires; switched on, it catches up.
        var note = await NewNote(ana, new { title = "Check the inspection report", reminderUtc = DateTime.UtcNow.AddHours(1) });
        var noteId = note.GetProperty("id").GetGuid();
        var noteReminder = note.GetProperty("reminderId").GetGuid();
        await Switch("CHAT_TASKS", false);
        try
        {
            await Exec("UPDATE chat.TRN_ChatReminder SET DueUtc = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE PublicId = @noteReminder", new { noteReminder });
            Assert.Equal(0, await Worker.RunOnceAsync());
            await Task.Delay(1500);
            Assert.Equal("PENDING", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @noteReminder", new { noteReminder }));
        }
        finally { await Switch("CHAT_TASKS", true); }
        await WaitFired(noteReminder);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @anaUser AND [Type] = 'NOTE_REMINDER' AND LinkPath = @l",
            new { anaUser, l = $"/chat?tab=notes&note={noteId}" }));
        var noteDone = await Ok(ana.PostAsync($"/api/v1/chat/reminders/{noteReminder}/done"));
        Assert.True(noteDone.GetProperty("note").GetProperty("isCompleted").GetBoolean());

        // A reminder whose task was completed meanwhile is cancelled, not shown.
        var other = await NewTask(ana, new { title = "Already handled", reminderUtc = DateTime.UtcNow.AddHours(1) });
        var otherReminder = other.GetProperty("reminderId").GetGuid();
        await Exec("""
            UPDATE chat.TRN_ChatTask SET [Status] = 'COMPLETED' WHERE PublicId = @id;
            UPDATE chat.TRN_ChatReminder SET DueUtc = DATEADD(SECOND, -1, SYSUTCDATETIME()) WHERE PublicId = @otherReminder;
            """, new { id = other.GetProperty("id").GetGuid(), otherReminder });
        await Worker.RunOnceAsync();
        Assert.Equal("CANCELLED", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @otherReminder", new { otherReminder }));
    }

    [Fact]
    public async Task My_day_shows_tasks_reminders_meetings_notes_follow_ups_chats_and_calls()
    {
        await Reset();
        var ana = await SignedIn("cana@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var now = DateTime.UtcNow;
        var meetingId = Guid.NewGuid();
        var tag = Guid.NewGuid().ToString("N")[..8];
        // A team meeting today hosted by Ben, with Ana invited.
        await Exec("""
            DECLARE @ben BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'C-BEN'), @ana BIGINT = (SELECT EmployeeId FROM org.Employees WHERE EmployeeCode = 'C-ANA');
            INSERT mtg.Meetings (PublicId, MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, ScheduledStartUtc, ScheduledEndUtc, LiveKitRoomName)
                VALUES (@meetingId, @code, @title, 'TEAM', @ben, @ben, DATEADD(HOUR, 2, SYSUTCDATETIME()), DATEADD(HOUR, 3, SYSUTCDATETIME()), @room);
            INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, LiveKitIdentity)
            SELECT MeetingId, 'EMPLOYEE', @ana, 'emp-wt-' + @code FROM mtg.Meetings WHERE PublicId = @meetingId;
            """, new { meetingId, code = "WT" + tag, title = "Renewal review " + tag, room = "oic_wt_" + tag });

        var window = $"dayStartUtc={Iso(now.AddMinutes(-30))}&dayEndUtc={Iso(now.AddHours(12))}";
        var conv = await Group(ana, $"My day {tag}", await PersonId(ana, "Ben Chat"));
        await Ok(ana.PostAsync($"/api/v1/chat/conversations/{conv}/pin", new { on = true }));
        var todayTask = await NewTask(ana, new { title = $"Prep {tag}", dueUtc = now.AddHours(1), meetingId });
        var overdueTask = await NewTask(ana, new { title = $"Late {tag}", dueUtc = now.AddHours(-3) });
        var pinnedNote = await NewNote(ana, new { title = $"Pinned {tag}", isPinned = true, meetingId });
        var reminderTask = await NewTask(ana, new { title = $"Remind {tag}", reminderUtc = now.AddHours(4) });
        Assert.Equal(meetingId, todayTask.GetProperty("meeting").GetProperty("id").GetGuid());
        Assert.Equal("Renewal review " + tag, pinnedNote.GetProperty("meeting").GetProperty("title").GetString());

        // Dan is not invited: he cannot link or pick the meeting.
        var steal = await dan.PostAsync("/api/v1/chat/tasks", new { title = "x", meetingId });
        Assert.Equal(HttpStatusCode.NotFound, steal.StatusCode);
        Assert.Equal("LINK_NOT_FOUND", await Code(steal));
        Assert.DoesNotContain((await Ok(dan.Http.GetAsync($"/api/v1/chat/work/meetings?search={tag}"))).EnumerateArray(), x => x.GetProperty("id").GetGuid() == meetingId);
        var picker = (await Ok(ana.Http.GetAsync($"/api/v1/chat/work/meetings?search={tag}"))).EnumerateArray().Single();
        Assert.Equal(meetingId, picker.GetProperty("id").GetGuid());

        var day = await Ok(ana.Http.GetAsync($"/api/v1/chat/my-day?{window}"));
        static Guid[] IdsOf(JsonElement e) => e.EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray();
        Assert.Contains(todayTask.GetProperty("id").GetGuid(), IdsOf(day.GetProperty("todayTasks")));
        Assert.Contains(overdueTask.GetProperty("id").GetGuid(), IdsOf(day.GetProperty("overdueTasks")));
        Assert.Contains(todayTask.GetProperty("id").GetGuid(), IdsOf(day.GetProperty("followUps")));       // linked to a meeting
        Assert.Contains(pinnedNote.GetProperty("id").GetGuid(), IdsOf(day.GetProperty("notes")));
        Assert.Contains(reminderTask.GetProperty("reminderId").GetGuid(), IdsOf(day.GetProperty("upcomingReminders")));
        var meeting = day.GetProperty("meetings").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == meetingId);
        Assert.Equal($"/meetings/{meetingId}", meeting.GetProperty("joinPath").GetString());
        Assert.Equal("internal", meeting.GetProperty("kind").GetString());
        Assert.Equal("SCHEDULED", meeting.GetProperty("status").GetString());
        var chat = day.GetProperty("importantChats").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == conv);
        Assert.True(chat.GetProperty("isPinned").GetBoolean());
        Assert.Equal($"My day {tag}", chat.GetProperty("title").GetString());
        Assert.True(chat.GetProperty("isGroup").GetBoolean());
        Assert.Equal(JsonValueKind.Array, day.GetProperty("recentCalls").ValueKind);
        Assert.Equal(JsonValueKind.Array, day.GetProperty("missedReminders").ValueKind);
        var counts = day.GetProperty("counts");
        Assert.True(counts.GetProperty("todayTasks").GetInt32() >= 1);
        Assert.True(counts.GetProperty("overdue").GetInt32() >= 1);
        Assert.True(counts.GetProperty("followUps").GetInt32() >= 1);
        Assert.True(counts.TryGetProperty("missed", out _));

        // Calls switched off: no recent calls.
        await Switch("CHAT_CALLS", false);
        try { Assert.Empty((await Ok(ana.Http.GetAsync("/api/v1/chat/my-day"))).GetProperty("recentCalls").EnumerateArray()); }
        finally { await Reset(); }
        await Ok(ana.PostAsync($"/api/v1/chat/conversations/{conv}/pin", new { on = false }));
    }
}
