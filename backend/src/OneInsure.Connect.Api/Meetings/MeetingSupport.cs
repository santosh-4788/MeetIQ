using System.Data;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

public sealed class MeetingOptions
{
    /// <summary>Default meeting / display time zone (IANA).</summary>
    public string DefaultTimeZone { get; set; } = "Asia/Kolkata";
    public int MaxDurationHours { get; set; } = 8;
    public int MaxCalendarDays { get; set; } = 62;
    /// <summary>How early before the start the meeting room opens (employees and the public join page).</summary>
    public int JoinEarlyMinutes { get; set; } = 15;
    /// <summary>How long after the scheduled end the room can still be joined (meetings that overrun, reconnecting participants).</summary>
    public int JoinLateMinutes { get; set; } = 60;
    /// <summary>Anonymous GET /join/{token} and POST /join/{token}/enter requests per client IP per minute.</summary>
    public int JoinPermitPerMinute { get; set; } = 30;
    /// <summary>Anonymous waiting-room polls, leave and guest chat requests per client IP per minute (a guest polls every 3 s).</summary>
    public int WaitingRoomPermitPerMinute { get; set; } = 180;
    /// <summary>Invitation links expire this many days after the meeting's scheduled end.</summary>
    public int InvitationGraceDays { get; set; } = 1;
    /// <summary>Length of an instant meeting when the host does not choose one (it can be ended earlier, and joined until the end + JoinLateMinutes).</summary>
    public int InstantDefaultMinutes { get; set; } = 60;
    /// <summary>How many people (guests and non-invited colleagues) may ask to join one meeting through its shared link.</summary>
    public int MaxLinkJoiners { get; set; } = 50;
}

public sealed class ReminderOptions
{
    public bool Enabled { get; set; } = true;
    /// <summary>Minutes before the start. Null/empty = [1440, 60, 15].</summary>
    public int[]? OffsetsMinutes { get; set; }
    public int PollSeconds { get; set; } = 30;
    public int BatchSize { get; set; } = 50;
    public int MaxAttempts { get; set; } = 5;
    public int LeaseSeconds { get; set; } = 120;

    // The configuration binder appends to (rather than replaces) a pre-filled array, so the default lives here.
    public IReadOnlyList<int> EffectiveOffsets =>
        OffsetsMinutes is { Length: > 0 } o ? o.Where(x => x >= 0).Distinct().OrderByDescending(x => x).ToArray() : [1440, 60, 15];
}

/// <summary>The signed-in user as seen by the meeting endpoints.</summary>
internal sealed record Actor(long UserId, long? EmployeeId, string? EmployeeName, bool ViewAll, bool Override, bool Customers)
{
    public static async Task<Actor> LoadAsync(IDbConnection c, ClaimsPrincipal u, IDbTransaction? tx = null)
    {
        var row = await c.QuerySingleAsync<(long? EmployeeId, string? Name)>("""
            SELECT u.EmployeeId, e.DisplayName FROM auth.Users u LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId AND e.IsActive = 1
            WHERE u.UserId = @id
            """, new { id = u.UserId() }, tx);
        return new Actor(u.UserId(), row.Name is null ? null : row.EmployeeId, row.Name,
            u.Can("meetings.view.all"), u.Can("meetings.override.conflict"), u.Can("customer.meetings.view"));
    }
}

public sealed record ConflictDto(Guid EmployeeId, string EmployeeName, string Type, DateTime StartUtc, DateTime EndUtc);

internal sealed record AvailabilityResult(List<ConflictDto> Conflicts, List<ConflictDto> Warnings);

/// <summary>Busy-time checks: meetings, leave and blocked time (mtg.usp_CheckAvailability) plus working hours (local rules, evaluated here).</summary>
internal static class AvailabilityCheck
{
    sealed record ConflictRow(long EmployeeId, string ConflictType, Guid? MeetingPublicId, DateTime ConflictStartUtc, DateTime ConflictEndUtc);
    sealed record EmpRow(long EmployeeId, Guid PublicId, string DisplayName, string TimeZoneId);
    sealed record HoursRow(long EmployeeId, int DayOfWeek, TimeSpan StartLocalTime, TimeSpan EndLocalTime);

