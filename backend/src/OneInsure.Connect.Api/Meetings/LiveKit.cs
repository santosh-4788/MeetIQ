using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// LiveKit SFU settings. ApiKey/ApiSecret come only from user secrets (development) or environment variables
/// (LiveKit__ApiKey, LiveKit__ApiSecret on servers), never from appsettings. Without them the API still starts and the
/// join endpoints answer 503.
/// </summary>
public sealed class LiveKitOptions
{
    /// <summary>Signalling URL handed to browsers, e.g. ws://127.0.0.1:7880 (dev) or wss://media.meet.oneinsure.com (production).</summary>
    public string PublicUrl { get; set; } = "";
    /// <summary>Server API (Twirp RoomService) reached by this API only. Empty = PublicUrl with ws→http.</summary>
    public string ApiUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string ApiSecret { get; set; } = "";
    /// <summary>Lifetime of a participant token. It is only needed to connect: LiveKit refreshes the token of connected clients itself.</summary>
    public int TokenTtlMinutes { get; set; } = 10;
    /// <summary>A room stays open this long after the last participant left (covers short network drops of everyone).</summary>
    public int DepartureTimeoutSeconds { get; set; } = 120;
    /// <summary>
    /// Development only: an extra plain-http listener (loopback addresses only) that serves nothing but the LiveKit webhook,
    /// because the dev LiveKit server cannot trust the self-signed https development certificate. Empty = off.
    /// </summary>
    public string? WebhookListenUrl { get; set; }

    public bool IsConfigured => !string.IsNullOrWhiteSpace(PublicUrl) && !string.IsNullOrWhiteSpace(ApiKey) && ApiSecret.Length >= 16;

    public string EffectiveApiUrl => (string.IsNullOrWhiteSpace(ApiUrl) ? PublicUrl.Replace("wss://", "https://").Replace("ws://", "http://") : ApiUrl).TrimEnd('/');
}

/// <summary>Grants of a participant access token (LiveKit VideoGrant).</summary>
internal sealed record ParticipantGrant(string Room, string Identity, string Name, string Metadata, bool CanPublish, bool CanScreenShare, bool RoomAdmin, bool CanPublishCamera = true);

/// <summary>
/// LiveKit access tokens (JWT HS256, https://docs.livekit.io/home/get-started/authentication/) and webhook verification.
/// Hand-written (≈60 lines) instead of a JWT package: HS256 with a fixed claim set is all LiveKit needs.
/// </summary>
public sealed class LiveKitTokens(IOptions<LiveKitOptions> options)
{
    LiveKitOptions O => options.Value;

    internal (string Token, DateTime ExpiresUtc) CreateParticipantToken(ParticipantGrant g, DateTime nowUtc)
    {
        // Audio-only meetings: the camera is not an allowed source, so LiveKit refuses a camera track (not just hidden in the UI).
        var sources = g.CanPublishCamera ? new JsonArray("camera", "microphone") : new JsonArray("microphone");
        if (g.CanScreenShare) { sources.Add("screen_share"); sources.Add("screen_share_audio"); }
        var exp = nowUtc.AddMinutes(Math.Clamp(O.TokenTtlMinutes, 1, 60));
        var token = Sign(new JsonObject
        {
            ["sub"] = g.Identity,
            ["jti"] = g.Identity,
            ["name"] = g.Name,
            ["metadata"] = g.Metadata,
            ["video"] = new JsonObject
            {
                ["room"] = g.Room,
                ["roomJoin"] = true,
                ["canSubscribe"] = true,
                ["canPublish"] = g.CanPublish,
                ["canPublishData"] = true,
                ["canPublishSources"] = sources,
                ["canUpdateOwnMetadata"] = false,
                ["roomAdmin"] = g.RoomAdmin,
            },
        }, nowUtc, exp);
        return (token, exp);
    }

