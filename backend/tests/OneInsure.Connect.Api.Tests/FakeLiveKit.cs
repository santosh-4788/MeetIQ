using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Stand-in for LiveKit's RoomService (Twirp/JSON). Records every call; identities in <see cref="Absent"/> are "not in the
/// room" (Twirp not_found). GetParticipant reports a microphone and a camera track per identity.
/// </summary>
public sealed class FakeLiveKit
{
    public sealed record Call(string Method, JsonElement Body, string? Authorization);

    public ConcurrentQueue<Call> Calls { get; } = new();
    public ConcurrentDictionary<string, bool> Absent { get; } = new();
    /// <summary>Identities reported by ListParticipants, per room (recording consent checks). Rooms not listed are empty.</summary>
    public ConcurrentDictionary<string, string[]> Participants { get; } = new();

    public List<Call> For(string room) =>
        Calls.Where(c => (c.Body.TryGetProperty("room", out var r) && r.GetString() == room) || (c.Body.TryGetProperty("name", out var n) && n.GetString() == room)).ToList();
}

public sealed class FakeLiveKitHandler(FakeLiveKit fake) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var method = request.RequestUri!.AbsolutePath.Split('/').Last();
        var text = request.Content is null ? "{}" : await request.Content.ReadAsStringAsync(cancellationToken);
        var body = JsonDocument.Parse(text).RootElement.Clone();
        fake.Calls.Enqueue(new FakeLiveKit.Call(method, body, request.Headers.Authorization?.ToString()));

        var identity = body.TryGetProperty("identity", out var i) ? i.GetString() : null;
        if (identity is not null && fake.Absent.ContainsKey(identity) && method is "GetParticipant" or "RemoveParticipant" or "MutePublishedTrack")
            return Json(HttpStatusCode.NotFound, """{"code":"not_found","msg":"participant not found"}""");
        return method switch
        {
            "GetParticipant" => Json(HttpStatusCode.OK, JsonSerializer.Serialize(new
            {
                identity,
                tracks = new[] { new { sid = $"TR_MIC_{identity}", type = "AUDIO", source = "MICROPHONE" }, new { sid = $"TR_CAM_{identity}", type = "VIDEO", source = "CAMERA" } },
            })),
            "ListParticipants" => Json(HttpStatusCode.OK, JsonSerializer.Serialize(new
            {
                participants = (fake.Participants.TryGetValue(body.GetProperty("room").GetString() ?? "", out var ids) ? ids : []).Select(x => new { identity = x }),
            })),
            "CreateRoom" => Json(HttpStatusCode.OK, JsonSerializer.Serialize(new { name = body.GetProperty("name").GetString(), sid = "RM_test" })),
            _ => Json(HttpStatusCode.OK, "{}"),
        };
    }

    static HttpResponseMessage Json(HttpStatusCode status, string json) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
