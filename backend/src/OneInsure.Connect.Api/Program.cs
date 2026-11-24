using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Dapper;
using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Admin;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Customers;
using OneInsure.Connect.Api.Dashboard;
using OneInsure.Connect.Api.Email;
using OneInsure.Connect.Api.Employees;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Integrations;
using OneInsure.Connect.Api.Meetings;
using OneInsure.Connect.Api.Org;
using OneInsure.Connect.Api.Recording;
using OneInsure.Connect.Api.Reports;
using OneInsure.Connect.Api.Security;
using OneInsure.Connect.Api.Setup;

// As a Windows service the working directory is System32: settings and wwwroot are read from the program folder instead.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = Microsoft.Extensions.Hosting.WindowsServices.WindowsServiceHelpers.IsWindowsService() ? AppContext.BaseDirectory : null,
});
// Production on Windows Server: runs as the Windows service "OneInsureConnectApi" (no effect when started from a console).
builder.Host.UseWindowsService(o => o.ServiceName = "OneInsureConnectApi");

var connectionString = builder.Configuration.GetConnectionString("OneInsure");
if (string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException(
        "ConnectionStrings:OneInsure is not configured. Development: dotnet user-secrets set ConnectionStrings:OneInsure \"...\". " +
        "Server: environment variable ConnectionStrings__OneInsure. It is never stored in appsettings.");

builder.Services.Configure<SecurityOptions>(builder.Configuration.GetSection("Security"));
builder.Services.Configure<DailyLogoutOptions>(builder.Configuration.GetSection("Security:DailyLogout"));
builder.Services.AddSingleton<DailyLogoutService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DailyLogoutService>());
builder.Services.Configure<PublicEndpointOptions>(builder.Configuration.GetSection("PublicEndpoints"));
builder.Services.AddSingleton(new Db(connectionString));
builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddSingleton<Passwords>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddSingleton<MfaService>();
builder.Services.Configure<EmailOptions>(builder.Configuration.GetSection("Email"));
builder.Services.AddSingleton<IEmailSender, SqlProcedureEmailSender>();
builder.Services.AddSingleton<EmailOutboxWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<EmailOutboxWorker>());
builder.Services.Configure<MeetingOptions>(builder.Configuration.GetSection("Meetings"));
builder.Services.Configure<ReminderOptions>(builder.Configuration.GetSection("Reminders"));
builder.Services.AddSingleton<MeetingMessaging>();
builder.Services.AddSingleton<ReminderWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<ReminderWorker>());
builder.Services.AddSingleton<MeetingExpiryWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MeetingExpiryWorker>());
builder.Services.AddSingleton<MeetingAutoEndWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MeetingAutoEndWorker>());
builder.Services.AddMemoryCache();
// Phase 4 — video room. LiveKit:ApiKey/ApiSecret only from user secrets or environment variables; missing → join endpoints answer 503.
builder.Services.Configure<LiveKitOptions>(builder.Configuration.GetSection("LiveKit"));
builder.Services.AddSingleton<LiveKitTokens>();
builder.Services.AddSingleton<WaitingRoomIds>();
builder.Services.AddHttpClient<LiveKitRoomService>(c => c.Timeout = TimeSpan.FromSeconds(8));
builder.Services.AddScoped<RoomEndpoints.RoomServices>();
builder.Services.AddScoped<MeetingLinkEndpoints.LinkServices>();
// Phase 5 — recording management. The R2 recorder (proof of concept) runs as a separate process started by RecorderWorker.
builder.Services.Configure<RecordingOptions>(builder.Configuration.GetSection("Recording"));
builder.Services.AddSingleton<RecordingPaths>();
builder.Services.AddSingleton<RecorderHealth>();
builder.Services.AddSingleton<RecordingMediaTokens>();
builder.Services.AddSingleton<IRecorderLauncher, ProcessRecorderLauncher>();
builder.Services.AddSingleton<RecorderWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RecorderWorker>());
builder.Services.AddSingleton<RetentionWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RetentionWorker>());
builder.Services.AddScoped<RecordingService>();
// External integration API (12 Nov 2026): API keys per portal, webhooks, OpenAPI document for /api/ext/v1.
builder.Services.Configure<IntegrationOptions>(builder.Configuration.GetSection("Integrations"));
builder.Services.AddScoped<ExternalApiEndpoints.ExtServices>();
builder.Services.AddHttpClient(WebhookWorker.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false }); // no redirects: the SSRF check covers the URL actually called
builder.Services.AddSingleton<WebhookWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<WebhookWorker>());
// Chat (20 Nov 2026, documentation/CHAT_MODULE_PHASE1.md): SignalR is part of ASP.NET Core (no package). Off until the CHAT switch is on.
builder.Services.Configure<OneInsure.Connect.Api.Chat.ChatOptions>(builder.Configuration.GetSection("Chat"));
builder.Services.AddSignalR(o =>
{
    o.KeepAliveInterval = TimeSpan.FromSeconds(15);
    o.ClientTimeoutInterval = TimeSpan.FromSeconds(30); // a closed laptop / lost network shows offline within ~30 s
    o.MaximumReceiveMessageSize = 16 * 1024;            // clients only send tiny signals (typing, delivered)
}).AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new UtcDateTimeConverter()));
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.PresenceTracker>();
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.PresenceService>();
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatPush>();
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatFileScanSignal>();
builder.Services.AddScoped<OneInsure.Connect.Api.Chat.ChatEndpoints.ChatServices>();
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatPresenceSweeper>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OneInsure.Connect.Api.Chat.ChatPresenceSweeper>());
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatFileScanWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OneInsure.Connect.Api.Chat.ChatFileScanWorker>());
builder.Services.AddScoped<OneInsure.Connect.Api.Chat.ChatCallEndpoints.CallServices>();
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatCallWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OneInsure.Connect.Api.Chat.ChatCallWorker>());
// Chat Phase 4: notes, tasks, reminders, My Day (V030). Off until the CHAT_TASKS switch is on.
builder.Services.AddScoped<OneInsure.Connect.Api.Chat.ChatWorkEndpoints.WorkServices>();
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatReminderWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OneInsure.Connect.Api.Chat.ChatReminderWorker>());
// Chat Phase 5: advanced chat - scheduled / saved / pinned messages, @mentions, favourites, quiet hours (V031). Off until the CHAT_ADVANCED switch is on.
builder.Services.AddSingleton<OneInsure.Connect.Api.Chat.ChatScheduledMessageWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<OneInsure.Connect.Api.Chat.ChatScheduledMessageWorker>());
builder.Services.AddOpenApi(ExternalApiEndpoints.DocumentName, o =>
{
    o.ShouldInclude = d => d.GroupName == ExternalApiEndpoints.DocumentName;
    o.AddDocumentTransformer<ExternalApiDocument>();
});
// Development only: LiveKit cannot trust the self-signed https dev certificate, so its webhooks arrive on an extra
// plain-http listener bound to loopback that serves only the webhook path (LiveKit:WebhookListenUrl, e.g. http://127.0.0.1:5080).
// A second API instance on the same PC (e.g. a test instance) skips the listener instead of failing to start.
var webhookListener = WebhookListener.Parse(builder.Configuration["LiveKit:WebhookListenUrl"]);
var webhookPortBusy = webhookListener is not null && !WebhookListener.PortIsFree(webhookListener);
if (webhookPortBusy) webhookListener = null;
if (webhookListener is not null) builder.WebHost.UseUrls(WebhookListener.MergeUrls(builder.Configuration, webhookListener));
// Encrypts TOTP secrets and signs MFA/trusted-device tokens. On Windows the key ring is protected with DPAPI.
// Production: set DataProtection:KeysPath to a backed-up folder readable only by the service account (losing it disables existing MFA).
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("OneInsure.Connect");
if (builder.Configuration["DataProtection:KeysPath"] is { Length: > 0 } keysPath)
{
    dataProtection.PersistKeysToFileSystem(new DirectoryInfo(keysPath));
    if (OperatingSystem.IsWindows()) dataProtection.ProtectKeysWithDpapi(protectToLocalMachine: true);
}
// Behind IIS (reverse proxy on the same server): the client's address and https come from X-Forwarded-For / -Proto, so rate
// limits and audit entries see the real caller instead of 127.0.0.1. Only the loopback proxy is trusted (the defaults).
var behindProxy = builder.Configuration.GetValue<bool>("ReverseProxy:Enabled");
if (behindProxy)
    builder.Services.Configure<Microsoft.AspNetCore.Builder.ForwardedHeadersOptions>(o =>
    {
        o.ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto;
        o.ForwardLimit = 1;
    });
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new UtcDateTimeConverter()));