    static SqlMapper.ICustomQueryParameter Tvp(IEnumerable<long> ids)
    {
        var t = new DataTable();
        t.Columns.Add("EmployeeId", typeof(long));
        foreach (var id in ids.Distinct()) t.Rows.Add(id);
        return t.AsTableValuedParameter("mtg.EmployeeIdList");
    }

    /// <summary>
    /// With <paramref name="lockCalendars"/> (booking path) the caller must be inside a SERIALIZABLE transaction:
    /// the employees' calendars are app-locked first so two concurrent bookings cannot both pass the check.
    /// </summary>
    public static async Task<AvailabilityResult> RunAsync(IDbConnection c, IDbTransaction? tx, IReadOnlyCollection<long> employeeIds,
        DateTime startUtc, DateTime endUtc, long? excludeMeetingId, bool lockCalendars)
    {
        if (employeeIds.Count == 0) return new([], []);
        if (lockCalendars)
            await c.ExecuteAsync("mtg.usp_LockEmployeesForBooking", new { EmployeeIds = Tvp(employeeIds) }, tx, commandType: CommandType.StoredProcedure);
        var rows = (await c.QueryAsync<ConflictRow>("mtg.usp_CheckAvailability",
            new { EmployeeIds = Tvp(employeeIds), StartUtc = startUtc, EndUtc = endUtc, ExcludeMeetingId = excludeMeetingId },
            tx, commandType: CommandType.StoredProcedure)).ToList();
        var ids = employeeIds.Distinct().ToArray();
        var emps = (await c.QueryAsync<EmpRow>("""
            SELECT e.EmployeeId, e.PublicId, e.DisplayName, COALESCE(u.TimeZoneId, b.TimeZoneId, 'Asia/Kolkata') AS TimeZoneId
            FROM org.Employees e LEFT JOIN auth.Users u ON u.EmployeeId = e.EmployeeId LEFT JOIN org.Branches b ON b.BranchId = e.BranchId
            WHERE e.EmployeeId IN @ids
            """, new { ids }, tx)).ToDictionary(e => e.EmployeeId);
        var hours = (await c.QueryAsync<HoursRow>("""
            SELECT EmployeeId, CAST([DayOfWeek] AS INT) AS [DayOfWeek], CAST(StartLocalTime AS TIME(0)) AS StartLocalTime, CAST(EndLocalTime AS TIME(0)) AS EndLocalTime
            FROM mtg.EmployeeAvailability WHERE [Type] = 'WORKING_HOURS' AND EmployeeId IN @ids
            """, new { ids }, tx)).ToLookup(h => h.EmployeeId);

        // Several overlapping meetings of the same employee collapse into one entry per (employee, type, period).
        var conflicts = rows.Where(r => emps.ContainsKey(r.EmployeeId))
            .Select(r => new ConflictDto(emps[r.EmployeeId].PublicId, emps[r.EmployeeId].DisplayName, r.ConflictType, Utc(r.ConflictStartUtc), Utc(r.ConflictEndUtc)))
            .Distinct().ToList();
        var warnings = new List<ConflictDto>();
        foreach (var id in ids)
        {
            if (!emps.TryGetValue(id, out var e) || !hours[id].Any()) continue; // no rules = no working-hours limit
            if (!WithinWorkingHours(hours[id].ToList(), startUtc, endUtc, Zones.Find(e.TimeZoneId)))
                warnings.Add(new ConflictDto(e.PublicId, e.DisplayName, "OUTSIDE_WORKING_HOURS", Utc(startUtc), Utc(endUtc)));
        }
        return new(conflicts, warnings);
    }

    static bool WithinWorkingHours(List<HoursRow> rules, DateTime startUtc, DateTime endUtc, TimeZoneInfo tz)
    {
        var ls = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(startUtc, DateTimeKind.Unspecified), tz);
        var le = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(endUtc, DateTimeKind.Unspecified), tz);
        if (le.Date != ls.Date) return false; // spans midnight (local)
        return rules.Any(r => r.DayOfWeek == (int)ls.DayOfWeek && r.StartLocalTime <= ls.TimeOfDay && r.EndLocalTime >= le.TimeOfDay);
    }

    static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);
}

