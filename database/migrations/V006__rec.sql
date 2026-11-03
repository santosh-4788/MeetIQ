-- V006: recording (rec). Recordings belong to the meeting creator; COMPLETED requires verification.

CREATE TABLE rec.MeetingRecordings (
    RecordingId         BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingRecordings PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MeetingRecordings_PublicId DEFAULT (NEWSEQUENTIALID()),
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingRecordings_Meeting REFERENCES mtg.Meetings (MeetingId),
    OwnerEmployeeId     BIGINT         NOT NULL CONSTRAINT FK_MeetingRecordings_Owner REFERENCES org.Employees (EmployeeId),
    CustomerId          BIGINT         NULL CONSTRAINT FK_MeetingRecordings_Customer REFERENCES crm.Customers (CustomerId),
    [Status]            VARCHAR(30)    NOT NULL CONSTRAINT DF_MeetingRecordings_Status DEFAULT ('PENDING'),
    StartedUtc          DATETIME2(3)   NULL,
    EndedUtc            DATETIME2(3)   NULL,
    DurationSeconds     INT            NULL,
    FileSizeBytes       BIGINT         NULL,
    StorageKey          NVARCHAR(400)  NULL,
    Sha256              BINARY(32)     NULL,
    Container           VARCHAR(20)    NULL,
    VideoCodec          VARCHAR(20)    NULL,
    AudioCodec          VARCHAR(20)    NULL,
    Width               INT            NULL,
    Height              INT            NULL,
    VerifiedUtc         DATETIME2(3)   NULL,
    VerificationDetails NVARCHAR(MAX)  NULL,
    IsEncrypted         BIT            NOT NULL CONSTRAINT DF_MeetingRecordings_IsEncrypted DEFAULT (0),
    KeyId               VARCHAR(100)   NULL,
    RetainUntilUtc      DATETIME2(3)   NULL,
    LegalHold           BIT            NOT NULL CONSTRAINT DF_MeetingRecordings_LegalHold DEFAULT (0),
    FailureReason       NVARCHAR(1000) NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingRecordings_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT UQ_MeetingRecordings_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_MeetingRecordings_Status CHECK ([Status] IN ('PENDING', 'RECORDING', 'PROCESSING', 'VERIFYING', 'COMPLETED', 'FAILED', 'PURGED')),
    CONSTRAINT CK_MeetingRecordings_CompletedIsVerified CHECK ([Status] <> 'COMPLETED' OR (VerifiedUtc IS NOT NULL AND Sha256 IS NOT NULL AND StorageKey IS NOT NULL AND FileSizeBytes > 0)),
    CONSTRAINT CK_MeetingRecordings_FailedHasReason CHECK ([Status] <> 'FAILED' OR FailureReason IS NOT NULL),
    CONSTRAINT CK_MeetingRecordings_VerificationJson CHECK (VerificationDetails IS NULL OR ISJSON(VerificationDetails) = 1),
    CONSTRAINT CK_MeetingRecordings_Encryption CHECK (IsEncrypted = 0 OR KeyId IS NOT NULL),
    -- StorageKey is a relative path; it must not escape the recordings root.
    CONSTRAINT CK_MeetingRecordings_StorageKey CHECK (StorageKey IS NULL OR (StorageKey NOT LIKE '%..%' AND StorageKey NOT LIKE '[\/]%' AND StorageKey NOT LIKE '_:%'))
);
CREATE UNIQUE INDEX UX_MeetingRecordings_StorageKey ON rec.MeetingRecordings (StorageKey) WHERE StorageKey IS NOT NULL;
CREATE INDEX IX_MeetingRecordings_Owner_Status ON rec.MeetingRecordings (OwnerEmployeeId, [Status]);
CREATE INDEX IX_MeetingRecordings_Meeting ON rec.MeetingRecordings (MeetingId);
GO

