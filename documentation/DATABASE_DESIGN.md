# Database Design — OneInsureVideoMeetingDB

**Status:** design for review (Phase 1). DDL/migration scripts are written in Phase 2 after approval.
**Engine:** Microsoft SQL Server 2019+ (dev: SQL Server Express on the developer PC).

> **Revision 1.2 (1 Nov 2026):** V011 adds the `RESPONSE` notification type and `PublicId` on `mtg.MeetingNotifications` and `mtg.EmployeeAvailability`. V012 adds `rec.RecordingPolicies`, `rec.RecordingPolicyCategories` and `rec.RecordingDeletions`, plus policy-snapshot, storage, retention and crash-recovery columns on `rec.MeetingRecordings` and `rec.RecordingJobs`. Total: 38 tables. Both are applied to `Oneinsure_v`.
>
> **Revision 1.1 (31 Oct 2026), made while writing the Phase 2 DDL (`database/migrations`):**
> 1. Platform schema renamed **`sys` → `app`**. SQL Server reserves `sys`; `CREATE TABLE sys.X` fails even for sysadmin (Msg 2760, verified on LocalDB 2019).
> 2. `auth.UserSessions` gains `TokenHash BINARY(32)`: the cookie value is stored only as a SHA-256 hash. `SessionId` stays the non-secret handle shown under "active sessions".
> 3. `mtg.MeetingParticipants` gains `GuestName` and `GuestEmail` (the `GUEST` type had no identifying columns).
> 4. Added integrity rules: meeting and recording owners are immutable (triggers); `rec.MeetingRecordings.OwnerEmployeeId` must equal the meeting's `CreatedByEmployeeId`; `FAILED` needs a `FailureReason`; `StorageKey` must be a relative path; consent, audit and access-log rows cannot be updated (trigger + `DENY`).
> 5. Logins are not created by scripts. Database roles `oic_app_role` and `oic_migrator_role` are created, and deployment maps a Windows service account (gMSA recommended) to them. No SQL passwords are used.
> 6. Working-hours checks run in the API, because rules use IANA time zones. `usp_CheckAvailability` covers meetings, leave and blocked time. The `rpt.usp_*` report procedures are deferred to Phase 5.

## 1. Conventions

- Schemas: `auth` (identity), `org` (organisation masters), `crm` (customers), `mtg` (meetings), `rec` (recording), `app` (platform; was `sys`, see revision note).
- PK: `BIGINT IDENTITY` named `<Entity>Id`. Records exposed to the outside also get `PublicId UNIQUEIDENTIFIER DEFAULT NEWSEQUENTIALID()` with a unique index. **Internal ids never appear in URLs.**
- Time: `DATETIME2(3)`, always **UTC**, suffixed `Utc`. Display time zone is per user (default `Asia/Kolkata`).
- Audit columns on mutable tables: `CreatedUtc, CreatedByUserId, ModifiedUtc, ModifiedByUserId, RowVersion ROWVERSION` (optimistic concurrency).
- Soft delete for masters: `IsActive BIT`, `DeactivatedUtc`. Transactional rows are never hard-deleted, except by the retention job.
- Enumerations are `VARCHAR(30)` with `CHECK` constraints, so they stay readable in reports.
- Append-only tables (`app.AuditLog`, `mtg.MeetingConsent`, `rec.RecordingAccessLog`): the app login gets `DENY UPDATE, DELETE`.
- App login `oic_app`: `db_datareader`/`db_datawriter` on its schemas + `EXECUTE` on procedures. No DDL. A separate `oic_migrator` login runs migrations.

## 2. Tables (35 tables + 2 views)

### auth — identity & access (9)

| Table | Key columns | Notes |
|---|---|---|
| **Users** | UserId, PublicId, EmployeeId FK NULL, Email (unique), EmployeeCode (unique), PasswordHash, SecurityStamp, MustChangePassword, FailedLoginCount, LockoutEndUtc, IsLocked, MfaEnabled, TimeZoneId, LastLoginUtc, IsActive | Login by email **or** employee code |
| **Roles** | RoleId, Code (unique), Name, Description, IsSystem | Seed: SuperAdmin, Admin, ComplianceAuditor, DepartmentHead, TeamLeader, Employee, HRMaster |
| **Permissions** | PermissionId, Code (unique, e.g. `recordings.view.team`), Module, Description | Seeded from code |
| **RolePermissions** | RoleId, PermissionId (PK both) | |
| **UserRoles** | UserId, RoleId (PK both), AssignedUtc, AssignedByUserId | |
| **UserSessions** | SessionId (GUID PK), UserId, CreatedUtc, LastSeenUtc, ExpiresUtc, AbsoluteExpiryUtc, IpAddress, UserAgent, RevokedUtc, RevokedReason | Server-side sessions → "active sessions" + revoke |
| **UserMfaMethods** | MfaMethodId, UserId, Type (`TOTP`/`EMAIL_OTP`), SecretEncrypted (DPAPI/AES), IsPrimary, VerifiedUtc, RecoveryCodesHash | |
| **PasswordResetTokens** | TokenId, UserId, TokenHash (SHA-256), ExpiresUtc, UsedUtc, RequestIp | Single-use, 30 min |
| **LoginAttempts** | AttemptId, LoginName, UserId NULL, Succeeded, FailureReason, IpAddress, UserAgent, AttemptUtc | Lockout + security reports |

