-- V011: Phase 3 (meetings, calendar, notifications).
-- 1. Notification type RESPONSE: the host is told when a participant accepts, declines or answers "tentative".
--    V005 had no type for RSVP answers.
-- 2. PublicId on mtg.MeetingNotifications and mtg.EmployeeAvailability: the API addresses rows by PublicId only
--    (internal ids never leave the database), and both tables are now edited through the API.

ALTER TABLE mtg.MeetingNotifications DROP CONSTRAINT CK_MeetingNotifications_Type;
ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT CK_MeetingNotifications_Type CHECK ([Type] IN
    ('INVITATION', 'REMINDER', 'RESCHEDULED', 'CANCELLED', 'STARTING_SOON', 'RECORDING_AVAILABLE', 'RECORDING_FAILED', 'ADMIT_REQUEST', 'RESPONSE'));
GO

ALTER TABLE mtg.MeetingNotifications ADD PublicId UNIQUEIDENTIFIER NOT NULL
    CONSTRAINT DF_MeetingNotifications_PublicId DEFAULT (NEWSEQUENTIALID());
ALTER TABLE mtg.EmployeeAvailability ADD PublicId UNIQUEIDENTIFIER NOT NULL
    CONSTRAINT DF_EmployeeAvailability_PublicId DEFAULT (NEWSEQUENTIALID());
GO

ALTER TABLE mtg.MeetingNotifications ADD CONSTRAINT UQ_MeetingNotifications_PublicId UNIQUE (PublicId);
ALTER TABLE mtg.EmployeeAvailability ADD CONSTRAINT UQ_EmployeeAvailability_PublicId UNIQUE (PublicId);
GO
