-- V007: platform tables (app; called `sys` in DATABASE_DESIGN.md v1, see V001).

CREATE TABLE app.SystemSettings (
    SettingKey          VARCHAR(100)   NOT NULL CONSTRAINT PK_SystemSettings PRIMARY KEY,
    SettingValue        NVARCHAR(MAX)  NULL,
    ValueType           VARCHAR(20)    NOT NULL,
    IsSecret            BIT            NOT NULL CONSTRAINT DF_SystemSettings_IsSecret DEFAULT (0),
    Category            VARCHAR(50)    NOT NULL,
    Description         NVARCHAR(400)  NULL,
    ModifiedUtc         DATETIME2(3)   NOT NULL CONSTRAINT DF_SystemSettings_ModifiedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_SystemSettings_ValueType CHECK (ValueType IN ('STRING', 'INT', 'BOOL', 'DECIMAL', 'JSON')),
    CONSTRAINT CK_SystemSettings_Json CHECK (ValueType <> 'JSON' OR SettingValue IS NULL OR ISJSON(SettingValue) = 1)
);

CREATE TABLE app.EmailOutbox (
    OutboxId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_EmailOutbox PRIMARY KEY,
    Template            VARCHAR(50)    NOT NULL,
    ToAddress           NVARCHAR(254)  NOT NULL,
    Subject             NVARCHAR(300)  NOT NULL,
    BodyHtml            NVARCHAR(MAX)  NOT NULL,
    RelatedMeetingId    BIGINT         NULL CONSTRAINT FK_EmailOutbox_Meeting REFERENCES mtg.Meetings (MeetingId),
    RelatedReminderId   BIGINT         NULL CONSTRAINT FK_EmailOutbox_Reminder REFERENCES mtg.MeetingReminders (ReminderId),
    [Status]            VARCHAR(30)    NOT NULL CONSTRAINT DF_EmailOutbox_Status DEFAULT ('PENDING'),
    Attempts            INT            NOT NULL CONSTRAINT DF_EmailOutbox_Attempts DEFAULT (0),
    NextAttemptUtc      DATETIME2(3)   NULL,
    LeaseOwner          VARCHAR(100)   NULL,
    LeaseExpiresUtc     DATETIME2(3)   NULL,
    SentUtc             DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_EmailOutbox_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_EmailOutbox_Status CHECK ([Status] IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'CANCELLED')),
    CONSTRAINT CK_EmailOutbox_Attempts CHECK (Attempts >= 0)
);
CREATE INDEX IX_EmailOutbox_Due ON app.EmailOutbox ([Status], NextAttemptUtc) WHERE [Status] IN ('PENDING', 'FAILED');
-- At most one e-mail per reminder row (the reminder dedupe key then covers e-mail too).
CREATE UNIQUE INDEX UX_EmailOutbox_Reminder ON app.EmailOutbox (RelatedReminderId) WHERE RelatedReminderId IS NOT NULL;

CREATE TABLE app.EmailDeliveryLog (
    DeliveryId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_EmailDeliveryLog PRIMARY KEY,
    OutboxId            BIGINT         NOT NULL CONSTRAINT FK_EmailDeliveryLog_Outbox REFERENCES app.EmailOutbox (OutboxId),
    AttemptNo           INT            NOT NULL,
    AttemptUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_EmailDeliveryLog_AttemptUtc DEFAULT (SYSUTCDATETIME()),
    Succeeded           BIT            NOT NULL,
    SmtpResponse        NVARCHAR(500)  NULL,
    ErrorMessage        NVARCHAR(1000) NULL,
    DurationMs          INT            NULL,
    CONSTRAINT UQ_EmailDeliveryLog_Attempt UNIQUE (OutboxId, AttemptNo)
);

