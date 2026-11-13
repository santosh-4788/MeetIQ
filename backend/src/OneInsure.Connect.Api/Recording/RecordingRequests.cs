using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Recording;

internal sealed record RequestRow(long RequestId, Guid PublicId, long MeetingId, long RequestedByParticipantId, long? RequestedByUserId, string NoticeVersion,
    string Status, DateTime CreatedUtc, DateTime ExpiresUtc, DateTime? ClosedUtc, string? CloseReason, string? RequestedByName);

internal sealed record RequestMember(long ParticipantId, string Identity, string Name, string Type, string Role, string? Decision);

/// <summary>One person in an open request as everyone sees it: GRANTED, DENIED, PENDING (in the room, not answered yet) or
/// DISCONNECTED (not in the room and not answered - never counted as accepted).</summary>
internal sealed record RequestMemberView(long ParticipantId, string Identity, string Name, string Type, string Status);

internal sealed record RequestView(RequestRow Request, List<RequestMemberView> Members, object Body);

/// <summary>
/// Recording consent requests (V020). When a host starts recording in a live meeting whose policy needs consent from everyone and
/// someone has not given it, a request is opened instead of refusing: every participant is asked (popup driven by the server's state,
/// so guests and people who join or reconnect while it is pending are asked too), the host sees each person's answer, one Decline
/// closes the request, and when everyone in it has accepted the existing recorder is started exactly as before (StartAsync).
/// The consent evidence itself stays in mtg.MeetingConsent (append-only); a request only links each answer to it.
/// </summary>
public sealed partial class RecordingService
{
    /// <summary>One request decision at a time (a single API instance): two participants accepting at the same moment can never
    /// start two recorders, and a request can never be both started and declined.</summary>
    static readonly SemaphoreSlim RequestGate = new(1, 1);

    internal const string RequestSelect = """
        SELECT r.RequestId, r.PublicId, r.MeetingId, r.RequestedByParticipantId, r.RequestedByUserId, r.NoticeVersion, r.[Status], r.CreatedUtc, r.ExpiresUtc,
               r.ClosedUtc, r.CloseReason, COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS RequestedByName
        FROM rec.RecordingRequests r
        JOIN mtg.MeetingParticipants p ON p.ParticipantId = r.RequestedByParticipantId
        LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
        LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
        """;

    /// <summary>The meeting's open request, or null. A request whose meeting is no longer live, or that has waited longer than
    /// Recording:ConsentRequestMinutes, is closed here (CANCELLED / EXPIRED) and everyone is told.</summary>
    internal async Task<RequestRow?> OpenRequestAsync(IDbConnection c, RecMeeting m, CancellationToken ct)
    {
        var r = await c.QuerySingleOrDefaultAsync<RequestRow>(RequestSelect + " WHERE r.MeetingId = @m AND r.[Status] = 'OPEN'", new { m = m.MeetingId });
        if (r is null) return null;
        if (m.Status != "LIVE")
        {
            await CloseRequestAsync(c, m, r, "CANCELLED", "The meeting is no longer in progress.", null, null, ct);
            return null;
        }
        if (DateTime.SpecifyKind(r.ExpiresUtc, DateTimeKind.Utc) <= Clock.UtcNow)
        {
            await CloseRequestAsync(c, m, r, "EXPIRED", $"Not everyone answered within {O.ConsentRequestMinutes} minutes.", null, null, ct);
            return null;
        }
        return r;
    }

    internal sealed record ClosedRequest(Guid Id, string Status, string? Reason, DateTime? ClosedUtc);

    internal static Task<ClosedRequest?> LastClosedRequestAsync(IDbConnection c, long meetingId) =>
        c.QuerySingleOrDefaultAsync<ClosedRequest?>("""
            SELECT TOP (1) PublicId AS Id, [Status] AS Status, CloseReason AS Reason, ClosedUtc
            FROM rec.RecordingRequests WHERE MeetingId = @meetingId AND [Status] <> 'OPEN' ORDER BY RequestId DESC
            """, new { meetingId });

