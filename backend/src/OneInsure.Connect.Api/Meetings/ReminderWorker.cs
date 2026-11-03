using System.Data;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Delivers due meeting reminders. Claims rows with mtg.usp_ClaimDueReminders (lease + READPAST, so several instances can run;
/// cancelled meetings and stale schedule versions are never claimed). Each reminder is delivered in one transaction together with
/// its SENT update: an in-app notification row, or an app.EmailOutbox row whose unique RelatedReminderId makes a duplicate e-mail impossible.
/// </summary>
public sealed class ReminderWorker(Db db, IOptions<ReminderOptions> options, IOptions<PublicEndpointOptions> pub, IOptions<EmailOptions> emailOptions,
    ILogger<ReminderWorker> log) : BackgroundService
{
    readonly string owner = $"{Environment.MachineName}:{Environment.ProcessId}:reminders";

    sealed record Claimed(long ReminderId, long MeetingId, long ParticipantId, int OffsetMinutes, string Channel, DateTime DueUtc, int ScheduleVersion, int Attempts);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var o = options.Value;
        if (!o.Enabled)
        {
            log.LogInformation("Meeting reminders are disabled (Reminders:Enabled=false).");
            return;
        }
        log.LogInformation("Reminder worker started (poll every {Seconds} s, offsets {Offsets} min).", o.PollSeconds, string.Join(", ", o.EffectiveOffsets));
        while (!stop.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(5, o.PollSeconds)), stop); } catch (OperationCanceledException) { return; }
            try { await RunOnceAsync(stop); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "Reminder worker cycle failed."); }
        }
    }

    /// <summary>One poll: claim due reminders and deliver each. Returns the number of reminders claimed.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        var o = options.Value;
        List<Claimed> batch;
        using (var c = await db.OpenAsync(ct))
            batch = (await c.QueryAsync<Claimed>("mtg.usp_ClaimDueReminders",
                new { Owner = owner, Batch = o.BatchSize, LeaseSeconds = o.LeaseSeconds, MaxAttempts = o.MaxAttempts }, commandType: CommandType.StoredProcedure)).ToList();

        foreach (var r in batch)
        {
            try { await DeliverAsync(r, ct); }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                var error = e.Message.Length > 900 ? e.Message[..900] : e.Message;
                // Exponential back-off: 1, 2, 4, 8 … minutes; after MaxAttempts the claim procedure leaves the row alone (FAILED).
                using var c = await db.OpenAsync(ct);
                await c.ExecuteAsync("""
                    UPDATE mtg.MeetingReminders SET [Status] = 'FAILED', LastError = @error, NextAttemptUtc = DATEADD(MINUTE, POWER(2, @attempt - 1), SYSUTCDATETIME()),
                        LeaseOwner = NULL, LeaseExpiresUtc = NULL
                    WHERE ReminderId = @id AND [Status] = 'CLAIMED' AND LeaseOwner = @owner
                    """, new { id = r.ReminderId, attempt = Math.Min(r.Attempts, 10), error, owner });
                log.LogWarning("Reminder {ReminderId} attempt {Attempt} failed: {Error}", r.ReminderId, r.Attempts, error);
            }
        }
        return batch.Count;
    }

    async Task DeliverAsync(Claimed r, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        using var tx = c.BeginTransaction();
        var m = await MeetingMessaging.LoadAsync(c, tx, r.MeetingId);
        var p = (await MeetingMessaging.RecipientsAsync(c, tx, r.MeetingId, [r.ParticipantId])).SingleOrDefault();

        string? skip = m.Status is not ("SCHEDULED" or "LIVE") ? "Meeting is no longer scheduled."
            : m.ScheduleVersion != r.ScheduleVersion ? "Meeting was rescheduled."
            : p is null ? "Participant removed."
            : p.ResponseStatus == "DECLINED" ? "Participant declined."
            : r.Channel == "IN_APP" && p.UserId is null ? "Recipient has no active user account."
            : r.Channel == "EMAIL" && p.Email is null ? "Recipient has no e-mail address."
            : r.Channel is not ("IN_APP" or "EMAIL") ? "Channel not supported." : null;
        if (skip is null)
        {
            var when = Zones.FormatRange(m.StartUtc, m.EndUtc, m.TimeZoneId);
            var title = $"Reminder: {m.Title}";
            var body = $"Starts {Lead(r.OffsetMinutes)}: {when}.";
            if (r.Channel == "IN_APP")
                await MeetingMessaging.NotifyAsync(c, tx, p!.UserId!.Value, m, "REMINDER", title, body);
            else
            {
                var employee = p!.ParticipantType == "EMPLOYEE";
                var baseUrl = pub.Value.WebBaseUrl.TrimEnd('/');
                await c.ExecuteAsync("""
                    INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml, RelatedMeetingId, RelatedReminderId)
                    SELECT 'MEETING_REMINDER', @to, @subject, @body, @meetingId, @reminderId
                    WHERE NOT EXISTS (SELECT 1 FROM app.EmailOutbox WHERE RelatedReminderId = @reminderId)
                    """, new
                {
                    to = p.Email, subject = title, meetingId = m.MeetingId, reminderId = r.ReminderId,
                    // The raw join token exists only in the invitation e-mail (only its hash is stored), so customers are pointed back to it.
                    body = EmailTemplates.Meeting(EmailBrand.From(emailOptions.Value), "Meeting reminder", m, p.Name, $"This meeting starts {Lead(r.OffsetMinutes)}.",
                        employee ? $"{baseUrl}/meetings/{m.PublicId}" : null, "View meeting",
                        employee ? null : "Use the personal join link from your invitation e-mail to join."),
                }, tx);
            }
        }
        var n = await c.ExecuteAsync($"""
            UPDATE mtg.MeetingReminders SET [Status] = {(skip is null ? "'SENT', SentUtc = SYSUTCDATETIME()" : "'CANCELLED'")}, LastError = @skip,
                LeaseOwner = NULL, LeaseExpiresUtc = NULL
            WHERE ReminderId = @id AND [Status] = 'CLAIMED' AND LeaseOwner = @owner
            """, new { id = r.ReminderId, owner, skip }, tx);
        if (n == 0) { tx.Rollback(); return; } // cancelled or re-claimed meanwhile: deliver nothing
        tx.Commit();
    }

    static string Lead(int minutes) => minutes switch
    {
        0 => "now",
        < 60 => $"in {minutes} minutes",
        60 => "in 1 hour",
        < 1440 when minutes % 60 == 0 => $"in {minutes / 60} hours",
        1440 => "in 24 hours",
        _ => $"in {minutes / 60} h {minutes % 60} min",
    };
}
