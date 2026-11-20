-- Rollback for V032 (per-user module access). Run ONLY if V032 must be removed: every user's module settings are lost and all
-- users get back everything their roles allow; the permissions chat.calls and chat.tasks are removed from every role (calls and
-- tasks then follow chat.use again only after the API is also rolled back). Take a database backup first.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

DROP FUNCTION IF EXISTS auth.EffectivePermissions;
DROP TABLE IF EXISTS auth.UserModuleBlocks;
DROP TABLE IF EXISTS auth.ModulePermissions;

DELETE rp FROM auth.RolePermissions rp JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId WHERE p.Code IN ('chat.calls', 'chat.tasks');
DELETE FROM auth.Permissions WHERE Code IN ('chat.calls', 'chat.tasks');

DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V032__user_module_access.sql';

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V032', N'Rollback of V032 (per-user module access)');

COMMIT;
