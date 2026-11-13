using System.Globalization;
using System.Text;
using Dapper;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Reports;

/// <summary>
/// Organisation-wide meeting activity report (feature-gap report, section 12: the Reports module did not exist - only
/// an honest "not yet implemented" placeholder; the frontend nav entry already reserved the "reports.view" permission
/// for it, seeded to DepartmentHead, ComplianceAuditor, Admin and SuperAdmin - see V010__seed_reference_data.sql).
/// Unlike GET /meetings, this is not scoped to "my" meetings - a report sees across the whole organisation. Note:
/// a DepartmentHead currently sees every department's summary here, not only their own - scoping reports to a single
/// department for that role is a reasonable follow-up, not implemented in this first version.
/// </summary>
public static class ReportsEndpoints
{
    public static RouteGroupBuilder MapReportsEndpoints(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/reports").RequireAnyPermission("reports.view");
        g.MapGet("/departments", Departments);
        g.MapGet("/meetings", Meetings);
        g.MapGet("/meetings/export", Export);
        return api;
    }

    sealed record Row(Guid Id, string MeetingCode, string Title, string Category, string Status, DateTime StartUtc, DateTime EndUtc,
        DateTime? ActualStartUtc, DateTime? ActualEndUtc, string HostName, string? Department, string? CustomerName, int ParticipantCount,
        string RecordingPolicy, string? RecordingStatus, string? PrarambhMainId, string? PlvcIdentification);

    sealed record SummaryRow(int Total, int Completed, int Cancelled, int LiveOrScheduled, int CustomerMeetings, int InternalMeetings,
        double TotalHours, int WithRecording);

    static async Task<IResult> Departments(Db db)
    {
        using var c = await db.OpenAsync();
        var rows = await c.QueryAsync<(long DepartmentId, string Name)>(
            "SELECT DepartmentId, Name FROM org.Departments WHERE IsActive = 1 ORDER BY Name");
        return Results.Ok(rows.Select(r => new { id = r.DepartmentId, name = r.Name }));
    }

