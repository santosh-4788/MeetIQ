using Dapper;
using OneInsure.Connect.Api.Auth;
using OneInsure.Connect.Api.Infrastructure;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Setup;

/// <summary>
/// First-run administrator creation, run on the server by an operator (no credentials are ever seeded):
///   OneInsure.Connect.Api.exe setup-admin --email admin@oneinsure.com [--employee-code OIC-0001]
/// The password is generated (shown once, must be changed at first sign-in) unless OIC_ADMIN_PASSWORD is set.
/// Refuses to run when a SuperAdmin already exists.
/// </summary>
public static class AdminBootstrap
{
    public static async Task<int> RunAsync(string[] args, Db db, Passwords passwords, TextWriter output)
    {
        string? Arg(string name) => args.SkipWhile(a => a != name).Skip(1).FirstOrDefault();
        var email = Arg("--email")?.Trim();
        var employeeCode = Arg("--employee-code")?.Trim();
        if (string.IsNullOrEmpty(email) || !email.Contains('@') || email.Length > 254)
        {
            output.WriteLine("Usage: setup-admin --email <address> [--employee-code <code>]");
            return 2;
        }

        var supplied = Environment.GetEnvironmentVariable("OIC_ADMIN_PASSWORD");
        var password = string.IsNullOrEmpty(supplied) ? GeneratePassword() : supplied;
        var violations = PasswordPolicy.Violations(password, email, employeeCode);
        if (violations.Count > 0)
        {
            output.WriteLine("OIC_ADMIN_PASSWORD does not meet the policy: " + string.Join("; ", violations));
            return 2;
        }

        using var c = await db.OpenAsync();
        using var tx = c.BeginTransaction(System.Data.IsolationLevel.Serializable);
        var existing = await c.ExecuteScalarAsync<int>("""
            SELECT COUNT(*) FROM auth.UserRoles ur WITH (UPDLOCK, HOLDLOCK) JOIN auth.Roles r ON r.RoleId = ur.RoleId WHERE r.Code = 'SuperAdmin'
            """, transaction: tx);
        if (existing > 0)
        {
            output.WriteLine("A SuperAdmin already exists. Use the administration screens to add administrators.");
            return 3;
        }
        if (await c.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM auth.Users WHERE Email = @email", new { email }, tx) > 0)
        {
            output.WriteLine($"A user with e-mail {email} already exists.");
            return 3;
        }

        var userId = await c.QuerySingleAsync<long>("""
            INSERT auth.Users (Email, EmployeeCode, PasswordHash, PasswordChangedUtc, MustChangePassword)
            OUTPUT inserted.UserId
            VALUES (@email, @employeeCode, @hash, SYSUTCDATETIME(), @mustChange)
            """, new { email, employeeCode = string.IsNullOrEmpty(employeeCode) ? null : employeeCode, hash = passwords.Hash(password), mustChange = string.IsNullOrEmpty(supplied) }, tx);
        await c.ExecuteAsync("INSERT auth.UserRoles (UserId, RoleId) SELECT @userId, RoleId FROM auth.Roles WHERE Code = 'SuperAdmin'", new { userId }, tx);
        await Audit.WriteUserAsync(c, "SYSTEM", null, "SUPERADMIN_CREATED", userId, $"First SuperAdmin created by setup-admin ({Environment.UserName}@{Environment.MachineName})", null, tx, privileged: true);
        tx.Commit();

        output.WriteLine($"SuperAdmin created: {email}");
        if (string.IsNullOrEmpty(supplied))
            output.WriteLine($"One-time password (change it at first sign-in; shown only now): {password}");
        return 0;
    }

    /// <summary>One-time password meeting the policy (shown once; the user must change it at first sign-in).</summary>
    public static string GeneratePassword()
    {
        const string upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", lower = "abcdefghijkmnopqrstuvwxyz", digits = "23456789", symbols = "#%*+-=?@_";
        var all = upper + lower + digits + symbols;
        var chars = new List<char>();
        foreach (var set in new[] { upper, lower, digits, symbols }) { chars.Add(Pick(set)); chars.Add(Pick(set)); }
        for (var i = 0; i < 12; i++) chars.Add(Pick(all));
        return new string(chars.OrderBy(_ => System.Security.Cryptography.RandomNumberGenerator.GetInt32(int.MaxValue)).ToArray());
        static char Pick(string s) => s[System.Security.Cryptography.RandomNumberGenerator.GetInt32(s.Length)];
    }
}
