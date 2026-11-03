using System.Data;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
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
    public sealed record InstantInput(string? Title, string? Category, int? DurationMinutes, bool? AudioOnly, bool? WaitingRoomEnabled, string? RecordingPolicy);
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

        api.MapGet("/m/{token}", LinkInfo).RequireRateLimiting(NotificationEndpoints.JoinRateLimit);
        api.MapPost("/m/{token}/request", LinkRequest).RequireRateLimiting(NotificationEndpoints.JoinRateLimit);
        return api;
    }

    public sealed class LinkServices(Db db, IClock clock, IDataProtectionProvider dp, IOptions<MeetingOptions> meetings, IOptions<LiveKitOptions> liveKit,
        IOptions<PublicEndpointOptions> pub)
    {
        public Db Db => db;
        public IClock Clock => clock;
        public IDataProtector Protector { get; } = dp.CreateProtector(Purpose);
        public MeetingOptions Meetings => meetings.Value;
        public LiveKitOptions LiveKit => liveKit.Value;
        public string Url(string token) => $"{pub.Value.WebBaseUrl.TrimEnd('/')}/m/{token}";
        /// <summary>A link works until joining closes (scheduled end + JoinLateMinutes).</summary>
        public DateTime Expiry(DateTime endUtc) => DateTime.SpecifyKind(endUtc, DateTimeKind.Utc).AddMinutes(Meetings.JoinLateMinutes);
    }

    sealed record LinkRow(long LinkId, string TokenProtected, DateTime CreatedUtc, DateTime ExpiresUtc, int UseCount, DateTime? LastUsedUtc);

    /// <summary>The meeting's active link, created (or extended after a reschedule) when needed.</summary>
    static async Task<(string Token, LinkRow Row)> EnsureLinkAsync(IDbConnection c, IDbTransaction? tx, LinkServices s, long meetingId, DateTime endUtc, long userId)
    {
        var now = s.Clock.UtcNow;
        var expires = s.Expiry(endUtc);
        var row = await c.QuerySingleOrDefaultAsync<LinkRow>("""
            SELECT LinkId, TokenProtected, CreatedUtc, ExpiresUtc, UseCount, LastUsedUtc FROM mtg.MeetingLinks WHERE MeetingId = @meetingId AND RevokedUtc IS NULL
            """, new { meetingId }, tx);
        if (row is not null)
        {
            if (row.ExpiresUtc < expires && expires > row.CreatedUtc)
            {
                await c.ExecuteAsync("UPDATE mtg.MeetingLinks SET ExpiresUtc = @expires WHERE LinkId = @id", new { expires, id = row.LinkId }, tx);
                row = row with { ExpiresUtc = expires };
            }
            return (s.Protector.Unprotect(row.TokenProtected), row);
        }
        var token = Tokens.New();
        var protectedToken = s.Protector.Protect(token);
        var exp = expires > now ? expires : now.AddMinutes(1); // a link made after joining closed works for nothing anyway
        var id = await c.QuerySingleAsync<long>("""
            INSERT mtg.MeetingLinks (MeetingId, TokenHash, TokenProtected, CreatedUtc, CreatedByUserId, ExpiresUtc)
            OUTPUT inserted.LinkId VALUES (@meetingId, @hash, @protectedToken, @now, @userId, @exp)
            """, new { meetingId, hash = Tokens.Hash(token), protectedToken, now, userId, exp }, tx);
        return (token, new LinkRow(id, protectedToken, now, exp, 0, null));
    }

    static object LinkDto(LinkServices s, string token, LinkRow r) => new
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
        var o = s.Meetings;
        var now = s.Clock.UtcNow;

        var v = new Validator();
        var title = v.Optional("title", i.Title, 200, "Title") ?? Shorten($"{me.EmployeeName ?? "Instant"}'s meeting", 200);
        var category = MeetingEndpoints.Upper(i.Category) ?? "GROUP";
        if (!MeetingEndpoints.Categories.Contains(category)) v.Add("category", "Unknown meeting category.");
        else if (MeetingEndpoints.IsCustomerCategory(category))
            v.Add("category", "Customer meetings need a customer and are scheduled: use Schedule meeting.");
        var minutes = i.DurationMinutes ?? o.InstantDefaultMinutes;
        if (minutes < 5 || minutes > o.MaxDurationHours * 60) v.Add("durationMinutes", $"Choose a length between 5 minutes and {o.MaxDurationHours} hours.");
        var recording = MeetingEndpoints.Upper(i.RecordingPolicy) ?? "NONE";
        if (!InstantRecording.Contains(recording)) v.Add("recordingPolicy", "Recording policy must be NONE, OPTIONAL or REQUIRED.");
        if (!v.IsValid) return v.Problem();

        var dept = await c.ExecuteScalarAsync<long>("SELECT DepartmentId FROM org.Employees WHERE EmployeeId = @e", new { e = me.EmployeeId });
        var end = now.AddMinutes(minutes);
        using var tx = c.BeginTransaction();
        long meetingId = 0;
        Guid publicId = default;
        string code = "";
        for (var attempt = 0; meetingId == 0; attempt++)
        {
            code = MeetingMessaging.NewMeetingCode(now);
            try
            {
                (meetingId, publicId) = await c.QuerySingleAsync<(long, Guid)>("""
                    INSERT mtg.Meetings (MeetingCode, Title, Category, CreatedByEmployeeId, HostEmployeeId, DepartmentId, ScheduledStartUtc, ScheduledEndUtc, TimeZoneId,
                        [Status], RecordingPolicy, WaitingRoomEnabled, LiveKitRoomName, MeetingKind, IsAudioOnly, CreatedByUserId)
                    OUTPUT inserted.MeetingId, inserted.PublicId
                    VALUES (@code, @title, @category, @emp, @emp, @dept, @now, @end, @tz, 'SCHEDULED', @recording, @waiting, @room, 'INSTANT', @audioOnly, @user)
                    """, new
                {
                    code, title, category, emp = me.EmployeeId, dept, now, end, tz = o.DefaultTimeZone, recording, waiting = i.WaitingRoomEnabled ?? true,
                    room = MeetingMessaging.NewOpaqueId("oic_", 16), audioOnly = i.AudioOnly == true, user = me.UserId,
                }, tx);
            }
            catch (SqlException e) when (e.IsUniqueViolation() && e.Message.Contains("MeetingCode") && attempt < 5) { }
        }
        await c.ExecuteAsync("""
            INSERT mtg.MeetingParticipants (MeetingId, ParticipantType, EmployeeId, [Role], ResponseStatus, LiveKitIdentity, CanScreenShare, CreatedByUserId)
            VALUES (@meetingId, 'EMPLOYEE', @emp, 'HOST', 'ACCEPTED', @identity, 1, @user)
            """, new { meetingId, emp = me.EmployeeId, identity = MeetingMessaging.NewOpaqueId("p_", 12), user = me.UserId }, tx);
        var (token, link) = await EnsureLinkAsync(c, tx, s, meetingId, end, me.UserId);
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_INSTANT_STARTED", "Meeting", publicId.ToString(), $"Instant meeting {code} created", ClientInfo.From(ctx).Ip, tx,
            newValues: new { meetingCode = code, title, category, startUtc = now, endUtc = end, recordingPolicy = recording, audioOnly = i.AudioOnly == true, waitingRoom = i.WaitingRoomEnabled ?? true });
        tx.Commit();
        return Results.Json(new { id = publicId, meetingCode = code, status = "SCHEDULED", kind = "INSTANT", link = LinkDto(s, token, link) }, statusCode: 201);
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

    // ---- Manage the link (hosts / organiser) --------------------------------------------------------------------------

    sealed record ManagedMeeting(long MeetingId, long HostEmployeeId, long CreatedByEmployeeId, string Status, DateTime EndUtc, string? MyRole);

    static async Task<IResult> Manage(Guid id, LinkServices s, HttpContext ctx, bool regenerate, bool revoke)
    {
        var ct = ctx.RequestAborted;
        using var c = await s.Db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await c.QuerySingleOrDefaultAsync<ManagedMeeting>($"""
            SELECT m.MeetingId, m.HostEmployeeId, m.CreatedByEmployeeId, m.[Status], m.ScheduledEndUtc AS EndUtc,
                   (SELECT p.[Role] FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = @emp AND p.IsBlocked = 0) AS MyRole
            FROM mtg.Meetings m WHERE m.PublicId = @id AND {MeetingEndpoints.Visible}
            """, new { id, emp = me.EmployeeId, all = me.ViewAll });
        if (m is null) return Db_.NotFound("Meeting");
        if (!CanManageLink(m.HostEmployeeId, m.CreatedByEmployeeId, m.MyRole, me))
            return Problems.Create(403, "FORBIDDEN", "Only the host, a co-host or the organiser can share this meeting's link.");
        if (m.Status is not ("SCHEDULED" or "LIVE")) return Db_.Conflict("This meeting is not scheduled or in progress, so it has no link to share.");

        var now = s.Clock.UtcNow;
        var ip = ClientInfo.From(ctx).Ip;
        using var tx = c.BeginTransaction();
        if (regenerate || revoke)
        {
            var n = await c.ExecuteAsync("UPDATE mtg.MeetingLinks SET RevokedUtc = @now, RevokedByUserId = @user WHERE MeetingId = @mid AND RevokedUtc IS NULL",
                new { now, user = me.UserId, mid = m.MeetingId }, tx);
            await Audit.WriteAsync(c, "USER", me.UserId, regenerate ? "MEETING_LINK_REGENERATED" : "MEETING_LINK_REVOKED", "Meeting", id.ToString(),
                regenerate ? "Meeting link replaced (the old link stops working)" : "Meeting link withdrawn", ip, tx, newValues: new { revoked = n });
            if (revoke)
            {
                tx.Commit();
                return Results.NoContent();
            }
        }
        var (token, row) = await EnsureLinkAsync(c, tx, s, m.MeetingId, m.EndUtc, me.UserId);
        tx.Commit();
        return Results.Ok(LinkDto(s, token, row));
    }

    // ---- Anonymous link page ----------------------------------------------------------------------------------------

    sealed record PublicLink(long LinkId, long MeetingId, Guid PublicId, string Title, string Organiser, DateTime StartUtc, DateTime EndUtc, string TimeZoneId, string Status,
        string MeetingCode, bool IsLocked, bool IsAudioOnly, string MeetingKind);

    static async Task<PublicLink?> FindLinkAsync(IDbConnection c, string token, DateTime now)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200) return null;
        return await c.QuerySingleOrDefaultAsync<PublicLink>("""
            SELECT l.LinkId, m.MeetingId, m.PublicId, m.Title, h.DisplayName AS Organiser, m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc, m.TimeZoneId,
                   m.[Status], m.MeetingCode, m.IsLocked, m.IsAudioOnly, m.MeetingKind
            FROM mtg.MeetingLinks l JOIN mtg.Meetings m ON m.MeetingId = l.MeetingId JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
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
        var personal = Tokens.New();
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
