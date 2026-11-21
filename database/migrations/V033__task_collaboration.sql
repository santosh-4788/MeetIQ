-- V033: Task collaboration - assign tasks to colleagues, review before close, checklists, comments, proof files, Top 3 for today,
--   shared notes and note colours (21 Nov 2026).
--   ADDITIVE, plus two widened CHECK lists (every existing value is kept):
--   chat.TRN_ChatTask              + AssignedByUserId, AssignmentKey, AssignState, RequiresReview, RequestedDueUtc, RequestReason,
--                                    SubmittedUtc, ReviewedUtc, FocusUtc, DueSoonSentUtc, OverdueSentUtc.
--                                    An assigned task is one row PER ASSIGNEE (OwnerUserId = the assignee); the copies of one
--                                    assignment share AssignmentKey. AssignedByUserId may see and review the copy.
--                                    Status CHECK gains 'IN_REVIEW' (sent for review, waiting for the person who assigned it).
--   chat.TRN_ChatTaskChecklist     - checklist steps of a task; IsRequired = must be done before it can be completed / sent for review.
--   chat.TRN_ChatTaskActivity      - history and comments of a task (assigned, accepted, declined, new date asked, sent for review,
--                                    approved, sent back, comment ...). Visible to the owner and the person who assigned it.
--   chat.TRN_ChatTaskFile          - proof files on a task; same rules as chat attachments (allowed types, content check, Defender scan).
--   chat.TRN_ChatNoteShare         - a note shared READ-ONLY with a colleague.
--   chat.TRN_ChatNote              + Color (optional note colour).
--   chat.MST_ChatUserPreference    + TaskEmails (e-mail me about tasks assigned to me / waiting for my review; default on).
--   mtg.MeetingNotifications       - Type CHECK gains TASK_ASSIGNED, TASK_UPDATE, TASK_REVIEW, TASK_COMMENT, TASK_DUE, NOTE_SHARED.
--   app.FeatureSettings 'TASK_COLLAB' - seeded OFF; also needs CHAT and CHAT_TASKS on. EMERGENCY_DISABLE switches it off.
--   Permissions: the schema-level GRANT on chat (V028) covers the new tables.
--   Requires V030, V031, V032.
--   Rollback: database/rollback/V033__task_collaboration.rollback.sql.

ALTER TABLE chat.TRN_ChatTask ADD
    AssignedByUserId  BIGINT           NULL CONSTRAINT FK_TRN_ChatTask_AssignedBy REFERENCES auth.Users (UserId),
    AssignmentKey     UNIQUEIDENTIFIER NULL,
    AssignState       VARCHAR(8)       NULL,
    RequiresReview    BIT              NOT NULL CONSTRAINT DF_TRN_ChatTask_RequiresReview DEFAULT (0),
    RequestedDueUtc   DATETIME2(3)     NULL,
    RequestReason     NVARCHAR(500)    NULL,
    SubmittedUtc      DATETIME2(3)     NULL,
    ReviewedUtc       DATETIME2(3)     NULL,
    FocusUtc          DATETIME2(3)     NULL,
    DueSoonSentUtc    DATETIME2(3)     NULL,
    OverdueSentUtc    DATETIME2(3)     NULL;
GO

ALTER TABLE chat.TRN_ChatTask ADD
    CONSTRAINT CK_TRN_ChatTask_AssignState CHECK (AssignState IS NULL OR AssignState IN ('PENDING', 'ACCEPTED', 'DECLINED')),
    CONSTRAINT CK_TRN_ChatTask_Assigned CHECK ((AssignedByUserId IS NULL AND AssignmentKey IS NULL AND AssignState IS NULL)
                                            OR (AssignedByUserId IS NOT NULL AND AssignmentKey IS NOT NULL AND AssignState IS NOT NULL AND AssignedByUserId <> OwnerUserId));
ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT CK_TRN_ChatTask_Status;
ALTER TABLE chat.TRN_ChatTask ADD CONSTRAINT CK_TRN_ChatTask_Status CHECK ([Status] IN ('PENDING', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'POSTPONED', 'CANCELLED'));
CREATE INDEX IX_TRN_ChatTask_AssignedBy ON chat.TRN_ChatTask (AssignedByUserId, [Status], DueUtc) INCLUDE (AssignmentKey) WHERE IsActive = 1 AND AssignedByUserId IS NOT NULL;
CREATE INDEX IX_TRN_ChatTask_AssignmentKey ON chat.TRN_ChatTask (AssignmentKey) WHERE AssignmentKey IS NOT NULL;
GO

CREATE TABLE chat.TRN_ChatTaskChecklist (
    ItemId          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatTaskChecklist PRIMARY KEY,
    PublicId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_PublicId DEFAULT (NEWSEQUENTIALID()),
    TaskId          BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatTaskChecklist_Task REFERENCES chat.TRN_ChatTask (TaskId),
    [Text]          NVARCHAR(300)  NOT NULL,
    IsRequired      BIT            NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_IsRequired DEFAULT (0),
    IsDone          BIT            NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_IsDone DEFAULT (0),
    DoneUtc         DATETIME2(3)   NULL,
    SortOrder       INT            NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_SortOrder DEFAULT (0),
    CreatedByUserId BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatTaskChecklist_CreatedBy REFERENCES auth.Users (UserId),
    IsActive        BIT            NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_IsActive DEFAULT (1),
    CreatedUtc      DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedUtc      DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatTaskChecklist_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatTaskChecklist_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatTaskChecklist_Text CHECK (LEN([Text]) > 0)
);
CREATE INDEX IX_TRN_ChatTaskChecklist_Task ON chat.TRN_ChatTaskChecklist (TaskId, SortOrder) WHERE IsActive = 1;
GO

