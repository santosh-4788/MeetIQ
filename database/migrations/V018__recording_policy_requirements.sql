-- V018: applies the recording Requirement decision the user approved in writing on 5 Nov 2026 (see CHANGELOG.md,
-- "business recording behaviour approved by the user") and left as a documented pending admin action since:
--   - Customer meetings (PLVC + general): Mandatory, auto-record as soon as the meeting goes live.
--   - Customer audio calls: Disabled (no telephony integration exists yet to actually capture an audio-only call).
--   - Internal employee meetings / Training & team meetings: Optional, host-controlled - already set this way, listed
--     here only so the full approved state is visible in one migration.
-- Consent mode, consent-from-all, notice wording/version and retention are untouched - those remain pending real
-- Legal/Compliance-approved values (see documentation/PRODUCTION_APPROVAL_CHECKLIST.md), not something this migration
-- invents or changes.

UPDATE rec.RecordingPolicies SET Requirement = 'MANDATORY', ModifiedUtc = SYSUTCDATETIME() WHERE PolicyCode = 'CUSTOMER_MEETING' AND Requirement <> 'MANDATORY';
UPDATE rec.RecordingPolicies SET Requirement = 'DISABLED', ModifiedUtc = SYSUTCDATETIME() WHERE PolicyCode = 'CUSTOMER_AUDIO_CALL' AND Requirement <> 'DISABLED';
GO