internal static class Zones
{
    public static TimeZoneInfo Find(string? id)
    {
        if (!string.IsNullOrWhiteSpace(id) && TimeZoneInfo.TryFindSystemTimeZoneById(id, out var tz)) return tz;
        return TimeZoneInfo.TryFindSystemTimeZoneById("Asia/Kolkata", out var ist) ? ist : TimeZoneInfo.Utc;
    }

    public static bool IsValid(string id) => TimeZoneInfo.TryFindSystemTimeZoneById(id, out _);

    public static string Label(string id) => id is "Asia/Kolkata" or "Asia/Calcutta" or "India Standard Time" ? "IST" : id;

    /// <summary>"Mon, 02 Nov 2026, 10:00 AM – 11:00 AM IST" in the meeting's time zone.</summary>
    public static string FormatRange(DateTime startUtc, DateTime endUtc, string tzId)
    {
        var tz = Find(tzId);
        var s = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(startUtc, DateTimeKind.Unspecified), tz);
        var e = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(endUtc, DateTimeKind.Unspecified), tz);
        var ci = CultureInfo.InvariantCulture;
        var end = e.Date == s.Date ? e.ToString("hh:mm tt", ci) : e.ToString("ddd, dd MMM yyyy, hh:mm tt", ci);
        return $"{s.ToString("ddd, dd MMM yyyy, hh:mm tt", ci)} – {end} {Label(tzId)}";
    }

    public static string Duration(DateTime startUtc, DateTime endUtc)
    {
        var d = endUtc - startUtc;
        return d.TotalMinutes < 60 ? $"{(int)d.TotalMinutes} minutes"
            : d.Minutes == 0 ? $"{(int)d.TotalHours} hour{((int)d.TotalHours == 1 ? "" : "s")}" : $"{(int)d.TotalHours} h {d.Minutes} min";
    }
}

internal sealed record MeetingInfo(long MeetingId, Guid PublicId, string MeetingCode, string Title, string Category, string Status,
    DateTime StartUtc, DateTime EndUtc, string TimeZoneId, int ScheduleVersion, string HostName, string? CancelReason);

internal sealed record Recipient(long ParticipantId, string ParticipantType, long? EmployeeId, string Name, string? Email, long? UserId, string Role, string ResponseStatus);

public enum MessageKind { Invited, Rescheduled, Cancelled, Removed }

