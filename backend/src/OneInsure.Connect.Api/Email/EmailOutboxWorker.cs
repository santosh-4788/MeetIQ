using System.Data;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Email;

/// <summary>
/// E-mail delivery through OneInsure's existing mail procedure (Util_SendEmail2), the same call the business already
/// uses, e.g. <c>EXEC Util_SendEmail2 @to, @subject, @body, @from, @replyto, @custref, @Displayname, @templateid, @userid, @PurposeId, @TranId</c>.
/// The application only writes to app.EmailOutbox; this worker claims rows (lease, READPAST) and hands them to the procedure.
/// Delivery is at-least-once: a crash between the procedure call and the SENT update can resend one e-mail.
/// </summary>
public sealed partial class EmailOptions
{
    /// <summary>Off by default: nothing is sent until explicitly enabled.</summary>
    public bool Enabled { get; set; }
    /// <summary>Three-part name allowed, e.g. "[MailDb].dbo.Util_SendEmail2". Validated against injection.</summary>
    public string Procedure { get; set; } = "dbo.Util_SendEmail2";
    /// <summary>Connection string name for the procedure; defaults to the application's own database connection.</summary>
    public string ConnectionStringName { get; set; } = "OneInsure";
    public string From { get; set; } = "support@oneinsure.com";
    public string ReplyTo { get; set; } = "support@oneinsure.com";
    public string? DisplayName { get; set; } = "OneInsure Connect";
    public int? TemplateId { get; set; }
    public int? PurposeId { get; set; }
    /// <summary>Absolute URL of the OneInsure logo shown in every e-mail header (mail clients cannot load relative or local images).</summary>
    public string LogoUrl { get; set; } = EmailBrand.DefaultLogoUrl;
    /// <summary>Support address shown in the e-mail footer ("Need help? Contact …"); empty = no support line.</summary>
    public string? SupportEmail { get; set; }
    /// <summary>Development safety net: when set, EVERY e-mail goes to this address instead (the original recipient is noted in the subject).</summary>
    public string? RedirectAllTo { get; set; }
    /// <summary>Development only: explicitly allow sending to real recipients without RedirectAllTo.</summary>
    public bool AllowRealRecipientsInDevelopment { get; set; }
    public int PollSeconds { get; set; } = 15;
    public int BatchSize { get; set; } = 20;
    public int MaxAttempts { get; set; } = 5;

    public bool ProcedureNameIsSafe() => ProcedureRe().IsMatch(Procedure);

    [GeneratedRegex(@"^(\[?[A-Za-z_][A-Za-z0-9_]{0,127}\]?\.){0,2}\[?[A-Za-z_][A-Za-z0-9_]{0,127}\]?$")]
    private static partial Regex ProcedureRe();
}

public sealed record OutboxMessage(long OutboxId, string Template, string ToAddress, string Subject, string BodyHtml, int Attempts);

public interface IEmailSender
{
    Task SendAsync(OutboxMessage message, CancellationToken ct);
}

/// <summary>Calls the configured mail procedure with the parameters of Util_SendEmail2.</summary>
public sealed class SqlProcedureEmailSender(IOptions<EmailOptions> options, IConfiguration config) : IEmailSender
{
    public async Task SendAsync(OutboxMessage m, CancellationToken ct)
    {
        var o = options.Value;
        if (!o.ProcedureNameIsSafe()) throw new InvalidOperationException("Email:Procedure is not a valid procedure name.");
        var cs = config.GetConnectionString(o.ConnectionStringName) ?? throw new InvalidOperationException($"Connection string {o.ConnectionStringName} is not configured.");
        var redirect = string.IsNullOrWhiteSpace(o.RedirectAllTo) ? null : o.RedirectAllTo.Trim();
        await using var c = new SqlConnection(cs);
        await c.OpenAsync(ct);
        await c.ExecuteAsync(new CommandDefinition(o.Procedure, new
        {
            to = new DbString { Value = redirect ?? m.ToAddress, IsAnsi = true, Length = 200 },
            subject = new DbString { Value = Truncate(redirect is null ? m.Subject : $"[to {m.ToAddress}] {m.Subject}", 500), IsAnsi = true, Length = 500 },
            body = new DbString { Value = m.BodyHtml, IsAnsi = false, Length = -1 }, // @body is NVARCHAR(MAX) in Util_SendEmail2
            from = new DbString { Value = o.From, IsAnsi = true, Length = 200 },
            replyto = new DbString { Value = o.ReplyTo, IsAnsi = true, Length = 200 },
            custref = (string?)null,
            Displayname = o.DisplayName,
            templateid = o.TemplateId,
            userid = (int?)null,
            PurposeId = o.PurposeId,
            TranId = (int?)null,
        }, commandType: CommandType.StoredProcedure, commandTimeout: 30, cancellationToken: ct));
    }

