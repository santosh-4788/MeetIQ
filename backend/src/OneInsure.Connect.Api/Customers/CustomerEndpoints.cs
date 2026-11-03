using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Org;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Customers;

/// <summary>
/// /api/v1/customers — customer participants (no login). Permission customer.meetings.view. Addressed by PublicId.
/// PII is minimised: lists show masked contact details, audit entries never contain names, e-mail addresses or mobile numbers.
/// </summary>
public static partial class CustomerEndpoints
{
    public sealed record CustomerInput(string? CustomerRef, string? FullName, string? Email, string? Mobile, string? PolicyNumber,
        string? ReferenceNumber, Guid? AssignedEmployeeId, string? Notes);

    sealed record ListRow(Guid Id, string CustomerRef, string FullName, string? Email, string? Mobile, string? PolicyNumber, string? ReferenceNumber,
        Guid? AssignedEmployeeId, string? AssignedEmployeeName, bool IsActive);

    const string Columns = """
        c.PublicId AS Id, c.CustomerRef, c.FullName, c.Email, c.Mobile, c.PolicyNumber, c.ReferenceNumber,
        e.PublicId AS AssignedEmployeeId, e.DisplayName AS AssignedEmployeeName, c.IsActive
        """;
    const string From = "FROM crm.Customers c LEFT JOIN org.Employees e ON e.EmployeeId = c.AssignedEmployeeId";

    public static RouteGroupBuilder MapCustomerEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/customers").RequirePermission("customer.meetings.view");

        g.MapGet("", async (string? search, bool? assignedToMe, bool? includeInactive, int? page, int? pageSize, Db db, HttpContext ctx) =>
        {
            var size = Math.Clamp(pageSize ?? 25, 5, 100);
            var p = Math.Max(page ?? 1, 1);
            var term = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
            using var c = await db.OpenAsync();
            var me = assignedToMe == true ? await c.ExecuteScalarAsync<long?>("SELECT EmployeeId FROM auth.Users WHERE UserId = @u", new { u = ctx.User.UserId() }) ?? -1 : (long?)null;
            var where = """
                WHERE (@inactive = 1 OR c.IsActive = 1) AND (@me IS NULL OR c.AssignedEmployeeId = @me)
                  AND (@search IS NULL OR c.FullName LIKE @like OR c.CustomerRef LIKE @like OR c.PolicyNumber LIKE @like OR c.ReferenceNumber LIKE @like
                       OR c.Email = @search OR c.Mobile = @search)
                """;
            using var multi = await c.QueryMultipleAsync($"""
                SELECT COUNT(*) {From} {where};
                SELECT {Columns} {From} {where} ORDER BY c.FullName, c.CustomerId OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
                """, new
            {
                inactive = includeInactive == true, me, search = term,
                like = term is null ? null : "%" + term.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%", skip = (p - 1) * size, size,
            });
            var total = await multi.ReadSingleAsync<int>();
            var items = (await multi.ReadAsync<ListRow>()).Select(r => new
            {
                id = r.Id, customerRef = r.CustomerRef, fullName = r.FullName, email = MaskEmail(r.Email), mobile = MaskMobile(r.Mobile),
                policyNumber = r.PolicyNumber, referenceNumber = r.ReferenceNumber, assignedEmployeeId = r.AssignedEmployeeId,
                assignedEmployeeName = r.AssignedEmployeeName, isActive = r.IsActive,
            }).ToList();
            return Results.Ok(new Page<object>(items, total, p, size));
        });

        g.MapGet("/{id:guid}", async (Guid id, Db db) =>
        {
            using var c = await db.OpenAsync();
            var r = await c.QuerySingleOrDefaultAsync<ListRow>($"SELECT {Columns} {From} WHERE c.PublicId = @id", new { id });
            if (r is null) return Db_.NotFound("Customer");
            var notes = await c.ExecuteScalarAsync<string?>("SELECT Notes FROM crm.Customers WHERE PublicId = @id", new { id });
            var meetings = await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM mtg.Meetings m JOIN crm.Customers x ON x.CustomerId = m.CustomerId WHERE x.PublicId = @id", new { id });
            return Results.Ok(new
            {
                id = r.Id, customerRef = r.CustomerRef, fullName = r.FullName, email = r.Email, mobile = r.Mobile, policyNumber = r.PolicyNumber,
                referenceNumber = r.ReferenceNumber, assignedEmployeeId = r.AssignedEmployeeId, assignedEmployeeName = r.AssignedEmployeeName,
                notes, isActive = r.IsActive, meetingCount = meetings,
            });
        });

