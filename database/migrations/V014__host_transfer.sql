-- V014: host transfer (Phase 1 of the feature-gap implementation plan).
-- A host can hand host privileges to another employee participant mid-meeting. mtg.HostTransfers is the audit
-- trail requested by the spec: previous host, new host, meeting id, timestamp. Transferring host to a guest or
-- customer stays impossible (CK_MeetingParticipants_HostIsEmployee, unchanged).

CREATE TABLE mtg.HostTransfers (
    TransferId                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_HostTransfers PRIMARY KEY,
    MeetingId                   BIGINT       NOT NULL CONSTRAINT FK_HostTransfers_Meeting REFERENCES mtg.Meetings (MeetingId),
    PreviousHostParticipantId   BIGINT       NOT NULL CONSTRAINT FK_HostTransfers_PreviousHost REFERENCES mtg.MeetingParticipants (ParticipantId),
    NewHostParticipantId        BIGINT       NOT NULL CONSTRAINT FK_HostTransfers_NewHost REFERENCES mtg.MeetingParticipants (ParticipantId),
    TransferredByUserId         BIGINT       NULL CONSTRAINT FK_HostTransfers_TransferredBy REFERENCES auth.Users (UserId),
    TransferredUtc               DATETIME2(3) NOT NULL CONSTRAINT DF_HostTransfers_TransferredUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_HostTransfers_NotSelf CHECK (PreviousHostParticipantId <> NewHostParticipantId)
);
CREATE INDEX IX_HostTransfers_Meeting ON mtg.HostTransfers (MeetingId, TransferredUtc);
GO
