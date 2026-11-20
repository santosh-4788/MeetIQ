# Chat module, Phase 3 (audio calls): delivery note

**Built and tested on the test environment, 20 Nov 2026. DEPLOYED 20 Nov 2026, 06:17–06:25 IST, switched off (see CHANGELOG).**

Plan: `CHAT_MODULE_PHASE1.md` section 10, approved on 20 Nov 2026 with decision D4 (10 people per call).

## What employees get

- **Calling:** a phone button in every chat. In a direct chat it calls the colleague; in a group it starts a group call, ringing every member.
- **Incoming call popup** on any portal page:
  - shows the caller's name and employee code, with Accept and Decline;
  - an original ringtone (generated in the browser, no audio file), silent if sounds are off or the person chose Do not disturb;
  - the browser tab title flashes, plus a browser notification if allowed;
  - every open tab rings, and answering in one stops the others.
- **Call panel** (bottom right; above the tab bar on phones):
  - timer, connection quality, and who is in the call with a speaking indicator;
  - Mute and unmute;
  - microphone and speaker choice (speaker where the browser supports it);
  - Add people during the call (it becomes a group call);
  - Leave or End; the person who started a group call can "End call for everyone".
  - The call keeps going while you move between portal pages.
- **Busy:** someone already in a call or a live meeting is not rung. The caller sees "… is busy", and the busy person gets a missed-call alert.
- **Missed calls:** after 45 s without an answer, a "Missed call from …" alert appears in the bell (it opens the chat), and a line is added to the chat.
- **In the chat itself:** a line for every call ("📞 Audio call · 3 min 05 s", "declined", "missed"), and "In a call" as presence.
- **Calls tab** in Chat: history with missed, incoming, outgoing, declined and duration, search by name or code, Call again, Open chat.
- **Moving between windows:** if the call is connected in another tab or window, you see "In a call … in another window · Join here".

## How it works

- **Video server:** the existing self-hosted LiveKit server, with no new server or service.
  - Each call is its own audio-only room `oic_call_<random>`.
  - Tokens allow the **microphone only**, and only for people invited to that call.
- **API:** `Chat/ChatCalls.cs`, with `/api/v1/chat/calls` (start, accept, decline, leave, end, invite, token, current, history).
  - `ChatCallWorker` runs every 5 s. It handles ring timeouts, and who is connected comes from LiveKit's participant list: a browser that closes or loses the network counts as left after about 25 s.
  - **The meeting webhook and meeting code are not changed.**
- **Database:** `V029__chat_calls.sql`.
  - `chat.TRN_ChatCall`, `chat.TRN_ChatCallParticipant`.
  - Notification type `MISSED_CALL`.
  - Switch `CHAT_CALLS`, seeded **off**.
  - Rollback script: `V029__chat_calls.rollback.sql`.
- **Website:** `pages/chat/CallProvider.tsx`, `CallOverlay.tsx` (separate chunk), `CallHistory.tsx`, `api/calls.ts`, plus small additions to `ConversationView`, `ChatPage`, `AppLayout`, the Meeting Features page and the bell icons.
- **Privacy:** calls are never recorded. Only who called whom, when and for how long is kept. Call events are audited: started, accepted, invited, ended.

## Also fixed in this round: website size

Since the Android-app deploy on 19 Nov, the public download page pulled the video library (about 570 KB) into the **main** website file, so every visitor downloaded it.
- A tiny `pages/room/androidBridge.ts` now holds the "inside the app?" check.
- The main file is back to 1.19 MB (it was 1.76 MB live). The video library loads only for meetings and calls.

## Settings

All optional, section `Chat`.

| Setting | Default | Meaning |
|---|---|---|
| `MaxCallParticipants` | `10` | D4; raise only after a load test on this server |
| `RingSeconds` | `45` | How long a call rings before it counts as missed |

## Switching it on

Administration › Meeting Features › **Audio calls in Chat**. Chat must be on too. Switching it off ends calls in progress within seconds.

## Deploy steps

To be run only when you say "deploy".

1. Pre-check, file backup and a verified database backup.
2. Apply `V029__chat_calls.sql` on its own (as V028).
3. Publish the API, then `npm run build`.
4. Live checks without sign-in. Switch calls on when ready.

## Tests

All on the test environment.

- **Backend:** 106/106, including 4 new call tests.
  - The switch.
  - Microphone-only tokens and the room name.
  - Outsiders get "not found" for every call action.
  - Answer; no second call while in one.
  - Connected and disconnected detection, then the end with a chat line, room deletion and audit.
  - Missed after the ring time, with the bell link to the chat.
  - Declined.
  - Busy.
  - Add people (becomes group); only the starter ends a group call; rejoin while ongoing; no join after the end.
- **Browser:** `tests/e2e/room/calls.mjs` 7/7, three people (one a phone) with **real audio** through the test LiveKit server.
  - Popup on the dashboard, answer, audio both ways (about 23 KB per 2.5 s each way).
  - Mute and "In a call".
  - Phone added mid-call (popup fits 390 px), then leaves while the others stay.
  - End for everyone, with the chat line.
  - Declined shown to the caller.
  - Busy: the ongoing call isn't interrupted, and a bell alert is sent.
  - Missed after about 46 s, with the chat line and "Missed" in the Calls tab.
- **Bugs found and fixed by these tests:**
  - a missed call created no bell alert;
  - the caller saw "disconnected" instead of "declined" or "busy";
  - avatars were hard to see on the dark call panel.

## Limits

- Calls ring only while the portal is open in a browser. Waking a closed browser would need Google or Apple push servers.
- Calls do not ring inside the meeting room screen. People in a live meeting count as busy.
- Group calls are capped at 10. The server's real capacity still needs a load test before raising it.
