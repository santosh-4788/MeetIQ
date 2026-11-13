-- V020: recording consent requests (12 Nov 2026) - "Fix recording consent notifications".
--   A host who starts recording in a live meeting whose policy needs consent from everyone now opens a CONSENT REQUEST
--   instead of a one-off "please answer" message. The request is stored, so every participant's screen (including people who
--   join or reconnect while it is pending, and guests) reads it from the server and shows the Accept / Decline popup; the
--   host sees each person's status; recording starts (existing R2 recorder, unchanged) only when every participant in the
--   request has accepted; one Decline closes it.
--   Additive only: no existing table, column or procedure changes. The consent EVIDENCE stays in mtg.MeetingConsent
--   (append-only, unchanged); rec.RecordingRequestParticipants only links each person's answer to the request (ConsentId).
--   Rollback: DROP TABLE rec.RecordingRequestParticipants; DROP TABLE rec.RecordingRequests; and delete the V020 row from
--   dbo.SchemaMigrations (only after rolling the API back to a build without consent requests).

CREATE TABLE rec.RecordingRequests (
    RequestId                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RecordingRequests PRIMARY KEY,
    PublicId                 UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_RecordingRequests_PublicId DEFAULT (NEWSEQUENTIALID()),
    MeetingId                BIGINT         NOT NULL CONSTRAINT FK_RecordingRequests_Meeting REFERENCES mtg.Meetings (MeetingId),
    RequestedByParticipantId BIGINT         NOT NULL CONSTRAINT FK_RecordingRequests_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    RequestedByUserId        BIGINT         NULL CONSTRAINT FK_RecordingRequests_User REFERENCES auth.Users (UserId),
    PolicyCode               VARCHAR(40)    NOT NULL,
    NoticeVersion            VARCHAR(30)    NOT NULL,
    [Status]                 VARCHAR(20)    NOT NULL CONSTRAINT DF_RecordingRequests_Status DEFAULT ('OPEN'),
    CreatedUtc               DATETIME2(3)   NOT NULL CONSTRAINT DF_RecordingRequests_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ExpiresUtc               DATETIME2(3)   NOT NULL,
    ClosedUtc                DATETIME2(3)   NULL,
    CloseReason              NVARCHAR(400)  NULL,
    RecordingId              BIGINT         NULL CONSTRAINT FK_RecordingRequests_Recording REFERENCES rec.MeetingRecordings (RecordingId),
    CONSTRAINT UQ_RecordingRequests_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_RecordingRequests_Status CHECK ([Status] IN ('OPEN', 'STARTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED')),
    CONSTRAINT CK_RecordingRequests_Closed CHECK (([Status] = 'OPEN' AND ClosedUtc IS NULL) OR ([Status] <> 'OPEN' AND ClosedUtc IS NOT NULL))
);
-- At most one pending request per meeting (a second Start while one is pending returns the same request).
CREATE UNIQUE INDEX UX_RecordingRequests_OneOpen ON rec.RecordingRequests (MeetingId) WHERE [Status] = 'OPEN';
CREATE INDEX IX_RecordingRequests_Meeting ON rec.RecordingRequests (MeetingId, RequestId DESC);
GO

-- Who must answer the request: everyone in the room when it was opened, plus anyone who joins while it is pending. A person
-- who disconnects stays in the set (shown as Disconnected) and is never treated as having accepted.
CREATE TABLE rec.RecordingRequestParticipants (
    RequestId     BIGINT        NOT NULL CONSTRAINT FK_RecordingRequestParticipants_Request REFERENCES rec.RecordingRequests (RequestId),
    ParticipantId BIGINT        NOT NULL CONSTRAINT FK_RecordingRequestParticipants_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    AddedUtc      DATETIME2(3)  NOT NULL CONSTRAINT DF_RecordingRequestParticipants_AddedUtc DEFAULT (SYSUTCDATETIME()),
    Decision      VARCHAR(20)   NULL,
    DecisionUtc   DATETIME2(3)  NULL,
    ConsentId     BIGINT        NULL CONSTRAINT FK_RecordingRequestParticipants_Consent REFERENCES mtg.MeetingConsent (ConsentId),
    CONSTRAINT PK_RecordingRequestParticipants PRIMARY KEY (RequestId, ParticipantId),
    CONSTRAINT CK_RecordingRequestParticipants_Decision CHECK (Decision IS NULL OR Decision IN ('GRANTED', 'DENIED'))
);
GO
