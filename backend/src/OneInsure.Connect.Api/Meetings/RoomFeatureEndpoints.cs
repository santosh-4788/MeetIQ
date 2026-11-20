using System.Data;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;
using static OneInsure.Connect.Api.Meetings.RoomEndpoints;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Optional meeting features (13 Nov 2026, "Advanced AI &amp; collaboration" request): feature switches, Yes/No polls, private 1:1
/// messages and the whiteboard. ADDITIVE: the existing room endpoints are unchanged. Every feature is off until an administrator
/// switches it on (app.FeatureSettings, V026); EMERGENCY_DISABLE turns all of them off at once. With the feature off, these
/// endpoints refuse (403 FEATURE_DISABLED) and the room shows none of their controls. A database without V026 behaves as "all off".
/// Employees use their session (/meetings/{id}/room/...); customers and guests their personal invitation token (/join/{token}/...).
/// Only admitted participants of the meeting itself can use them.
/// </summary>
public static class RoomFeatureEndpoints
{
    public const string PollTopic = "oic.poll";
    public const string PrivateTopic = "oic.private";
    public const string WhiteboardStateTopic = "oic.wb-state";
    public const int PollQuestionMax = 300;
    /// <summary>A whiteboard scene (Excalidraw elements JSON, no embedded images) - generous for hand drawing, bounded for SQL.</summary>
    public const int SceneMaxChars = 2_000_000;

    public static class Keys
    {
        public const string Emergency = "EMERGENCY_DISABLE";
        public const string Reactions = "REACTIONS";
        public const string Polls = "POLLS";
        public const string PrivateChat = "PRIVATE_CHAT";
        public const string Whiteboard = "WHITEBOARD";
        public const string BackgroundEffects = "BACKGROUND_EFFECTS";
        public const string NoiseSuppression = "NOISE_SUPPRESSION";
        public const string CameraFlip = "CAMERA_FLIP";
        /// <summary>Minutes of meeting written by people (V027, no AI). Not a room control: it shows on the meeting page.</summary>
        public const string MeetingMinutes = "MEETING_MINUTES";
        /// <summary>Chat workspace for employees (V028, 20 Nov 2026). Not a room control: it shows as "Chat" in the menu.</summary>
        public const string Chat = "CHAT";
        /// <summary>Audio calls from Chat (V029, 20 Nov 2026); needs CHAT on as well.</summary>
        public const string ChatCalls = "CHAT_CALLS";
        /// <summary>Personal notes, tasks, reminders and My Day in Chat (V030, 20 Nov 2026); needs CHAT on as well.</summary>
        public const string ChatTasks = "CHAT_TASKS";
        /// <summary>Advanced chat: scheduled / saved / pinned messages, @mentions, favourites, quiet hours (V031, 20 Nov 2026); needs CHAT on as well.</summary>
        public const string ChatAdvanced = "CHAT_ADVANCED";
        public static readonly string[] Features = [Reactions, Polls, PrivateChat, Whiteboard, BackgroundEffects, NoiseSuppression, CameraFlip, MeetingMinutes, Chat, ChatCalls, ChatTasks, ChatAdvanced];
    }

    sealed record SettingRow(string FeatureKey, bool IsEnabled, DateTime ModifiedUtc, string? ModifiedBy);

    /// <summary>Raw switches. A database without V026 (table missing) means every feature is off - never an error.</summary>
    static async Task<List<SettingRow>> SettingsAsync(IDbConnection c)
    {
        try
        {
            return (await c.QueryAsync<SettingRow>("""
                SELECT f.FeatureKey, f.IsEnabled, f.ModifiedUtc, COALESCE(e.DisplayName, u.Email) AS ModifiedBy
                FROM app.FeatureSettings f LEFT JOIN auth.Users u ON u.UserId = f.ModifiedByUserId LEFT JOIN org.Employees e ON e.EmployeeId = u.EmployeeId
                """)).ToList();
        }
        catch (SqlException e) when (e.Number == 208) { return []; }
    }

    /// <summary>What the room may use right now: a feature counts as on only if it is switched on AND the emergency switch is off.</summary>
    internal static async Task<HashSet<string>> EnabledAsync(IDbConnection c)
    {
        var rows = await SettingsAsync(c);
        if (rows.Any(r => r.FeatureKey == Keys.Emergency && r.IsEnabled)) return [];
        return rows.Where(r => r.IsEnabled && Keys.Features.Contains(r.FeatureKey)).Select(r => r.FeatureKey).ToHashSet();
    }

