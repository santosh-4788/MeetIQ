using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Dapper;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Mvc.Testing.Handlers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.DependencyInjection;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Tests;

/// <summary>
/// Creates a disposable OneInsureVideoMeetingDB_ApiTest_* database on LocalDB with database\deploy-database.ps1
/// (the real migrations), seeds fictitious users, hosts the API in-process, and drops the database afterwards.
/// </summary>
public sealed class ApiFixture : IAsyncLifetime
{
    public const string Server = @"(localdb)\MSSQLLocalDB";
    public const string Password = "Correct#Horse7Battery";
    public string Database { get; } = "OneInsureVideoMeetingDB_ApiTest_" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
    public string ConnectionString => $"Server={Server};Database={Database};Integrated Security=true;TrustServerCertificate=true";
    public WebApplicationFactory<Program> Factory { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var root = FindRepoRoot();
        var psi = new ProcessStartInfo("powershell.exe",
            $"-NoProfile -ExecutionPolicy Bypass -File \"{Path.Combine(root, "database", "deploy-database.ps1")}\" -Server \"{Server}\" -Database {Database} -CreateDatabase")
        { RedirectStandardOutput = true, RedirectStandardError = true };
        using (var p = Process.Start(psi)!)
        {
            var output = await p.StandardOutput.ReadToEndAsync() + await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            if (p.ExitCode != 0) throw new InvalidOperationException("Migration failed: " + output);
        }

        await SeedAsync();

        Environment.SetEnvironmentVariable("ConnectionStrings__OneInsure", ConnectionString);
        Environment.SetEnvironmentVariable("Security__CookieSecure", "false"); // TestServer is plain http
        Environment.SetEnvironmentVariable("Security__LoginPermitPerMinute", "1000");
        Environment.SetEnvironmentVariable("Security__PasswordResetPermitPer5Minutes", "1000");
        // Every test client shares one address: the anonymous join limit is tested separately (MeetingLinkTests).
        Environment.SetEnvironmentVariable("Meetings__JoinPermitPerMinute", "1000");
        Environment.SetEnvironmentVariable("Email__Enabled", "true");
        Environment.SetEnvironmentVariable("Email__PollSeconds", "3600"); // tests drive the worker with RunOnceAsync
        Environment.SetEnvironmentVariable("Email__TemplateId", "103");
        // Meeting tests queue many e-mails; one worker run must drain the outbox so EmailTests' "nothing is sent twice" holds in any order.
        Environment.SetEnvironmentVariable("Email__BatchSize", "1000");
        Environment.SetEnvironmentVariable("Reminders__PollSeconds", "3600"); // tests drive the reminder worker with RunOnceAsync
        // Phase 4: a fictitious LiveKit. Server calls (Twirp RoomService) go to FakeLiveKit instead of the network.
        Environment.SetEnvironmentVariable("LiveKit__PublicUrl", LiveKitPublicUrl);
        Environment.SetEnvironmentVariable("LiveKit__ApiUrl", "http://livekit.test");
        Environment.SetEnvironmentVariable("LiveKit__ApiKey", LiveKitKey);
        Environment.SetEnvironmentVariable("LiveKit__ApiSecret", LiveKitSecret);
        // Phase 5: recordings go to a temporary library; the recorder process is replaced by FakeRecorderLauncher, FFmpeg/FFprobe are real
        // (verification runs on real MP4 files). Tests drive the workers with RunOnceAsync.
        Directory.CreateDirectory(RecordingRoot);
        Environment.SetEnvironmentVariable("Recording__Environment", "Test");
        Environment.SetEnvironmentVariable("Recording__StorageRoot", Path.Combine(RecordingRoot, "library"));
        Environment.SetEnvironmentVariable("Recording__SpoolRoot", Path.Combine(RecordingRoot, "spool"));
        Environment.SetEnvironmentVariable("Recording__RecorderExePath", typeof(ApiFixture).Assembly.Location);
        Environment.SetEnvironmentVariable("Recording__FfmpegPath", Path.Combine(FfmpegDir, "ffmpeg.exe"));
        Environment.SetEnvironmentVariable("Recording__FfprobePath", Path.Combine(FfmpegDir, "ffprobe.exe"));
        Environment.SetEnvironmentVariable("Recording__PollSeconds", "3600");
        Environment.SetEnvironmentVariable("Recording__RetentionEnabled", "false");
        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Testing");
            b.ConfigureTestServices(s =>
            {
                s.AddHttpClient<OneInsure.Connect.Api.Meetings.LiveKitRoomService>().ConfigurePrimaryHttpMessageHandler(() => new FakeLiveKitHandler(LiveKit));
                s.AddSingleton<OneInsure.Connect.Api.Recording.IRecorderLauncher>(Recorder);
            });
        });
    }

    public const string LiveKitPublicUrl = "ws://livekit.test:7880";
    public const string LiveKitKey = "APItestKey01";
    public const string LiveKitSecret = "test-secret-0123456789-abcdefghijklmnopqrstuv";
    public FakeLiveKit LiveKit { get; } = new();
    public FakeRecorderLauncher Recorder { get; } = new();
    public string RecordingRoot { get; } = Path.Combine(Path.GetTempPath(), "oic-rec-tests-" + Guid.NewGuid().ToString("N")[..8]);
    /// <summary>Real FFmpeg (C:/ffmpeg/... on the development PC; override with OIC_FFMPEG_DIR).</summary>
    public static string FfmpegDir => Environment.GetEnvironmentVariable("OIC_FFMPEG_DIR") ?? "C:/ffmpeg/ffmpeg-7.1.1-essentials_build/bin";

    async Task SeedAsync()
    {
        var hash = new Passwords().Hash(Password);
        await using var c = new SqlConnection(ConnectionString);
        await c.ExecuteAsync("""
            INSERT org.Departments (Code, Name) VALUES ('TST', N'Test Department');
            INSERT org.Designations (Code, Name) VALUES ('TEX', N'Test Executive');
            DECLARE @d BIGINT = SCOPE_IDENTITY();
            INSERT org.Employees (EmployeeCode, FirstName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
            VALUES ('TST-0001', N'Test', N'Test Employee', N'employee@test.invalid', (SELECT DepartmentId FROM org.Departments WHERE Code = 'TST'), @d);

            INSERT auth.Users (Email, PasswordHash) VALUES
              (N'admin@test.invalid', @hash), (N'lockout@test.invalid', @hash), (N'change@test.invalid', @hash),
              (N'reset@test.invalid', @hash), (N'noperm@test.invalid', @hash), (N'logout@test.invalid', @hash),
              (N'orgadmin@test.invalid', @hash), (N'mfa@test.invalid', @hash), (N'second.super@test.invalid', @hash), (N'victim@test.invalid', @hash), (N'otp@test.invalid', @hash);
            INSERT auth.Users (Email, PasswordHash, EmployeeId) SELECT N'employee@test.invalid', @hash, EmployeeId FROM org.Employees WHERE EmployeeCode = 'TST-0001';
            INSERT auth.Users (Email, PasswordHash, MustChangePassword) VALUES (N'mustchange@test.invalid', @hash, 1);
            INSERT auth.Users (Email, PasswordHash, IsActive) VALUES (N'inactive@test.invalid', @hash, 0);

            INSERT auth.UserRoles (UserId, RoleId)
            SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = CASE WHEN u.Email IN (N'admin@test.invalid', N'second.super@test.invalid') THEN 'SuperAdmin'
                                                                WHEN u.Email = N'orgadmin@test.invalid' THEN 'Admin' ELSE 'Employee' END
            WHERE u.Email <> N'noperm@test.invalid';
            """, new { hash });

        // Phase 3: employees with linked user accounts for the meeting tests (M-NOACCT has no account; M-SUPER is a SuperAdmin).
        await c.ExecuteAsync("""
            INSERT org.Employees (EmployeeCode, FirstName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
            SELECT v.Code, v.Name, v.Name, v.Email, (SELECT DepartmentId FROM org.Departments WHERE Code = 'TST'), (SELECT DesignationId FROM org.Designations WHERE Code = 'TEX')
            FROM (VALUES ('M-HOST', N'Meera Host', N'mhost@test.invalid'), ('M-PEER', N'Pranav Peer', N'mpeer@test.invalid'),
                         ('M-THIRD', N'Tara Third', N'mthird@test.invalid'), ('M-OUT', N'Omar Outsider', N'mout@test.invalid'),
                         ('M-SUPER', N'Sunita Super', N'msuper@test.invalid'), ('M-CONC', N'Chetan Concurrent', N'mconc@test.invalid'),
                         ('M-AVAIL', N'Asha Avail', N'mavail@test.invalid'), ('M-NOACCT', N'Neel NoAccount', N'mnoacct@test.invalid')) v (Code, Name, Email);
            INSERT auth.Users (Email, PasswordHash, EmployeeId)
            SELECT e.OfficialEmail, @hash, e.EmployeeId FROM org.Employees e WHERE e.EmployeeCode LIKE 'M-%' AND e.EmployeeCode <> 'M-NOACCT';
            INSERT auth.UserRoles (UserId, RoleId)
            SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = CASE WHEN u.Email = N'msuper@test.invalid' THEN 'SuperAdmin' ELSE 'Employee' END
            WHERE u.Email IN (N'mhost@test.invalid', N'mpeer@test.invalid', N'mthird@test.invalid', N'mout@test.invalid', N'msuper@test.invalid', N'mconc@test.invalid', N'mavail@test.invalid');
            """, new { hash });

        // Phase 4: employees for the video-room tests (own calendars, so their near-"now" meetings never clash with other tests).
        await c.ExecuteAsync("""
            INSERT org.Employees (EmployeeCode, FirstName, DisplayName, OfficialEmail, DepartmentId, DesignationId)
            SELECT v.Code, v.Name, v.Name, v.Email, (SELECT DepartmentId FROM org.Departments WHERE Code = 'TST'), (SELECT DesignationId FROM org.Designations WHERE Code = 'TEX')
            FROM (VALUES ('R-HOST', N'Rohan Host', N'rhost@test.invalid'), ('R-PEER', N'Riya Peer', N'rpeer@test.invalid'),
                         ('R-OUT', N'Raj Outsider', N'rout@test.invalid')) v (Code, Name, Email);
            INSERT auth.Users (Email, PasswordHash, EmployeeId)
            SELECT e.OfficialEmail, @hash, e.EmployeeId FROM org.Employees e WHERE e.EmployeeCode LIKE 'R-%';
            INSERT auth.UserRoles (UserId, RoleId)
            SELECT u.UserId, r.RoleId FROM auth.Users u JOIN auth.Roles r ON r.Code = 'Employee'
            WHERE u.Email IN (N'rhost@test.invalid', N'rpeer@test.invalid', N'rout@test.invalid');
            """, new { hash });

        // Stand-in for OneInsure's mail procedure: identical parameter list to Util_SendEmail2; records instead of sending.
        // Recipients starting with "fail" raise an error so the retry path can be tested.
        await c.ExecuteAsync("""
            CREATE TABLE dbo.TestSentMail (Id INT IDENTITY PRIMARY KEY, [To] VARCHAR(200), Subject VARCHAR(500), Body NVARCHAR(MAX), [From] VARCHAR(200),
                ReplyTo VARCHAR(200), CustRef VARCHAR(100), DisplayName VARCHAR(200), TemplateId INT, UserId INT, PurposeId INT, TranId INT)
            """);
        await c.ExecuteAsync("""
            CREATE PROCEDURE dbo.Util_SendEmail2 @to VARCHAR(8000), @subject VARCHAR(8000), @body NVARCHAR(MAX), @from VARCHAR(8000), @replyto VARCHAR(8000),
                @custref VARCHAR(128), @Displayname VARCHAR(128), @templateid INT, @userid INT, @PurposeId INT, @TranId INT
            AS
            BEGIN
                IF @to LIKE 'fail%' THROW 50010, 'Mail relay rejected the recipient.', 1;
                INSERT dbo.TestSentMail ([To], Subject, Body, [From], ReplyTo, CustRef, DisplayName, TemplateId, UserId, PurposeId, TranId)
                VALUES (@to, @subject, @body, @from, @replyto, @custref, @Displayname, @templateid, @userid, @PurposeId, @TranId);
            END
            """);
    }

    public async Task DisposeAsync()
    {
        if (Factory is not null) await Factory.DisposeAsync();
        SqlConnection.ClearAllPools();
        await using var c = new SqlConnection($"Server={Server};Database=master;Integrated Security=true;TrustServerCertificate=true");
        await c.ExecuteAsync($"ALTER DATABASE [{Database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{Database}];");
        try { Directory.Delete(RecordingRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    public async Task<T> QueryAsync<T>(string sql, object? param = null)
    {
        await using var c = new SqlConnection(ConnectionString);
        return await c.QuerySingleAsync<T>(sql, param);
    }

    /// <summary>A browser-like client: keeps cookies and echoes the XSRF cookie in X-XSRF-TOKEN like the SPA does.</summary>
    public async Task<TestClient> NewClientAsync()
    {
        var jar = new CookieContainer();
        var http = Factory.CreateDefaultClient(new Uri("http://localhost"), new CookieContainerHandler(jar));
        var client = new TestClient(http, jar);
        (await http.GetAsync("/api/v1/health")).EnsureSuccessStatusCode(); // receives the XSRF cookie
        return client;
    }

    static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "database", "migrations"))) dir = dir.Parent;
        return dir?.FullName ?? throw new DirectoryNotFoundException("Repository root (database/migrations) not found.");
    }
}

