-- V005: meetings, calendar, consent, reminders and notifications (mtg).

CREATE TABLE mtg.Meetings (
    MeetingId               BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Meetings PRIMARY KEY,
    PublicId                UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Meetings_PublicId DEFAULT (NEWSEQUENTIALID()),
    MeetingCode             VARCHAR(20)    NOT NULL CONSTRAINT UQ_Meetings_MeetingCode UNIQUE,
    Title                   NVARCHAR(200)  NOT NULL,
    Description             NVARCHAR(2000) NULL,
    Agenda                  NVARCHAR(4000) NULL,
    Category                VARCHAR(30)    NOT NULL,
    CreatedByEmployeeId     BIGINT         NOT NULL CONSTRAINT FK_Meetings_CreatedBy REFERENCES org.Employees (EmployeeId),
    HostEmployeeId          BIGINT         NOT NULL CONSTRAINT FK_Meetings_Host REFERENCES org.Employees (EmployeeId),
    DepartmentId            BIGINT         NULL CONSTRAINT FK_Meetings_Department REFERENCES org.Departments (DepartmentId),
    CustomerId              BIGINT         NULL CONSTRAINT FK_Meetings_Customer REFERENCES crm.Customers (CustomerId),
    PolicyNumber            VARCHAR(50)    NULL,
    Purpose                 NVARCHAR(200)  NULL,
    ScheduledStartUtc       DATETIME2(3)   NOT NULL,
    ScheduledEndUtc         DATETIME2(3)   NOT NULL,
    TimeZoneId              VARCHAR(64)    NOT NULL CONSTRAINT DF_Meetings_TimeZoneId DEFAULT ('Asia/Kolkata'),
    ActualStartUtc          DATETIME2(3)   NULL,
    ActualEndUtc            DATETIME2(3)   NULL,
    [Status]                VARCHAR(30)    NOT NULL CONSTRAINT DF_Meetings_Status DEFAULT ('SCHEDULED'),
    RecordingPolicy         VARCHAR(30)    NOT NULL CONSTRAINT DF_Meetings_RecordingPolicy DEFAULT ('NONE'),
    WaitingRoomEnabled      BIT            NOT NULL CONSTRAINT DF_Meetings_WaitingRoomEnabled DEFAULT (1),
    IsLocked                BIT            NOT NULL CONSTRAINT DF_Meetings_IsLocked DEFAULT (0),
    LiveKitRoomName         VARCHAR(64)    NOT NULL CONSTRAINT UQ_Meetings_LiveKitRoomName UNIQUE,
    ScheduleVersion         INT            NOT NULL CONSTRAINT DF_Meetings_ScheduleVersion DEFAULT (1),
    CancelReason            NVARCHAR(500)  NULL,
    OverrideConflictReason  NVARCHAR(500)  NULL,
    CreatedUtc              DATETIME2(3)   NOT NULL CONSTRAINT DF_Meetings_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId         BIGINT         NULL,
    ModifiedUtc             DATETIME2(3)   NULL,
    ModifiedByUserId        BIGINT         NULL,
    RowVersion              ROWVERSION     NOT NULL,
    CONSTRAINT UQ_Meetings_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_Meetings_Category CHECK (Category IN ('INTERNAL_1_1', 'GROUP', 'TEAM', 'DEPARTMENT', 'MANAGEMENT', 'TRAINING', 'REVIEW', 'CUSTOMER_PLVC', 'CUSTOMER_GENERAL')),
    CONSTRAINT CK_Meetings_Status CHECK ([Status] IN ('DRAFT', 'SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'INCOMPLETE')),
    CONSTRAINT CK_Meetings_RecordingPolicy CHECK (RecordingPolicy IN ('NONE', 'OPTIONAL', 'REQUIRED')),
    CONSTRAINT CK_Meetings_Schedule CHECK (ScheduledEndUtc > ScheduledStartUtc),
    CONSTRAINT CK_Meetings_Actual CHECK (ActualEndUtc IS NULL OR ActualStartUtc IS NULL OR ActualEndUtc >= ActualStartUtc),
    CONSTRAINT CK_Meetings_CustomerRequired CHECK (Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') OR CustomerId IS NOT NULL),
    CONSTRAINT CK_Meetings_ScheduleVersion CHECK (ScheduleVersion >= 1)
);
CREATE INDEX IX_Meetings_Host_Start ON mtg.Meetings (HostEmployeeId, ScheduledStartUtc) INCLUDE ([Status], ScheduledEndUtc);
CREATE INDEX IX_Meetings_Status_Start ON mtg.Meetings ([Status], ScheduledStartUtc);
CREATE INDEX IX_Meetings_CreatedBy_Start ON mtg.Meetings (CreatedByEmployeeId, ScheduledStartUtc);
CREATE INDEX IX_Meetings_Customer ON mtg.Meetings (CustomerId) WHERE CustomerId IS NOT NULL;
GO

-- The creator is the permanent owner of the meeting and of its recordings (employee-wise recording management).
CREATE TRIGGER mtg.trg_Meetings_OwnerImmutable ON mtg.Meetings AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF UPDATE(CreatedByEmployeeId)
       AND EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.MeetingId = i.MeetingId
                   WHERE i.CreatedByEmployeeId <> d.CreatedByEmployeeId)
        THROW 51001, 'Meetings.CreatedByEmployeeId is immutable.', 1;
END;
GO

CREATE TABLE mtg.MeetingParticipants (
    ParticipantId       BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingParticipants PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingParticipants_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantType     VARCHAR(30)    NOT NULL,
    EmployeeId          BIGINT         NULL CONSTRAINT FK_MeetingParticipants_Employee REFERENCES org.Employees (EmployeeId),
    CustomerId          BIGINT         NULL CONSTRAINT FK_MeetingParticipants_Customer REFERENCES crm.Customers (CustomerId),
    GuestName           NVARCHAR(200)  NULL,
    GuestEmail          NVARCHAR(254)  NULL,
    [Role]              VARCHAR(30)    NOT NULL CONSTRAINT DF_MeetingParticipants_Role DEFAULT ('ATTENDEE'),
    ResponseStatus      VARCHAR(30)    NOT NULL CONSTRAINT DF_MeetingParticipants_ResponseStatus DEFAULT ('PENDING'),
    IsRequired          BIT            NOT NULL CONSTRAINT DF_MeetingParticipants_IsRequired DEFAULT (1),
    LiveKitIdentity     VARCHAR(64)    NOT NULL,
    CanPublish          BIT            NOT NULL CONSTRAINT DF_MeetingParticipants_CanPublish DEFAULT (1),
    CanScreenShare      BIT            NOT NULL CONSTRAINT DF_MeetingParticipants_CanScreenShare DEFAULT (0),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingParticipants_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT UQ_MeetingParticipants_Identity UNIQUE (MeetingId, LiveKitIdentity),
    CONSTRAINT CK_MeetingParticipants_Type CHECK (
        (ParticipantType = 'EMPLOYEE' AND EmployeeId IS NOT NULL AND CustomerId IS NULL)
     OR (ParticipantType = 'CUSTOMER' AND CustomerId IS NOT NULL AND EmployeeId IS NULL)
     OR (ParticipantType = 'GUEST' AND EmployeeId IS NULL AND CustomerId IS NULL AND GuestName IS NOT NULL)),
    CONSTRAINT CK_MeetingParticipants_Role CHECK ([Role] IN ('HOST', 'COHOST', 'ATTENDEE')),
    CONSTRAINT CK_MeetingParticipants_Response CHECK (ResponseStatus IN ('PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE')),
    -- Only employees can host or co-host.
    CONSTRAINT CK_MeetingParticipants_HostIsEmployee CHECK ([Role] = 'ATTENDEE' OR ParticipantType = 'EMPLOYEE')
);
CREATE UNIQUE INDEX UX_MeetingParticipants_Employee ON mtg.MeetingParticipants (MeetingId, EmployeeId) WHERE EmployeeId IS NOT NULL;
CREATE INDEX IX_MeetingParticipants_Employee_Meeting ON mtg.MeetingParticipants (EmployeeId, MeetingId) INCLUDE (ResponseStatus) WHERE EmployeeId IS NOT NULL;

CREATE TABLE mtg.MeetingInvitations (
    InvitationId        BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingInvitations PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingInvitations_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantId       BIGINT         NOT NULL CONSTRAINT FK_MeetingInvitations_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    TokenHash           BINARY(32)     NOT NULL CONSTRAINT UQ_MeetingInvitations_TokenHash UNIQUE,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingInvitations_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ExpiresUtc          DATETIME2(3)   NOT NULL,
    RevokedUtc          DATETIME2(3)   NULL,
    RevokeReason        NVARCHAR(200)  NULL,
    UseCount            INT            NOT NULL CONSTRAINT DF_MeetingInvitations_UseCount DEFAULT (0),
    MaxUses             INT            NULL,
    LastUsedUtc         DATETIME2(3)   NULL,
    OtpRequired         BIT            NOT NULL CONSTRAINT DF_MeetingInvitations_OtpRequired DEFAULT (0),
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_MeetingInvitations_Expiry CHECK (ExpiresUtc > CreatedUtc),
    CONSTRAINT CK_MeetingInvitations_Uses CHECK (UseCount >= 0 AND (MaxUses IS NULL OR (MaxUses > 0 AND UseCount <= MaxUses)))
);
CREATE INDEX IX_MeetingInvitations_Participant ON mtg.MeetingInvitations (ParticipantId);

CREATE TABLE mtg.MeetingReminders (
    ReminderId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingReminders PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingReminders_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantId       BIGINT         NOT NULL CONSTRAINT FK_MeetingReminders_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    OffsetMinutes       INT            NOT NULL,
    Channel             VARCHAR(30)    NOT NULL,
    DueUtc              DATETIME2(3)   NOT NULL,
    ScheduleVersion     INT            NOT NULL,
    [Status]            VARCHAR(30)    NOT NULL CONSTRAINT DF_MeetingReminders_Status DEFAULT ('PENDING'),
    Attempts            INT            NOT NULL CONSTRAINT DF_MeetingReminders_Attempts DEFAULT (0),
    NextAttemptUtc      DATETIME2(3)   NULL,
    LeaseOwner          VARCHAR(100)   NULL,
    LeaseExpiresUtc     DATETIME2(3)   NULL,
    LastError           NVARCHAR(1000) NULL,
    SentUtc             DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingReminders_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    RowVersion          ROWVERSION     NOT NULL,
    -- One reminder per recipient, offset, channel and schedule version: duplicates are impossible.
    CONSTRAINT UQ_MeetingReminders_Dedupe UNIQUE (MeetingId, ParticipantId, OffsetMinutes, Channel, ScheduleVersion),
    CONSTRAINT CK_MeetingReminders_Offset CHECK (OffsetMinutes >= 0),
    CONSTRAINT CK_MeetingReminders_Channel CHECK (Channel IN ('IN_APP', 'EMAIL', 'BROWSER')),
    CONSTRAINT CK_MeetingReminders_Status CHECK ([Status] IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'CANCELLED')),
    CONSTRAINT CK_MeetingReminders_Attempts CHECK (Attempts >= 0)
);
CREATE INDEX IX_MeetingReminders_Due ON mtg.MeetingReminders ([Status], DueUtc) WHERE [Status] IN ('PENDING', 'FAILED');

CREATE TABLE mtg.MeetingNotifications (
    NotificationId      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingNotifications PRIMARY KEY,
    RecipientUserId     BIGINT         NOT NULL CONSTRAINT FK_MeetingNotifications_Recipient REFERENCES auth.Users (UserId),
    MeetingId           BIGINT         NULL CONSTRAINT FK_MeetingNotifications_Meeting REFERENCES mtg.Meetings (MeetingId),
    [Type]              VARCHAR(30)    NOT NULL,
    Title               NVARCHAR(200)  NOT NULL,
    Body                NVARCHAR(1000) NULL,
    LinkPath            NVARCHAR(400)  NULL,
    IsRead              BIT            NOT NULL CONSTRAINT DF_MeetingNotifications_IsRead DEFAULT (0),
    ReadUtc             DATETIME2(3)   NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingNotifications_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST')),
    -- Links are app-relative only (no open redirects).
    CONSTRAINT CK_MeetingNotifications_LinkPath CHECK (LinkPath IS NULL OR (LinkPath LIKE '/%' AND LinkPath NOT LIKE '//%'))
);
CREATE INDEX IX_MeetingNotifications_Recipient ON mtg.MeetingNotifications (RecipientUserId, IsRead, CreatedUtc DESC);

CREATE TABLE mtg.MeetingAttendance (
    AttendanceId        BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingAttendance PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingAttendance_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantId       BIGINT         NOT NULL CONSTRAINT FK_MeetingAttendance_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    JoinedUtc           DATETIME2(3)   NOT NULL,
    LeftUtc             DATETIME2(3)   NULL,
    DurationSeconds     AS (CASE WHEN LeftUtc IS NULL THEN NULL ELSE DATEDIFF(SECOND, JoinedUtc, LeftUtc) END) PERSISTED,
    LeaveReason         VARCHAR(30)    NULL,
    ClientInfo          NVARCHAR(400)  NULL,
    NetworkQualityAvg   DECIMAL(4, 2)  NULL,
    CONSTRAINT CK_MeetingAttendance_Period CHECK (LeftUtc IS NULL OR LeftUtc >= JoinedUtc)
);
CREATE INDEX IX_MeetingAttendance_Meeting ON mtg.MeetingAttendance (MeetingId, ParticipantId, JoinedUtc);

-- Append-only: the latest row per (meeting, participant, type) is the current decision.
CREATE TABLE mtg.MeetingConsent (
    ConsentId           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingConsent PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingConsent_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantId       BIGINT         NOT NULL CONSTRAINT FK_MeetingConsent_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    ConsentType         VARCHAR(30)    NOT NULL CONSTRAINT DF_MeetingConsent_ConsentType DEFAULT ('RECORDING'),
    NoticeVersion       VARCHAR(30)    NOT NULL,
    Decision            VARCHAR(30)    NOT NULL,
    DecisionUtc         DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingConsent_DecisionUtc DEFAULT (SYSUTCDATETIME()),
    IpAddress           VARCHAR(45)    NULL,
    UserAgent           NVARCHAR(512)  NULL,
    EvidenceHash        BINARY(32)     NULL,
    CONSTRAINT CK_MeetingConsent_Type CHECK (ConsentType IN ('RECORDING')),
    CONSTRAINT CK_MeetingConsent_Decision CHECK (Decision IN ('GRANTED', 'DENIED', 'WITHDRAWN'))
);
CREATE INDEX IX_MeetingConsent_Current ON mtg.MeetingConsent (MeetingId, ParticipantId, ConsentType, DecisionUtc DESC);
GO

CREATE TRIGGER mtg.trg_MeetingConsent_AppendOnly ON mtg.MeetingConsent AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51002, 'mtg.MeetingConsent is append-only.', 1;
END;
GO

CREATE TABLE mtg.WaitingRoomEntries (
    EntryId             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_WaitingRoomEntries PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_WaitingRoomEntries_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantId       BIGINT         NOT NULL CONSTRAINT FK_WaitingRoomEntries_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    EnteredUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_WaitingRoomEntries_EnteredUtc DEFAULT (SYSUTCDATETIME()),
    [Status]            VARCHAR(30)    NOT NULL CONSTRAINT DF_WaitingRoomEntries_Status DEFAULT ('WAITING'),
    DecidedByEmployeeId BIGINT         NULL CONSTRAINT FK_WaitingRoomEntries_DecidedBy REFERENCES org.Employees (EmployeeId),
    DecidedUtc          DATETIME2(3)   NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_WaitingRoomEntries_Status CHECK ([Status] IN ('WAITING', 'ADMITTED', 'REJECTED', 'LEFT')),
    CONSTRAINT CK_WaitingRoomEntries_Decision CHECK ([Status] NOT IN ('ADMITTED', 'REJECTED') OR (DecidedByEmployeeId IS NOT NULL AND DecidedUtc IS NOT NULL))
);
CREATE INDEX IX_WaitingRoomEntries_Meeting ON mtg.WaitingRoomEntries (MeetingId, [Status]);

CREATE TABLE mtg.MeetingChatMessages (
    MessageId           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingChatMessages PRIMARY KEY,
    MeetingId           BIGINT         NOT NULL CONSTRAINT FK_MeetingChatMessages_Meeting REFERENCES mtg.Meetings (MeetingId),
    ParticipantId       BIGINT         NULL CONSTRAINT FK_MeetingChatMessages_Participant REFERENCES mtg.MeetingParticipants (ParticipantId),
    Body                NVARCHAR(2000) NOT NULL,
    SentUtc             DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingChatMessages_SentUtc DEFAULT (SYSUTCDATETIME()),
    IsSystem            BIT            NOT NULL CONSTRAINT DF_MeetingChatMessages_IsSystem DEFAULT (0),
    CONSTRAINT CK_MeetingChatMessages_Sender CHECK (IsSystem = 1 OR ParticipantId IS NOT NULL)
);
CREATE INDEX IX_MeetingChatMessages_Meeting ON mtg.MeetingChatMessages (MeetingId, SentUtc);

-- Working hours are local times (evaluated in the API with the employee/branch time zone);
-- leave and blocked periods are absolute UTC ranges.
CREATE TABLE mtg.EmployeeAvailability (
    AvailabilityId      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_EmployeeAvailability PRIMARY KEY,
    EmployeeId          BIGINT         NOT NULL CONSTRAINT FK_EmployeeAvailability_Employee REFERENCES org.Employees (EmployeeId),
    [Type]              VARCHAR(30)    NOT NULL,
    [DayOfWeek]         TINYINT        NULL,
    StartLocalTime      TIME(0)        NULL,
    EndLocalTime        TIME(0)        NULL,
    StartUtc            DATETIME2(3)   NULL,
    EndUtc              DATETIME2(3)   NULL,
    Reason              NVARCHAR(400)  NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_EmployeeAvailability_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId     BIGINT         NULL,
    ModifiedUtc         DATETIME2(3)   NULL,
    ModifiedByUserId    BIGINT         NULL,
    RowVersion          ROWVERSION     NOT NULL,
    CONSTRAINT CK_EmployeeAvailability_Shape CHECK (
        ([Type] = 'WORKING_HOURS' AND [DayOfWeek] BETWEEN 0 AND 6 AND StartLocalTime IS NOT NULL AND EndLocalTime > StartLocalTime
            AND StartUtc IS NULL AND EndUtc IS NULL)
     OR ([Type] IN ('LEAVE', 'BLOCKED') AND StartUtc IS NOT NULL AND EndUtc > StartUtc
            AND [DayOfWeek] IS NULL AND StartLocalTime IS NULL AND EndLocalTime IS NULL))
);
CREATE INDEX IX_EmployeeAvailability_Employee ON mtg.EmployeeAvailability (EmployeeId, [Type], StartUtc) INCLUDE (EndUtc);
GO
