# Recording storage structure

**Audience:** OneInsure Connect operators and developers. **In effect from:** 13 Nov 2026 (deployment of the 12–13 Nov batch).

## Layout (new recordings)

The library root is `Recording:StorageRoot` in `deploy\api\appsettings.Production.json`. The archive root comes from each policy's `ArchiveLocation`.

```
<StorageRoot>/
├── 20261112/
│   ├── 706082601-OIC-261112-QWD3-REC10030.mp4     ← Customer – PLVC: starts with the Prarambh Main ID
│   └── OIC-261112-AB12-REC10031.mp4               ← every other category
└── 20261113/
    └── OIC-261113-XY9Z-REC10032.mp4
```

| Part | Rule |
|---|---|
| Folder | `YYYYMMDD` = the recording's **start** date in **Asia/Kolkata**. A recording started at 01:30 IST belongs to that IST day, not the previous UTC day. The folder is created when the first file of the day is saved. |
| File, PLVC | `<PrarambhMainId>-<MeetingCode>-REC<RecordingId>.mp4`. The Prarambh ID is digits only (validated when the meeting is created and re-checked here) and is used exactly as stored. |
| File, others | `<MeetingCode>-REC<RecordingId>.mp4` |
| Collisions | If the name exists on disk, as a `.partial` file, or in `rec.MeetingRecordings.StorageKey` (unique index), a `-2`, `-3`, … suffix is added. |
| Never in a name | Customer or participant names, e-mail addresses |

Code: `backend/src/OneInsure.Connect.Api/Recording/RecordingStorageKeys.cs`, called from `RecorderWorker` when the verified MP4 is moved into the library.

The MP4's own metadata carries the same identity: title `<PrarambhMainId>-<MeetingCode>` (PLVC) or `<MeetingCode>`, and comment `OneInsure Connect meeting <code>; Prarambh Main ID <id>`.

## Database

The `rec.MeetingRecordings` columns involved:

| Column | Meaning |
|---|---|
| `StorageKey` | The relative key above. CHECK: no drive letter, no leading slash, no `..`. Unique. |
| `StorageTier` | `PRIMARY` or `ARCHIVE`, with `ArchiveRoot` for archived files |
| `PrarambhMainId` | Snapshot of the meeting's ID when the recording was created (V022) |
| `IntegrationId` | Set when the meeting was created through the external API (V023) |
| Other metadata | `StartedUtc`, `EndedUtc`, `DurationSeconds`, `FileSizeBytes`, `Sha256`, `Status`, `PolicyCode`/`PolicyVersion`; meeting id and category through `MeetingId` |

## Existing recordings

- Recordings made before this change keep their keys (`yyyy/MM/dd/<random>.mp4`, by UTC date). They were **not renamed or moved**.
- Playback, download, archive and deletion resolve whatever `StorageKey` a row holds, so old and new layouts work side by side.
- A future migration of old files would need its own tested plan and a backup. None is planned.

## Access

- Files are never served statically. The library folder is outside the web root.
- **Portal users** get a short-lived link signed for their user: `/api/v1/recordings/media/{token}`.
- **External portals** get a short-lived link signed for their integration: `/api/ext/v1/recordings/media/{token}`, 5 minutes by default (`Integrations:DownloadLinkSeconds`).
- Responses never contain physical paths.

## Deletion (12 Nov 2026 policy)

Recordings are **never deleted automatically**.
- The retention worker only flags expired recordings for review, or archives them if a policy says ARCHIVE.
- A legacy `DELETE` expiry action is treated as review-only, and the policy screen no longer offers it.
- Deletion is manual only (Recording Library → Delete):
  - it requires a reason and the user's permission;
  - legal hold blocks it;
  - the policy's dual approval applies;
  - it is audited;
  - the row is kept and marked `PURGED`;
  - it is marked purged only after the file was actually deleted.
- Compliance agreed to this change (business owner's confirmation, 12 Nov 2026).
