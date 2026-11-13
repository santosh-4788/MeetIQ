-- V025: who may read the API Documentation page (13 Nov 2026, owner: "this details show only to admin, if i give this access to anyone
--        then they got all the details on this page").
--   api.docs.view  - read Organisation -> System -> API Documentation (guide, endpoint reference, Swagger, OpenAPI download).
--                    Granted to Admin and SuperAdmin. It does NOT allow managing integrations or API keys (that stays integrations.manage).
--   ApiDocsViewer  - new role "API Documentation Viewer" (api.docs.view + dashboard.view, so the user lands on a page after sign-in).
--                    An administrator gives the page to anyone by adding this role to the user (Administration -> Users & roles).
--   Rollback: DELETE auth.UserRoles / auth.RolePermissions rows for the role and permission, then the role and the permission.

INSERT auth.Permissions (Code, Module, Description)
SELECT 'api.docs.view', 'System', N'Read the API Documentation page: integration guide, endpoints, examples, Swagger and the OpenAPI file (no API key management)'
WHERE NOT EXISTS (SELECT 1 FROM auth.Permissions WHERE Code = 'api.docs.view');

INSERT auth.Roles (Code, Name, Description, IsSystem)
SELECT 'ApiDocsViewer', N'API Documentation Viewer', N'Can read the API Documentation page (for developers of integrating portals). Cannot create or see API keys.', 1
WHERE NOT EXISTS (SELECT 1 FROM auth.Roles WHERE Code = 'ApiDocsViewer');
GO

INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r JOIN auth.Permissions p ON (r.Code IN ('Admin', 'SuperAdmin', 'ApiDocsViewer') AND p.Code = 'api.docs.view')
                                           OR (r.Code = 'ApiDocsViewer' AND p.Code = 'dashboard.view')
WHERE NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V025',
    N'Migration V025: permission api.docs.view (Admin, SuperAdmin) and role ApiDocsViewer (API Documentation Viewer)',
    N'{"permissions":["api.docs.view"],"roles":["ApiDocsViewer"]}');
