using System.Text.RegularExpressions;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Meetings;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Renders one sample of every e-mail type through the shared layout (no database, nothing is queued or sent).
/// Set OIC_EMAIL_PREVIEW_DIR to also write the samples as .html files for a visual check (tests/email-previews).
/// </summary>
public sealed class EmailLayoutTests
{
    static readonly MeetingInfo Sample = new(1, Guid.Parse("6f1c2a52-3b7e-4b0e-9a55-1f2d3c4b5a69"), "OIC-261102-K7QM", "Quarterly policy review <Q4>",
        "CUSTOMER", "SCHEDULED", new DateTime(2026, 11, 2, 4, 30, 0, DateTimeKind.Utc), new DateTime(2026, 11, 2, 5, 30, 0, DateTimeKind.Utc),
        "Asia/Kolkata", 1, "Anita Sharma", "Client asked to move it & will confirm a new date");

    const string Base = "https://connect.oneinsure.com";
    const string JoinToken = "Zx9_Qw-3kLmN0pR7sTuVwXyZ12345abcdeFGHIJklm";

    static IEnumerable<(string File, string Html)> Samples(EmailBrand brand)
    {
        var m = Sample;
        string Meeting(MessageKind kind, string name, string? link, string button, string? note)
        {
            var (_, heading, intro) = MeetingMessaging.Texts(kind, m);
            return EmailTemplates.Meeting(brand, heading, m, name, intro, link, button, note);
        }
        const string personal = "This link is personal to you. Please do not forward it.";
        yield return ("01-invitation-customer.html", Meeting(MessageKind.Invited, "Ravi Kumar", $"{Base}/join/{JoinToken}", "Join meeting", personal));
        yield return ("02-invitation-employee.html", Meeting(MessageKind.Invited, "Vijay Vishwakarma", $"{Base}/meetings/{m.PublicId}", "View meeting", null));
        yield return ("03-rescheduled-customer.html", Meeting(MessageKind.Rescheduled, "Ravi Kumar", $"{Base}/join/{JoinToken}", "Join meeting", personal));
        yield return ("04-cancelled.html", Meeting(MessageKind.Cancelled, "Ravi Kumar", null, "Join meeting", null));
        yield return ("05-removed.html", Meeting(MessageKind.Removed, "Gita Guest", null, "Join meeting", null));
        yield return ("06-reminder-employee.html", EmailTemplates.Meeting(brand, "Meeting reminder", m, "Vijay Vishwakarma", "This meeting starts in 1 hour.",
            $"{Base}/meetings/{m.PublicId}", "View meeting", null));
        yield return ("07-reminder-customer.html", EmailTemplates.Meeting(brand, "Meeting reminder", m, "Ravi Kumar", "This meeting starts in 15 minutes.",
            null, "View meeting", "Use the personal join link from your invitation e-mail to join."));
        const string recNote = "Recordings are available only to authorised users after signing in. Do not forward this e-mail.";
        yield return ("08-recording-available.html", EmailTemplates.Meeting(brand, "Recording available", m, "Anita Sharma",
            "The recording was verified (codecs, duration, full decode, checksum) and is in the Recording Library.",
            $"{Base}/recordings/0d6b8f0e-2f4c-4b8a-9d7e-5a3c1b2e4f60", "Open the recording", recNote));
        yield return ("09-recording-failed.html", EmailTemplates.Meeting(brand, "Recording failed", m, "Anita Sharma",
            "The recording could not be completed. The recorder stopped unexpectedly.",
            $"{Base}/recordings/0d6b8f0e-2f4c-4b8a-9d7e-5a3c1b2e4f60", "View details", recNote));
        yield return ("10-password-reset.html", AccountEmails.PasswordReset(brand, "Vijay Vishwakarma", $"{Base}/reset-password?token={Uri.EscapeDataString(JoinToken)}", 30));
        yield return ("11-sign-in-code.html", AccountEmails.SignInCode(brand, "Vijay Vishwakarma", "482913", 10));
    }

    [Fact]
    public void Every_email_uses_the_shared_layout_encodes_values_and_keeps_its_links_parseable()
    {
        var dir = Environment.GetEnvironmentVariable("OIC_EMAIL_PREVIEW_DIR");
        var brand = new EmailBrand(string.IsNullOrWhiteSpace(dir) ? EmailBrand.DefaultLogoUrl : "../../frontend/public/brand/oneinsure-logo.png", "it.support@oneinsure.com");
        var samples = Samples(brand).ToList();
        Assert.Equal(11, samples.Count);
        foreach (var (file, html) in samples)
        {
            Assert.Contains("alt=\"OneInsure\"", html);
            Assert.Contains("Please do not reply.", html);
            Assert.Contains("it.support@oneinsure.com", html);
            Assert.DoesNotContain("<Q4>", html); // dynamic values are HTML-encoded
            Assert.DoesNotContain("<style", html);
            if (file.Contains("customer") && !file.Contains("reminder"))
                Assert.Equal(JoinToken, Regex.Match(html, @"/join/([A-Za-z0-9_\-]+)").Groups[1].Value);
        }
        Assert.Contains("&lt;Q4&gt;", samples[0].Html);
        Assert.Contains("Client asked to move it &amp; will confirm a new date", samples[3].Html);
        Assert.Equal(JoinToken, Uri.UnescapeDataString(Regex.Match(samples[9].Html, "token=([^\"&]+)").Groups[1].Value));
        Assert.Equal("482913", Regex.Match(samples[10].Html, @"<b[^>]*>(\d{6})</b>").Groups[1].Value);

        if (string.IsNullOrWhiteSpace(dir)) return;
        Directory.CreateDirectory(dir);
        foreach (var (file, html) in samples)
            File.WriteAllText(Path.Combine(dir, file),
                $"<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{file}</title></head><body style=\"margin:0;padding:0\">{html}</body></html>");
    }
}
