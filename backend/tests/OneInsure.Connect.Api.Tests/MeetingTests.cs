using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Meetings;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Phase 3: meetings, double booking, RSVP, customers and invitation links, reminders, notifications, calendar and availability.
/// Each test books on its own day so tests cannot conflict with each other.
/// </summary>
[Collection(ApiCollection.Name)]
public sealed partial class MeetingTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;
    static DateTime Slot(int day, double hour) => DateTime.SpecifyKind(DateTime.UtcNow.Date.AddDays(day).AddHours(hour), DateTimeKind.Utc);
    Task<int> RunReminders() => fx.Factory.Services.GetRequiredService<ReminderWorker>().RunOnceAsync(CancellationToken.None);
    Task<int> Count(string sql, object? p = null) => fx.QueryAsync<int>(sql, p);
    Task<Guid> Emp(string code) => fx.QueryAsync<Guid>("SELECT PublicId FROM org.Employees WHERE EmployeeCode = @code", new { code });
    Task<long> MeetingRowId(Guid id) => fx.QueryAsync<long>("SELECT MeetingId FROM mtg.Meetings WHERE PublicId = @id", new { id });

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    static object Meeting(string title, DateTime start, DateTime end, Guid[]? employees = null, string category = "TEAM", string status = "SCHEDULED",
        object[]? guests = null, Guid? customerId = null, bool overrideConflicts = false, string? overrideReason = null) =>
        new { title, category, startUtc = start, endUtc = end, employeeIds = employees ?? [], guests, customerId, status, recordingPolicy = "OPTIONAL", overrideConflicts, overrideReason };

    async Task<Guid> Create(TestClient c, object body)
    {
        var r = await c.PostAsync("/api/v1/meetings", body);
        Assert.True(r.StatusCode == HttpStatusCode.Created, await r.Content.ReadAsStringAsync());
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    static string Token(string body) => Regex.Match(body, @"/join/([A-Za-z0-9_\-]+)").Groups[1].Value;

    // ---- Create / list / get / update / cancel ------------------------------------------------------------

    [Fact]
    public async Task Meeting_lifecycle_with_visibility_invitations_reminders_and_reschedule()
    {
        var host = await SignedIn("mhost@test.invalid");
        var peer = await SignedIn("mpeer@test.invalid");
        var outsider = await SignedIn("mout@test.invalid");
        var super = await SignedIn("msuper@test.invalid");
        Guid peerId = await Emp("M-PEER"), thirdId = await Emp("M-THIRD");

        var r = await host.PostAsync("/api/v1/meetings", Meeting("Quarterly planning", Slot(10, 5), Slot(10, 6), [peerId, thirdId],
            guests: [new { name = "Gita Guest", email = "gita.guest@test.invalid" }]));
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        var created = await Json(r);
        var id = created.GetProperty("id").GetGuid();
        Assert.Matches(@"^OIC-\d{6}-[A-Z2-9]{4}$", created.GetProperty("meetingCode").GetString());
        var mid = await MeetingRowId(id);

        Assert.Equal(4, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants WHERE MeetingId = @mid", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = @mid AND e.EmployeeCode = 'M-HOST' AND p.[Role] = 'HOST' AND p.ResponseStatus = 'ACCEPTED'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.Meetings m JOIN org.Employees e ON e.EmployeeId = m.CreatedByEmployeeId WHERE m.MeetingId = @mid AND e.EmployeeCode = 'M-HOST' AND LEN(m.LiveKitRoomName) >= 32", new { mid }));
        // Invitation e-mails to everyone but the organiser; the guest's carries a personal join link (only its hash is stored).
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_INVITED'", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = N'mhost@test.invalid'", new { mid }));
        var guestMail = await fx.QueryAsync<string>("SELECT BodyHtml FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = N'gita.guest@test.invalid'", new { mid });
        Assert.Contains("Quarterly planning", guestMail);
        Assert.Contains(" IST", guestMail);
        var token1 = Token(guestMail);
        Assert.NotEmpty(token1);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations WHERE MeetingId = @mid AND RevokedUtc IS NULL", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE n.MeetingId = @mid AND u.Email = N'mpeer@test.invalid' AND n.[Type] = 'INVITATION' AND n.LinkPath = @link", new { mid, link = $"/meetings/{id}" }));
        // 3 offsets × (3 employees with accounts × IN_APP+EMAIL + guest × EMAIL).
        Assert.Equal(21, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND [Status] = 'PENDING' AND ScheduleVersion = 1", new { mid }));

        // Visibility.
        var peerList = await Json(await peer.Http.GetAsync("/api/v1/meetings?scope=mine&pageSize=100"));
        Assert.Contains(peerList.GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        Assert.DoesNotContain((await Json(await peer.Http.GetAsync("/api/v1/meetings?scope=hosting&pageSize=100"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        Assert.Contains((await Json(await peer.Http.GetAsync("/api/v1/meetings?scope=attending&pageSize=100"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        var peerView = await Json(await peer.Http.GetAsync($"/api/v1/meetings/{id}"));
        Assert.Equal("ATTENDEE", peerView.GetProperty("my").GetProperty("role").GetString());
        Assert.False(peerView.GetProperty("my").GetProperty("canEdit").GetBoolean());
        Assert.Equal(4, peerView.GetProperty("participants").GetArrayLength());
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.Http.GetAsync($"/api/v1/meetings/{id}")).StatusCode);
        Assert.DoesNotContain((await Json(await outsider.Http.GetAsync("/api/v1/meetings?pageSize=100"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync("/api/v1/meetings?scope=all")).StatusCode);
        Assert.Contains((await Json(await super.Http.GetAsync("/api/v1/meetings?scope=all&search=Quarterly&pageSize=100"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(HttpStatusCode.OK, (await super.Http.GetAsync($"/api/v1/meetings/{id}")).StatusCode);

        // Only host/organiser/admin may change it; invisible meetings are 404 for writes too.
        var update = new { title = "Quarterly planning (moved)", category = "TEAM", startUtc = Slot(11, 5), endUtc = Slot(11, 6), status = "SCHEDULED" };
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PutAsync($"/api/v1/meetings/{id}", update)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.PutAsync($"/api/v1/meetings/{id}", update)).StatusCode);
        var resched = await host.PutAsync($"/api/v1/meetings/{id}", update);
        Assert.Equal(HttpStatusCode.OK, resched.StatusCode);
        Assert.True((await Json(resched)).GetProperty("rescheduled").GetBoolean());
        Assert.Equal(2, await fx.QueryAsync<int>("SELECT ScheduleVersion FROM mtg.Meetings WHERE MeetingId = @mid", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 1 AND [Status] <> 'CANCELLED'", new { mid }));
        Assert.Equal(21, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 2 AND [Status] = 'PENDING'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations WHERE MeetingId = @mid AND RevokedUtc IS NULL", new { mid }));
        Assert.Equal(HttpStatusCode.NotFound, (await (await fx.NewClientAsync()).Http.GetAsync($"/api/v1/join/{token1}")).StatusCode); // old link revoked
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE n.MeetingId = @mid AND u.Email = N'mthird@test.invalid' AND n.[Type] = 'RESCHEDULED'", new { mid }));
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_RESCHEDULED'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityType = 'Meeting' AND EntityId = @id AND [Action] = 'MEETING_RESCHEDULED'", new { id = id.ToString() }));

        // Cancel: reason required, reminders and links stop, everyone is told.
        Assert.Equal("VALIDATION", await Code(await host.PostAsync($"/api/v1/meetings/{id}/cancel", new { reason = "" })));
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{id}/cancel", new { reason = "No" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{id}/cancel", new { reason = "Budget review postponed" })).StatusCode);
        Assert.Equal("CANCELLED", await fx.QueryAsync<string>("SELECT [Status] FROM mtg.Meetings WHERE MeetingId = @mid", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND [Status] IN ('PENDING', 'CLAIMED', 'FAILED')", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations WHERE MeetingId = @mid AND RevokedUtc IS NULL", new { mid }));
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_CANCELLED' AND BodyHtml LIKE N'%Budget review postponed%'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE n.MeetingId = @mid AND u.Email = N'mpeer@test.invalid' AND n.[Type] = 'CANCELLED'", new { mid }));
        Assert.Equal("CONFLICT", await Code(await host.PostAsync($"/api/v1/meetings/{id}/cancel", new { reason = "again" })));
        Assert.Equal("CONFLICT", await Code(await host.PutAsync($"/api/v1/meetings/{id}", update)));
    }

    [Fact]
    public async Task Create_validates_input_and_requires_a_linked_employee()
    {
        var host = await SignedIn("mhost@test.invalid");
        var noEmployee = await SignedIn("admin@test.invalid"); // SuperAdmin without an employee record
        var r = await noEmployee.PostAsync("/api/v1/meetings", Meeting("x", Slot(12, 5), Slot(12, 6)));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Contains("not linked to an employee", (await Json(r)).GetProperty("detail").GetString());

        var bad = await Json(await host.PostAsync("/api/v1/meetings", new { title = "", category = "PARTY", startUtc = Slot(12, 6), endUtc = Slot(12, 5) }));
        Assert.Equal("VALIDATION", bad.GetProperty("code").GetString());
        var errors = bad.GetProperty("errors");
        Assert.True(errors.TryGetProperty("title", out _));
        Assert.True(errors.TryGetProperty("category", out _));
        Assert.True(errors.TryGetProperty("endUtc", out _));
        Assert.True((await Json(await host.PostAsync("/api/v1/meetings", Meeting("Too long", Slot(12, 1), Slot(12, 10))))).GetProperty("errors").TryGetProperty("endUtc", out _));
        Assert.True((await Json(await host.PostAsync("/api/v1/meetings", Meeting("Past", Slot(-1, 5), Slot(-1, 6))))).GetProperty("errors").TryGetProperty("startUtc", out _));
        Assert.True((await Json(await host.PostAsync("/api/v1/meetings", Meeting("No customer", Slot(12, 5), Slot(12, 6), category: "CUSTOMER_PLVC")))).GetProperty("errors").TryGetProperty("customerId", out _));
        Assert.True((await Json(await host.PostAsync("/api/v1/meetings", Meeting("Unknown employee", Slot(12, 5), Slot(12, 6), [Guid.NewGuid()])))).GetProperty("errors").TryGetProperty("employeeIds", out _));
        Assert.True((await Json(await host.PostAsync("/api/v1/meetings", Meeting("Bad guest", Slot(12, 5), Slot(12, 6), guests: [new { name = "G", email = "nope" }])))).GetProperty("errors").TryGetProperty("guests[0].email", out _));

        // Drafts may be in the past, are invisible to invitees and send nothing until scheduled.
        var peer = await SignedIn("mpeer@test.invalid");
        var draft = await Create(host, Meeting("Draft idea", Slot(-2, 5), Slot(-2, 6), [await Emp("M-PEER")], status: "DRAFT"));
        var mid = await MeetingRowId(draft);
        Assert.Equal(HttpStatusCode.NotFound, (await peer.Http.GetAsync($"/api/v1/meetings/{draft}")).StatusCode);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid", new { mid }));
        Assert.Equal("VALIDATION", await Code(await host.PutAsync($"/api/v1/meetings/{draft}", new { title = "Draft idea", startUtc = Slot(-2, 5), endUtc = Slot(-2, 6), status = "SCHEDULED" })));
        var scheduled = await host.PutAsync($"/api/v1/meetings/{draft}", new { title = "Draft idea", startUtc = Slot(12, 5), endUtc = Slot(12, 6), status = "SCHEDULED" });
        Assert.Equal(HttpStatusCode.OK, scheduled.StatusCode);
        Assert.False((await Json(scheduled)).GetProperty("rescheduled").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await peer.Http.GetAsync($"/api/v1/meetings/{draft}")).StatusCode);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_INVITED'", new { mid }));
        Assert.True(await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 1", new { mid }) > 0);
        Assert.Equal("VALIDATION", await Code(await host.PutAsync($"/api/v1/meetings/{draft}", new { title = "Draft idea", startUtc = Slot(12, 5), endUtc = Slot(12, 6), status = "DRAFT" })));
    }

    // ---- Double booking ---------------------------------------------------------------------------------------

    [Fact]
    public async Task Double_booking_is_rejected_with_conflicts_and_can_be_overridden_only_with_permission()
    {
        var host = await SignedIn("mhost@test.invalid");
        var peer = await SignedIn("mpeer@test.invalid");
        var super = await SignedIn("msuper@test.invalid");
        var hostId = await Emp("M-HOST");
        var first = await Create(host, Meeting("Confidential board prep", Slot(14, 5), Slot(14, 6)));

        var clash = await peer.PostAsync("/api/v1/meetings", Meeting("Catch-up", Slot(14, 5.5), Slot(14, 6.5), [hostId]));
        Assert.Equal(HttpStatusCode.Conflict, clash.StatusCode);
        var body = await Json(clash);
        Assert.Equal("CONFLICT", body.GetProperty("code").GetString());
        var conflict = body.GetProperty("conflicts")[0];
        Assert.Equal(hostId, conflict.GetProperty("employeeId").GetGuid());
        Assert.Equal("Meera Host", conflict.GetProperty("employeeName").GetString());
        Assert.Equal("MEETING", conflict.GetProperty("type").GetString());
        Assert.Equal(Slot(14, 5), conflict.GetProperty("startUtc").GetDateTime());
        Assert.DoesNotContain("board prep", await clash.Content.ReadAsStringAsync()); // other meetings' titles never leak

        // Back-to-back is fine (end is exclusive).
        await Create(peer, Meeting("Right after", Slot(14, 6), Slot(14, 6.5), [hostId]));

        // Live check used by the form.
        var check = await Json(await peer.PostAsync("/api/v1/meetings/availability", new { employeeIds = new[] { hostId }, startUtc = Slot(14, 5.25), endUtc = Slot(14, 5.75) }));
        Assert.False(check.GetProperty("available").GetBoolean());
        var exclude = await Json(await host.PostAsync("/api/v1/meetings/availability", new { employeeIds = new[] { hostId }, startUtc = Slot(14, 5.25), endUtc = Slot(14, 5.75), excludeMeetingId = first }));
        Assert.True(exclude.GetProperty("available").GetBoolean());

        // Override: Employees lack meetings.override.conflict; SuperAdmin must give a reason and is audited (privileged).
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync("/api/v1/meetings", Meeting("Catch-up", Slot(14, 5.5), Slot(14, 6.5), [hostId], overrideConflicts: true, overrideReason: "Urgent"))).StatusCode);
        Assert.True((await Json(await super.PostAsync("/api/v1/meetings", Meeting("Escalation", Slot(14, 5.5), Slot(14, 6.5), [hostId], overrideConflicts: true)))).GetProperty("errors").TryGetProperty("overrideReason", out _));
        var forced = await super.PostAsync("/api/v1/meetings", Meeting("Escalation", Slot(14, 5.5), Slot(14, 6.5), [hostId], overrideConflicts: true, overrideReason: "Regulator call"));
        Assert.Equal(HttpStatusCode.Created, forced.StatusCode);
        var forcedBody = await Json(forced);
        var forcedId = forcedBody.GetProperty("id").GetGuid();
        Assert.True(forcedBody.GetProperty("overriddenConflicts").GetInt32() >= 1);
        Assert.Equal("Regulator call", await fx.QueryAsync<string>("SELECT OverrideConflictReason FROM mtg.Meetings WHERE PublicId = @forcedId", new { forcedId }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'MEETING_CONFLICT_OVERRIDDEN' AND EntityId = @e AND IsPrivileged = 1", new { e = forcedId.ToString() }));

        // Leave blocks booking too; a DECLINED participant does not.
        var peerId = await Emp("M-PEER");
        Assert.Equal(HttpStatusCode.Created, (await peer.PostAsync("/api/v1/account/availability", new { type = "LEAVE", startUtc = Slot(15, 0), endUtc = Slot(16, 0), reason = "Family function" })).StatusCode);
        var leave = await host.PostAsync("/api/v1/meetings", Meeting("During leave", Slot(15, 5), Slot(15, 6), [peerId]));
        Assert.Equal(HttpStatusCode.Conflict, leave.StatusCode);
        Assert.Equal("LEAVE", (await Json(leave)).GetProperty("conflicts")[0].GetProperty("type").GetString());
        Assert.DoesNotContain("Family function", await leave.Content.ReadAsStringAsync());
        var withPeer = await Create(host, Meeting("Declinable", Slot(14, 8), Slot(14, 9), [peerId]));
        Assert.Equal(HttpStatusCode.NoContent, (await peer.PostAsync($"/api/v1/meetings/{withPeer}/respond", new { response = "DECLINED" })).StatusCode);
        await Create(super, Meeting("Peer is free", Slot(14, 8), Slot(14, 9), [peerId]));
    }

    [Fact]
    public async Task Concurrent_bookings_for_the_same_employee_and_time_cannot_both_succeed()
    {
        var a = await SignedIn("mhost@test.invalid");
        var b = await SignedIn("mthird@test.invalid");
        var conc = await Emp("M-CONC");
        for (var round = 0; round < 5; round++)
        {
            var start = Slot(16, 1 + round * 2);
            var results = await Task.WhenAll(
                a.PostAsync("/api/v1/meetings", Meeting($"Race A{round}", start, start.AddHours(1), [conc])),
                b.PostAsync("/api/v1/meetings", Meeting($"Race B{round}", start.AddMinutes(30), start.AddMinutes(90), [conc])));
            var codes = results.Select(r => r.StatusCode).OrderBy(s => s).ToArray();
            Assert.Equal([HttpStatusCode.Created, HttpStatusCode.Conflict], codes);
        }
        Assert.Equal(5, await Count("""
            SELECT COUNT(*) FROM mtg.Meetings m JOIN mtg.MeetingParticipants p ON p.MeetingId = m.MeetingId JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            WHERE e.EmployeeCode = 'M-CONC' AND m.Title LIKE 'Race%' AND m.[Status] = 'SCHEDULED'
            """));
    }

    // ---- RSVP and participants ------------------------------------------------------------------------------

    [Fact]
    public async Task Rsvp_updates_the_participant_notifies_the_host_and_manages_reminders()
    {
        var host = await SignedIn("mhost@test.invalid");
        var peer = await SignedIn("mpeer@test.invalid");
        var outsider = await SignedIn("mout@test.invalid");
        var id = await Create(host, Meeting("Sprint review", Slot(18, 5), Slot(18, 6), [await Emp("M-PEER")]));
        var mid = await MeetingRowId(id);
        const string peerReminders = """
            SELECT COUNT(*) FROM mtg.MeetingReminders r JOIN mtg.MeetingParticipants p ON p.ParticipantId = r.ParticipantId
            JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE r.MeetingId = @mid AND e.EmployeeCode = 'M-PEER' AND r.[Status] = 'PENDING'
            """;
        Assert.Equal(6, await Count(peerReminders, new { mid }));

        Assert.Equal("VALIDATION", await Code(await peer.PostAsync($"/api/v1/meetings/{id}/respond", new { response = "MAYBE" })));
        Assert.Equal(HttpStatusCode.NotFound, (await outsider.PostAsync($"/api/v1/meetings/{id}/respond", new { response = "ACCEPTED" })).StatusCode);
        Assert.Equal("VALIDATION", await Code(await host.PostAsync($"/api/v1/meetings/{id}/respond", new { response = "DECLINED" })));

        Assert.Equal(HttpStatusCode.NoContent, (await peer.PostAsync($"/api/v1/meetings/{id}/respond", new { response = "ACCEPTED" })).StatusCode);
        Assert.Equal("ACCEPTED", (await Json(await peer.Http.GetAsync($"/api/v1/meetings/{id}"))).GetProperty("my").GetProperty("responseStatus").GetString());
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications n JOIN auth.Users u ON u.UserId = n.RecipientUserId WHERE n.MeetingId = @mid AND u.Email = N'mhost@test.invalid' AND n.[Type] = 'RESPONSE' AND n.Title LIKE N'Pranav Peer accepted%'", new { mid }));

        Assert.Equal(HttpStatusCode.NoContent, (await peer.PostAsync($"/api/v1/meetings/{id}/respond", new { response = "DECLINED" })).StatusCode);
        Assert.Equal(0, await Count(peerReminders, new { mid }));
        Assert.Equal(HttpStatusCode.NoContent, (await peer.PostAsync($"/api/v1/meetings/{id}/respond", new { response = "TENTATIVE" })).StatusCode);
        Assert.Equal(6, await Count(peerReminders, new { mid }));
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'MEETING_RESPONDED' AND EntityId = @e", new { e = id.ToString() }));
    }

    [Fact]
    public async Task Participants_can_be_added_and_removed_by_the_organiser_only()
    {
        var host = await SignedIn("mhost@test.invalid");
        var peer = await SignedIn("mpeer@test.invalid");
        var id = await Create(host, Meeting("Training: claims", Slot(28, 5), Slot(28, 6), [await Emp("M-PEER")], category: "TRAINING"));
        var mid = await MeetingRowId(id);
        var add = new { employeeIds = new[] { await Emp("M-THIRD"), await Emp("M-NOACCT") }, guests = new[] { new { name = "Vikram Vendor", email = "vikram.vendor@test.invalid" } } };
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.PostAsync($"/api/v1/meetings/{id}/participants", add)).StatusCode);
        var added = await host.PostAsync($"/api/v1/meetings/{id}/participants", add);
        Assert.Equal(HttpStatusCode.OK, added.StatusCode);
        Assert.Equal(3, (await Json(added)).GetProperty("added").GetInt32());
        Assert.Equal("VALIDATION", await Code(await host.PostAsync($"/api/v1/meetings/{id}/participants", add))); // all already present
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = N'mnoacct@test.invalid' AND Template = 'MEETING_INVITED'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations WHERE MeetingId = @mid AND RevokedUtc IS NULL", new { mid }));

        var detail = await Json(await host.Http.GetAsync($"/api/v1/meetings/{id}"));
        var participants = detail.GetProperty("participants").EnumerateArray().ToList();
        Assert.Equal(5, participants.Count);
        var guest = participants.Single(p => p.GetProperty("type").GetString() == "GUEST");
        Assert.Equal("ACTIVE", guest.GetProperty("invitation").GetProperty("status").GetString());
        var hostRow = participants.Single(p => p.GetProperty("role").GetString() == "HOST");

        Assert.Equal("CONFLICT", await Code(await host.DeleteAsync($"/api/v1/meetings/{id}/participants/{hostRow.GetProperty("id").GetString()}")));
        Assert.Equal(HttpStatusCode.Forbidden, (await peer.DeleteAsync($"/api/v1/meetings/{id}/participants/{guest.GetProperty("id").GetString()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await host.DeleteAsync($"/api/v1/meetings/{id}/participants/{guest.GetProperty("id").GetString()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await host.DeleteAsync($"/api/v1/meetings/{id}/participants/{guest.GetProperty("id").GetString()}")).StatusCode);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants WHERE MeetingId = @mid AND ParticipantType = 'GUEST'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = N'vikram.vendor@test.invalid' AND Template = 'MEETING_REMOVED'", new { mid }));
    }

    // ---- Customers, invitation tokens, /join ---------------------------------------------------------------

    [Fact]
    public async Task Customer_meeting_issues_a_join_link_that_is_reissued_on_reschedule_and_revoked_on_cancel()
    {
        var host = await SignedIn("mhost@test.invalid");
        Assert.Equal(HttpStatusCode.Forbidden, (await (await SignedIn("noperm@test.invalid")).Http.GetAsync("/api/v1/customers")).StatusCode);
        Assert.True((await Json(await host.PostAsync("/api/v1/customers", new { customerRef = "CUST-001", fullName = "Ravi Customer" }))).GetProperty("errors").TryGetProperty("email", out _));
        var cr = await host.PostAsync("/api/v1/customers", new { customerRef = "cust-001", fullName = "Ravi Customer", email = "ravi.customer@test.invalid", policyNumber = "POL-778899", assignedEmployeeId = await Emp("M-HOST") });
        Assert.Equal(HttpStatusCode.Created, cr.StatusCode);
        var customerId = (await Json(cr)).GetProperty("id").GetGuid();
        Assert.Equal("CONFLICT", await Code(await host.PostAsync("/api/v1/customers", new { customerRef = "CUST-001", fullName = "Dup", mobile = "+919800000000" })));
        var list = await Json(await host.Http.GetAsync("/api/v1/customers?search=Ravi"));
        Assert.Equal(1, list.GetProperty("total").GetInt32());
        Assert.Equal("ra***@test.invalid", list.GetProperty("items")[0].GetProperty("email").GetString()); // masked in lists
        Assert.Equal("ravi.customer@test.invalid", (await Json(await host.Http.GetAsync($"/api/v1/customers/{customerId}"))).GetProperty("email").GetString());
        Assert.Equal(HttpStatusCode.NoContent, (await host.PutAsync($"/api/v1/customers/{customerId}", new { customerRef = "CUST-001", fullName = "Ravi Customer", email = "ravi.customer@test.invalid", mobile = "+919811111111", policyNumber = "POL-778899", notes = "Prefers mornings" })).StatusCode);
        Assert.DoesNotContain("ravi.customer", await fx.QueryAsync<string>("SELECT STRING_AGG(CAST(COALESCE(NewValuesJson, '') + Summary AS NVARCHAR(MAX)), '|') FROM app.AuditLog WHERE EntityType = 'Customer'"));

        Assert.True((await Json(await host.PostAsync("/api/v1/meetings", Meeting("Internal with customer", Slot(30, 5), Slot(30, 6), customerId: customerId)))).GetProperty("errors").TryGetProperty("customerId", out _));

        // Starts in 10 minutes: inside the 15-minute join window.
        var now = DateTime.UtcNow;
        var start = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, DateTimeKind.Utc).AddMinutes(10);
        var id = await Create(host, Meeting("Policy verification call", start, start.AddMinutes(30), category: "CUSTOMER_PLVC", customerId: customerId));
        var mid = await MeetingRowId(id);
        Assert.Equal("POL-778899", await fx.QueryAsync<string>("SELECT PolicyNumber FROM mtg.Meetings WHERE MeetingId = @mid", new { mid }));
        var mail = await fx.QueryAsync<string>("SELECT BodyHtml FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = N'ravi.customer@test.invalid'", new { mid });
        var token = Token(mail);
        Assert.True(token.Length >= 40);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations WHERE MeetingId = @mid AND TokenHash = HASHBYTES('SHA2_256', CAST(@token AS VARCHAR(100)))", new { mid, token })); // only the hash is stored
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingInvitations i JOIN mtg.Meetings m ON m.MeetingId = i.MeetingId WHERE i.MeetingId = @mid AND i.ExpiresUtc = DATEADD(DAY, 1, m.ScheduledEndUtc)", new { mid }));

        var anon = await fx.NewClientAsync();
        var join = await Json(await anon.Http.GetAsync($"/api/v1/join/{token}"));
        Assert.Equal("Policy verification call", join.GetProperty("title").GetString());
        Assert.Equal("Meera Host", join.GetProperty("organiser").GetString());
        Assert.Equal("SCHEDULED", join.GetProperty("status").GetString());
        Assert.True(join.GetProperty("joinableNow").GetBoolean());
        Assert.False(join.TryGetProperty("customer", out _));
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Http.GetAsync("/api/v1/join/not-a-real-token")).StatusCode);

        // Reschedule: old link dies, a new one is e-mailed.
        var later = start.AddDays(31);
        Assert.Equal(HttpStatusCode.OK, (await host.PutAsync($"/api/v1/meetings/{id}", new { title = "Policy verification call", startUtc = later, endUtc = later.AddMinutes(30) })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Http.GetAsync($"/api/v1/join/{token}")).StatusCode);
        var token2 = Token(await fx.QueryAsync<string>("SELECT BodyHtml FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND ToAddress = N'ravi.customer@test.invalid' AND Template = 'MEETING_RESCHEDULED'", new { mid }));
        var join2 = await Json(await anon.Http.GetAsync($"/api/v1/join/{token2}"));
        Assert.False(join2.GetProperty("joinableNow").GetBoolean());

        // Customer details stay with permitted users; the calendar flags the customer meeting.
        var detail = await Json(await host.Http.GetAsync($"/api/v1/meetings/{id}"));
        Assert.Equal("Ravi Customer", detail.GetProperty("customer").GetProperty("name").GetString());
        Assert.Equal("CUSTOMER", detail.GetProperty("categoryGroup").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{id}/cancel", new { reason = "Customer request" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Http.GetAsync($"/api/v1/join/{token2}")).StatusCode);
    }

    // ---- Reminders --------------------------------------------------------------------------------------------

    [Fact]
    public async Task Reminder_worker_delivers_once_and_skips_stale_versions_and_cancelled_meetings()
    {
        var host = await SignedIn("mhost@test.invalid");
        Guid peerId = await Emp("M-PEER"), noAccount = await Emp("M-NOACCT");
        var id = await Create(host, Meeting("Reminder check", Slot(20, 5), Slot(20, 6), [peerId, noAccount]));
        var mid = await MeetingRowId(id);
        // host, peer: IN_APP + EMAIL; no-account employee: EMAIL only → 5 per offset.
        Assert.Equal(15, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid", new { mid }));

        // Reschedule first: version-1 rows are cancelled; even if one is forced back to PENDING it is never claimed.
        Assert.Equal(HttpStatusCode.OK, (await host.PutAsync($"/api/v1/meetings/{id}", new { title = "Reminder check", startUtc = Slot(21, 5), endUtc = Slot(21, 6) })).StatusCode);
        await fx.QueryAsync<int>("""
            UPDATE mtg.MeetingReminders SET DueUtc = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE MeetingId = @mid;
            UPDATE TOP (1) mtg.MeetingReminders SET [Status] = 'PENDING' WHERE MeetingId = @mid AND ScheduleVersion = 1;
            SELECT 1;
            """, new { mid });

        Assert.True(await RunReminders() >= 15);
        Assert.Equal(15, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 2 AND [Status] = 'SENT'", new { mid }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 1 AND [Status] = 'PENDING'", new { mid }));
        Assert.Equal(6, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE MeetingId = @mid AND [Type] = 'REMINDER'", new { mid }));
        Assert.Equal(9, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_REMINDER' AND RelatedReminderId IS NOT NULL", new { mid }));
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_REMINDER' AND ToAddress = N'mnoacct@test.invalid'", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.EmailOutbox o JOIN mtg.MeetingReminders r ON r.ReminderId = o.RelatedReminderId WHERE r.MeetingId = @mid AND r.ScheduleVersion = 1", new { mid }));

        // Idempotent: a second run claims nothing; a re-delivered e-mail reminder cannot create a second e-mail.
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 2 AND [Status] <> 'SENT'", new { mid }));
        await RunReminders();
        await fx.QueryAsync<int>("UPDATE TOP (1) mtg.MeetingReminders SET [Status] = 'PENDING', SentUtc = NULL WHERE MeetingId = @mid AND ScheduleVersion = 2 AND Channel = 'EMAIL'; SELECT 1;", new { mid });
        await RunReminders();
        Assert.Equal(9, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @mid AND Template = 'MEETING_REMINDER'", new { mid }));
        Assert.Equal(6, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE MeetingId = @mid AND [Type] = 'REMINDER'", new { mid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @mid AND ScheduleVersion = 2 AND [Status] <> 'SENT'", new { mid }));

        // Cancelled meeting: nothing is sent even if reminders are due and (wrongly) still pending.
        var gone = await Create(host, Meeting("Will be cancelled", Slot(22, 5), Slot(22, 6), [peerId]));
        var gmid = await MeetingRowId(gone);
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{gone}/cancel", new { reason = "Not needed" })).StatusCode);
        await fx.QueryAsync<int>("UPDATE mtg.MeetingReminders SET [Status] = 'PENDING', DueUtc = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE MeetingId = @gmid; SELECT 1;", new { gmid });
        await RunReminders();
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE MeetingId = @gmid AND [Type] = 'REMINDER'", new { gmid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM app.EmailOutbox WHERE RelatedMeetingId = @gmid AND Template = 'MEETING_REMINDER'", new { gmid }));
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.MeetingReminders WHERE MeetingId = @gmid AND [Status] IN ('SENT', 'CLAIMED')", new { gmid }));
    }

    // ---- Notifications ----------------------------------------------------------------------------------------

    [Fact]
    public async Task Notifications_list_unread_count_and_mark_read()
    {
        var host = await SignedIn("mhost@test.invalid");
        var third = await SignedIn("mthird@test.invalid");
        await Create(host, Meeting("Notify A", Slot(24, 5), Slot(24, 6), [await Emp("M-THIRD")]));
        await Create(host, Meeting("Notify B", Slot(24, 7), Slot(24, 8), [await Emp("M-THIRD")]));

        var page = await Json(await third.Http.GetAsync("/api/v1/notifications?pageSize=5"));
        var unread = page.GetProperty("unreadCount").GetInt32();
        Assert.True(unread >= 2);
        var newest = page.GetProperty("items")[0];
        Assert.Equal("INVITATION", newest.GetProperty("type").GetString());
        Assert.Equal("Invitation: Notify B", newest.GetProperty("title").GetString());
        Assert.StartsWith("/meetings/", newest.GetProperty("linkPath").GetString());
        var nid = newest.GetProperty("id").GetGuid();

        Assert.Equal(HttpStatusCode.NotFound, (await host.PostAsync($"/api/v1/notifications/{nid}/read")).StatusCode); // someone else's
        Assert.Equal(HttpStatusCode.NoContent, (await third.PostAsync($"/api/v1/notifications/{nid}/read")).StatusCode);
        Assert.Equal(unread - 1, (await Json(await third.Http.GetAsync("/api/v1/notifications/unread-count"))).GetProperty("unreadCount").GetInt32());
        var unreadOnly = await Json(await third.Http.GetAsync("/api/v1/notifications?unreadOnly=true&pageSize=100"));
        Assert.DoesNotContain(unreadOnly.GetProperty("items").EnumerateArray(), x => x.GetProperty("id").GetGuid() == nid);
        Assert.Equal(unread - 1, (await Json(await third.PostAsync("/api/v1/notifications/read-all"))).GetProperty("marked").GetInt32());
        Assert.Equal(0, (await Json(await third.Http.GetAsync("/api/v1/notifications"))).GetProperty("unreadCount").GetInt32());
        Assert.Equal(HttpStatusCode.Forbidden, (await (await SignedIn("noperm@test.invalid")).Http.GetAsync("/api/v1/notifications")).StatusCode);
    }

    // ---- Calendar and availability -----------------------------------------------------------------------------

    [Fact]
    public async Task Calendar_shows_meetings_and_leave_with_range_and_permission_checks()
    {
        var host = await SignedIn("mhost@test.invalid");
        var super = await SignedIn("msuper@test.invalid");
        var id = await Create(host, Meeting("Calendar item", Slot(26, 5), Slot(26, 6)));
        Assert.Equal(HttpStatusCode.Created, (await host.PostAsync("/api/v1/account/availability", new { type = "BLOCKED", startUtc = Slot(26, 8), endUtc = Slot(26, 9), reason = "Doctor" })).StatusCode);
        string Range(int fromDay, int toDay) => $"from={Slot(fromDay, 0):O}&to={Slot(toDay, 0):O}".Replace("+", "%2B");

        var cal = await Json(await host.Http.GetAsync($"/api/v1/calendar?{Range(26, 27)}"));
        var items = cal.GetProperty("items").EnumerateArray().ToList();
        Assert.Contains(items, x => x.GetProperty("kind").GetString() == "MEETING" && x.GetProperty("id").GetGuid() == id && x.GetProperty("role").GetString() == "HOST");
        var blocked = items.Single(x => x.GetProperty("kind").GetString() == "BLOCKED");
        Assert.Equal("Doctor", blocked.GetProperty("reason").GetString());
        Assert.True(items.IndexOf(blocked) > items.FindIndex(x => x.GetProperty("kind").GetString() == "MEETING")); // ordered by start
        Assert.DoesNotContain((await Json(await host.Http.GetAsync($"/api/v1/calendar?{Range(26, 27)}&category=CUSTOMER"))).GetProperty("items").EnumerateArray(), x => x.GetProperty("kind").GetString() == "MEETING");

        Assert.Equal("VALIDATION", await Code(await host.Http.GetAsync($"/api/v1/calendar?{Range(1, 70)}")));
        Assert.Equal("VALIDATION", await Code(await host.Http.GetAsync("/api/v1/calendar")));
        var hostId = await Emp("M-HOST");
        Assert.Equal(HttpStatusCode.Forbidden, (await (await SignedIn("mpeer@test.invalid")).Http.GetAsync($"/api/v1/calendar?{Range(26, 27)}&employeeId={hostId}")).StatusCode);
        var asAdmin = await Json(await super.Http.GetAsync($"/api/v1/calendar?{Range(26, 27)}&employeeId={hostId}"));
        var adminBlocked = asAdmin.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("kind").GetString() == "BLOCKED");
        Assert.Equal(JsonValueKind.Null, adminBlocked.GetProperty("reason").ValueKind); // other people's reasons stay private
        var dept = await Json(await super.Http.GetAsync($"/api/v1/calendar?{Range(26, 27)}&department=TST"));
        Assert.Contains(dept.GetProperty("items").EnumerateArray(), x => x.GetProperty("kind").GetString() == "MEETING" && x.GetProperty("id").GetGuid() == id);
    }

    [Fact]
    public async Task Availability_crud_respects_shapes_ownership_and_feeds_working_hour_warnings()
    {
        var me = await SignedIn("mavail@test.invalid");
        var other = await SignedIn("mout@test.invalid");
        Assert.True((await Json(await me.PostAsync("/api/v1/account/availability", new { type = "WORKING_HOURS", dayOfWeek = 1, startLocalTime = "18:00", endLocalTime = "09:00" }))).GetProperty("errors").TryGetProperty("endLocalTime", out _));
        Assert.True((await Json(await me.PostAsync("/api/v1/account/availability", new { type = "WORKING_HOURS", dayOfWeek = 9, startLocalTime = "09:00", endLocalTime = "18:00" }))).GetProperty("errors").TryGetProperty("dayOfWeek", out _));
        Assert.True((await Json(await me.PostAsync("/api/v1/account/availability", new { type = "LEAVE", startUtc = Slot(40, 5) }))).GetProperty("errors").TryGetProperty("endUtc", out _));
        Assert.Equal("VALIDATION", await Code(await me.PostAsync("/api/v1/account/availability", new { type = "HOLIDAY" })));

        // Monday 09:00–18:00 IST only.
        var hours = await me.PostAsync("/api/v1/account/availability", new { type = "WORKING_HOURS", dayOfWeek = 1, startLocalTime = "09:00", endLocalTime = "18:00" });
        Assert.Equal(HttpStatusCode.Created, hours.StatusCode);
        var leave = (await Json(await me.PostAsync("/api/v1/account/availability", new { type = "LEAVE", startUtc = Slot(40, 0), endUtc = Slot(41, 0), reason = "Trip" }))).GetProperty("id").GetGuid();
        var list = await Json(await me.Http.GetAsync("/api/v1/account/availability"));
        Assert.Equal("Asia/Kolkata", list.GetProperty("timeZoneId").GetString());
        Assert.Equal("09:00", list.GetProperty("workingHours")[0].GetProperty("startLocalTime").GetString());
        Assert.Contains(list.GetProperty("periods").EnumerateArray(), p => p.GetProperty("id").GetGuid() == leave);

        Assert.Equal(HttpStatusCode.NotFound, (await other.PutAsync($"/api/v1/account/availability/{leave}", new { type = "LEAVE", startUtc = Slot(40, 0), endUtc = Slot(42, 0) })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.DeleteAsync($"/api/v1/account/availability/{leave}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await me.PutAsync($"/api/v1/account/availability/{leave}", new { type = "BLOCKED", startUtc = Slot(40, 0), endUtc = Slot(42, 0) })).StatusCode);
        Assert.Equal(2, await Count("SELECT DATEDIFF(DAY, StartUtc, EndUtc) FROM mtg.EmployeeAvailability WHERE PublicId = @leave AND [Type] = 'BLOCKED'", new { leave }));

        // Working hours are warnings, not conflicts: next Monday 14:30 UTC = 20:00 IST.
        var monday = DateTime.UtcNow.Date.AddDays(((int)DayOfWeek.Monday - (int)DateTime.UtcNow.DayOfWeek + 7) % 7 + 7);
        var availId = await Emp("M-AVAIL");
        var late = await Json(await me.PostAsync("/api/v1/meetings/availability", new { employeeIds = new[] { availId }, startUtc = DateTime.SpecifyKind(monday.AddHours(14.5), DateTimeKind.Utc), endUtc = DateTime.SpecifyKind(monday.AddHours(15), DateTimeKind.Utc) }));
        Assert.True(late.GetProperty("available").GetBoolean());
        Assert.Equal("OUTSIDE_WORKING_HOURS", late.GetProperty("warnings")[0].GetProperty("type").GetString());
        var inHours = await Json(await me.PostAsync("/api/v1/meetings/availability", new { employeeIds = new[] { availId }, startUtc = DateTime.SpecifyKind(monday.AddHours(5), DateTimeKind.Utc), endUtc = DateTime.SpecifyKind(monday.AddHours(6), DateTimeKind.Utc) }));
        Assert.Equal(0, inHours.GetProperty("warnings").GetArrayLength());
        var during = await Json(await me.PostAsync("/api/v1/meetings/availability", new { startUtc = Slot(40, 5), endUtc = Slot(40, 6) })); // defaults to me
        Assert.Equal("BLOCKED", during.GetProperty("conflicts")[0].GetProperty("type").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await me.DeleteAsync($"/api/v1/account/availability/{leave}")).StatusCode);
        Assert.Equal(0, await Count("SELECT COUNT(*) FROM mtg.EmployeeAvailability WHERE PublicId = @leave", new { leave }));
        Assert.Equal(3, await Count("SELECT COUNT(*) FROM app.AuditLog WHERE EntityType = 'EmployeeAvailability' AND EntityId = @e", new { e = leave.ToString() }));
    }
    [Fact]
    public async Task Colleague_entered_as_guest_email_is_added_as_employee_and_sees_the_meeting()
    {
        // Reported by the user: an employee typed in as a "guest" could not see the meeting in the portal.
        var host = await SignedIn("mhost@test.invalid");
        var id = await Create(host, Meeting("Guest-email colleague", Slot(25, 9), Slot(25, 10),
            guests: [new { name = "Pranav (typed as guest)", email = "MPEER@test.invalid" }, new { name = "Real Guest", email = "real.guest@test.invalid" }]));
        var meetingId = await MeetingRowId(id);
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants p JOIN org.Employees e ON e.EmployeeId = p.EmployeeId WHERE p.MeetingId = @meetingId AND p.ParticipantType = 'EMPLOYEE' AND e.EmployeeCode = 'M-PEER'", new { meetingId }));
        Assert.Equal(1, await Count("SELECT COUNT(*) FROM mtg.MeetingParticipants WHERE MeetingId = @meetingId AND ParticipantType = 'GUEST'", new { meetingId }));

        var peer = await SignedIn("mpeer@test.invalid");
        Assert.Equal(HttpStatusCode.OK, (await peer.Http.GetAsync($"/api/v1/meetings/{id}")).StatusCode);
    }
}
