# Recording Policy Configuration

**Status (updated 31 Oct 2026):** customer recording is an **existing, approved OneInsure business activity**. The company already records customer audio calls and customer meetings held on Zoom, and stores them on internal systems. OneInsure Connect supports that existing process. It is **not** treated as a new or unapproved activity.

- Development and testing of recording are **never blocked** by approval status.
- OneInsure Connect **reuses the existing policy's** consent/notification wording, retention period and access rules. The software never invents legal wording, retention periods or policies.
- The values shipped in configuration are **placeholders to be replaced with the existing policy's values**. They block only Pilot/Production, and only until replaced.
- Every value is configuration. Changing it needs no code change: **Administration → Recording policies** (section 5).

## 0. Items to confirm internally (only these)

Customer recording itself is already approved. What the team needs to supply or confirm:

| # | Item | Why it is needed |
|---|---|---|
| 1 | **Name and version of the existing recording policy** (the document that covers customer audio and Zoom recordings) | Stored as `ApprovalReference` with status `ExistingBusinessPolicy` |
| 2 | **The consent/notification wording used today** for recorded Zoom meetings (and its version) | Shown to participants verbatim; stored with every consent decision |
| 3 | **The retention period and the action at expiry** used today for call and Zoom recordings | `RetentionDays`, `ActionOnRetentionExpiry` |
| 4 | **Who may play and download recordings today** (roles or teams) | Mapped to `PlaybackRoles`, `DownloadRoles`, owner and team-leader access |
| 5 | **Whether the existing policy wording already covers recordings made on a new internal platform** (OneInsure Connect instead of Zoom) | If it names Zoom specifically, a one-line confirmation that it also applies to OneInsure Connect |
| 6 | **Whether internal (employee-only) meetings** are covered by the same policy or need separate HR wording | `InternalRecordingEnabled` and internal consent text |
| 7 | (Optional) **Where existing recordings are stored**, if OneInsure Connect recordings should go to the same internal store or archive | `ArchiveLocation` / storage path |

Once items 1–4 are supplied, set `ApprovalStatus = ExistingBusinessPolicy` with the real values. The gate then allows customer recording in Pilot/Production, subject to consent.

## 1. Enforcement (implemented and tested)

`RecordingPolicyGate` (`backend/src/OneInsure.Connect.Domain/Recording/RecordingPolicy.cs`) is evaluated **before the recorder joins a room**:

| Rule | Result | Test evidence |
|---|---|---|
| Customer recording switched off in configuration | Refused: `CUSTOMER_RECORDING_DISABLED` | Unit test + end-to-end run (exit code 3, recorder never joined) |
| Consent required and not granted by all required participants | Refused: `CONSENT_MISSING` | Unit test + end-to-end run |
| Pilot/Production with customer recording enabled while the policy values are still placeholders (status neither `ExistingBusinessPolicy` nor `Approved`) | **Startup/config invalid**: `POLICY_INVALID` | Unit tests + end-to-end runs (Pilot and Production) |
| Policy marked `Approved` or `ExistingBusinessPolicy` but still containing placeholder text, version or retention, or without the policy reference | Invalid | Unit tests |
| Development / Test environments | Never blocked by approval status (consent still applies) | Unit test |
| Policy marked `Approved` without ApprovedBy / ApprovalReference / ApprovedOnUtc | Invalid | Unit test |
| Retention action `Archive` without an archive location | Invalid | Unit test |
| Signed playback URL lifetime outside 30–3600 s | Invalid | Unit test |

Results: 18/18 unit tests passed (31 Oct 2026, including the existing-business-policy rules); originally 15/15 and 4/4 end-to-end refusal cases passed on 31 Oct 2026 (`tests/r2-poc/results/policy-e2e.json`).

The application API (Phases 3–5) will enforce the same policy again for consent capture, playback, download, legal hold and deletion. A browser can never bypass it.

## 2. Settings

Stored in `rec.RecordingPolicies` (migration V012, one row per policy — section 5) and edited in **Administration → Recording policies**. When the API launches the R2 recorder it passes the meeting's current policy as environment variables (`OIC_RecordingPolicy__*`), so the recorder's own gate evaluates exactly the administrator's values; `appsettings.json` → `RecordingPolicy` is used only when the recorder PoC is run by hand. Every change is audited (privileged, old and new values). The table below describes the recorder PoC's settings; the per-policy fields of the admin editor are listed in section 5.

