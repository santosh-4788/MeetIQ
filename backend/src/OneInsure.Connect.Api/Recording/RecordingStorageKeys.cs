using System.Globalization;
using System.Text.RegularExpressions;

namespace OneInsure.Connect.Api.Recording;

/// <summary>
/// Storage keys for new recordings (12 Nov 2026): <c>YYYYMMDD/[PrarambhMainId-]MeetingCode-REC&lt;RecordingId&gt;[-n].mp4</c>.
/// <list type="bullet">
/// <item>Folder: the recording's START date in Asia/Kolkata (a 01:30 IST recording belongs to that IST day, not the previous UTC day).</item>
/// <item>PLVC: the file name starts with the Prarambh Main ID (digits only - validated at meeting creation, re-checked here).</item>
/// <item>Only the meeting code, the recording number and the Prarambh ID - never a customer's name or e-mail.</item>
/// <item>The key is relative (no drive, no "..") so it satisfies CK_MeetingRecordings_StorageKey; uniqueness is checked by the caller.</item>
/// </list>
/// </summary>
public static partial class RecordingStorageKeys
{
    public const string TimeZoneId = "Asia/Kolkata";

    static readonly TimeZoneInfo Ist = TimeZoneInfo.TryFindSystemTimeZoneById(TimeZoneId, out var tz) ? tz
        : TimeZoneInfo.TryFindSystemTimeZoneById("India Standard Time", out var win) ? win
        : TimeZoneInfo.CreateCustomTimeZone("IST", TimeSpan.FromMinutes(330), "IST", "IST");

    /// <summary>The IST calendar date (yyyyMMdd) of a UTC instant.</summary>
    public static string DateFolder(DateTime utc) =>
        TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Ist).ToString("yyyyMMdd", CultureInfo.InvariantCulture);

    public static string FileName(string meetingCode, long recordingId, string? prarambhMainId, int suffix = 1)
    {
        var code = SafeSegment(meetingCode);
        var prefix = prarambhMainId is { Length: > 0 } p && DigitsOnly().IsMatch(p) ? p + "-" : "";
        var tail = suffix > 1 ? $"-{suffix}" : "";
        return $"{prefix}{code}-REC{recordingId.ToString(CultureInfo.InvariantCulture)}{tail}.mp4";
    }

    public static string Build(DateTime startedUtc, string meetingCode, long recordingId, string? prarambhMainId, int suffix = 1) =>
        $"{DateFolder(startedUtc)}/{FileName(meetingCode, recordingId, prarambhMainId, suffix)}";

    /// <summary>Meeting codes are server-generated (OIC-yyMMdd-XXXX); anything outside [A-Za-z0-9-] is dropped defensively.</summary>
    static string SafeSegment(string s)
    {
        var cleaned = NotSafe().Replace(s ?? "", "");
        return cleaned.Length == 0 ? "MEETING" : cleaned[..Math.Min(cleaned.Length, 40)];
    }

    [GeneratedRegex("^[0-9]{1,30}$")]
    private static partial Regex DigitsOnly();

    [GeneratedRegex("[^A-Za-z0-9-]")]
    private static partial Regex NotSafe();
}
