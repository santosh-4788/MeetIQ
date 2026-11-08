-- V019: user-initiated recording deletion, on the user's explicit instruction (7 Nov 2026) - "add delete recording
-- option to user and maintain history in backend".
--   No new table: reuses rec.RecordingDeletions (V012), which already supports Source = 'MANUAL' in its CHECK
--   constraint (built for exactly this, never previously used - only Source = 'RETENTION' rows existed until now).
--   The recording row itself is never deleted: a purge sets Status = 'PURGED' and the row, rec.RecordingAccessLog
--   and app.AuditLog are all kept forever - "history in backend" is this existing, already-tested mechanism.
--   A recording's owner may request deletion of their own COMPLETED/FAILED recording; if the recording's policy
--   requires dual approval (DualApprovalForDeletion, on by default for all 4 policies today), the request waits
--   for two approvers exactly like a retention-triggered deletion already does - it is not auto-approved just
--   because a user asked. New permission recordings.delete lets Admin/SuperAdmin delete any recording they can
--   see immediately (still fully audited), the same trust level V017 already gave them for view-all/download.

INSERT auth.Permissions (Code, Module, Description) VALUES
 ('recordings.delete', 'Recordings', N'Delete any recording immediately, bypassing the deletion-approval workflow - every deletion is still audited and the record itself is kept (marked PURGED), never erased');
GO

INSERT auth.RolePermissions (RoleId, PermissionId)
SELECT r.RoleId, p.PermissionId
FROM auth.Roles r
CROSS JOIN auth.Permissions p
WHERE r.Code IN ('Admin', 'SuperAdmin') AND p.Code = 'recordings.delete'
  AND NOT EXISTS (SELECT 1 FROM auth.RolePermissions rp WHERE rp.RoleId = r.RoleId AND rp.PermissionId = p.PermissionId);
GO
