using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Chat;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Chat, Phase 2 (V028): the feature switch, direct and group conversations, membership as the only way in (outsiders get
/// "not found" everywhere), history visibility for people added later, read marks, edit/delete windows, reactions, forward,
/// search, and attachments (allowed types, content checks, antivirus gate, member-only download).
/// </summary>
[Collection(ApiCollection.Name)]
public sealed class ChatTests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;

    async Task Exec(string sql, object? p = null)
    {
        await using var c = new SqlConnection(fx.ConnectionString);
        await c.ExecuteAsync(sql, p);
    }

    async Task SetChat(bool on)
    {
        await Exec("UPDATE app.FeatureSettings SET IsEnabled = @on WHERE FeatureKey = 'CHAT'", new { on });
        fx.Factory.Services.GetRequiredService<IMemoryCache>().Remove("chat:enabled");
    }

    async Task<TestClient> SignedIn(string email)
    {
        var c = await fx.NewClientAsync();
        Assert.Equal(HttpStatusCode.OK, (await c.LoginAsync(email, Pw)).StatusCode);
        return c;
    }

    static async Task<Guid> PersonId(TestClient c, string search)
    {
        var r = await c.Http.GetAsync($"/api/v1/chat/people?search={Uri.EscapeDataString(search)}");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return (await Json(r)).EnumerateArray().Single().GetProperty("id").GetGuid();
    }

    static async Task<Guid> Direct(TestClient c, Guid userId)
    {
        var r = await c.PostAsync("/api/v1/chat/direct", new { userId });
        Assert.True(r.StatusCode == HttpStatusCode.OK, await r.Content.ReadAsStringAsync());
        return (await Json(r)).GetProperty("id").GetGuid();
    }

    static async Task<JsonElement> Send(TestClient c, Guid conversation, string body, Guid? clientId = null, Guid? replyTo = null)
    {
        var r = await c.PostAsync($"/api/v1/chat/conversations/{conversation}/messages", new { clientMessageId = clientId ?? Guid.NewGuid(), body, replyToId = replyTo });
        Assert.True(r.StatusCode == HttpStatusCode.OK, await r.Content.ReadAsStringAsync());
        return await Json(r);
    }

    static async Task<JsonElement[]> Messages(TestClient c, Guid conversation)
    {
        var r = await c.Http.GetAsync($"/api/v1/chat/conversations/{conversation}/messages");
        Assert.True(r.StatusCode == HttpStatusCode.OK, await r.Content.ReadAsStringAsync());
        return (await Json(r)).GetProperty("items").EnumerateArray().ToArray();
    }

    static async Task<JsonElement?> ListItem(TestClient c, Guid conversation)
    {
        var list = await Json(await c.Http.GetAsync("/api/v1/chat/conversations"));
        foreach (var x in list.EnumerateArray()) if (x.GetProperty("id").GetGuid() == conversation) return x;
        return null;
    }

    static async Task<HttpResponseMessage> Upload(TestClient c, Guid conversation, string fileName, byte[] content, string? caption = null)
    {
        using var form = new MultipartFormDataContent();
        var part = new ByteArrayContent(content);
        part.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        form.Add(part, "file", fileName);
        form.Add(new StringContent(Guid.NewGuid().ToString()), "clientMessageId");
        if (caption is not null) form.Add(new StringContent(caption), "body");
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/chat/conversations/{conversation}/files") { Content = form };
        req.Headers.Add("X-XSRF-TOKEN", c.Cookie("XSRF-TOKEN"));
        return await c.Http.SendAsync(req);
    }

    static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0];

    static byte[] OfficeZip(bool withMacro)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            using (var w = new StreamWriter(zip.CreateEntry("[Content_Types].xml").Open()))
                w.Write("<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
            using (var w = new StreamWriter(zip.CreateEntry("word/document.xml").Open())) w.Write("<w:document/>");
            if (withMacro) using (var w = zip.CreateEntry("word/vbaProject.bin").Open()) w.Write([1, 2, 3]);
        }
        return ms.ToArray();
    }

    [Fact]
    public async Task Chat_is_off_until_an_administrator_switches_it_on()
    {
        await SetChat(false);
        try
        {
            var ana = await SignedIn("cana@test.invalid");
            var status = await Json(await ana.Http.GetAsync("/api/v1/chat/status"));
            Assert.False(status.GetProperty("enabled").GetBoolean());
            var r = await ana.Http.GetAsync("/api/v1/chat/conversations");
            Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
            Assert.Equal("FEATURE_DISABLED", await Code(r));

            // A signed-in user without an employee profile never gets Chat, even when it is on.
            await SetChat(true);
            var admin = await SignedIn("admin@test.invalid");
            Assert.Equal("NO_EMPLOYEE", (await Json(await admin.Http.GetAsync("/api/v1/chat/status"))).GetProperty("reason").GetString());
            Assert.Equal(HttpStatusCode.Forbidden, (await admin.Http.GetAsync("/api/v1/chat/conversations")).StatusCode);

            // Not signed in: nothing.
            var anon = await fx.NewClientAsync();
            Assert.Equal(HttpStatusCode.Unauthorized, (await anon.Http.GetAsync("/api/v1/chat/status")).StatusCode);
        }
        finally { await SetChat(true); }
    }

    [Fact]
    public async Task Direct_chat_delivers_once_tracks_read_marks_and_keeps_outsiders_out()
    {
        await SetChat(true);
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var benId = await PersonId(ana, "Ben Chat");
        var anaId = await PersonId(ben, "Ana Chat");

        // People search: no e-mail (decision D8), searchable by code.
        var people = await Json(await ana.Http.GetAsync("/api/v1/chat/people?search=C-BEN"));
        Assert.False(people[0].TryGetProperty("email", out _));
        Assert.Equal("C-BEN", people[0].GetProperty("code").GetString());

        // One conversation per pair, whoever starts it.
        var conv = await Direct(ana, benId);
        Assert.Equal(conv, await Direct(ben, anaId));
        Assert.Equal(HttpStatusCode.Conflict, (await ana.PostAsync("/api/v1/chat/direct", new { userId = await PersonId(ben, "Ana Chat") })).StatusCode);

        // A retried send (same client id) is saved once.
        var clientId = Guid.NewGuid();
        var first = await Send(ana, conv, "Hello <b>Ben</b>\u0007", clientId);
        var again = await Send(ana, conv, "Hello <b>Ben</b>", clientId);
        Assert.Equal(first.GetProperty("id").GetGuid(), again.GetProperty("id").GetGuid());
        Assert.Equal("Hello <b>Ben</b>", first.GetProperty("body").GetString()); // stored as plain text, control characters removed
        Assert.Single(await Messages(ben, conv), m => m.GetProperty("kind").GetString() == "TEXT");

        // Unread for Ben until he reads; the read mark is visible to Ana.
        Assert.Equal(1, (await ListItem(ben, conv))!.Value.GetProperty("unread").GetInt32());
        var seq = first.GetProperty("seq").GetInt64();
        Assert.Equal(HttpStatusCode.NoContent, (await ben.PostAsync($"/api/v1/chat/conversations/{conv}/read", new { seq })).StatusCode);
        Assert.Equal(0, (await ListItem(ben, conv))!.Value.GetProperty("unread").GetInt32());
        var detail = await Json(await ana.Http.GetAsync($"/api/v1/chat/conversations/{conv}"));
        Assert.Equal(seq, detail.GetProperty("members").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == benId).GetProperty("readSeq").GetInt64());

        // Mark unread / mute: muted chats do not count in the menu badge.
        await ben.PostAsync($"/api/v1/chat/conversations/{conv}/mark-unread");
        Assert.True((await ListItem(ben, conv))!.Value.GetProperty("markedUnread").GetBoolean());
        await Send(ana, conv, "ping");
        Assert.True((await Json(await ben.Http.GetAsync("/api/v1/chat/status"))).GetProperty("unread").GetProperty("messages").GetInt32() >= 1);
        await ben.PostAsync($"/api/v1/chat/conversations/{conv}/mute", new { forever = true });
        var benUnreadMuted = (await Json(await ben.Http.GetAsync("/api/v1/chat/status"))).GetProperty("unread");
        Assert.True((await ListItem(ben, conv))!.Value.GetProperty("muted").GetBoolean());
        await ben.PostAsync($"/api/v1/chat/conversations/{conv}/mute", new { minutes = 0 });
        Assert.False((await ListItem(ben, conv))!.Value.GetProperty("muted").GetBoolean());
        Assert.True(benUnreadMuted.GetProperty("messages").GetInt32() < (await Json(await ben.Http.GetAsync("/api/v1/chat/status"))).GetProperty("unread").GetProperty("messages").GetInt32());

        // Dan is not in the conversation: "not found" for everything, and it is not in his list.
        var mid = first.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NotFound, (await dan.Http.GetAsync($"/api/v1/chat/conversations/{conv}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.Http.GetAsync($"/api/v1/chat/conversations/{conv}/messages")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync($"/api/v1/chat/conversations/{conv}/messages", new { body = "hi" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync($"/api/v1/chat/messages/{mid}/reactions", new { emoji = "👍" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PutAsync($"/api/v1/chat/messages/{mid}", new { body = "x" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.DeleteAsync($"/api/v1/chat/messages/{mid}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync($"/api/v1/chat/messages/{mid}/forward", new { conversationIds = new[] { conv } })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.PostAsync($"/api/v1/chat/conversations/{conv}/read", new { seq })).StatusCode);
        Assert.Null(await ListItem(dan, conv));
        var found = await Json(await dan.Http.GetAsync("/api/v1/chat/search?q=Hello"));
        Assert.Empty(found.GetProperty("items").EnumerateArray());
        Assert.NotEmpty((await Json(await ben.Http.GetAsync("/api/v1/chat/search?q=Hello"))).GetProperty("items").EnumerateArray());

        // Replying to a message from another conversation is refused.
        var other = await Direct(ana, await PersonId(ana, "Cat Chat"));
        var r = await ana.PostAsync($"/api/v1/chat/conversations/{other}/messages", new { body = "x", replyToId = mid });
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }

    [Fact]
    public async Task Edit_delete_reactions_and_forward_follow_the_rules()
    {
        await SetChat(true);
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var conv = await Direct(ana, await PersonId(ana, "Ben Chat"));
        var msg = await Send(ana, conv, "Original text");
        var id = msg.GetProperty("id").GetGuid();

        Assert.Equal(HttpStatusCode.Forbidden, (await ben.PutAsync($"/api/v1/chat/messages/{id}", new { body = "hijack" })).StatusCode);
        var edited = await Json(await ana.PutAsync($"/api/v1/chat/messages/{id}", new { body = "Edited text" }));
        Assert.Equal("Edited text", edited.GetProperty("body").GetString());
        Assert.True(edited.TryGetProperty("editedUtc", out var e) && e.ValueKind == JsonValueKind.String);

        // Edit window (15 min) and delete window (1 h).
        var old = await Send(ana, conv, "Old message");
        await Exec("UPDATE chat.TRN_ChatMessage SET CreatedUtc = DATEADD(MINUTE, -20, CreatedUtc) WHERE PublicId = @id", new { id = old.GetProperty("id").GetGuid() });
        Assert.Equal(HttpStatusCode.Conflict, (await ana.PutAsync($"/api/v1/chat/messages/{old.GetProperty("id").GetGuid()}", new { body = "late" })).StatusCode);
        await Exec("UPDATE chat.TRN_ChatMessage SET CreatedUtc = DATEADD(MINUTE, -61, CreatedUtc) WHERE PublicId = @id", new { id = old.GetProperty("id").GetGuid() });
        Assert.Equal(HttpStatusCode.Conflict, (await ana.DeleteAsync($"/api/v1/chat/messages/{old.GetProperty("id").GetGuid()}")).StatusCode);

        // Reactions toggle; only emoji accepted.
        var reacted = await Json(await ben.PostAsync($"/api/v1/chat/messages/{id}/reactions", new { emoji = "👍" }));
        Assert.Single(reacted.GetProperty("reactions").EnumerateArray());
        Assert.Equal(HttpStatusCode.BadRequest, (await ben.PostAsync($"/api/v1/chat/messages/{id}/reactions", new { emoji = "<script>" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ben.PostAsync($"/api/v1/chat/messages/{id}/reactions", new { emoji = "ok" })).StatusCode);
        var unreacted = await Json(await ben.PostAsync($"/api/v1/chat/messages/{id}/reactions", new { emoji = "👍" }));
        Assert.Empty(unreacted.GetProperty("reactions").EnumerateArray());

        // Forward into another of my chats: marked forwarded.
        var cat = await Direct(ana, await PersonId(ana, "Cat Chat"));
        var fwd = await Json(await ana.PostAsync($"/api/v1/chat/messages/{id}/forward", new { conversationIds = new[] { cat } }));
        Assert.True(fwd[0].GetProperty("forwarded").GetBoolean());
        Assert.Equal("Edited text", fwd[0].GetProperty("body").GetString());

        // Delete for everyone: text gone for both.
        Assert.Equal(HttpStatusCode.Forbidden, (await ben.DeleteAsync($"/api/v1/chat/messages/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/messages/{id}")).StatusCode);
        var seen = (await Messages(ben, conv)).Single(m => m.GetProperty("id").GetGuid() == id);
        Assert.True(seen.GetProperty("deleted").GetBoolean());
        Assert.Equal(JsonValueKind.Null, seen.GetProperty("body").ValueKind);
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatMessage WHERE PublicId = @id AND Body IS NOT NULL", new { id }));
    }

    [Fact]
    public async Task Groups_admins_manage_members_new_members_see_only_new_messages_removed_members_lose_access()
    {
        await SetChat(true);
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var cat = await SignedIn("ccat@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var benId = await PersonId(ana, "Ben Chat");
        var catId = await PersonId(ana, "Cat Chat");
        var danId = await PersonId(ana, "Dan Chat");

        Assert.Equal(HttpStatusCode.BadRequest, (await ana.PostAsync("/api/v1/chat/groups", new { name = "", memberIds = new[] { benId } })).StatusCode);
        var created = await ana.PostAsync("/api/v1/chat/groups", new { name = "Claims team", description = "Daily claims", memberIds = new[] { benId, catId } });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var createdJson = await Json(created);
        var g = createdJson.GetProperty("id").GetGuid();
        Assert.Equal("ADMIN", createdJson.GetProperty("role").GetString());
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'CHAT_GROUP_CREATED' AND EntityId = @g", new { g = g.ToString() }));

        await Send(ana, g, "Before Dan joined");
        Assert.Equal(3, (await ListItem(cat, g))!.Value.GetProperty("memberCount").GetInt32());
        Assert.True((await ListItem(cat, g))!.Value.GetProperty("otherActive").GetBoolean()); // groups can always be written to (bug found by the browser test)

        // Members are not admins: they cannot add, rename or remove others.
        Assert.Equal(HttpStatusCode.Forbidden, (await ben.PostAsync($"/api/v1/chat/conversations/{g}/members", new { userIds = new[] { danId } })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ben.PutAsync($"/api/v1/chat/conversations/{g}", new { name = "Mine" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ben.DeleteAsync($"/api/v1/chat/conversations/{g}/members/{catId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await dan.Http.GetAsync($"/api/v1/chat/conversations/{g}/messages")).StatusCode);

        // Dan is added: he sees the group from now on, not the earlier messages.
        Assert.Equal(HttpStatusCode.NoContent, (await ana.PostAsync($"/api/v1/chat/conversations/{g}/members", new { userIds = new[] { danId } })).StatusCode);
        await Send(ben, g, "After Dan joined");
        var danSees = (await Messages(dan, g)).Select(m => m.GetProperty("body").GetString()).ToList();
        Assert.DoesNotContain("Before Dan joined", danSees);
        Assert.Contains("After Dan joined", danSees);
        Assert.Empty((await Json(await dan.Http.GetAsync("/api/v1/chat/search?q=Before%20Dan"))).GetProperty("items").EnumerateArray());

        // Rename (admin) leaves a system line.
        Assert.Equal(HttpStatusCode.OK, (await ana.PutAsync($"/api/v1/chat/conversations/{g}", new { name = "Claims squad", description = "x" })).StatusCode);
        Assert.Contains(await Messages(cat, g), m => m.GetProperty("kind").GetString() == "SYSTEM" && m.GetProperty("body").GetString()!.Contains("Claims squad"));

        // Cat is removed: from then on everything about the group is "not found" for her.
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/conversations/{g}/members/{catId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await cat.Http.GetAsync($"/api/v1/chat/conversations/{g}/messages")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await cat.PostAsync($"/api/v1/chat/conversations/{g}/messages", new { body = "still here?" })).StatusCode);
        Assert.Null(await ListItem(cat, g));
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'CHAT_MEMBER_REMOVED' AND EntityId = @g", new { g = g.ToString() }));

        // The only admin cannot leave while others remain; after making Ben admin she can.
        var leave = await ana.DeleteAsync($"/api/v1/chat/conversations/{g}/members/{await PersonId(ben, "Ana Chat")}");
        Assert.Equal(HttpStatusCode.Conflict, leave.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ana.PutAsync($"/api/v1/chat/conversations/{g}/members/{benId}/role", new { role = "ADMIN" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/conversations/{g}/members/{await PersonId(ben, "Ana Chat")}")).StatusCode);
        Assert.Equal("ADMIN", (await ListItem(ben, g))!.Value.GetProperty("role").GetString());
        Assert.Null(await ListItem(ana, g));
    }

    [Fact]
    public async Task Attachments_are_checked_scanned_before_download_and_only_members_can_download()
    {
        await SetChat(true);
        var ana = await SignedIn("cana@test.invalid");
        var ben = await SignedIn("cben@test.invalid");
        var dan = await SignedIn("cdan@test.invalid");
        var conv = await Direct(ana, await PersonId(ana, "Ben Chat"));

        // Refused: not on the allowed list, content not matching the extension, macros, binary "text", empty.
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "setup.exe", [0x4D, 0x5A, 0x90, 0])).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "page.html", Encoding.UTF8.GetBytes("<script>alert(1)</script>"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "logo.svg", Encoding.UTF8.GetBytes("<svg onload=alert(1)>"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "photo.png", Encoding.UTF8.GetBytes("<html>not a png</html>"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "report.docx", OfficeZip(withMacro: true))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "report.docm", OfficeZip(withMacro: true))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "notes.txt", [0x4D, 0x5A, 0, 0, 0])).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Upload(ana, conv, "empty.pdf", [])).StatusCode);
        Assert.True(await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'CHAT_FILE_REJECTED'") >= 3); // mismatching content, macro, binary text (unlisted types are refused before saving)

        // Accepted (path tricks in the name are cut to the file name).
        var up = await Upload(ana, conv, @"..\..\windows\photo.png", Png, "Screenshot");
        Assert.True(up.StatusCode == HttpStatusCode.OK, await up.Content.ReadAsStringAsync());
        var msg = await Json(up);
        var file = msg.GetProperty("file");
        Assert.Equal("photo.png", file.GetProperty("name").GetString());
        Assert.Equal("PENDING", file.GetProperty("status").GetString());
        var fileId = file.GetProperty("id").GetGuid();
        var key = await fx.QueryAsync<string>("SELECT StorageKey FROM chat.TRN_ChatFile WHERE PublicId = @fileId", new { fileId });
        Assert.DoesNotContain(".png", key);
        Assert.DoesNotContain(key, await up.Content.ReadAsStringAsync());
        Assert.True(OkDocx(await Upload(ana, conv, "report.docx", OfficeZip(withMacro: false))));

        // Not downloadable until the antivirus pass has run. (The background worker may already have woken on the upload: put it back.)
        for (var i = 0; i < 50 && await fx.QueryAsync<int>("SELECT COUNT(*) FROM chat.TRN_ChatFile WHERE ScanStatus = 'PENDING'") > 0; i++) await Task.Delay(100);
        await Task.Delay(300);
        await Exec("UPDATE chat.TRN_ChatFile SET ScanStatus = 'PENDING', ScannedUtc = NULL WHERE PublicId = @fileId", new { fileId });
        Assert.Equal(HttpStatusCode.Conflict, (await ben.Http.GetAsync($"/api/v1/chat/files/{fileId}")).StatusCode);
        await fx.Factory.Services.GetRequiredService<ChatFileScanWorker>().RunOnceAsync();
        Assert.Equal("CLEAN", (await Messages(ben, conv)).Single(m => m.GetProperty("id").GetGuid() == msg.GetProperty("id").GetGuid()).GetProperty("file").GetProperty("status").GetString());

        var dl = await ben.Http.GetAsync($"/api/v1/chat/files/{fileId}");
        Assert.Equal(HttpStatusCode.OK, dl.StatusCode);
        Assert.Equal("attachment", dl.Content.Headers.ContentDisposition?.DispositionType);
        // Real type (from our file-type list) and a plain quoted name first, so Android saves "x.png", not "<id>.bin".
        Assert.Equal("image/png", dl.Content.Headers.ContentType?.MediaType);
        Assert.Matches("^attachment; filename=\"[^\"]+\\.png\"$",string.Join(",", dl.Content.Headers.GetValues("Content-Disposition")));
        Assert.Equal(Png, await dl.Content.ReadAsByteArrayAsync());
        var inline = await ben.Http.GetAsync($"/api/v1/chat/files/{fileId}?inline=1");
        Assert.Equal("image/png", inline.Content.Headers.ContentType?.MediaType);
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'CHAT_FILE_DOWNLOADED' AND EntityId = @id", new { id = fileId.ToString() }));

        // Outsider: not found. A blocked file is never served.
        Assert.Equal(HttpStatusCode.NotFound, (await dan.Http.GetAsync($"/api/v1/chat/files/{fileId}")).StatusCode);
        await Exec("UPDATE chat.TRN_ChatFile SET ScanStatus = 'BLOCKED' WHERE PublicId = @fileId", new { fileId });
        Assert.Equal(HttpStatusCode.Forbidden, (await ben.Http.GetAsync($"/api/v1/chat/files/{fileId}")).StatusCode);
        await Exec("UPDATE chat.TRN_ChatFile SET ScanStatus = 'CLEAN' WHERE PublicId = @fileId", new { fileId });

        // Deleting the message removes the attachment for good.
        Assert.Equal(HttpStatusCode.NoContent, (await ana.DeleteAsync($"/api/v1/chat/messages/{msg.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ben.Http.GetAsync($"/api/v1/chat/files/{fileId}")).StatusCode);
        Assert.False(File.Exists(Path.Combine(fx.RecordingRoot, "chat", key.Replace('/', Path.DirectorySeparatorChar))));

        // File-name search.
        Assert.NotEmpty((await Json(await ben.Http.GetAsync("/api/v1/chat/search?q=report"))).GetProperty("items").EnumerateArray());
    }

    static bool OkDocx(HttpResponseMessage r) => r.StatusCode == HttpStatusCode.OK;

    [Fact]
    public void File_names_are_cleaned_and_storage_keys_cannot_escape_the_root()
    {
        Assert.Equal("photo.png", ChatFileEndpoints.SafeName(@"C:\Users\x\photo.png"));
        Assert.Equal("passwd", ChatFileEndpoints.SafeName("../../etc/passwd"));
        Assert.Equal("file", ChatFileEndpoints.SafeName("..."));
        Assert.Equal("ab.txt", ChatFileEndpoints.SafeName("a\u0000b.txt"));
        Assert.Throws<InvalidOperationException>(() => ChatFileEndpoints.Resolve(@"C:\data\chat", "../../windows/win.ini"));
        Assert.True(ChatAccess.IsEmoji("👍"));
        Assert.True(ChatAccess.IsEmoji("❤️"));
        Assert.True(ChatAccess.IsEmoji("👍🏽"));
        Assert.False(ChatAccess.IsEmoji("a"));
        Assert.False(ChatAccess.IsEmoji("<"));
        Assert.False(ChatAccess.IsEmoji(""));
    }

    [Fact]
    public void Download_headers_work_for_phone_download_managers()
    {
        // Android WebView (URLUtil.guessFileName) reads only a plain `attachment; filename="..."`.
        Assert.Equal("attachment; filename=\"Sales Report (Nov).xlsx\"", ChatFileEndpoints.AttachmentDisposition("Sales Report (Nov).xlsx"));
        Assert.Equal("attachment; filename=\"a_b.txt\"", ChatFileEndpoints.AttachmentDisposition("a\"b.txt").Replace("; filename*=UTF-8''a%22b.txt", ""));
        Assert.Equal("attachment; filename=\"_____.pdf\"; filename*=UTF-8''%E0%A4%B0%E0%A4%BF%E0%A4%AA%E0%A5%8B%E0%A4%B0.pdf", ChatFileEndpoints.AttachmentDisposition("रिपोर.pdf"));
        Assert.Equal("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ChatFileEndpoints.DownloadContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
        Assert.Equal("application/octet-stream", ChatFileEndpoints.DownloadContentType("text/html"));
        Assert.Equal("application/octet-stream", ChatFileEndpoints.DownloadContentType("image/svg+xml"));
        Assert.Equal("application/octet-stream", ChatFileEndpoints.DownloadContentType(null));
    }
}
