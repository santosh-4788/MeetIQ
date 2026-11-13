using Microsoft.AspNetCore.OpenApi;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi;
using OneInsure.Connect.Api.Infrastructure;

namespace OneInsure.Connect.Api.Integrations;

/// <summary>
/// Shapes the generated OpenAPI document for /api/ext/v1: title and description, the real public server URL (from
/// PublicEndpoints:WebBaseUrl - never an invented domain), and the API-key bearer security scheme applied to every operation.
/// The operations and schemas themselves are generated from the implemented endpoints and records - nothing is hand-listed.
/// </summary>
public sealed class ExternalApiDocument(IOptions<PublicEndpointOptions> pub) : IOpenApiDocumentTransformer
{
    public Task TransformAsync(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
    {
        document.Info = new OpenApiInfo
        {
            Title = "OneInsure Connect Integration API",
            Version = ExternalApiEndpoints.Version,
            Description = """
                Create and manage OneInsure Connect meetings from your own portal: instant or scheduled meetings, PLVC meetings with a Prarambh Main ID,
                participant join links, meeting status, the meeting completion report, recording metadata and secure recording downloads, and webhooks.

                Authentication: send your integration's API key as `Authorization: Bearer <key>` (or `X-Api-Key: <key>`). Each key belongs to one
                integration and only ever sees that integration's meetings and recordings. Scopes decide which operations a key may call.
                Errors are application/problem+json with a machine-readable `code`. Rate limits are per integration (HTTP 429 with Retry-After).
                Times are ISO-8601 in India Standard Time (+05:30).
                """,
        };
        var webBase = pub.Value.WebBaseUrl.TrimEnd('/');
        if (webBase.Length > 0) document.Servers = [new OpenApiServer { Url = webBase, Description = "OneInsure Connect" }];
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
        document.Components.SecuritySchemes["ApiKey"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "oic_live_… API key",
            Description = "The integration's API key, issued under Organisation → System → API Documentation → Integrations.",
        };
        document.Security = [new OpenApiSecurityRequirement { [new OpenApiSecuritySchemeReference("ApiKey", document)] = [] }];
        return Task.CompletedTask;
    }
}
