using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Chat;

namespace OneInsure.Connect.Api.Tests;

/// <summary>24 Nov 2026: own profile pictures (upload, checks, serving, remove) and the new BRB / Appear offline availability.</summary>
[Collection(ApiCollection.Name)]
public sealed class ChatProfileTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0];
    static readonly byte[] Jpg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 16, (byte)'J', (byte)'F', (byte)'I', (byte)'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9];

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    static async Task<HttpResponseMessage> UploadPhoto(TestClient c, byte[] content, string name = "me.png")
    {
        using var form = new MultipartFormDataContent();
        var part = new ByteArrayContent(content);
        part.Headers.ContentType = new MediaTypeHeaderValue("image/png"); // the server goes by the content, not this
        form.Add(part, "file", name);
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/account/photo") { Content = form };
        req.Headers.Add("X-XSRF-TOKEN", c.Cookie("XSRF-TOKEN"));
        return await c.Http.SendAsync(req);
    }

    static async Task<HttpResponseMessage> Delete(TestClient c, string path)
    {
        var req = new HttpRequestMessage(HttpMethod.Delete, path);
        req.Headers.Add("X-XSRF-TOKEN", c.Cookie("XSRF-TOKEN"));
        return await c.Http.SendAsync(req);
    }

    static async Task<Dictionary<Guid, string>> Photos(TestClient c) =>
        (await Json(await c.Http.GetAsync("/api/v1/people/photos"))).EnumerateArray().ToDictionary(x => x.GetProperty("id").GetGuid(), x => x.GetProperty("v").GetString()!);

    [Fact]
    public async Task Own_profile_picture_upload_checks_serving_and_removal()
    {
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");

        // Only real pictures: a text file named .png is refused.
        var bad = await UploadPhoto(ana, "not a picture"u8.ToArray());
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        var ok = await UploadPhoto(ana, Png);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var body = await Json(ok);
        var anaId = body.GetProperty("id").GetGuid();
        var v1 = body.GetProperty("v").GetString();

        // Colleagues see it in the list and can load it (never the storage path); the answer is not sniffable.
        Assert.Equal(v1, (await Photos(ben))[anaId]);
        var img = await ben.Http.GetAsync($"/api/v1/people/{anaId}/photo?v={v1}");
        Assert.Equal(HttpStatusCode.OK, img.StatusCode);
        Assert.Equal("image/png", img.Content.Headers.ContentType?.MediaType);
        Assert.Equal(Png, await img.Content.ReadAsByteArrayAsync());
        Assert.Contains("nosniff", string.Join(",", img.Headers.GetValues("X-Content-Type-Options")));
        Assert.DoesNotContain("photos/", body.ToString());

        // Ben changing his picture never touches Ana's.
        Assert.Equal(HttpStatusCode.OK, (await UploadPhoto(ben, Jpg, "ben.jpg")).StatusCode);
        Assert.Equal(v1, (await Photos(ben))[anaId]);

        // Replacing gives a new version; removing takes it out of the list and the address answers 404.
        var v2 = (await Json(await UploadPhoto(ana, Jpg, "new.jpg"))).GetProperty("v").GetString();
        Assert.NotEqual(v1, v2);
        Assert.Equal(HttpStatusCode.NoContent, (await Delete(ana, "/api/v1/account/photo")).StatusCode);
        Assert.False((await Photos(ben)).ContainsKey(anaId));
        Assert.Equal(HttpStatusCode.NotFound, (await ben.Http.GetAsync($"/api/v1/people/{anaId}/photo")).StatusCode);

        // Not signed in: nothing.
        var anon = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Http.GetAsync("/api/v1/people/photos")).StatusCode);
        await Delete(ben, "/api/v1/account/photo");
    }

    [Theory]
    [InlineData(new byte[] { 0xFF, 0xD8, 0xFF, 0xDB }, "jpg")]
    [InlineData(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, "png")]
    [InlineData(new byte[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F', 1, 2, 3, 4, (byte)'W', (byte)'E', (byte)'B', (byte)'P' }, "webp")]
    [InlineData(new byte[] { (byte)'G', (byte)'I', (byte)'F', (byte)'8', (byte)'9', (byte)'a' }, null)]
    [InlineData(new byte[] { (byte)'<', (byte)'s', (byte)'v', (byte)'g' }, null)]
    public void Picture_type_is_decided_by_content(byte[] head, string? expected) => Assert.Equal(expected, ProfilePhotoEndpoints.Sniff(head));

    [Fact]
    public async Task Be_right_back_and_appear_offline()
    {
        await using (var c = new SqlConnection(fx.ConnectionString))
            await c.ExecuteAsync("UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'CHAT'");
        fx.Factory.Services.GetRequiredService<IMemoryCache>().Remove("chat:enabled");
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var anaUserId = await new SqlConnection(fx.ConnectionString).ExecuteScalarAsync<long>("SELECT UserId FROM auth.Users WHERE Email = 'cana@test.invalid'");
        var tracker = fx.Factory.Services.GetRequiredService<PresenceTracker>();
        tracker.Add(new PresenceTracker.Conn("test-ana-online", anaUserId, Guid.NewGuid(), null!)); // Ana has the portal open
        try
        {
            async Task<string> AnaAsBenSeesIt() =>
                (await Json(await ben.Http.GetAsync("/api/v1/chat/people?search=C-ANA"))).EnumerateArray().Single().GetProperty("presence").GetProperty("state").GetString()!;

            Assert.Equal(HttpStatusCode.BadRequest, (await ana.PutAsync("/api/v1/chat/me/preferences", new { availability = "INVISIBLE" })).StatusCode);

            Assert.Equal(HttpStatusCode.OK, (await ana.PutAsync("/api/v1/chat/me/preferences", new { availability = "BRB" })).StatusCode);
            Assert.Equal("BRB", await AnaAsBenSeesIt());

            var r = await ana.PutAsync("/api/v1/chat/me/preferences", new { availability = "APPEAR_OFFLINE" });
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            Assert.Equal("APPEAR_OFFLINE", (await Json(r)).GetProperty("availability").GetString());
            var seen = (await Json(await ben.Http.GetAsync("/api/v1/chat/people?search=C-ANA"))).EnumerateArray().Single().GetProperty("presence");
            Assert.Equal("OFFLINE", seen.GetProperty("state").GetString());
            Assert.Equal(JsonValueKind.Null, seen.GetProperty("lastSeenUtc").ValueKind); // no "last seen just now" giving it away

            Assert.Equal(HttpStatusCode.OK, (await ana.PutAsync("/api/v1/chat/me/preferences", new { availability = "AVAILABLE" })).StatusCode);
            Assert.Equal("AVAILABLE", await AnaAsBenSeesIt());
        }
        finally
        {
            tracker.Remove("test-ana-online", out _);
            await ana.PutAsync("/api/v1/chat/me/preferences", new { availability = "AVAILABLE" });
        }
    }
}
