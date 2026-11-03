using System.Data;
using Microsoft.Data.SqlClient;

namespace OneInsure.Connect.Api.Infrastructure;

public sealed class SecurityOptions
{
    public int SessionIdleMinutes { get; set; } = 30;
    public int SessionAbsoluteHours { get; set; } = 12;
    public int RememberMeDays { get; set; } = 7;
    public int LockoutThreshold { get; set; } = 5;
    public int LockoutMinutes { get; set; } = 15;
    public int PasswordResetMinutes { get; set; } = 30;
    public bool CookieSecure { get; set; } = true;
    /// <summary>Per client IP: sign-in attempts per minute; password reset/change requests per 5 minutes.</summary>
    public int LoginPermitPerMinute { get; set; } = 10;
    public int PasswordResetPermitPer5Minutes { get; set; } = 5;
    /// <summary>Browser origins allowed to send state-changing requests (besides the API's own origin).</summary>
    public string[] AllowedOrigins { get; set; } = [];
}

public sealed class PublicEndpointOptions
{
    public string WebBaseUrl { get; set; } = "";
}

/// <summary>Opens connections to OneInsureVideoMeetingDB. The connection string is never logged.</summary>
public sealed class Db(string connectionString)
{
    public async Task<IDbConnection> OpenAsync(CancellationToken ct = default)
    {
        var c = new SqlConnection(connectionString);
        await c.OpenAsync(ct);
        return c;
    }
}

/// <summary>
/// All DATETIME2 columns hold UTC, but ADO.NET returns them with Kind=Unspecified, which serialises without "Z" and
/// browsers then read as local time. This writes every DateTime as UTC ("...Z") across all endpoints.
/// </summary>
public sealed class UtcDateTimeConverter : System.Text.Json.Serialization.JsonConverter<DateTime>
{
    public override DateTime Read(ref System.Text.Json.Utf8JsonReader reader, Type typeToConvert, System.Text.Json.JsonSerializerOptions options) =>
        reader.GetDateTime().ToUniversalTime();

    public override void Write(System.Text.Json.Utf8JsonWriter writer, DateTime value, System.Text.Json.JsonSerializerOptions options) =>
        writer.WriteStringValue(value.Kind == DateTimeKind.Local ? value.ToUniversalTime() : DateTime.SpecifyKind(value, DateTimeKind.Utc));
}

/// <summary>Testable clock.</summary>
public interface IClock
{
    DateTime UtcNow { get; }
}

public sealed class SystemClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}
