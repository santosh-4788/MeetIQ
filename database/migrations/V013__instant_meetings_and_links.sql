-- V013: instant meetings and shareable meeting links (Advanced features, Phase B).
-- 1. mtg.Meetings.MeetingKind: SCHEDULED (calendar) or INSTANT (started at once, no invitations). Existing rows: SCHEDULED.
-- 2. mtg.Meetings.IsAudioOnly: nobody may publish a camera (enforced in the LiveKit token).
-- 3. mtg.MeetingParticipants: JoinSource (INVITED by the organiser, or joined through the shared LINK),
--    AdmissionRequired (must be admitted from the waiting room even when the meeting's waiting room is off),
--    IsBlocked (removed by a host and not allowed back).
-- 4. mtg.MeetingLinks: the shareable link of a meeting. Only the SHA-256 identifies it; TokenProtected is the raw link
--    encrypted with ASP.NET Core Data Protection, so the host can copy the same link again. One active link per meeting.

ALTER TABLE mtg.Meetings ADD
    MeetingKind     VARCHAR(20)  NOT NULL CONSTRAINT DF_Meetings_MeetingKind DEFAULT ('SCHEDULED'),
    IsAudioOnly     BIT          NOT NULL CONSTRAINT DF_Meetings_IsAudioOnly DEFAULT (0);
GO
ALTER TABLE mtg.Meetings ADD CONSTRAINT CK_Meetings_MeetingKind CHECK (MeetingKind IN ('SCHEDULED', 'INSTANT'));
GO

ALTER TABLE mtg.MeetingParticipants ADD
    JoinSource          VARCHAR(20)  NOT NULL CONSTRAINT DF_MeetingParticipants_JoinSource DEFAULT ('INVITED'),
    AdmissionRequired   BIT          NOT NULL CONSTRAINT DF_MeetingParticipants_AdmissionRequired DEFAULT (0),
    IsBlocked           BIT          NOT NULL CONSTRAINT DF_MeetingParticipants_IsBlocked DEFAULT (0),
    BlockedUtc          DATETIME2(3) NULL,
    BlockedByEmployeeId BIGINT       NULL CONSTRAINT FK_MeetingParticipants_BlockedBy REFERENCES org.Employees (EmployeeId);
GO
ALTER TABLE mtg.MeetingParticipants ADD
    CONSTRAINT CK_MeetingParticipants_JoinSource CHECK (JoinSource IN ('INVITED', 'LINK')),
    CONSTRAINT CK_MeetingParticipants_Blocked CHECK (IsBlocked = 0 OR BlockedUtc IS NOT NULL);
GO
CREATE INDEX IX_MeetingParticipants_JoinSource ON mtg.MeetingParticipants (MeetingId, JoinSource);
GO

CREATE TABLE mtg.MeetingLinks (
    LinkId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingLinks PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingLinks_Meeting REFERENCES mtg.Meetings (MeetingId),
    TokenHash           BINARY(32)     NOT NULL CONSTRAINT UQ_MeetingLinks_TokenHash UNIQUE,
    TokenProtected      NVARCHAR(1000) NOT NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingLinks_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL CONSTRAINT FK_MeetingLinks_CreatedBy REFERENCES auth.Users (UserId),
    ExpiresUtc          DATETIME2(3)   NOT NULL,
    RevokedUtc          DATETIME2(3)   NULL,
    RevokedByUserId     BIGINT         NULL CONSTRAINT FK_MeetingLinks_RevokedBy REFERENCES auth.Users (UserId),
    UseCount            INT            NOT NULL CONSTRAINT DF_MeetingLinks_UseCount DEFAULT (0),
    LastUsedUtc         DATETIME2(3)   NULL,
    CONSTRAINT CK_MeetingLinks_Expiry CHECK (ExpiresUtc > CreatedUtc),
    CONSTRAINT CK_MeetingLinks_Uses CHECK (UseCount >= 0)
);
CREATE UNIQUE INDEX UX_MeetingLinks_Active ON mtg.MeetingLinks (MeetingId) WHERE RevokedUtc IS NULL;
GO