    static IResult Disabled() => Problems.Create(403, "FEATURE_DISABLED", "This feature is switched off by your administrator.");

    public static RouteGroupBuilder MapRoomFeatureEndpoints(this RouteGroupBuilder api)
    {
        // Booleans only (no secrets): the room asks once when it opens; guests have no session, hence anonymous + rate limit.
        api.MapGet("/room-features", RoomFeatures).RequireRateLimiting(GuestRateLimit);

        var admin = api.MapGroup("/admin/features").RequireAnyPermission("features.manage");
        admin.MapGet("", AdminList);
        admin.MapPut("/{key}", AdminSet);

        var e = api.MapGroup("/meetings/{id:guid}/room").RequireAnyPermission("meetings.view.own", "meetings.view.all");
        e.MapGet("/polls", (Guid id, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Polls, (c, w) => ListPolls(c, w)));
        e.MapPost("/polls", (Guid id, PollInput input, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Polls, (c, w) => CreatePoll(c, s, w, input, ctx)));
        e.MapPost("/polls/{pollId:guid}/close", (Guid id, Guid pollId, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Polls, (c, w) => ClosePoll(c, s, w, pollId, ctx)));
        e.MapPost("/polls/{pollId:guid}/vote", (Guid id, Guid pollId, VoteInput input, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Polls, (c, w) => Vote(c, s, w, pollId, input)));
        e.MapGet("/private", (Guid id, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.PrivateChat, (c, w) => ListPrivate(c, w)));
        e.MapPost("/private", (Guid id, PrivateInput input, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.PrivateChat, (c, w) => SendPrivate(c, s, w, input)));
        e.MapPost("/private/read", (Guid id, ReadInput input, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.PrivateChat, (c, w) => MarkRead(c, w, input)));
        e.MapGet("/whiteboard", (Guid id, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Whiteboard, (c, w) => GetBoard(c, w)));
        e.MapPost("/whiteboard/state", (Guid id, BoardStateInput input, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Whiteboard, (c, w) => SetBoardState(c, s, w, input, ctx)));
        e.MapPut("/whiteboard/scene", (Guid id, SceneInput input, RoomServices s, HttpContext ctx) => Employee(id, s, ctx, Keys.Whiteboard, (c, w) => SaveScene(c, w, input)));

        var g = api.MapGroup("/join/" + Tokens.LinkTokenRoute).RequireRateLimiting(GuestRateLimit);
        g.MapGet("/polls", (string token, RoomServices s, HttpContext ctx) => Guest(token, s, Keys.Polls, (c, w) => ListPolls(c, w)));
        g.MapPost("/polls/{pollId:guid}/vote", (string token, Guid pollId, VoteInput input, RoomServices s, HttpContext ctx) => Guest(token, s, Keys.Polls, (c, w) => Vote(c, s, w, pollId, input)));
        g.MapGet("/private", (string token, RoomServices s) => Guest(token, s, Keys.PrivateChat, (c, w) => ListPrivate(c, w)));
        g.MapPost("/private", (string token, PrivateInput input, RoomServices s) => Guest(token, s, Keys.PrivateChat, (c, w) => SendPrivate(c, s, w, input)));
        g.MapPost("/private/read", (string token, ReadInput input, RoomServices s) => Guest(token, s, Keys.PrivateChat, (c, w) => MarkRead(c, w, input)));
        g.MapGet("/whiteboard", (string token, RoomServices s) => Guest(token, s, Keys.Whiteboard, (c, w) => GetBoard(c, w)));
        g.MapPut("/whiteboard/scene", (string token, SceneInput input, RoomServices s) => Guest(token, s, Keys.Whiteboard, (c, w) => SaveScene(c, w, input)));
        return api;
    }

    // ---- Feature switches -------------------------------------------------------------------------------------------------

