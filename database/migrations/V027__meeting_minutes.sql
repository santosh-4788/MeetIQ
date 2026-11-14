-- V027: minutes of meeting (MOM) written by people - NO AI (14 Nov 2026).
--   ADDITIVE ONLY: new tables, one new feature switch, one new permission. No existing table, column, constraint or row is changed.
--   app.FeatureSettings 'MEETING_MINUTES'  - seeded OFF. With it off the meeting page shows nothing new and the API refuses
--                                           (403 FEATURE_DISABLED). EMERGENCY_DISABLE (V026) also switches it off.
--   mtg.MeetingMinutes                     - one set of minutes per meeting: DRAFT -> APPROVED (approved minutes are read-only
--                                           until someone reopens them with a reason, which makes them a draft again).
--   mtg.MeetingMinutesActionItems          - the current action items (description, assigned employee, due date, priority, status).
--   mtg.MeetingMinutesVersions             - append-only history: every save, approval and reopen stores a full JSON snapshot.
--   minutes.approve                        - may approve minutes of meetings the user can see (Super Admin, Admin, Department
--                                           Head, Team Leader; Roles & permissions can change this).
--   Writing/editing: the meeting's host, organiser, co-hosts, or a user with meetings.view.all (checked by the API).
--   Requires V026 (app.FeatureSettings).
--   Rollback: database/rollback/V027__meeting_minutes.rollback.sql (drops only what this script created).

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT 'MEETING_MINUTES', 0
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings WHERE FeatureKey = 'MEETING_MINUTES');
GO

CREATE TABLE mtg.MeetingMinutes (
    MinutesId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingMinutes PRIMARY KEY,
    PublicId               UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MeetingMinutes_PublicId DEFAULT (NEWSEQUENTIALID()),
    MeetingId              BIGINT         NOT NULL CONSTRAINT FK_MeetingMinutes_Meeting REFERENCES mtg.Meetings (MeetingId),
    [Status]               VARCHAR(10)    NOT NULL CONSTRAINT DF_MeetingMinutes_Status DEFAULT ('DRAFT'),
    [Version]              INT            NOT NULL CONSTRAINT DF_MeetingMinutes_Version DEFAULT (1),
    DiscussionSummary      NVARCHAR(MAX)  NULL,   -- the API limits it to 8000 characters
    CustomerRequirements   NVARCHAR(4000) NULL,
    Decisions              NVARCHAR(4000) NULL,
    PendingActivities      NVARCHAR(4000) NULL,
    FollowUpDate           DATE           NULL,
    CreatedUtc             DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingMinutes_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId        BIGINT         NOT NULL CONSTRAINT FK_MeetingMinutes_CreatedBy REFERENCES auth.Users (UserId),
    ModifiedUtc            DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingMinutes_ModifiedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedByUserId       BIGINT         NOT NULL CONSTRAINT FK_MeetingMinutes_ModifiedBy REFERENCES auth.Users (UserId),
    ApprovedUtc            DATETIME2(3)   NULL,
    ApprovedByUserId       BIGINT         NULL CONSTRAINT FK_MeetingMinutes_ApprovedBy REFERENCES auth.Users (UserId),
    CONSTRAINT UQ_MeetingMinutes_PublicId UNIQUE (PublicId),
    CONSTRAINT UQ_MeetingMinutes_Meeting UNIQUE (MeetingId),
    CONSTRAINT CK_MeetingMinutes_Status CHECK ([Status] IN ('DRAFT', 'APPROVED')),
    -- Reopening clears the approval; who approved earlier stays in mtg.MeetingMinutesVersions and the audit log.
    CONSTRAINT CK_MeetingMinutes_Approved CHECK (([Status] = 'APPROVED' AND ApprovedUtc IS NOT NULL AND ApprovedByUserId IS NOT NULL)
                                              OR ([Status] = 'DRAFT' AND ApprovedUtc IS NULL AND ApprovedByUserId IS NULL)),
    CONSTRAINT CK_MeetingMinutes_Version CHECK ([Version] >= 1)
);
GO

