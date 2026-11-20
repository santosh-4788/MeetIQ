-- Rollback for V029 (chat audio calls). Run ONLY if V029 must be removed: it deletes the call history and the missed-call
-- notifications. Take a database backup first. Switching CHAT_CALLS off is the normal, data-preserving way to stop calls.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE FROM mtg.MeetingNotifications WHERE [Type] = 'MISSED_CALL';
ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE'));

DELETE FROM app.FeatureSettings WHERE FeatureKey = 'CHAT_CALLS';
DROP TABLE IF EXISTS chat.TRN_ChatCallParticipant;
DROP TABLE IF EXISTS chat.TRN_ChatCall;

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V029__chat_calls.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V029', N'Rollback of V029 (chat audio calls)');

COMMIT;
