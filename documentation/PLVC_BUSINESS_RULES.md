# PLVC business rules

Status 13 Nov 2026, live since 16:20 IST (migration V024).

## 1. Two kinds of Customer – PLVC meeting

| | Identified PLVC | Unidentified PLVC |
|---|---|---|
| How it is created | Portal instant or scheduled meeting with a Prarambh Main ID and participants; external API without `plvcIdentification` | Portal instant meeting, **"Skip details & start meeting"**; external API with `plvcIdentification: "UNIDENTIFIED"` (instant only, scope `meeting.plvc.unidentified`) |
| Prarambh Main ID | Required: digits only, 1–30 characters, stored exactly as entered | None. **Never generated or substituted** |
| Customer / participants | The first participant becomes, or reuses, the customer; the others are guests; each is e-mailed their own personal link | None. The host shares the meeting link, and people wait in the waiting room |
| Recording | Mandatory, notification only | **Recorded and saved as normal** (owner's decision, 13 Nov 2026) |
| Recording file name | `yyyyMMdd/{PrarambhMainId}-{MeetingCode}-REC{id}.mp4` | `yyyyMMdd/{MeetingCode}-REC{id}.mp4`: no ID prefix, never NULL, "undefined", empty or a dummy |
| Scheduled meetings | Required, as before | Not possible: Skip is offered for instant meetings only, and the database refuses a scheduled customer meeting without a customer |

## 2. Where it is enforced

- **Database (V024):**
  - `mtg.Meetings.PlvcIdentification` is a *computed* column (`IDENTIFIED` / `UNIDENTIFIED` / NULL) derived from Category + PrarambhMainId, so it cannot disagree with the data.
  - `CK_Meetings_CustomerRequired` now allows a missing customer only for an **instant** PLVC meeting.
  - The scopes check now includes `meeting.plvc.unidentified`.
  - Existing checks are unchanged: digits only; the ID only on PLVC meetings.
- **API:** `Meetings/Plvc.cs` (validation, `Identification`, `SetPrarambhAsync`); `MeetingLinkEndpoints.CreateInstantAsync` (`skipPlvcDetails`); `ExternalApiEndpoints` (explicit request + scope).
- **Reports:**
  - Prarambh Main ID column ("Unidentified" when missing).
  - Category filters "Customer PLVC — identified" and "— unidentified". A report that needs verified Prarambh mapping uses the *identified* filter.
  - The CSV has a "PLVC identification" column.
- **Recording library:**
  - "· Unidentified PLVC" on the recording, using the recording's own snapshot of the ID.
  - The same two filters as Reports.

## 3. Adding the ID later (authorised correction)

`POST /api/v1/meetings/{id}/prarambh` is used by "Add Prarambh Main ID" on the meeting page.

- **Who:** the host, co-host, organiser, or an administrator with `meetings.view.all`. This also works after the meeting has ended.
- **Only once:** a meeting that already has an ID is refused (409). An existing ID is never overwritten, and it never touches another meeting.
- **Validation:** the same rule as everywhere (digits only).
- **Recordings:** the ID is added to that meeting's recordings that have none, as **metadata only**. Files are **never renamed or moved**.
- **Audit:** `MEETING_PRARAMBH_ADDED` with the old and new values, the number of recordings updated, and `filesRenamed: 0`.

## 4. Recording notice wording

- **Wording on all five policies:** the owner-approved text: "This meeting may be recorded by OneInsure for business, service, quality assurance and compliance purposes, as applicable. The recording will be securely stored and accessed only by authorised personnel."
- **Versions:** `PLVC-NOTICE-1.0`, `CUSTMEET-NOTICE-1.0`, `CUSTAUDIO-NOTICE-1.0`, `INTERNAL-NOTICE-1.0`, `TRAINING-NOTICE-1.0`.
- **Approval reference:** the product owner (Santosh Yadav), 13 Nov 2026.

**Approval status stays `PENDING_CONFIRMATION` on purpose.**
- The recording gate treats an `APPROVED` policy without a retention period as invalid, and refuses to record.
- The retention period is intentionally empty (no automatic deletion).
- Marking a policy fully Approved therefore first needs a retention decision from Compliance.
- Until then, hosts do **not** see a "wording not confirmed" note, because the wording itself has an approval reference.