builder.Services.AddAuthentication(SessionClaims.Scheme)
    .AddScheme<Microsoft.AspNetCore.Authentication.AuthenticationSchemeOptions, SessionAuthenticationHandler>(SessionClaims.Scheme, null);
builder.Services.AddAuthorization();

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.OnRejected = (ctx, _) => new ValueTask(Problems.WriteAsync(ctx.HttpContext, 429, "RATE_LIMITED", "Too many attempts. Please wait a minute and try again."));
    static string Ip(HttpContext c) => c.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    static SecurityOptions Sec(HttpContext c) => c.RequestServices.GetRequiredService<IOptions<SecurityOptions>>().Value;
    o.AddPolicy(AuthEndpoints.LoginRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(Ip(c),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = Sec(c).LoginPermitPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    o.AddPolicy(AuthEndpoints.PasswordResetRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(Ip(c),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = Sec(c).PasswordResetPermitPer5Minutes, Window = TimeSpan.FromMinutes(5), QueueLimit = 0 }));
    o.AddPolicy(NotificationEndpoints.JoinRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(Ip(c),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = c.RequestServices.GetRequiredService<IOptions<MeetingOptions>>().Value.JoinPermitPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    o.AddPolicy(RoomEndpoints.GuestRateLimit, c => RateLimitPartition.GetFixedWindowLimiter(Ip(c),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = c.RequestServices.GetRequiredService<IOptions<MeetingOptions>>().Value.WaitingRoomPermitPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    OneInsure.Connect.Api.Chat.ChatEndpoints.AddChatRateLimits(o);
});

var app = builder.Build();

// One-off operator command (not a web endpoint): create the first SuperAdmin.
if (args.Length > 0 && args[0] == "setup-admin")
{
    Environment.ExitCode = await AdminBootstrap.RunAsync(args, app.Services.GetRequiredService<Db>(), app.Services.GetRequiredService<Passwords>(), Console.Out);
    return;
}

if (behindProxy) app.UseForwardedHeaders();
app.UseExceptionHandler(e => e.Run(ctx => Problems.WriteAsync(ctx, 500, "SERVER", "An unexpected error occurred.")));
if (webhookPortBusy)
    app.Logger.LogWarning("LiveKit:WebhookListenUrl {Url} is already in use by another process: this instance receives no LiveKit webhooks.", builder.Configuration["LiveKit:WebhookListenUrl"]);
if (webhookListener is not null)
{
    var hookPort = webhookListener.Port;
    app.Use(async (ctx, next) =>
    {
        // The plain-http development listener exists for LiveKit webhooks only: everything else is refused there.
        if (ctx.Connection.LocalPort == hookPort && !ctx.Request.Path.Equals(LiveKitWebhookEndpoints.Path, StringComparison.OrdinalIgnoreCase))
        {
            await Problems.WriteAsync(ctx, 404, "NOT_FOUND", "Not found.");
            return;
        }
        await next();
    });
}
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.UseSecurityHeaders();
app.UseCsrfProtection();
app.UseExternalApi();
app.UseAuthentication();
app.UseRateLimiter();
app.UseAuthorization();
app.UsePendingPasswordChangeGate();

var api = app.MapGroup("/api/v1");
api.MapAuthEndpoints();
api.MapDailyLogoutEndpoints();
api.MapAccountEndpoints();
api.MapProfilePhotoEndpoints();
api.MapOrgEndpoints();
api.MapEmployeeEndpoints();
api.MapUserAdminEndpoints();
api.MapDashboardEndpoints();
api.MapCustomerEndpoints();
api.MapMeetingEndpoints();
api.MapCalendarEndpoints();
api.MapNotificationEndpoints();
api.MapRoomEndpoints();
api.MapRoomFeatureEndpoints();
api.MapMeetingMinutesEndpoints();
api.MapMeetingLinkEndpoints();
api.MapLiveKitWebhook();
api.MapRecordingPolicyEndpoints();
api.MapRecordingRoomEndpoints();
api.MapRecordingLibraryEndpoints();
api.MapReportsEndpoints();
api.MapAuditEndpoints();
api.MapIntegrationAdminEndpoints();
OneInsure.Connect.Api.Chat.ChatEndpoints.MapChatEndpoints(api);
OneInsure.Connect.Api.Chat.ChatCallEndpoints.MapChatCallEndpoints(api);
OneInsure.Connect.Api.Chat.ChatWorkEndpoints.MapChatWorkEndpoints(api);
OneInsure.Connect.Api.Chat.ChatAdvancedEndpoints.MapChatAdvancedEndpoints(api);
app.MapHub<OneInsure.Connect.Api.Chat.ChatHub>("/api/v1/hubs/chat");
app.MapExternalApi();
// 13 Nov 2026: the API description is for people given the API Documentation page (api.docs.view) or integration admins - not public.
app.MapOpenApi("/api/ext/openapi/{documentName}.json").RequireAnyPermission("api.docs.view", "integrations.manage");
api.MapGet("/health", async (Db db, CancellationToken ct) =>
{
    try
    {
        using var c = await db.OpenAsync(ct);
        await c.ExecuteScalarAsync<int>("SELECT 1");
        return Results.Ok(new { status = "Healthy" });
    }
    catch (Exception)
    {
        return Results.Json(new { status = "Unhealthy" }, statusCode: 503); // no details to anonymous callers
    }
});
app.MapFallback("/api/{**rest}", (HttpContext ctx) => Problems.Create(404, "SERVER", "Not found."));

app.Run();

public partial class Program;
