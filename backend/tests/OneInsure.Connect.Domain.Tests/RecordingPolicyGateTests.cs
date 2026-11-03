using OneInsure.Connect.Domain.Recording;

namespace OneInsure.Connect.Domain.Tests;

public class RecordingPolicyGateTests
{
    private static readonly RecordingPolicy Placeholder = new(); // shipped defaults

    private static RecordingPolicy ApprovedPolicy(bool customerEnabled = true) => new()
    {
        ApprovalStatus = PolicyApprovalStatus.Approved,
        ApprovedBy = "Compliance Officer",
        ApprovalReference = "LEGAL-REF-001",
        ApprovedOnUtc = DateTimeOffset.UtcNow,
        ConsentNoticeVersion = "v1.0",
        ConsentNoticeText = "Approved consent wording.",
        RetentionDays = 365,
        CustomerRecordingEnabled = customerEnabled,
        InternalRecordingEnabled = true,
    };

    [Fact]
    public void Defaults_are_restrictive_placeholders()
    {
        Assert.Equal(PolicyApprovalStatus.PendingLegalApproval, Placeholder.ApprovalStatus);
        Assert.False(Placeholder.CustomerRecordingEnabled);
        Assert.False(Placeholder.OwnerCanDownload);
        Assert.True(Placeholder.HasPlaceholders);
        Assert.Contains(RecordingPolicy.PlaceholderMarker, Placeholder.ConsentNoticeText);
    }

    [Theory]
    [InlineData(DeploymentEnvironment.Development)]
    [InlineData(DeploymentEnvironment.Pilot)]
    [InlineData(DeploymentEnvironment.Production)]
    public void Customer_recording_is_refused_with_default_policy(DeploymentEnvironment env)
    {
        var d = RecordingPolicyGate.Evaluate(Placeholder, env, MeetingRecordingKind.Customer, consentGrantedByAllRequired: true);
        Assert.False(d.Allowed);
        Assert.Equal("CUSTOMER_RECORDING_DISABLED", d.Code);
    }

    [Theory]
    [InlineData(DeploymentEnvironment.Pilot)]
    [InlineData(DeploymentEnvironment.Production)]
    public void Enabling_customer_recording_without_legal_approval_is_invalid_in_pilot_and_production(DeploymentEnvironment env)
    {
        var p = new RecordingPolicy { CustomerRecordingEnabled = true };
        Assert.NotEmpty(RecordingPolicyGate.Validate(p, env));
        var d = RecordingPolicyGate.Evaluate(p, env, MeetingRecordingKind.Customer, true);
        Assert.False(d.Allowed);
        Assert.Equal("POLICY_INVALID", d.Code);
    }

    [Fact]
    public void Development_may_test_customer_recording_with_placeholder_policy()
    {
        var p = new RecordingPolicy { CustomerRecordingEnabled = true };
        Assert.True(RecordingPolicyGate.Evaluate(p, DeploymentEnvironment.Development, MeetingRecordingKind.Customer, true).Allowed);
    }