public sealed class TestClient(HttpClient http, CookieContainer jar)
{
    public HttpClient Http => http;
    public CookieContainer Jar => jar;
    public string? Cookie(string name) => jar.GetCookies(new Uri("http://localhost"))[name]?.Value;

    public Task<HttpResponseMessage> PostAsync(string path, object? body = null, bool withXsrf = true)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body ?? new { }) };
        if (withXsrf && Cookie("XSRF-TOKEN") is { } t) req.Headers.Add("X-XSRF-TOKEN", t);
        return http.SendAsync(req);
    }

    public Task<HttpResponseMessage> PutAsync(string path, object body)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, path) { Content = JsonContent.Create(body) };
        if (Cookie("XSRF-TOKEN") is { } t) req.Headers.Add("X-XSRF-TOKEN", t);
        return http.SendAsync(req);
    }

    public Task<HttpResponseMessage> DeleteAsync(string path)
    {
        var req = new HttpRequestMessage(HttpMethod.Delete, path);
        if (Cookie("XSRF-TOKEN") is { } t) req.Headers.Add("X-XSRF-TOKEN", t);
        return http.SendAsync(req);
    }

    public Task<HttpResponseMessage> LoginAsync(string login, string password, bool rememberMe = false) =>
        PostAsync("/api/v1/auth/login", new { login, password, rememberMe });
}

[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<ApiFixture>
{
    public const string Name = "api";
}
