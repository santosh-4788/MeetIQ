using System.Data;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Recording;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Integrations;

// ---- Contract (these records ARE the published OpenAPI schema) ------------------------------------------------------------

/// <summary>A customer / guest to invite: name and e-mail.</summary>
public sealed record ExtParticipantInput(string? Name, string? Email);
/// <summary>Who hosts the meeting: an active OneInsure employee with a portal login, by official e-mail or employee code.</summary>
public sealed record ExtHostInput(string? Email, string? EmployeeCode);
/// <summary>Create a meeting (instant or scheduled).</summary>
/// <param name="Category">CUSTOMER_PLVC, CUSTOMER_GENERAL, INTERNAL (= GROUP), TRAINING, TEAM, or any portal category code.</param>
/// <param name="MeetingType">INSTANT (starts now) or SCHEDULED (needs startTime).</param>
/// <param name="PrarambhMainId">Required for CUSTOMER_PLVC; digits only (max 30). Not allowed for other categories.</param>
/// <param name="StartTime">SCHEDULED only: ISO-8601 with offset, e.g. 2026-11-13T10:00:00+05:30.</param>
/// <param name="DurationMinutes">5 minutes up to the configured maximum (default 30 for instant meetings).</param>
/// <param name="RecordingPolicy">NONE, OPTIONAL or REQUIRED (the category's approved recording policy still applies - PLVC is always recorded).</param>
/// <param name="ExternalReference">Your own reference for this meeting (max 100), returned in every response and webhook.</param>
/// <param name="PlvcIdentification">CUSTOMER_PLVC + INSTANT only: "UNIDENTIFIED" creates a meeting without Prarambh Main ID, customer or participants (needs the meeting.plvc.unidentified scope). Omit it for the normal, identified flow.</param>
public sealed record ExtCreateMeetingInput(string? Category, string? MeetingType, string? MeetingTitle, string? Purpose, string? Description, string? PrarambhMainId,
    ExtHostInput? Host, ExtParticipantInput[]? Participants, DateTimeOffset? StartTime, int? DurationMinutes, bool? AudioOnly, bool? WaitingRoomEnabled,
    string? RecordingPolicy, string? ExternalReference, string? PlvcIdentification = null);

public sealed record ExtHost(string Name, string? Email, string? EmployeeCode);
/// <param name="Type">CUSTOMER, GUEST or EMPLOYEE.</param>
/// <param name="JoinUrl">Personal join link (instant meetings, returned only by the create call - store it; it is not retrievable later).</param>
public sealed record ExtParticipant(string Name, string? Email, string Type, string Role, string? JoinUrl);
/// <param name="MeetingId">The meeting code, e.g. OIC-261112-AB12 - use it in every other call.</param>
/// <param name="MeetingLink">Shareable link: anyone opening it asks to join and a host admits them.</param>
/// <param name="HostJoinUrl">The host opens this after signing in to OneInsure Connect.</param>
/// <param name="Status">Draft, Scheduled, Live, Completed, Cancelled, Expired or Incomplete.</param>
public sealed record ExtMeeting(bool Success, string MeetingId, Guid Id, string IntegrationId, string? ExternalReference, string Title, string Category,
    string MeetingType, string? PrarambhMainId, string Status, DateTimeOffset StartTime, DateTimeOffset EndTime, string? MeetingLink, string HostJoinUrl,
    ExtHost Host, IReadOnlyList<ExtParticipant> Participants, string? PlvcIdentification = null);
public sealed record ExtMeetingSummary(string MeetingId, Guid Id, string? ExternalReference, string Title, string Category, string MeetingType,
    string? PrarambhMainId, string Status, DateTimeOffset StartTime, DateTimeOffset EndTime);
public sealed record ExtMeetingList(bool Success, int Page, int PageSize, int Total, IReadOnlyList<ExtMeetingSummary> Meetings);
public sealed record ExtCancelInput(string? Reason);

/// <param name="Status">NotStarted, ConsentPending, Starting, Recording, Processing, Completed, Failed or Deleted.</param>
/// <param name="FileName">Download file name (never a server path).</param>
public sealed record ExtRecording(string RecordingId, string Status, bool Available, bool DownloadAvailable, DateTimeOffset? StartTime, DateTimeOffset? EndTime,
    int? DurationSeconds, long? FileSizeBytes, string? FileName, string? PrarambhMainId);
public sealed record ExtRecordingList(bool Success, string MeetingId, IReadOnlyList<ExtRecording> Recordings);
public sealed record ExtDownloadLink(bool Success, string RecordingId, string Url, DateTimeOffset ExpiresAt, string FileName);

public sealed record ExtReportMeeting(string MeetingId, Guid Id, string IntegrationId, string? ExternalReference, string Title, string Category, string MeetingType,
    string? PrarambhMainId, string Status, bool Completed, DateTimeOffset ScheduledStart, DateTimeOffset ScheduledEnd, DateTimeOffset? StartTime, DateTimeOffset? EndTime,
    int? DurationMinutes);
public sealed record ExtAttendance(DateTimeOffset JoinedAt, DateTimeOffset? LeftAt, int? Seconds);
public sealed record ExtReportParticipant(string Name, string? Email, string Type, string Role, DateTimeOffset? JoinedAt, DateTimeOffset? LeftAt,
    int AttendedSeconds, IReadOnlyList<ExtAttendance> Sessions);
public sealed record ExtSummaryRef(bool Available, string? Reference);
/// <summary>Meeting completion report. Meeting and recording status are independent: a Completed meeting may still have a Processing recording.</summary>
public sealed record ExtMeetingReport(bool Success, ExtReportMeeting Meeting, ExtHost Host, IReadOnlyList<ExtReportParticipant> Participants,
    ExtRecording Recording, IReadOnlyList<ExtRecording> Recordings, ExtSummaryRef Summary);

public sealed record ExtWebhookInput(string? Url, string[]? Events, bool? Active, bool? RotateSecret);
/// <param name="Secret">HMAC-SHA256 signing secret - returned ONLY when the subscription is created or the secret rotated.</param>
public sealed record ExtWebhook(bool Success, string Url, IReadOnlyList<string> Events, bool Active, DateTimeOffset CreatedAt, string? Secret);
public sealed record ExtWebhookTest(bool Success, Guid EventId, string Status);
public sealed record ExtMe(bool Success, string IntegrationId, string Name, IReadOnlyList<string> Scopes, int RateLimitPerMinute, string ApiVersion);

