using System.Data;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Instant meetings and shareable meeting links (Advanced features, Phase B).
/// <list type="bullet">
/// <item>POST /meetings/instant — a meeting that starts now: no calendar check, no invitation e-mails; the host shares its link.</item>
/// <item>/meetings/{id}/link — the meeting's shareable link (copy, replace, withdraw). Hosts, co-hosts and the organiser only.</item>
/// <item>GET /meetings/by-code/{code} — "Join meeting" by code, for meetings the signed-in user may already see (no anonymous lookup).</item>
/// <item>Anonymous /m/{token} — the link page. Asking to join creates a participant (GUEST, or EMPLOYEE when signed in) that must be
/// admitted from the waiting room, and hands back a personal token: from there the existing /join/{token} flow is used unchanged.</item>
/// </list>
/// The link itself is a bearer secret (256 random bits); only its SHA-256 identifies it. A Data Protection-encrypted copy lets hosts copy
/// the same link again. Nobody joins through a link without a host's admission.
/// </summary>
public static class MeetingLinkEndpoints
{
    public sealed record InstantInput(string? Title, string? Category, int? DurationMinutes, bool? AudioOnly, bool? WaitingRoomEnabled, string? RecordingPolicy,
        Guid? CustomerId = null, string? PrarambhMainId = null, MeetingEndpoints.GuestInput[]? Participants = null, bool? SkipPlvcDetails = null);
    public sealed record LinkRequestInput(string? DisplayName);

    const string Purpose = "OneInsure.Connect.MeetingLink.v1";
    static readonly string[] InstantRecording = ["NONE", "OPTIONAL", "REQUIRED"];

    /// <summary>Who may see, share, replace or withdraw a meeting's link: its host, organiser, or anyone hosting/co-hosting it.</summary>
    internal static bool CanManageLink(long hostEmployeeId, long createdByEmployeeId, string? myRole, Actor me) =>
        me.EmployeeId is { } e && (e == hostEmployeeId || e == createdByEmployeeId || myRole is "HOST" or "COHOST");

    public static RouteGroupBuilder MapMeetingLinkEndpoints(this RouteGroupBuilder api)
    {
        api.MapPost("/meetings/instant", Instant).RequirePermission("meetings.create");
        api.MapGet("/meetings/by-code/{code}", ByCode).RequireAnyPermission("meetings.view.own", "meetings.view.all");

        var g = api.MapGroup("/meetings/{id:guid}/link").RequireAnyPermission("meetings.view.own", "meetings.view.all");
        g.MapGet("", (Guid id, LinkServices s, HttpContext ctx) => Manage(id, s, ctx, regenerate: false, revoke: false));
        g.MapPost("/regenerate", (Guid id, LinkServices s, HttpContext ctx) => Manage(id, s, ctx, regenerate: true, revoke: false));
        g.MapPost("/revoke", (Guid id, LinkServices s, HttpContext ctx) => Manage(id, s, ctx, regenerate: false, revoke: true));
        g.MapPost("/customer", CustomerLink);
        api.MapPost("/meetings/{id:guid}/prarambh", Plvc.SetPrarambhAsync).RequireAnyPermission("meetings.view.own", "meetings.view.all");
        var inv = api.MapGroup("/meetings/{id:guid}/invitation-emails").RequireAnyPermission("meetings.view.own", "meetings.view.all");
        inv.MapGet("", InvitationStatus);
        inv.MapPost("/resend", ResendInvitation);

        // Malformed link codes (wrong length or characters) never reach a handler (Tokens.LinkTokenRoute); they get the same
        // "invalid link" answer as an unknown code, without a database lookup. Lowest route precedence: real routes win.
        api.Map("/m/{**rest}", () => Problems.Create(404, "NOT_FOUND", "This meeting link is invalid."));
        api.Map("/join/{**rest}", () => Problems.Create(404, "NOT_FOUND", "This invitation link is invalid, has expired or was withdrawn."));
        api.MapGet("/m/" + Tokens.LinkTokenRoute, LinkInfo).RequireRateLimiting(NotificationEndpoints.JoinRateLimit);
        api.MapPost("/m/" + Tokens.LinkTokenRoute + "/request", LinkRequest).RequireRateLimiting(NotificationEndpoints.JoinRateLimit);
        return api;
    }

    public sealed class LinkServices(Db db, IClock clock, IDataProtectionProvider dp, IOptions<MeetingOptions> meetings, IOptions<LiveKitOptions> liveKit,
        IOptions<PublicEndpointOptions> pub, IOptions<EmailOptions> email)
    {
        public Db Db => db;
        public EmailBrand Brand => EmailBrand.From(email.Value);
        public IClock Clock => clock;
        public IDataProtector Protector { get; } = dp.CreateProtector(Purpose);
        public MeetingOptions Meetings => meetings.Value;
        public LiveKitOptions LiveKit => liveKit.Value;
        public string Url(string token) => $"{pub.Value.WebBaseUrl.TrimEnd('/')}/m/{token}";
        /// <summary>A participant's personal join link (the existing /join/{token} flow).</summary>
        public string JoinUrl(string token) => $"{pub.Value.WebBaseUrl.TrimEnd('/')}/join/{token}";
        /// <summary>A link works until joining closes (scheduled end + JoinLateMinutes).</summary>
        public DateTime Expiry(DateTime endUtc) => DateTime.SpecifyKind(endUtc, DateTimeKind.Utc).AddMinutes(Meetings.JoinLateMinutes);
    }

    internal sealed record LinkRow(long LinkId, string TokenProtected, DateTime CreatedUtc, DateTime ExpiresUtc, int UseCount, DateTime? LastUsedUtc);