| Setting | Placeholder / default | Meaning | Decided by |
|---|---|---|---|
| `ApprovalStatus` | `PendingLegalApproval` (placeholder) | Set to `ExistingBusinessPolicy` once the existing policy's values are entered (or `Approved` for a platform-specific approval) | Compliance (existing policy owner) |
| `ApprovedBy`, `ApprovalReference`, `ApprovedOnUtc` | empty | Evidence of approval | Legal/Compliance |
| `CustomerRecordingEnabled` | false in shipped config; **true in Development** | Master switch for customer (PLVC) recording | Business (existing process) |
| `InternalRecordingEnabled` | true in Development only | Master switch for internal meetings | HR/Compliance |
| `CustomerMeetingRecording` | `Optional` | `Disabled` / `Optional` / `Mandatory` | Legal/Compliance |
| `InternalMeetingRecording` | `Optional` | Same, for internal meetings | HR/Compliance |
| `ConsentNoticeVersion` | `PLACEHOLDER-0` | Version stored with every consent decision | Legal |
| `ConsentNoticeText` | `[PLACEHOLDER – NOT APPROVED BY LEGAL] …` | Text shown to participants before recording | **Legal (final wording)** |
| `ConsentRequiredFromAllParticipants` | true | Recording starts only after every required participant consents | Legal |
| `StopRecordingOnConsentWithdrawal` | true | Withdrawal stops recording and flags the meeting | Legal |
| `RetentionDays` | **not set** | How long recordings are kept | **Legal/Compliance** |
| `ActionOnRetentionExpiry` | `ReviewOnly` | `ReviewOnly` / `Archive` / `Delete` | Legal/Compliance |
| `ArchiveLocation` | not set | Required if action = Archive | IT + Compliance |
| `LegalHoldEnabled` | true | Allows holds that override retention | Legal |
| `LegalHoldManagerRoles` | ComplianceAuditor, SuperAdmin | Who can place or release holds | Legal/Compliance |
| `DeletionApproverRoles` | SuperAdmin | Who approves deletion | Compliance |
| `RequireDualApprovalForDeletion` | true | Two-person rule for deletion | Compliance |
| `OwnerCanPlay` | true | Meeting creator can play own recordings | Business + Compliance |
| `OwnerCanDownload` | **false** | Meeting creator can download own recordings | Business + Compliance |
| `TeamLeaderCanPlayTeamRecordings` | true | Team scope (BRD p.5) | Business |
| `PlaybackRoles` | Admin, ComplianceAuditor, SuperAdmin | Roles with playback beyond own/team | Compliance |
| `DownloadRoles` | SuperAdmin | Roles allowed to download | Compliance |
| `SignedUrlTtlSeconds` | 300 | Lifetime of playback/download links | Security |

## 3. Pilot gate

Customer recording may be switched on in a Pilot or Production environment only when **all** of the following hold. The software enforces the first three; the others are sign-offs.

1. `ApprovalStatus = Approved`, with approval evidence recorded.
2. Consent wording and version replaced (no placeholder marker).
3. `RetentionDays` set.
4. Legal hold and deletion procedure signed off.
5. Access/download matrix signed off.

## 5. Administration → Recording policies (Phase 5, implemented)

**Where:** Administration page, card "Recording policies" (plus "Recorder status"). Reading needs `recordings.policy.manage`, `admin.settings` or `audit.view`; **changing needs `recordings.policy.manage`** — a new permission (V012) granted only to SuperAdmin by default. It is deliberately not `admin.settings`, which the day-to-day Admin role also holds: consent wording, retention and access to recordings are compliance decisions. A SuperAdmin can grant it to another role in the roles matrix. The other `recordings.*` permissions remain unassigned (V010) until the access matrix is confirmed.

**Four separate policies** (table `rec.RecordingPolicies`):