/// <summary>
/// The external integration API (Modules 8-12): /api/ext/v1. Authenticated by API key (ExternalApiMiddleware), scoped per endpoint,
/// isolated per integration - every query filters on the caller's IntegrationId, so another portal's meeting is simply "not found".
/// Meetings are created through the same code as the portal (MeetingLinkEndpoints.CreateInstantAsync / MeetingEndpoints.CreateCoreAsync),
/// hosted by a mapped employee, so every business rule (categories, PLVC, recording policies, calendar conflicts) applies unchanged.
/// </summary>
public static partial class ExternalApiEndpoints
{
    public const string Version = "v1";
    public const string DocumentName = "ext-v1";
    const string MediaPurpose = "OneInsure.Connect.ExtRecordingMedia.v1";

    public static IEndpointRouteBuilder MapExternalApi(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/api/ext/v1").WithGroupName(DocumentName).WithTags("OneInsure Connect integration API")
            .ProducesProblem(401).ProducesProblem(403).ProducesProblem(429);

        g.MapGet("/me", Me).WithName("GetIntegration").WithSummary("Who am I: the calling integration, its scopes and rate limit.").Produces<ExtMe>();
        g.MapPost("/meetings", CreateMeeting).RequireScope(IntegrationScopes.MeetingCreate).WithName("CreateMeeting")
            .WithSummary("Create an instant or scheduled meeting and get its links.")
            .WithDescription("Send an Idempotency-Key header to make retries safe: a repeated key with the same body returns the original response; with a different body, 422.")
            .Produces<ExtMeeting>(201).ProducesProblem(400).ProducesProblem(409).ProducesProblem(422);
        g.MapGet("/meetings", ListMeetings).RequireScope(IntegrationScopes.MeetingRead).WithName("ListMeetings")
            .WithSummary("List this integration's meetings (newest first), optionally by externalReference or status.").Produces<ExtMeetingList>();
        g.MapGet("/meetings/{meetingId}", GetMeeting).RequireScope(IntegrationScopes.MeetingRead).WithName("GetMeeting")
            .WithSummary("Meeting details, status, participants and the shareable link.").Produces<ExtMeeting>().ProducesProblem(404);
        g.MapPost("/meetings/{meetingId}/cancel", CancelMeeting).RequireScope(IntegrationScopes.MeetingCancel).WithName("CancelMeeting")
            .WithSummary("Cancel a meeting that has not started (participants are notified).").Produces(204).ProducesProblem(400).ProducesProblem(404).ProducesProblem(409);
        g.MapGet("/meetings/{meetingId}/report", Report).RequireScope(IntegrationScopes.MeetingJsonRead).WithName("GetMeetingReport")
            .WithSummary("Meeting completion JSON: times, participants with join/leave, recording status. Call again for updates.").Produces<ExtMeetingReport>().ProducesProblem(404);
        g.MapGet("/meetings/{meetingId}/recordings", Recordings).RequireScope(IntegrationScopes.RecordingRead).WithName("ListRecordings")
            .WithSummary("Recording metadata for a meeting.").Produces<ExtRecordingList>().ProducesProblem(404);
        g.MapPost("/meetings/{meetingId}/recordings/{recordingId}/download-link", DownloadLink).RequireScope(IntegrationScopes.RecordingDownload)
            .WithName("CreateRecordingDownloadLink").WithSummary("A short-lived download URL for a completed recording (no API key needed to fetch it).")
            .Produces<ExtDownloadLink>().ProducesProblem(404).ProducesProblem(409).ProducesProblem(410);
        g.MapGet("/recordings/media/{token}", Media).WithName("DownloadRecording").WithSummary("Streams the MP4 (supports HTTP Range). Authorised by the signed token only.")
            .Produces(200, contentType: "video/mp4").ProducesProblem(403).ProducesProblem(404);
        g.MapGet("/webhook", GetWebhook).RequireScope(IntegrationScopes.WebhookManage).WithName("GetWebhook").WithSummary("This integration's webhook subscription.")
            .Produces<ExtWebhook>().ProducesProblem(404);
        g.MapPut("/webhook", PutWebhook).RequireScope(IntegrationScopes.WebhookManage).WithName("SetWebhook")
            .WithSummary("Create or change the webhook subscription (URL, events). The signing secret is returned on creation or rotation only.")
            .Produces<ExtWebhook>().ProducesProblem(400);
        g.MapDelete("/webhook", DeleteWebhook).RequireScope(IntegrationScopes.WebhookManage).WithName("DisableWebhook").WithSummary("Stop webhook deliveries.").Produces(204);
        g.MapPost("/webhook/test", TestWebhook).RequireScope(IntegrationScopes.WebhookManage).WithName("TestWebhook")
            .WithSummary("Queue a signed 'webhook.test' event to your endpoint.").Produces<ExtWebhookTest>().ProducesProblem(404);
        return app;
    }

    // ---- Shared ----------------------------------------------------------------------------------------------------------

    public sealed class ExtServices(Db db, IClock clock, MeetingLinkEndpoints.LinkServices links, MeetingMessaging msg, IOptions<MeetingOptions> meetings,
        IOptions<PublicEndpointOptions> pub, RecordingPaths paths, IDataProtectionProvider dp, IOptions<IntegrationOptions> options)
    {
        public Db Db => db;
        public IClock Clock => clock;
        public MeetingLinkEndpoints.LinkServices Links => links;
        public MeetingMessaging Msg => msg;
        public MeetingOptions Meetings => meetings.Value;
        public string WebBase => pub.Value.WebBaseUrl.TrimEnd('/');
        public RecordingPaths Paths => paths;
        public ITimeLimitedDataProtector Media { get; } = dp.CreateProtector(MediaPurpose).ToTimeLimitedDataProtector();
        public IDataProtector WebhookSecrets { get; } = dp.CreateProtector(WebhookWorker.SecretPurpose);
        public IntegrationOptions Options => options.Value;
    }