    /// <summary>
    /// The active link for one meeting, or for a whole recurring series (exactly one of the two is given), created
    /// (or extended after a reschedule / new occurrence) when needed. A series link resolves to the relevant
    /// occurrence only when it is opened (<see cref="FindLinkAsync"/>) - this just keeps one token alive.
    /// </summary>
    internal static async Task<(string Token, LinkRow Row)> EnsureLinkAsync(IDbConnection c, IDbTransaction? tx, LinkServices s, long? meetingId, long? seriesId, DateTime endUtc, long userId)
    {
        var now = s.Clock.UtcNow;
        var expires = s.Expiry(endUtc);
        var row = await c.QuerySingleOrDefaultAsync<LinkRow>("""
            SELECT LinkId, TokenProtected, CreatedUtc, ExpiresUtc, UseCount, LastUsedUtc FROM mtg.MeetingLinks
            WHERE RevokedUtc IS NULL AND ((@meetingId IS NOT NULL AND MeetingId = @meetingId) OR (@seriesId IS NOT NULL AND SeriesId = @seriesId))
            """, new { meetingId, seriesId }, tx);
        if (row is not null)
        {
            if (row.ExpiresUtc < expires && expires > row.CreatedUtc)
            {
                await c.ExecuteAsync("UPDATE mtg.MeetingLinks SET ExpiresUtc = @expires WHERE LinkId = @id", new { expires, id = row.LinkId }, tx);
                row = row with { ExpiresUtc = expires };
            }
            return (s.Protector.Unprotect(row.TokenProtected), row);
        }
        var token = Tokens.NewLinkToken();
        var protectedToken = s.Protector.Protect(token);
        var exp = expires > now ? expires : now.AddMinutes(1); // a link made after joining closed works for nothing anyway
        var id = await c.QuerySingleAsync<long>("""
            INSERT mtg.MeetingLinks (MeetingId, SeriesId, TokenHash, TokenProtected, CreatedUtc, CreatedByUserId, ExpiresUtc)
            OUTPUT inserted.LinkId VALUES (@meetingId, @seriesId, @hash, @protectedToken, @now, @userId, @exp)
            """, new { meetingId, seriesId, hash = Tokens.Hash(token), protectedToken, now, userId, exp }, tx);
        return (token, new LinkRow(id, protectedToken, now, exp, 0, null));
    }

    internal static object LinkDto(LinkServices s, string token, LinkRow r) => new
    {
        url = s.Url(token), path = $"/m/{token}", createdUtc = r.CreatedUtc, expiresUtc = r.ExpiresUtc, useCount = r.UseCount, lastUsedUtc = r.LastUsedUtc,
    };

    // ---- Instant meeting -------------------------------------------------------------------------------------------

    static async Task<IResult> Instant(InstantInput? input, LinkServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = input ?? new InstantInput(null, null, null, null, null, null);
        using var c = await s.Db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        if (me.EmployeeId is null)
            return Problems.Create(400, "VALIDATION", "Your user account is not linked to an employee record, so you cannot start meetings. Ask an administrator to link it.");
        // 17 Nov 2026: the portal's instant meeting needs a title (every user, every type, also "Skip details"). The external
        // API keeps its documented default title ("<host name>'s meeting") so calling portals are not broken.
        var (error, r) = await CreateInstantAsync(c, s, i, me, ClientInfo.From(ctx).Ip, null, sendInvitations: true, requireTitle: true);
        if (error is not null) return error;
        return Results.Json(new
        {
            id = r!.PublicId, meetingCode = r.MeetingCode, status = "SCHEDULED", kind = "INSTANT", link = r.Link, prarambhMainId = r.PrarambhMainId,
            plvcIdentification = Plvc.Identification(r.Category, r.PrarambhMainId),
            invitationEmails = r.Participants.Count(p => !string.IsNullOrWhiteSpace(p.Email)),
            customer = r.Customer is { } x ? new { name = x.Name, email = x.Email, mobile = x.Mobile, joinUrl = x.JoinUrl } : null,
            participants = r.Participants.Select(p => new { name = p.Name, email = p.Email, type = p.Type, joinUrl = p.JoinUrl }),
        }, statusCode: 201);
    }

    internal sealed record InstantPerson(string Name, string? Email, string? Mobile, string Type, string JoinUrl);
    internal sealed record InstantResult(long MeetingId, Guid PublicId, string MeetingCode, string Title, string Category, DateTime StartUtc, DateTime EndUtc,
        string? PrarambhMainId, object Link, string LinkUrl, InstantPerson? Customer, List<InstantPerson> Participants);