CREATE TABLE chat.TRN_ChatTaskActivity (
    ActivityId      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatTaskActivity PRIMARY KEY,
    PublicId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatTaskActivity_PublicId DEFAULT (NEWSEQUENTIALID()),
    TaskId          BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatTaskActivity_Task REFERENCES chat.TRN_ChatTask (TaskId),
    ActorUserId     BIGINT         NULL CONSTRAINT FK_TRN_ChatTaskActivity_Actor REFERENCES auth.Users (UserId),   -- NULL = the system
    Kind            VARCHAR(16)    NOT NULL,
    Body            NVARCHAR(2000) NULL,
    DueUtc          DATETIME2(3)   NULL,
    CreatedUtc      DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatTaskActivity_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatTaskActivity_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatTaskActivity_Kind CHECK (Kind IN ('CREATED', 'ASSIGNED', 'ACCEPTED', 'DECLINED', 'DATE_REQUESTED', 'DATE_APPROVED', 'DATE_REJECTED',
        'EDITED', 'STARTED', 'SUBMITTED', 'APPROVED', 'RETURNED', 'COMPLETED', 'REOPENED', 'CANCELLED', 'COMMENT', 'FILE', 'OVERDUE', 'NUDGED'))
);
CREATE INDEX IX_TRN_ChatTaskActivity_Task ON chat.TRN_ChatTaskActivity (TaskId, ActivityId);
GO

CREATE TABLE chat.TRN_ChatTaskFile (
    FileId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatTaskFile PRIMARY KEY,
    PublicId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatTaskFile_PublicId DEFAULT (NEWSEQUENTIALID()),
    TaskId            BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatTaskFile_Task REFERENCES chat.TRN_ChatTask (TaskId),
    UploadedByUserId  BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatTaskFile_User REFERENCES auth.Users (UserId),
    OriginalName      NVARCHAR(200)  NOT NULL,
    Extension         VARCHAR(10)    NOT NULL,
    ContentType       VARCHAR(100)   NOT NULL,
    SizeBytes         BIGINT         NOT NULL,
    Sha256            CHAR(64)       NOT NULL,
    StorageKey        VARCHAR(80)    NOT NULL,   -- opaque relative path under Chat:StorageRoot, never sent to clients
    ScanStatus        VARCHAR(8)     NOT NULL CONSTRAINT DF_TRN_ChatTaskFile_ScanStatus DEFAULT ('PENDING'),
    ScanAttempts      INT            NOT NULL CONSTRAINT DF_TRN_ChatTaskFile_ScanAttempts DEFAULT (0),
    ScannedUtc        DATETIME2(3)   NULL,
    ScanDetail        NVARCHAR(200)  NULL,
    CreatedUtc        DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatTaskFile_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    DeletedUtc        DATETIME2(3)   NULL,
    CONSTRAINT UQ_TRN_ChatTaskFile_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatTaskFile_ScanStatus CHECK (ScanStatus IN ('PENDING', 'CLEAN', 'BLOCKED', 'ERROR')),
    CONSTRAINT CK_TRN_ChatTaskFile_Size CHECK (SizeBytes >= 0)
);
CREATE INDEX IX_TRN_ChatTaskFile_Task ON chat.TRN_ChatTaskFile (TaskId) WHERE DeletedUtc IS NULL;
CREATE INDEX IX_TRN_ChatTaskFile_Pending ON chat.TRN_ChatTaskFile (FileId) WHERE ScanStatus = 'PENDING';
GO

CREATE TABLE chat.TRN_ChatNoteShare (
    NoteId          BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatNoteShare_Note REFERENCES chat.TRN_ChatNote (NoteId),
    UserId          BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatNoteShare_User REFERENCES auth.Users (UserId),
    CreatedUtc      DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatNoteShare_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_TRN_ChatNoteShare PRIMARY KEY (NoteId, UserId)
);
CREATE INDEX IX_TRN_ChatNoteShare_User ON chat.TRN_ChatNoteShare (UserId);
GO

ALTER TABLE chat.TRN_ChatNote ADD Color VARCHAR(7) NULL
    CONSTRAINT CK_TRN_ChatNote_Color CHECK (Color IS NULL OR Color LIKE '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]');
ALTER TABLE chat.MST_ChatUserPreference ADD TaskEmails BIT NOT NULL CONSTRAINT DF_MST_ChatUserPreference_TaskEmails DEFAULT (1);
GO

ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL',
     'TASK_REMINDER', 'NOTE_REMINDER', 'CHAT_MENTION', 'GROUP_ADDED',
     'TASK_ASSIGNED', 'TASK_UPDATE', 'TASK_REVIEW', 'TASK_COMMENT', 'TASK_DUE', 'NOTE_SHARED'));
GO

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT 'TASK_COLLAB', 0
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings WHERE FeatureKey = 'TASK_COLLAB');
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V033',
    N'Migration V033: task collaboration (assign, review before close, checklists, comments, proof files, Top 3), shared notes, note colours, task e-mails, notification types, feature switch TASK_COLLAB (off)',
    N'{"tables":["chat.TRN_ChatTaskChecklist","chat.TRN_ChatTaskActivity","chat.TRN_ChatTaskFile","chat.TRN_ChatNoteShare"],"columns":["chat.TRN_ChatTask.Assign*","chat.TRN_ChatNote.Color","chat.MST_ChatUserPreference.TaskEmails"],"constraints":["CK_TRN_ChatTask_Status +IN_REVIEW","CK_MeetingNotifications_Type +TASK_*"],"features":["TASK_COLLAB"]}');
