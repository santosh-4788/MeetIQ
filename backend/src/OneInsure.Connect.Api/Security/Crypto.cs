using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;

namespace OneInsure.Connect.Api.Security;

/// <summary>Opaque random tokens. Only their SHA-256 is stored; the raw value lives in the cookie or e-mail.</summary>
public static class Tokens
{
    public static string New(int bytes = 32) => Base64Url(RandomNumberGenerator.GetBytes(bytes));

    public static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    public static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    static string Base64Url(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>ASP.NET Core Identity's PBKDF2 hasher (v3 format: HMAC-SHA512, 100,000 iterations, per-hash salt).</summary>
public sealed class Passwords
{
    static readonly object Subject = new();
    readonly PasswordHasher<object> hasher = new();
    // Verified against when the login name is unknown, so both paths cost the same.
    readonly string dummyHash;

    public Passwords() => dummyHash = hasher.HashPassword(Subject, Tokens.New());

    public string Hash(string password) => hasher.HashPassword(Subject, password);

    public PasswordVerificationResult Verify(string? hash, string password)
    {
        PasswordVerificationResult r;
        try { r = hasher.VerifyHashedPassword(Subject, hash ?? dummyHash, password); }
        catch (FormatException) { r = PasswordVerificationResult.Failed; }
        return hash is null ? PasswordVerificationResult.Failed : r;
    }
}

/// <summary>Server-side password policy (authoritative). Mirrors passwordRules in frontend/src/lib/validation.ts.</summary>
public static class PasswordPolicy
{
    public const int MinLength = 12;
    public const int MaxLength = 128;

    public static List<string> Violations(string password, params string?[] personalValues)
    {
        var v = new List<string>();
        if (password.Length < MinLength) v.Add($"At least {MinLength} characters");
        if (password.Length > MaxLength) v.Add($"At most {MaxLength} characters");
        if (!password.Any(char.IsAsciiLetterUpper)) v.Add("An uppercase letter");
        if (!password.Any(char.IsAsciiLetterLower)) v.Add("A lowercase letter");
        if (!password.Any(char.IsAsciiDigit)) v.Add("A number");
        if (password.All(char.IsAsciiLetterOrDigit)) v.Add("A symbol");
        foreach (var p in personalValues)
        {
            var part = p?.Split('@')[0];
            if (part is { Length: >= 4 } && password.Contains(part, StringComparison.OrdinalIgnoreCase))
            {
                v.Add("Must not contain your e-mail name or employee ID");
                break;
            }
        }
        return v;
    }
}