    /// <summary>
    /// Creates an instant meeting hosted by <paramref name="me"/> (the signed-in employee, or - for the external API - the
    /// integration's mapped host). Customer meetings: the customer is either an existing crm.Customers row (CustomerId) or, when
    /// <c>Participants</c> are given, the FIRST participant (an existing customer with that e-mail is reused, otherwise one is
    /// created) - so dashboards, reports and recording access keep working. Every other participant becomes a GUEST. Each
    /// customer/guest gets a personal join link (instant meetings send no e-mail; the host or the calling portal shares it).
    /// </summary>
    internal static async Task<(IResult? Error, InstantResult? Result)> CreateInstantAsync(IDbConnection c, LinkServices s, InstantInput i, Actor me, string? ip,
        long? integrationId, string? externalReference = null, bool sendInvitations = false, bool requireTitle = false)
    {
        var o = s.Meetings;
        var now = s.Clock.UtcNow;

        var v = new Validator();
        var title = (requireTitle ? v.Required("title", i.Title, 200, "Title") : v.Optional("title", i.Title, 200, "Title")) ?? Shorten($"{me.EmployeeName ?? "Instant"}'s meeting", 200);
        var category = MeetingEndpoints.Upper(i.Category) ?? "GROUP";
        var isCustomer = MeetingEndpoints.IsCustomerCategory(category);
        if (!MeetingEndpoints.Categories.Contains(category)) v.Add("category", "Unknown meeting category.");
        // "Skip details & start meeting" (V024): an UNIDENTIFIED Customer - PLVC meeting - no Prarambh Main ID (never invented), no
        // customer, no participants and therefore no e-mails; people join through the meeting link and the waiting room. Whatever was
        // typed in the PLVC block is deliberately not used (the host chose to skip it). Recorded as normal under the PLVC policy.
        var skip = i.SkipPlvcDetails == true;
        if (skip && category != "CUSTOMER_PLVC") v.Add("skipPlvcDetails", "Skipping details is only possible for a Customer – PLVC meeting.");
        var prarambh = skip ? null : Plvc.ValidatePrarambh(v, i.PrarambhMainId, category);
        var people = skip ? [] : Plvc.ValidateParticipants(v, i.Participants);
        (long CustomerId, string? PolicyNumber, string Name, string? Email, string? Mobile)? customer = null;
        Plvc.Person? newCustomer = null;
        if (isCustomer)
        {
            if (!me.Customers) return (Problems.Create(403, "FORBIDDEN", "You do not have permission to start customer meetings."), null);
            if (skip) { /* unidentified PLVC: no customer */ }
            else if (i.CustomerId is { } cid)
            {
                customer = await c.QuerySingleOrDefaultAsync<(long, string?, string, string?, string?)?>(
                    "SELECT CustomerId, PolicyNumber, FullName, Email, Mobile FROM crm.Customers WHERE PublicId = @id AND IsActive = 1", new { id = cid });
                if (customer is null) v.Add("customerId", "The selected customer was not found or is inactive.");
            }
            else if (people.Count > 0) { newCustomer = people[0]; people = people.Skip(1).ToList(); }
            else v.Add(category == "CUSTOMER_PLVC" ? "participants" : "customerId",
                category == "CUSTOMER_PLVC" ? "Add at least one participant (name and e-mail)." : "Select the customer for a customer meeting.");
        }
        else if (i.CustomerId is not null) v.Add("customerId", "Only customer meetings (PLVC, general) can include a customer.");
        var minutes = i.DurationMinutes ?? o.InstantDefaultMinutes;
        if (minutes < 5 || minutes > o.MaxDurationHours * 60) v.Add("durationMinutes", $"Choose a length between 5 minutes and {o.MaxDurationHours} hours.");
        var recording = MeetingEndpoints.Upper(i.RecordingPolicy) ?? "NONE";
        if (!InstantRecording.Contains(recording)) v.Add("recordingPolicy", "Recording policy must be NONE, OPTIONAL or REQUIRED.");
        if (!v.IsValid) return (v.Problem(), null);

        var dept = await c.ExecuteScalarAsync<long>("SELECT DepartmentId FROM org.Employees WHERE EmployeeId = @e", new { e = me.EmployeeId });
        var end = now.AddMinutes(minutes);
        using var tx = c.BeginTransaction();
        if (newCustomer is not null)
        {
            var created = await Plvc.EnsureCustomerAsync(c, tx, newCustomer, prarambh, me.EmployeeId, me.UserId, ip);
            customer = (created.CustomerId, created.PolicyNumber, created.Name, created.Email, created.Mobile);
        }
        long meetingId = 0;
        Guid publicId = default;
        string code = "";
        for (var attempt = 0; meetingId == 0; attempt++)
        {
            code = MeetingMessaging.NewMeetingCode(now);
            try
            {
                (meetingId, publicId) = await c.QuerySingleAsync<(long, Guid)>("""
                    INSERT mtg.Meetings (MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, DepartmentId, CustomerId, PolicyNumber, ScheduledStartUtc, ScheduledEndUtc,
                        TimeZoneId, [Status], RecordingPolicy, WaitingRoomEnabled, LiveKitRoomName, MeetingKind, IsAudioOnly, CreatedByUserId, PrarambhMainId, IntegrationId, ExternalReference)
                    OUTPUT inserted.MeetingId, inserted.PublicId
                    VALUES (@code, @title, @category, @emp, @emp, @dept, @customerId, @policyNumber, @now, @end, @tz, 'SCHEDULED', @recording, @waiting, @room, 'INSTANT', @audioOnly, @user,
                        @prarambh, @integrationId, @externalReference)
                    """, new
                {
                    code, title, category, emp = me.EmployeeId, dept, customerId = customer?.CustomerId, policyNumber = customer?.PolicyNumber, now, end, tz = o.DefaultTimeZone, recording, waiting = i.WaitingRoomEnabled ?? true,
                    room = MeetingMessaging.NewOpaqueId("oic_", 16), audioOnly = i.AudioOnly == true, user = me.UserId, prarambh, integrationId, externalReference,
                }, tx);
            }
            catch (SqlException e) when (e.IsUniqueViolation() && e.Message.Contains("MeetingCode") && attempt < 5) { }
        }
        await c.ExecuteAsync("""
            INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, [Role], ResponseStatus, LiveKitIdentity, CanScreenShare, CreatedByUserId)
            VALUES (@meetingId, 'EMPLOYEE', @emp, 'HOST', 'ACCEPTED', @identity, 1, @user)
            """, new { meetingId, emp = me.EmployeeId, identity = MeetingMessaging.NewOpaqueId("p_", 12), user = me.UserId }, tx);

        // Customer and guests: a participant row each with a personal join link (no e-mail for instant meetings).
        async Task<string> PersonalLinkAsync(long? customerId, string? guestName, string? guestEmail)
        {
            var participantId = await c.QuerySingleAsync<long>("""
                INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, CustomerId, GuestName, GuestEmail, [Role], ResponseStatus, LiveKitIdentity, CanScreenShare, CreatedByUserId)
                OUTPUT inserted.ParticipantId
                VALUES (@meetingId, @type, @customerId, @guestName, @guestEmail, 'ATTENDEE', 'PENDING', @identity, 1, @user)
                """, new { meetingId, type = customerId is null ? "GUEST" : "CUSTOMER", customerId, guestName, guestEmail, identity = MeetingMessaging.NewOpaqueId("p_", 12), user = me.UserId }, tx);
            var personal = Tokens.NewLinkToken();
            await c.ExecuteAsync("""
                INSERT mtg.MeetingInvitations (MeetingId, ParticipantId, TokenHash, CreatedUtc, ExpiresUtc) VALUES (@meetingId, @participantId, @hash, @now, @exp)
                """, new { meetingId, participantId, hash = Tokens.Hash(personal), now, exp = s.Expiry(end) }, tx);
            return s.JoinUrl(personal);
        }
        InstantPerson? customerOut = null;
        var participants = new List<InstantPerson>();
        if (customer is { } cu)
        {
            customerOut = new InstantPerson(cu.Name, cu.Email, cu.Mobile, "CUSTOMER", await PersonalLinkAsync(cu.CustomerId, null, null));
            participants.Add(customerOut);
        }
        foreach (var p in people)
            participants.Add(new InstantPerson(p.Name, p.Email, null, "GUEST", await PersonalLinkAsync(null, p.Name, p.Email)));

        // Invitation e-mails (13 Nov 2026): each participant with an e-mail address gets their OWN personal link - never anyone
        // else's - queued in app.EmailOutbox in this same transaction (the existing outbox worker sends, retries and logs each
        // attempt in app.EmailDeliveryLog). One meeting = one e-mail per person: a failed send is retried by the worker and can be
        // re-sent by the host, never by creating the meeting again. Nobody in the request = no e-mail (e.g. a link-only meeting).
        // Portal only: the external API keeps its documented behaviour (the calling portal shares the returned links itself).
        var invited = 0;
        if (sendInvitations && participants.Any(p => !string.IsNullOrWhiteSpace(p.Email)))
        {
            var info = await MeetingMessaging.LoadAsync(c, tx, meetingId);
            foreach (var p in participants.Where(p => !string.IsNullOrWhiteSpace(p.Email)))
            {
                await QueueInstantInvitationAsync(c, tx, s, info, p.Name, p.Email!, p.JoinUrl);
                invited++;
            }
        }

        var (token, link) = await EnsureLinkAsync(c, tx, s, meetingId, null, end, me.UserId);
        await Audit.WriteAsync(c, integrationId is null ? "USER" : "INTEGRATION", me.UserId, "MEETING_INSTANT_STARTED", "Meeting", publicId.ToString(),
            $"Instant meeting {code} created{(integrationId is null ? "" : " through the external API")}", ip, tx,
            newValues: new { meetingCode = code, title, category, customer = customer?.Name, guests = people.Count, prarambhMainId = prarambh, integrationId, startUtc = now, endUtc = end,
                recordingPolicy = recording, audioOnly = i.AudioOnly == true, waitingRoom = i.WaitingRoomEnabled ?? true, invitationEmailsQueued = invited,
                plvcIdentification = Plvc.Identification(category, prarambh), plvcDetailsSkipped = skip });
        tx.Commit();
        return (null, new InstantResult(meetingId, publicId, code, title, category, now, end, prarambh, LinkDto(s, token, link), s.Url(token), customerOut, participants));
    }

