using System.Globalization;
using System.Net;
using System.Text;

namespace OneInsure.Connect.Api.Email;

/// <summary>Brand settings every e-mail needs (from the Email section: LogoUrl, SupportEmail).</summary>
public sealed record EmailBrand(string LogoUrl, string? SupportEmail)
{
    public const string DefaultLogoUrl = "https://www.oneinsure.com/assets/cmn/logo-white.png";

    public static EmailBrand From(EmailOptions o) => new(
        string.IsNullOrWhiteSpace(o.LogoUrl) ? DefaultLogoUrl : o.LogoUrl.Trim(),
        string.IsNullOrWhiteSpace(o.SupportEmail) ? null : o.SupportEmail.Trim());
}

/// <summary>What one e-mail says. All strings are plain text; <see cref="EmailLayout"/> encodes them.</summary>
public sealed record EmailContent
{
    /// <summary>Hidden preview line shown by mail clients next to the subject.</summary>
    public required string Preheader { get; init; }
    /// <summary>Small upper-case label above the title, e.g. "Meeting invitation".</summary>
    public string? Eyebrow { get; init; }
    public required string Title { get; init; }
    /// <summary>Recipient name for "Dear name,"; null = "Hello,".</summary>
    public string? RecipientName { get; init; }
    public IReadOnlyList<string> Paragraphs { get; init; } = [];
    /// <summary>A one-time code shown large (sign-in code), rendered as &lt;b&gt;code&lt;/b&gt;.</summary>
    public string? Code { get; init; }
    public IReadOnlyList<(string Label, string Value)> Details { get; init; } = [];
    public string? ButtonUrl { get; init; }
    public string? ButtonText { get; init; }
    /// <summary>Small print below the button (link is personal, do not forward, …).</summary>
    public string? Note { get; init; }
}

/// <summary>
/// The single layout of every OneInsure Connect e-mail. Built for the lowest common denominator (Outlook desktop's Word engine,
/// Outlook on the web, Gmail, mobile clients): nested tables, inline styles only, bgcolor attributes next to background styles,
/// a system font stack, a 600 px fluid card and no reliance on &lt;style&gt; blocks, web fonts or media queries.
/// Every dynamic value is HTML-encoded here.
/// </summary>
public static class EmailLayout
{
    const string Font = "'Segoe UI',Arial,Helvetica,sans-serif";
    const string Canvas = "#F4F7FB", Surface = "#FFFFFF", Muted = "#F8FAFD", Line = "#E3E9F2", Navy = "#102A43",
        Brand = "#1F6FD0", BrandDark = "#1769AA", Ink = "#172B4D", Secondary = "#64748B", Faint = "#94A3B8";

    static string E(string? s) => WebUtility.HtmlEncode(s ?? "");

