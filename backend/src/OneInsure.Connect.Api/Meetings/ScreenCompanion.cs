namespace OneInsure.Connect.Api.Meetings;

/// <summary>
/// Phone screen sharing from the Android app (19 Nov 2026). An Android phone browser cannot capture its screen, so the app
/// publishes it through a second, screen-only LiveKit connection of the same person: identity "&lt;owner&gt;.screen",
/// metadata role "SCREEN". See LiveKitTokens.CreateScreenCompanionToken for what that connection may do (only publish a
/// screen). Mirrors: frontend src/pages/room/screenCompanion.ts, recording/layout/src/main.ts.
/// </summary>
internal static class ScreenCompanion
{
    public const string Suffix = ".screen";
    public const string Role = "SCREEN";

    public static string IdentityFor(string ownerIdentity) => ownerIdentity + Suffix;

    public static bool IsCompanion(string? identity) => identity is not null && identity.EndsWith(Suffix, StringComparison.Ordinal);
}