CREATE TRIGGER rec.trg_MeetingRecordings_Owner ON rec.MeetingRecordings AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.RecordingId = i.RecordingId
               WHERE i.OwnerEmployeeId <> d.OwnerEmployeeId OR i.MeetingId <> d.MeetingId)
        THROW 51003, 'MeetingRecordings.OwnerEmployeeId and MeetingId are immutable.', 1;
    IF EXISTS (SELECT 1 FROM inserted i JOIN mtg.Meetings m ON m.MeetingId = i.MeetingId
               WHERE i.OwnerEmployeeId <> m.CreatedByEmployeeId)
        THROW 51004, 'MeetingRecordings.OwnerEmployeeId must equal Meetings.CreatedByEmployeeId.', 1;
END;
GO

CREATE TABLE rec.RecordingJobs (
    JobId               BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RecordingJobs PRIMARY KEY,
    RecordingId         BIGINT         NOT NULL CONSTRAINT FK_RecordingJobs_Recording REFERENCES rec.MeetingRecordings (RecordingId),
    IdempotencyKey      VARCHAR(100)   NOT NULL CONSTRAINT UQ_RecordingJobs_IdempotencyKey UNIQUE,
    Engine              VARCHAR(30)    NOT NULL,
    EngineJobId         VARCHAR(100)   NULL,
    [State]             VARCHAR(30)    NOT NULL CONSTRAINT DF_RecordingJobs_State DEFAULT ('QUEUED'),
    Attempt             INT            NOT NULL CONSTRAINT DF_RecordingJobs_Attempt DEFAULT (0),
    LeaseOwner          VARCHAR(100)   NULL,
    LeaseExpiresUtc     DATETIME2(3)   NULL,
    HeartbeatUtc        DATETIME2(3)   NULL,
    LastError           NVARCHAR(2000) NULL,
    SpoolPath           NVARCHAR(400)  NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_RecordingJobs_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedUtc         DATETIME2(3)   NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_RecordingJobs_Engine CHECK (Engine IN ('R2_CHROMIUM', 'R1_EGRESS')),
    CONSTRAINT CK_RecordingJobs_State CHECK ([State] IN ('QUEUED', 'STARTING', 'ACTIVE', 'STOPPING', 'POST_PROCESSING', 'DONE', 'FAILED')),
    CONSTRAINT CK_RecordingJobs_Attempt CHECK (Attempt >= 0)
);
CREATE INDEX IX_RecordingJobs_State_Lease ON rec.RecordingJobs ([State], LeaseExpiresUtc);
CREATE INDEX IX_RecordingJobs_Recording ON rec.RecordingJobs (RecordingId);

-- Append-only.
CREATE TABLE rec.RecordingAccessLog (
    AccessId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RecordingAccessLog PRIMARY KEY,
    RecordingId         BIGINT         NOT NULL CONSTRAINT FK_RecordingAccessLog_Recording REFERENCES rec.MeetingRecordings (RecordingId),
    UserId              BIGINT         NOT NULL CONSTRAINT FK_RecordingAccessLog_User REFERENCES auth.Users (UserId),
    [Action]            VARCHAR(30)    NOT NULL,
    Utc                 DATETIME2(3)   NOT NULL CONSTRAINT DF_RecordingAccessLog_Utc DEFAULT (SYSUTCDATETIME()),
    IpAddress           VARCHAR(45)    NULL,
    UserAgent           NVARCHAR(512)  NULL,
    SignedUrlExpiresUtc DATETIME2(3)   NULL,
    CONSTRAINT CK_RecordingAccessLog_Action CHECK ([Action] IN ('VIEW_DETAILS', 'PLAY', 'DOWNLOAD', 'DENIED'))
);
CREATE INDEX IX_RecordingAccessLog_Recording ON rec.RecordingAccessLog (RecordingId, Utc);
CREATE INDEX IX_RecordingAccessLog_User ON rec.RecordingAccessLog (UserId, Utc);
GO

CREATE TRIGGER rec.trg_RecordingAccessLog_AppendOnly ON rec.RecordingAccessLog AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51002, 'rec.RecordingAccessLog is append-only.', 1;
END;
GO
