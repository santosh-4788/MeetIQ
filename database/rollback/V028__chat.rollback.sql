-- Rollback for V028 (Chat, Phase 2). Run ONLY if V028 must be removed: it deletes every chat conversation, message, reaction and
-- file record (the files on disk under Chat:StorageRoot stay and can be deleted by hand). Take a database backup first.
-- Switching CHAT off in Administration -> Meeting features is the normal, data-preserving way to stop Chat.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE rp FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE p.Code = 'chat.use';
DELETE FROM auth.Permissions WHERE Code = 'chat.use';
DELETE FROM app.FeatureSettings WHERE FeatureKey = 'CHAT';

ALTER TABLE chat.TRN_ChatConversation DROP CONSTRAINT IF EXISTS FK_TRN_ChatConversation_ImageFile;
DROP TABLE IF EXISTS chat.TRN_ChatMessageReaction;
DROP TABLE IF EXISTS chat.TRN_ChatFile;
DROP TABLE IF EXISTS chat.TRN_ChatMessage;
DROP TABLE IF EXISTS chat.TRN_ChatConversationParticipant;
DROP TABLE IF EXISTS chat.TRN_ChatConversation;
DROP TABLE IF EXISTS chat.MST_ChatUserPreference;
DROP TABLE IF EXISTS chat.MST_ChatFileType;
DROP SCHEMA IF EXISTS chat;

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V028__chat.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V028', N'Rollback of V028 (chat)');

COMMIT;