    /// <summary>Closes an open request (first writer wins), audits it and tells everyone in the room. False if it was already closed.</summary>
    internal async Task<bool> CloseRequestAsync(IDbConnection c, RecMeeting m, RequestRow r, string status, string reason, long? userId, string? ip, CancellationToken ct,
        long? recordingId = null, string? actorType = null)
    {
        var n = await c.ExecuteAsync("""
            UPDATE rec.RecordingRequests SET [Status] = @status, ClosedUtc = SYSUTCDATETIME(), CloseReason = @reason, RecordingId = COALESCE(@recordingId, RecordingId)
            WHERE RequestId = @id AND [Status] = 'OPEN'
            """, new { id = r.RequestId, status, reason = reason.Length > 400 ? reason[..400] : reason, recordingId });
        if (n == 0) return false;
        await Audit.WriteAsync(c, actorType ?? (userId is null ? "SYSTEM" : "USER"), userId, "RECORDING_REQUEST_" + status, "Meeting", m.PublicId.ToString(),
            $"Recording request {status.ToLowerInvariant()}: {reason}", ip, null, newValues: new { request = r.PublicId, status, reason });
        await BroadcastAsync(c, Rooms, m.MeetingId, ct);
        await Rooms.TrySendDataAsync(m.LiveKitRoomName, Topic, new { type = "consent-request-closed", requestId = r.PublicId, status, reason }, null, ct);
        return true;
    }

    internal static async Task<List<RequestMember>> MembersAsync(IDbConnection c, long requestId) =>
        (await c.QueryAsync<RequestMember>("""
            SELECT p.ParticipantId, p.LiveKitIdentity AS [Identity], COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name, p.ParticipantType AS Type, p.[Role], x.Decision
            FROM rec.RecordingRequestParticipants x
            JOIN mtg.MeetingParticipants p ON p.ParticipantId = x.ParticipantId
            LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId
            LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
            WHERE x.RequestId = @requestId
            ORDER BY x.AddedUtc, p.ParticipantId
            """, new { requestId })).ToList();

    /// <summary>Adds everyone now in the room who is not yet part of the request (people who joined while it is pending). Someone who
    /// already has a current GRANTED consent for this notice version counts as accepted (they can withdraw it at any time).</summary>
    async Task SyncMembersAsync(IDbConnection c, RecMeeting m, RequestRow r, IReadOnlySet<string> present)
    {
        if (present.Count == 0) return;
        var known = (await c.QueryAsync<long>("SELECT ParticipantId FROM rec.RecordingRequestParticipants WHERE RequestId = @r", new { r = r.RequestId })).ToHashSet();
        foreach (var p in (await ConsentRowsAsync(c, m.MeetingId, r.NoticeVersion)).Where(x => present.Contains(x.Identity) && !known.Contains(x.ParticipantId)))
        {
            try
            {
                await c.ExecuteAsync("""
                    INSERT rec.RecordingRequestParticipants (RequestId, ParticipantId, Decision, DecisionUtc, ConsentId)
                    SELECT @r, @p, CASE WHEN @granted = 1 THEN 'GRANTED' END, CASE WHEN @granted = 1 THEN SYSUTCDATETIME() END,
                           CASE WHEN @granted = 1 THEN (SELECT TOP (1) ConsentId FROM mtg.MeetingConsent WHERE MeetingId = @m AND ParticipantId = @p AND ConsentType = 'RECORDING'
                                AND NoticeVersion = @v ORDER BY DecisionUtc DESC, ConsentId DESC) END
                    WHERE NOT EXISTS (SELECT 1 FROM rec.RecordingRequestParticipants WHERE RequestId = @r AND ParticipantId = @p)
                    """, new { r = r.RequestId, p = p.ParticipantId, m = m.MeetingId, v = r.NoticeVersion, granted = p.Decision == "GRANTED" });
            }
            catch (SqlException e) when (e.IsUniqueViolation()) { /* added by a concurrent call */ }
        }
    }

    static string MemberStatus(RequestMember x, IReadOnlySet<string> present) =>
        x.Decision switch { "GRANTED" => "GRANTED", "DENIED" => "DENIED", _ => present.Contains(x.Identity) ? "PENDING" : "DISCONNECTED" };

