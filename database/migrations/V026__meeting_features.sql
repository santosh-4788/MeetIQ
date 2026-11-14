-- V026: optional meeting features (13 Nov 2026, "Advanced AI & collaboration" request, Phase 3/4 browser-side features).
--   ADDITIVE ONLY: new tables, one new permission. No existing table, column, constraint or row is changed.
--   app.FeatureSettings      - one row per optional feature; every feature is seeded DISABLED. EMERGENCY_DISABLE switches all of
--                              them off at once without touching their individual settings. Existing meetings behave exactly as
--                              before while a feature is off (the room never shows its controls).
--   mtg.MeetingPolls / mtg.MeetingPollVotes - Yes/No polls (one vote per participant, enforced by the primary key).
--   mtg.PrivateMessages      - 1:1 messages between two participants of the same meeting (the API checks both ends).
--   mtg.MeetingWhiteboards   - the latest whiteboard scene per meeting (late joiners and reconnects load it) + who may draw.
--   features.manage          - Administration -> Meeting features (Admin, SuperAdmin).
--   Rollback: database/rollback/V026__meeting_features.rollback.sql (drops only what this script created).

CREATE TABLE app.FeatureSettings (
    FeatureKey        VARCHAR(40)    NOT NULL CONSTRAINT PK_FeatureSettings PRIMARY KEY,
    IsEnabled         BIT            NOT NULL CONSTRAINT DF_FeatureSettings_IsEnabled DEFAULT (0),
    ConfigJson        NVARCHAR(2000) NULL,
    ModifiedUtc       DATETIME2(3)   NOT NULL CONSTRAINT DF_FeatureSettings_ModifiedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedByUserId  BIGINT         NULL CONSTRAINT FK_FeatureSettings_User REFERENCES auth.Users (UserId)
);
GO

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT v.k, 0 FROM (VALUES ('EMERGENCY_DISABLE'), ('REACTIONS'), ('POLLS'), ('PRIVATE_CHAT'), ('WHITEBOARD'), ('BACKGROUND_EFFECTS'),
                           ('NOISE_SUPPRESSION'), ('CAMERA_FLIP')) v (k)
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings f WHERE f.FeatureKey = v.k);
GO

CREATE TABLE mtg.MeetingPolls (
    PollId                 BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingPolls PRIMARY KEY,
    PublicId               UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MeetingPolls_PublicId DEFAULT (NEWSEQUENTIALID()),
    MeetingId              BIGINT         NOT NULL CONSTRAINT FK_MeetingPolls_Meeting REFERENCES mtg.Meetings (MeetingId),
    Question               NVARCHAR(300)  NOT NULL,
    CreatedByParticipantId BIGINT         NOT NULL CONSTRAINT FK_MeetingPolls_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    CreatedUtc             DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingPolls_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ClosedUtc              DATETIME2(3)   NULL,
    CONSTRAINT UQ_MeetingPolls_PublicId UNIQUE (PublicId)
);
CREATE INDEX IX_MeetingPolls_Meeting ON mtg.MeetingPolls (MeetingId, PollId);
GO

CREATE TABLE mtg.MeetingPollVotes (
    PollId        BIGINT       NOT NULL CONSTRAINT FK_MeetingPollVotes_Poll REFERENCES mtg.MeetingPolls (PollId),
    ParticipantId BIGINT       NOT NULL CONSTRAINT FK_MeetingPollVotes_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    Answer        VARCHAR(3)   NOT NULL,
    VotedUtc      DATETIME2(3) NOT NULL CONSTRAINT DF_MeetingPollVotes_VotedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_MeetingPollVotes PRIMARY KEY (PollId, ParticipantId),
    CONSTRAINT CK_MeetingPollVotes_Answer CHECK (Answer IN ('YES', 'NO'))
);
GO

CREATE TABLE mtg.PrivateMessages (
    MessageId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PrivateMessages PRIMARY KEY,
    MeetingId              BIGINT         NOT NULL CONSTRAINT FK_PrivateMessages_Meeting REFERENCES mtg.Meetings (MeetingId),
    SenderParticipantId    BIGINT         NOT NULL CONSTRAINT FK_PrivateMessages_Sender REFERENCES mtg.MeetingParticipants (ParticipantId),
    RecipientParticipantId BIGINT         NOT NULL CONSTRAINT FK_PrivateMessages_Recipient REFERENCES mtg.MeetingParticipants (ParticipantId),
    Body                   NVARCHAR(2000) NOT NULL,
    SentUtc                DATETIME2(3)   NOT NULL CONSTRAINT DF_PrivateMessages_SentUtc DEFAULT (SYSUTCDATETIME()),
    ReadUtc                DATETIME2(3)   NULL,
    CONSTRAINT CK_PrivateMessages_NotSelf CHECK (SenderParticipantId <> RecipientParticipantId)
);
CREATE INDEX IX_PrivateMessages_Recipient ON mtg.PrivateMessages (MeetingId, RecipientParticipantId, MessageId);
CREATE INDEX IX_PrivateMessages_Sender ON mtg.PrivateMessages (MeetingId, SenderParticipantId, MessageId);
GO

CREATE TABLE mtg.MeetingWhiteboards (
    MeetingId              BIGINT         NOT NULL CONSTRAINT PK_MeetingWhiteboards PRIMARY KEY
                                          CONSTRAINT FK_MeetingWhiteboards_Meeting REFERENCES mtg.Meetings (MeetingId),
    IsOpen                 BIT            NOT NULL CONSTRAINT DF_MeetingWhiteboards_IsOpen DEFAULT (0),
    DrawMode               VARCHAR(10)    NOT NULL CONSTRAINT DF_MeetingWhiteboards_DrawMode DEFAULT ('HOSTS'),
    AllowedJson            NVARCHAR(4000) NULL,
    SceneJson              NVARCHAR(MAX)  NULL,
    [Version]              INT            NOT NULL CONSTRAINT DF_MeetingWhiteboards_Version DEFAULT (0),
    UpdatedUtc             DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingWhiteboards_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedByParticipantId BIGINT         NULL CONSTRAINT FK_MeetingWhiteboards_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    CONSTRAINT CK_MeetingWhiteboards_DrawMode CHECK (DrawMode IN ('HOSTS', 'EVERYONE', 'SELECTED'))
);
GO

INSERT auth.Permissions (Code, Module, Description)
SELECT 'features.manage', 'System', N'Switch optional meeting features (reactions, polls, private chat, whiteboard, background effects, noise suppression) on or off, including the emergency switch'
WHERE NOT EXISTS (SELECT 1 FROM auth.Permissions WHERE Code = 'features.manage');
GO

INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r JOIN auth.Permissions p ON r.Code IN ('Admin', 'SuperAdmin') AND p.Code = 'features.manage'
WHERE NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V026',
    N'Migration V026: optional meeting features (all disabled), polls, private messages, whiteboards, permission features.manage',
    N'{"tables":["app.FeatureSettings","mtg.MeetingPolls","mtg.MeetingPollVotes","mtg.PrivateMessages","mtg.MeetingWhiteboards"],"permissions":["features.manage"]}');