| Code | Title | Applies to |
|---|---|---|
| `CUSTOMER_MEETING` | Customer meetings | Customer video meetings (PLVC and general). Shipped **enabled / Optional**, because customer recording is an existing business activity; Pilot/Production still refuse it until the policy is confirmed |
| `CUSTOMER_AUDIO_CALL` | Customer audio calls | **Configuration only**: there is no telephony integration, so it is applied to nothing yet; it is stored so it can apply later. Shipped disabled |
| `INTERNAL_MEETING` | Internal employee meetings | One-to-one, group, management and review meetings. Shipped disabled (item 6 of section 0 is open) |
| `TRAINING_TEAM_MEETING` | Training & team meetings | Training, team and department meetings. Shipped disabled |

Each policy holds: name, version, effective date, approval status (`PENDING_CONFIRMATION` / `EXISTING_BUSINESS_POLICY` / `APPROVED`), policy reference, approved by/on, enabled, requirement (`DISABLED` / `OPTIONAL` / `MANDATORY`), consent mode (`CONSENT_REQUIRED` = Accept/Decline, `NOTIFICATION_ONLY` = acknowledge) with the wording and its version, consent from all participants (yes/no), stop on withdrawal, retention days (**empty = not set → never deleted or archived automatically**), action at expiry (`REVIEW_ONLY` / `ARCHIVE` + archive location / `DELETE`), legal hold allowed, dual approval for deletion and the deletion-approver roles, playback roles, download roles, owner can play / download, team-leader access, department-head access, signed-link lifetime (30–3600 s).

**Shipped values are placeholders** — wording `[PLACEHOLDER - NOT CONFIRMED] …`, version `PLACEHOLDER-0`, no retention, no playback/download/approver roles, owner may play but not download, no team-leader or department-head access. Nothing is invented: the real values come from the existing OneInsure recording policy (section 0).

**"Not confirmed" banner:** every policy shows "Not confirmed — values pending internal confirmation" (with the list of open items) unless its status is `EXISTING_BUSINESS_POLICY` or `APPROVED` **and** a policy reference is entered. Participants in the meeting room see "Wording not confirmed" above placeholder wording.

**A policy can never be marked confirmed with placeholders:** the API refuses `EXISTING_BUSINESS_POLICY` / `APPROVED` while the wording contains `[PLACEHOLDER`, the version starts with `PLACEHOLDER`, retention is empty, or name, version or reference are missing (`APPROVED` also needs approver and date); a database CHECK requires the reference too. In Pilot/Production (`Recording:Environment`) an unconfirmed policy blocks recording entirely (`POLICY_NOT_CONFIRMED`); in Development/Test it does not (consent still applies).

**Category mapping** ("Meeting categories → policy", table `rec.RecordingPolicyCategories`): CUSTOMER_PLVC/CUSTOMER_GENERAL → customer meetings; TRAINING/TEAM/DEPARTMENT → training & team; INTERNAL_1_1/GROUP/MANAGEMENT/REVIEW → internal. Editable; customer categories always use the customer meetings policy and internal categories never do.

**Per meeting:** the organiser's choice (None/Optional/Required) can only make recording stricter: a disabled policy is never overridden, Required on an Optional policy behaves as Mandatory (automatic start once the consent conditions hold).

**Consent in the room:** everyone in the meeting (employees, customers, guests) sees the notice when recording is possible and answers it; each decision is appended to `mtg.MeetingConsent` with the notice version, IP, user agent and an evidence hash. With "consent from all participants", recording starts only when everyone in the room (and the host, who accepts the notice when pressing Start) has granted it; with "stop on withdrawal", a withdrawal or decline stops a running recording. A REC indicator is shown to everyone while recording.

**Audit:** `RECORDING_POLICY_UPDATED` and `RECORDING_POLICY_CATEGORIES_UPDATED` in `app.AuditLog` (privileged, old and new values).

**Retention in practice:** the retention worker (hourly) does nothing for a policy without retention, and never touches a recording under legal hold. `REVIEW_ONLY` lists expired recordings under Recording Library → Retention; `ARCHIVE` moves the file (checksum verified) to the archive location, still playable; `DELETE` deletes the file and marks the recording `PURGED` (row, consent, audit and access history kept) — immediately if the policy does not require dual approval, otherwise after two different users holding a deletion-approver role approved it.
