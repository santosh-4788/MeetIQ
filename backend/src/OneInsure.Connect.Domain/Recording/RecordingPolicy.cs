namespace OneInsure.Connect.Domain.Recording;

public enum DeploymentEnvironment { Development, Test, Pilot, Production }

/// <summary>
/// ExistingBusinessPolicy: recording is covered by OneInsure's existing, already-approved recording process
/// (customer audio calls and Zoom meetings). OneInsure Connect reuses that policy's consent wording, retention and
/// access rules; ApprovalReference must identify that policy document. Approved: a policy approved specifically for this platform.
/// </summary>
public enum PolicyApprovalStatus { PendingLegalApproval, Approved, ExistingBusinessPolicy }

public enum RecordingRequirement { Disabled, Optional, Mandatory }

public enum RetentionExpiryAction { ReviewOnly, Archive, Delete }

public enum MeetingRecordingKind { Internal, Customer }

/// <summary>
/// Recording policy. Every legal/compliance value here is configuration, not code, and is NEVER invented by the software.
/// Customer recording is an existing OneInsure business activity: the values are copied from the existing approved
/// recording policy (status ExistingBusinessPolicy). The shipped defaults are placeholders that only block Pilot/Production,
/// never development or testing.
/// Stored in sys.SystemSettings (Phase 2); loaded from configuration by the recorder PoC.
/// </summary>
public sealed class RecordingPolicy
{
    public const string PlaceholderMarker = "[PLACEHOLDER";

    // ---- Approval -----------------------------------------------------------------------
    public PolicyApprovalStatus ApprovalStatus { get; init; } = PolicyApprovalStatus.PendingLegalApproval;
    public string? ApprovedBy { get; init; }
    public string? ApprovalReference { get; init; }
    public DateTimeOffset? ApprovedOnUtc { get; init; }

    // ---- What may be recorded ----------------------------------------------------------
    /// <summary>Customer (PLVC) recording. Must stay false in Pilot/Production until approved.</summary>
    public bool CustomerRecordingEnabled { get; init; }
    public bool InternalRecordingEnabled { get; init; }
    public RecordingRequirement CustomerMeetingRecording { get; init; } = RecordingRequirement.Optional;
    public RecordingRequirement InternalMeetingRecording { get; init; } = RecordingRequirement.Optional;

    // ---- Consent ----------------------------------------------------------------------
    public string ConsentNoticeVersion { get; init; } = "PLACEHOLDER-0";
    public string ConsentNoticeText { get; init; } =
        "[PLACEHOLDER – NOT APPROVED BY LEGAL] This meeting will be recorded. Final wording to be provided by the OneInsure legal/compliance team.";
    public bool ConsentRequiredFromAllParticipants { get; init; } = true;
    public bool StopRecordingOnConsentWithdrawal { get; init; } = true;

    // ---- Retention, legal hold, archival, deletion -------------------------------------
    /// <summary>Null = not yet decided (placeholder). Required before approval.</summary>
    public int? RetentionDays { get; init; }
    public RetentionExpiryAction ActionOnRetentionExpiry { get; init; } = RetentionExpiryAction.ReviewOnly;
    public string? ArchiveLocation { get; init; }
    public bool LegalHoldEnabled { get; init; } = true;
    public string[] LegalHoldManagerRoles { get; init; } = ["ComplianceAuditor", "SuperAdmin"];
    public string[] DeletionApproverRoles { get; init; } = ["SuperAdmin"];
    public bool RequireDualApprovalForDeletion { get; init; } = true;

    // ---- Access -------------------------------------------------------------------------
    public bool OwnerCanPlay { get; init; } = true;
    public bool OwnerCanDownload { get; init; }
    public bool TeamLeaderCanPlayTeamRecordings { get; init; } = true;
    public string[] PlaybackRoles { get; init; } = ["Admin", "ComplianceAuditor", "SuperAdmin"];
    public string[] DownloadRoles { get; init; } = ["SuperAdmin"];
    public int SignedUrlTtlSeconds { get; init; } = 300;

    /// <summary>The policy is in force for Pilot/Production (existing business policy or one approved for this platform).</summary>
    public bool IsInForce => ApprovalStatus is PolicyApprovalStatus.Approved or PolicyApprovalStatus.ExistingBusinessPolicy;

