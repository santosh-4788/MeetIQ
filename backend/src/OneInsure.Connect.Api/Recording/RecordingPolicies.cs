using System.Data;
using System.Text.Json;
using Dapper;
using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Api.Recording;

/// <summary>One row of rec.RecordingPolicies (V012). Every legal/compliance value is configuration entered by an administrator.</summary>
public sealed class PolicyRow
{
    public string PolicyCode { get; set; } = "";
    public int DisplayOrder { get; set; }
    public string Title { get; set; } = "";
    public string AppliesTo { get; set; } = "";
    public string? PolicyName { get; set; }
    public string? PolicyVersion { get; set; }
    public DateTime? EffectiveFrom { get; set; }
    public string ApprovalStatus { get; set; } = "PENDING_CONFIRMATION";
    public string? PolicyReference { get; set; }
    public string? ApprovedBy { get; set; }
    public DateTime? ApprovedOn { get; set; }
    public bool IsEnabled { get; set; }
    public string Requirement { get; set; } = "OPTIONAL";
    public string ConsentMode { get; set; } = "CONSENT_REQUIRED";
    public string NoticeText { get; set; } = "";
    public string NoticeVersion { get; set; } = "";
    public bool ConsentFromAll { get; set; }
    public bool StopOnWithdrawal { get; set; }
    public int? RetentionDays { get; set; }
    public string ExpiryAction { get; set; } = "REVIEW_ONLY";
    public string? ArchiveLocation { get; set; }
    public bool LegalHoldEnabled { get; set; }
    public bool DualApprovalForDeletion { get; set; }
    public string DeletionApproverRoles { get; set; } = "[]";
    public string PlaybackRoles { get; set; } = "[]";
    public string DownloadRoles { get; set; } = "[]";
    public bool OwnerCanPlay { get; set; }
    public bool OwnerCanDownload { get; set; }
    public bool TeamLeaderCanPlay { get; set; }
    public bool DepartmentHeadCanPlay { get; set; }
    public int SignedUrlTtlSeconds { get; set; }
    public DateTime? ModifiedUtc { get; set; }
    public string? ModifiedBy { get; set; }
    public byte[] RowVersion { get; set; } = [];

    public string[] Playback => Roles(PlaybackRoles);
    public string[] Download => Roles(DownloadRoles);
    public string[] DeletionApprovers => Roles(DeletionApproverRoles);

    static string[] Roles(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json) ?? []; }
        catch (JsonException) { return []; }
    }

    /// <summary>The values come from a confirmed policy document (existing business policy or a platform approval) with a reference.</summary>
    public bool IsConfirmed => ApprovalStatus is "EXISTING_BUSINESS_POLICY" or "APPROVED" && !string.IsNullOrWhiteSpace(PolicyReference);

    public bool HasPlaceholders => ToGate(MeetingRecordingKind.Internal).HasPlaceholders;

    /// <summary>The policy as the shared <see cref="RecordingPolicyGate"/> (and the R2 recorder) understands it.</summary>
    public RecordingPolicy ToGate(MeetingRecordingKind kind)
    {
        var requirement = Requirement switch { "MANDATORY" => RecordingRequirement.Mandatory, "DISABLED" => RecordingRequirement.Disabled, _ => RecordingRequirement.Optional };
        var enabled = IsEnabled && requirement != RecordingRequirement.Disabled;
        return new RecordingPolicy
        {
            ApprovalStatus = ApprovalStatus switch
            {
                "EXISTING_BUSINESS_POLICY" => PolicyApprovalStatus.ExistingBusinessPolicy,
                "APPROVED" => PolicyApprovalStatus.Approved,
                _ => PolicyApprovalStatus.PendingLegalApproval,
            },
            ApprovedBy = ApprovedBy,
            ApprovalReference = PolicyReference,
            ApprovedOnUtc = ApprovedOn is { } d ? new DateTimeOffset(DateTime.SpecifyKind(d, DateTimeKind.Utc)) : null,
            CustomerRecordingEnabled = kind == MeetingRecordingKind.Customer && enabled,
            InternalRecordingEnabled = kind == MeetingRecordingKind.Internal && enabled,
            CustomerMeetingRecording = requirement,
            InternalMeetingRecording = requirement,
            ConsentNoticeText = NoticeText,
            ConsentNoticeVersion = NoticeVersion,
            ConsentRequiredFromAllParticipants = ConsentMode == "CONSENT_REQUIRED" && ConsentFromAll,
            StopRecordingOnConsentWithdrawal = StopOnWithdrawal,
            RetentionDays = RetentionDays,
            ActionOnRetentionExpiry = ExpiryAction switch { "ARCHIVE" => RetentionExpiryAction.Archive, "DELETE" => RetentionExpiryAction.Delete, _ => RetentionExpiryAction.ReviewOnly },
            ArchiveLocation = ArchiveLocation,
            LegalHoldEnabled = LegalHoldEnabled,
            LegalHoldManagerRoles = [],
            DeletionApproverRoles = DeletionApprovers,
            RequireDualApprovalForDeletion = DualApprovalForDeletion,
            OwnerCanPlay = OwnerCanPlay,
            OwnerCanDownload = OwnerCanDownload,
            TeamLeaderCanPlayTeamRecordings = TeamLeaderCanPlay,
            PlaybackRoles = Playback,
            DownloadRoles = Download,
            SignedUrlTtlSeconds = SignedUrlTtlSeconds,
        };
    }

    /// <summary>Values written to the audit log and to each recording's policy snapshot.</summary>
    public object Snapshot() => new
    {
        policyCode = PolicyCode, policyName = PolicyName, policyVersion = PolicyVersion, effectiveFrom = EffectiveFrom?.ToString("yyyy-MM-dd"),
        approvalStatus = ApprovalStatus, policyReference = PolicyReference, approvedBy = ApprovedBy, approvedOn = ApprovedOn?.ToString("yyyy-MM-dd"),
        enabled = IsEnabled, requirement = Requirement, consentMode = ConsentMode, noticeText = NoticeText, noticeVersion = NoticeVersion,
        consentFromAll = ConsentFromAll, stopOnWithdrawal = StopOnWithdrawal, retentionDays = RetentionDays, expiryAction = ExpiryAction,
        archiveLocation = ArchiveLocation, legalHoldEnabled = LegalHoldEnabled, dualApprovalForDeletion = DualApprovalForDeletion,
        deletionApproverRoles = DeletionApprovers, playbackRoles = Playback, downloadRoles = Download, ownerCanPlay = OwnerCanPlay,
        ownerCanDownload = OwnerCanDownload, teamLeaderCanPlay = TeamLeaderCanPlay, departmentHeadCanPlay = DepartmentHeadCanPlay,
        signedUrlTtlSeconds = SignedUrlTtlSeconds,
    };
}