    static async Task<IResult> RoomFeatures(Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var on = await EnabledAsync(c);
        return Results.Ok(new
        {
            reactions = on.Contains(Keys.Reactions), polls = on.Contains(Keys.Polls), privateChat = on.Contains(Keys.PrivateChat),
            whiteboard = on.Contains(Keys.Whiteboard), backgroundEffects = on.Contains(Keys.BackgroundEffects),
            noiseSuppression = on.Contains(Keys.NoiseSuppression), cameraFlip = on.Contains(Keys.CameraFlip),
            meetingMinutes = on.Contains(Keys.MeetingMinutes),
        });
    }

    static async Task<IResult> AdminList(Db db, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var rows = await SettingsAsync(c);
        if (rows.Count == 0) return Problems.Create(409, "CONFLICT", "The meeting-features database update (V026) has not been applied on this server yet.");
        return Results.Ok(new { items = rows.Select(r => new { key = r.FeatureKey, enabled = r.IsEnabled, modifiedUtc = r.ModifiedUtc, modifiedBy = r.ModifiedBy }) });
    }

    public sealed record SetInput(bool Enabled);

    static async Task<IResult> AdminSet(string key, SetInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        key = (key ?? "").Trim().ToUpperInvariant();
        if (key != Keys.Emergency && !Keys.Features.Contains(key)) return Db_.NotFound("Feature");
        using var c = await db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var before = await c.QuerySingleOrDefaultAsync<bool?>("SELECT IsEnabled FROM app.FeatureSettings WHERE FeatureKey = @key", new { key });
        if (before is null) return Db_.NotFound("Feature");
        await c.ExecuteAsync("UPDATE app.FeatureSettings SET IsEnabled = @on, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user WHERE FeatureKey = @key",
            new { on = input.Enabled, user = me.UserId, key });
        if (before != input.Enabled)
            await Audit.WriteAsync(c, "USER", me.UserId, key == Keys.Emergency ? (input.Enabled ? "FEATURES_EMERGENCY_DISABLED" : "FEATURES_EMERGENCY_CLEARED") : "FEATURE_SETTING_CHANGED",
                "FeatureSetting", key, $"{key} switched {(input.Enabled ? "on" : "off")}", ClientInfo.From(ctx).Ip, privileged: true,
                newValues: new { key, enabled = input.Enabled, previous = before });
        return Results.NoContent();
    }

    // ---- Who is calling ----------------------------------------------------------------------------------------------------

    internal sealed record Who(RoomMeeting M, RoomParticipant P, long? UserId)
    {
        public bool IsHost => IsHostRole(P.Role);
        public bool InProgress => M.Status is "SCHEDULED" or "LIVE";
    }

    static async Task<IResult> Employee(Guid id, RoomServices s, HttpContext ctx, string feature, Func<IDbConnection, Who, Task<IResult>> run)
    {
        using var c = await s.Db.OpenAsync(ctx.RequestAborted);
        if (!(await EnabledAsync(c)).Contains(feature)) return Disabled();
        var (caller, error) = await CallerAsync(c, id, ctx, hostOnly: false);
        return caller is null ? error! : await run(c, new Who(caller.Meeting, caller.Participant!, caller.Me.UserId));
    }

    static async Task<IResult> Guest(string token, RoomServices s, string feature, Func<IDbConnection, Who, Task<IResult>> run)
    {
        using var c = await s.Db.OpenAsync();
        if (!(await EnabledAsync(c)).Contains(feature)) return Disabled();
        var g = await AdmittedGuestAsync(c, s, token);
        return g is null ? Problems.Create(403, "FORBIDDEN", "This is available once you are in the meeting.") : await run(c, new Who(g.Value.M, g.Value.P, null));
    }

    static IResult NotInProgress() => Db_.Conflict("This meeting is not in progress.");
    static IResult HostsOnly() => Problems.Create(403, "FORBIDDEN", "Only the host or a co-host can do this.");

    // ---- Polls (Yes/No) ------------------------------------------------------------------------------------------------------

    public sealed record PollInput(string? Question);
    public sealed record VoteInput(string? Answer);
    sealed record PollRow(long PollId, Guid PublicId, string Question, DateTime CreatedUtc, DateTime? ClosedUtc, int Yes, int No, string? Mine);

