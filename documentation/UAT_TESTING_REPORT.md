# UAT testing report — advanced meeting features

Two separate columns on purpose: **Dev status** is what the development team verified (automated tests, browser tests). **UAT** is your acceptance and stays *Pending* until you test and confirm it. Nothing here is accepted on your behalf.

Legend: ✅ passed · ❌ failed · ⏳ pending · ➖ not applicable yet

Environment for UAT: this laptop (`https://localhost:5173`) or LAN mode (`https://192.168.2.77:5173`, run `scripts\lan\enable-lan-firewall.ps1` once as Administrator so other PCs can connect). Database `Oneinsure_v`.

## Phase B — Instant meeting, shareable link, guest waiting room

Dev verification 2 Nov 2026: API tests 72/72, browser test `tests/e2e/room/instant-link.mjs` **8/8** (Edge, fake camera/mic, isolated LocalDB). UAT: **pending**.

| ID | Test | Steps | Expected | Dev status | UAT |
|---|---|---|---|---|---|
| B-01 | Start an instant meeting | Dashboard → **New meeting** → title → **Start meeting** → **Start meeting** on the pre-join screen | Room opens; the **Invite** dialog shows the meeting link; meeting appears as *Instant* in My meetings; no e-mails sent | ✅ API + browser (IL-01) | ⏳ |
| B-02 | Camera off at start | New meeting → switch off "Start with my camera on" | Pre-join opens with the camera off | ✅ (code path; covered by IL-07 for audio-only) | ⏳ |
| B-03 | Audio-only meeting | New meeting → "Audio-only meeting" on | Pre-join says *Audio-only meeting*, no camera choice; no camera button in the room; camera refused by the video server | ✅ API (token) + browser (IL-07) | ⏳ |
| B-04 | Copy / e-mail / share the link | In the room: **Invite** → Copy link / E-mail | Link copied; e-mail draft opens with the link | ✅ copy (IL-01) | ⏳ |
| B-05 | Guest joins without login | Open the link in another browser (or a private window / another PC) → **Join meeting** → type a name → **Ask to join** | "Please wait, the host will let you in soon"; the guest sees nothing of the meeting | ✅ API + browser (IL-02) | ⏳ |
| B-06 | Guest waits while the host is absent | Guest asks to join before the host has entered | Guest keeps waiting; never admitted automatically | ✅ API (`Link_guests_always_wait…`) | ⏳ |
| B-07 | Host admits the guest | Host: Participants badge → entry says "Guest · via meeting link" → **Admit** | Guest enters the room; both see and hear each other | ✅ API + browser (IL-03) | ⏳ |
| B-08 | Host denies the guest | **Deny** instead of Admit | Guest sees "The host has not let you in" | ✅ API (existing waiting-room test) | ⏳ |
| B-09 | Remove and block | Participants → remove the guest → tick "Do not allow them to rejoin" | Guest sees "You were removed"; asking again is refused | ✅ API + browser (IL-05) | ⏳ |
| B-10 | Colleague not invited uses the link | Signed in as Sagar → Dashboard **Join meeting** → paste the link → **Continue as …** → Ask to join | Waits; host sees "Colleague (not invited)"; after Admit Sagar is in the room as an employee and the meeting appears in his list | ✅ API + browser (IL-04) | ⏳ |
| B-11 | Join by code | Dashboard **Join meeting** → type the code (e.g. OIC-261102-AB12) | Opens the meeting if you are invited; otherwise "No meeting with this code was found among your meetings" | ✅ API | ⏳ |
| B-12 | Replace / withdraw the link | Meeting page → *Meeting link* card → **New link** / **Withdraw** | Old link shows "This meeting link no longer works" | ✅ API + browser (IL-06) | ⏳ |
| B-13 | Ended meeting | Use the link after **End for all** | "This meeting has ended"; asking is refused | ✅ API | ⏳ |
| B-14 | Link page on a phone | Open the link on an Android/iPhone browser | Fits the screen, no sideways scrolling | ✅ browser at 390 px (IL-08) | ⏳ |
| B-15 | Guessing protection | Many wrong links from one address | After 30/min the server answers "Too many requests" | ✅ API (rate-limit test) | ⏳ |

Known limits (by design, documented): someone who holds a shared link can ask again under a new name after being blocked — the host denies them, or replaces/withdraws the link, or (Phase E) locks the meeting. A permanent personal meeting link (PMI) is deferred. Guests cannot be made host (database rule; needs a policy decision).

## Mobile (Android and iOS)

Dev verification 3 Nov 2026: `tests/e2e/room/mobile-audit.mjs` 7/7 (Edge with phone viewports and touch: 360, 390, 430, 768 px; room portrait and landscape). Real phones: **not yet tested** (needs LAN mode with the firewall rule, or the server).

| ID | Test | Expected | Dev status | UAT |
|---|---|---|---|---|
| M-01 | Sign in on an Android phone (Chrome) and an iPhone (Safari) | Page fits, no sideways scrolling, fields do not zoom on iPhone | ✅ emulated | ⏳ |
| M-02 | Bottom tab bar: Home, Meetings, +, Calendar, Alerts | Each opens; + starts a new meeting | ✅ emulated | ⏳ |
| M-03 | Join a meeting on the phone (portrait) | Six large buttons fit; More shows the rest; chat and participants open full width | ✅ emulated | ⏳ |
| M-04 | Turn the phone to landscape | Video larger, toolbar still fits | ✅ emulated | ⏳ |
| M-05 | Guest opens a meeting link on a phone | Join page fits; waiting room; admitted into the room | ✅ emulated (IL-08) | ⏳ |
| M-06 | Add to home screen (Android: "Install app"; iPhone: Share → Add to Home Screen) | OneInsure Connect icon; opens full screen | ⏳ needs https on a real phone | ⏳ |
| M-07 | Present screen on a phone | Not offered (browser limitation) | ✅ | ⏳ |

## Phases C–H

Added here as each phase is delivered.