/// <summary>The recording policy that applies to a meeting, and what it means for that meeting.</summary>
public sealed record MeetingPolicy(PolicyRow Policy, MeetingRecordingKind Kind, string EffectiveRequirement);

public static class RecordingPolicyStore
{
    public static readonly string[] Codes = ["CUSTOMER_MEETING", "CUSTOMER_AUDIO_CALL", "INTERNAL_MEETING", "TRAINING_TEAM_MEETING"];
    public static readonly string[] Statuses = ["PENDING_CONFIRMATION", "EXISTING_BUSINESS_POLICY", "APPROVED"];
    public static readonly string[] Requirements = ["DISABLED", "OPTIONAL", "MANDATORY"];
    public static readonly string[] ConsentModes = ["CONSENT_REQUIRED", "NOTIFICATION_ONLY"];
    public static readonly string[] ExpiryActions = ["REVIEW_ONLY", "ARCHIVE", "DELETE"];

    const string Columns = """
        p.PolicyCode, p.DisplayOrder, p.Title, p.AppliesTo, p.PolicyName, p.PolicyVersion, p.EffectiveFrom, p.ApprovalStatus, p.PolicyReference,
        p.ApprovedBy, p.ApprovedOn, p.IsEnabled, p.Requirement, p.ConsentMode, p.NoticeText, p.NoticeVersion, p.ConsentFromAll, p.StopOnWithdrawal,
        p.RetentionDays, p.ExpiryAction, p.ArchiveLocation, p.LegalHoldEnabled, p.DualApprovalForDeletion, p.DeletionApproverRoles, p.PlaybackRoles,
        p.DownloadRoles, p.OwnerCanPlay, p.OwnerCanDownload, p.TeamLeaderCanPlay, p.DepartmentHeadCanPlay, p.SignedUrlTtlSeconds, p.ModifiedUtc,
        u.Email AS ModifiedBy, p.RowVersion
        """;

    public static async Task<List<PolicyRow>> AllAsync(IDbConnection c, IDbTransaction? tx = null) =>
        (await c.QueryAsync<PolicyRow>($"SELECT {Columns} FROM rec.RecordingPolicies p LEFT JOIN auth.Users u ON u.UserId = p.ModifiedByUserId ORDER BY p.DisplayOrder", transaction: tx)).ToList();

    public static Task<PolicyRow?> GetAsync(IDbConnection c, string code, IDbTransaction? tx = null) =>
        c.QuerySingleOrDefaultAsync<PolicyRow>($"SELECT {Columns} FROM rec.RecordingPolicies p LEFT JOIN auth.Users u ON u.UserId = p.ModifiedByUserId WHERE p.PolicyCode = @code",
            new { code }, tx);

    /// <summary>The policy mapped to a meeting category (rec.RecordingPolicyCategories) and the effective requirement for this meeting.</summary>
    public static async Task<MeetingPolicy?> ForMeetingAsync(IDbConnection c, string category, string meetingRecordingPolicy, IDbTransaction? tx = null)
    {
        var p = await c.QuerySingleOrDefaultAsync<PolicyRow>($"""
            SELECT {Columns} FROM rec.RecordingPolicyCategories m JOIN rec.RecordingPolicies p ON p.PolicyCode = m.PolicyCode
            LEFT JOIN auth.Users u ON u.UserId = p.ModifiedByUserId WHERE m.Category = @category
            """, new { category }, tx);
        if (p is null) return null;
        var kind = Meetings.MeetingEndpoints.IsCustomerCategory(category) ? MeetingRecordingKind.Customer : MeetingRecordingKind.Internal;
        return new MeetingPolicy(p, kind, EffectiveRequirement(p, meetingRecordingPolicy));
    }

    /// <summary>
    /// The configured policy decides; the organiser's per-meeting choice (NONE/OPTIONAL/REQUIRED) can only make recording stricter:
    /// a disabled policy is never overridden, MANDATORY stays mandatory, and REQUIRED on an OPTIONAL policy auto-starts recording.
    /// </summary>
    public static string EffectiveRequirement(PolicyRow p, string meetingRecordingPolicy) =>
        !p.IsEnabled || p.Requirement == "DISABLED" ? "DISABLED"
        : p.Requirement == "MANDATORY" || meetingRecordingPolicy == "REQUIRED" ? "MANDATORY"
        : "OPTIONAL";

    public static async Task<List<(string Category, string PolicyCode)>> CategoriesAsync(IDbConnection c) =>
        (await c.QueryAsync<(string, string)>("SELECT Category, PolicyCode FROM rec.RecordingPolicyCategories ORDER BY Category")).ToList();
}
