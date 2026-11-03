using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using OneInsure.Connect.Api.Security;

namespace OneInsure.Connect.Api.Tests;

public sealed class TotpTests
{
    // RFC 6238 Appendix B (SHA1, secret "12345678901234567890"), last 6 digits of the 8-digit values.
    [Theory]
    [InlineData(59L, "287082")]
    [InlineData(1111111109L, "081804")]
    [InlineData(1234567890L, "005924")]
    [InlineData(2000000000L, "279037")]
    public void Matches_rfc6238_vectors(long unixSeconds, string expected)
    {
        var secret = Encoding.ASCII.GetBytes("12345678901234567890");
        Assert.Equal(expected, Totp.Code(secret, unixSeconds / 30));
        Assert.NotNull(Totp.Match(secret, expected, DateTimeOffset.FromUnixTimeSeconds(unixSeconds).UtcDateTime));
        Assert.Null(Totp.Match(secret, "000000", DateTimeOffset.FromUnixTimeSeconds(unixSeconds).UtcDateTime));
    }

    [Fact]
    public void Base32_matches_rfc4648() => Assert.Equal("MZXW6YTBOI", Totp.Base32(Encoding.ASCII.GetBytes("foobar")));
}

[Collection(ApiCollection.Name)]
public sealed class Phase2Tests(ApiFixture fx)
{
    const string Pw = ApiFixture.Password;
    static async Task<JsonElement> Json(HttpResponseMessage r) => await r.Content.ReadFromJsonAsync<JsonElement>();
    static async Task<string?> Code(HttpResponseMessage r) => (await Json(r)).TryGetProperty("code", out var c) ? c.GetString() : null;

    async Task<TestClient> SignedIn(string email, string? password = null)
    {
        var c = await fx.NewClientAsync();
        var r = await c.LoginAsync(email, password ?? Pw);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return c;
    }

    static byte[] FromBase32(string s)
    {
        const string a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var bytes = new List<byte>(); int buffer = 0, bits = 0;
        foreach (var ch in s) { buffer = (buffer << 5) | a.IndexOf(ch); bits += 5; if (bits >= 8) { bytes.Add((byte)(buffer >> (bits - 8))); bits -= 8; } }
        return bytes.ToArray();
    }

    static string CodeAt(byte[] secret, int stepOffset) => Totp.Code(secret, Totp.TimeStep(DateTime.UtcNow) + stepOffset);