    static async Task<IResult> ListPolls(IDbConnection c, Who w)
    {
        var rows = await c.QueryAsync<PollRow>("""
            SELECT TOP (20) p.PollId, p.PublicId, p.Question, p.CreatedUtc, p.ClosedUtc,
                   (SELECT COUNT(*) FROM mtg.MeetingPollVotes v WHERE v.PollId = p.PollId AND v.Answer = 'YES') AS Yes,
                   (SELECT COUNT(*) FROM mtg.MeetingPollVotes v WHERE v.PollId = p.PollId AND v.Answer = 'NO') AS No,
                   (SELECT v.Answer FROM mtg.MeetingPollVotes v WHERE v.PollId = p.PollId AND v.ParticipantId = @me) AS Mine
            FROM mtg.MeetingPolls p WHERE p.MeetingId = @m ORDER BY p.PollId DESC
            """, new { m = w.M.MeetingId, me = w.P.ParticipantId });
        // Live results for everyone in the meeting (15 Nov 2026; until then only hosts saw them before the poll closed).
        return Results.Ok(new
        {
            canCreate = w.IsHost,
            items = rows.Select(r => new
            {
                id = r.PublicId, question = r.Question, createdUtc = r.CreatedUtc, closed = r.ClosedUtc is not null, myAnswer = r.Mine,
                results = new { yes = r.Yes, no = r.No, total = r.Yes + r.No },
            }),
        });
    }

    /// <summary>The newest poll of a meeting with its counts - carried in every poll signal so the recorder can draw it.</summary>
    static async Task<object?> PollSnapshotAsync(IDbConnection c, long meetingId)
    {
        var r = await c.QuerySingleOrDefaultAsync<(Guid PublicId, string Question, DateTime? ClosedUtc, int Yes, int No)?>("""
            SELECT TOP (1) p.PublicId, p.Question, p.ClosedUtc,
                   (SELECT COUNT(*) FROM mtg.MeetingPollVotes v WHERE v.PollId = p.PollId AND v.Answer = 'YES') AS Yes,
                   (SELECT COUNT(*) FROM mtg.MeetingPollVotes v WHERE v.PollId = p.PollId AND v.Answer = 'NO') AS No
            FROM mtg.MeetingPolls p WHERE p.MeetingId = @meetingId ORDER BY p.PollId DESC
            """, new { meetingId });
        return r is null ? null : new { id = r.Value.PublicId, question = r.Value.Question, closed = r.Value.ClosedUtc is not null, yes = r.Value.Yes, no = r.Value.No, total = r.Value.Yes + r.Value.No };
    }

    static async Task SignalPollAsync(IDbConnection c, RoomServices s, Who w) =>
        await s.Rooms.TrySendDataAsync(w.M.LiveKitRoomName, PollTopic, new { type = "poll-changed", poll = await PollSnapshotAsync(c, w.M.MeetingId) }, null, CancellationToken.None);

    static async Task<IResult> CreatePoll(IDbConnection c, RoomServices s, Who w, PollInput input, HttpContext ctx)
    {
        if (!w.IsHost) return HostsOnly();
        if (!w.InProgress) return NotInProgress();
        var q = CleanName(input.Question);
        var v = new Validator();
        if (q is null) v.Add("question", "Type a question.");
        else if (q.Length > PollQuestionMax) v.Add("question", $"A question can be at most {PollQuestionMax} characters.");
        if (!v.IsValid) return v.Problem();
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM mtg.MeetingPolls WHERE MeetingId = @m AND ClosedUtc IS NULL", new { m = w.M.MeetingId }) > 0)
            return Db_.Conflict("Close the current poll before starting a new one.");
        var id = await c.QuerySingleAsync<Guid>("""
            INSERT mtg.MeetingPolls (MeetingId, Question, CreatedByParticipantId) OUTPUT inserted.PublicId VALUES (@m, @q, @p)
            """, new { m = w.M.MeetingId, q, p = w.P.ParticipantId });
        await Audit.WriteAsync(c, "USER", w.UserId, "MEETING_POLL_CREATED", "Meeting", w.M.PublicId.ToString(), "Yes/No poll started", ClientInfo.From(ctx).Ip,
            newValues: new { pollId = id, question = q });
        await SignalPollAsync(c, s, w);
        return Results.Json(new { id }, statusCode: 201);
    }

