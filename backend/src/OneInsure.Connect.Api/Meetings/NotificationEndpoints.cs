using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>/api/v1/notifications (notification centre) and the public, anonymous GET /api/v1/join/{token}.</summary>
public static class NotificationEndpoints
{
    public const string JoinRateLimit = "join";

    sealed record Row(Guid Id, string Type, string Title, string? Body, string? LinkPath, bool IsRead, DateTime CreatedUtc, DateTime? ReadUtc);
    sealed record JoinRow(string Title, string Organiser, DateTime StartUtc, DateTime EndUtc, string TimeZoneId, string Status, string MeetingCode, bool WaitingRoomEnabled,
        string ParticipantType, string? DisplayName);

    public static RouteGroupBuilder MapNotificationEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/notifications").RequirePermission("notifications.view");

        g.MapGet("", async (bool? unreadOnly, int? page, int? pageSize, Db db, HttpContext ctx) =>
        {
            var size = Math.Clamp(pageSize ?? 20, 5, 100);
            var p = Math.Max(page ?? 1, 1);
            using var c = await db.OpenAsync();
            using var multi = await c.QueryMultipleAsync("""
                SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @user AND (@unread = 0 OR IsRead = 0);
                SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @user AND IsRead = 0;
                SELECT PublicId AS Id, [Type], Title, Body, LinkPath, IsRead, CreatedUtc, ReadUtc FROM mtg.MeetingNotifications
                WHERE RecipientUserId = @user AND (@unread = 0 OR IsRead = 0)
                ORDER BY CreatedUtc DESC, NotificationId DESC OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
                """, new { user = ctx.User.UserId(), unread = unreadOnly == true, skip = (p - 1) * size, size });
            var total = await multi.ReadSingleAsync<int>();
            var unreadCount = await multi.ReadSingleAsync<int>();
            var items = (await multi.ReadAsync<Row>()).ToList();
            return Results.Ok(new { items, total, pageNumber = p, pageSize = size, unreadCount });
        });

        g.MapGet("/unread-count", async (Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            return Results.Ok(new { unreadCount = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM mtg.MeetingNotifications WHERE RecipientUserId = @user AND IsRead = 0", new { user = ctx.User.UserId() }) });
        });

        g.MapPost("/{id:guid}/read", async (Guid id, Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync("""
                UPDATE mtg.MeetingNotifications SET IsRead = 1, ReadUtc = COALESCE(ReadUtc, SYSUTCDATETIME()) WHERE PublicId = @id AND RecipientUserId = @user
                """, new { id, user = ctx.User.UserId() });
            if (n == 0) return Db_.NotFound("Notification");
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "NOTIFICATION_READ", "Notification", id.ToString(), "Notification marked as read", ClientInfo.From(ctx).Ip);
            return Results.NoContent();
        });

        g.MapPost("/read-all", async (Db db, HttpContext ctx) =>
        {
            using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync("UPDATE mtg.MeetingNotifications SET IsRead = 1, ReadUtc = SYSUTCDATETIME() WHERE RecipientUserId = @user AND IsRead = 0",
                new { user = ctx.User.UserId() });
            if (n > 0)
                await Audit.WriteAsync(c, "USER", ctx.User.UserId(), "NOTIFICATIONS_READ_ALL", "Notification", null, $"{n} notification(s) marked as read", ClientInfo.From(ctx).Ip);
            return Results.Ok(new { marked = n });
        });

        // Customers and guests open their e-mailed link. Only non-sensitive facts are returned; joining the call: RoomEndpoints (/join/{token}/enter).
        api.MapGet("/join/{token}", async (string token, Db db, IClock clock, IOptions<MeetingOptions> mo, IOptions<LiveKitOptions> lk) =>
        {
            var invalid = Problems.Create(404, "NOT_FOUND", "This invitation link is invalid, has expired or was withdrawn.");
            if (string.IsNullOrEmpty(token) || token.Length > 200) return invalid;
            var now = clock.UtcNow;
            using var c = await db.OpenAsync();
            var m = await c.QuerySingleOrDefaultAsync<JoinRow>("""
                SELECT m.Title, h.DisplayName AS Organiser, m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc, m.TimeZoneId, m.[Status], m.MeetingCode, m.WaitingRoomEnabled,
                       p.ParticipantType, COALESCE(cu.FullName, p.GuestName) AS DisplayName
                FROM mtg.MeetingInvitations i JOIN mtg.Meetings m ON m.MeetingId = i.MeetingId JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
                JOIN mtg.MeetingParticipants p ON p.ParticipantId = i.ParticipantId LEFT JOIN crm.Customers cu ON cu.CustomerId = p.CustomerId
                WHERE i.TokenHash = @hash AND i.RevokedUtc IS NULL AND i.ExpiresUtc > @now AND (i.MaxUses IS NULL OR i.UseCount < i.MaxUses)
                """, new { hash = Tokens.Hash(token), now });
            if (m is null)
            {
                // A genuine but no-longer-valid link gets a helpful reason (the token itself proves the person was invited).
                var old = await c.QuerySingleOrDefaultAsync<DeadInvitation>(
                    "SELECT RevokeReason, ExpiresUtc FROM mtg.MeetingInvitations WHERE TokenHash = @hash", new { hash = Tokens.Hash(token) });
                if (old is null) return invalid;
                var reason = old.RevokeReason ?? "";
                var detail = reason.Contains("reschedul", StringComparison.OrdinalIgnoreCase)
                    ? "This meeting was rescheduled, so this link was replaced. Please use the link in your most recent invitation e-mail."
                    : reason.Contains("cancel", StringComparison.OrdinalIgnoreCase)
                        ? "This meeting was cancelled by the organiser."
                        : old.ExpiresUtc <= now ? "This invitation has expired." : "This invitation was withdrawn by the organiser.";
                return Problems.Create(404, "NOT_FOUND", detail, new Dictionary<string, object?> { ["reason"] = reason.Length == 0 ? "EXPIRED_OR_WITHDRAWN" : reason });
            }
            var w = JoinWindow.Evaluate(m.Status, m.StartUtc, m.EndUtc, now, mo.Value);
            return Results.Ok(new
            {
                title = m.Title, organiser = m.Organiser, startUtc = m.StartUtc, endUtc = m.EndUtc, timeZoneId = m.TimeZoneId,
                status = m.Status switch { "SCHEDULED" or "LIVE" or "CANCELLED" => m.Status, "DRAFT" => "SCHEDULED", _ => "ENDED" },
                meetingCode = m.MeetingCode, waitingRoom = m.WaitingRoomEnabled, joinableNow = w.Joinable, joinOpensUtc = w.OpensUtc,
                joinClosesUtc = w.ClosesUtc, videoAvailable = lk.Value.IsConfigured,
                // Guests may choose the name shown in the room; customers appear under their customer record's name.
                participantType = m.ParticipantType, displayName = m.DisplayName,
            });
        }).RequireRateLimiting(JoinRateLimit);

        return api;
    }

    sealed record DeadInvitation(string? RevokeReason, DateTime ExpiresUtc);
}
