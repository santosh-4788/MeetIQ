-- V030: Chat Phase 4 - personal notes, tasks, reminders and My Day (20 Nov 2026, documentation/CHAT_MODULE_PHASE1.md sections 6, 7, 12,
--   requirement sections 14-16).
--   ADDITIVE, plus one widened CHECK list:
--   chat.MST_TaskCategory          - task / note categories: defaults (OwnerUserId NULL) + each person's own.
--   chat.TRN_ChatTask              - personal tasks / follow-ups (priority, status, due, repeat, links to meeting, colleague,
--                                    conversation, chat message, call, note). PRIVATE to the owner.
--   chat.TRN_ChatNote              - personal notes (pin, complete, archive, date, links to meeting, task, colleague, conversation).
--                                    PRIVATE to the owner.
--   chat.TRN_ChatReminder          - one reminder for a task OR a note; fired exactly once by the server (ChatReminderWorker),
--                                    snooze puts it back to PENDING. At most one open reminder per item (enforced by the API).
--   mtg.MeetingNotifications       - Type CHECK gains 'TASK_REMINDER' and 'NOTE_REMINDER'. Every existing value (incl. MISSED_CALL) is kept.
--   app.FeatureSettings 'CHAT_TASKS' - seeded OFF; also needs CHAT on. EMERGENCY_DISABLE switches it off.
--   Permissions: the schema-level GRANT on chat (V028) covers the new tables.
--   Requires V028 and V029.
--   Rollback: database/rollback/V030__chat_tasks.rollback.sql.

