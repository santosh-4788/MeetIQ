SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;

DECLARE @roleId INT = (SELECT RoleId FROM auth.Roles WHERE Code = 'SuperAdmin');
DECLARE @permId INT = (SELECT PermissionId FROM auth.Permissions WHERE Code = 'recordings.view.all');
DECLARE @actor BIGINT = 1; -- santosh.yadav@oneinsure.com, the SuperAdmin account reporting the gap

IF NOT EXISTS (SELECT 1 FROM auth.RolePermissions WHERE RoleId = @roleId AND PermissionId = @permId)
BEGIN
    INSERT auth.RolePermissions (RoleId, PermissionId, GrantedByUserId) VALUES (@roleId, @permId, @actor);
    INSERT app.AuditLog (ActorType, ActorUserId, [Action], EntityType, EntityId, Summary, NewValuesJson, IsPrivileged)
    VALUES ('USER', @actor, 'ROLE_PERMISSIONS_CHANGED', 'Role', 'SuperAdmin',
            'recordings.view.all granted to SuperAdmin (seed-data gap: every other broad admin permission - audit.view, admin.ops, roles.manage, users.manage - was already granted; recordings.view.all was left out of V010''s seed, with no role able to see every recording)',
            N'{"permission":"recordings.view.all","action":"grant"}', 1);
END

COMMIT TRANSACTION;