    /// <summary>The open request as the caller sees it (null if none): hosts get every person's status; everyone gets their own answer.</summary>
    internal async Task<RequestView?> RequestViewAsync(IDbConnection c, RecMeeting m, RecParticipant? me, bool isHost, CancellationToken ct)
    {
        var r = await OpenRequestAsync(c, m, ct);
        if (r is null) return null;
        var present = await PresentAsync(c, m, ct);
        await SyncMembersAsync(c, m, r, present);
        var members = (await MembersAsync(c, r.RequestId)).Select(x => new RequestMemberView(x.ParticipantId, x.Identity, x.Name, x.Type, MemberStatus(x, present))).ToList();
        var mine = me is null ? null : members.FirstOrDefault(x => x.ParticipantId == me.ParticipantId);
        object body = new
        {
            id = r.PublicId, status = r.Status, createdUtc = r.CreatedUtc, expiresUtc = r.ExpiresUtc, requestedBy = r.RequestedByName,
            isRequester = me is not null && me.ParticipantId == r.RequestedByParticipantId,
            myDecision = mine?.Status is "GRANTED" or "DENIED" ? mine.Status : null,
            total = members.Count, accepted = members.Count(x => x.Status == "GRANTED"),
            participants = isHost ? members.Select(x => new { identity = x.Identity, name = x.Name, type = x.Type, status = x.Status }) : null,
        };
        return new RequestView(r, members, body);
    }

    /// <summary>Opens the meeting's consent request (or returns the one already open), with the host's own acceptance, and asks
    /// everyone in the room. Returns the request's public id.</summary>
    async Task<Guid> OpenOrCreateRequestAsync(IDbConnection c, RecMeeting m, RecParticipant starter, long? userId, PolicyRow p, HashSet<string> present, string? ip, CancellationToken ct)
    {
        RequestRow r;
        await RequestGate.WaitAsync(ct);
        try
        {
            if (await OpenRequestAsync(c, m, ct) is { } open) r = open;
            else
            {
                try
                {
                    await c.ExecuteAsync("""
                        INSERT rec.RecordingRequests (MeetingId, RequestedByParticipantId, RequestedByUserId, PolicyCode, NoticeVersion, ExpiresUtc)
                        VALUES (@m, @p, @userId, @code, @version, @expires)
                        """, new { m = m.MeetingId, p = starter.ParticipantId, userId, code = p.PolicyCode, version = p.NoticeVersion, expires = Clock.UtcNow.AddMinutes(Math.Max(1, O.ConsentRequestMinutes)) });
                }
                catch (SqlException e) when (e.IsUniqueViolation()) { /* another host opened one at the same moment: use it */ }
                r = (await c.QuerySingleOrDefaultAsync<RequestRow>(RequestSelect + " WHERE r.MeetingId = @m AND r.[Status] = 'OPEN'", new { m = m.MeetingId }))!;
                await Audit.WriteAsync(c, userId is null ? "SYSTEM" : "USER", userId, "RECORDING_REQUESTED", "Meeting", m.PublicId.ToString(),
                    "Host requested recording; waiting for every participant to accept", ip, null, newValues: new { request = r.PublicId, noticeVersion = p.NoticeVersion });
            }
            // The host accepted the notice when pressing Start, so they are in the request as accepted.
            await SyncMembersAsync(c, m, r, new HashSet<string>(present, StringComparer.Ordinal) { starter.Identity });
        }
        finally
        {
            RequestGate.Release();
        }
        await BroadcastAsync(c, Rooms, m.MeetingId, ct);
        // Everyone in the room (no destination list): each client then reads the request from the server and decides whether to ask.
        await Rooms.TrySendDataAsync(m.LiveKitRoomName, Topic, new { type = "consent-requested", requestId = r.PublicId, noticeVersion = r.NoticeVersion }, null, ct);
        return r.PublicId;
    }

    /// <summary>A participant answered while a request is open: record it on the request; Decline closes the request; an
    /// acceptance may complete it (then recording starts).</summary>
    internal async Task AnswerRequestAsync(IDbConnection c, RecMeeting m, RecParticipant p, string decision, long consentId, string actorType, long? userId, string? ip, CancellationToken ct)
    {
        var answer = decision == "GRANTED" ? "GRANTED" : "DENIED";
        await RequestGate.WaitAsync(ct);
        try
        {
            var r = await OpenRequestAsync(c, m, ct);
            if (r is null) return; // nothing pending (or it was just started/closed - a decline then stops a running recording as before)
            await c.ExecuteAsync("""
                UPDATE rec.RecordingRequestParticipants SET Decision = @answer, DecisionUtc = SYSUTCDATETIME(), ConsentId = @consentId WHERE RequestId = @r AND ParticipantId = @p;
                IF @@ROWCOUNT = 0
                    INSERT rec.RecordingRequestParticipants (RequestId, ParticipantId, Decision, DecisionUtc, ConsentId) VALUES (@r, @p, @answer, SYSUTCDATETIME(), @consentId);
                """, new { r = r.RequestId, p = p.ParticipantId, answer, consentId });
            if (answer == "DENIED")
            {
                await CloseRequestAsync(c, m, r, "DECLINED", $"{p.Name} declined recording.", userId, ip, ct, actorType: actorType);
                return;
            }
        }
        finally
        {
            RequestGate.Release();
        }
        await EvaluateRequestAsync(c, m, ct);
    }