### org — organisation masters (6)

| Table | Key columns | Notes |
|---|---|---|
| **Employees** | EmployeeId, PublicId, EmployeeCode (unique), FirstName, LastName, DisplayName, OfficialEmail (unique), Mobile, DepartmentId, DesignationId, BranchId, ReportingManagerId (self FK), DateOfJoining, PhotoPath, IsActive | Independent from Prarambh. `ExternalRef` column reserved for future mapping |
| **Departments** | DepartmentId, Code, Name, HeadEmployeeId NULL, ParentDepartmentId NULL, IsActive | |
| **Designations** | DesignationId, Code, Name, Level, IsActive | |
| **Branches** | BranchId, Code, Name, City, State, TimeZoneId, Address, IsActive | |
| **Teams** | TeamId, Code, Name, DepartmentId, TeamLeaderEmployeeId, IsActive | |
| **TeamMembers** | TeamId, EmployeeId (PK both), FromUtc, ToUtc | Team scope for TeamLeader recording access |

### crm — customer participants (1)

| Table | Key columns | Notes |
|---|---|---|
| **Customers** | CustomerId, PublicId, CustomerRef (unique, business id), FullName, Email, Mobile, PolicyNumber NULL, ReferenceNumber NULL, AssignedEmployeeId, Notes, IsActive | No login. PII is minimised and never placed in recording file paths |

### mtg — meetings, calendar, notifications (11)

| Table | Key columns | Notes |
|---|---|---|
| **Meetings** | MeetingId, PublicId, MeetingCode (unique, `OIC-YYMMDD-XXXX`, support only), Title, Description, Agenda, Category (`INTERNAL_1_1`,`GROUP`,`TEAM`,`DEPARTMENT`,`MANAGEMENT`,`TRAINING`,`REVIEW`,`CUSTOMER_PLVC`,`CUSTOMER_GENERAL`), **CreatedByEmployeeId (immutable owner)**, HostEmployeeId, DepartmentId NULL, CustomerId NULL, PolicyNumber NULL, Purpose, ScheduledStartUtc, ScheduledEndUtc, TimeZoneId, ActualStartUtc, ActualEndUtc, Status (`DRAFT`,`SCHEDULED`,`LIVE`,`COMPLETED`,`CANCELLED`,`EXPIRED`,`INCOMPLETE`), RecordingPolicy (`NONE`,`OPTIONAL`,`REQUIRED`), WaitingRoomEnabled, IsLocked, LiveKitRoomName (unique, opaque), ScheduleVersion INT, CancelReason, OverrideConflictReason NULL | Aggregate root (BRD p.11) |
| **MeetingParticipants** | ParticipantId, MeetingId, ParticipantType (`EMPLOYEE`,`CUSTOMER`,`GUEST`), EmployeeId NULL, CustomerId NULL, Role (`HOST`,`COHOST`,`ATTENDEE`), ResponseStatus (`PENDING`,`ACCEPTED`,`DECLINED`,`TENTATIVE`), IsRequired, LiveKitIdentity (opaque, unique per meeting), CanPublish, CanScreenShare | `CHECK` exactly one of EmployeeId/CustomerId for those types |
| **MeetingInvitations** | InvitationId, MeetingId, ParticipantId, TokenHash (SHA-256, unique), ExpiresUtc, RevokedUtc, RevokeReason, UseCount, MaxUses, LastUsedUtc, OtpRequired | BRD `VM_Invitation`. Raw token only appears in the email |
| **MeetingReminders** | ReminderId, MeetingId, ParticipantId, OffsetMinutes, Channel (`IN_APP`,`EMAIL`,`BROWSER`), DueUtc, ScheduleVersion, Status (`PENDING`,`CLAIMED`,`SENT`,`FAILED`,`CANCELLED`), Attempts, NextAttemptUtc, LeaseOwner, LeaseExpiresUtc, LastError | **Unique (MeetingId, ParticipantId, OffsetMinutes, Channel, ScheduleVersion)** → no duplicates |
| **MeetingNotifications** | NotificationId, RecipientUserId, MeetingId NULL, Type (`INVITATION`,`REMINDER`,`RESCHEDULED`,`CANCELLED`,`STARTING_SOON`,`RECORDING_AVAILABLE`,`RECORDING_FAILED`,`ADMIT_REQUEST`), Title, Body, LinkPath, IsRead, ReadUtc, CreatedUtc | Notification centre (BRD `VM_Notification`) |
| **MeetingAttendance** | AttendanceId, MeetingId, ParticipantId, JoinedUtc, LeftUtc, DurationSeconds (computed), LeaveReason, ClientInfo, NetworkQualityAvg | One row per join interval (reconnects create new rows) |
| **MeetingConsent** | ConsentId, MeetingId, ParticipantId, ConsentType (`RECORDING`), NoticeVersion, Decision (`GRANTED`,`DENIED`,`WITHDRAWN`), DecisionUtc, IpAddress, UserAgent, EvidenceHash | **Append-only**. Latest row = current state (BRD `VM_Consent`) |
| **WaitingRoomEntries** | EntryId, MeetingId, ParticipantId, EnteredUtc, Status (`WAITING`,`ADMITTED`,`REJECTED`,`LEFT`), DecidedByEmployeeId, DecidedUtc | |
| **MeetingChatMessages** | MessageId, MeetingId, ParticipantId, Body NVARCHAR(2000), SentUtc, IsSystem | Subject to D8 + retention |
| **EmployeeAvailability** | AvailabilityId, EmployeeId, Type (`WORKING_HOURS`,`LEAVE`,`BLOCKED`), DayOfWeek NULL, StartLocalTime/EndLocalTime NULL, StartUtc/EndUtc NULL, Reason | Meetings themselves also count as busy time |
| **MeetingAuditLog** | → see `app.AuditLog` | The prompt's `MeetingAuditLog` is implemented as the general `app.AuditLog` filtered by `EntityType='Meeting'`, exposed as view `mtg.vw_MeetingAuditLog` |

