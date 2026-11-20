-- V029: Chat audio calls, Phase 3 (20 Nov 2026, documentation/CHAT_MODULE_PHASE1.md section 10).
--   ADDITIVE, plus one widened CHECK list:
--   chat.TRN_ChatCall              - one row per call: DIRECT or GROUP, its own audio-only LiveKit room, status and times.
--   chat.TRN_ChatCallParticipant   - who was invited / rang / accepted / declined / missed / was busy / left, and when.
--                                    Metadata only: calls are NEVER recorded and no audio is stored.
--   mtg.MeetingNotifications       - Type CHECK gains 'MISSED_CALL' (the bell shows missed calls). Every existing value is kept.
--   app.FeatureSettings 'CHAT_CALLS' - seeded OFF; calls also need CHAT on. EMERGENCY_DISABLE switches it off.
--   Requires V028.
--   Rollback: database/rollback/V029__chat_calls.rollback.sql.

CREATE TABLE chat.TRN_ChatCall (
    CallId            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TRN_ChatCall PRIMARY KEY,
    PublicId          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_TRN_ChatCall_PublicId DEFAULT (NEWSEQUENTIALID()),
    ConversationId    BIGINT         NULL CONSTRAINT FK_TRN_ChatCall_Conversation REFERENCES chat.TRN_ChatConversation (ConversationId),
    [Type]            VARCHAR(6)     NOT NULL,
    StartedByUserId   BIGINT         NOT NULL CONSTRAINT FK_TRN_ChatCall_StartedBy REFERENCES auth.Users (UserId),
    LiveKitRoomName   VARCHAR(64)    NOT NULL,
    [Status]          VARCHAR(9)     NOT NULL CONSTRAINT DF_TRN_ChatCall_Status DEFAULT ('RINGING'),
    CreatedUtc        DATETIME2(3)   NOT NULL CONSTRAINT DF_TRN_ChatCall_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    AnsweredUtc       DATETIME2(3)   NULL,
    EndedUtc          DATETIME2(3)   NULL,
    EndReason         VARCHAR(30)    NULL,
    RowVersion        ROWVERSION     NOT NULL,
    CONSTRAINT UQ_TRN_ChatCall_PublicId UNIQUE (PublicId),
    CONSTRAINT UQ_TRN_ChatCall_Room UNIQUE (LiveKitRoomName),
    CONSTRAINT CK_TRN_ChatCall_Type CHECK ([Type] IN ('DIRECT', 'GROUP')),
    CONSTRAINT CK_TRN_ChatCall_Status CHECK ([Status] IN ('RINGING', 'ACTIVE', 'ENDED', 'MISSED', 'DECLINED', 'FAILED'))
);
CREATE INDEX IX_TRN_ChatCall_Open ON chat.TRN_ChatCall (CallId) WHERE [Status] IN ('RINGING', 'ACTIVE');
CREATE INDEX IX_TRN_ChatCall_Conversation ON chat.TRN_ChatCall (ConversationId, CallId DESC);
GO

CREATE TABLE chat.TRN_ChatCallParticipant (
    CallId                 BIGINT       NOT NULL CONSTRAINT FK_TRN_ChatCallParticipant_Call REFERENCES chat.TRN_ChatCall (CallId),
    UserId                 BIGINT       NOT NULL CONSTRAINT FK_TRN_ChatCallParticipant_User REFERENCES auth.Users (UserId),
    InvitedByUserId        BIGINT       NULL,
    [State]                VARCHAR(9)   NOT NULL,
    InvitedUtc             DATETIME2(3) NOT NULL CONSTRAINT DF_TRN_ChatCallParticipant_InvitedUtc DEFAULT (SYSUTCDATETIME()),
    AnsweredUtc            DATETIME2(3) NULL,
    JoinedUtc              DATETIME2(3) NULL,   -- first seen connected to the call's audio room
    LastConnectedUtc       DATETIME2(3) NULL,   -- last time the server saw them connected
    LeftUtc                DATETIME2(3) NULL,
    CONSTRAINT PK_TRN_ChatCallParticipant PRIMARY KEY (CallId, UserId),
    CONSTRAINT CK_TRN_ChatCallParticipant_State CHECK ([State] IN ('RINGING', 'ACCEPTED', 'DECLINED', 'MISSED', 'BUSY', 'LEFT', 'CANCELLED'))
);
CREATE INDEX IX_TRN_ChatCallParticipant_User ON chat.TRN_ChatCallParticipant (UserId, CallId DESC) INCLUDE ([State]);
GO

ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL'));
GO

INSERT app.FeatureSettings (FeatureKey, IsEnabled)
SELECT 'CHAT_CALLS', 0
WHERE NOT EXISTS (SELECT 1 FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_CALLS');
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V029',
    N'Migration V029: chat audio calls (call + participant tables, metadata only, never recorded), notification type MISSED_CALL, feature switch CHAT_CALLS (off)',
    N'{"tables":["chat.TRN_ChatCall","chat.TRN_ChatCallParticipant"],"constraints":["CK_MeetingNotifications_Type +MISSED_CALL"],"features":["CHAT_CALLS"]}');
