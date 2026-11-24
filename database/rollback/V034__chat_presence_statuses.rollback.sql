-- Rollback for V034 (BRB / APPEAR_OFFLINE). People who chose one of the two new values go back to AVAILABLE first, then the
-- original column size (VARCHAR(10)) and CHECK list are restored. Take a database backup first.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

UPDATE chat.MST_ChatUserPreference SET Availability = 'AVAILABLE' WHERE Availability IN ('BRB', 'APPEAR_OFFLINE');
ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT CK_MST_ChatUserPreference_Availability;
ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_Availability;
ALTER TABLE chat.MST_ChatUserPreference ALTER COLUMN Availability VARCHAR(10) NOT NULL;
ALTER TABLE chat.MST_ChatUserPreference ADD CONSTRAINT DF_MST_ChatUserPreference_Availability DEFAULT ('AVAILABLE') FOR Availability;
ALTER TABLE chat.MST_ChatUserPreference ADD CONSTRAINT CK_MST_ChatUserPreference_Availability
    CHECK (Availability IN ('AVAILABLE', 'BUSY', 'DND', 'AWAY'));
DELETE FROM dbo.SchemaMigrations WHERE ScriptName = 'V034__chat_presence_statuses.sql';

COMMIT TRANSACTION;
