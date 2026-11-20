-- V031: Chat Phase 5 - advanced chat features (20 Nov 2026, documentation/CHAT_MODULE_PHASE1.md section 17, requirement section 17).
--   ADDITIVE, plus one widened CHECK list and new columns (with defaults) on an existing chat table:
--   chat.TRN_ChatScheduledMessage  - messages a person schedules for later; sent exactly once by the server
--                                    (ChatScheduledMessageWorker, ClientMessageId = PublicId so a retry never duplicates).
--   chat.TRN_ChatSavedMessage      - messages a person saved ("starred"); PRIVATE to that person.
--   chat.TRN_ChatPinnedMessage     - messages pinned in a conversation (visible to its members), at most 20 per conversation (API).
--   chat.TRN_ChatMessageMention    - @mentions of a message (one row per mentioned person, or one IsAll row for @all).
--   chat.TRN_ChatFavourite         - a person's favourite colleagues (ordered); PRIVATE to that person.
--   chat.MST_ChatUserPreference    - gains quiet-hours columns (all with defaults; existing rows get the defaults).
--   mtg.MeetingNotifications       - Type CHECK gains 'CHAT_MENTION' and 'GROUP_ADDED'. Every existing value is kept.
--   app.FeatureSettings 'CHAT_ADVANCED' - seeded OFF; also needs CHAT on. EMERGENCY_DISABLE switches it off.
--   Permissions: the schema-level GRANT on chat (V028) covers the new tables.
--   Requires V028, V029 and V030.
--   Rollback: database/rollback/V031__chat_advanced.rollback.sql.

CREATE TABLE chat.TRN_ChatScheduledMessage (
    ScheduledMessageId  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatScheduledMessage PRIMARY KEY,
    PublicId            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatScheduledMessage_PublicId DEFAULT (NEWSEQUENTIALID()),
    ConversationId      BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatScheduledMessage_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    SenderUserId        BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatScheduledMessage_Sender REFERENCES auth.Users (UserId),
    Body                NVARCHAR(4000) NOT NULL,
    ReplyToMessageId    BIGINT         NULL CONSTRAINT FK_TRN_ChatScheduledMessage_ReplyTo REFERENCES chat.TRN_ChatMessage (MessageId),
    SendAtUtc           DATETIME2(3)   NOT NULL,
    [State]             VARCHAR(9)     NOT NULL CONSTRAINT DF_TRN_ChatScheduledMessage_State DEFAULT ('PENDING'),
    SentMessageId       BIGINT         NULL CONSTRAINT FK_TRN_ChatScheduledMessage_Sent REFERENCES chat.TRN_ChatMessage (MessageId),
    FailureReason       NVARCHAR(200)  NULL,
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatScheduledMessage_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    UpdatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatScheduledMessage_UpdatedUtc DEFAULT (SYSUTCDATETIME()),
    [RowVersion]        ROWVERSION     NOT NULL,
    CONSTRAINT UQ_TRN_ChatScheduledMessage_PublicId UNIQUE (PublicId),
    CONSTRAINT CK_TRN_ChatScheduledMessage_State CHECK ([State] IN ('PENDING', 'SENDING', 'SENT', 'CANCELLED', 'FAILED')),
    CONSTRAINT CK_TRN_ChatScheduledMessage_Body CHECK (LEN(Body) > 0)
);
CREATE INDEX IX_TRN_ChatScheduledMessage_Due ON chat.TRN_ChatScheduledMessage ([State], SendAtUtc);
CREATE INDEX IX_TRN_ChatScheduledMessage_Sender ON chat.TRN_ChatScheduledMessage (SenderUserId, [State], SendAtUtc);
GO

CREATE TABLE chat.TRN_ChatSavedMessage (
    SavedMessageId      BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatSavedMessage PRIMARY KEY,
    UserId              BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatSavedMessage_User REFERENCES auth.Users (UserId),
    MessageId           BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatSavedMessage_Message REFERENCES chat.TRN_ChatMessage (MessageId),
    SavedUtc            DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatSavedMessage_SavedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatSavedMessage_UserMessage UNIQUE (UserId, MessageId)
);
CREATE INDEX IX_TRN_ChatSavedMessage_Message ON chat.TRN_ChatSavedMessage (MessageId);
GO

