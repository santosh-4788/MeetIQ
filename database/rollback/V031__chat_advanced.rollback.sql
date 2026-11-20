-- Rollback for V031 (advanced chat). Run ONLY if V031 must be removed: it deletes scheduled messages that were not sent yet,
-- saved and pinned messages, @mentions, favourites, quiet-hours settings and the CHAT_MENTION / GROUP_ADDED notifications.
-- Messages that were already sent stay. Take a database backup first. Switching CHAT_ADVANCED off is the normal,
-- data-preserving way to stop the feature.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE FROM mtg.MeetingNotifications WHERE [Type] IN ('CHAT_MENTION', 'GROUP_ADDED');
ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL',
     'TASK_REMINDER', 'NOTE_REMINDER'));

DELETE FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_ADVANCED';

DROP TABLE IF EXISTS chat.TRN_ChatScheduledMessage;
DROP TABLE IF EXISTS chat.TRN_ChatSavedMessage;
DROP TABLE IF EXISTS chat.TRN_ChatPinnedMessage;
DROP TABLE IF EXISTS chat.TRN_ChatMessageMention;
DROP TABLE IF EXISTS chat.TRN_ChatFavourite;

-- Quiet-hours columns: CHECK and DEFAULT constraints first, then the columns.
IF OBJECT_ID(N'chat.CK_MST_ChatUserPreference_QuietCallPolicy', N'C') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT CK_MST_ChatUserPreference_QuietCallPolicy;
IF OBJECT_ID(N'chat.CK_MST_ChatUserPreference_QuietDays', N'C') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT CK_MST_ChatUserPreference_QuietDays;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietEnabled', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietEnabled;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietStart', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietStart;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietEnd', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietEnd;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietDays', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietDays;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietCallPolicy', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietCallPolicy;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietAllowMentions', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietAllowMentions;
IF OBJECT_ID(N'chat.DF_MST_ChatUserPreference_QuietAllowUrgent', N'D') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_QuietAllowUrgent;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietEnabled') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietEnabled;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietStart') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietStart;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietEnd') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietEnd;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietDays') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietDays;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietCallPolicy') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietCallPolicy;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietAllowMentions') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietAllowMentions;
IF COL_LENGTH(N'chat.MST_ChatUserPreference', N'QuietAllowUrgent') IS NOT NULL ALTER TABLE chat.MST_ChatUserPreference DROP COLUMN QuietAllowUrgent;

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V031__chat_advanced.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V031', N'Rollback of V031 (advanced chat)');

COMMIT;
