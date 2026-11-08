-- V017: recording download access, on the user's explicit instruction (6 Nov 2026):
--   1. The employee who created/scheduled a meeting can play AND download that meeting's recording ("their own
--      bucket") - OwnerCanPlay was already on by default (V012); OwnerCanDownload was off by default and is now
--      turned on for all four policies. No permission grant needed for this: RecordingAccess.Decide already has
--      an independent (IsOwner && OwnerCanDownload) path.
--   2. Admin and SuperAdmin get full access to every recording, not just their own: recordings.view.all (visibility)
--      and recordings.download (download), both of which existed as permission codes since V010 but had never been
--      granted to any role at all - deliberately left for "the Compliance-approved access matrix", which still has
--      not been supplied. This grant is scoped to Admin/SuperAdmin only; team/department-level access and the
--      wider Compliance matrix remain exactly as pending as before.
-- Nothing here touches consent wording, retention periods or the recording/consent workflow itself.

UPDATE rec.RecordingPolicies SET OwnerCanDownload = 1, ModifiedUtc = SYSUTCDATETIME()
WHERE PolicyCode IN ('CUSTOMER_MEETING', 'CUSTOMER_AUDIO_CALL', 'INTERNAL_MEETING', 'TRAINING_TEAM_MEETING') AND OwnerCanDownload = 0;
GO

INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r
CROSS JOIN auth.Permissions p
WHERE r.Code IN ('Admin', 'SuperAdmin') AND p.Code IN ('recordings.view.all', 'recordings.download')
  AND NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO
