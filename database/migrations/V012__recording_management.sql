-- V012: recording management (Phase 5).
-- 1. rec.RecordingPolicies: four SEPARATE, admin-editable recording policies (customer meetings, customer audio calls,
--    internal employee meetings, training & team meetings). Every legal/compliance value is configuration. The seeded rows
--    are PLACEHOLDERS (status PENDING_CONFIRMATION, placeholder wording, no retention, no access roles): nothing here is a
--    confirmed OneInsure policy, and the API refuses to mark a policy confirmed while placeholders remain.
-- 2. rec.RecordingPolicyCategories: which policy applies to which meeting category (editable).
-- 3. rec.MeetingRecordings: policy snapshot, storage tier (primary/archive), retention review, purge and stop details,
--    and at most one active (PENDING/RECORDING) recording per meeting.
-- 4. rec.RecordingJobs: launch counter and recorder process id (crash recovery / diagnostics).
-- 5. rec.RecordingDeletions: deletion requests, approvals (dual approval when the policy requires it) and executions.
--    The recording row itself is never deleted: it becomes PURGED.
-- 6. Permission recordings.policy.manage (edit recording policies), granted to SuperAdmin only. All other recordings.*
--    permissions stay unassigned (V010) until the access matrix is confirmed.

CREATE TABLE rec.RecordingPolicies (
    PolicyCode              VARCHAR(40)    NOT NULL CONSTRAINT PK_RecordingPolicies PRIMARY KEY,
    DisplayOrder            INT            NOT NULL,
    Title                   NVARCHAR(100)  NOT NULL,
    AppliesTo               NVARCHAR(400)  NOT NULL,
    PolicyName              NVARCHAR(200)  NULL,
    PolicyVersion           NVARCHAR(50)   NULL,
    EffectiveFrom           DATE           NULL,
    ApprovalStatus          VARCHAR(30)    NOT NULL CONSTRAINT DF_RecordingPolicies_ApprovalStatus DEFAULT ('PENDING_CONFIRMATION'),
    PolicyReference         NVARCHAR(400)  NULL,
    ApprovedBy              NVARCHAR(200)  NULL,
    ApprovedOn              DATE           NULL,
    IsEnabled               BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_IsEnabled DEFAULT (0),
    Requirement             VARCHAR(20)    NOT NULL CONSTRAINT DF_RecordingPolicies_Requirement DEFAULT ('OPTIONAL'),
    ConsentMode             VARCHAR(30)    NOT NULL CONSTRAINT DF_RecordingPolicies_ConsentMode DEFAULT ('CONSENT_REQUIRED'),
    NoticeText              NVARCHAR(4000) NOT NULL,
    NoticeVersion           VARCHAR(30)    NOT NULL,
    ConsentFromAll          BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_ConsentFromAll DEFAULT (1),
    StopOnWithdrawal        BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_StopOnWithdrawal DEFAULT (1),
    RetentionDays           INT            NULL,
    ExpiryAction            VARCHAR(20)    NOT NULL CONSTRAINT DF_RecordingPolicies_ExpiryAction DEFAULT ('REVIEW_ONLY'),
    ArchiveLocation         NVARCHAR(400)  NULL,
    LegalHoldEnabled        BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_LegalHoldEnabled DEFAULT (1),
    DualApprovalForDeletion BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_DualApproval DEFAULT (1),
    DeletionApproverRoles   NVARCHAR(400)  NOT NULL CONSTRAINT DF_RecordingPolicies_DeletionApproverRoles DEFAULT (N'[]'),
    PlaybackRoles           NVARCHAR(400)  NOT NULL CONSTRAINT DF_RecordingPolicies_PlaybackRoles DEFAULT (N'[]'),
    DownloadRoles           NVARCHAR(400)  NOT NULL CONSTRAINT DF_RecordingPolicies_DownloadRoles DEFAULT (N'[]'),
    OwnerCanPlay            BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_OwnerCanPlay DEFAULT (1),
    OwnerCanDownload        BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_OwnerCanDownload DEFAULT (0),
    TeamLeaderCanPlay       BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_TeamLeaderCanPlay DEFAULT (0),
    DepartmentHeadCanPlay   BIT            NOT NULL CONSTRAINT DF_RecordingPolicies_DepartmentHeadCanPlay DEFAULT (0),
    SignedUrlTtlSeconds     INT            NOT NULL CONSTRAINT DF_RecordingPolicies_SignedUrlTtl DEFAULT (300),
    ModifiedUtc             DATETIME2(3)   NULL,
    ModifiedByUserId        BIGINT         NULL CONSTRAINT FK_RecordingPolicies_ModifiedBy REFERENCES auth.Users (UserId),
    RowVersion              ROWVERSION     NOT NULL,
    CONSTRAINT CK_RecordingPolicies_Code CHECK (PolicyCode IN ('CUSTOMER_MEETING', 'CUSTOMER_AUDIO_CALL', 'INTERNAL_MEETING', 'TRAINING_TEAM_MEETING')),
    CONSTRAINT CK_RecordingPolicies_ApprovalStatus CHECK (ApprovalStatus IN ('PENDING_CONFIRMATION', 'EXISTING_BUSINESS_POLICY', 'APPROVED')),
    CONSTRAINT CK_RecordingPolicies_Requirement CHECK (Requirement IN ('DISABLED', 'OPTIONAL', 'MANDATORY')),
    CONSTRAINT CK_RecordingPolicies_ConsentMode CHECK (ConsentMode IN ('CONSENT_REQUIRED', 'NOTIFICATION_ONLY')),
    CONSTRAINT CK_RecordingPolicies_ExpiryAction CHECK (ExpiryAction IN ('REVIEW_ONLY', 'ARCHIVE', 'DELETE')),
    CONSTRAINT CK_RecordingPolicies_Retention CHECK (RetentionDays IS NULL OR RetentionDays BETWEEN 1 AND 36500),
    CONSTRAINT CK_RecordingPolicies_Ttl CHECK (SignedUrlTtlSeconds BETWEEN 30 AND 3600),
    CONSTRAINT CK_RecordingPolicies_RoleJson CHECK (ISJSON(PlaybackRoles) = 1 AND ISJSON(DownloadRoles) = 1 AND ISJSON(DeletionApproverRoles) = 1),
    -- A policy is never "confirmed" without the reference of the policy document it comes from.
    CONSTRAINT CK_RecordingPolicies_ConfirmedHasReference CHECK (ApprovalStatus = 'PENDING_CONFIRMATION' OR (PolicyReference IS NOT NULL AND LEN(PolicyReference) > 0))
);
GO

-- PLACEHOLDER values. Wording, retention and access roles are deliberately NOT filled in: they come from the existing OneInsure
-- recording policy and are entered by an administrator (Administration -> Recording policies). Customer meeting recording is
-- switched on because it is an existing business activity; Pilot/Production still refuse it until the policy is confirmed.
DECLARE @notice NVARCHAR(4000) = N'[PLACEHOLDER - NOT CONFIRMED] This meeting may be recorded. The approved notification wording from the existing OneInsure recording policy has not been entered yet.';
INSERT rec.RecordingPolicies (PolicyCode, DisplayOrder, Title, AppliesTo, IsEnabled, Requirement, ConsentMode, NoticeText, NoticeVersion) VALUES
 ('CUSTOMER_MEETING',      1, N'Customer meetings',            N'Video meetings with customers (PLVC and general customer meetings).', 1, 'OPTIONAL', 'CONSENT_REQUIRED', @notice, 'PLACEHOLDER-0'),
 ('CUSTOMER_AUDIO_CALL',   2, N'Customer audio calls',         N'Customer audio calls. Configuration only: OneInsure Connect has no telephony integration yet, so this policy is not applied to any meeting.', 0, 'OPTIONAL', 'CONSENT_REQUIRED', @notice, 'PLACEHOLDER-0'),
 ('INTERNAL_MEETING',      3, N'Internal employee meetings',   N'Employee-only meetings: one-to-one, group, management and review meetings.', 0, 'OPTIONAL', 'CONSENT_REQUIRED', @notice, 'PLACEHOLDER-0'),
 ('TRAINING_TEAM_MEETING', 4, N'Training & team meetings',     N'Training, team and department meetings.', 0, 'OPTIONAL', 'CONSENT_REQUIRED', @notice, 'PLACEHOLDER-0');
