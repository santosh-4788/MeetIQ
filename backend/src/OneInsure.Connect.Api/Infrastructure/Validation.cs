using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

namespace OneInsure.Connect.Api.Infrastructure;

/// <summary>Collects field errors and turns them into a 400 VALIDATION problem ({ errors: { field: message } }).</summary>
public sealed partial class Validator
{
    readonly Dictionary<string, string> errors = [];

    public bool IsValid => errors.Count == 0;

    public string? Required(string field, string? value, int maxLength, string label)
    {
        var v = value?.Trim();
        if (string.IsNullOrEmpty(v)) errors.TryAdd(field, $"{label} is required.");
        else if (v.Length > maxLength) errors.TryAdd(field, $"{label} must be at most {maxLength} characters.");
        return string.IsNullOrEmpty(v) ? null : v;
    }

    public string? Optional(string field, string? value, int maxLength, string label)
    {
        var v = value?.Trim();
        if (!string.IsNullOrEmpty(v) && v.Length > maxLength) errors.TryAdd(field, $"{label} must be at most {maxLength} characters.");
        return string.IsNullOrEmpty(v) ? null : v;
    }

    public string? Code(string field, string? value, string label, int maxLength = 30)
    {
        var v = Required(field, value, maxLength, label)?.ToUpperInvariant();
        if (v is not null && !CodeRe().IsMatch(v)) errors.TryAdd(field, $"{label} may contain only letters, digits, '-', '_' and '/'.");
        return v;
    }

    public string? Email(string field, string? value, string label, bool required = true)
    {
        var v = required ? Required(field, value, 254, label) : Optional(field, value, 254, label);
        if (v is not null && !EmailRe().IsMatch(v)) errors.TryAdd(field, $"Enter a valid {label.ToLowerInvariant()}.");
        return v?.ToLowerInvariant();
    }

    public string? Mobile(string field, string? value)
    {
        var v = Optional(field, value, 20, "Mobile");
        if (v is not null && !MobileRe().IsMatch(v)) errors.TryAdd(field, "Enter a valid mobile number (digits, optional leading +).");
        return v;
    }

    public void Add(string field, string message) => errors.TryAdd(field, message);

    public IResult Problem() => Problems.Create(400, "VALIDATION", "Please correct the highlighted fields.", new Dictionary<string, object?> { ["errors"] = errors });

    public IReadOnlyDictionary<string, string> Errors => errors;

    [GeneratedRegex(@"^[A-Z0-9][A-Z0-9_/-]{0,29}$")] private static partial Regex CodeRe();
    [GeneratedRegex(@"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")] private static partial Regex EmailRe();
    [GeneratedRegex(@"^\+?[0-9]{7,15}$")] private static partial Regex MobileRe();
}

public static class Db_
{
    public static bool IsUniqueViolation(this SqlException e) => e.Number is 2601 or 2627;

    public static IResult Conflict(string detail) => Problems.Create(409, "CONFLICT", detail);

    public static IResult NotFound(string what) => Problems.Create(404, "NOT_FOUND", $"{what} not found.");

    public static string Json(object o) => JsonSerializer.Serialize(o);
}

public sealed record Page<T>(IReadOnlyList<T> Items, int Total, int PageNumber, int PageSize);
