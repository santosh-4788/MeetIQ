-- V021: separate recording policy for PLVC customer calls (12 Nov 2026), on the business owner's instruction: "in PLVC calls recording
-- is mandatory without any permission required".
--   Until now CUSTOMER_PLVC and CUSTOMER_GENERAL shared CUSTOMER_MEETING (MANDATORY + CONSENT_REQUIRED from everyone), so changing
--   PLVC alone was impossible. CUSTOMER_PLVC gets its own policy, copied from CUSTOMER_MEETING (same notice text and version, retention,
--   access roles, approval status), except:
--     Requirement = MANDATORY          - recording starts automatically when the meeting is live;
--     ConsentMode = NOTIFICATION_ONLY  - nobody has to click Accept; everyone still sees the recording notice banner and the REC
--                                        indicator (no covert recording), and the acknowledgement is stored as evidence;
--     ConsentFromAll = 0, StopOnWithdrawal = 0 (meaningless without consent).
--   CUSTOMER_GENERAL keeps CUSTOMER_MEETING, unchanged. The notice wording is NOT changed (still the placeholder until the policy
--   administrator enters the approved text); everything stays editable and audited in Administration -> Recording policies.
--   Rollback: UPDATE rec.RecordingPolicyCategories SET PolicyCode = 'CUSTOMER_MEETING' WHERE Category = 'CUSTOMER_PLVC';
--             DELETE rec.RecordingPolicies WHERE PolicyCode = 'CUSTOMER_PLVC'; then restore CK_RecordingPolicies_Code to the 4 codes.

ALTER TABLE rec.RecordingPolicies DROP CONSTRAINT CK_RecordingPolicies_Code;
ALTER TABLE rec.RecordingPolicies ADD CONSTRAINT CK_RecordingPolicies_Code
    CHECK (PolicyCode IN ('CUSTOMER_MEETING', 'CUSTOMER_PLVC', 'CUSTOMER_AUDIO_CALL', 'INTERNAL_MEETING', 'TRAINING_TEAM_MEETING'));
GO

INSERT rec.RecordingPolicies (PolicyCode, DisplayOrder, Title, AppliesTo, PolicyName, PolicyVersion, EffectiveFrom, ApprovalStatus, PolicyReference,
    ApprovedBy, ApprovedOn, IsEnabled, Requirement, ConsentMode, NoticeText, NoticeVersion, ConsentFromAll, StopOnWithdrawal, RetentionDays,
    ExpiryAction, ArchiveLocation, LegalHoldEnabled, DualApprovalForDeletion, DeletionApproverRoles, PlaybackRoles, DownloadRoles, OwnerCanPlay,
    OwnerCanDownload, TeamLeaderCanPlay, DepartmentHeadCanPlay, SignedUrlTtlSeconds, ModifiedUtc)
SELECT 'CUSTOMER_PLVC', DisplayOrder, N'Customer PLVC calls', N'PLVC video calls with customers: recording is mandatory and starts automatically; participants are notified (no acceptance step).',
    PolicyName, PolicyVersion, EffectiveFrom, ApprovalStatus, PolicyReference,
    ApprovedBy, ApprovedOn, 1, 'MANDATORY', 'NOTIFICATION_ONLY', NoticeText, NoticeVersion, 0, 0, RetentionDays,
    ExpiryAction, ArchiveLocation, LegalHoldEnabled, DualApprovalForDeletion, DeletionApproverRoles, PlaybackRoles, DownloadRoles, OwnerCanPlay,
    OwnerCanDownload, TeamLeaderCanPlay, DepartmentHeadCanPlay, SignedUrlTtlSeconds, SYSUTCDATETIME()
FROM rec.RecordingPolicies WHERE PolicyCode = 'CUSTOMER_MEETING'
  AND NOT EXISTS (SELECT 1 FROM rec.RecordingPolicies WHERE PolicyCode = 'CUSTOMER_PLVC');

UPDATE rec.RecordingPolicies SET AppliesTo = N'General video meetings with customers (PLVC calls have their own policy).', ModifiedUtc = SYSUTCDATETIME()
WHERE PolicyCode = 'CUSTOMER_MEETING';

UPDATE rec.RecordingPolicyCategories SET PolicyCode = 'CUSTOMER_PLVC' WHERE Category = 'CUSTOMER_PLVC';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'RECORDING_POLICY_CREATED', 'RecordingPolicy', 'CUSTOMER_PLVC',
    N'Migration V021: PLVC calls get their own policy - recording mandatory, notification only (no acceptance); mapped CUSTOMER_PLVC to it',
    N'{"requirement":"MANDATORY","consentMode":"NOTIFICATION_ONLY","category":"CUSTOMER_PLVC"}');
GO