CREATE TABLE chat.MST_TaskCategory (
    CategoryId     BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MST_TaskCategory PRIMARY KEY,
    PublicId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MST_TaskCategory_PublicId DEFAULT (NEWSEQUENTIALID()),
    OwnerUserId    BIGINT         NULL CONSTRAINT FK_MST_TaskCategory_Owner REFERENCES auth.Users (UserId),   -- NULL = default category
    [Name]         NVARCHAR(40)   NOT NULL,
    Color          VARCHAR(7)     NOT NULL,
    SortOrder      INT            NOT NULL CONSTRAINT DF_MST_TaskCategory_SortOrder DEFAULT (100),
    IsActive       BIT            NOT NULL CONSTRAINT DF_MST_TaskCategory_IsActive DEFAULT (1),
    CreatedUtc     DATETIME2(3)   NOT NULL CONSTRAINT DF_MST_TaskCategory_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedUtc     DATETIME2(3)   NOT NULL CONSTRAINT DF_MST_TaskCategory_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_MST_TaskCategory_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_MST_TaskCategory_Color CHECK (Color LIKE '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
    CONSTRAINT CK_MST_TaskCategory_Name CHECK (LEN([Name]) > 0)
);
CREATE UNIQUE INDEX UX_MST_TaskCategory_OwnerName ON chat.MST_TaskCategory (OwnerUserId, [Name]) WHERE IsActive = 1;
GO

INSERT chat.MST_TaskCategory (OwnerUserId, [Name], Color, SortOrder)
SELECT NULL, v.n, v.c, v.s
FROM (VALUES (N'Work', '#2563EB', 1), (N'Follow-up', '#D97706', 2), (N'Customer', '#059669', 3), (N'Meeting prep', '#7C3AED', 4), (N'Personal', '#DB2777', 5)) v (n, c, s)
WHERE NOT EXISTS (SELECT 1 FROM chat.MST_TaskCategory x WHERE x.OwnerUserId IS NULL AND x.[Name] = v.n);
GO

CREATE TABLE chat.TRN_ChatTask (
    TaskId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatTask PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatTask_PublicId DEFAULT (NEWSEQUENTIALID()),
    OwnerUserId         BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatTask_Owner REFERENCES auth.Users (UserId),
    Title               NVARCHAR(200)  NOT NULL,
    [Description]       NVARCHAR(MAX)  NULL,
    Notes               NVARCHAR(MAX)  NULL,
    [Priority]          VARCHAR(6)     NOT NULL CONSTRAINT DF_TRN_ChatTask_Priority DEFAULT ('MEDIUM'),
    [Status]            VARCHAR(11)    NOT NULL CONSTRAINT DF_TRN_ChatTask_Status DEFAULT ('PENDING'),
    DueUtc              DATETIME2(3)   NULL,
    HasDueTime          BIT            NOT NULL CONSTRAINT DF_TRN_ChatTask_HasDueTime DEFAULT (0),
    CategoryId          BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_Category REFERENCES chat.MST_TaskCategory (CategoryId),
    RepeatRule          VARCHAR(8)     NOT NULL CONSTRAINT DF_TRN_ChatTask_RepeatRule DEFAULT ('NONE'),
    CompletedUtc        DATETIME2(3)   NULL,
    MeetingId           BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_Meeting REFERENCES mtg.Meetings (MeetingId),
    EmployeeUserId      BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_Employee REFERENCES auth.Users (UserId),
    ConversationId      BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    SourceMessageId     BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_Message REFERENCES chat.TRN_ChatMessage (MessageId),
    SourceCallId        BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_Call REFERENCES chat.TRN_ChatCall (CallId),
    NoteId              BIGINT         NULL,   -- FK_TRN_ChatTask_Note added after chat.TRN_ChatNote exists
    RepeatedFromTaskId  BIGINT         NULL CONSTRAINT FK_TRN_ChatTask_RepeatedFrom REFERENCES chat.TRN_ChatTask (TaskId),
    IsActive            BIT            NOT NULL CONSTRAINT DF_TRN_ChatTask_IsActive DEFAULT (1),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatTask_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatTask_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatTask_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatTask_Priority CHECK ([Priority] IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    CONSTRAINT CK_TRN_ChatTask_Status CHECK ([Status] IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED')),
    CONSTRAINT CK_TRN_ChatTask_RepeatRule CHECK (RepeatRule IN ('NONE', 'DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY')),
    CONSTRAINT CK_TRN_ChatTask_Title CHECK (LEN(Title) > 0),
    CONSTRAINT CK_TRN_ChatTask_Description CHECK ([Description] IS NULL OR LEN([Description]) <= 8000),
    CONSTRAINT CK_TRN_ChatTask_Notes CHECK (Notes IS NULL OR LEN(Notes) <= 8000)
);
CREATE INDEX IX_TRN_ChatTask_Owner ON chat.TRN_ChatTask (OwnerUserId, [Status], DueUtc) WHERE IsActive = 1;
CREATE INDEX IX_TRN_ChatTask_RepeatedFrom ON chat.TRN_ChatTask (RepeatedFromTaskId) WHERE RepeatedFromTaskId IS NOT NULL;
GO

CREATE TABLE chat.TRN_ChatNote (
    NoteId              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatNote PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatNote_PublicId DEFAULT (NEWSEQUENTIALID()),
    OwnerUserId         BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatNote_Owner REFERENCES auth.Users (UserId),
    Title               NVARCHAR(200)  NOT NULL,
    Body                NVARCHAR(MAX)  NULL,
    CategoryId          BIGINT         NULL CONSTRAINT FK_TRN_ChatNote_Category REFERENCES chat.MST_TaskCategory (CategoryId),
    IsPinned            BIT            NOT NULL CONSTRAINT DF_TRN_ChatNote_IsPinned DEFAULT (0),
    IsCompleted         BIT            NOT NULL CONSTRAINT DF_TRN_ChatNote_IsCompleted DEFAULT (0),
    CompletedUtc        DATETIME2(3)   NULL,
    IsArchived          BIT            NOT NULL CONSTRAINT DF_TRN_ChatNote_IsArchived DEFAULT (0),
    NoteDateUtc         DATETIME2(3)   NULL,
    MeetingId           BIGINT         NULL CONSTRAINT FK_TRN_ChatNote_Meeting REFERENCES mtg.Meetings (MeetingId),
    TaskId              BIGINT         NULL CONSTRAINT FK_TRN_ChatNote_Task REFERENCES chat.TRN_ChatTask (TaskId),
    EmployeeUserId      BIGINT         NULL CONSTRAINT FK_TRN_ChatNote_Employee REFERENCES auth.Users (UserId),
    ConversationId      BIGINT         NULL CONSTRAINT FK_TRN_ChatNote_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    IsActive            BIT            NOT NULL CONSTRAINT DF_TRN_ChatNote_IsActive DEFAULT (1),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatNote_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatNote_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatNote_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatNote_Title CHECK (LEN(Title) > 0),
    CONSTRAINT CK_TRN_ChatNote_Body CHECK (Body IS NULL OR LEN(Body) <= 8000)
);
CREATE INDEX IX_TRN_ChatNote_Owner ON chat.TRN_ChatNote (OwnerUserId, IsArchived, IsPinned, UpdatedUtc DESC) WHERE IsActive = 1;
GO

ALTER TABLE chat.TRN_ChatTask ADD CONSTRAINT FK_TRN_ChatTask_Note FOREIGN KEY (NoteId) REFERENCES chat.TRN_ChatNote (NoteId);
GO

CREATE TABLE chat.TRN_ChatReminder (
    ReminderId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatReminder PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatReminder_PublicId DEFAULT (NEWSEQUENTIALID()),
    OwnerUserId         BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatReminder_Owner REFERENCES auth.Users (UserId),
    TaskId              BIGINT         NULL CONSTRAINT FK_TRN_ChatReminder_Task REFERENCES chat.TRN_ChatTask (TaskId),
    NoteId              BIGINT         NULL CONSTRAINT FK_TRN_ChatReminder_Note REFERENCES chat.TRN_ChatNote (NoteId),
    DueUtc              DATETIME2(3)   NOT NULL,
    [State]             VARCHAR(9)     NOT NULL CONSTRAINT DF_TRN_ChatReminder_State DEFAULT ('PENDING'),
    FiredUtc            DATETIME2(3)   NULL,
    AcknowledgedUtc     DATETIME2(3)   NULL,
    SnoozeCount         INT            NOT NULL CONSTRAINT DF_TRN_ChatReminder_SnoozeCount DEFAULT (0),
    IsActive            BIT            NOT NULL CONSTRAINT DF_TRN_ChatReminder_IsActive DEFAULT (1),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatReminder_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatReminder_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatReminder_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatReminder_Item CHECK ((TaskId IS NULL AND NoteId IS NOT NULL) OR (TaskId IS NOT NULL AND NoteId IS NULL)),
    CONSTRAINT CK_TRN_ChatReminder_State CHECK ([State] IN ('PENDING', 'FIRED', 'DONE', 'CANCELLED', 'DISMISSED')),
    CONSTRAINT CK_TRN_ChatReminder_SnoozeCount CHECK (SnoozeCount >= 0)
);
CREATE INDEX IX_TRN_ChatReminder_Due ON chat.TRN_ChatReminder ([State], DueUtc) INCLUDE (OwnerUserId, TaskId, NoteId) WHERE IsActive = 1;
CREATE INDEX IX_TRN_ChatReminder_Owner ON chat.TRN_ChatReminder (OwnerUserId, [State], DueUtc) WHERE IsActive = 1;
CREATE INDEX IX_TRN_ChatReminder_Task ON chat.TRN_ChatReminder (TaskId) WHERE TaskId IS NOT NULL;
CREATE INDEX IX_TRN_ChatReminder_Note ON chat.TRN_ChatReminder (NoteId) WHERE NoteId IS NOT NULL;
GO

ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL',
     'TASK_REMINDER', 'NOTE_REMINDER'));
GO

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT 'CHAT_TASKS', 0
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_TASKS');
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V030',
    N'Migration V030: chat notes, tasks and reminders (private to each person), task categories, notification types TASK_REMINDER / NOTE_REMINDER, feature switch CHAT_TASKS (off)',
    N'{"tables":["chat.MST_TaskCategory","chat.TRN_ChatTask","chat.TRN_ChatNote","chat.TRN_ChatReminder"],"constraints":["CK_MeetingNotifications_Type +TASK_REMINDER +NOTE_REMINDER"],"features":["CHAT_TASKS"]}');