CREATE TABLE app.BackgroundJobLog (
    JobRunId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_BackgroundJobLog PRIMARY KEY,
    JobName             VARCHAR(100)   NOT NULL,
    Instance            VARCHAR(100)   NOT NULL,
    StartedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_BackgroundJobLog_StartedUtc DEFAULT (SYSUTCDATETIME()),
    FinishedUtc         DATETIME2(3)   NULL,
    [Status]            VARCHAR(30)    NOT NULL CONSTRAINT DF_BackgroundJobLog_Status DEFAULT ('RUNNING'),
    ItemsProcessed      INT            NOT NULL CONSTRAINT DF_BackgroundJobLog_ItemsProcessed DEFAULT (0),
    ErrorMessage        NVARCHAR(2000) NULL,
    CONSTRAINT CK_BackgroundJobLog_Status CHECK ([Status] IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
);
CREATE INDEX IX_BackgroundJobLog_Job ON app.BackgroundJobLog (JobName, StartedUtc DESC);

CREATE TABLE app.WebhookEvents (
    EventId             VARCHAR(100)   NOT NULL CONSTRAINT PK_WebhookEvents PRIMARY KEY,
    Source              VARCHAR(30)    NOT NULL,
    EventType           VARCHAR(50)    NOT NULL,
    ReceivedUtc         DATETIME2(3)   NOT NULL CONSTRAINT DF_WebhookEvents_ReceivedUtc DEFAULT (SYSUTCDATETIME()),
    PayloadJson         NVARCHAR(MAX)  NOT NULL,
    SignatureValid      BIT            NOT NULL,
    ProcessedUtc        DATETIME2(3)   NULL,
    ProcessingError     NVARCHAR(1000) NULL,
    Attempts            INT            NOT NULL CONSTRAINT DF_WebhookEvents_Attempts DEFAULT (0),
    CONSTRAINT CK_WebhookEvents_Json CHECK (ISJSON(PayloadJson) = 1)
);
CREATE INDEX IX_WebhookEvents_Unprocessed ON app.WebhookEvents (ReceivedUtc) WHERE ProcessedUtc IS NULL;

-- Append-only. Double-booking overrides and other privileged actions always land here.
CREATE TABLE app.AuditLog (
    AuditId             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AuditLog PRIMARY KEY,
    Utc                 DATETIME2(3)   NOT NULL CONSTRAINT DF_AuditLog_Utc DEFAULT (SYSUTCDATETIME()),
    ActorUserId         BIGINT         NULL CONSTRAINT FK_AuditLog_Actor REFERENCES auth.Users (UserId),
    ActorType           VARCHAR(30)    NOT NULL,
    [Action]            VARCHAR(100)   NOT NULL,
    EntityType          VARCHAR(50)    NOT NULL,
    EntityId            VARCHAR(64)    NULL,
    Summary             NVARCHAR(500)  NULL,
    OldValuesJson       NVARCHAR(MAX)  NULL,
    NewValuesJson       NVARCHAR(MAX)  NULL,
    IpAddress           VARCHAR(45)    NULL,
    CorrelationId       VARCHAR(64)    NULL,
    IsPrivileged        BIT            NOT NULL CONSTRAINT DF_AuditLog_IsPrivileged DEFAULT (0),
    CONSTRAINT CK_AuditLog_ActorType CHECK (ActorType IN ('USER', 'CUSTOMER', 'SYSTEM')),
    CONSTRAINT CK_AuditLog_UserActor CHECK (ActorType <> 'USER' OR ActorUserId IS NOT NULL),
    CONSTRAINT CK_AuditLog_Json CHECK ((OldValuesJson IS NULL OR ISJSON(OldValuesJson) = 1) AND (NewValuesJson IS NULL OR ISJSON(NewValuesJson) = 1))
);
CREATE INDEX IX_AuditLog_Entity ON app.AuditLog (EntityType, EntityId, Utc);
CREATE INDEX IX_AuditLog_Actor ON app.AuditLog (ActorUserId, Utc);
GO

CREATE TRIGGER app.trg_AuditLog_AppendOnly ON app.AuditLog AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51002, 'app.AuditLog is append-only.', 1;
END;
GO
