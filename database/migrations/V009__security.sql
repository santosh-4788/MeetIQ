-- V009: database roles. Logins are NOT created here: deployment maps a Windows service account
-- (recommended: gMSA, no password) to these roles. See database/README.md.
--   oic_app_role       API, Worker and Recorder: DML + EXECUTE on application schemas, no DDL.
--   oic_migrator_role  deployment only: DDL. Not used at runtime.

CREATE ROLE oic_app_role AUTHORIZATION dbo;
GO
CREATE ROLE oic_migrator_role AUTHORIZATION dbo;
GO

GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::auth TO oic_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::org  TO oic_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::crm  TO oic_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::mtg  TO oic_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::rec  TO oic_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, REFERENCES ON SCHEMA::app  TO oic_app_role;
GRANT EXECUTE ON TYPE::mtg.EmployeeIdList TO oic_app_role;

-- Append-only evidence tables.
DENY UPDATE, DELETE ON mtg.MeetingConsent     TO oic_app_role;
DENY UPDATE, DELETE ON rec.RecordingAccessLog TO oic_app_role;
DENY UPDATE, DELETE ON app.AuditLog           TO oic_app_role;

-- The migration history is not the application's business.
DENY SELECT, INSERT, UPDATE, DELETE ON dbo.SchemaMigrations TO oic_app_role;

ALTER ROLE db_ddladmin    ADD MEMBER oic_migrator_role;
ALTER ROLE db_datareader  ADD MEMBER oic_migrator_role;
ALTER ROLE db_datawriter  ADD MEMBER oic_migrator_role;
GO