    static async Task<IResult> ClosePoll(IDbConnection c, RoomServices s, Who w, Guid pollId, HttpContext ctx)
    {
        if (!w.IsHost) return HostsOnly();
        var n = await c.ExecuteAsync("UPDATE mtg.MeetingPolls SET ClosedUtc = SYSUTCDATETIME() WHERE PublicId = @pollId AND MeetingId = @m AND ClosedUtc IS NULL",
            new { pollId, m = w.M.MeetingId });
        if (n == 0) return Db_.Conflict("This poll is already closed or does not belong to this meeting.");
        await Audit.WriteAsync(c, "USER", w.UserId, "MEETING_POLL_CLOSED", "Meeting", w.M.PublicId.ToString(), "Yes/No poll closed", ClientInfo.From(ctx).Ip, newValues: new { pollId });
        await SignalPollAsync(c, s, w);
        return Results.NoContent();
    }

    static async Task<IResult> Vote(IDbConnection c, RoomServices s, Who w, Guid pollId, VoteInput input)
    {
        var answer = (input.Answer ?? "").Trim().ToUpperInvariant();
        if (answer is not ("YES" or "NO")) { var v = new Validator(); v.Add("answer", "Answer YES or NO."); return v.Problem(); }
        var poll = await c.QuerySingleOrDefaultAsync<(long PollId, DateTime? ClosedUtc)?>("SELECT PollId, ClosedUtc FROM mtg.MeetingPolls WHERE PublicId = @pollId AND MeetingId = @m",
            new { pollId, m = w.M.MeetingId });
        if (poll is null) return Db_.NotFound("Poll");
        if (poll.Value.ClosedUtc is not null) return Db_.Conflict("This poll is closed.");
        try
        {
            await c.ExecuteAsync("INSERT mtg.MeetingPollVotes (PollId, ParticipantId, Answer) VALUES (@poll, @p, @answer)", new { poll = poll.Value.PollId, p = w.P.ParticipantId, answer });
        }
        catch (SqlException e) when (e.Number is 2627 or 2601) { return Db_.Conflict("You have already answered this poll."); }
        await SignalPollAsync(c, s, w); // everyone sees live results now, so everyone (and the recorder) is told
        return Results.NoContent();
    }

    // ---- Private 1:1 messages ------------------------------------------------------------------------------------------------

    public sealed record PrivateInput(string? ToIdentity, string? Body);
    public sealed record ReadInput(string? WithIdentity);
    sealed record PrivateRow(long MessageId, string FromIdentity, string FromName, string ToIdentity, string ToName, string Body, DateTime SentUtc, DateTime? ReadUtc);

    const string PrivateSelect = """
        SELECT pm.MessageId, sp.LiveKitIdentity AS FromIdentity, COALESCE(se.DisplayName, sc.FullName, sp.GuestName) AS FromName,
               rp.LiveKitIdentity AS ToIdentity, COALESCE(re.DisplayName, rc.FullName, rp.GuestName) AS ToName, pm.Body, pm.SentUtc, pm.ReadUtc
        FROM mtg.PrivateMessages pm
        JOIN mtg.MeetingParticipants sp ON sp.ParticipantId = pm.SenderParticipantId
        LEFT JOIN org.Employees se ON se.EmployeeId = sp.EmployeeId LEFT JOIN crm.Customers sc ON sc.CustomerId = sp.CustomerId
        JOIN mtg.MeetingParticipants rp ON rp.ParticipantId = pm.RecipientParticipantId
        LEFT JOIN org.Employees re ON re.EmployeeId = rp.EmployeeId LEFT JOIN crm.Customers rc ON rc.CustomerId = rp.CustomerId
        """;

    static object Dto(PrivateRow r) => new
    {
        id = r.MessageId, fromIdentity = r.FromIdentity, fromName = r.FromName, toIdentity = r.ToIdentity, toName = r.ToName, body = r.Body, sentUtc = r.SentUtc, read = r.ReadUtc is not null,
    };

    /// <summary>Only the caller's own conversations: messages they sent or received. Nobody else - the host included - can list them.</summary>
    static async Task<IResult> ListPrivate(IDbConnection c, Who w)
    {
        var rows = await c.QueryAsync<PrivateRow>($"""
            SELECT x.* FROM (SELECT TOP (500) q.* FROM ({PrivateSelect}
                WHERE pm.MeetingId = @m AND (pm.SenderParticipantId = @me OR pm.RecipientParticipantId = @me)) q ORDER BY q.MessageId DESC) x
            ORDER BY x.MessageId
            """, new { m = w.M.MeetingId, me = w.P.ParticipantId });
        return Results.Ok(new { me = w.P.Identity, items = rows.Select(Dto) });
    }

