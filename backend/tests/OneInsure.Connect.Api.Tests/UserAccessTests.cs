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
/// Per-user module access (V032): without blocks nothing changes; an administrator switches Meetings, Chat, Audio calls or
/// Notes &amp; tasks off per user, which removes those permissions even when the roles grant them (applies on the next request);
/// people who cannot receive calls are never rung; reminders of people without Notes &amp; tasks wait; validation and audit.
/// Every test uses its own fictitious users (UA-*) so the other tests' users never get blocks.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class UserAccessTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static readonly string[] AllModules = ["MEETINGS", "CHAT", "CALLS", "TASKS"];

    static async Task<JsonElement> Json(HttpResponseMessage r)
    {
        await r.Content.LoadIntoBufferAsync();
        return JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
    }
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;

    static async Task<JsonElement> Ok(Task<HttpResponseMessage> call)
    {
        var r = await call;
        Assert.True(r.StatusCode == HttpStatusCode.OK, $"{(int)r.StatusCode}: {await r.Content.ReadAsStringAsync()}");
        return await Json(r);
    }

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    async Task Switches()
    {
        await Exec("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey IN ('CHAT', 'CHAT_CALLS', 'CHAT_TASKS')");
        var cache = fx.Factory.Services.GetRequiredService<IMemoryCache>();
        cache.Remove("chat:enabled");
        cache.Remove("chat:calls-enabled");
        cache.Remove("chat:tasks-enabled");
    }

    /// <summary>Creates (once) an active employee with an Employee-role account: e-mail ua.{key}@test.invalid.</summary>
    async Task<(string Email, Guid Id)> User(string key, string name)
    {
        var email = $"ua.{key}@test.invalid";
        await Exec("""
            IF NOT EXISTS (SELECT 1 FROM org.Employees WHERE OfficialEmail = @email)
            BEGIN
                INSERT org.Employees (EmployeeCode, FirstName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
                VALUES (@code, @name, @name, @email, (SELECT DepartmentId FROM org.Departments WHERE Code = 'TST'), (SELECT DesignationId FROM org.Designations WHERE Code = 'TEX'));
                INSERT auth.Users (Email, PasswordHash, EmployeeId)
                SELECT @email, (SELECT PasswordHash FROM auth.Users WHERE Email = N'cana@test.invalid'), EmployeeId FROM org.Employees WHERE OfficialEmail = @email;
                INSERT auth.UserRoles (UserId, RoleId) SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = 'Employee' WHERE u.Email = @email;
            END
            """, new { email, name, code = "UA-" + key.ToUpperInvariant() });
        return (email, await fx.QueryAsync<Guid>("SELECT PublicId FROM auth.Users WHERE Email = @email", new { email }));
    }

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    static async Task<string[]> Permissions(TestClient c) =>
        (await Ok(c.Http.GetAsync("/api/v1/auth/me"))).GetProperty("permissions").EnumerateArray().Select(p => p.GetString()!).ToArray();

    static Task<HttpResponseMessage> SetAccess(TestClient admin, Guid userId, params string[] access) =>
        admin.PutAsync($"/api/v1/admin/users/{userId}/access", new { access });

    static string[] Access(JsonElement userRow) => userRow.GetProperty("access").EnumerateArray().Select(x => x.GetString()!).ToArray();

    static async Task<Guid> Direct(TestClient c, Guid userId) => (await Ok(c.PostAsync("/api/v1/chat/direct", new { userId }))).GetProperty("id").GetGuid();

    async Task EndOpenCalls() =>
        await Exec("UPDATE chat.TRN_ChatCall SET [Status] = 'ENDED', EndedUtc = SYSUTCDATETIME() WHERE [Status] IN ('RINGING', 'ACTIVE')");

    [Fact]
    public async Task Without_blocks_permissions_are_exactly_what_the_roles_allow()
    {
        await Switches();
        var (email, id) = await User("plain", "Pia Plain");
        var pia = await SignedIn(email);
        var perms = await Permissions(pia);
        foreach (var p in new[] { "dashboard.view", "meetings.view.own", "meetings.create", "calendar.view", "recordings.view.own", "notifications.view",
                                  "chat.use", "chat.calls", "chat.tasks" })
            Assert.Contains(p, perms);

        // Every user without blocks: auth.EffectivePermissions = the role permissions, code for code.
        Assert.Equal(0, await fx.QueryAsync<int>("""
            SELECT COUNT(*) FROM auth.Users u
            WHERE NOT EXISTS (SELECT 1 FROM auth.UserModuleBlocks b WHERE b.UserId = u.UserId)
              AND EXISTS (
                (SELECT p.Code FROM auth.UserRoles ur JOIN auth.RolePermissions rp ON rp.RoleId = ur.RoleId JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE ur.UserId = u.UserId
                 EXCEPT SELECT Code FROM auth.EffectivePermissions(u.UserId))
                UNION ALL
                (SELECT Code FROM auth.EffectivePermissions(u.UserId)
                 EXCEPT SELECT p.Code FROM auth.UserRoles ur JOIN auth.RolePermissions rp ON rp.RoleId = ur.RoleId JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE ur.UserId = u.UserId))
            """));
        // Every role that has chat.use also has chat.calls and chat.tasks (V032).
        Assert.Equal(0, await fx.QueryAsync<int>("""
            SELECT COUNT(*) FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId AND p.Code = 'chat.use'
            WHERE (SELECT COUNT(*) FROM auth.RolePermissions x JOIN auth.Permissions q ON q.PermissionId = x.PermissionId WHERE x.RoleId = rp.RoleId AND q.Code IN ('chat.calls', 'chat.tasks')) <> 2
            """));

        var admin = await SignedIn("admin@test.invalid");
        var list = await Ok(admin.Http.GetAsync("/api/v1/admin/users?search=ua.plain"));
        Assert.Equal(AllModules, Access(list.GetProperty("items").EnumerateArray().Single()));
        Assert.Equal(AllModules, Access(await Ok(admin.Http.GetAsync($"/api/v1/admin/users/{id}"))));
        var status = await Ok(pia.Http.GetAsync("/api/v1/chat/status"));
        Assert.True(status.GetProperty("tasks").GetBoolean());
        Assert.True(status.GetProperty("calls").GetBoolean());
    }

    [Fact]
    public async Task Chat_and_calls_only_removes_meetings_and_tasks_on_the_next_request()
    {
        await Switches();
        await EndOpenCalls();
        var (bobEmail, bobId) = await User("bob", "Bob Modular");
        var (adaEmail, adaId) = await User("ada", "Ada Modular");
        var bob = await SignedIn(bobEmail);   // signed in BEFORE the change: the change must still apply at once
        var ada = await SignedIn(adaEmail);
        var admin = await SignedIn("admin@test.invalid");
        try
        {
            var row = await Ok(SetAccess(admin, bobId, "chat", "CALLS"));
            Assert.Equal(["CHAT", "CALLS"], Access(row));
            Assert.Equal(bobId, row.GetProperty("id").GetGuid());

            var perms = await Permissions(bob);
            Assert.DoesNotContain(perms, p => p.StartsWith("meetings.") || p.StartsWith("recordings.") || p == "dashboard.view" || p == "calendar.view" || p == "chat.tasks");
            Assert.Contains("chat.use", perms);
            Assert.Contains("chat.calls", perms);
            Assert.Contains("notifications.view", perms);   // not part of any module

            var meetings = await bob.Http.GetAsync("/api/v1/meetings");
            Assert.Equal(HttpStatusCode.Forbidden, meetings.StatusCode);
            Assert.Equal("FORBIDDEN", await Code(meetings));
            Assert.Equal(HttpStatusCode.Forbidden, (await bob.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);

            Assert.Equal(HttpStatusCode.OK, (await bob.Http.GetAsync("/api/v1/chat/conversations")).StatusCode);
            foreach (var path in new[] { "/api/v1/chat/notes", "/api/v1/chat/tasks", "/api/v1/chat/my-day", "/api/v1/chat/reminders/due", "/api/v1/chat/categories", "/api/v1/chat/tasks/followup-panel" })
            {
                var r = await bob.Http.GetAsync(path);
                Assert.True(r.StatusCode == HttpStatusCode.Forbidden, path);
                Assert.Equal("FORBIDDEN", await Code(r));
            }
            Assert.Equal(HttpStatusCode.Forbidden, (await bob.PostAsync("/api/v1/chat/tasks", new { title = "Not allowed" })).StatusCode);
            var status = await Ok(bob.Http.GetAsync("/api/v1/chat/status"));
            Assert.False(status.GetProperty("tasks").GetBoolean());
            Assert.True(status.GetProperty("calls").GetBoolean());

            // Calls still work both ways.
            var conv = await Direct(bob, adaId);
            var started = await Ok(bob.PostAsync("/api/v1/chat/calls", new { conversationId = conv }));
            Assert.Empty(started.GetProperty("skipped").EnumerateArray());
            var callId = started.GetProperty("call").GetProperty("id").GetGuid();
            Assert.Equal(HttpStatusCode.OK, (await ada.PostAsync($"/api/v1/chat/calls/{callId}/accept")).StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await bob.PostAsync($"/api/v1/chat/calls/{callId}/end")).StatusCode);

            Assert.Equal(1, await fx.QueryAsync<int>("""
                SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'USER_ACCESS_CHANGED' AND EntityType = 'User' AND EntityId = @id
                  AND IsPrivileged = 1 AND CHARINDEX('"access":["CHAT","CALLS"]', NewValuesJson) > 0
                """, new { id = bobId.ToString() }));

            // Switched back on: everything returns on the next request.
            Assert.Equal(AllModules, Access(await Ok(SetAccess(admin, bobId, AllModules))));
            Assert.Equal(HttpStatusCode.OK, (await bob.Http.GetAsync("/api/v1/meetings")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await bob.Http.GetAsync("/api/v1/chat/notes")).StatusCode);
            Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.UserModuleBlocks b JOIN auth.Users u ON u.UserId = b.UserId WHERE u.PublicId = @bobId", new { bobId }));
        }
        finally
        {
            await SetAccess(admin, bobId, AllModules);
            await EndOpenCalls();
        }
    }

    [Fact]
    public async Task Meetings_only_removes_chat_and_keeps_meetings()
    {
        await Switches();
        var (email, id) = await User("dee", "Dee Modular");
        var dee = await SignedIn(email);
        var admin = await SignedIn("admin@test.invalid");
        try
        {
            Assert.Equal(["MEETINGS"], Access(await Ok(SetAccess(admin, id, "MEETINGS"))));
            var perms = await Permissions(dee);
            Assert.DoesNotContain(perms, p => p.StartsWith("chat."));
            Assert.Contains("meetings.view.own", perms);
            Assert.Contains("dashboard.view", perms);
            foreach (var path in new[] { "/api/v1/chat/status", "/api/v1/chat/conversations", "/api/v1/chat/people", "/api/v1/chat/calls/current", "/api/v1/chat/notes" })
                Assert.True((await dee.Http.GetAsync(path)).StatusCode == HttpStatusCode.Forbidden, path);
            Assert.Equal(HttpStatusCode.OK, (await dee.Http.GetAsync("/api/v1/meetings")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await dee.Http.GetAsync("/api/v1/dashboard/summary")).StatusCode);
        }
        finally { await SetAccess(admin, id, AllModules); }
    }

    [Fact]
    public async Task People_without_calls_are_never_rung()
    {
        await Switches();
        await EndOpenCalls();
        var (callerEmail, callerId) = await User("kai", "Kai Caller");
        var (_, cydId) = await User("cyd", "Cyd Silent");
        var (_, evaId) = await User("eva", "Eva Ringer");
        var (_, finId) = await User("fin", "Fin Silent");
        var kai = await SignedIn(callerEmail);
        var admin = await SignedIn("admin@test.invalid");
        try
        {
            await Ok(SetAccess(admin, cydId, "MEETINGS", "CHAT", "TASKS"));
            await Ok(SetAccess(admin, finId, "MEETINGS", "CHAT"));

            // People search tells the website who can be called.
            var people = (await Ok(kai.Http.GetAsync("/api/v1/chat/people?search=Silent"))).EnumerateArray().ToList();
            Assert.Equal(2, people.Count);
            Assert.All(people, p => Assert.False(p.GetProperty("canCall").GetBoolean()));
            Assert.True((await Ok(kai.Http.GetAsync("/api/v1/chat/people?search=Eva%20Ringer"))).EnumerateArray().Single().GetProperty("canCall").GetBoolean());

            // Direct call to someone who cannot receive calls: 409, nobody rung, no call created.
            var before = await fx.QueryAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatCall");
            var r = await kai.PostAsync("/api/v1/chat/calls", new { conversationId = await Direct(kai, cydId) });
            Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
            Assert.Equal("CALLS_NOT_AVAILABLE", await Code(r));
            Assert.Equal("Cyd Silent cannot receive audio calls.", (await Json(r)).GetProperty("detail").GetString());
            Assert.Equal(before, await fx.QueryAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatCall"));

            // Group where nobody else can receive calls: 409 with the group message.
            var silentGroup = (await Ok(kai.PostAsync("/api/v1/chat/groups", new { name = "Silent pair", memberIds = new[] { cydId, finId } }))).GetProperty("id").GetGuid();
            r = await kai.PostAsync("/api/v1/chat/calls", new { conversationId = silentGroup });
            Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
            Assert.Equal("CALLS_NOT_AVAILABLE", await Code(r));
            Assert.Equal("None of these colleagues can receive audio calls.", (await Json(r)).GetProperty("detail").GetString());

            // Mixed group: only Eva is rung; Cyd and Fin are skipped (not participants of the call at all).
            var group = (await Ok(kai.PostAsync("/api/v1/chat/groups", new { name = "Mixed call", memberIds = new[] { cydId, evaId, finId } }))).GetProperty("id").GetGuid();
            var started = await Ok(kai.PostAsync("/api/v1/chat/calls", new { conversationId = group }));
            var skipped = started.GetProperty("skipped").EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToHashSet();
            Assert.Equal(new HashSet<Guid> { cydId, finId }, skipped);
            var participants = started.GetProperty("call").GetProperty("participants").EnumerateArray().Select(p => p.GetProperty("id").GetGuid()).ToHashSet();
            Assert.Equal(new HashSet<Guid> { callerId, evaId }, participants);
            var callId = started.GetProperty("call").GetProperty("id").GetGuid();

            // Adding someone who cannot receive calls mid-call: 409; with a callable person they are skipped.
            r = await kai.PostAsync($"/api/v1/chat/calls/{callId}/invite", new { userIds = new[] { cydId } });
            Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
            Assert.Equal("CALLS_NOT_AVAILABLE", await Code(r));
            var (_, gusId) = await User("gus", "Gus Ringer");
            var invited = await Ok(kai.PostAsync($"/api/v1/chat/calls/{callId}/invite", new { userIds = new[] { cydId, gusId } }));
            Assert.Equal([cydId], invited.GetProperty("skipped").EnumerateArray().Select(x => x.GetProperty("id").GetGuid()).ToArray());
            Assert.Contains(invited.GetProperty("participants").EnumerateArray(), p => p.GetProperty("id").GetGuid() == gusId && p.GetProperty("state").GetString() == "RINGING");
            Assert.Equal(0, await fx.QueryAsync<int>("""
                SELECT COUNT(*) FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall cl ON cl.CallId = p.CallId JOIN auth.Users u ON u.UserId = p.UserId
                WHERE cl.PublicId = @callId AND u.PublicId IN (@cydId, @finId)
                """, new { callId, cydId, finId }));

            // Someone whose calls are switched off while being rung stops ringing at the next call-worker pass.
            await Ok(SetAccess(admin, evaId, "MEETINGS", "CHAT"));
            await fx.Factory.Services.GetRequiredService<ChatCallWorker>().RunOnceAsync();
            Assert.Equal("MISSED", await fx.QueryAsync<string>("""
                SELECT p.[State] FROM chat.TRN_ChatCallParticipant p JOIN chat.TRN_ChatCall cl ON cl.CallId = p.CallId JOIN auth.Users u ON u.UserId = p.UserId
                WHERE cl.PublicId = @callId AND u.PublicId = @evaId
                """, new { callId, evaId }));

            // The person without calls cannot use the call endpoints at all.
            var cyd = await SignedIn("ua.cyd@test.invalid");
            var current = await cyd.Http.GetAsync("/api/v1/chat/calls/current");
            Assert.Equal(HttpStatusCode.Forbidden, current.StatusCode);
            Assert.Equal("FORBIDDEN", await Code(current));
        }
        finally
        {
            foreach (var u in new[] { cydId, evaId, finId }) await SetAccess(admin, u, AllModules);
            await EndOpenCalls();
        }
    }

    [Fact]
    public async Task Reminders_wait_while_notes_and_tasks_are_switched_off()
    {
        await Switches();
        var (email, id) = await User("rex", "Rex Reminder");
        var rex = await SignedIn(email);
        var admin = await SignedIn("admin@test.invalid");
        try
        {
            var task = await Ok(rex.PostAsync("/api/v1/chat/tasks", new { title = "Call back the customer", reminderUtc = DateTime.UtcNow.AddDays(1) }));
            var reminderId = task.GetProperty("reminderId").GetGuid();
            await Ok(SetAccess(admin, id, "MEETINGS", "CHAT", "CALLS"));
            await Exec("UPDATE chat.TRN_ChatReminder SET DueUtc = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE PublicId = @reminderId", new { reminderId });

            var worker = fx.Factory.Services.GetRequiredService<ChatReminderWorker>();
            await worker.RunOnceAsync();
            await Task.Delay(1500);   // the background worker (every second) must not fire it either
            Assert.Equal("PENDING", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @reminderId", new { reminderId }));
            Assert.False((await Ok(rex.Http.GetAsync("/api/v1/chat/status"))).GetProperty("tasks").GetBoolean());

            // Switched back on: the reminder fires (catch-up), exactly as after the CHAT_TASKS switch was off.
            await Ok(SetAccess(admin, id, AllModules));
            await worker.RunOnceAsync();
            for (var i = 0; i < 50 && await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @reminderId", new { reminderId }) != "FIRED"; i++)
                await Task.Delay(200);
            Assert.Equal("FIRED", await fx.QueryAsync<string>("SELECT [State] FROM chat.TRN_ChatReminder WHERE PublicId = @reminderId", new { reminderId }));
        }
        finally { await SetAccess(admin, id, AllModules); }
    }

    [Fact]
    public async Task Access_is_validated_audited_and_can_be_set_when_creating_a_user()
    {
        await Switches();
        var (email, id) = await User("val", "Val Modular");
        var admin = await SignedIn("admin@test.invalid");

        foreach (var bad in new[] { new[] { "CALLS" }, ["TASKS", "MEETINGS"], ["CHAT", "VIDEO"] })
        {
            var r = await SetAccess(admin, id, bad);
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
            Assert.Equal("VALIDATION", await Code(r));
            Assert.True((await Json(r)).GetProperty("errors").TryGetProperty("access", out _));
        }
        var missing = await admin.PutAsync($"/api/v1/admin/users/{id}/access", new { });
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'USER_ACCESS_CHANGED' AND EntityId = @id", new { id = id.ToString() }));

        // Only users.manage may change access.
        var val = await SignedIn(email);
        Assert.Equal(HttpStatusCode.Forbidden, (await SetAccess(val, id, "MEETINGS")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await SetAccess(admin, Guid.NewGuid(), "MEETINGS")).StatusCode);

        // No modules at all is allowed (the user keeps notifications and any administration permissions).
        Assert.Empty(Access(await Ok(SetAccess(admin, id, []))));
        Assert.Equal(4, await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.UserModuleBlocks b JOIN auth.Users u ON u.UserId = b.UserId WHERE u.PublicId = @id", new { id }));
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'USER_ACCESS_CHANGED' AND EntityId = @id", new { id = id.ToString() }));
        await Ok(SetAccess(admin, id, AllModules));

        // Create with access.
        var badCreate = await admin.PostAsync("/api/v1/admin/users", new { email = "ua.newbad@test.invalid", roles = new[] { "Employee" }, access = new[] { "TASKS" } });
        Assert.Equal(HttpStatusCode.BadRequest, badCreate.StatusCode);
        Assert.True((await Json(badCreate)).GetProperty("errors").TryGetProperty("access", out _));
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.Users WHERE Email = N'ua.newbad@test.invalid'"));

        var created = await admin.PostAsync("/api/v1/admin/users", new { email = "ua.newmeet@test.invalid", roles = new[] { "Employee" }, access = new[] { "MEETINGS" } });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var newId = (await Json(created)).GetProperty("id").GetGuid();
        var listed = (await Ok(admin.Http.GetAsync("/api/v1/admin/users?search=ua.newmeet"))).GetProperty("items").EnumerateArray().Single();
        Assert.Equal(["MEETINGS"], Access(listed));
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'USER_ACCESS_CHANGED' AND EntityId = @id", new { id = newId.ToString() }));

        // Create without access: no blocks (all modules, as before).
        var plain = await admin.PostAsync("/api/v1/admin/users", new { email = "ua.newall@test.invalid", roles = new[] { "Employee" } });
        Assert.Equal(HttpStatusCode.Created, plain.StatusCode);
        var plainId = (await Json(plain)).GetProperty("id").GetGuid();
        Assert.Equal(AllModules, Access(await Ok(admin.Http.GetAsync($"/api/v1/admin/users/{plainId}"))));
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.UserModuleBlocks b JOIN auth.Users u ON u.UserId = b.UserId WHERE u.PublicId = @plainId", new { plainId }));
    }
}