/// <summary>
/// Invitations, e-mails (only ever queued in app.EmailOutbox), in-app notifications and reminder rows for a meeting.
/// Every method runs inside the caller's transaction, so a booking and its messages commit or roll back together.
/// </summary>
public sealed class MeetingMessaging(IOptions<PublicEndpointOptions> pub, IOptions<MeetingOptions> meetingOptions, IOptions<ReminderOptions> reminderOptions,
    IOptions<EmailOptions> emailOptions, IClock clock)
{
    internal static Task<MeetingInfo> LoadAsync(IDbConnection c, IDbTransaction? tx, long meetingId) =>
        c.QuerySingleAsync<MeetingInfo>("""
            SELECT m.MeetingId, m.PublicId, m.MeetingCode, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc,
                   m.TimeZoneId, m.ScheduleVersion, h.DisplayName AS HostName, m.CancelReason
            FROM mtg.Meetings m JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId WHERE m.MeetingId = @meetingId
            """, new { meetingId }, tx);

    internal static async Task<List<Recipient>> RecipientsAsync(IDbConnection c, IDbTransaction? tx, long meetingId, IEnumerable<long>? onlyParticipantIds = null)
    {
        var only = onlyParticipantIds?.ToArray();
        return (await c.QueryAsync<Recipient>($"""
            SELECT p.ParticipantId, p.ParticipantType, p.EmployeeId, COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name,
                   COALESCE(e.OfficialEmail, cu.Email, p.GuestEmail) AS Email, u.UserId, p.[Role], p.ResponseStatus
            FROM mtg.MeetingParticipants p
            LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            LEFT JOIN auth.Users u ON u.EmployeeId = p.EmployeeId AND u.IsActive = 1
            WHERE p.MeetingId = @meetingId {(only is null ? "" : "AND p.ParticipantId IN @only")}
            ORDER BY p.ParticipantId
            """, new { meetingId, only }, tx)).ToList();
    }

    string BaseUrl => pub.Value.WebBaseUrl.TrimEnd('/');

    /// <summary>
    /// Invited/Rescheduled: (re-)issues customer and guest join links (old links revoked), e-mails everyone and notifies employees.
    /// Cancelled/Removed: revokes join links, e-mails and notifies. The acting user gets no message about their own action.
    /// </summary>
    internal async Task SendAsync(IDbConnection c, IDbTransaction tx, MeetingInfo m, IEnumerable<Recipient> recipients, MessageKind kind, long? actorUserId)
    {
        var now = clock.UtcNow;
        foreach (var r in recipients)
        {
            string? joinLink = null;
            if (r.ParticipantType != "EMPLOYEE")
            {
                await c.ExecuteAsync("""
                    UPDATE mtg.MeetingInvitations SET RevokedUtc = @now, RevokeReason = @reason WHERE ParticipantId = @p AND RevokedUtc IS NULL
                    """, new { now, p = r.ParticipantId, reason = kind == MessageKind.Rescheduled ? "Re-issued after reschedule" : kind == MessageKind.Removed ? "Participant removed" : kind == MessageKind.Cancelled ? "Meeting cancelled" : "Re-issued" }, tx);
                if (kind is MessageKind.Invited or MessageKind.Rescheduled && r.Email is not null)
                {
                    var token = Tokens.New();
                    await c.ExecuteAsync("""
                        INSERT mtg.MeetingInvitations (MeetingId, ParticipantId, TokenHash, CreatedUtc, ExpiresUtc) VALUES (@meetingId, @p, @hash, @now, @exp)
                        """, new { meetingId = m.MeetingId, p = r.ParticipantId, hash = Tokens.Hash(token), now, exp = m.EndUtc.AddDays(meetingOptions.Value.InvitationGraceDays) }, tx);
                    joinLink = $"{BaseUrl}/join/{token}";
                }
            }
            if (actorUserId is not null && r.UserId == actorUserId) continue;

            var (subject, heading, intro) = Texts(kind, m);
            if (r.Email is not null)
            {
                var link = r.ParticipantType == "EMPLOYEE" && kind is not MessageKind.Cancelled and not MessageKind.Removed ? $"{BaseUrl}/meetings/{m.PublicId}" : joinLink;
                var button = r.ParticipantType == "EMPLOYEE" ? "View meeting" : "Join meeting";
                await c.ExecuteAsync("""
                    INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml, RelatedMeetingId) VALUES (@template, @to, @subject, @body, @meetingId)
                    """, new
                {
                    template = "MEETING_" + kind.ToString().ToUpperInvariant(), to = r.Email, subject, meetingId = m.MeetingId,
                    body = EmailTemplates.Meeting(EmailBrand.From(emailOptions.Value), heading, m, r.Name, intro, link, button,
                        r.ParticipantType == "EMPLOYEE" ? null : "This link is personal to you. Please do not forward it."),
                }, tx);
            }
            if (r.UserId is not null)
                await NotifyAsync(c, tx, r.UserId.Value, m, kind switch
                {
                    MessageKind.Invited => "INVITATION",
                    MessageKind.Rescheduled => "RESCHEDULED",
                    _ => "CANCELLED",
                }, subject, intro);
        }
    }

    internal static Task NotifyAsync(IDbConnection c, IDbTransaction? tx, long userId, MeetingInfo m, string type, string title, string? body) =>
        c.ExecuteAsync("""
            INSERT mtg.MeetingNotifications (RecipientUserId, MeetingId, [Type], Title, Body, LinkPath) VALUES (@userId, @meetingId, @type, @title, @body, @link)
            """, new { userId, meetingId = m.MeetingId, type, title = Trim(title, 200), body = body is null ? null : Trim(body, 1000), link = $"/meetings/{m.PublicId}" }, tx);

    internal static (string Subject, string Heading, string Intro) Texts(MessageKind kind, MeetingInfo m) => kind switch
    {
        MessageKind.Invited => ($"Invitation: {m.Title}", "Meeting invitation", $"{m.HostName} has invited you to a meeting on {Zones.FormatRange(m.StartUtc, m.EndUtc, m.TimeZoneId)}."),
        MessageKind.Rescheduled => ($"Rescheduled: {m.Title}", "Meeting rescheduled", $"{m.HostName} has moved this meeting to {Zones.FormatRange(m.StartUtc, m.EndUtc, m.TimeZoneId)}. Earlier links no longer work."),
        MessageKind.Cancelled => ($"Cancelled: {m.Title}", "Meeting cancelled", $"{m.HostName} has cancelled this meeting." + (string.IsNullOrWhiteSpace(m.CancelReason) ? "" : $" Reason: {m.CancelReason}")),
        _ => ($"Removed from: {m.Title}", "Participation removed", $"You are no longer a participant in this meeting organised by {m.HostName}."),
    };

    static string Trim(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    /// <summary>
    /// One reminder per participant × offset × channel for the meeting's current schedule version (the unique dedupe key makes a
    /// second call a no-op). Offsets already in the past and declined participants are skipped.
    /// </summary>
    internal async Task<int> ScheduleRemindersAsync(IDbConnection c, IDbTransaction tx, MeetingInfo m, IEnumerable<Recipient> recipients)
    {
        var now = clock.UtcNow;
        var rows = new List<object>();
        foreach (var r in recipients.Where(r => r.ResponseStatus != "DECLINED"))
            foreach (var offset in reminderOptions.Value.EffectiveOffsets)
            {
                var due = DateTime.SpecifyKind(m.StartUtc, DateTimeKind.Utc).AddMinutes(-offset);
                if (due <= now) continue;
                if (r.UserId is not null) rows.Add(new { m.MeetingId, r.ParticipantId, offset, channel = "IN_APP", due, m.ScheduleVersion });
                if (r.Email is not null) rows.Add(new { m.MeetingId, r.ParticipantId, offset, channel = "EMAIL", due, m.ScheduleVersion });
            }
        if (rows.Count == 0) return 0;
        return await c.ExecuteAsync("""
            INSERT mtg.MeetingReminders (MeetingId, ParticipantId, OffsetMinutes, Channel, DueUtc, ScheduleVersion)
            SELECT @MeetingId, @ParticipantId, @offset, @channel, @due, @ScheduleVersion
            WHERE NOT EXISTS (SELECT 1 FROM mtg.MeetingReminders WHERE MeetingId = @MeetingId AND ParticipantId = @ParticipantId
                              AND OffsetMinutes = @offset AND Channel = @channel AND ScheduleVersion = @ScheduleVersion)
            """, rows, tx);
    }

    /// <summary>Cancels unsent reminders (all versions). A reminder the worker holds right now is cancelled too; its SENT update then matches nothing.</summary>
    internal static Task CancelRemindersAsync(IDbConnection c, IDbTransaction tx, long meetingId, long? participantId = null) =>
        c.ExecuteAsync("""
            UPDATE mtg.MeetingReminders SET [Status] = 'CANCELLED', LeaseOwner = NULL, LeaseExpiresUtc = NULL
            WHERE MeetingId = @meetingId AND (@participantId IS NULL OR ParticipantId = @participantId) AND [Status] IN ('PENDING', 'FAILED', 'CLAIMED')
            """, new { meetingId, participantId }, tx);

    internal static string NewMeetingCode(DateTime nowUtc)
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
        var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(nowUtc, DateTimeKind.Unspecified), Zones.Find("Asia/Kolkata"));
        Span<char> s = stackalloc char[4];
        for (var i = 0; i < 4; i++) s[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        return $"OIC-{local:yyMMdd}-{s}";
    }

    internal static string NewOpaqueId(string prefix, int bytes) => prefix + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(bytes));
}

/// <summary>Meeting e-mails (invitation, update, cancellation, reminder, recording) in the shared <see cref="EmailLayout"/>.</summary>
internal static class EmailTemplates
{
    public static string Meeting(EmailBrand brand, string heading, MeetingInfo m, string recipientName, string intro, string? link, string buttonText, string? note) =>
        EmailLayout.Render(brand, new EmailContent
        {
            Preheader = intro,
            Eyebrow = heading,
            Title = m.Title,
            RecipientName = recipientName,
            Paragraphs = [intro],
            Details =
            [
                ("When", Zones.FormatRange(m.StartUtc, m.EndUtc, m.TimeZoneId)),
                ("Duration", Zones.Duration(m.StartUtc, m.EndUtc)),
                ("Organiser", m.HostName),
                ("Meeting code", m.MeetingCode),
            ],
            ButtonUrl = link,
            ButtonText = buttonText,
            Note = note,
        });
}
