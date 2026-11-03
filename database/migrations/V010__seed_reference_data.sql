-- V010: reference data only. NO users, passwords or keys are seeded (first SuperAdmin via /setup).
-- Role -> permission defaults are editable by administrators.
-- Recording access beyond the employee's own recordings (team/department/all/download/legal hold) is
-- deliberately NOT granted to any role: it waits for the Compliance-approved access matrix
-- (PRODUCTION_APPROVAL_CHECKLIST.md item 14).

INSERT auth.Roles (Code, Name, Description, IsSystem) VALUES
 ('SuperAdmin',        N'Super Administrator', N'Full platform administration, including security and roles', 1),
 ('Admin',             N'Administrator',       N'Day-to-day administration: users, masters, settings, operations', 1),
 ('ComplianceAuditor', N'Compliance Auditor',  N'Read-only audit and reports', 1),
 ('DepartmentHead',    N'Department Head',     N'Employee capabilities plus department reports', 1),
 ('TeamLeader',        N'Team Leader',         N'Employee capabilities for a team leader', 1),
 ('Employee',          N'Employee',            N'Schedule and attend meetings; own recordings', 1),
 ('HRMaster',          N'HR Master',           N'Employee and organisation masters', 1);

INSERT auth.Permissions (Code, Module, Description) VALUES
 ('dashboard.view',             'Dashboard',     N'View the dashboard'),
 ('meetings.view.own',          'Meetings',      N'View meetings the user organises or attends'),
 ('meetings.view.all',          'Meetings',      N'View all meetings'),
 ('meetings.create',            'Meetings',      N'Schedule, reschedule and cancel own meetings'),
 ('meetings.override.conflict', 'Meetings',      N'Book despite a calendar conflict (always audited)'),
 ('calendar.view',              'Calendar',      N'View the meeting calendar'),
 ('customer.meetings.view',     'Customer',      N'View and schedule customer meetings'),
 ('recordings.view.own',        'Recordings',    N'View recordings of meetings the user created'),
 ('recordings.view.team',       'Recordings',    N'View recordings of the user''s team (pending Compliance matrix)'),
 ('recordings.view.department', 'Recordings',    N'View recordings of the user''s department (pending Compliance matrix)'),
 ('recordings.view.all',        'Recordings',    N'View all recordings (pending Compliance matrix)'),
 ('recordings.download',        'Recordings',    N'Download recording files (pending Compliance matrix)'),
 ('recordings.legalhold',       'Recordings',    N'Place or release a legal hold (pending Compliance matrix)'),
 ('notifications.view',         'Notifications', N'View the notification centre'),
 ('reports.view',               'Reports',       N'View and export reports'),
 ('employees.manage',           'Employees',     N'Create, edit and deactivate employees'),
 ('org.manage',                 'Organisation',  N'Manage departments, designations, branches and teams'),
 ('users.manage',               'Administration',N'Manage user accounts and role assignments'),
 ('roles.manage',               'Administration',N'Edit roles and the permission matrix'),
 ('admin.settings',             'Administration',N'Edit system settings'),
 ('admin.security',             'Administration',N'Edit security settings and revoke sessions'),
 ('admin.ops',                  'Administration',N'View system health and background services'),
 ('audit.view',                 'Administration',N'View the audit log');

DECLARE @map TABLE (RoleCode VARCHAR(50), PermissionCode VARCHAR(100));
INSERT @map (RoleCode, PermissionCode)
SELECT r.RoleCode, p.value
FROM (VALUES
  ('Employee',          'dashboard.view,meetings.view.own,meetings.create,calendar.view,customer.meetings.view,recordings.view.own,notifications.view'),
  ('TeamLeader',        'dashboard.view,meetings.view.own,meetings.create,calendar.view,customer.meetings.view,recordings.view.own,notifications.view'),
  ('DepartmentHead',    'dashboard.view,meetings.view.own,meetings.create,calendar.view,customer.meetings.view,recordings.view.own,notifications.view,reports.view'),
  ('HRMaster',          'dashboard.view,meetings.view.own,meetings.create,calendar.view,recordings.view.own,notifications.view,employees.manage,org.manage'),
  ('ComplianceAuditor', 'dashboard.view,notifications.view,reports.view,audit.view'),
  ('Admin',             'dashboard.view,meetings.view.own,meetings.create,meetings.override.conflict,calendar.view,customer.meetings.view,recordings.view.own,notifications.view,reports.view,employees.manage,org.manage,users.manage,admin.settings,admin.ops,audit.view'),
  ('SuperAdmin',        'dashboard.view,meetings.view.own,meetings.view.all,meetings.create,meetings.override.conflict,calendar.view,customer.meetings.view,recordings.view.own,notifications.view,reports.view,employees.manage,org.manage,users.manage,roles.manage,admin.settings,admin.security,admin.ops,audit.view')
) AS r (RoleCode, Perms)
CROSS APPLY STRING_SPLIT(r.Perms, ',') AS p;

-- Fails loudly (FK/NULL) if a code in the map is misspelt.
INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT (SELECT RoleId FROM auth.Roles WHERE Code = m.RoleCode),
       (SELECT PermissionId FROM auth.Permissions WHERE Code = m.PermissionCode)
FROM @map m;

INSERT app.SystemSettings (SettingKey, SettingValue, ValueType, Category, Description) VALUES
 ('App.DefaultTimeZone',         N'Asia/Kolkata', 'STRING', 'General',  N'Default display time zone (IANA id)'),
 ('Security.SessionIdleMinutes', N'30',           'INT',    'Security', N'Idle session timeout; matches the web client');
GO