    /// <summary>
    /// The host takes someone who has LEFT out of the open request (e.g. a link guest who rejoined - a new participant, so the old
    /// entry would stay "Disconnected" for ever). Only a person who is not in the room and has not accepted can be removed; they are
    /// not counted as accepted - they are simply no longer required, and are asked again if they come back. Audited.
    /// Returns null on success, or a problem message.
    /// </summary>
    internal async Task<string?> RemoveRequestMemberAsync(IDbConnection c, RecMeeting m, string identity, long? userId, string? ip, CancellationToken ct)
    {
        await RequestGate.WaitAsync(ct);
        try
        {
            var r = await OpenRequestAsync(c, m, ct);
            if (r is null) return "There is no pending recording request.";
            var present = await PresentAsync(c, m, ct);
            if (present.Contains(identity)) return "This person is in the meeting; only people who have left can be removed from the request.";
            var member = (await MembersAsync(c, r.RequestId)).FirstOrDefault(x => x.Identity == identity);
            if (member is null) return "This person is not part of the recording request.";
            if (member.Decision == "GRANTED") return "This person has already accepted.";
            await c.ExecuteAsync("DELETE rec.RecordingRequestParticipants WHERE RequestId = @r AND ParticipantId = @p", new { r = r.RequestId, p = member.ParticipantId });
            await Audit.WriteAsync(c, "USER", userId, "RECORDING_REQUEST_MEMBER_REMOVED", "Meeting", m.PublicId.ToString(),
                $"Host removed {member.Name} (disconnected, not accepted) from the recording request", ip, null, newValues: new { request = r.PublicId, participant = identity });
        }
        finally
        {
            RequestGate.Release();
        }
        await EvaluateRequestAsync(c, m, ct);
        return null;
    }

    /// <summary>Starts recording when everyone in the open request has accepted (and nobody is pending or disconnected); otherwise
    /// tells the room that the answers changed so the host's status panel updates at once.</summary>
    internal async Task EvaluateRequestAsync(IDbConnection c, RecMeeting m, CancellationToken ct)
    {
        await RequestGate.WaitAsync(ct);
        try
        {
            var r = await OpenRequestAsync(c, m, ct);
            if (r is null) return;
            var present = await PresentAsync(c, m, ct);
            await SyncMembersAsync(c, m, r, present);
            var members = await MembersAsync(c, r.RequestId);
            if (members.Count == 0 || members.Any(x => x.Decision != "GRANTED"))
            {
                await Rooms.TrySendDataAsync(m.LiveKitRoomName, Topic, new { type = "consent-changed", requestId = r.PublicId }, null, ct);
                return;
            }
            var starter = await c.QuerySingleOrDefaultAsync<RecParticipant>("""
                SELECT p.ParticipantId, p.LiveKitIdentity AS [Identity], p.[Role], p.ParticipantType AS Type, COALESCE(e.DisplayName, cu.FullName, p.GuestName) AS Name
                FROM mtg.MeetingParticipants p LEFT JOIN org.Employees e ON e.EmployeeId = p.EmployeeId LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
                WHERE p.ParticipantId = @id
                """, new { id = r.RequestedByParticipantId });
            var result = await StartAsync(c, m, starter, r.RequestedByUserId, false, null, null, ct, fromRequestId: r.RequestId);
            if (result.RecordingId is { } recording)
            {
                var recordingId = await c.ExecuteScalarAsync<long>("SELECT RecordingId FROM rec.MeetingRecordings WHERE PublicId = @recording", new { recording });
                await CloseRequestAsync(c, m, r, "STARTED", "Every participant accepted; recording is starting.", r.RequestedByUserId, null, ct, recordingId);
            }
            else if (result.Code == "CONSENT_MISSING")
                // Someone joined between the check and the start: they are added and asked; the request stays open.
                await Rooms.TrySendDataAsync(m.LiveKitRoomName, Topic, new { type = "consent-changed", requestId = r.PublicId }, null, ct);
            else
                await CloseRequestAsync(c, m, r, "FAILED", result.Message, r.RequestedByUserId, null, ct);
        }
        finally
        {
            RequestGate.Release();
        }
    }
}