    public bool HasPlaceholders =>
        ConsentNoticeText.Contains(PlaceholderMarker, StringComparison.OrdinalIgnoreCase)
        || ConsentNoticeVersion.StartsWith("PLACEHOLDER", StringComparison.OrdinalIgnoreCase)
        || RetentionDays is null;
}

public sealed record PolicyDecision(bool Allowed, string Code, string Message)
{
    public static PolicyDecision Allow() => new(true, "ALLOWED", "Recording permitted by policy.");
    public static PolicyDecision Deny(string code, string message) => new(false, code, message);
}

public static class RecordingPolicyGate
{
    /// <summary>Configuration problems that must block startup in the given environment.</summary>
    public static IReadOnlyList<string> Validate(RecordingPolicy p, DeploymentEnvironment env)
    {
        var errors = new List<string>();
        var restricted = env is DeploymentEnvironment.Pilot or DeploymentEnvironment.Production;
        if (restricted && p.CustomerRecordingEnabled && !p.IsInForce)
            errors.Add("Customer recording in Pilot/Production needs the recording policy in force: set ApprovalStatus to ExistingBusinessPolicy (with the existing policy's reference and values) or Approved.");
        if (p.ApprovalStatus == PolicyApprovalStatus.ExistingBusinessPolicy)
        {
            if (p.HasPlaceholders) errors.Add("ExistingBusinessPolicy still contains placeholder consent wording, version or retention: copy the values from the existing recording policy.");
            if (string.IsNullOrWhiteSpace(p.ApprovalReference))
                errors.Add("ExistingBusinessPolicy must name the existing recording policy document in ApprovalReference.");
            if (p.ActionOnRetentionExpiry == RetentionExpiryAction.Archive && string.IsNullOrWhiteSpace(p.ArchiveLocation))
                errors.Add("ArchiveLocation is required when retention action is Archive.");
        }
        if (p.ApprovalStatus == PolicyApprovalStatus.Approved)
        {
            if (p.HasPlaceholders) errors.Add("Policy is marked Approved but still contains placeholder consent wording, version or retention.");
            if (string.IsNullOrWhiteSpace(p.ApprovedBy) || string.IsNullOrWhiteSpace(p.ApprovalReference) || p.ApprovedOnUtc is null)
                errors.Add("Approved policy must record ApprovedBy, ApprovalReference and ApprovedOnUtc.");
            if (p.ActionOnRetentionExpiry == RetentionExpiryAction.Archive && string.IsNullOrWhiteSpace(p.ArchiveLocation))
                errors.Add("ArchiveLocation is required when retention action is Archive.");
        }
        if (p.SignedUrlTtlSeconds is < 30 or > 3600) errors.Add("SignedUrlTtlSeconds must be between 30 and 3600.");
        return errors;
    }

    /// <summary>Decides whether a specific meeting may be recorded right now.</summary>
    public static PolicyDecision Evaluate(RecordingPolicy p, DeploymentEnvironment env, MeetingRecordingKind kind, bool consentGrantedByAllRequired)
    {
        var configErrors = Validate(p, env);
        if (configErrors.Count > 0) return PolicyDecision.Deny("POLICY_INVALID", string.Join(" ", configErrors));

        var (enabled, requirement) = kind == MeetingRecordingKind.Customer
            ? (p.CustomerRecordingEnabled, p.CustomerMeetingRecording)
            : (p.InternalRecordingEnabled, p.InternalMeetingRecording);

        if (!enabled || requirement == RecordingRequirement.Disabled)
            return PolicyDecision.Deny(kind == MeetingRecordingKind.Customer ? "CUSTOMER_RECORDING_DISABLED" : "INTERNAL_RECORDING_DISABLED",
                $"{kind} meeting recording is disabled by policy.");

        if (kind == MeetingRecordingKind.Customer && env is DeploymentEnvironment.Pilot or DeploymentEnvironment.Production
            && !p.IsInForce)
            return PolicyDecision.Deny("POLICY_NOT_APPROVED", "Customer recording in Pilot/Production requires the recording policy in force (existing business policy or approved).");

        if (p.ConsentRequiredFromAllParticipants && !consentGrantedByAllRequired)
            return PolicyDecision.Deny("CONSENT_MISSING", "Recording consent has not been granted by all required participants.");

        return PolicyDecision.Allow();
    }
}
