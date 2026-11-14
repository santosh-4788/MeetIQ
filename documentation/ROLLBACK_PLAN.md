# Rollback plan: optional meeting features (branch `feature/ai-collab-1113`, 13 Nov 2026)

**Nothing from this branch is deployed.** Production (`https://www.oneinsure.com/meet`, database `Oneinsure_v`) is unchanged.

## Before deployment (when approved)
1. Check that no meeting is live or recording (the usual `LIVE=0;REC=0` check).
2. Back up:
   - `deploy\api` and `frontend\dist` → `deploy\_backup-<stamp>`;
   - `Oneinsure_v` → a copy-only backup with CHECKSUM, plus `RESTORE VERIFYONLY`.
3. Apply **V026** (additive: 5 new tables, 1 permission; no existing object changed) and then **V027** (minutes of meeting: 3 new tables, 1 switch row, 1 permission), each in one transaction with its `dbo.SchemaMigrations` row.
4. Publish the API and run `npm run build`, as in earlier deployments. Verify health and the new `GET /api/v1/room-features` (expected: all `false`).
5. Every feature is **off** after deployment. Switch them on one at a time in Administration → Meeting features.

## Rolling back, from least to most drastic

| Level | When | How | Data |
|---|---|---|---|
| 1. One feature off | One feature misbehaves | Administration → Meeting features → switch it off | Kept |
| 2. Emergency switch | Several features, or unsure which | Administration → Meeting features → Emergency switch. Or in SQL: `UPDATE app.FeatureSettings SET IsEnabled = 1 WHERE FeatureKey = 'EMERGENCY_DISABLE'` | Kept |
| 3. Previous application files | The new code itself causes trouble | Stop `MeetIQApi`; restore `deploy\api` and `frontend\dist` from the backup; start; check health. V026 can stay: the old code never touches the new tables. | Kept |
| 4a. Remove V027 | Only if the minutes schema itself must go | `database/rollback/V027__meeting_minutes.rollback.sql` (one transaction). Run it **before** the V026 rollback. | **Deletes** all minutes, action items and their history |
| 4b. Remove V026 | Only if the schema itself must go | `database/rollback/V026__meeting_features.rollback.sql` (one transaction; tested on LocalDB 13 Nov: 0 tables left, permission and history row removed, then V026 re-applied cleanly) | **Deletes** polls, private messages and whiteboards |

## Files changed in existing modules (impact review)

| File | Change | Why | Risk with every feature off |
|---|---|---|---|
| `backend/.../Meetings/RoomEndpoints.cs` | 4 helpers changed from `private` to `internal` | So the new endpoints reuse the same participant checks | None (no logic change) |
| `backend/.../Program.cs` | +2 lines `MapRoomFeatureEndpoints()`, `MapMeetingMinutesEndpoints()` | New routes | None |
| `backend/.../Meetings/RoomFeatureEndpoints.cs` | Switch key `MEETING_MINUTES`; `meetingMinutes` in `/room-features` | Minutes switch | None (new field only) |
| `frontend/.../meetings/MeetingDetailPage.tsx` | Minutes card in the left column | Entry point | Renders nothing while the switch is off (test MM-01, MM-15) |
| `frontend/.../meetings/MeetingsPages.tsx` | Route `:id/minutes` | Minutes page | None |
| `frontend/.../room/MeetingRoom.tsx` | Feature hooks; optional Tools button; Private tab; whiteboard instead of video when open | UI entry points | Every new element renders only when its switch is on. The room suite passes 11/11 both with all features off and with all on. |
| `frontend/.../room/RoomPanels.tsx` | `PanelHeader` exported; `SettingsPanel` gains an optional `extra` slot | Reuse; effects section | None |
| `frontend/.../room/roomUi.ts`, `EmployeeRoomPage.tsx`, `GuestRoom.tsx` | Optional `features` calls on the room backend | Wiring | None |
| `frontend/public/web.config` | MIME types `.wasm`, `.tflite` | Self-hosted MediaPipe files | None for existing pages |
| `frontend/package.json` | `@livekit/track-processors` 0.8.2, `jspdf` 4.2.1 (exact versions) | Background effects, PDF | Loaded only on use (lazy); `npm audit` shows 0 vulnerabilities |
