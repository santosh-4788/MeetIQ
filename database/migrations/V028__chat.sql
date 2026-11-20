-- V028: Chat module, Phase 2 (20 Nov 2026, documentation/CHAT_MODULE_PHASE1.md, approved with decisions D1-D10).
--   ADDITIVE ONLY: a new schema `chat` with new tables, one new permission and one new feature switch. No existing table,
--   column, constraint or row is changed.
--   Naming (approved decision D1): master tables chat.MST_*, transaction tables chat.TRN_*; keys, PublicId, UTC DATETIME2(3) and
--   constraint names follow the rest of the database.
--   chat.MST_ChatFileType                 - allowed attachment types (extension, expected file signature, size limit, preview).
--   chat.MST_ChatUserPreference           - per person: availability, show last seen, sounds, last seen time.
--   chat.TRN_ChatConversation             - DIRECT (one per pair of people, DirectKey) or GROUP (name, description, image).
--   chat.TRN_ChatConversationParticipant  - membership + per-person state: role, read/delivered marks, pin, mute, archive, unread.
--   chat.TRN_ChatMessage                  - TEXT / FILE / SYSTEM messages; ClientMessageId makes retried sends idempotent.
--   chat.TRN_ChatMessageReaction          - emoji reactions.
--   chat.TRN_ChatFile                     - attachment metadata; the file itself is on disk (Chat:StorageRoot) under an opaque key.
--   chat.use                              - may use Chat (every role; Roles & permissions can remove it).
--   app.FeatureSettings 'CHAT'            - seeded OFF: with it off the menu item is hidden and the API refuses (403 FEATURE_DISABLED).
--                                           EMERGENCY_DISABLE (V026) also switches it off.
--   Requires V026 (app.FeatureSettings).
--   Rollback: database/rollback/V028__chat.rollback.sql (drops only what this script created).

CREATE SCHEMA chat AUTHORIZATION dbo;
GO

GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::chat TO oic_app_role;
GO

CREATE TABLE chat.MST_ChatFileType (
    FileTypeId     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_MST_ChatFileType PRIMARY KEY,
    Extension      VARCHAR(10)    NOT NULL,
    Category       VARCHAR(12)    NOT NULL,
    ContentType    VARCHAR(100)   NOT NULL,
    Signature      VARCHAR(10)    NOT NULL,
    MaxSizeMb      INT            NOT NULL CONSTRAINT DF_MST_ChatFileType_MaxSizeMb DEFAULT (25),
    InlinePreview  BIT            NOT NULL CONSTRAINT DF_MST_ChatFileType_InlinePreview DEFAULT (0),
    IsActive       BIT            NOT NULL CONSTRAINT DF_MST_ChatFileType_IsActive DEFAULT (1),
    CreatedUtc     DATETIME2(3)   NOT NULL CONSTRAINT DF_MST_ChatFileType_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedUtc    DATETIME2(3)   NULL,
    CONSTRAINT UQ_MST_ChatFileType_Extension UNIQUE (Extension),
    CONSTRAINT CK_MST_ChatFileType_Category CHECK (Category IN ('IMAGE', 'PDF', 'WORD', 'EXCEL', 'POWERPOINT', 'TEXT', 'CSV', 'ZIP')),
    CONSTRAINT CK_MST_ChatFileType_Signature CHECK (Signature IN ('PNG', 'JPEG', 'GIF', 'WEBP', 'PDF', 'OOXML', 'OLE', 'ZIP', 'TEXT')),
    CONSTRAINT CK_MST_ChatFileType_Size CHECK (MaxSizeMb BETWEEN 1 AND 100),
    CONSTRAINT CK_MST_ChatFileType_Extension CHECK (Extension NOT LIKE '%[^a-z0-9]%')
);
GO