    [Fact]
    public void Approved_policy_with_placeholder_text_is_invalid()
    {
        var p = new RecordingPolicy
        {
            ApprovalStatus = PolicyApprovalStatus.Approved, ApprovedBy = "x", ApprovalReference = "y", ApprovedOnUtc = DateTimeOffset.UtcNow,
            RetentionDays = 365, CustomerRecordingEnabled = true,
        };
        Assert.Contains(RecordingPolicyGate.Validate(p, DeploymentEnvironment.Production), e => e.Contains("placeholder", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Approved_policy_requires_approval_evidence_and_retention()
    {
        var p = new RecordingPolicy { ApprovalStatus = PolicyApprovalStatus.Approved, ConsentNoticeVersion = "v1", ConsentNoticeText = "ok" };
        var errors = RecordingPolicyGate.Validate(p, DeploymentEnvironment.Production);
        Assert.Contains(errors, e => e.Contains("ApprovedBy"));
        Assert.Contains(errors, e => e.Contains("placeholder")); // RetentionDays missing
    }

    [Fact]
    public void Archive_action_requires_location()
    {
        var p = ApprovedPolicy();
        var archive = new RecordingPolicy
        {
            ApprovalStatus = p.ApprovalStatus, ApprovedBy = p.ApprovedBy, ApprovalReference = p.ApprovalReference, ApprovedOnUtc = p.ApprovedOnUtc,
            ConsentNoticeVersion = p.ConsentNoticeVersion, ConsentNoticeText = p.ConsentNoticeText, RetentionDays = 365,
            ActionOnRetentionExpiry = RetentionExpiryAction.Archive,
        };
        Assert.Contains(RecordingPolicyGate.Validate(archive, DeploymentEnvironment.Production), e => e.Contains("ArchiveLocation"));
    }

    [Fact]
    public void Approved_policy_allows_customer_recording_in_production_only_with_consent()
    {
        var p = ApprovedPolicy();
        Assert.True(RecordingPolicyGate.Evaluate(p, DeploymentEnvironment.Production, MeetingRecordingKind.Customer, true).Allowed);
        var noConsent = RecordingPolicyGate.Evaluate(p, DeploymentEnvironment.Production, MeetingRecordingKind.Customer, false);
        Assert.False(noConsent.Allowed);
        Assert.Equal("CONSENT_MISSING", noConsent.Code);
    }

    [Fact]
    public void Disabled_requirement_blocks_even_when_enabled_flag_is_set()
    {
        var p = new RecordingPolicy { InternalRecordingEnabled = true, InternalMeetingRecording = RecordingRequirement.Disabled };
        Assert.Equal("INTERNAL_RECORDING_DISABLED", RecordingPolicyGate.Evaluate(p, DeploymentEnvironment.Development, MeetingRecordingKind.Internal, true).Code);
    }

    [Theory]
    [InlineData(10, false)]
    [InlineData(300, true)]
    [InlineData(7200, false)]
    public void Signed_url_ttl_is_bounded(int ttl, bool valid)
    {
        var p = new RecordingPolicy { SignedUrlTtlSeconds = ttl };
        Assert.Equal(valid, RecordingPolicyGate.Validate(p, DeploymentEnvironment.Development).Count == 0);
    }
    // ---- Existing business recording policy (customer audio calls and Zoom meetings) -------------------------

    static RecordingPolicy ExistingPolicy(string? reference = "OneInsure Call & Meeting Recording Policy (existing)", string consent = "Existing approved consent wording.", int? retention = 2555) => new()
    {
        ApprovalStatus = PolicyApprovalStatus.ExistingBusinessPolicy,
        ApprovalReference = reference,
        CustomerRecordingEnabled = true,
        InternalRecordingEnabled = true,
        ConsentNoticeVersion = "EXISTING-1",
        ConsentNoticeText = consent,
        RetentionDays = retention,
    };

    [Fact]
    public void Existing_business_policy_allows_customer_recording_in_production_with_consent()
    {
        var p = ExistingPolicy();
        Assert.Empty(RecordingPolicyGate.Validate(p, DeploymentEnvironment.Production));
        Assert.True(RecordingPolicyGate.Evaluate(p, DeploymentEnvironment.Production, MeetingRecordingKind.Customer, consentGrantedByAllRequired: true).Allowed);
        Assert.Equal("CONSENT_MISSING", RecordingPolicyGate.Evaluate(p, DeploymentEnvironment.Production, MeetingRecordingKind.Customer, consentGrantedByAllRequired: false).Code);
    }

    [Fact]
    public void Existing_business_policy_must_name_the_policy_and_carry_its_real_values()
    {
        Assert.NotEmpty(RecordingPolicyGate.Validate(ExistingPolicy(reference: null), DeploymentEnvironment.Production));
        Assert.NotEmpty(RecordingPolicyGate.Validate(ExistingPolicy(consent: "[PLACEHOLDER] text"), DeploymentEnvironment.Production));
        Assert.NotEmpty(RecordingPolicyGate.Validate(ExistingPolicy(retention: null), DeploymentEnvironment.Production));
    }

    [Fact]
    public void Development_and_test_never_block_customer_recording_on_approval_status()
    {
        var dev = new RecordingPolicy { CustomerRecordingEnabled = true };
        Assert.True(RecordingPolicyGate.Evaluate(dev, DeploymentEnvironment.Development, MeetingRecordingKind.Customer, true).Allowed);
        Assert.True(RecordingPolicyGate.Evaluate(dev, DeploymentEnvironment.Test, MeetingRecordingKind.Customer, true).Allowed);
    }
}