    public static string Render(EmailBrand brand, EmailContent c)
    {
        var b = new StringBuilder(8 * 1024);

        // Preheader: hidden everywhere (mso-hide for Outlook); padded so clients do not pull body text into the preview.
        b.Append($"<div style=\"display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:{Canvas}\">")
         .Append(E(c.Preheader)).Append(string.Concat(Enumerable.Repeat("&#847;&zwnj;&nbsp;", 40))).Append("</div>");

        b.Append($"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"{Canvas}\" style=\"width:100%;background-color:{Canvas};border-collapse:collapse\">")
         .Append($"<tr><td align=\"center\" style=\"padding:28px 12px;font-family:{Font}\">")
         // Outlook (Word engine) ignores max-width: a fixed 600 px ghost table keeps the card from stretching.
         .Append("<!--[if mso]><table role=\"presentation\" width=\"600\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td><![endif]-->")
         .Append($"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"{Surface}\" style=\"width:100%;max-width:600px;margin:0 auto;background-color:{Surface};border:1px solid {Line};border-radius:12px;border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt\">");

        // Header: OneInsure logo (white pill, made for dark backgrounds) + product name on navy.
        b.Append($"<tr><td bgcolor=\"{Navy}\" style=\"background-color:{Navy};padding:18px 28px;border-radius:11px 11px 0 0\">")
         .Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>")
         .Append($"<td valign=\"middle\" style=\"width:150px\"><img src=\"{E(brand.LogoUrl)}\" width=\"150\" height=\"44\" alt=\"OneInsure\" style=\"display:block;width:150px;height:44px;border:0;outline:none;text-decoration:none;font-family:{Font};font-size:20px;font-weight:700;color:#ffffff\"></td>")
         .Append($"<td valign=\"middle\" align=\"right\" style=\"font-family:{Font};font-size:15px;line-height:20px;font-weight:600;color:#ffffff;padding-left:12px\">OneInsure <span style=\"color:#20C4D8\">Connect</span></td>")
         .Append("</tr></table></td></tr>");

        // Brand accent bar (gradient where supported, solid brand blue in Outlook).
        b.Append($"<tr><td height=\"4\" bgcolor=\"#2878E5\" style=\"height:4px;font-size:0;line-height:0;mso-line-height-rule:exactly;background-color:#2878E5;background-image:linear-gradient(90deg,{BrandDark},#2878E5,#20C4D8)\">&nbsp;</td></tr>");

        // Body.
        b.Append($"<tr><td style=\"padding:32px 28px 16px;font-family:{Font};color:{Ink}\">");
        if (!string.IsNullOrWhiteSpace(c.Eyebrow))
            b.Append($"<p style=\"margin:0 0 6px;font-family:{Font};font-size:12px;line-height:16px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:{BrandDark}\">{E(c.Eyebrow)}</p>");
        b.Append($"<h1 style=\"margin:0 0 20px;font-family:{Font};font-size:22px;line-height:30px;font-weight:700;color:{Ink}\">{E(c.Title)}</h1>");
        b.Append(P(string.IsNullOrWhiteSpace(c.RecipientName) ? "Hello," : $"Dear {c.RecipientName},"));
        foreach (var p in c.Paragraphs) b.Append(P(p));

        if (!string.IsNullOrEmpty(c.Code))
            b.Append("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:4px 0 20px\"><tr>")
             .Append($"<td bgcolor=\"{Muted}\" style=\"background-color:{Muted};border:1px solid {Line};border-radius:10px;padding:14px 28px;font-family:Consolas,'Courier New',monospace;font-size:30px;line-height:36px;color:{Navy}\">")
             .Append($"<b style=\"font-size:30px;letter-spacing:6px\">{E(c.Code)}</b></td></tr></table>");

        if (c.Details.Count > 0)
        {
            b.Append($"<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"{Muted}\" style=\"width:100%;margin:4px 0 12px;background-color:{Muted};border:1px solid {Line};border-radius:10px;border-collapse:separate\">");
            for (var i = 0; i < c.Details.Count; i++)
            {
                var sep = i == 0 ? "" : $"border-top:1px solid {Line};";
                b.Append("<tr>")
                 .Append($"<td valign=\"top\" style=\"{sep}width:30%;white-space:nowrap;padding:11px 14px 11px 16px;font-family:{Font};font-size:13px;line-height:20px;color:{Secondary}\">{E(c.Details[i].Label)}</td>")
                 .Append($"<td valign=\"top\" style=\"{sep}padding:11px 16px 11px 0;font-family:{Font};font-size:14px;line-height:20px;font-weight:600;color:{Ink}\">{E(c.Details[i].Value)}</td>")
                 .Append("</tr>");
            }
            b.Append("</table>");
        }

        if (!string.IsNullOrEmpty(c.ButtonUrl))
        {
            var url = E(c.ButtonUrl);
            // "Bulletproof" button: Outlook ignores backgrounds on <a> and recolours visited links, so the colour sits on
            // the table cell (bgcolor + style) and the text colour is forced on both the link and an inner span.
            b.Append("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:24px 0 20px\"><tr>")
             .Append($"<td bgcolor=\"{Brand}\" style=\"background-color:{Brand};border-radius:8px;mso-padding-alt:12px 26px\">")
             .Append($"<a href=\"{url}\" target=\"_blank\" style=\"display:inline-block;padding:12px 26px;font-family:{Font};font-size:15px;font-weight:600;line-height:20px;color:#ffffff !important;text-decoration:none;border-radius:8px\">")
             .Append($"<span style=\"color:#ffffff\">{E(c.ButtonText ?? "Open")}</span></a></td></tr></table>")
             .Append($"<p style=\"margin:0 0 16px;font-family:{Font};font-size:12px;line-height:18px;color:{Secondary}\">If the button does not work, copy this address into your browser:<br>")
             .Append($"<a href=\"{url}\" target=\"_blank\" style=\"color:{BrandDark};text-decoration:underline;word-break:break-all\">{url}</a></p>");
        }

        if (!string.IsNullOrWhiteSpace(c.Note))
            b.Append($"<p style=\"margin:0 0 16px;font-family:{Font};font-size:12px;line-height:18px;color:{Secondary}\">{E(c.Note)}</p>");
        b.Append("</td></tr>");

        // Footer.
        b.Append($"<tr><td bgcolor=\"{Muted}\" style=\"background-color:{Muted};border-top:1px solid {Line};padding:18px 28px 20px;border-radius:0 0 11px 11px;font-family:{Font};font-size:12px;line-height:18px;color:{Secondary}\">")
         .Append("This is an automated message from OneInsure Connect. Please do not reply.");
        if (brand.SupportEmail is { } support)
            b.Append($"<br>Need help? Contact <a href=\"mailto:{E(support)}\" style=\"color:{BrandDark};text-decoration:none\">{E(support)}</a>");
        b.Append($"<br><span style=\"color:{Faint}\">&copy; {DateTime.UtcNow.Year.ToString(CultureInfo.InvariantCulture)} OneInsure</span>")
         .Append("</td></tr>");

        b.Append("</table>")
         .Append("<!--[if mso]></td></tr></table><![endif]-->")
         .Append("</td></tr></table>");
        return b.ToString();
    }

    static string P(string text) =>
        $"<p style=\"margin:0 0 16px;font-family:{Font};font-size:15px;line-height:24px;color:{Ink}\">{E(text)}</p>";
}

/// <summary>Account e-mails (password reset, sign-in code) in the shared <see cref="EmailLayout"/>.</summary>
public static class AccountEmails
{
    public static string PasswordReset(EmailBrand brand, string? name, string link, int validMinutes) =>
        EmailLayout.Render(brand, new EmailContent
        {
            Preheader = $"Use the link inside to choose a new password. It is valid for {validMinutes} minutes.",
            Eyebrow = "Account security",
            Title = "Reset your password",
            RecipientName = name,
            Paragraphs =
            [
                "A password reset was requested for your OneInsure Connect account.",
                $"Select the button below to choose a new password. The link is valid for {validMinutes} minutes and can be used once.",
            ],
            ButtonUrl = link,
            ButtonText = "Reset your password",
            Note = "If you did not request this, ignore this e-mail. Your password stays unchanged.",
        });

    public static string SignInCode(EmailBrand brand, string? name, string code, int validMinutes) =>
        EmailLayout.Render(brand, new EmailContent
        {
            Preheader = $"Your sign-in code expires in {validMinutes} minutes.",
            Eyebrow = "Account security",
            Title = "Your sign-in code",
            RecipientName = name,
            Paragraphs = ["Your OneInsure Connect sign-in code is:"],
            Code = code,
            Note = $"It expires in {validMinutes} minutes. If you did not try to sign in, change your password and inform IT support.",
        });
}
