namespace OneInsure.Connect.Api.Infrastructure;

/// <summary>
/// RFC 9457 problem responses with an application "code" extension. The codes are the
/// <c>ApiErrorCode</c> union in frontend/src/api/types.ts.
/// </summary>
public static class Problems
{
    public static IResult Create(int status, string code, string detail, IDictionary<string, object?>? extra = null)
    {
        var ext = new Dictionary<string, object?> { ["code"] = code };
        if (extra is not null)
            foreach (var (k, v) in extra) ext[k] = v;
        return Results.Problem(statusCode: status, title: Title(status), detail: detail, extensions: ext);
    }

    public static Task WriteAsync(HttpContext ctx, int status, string code, string detail)
    {
        ctx.Response.StatusCode = status;
        return Create(status, code, detail).ExecuteAsync(ctx);
    }

    static string Title(int status) => status switch
    {
        400 => "Bad request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not found",
        409 => "Conflict",
        423 => "Locked",
        429 => "Too many requests",
        503 => "Service unavailable",
        _ => "Error",
    };
}