CREATE TABLE chat.TRN_ChatPinnedMessage (
    PinnedMessageId     BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatPinnedMessage PRIMARY KEY,
    ConversationId      BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatPinnedMessage_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    MessageId           BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatPinnedMessage_Message REFERENCES chat.TRN_ChatMessage (MessageId),
    PinnedByUserId      BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatPinnedMessage_PinnedBy REFERENCES auth.Users (UserId),
    PinnedUtc           DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatPinnedMessage_PinnedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatPinnedMessage_ConversationMessage UNIQUE (ConversationId, MessageId)
);
CREATE INDEX IX_TRN_ChatPinnedMessage_Message ON chat.TRN_ChatPinnedMessage (MessageId);
GO

CREATE TABLE chat.TRN_ChatMessageMention (
    MentionId           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatMessageMention PRIMARY KEY,
    MessageId           BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatMessageMention_Message REFERENCES chat.TRN_ChatMessage (MessageId),
    MentionedUserId     BIGINT         NULL CONSTRAINT FK_TRN_ChatMessageMention_User REFERENCES auth.Users (UserId),
    IsAll               BIT            NOT NULL CONSTRAINT DF_TRN_ChatMessageMention_IsAll DEFAULT (0),
    CONSTRAINT CK_TRN_ChatMessageMention_Target CHECK ((IsAll = 1 AND MentionedUserId IS NULL) OR (IsAll = 0 AND MentionedUserId IS NOT NULL))
);
CREATE INDEX IX_TRN_ChatMessageMention_User ON chat.TRN_ChatMessageMention (MentionedUserId, MessageId);
CREATE INDEX IX_TRN_ChatMessageMention_Message ON chat.TRN_ChatMessageMention (MessageId);
GO

CREATE TABLE chat.TRN_ChatFavourite (
    FavouriteId         BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatFavourite PRIMARY KEY,
    UserId              BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatFavourite_User REFERENCES auth.Users (UserId),
    FavouriteUserId     BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatFavourite_Favourite REFERENCES auth.Users (UserId),
    SortOrder           INT            NOT NULL CONSTRAINT DF_TRN_ChatFavourite_SortOrder DEFAULT (0),
    CreatedUtc          DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatFavourite_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_TRN_ChatFavourite_UserFavourite UNIQUE (UserId, FavouriteUserId),
    CONSTRAINT CK_TRN_ChatFavourite_NotSelf CHECK (UserId <> FavouriteUserId)
);
GO

ALTER TABLE chat.MST_ChatUserPreference ADD
    QuietEnabled        BIT          NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietEnabled DEFAULT (0),
    QuietStart          TIME(0)      NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietStart DEFAULT ('22:00'),
    QuietEnd            TIME(0)      NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietEnd DEFAULT ('07:00'),
    QuietDays           TINYINT      NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietDays DEFAULT (127),   -- bit 0 = Monday ... bit 6 = Sunday
    QuietCallPolicy     VARCHAR(10)  NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietCallPolicy DEFAULT ('SILENT'),
    QuietAllowMentions  BIT          NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietAllowMentions DEFAULT (1),
    QuietAllowUrgent    BIT          NOT NULL CONSTRAINT DF_MST_ChatUserPreference_QuietAllowUrgent DEFAULT (1);
GO

ALTER TABLE chat.MST_ChatUserPreference ADD
    CONSTRAINT CK_MST_ChatUserPreference_QuietCallPolicy CHECK (QuietCallPolicy IN ('RING', 'SILENT')),
    CONSTRAINT CK_MST_ChatUserPreference_QuietDays CHECK (QuietDays <= 127);
GO

ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL',
     'TASK_REMINDER', 'NOTE_REMINDER', 'CHAT_MENTION', 'GROUP_ADDED'));
GO

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT 'CHAT_ADVANCED', 0
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_ADVANCED');
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V031',
    N'Migration V031: advanced chat (scheduled, saved and pinned messages, @mentions, favourites, quiet hours), notification types CHAT_MENTION / GROUP_ADDED, feature switch CHAT_ADVANCED (off)',
    N'{"tables":["chat.TRN_ChatScheduledMessage","chat.TRN_ChatSavedMessage","chat.TRN_ChatPinnedMessage","chat.TRN_ChatMessageMention","chat.TRN_ChatFavourite"],"columns":["chat.MST_ChatUserPreference.Quiet*"],"constraints":["CK_MeetingNotifications_Type +CHAT_MENTION +GROUP_ADDED"],"features":["CHAT_ADVANCED"]}');
