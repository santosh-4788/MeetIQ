-- Rollback for V027 (minutes of meeting). Run ONLY if V027 must be removed: it DELETES every set of minutes, action item and
-- version history written while the feature was in use. Take a backup first. Switching MEETING_MINUTES off in
-- Administration -> Meeting features is the normal, data-preserving way to stop the feature.
-- Must run BEFORE the V026 rollback (V027 adds a row to app.FeatureSettings, which V026 owns).
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DELETE rp FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE p.Code = 'minutes.approve';
DELETE FROM auth.Permissions WHERE Code = 'minutes.approve';

DROP TABLE IF EXISTS mtg.MeetingMinutesVersions;
DROP TABLE IF EXISTS mtg.MeetingMinutesActionItems;
DROP TABLE IF EXISTS mtg.MeetingMinutes;

IF OBJECT_ID('app.FeatureSettings', 'U') IS NOT NULL
    DELETE FROM app.FeatureSettings WHERE FeatureKey = 'MEETING_MINUTES';

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V027__meeting_minutes.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V027', N'Rollback of V027 (minutes of meeting)');

COMMIT;
