-- V034: two more chat availability choices (24 Nov 2026): BRB ("Be right back") and APPEAR_OFFLINE ("Appear offline": colleagues
--   see the person as offline, without last seen or in-call / in-meeting).
--   chat.MST_ChatUserPreference.Availability: VARCHAR(10) -> VARCHAR(20) (APPEAR_OFFLINE is 14 characters) and the CHECK list is
--   widened; every existing value and the default ('AVAILABLE') are kept. No data changes.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT CK_MST_ChatUserPreference_Availability;
ALTER TABLE chat.MST_ChatUserPreference DROP CONSTRAINT DF_MST_ChatUserPreference_Availability;
ALTER TABLE chat.MST_ChatUserPreference ALTER COLUMN Availability VARCHAR(20) NOT NULL;
ALTER TABLE chat.MST_ChatUserPreference ADD CONSTRAINT DF_MST_ChatUserPreference_Availability DEFAULT ('AVAILABLE') FOR Availability;
ALTER TABLE chat.MST_ChatUserPreference ADD CONSTRAINT CK_MST_ChatUserPreference_Availability
    CHECK (Availability IN ('AVAILABLE', 'BUSY', 'DND', 'AWAY', 'BRB', 'APPEAR_OFFLINE'));

COMMIT TRANSACTION;