        g.MapPost("", (CustomerInput i, Db db, HttpContext ctx) => Save(null, i, db, ctx));
        g.MapPut("/{id:guid}", (Guid id, CustomerInput i, Db db, HttpContext ctx) => Save(id, i, db, ctx));
        return api;
    }

    static async Task<IResult> Save(Guid? id, CustomerInput i, Db db, HttpContext ctx)
    {
        var v = new Validator();
        var customerRef = v.Required("customerRef", i.CustomerRef, 50, "Customer reference")?.ToUpperInvariant();
        if (customerRef is not null && !RefRe().IsMatch(customerRef)) v.Add("customerRef", "Customer reference may contain only letters, digits, '-', '_' and '/'.");
        var name = v.Required("fullName", i.FullName, 200, "Full name");
        var email = v.Email("email", i.Email, "E-mail", required: false);
        var mobile = v.Mobile("mobile", i.Mobile);
        if (email is null && mobile is null && v.IsValid) v.Add("email", "Enter an e-mail address or a mobile number.");
        var policy = v.Optional("policyNumber", i.PolicyNumber, 50, "Policy number");
        var reference = v.Optional("referenceNumber", i.ReferenceNumber, 50, "Reference number");
        var notes = v.Optional("notes", i.Notes, 1000, "Notes");
        using var c = await db.OpenAsync();
        var assigned = await OrgEndpoints.ResolveEmployee(c, i.AssignedEmployeeId, v, "assignedEmployeeId", "Assigned employee");
        if (!v.IsValid) return v.Problem();

        var p = new { id, customerRef, name, email, mobile, policy, reference, assigned, notes, user = ctx.User.UserId() };
        try
        {
            using var tx = c.BeginTransaction();
            Guid publicId;
            if (id is null)
                publicId = await c.QuerySingleAsync<Guid>("""
                    INSERT crm.Customers (CustomerRef, FullName, Email, Mobile, PolicyNumber, ReferenceNumber, AssignedEmployeeId, Notes, CreatedByUserId)
                    OUTPUT inserted.PublicId VALUES (@customerRef, @name, @email, @mobile, @policy, @reference, @assigned, @notes, @user)
                    """, p, tx);
            else
            {
                var n = await c.ExecuteAsync("""
                    UPDATE crm.Customers SET CustomerRef = @customerRef, FullName = @name, Email = @email, Mobile = @mobile, PolicyNumber = @policy,
                        ReferenceNumber = @reference, AssignedEmployeeId = @assigned, Notes = @notes, ModifiedUtc = SYSUTCDATETIME(), ModifiedByUserId = @user
                    WHERE PublicId = @id
                    """, p, tx);
                if (n == 0) { tx.Rollback(); return Db_.NotFound("Customer"); }
                publicId = id.Value;
            }
            // No PII in the audit trail: which fields are present, not their values.
            await Audit.WriteAsync(c, "USER", ctx.User.UserId(), id is null ? "CUSTOMER_CREATED" : "CUSTOMER_UPDATED", "Customer", publicId.ToString(),
                $"Customer {customerRef} {(id is null ? "created" : "updated")}", ClientInfo.From(ctx).Ip, tx,
                newValues: new { customerRef, hasEmail = email is not null, hasMobile = mobile is not null, hasPolicyNumber = policy is not null, hasReferenceNumber = reference is not null, assignedEmployeeId = i.AssignedEmployeeId });
            tx.Commit();
            return id is null ? Results.Json(new { id = publicId }, statusCode: 201) : Results.NoContent();
        }
        catch (SqlException e) when (e.IsUniqueViolation())
        {
            return Db_.Conflict($"Customer reference {customerRef} already exists.");
        }
    }

    internal static string? MaskEmail(string? e)
    {
        if (string.IsNullOrEmpty(e)) return null;
        var at = e.IndexOf('@');
        return at <= 0 ? "***" : $"{e[..Math.Min(2, at)]}***{e[at..]}";
    }

    internal static string? MaskMobile(string? m) => string.IsNullOrEmpty(m) ? null : m.Length <= 4 ? "****" : new string('*', m.Length - 4) + m[^4..];

    [GeneratedRegex(@"^[A-Z0-9][A-Z0-9_/-]{0,49}$")] private static partial Regex RefRe();
}
