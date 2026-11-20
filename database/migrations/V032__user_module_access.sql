-- V032: Per-user module access (20 Nov 2026).
--   ADDITIVE ONLY: two new permissions, two new tables and one inline function in the existing auth schema. No existing table,
--   column, constraint or row is changed or removed.
--   chat.calls                 - make and receive audio calls in Chat; granted to every role that has chat.use (no change in behaviour).
--   chat.tasks                 - notes, tasks, reminders and My Day; granted to every role that has chat.use (no change in behaviour).
--   auth.ModulePermissions     - which permissions belong to which module (MEETINGS, CHAT, CALLS, TASKS). Administration
--                                permissions are never in a module, so module access can never remove them.
--   auth.UserModuleBlocks      - a row = that module is OFF for that user. No row = everything the user's roles allow.
--   auth.EffectivePermissions  - inline function: the user's permission codes from roles, minus the permissions of any module
--                                blocked for that user. Every permission check in the API uses it.
--   Permissions: the schema-level GRANT on auth (V009) covers the new tables and the function.
--   Requires V028 (chat.use).
--   Rollback: database/rollback/V032__user_module_access.rollback.sql (drops only what this script created).

INSERT auth.Permissions (Code, Module, Description)
SELECT v.c, 'Chat', v.d
FROM (VALUES
    ('chat.calls', N'Make and receive audio calls in Chat'),
    ('chat.tasks', N'Use notes, tasks, reminders and My Day')
) v (c, d)
WHERE NOT EXISTS (SELECT 1 FROM auth.Permissions p WHERE p.Code = v.c);
GO

-- Every role that can use Chat today keeps calls and tasks (they were part of chat.use until now).
INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT DISTINCT rp.RoleId, np.PermissionId
FROM auth.RolePermissions rp
JOIN auth.Permissions cu ON cu.PermissionId = rp.PermissionId AND cu.Code = 'chat.use'
CROSS JOIN auth.Permissions np
WHERE np.Code IN ('chat.calls', 'chat.tasks')
  AND NOT EXISTS (SELECT 1 FROM auth.RolePermissions x WHERE x.RoleId = rp.RoleId AND x.PermissionId = np.PermissionId);
GO

CREATE TABLE auth.ModulePermissions (
    ModuleCode     VARCHAR(20)    NOT NULL,
    PermissionId   INT            NOT NULL CONSTRAINT FK_ModulePermissions_Permission REFERENCES auth.Permissions (PermissionId),
    CONSTRAINT PK_ModulePermissions PRIMARY KEY (ModuleCode, PermissionId),
    CONSTRAINT CK_ModulePermissions_Module CHECK (ModuleCode IN ('MEETINGS', 'CHAT', 'CALLS', 'TASKS'))
);
CREATE INDEX IX_ModulePermissions_Permission ON auth.ModulePermissions (PermissionId, ModuleCode);
GO

INSERT auth.ModulePermissions (ModuleCode, PermissionId)
SELECT m.ModuleCode, p.PermissionId
FROM (VALUES
    ('MEETINGS', 'dashboard.view'),
    ('MEETINGS', 'calendar.view'),
    ('MEETINGS', 'customer.meetings.view'),
    ('MEETINGS', 'meetings.create'),
    ('MEETINGS', 'meetings.override.conflict'),
    ('MEETINGS', 'meetings.view.all'),
    ('MEETINGS', 'meetings.view.own'),
    ('MEETINGS', 'minutes.approve'),
    ('MEETINGS', 'recordings.view.own'),
    ('MEETINGS', 'recordings.view.team'),
    ('MEETINGS', 'recordings.view.department'),
    ('MEETINGS', 'recordings.view.all'),
    ('MEETINGS', 'recordings.download'),
    ('MEETINGS', 'recordings.delete'),
    ('MEETINGS', 'recordings.legalhold'),
    ('MEETINGS', 'reports.view'),
    ('CHAT',     'chat.use'),
    ('CALLS',    'chat.calls'),
    ('TASKS',    'chat.tasks')
) m (ModuleCode, PermissionCode)
JOIN auth.Permissions p ON p.Code = m.PermissionCode
WHERE NOT EXISTS (SELECT 1 FROM auth.ModulePermissions x WHERE x.ModuleCode = m.ModuleCode AND x.PermissionId = p.PermissionId);
GO

CREATE TABLE auth.UserModuleBlocks (
    UserId           BIGINT         NOT NULL CONSTRAINT FK_UserModuleBlocks_User REFERENCES auth.Users (UserId),
    ModuleCode       VARCHAR(20)    NOT NULL,
    CreatedUtc       DATETIME2(3)   NOT NULL CONSTRAINT DF_UserModuleBlocks_CreatedUtc DEFAULT (SYSUTCDATETIME()),
    CreatedByUserId  BIGINT         NULL,
    CONSTRAINT PK_UserModuleBlocks PRIMARY KEY (UserId, ModuleCode),
    CONSTRAINT CK_UserModuleBlocks_Module CHECK (ModuleCode IN ('MEETINGS', 'CHAT', 'CALLS', 'TASKS'))
);
GO

-- The user's permission codes: from roles, minus the permissions of modules switched off for the user.
-- Without blocks this returns exactly the same codes as the role query it replaces.
CREATE FUNCTION auth.EffectivePermissions (@userId BIGINT)
RETURNS TABLE
AS RETURN
    SELECT DISTINCT p.Code
    FROM auth.UserRoles ur
    JOIN auth.RolePermissions rp ON rp.RoleId = ur.RoleId
    JOIN auth.Permissions p ON p.PermissionId = rp.PermissionId
    WHERE ur.UserId = @userId
      AND NOT EXISTS (SELECT 1 FROM auth.UserModuleBlocks b
                      JOIN auth.ModulePermissions mp ON mp.ModuleCode = b.ModuleCode
                      WHERE b.UserId = @userId AND mp.PermissionId = p.PermissionId);
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V032',
    N'Migration V032: per-user module access (auth.ModulePermissions, auth.UserModuleBlocks, auth.EffectivePermissions), permissions chat.calls and chat.tasks',
    N'{"tables":["auth.ModulePermissions","auth.UserModuleBlocks"],"functions":["auth.EffectivePermissions"],"permissions":["chat.calls","chat.tasks"]}');
GO