    /// <summary>Short-lived server token for RoomService calls on one room.</summary>
    internal string CreateAdminToken(string room, DateTime nowUtc) => Sign(new JsonObject
    {
        ["video"] = new JsonObject { ["room"] = room, ["roomAdmin"] = true, ["roomCreate"] = true, ["roomList"] = true },
    }, nowUtc, nowUtc.AddMinutes(2));

    string Sign(JsonObject claims, DateTime nowUtc, DateTime expUtc)
    {
        var now = new DateTimeOffset(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc)).ToUnixTimeSeconds();
        claims["iss"] = O.ApiKey;
        claims["nbf"] = now - 10; // tolerate small clock differences between API and SFU
        claims["iat"] = now;
        claims["exp"] = new DateTimeOffset(DateTime.SpecifyKind(expUtc, DateTimeKind.Utc)).ToUnixTimeSeconds();
        var header = B64(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}"""));
        var payload = B64(Encoding.UTF8.GetBytes(claims.ToJsonString()));
        var sig = B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(O.ApiSecret), Encoding.ASCII.GetBytes($"{header}.{payload}")));
        return $"{header}.{payload}.{sig}";
    }

    /// <summary>
    /// LiveKit signs every webhook: the Authorization header is a JWT (HS256, issuer = API key) whose "sha256" claim is the
    /// base64 SHA-256 of the exact request body. Returns null when valid, otherwise the reason.
    /// </summary>
    public string? VerifyWebhook(string? authorization, ReadOnlySpan<byte> body, DateTime nowUtc)
    {
        if (string.IsNullOrWhiteSpace(authorization)) return "missing Authorization header";
        var token = authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? authorization[7..].Trim() : authorization.Trim();
        var parts = token.Split('.');
        if (parts.Length != 3) return "malformed token";
        JsonNode? header, claims;
        try
        {
            header = JsonNode.Parse(FromB64(parts[0]));
            claims = JsonNode.Parse(FromB64(parts[1]));
        }
        catch (Exception e) when (e is FormatException or JsonException) { return "malformed token"; }
        if (header?["alg"]?.GetValue<string>() != "HS256") return "unexpected algorithm";

        var expected = HMACSHA256.HashData(Encoding.UTF8.GetBytes(O.ApiSecret), Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"));
        byte[] actual;
        try { actual = FromB64(parts[2]); } catch (FormatException) { return "malformed signature"; }
        if (!CryptographicOperations.FixedTimeEquals(expected, actual)) return "invalid signature";
        if (claims?["iss"]?.GetValue<string>() != O.ApiKey) return "unknown issuer";

        var now = new DateTimeOffset(DateTime.SpecifyKind(nowUtc, DateTimeKind.Utc)).ToUnixTimeSeconds();
        if (Num(claims["exp"]) is { } exp && now > exp + 60) return "token expired";
        if (Num(claims["nbf"]) is { } nbf && now < nbf - 60) return "token not yet valid";

        var sha = claims["sha256"]?.GetValue<string>();
        if (string.IsNullOrEmpty(sha)) return "missing body hash";
        var bodyHash = Convert.ToBase64String(SHA256.HashData(body));
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(bodyHash), Encoding.ASCII.GetBytes(sha))) return "body hash mismatch";
        return null;
    }

    static long? Num(JsonNode? n) => n is JsonValue v && v.TryGetValue<long>(out var l) ? l : null;

    internal static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static byte[] FromB64(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='));
    }
}

/// <summary>The SFU could not be reached or refused a server call.</summary>
public sealed class LiveKitUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Thin client for LiveKit's RoomService (Twirp over HTTP+JSON). Every call carries a 2-minute room-scoped admin token.
/// Only host actions and the join path use it: an ongoing call never depends on this API or on SQL Server.
/// </summary>
public sealed class LiveKitRoomService(HttpClient http, LiveKitTokens tokens, IOptions<LiveKitOptions> options, IClock clock, ILogger<LiveKitRoomService> log)
{
    async Task<JsonDocument?> CallAsync(string method, string room, object body, CancellationToken ct, bool notFoundIsNull = true)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{options.Value.EffectiveApiUrl}/twirp/livekit.RoomService/{method}")
        {
            Content = JsonContent.Create(body),
        };
        req.Headers.Authorization = new("Bearer", tokens.CreateAdminToken(room, clock.UtcNow));
        HttpResponseMessage res;
        try { res = await http.SendAsync(req, ct); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new LiveKitUnavailableException("The video service is not reachable right now. Please try again in a moment.", e);
        }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (res.IsSuccessStatusCode) return JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
            if (res.StatusCode == HttpStatusCode.NotFound && notFoundIsNull) return null; // Twirp "not_found": room or participant gone
            log.LogWarning("LiveKit {Method} failed: {Status} {Body}", method, (int)res.StatusCode, text.Length > 300 ? text[..300] : text);
            throw new LiveKitUnavailableException("The video service rejected the request.");
        }
    }

    /// <summary>Creates the room (or returns the existing one) with this deployment's departure timeout.</summary>
    public async Task EnsureRoomAsync(string room, CancellationToken ct) =>
        (await CallAsync("CreateRoom", room, new { name = room, departure_timeout = options.Value.DepartureTimeoutSeconds, empty_timeout = 600 }, ct))?.Dispose();

    /// <summary>Mutes one published track of a participant. Returns false when the participant or track is not in the room.</summary>
    public async Task<bool> MuteTrackAsync(string room, string identity, string? trackSid, string source, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(trackSid))
        {
            using var p = await CallAsync("GetParticipant", room, new { room, identity }, ct);
            if (p is null) return false;
            if (!p.RootElement.TryGetProperty("tracks", out var tracks)) return false;
            foreach (var t in tracks.EnumerateArray())
                if (t.TryGetProperty("source", out var s) && string.Equals(s.GetString(), source, StringComparison.OrdinalIgnoreCase) && t.TryGetProperty("sid", out var sid))
                {
                    trackSid = sid.GetString();
                    break;
                }
            if (string.IsNullOrEmpty(trackSid)) return false;
        }
        using var r = await CallAsync("MutePublishedTrack", room, new { room, identity, track_sid = trackSid, muted = true }, ct);
        return r is not null;
    }

    public async Task<bool> RemoveParticipantAsync(string room, string identity, CancellationToken ct)
    {
        using var r = await CallAsync("RemoveParticipant", room, new { room, identity }, ct);
        return r is not null;
    }

    /// <summary>Disconnects everyone and closes the room. A room that no longer exists is not an error.</summary>
    public async Task DeleteRoomAsync(string room, CancellationToken ct) => (await CallAsync("DeleteRoom", room, new { room }, ct))?.Dispose();

    /// <summary>Identities of the participants currently in the room (hidden participants such as the recorder included). Empty when the room does not exist.</summary>
    public async Task<List<string>> ListParticipantIdentitiesAsync(string room, CancellationToken ct)
    {
        using var r = await CallAsync("ListParticipants", room, new { room }, ct);
        var list = new List<string>();
        if (r is not null && r.RootElement.TryGetProperty("participants", out var ps) && ps.ValueKind == JsonValueKind.Array)
            foreach (var p in ps.EnumerateArray())
                if (p.TryGetProperty("identity", out var id) && id.GetString() is { Length: > 0 } s) list.Add(s);
        return list;
    }

    /// <summary>Best-effort room metadata update (e.g. the recording state, read by participants who join later). Never throws.</summary>
    public async Task TryUpdateRoomMetadataAsync(string room, string metadata, CancellationToken ct)
    {
        try { (await CallAsync("UpdateRoomMetadata", room, new { room, metadata }, ct))?.Dispose(); }
        catch (LiveKitUnavailableException e) { log.LogInformation("LiveKit UpdateRoomMetadata skipped: {Message}", e.Message); }
    }

    /// <summary>Best-effort reliable data message from the server (e.g. "someone is waiting" to the hosts). Never throws.</summary>
    public async Task TrySendDataAsync(string room, string topic, object payload, IReadOnlyCollection<string>? destinationIdentities, CancellationToken ct)
    {
        try
        {
            var data = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(payload));
            (await CallAsync("SendData", room, new { room, data, kind = "RELIABLE", topic, destination_identities = destinationIdentities ?? [] }, ct))?.Dispose();
        }
        catch (LiveKitUnavailableException e)
        {
            log.LogInformation("LiveKit SendData ({Topic}) skipped: {Message}", topic, e.Message);
        }
    }
}

/// <summary>
/// The optional development listener for LiveKit webhooks (LiveKit:WebhookListenUrl). Only plain http on a loopback address is
/// accepted, and the listener answers nothing but the webhook path (see Program.cs), so no session cookie ever crosses it.
/// </summary>
public static class WebhookListener
{
    public static Uri? Parse(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out var u)) return null;
        if (u.Scheme != Uri.UriSchemeHttp || u.IsDefaultPort) return null;
        var loopback = u.Host == "localhost" || (IPAddress.TryParse(u.Host.Trim('[', ']'), out var ip) && IPAddress.IsLoopback(ip));
        return loopback ? u : null;
    }

    public static bool PortIsFree(Uri listener)
    {
        var ip = IPAddress.TryParse(listener.Host.Trim('[', ']'), out var a) ? a : IPAddress.Loopback;
        try
        {
            var l = new System.Net.Sockets.TcpListener(ip, listener.Port);
            l.Start();
            l.Stop();
            return true;
        }
        catch (System.Net.Sockets.SocketException) { return false; }
    }

    /// <summary>The configured server URLs plus the webhook listener (UseUrls replaces the list, so the existing ones are kept).</summary>
    public static string[] MergeUrls(IConfiguration config, Uri listener)
    {
        var urls = (config["urls"] ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        if (urls.Count == 0)
        {
            foreach (var p in (config["http_ports"] ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) urls.Add($"http://*:{p}");
            foreach (var p in (config["https_ports"] ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) urls.Add($"https://*:{p}");
        }
        if (urls.Count == 0) urls.Add("http://localhost:5000"); // Kestrel's default
        urls.Add($"http://{listener.Authority}");
        return [.. urls.Distinct(StringComparer.OrdinalIgnoreCase)];
    }
}

/// <summary>When a meeting can be joined: from Meetings:JoinEarlyMinutes before the start until Meetings:JoinLateMinutes after the end.</summary>
internal static class JoinWindow
{
    public sealed record Result(bool Joinable, string? Reason, string? Message, DateTime OpensUtc, DateTime ClosesUtc);

    public static Result Evaluate(string status, DateTime startUtc, DateTime endUtc, DateTime nowUtc, MeetingOptions o)
    {
        var opens = DateTime.SpecifyKind(startUtc, DateTimeKind.Utc).AddMinutes(-o.JoinEarlyMinutes);
        var closes = DateTime.SpecifyKind(endUtc, DateTimeKind.Utc).AddMinutes(o.JoinLateMinutes);
        Result No(string reason, string message) => new(false, reason, message, opens, closes);
        return status switch
        {
            "DRAFT" => No("DRAFT", "This meeting is still a draft. Schedule it before anyone can join."),
            "CANCELLED" => No("CANCELLED", "This meeting was cancelled."),
            "COMPLETED" or "EXPIRED" or "INCOMPLETE" => No("ENDED", "This meeting has ended."),
            _ when nowUtc < opens => No("TOO_EARLY", $"The meeting room opens {o.JoinEarlyMinutes} minutes before the start."),
            _ when nowUtc >= closes => No("TOO_LATE", "The time for joining this meeting has passed."),
            _ => new(true, null, null, opens, closes),
        };
    }
}
