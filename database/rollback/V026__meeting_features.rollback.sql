-- Rollback for V026 (optional meeting features). Run ONLY if V026 must be removed: it deletes the polls, private messages and
-- whiteboards created while the features were in use. Take a backup first. Turning the features off in
-- Administration -> Meeting features (or EMERGENCY_DISABLE) is the normal, data-preserving way to stop them.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE rp FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE p.Code = 'features.manage';
DELETE FROM auth.Permissions WHERE Code = 'features.manage';

DROP TABLE IF EXISTS mtg.MeetingWhiteboards;
DROP TABLE IF EXISTS mtg.PrivateMessages;
DROP TABLE IF EXISTS mtg.MeetingPollVotes;
DROP TABLE IF EXISTS mtg.MeetingPolls;
DROP TABLE IF EXISTS app.FeatureSettings;

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V026__meeting_features.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V026', N'Rollback of V026 (optional meeting features)');

COMMIT;
