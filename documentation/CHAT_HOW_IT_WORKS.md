# OneInsure Connect Chat and audio calls: how it works and where the data is kept

For managers and IT. Last updated 20 Nov 2026.

## In one minute

- Chat and calls run **entirely on OneInsure's own servers**. There is no WhatsApp, Google, Microsoft Teams, cloud service, paid service or AI involved.
- **Messages, groups, tasks and notes** are stored in OneInsure's own SQL Server database (`Oneinsure_v`). **Files** sent in chat are stored on OneInsure's own server disk.
- **Nothing is stored on phones or laptops.** The browser or the app only shows what the server sends. A lost phone holds no chat history; signing out (or the session ending) removes access.
- **Audio calls are never recorded.** Only who called whom, when and for how long is kept.

## 1. How chat works

1. An employee opens **Chat** (the menu on a computer, the Chat tab on a phone, or the Android app) and starts a chat with a colleague or creates a group.
2. When they press send, the message goes over an encrypted connection (HTTPS) to the OneInsure server.
3. The server checks the sender is allowed to write in that chat and saves the message in the database.
4. The server pushes the message straight away to every member who has the portal open, on any device. This uses a live connection (SignalR), which is part of the server software.
5. Ticks show *sent* (saved on the server), *delivered* (the colleague's device received it) and *read* (the colleague opened the chat).
6. Anyone who was offline sees the message, with an unread count, the next time they open the portal.

### Who can see what

- Only the members of a chat can read it. Every request is checked on the server; anyone else gets "not found".
- People added to a group later see messages **from the time they joined**, not the earlier history.
- People removed from a group no longer see it.
- **Notes and tasks are private:** only their owner can see them.
- Administrators manage the feature switches. There is no screen for reading other people's chats.

### Files

- Allowed: images, PDF, Word, Excel, PowerPoint, text, CSV and ZIP, up to 25 MB.
- Every file is **checked by Windows Defender** on the server before anyone can download it. A file that fails the check is never served.
- Files are stored under random names in a server folder that only administrators and the Connect service can open.
- Only chat members can download a file, and every download is checked.

### Edit and delete

- A message can be edited within 15 minutes and deleted for everyone within 1 hour.
- **Delete removes the text from the database** and deletes an attached file from the disk. Everyone sees "This message was deleted".

## 2. Where everything is stored

| What | Where | How long |
|---|---|---|
| Messages, groups, members, read ticks, reactions | SQL Server database `Oneinsure_v`, schema `chat` | Kept until deleted (decision D9) |
| Files sent in chat | Server folder `deploy\data\chat` (random names, restricted access) | Kept; an optional administrator setting can remove old files after N days |
| Call history (who, when, how long) | Database, `chat.TRN_ChatCall` | Kept |
| Call audio | **Not stored anywhere** | — |
| Notes, tasks, reminders | Database, `chat.TRN_ChatNote`, `TRN_ChatTask`, `TRN_ChatReminder` (owner only) | Kept until the owner deletes them |
| Scheduled, saved and pinned messages; favourites; quiet hours | Database (V031 tables) | Kept until changed |
| Phones, browsers, the Android app | **Nothing is saved** (the app also turns off Android backup of its data) | — |

**Backups:** chat is part of the normal `Oneinsure_v` database backups. A verified backup is also taken before every deploy. **The `deploy\data\chat` folder (chat files) should be included in the server's file backups.**

**Encryption:**
- Everything travels encrypted (HTTPS; calls use WebRTC's built-in encryption).
- Stored messages are protected by server and database access controls.
- This is not end-to-end encryption, so the company keeps its records, as with company email.

## 3. How audio calls work

1. In a chat, the employee taps the **phone button**. In a group it calls everyone, up to 10 people.
2. The server creates a private, **audio-only** call room on OneInsure's own video server, the same one used for meetings.
3. Each invited colleague **rings** on every open portal page or app: a ringtone and an Accept / Decline screen, full screen on phones. Answering on one device stops the others ringing.
4. On **Accept**, the server gives that person a short-lived key that allows **microphone only**, for that call only. The phone or browser connects and the audio flows.
5. During the call:
   - mute, choose the microphone or speaker, add people, and see who is speaking and the connection quality;
   - the call carries on while the person moves around the portal;
   - on phones it can be minimised to a green bar;
   - in the Android app it keeps going with the screen off.
6. **Ending:** End or Leave. In a group, the person who started it can end it for everyone. The call room is then deleted, and a line such as "📞 Audio call · 3 min 05 s" appears in the chat.

### Busy, missed and declined calls

- **Busy:** someone already in a call or a live meeting isn't rung. The caller sees "busy" and the busy person gets a missed-call alert.
- **Missed:** after 45 seconds without an answer, the person gets a **missed-call alert in the bell** and a line in the chat.
- **Declined:** the caller is told straight away.

### What a call needs

- The colleague must have the **portal open in a browser, or the Android app open (it can be in the background)**, to ring. Waking a closed phone would need Google's or Apple's push services, which are not used.
- Microphone permission, which the browser or app asks for the first time.
- iPhone: use Safari. The iOS app is not built (it needs a Mac and a paid Apple account).

## 4. Switches (Administration › Meeting Features)

| Switch | Turns on |
|---|---|
| **Chat** | Chat, groups, files, presence |
| **Audio calls in Chat** | Calls (needs Chat) |
| **Notes, tasks and My Day** | Private notes, tasks, reminders and My Day (needs Chat) |
| **Advanced chat** | Scheduled, saved and pinned messages; @mentions; search filters; quiet hours; favourites; follow-up panel (needs Chat) |

Switching any of these off hides the feature for everyone straight away. **Nothing is deleted.**

## 5. Android app

- Download: `https://www.oneinsure.com/meet/get-app`. Version **1.1.0** (20 Nov 2026).
- People with the app are offered the update when they open it.
- The app is the same portal inside a secure shell. It gets every new website feature automatically, with no reinstall. It adds:
  - presenting the phone screen in meetings;
  - keeping a call or meeting alive in the background.