    const string InstantInviteTemplate = "MEETING_INSTANT_INVITED";

    static Task QueueInstantInvitationAsync(IDbConnection c, IDbTransaction tx, LinkServices s, MeetingInfo m, string name, string email, string joinUrl) =>
        c.ExecuteAsync("""
            INSERT app.EmailOutbox (Template, ToAddress, Subject, BodyHtml, RelatedMeetingId) VALUES (@template, @to, @subject, @body, @meetingId)
            """, new
        {
            template = InstantInviteTemplate, to = email, subject = $"Join now: {m.Title}", meetingId = m.MeetingId,
            body = EmailTemplates.Meeting(s.Brand, "Meeting invitation", m, name,
                $"{m.HostName} has started a meeting and invited you to join now ({Zones.FormatRange(m.StartUtc, m.EndUtc, m.TimeZoneId)}).",
                joinUrl, "Join meeting", "This link is personal to you. Please do not forward it."),
        }, tx);

    /// <summary>Delivery state of an instant meeting's invitation e-mails, per address (newest message per address), for the host.</summary>
    static async Task<IResult> InvitationStatus(Guid id, LinkServices s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (m, error) = await ManagedMeetingAsync(c, id, ctx);
        if (m is null) return error!;
        var rows = await c.QueryAsync<(string To, string Status, int Attempts, DateTime CreatedUtc, DateTime? SentUtc)>("""
            SELECT o.ToAddress, o.[Status], o.Attempts, o.CreatedUtc, o.SentUtc FROM app.EmailOutbox o
            WHERE o.RelatedMeetingId = @m AND o.Template = @t
              AND o.OutboxId = (SELECT MAX(x.OutboxId) FROM app.EmailOutbox x WHERE x.RelatedMeetingId = @m AND x.Template = @t AND x.ToAddress = o.ToAddress)
            ORDER BY o.OutboxId
            """, new { m = m.Value.MeetingId, t = InstantInviteTemplate });
        return Results.Ok(new
        {
            items = rows.Select(r => new
            {
                email = r.To, status = r.Status is "CLAIMED" ? "SENDING" : r.Status, attempts = r.Attempts, queuedUtc = r.CreatedUtc, sentUtc = r.SentUtc,
                // Never the raw transport error (it can contain server details) - just that it failed.
                error = r.Status == "FAILED" ? "The e-mail could not be delivered." : null,
            }),
        });
    }