-- Approved decision D3: 25 MB, ZIP allowed (scanned by the antivirus). Executables, scripts, HTML, SVG and macro-enabled Office
-- files (.docm/.xlsm/.pptm) are not in the list, so they are refused.
INSERT chat.MST_ChatFileType (Extension, Category, ContentType, Signature, InlinePreview)
SELECT v.e, v.c, v.t, v.s, v.p
FROM (VALUES
    ('png',  'IMAGE',      'image/png',  'PNG',  1),
    ('jpg',  'IMAGE',      'image/jpeg', 'JPEG', 1),
    ('jpeg', 'IMAGE',      'image/jpeg', 'JPEG', 1),
    ('gif',  'IMAGE',      'image/gif',  'GIF',  1),
    ('webp', 'IMAGE',      'image/webp', 'WEBP', 1),
    ('pdf',  'PDF',        'application/pdf', 'PDF', 1),
    ('doc',  'WORD',       'application/msword', 'OLE', 0),
    ('docx', 'WORD',       'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'OOXML', 0),
    ('xls',  'EXCEL',      'application/vnd.ms-excel', 'OLE', 0),
    ('xlsx', 'EXCEL',      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'OOXML', 0),
    ('ppt',  'POWERPOINT', 'application/vnd.ms-powerpoint', 'OLE', 0),
    ('pptx', 'POWERPOINT', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'OOXML', 0),
    ('txt',  'TEXT',       'text/plain', 'TEXT', 0),
    ('csv',  'CSV',        'text/csv',   'TEXT', 0),
    ('zip',  'ZIP',        'application/zip', 'ZIP', 0)
) v (e, c, t, s, p)
WHERE NOT EXISTS (SELECT 1 FROM chat.MST_ChatFileType f WHERE f.Extension = v.e);
GO

CREATE TABLE chat.MST_ChatUserPreference (
    UserId         BIGINT         NOT NULL CONSTRAINT PK_MST_ChatUserPreference PRIMARY KEY
                                  CONSTRAINT FK_MST_ChatUserPreference_User REFERENCES auth.Users (UserId),
    Availability   VARCHAR(10)    NOT NULL CONSTRAINT DF_MST_ChatUserPreference_Availability DEFAULT ('AVAILABLE'),
    ShowLastSeen   BIT            NOT NULL CONSTRAINT DF_MST_ChatUserPreference_ShowLastSeen DEFAULT (1),
    SoundsOn       BIT            NOT NULL CONSTRAINT DF_MST_ChatUserPreference_SoundsOn DEFAULT (1),
    LastSeenUtc    DATETIME2(3)   NULL,
    CreatedUtc     DATETIME2(3)   NOT NULL CONSTRAINT DF_MST_ChatUserPreference_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedUtc    DATETIME2(3)   NULL,
    CONSTRAINT CK_MST_ChatUserPreference_Availability CHECK (Availability IN ('AVAILABLE', 'BUSY', 'DND', 'AWAY'))
);
GO

CREATE TABLE chat.TRN_ChatConversation (
    ConversationId   BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatConversation PRIMARY KEY,
    PublicId         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatConversation_PublicId DEFAULT (NEWSEQUENTIALID()),
    [Type]           VARCHAR(6)     NOT NULL,
    DirectKey        VARCHAR(41)    NULL,   -- "<smaller UserId>:<larger UserId>" for DIRECT: one conversation per pair
    [Name]           NVARCHAR(80)   NULL,
    [Description]    NVARCHAR(500)  NULL,
    ImageFileId      BIGINT         NULL,   -- FK added after chat.TRN_ChatFile
    CreatedByUserId  BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatConversation_CreatedBy REFERENCES auth.Users (UserId),
    CreatedUtc       DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatConversation_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    ModifiedUtc      DATETIME2(3)   NULL,
    LastMessageId    BIGINT         NULL,
    LastMessageUtc   DATETIME2(3)   NULL,
    IsActive         BIT            NOT NULL CONSTRAINT DF_TRN_ChatConversation_IsActive DEFAULT (1),
    RowVersion       ROWVERSION     NOT NULL,
    CONSTRAINT UQ_TRN_ChatConversation_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatConversation_Type CHECK ([Type] IN ('DIRECT', 'GROUP')),
    CONSTRAINT CK_TRN_ChatConversation_Shape CHECK (([Type] = 'DIRECT' AND DirectKey IS NOT NULL) OR ([Type] = 'GROUP' AND DirectKey IS NULL AND [Name] IS NOT NULL))
);
CREATE UNIQUE INDEX UX_TRN_ChatConversation_DirectKey ON chat.TRN_ChatConversation (DirectKey) WHERE DirectKey IS NOT NULL;
GO

CREATE TABLE chat.TRN_ChatConversationParticipant (
    ConversationId          BIGINT       NOT NULL CONSTRAINT FK_TRN_ChatConversationParticipant_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    UserId                  BIGINT       NOT NULL CONSTRAINT FK_TRN_ChatConversationParticipant_User REFERENCES auth.Users (UserId),
    [Role]                  VARCHAR(6)   NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_Role DEFAULT ('MEMBER'),
    JoinedUtc               DATETIME2(3) NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_JoinedUtc DEFAULT (SYSUTCDATETIME()),
    LeftUtc                 DATETIME2(3) NULL,
    AddedByUserId           BIGINT       NULL,
    VisibleFromMessageId    BIGINT       NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_VisibleFrom DEFAULT (0), -- people added to a group see messages from then on
    LastReadMessageId       BIGINT       NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_LastRead DEFAULT (0),
    LastDeliveredMessageId  BIGINT       NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_LastDelivered DEFAULT (0),
    IsPinned                BIT          NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_IsPinned DEFAULT (0),
    MutedUntilUtc           DATETIME2(3) NULL,
    IsArchived              BIT          NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_IsArchived DEFAULT (0),
    MarkedUnread            BIT          NOT NULL CONSTRAINT DF_TRN_ChatConversationParticipant_MarkedUnread DEFAULT (0),
    CONSTRAINT PK_TRN_ChatConversationParticipant PRIMARY KEY (ConversationId, UserId),
    CONSTRAINT CK_TRN_ChatConversationParticipant_Role CHECK ([Role] IN ('ADMIN', 'MEMBER'))
);
CREATE INDEX IX_TRN_ChatConversationParticipant_User ON chat.TRN_ChatConversationParticipant (UserId, LeftUtc) INCLUDE (ConversationId, LastReadMessageId, IsPinned, IsArchived, MutedUntilUtc, MarkedUnread);
GO

CREATE TABLE chat.TRN_ChatMessage (
    MessageId         BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatMessage PRIMARY KEY,
    PublicId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatMessage_PublicId DEFAULT (NEWSEQUENTIALID()),
    ConversationId    BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatMessage_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    SenderUserId      BIGINT         NULL CONSTRAINT FK_TRN_ChatMessage_Sender REFERENCES auth.Users (UserId),  -- NULL for SYSTEM
    ClientMessageId   UNIQUEIDENTIFIER NULL,
    Kind              VARCHAR(6)     NOT NULL,
    Body              NVARCHAR(4000) NULL,
    ReplyToMessageId  BIGINT         NULL CONSTRAINT FK_TRN_ChatMessage_ReplyTo REFERENCES chat.TRN_ChatMessage (MessageId),
    IsForwarded       BIT            NOT NULL CONSTRAINT DF_TRN_ChatMessage_IsForwarded DEFAULT (0),
    CreatedUtc        DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatMessage_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    EditedUtc         DATETIME2(3)   NULL,
    DeletedUtc        DATETIME2(3)   NULL,
    DeletedByUserId   BIGINT         NULL,
    CONSTRAINT UQ_TRN_ChatMessage_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatMessage_Kind CHECK (Kind IN ('TEXT', 'FILE', 'SYSTEM')),
    CONSTRAINT CK_TRN_ChatMessage_Sender CHECK ((Kind = 'SYSTEM' AND SenderUserId IS NULL) OR (Kind <> 'SYSTEM' AND SenderUserId IS NOT NULL))
);
CREATE INDEX IX_TRN_ChatMessage_Conversation ON chat.TRN_ChatMessage (ConversationId, MessageId DESC) INCLUDE (SenderUserId, DeletedUtc);
CREATE UNIQUE INDEX UX_TRN_ChatMessage_ClientId ON chat.TRN_ChatMessage (SenderUserId, ClientMessageId) WHERE ClientMessageId IS NOT NULL;
GO

CREATE TABLE chat.TRN_ChatMessageReaction (
    MessageId   BIGINT        NOT NULL CONSTRAINT FK_TRN_ChatMessageReaction_Message REFERENCES chat.TRN_ChatMessage (MessageId),
    UserId      BIGINT        NOT NULL CONSTRAINT FK_TRN_ChatMessageReaction_User REFERENCES auth.Users (UserId),
    Emoji       NVARCHAR(16)  NOT NULL,
    CreatedUtc  DATETIME2(3)  NOT NULL CONSTRAINT DF_TRN_ChatMessageReaction_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_TRN_ChatMessageReaction PRIMARY KEY (MessageId, UserId, Emoji)
);
GO

CREATE TABLE chat.TRN_ChatFile (
    FileId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatFile PRIMARY KEY,
    PublicId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatFile_PublicId DEFAULT (NEWSEQUENTIALID()),
    ConversationId    BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatFile_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    MessageId         BIGINT         NULL CONSTRAINT FK_TRN_ChatFile_Message REFERENCES chat.TRN_ChatMessage (MessageId),
    UploadedByUserId  BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatFile_User REFERENCES auth.Users (UserId),
    OriginalName      NVARCHAR(200)  NOT NULL,
    Extension         VARCHAR(10)    NOT NULL,
    ContentType       VARCHAR(100)   NOT NULL,
    SizeBytes         BIGINT         NOT NULL,
    Sha256            CHAR(64)       NOT NULL,
    StorageKey        VARCHAR(80)    NOT NULL,   -- opaque relative path under Chat:StorageRoot, never sent to clients
    ScanStatus        VARCHAR(8)     NOT NULL CONSTRAINT DF_TRN_ChatFile_ScanStatus DEFAULT ('PENDING'),
    ScanAttempts      INT            NOT NULL CONSTRAINT DF_TRN_ChatFile_ScanAttempts DEFAULT (0),
    ScannedUtc        DATETIME2(3)   NULL,
    ScanDetail        NVARCHAR(200)  NULL,
    CreatedUtc        DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatFile_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    DeletedUtc        DATETIME2(3)   NULL,
    CONSTRAINT UQ_TRN_ChatFile_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatFile_ScanStatus CHECK (ScanStatus IN ('PENDING', 'CLEAN', 'BLOCKED', 'ERROR')),
    CONSTRAINT CK_TRN_ChatFile_Size CHECK (SizeBytes >= 0)
);
CREATE INDEX IX_TRN_ChatFile_Message ON chat.TRN_ChatFile (MessageId);
CREATE INDEX IX_TRN_ChatFile_Conversation ON chat.TRN_ChatFile (ConversationId, FileId DESC);
CREATE INDEX IX_TRN_ChatFile_Pending ON chat.TRN_ChatFile (FileId) WHERE ScanStatus = 'PENDING';
CREATE INDEX IX_TRN_ChatFile_StorageKey ON chat.TRN_ChatFile (StorageKey);
GO

ALTER TABLE chat.TRN_ChatConversation ADD CONSTRAINT FK_TRN_ChatConversation_ImageFile FOREIGN KEY (ImageFileId) REFERENCES chat.TRN_ChatFile (FileId);
GO

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT 'CHAT', 0
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings WHERE FeatureKey = 'CHAT');
GO

INSERT auth.Permissions (Code, Module, Description)
SELECT 'chat.use', 'Chat', N'Use Chat: direct and group conversations with colleagues, files, reactions and presence'
WHERE NOT EXISTS (SELECT 1 FROM auth.Permissions WHERE Code = 'chat.use');
GO

INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r JOIN auth.Permissions p ON p.Code = 'chat.use'
WHERE NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V028',
    N'Migration V028: chat schema (conversations, participants, messages, reactions, files, file types, preferences), permission chat.use, feature switch CHAT (off)',
    N'{"schema":"chat","tables":["chat.MST_ChatFileType","chat.MST_ChatUserPreference","chat.TRN_ChatConversation","chat.TRN_ChatConversationParticipant","chat.TRN_ChatMessage","chat.TRN_ChatMessageReaction","chat.TRN_ChatFile"],"permissions":["chat.use"],"features":["CHAT"]}');
