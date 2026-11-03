using Microsoft.Extensions.Options;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Security;

public static class SecurityMiddleware
{
    /// <summary>Hardening headers for every API response (the SPA's own headers are set by IIS in production).</summary>
    public static IApplicationBuilder UseSecurityHeaders(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h["X-Content-Type-Options"] = "nosniff";
        h["X-Frame-Options"] = "DENY";
        h["Referrer-Policy"] = "no-referrer";
        h["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
        h["Cache-Control"] = "no-store";
        h["Cross-Origin-Resource-Policy"] = "same-origin";
        await next();
    });

    /// <summary>
    /// CSRF defence for state-changing /api requests: the X-XSRF-TOKEN header must equal the XSRF-TOKEN cookie
    /// (double submit) and, when the browser sends an Origin, it must be the API's own origin or an allowed one.
    /// The XSRF cookie is issued on any API response that lacks it. Session cookies are also SameSite=Strict.
    /// </summary>
    public static IApplicationBuilder UseCsrfProtection(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var o = ctx.RequestServices.GetRequiredService<IOptions<SecurityOptions>>().Value;
        var req = ctx.Request;
        // Server-to-server webhooks carry no cookies; they are authenticated by their signature instead.
        if (!req.Path.StartsWithSegments("/api") || req.Path.StartsWithSegments("/api/v1/webhooks")) { await next(); return; }

        if (!HttpMethods.IsGet(req.Method) && !HttpMethods.IsHead(req.Method) && !HttpMethods.IsOptions(req.Method))
        {
            var origin = req.Headers.Origin.ToString();
            var self = $"{req.Scheme}://{req.Host}";
            if (origin.Length > 0 && !string.Equals(origin, self, StringComparison.OrdinalIgnoreCase)
                && !o.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase))
            {
                await Problems.WriteAsync(ctx, 403, "FORBIDDEN", "Request origin not allowed.");
                return;
            }
            var cookie = req.Cookies[Cookies.Xsrf];
            var header = req.Headers["X-XSRF-TOKEN"].ToString();
            if (string.IsNullOrEmpty(cookie) || string.IsNullOrEmpty(header) || !Tokens.FixedTimeEquals(cookie, header))
            {
                Cookies.SetXsrf(ctx.Response, o); // give the client a fresh token to retry with
                await Problems.WriteAsync(ctx, 403, "FORBIDDEN", "Security token missing or invalid. Refresh the page and try again.");
                return;
            }
        }
        else if (!req.Cookies.ContainsKey(Cookies.Xsrf))
        {
            Cookies.SetXsrf(ctx.Response, o);
        }
        await next();
    });

    /// <summary>A user flagged MustChangePassword may only reach endpoints marked AllowPendingPasswordChange.</summary>
    public static IApplicationBuilder UsePendingPasswordChangeGate(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        if (ctx.User.Identity?.IsAuthenticated == true && ctx.User.MustChangePassword()
            && ctx.GetEndpoint()?.Metadata.GetMetadata<AllowPendingPasswordChangeAttribute>() is null)
        {
            await Problems.WriteAsync(ctx, 403, "FORBIDDEN", "You must change your password before continuing.");
            return;
        }
        await next();
    });
}