    static async Task<IResult> SendPrivate(IDbConnection c, RoomServices s, Who w, PrivateInput input)
    {
        var body = CleanChat(input.Body);
        var v = new Validator();
        if (body is null) v.Add("body", "Type a message.");
        else if (body.Length > ChatMaxLength) v.Add("body", $"A message can be at most {ChatMaxLength} characters.");
        if (string.IsNullOrWhiteSpace(input.ToIdentity) || input.ToIdentity.Length > 100) v.Add("toIdentity", "Choose who to send the message to.");
        if (!v.IsValid) return v.Problem();
        if (!w.InProgress) return NotInProgress();
        // The recipient must be a (not removed) participant of THIS meeting - never someone in another meeting.
        var to = await c.QuerySingleOrDefaultAsync<long?>("""
            SELECT ParticipantId FROM mtg.MeetingParticipants WHERE MeetingId = @m AND LiveKitIdentity = @identity AND IsBlocked = 0
            """, new { m = w.M.MeetingId, identity = input.ToIdentity!.Trim() });
        if (to is null) return Db_.NotFound("Participant");
        if (to == w.P.ParticipantId) { var v2 = new Validator(); v2.Add("toIdentity", "You cannot send a private message to yourself."); return v2.Problem(); }
        var id = await c.QuerySingleAsync<long>("""
            INSERT mtg.PrivateMessages (MeetingId, SenderParticipantId, RecipientParticipantId, Body) OUTPUT inserted.MessageId VALUES (@m, @from, @to, @body)
            """, new { m = w.M.MeetingId, from = w.P.ParticipantId, to, body });
        var row = await c.QuerySingleAsync<PrivateRow>($"{PrivateSelect} WHERE pm.MessageId = @id", new { id });
        // Live delivery from the server to exactly two identities (recipient + sender's other tabs). LiveKit routes it to no one else.
        await s.Rooms.TrySendDataAsync(w.M.LiveKitRoomName, PrivateTopic, Dto(row), [row.ToIdentity, row.FromIdentity], CancellationToken.None);
        return Results.Json(Dto(row), statusCode: 201);
    }

    static async Task<IResult> MarkRead(IDbConnection c, Who w, ReadInput input)
    {
        if (string.IsNullOrWhiteSpace(input.WithIdentity)) return Results.NoContent();
        await c.ExecuteAsync("""
            UPDATE pm SET ReadUtc = SYSUTCDATETIME()
            FROM mtg.PrivateMessages pm JOIN mtg.MeetingParticipants sp ON sp.ParticipantId = pm.SenderParticipantId
            WHERE pm.MeetingId = @m AND pm.RecipientParticipantId = @me AND pm.ReadUtc IS NULL AND sp.LiveKitIdentity = @with
            """, new { m = w.M.MeetingId, me = w.P.ParticipantId, with = input.WithIdentity.Trim() });
        return Results.NoContent();
    }

    // ---- Whiteboard ----------------------------------------------------------------------------------------------------------

    public sealed record BoardStateInput(bool? Open, string? DrawMode, string[]? Allowed);
    public sealed record SceneInput(int BaseVersion, string? Scene);
    sealed record BoardRow(bool IsOpen, string DrawMode, string? AllowedJson, string? SceneJson, int Version);

