-- Rollback for V030 (chat notes, tasks and reminders). Run ONLY if V030 must be removed: it deletes every person's notes, tasks,
-- reminders and custom categories, and the reminder notifications. Take a database backup first. Switching CHAT_TASKS off is the
-- normal, data-preserving way to stop the feature.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE FROM mtg.MeetingNotifications WHERE [Type] IN ('TASK_REMINDER', 'NOTE_REMINDER');
ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE', 'MISSED_CALL'));

DELETE FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_TASKS';
DROP TABLE IF EXISTS chat.TRN_ChatReminder;
IF OBJECT_ID(N'chat.FK_TRN_ChatTask_Note', N'F') IS NOT NULL ALTER TABLE chat.TRN_ChatTask DROP CONSTRAINT FK_TRN_ChatTask_Note;
DROP TABLE IF EXISTS chat.TRN_ChatNote;
DROP TABLE IF EXISTS chat.TRN_ChatTask;
DROP TABLE IF EXISTS chat.MST_TaskCategory;

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V030__chat_tasks.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V030', N'Rollback of V030 (chat notes, tasks and reminders)');

COMMIT;
