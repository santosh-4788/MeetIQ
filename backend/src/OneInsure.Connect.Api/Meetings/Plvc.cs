using System.Data;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Customer - PLVC meetings (12 Nov 2026): a mandatory Prarambh Main ID (digits only) and a participant list (name + e-mail rows,
/// like "Add guest") instead of picking a customer record. The first participant becomes the meeting's customer: an existing
/// active customer with that e-mail is reused, otherwise one is created - so dashboards, reports and recording access, which
/// all key on the meeting's CustomerId, keep working. The other participants are guests.
/// </summary>
internal static partial class Plvc
{
    public const string Category = "CUSTOMER_PLVC";
    public const int MaxParticipants = 20;

    public sealed record Person(string Name, string Email);

    [GeneratedRegex("^[0-9]{1,30}$")]
    private static partial Regex Digits();

    public static bool IsValidPrarambh(string? value) => value is not null && Digits().IsMatch(value);

    /// <summary>Same rule as the computed column mtg.Meetings.PlvcIdentification (V024): null for non-PLVC meetings.</summary>
    public static string? Identification(string? category, string? prarambh) =>
        category != Category ? null : string.IsNullOrEmpty(prarambh) ? "UNIDENTIFIED" : "IDENTIFIED";

    /// <summary>
    /// Authorised correction (V024): adds the Prarambh Main ID to an UNIDENTIFIED PLVC meeting - host, organiser or an administrator
    /// with meetings.view.all; only while it has none (an existing ID is never overwritten); also to that meeting's recordings that
    /// have none (metadata only - files are never renamed or moved). Audited with the old and new values.
    /// </summary>
    public sealed record SetPrarambhInput(string? PrarambhMainId);

    public static async Task<IResult> SetPrarambhAsync(Guid id, SetPrarambhInput input, Db db, HttpContext ctx, CancellationToken ct)
    {
        using var c = await db.OpenAsync(ct);
        var me = await Actor.LoadAsync(c, ctx.User);
        var m = await c.QuerySingleOrDefaultAsync<(long MeetingId, string Category, string? PrarambhMainId, long HostEmployeeId, long CreatedByEmployeeId, string? MyRole)?>("""
            SELECT m.MeetingId, m.Category, m.PrarambhMainId, m.HostEmployeeId, m.CreatedByEmployeeId,
                   (SELECT TOP (1) p.[Role] FROM mtg.MeetingParticipants p WHERE p.MeetingId = m.MeetingId AND p.EmployeeId = @emp) AS MyRole
            FROM mtg.Meetings m WHERE m.PublicId = @id
            """, new { id, emp = me.EmployeeId });
        if (m is null) return Problems.Create(404, "NOT_FOUND", "Meeting not found.");
        var allowed = me.ViewAll || MeetingLinkEndpoints.CanManageLink(m.Value.HostEmployeeId, m.Value.CreatedByEmployeeId, m.Value.MyRole, me);
        if (!allowed) return Problems.Create(403, "FORBIDDEN", "Only the host, the organiser or an administrator can add the Prarambh Main ID.");
        if (m.Value.Category != Category) return Problems.Create(409, "CONFLICT", "A Prarambh Main ID applies only to Customer – PLVC meetings.");
        if (m.Value.PrarambhMainId is not null) return Problems.Create(409, "CONFLICT", "This meeting already has a Prarambh Main ID. It cannot be changed here.");
        var v = new Validator();
        var value = ValidatePrarambh(v, input.PrarambhMainId, Category);
        if (!v.IsValid) return v.Problem();
        using var tx = c.BeginTransaction();
        var n = await c.ExecuteAsync("""
            UPDATE mtg.Meetings SET PrarambhMainId = @value, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
            WHERE MeetingId = @m AND PrarambhMainId IS NULL AND Category = 'CUSTOMER_PLVC'
            """, new { value, user = me.UserId, m = m.Value.MeetingId }, tx);
        if (n == 0) { tx.Rollback(); return Problems.Create(409, "CONFLICT", "Someone else changed this meeting in the meantime. Reload it."); }
        var recordings = await c.ExecuteAsync(
            "UPDATE rec.MeetingRecordings SET PrarambhMainId = @value WHERE MeetingId = @m AND PrarambhMainId IS NULL", new { value, m = m.Value.MeetingId }, tx);
        await Audit.WriteAsync(c, "USER", me.UserId, "MEETING_PRARAMBH_ADDED", "Meeting", id.ToString(),
            "Prarambh Main ID added to an unidentified Customer – PLVC meeting (now identified)", ClientInfo.From(ctx).Ip, tx,
            newValues: new { oldPrarambhMainId = (string?)null, prarambhMainId = value, oldIdentification = "UNIDENTIFIED", identification = "IDENTIFIED", recordingsUpdated = recordings, filesRenamed = 0 });
        tx.Commit();
        return Results.Ok(new { prarambhMainId = value, plvcIdentification = "IDENTIFIED", recordingsUpdated = recordings });
    }

    /// <summary>Required and digits-only for PLVC; refused for every other category. Returned exactly as supplied (trimmed of spaces).</summary>
    public static string? ValidatePrarambh(Validator v, string? raw, string? category)
    {
        var value = raw?.Trim();
        if (category == Category)
        {
            if (string.IsNullOrEmpty(value)) { v.Add("prarambhMainId", "Prarambh Main ID is required for a Customer – PLVC meeting."); return null; }
            if (!Digits().IsMatch(value)) { v.Add("prarambhMainId", "Prarambh Main ID must contain digits only (0–9), at most 30 digits."); return null; }
            return value;
        }
        if (!string.IsNullOrEmpty(value)) v.Add("prarambhMainId", "Prarambh Main ID applies only to Customer – PLVC meetings.");
        return null;
    }

    /// <summary>Name + e-mail rows: both required, valid e-mail, no duplicates (case-insensitive), at most 20.</summary>
    public static List<Person> ValidateParticipants(Validator v, MeetingEndpoints.GuestInput[]? rows, string field = "participants")
    {
        var list = new List<Person>();
        if (rows is null) return list;
        if (rows.Length > MaxParticipants) { v.Add(field, $"At most {MaxParticipants} participants can be added."); return list; }
        for (var i = 0; i < rows.Length; i++)
        {
            var name = v.Required($"{field}[{i}].name", rows[i].Name, 200, "Participant name");
            var email = v.Email($"{field}[{i}].email", rows[i].Email, "Participant e-mail");
            if (name is null || email is null) continue;
            if (list.Any(p => string.Equals(p.Email, email, StringComparison.OrdinalIgnoreCase))) v.Add($"{field}[{i}].email", "This participant is listed twice.");
            else list.Add(new Person(name, email));
        }
        return list;
    }

    public sealed record CustomerRef(long CustomerId, Guid PublicId, string? PolicyNumber, string Name, string? Email, string? Mobile, bool Created);

    /// <summary>
    /// The customer record for a meeting's first participant: an active customer with the same e-mail is reused unchanged;
    /// otherwise a new one is created (CustomerRef PLVC-&lt;PrarambhMainId&gt; for PLVC, AUTO-&lt;random&gt; otherwise; the Prarambh ID is
    /// also kept as its ReferenceNumber). Runs inside the caller's transaction.
    /// </summary>
    public static async Task<CustomerRef> EnsureCustomerAsync(IDbConnection c, IDbTransaction tx, Person p, string? prarambh, long? assignedEmployeeId, long userId, string? ip)
    {
        var existing = await c.QuerySingleOrDefaultAsync<CustomerRef>("""
            SELECT TOP (1) CustomerId, PublicId, PolicyNumber, FullName AS Name, Email, Mobile, CAST(0 AS BIT) AS Created
            FROM crm.Customers WHERE IsActive = 1 AND Email = @email ORDER BY CustomerId
            """, new { email = p.Email }, tx);
        if (existing is not null) return existing;
        var baseRef = prarambh is not null ? $"PLVC-{prarambh}" : $"AUTO-{MeetingMessaging.NewOpaqueId("", 8).ToUpperInvariant()}";
        for (var n = 1; ; n++)
        {
            var customerRef = n == 1 ? baseRef : $"{baseRef}-{n}";
            try
            {
                var (id, publicId) = await c.QuerySingleAsync<(long, Guid)>("""
                    INSERT crm.Customers (CustomerRef, FullName, Email, ReferenceNumber, AssignedEmployeeId, Notes, CreatedByUserId)
                    OUTPUT inserted.CustomerId, inserted.PublicId
                    VALUES (@customerRef, @name, @email, @reference, @assigned, @notes, @user)
                    """, new { customerRef, name = p.Name, email = p.Email, reference = prarambh, assigned = assignedEmployeeId,
                        notes = "Created automatically from a meeting participant" + (prarambh is null ? "" : $" (Prarambh Main ID {prarambh})"), user = userId }, tx);
                await Audit.WriteAsync(c, "USER", userId, "CUSTOMER_CREATED", "Customer", publicId.ToString(), $"Customer {customerRef} created from a meeting participant", ip, tx,
                    newValues: new { customerRef, prarambhMainId = prarambh, automatic = true });
                return new CustomerRef(id, publicId, null, p.Name, p.Email, null, true);
            }
            catch (SqlException e) when (e.IsUniqueViolation() && n < 50) { }
        }
    }
}
