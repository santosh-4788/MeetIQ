using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OneInsure.Connect.Recorder;

/// <summary>Minimal LiveKit access-token signer and RoomService (Twirp/JSON) client.</summary>
public sealed class LiveKitClient(LiveKitOptions options)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// <summary>Least-privilege token for the recorder: hidden, subscribe-only, no publish, no data.</summary>
    public string CreateRecorderToken(string room, string identity) => Sign(new JsonObject
    {
        ["sub"] = identity,
        ["name"] = "OneInsure Recorder",
        ["video"] = new JsonObject
        {
            ["room"] = room,
            ["roomJoin"] = true,
            ["canSubscribe"] = true,
            ["canPublish"] = false,
            ["canPublishData"] = false,
            ["canUpdateOwnMetadata"] = false,
            ["hidden"] = true,
            ["recorder"] = true,
        },
    }, TimeSpan.FromMinutes(options.TokenTtlMinutes));

    public async Task<bool> RoomExistsAsync(string room, CancellationToken ct)
    {
        var token = Sign(new JsonObject { ["video"] = new JsonObject { ["roomList"] = true } }, TimeSpan.FromMinutes(1));
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{HttpBase()}/twirp/livekit.RoomService/ListRooms")
        {
            Content = JsonContent.Create(new { names = new[] { room } }),
        };
        req.Headers.Authorization = new("Bearer", token);
        using var res = await Http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        return doc.RootElement.TryGetProperty("rooms", out var rooms) && rooms.GetArrayLength() > 0;
    }

    private string HttpBase() => options.Url.Replace("wss://", "https://").Replace("ws://", "http://").TrimEnd('/');

    private string Sign(JsonObject claims, TimeSpan ttl)
    {
        if (string.IsNullOrEmpty(options.ApiKey) || string.IsNullOrEmpty(options.ApiSecret))
            throw new InvalidOperationException("LiveKit API key/secret are not configured (set LIVEKIT_API_KEY and LIVEKIT_API_SECRET).");
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        claims["iss"] = options.ApiKey;
        claims["nbf"] = now - 5;
        claims["exp"] = now + (long)ttl.TotalSeconds;
        var header = B64(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}"""));
        var payload = B64(Encoding.UTF8.GetBytes(claims.ToJsonString()));
        var sig = B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(options.ApiSecret), Encoding.ASCII.GetBytes($"{header}.{payload}")));
        return $"{header}.{payload}.{sig}";
    }

    private static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