    static (string Where, DynamicParameters Prm, string? Error) BuildFilter(string? from, string? to, string? category, long? departmentId, string? status, string? search)
    {
        if (!MeetingEndpoints.TryParseUtc(from, out var fromUtc)) return ("", new DynamicParameters(), "from must be an ISO 8601 date-time.");
        if (!MeetingEndpoints.TryParseUtc(to, out var toUtc)) return ("", new DynamicParameters(), "to must be an ISO 8601 date-time.");
        var cat = MeetingEndpoints.Upper(category);
        var st = MeetingEndpoints.Upper(status);
        var term = string.IsNullOrWhiteSpace(search) ? null : search.Trim();

        var prm = new DynamicParameters();
        prm.Add("from", fromUtc);
        prm.Add("to", toUtc);
        prm.Add("cat", cat);
        prm.Add("st", st);
        prm.Add("dept", departmentId);
        prm.Add("search", term);
        prm.Add("like", term is null ? null : "%" + term.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%");

        var where = """
            WHERE m.[Status] <> 'DRAFT'
              AND (@from IS NULL OR m.ScheduledEndUtc > @from) AND (@to IS NULL OR m.ScheduledStartUtc < @to)
              AND (@cat IS NULL OR m.Category = @cat OR (@cat = 'CUSTOMER' AND m.Category IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL'))
                   OR (@cat = 'INTERNAL' AND m.Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL'))
                   -- V024: identified PLVC (verified Prarambh mapping) vs unidentified PLVC
                   OR (@cat = 'CUSTOMER_PLVC_IDENTIFIED' AND m.PlvcIdentification = 'IDENTIFIED')
                   OR (@cat = 'CUSTOMER_PLVC_UNIDENTIFIED' AND m.PlvcIdentification = 'UNIDENTIFIED'))
              AND (@st IS NULL OR m.[Status] = @st)
              AND (@dept IS NULL OR h.DepartmentId = @dept)
              AND (@search IS NULL OR m.Title LIKE @like OR m.MeetingCode LIKE @like OR m.PrarambhMainId LIKE @like)
            """;
        return (where, prm, null);
    }

    const string FromSql = """
        FROM mtg.Meetings m
        JOIN org.Employees h ON h.EmployeeId = m.HostEmployeeId
        LEFT JOIN org.Departments d ON d.DepartmentId = h.DepartmentId
        LEFT JOIN crm.Customers cu ON cu.CustomerId = m.CustomerId
        """;

    static async Task<IResult> Meetings(string? from, string? to, string? category, long? department, string? status, string? search,
        int? page, int? pageSize, Db db)
    {
        var (where, prm, error) = BuildFilter(from, to, category, department, status, search);
        if (error is not null) { var v = new Validator(); v.Add("from", error); return v.Problem(); }
        var size = Math.Clamp(pageSize ?? 25, 5, 200);
        var p = Math.Max(page ?? 1, 1);
        prm.Add("skip", (p - 1) * size);
        prm.Add("size", size);

        using var c = await db.OpenAsync();
        using var multi = await c.QueryMultipleAsync($"""
            SELECT COUNT(*) {FromSql} {where};

            SELECT
                ISNULL(SUM(CASE WHEN 1=1 THEN 1 ELSE 0 END), 0) AS Total,
                ISNULL(SUM(CASE WHEN m.[Status] = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS Completed,
                ISNULL(SUM(CASE WHEN m.[Status] IN ('CANCELLED', 'EXPIRED') THEN 1 ELSE 0 END), 0) AS Cancelled,
                ISNULL(SUM(CASE WHEN m.[Status] IN ('LIVE', 'SCHEDULED') THEN 1 ELSE 0 END), 0) AS LiveOrScheduled,
                ISNULL(SUM(CASE WHEN m.Category IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') THEN 1 ELSE 0 END), 0) AS CustomerMeetings,
                ISNULL(SUM(CASE WHEN m.Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') THEN 1 ELSE 0 END), 0) AS InternalMeetings,
                CAST(ISNULL(SUM(DATEDIFF(MINUTE, m.ScheduledStartUtc, m.ScheduledEndUtc)) / 60.0, 0) AS FLOAT) AS TotalHours,
                ISNULL(SUM(CASE WHEN m.RecordingPolicy <> 'NONE' THEN 1 ELSE 0 END), 0) AS WithRecording
            {FromSql} {where};

            SELECT m.PublicId AS Id, m.MeetingCode, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc,
                   m.ActualStartUtc, m.ActualEndUtc, h.DisplayName AS HostName, d.Name AS Department, cu.FullName AS CustomerName,
                   (SELECT COUNT(*) FROM mtg.MeetingParticipants x WHERE x.MeetingId = m.MeetingId) AS ParticipantCount, m.RecordingPolicy,
                   (SELECT TOP (1) r.[Status] FROM rec.MeetingRecordings r WHERE r.MeetingId = m.MeetingId ORDER BY r.RecordingId DESC) AS RecordingStatus, m.PrarambhMainId, m.PlvcIdentification
            {FromSql} {where}
            ORDER BY m.ScheduledStartUtc DESC, m.MeetingId
            OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
            """, prm);

        var total = await multi.ReadSingleAsync<int>();
        var summary = await multi.ReadSingleAsync<SummaryRow>();
        var rows = (await multi.ReadAsync<Row>()).Select(r => new
        {
            id = r.Id, meetingCode = r.MeetingCode, title = r.Title, category = r.Category, categoryGroup = MeetingEndpoints.CategoryGroup(r.Category),
            status = r.Status, startUtc = r.StartUtc, endUtc = r.EndUtc, actualStartUtc = r.ActualStartUtc, actualEndUtc = r.ActualEndUtc,
            hostName = r.HostName, department = r.Department, customerName = r.CustomerName, participantCount = r.ParticipantCount,
            recordingPolicy = r.RecordingPolicy, recordingStatus = r.RecordingStatus, prarambhMainId = r.PrarambhMainId, plvcIdentification = r.PlvcIdentification,
        }).ToList();

        return Results.Ok(new
        {
            summary = new
            {
                total = summary.Total, completed = summary.Completed, cancelled = summary.Cancelled, liveOrScheduled = summary.LiveOrScheduled,
                customerMeetings = summary.CustomerMeetings, internalMeetings = summary.InternalMeetings,
                totalHours = Math.Round(summary.TotalHours, 1), withRecording = summary.WithRecording,
            },
            page = new Page<object>(rows, total, p, size),
        });
    }

    const int ExportMaxRows = 5000;

    static async Task<IResult> Export(string? from, string? to, string? category, long? department, string? status, string? search, Db db)
    {
        var (where, prm, error) = BuildFilter(from, to, category, department, status, search);
        if (error is not null) { var v = new Validator(); v.Add("from", error); return v.Problem(); }
        prm.Add("top", ExportMaxRows);

        using var c = await db.OpenAsync();
        var rows = await c.QueryAsync<Row>($"""
            SELECT TOP (@top) m.PublicId AS Id, m.MeetingCode, m.Title, m.Category, m.[Status], m.ScheduledStartUtc AS StartUtc, m.ScheduledEndUtc AS EndUtc,
                   m.ActualStartUtc, m.ActualEndUtc, h.DisplayName AS HostName, d.Name AS Department, cu.FullName AS CustomerName,
                   (SELECT COUNT(*) FROM mtg.MeetingParticipants x WHERE x.MeetingId = m.MeetingId) AS ParticipantCount, m.RecordingPolicy,
                   (SELECT TOP (1) r.[Status] FROM rec.MeetingRecordings r WHERE r.MeetingId = m.MeetingId ORDER BY r.RecordingId DESC) AS RecordingStatus, m.PrarambhMainId, m.PlvcIdentification
            {FromSql} {where}
            ORDER BY m.ScheduledStartUtc DESC, m.MeetingId
            """, prm);

        var sb = new StringBuilder();
        void Line(params string?[] fields) => sb.AppendLine(string.Join(',', fields.Select(Csv)));
        Line("Meeting code", "Title", "Category", "Status", "Scheduled start (UTC)", "Scheduled end (UTC)", "Actual start (UTC)", "Actual end (UTC)",
            "Host", "Department", "Customer", "Participants", "Recording policy", "Recording status", "Prarambh Main ID", "PLVC identification");
        foreach (var r in rows)
            Line(r.MeetingCode, r.Title, MeetingEndpoints.CategoryGroup(r.Category), r.Status,
                r.StartUtc.ToString("u", CultureInfo.InvariantCulture), r.EndUtc.ToString("u", CultureInfo.InvariantCulture),
                r.ActualStartUtc?.ToString("u", CultureInfo.InvariantCulture), r.ActualEndUtc?.ToString("u", CultureInfo.InvariantCulture),
                r.HostName, r.Department, r.CustomerName, r.ParticipantCount.ToString(CultureInfo.InvariantCulture), r.RecordingPolicy, r.RecordingStatus, r.PrarambhMainId, r.PlvcIdentification);

        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(sb.ToString())).ToArray(); // BOM: Excel needs it to read UTF-8 correctly
        return Results.File(bytes, "text/csv", $"meeting-report-{DateTime.UtcNow:yyyyMMdd-HHmm}.csv");
    }

    static string Csv(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Contains(',') || s.Contains('"') || s.Contains('\n') ? $"\"{s.Replace("\"", "\"\"")}\"" : s;
    }
}