(`MeetingAuditLog` is a view, so the `mtg` table count is 10 + `vw_MeetingCalendar` + `vw_MeetingAuditLog`.)

### rec — recording (3)

| Table | Key columns | Notes |
|---|---|---|
| **MeetingRecordings** | RecordingId, PublicId, MeetingId, **OwnerEmployeeId (copied from Meetings.CreatedByEmployeeId)**, CustomerId NULL, Status (`PENDING`,`RECORDING`,`PROCESSING`,`VERIFYING`,`COMPLETED`,`FAILED`,`PURGED`), StartedUtc, EndedUtc, DurationSeconds, FileSizeBytes, StorageKey (relative path, opaque), Sha256, Container/VideoCodec/AudioCodec, Width/Height, VerifiedUtc, VerificationDetails JSON, IsEncrypted, KeyId NULL, RetainUntilUtc, LegalHold BIT, FailureReason | **COMPLETED only when VerifiedUtc is set** (`CHECK`) |
| **RecordingJobs** | JobId, RecordingId, IdempotencyKey (unique), Engine (`R2_CHROMIUM`/`R1_EGRESS`), EngineJobId, State (`QUEUED`,`STARTING`,`ACTIVE`,`STOPPING`,`POST_PROCESSING`,`DONE`,`FAILED`), Attempt, LeaseOwner, LeaseExpiresUtc, HeartbeatUtc, LastError, SpoolPath | Reconciler checks for stale `STARTING/ACTIVE/POST_PROCESSING` |
| **RecordingAccessLog** | AccessId, RecordingId, UserId, Action (`VIEW_DETAILS`,`PLAY`,`DOWNLOAD`,`DENIED`), Utc, IpAddress, UserAgent, SignedUrlExpiresUtc | Append-only |

### app — platform (6) (named `sys` in v1)

