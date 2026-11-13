-- V024: identified / unidentified Customer - PLVC meetings (13 Nov 2026; plan in documentation/PLVC_BUSINESS_RULES.md, approved by the
--        product owner: "approved all the pending things related to recording ... go live").
--   "Skip details & start meeting" creates an INSTANT Customer - PLVC meeting with no Prarambh Main ID and no customer. Such a meeting is
--   UNIDENTIFIED: it is recorded and saved as normal (owner's decision), but never presented as an identified PLVC call and never given a
--   fabricated ID. Scheduled PLVC meetings and PLVC meetings with participants still need a customer (the API enforces the rest).
--
--   mtg.Meetings.PlvcIdentification  - COMPUTED (persisted) from Category + PrarambhMainId, so it can never disagree with the data:
--                                      NULL = not a PLVC meeting; IDENTIFIED = has a Prarambh Main ID; UNIDENTIFIED = has none.
--                                      Adding the ID later (authorised correction, audited by the API) makes it IDENTIFIED automatically.
--   CK_Meetings_CustomerRequired     - unchanged for every meeting except an INSTANT Customer - PLVC meeting, which may have no customer.
--
--   Rollback (only while no instant PLVC meeting without a customer exists - check first:
--     SELECT COUNT(*) FROM mtg.Meetings WHERE Category = 'CUSTOMER_PLVC' AND CustomerId IS NULL):
--     DROP INDEX IX_Meetings_PlvcIdentification ON mtg.Meetings;
--     ALTER TABLE mtg.Meetings DROP CONSTRAINT CK_Meetings_CustomerRequired;
--     ALTER TABLE mtg.Meetings ADD CONSTRAINT CK_Meetings_CustomerRequired CHECK (Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') OR CustomerId IS NOT NULL);
--     ALTER TABLE mtg.Meetings DROP COLUMN PlvcIdentification;
--     DELETE app.ApiIntegrationScopes WHERE Scope = 'meeting.plvc.unidentified'; then restore CK_ApiIntegrationScopes_Scope from V023.

ALTER TABLE mtg.Meetings ADD PlvcIdentification AS
    (CAST(CASE WHEN Category = 'CUSTOMER_PLVC' THEN CASE WHEN PrarambhMainId IS NULL THEN 'UNIDENTIFIED' ELSE 'IDENTIFIED' END END AS VARCHAR(20))) PERSISTED;
GO

ALTER TABLE mtg.Meetings DROP CONSTRAINT CK_Meetings_CustomerRequired;
ALTER TABLE mtg.Meetings ADD CONSTRAINT CK_Meetings_CustomerRequired
    CHECK (Category NOT IN ('CUSTOMER_PLVC', 'CUSTOMER_GENERAL') OR CustomerId IS NOT NULL OR (Category = 'CUSTOMER_PLVC' AND MeetingKind = 'INSTANT'));
CREATE INDEX IX_Meetings_PlvcIdentification ON mtg.Meetings (PlvcIdentification) WHERE Category = 'CUSTOMER_PLVC'; -- a filter cannot name a computed column

-- External API: creating an UNIDENTIFIED PLVC meeting must be requested explicitly AND granted (scope meeting.plvc.unidentified).
ALTER TABLE app.ApiIntegrationScopes DROP CONSTRAINT CK_ApiIntegrationScopes_Scope;
ALTER TABLE app.ApiIntegrationScopes ADD CONSTRAINT CK_ApiIntegrationScopes_Scope CHECK (Scope IN ('meeting.create', 'meeting.read', 'meeting.schedule', 'meeting.cancel',
    'recording.read', 'recording.download', 'meeting.json.read', 'webhook.manage', 'meeting.plvc.unidentified'));
GO

INSERT app.AuditLog ([Utc], ActorType, [Action], EntityType, EntityId, Summary, NewValuesJson)
VALUES (SYSUTCDATETIME(), 'SYSTEM', 'SCHEMA_CHANGED', 'Schema', 'V024',
    N'Migration V024: PLVC identification (computed IDENTIFIED/UNIDENTIFIED); an instant Customer - PLVC meeting may have no customer ("Skip details")',
    N'{"columns":["mtg.Meetings.PlvcIdentification"],"constraints":["CK_Meetings_CustomerRequired"]}');