CREATE TABLE mtg.MeetingMinutesActionItems (
    ActionItemId           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MeetingMinutesActionItems PRIMARY KEY,
    PublicId               UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MeetingMinutesActionItems_PublicId DEFAULT (NEWID()),
    MinutesId              BIGINT         NOT NULL CONSTRAINT FK_MeetingMinutesActionItems_Minutes REFERENCES mtg.MeetingMinutes (MinutesId),
    SortOrder              INT            NOT NULL,
    [Description]          NVARCHAR(500)  NOT NULL,
    AssignedEmployeeId     BIGINT         NULL CONSTRAINT FK_MeetingMinutesActionItems_Employee REFERENCES org.Employees (EmployeeId),
    DueDate                DATE           NULL,
    [Priority]             VARCHAR(10)    NOT NULL CONSTRAINT DF_MeetingMinutesActionItems_Priority DEFAULT ('MEDIUM'),
    [Status]               VARCHAR(12)    NOT NULL CONSTRAINT DF_MeetingMinutesActionItems_Status DEFAULT ('OPEN'),
    CONSTRAINT UQ_MeetingMinutesActionItems_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_MeetingMinutesActionItems_Priority CHECK ([Priority] IN ('LOW', 'MEDIUM', 'HIGH')),
    CONSTRAINT CK_MeetingMinutesActionItems_Status CHECK ([Status] IN ('OPEN', 'IN_PROGRESS', 'DONE'))
);
CREATE INDEX IX_MeetingMinutesActionItems_Minutes ON mtg.MeetingMinutesActionItems (MinutesId, SortOrder);
CREATE INDEX IX_MeetingMinutesActionItems_Employee ON mtg.MeetingMinutesActionItems (AssignedEmployeeId, [Status]) WHERE AssignedEmployeeId IS NOT NULL;
GO

CREATE TABLE mtg.MeetingMinutesVersions (
    MinutesId              BIGINT         NOT NULL CONSTRAINT FK_MeetingMinutesVersions_Minutes REFERENCES mtg.MeetingMinutes (MinutesId),
    [Version]              INT            NOT NULL,
    [Action]               VARCHAR(10)    NOT NULL,
    [Status]               VARCHAR(10)    NOT NULL,
    SnapshotJson           NVARCHAR(MAX)  NOT NULL,
    Note                   NVARCHAR(500)  NULL,
    SavedUtc               DATETIME2(3)   NOT NULL CONSTRAINT DF_MeetingMinutesVersions_SavedUtc DEFAULT (SYSUTCDATETIME()),
    SavedByUserId          BIGINT         NOT NULL CONSTRAINT FK_MeetingMinutesVersions_User REFERENCES auth.Users (UserId),
    CONSTRAINT PK_MeetingMinutesVersions PRIMARY KEY (MinutesId, [Version]),
    CONSTRAINT CK_MeetingMinutesVersions_Action CHECK ([Action] IN ('CREATED', 'SAVED', 'APPROVED', 'REOPENED')),
    CONSTRAINT CK_MeetingMinutesVersions_Status CHECK ([Status] IN ('DRAFT', 'APPROVED'))
);
GO

INSERT auth.Permissions (Code, Module, Description)
SELECT 'minutes.approve', 'Meetings', N'Approve the minutes of meetings the user can see (approved minutes become read-only until reopened)'
WHERE NOT EXISTS (SELECT 1 FROM auth.Permissions WHERE Code = 'minutes.approve');
GO

INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r JOIN auth.Permissions p ON r.Code IN ('SuperAdmin', 'Admin', 'DepartmentHead', 'TeamLeader') AND p.Code = 'minutes.approve'
WHERE NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V027',
    N'Migration V027: minutes of meeting without AI (feature MEETING_MINUTES, disabled), minutes, action items, versions, permission minutes.approve',
    N'{"tables":["mtg.MeetingMinutes","mtg.MeetingMinutesActionItems","mtg.MeetingMinutesVersions"],"features":["MEETING_MINUTES"],"permissions":["minutes.approve"]}');
