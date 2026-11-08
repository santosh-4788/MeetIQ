using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Recurring meetings are generated as independent mtg.Meetings rows (V015__recurring_meetings.sql), one per
/// occurrence, linked by mtg.MeetingSeries. This class only computes the occurrence dates and validates the rule;
/// everything else (conflict checking, participants, recording, reminders, cancellation) reuses the existing
/// per-meeting code in MeetingEndpoints unchanged.
/// </summary>
internal static class Recurrence
{
    public const int MaxOccurrences = 52;
    public static readonly TimeSpan MaxHorizon = TimeSpan.FromDays(366);
    public static readonly string[] Patterns = ["DAILY", "WEEKLY", "MONTHLY"];
    public static readonly string[] EndTypes = ["COUNT", "UNTIL"];
    static readonly string[] WeekdayCodes = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

    public static int? ParseWeekdaysMask(string[]? codes, Validator v, string field)
    {
        if (codes is null || codes.Length == 0) { v.Add(field, "Choose at least one day of the week."); return null; }
        var mask = 0;
        foreach (var raw in codes)
        {
            var i = Array.IndexOf(WeekdayCodes, raw?.Trim().ToUpperInvariant());
            if (i < 0) { v.Add(field, $"Unknown weekday '{raw}'. Use MON, TUE, WED, THU, FRI, SAT or SUN."); return null; }
            mask |= 1 << i;
        }
        return mask;
    }

    public static string[] WeekdaysFromMask(int mask) => WeekdayCodes.Where((_, i) => (mask & (1 << i)) != 0).ToArray();

    /// <summary>Generates occurrence (start, end) pairs in UTC, each preserving the first occurrence's duration.</summary>
    public static List<(DateTime Start, DateTime End)> Generate(string pattern, int interval, int? weekdaysMask, string endType, int? endCount,
        DateTime? endUntilUtc, DateTime firstStartUtc, DateTime firstEndUtc, string timeZoneId)
    {
        var tz = Zones.Find(timeZoneId);
        var duration = firstEndUtc - firstStartUtc;
        DateTime ToUtc(DateTime local) => TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), tz);
        DateTime ToLocal(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), tz);

        var firstLocal = ToLocal(firstStartUtc);
        var untilUtc = endUntilUtc ?? firstStartUtc.Add(MaxHorizon);
        var maxCount = endType == "COUNT" ? Math.Min(endCount ?? 1, MaxOccurrences) : MaxOccurrences;
        var result = new List<(DateTime, DateTime)>();

        switch (pattern)
        {
            case "DAILY":
                for (var k = 0; result.Count < maxCount; k++)
                {
                    var localStart = firstLocal.AddDays((double)k * interval);
                    if (localStart - firstLocal > MaxHorizon) break;
                    var s = ToUtc(localStart);
                    if (s > untilUtc) break;
                    result.Add((s, s + duration));
                }
                break;

            case "WEEKLY":
                var mask = weekdaysMask ?? 0;
                for (var dayOffset = 0; result.Count < maxCount && dayOffset <= MaxHorizon.Days; dayOffset++)
                {
                    var localDate = firstLocal.Date.AddDays(dayOffset);
                    var weekIndex = dayOffset / 7;
                    var bit = 1 << ((int)localDate.DayOfWeek == 0 ? 6 : (int)localDate.DayOfWeek - 1); // Mon=bit0 .. Sun=bit6
                    if (weekIndex % interval != 0 || (mask & bit) == 0) continue;
                    var localStart = localDate + firstLocal.TimeOfDay;
                    if (localStart < firstLocal) continue;
                    var s = ToUtc(localStart);
                    if (s > untilUtc) break;
                    result.Add((s, s + duration));
                }
                break;

            default: // MONTHLY: same day of month (clamped to the shortest month, e.g. 31 Jan -> 28/29 Feb)
                for (var k = 0; result.Count < maxCount; k++)
                {
                    var localStart = firstLocal.AddMonths(k * interval);
                    if (localStart - firstLocal > MaxHorizon) break;
                    var s = ToUtc(localStart);
                    if (s > untilUtc) break;
                    result.Add((s, s + duration));
                }
                break;
        }
        return result;
    }
}
