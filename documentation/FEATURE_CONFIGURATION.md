# Optional meeting features: configuration (13 Nov 2026)

**Where:** Organisation → System → **Meeting Features** (`/meet/meeting-features`).
**Who:** the permission `features.manage`, granted to Admin and Super Admin by migration V026.
**Audit:** every change is recorded in the audit log as privileged.

| Switch (`app.FeatureSettings.FeatureKey`) | Default | Effect when on |
|---|---|---|
| `REACTIONS` | Off | Six reaction bubbles (Tools menu). Peer-to-peer, not stored. |
| `POLLS` | Off | Host Yes/No polls; one answer each; live results for everyone in the meeting (15 Nov 2026); shown in recordings; stored in `mtg.MeetingPolls` / `mtg.MeetingPollVotes`. |
| `PRIVATE_CHAT` | Off | "Private" tab in Chat; stored in `mtg.PrivateMessages`. See `PRIVATE_CHAT_SECURITY.md`. |
| `WHITEBOARD` | Off | Host can open the whiteboard; everyone may draw by default (the host can restrict it); shown in recordings; stored in `mtg.MeetingWhiteboards`. See `WHITEBOARD_FEATURE.md`. |
| `BACKGROUND_EFFECTS` | Off | Blur and background pictures, processed in the browser. |
| `NOISE_SUPPRESSION` | Off | Shows the noise-suppression switch. Suppression itself stays on by default either way. |
| `CAMERA_FLIP` | Off | "Switch camera" button on devices with 2 or more cameras. |
| `MEETING_MINUTES` (V027) | Off | "Minutes of meeting" card and page on the meeting page; written by people, no AI. Approving needs `minutes.approve`. See `TRANSCRIPTION_AND_MOM.md`. |
| `EMERGENCY_DISABLE` | Off | **On = every optional feature off**, whatever the individual switches say. The individual settings are kept. |

## How a switch takes effect
- The room reads the switches **once when it opens** (`GET /api/v1/room-features`, anonymous, booleans only).
- People already in a meeting keep the controls they have until they rejoin.
- The **server**, however, checks the switches on **every** call: once a feature is switched off (or the emergency switch is on), its API calls return `403 FEATURE_DISABLED` straight away, and the control simply stops working.
- A meeting is **never** interrupted by switching a feature off. Test MF-11 checks this.
- A database without V026 behaves as "all off". The API can be deployed before or after the migration.

## Not configurable yet
These are not built, so there is no switch:
- AI assistant, AI-drafted minutes, live captions and transcription (needs the approved benchmark: `RESOURCE_BENCHMARK.md`);
- gesture recognition (`GESTURE_RECOGNITION.md`);
- model selection, AI concurrency and resource limits.

The page lists them under "Not available yet", with the reason.
