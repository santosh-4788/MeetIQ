-- V022: Prarambh Main ID for Customer - PLVC meetings (12 Nov 2026, business owner: "prarambhmainid only digit").
--   mtg.Meetings.PrarambhMainId      - mandatory for NEW PLVC meetings (enforced by the API - existing PLVC meetings have none, so
--                                      the database only enforces the format and "PLVC only", never "required").
--   rec.MeetingRecordings.PrarambhMainId - snapshot taken when a recording is created, so the recording keeps the ID it was made
--                                      under (recording metadata, file name, reports, external API).
--   Format: digits only, 1-30 characters (no length was specified; 30 is a storage cap, not a business rule). Stored exactly as
--   supplied - never padded, trimmed of zeros or generated.
--   Rollback (no data loss for other columns):
--     DROP INDEX IX_Meetings_PrarambhMainId ON mtg.Meetings; DROP INDEX IX_MeetingRecordings_PrarambhMainId ON rec.MeetingRecordings;
--     ALTER TABLE mtg.Meetings DROP CONSTRAINT CK_Meetings_PrarambhMainId, CK_Meetings_PrarambhCategory;
--     ALTER TABLE rec.MeetingRecordings DROP CONSTRAINT CK_MeetingRecordings_PrarambhMainId;
--     ALTER TABLE mtg.Meetings DROP COLUMN PrarambhMainId; ALTER TABLE rec.MeetingRecordings DROP COLUMN PrarambhMainId;

ALTER TABLE mtg.Meetings ADD PrarambhMainId VARCHAR(30) NULL;
ALTER TABLE rec.MeetingRecordings ADD PrarambhMainId VARCHAR(30) NULL;
GO

ALTER TABLE mtg.Meetings ADD CONSTRAINT CK_Meetings_PrarambhMainId
    CHECK (PrarambhMainId IS NULL OR (LEN(PrarambhMainId) BETWEEN 1 AND 30 AND PrarambhMainId NOT LIKE '%[^0-9]%'));
ALTER TABLE mtg.Meetings ADD CONSTRAINT CK_Meetings_PrarambhCategory
    CHECK (PrarambhMainId IS NULL OR Category = 'CUSTOMER_PLVC');
ALTER TABLE rec.MeetingRecordings ADD CONSTRAINT CK_MeetingRecordings_PrarambhMainId
    CHECK (PrarambhMainId IS NULL OR (LEN(PrarambhMainId) BETWEEN 1 AND 30 AND PrarambhMainId NOT LIKE '%[^0-9]%'));
CREATE INDEX IX_Meetings_PrarambhMainId ON mtg.Meetings (PrarambhMainId) WHERE PrarambhMainId IS NOT NULL;
CREATE INDEX IX_MeetingRecordings_PrarambhMainId ON rec.MeetingRecordings (PrarambhMainId) WHERE PrarambhMainId IS NOT NULL;
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V022',
    N'Migration V022: Prarambh Main ID (digits only) on meetings and recordings; required for new Customer - PLVC meetings by the API',
    N'{"columns":["mtg.Meetings.PrarambhMainId","rec.MeetingRecordings.PrarambhMainId"]}');