GO

CREATE TABLE rec.RecordingPolicyCategories (
    Category            VARCHAR(30)    NOT NULL CONSTRAINT PK_RecordingPolicyCategories PRIMARY KEY,
    PolicyCode          VARCHAR(40)    NOT NULL CONSTRAINT FK_RecordingPolicyCategories_Policy REFERENCES rec.RecordingPolicies (PolicyCode),
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL CONSTRAINT FK_RecordingPolicyCategories_ModifiedBy REFERENCES auth.Users (UserId),
    CONSTRAINT CK_RecordingPolicyCategories_Category CHECK (Category IN ('INTERNAL_1_1', 'GROUP', 'TEAM', 'DEPARTMENT', 'MANAGEMENT', 'TRAINING', 'REVIEW', 'CUSTOMER_PLVC', 'CUSTOMER_GENERAL')),
    -- Customer audio calls are not meetings (no telephony integration): no meeting category maps to that policy.
    CONSTRAINT CK_RecordingPolicyCategories_NotAudio CHECK (PolicyCode <> 'CUSTOMER_AUDIO_CALL')
);
INSERT rec.RecordingPolicyCategories (Category, PolicyCode) VALUES
 ('CUSTOMER_PLVC', 'CUSTOMER_MEETING'), ('CUSTOMER_GENERAL', 'CUSTOMER_MEETING'),
 ('TRAINING', 'TRAINING_TEAM_MEETING'), ('TEAM', 'TRAINING_TEAM_MEETING'), ('DEPARTMENT', 'TRAINING_TEAM_MEETING'),
 ('INTERNAL_1_1', 'INTERNAL_MEETING'), ('GROUP', 'INTERNAL_MEETING'), ('MANAGEMENT', 'INTERNAL_MEETING'), ('REVIEW', 'INTERNAL_MEETING');
GO

ALTER TABLE rec.MeetingRecordings ADD
    PolicyCode          VARCHAR(40)    NULL CONSTRAINT FK_MeetingRecordings_Policy REFERENCES rec.RecordingPolicies (PolicyCode),
    PolicyVersion       NVARCHAR(50)   NULL,
    PolicySnapshotJson  NVARCHAR(MAX)  NULL,
    StorageTier         VARCHAR(20)    NOT NULL CONSTRAINT DF_MeetingRecordings_StorageTier DEFAULT ('PRIMARY'),
    ArchiveRoot         NVARCHAR(400)  NULL,
    ArchivedUtc         DATETIME2(3)   NULL,
    RetentionReviewUtc  DATETIME2(3)   NULL,
    PurgedUtc           DATETIME2(3)   NULL,
    StartedByUserId     BIGINT         NULL CONSTRAINT FK_MeetingRecordings_StartedBy REFERENCES auth.Users (UserId),
    StopReason          NVARCHAR(200)  NULL;
GO
ALTER TABLE rec.MeetingRecordings ADD
    CONSTRAINT CK_MeetingRecordings_PolicySnapshotJson CHECK (PolicySnapshotJson IS NULL OR ISJSON(PolicySnapshotJson) = 1),
    CONSTRAINT CK_MeetingRecordings_StorageTier CHECK (StorageTier IN ('PRIMARY', 'ARCHIVE')),
    CONSTRAINT CK_MeetingRecordings_ArchiveRoot CHECK (StorageTier <> 'ARCHIVE' OR ArchiveRoot IS NOT NULL),
    CONSTRAINT CK_MeetingRecordings_Purged CHECK ([Status] <> 'PURGED' OR PurgedUtc IS NOT NULL);