    static readonly TimeZoneInfo Ist = TimeZoneInfo.TryFindSystemTimeZoneById("Asia/Kolkata", out var tz) ? tz
        : TimeZoneInfo.TryFindSystemTimeZoneById("India Standard Time", out var w) ? w : TimeZoneInfo.Utc;
    internal static DateTimeOffset ToIst(DateTime utc) => TimeZoneInfo.ConvertTime(new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)), Ist);
    static DateTimeOffset? ToIst(DateTime? utc) => utc is { } u ? ToIst(u) : null;

    internal static string MeetingStatus(string s) => s switch
    {
        "DRAFT" => "Draft", "SCHEDULED" => "Scheduled", "LIVE" => "Live", "COMPLETED" => "Completed", "CANCELLED" => "Cancelled",
        "EXPIRED" => "Expired", "INCOMPLETE" => "Incomplete", _ => s,
    };
    internal static string RecordingStatus(string s) => s switch
    {
        "PENDING" => "Starting", "RECORDING" => "Recording", "PROCESSING" or "VERIFYING" => "Processing", "COMPLETED" => "Completed",
        "FAILED" => "Failed", "PURGED" => "Deleted", _ => s,
    };

    /// <summary>Friendly category names accepted from portals, mapped to the portal's category codes.</summary>
    internal static string? Category(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var k = raw.Trim().ToUpperInvariant().Replace('-', '_').Replace(' ', '_');
        return k switch
        {
            "CUSTOMER_PLVC" or "PLVC" or "CUSTOMER__PLVC" => "CUSTOMER_PLVC",
            "CUSTOMER_GENERAL" or "CUSTOMER" or "CUSTOMER__GENERAL" => "CUSTOMER_GENERAL",
            "INTERNAL" or "INTERNAL_MEETING" or "INTERNAL_MEETINGS" => "GROUP",
            "TRAINING" or "TRAINING_TEAM" or "TRAINING_/_TEAM" or "TRAINING_TEAM_MEETING" => "TRAINING",
            _ => MeetingEndpoints.Categories.Contains(k) ? k : null,
        };
    }

    sealed record MeetingRow(long MeetingId, Guid Id, string MeetingCode, string Title, string Category, string MeetingKind, string Status,
        DateTime StartUtc, DateTime EndUtc, DateTime? ActualStartUtc, DateTime? ActualEndUtc, string? PrarambhMainId, string? ExternalReference,
        string HostName, string? HostEmail, string? HostCode);

    const string MeetingSelect = """
        SELECT m.MeetingId, m.PublicId AS Id, m.MeetingCode, m.Title, m.Category, m.MeetingKind, m.[Status], m.ScheduledStartUtc AS StartUtc,
               m.ScheduledEndUtc AS EndUtc, m.ActualStartUtc, m.ActualEndUtc, m.PrarambhMainId, m.ExternalReference,
               h.DisplayName AS HostName, h.OfficialEmail AS HostEmail, h.EmployeeCode AS HostCode
        FROM mtg.Meetings m JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
        """;

    /// <summary>The caller's own meeting by code (or public id) - anything else is 404, never 403, so ids of other portals cannot be probed.</summary>
    static Task<MeetingRow?> FindAsync(IDbConnection c, string meetingId, long integrationId)
    {
        Guid.TryParse(meetingId, out var g);
        return c.QuerySingleOrDefaultAsync<MeetingRow>($"""
            {MeetingSelect}
            WHERE m.IntegrationId = @integrationId AND (m.MeetingCode = @code OR m.PublicId = @g)
            """, new { integrationId, code = meetingId.Trim().ToUpperInvariant(), g = g == Guid.Empty ? (Guid?)null : g });
    }

    static IResult NotFound() => Problems.Create(404, "NOT_FOUND", "Meeting not found for this integration.");

    static ExtMeetingSummary Summary(MeetingRow m) => new(m.MeetingCode, m.Id, m.ExternalReference, m.Title, m.Category, m.MeetingKind, m.PrarambhMainId,
        MeetingStatus(m.Status), ToIst(m.StartUtc), ToIst(m.EndUtc));

    static async Task<ExtMeeting> MeetingDtoAsync(IDbConnection c, ExtServices s, MeetingRow m, IntegrationContext i, IReadOnlyList<ExtParticipant>? created = null)
    {
        string? link = null;
        if (m.Status is "SCHEDULED" or "LIVE" or "DRAFT")
        {
            var (token, _) = await MeetingLinkEndpoints.EnsureLinkAsync(c, null, s.Links, m.MeetingId, null, m.EndUtc,
                await c.ExecuteScalarAsync<long>("SELECT TOP (1) CreatedByUserId FROM mtg.Meetings WHERE MeetingId = @id", new { id = m.MeetingId }));
            link = s.Links.Url(token);
        }
        var participants = created ?? (await c.QueryAsync<ExtParticipant>("""
            SELECT COALESCE(e.DisplayName, cu.FullName, p.GuestName, '') AS Name, COALESCE(e.OfficialEmail, cu.Email, p.GuestEmail) AS Email,
                   p.ParticipantType AS Type, p.[Role], CAST(NULL AS NVARCHAR(10)) AS JoinUrl
            FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE p.MeetingId = @id ORDER BY CASE p.[Role] WHEN 'HOST' THEN 0 ELSE 1 END, p.ParticipantId
            """, new { id = m.MeetingId })).ToList();
        return new ExtMeeting(true, m.MeetingCode, m.Id, i.Code, m.ExternalReference, m.Title, m.Category, m.MeetingKind, m.PrarambhMainId, MeetingStatus(m.Status),
            ToIst(m.StartUtc), ToIst(m.EndUtc), link, $"{s.WebBase}/meetings/{m.Id}/room", new ExtHost(m.HostName, m.HostEmail, m.HostCode), participants,
            Plvc.Identification(m.Category, m.PrarambhMainId));
    }

    // ---- /me -------------------------------------------------------------------------------------------------------------

    static IResult Me(HttpContext ctx)
    {
        var i = ctx.Integration();
        return Results.Ok(new ExtMe(true, i.Code, i.Name, i.Scopes.Order().ToList(), i.RateLimitPerMinute, Version));
    }

    // ---- Create ----------------------------------------------------------------------------------------------------------

    sealed record HostRow(long EmployeeId, Guid EmployeePublicId, string DisplayName, long UserId, bool Customers);

    static async Task<IResult> CreateMeeting(ExtCreateMeetingInput? input, [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey, ExtServices s,
        HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        if (input is null) return Problems.Create(400, "VALIDATION", "A JSON request body is required.");
        using var c = await s.Db.OpenAsync(ct);

        // Idempotency: a retried request with the same key and body returns the original response instead of a second meeting.
        byte[]? requestHash = null;
        if (!string.IsNullOrWhiteSpace(idempotencyKey))
        {
            if (idempotencyKey.Length > 100) return Problems.Create(400, "VALIDATION", "Idempotency-Key must be at most 100 characters.");
            requestHash = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(input));
            try
            {
                await c.ExecuteAsync("INSERT app.ApiIdempotency (IntegrationId, IdempotencyKey, RequestHash, StatusCode) VALUES (@id, @key, @hash, 0)",
                    new { id = i.IntegrationId, key = idempotencyKey, hash = requestHash });
            }
            catch (SqlException e) when (e.IsUniqueViolation())
            {
                var prior = await c.QuerySingleAsync<(byte[] RequestHash, int StatusCode, string? ResponseJson)>(
                    "SELECT RequestHash, StatusCode, ResponseJson FROM app.ApiIdempotency WHERE IntegrationId = @id AND IdempotencyKey = @key", new { id = i.IntegrationId, key = idempotencyKey });
                if (!prior.RequestHash.AsSpan().SequenceEqual(requestHash))
                    return Problems.Create(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request body.");
                if (prior.StatusCode == 0) return Problems.Create(409, "REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still being processed. Retry shortly.");
                ctx.Response.Headers["Idempotent-Replayed"] = "true";
                return Results.Content(prior.ResponseJson ?? "{}", "application/json", Encoding.UTF8, prior.StatusCode);
            }
        }

        var result = await CreateCoreAsync(c, s, i, input, ctx, ct);
        if (requestHash is not null)
        {
            if (result.Body is not null)
                await c.ExecuteAsync("UPDATE app.ApiIdempotency SET StatusCode = 201, ResponseJson = @json WHERE IntegrationId = @id AND IdempotencyKey = @key",
                    new { id = i.IntegrationId, key = idempotencyKey, json = JsonSerializer.Serialize(result.Body, JsonOptions(ctx)) });
            else
                await c.ExecuteAsync("DELETE app.ApiIdempotency WHERE IntegrationId = @id AND IdempotencyKey = @key AND StatusCode = 0", new { id = i.IntegrationId, key = idempotencyKey });
        }
        return result.Body is not null ? Results.Json(result.Body, statusCode: 201) : result.Error!;
    }

    static JsonSerializerOptions JsonOptions(HttpContext ctx) =>
        ctx.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions;

    static async Task<(ExtMeeting? Body, IResult? Error)> CreateCoreAsync(IDbConnection c, ExtServices s, IntegrationContext i, ExtCreateMeetingInput input,
        HttpContext ctx, CancellationToken ct)
    {
        var v = new Validator();
        var category = Category(input.Category);
        if (category is null) v.Add("category", "Unknown category. Use CUSTOMER_PLVC, CUSTOMER_GENERAL, INTERNAL, TRAINING or TEAM.");
        var type = (input.MeetingType ?? "INSTANT").Trim().ToUpperInvariant();
        if (type is not ("INSTANT" or "SCHEDULED")) v.Add("meetingType", "meetingType must be INSTANT or SCHEDULED.");
        if (type == "SCHEDULED" && !i.Has(IntegrationScopes.MeetingSchedule))
            return (null, Problems.Create(403, "INSUFFICIENT_SCOPE", "Scheduling meetings needs the 'meeting.schedule' scope.", new Dictionary<string, object?> { ["requiredScope"] = IntegrationScopes.MeetingSchedule }));
        var externalReference = v.Optional("externalReference", input.ExternalReference, 100, "External reference");
        if (type == "SCHEDULED" && input.StartTime is null) v.Add("startTime", "startTime is required for a scheduled meeting (ISO-8601 with offset).");
        // V024: an UNIDENTIFIED PLVC meeting is never the default - it must be asked for explicitly, by an integration granted it.
        var ident = input.PlvcIdentification?.Trim().ToUpperInvariant();
        var unidentified = ident == "UNIDENTIFIED";
        if (ident is not (null or "" or "IDENTIFIED" or "UNIDENTIFIED")) v.Add("plvcIdentification", "plvcIdentification must be IDENTIFIED or UNIDENTIFIED.");
        if (unidentified && (category != "CUSTOMER_PLVC" || type != "INSTANT")) v.Add("plvcIdentification", "UNIDENTIFIED is only possible for an INSTANT CUSTOMER_PLVC meeting.");
        if (unidentified && (!string.IsNullOrWhiteSpace(input.PrarambhMainId) || input.Participants is { Length: > 0 }))
            v.Add("plvcIdentification", "An UNIDENTIFIED meeting has no prarambhMainId and no participants - remove them, or omit plvcIdentification.");
        if (unidentified && !i.Has(IntegrationScopes.PlvcUnidentified))
            return (null, Problems.Create(403, "INSUFFICIENT_SCOPE", "Unidentified PLVC meetings need the 'meeting.plvc.unidentified' scope.", new Dictionary<string, object?> { ["requiredScope"] = IntegrationScopes.PlvcUnidentified }));
        if (!v.IsValid) return (null, v.Problem());

        var host = await ResolveHostAsync(c, i, input.Host, v);
        if (host is null) return (null, v.IsValid ? Problems.Create(400, "VALIDATION", "No host.") : v.Problem());
        if (MeetingEndpoints.IsCustomerCategory(category) && !host.Customers)
            return (null, Problems.Create(403, "HOST_NOT_PERMITTED", "The host employee is not allowed to hold customer meetings."));
        var me = new Actor(host.UserId, host.EmployeeId, host.DisplayName, ViewAll: false, Override: false, Customers: host.Customers);
        var people = input.Participants?.Select(p => new MeetingEndpoints.GuestInput(p.Name, p.Email)).ToArray();
        var ip = ctx.Connection.RemoteIpAddress?.ToString();

        Guid publicId;
        IReadOnlyList<ExtParticipant>? created = null;
        if (type == "INSTANT")
        {
            var (error, r) = await MeetingLinkEndpoints.CreateInstantAsync(c, s.Links,
                new MeetingLinkEndpoints.InstantInput(input.MeetingTitle, category, input.DurationMinutes, input.AudioOnly, input.WaitingRoomEnabled, input.RecordingPolicy,
                    null, input.PrarambhMainId, people, SkipPlvcDetails: unidentified), me, ip, i.IntegrationId, externalReference);
            if (error is not null) return (null, error);
            publicId = r!.PublicId;
            created = [new ExtParticipant(host.DisplayName, null, "EMPLOYEE", "HOST", null),
                .. r.Participants.Select(p => new ExtParticipant(p.Name, p.Email, p.Type, "ATTENDEE", p.JoinUrl))];
        }
        else
        {
            var start = input.StartTime!.Value.UtcDateTime;
            var minutes = input.DurationMinutes ?? 30;
            Guid? createdId = null;
            var error = await MeetingEndpoints.CreateCoreAsync(c,
                new MeetingEndpoints.MeetingInput(input.MeetingTitle ?? $"{host.DisplayName}'s meeting", input.Description, null, category, start, start.AddMinutes(minutes),
                    s.Meetings.DefaultTimeZone, null, null, null, null, input.RecordingPolicy, input.WaitingRoomEnabled, "SCHEDULED", input.Purpose, null, false, null,
                    input.PrarambhMainId, people),
                me, ip, s.Msg, s.Clock, s.Meetings, i.IntegrationId, externalReference, id => createdId = id);
            if (createdId is null) return (null, error);
            publicId = createdId.Value;
        }
        var m = await c.QuerySingleAsync<MeetingRow>($"{MeetingSelect} WHERE m.PublicId = @publicId", new { publicId });
        if (input.Purpose is { Length: > 0 } purpose && type == "INSTANT")
            await c.ExecuteAsync("UPDATE mtg.Meetings SET Purpose = @purpose WHERE MeetingId = @id", new { purpose = purpose.Length > 200 ? purpose[..200] : purpose, id = m.MeetingId });
        await WebhookWorker.EnqueueAsync(c, i.IntegrationId, IntegrationEventTypes.MeetingCreated, m.MeetingId, $"m:{m.MeetingId}",
            new { meetingId = m.MeetingCode, externalReference = m.ExternalReference, category = m.Category, meetingType = m.MeetingKind, status = MeetingStatus(m.Status),
                startTime = ToIst(m.StartUtc), endTime = ToIst(m.EndUtc), prarambhMainId = m.PrarambhMainId, plvcIdentification = Plvc.Identification(m.Category, m.PrarambhMainId) }, i.Code, s.Clock.UtcNow);
        return (await MeetingDtoAsync(c, s, m, i, created), null);
    }

    static async Task<HostRow?> ResolveHostAsync(IDbConnection c, IntegrationContext i, ExtHostInput? h, Validator v)
    {
        const string Select = """
            SELECT TOP (1) e.EmployeeId, e.PublicId AS EmployeePublicId, e.DisplayName, u.UserId,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM auth.UserRoles ur JOIN auth.RolePermissions rp ON rp.RoleId = ur.RoleId
                        JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE ur.UserId = u.UserId AND p.Code = 'customer.meetings.view') THEN 1 ELSE 0 END AS BIT) AS Customers
            FROM org.Employees e JOIN auth.Users u ON u.EmployeeId = e.EmployeeId AND u.IsActive = 1 AND u.IsLocked = 0
            WHERE e.IsActive = 1
            """;
        HostRow? row;
        if (h?.Email is { Length: > 0 } email)
            row = await c.QuerySingleOrDefaultAsync<HostRow>($"{Select} AND (e.OfficialEmail = @email OR u.Email = @email) ORDER BY e.EmployeeId", new { email = email.Trim() });
        else if (h?.EmployeeCode is { Length: > 0 } code)
            row = await c.QuerySingleOrDefaultAsync<HostRow>($"{Select} AND e.EmployeeCode = @code ORDER BY e.EmployeeId", new { code = code.Trim() });
        else if (i.DefaultHostEmployeeId is { } d)
            row = await c.QuerySingleOrDefaultAsync<HostRow>($"{Select} AND e.EmployeeId = @d", new { d });
        else { v.Add("host", "Give the host's e-mail or employee code (this integration has no default host)."); return null; }
        if (row is null) v.Add("host", "The host must be an active OneInsure employee with an active portal login.");
        return row;
    }

    // ---- Read / list / cancel ----------------------------------------------------------------------------------------------

    static async Task<IResult> GetMeeting(string meetingId, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var m = await FindAsync(c, meetingId, i.IntegrationId);
        return m is null ? NotFound() : Results.Ok(await MeetingDtoAsync(c, s, m, i));
    }

    static async Task<IResult> ListMeetings(string? externalReference, string? status, int? page, int? pageSize, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        var size = Math.Clamp(pageSize ?? 50, 1, 200);
        var p = Math.Max(1, page ?? 1);
        var st = status?.Trim().ToUpperInvariant();
        using var c = await s.Db.OpenAsync(ct);
        var where = "WHERE m.IntegrationId = @id AND (@ref IS NULL OR m.ExternalReference = @ref) AND (@st IS NULL OR m.[Status] = @st)";
        var args = new { id = i.IntegrationId, @ref = externalReference, st, skip = (p - 1) * size, size };
        var total = await c.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM mtg.Meetings m {where}", args);
        var rows = await c.QueryAsync<MeetingRow>($"{MeetingSelect} {where} ORDER BY m.CreatedUtc DESC, m.MeetingId DESC OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY", args);
        return Results.Ok(new ExtMeetingList(true, p, size, total, rows.Select(Summary).ToList()));
    }

    static async Task<IResult> CancelMeeting(string meetingId, ExtCancelInput? input, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        var v = new Validator();
        var reason = v.Required("reason", input?.Reason, 500, "Reason");
        if (!v.IsValid) return v.Problem();
        using var c = await s.Db.OpenAsync(ct);
        var m = await FindAsync(c, meetingId, i.IntegrationId);
        if (m is null) return NotFound();
        if (m.Status is not ("DRAFT" or "SCHEDULED")) return Problems.Create(409, "CONFLICT", $"Only a meeting that has not started can be cancelled (status: {MeetingStatus(m.Status)}).");
        using var tx = c.BeginTransaction();
        var n = await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET [Status] = 'CANCELLED', CancelReason = @reason, ModifiedUtc = SYSUTCDATETIME() WHERE MeetingId = @id AND [Status] = @old
            """, new { reason, id = m.MeetingId, old = m.Status }, tx);
        if (n == 0) { tx.Rollback(); return Problems.Create(409, "CONFLICT", "The meeting changed meanwhile. Fetch it again."); }
        await MeetingMessaging.CancelRemindersAsync(c, tx, m.MeetingId);
        var creator = await c.ExecuteScalarAsync<long>("SELECT CreatedByUserId FROM mtg.Meetings WHERE MeetingId = @id", new { id = m.MeetingId }, tx);
        if (m.Status == "SCHEDULED" && m.MeetingKind != "INSTANT")
        {
            var info = await MeetingMessaging.LoadAsync(c, tx, m.MeetingId);
            await s.Msg.SendAsync(c, tx, info, await MeetingMessaging.RecipientsAsync(c, tx, m.MeetingId), MessageKind.Cancelled, creator);
        }
        await Audit.WriteAsync(c, "INTEGRATION", creator, "MEETING_CANCELLED", "Meeting", m.Id.ToString(), $"Meeting cancelled through the external API ({i.Code})",
            ctx.Connection.RemoteIpAddress?.ToString(), tx, newValues: new { reason, integration = i.Code });
        tx.Commit();
        return Results.NoContent();
    }

    // ---- Completion report ---------------------------------------------------------------------------------------------------

    sealed record RecordingRow(long RecordingId, Guid PublicId, string Status, DateTime? StartedUtc, DateTime? EndedUtc, int? DurationSeconds, long? FileSizeBytes,
        string? StorageKey, string? PrarambhMainId, DateTime CreatedUtc);

    static async Task<List<RecordingRow>> RecordingRowsAsync(IDbConnection c, long meetingId) =>
        (await c.QueryAsync<RecordingRow>("""
            SELECT RecordingId, PublicId, [Status], StartedUtc, EndedUtc, DurationSeconds, FileSizeBytes, StorageKey, PrarambhMainId, CreatedUtc
            FROM rec.MeetingRecordings WHERE MeetingId = @meetingId ORDER BY RecordingId
            """, new { meetingId })).ToList();

    internal static string DownloadName(string meetingCode, RecordingRowLite r) =>
        r.StorageKey is { } k && k.Length > 9 && k[8] == '/' ? Path.GetFileName(k) : $"recording-{meetingCode}-{(r.StartedUtc ?? DateTime.UtcNow):yyyyMMdd-HHmm}.mp4";
    internal sealed record RecordingRowLite(string? StorageKey, DateTime? StartedUtc);

    static ExtRecording RecordingDto(string meetingCode, RecordingRow r)
    {
        var completed = r.Status == "COMPLETED";
        return new ExtRecording(r.PublicId.ToString(), RecordingStatus(r.Status), completed, completed, ToIst(r.StartedUtc), ToIst(r.EndedUtc), r.DurationSeconds,
            r.FileSizeBytes, completed ? DownloadName(meetingCode, new RecordingRowLite(r.StorageKey, r.StartedUtc)) : null, r.PrarambhMainId);
    }

    static async Task<IResult> Report(string meetingId, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var m = await FindAsync(c, meetingId, i.IntegrationId);
        if (m is null) return NotFound();

        var people = (await c.QueryAsync<(long ParticipantId, string Name, string? Email, string Type, string Role)>("""
            SELECT p.ParticipantId, COALESCE(e.DisplayName, cu.FullName, p.GuestName, '') AS Name, COALESCE(e.OfficialEmail, cu.Email, p.GuestEmail) AS Email,
                   p.ParticipantType, p.[Role]
            FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE p.MeetingId = @id ORDER BY CASE p.[Role] WHEN 'HOST' THEN 0 ELSE 1 END, p.ParticipantId
            """, new { id = m.MeetingId })).ToList();
        var sessions = (await c.QueryAsync<(long ParticipantId, DateTime JoinedUtc, DateTime? LeftUtc, int? DurationSeconds)>(
            "SELECT ParticipantId, JoinedUtc, LeftUtc, DurationSeconds FROM mtg.MeetingAttendance WHERE MeetingId = @id ORDER BY JoinedUtc", new { id = m.MeetingId }))
            .GroupBy(a => a.ParticipantId).ToDictionary(g => g.Key, g => g.ToList());
        var participants = people.Select(p =>
        {
            var list = sessions.TryGetValue(p.ParticipantId, out var l) ? l : [];
            return new ExtReportParticipant(p.Name, p.Email, p.Type, p.Role, list.Count > 0 ? ToIst(list.Min(a => a.JoinedUtc)) : null,
                list.Count > 0 && list.All(a => a.LeftUtc is not null) ? ToIst(list.Max(a => a.LeftUtc!.Value)) : null,
                list.Sum(a => a.DurationSeconds ?? 0), list.Select(a => new ExtAttendance(ToIst(a.JoinedUtc), ToIst(a.LeftUtc), a.DurationSeconds)).ToList());
        }).ToList();

        var recordings = await RecordingRowsAsync(c, m.MeetingId);
        ExtRecording latest;
        if (recordings.Count > 0) latest = RecordingDto(m.MeetingCode, recordings[^1]);
        else
        {
            var consentPending = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM rec.RecordingRequests WHERE MeetingId = @id AND [Status] = 'OPEN'", new { id = m.MeetingId }) > 0;
            latest = new ExtRecording("", consentPending ? "ConsentPending" : "NotStarted", false, false, null, null, null, null, null, m.PrarambhMainId);
        }
        int? duration = m.ActualStartUtc is { } a && m.ActualEndUtc is { } b ? (int)Math.Round((b - a).TotalMinutes) : null;
        var completed = m.Status is "COMPLETED" or "INCOMPLETE";
        return Results.Ok(new ExtMeetingReport(true,
            new ExtReportMeeting(m.MeetingCode, m.Id, i.Code, m.ExternalReference, m.Title, m.Category, m.MeetingKind, m.PrarambhMainId, MeetingStatus(m.Status), completed,
                ToIst(m.StartUtc), ToIst(m.EndUtc), ToIst(m.ActualStartUtc), completed ? ToIst(m.ActualEndUtc) : null, completed ? duration : null),
            new ExtHost(m.HostName, m.HostEmail, m.HostCode), participants, latest, recordings.Select(r => RecordingDto(m.MeetingCode, r)).ToList(),
            new ExtSummaryRef(false, null)));
    }

    // ---- Recordings ------------------------------------------------------------------------------------------------------------

    static async Task<IResult> Recordings(string meetingId, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var m = await FindAsync(c, meetingId, i.IntegrationId);
        if (m is null) return NotFound();
        return Results.Ok(new ExtRecordingList(true, m.MeetingCode, (await RecordingRowsAsync(c, m.MeetingId)).Select(r => RecordingDto(m.MeetingCode, r)).ToList()));
    }

    static async Task<IResult> DownloadLink(string meetingId, string recordingId, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var m = await FindAsync(c, meetingId, i.IntegrationId);
        if (m is null || !Guid.TryParse(recordingId, out var rid)) return Problems.Create(404, "NOT_FOUND", "Recording not found for this integration.");
        var r = (await RecordingRowsAsync(c, m.MeetingId)).FirstOrDefault(x => x.PublicId == rid);
        if (r is null) return Problems.Create(404, "NOT_FOUND", "Recording not found for this integration.");
        switch (r.Status)
        {
            case "PURGED": return Problems.Create(410, "RECORDING_DELETED", "This recording was deleted.");
            case "FAILED": return Problems.Create(409, "RECORDING_FAILED", "This recording failed and has no file.");
            case not "COMPLETED": return Problems.Create(409, "RECORDING_NOT_READY", $"The recording is not ready yet (status: {RecordingStatus(r.Status)}). Try again later.");
        }
        var ttl = TimeSpan.FromSeconds(Math.Clamp(s.Options.DownloadLinkSeconds, 30, 3600));
        var token = s.Media.Protect($"{r.PublicId:N}|{i.IntegrationId}", ttl);
        var expires = s.Clock.UtcNow.Add(ttl);
        await Audit.WriteAsync(c, "INTEGRATION", null, "RECORDING_DOWNLOAD_LINK_ISSUED", "Recording", r.PublicId.ToString(),
            $"Download link issued to integration {i.Code}", ctx.Connection.RemoteIpAddress?.ToString(), newValues: new { integration = i.Code, expiresUtc = expires });
        return Results.Ok(new ExtDownloadLink(true, r.PublicId.ToString(), $"{s.WebBase}/api/ext/v1/recordings/media/{token}", ToIst(expires),
            DownloadName(m.MeetingCode, new RecordingRowLite(r.StorageKey, r.StartedUtc))));
    }

    static async Task<IResult> Media(string token, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        string payload;
        try { payload = s.Media.Unprotect(token, out _); }
        catch (CryptographicException) { return Problems.Create(403, "FORBIDDEN", "This download link is not valid or has expired. Request a new one."); }
        var parts = payload.Split('|');
        if (parts.Length != 2 || !Guid.TryParseExact(parts[0], "N", out var rid) || !long.TryParse(parts[1], out var integrationId))
            return Problems.Create(403, "FORBIDDEN", "This download link is not valid.");
        using var c = await s.Db.OpenAsync(ct);
        var r = await c.QuerySingleOrDefaultAsync<(Guid PublicId, string Status, string? StorageKey, string StorageTier, string? ArchiveRoot, DateTime? StartedUtc, string MeetingCode, bool Active)?>("""
            SELECT r.PublicId, r.[Status], r.StorageKey, r.StorageTier, r.ArchiveRoot, r.StartedUtc, m.MeetingCode, i.IsActive
            FROM rec.MeetingRecordings r JOIN mtg.Meetings m ON m.MeetingId = r.MeetingId JOIN app.ApiIntegrations i ON i.IntegrationId = m.IntegrationId
            WHERE r.PublicId = @rid AND m.IntegrationId = @integrationId
            """, new { rid, integrationId });
        if (r is null || !r.Value.Active) return Problems.Create(403, "FORBIDDEN", "This download link is not valid.");
        if (r.Value.Status == "PURGED") return Problems.Create(410, "RECORDING_DELETED", "This recording was deleted.");
        if (r.Value.Status != "COMPLETED" || r.Value.StorageKey is null) return Problems.Create(404, "NOT_FOUND", "Recording not available.");
        var root = r.Value.StorageTier == "ARCHIVE" ? r.Value.ArchiveRoot : s.Paths.StorageRoot;
        if (root is null) return Problems.Create(503, "SERVICE_UNAVAILABLE", "Recording storage is not available.");
        var file = RecordingPaths.Resolve(root, r.Value.StorageKey);
        if (!File.Exists(file)) return Problems.Create(404, "NOT_FOUND", "The recording file is not available.");
        if (ctx.Request.Headers.Range.Count == 0 || ctx.Request.Headers.Range.ToString().StartsWith("bytes=0-", StringComparison.Ordinal))
            await Audit.WriteAsync(c, "INTEGRATION", null, "RECORDING_DOWNLOADED", "Recording", r.Value.PublicId.ToString(),
                "Recording downloaded through the external API", ctx.Connection.RemoteIpAddress?.ToString(), newValues: new { integrationId });
        ctx.Response.Headers.CacheControl = "private, no-store";
        ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Results.File(file, "video/mp4", DownloadName(r.Value.MeetingCode, new RecordingRowLite(r.Value.StorageKey, r.Value.StartedUtc)), enableRangeProcessing: true);
    }

    // ---- Webhook subscription -----------------------------------------------------------------------------------------------

    internal sealed record SubRow(long SubscriptionId, string Url, string Events, bool IsActive, DateTime CreatedUtc);

    static async Task<IResult> GetWebhook(ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var sub = await c.QuerySingleOrDefaultAsync<SubRow>("SELECT SubscriptionId, Url, Events, IsActive, CreatedUtc FROM app.WebhookSubscriptions WHERE IntegrationId = @id", new { id = i.IntegrationId });
        return sub is null ? Problems.Create(404, "NOT_FOUND", "No webhook is configured.") : Results.Ok(new ExtWebhook(true, sub.Url, Events(sub.Events), sub.IsActive, ToIst(sub.CreatedUtc), null));
    }

    static IReadOnlyList<string> Events(string csv) => csv.Split(',', StringSplitOptions.RemoveEmptyEntries);

    static async Task<IResult> PutWebhook(ExtWebhookInput? input, ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var (sub, secret, error) = await SaveWebhookAsync(c, s, i.IntegrationId, input, null, ctx.Connection.RemoteIpAddress?.ToString());
        return error ?? Results.Ok(new ExtWebhook(true, sub!.Url, Events(sub.Events), sub.IsActive, ToIst(sub.CreatedUtc), secret));
    }

    /// <summary>Shared by the external API and the admin screen. Returns the plain secret only when one was generated.</summary>
    internal static async Task<(SubRow? Sub, string? Secret, IResult? Error)> SaveWebhookAsync(IDbConnection c, ExtServices s, long integrationId, ExtWebhookInput? input,
        long? userId, string? ip)
    {
        var v = new Validator();
        var url = v.Required("url", input?.Url, 500, "Webhook URL");
        if (url is not null)
        {
            var problem = await WebhookUrlProblemAsync(url, s.Options.AllowPrivateWebhookTargets);
            if (problem is not null) v.Add("url", problem);
        }
        var events = (input?.Events is { Length: > 0 } e ? e : IntegrationEventTypes.All).Select(x => x.Trim()).Distinct().ToArray();
        var unknown = events.Where(x => !IntegrationEventTypes.All.Contains(x)).ToList();
        if (unknown.Count > 0) v.Add("events", $"Unknown event(s): {string.Join(", ", unknown)}. Allowed: {string.Join(", ", IntegrationEventTypes.All)}.");
        if (!v.IsValid) return (null, null, v.Problem());
        var existing = await c.QuerySingleOrDefaultAsync<SubRow>("SELECT SubscriptionId, Url, Events, IsActive, CreatedUtc FROM app.WebhookSubscriptions WHERE IntegrationId = @integrationId", new { integrationId });
        string? secret = null;
        if (existing is null || input?.RotateSecret == true) secret = "whsec_" + Tokens.New(32);
        if (existing is null)
            await c.ExecuteAsync("""
                INSERT app.WebhookSubscriptions (IntegrationId, Url, SecretProtected, Events, IsActive) VALUES (@integrationId, @url, @secret, @events, @active)
                """, new { integrationId, url, secret = s.WebhookSecrets.Protect(secret!), events = string.Join(',', events), active = input?.Active ?? true });
        else
            await c.ExecuteAsync("""
                UPDATE app.WebhookSubscriptions SET Url = @url, Events = @events, IsActive = @active, ModifiedUtc = SYSUTCDATETIME(),
                    SecretProtected = COALESCE(@secret, SecretProtected)
                WHERE IntegrationId = @integrationId
                """, new { integrationId, url, events = string.Join(',', events), active = input?.Active ?? existing.IsActive, secret = secret is null ? null : s.WebhookSecrets.Protect(secret) });
        await Audit.WriteAsync(c, userId is null ? "INTEGRATION" : "USER", userId, existing is null ? "WEBHOOK_CREATED" : "WEBHOOK_UPDATED", "Integration", integrationId.ToString(),
            $"Webhook {(existing is null ? "created" : "updated")}{(secret is not null && existing is not null ? " (secret rotated)" : "")}", ip,
            newValues: new { url, events, secretRotated = secret is not null });
        var sub = await c.QuerySingleAsync<SubRow>("SELECT SubscriptionId, Url, Events, IsActive, CreatedUtc FROM app.WebhookSubscriptions WHERE IntegrationId = @integrationId", new { integrationId });
        return (sub, secret, null);
    }

    static async Task<IResult> DeleteWebhook(ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        await c.ExecuteAsync("UPDATE app.WebhookSubscriptions SET IsActive = 0, ModifiedUtc = SYSUTCDATETIME() WHERE IntegrationId = @id", new { id = i.IntegrationId });
        await Audit.WriteAsync(c, "INTEGRATION", null, "WEBHOOK_DISABLED", "Integration", i.IntegrationId.ToString(), "Webhook disabled through the API", ctx.Connection.RemoteIpAddress?.ToString());
        return Results.NoContent();
    }

    static async Task<IResult> TestWebhook(ExtServices s, HttpContext ctx, CancellationToken ct)
    {
        var i = ctx.Integration();
        using var c = await s.Db.OpenAsync(ct);
        var id = await WebhookWorker.EnqueueTestAsync(c, i.IntegrationId, i.Code, s.Clock.UtcNow);
        return id is null ? Problems.Create(404, "NOT_FOUND", "No active webhook is configured.") : Results.Ok(new ExtWebhookTest(true, id.Value, "Queued"));
    }

    /// <summary>
    /// SSRF guard: https only (http only for localhost when private targets are allowed), and the host must not resolve to a
    /// loopback, private, link-local or otherwise internal address - unless Integrations:AllowPrivateWebhookTargets (test setups).
    /// Re-checked by the dispatcher before every delivery.
    /// </summary>
    internal static async Task<string?> WebhookUrlProblemAsync(string url, bool allowPrivate)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return "Enter an absolute URL.";
        if (u.Scheme != Uri.UriSchemeHttps && !(allowPrivate && u.Scheme == Uri.UriSchemeHttp && u.IsLoopback)) return "The webhook URL must use https.";
        if (!string.IsNullOrEmpty(u.UserInfo)) return "The URL must not contain credentials.";
        if (allowPrivate) return null;
        IPAddress[] addresses;
        try { addresses = IPAddress.TryParse(u.Host, out var ipa) ? [ipa] : await Dns.GetHostAddressesAsync(u.Host); }
        catch (SocketException) { return "The webhook host name could not be resolved."; }
        if (addresses.Length == 0 || addresses.Any(IsInternal)) return "The webhook URL must point to a public internet address.";
        return null;
    }

    static bool IsInternal(IPAddress a)
    {
        if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
        if (IPAddress.IsLoopback(a) || a.Equals(IPAddress.Any) || a.Equals(IPAddress.IPv6Any)) return true;
        if (a.AddressFamily == AddressFamily.InterNetworkV6) return a.IsIPv6LinkLocal || a.IsIPv6SiteLocal || a.IsIPv6UniqueLocal || a.IsIPv6Multicast;
        var b = a.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
            || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) || b[0] == 0 || b[0] >= 224;
    }
}

public sealed class IntegrationOptions
{
    /// <summary>Lifetime of a recording download link issued to an integration (30-3600 s).</summary>
    public int DownloadLinkSeconds { get; set; } = 300;
    /// <summary>Test setups only: allow webhook URLs on localhost / private networks (and plain http on localhost).</summary>
    public bool AllowPrivateWebhookTargets { get; set; }
    public int WebhookPollSeconds { get; set; } = 5;
    public int WebhookMaxAttempts { get; set; } = 8;
}