    // ---- MFA -------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Mfa_enrolment_then_sign_in_requires_code_supports_recovery_and_trusted_device()
    {
        var c = await SignedIn("mfa@test.invalid");
        Assert.Equal("INVALID_CREDENTIALS", await Code(await c.PostAsync("/api/v1/account/mfa/totp/setup", new { currentPassword = "wrong" })));
        var setup = await Json(await c.PostAsync("/api/v1/account/mfa/totp/setup", new { currentPassword = Pw }));
        Assert.StartsWith("otpauth://totp/", setup.GetProperty("otpAuthUri").GetString());
        Assert.StartsWith("data:image/svg+xml;base64,", setup.GetProperty("qrCodeDataUrl").GetString());
        var secret = FromBase32(setup.GetProperty("secret").GetString()!);

        Assert.Equal("INVALID_MFA_CODE", await Code(await c.PostAsync("/api/v1/account/mfa/totp/confirm", new { code = "000000" })));
        var confirm = await Json(await c.PostAsync("/api/v1/account/mfa/totp/confirm", new { code = CodeAt(secret, 0) }));
        var recovery = confirm.GetProperty("recoveryCodes").EnumerateArray().Select(x => x.GetString()!).ToArray();
        Assert.Equal(10, recovery.Length);
        Assert.True((await Json(await c.Http.GetAsync("/api/v1/account/mfa"))).GetProperty("enabled").GetBoolean());
        Assert.Equal(1, await fx.QueryAsync<int>("SELECT COUNT(*) FROM auth.UserMfaMethods m JOIN auth.Users u ON u.UserId = m.UserId WHERE u.Email = N'mfa@test.invalid' AND m.SecretEncrypted IS NOT NULL AND m.VerifiedUtc IS NOT NULL"));

        // Password alone no longer signs in.
        var b = await fx.NewClientAsync();
        var step1 = await Json(await b.LoginAsync("mfa@test.invalid", Pw));
        Assert.Equal("MFA_REQUIRED", step1.GetProperty("status").GetString());
        Assert.Null(b.Cookie("oic_session"));
        var token = step1.GetProperty("mfaToken").GetString()!;
        Assert.Equal("INVALID_MFA_CODE", await Code(await b.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = token, code = "123456", method = "TOTP" })));
        var ok = await b.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = token, code = CodeAt(secret, 1), method = "TOTP", rememberDevice = true });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await b.Http.GetAsync("/api/v1/auth/me")).StatusCode);
        Assert.NotNull(b.Cookie("oic_trusted_device") ?? b.Jar.GetCookies(new Uri("http://localhost/api/v1/auth"))["oic_trusted_device"]?.Value);

        // The used token cannot be replayed.
        Assert.Equal("MFA_EXPIRED", await Code(await b.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = token, code = CodeAt(secret, -1), method = "TOTP" })));

        // Trusted browser: password only. Fresh browser: recovery code works once.
        Assert.Equal("SUCCESS", (await Json(await b.LoginAsync("mfa@test.invalid", Pw))).GetProperty("status").GetString());
        var d = await fx.NewClientAsync();
        var t2 = (await Json(await d.LoginAsync("mfa@test.invalid", Pw))).GetProperty("mfaToken").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await d.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = t2, code = recovery[0].ToLowerInvariant(), method = "RECOVERY_CODE" })).StatusCode);
        var e = await fx.NewClientAsync();
        var t3 = (await Json(await e.LoginAsync("mfa@test.invalid", Pw))).GetProperty("mfaToken").GetString()!;
        Assert.Equal("INVALID_MFA_CODE", await Code(await e.PostAsync("/api/v1/auth/mfa/verify", new { mfaToken = t3, code = recovery[0], method = "RECOVERY_CODE" })));
        Assert.Equal(9, (await Json(await d.Http.GetAsync("/api/v1/account/mfa"))).GetProperty("recoveryCodesRemaining").GetInt32());

        // An administrator can reset MFA (lost phone); afterwards the password alone works again.
        var admin = await SignedIn("admin@test.invalid");
        var mfaUserId = await fx.QueryAsync<Guid>("SELECT PublicId FROM auth.Users WHERE Email = N'mfa@test.invalid'");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/v1/admin/users/{mfaUserId}/reset-mfa")).StatusCode);
        Assert.Equal("SUCCESS", (await Json(await (await fx.NewClientAsync()).LoginAsync("mfa@test.invalid", Pw))).GetProperty("status").GetString());
    }

    // ---- Linking an existing account to an employee ---------------------------------------------------------

    [Fact]
    public async Task Existing_account_can_be_linked_to_employee_changed_and_unlinked_with_guards()
    {
        var super = await SignedIn("admin@test.invalid");
        var emp = await Json(await super.PostAsync("/api/v1/employees", new { employeeCode = "LNK-0001", firstName = "Lina", lastName = "Link", officialEmail = "linkme@test.invalid", departmentCode = "TST", designationCode = "TEX" }));
        var empId = emp.GetProperty("id").GetGuid();
        var user = await Json(await super.PostAsync("/api/v1/admin/users", new { email = "linkme@test.invalid", roles = new[] { "Employee" } }));
        var userId = user.GetProperty("id").GetGuid();
        var linkMe = await fx.NewClientAsync();
        await linkMe.LoginAsync("linkme@test.invalid", user.GetProperty("oneTimePassword").GetString()!);
        Assert.False((await Json(await linkMe.Http.GetAsync("/api/v1/auth/me"))).GetProperty("employeeLinked").GetBoolean());

        // The employee detail offers the existing account; creating a second one is refused with a pointer to linking.
        var detail = await Json(await super.Http.GetAsync($"/api/v1/employees/{empId}"));
        Assert.Equal(JsonValueKind.Null, detail.GetProperty("userAccount").ValueKind);
        Assert.Equal("linkme@test.invalid", detail.GetProperty("matchingAccount").GetProperty("email").GetString());
        var dup = await super.PostAsync("/api/v1/admin/users", new { employeeId = empId, roles = new[] { "Employee" } });
        Assert.Equal(HttpStatusCode.Conflict, dup.StatusCode);
        Assert.Contains("Link it instead", (await Json(dup)).GetProperty("detail").GetString());

        // An employee already linked to another account cannot be linked twice.
        var taken = await fx.QueryAsync<Guid>("SELECT PublicId FROM org.Employees WHERE EmployeeCode = 'TST-0001'");
        Assert.Equal("CONFLICT", await Code(await super.PutAsync($"/api/v1/admin/users/{userId}/employee", new { employeeId = taken })));
        // Unknown and inactive employees are validation errors.
        Assert.Equal("VALIDATION", await Code(await super.PutAsync($"/api/v1/admin/users/{userId}/employee", new { employeeId = Guid.NewGuid() })));
        var inactive = (await Json(await super.PostAsync("/api/v1/employees", new { employeeCode = "LNK-0002", firstName = "Ina", officialEmail = "lnk2@test.invalid", departmentCode = "TST", designationCode = "TEX" }))).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await super.PostAsync($"/api/v1/employees/{inactive}/deactivate")).StatusCode);
        Assert.Equal("VALIDATION", await Code(await super.PutAsync($"/api/v1/admin/users/{userId}/employee", new { employeeId = inactive })));

        // Link: the account now belongs to the employee (privileged audit entry).
        Assert.Equal(HttpStatusCode.NoContent, (await super.PutAsync($"/api/v1/admin/users/{userId}/employee", new { employeeId = empId })).StatusCode);
        detail = await Json(await super.Http.GetAsync($"/api/v1/employees/{empId}"));
        Assert.Equal("linkme@test.invalid", detail.GetProperty("userAccount").GetProperty("email").GetString());
        Assert.True((await Json(await linkMe.Http.GetAsync("/api/v1/auth/me"))).GetProperty("employeeLinked").GetBoolean());
        Assert.Equal(1, await fx.QueryAsync<int>($"SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'USER_EMPLOYEE_LINKED' AND EntityId = '{userId}' AND IsPrivileged = 1"));

        // An Admin without roles.manage cannot change a Super Administrator's link.
        var orgAdmin = await SignedIn("orgadmin@test.invalid");
        var superId = await fx.QueryAsync<Guid>("SELECT PublicId FROM auth.Users WHERE Email = N'admin@test.invalid'");
        Assert.Equal(HttpStatusCode.Forbidden, (await orgAdmin.PutAsync($"/api/v1/admin/users/{superId}/employee", new { employeeId = empId })).StatusCode);

        // Unlinking is refused while the employee organises upcoming meetings, allowed otherwise.
        var host = await SignedIn("mhost@test.invalid");
        var start = DateTime.UtcNow.Date.AddDays(500).AddHours(3);
        var created = await host.PostAsync("/api/v1/meetings", new { title = "Link guard", category = "GROUP", startUtc = start, endUtc = start.AddHours(1), hostEmployeeId = empId });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal("CONFLICT", await Code(await super.PutAsync($"/api/v1/admin/users/{userId}/employee", new { employeeId = (Guid?)null })));
        var meetingId = (await Json(created)).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await host.PostAsync($"/api/v1/meetings/{meetingId}/cancel", new { reason = "test" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await super.PutAsync($"/api/v1/admin/users/{userId}/employee", new { employeeId = (Guid?)null })).StatusCode);
        Assert.Equal(0, await fx.QueryAsync<int>($"SELECT COUNT(*) FROM auth.Users WHERE PublicId = '{userId}' AND EmployeeId IS NOT NULL"));
    }

    // ---- Organisation masters -------------------------------------------------------------------------------

    [Fact]
    public async Task Org_masters_crud_validation_conflicts_and_permissions()
    {
        var admin = await SignedIn("orgadmin@test.invalid");
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/org/departments", new { code = "claims", name = "Claims" })).StatusCode);
        Assert.Equal("CONFLICT", await Code(await admin.PostAsync("/api/v1/org/departments", new { code = "CLAIMS", name = "Claims again" })));
        var invalid = await Json(await admin.PostAsync("/api/v1/org/departments", new { code = "bad code!", name = "" }));
        Assert.Equal("VALIDATION", invalid.GetProperty("code").GetString());
        Assert.True(invalid.GetProperty("errors").TryGetProperty("name", out _));
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/org/departments", new { code = "CLAIMS-NORTH", name = "Claims North", parentCode = "CLAIMS" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync("/api/v1/org/departments/CLAIMS", new { name = "Claims & Settlement" })).StatusCode);
        Assert.Equal("VALIDATION", await Code(await admin.PutAsync("/api/v1/org/departments/CLAIMS", new { name = "x", parentCode = "CLAIMS" })));

        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/org/designations", new { code = "MGR", name = "Manager", level = 5 })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/org/branches", new { code = "MUM", name = "Mumbai", city = "Mumbai", timeZoneId = "Asia/Kolkata" })).StatusCode);
        Assert.Equal("VALIDATION", await Code(await admin.PostAsync("/api/v1/org/branches", new { code = "XXX", name = "X", timeZoneId = "Mars/Olympus" })));

        // Department with active employees cannot be deactivated.
        Assert.Equal("CONFLICT", await Code(await admin.PostAsync("/api/v1/org/departments/TST/deactivate")));
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync("/api/v1/org/departments/CLAIMS-NORTH/deactivate")).StatusCode);
        var active = await Json(await admin.Http.GetAsync("/api/v1/org/departments"));
        Assert.DoesNotContain(active.EnumerateArray(), d => d.GetProperty("code").GetString() == "CLAIMS-NORTH");

        // Branch with active employees cannot be deactivated either (they could no longer be saved); an empty one can.
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/org/branches", new { code = "BR-BUSY", name = "Busy Branch" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/employees", new
        {
            employeeCode = "BR-0001", firstName = "Branch", officialEmail = "branch.employee@test.invalid", departmentCode = "TST", designationCode = "TEX", branchCode = "BR-BUSY",
        })).StatusCode);
        Assert.Equal("CONFLICT", await Code(await admin.PostAsync("/api/v1/org/branches/BR-BUSY/deactivate")));
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync("/api/v1/org/branches/MUM/deactivate")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync("/api/v1/org/branches/MUM/activate")).StatusCode);

        // Teams and members.
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsync("/api/v1/org/teams", new { code = "T-CLAIMS", name = "Claims Team", departmentCode = "CLAIMS" })).StatusCode);
        var empId = await fx.QueryAsync<Guid>("SELECT PublicId FROM org.Employees WHERE EmployeeCode = 'TST-0001'");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync("/api/v1/org/teams/T-CLAIMS/members", new { employeeIds = new[] { empId } })).StatusCode);
        Assert.Single((await Json(await admin.Http.GetAsync("/api/v1/org/teams/T-CLAIMS/members"))).EnumerateArray());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync("/api/v1/org/teams/T-CLAIMS/members", new { employeeIds = Array.Empty<Guid>() })).StatusCode);
        Assert.Empty((await Json(await admin.Http.GetAsync("/api/v1/org/teams/T-CLAIMS/members"))).EnumerateArray());

        // Employees can read pick lists but not write.
        var emp = await SignedIn("employee@test.invalid");
        Assert.Equal(HttpStatusCode.OK, (await emp.Http.GetAsync("/api/v1/org/departments")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await emp.PostAsync("/api/v1/org/departments", new { code = "HACK", name = "Hack" })).StatusCode);
        Assert.True(await fx.QueryAsync<int>("SELECT COUNT(*) FROM app.AuditLog WHERE [Action] = 'DEPARTMENT_CREATED'") >= 2);
    }

    // ---- Employees -------------------------------------------------------------------------------------------

    [Fact]
    public async Task Employees_create_update_search_cycle_check_and_deactivation_revokes_access()
    {
        var admin = await SignedIn("orgadmin@test.invalid");
        async Task<Guid> Create(string code, string email, Guid? manager = null)
        {
            var r = await admin.PostAsync("/api/v1/employees", new { employeeCode = code, firstName = "Emp", lastName = code, officialEmail = email, mobile = "+919800000000", departmentCode = "TST", designationCode = "TEX", reportingManagerId = manager });
            Assert.Equal(HttpStatusCode.Created, r.StatusCode);
            return (await Json(r)).GetProperty("id").GetGuid();
        }
        var boss = await Create("E-BOSS", "boss@test.invalid");
        var mid = await Create("E-MID", "mid@test.invalid", boss);
        Assert.Equal("CONFLICT", await Code(await admin.PostAsync("/api/v1/employees", new { employeeCode = "E-OTHER", firstName = "X", officialEmail = "boss@test.invalid", departmentCode = "TST", designationCode = "TEX" })));
        Assert.Equal("VALIDATION", await Code(await admin.PostAsync("/api/v1/employees", new { employeeCode = "E-BAD", firstName = "X", officialEmail = "not-an-email", departmentCode = "NOPE", designationCode = "TEX" })));

        // boss -> mid would create a loop (mid already reports to boss).
        var loop = await Json(await admin.PutAsync($"/api/v1/employees/{boss}", new { firstName = "Emp", officialEmail = "boss@test.invalid", departmentCode = "TST", designationCode = "TEX", reportingManagerId = mid }));
        Assert.True(loop.GetProperty("errors").TryGetProperty("reportingManagerId", out _));

        var page = await Json(await admin.Http.GetAsync("/api/v1/employees?search=E-MID"));
        Assert.Equal(1, page.GetProperty("total").GetInt32());
        Assert.Equal("Emp E-BOSS", page.GetProperty("items")[0].GetProperty("reportingManagerName").GetString());
        var detail = await Json(await admin.Http.GetAsync($"/api/v1/employees/{boss}"));
        Assert.Equal(1, detail.GetProperty("directReports").GetInt32());

        // Give mid a user account, sign in, then deactivate the employee: access ends immediately.
        var created = await Json(await admin.PostAsync("/api/v1/admin/users", new { employeeId = mid, roles = new[] { "Employee" } }));
        var oneTime = created.GetProperty("oneTimePassword").GetString()!;
        var midClient = await fx.NewClientAsync();
        Assert.Equal("PASSWORD_CHANGE_REQUIRED", (await Json(await midClient.LoginAsync("mid@test.invalid", oneTime))).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/v1/employees/{mid}/deactivate")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await midClient.Http.GetAsync("/api/v1/auth/me")).StatusCode);
        Assert.Equal("ACCOUNT_DISABLED", await Code(await (await fx.NewClientAsync()).LoginAsync("mid@test.invalid", oneTime)));

        var emp = await SignedIn("employee@test.invalid");
        Assert.Equal(HttpStatusCode.Forbidden, (await emp.Http.GetAsync("/api/v1/employees")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await emp.Http.GetAsync("/api/v1/employees/lookup?search=Emp")).StatusCode);
    }

    [Fact]
    public async Task Employee_csv_import_validates_everything_before_applying()
    {
        var admin = await SignedIn("orgadmin@test.invalid");
        const string good = "EmployeeCode,FirstName,LastName,OfficialEmail,DepartmentCode,DesignationCode,ReportingManagerCode,DateOfJoining\r\n" +
                            "IMP-1,\"Asha, R\",Kumar,imp1@test.invalid,TST,TEX,,2024-04-01\r\n" +
                            "IMP-2,Ravi,Shah,imp2@test.invalid,TST,TEX,IMP-1,2025-01-15\r\n";
        var dry = await Json(await admin.PostAsync("/api/v1/employees/import", new { csv = good, dryRun = true }));
        Assert.False(dry.GetProperty("applied").GetBoolean());
        Assert.Equal(2, dry.GetProperty("summary").GetProperty("created").GetInt32());
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM org.Employees WHERE EmployeeCode LIKE 'IMP-%'"));

        var bad = good + "IMP-3,Bad,Row,not-an-email,NOPE,TEX,,31/12/2024\r\n";
        var badResult = await Json(await admin.PostAsync("/api/v1/employees/import", new { csv = bad, dryRun = false }));
        Assert.False(badResult.GetProperty("applied").GetBoolean());
        Assert.Equal(1, badResult.GetProperty("summary").GetProperty("failed").GetInt32());
        Assert.Equal(0, await fx.QueryAsync<int>("SELECT COUNT(*) FROM org.Employees WHERE EmployeeCode LIKE 'IMP-%'")); // all-or-nothing

        var applied = await Json(await admin.PostAsync("/api/v1/employees/import", new { csv = good, dryRun = false }));
        Assert.True(applied.GetProperty("applied").GetBoolean());
        Assert.Equal("Asha, R", await fx.QueryAsync<string>("SELECT FirstName FROM org.Employees WHERE EmployeeCode = 'IMP-1'"));
        Assert.Equal("IMP-1", await fx.QueryAsync<string>("SELECT m.EmployeeCode FROM org.Employees e JOIN org.Employees m ON m.EmployeeId = e.ReportingManagerId WHERE e.EmployeeCode = 'IMP-2'"));
        // Re-import updates instead of duplicating.
        var again = await Json(await admin.PostAsync("/api/v1/employees/import", new { csv = good, dryRun = false }));
        Assert.Equal(2, again.GetProperty("summary").GetProperty("updated").GetInt32());
    }

    // ---- Users & roles ---------------------------------------------------------------------------------------

    [Fact]
    public async Task User_admin_one_time_passwords_and_privilege_escalation_guards()
    {
        var admin = await SignedIn("orgadmin@test.invalid");   // Admin role: users.manage, no roles.manage
        var super = await SignedIn("admin@test.invalid");      // SuperAdmin

        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsync("/api/v1/admin/users", new { email = "x1@test.invalid", roles = new[] { "SuperAdmin" } })).StatusCode);
        var created = await Json(await admin.PostAsync("/api/v1/admin/users", new { email = "new.user@test.invalid", roles = new[] { "Employee" } }));
        var newId = created.GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.OK, (await (await fx.NewClientAsync()).LoginAsync("new.user@test.invalid", created.GetProperty("oneTimePassword").GetString()!)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PutAsync($"/api/v1/admin/users/{newId}/roles", new { roles = new[] { "SuperAdmin" } })).StatusCode);

        var superId = await fx.QueryAsync<Guid>("SELECT PublicId FROM auth.Users WHERE Email = N'admin@test.invalid'");
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsync($"/api/v1/admin/users/{superId}/reset-password")).StatusCode);
        Assert.Equal("CONFLICT", await Code(await super.PutAsync($"/api/v1/admin/users/{superId}/roles", new { roles = new[] { "Admin" } }))); // not own role
        Assert.Equal("CONFLICT", await Code(await super.PostAsync($"/api/v1/admin/users/{superId}/deactivate")));

        // Admin-issued reset: old sessions end, one-time password must be changed.
        var victim = await SignedIn("victim@test.invalid");
        var victimId = await fx.QueryAsync<Guid>("SELECT PublicId FROM auth.Users WHERE Email = N'victim@test.invalid'");
        var reset = await Json(await admin.PostAsync($"/api/v1/admin/users/{victimId}/reset-password"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await victim.Http.GetAsync("/api/v1/auth/me")).StatusCode);
        Assert.Equal("PASSWORD_CHANGE_REQUIRED", (await Json(await (await fx.NewClientAsync()).LoginAsync("victim@test.invalid", reset.GetProperty("oneTimePassword").GetString()!))).GetProperty("status").GetString());

        // Permission matrix: only roles.manage, and SuperAdmin keeps roles.manage.
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PutAsync("/api/v1/admin/roles/Employee/permissions", new { permissions = new[] { "dashboard.view" } })).StatusCode);
        Assert.Equal("CONFLICT", await Code(await super.PutAsync("/api/v1/admin/roles/SuperAdmin/permissions", new { permissions = new[] { "dashboard.view" } })));
        Assert.Equal(HttpStatusCode.NoContent, (await super.PutAsync("/api/v1/admin/roles/TeamLeader/permissions", new { permissions = new[] { "dashboard.view", "calendar.view" } })).StatusCode);
        var roles = await Json(await super.Http.GetAsync("/api/v1/admin/roles"));
        var tl = roles.EnumerateArray().First(r => r.GetProperty("code").GetString() == "TeamLeader");
        Assert.Equal(new[] { "calendar.view", "dashboard.view" }, tl.GetProperty("permissions").EnumerateArray().Select(x => x.GetString()!).ToArray());

        var list = await Json(await admin.Http.GetAsync("/api/v1/admin/users?search=new.user"));
        Assert.Equal(1, list.GetProperty("total").GetInt32());
        Assert.True(list.GetProperty("items")[0].GetProperty("mustChangePassword").GetBoolean());
        Assert.EndsWith("Z", list.GetProperty("items")[0].GetProperty("lastLoginUtc").GetString()); // UTC timestamps carry "Z"
    }
}
