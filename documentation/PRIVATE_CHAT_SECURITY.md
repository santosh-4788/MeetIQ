# Private participant messages: security design (13 Nov 2026)

**Status:** built and tested locally; **not deployed**. Switched **off** by default (Administration → Meeting features → Private messages).

## What it does
- Any participant who is in the meeting (an employee, or a customer/guest who has been admitted) can send a 1:1 message to another participant **of the same meeting**.
- Only the sender and the recipient can read it. The host does **not** get access to other people's private conversations.
- The group chat ("Everyone") is unchanged. Private messages appear in a separate **Private** tab of the same chat panel, with a per-person unread count and timestamps.

## How it is enforced (server side, not just hidden in the browser)

| Rule | Where |
|---|---|
| The feature must be switched on, and the emergency switch must be off | `RoomFeatureEndpoints.Employee/Guest` → `EnabledAsync`. Otherwise `403 FEATURE_DISABLED`. |
| The sender must be a participant of this meeting | Employees: session + participant row (`CallerAsync`). Customers/guests: personal invitation token + admitted (`AdmittedGuestAsync`). |
| The recipient must be a non-removed participant of **the same meeting** | SQL lookup by `MeetingId` + `LiveKitIdentity` + `IsBlocked = 0`. Otherwise `404`. |
| No messages to yourself | `400` (also a database CHECK constraint). |
| Listing returns only conversations the caller is part of | `WHERE SenderParticipantId = @me OR RecipientParticipantId = @me`. |
| Live delivery only to the two people | The API sends the message through LiveKit's server API with `destination_identities = [recipient, sender]`. LiveKit routes it to nobody else. |
| Clients trust only server-sent private messages | The browser ignores anything on the `oic.private` topic that comes from a participant rather than the server, so a participant cannot fake a message. |
| Plain text only | The same cleaning as group chat (control characters removed, at most 2,000 characters). The UI renders text, never HTML. |
| Missed while offline / reconnecting | Stored in `mtg.PrivateMessages`. The room reloads the list on reconnect. |

## Data and retention
- **Table:** `mtg.PrivateMessages` (V026): meeting, sender participant, recipient participant, body, sent time, read time.
- **Retention:** the same as the meeting's group chat (stored with the meeting record). No separate retention rule has been approved, so none is invented. If Compliance sets a different rule, it can be applied to this table on its own.
- **AI:** private messages are **not** passed to any AI processing (no AI processing exists yet). Any future AI feature must leave this table out unless a policy explicitly allows it.
- **Rollback:** switch the feature off (data kept). A full removal is `database/rollback/V026__meeting_features.rollback.sql`.

## Tests actually run (local, isolated: LocalDB `_Room`, separate LiveKit)
See `tests/e2e/room/meeting-features.mjs`, case **MF-05**:
- employee → host delivered live, and the host's unread badge shows 1;
- host reply delivered live;
- the third participant (guest) lists **0** messages;
- sending to an identity outside the meeting returns 404, and sending to yourself returns 400;
- 2 rows stored, and the first is marked read once opened.

Results: `UAT_TESTING_REPORT.md`.