| Table | Key columns | Notes |
|---|---|---|
| **SystemSettings** | SettingKey (PK), SettingValue NVARCHAR(MAX), ValueType, IsSecret, Category, ModifiedUtc, ModifiedByUserId | Secrets (SMTP password) are stored DPAPI-encrypted or in config, never in plain text |
| **EmailOutbox** | OutboxId, Template, ToAddress, Subject, BodyHtml, RelatedMeetingId, RelatedReminderId, Status, Attempts, NextAttemptUtc, LeaseOwner, LeaseExpiresUtc, CreatedUtc | Outbox pattern (BRD p.23) |
| **EmailDeliveryLog** | DeliveryId, OutboxId, AttemptNo, AttemptUtc, Succeeded, SmtpResponse, ErrorMessage, DurationMs | Reminder-delivery report source |
| **BackgroundJobLog** | JobRunId, JobName, Instance, StartedUtc, FinishedUtc, Status, ItemsProcessed, ErrorMessage | Background service status page |
| **WebhookEvents** | EventId (LiveKit id, PK), Source, EventType, ReceivedUtc, PayloadJson, SignatureValid, ProcessedUtc, ProcessingError, Attempts | Idempotent replay (BRD p.22) |
| **AuditLog** | AuditId, Utc, ActorUserId NULL, ActorType (`USER`,`CUSTOMER`,`SYSTEM`), Action, EntityType, EntityId, Summary, OldValuesJson, NewValuesJson, IpAddress, CorrelationId, IsPrivileged | Append-only. Overrides (double booking) are always logged here |

**Count:** auth 9 + org 6 + crm 1 + mtg 10 + rec 3 + app 6 = **35 tables**. Views: `mtg.vw_MeetingCalendar`, `mtg.vw_MeetingAuditLog`.

## 3. BRD table mapping

| BRD (p.11–13) | OneInsure Connect |
|---|---|
| VM_Meeting | mtg.Meetings (EmployeeId → CreatedByEmployeeId; EmployeeName/CustomerName not denormalised, joined instead) |
| VM_Participant | mtg.MeetingParticipants + mtg.MeetingAttendance (join/leave) |
| VM_Invitation | mtg.MeetingInvitations |
| VM_Consent | mtg.MeetingConsent |
| VM_Recording | rec.MeetingRecordings (StorageBucket/ObjectKey → StorageKey on NTFS) |
| VM_RecordingJob | rec.RecordingJobs (EgressID → EngineJobId) |
| VM_AuditLog | app.AuditLog |
| VM_Notification | mtg.MeetingNotifications + app.EmailOutbox |

## 4. Key indexes

- `Meetings (HostEmployeeId, ScheduledStartUtc) INCLUDE (Status, ScheduledEndUtc)`; `(Status, ScheduledStartUtc)`; `(CreatedByEmployeeId, ScheduledStartUtc)` (BRD p.13)
- `MeetingParticipants (EmployeeId, MeetingId)` → availability and "my meetings"
- `MeetingReminders (Status, DueUtc) WHERE Status IN ('PENDING','FAILED')` (filtered) → worker poll
- `EmailOutbox (Status, NextAttemptUtc)` filtered
- `MeetingRecordings (OwnerEmployeeId, Status)` (BRD p.13), `(MeetingId)`
- `RecordingJobs (State, LeaseExpiresUtc)`
- `MeetingNotifications (RecipientUserId, IsRead, CreatedUtc DESC)`
- `AuditLog (EntityType, EntityId, Utc)`, `(ActorUserId, Utc)`

## 5. Stored procedures (where they help)

| Procedure | Purpose |
|---|---|
| `mtg.usp_CheckAvailability @EmployeeIds (TVP), @StartUtc, @EndUtc, @ExcludeMeetingId` | Conflicts across meetings + leave/blocked + working hours |
| `mtg.usp_ClaimDueReminders @Owner, @Batch, @LeaseSeconds` | `UPDATE TOP(@Batch) … WITH (UPDLOCK, READPAST, ROWLOCK) OUTPUT inserted.*` |
| `app.usp_ClaimOutbox` | Same pattern for email |
| `rec.usp_ClaimRecordingJobs` | Same pattern for the recorder |
| `rpt.usp_*` (9 report procs) | Report queries with date/department/employee filters |

Double-booking guard: `usp_CheckAvailability` runs inside a `SERIALIZABLE` transaction at meeting create/reschedule, with an app lock per employee (`sp_getapplock`), so two concurrent bookings cannot both succeed.

## 6. Initial administrator setup

No credentials are seeded. On first start, the API detects "no SuperAdmin". It writes a **one-time setup key** to the Windows Event Log and to `logs/setup-key.txt` (ACL: Administrators only). `/setup` requires that key and creates the first SuperAdmin with a password policy check and mandatory MFA enrolment. The key is then invalidated.

## 7. Backup & restore (summary; full guide in Phase 7)

- Full backup daily, differential every 6 h, log backups every 15 min (FULL recovery model), `WITH CHECKSUM, COMPRESSION`, plus encryption if the edition supports it.
- Restore drill each quarter onto a test instance. Restore verification is mandatory before go-live.
- Recordings volume backed up separately (robocopy/VSS to the backup share). The `Sha256` column allows integrity checks after restore.