    static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}

public sealed class EmailOutboxWorker(Db db, IEmailSender sender, IOptions<EmailOptions> options, IHostEnvironment env, ILogger<EmailOutboxWorker> log) : BackgroundService
{
    readonly string owner = $"{Environment.MachineName}:{Environment.ProcessId}";

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var o = options.Value;
        if (!o.Enabled)
        {
            log.LogInformation("E-mail sending is disabled (Email:Enabled=false). Messages stay queued in app.EmailOutbox.");
            return;
        }
        if (env.IsDevelopment() && string.IsNullOrWhiteSpace(o.RedirectAllTo) && !o.AllowRealRecipientsInDevelopment)
        {
            log.LogWarning("E-mail sending not started: in Development set Email:RedirectAllTo (or Email:AllowRealRecipientsInDevelopment=true) so test mail cannot reach real people.");
            return;
        }
        if (!o.ProcedureNameIsSafe())
        {
            log.LogError("E-mail sending not started: Email:Procedure '{Procedure}' is not a valid procedure name.", o.Procedure);
            return;
        }
        log.LogInformation("E-mail worker started: procedure {Procedure}{Redirect}.", o.Procedure,
            string.IsNullOrWhiteSpace(o.RedirectAllTo) ? "" : " (all mail redirected to the configured test address)");
        while (!stop.IsCancellationRequested)
        {
            try { await RunOnceAsync(stop); }
            catch (Exception e) when (e is not OperationCanceledException) { log.LogError(e, "E-mail worker cycle failed."); }
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(5, o.PollSeconds)), stop); } catch (OperationCanceledException) { }
        }
    }

    /// <summary>One poll: claim due messages, send each, record the outcome. Returns the number processed.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        var o = options.Value;
        List<OutboxMessage> batch;
        using (var c = await db.OpenAsync(ct))
            batch = (await c.QueryAsync<OutboxMessage>("app.usp_ClaimOutbox",
                new { Owner = owner, Batch = o.BatchSize, LeaseSeconds = 120, MaxAttempts = o.MaxAttempts }, commandType: CommandType.StoredProcedure)).ToList();

        foreach (var m in batch)
        {
            var started = DateTime.UtcNow;
            string? error = null;
            try { await sender.SendAsync(m, ct); }
            catch (Exception e) when (e is not OperationCanceledException) { error = e.Message.Length > 900 ? e.Message[..900] : e.Message; }
            var ms = (int)(DateTime.UtcNow - started).TotalMilliseconds;

            using var c = await db.OpenAsync(ct);
            if (error is null)
                await c.ExecuteAsync("""
                    UPDATE app.EmailOutbox SET [Status] = 'SENT', SentUtc = SYSUTCDATETIME(), LeaseOwner = NULL, LeaseExpiresUtc = NULL WHERE OutboxId = @id;
                    INSERT app.EmailDeliveryLog (OutboxId, AttemptNo, Succeeded, SmtpResponse, DurationMs) VALUES (@id, @attempt, 1, N'Handed to mail procedure', @ms);
                    """, new { id = m.OutboxId, attempt = m.Attempts, ms });
            else
            {
                // Exponential back-off: 1, 2, 4, 8 … minutes; after MaxAttempts the row stays FAILED for the operators.
                await c.ExecuteAsync("""
                    UPDATE app.EmailOutbox SET [Status] = 'FAILED', NextAttemptUtc = DATEADD(MINUTE, POWER(2, @attempt - 1), SYSUTCDATETIME()),
                        LeaseOwner = NULL, LeaseExpiresUtc = NULL WHERE OutboxId = @id;
                    INSERT app.EmailDeliveryLog (OutboxId, AttemptNo, Succeeded, ErrorMessage, DurationMs) VALUES (@id, @attempt, 0, @error, @ms);
                    """, new { id = m.OutboxId, attempt = Math.Min(m.Attempts, 10), error, ms });
                log.LogWarning("E-mail {OutboxId} attempt {Attempt} failed: {Error}", m.OutboxId, m.Attempts, error);
            }
        }
        return batch.Count;
    }
}