    static string[] Allowed(string? json)
    {
        try { return string.IsNullOrEmpty(json) ? [] : JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }

    static bool CanDraw(Who w, BoardRow b) => w.IsHost || b.DrawMode == "EVERYONE" || (b.DrawMode == "SELECTED" && Allowed(b.AllowedJson).Contains(w.P.Identity));

    static async Task<BoardRow> BoardAsync(IDbConnection c, long meetingId) =>
        await c.QuerySingleOrDefaultAsync<BoardRow>("SELECT IsOpen, DrawMode, AllowedJson, SceneJson, [Version] FROM mtg.MeetingWhiteboards WHERE MeetingId = @meetingId", new { meetingId })
        ?? new BoardRow(false, DefaultDrawMode, null, null, 0);

    /// <summary>15 Nov 2026: a board opens with drawing for everyone in the meeting; the host can still restrict it.</summary>
    const string DefaultDrawMode = "EVERYONE";

    static async Task<IResult> GetBoard(IDbConnection c, Who w)
    {
        var b = await BoardAsync(c, w.M.MeetingId);
        return Results.Ok(new { isOpen = b.IsOpen, drawMode = b.DrawMode, allowed = Allowed(b.AllowedJson), scene = b.SceneJson, version = b.Version, canDraw = CanDraw(w, b), canManage = w.IsHost });
    }

    static async Task<IResult> SetBoardState(IDbConnection c, RoomServices s, Who w, BoardStateInput input, HttpContext ctx)
    {
        if (!w.IsHost) return HostsOnly();
        if (!w.InProgress) return NotInProgress();
        var mode = input.DrawMode is null ? null : input.DrawMode.Trim().ToUpperInvariant();
        if (mode is not null and not ("HOSTS" or "EVERYONE" or "SELECTED")) { var v = new Validator(); v.Add("drawMode", "Draw mode must be HOSTS, EVERYONE or SELECTED."); return v.Problem(); }
        var allowed = input.Allowed?.Where(x => !string.IsNullOrWhiteSpace(x) && x.Length <= 100).Select(x => x.Trim()).Distinct().Take(100).ToArray();
        var b = await BoardAsync(c, w.M.MeetingId);
        var next = b with { IsOpen = input.Open ?? b.IsOpen, DrawMode = mode ?? b.DrawMode, AllowedJson = allowed is null ? b.AllowedJson : JsonSerializer.Serialize(allowed) };
        await c.ExecuteAsync("""
            MERGE mtg.MeetingWhiteboards AS t USING (SELECT @m AS MeetingId) AS src ON t.MeetingId = src.MeetingId
            WHEN MATCHED THEN UPDATE SET IsOpen = @open, DrawMode = @mode, AllowedJson = @allowed, UpdatedUtc = SYSUTCDATETIME(), UpdatedByParticipantId = @p
            WHEN NOT MATCHED THEN INSERT (MeetingId, IsOpen, DrawMode, AllowedJson, UpdatedByParticipantId) VALUES (@m, @open, @mode, @allowed, @p);
            """, new { m = w.M.MeetingId, open = next.IsOpen, mode = next.DrawMode, allowed = next.AllowedJson, p = w.P.ParticipantId });
        var action = next.IsOpen != b.IsOpen ? (next.IsOpen ? "WHITEBOARD_OPENED" : "WHITEBOARD_CLOSED") : "WHITEBOARD_ACCESS_CHANGED";
        await Audit.WriteAsync(c, "USER", w.UserId, action, "Meeting", w.M.PublicId.ToString(), action switch
        {
            "WHITEBOARD_OPENED" => "Whiteboard opened", "WHITEBOARD_CLOSED" => "Whiteboard closed", _ => "Whiteboard drawing access changed",
        }, ClientInfo.From(ctx).Ip, newValues: new { isOpen = next.IsOpen, drawMode = next.DrawMode, allowed = Allowed(next.AllowedJson) });
        // Sent by the server, so clients can trust who may draw (a participant cannot forge a server message).
        await s.Rooms.TrySendDataAsync(w.M.LiveKitRoomName, WhiteboardStateTopic, new { isOpen = next.IsOpen, drawMode = next.DrawMode, allowed = Allowed(next.AllowedJson) }, null, CancellationToken.None);
        // A recording in progress draws the board too: on (re)opening, hand the recorder the saved drawing (participants load it themselves).
        if (next.IsOpen && !b.IsOpen)
        {
            var recorders = await RecorderIdentitiesAsync(s.Rooms, w.M.LiveKitRoomName);
            if (recorders.Length > 0) await SendSceneAsync(s.Rooms, w.M.LiveKitRoomName, next, recorders, CancellationToken.None);
        }
        return Results.NoContent();
    }

    // ---- Recorder (15 Nov 2026: the recording shows the whiteboard and polls) -------------------------------------------------
    // The hidden recorder (identity "oic-recorder-<job>") hears live strokes and poll signals like everyone else. What it cannot
    // hear is the state from before it joined - so the server sends it that state, only to the recorder's identity, whenever it starts
    // a segment (RecorderWorker) and when the board is reopened. Server-sent data has no participant, so nobody in the meeting can forge it.

    public const string RecorderIdentityPrefix = "oic-recorder-";
    public const string RecorderSceneTopic = "oic.rec-scene";
    const int SceneChunkChars = 12_000; // keeps each LiveKit data message well under its packet limit

    static async Task<string[]> RecorderIdentitiesAsync(LiveKitRoomService rooms, string room)
    {
        try { return [.. (await rooms.ListParticipantIdentitiesAsync(room, CancellationToken.None)).Where(i => i.StartsWith(RecorderIdentityPrefix, StringComparison.Ordinal))]; }
        catch (LiveKitUnavailableException) { return []; }
    }

    static async Task SendSceneAsync(LiveKitRoomService rooms, string room, BoardRow b, string[] to, CancellationToken ct)
    {
        var scene = b.SceneJson ?? "";
        var parts = Math.Max(1, (scene.Length + SceneChunkChars - 1) / SceneChunkChars);
        var id = Guid.NewGuid().ToString("N")[..12];
        for (var i = 0; i < parts; i++)
        {
            var from = i * SceneChunkChars;
            var data = from >= scene.Length ? "" : scene.Substring(from, Math.Min(SceneChunkChars, scene.Length - from));
            await rooms.TrySendDataAsync(room, RecorderSceneTopic, new { id, part = i, parts, data }, to, ct);
        }
    }

    /// <summary>Called when a recorder starts a segment (the first, and after every restart): the current board and poll, to that recorder only.</summary>
    internal static async Task SendRecorderSnapshotAsync(Db db, LiveKitRoomService rooms, string room, string identity, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var on = await EnabledAsync(c);
        if (!on.Contains(Keys.Whiteboard) && !on.Contains(Keys.Polls)) return;
        var meetingId = await c.QuerySingleOrDefaultAsync<long?>("SELECT MeetingId FROM mtg.Meetings WHERE LiveKitRoomName = @room", new { room });
        if (meetingId is null) return;
        string[] to = [identity];
        if (on.Contains(Keys.Whiteboard))
        {
            var b = await BoardAsync(c, meetingId.Value);
            await rooms.TrySendDataAsync(room, WhiteboardStateTopic, new { isOpen = b.IsOpen, drawMode = b.DrawMode, allowed = Allowed(b.AllowedJson) }, to, ct);
            if (b.IsOpen) await SendSceneAsync(rooms, room, b, to, ct);
        }
        if (on.Contains(Keys.Polls) && await PollSnapshotAsync(c, meetingId.Value) is { } poll)
            await rooms.TrySendDataAsync(room, PollTopic, new { type = "poll-changed", poll }, to, ct);
    }

    /// <summary>Saves the latest scene for late joiners and reconnects (the live strokes travel browser-to-browser over LiveKit).</summary>
    static async Task<IResult> SaveScene(IDbConnection c, Who w, SceneInput input)
    {
        if (!w.InProgress) return NotInProgress();
        var b = await BoardAsync(c, w.M.MeetingId);
        if (!b.IsOpen) return Db_.Conflict("The whiteboard is closed.");
        if (!CanDraw(w, b)) return Problems.Create(403, "FORBIDDEN", "The host has not given you drawing access.");
        if (input.Scene is null || input.Scene.Length > SceneMaxChars) { var v = new Validator(); v.Add("scene", "The drawing is too large to save. Clear part of the board."); return v.Problem(); }
        try { using var _ = JsonDocument.Parse(input.Scene); }
        catch (JsonException) { var v = new Validator(); v.Add("scene", "The drawing could not be read."); return v.Problem(); }
        var version = await c.QuerySingleAsync<int>("""
            UPDATE mtg.MeetingWhiteboards SET SceneJson = @scene, [Version] = [Version] + 1, UpdatedUtc = SYSUTCDATETIME(), UpdatedByParticipantId = @p
            OUTPUT inserted.[Version] WHERE MeetingId = @m
            """, new { scene = input.Scene, p = w.P.ParticipantId, m = w.M.MeetingId });
        return Results.Ok(new { version });
    }
}