GO
-- One live recording per meeting: two hosts pressing "Start" at once cannot create two recorder jobs.
CREATE UNIQUE INDEX UX_MeetingRecordings_ActivePerMeeting ON rec.MeetingRecordings (MeetingId) WHERE [Status] IN ('PENDING', 'RECORDING');
CREATE INDEX IX_MeetingRecordings_Status_Ended ON rec.MeetingRecordings ([Status], EndedUtc) INCLUDE (PolicyCode, LegalHold, StorageTier);
GO

ALTER TABLE rec.RecordingJobs ADD
    LaunchCount         INT            NOT NULL CONSTRAINT DF_RecordingJobs_LaunchCount DEFAULT (0),
    RecorderPid         INT            NULL;
GO

CREATE TABLE rec.RecordingDeletions (
    DeletionId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RecordingDeletions PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_RecordingDeletions_PublicId DEFAULT (NEWSEQUENTIALID()),
    RecordingId         BIGINT         NOT NULL CONSTRAINT FK_RecordingDeletions_Recording REFERENCES rec.MeetingRecordings (RecordingId),
    Source              VARCHAR(20)    NOT NULL,
    Reason              NVARCHAR(500)  NOT NULL,
    RequiredApprovals   INT            NOT NULL,
    [Status]            VARCHAR(20)    NOT NULL CONSTRAINT DF_RecordingDeletions_Status DEFAULT ('PENDING'),
    RequestedUtc        DATETIME2(3)   NOT NULL CONSTRAINT DF_RecordingDeletions_RequestedUtc DEFAULT (SYSUTCDATETIME()),
    RequestedByUserId   BIGINT         NULL CONSTRAINT FK_RecordingDeletions_RequestedBy REFERENCES auth.Users (UserId),
    FirstApproverUserId BIGINT         NULL CONSTRAINT FK_RecordingDeletions_First REFERENCES auth.Users (UserId),
    FirstApprovedUtc    DATETIME2(3)   NULL,
    SecondApproverUserId BIGINT        NULL CONSTRAINT FK_RecordingDeletions_Second REFERENCES auth.Users (UserId),
    SecondApprovedUtc   DATETIME2(3)   NULL,
    DecidedByUserId     BIGINT         NULL CONSTRAINT FK_RecordingDeletions_DecidedBy REFERENCES auth.Users (UserId),
    DecidedUtc          DATETIME2(3)   NULL,
    ExecutedUtc         DATETIME2(3)   NULL,
    Notes               NVARCHAR(1000) NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT UQ_RecordingDeletions_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_RecordingDeletions_Source CHECK (Source IN ('RETENTION', 'MANUAL')),
    CONSTRAINT CK_RecordingDeletions_Status CHECK ([Status] IN ('PENDING', 'EXECUTED', 'REJECTED', 'CANCELLED', 'FAILED')),
    CONSTRAINT CK_RecordingDeletions_Approvals CHECK (RequiredApprovals BETWEEN 0 AND 2),
    -- Two-person rule: the second approver is never the first approver.
    CONSTRAINT CK_RecordingDeletions_TwoPeople CHECK (SecondApproverUserId IS NULL OR SecondApproverUserId <> FirstApproverUserId),
    CONSTRAINT CK_RecordingDeletions_Executed CHECK ([Status] <> 'EXECUTED' OR ExecutedUtc IS NOT NULL)
);
CREATE UNIQUE INDEX UX_RecordingDeletions_OnePending ON rec.RecordingDeletions (RecordingId) WHERE [Status] = 'PENDING';
GO

INSERT auth.Permissions (Code, Module, Description) VALUES
 ('recordings.policy.manage', 'Recordings', N'Edit recording policies (consent wording, retention, access) - every change is audited');
INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT (SELECT RoleId FROM auth.Roles WHERE Code = 'SuperAdmin'), (SELECT PermissionId FROM auth.Permissions WHERE Code = 'recordings.policy.manage');
GO