    public sealed record ResendInput(string? Email);

    /// <summary>
    /// Host: e-mail a participant's invitation again (after a failure). Issues a fresh personal link for that one participant (the
    /// old one stops working, so a mis-sent link cannot be used) - never creates a meeting or touches anyone else's link.
    /// </summary>
    static async Task<IResult> ResendInvitation(Guid id, ResendInput input, LinkServices s, HttpContext ctx, CancellationToken ct)
    {
        using var c = await s.Db.OpenAsync(ct);
        var (m, error) = await ManagedMeetingAsync(c, id, ctx);
        if (m is null) return error!;
        if (m.Value.Status is not ("SCHEDULED" or "LIVE")) return Problems.Create(409, "CONFLICT", "This meeting is no longer in progress.");
        var email = input.Email?.Trim();
        if (string.IsNullOrEmpty(email)) return Problems.Create(400, "VALIDATION_FAILED", "Choose the participant to e-mail.");
        var p = await c.QuerySingleOrDefaultAsync<(long ParticipantId, string Name)?>("""
            SELECT TOP (1) p.ParticipantId, COALESCE(cu.FullName, p.GuestName) FROM mtg.MeetingParticipants p LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE p.MeetingId = @m AND p.ParticipantType IN ('CUSTOMER', 'GUEST') AND p.IsBlocked = 0 AND COALESCE(cu.Email, p.GuestEmail) = @email
            """, new { m = m.Value.MeetingId, email });
        if (p is null) return Problems.Create(404, "NOT_FOUND", "That e-mail address is not a participant of this meeting.");
        var me = await Actor.LoadAsync(c, ctx.User);
        var now = s.Clock.UtcNow;
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("UPDATE mtg.MeetingInvitations SET RevokedUtc = @now, RevokeReason = 'Re-issued (invitation e-mailed again)' WHERE ParticipantId = @p AND RevokedUtc IS NULL",
            new { now, p = p.Value.ParticipantId }, tx);
        var info = await MeetingMessaging.LoadAsync(c, tx, m.Value.MeetingId);
        var personal = Tokens.NewLinkToken();
        await c.ExecuteAsync("INSERT mtg.MeetingInvitations (MeetingId, ParticipantId, TokenHash, CreatedUtc, ExpiresUtc) VALUES (@meetingId, @participantId, @hash, @now, @exp)",
            new { meetingId = m.Value.MeetingId, participantId = p.Value.ParticipantId, hash = Tokens.Hash(personal), now, exp = s.Expiry(info.EndUtc) }, tx);
        await QueueInstantInvitationAsync(c, tx, s, info, p.Value.Name, email, s.JoinUrl(personal));
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_INVITATION_RESENT", "Meeting", id.ToString(), "Host e-mailed a participant's invitation again (new personal link)",
            ClientInfo.From(ctx).Ip, tx, newValues: new { participantEmail = email });
        tx.Commit();
        return Results.Ok(new { email, status = "PENDING", joinUrl = s.JoinUrl(personal) });
    }

    /// <summary>The meeting, if the caller may manage its link/invitations (host, organiser, co-host).</summary>
    static async Task<((long MeetingId, string Status)? Meeting, IResult? Error)> ManagedMeetingAsync(IDbConnection c, Guid id, HttpContext ctx)
    {
        var me = await Actor.LoadAsync(c, ctx.User);
        var row = await c.QuerySingleOrDefaultAsync<(long MeetingId, string Status, long HostEmployeeId, long CreatedByEmployeeId, string? MyRole)?>("""
            SELECT m.MeetingId, m.[Status], m.HostEmployeeId, m.CreatedByEmployeeId,
                   (SELECT TOP (1) p.[Role] FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = @emp) AS MyRole
            FROM mtg.Meetings m WHERE m.PublicId = @id
            """, new { id, emp = me.EmployeeId });
        if (row is null || !CanManageLink(row.Value.HostEmployeeId, row.Value.CreatedByEmployeeId, row.Value.MyRole, me))
            return (null, Problems.Create(404, "NOT_FOUND", "Meeting not found."));
        return ((row.Value.MeetingId, row.Value.Status), null);
    }

    static string Shorten(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    // ---- Join by code (signed in) ----------------------------------------------------------------------------------

    static async Task<IResult> ByCode(string code, Db db, HttpContext ctx, CancellationToken ct)
    {
        var normalized = (code ?? "").Trim().ToUpperInvariant();
        if (normalized.Length is < 6 or > 20) return Db_.NotFound("Meeting");
        if (!normalized.StartsWith("OIC-", StringComparison.Ordinal)) normalized = "OIC-" + normalized;
        using var c = await db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var id = await c.QuerySingleOrDefaultAsync<Guid?>($"""
            SELECT m.PublicId FROM mtg.Meetings m WHERE m.MeetingCode = @normalized AND {MeetingEndpoints.Visible}
            """, new { normalized, emp = me.EmployeeId, all = me.ViewAll });
        // Same answer for "does not exist" and "not yours": codes cannot be probed.
        return id is null
            ? Problems.Create(404, "NOT_FOUND", "No meeting with this code was found among your meetings. If you were sent a link, open the link instead.")
            : Results.Ok(new { id });
    }

    // ---- The customer's personal link (GoodDay #14195) -----------------------------------------------------------------

    sealed record CustomerRow(long MeetingId, long HostEmployeeId, long CreatedByEmployeeId, string Status, DateTime EndUtc, string? MyRole,
        long ParticipantId, string Name, string? Email, string? Mobile);

    /// <summary>
    /// Host / co-host / organiser of a customer meeting: a fresh personal join link for the customer (the one in the invitation
    /// e-mail keeps working - only token hashes are stored, so it cannot be shown again), so the host can send it straight to
    /// the customer by WhatsApp, e-mail or any other way. Same credential as the e-mailed link: /join/{token}.
    /// </summary>
    static async Task<IResult> CustomerLink(Guid id, LinkServices s, HttpContext ctx)
    {
        var ct = ctx.RequestAborted;
        using var c = await s.Db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await c.QuerySingleOrDefaultAsync<CustomerRow>($"""
            SELECT TOP (1) m.MeetingId, m.HostEmployeeId, m.CreatedByEmployeeId, m.[Status], m.ScheduledEndUtc AS EndUtc,
                   (SELECT p2.[Role] FROM mtg.MeetingParticipants p2 WHERE p2.MeetingId = m.MeetingId AND p2.EmployeeId = @emp AND p2.IsBlocked = 0) AS MyRole,
                   p.ParticipantId, cu.FullName AS Name, cu.Email, cu.Mobile
            FROM mtg.Meetings m
            JOIN mtg.MeetingParticipants p ON p.MeetingId = m.MeetingId AND p.ParticipantType = 'CUSTOMER' AND p.IsBlocked = 0
            JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}
            ORDER BY p.ParticipantId
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (m is null) return Problems.Create(404, "NOT_FOUND", "This meeting has no customer.");
        if (!CanManageLink(m.HostEmployeeId, m.CreatedByEmployeeId, m.MyRole, me))
            return Problems.Create(403, "FORBIDDEN", "Only the host, a co-host or the organiser can send the customer's link.");
        if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("This meeting is not scheduled or in progress.");

        var token = Tokens.NewLinkToken();
        var now = s.Clock.UtcNow;
        using var tx = c.BeginTransaction();
        await c.ExecuteAsync("""
            INSERT mtg.MeetingInvitations (MeetingId, ParticipantId, TokenHash, CreatedUtc, ExpiresUtc) VALUES (@meetingId, @participantId, @hash, @now, @exp)
            """, new { meetingId = m.MeetingId, participantId = m.ParticipantId, hash = Tokens.Hash(token), now, exp = s.Expiry(m.EndUtc) }, tx);
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_CUSTOMER_LINK_ISSUED", "Meeting", id.ToString(), "Personal join link issued for the customer, to send directly",
            ClientInfo.From(ctx).Ip, tx);
        tx.Commit();
        return Results.Ok(new { name = m.Name, email = m.Email, mobile = m.Mobile, joinUrl = s.JoinUrl(token) });
    }

    // ---- Manage the link (hosts / organiser) --------------------------------------------------------------------------

    sealed record ManagedMeeting(long MeetingId, long? SeriesId, long HostEmployeeId, long CreatedByEmployeeId, string Status, DateTime EndUtc, string? MyRole);

    static async Task<IResult> Manage(Guid id, LinkServices s, HttpContext ctx, bool regenerate, bool revoke)
    {
        var ct = ctx.RequestAborted;
        using var c = await s.Db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await c.QuerySingleOrDefaultAsync<ManagedMeeting>($"""
            SELECT m.MeetingId, m.SeriesId, m.HostEmployeeId, m.CreatedByEmployeeId, m.[Status], m.ScheduledEndUtc AS EndUtc,
                   (SELECT p.[Role] FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = @emp AND p.IsBlocked = 0) AS MyRole
            FROM mtg.Meetings m WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (m is null) return Db_.NotFound("Meeting");
        if (!CanManageLink(m.HostEmployeeId, m.CreatedByEmployeeId, m.MyRole, me))
            return Problems.Create(403, "FORBIDDEN", "Only the host, a co-host or the organiser can share this meeting's link.");

        // Part of a series: one link for the whole series, so what matters is whether the series still has anything
        // left to join, not just the one occurrence this request happened to be made from.
        long? meetingKey = m.MeetingId, seriesKey = null;
        var endUtc = m.EndUtc;
        if (m.SeriesId is { } sid)
        {
            var active = await c.QuerySingleOrDefaultAsync<DateTime?>(
                "SELECT MAX(ScheduledEndUtc) FROM mtg.Meetings WHERE SeriesId = @sid AND [Status] IN ('SCHEDULED', 'LIVE')", new { sid });
            if (active is null) return Db_.Conflict("This recurring meeting has no scheduled occurrences left, so it has no link to share.");
            (meetingKey, seriesKey, endUtc) = (null, sid, active.Value);
        }
        else if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("This meeting is not scheduled or in progress, so it has no link to share.");

        var now = s.Clock.UtcNow;
        var ip = ClientInfo.From(ctx).Ip;
        using var tx = c.BeginTransaction();
        if (regenerate || revoke)
        {
            var n = await c.ExecuteAsync("""
                UPDATE mtg.MeetingLinks SET RevokedUtc = @now, RevokedByUserId = @user
                WHERE RevokedUtc IS NULL AND ((@meetingKey IS NOT NULL AND MeetingId = @meetingKey) OR (@seriesKey IS NOT NULL AND SeriesId = @seriesKey))
                """, new { now, user = me.UserId, meetingKey, seriesKey }, tx);
            await Audit.WriteAsync(c, "USER", me.UserId, regenerate ? "MEETING_LINK_REGENERATED" : "MEETING_LINK_REVOKED", "Meeting", id.ToString(),
                regenerate ? "Meeting link replaced (the old link stops working)" : "Meeting link withdrawn", ip, tx, newValues: new { revoked = n });
            if (revoke)
            {
                tx.Commit();
                return Results.NoContent();
            }
        }
        var (token, row) = await EnsureLinkAsync(c, tx, s, meetingKey, seriesKey, endUtc, me.UserId);
        tx.Commit();
        return Results.Ok(LinkDto(s, token, row));
    }

    // ---- Anonymous link page ----------------------------------------------------------------------------------------

    sealed record PublicLink(long LinkId, long MeetingId, Guid PublicId, string Title, string Organiser, DateTime StartUtc, DateTime EndUtc, string TimeZoneId, string Status,
        string MeetingCode, bool IsLocked, bool IsAudioOnly, string MeetingKind);

    /// <summary>
    /// A plain link resolves to its one meeting, unchanged. A series link resolves, each time it is opened, to
    /// whichever occurrence is relevant right now: the one currently live, else the earliest upcoming one that has
    /// not ended yet - so the same link keeps working as the recurring meeting moves from day to day. If the series
    /// has nothing left (every occurrence done, cancelled or expired), it resolves to nothing and the link reads as
    /// expired, same as a one-off meeting whose link outlived it.
    /// </summary>
    static async Task<PublicLink?> FindLinkAsync(IDbConnection c, string token, DateTime now)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return null;
        return await c.QuerySingleOrDefaultAsync<PublicLink>("""
            SELECT l.LinkId, rm.MeetingId, rm.PublicId, rm.Title, h.DisplayName AS Organiser, rm.ScheduledStartUtc AS StartUtc, rm.ScheduledEndUtc AS EndUtc,
                   rm.TimeZoneId, rm.[Status], rm.MeetingCode, rm.IsLocked, rm.IsAudioOnly, rm.MeetingKind
            FROM mtg.MeetingLinks l
            CROSS APPLY (
                SELECT TOP (1) m.MeetingId, m.PublicId, m.Title, m.HostEmployeeId, m.ScheduledStartUtc, m.ScheduledEndUtc, m.TimeZoneId, m.[Status],
                       m.MeetingCode, m.IsLocked, m.IsAudioOnly, m.MeetingKind
                FROM mtg.Meetings m
                WHERE (l.MeetingId IS NOT NULL AND m.MeetingId = l.MeetingId)
                   OR (l.SeriesId IS NOT NULL AND m.SeriesId = l.SeriesId AND m.[Status] IN ('SCHEDULED', 'LIVE') AND m.ScheduledEndUtc > @now)
                ORDER BY CASE WHEN m.[Status] = 'LIVE' THEN 0 ELSE 1 END, m.ScheduledStartUtc ASC
            ) rm
            JOIN org.Employees h ON h.EmployeeId = rm.HostEmployeeId
            WHERE l.TokenHash = @hash AND l.RevokedUtc IS NULL AND l.ExpiresUtc > @now
            """, new { hash = Tokens.Hash(token), now });
    }

    static async Task<IResult> DeadLink(IDbConnection c, string token)
    {
        var old = string.IsNullOrEmpty(token) || token.Length > 200 ? null : await c.QuerySingleOrDefaultAsync<(DateTime? RevokedUtc, DateTime ExpiresUtc)?>(
            "SELECT RevokedUtc, ExpiresUtc FROM mtg.MeetingLinks WHERE TokenHash = @hash", new { hash = Tokens.Hash(token) });
        var detail = old is null ? "This meeting link is invalid."
            : old.Value.RevokedUtc is not null ? "The organiser withdrew or replaced this meeting link. Ask them for the current link."
            : "This meeting link has expired.";
        return Problems.Create(404, "NOT_FOUND", detail);
    }

    /// <summary>Signed-in employee (with meeting access) opening a link: their participant row in that meeting, if any.</summary>
    static async Task<(Actor? Me, Mine? Participant)> SignedInAsync(IDbConnection c, HttpContext ctx, long meetingId)
    {
        if (ctx.User.Identity?.IsAuthenticated != true || !(ctx.User.Can("meetings.view.own") || ctx.User.Can("meetings.view.all"))) return (null, null);
        var me = await Actor.LoadAsync(c, ctx.User);
        if (me.EmployeeId is null) return (null, null);
        var p = await c.QuerySingleOrDefaultAsync<Mine>("""
            SELECT p.ParticipantId, p.IsBlocked,
                   CAST(CASE WHEN p.AdmissionRequired = 1 AND NOT EXISTS (SELECT 1 FROM mtg.WaitingRoomEntries w WHERE w.ParticipantId = p.ParticipantId AND w.[Status] = 'ADMITTED')
                        THEN 1 ELSE 0 END AS BIT) AS NeedsAdmission
            FROM mtg.MeetingParticipants p WHERE p.MeetingId = @meetingId AND p.EmployeeId = @e
            """, new { meetingId, e = me.EmployeeId });
        return (me, p);
    }

    sealed record Mine(long ParticipantId, bool IsBlocked, bool NeedsAdmission);

    /// <summary>
    /// GET /m/{token} — only what a person needs to decide to join (title, organiser, time). Nothing about the other participants.
    /// A signed-in participant is sent to their normal meeting room instead.
    /// </summary>
    static async Task<IResult> LinkInfo(string token, LinkServices s, HttpContext ctx, CancellationToken ct)
    {
        var now = s.Clock.UtcNow;
        using var c = await s.Db.OpenAsync(ct);
        var l = await FindLinkAsync(c, token, now);
        if (l is null) return await DeadLink(c, token);
        var (me, mine) = await SignedInAsync(c, ctx, l.MeetingId);
        var w = JoinWindow.Evaluate(l.Status, l.StartUtc, l.EndUtc, now, s.Meetings);
        return Results.Ok(new
        {
            title = l.Title, organiser = l.Organiser, startUtc = l.StartUtc, endUtc = l.EndUtc, timeZoneId = l.TimeZoneId,
            status = l.Status switch { "SCHEDULED" or "LIVE" or "CANCELLED" => l.Status, "DRAFT" => "SCHEDULED", _ => "ENDED" },
            meetingCode = l.MeetingCode, waitingRoom = true, joinableNow = w.Joinable, joinOpensUtc = w.OpensUtc, joinClosesUtc = w.ClosesUtc,
            videoAvailable = s.LiveKit.IsConfigured, locked = l.IsLocked, audioOnly = l.IsAudioOnly, kind = l.MeetingKind,
            participantType = me is null ? "GUEST" : "EMPLOYEE", displayName = me?.EmployeeName,
            // Already invited (and not removed): the normal room page, no waiting room.
            meetingId = mine is { IsBlocked: false, NeedsAdmission: false } ? l.PublicId : (Guid?)null,
        });
    }

    /// <summary>
    /// POST /m/{token}/request — creates the asking person's participant row (admission always required) and a personal token
    /// for the existing waiting-room flow (/join/{token}/enter, polling, chat, recording notice).
    /// </summary>
    static async Task<IResult> LinkRequest(string token, LinkRequestInput? input, LinkServices s, HttpContext ctx, CancellationToken ct)
    {
        if (!s.LiveKit.IsConfigured) return RoomEndpoints.Unavailable();
        var now = s.Clock.UtcNow;
        using var c = await s.Db.OpenAsync(ct);
        var l = await FindLinkAsync(c, token, now);
        if (l is null) return await DeadLink(c, token);
        var w = JoinWindow.Evaluate(l.Status, l.StartUtc, l.EndUtc, now, s.Meetings);
        if (!w.Joinable)
            return Problems.Create(409, "CONFLICT", w.Message!, new Dictionary<string, object?> { ["reason"] = w.Reason, ["opensUtc"] = w.OpensUtc, ["closesUtc"] = w.ClosesUtc });
        if (l.IsLocked) return Problems.Create(403, "FORBIDDEN", "The host has locked this meeting. Nobody new can ask to join.", new Dictionary<string, object?> { ["reason"] = "LOCKED" });

        var (me, mine) = await SignedInAsync(c, ctx, l.MeetingId);
        if (mine is { IsBlocked: true }) return Problems.Create(403, "FORBIDDEN", "A host removed you from this meeting.");
        if (mine is { NeedsAdmission: false }) return Results.Ok(new { meetingId = l.PublicId });

        string? guestName = null;
        if (me is null)
        {
            guestName = RoomEndpoints.CleanName(input?.DisplayName);
            var v = new Validator();
            if (guestName is null) v.Add("displayName", "Enter your name.");
            else if (guestName.Length > 80) v.Add("displayName", "Your name can be at most 80 characters.");
            if (!v.IsValid) return v.Problem();
        }

        using var tx = c.BeginTransaction();
        // Serialised per meeting (UPDLOCK on the link row), so the cap holds under concurrent requests.
        await c.ExecuteAsync("UPDATE mtg.MeetingLinks SET UseCount = UseCount + 1, LastUsedUtc = @now WHERE LinkId = @id", new { now, id = l.LinkId }, tx);
        var joiners = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM mtg.MeetingParticipants WHERE MeetingId = @m AND JoinSource = 'LINK'", new { m = l.MeetingId }, tx);
        if (mine is null && joiners >= s.Meetings.MaxLinkJoiners)
        {
            tx.Rollback();
            return Db_.Conflict("This meeting has reached the number of people who can join through its link. Contact the organiser.");
        }
        // A colleague who asked before and is still waiting for admission gets a fresh personal token (the earlier one is replaced).
        var participantId = mine?.ParticipantId ?? await c.QuerySingleAsync<long>("""
            INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, GuestName, [Role], ResponseStatus, IsRequired, LiveKitIdentity, CanScreenShare,
                JoinSource, AdmissionRequired, CreatedByUserId)
            OUTPUT inserted.ParticipantId
            VALUES (@m, @type, @emp, @guestName, 'ATTENDEE', 'ACCEPTED', 0, @identity, @screen, 'LINK', 1, @user)
            """, new
        {
            m = l.MeetingId, type = me is null ? "GUEST" : "EMPLOYEE", emp = me?.EmployeeId, guestName, identity = MeetingMessaging.NewOpaqueId("p_", 12),
            screen = me is not null, user = me?.UserId,
        }, tx);
        if (mine is not null)
            await c.ExecuteAsync("UPDATE mtg.MeetingInvitations SET RevokedUtc = @now, RevokeReason = 'Replaced (asked to join again)' WHERE ParticipantId = @p AND RevokedUtc IS NULL",
                new { now, p = mine.ParticipantId }, tx);
        var personal = Tokens.NewLinkToken();
        var exp = s.Expiry(l.EndUtc);
        await c.ExecuteAsync("""
            INSERT mtg.MeetingInvitations (MeetingId, ParticipantId, TokenHash, CreatedUtc, ExpiresUtc) VALUES (@m, @p, @hash, @now, @exp)
            """, new { m = l.MeetingId, p = participantId, hash = Tokens.Hash(personal), now, exp = exp > now ? exp : now.AddMinutes(1) }, tx);
        await Audit.WriteAsync(c, me is null ? "CUSTOMER" : "USER", me?.UserId, "MEETING_LINK_USED", "Meeting", l.PublicId.ToString(),
            me is null ? "A guest asked to join through the meeting link" : "A colleague asked to join through the meeting link", ClientInfo.From(ctx).Ip, tx,
            newValues: new { participantType = me is null ? "GUEST" : "EMPLOYEE" });
        tx.Commit();
        return Results.Ok(new { joinToken = personal, participantType = me is null ? "GUEST" : "EMPLOYEE", displayName = guestName ?? me!.EmployeeName });
    }
}
