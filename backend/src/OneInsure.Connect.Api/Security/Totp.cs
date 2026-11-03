using System.Security.Cryptography;
using System.Text;

namespace OneInsure.Connect.Api.Security;

/// <summary>RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits): what authenticator apps implement.</summary>
public static class Totp
{
    public const int Digits = 6;
    public const int StepSeconds = 30;

    public static long TimeStep(DateTime utc) => new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToUnixTimeSeconds() / StepSeconds;

    public static string Code(byte[] secret, long timeStep, int digits = Digits)
    {
        Span<byte> counter = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(counter, timeStep);
        var hash = HMACSHA1.HashData(secret, counter);
        var offset = hash[^1] & 0x0F;
        var binary = ((hash[offset] & 0x7F) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        var mod = (int)Math.Pow(10, digits);
        return (binary % mod).ToString().PadLeft(digits, '0');
    }

    /// <summary>Returns the matching time step within ±<paramref name="window"/> steps (clock drift), or null.</summary>
    public static long? Match(byte[] secret, string code, DateTime utcNow, int window = 1)
    {
        if (code.Length != Digits || !code.All(char.IsAsciiDigit)) return null;
        var now = TimeStep(utcNow);
        for (var s = now - window; s <= now + window; s++)
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Code(secret, s)), Encoding.ASCII.GetBytes(code)))
                return s;
        return null;
    }

    const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>RFC 4648 base32 without padding (the format authenticator apps accept for manual entry).</summary>
    public static string Base32(byte[] data)
    {
        var sb = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5) { sb.Append(Alphabet[(buffer >> (bits - 5)) & 31]); bits -= 5; }
        }
        if (bits > 0) sb.Append(Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static string OtpAuthUri(string issuer, string account, byte[] secret) =>
        $"otpauth://totp/{Uri.EscapeDataString(issuer)}:{Uri.EscapeDataString(account)}?secret={Base32(secret)}&issuer={Uri.EscapeDataString(issuer)}&algorithm=SHA1&digits={Digits}&period={StepSeconds}";
}
