# OneInsure Connect Android app — real-phone test checklist

Version 1.0.0 (code 1). Download: https://www.oneinsure.com/meet/get-app (after the deploy).
Fill in one column per phone. Mark each row Pass / Fail, and for a Fail write what you saw (a screenshot helps).

**Phones to cover, at least:**
- one recent Android (14 or 15);
- one older Android (8 to 10);
- one Samsung;
- one low-cost phone (Redmi, Realme or similar).

**What was already tested on the server** (no phone needed):
- the screen-only token's limits, and removal by the host;
- what other people see when a phone presents;
- the app's link and safety rules.

The rows below need a real phone.

| Phone → | | | | |
|---|---|---|---|---|
| Model / Android version | | | | |

## A. Install and start

| # | Steps | Expected |
|---|---|---|
| A1 | Open /meet/get-app in Chrome on the phone and tap Download | The file `OneInsureConnect.apk` (about 26 MB) downloads |
| A2 | Open the file. Allow "install unknown apps" if asked, then Install | Installs. The icon "OneInsure Connect" appears |
| A3 | Open the app | The sign-in page of OneInsure Connect. No browser address bar |
| A4 | Sign in (with MFA if it is on), close the app, open it again | Still signed in |
| A5 | Turn on airplane mode and open the app | "No internet connection" with **Try again**. Turn the internet on, tap it, and the page loads |

## B. Links

| # | Steps | Expected |
|---|---|---|
| B1 | In WhatsApp or e-mail, tap a meeting link (`…/meet/m/…`) | Android offers "OneInsure Connect". The link page opens in the app |
| B2 | Tap a personal customer/guest link (`…/meet/join/…`) | It opens in the app, at the join page for that person |
| B3 | In the app, tap **Invite → WhatsApp** (or E-mail) | WhatsApp (or the mail app) opens with the message. Going back returns to the meeting |
| B4 | Tap any link to a different website (if any) | It opens in Chrome, not inside the app |

## C. Meeting basics (same as the website)

| # | Steps | Expected |
|---|---|---|
| C1 | Join a meeting with camera and microphone on | Android asks for Camera and Microphone **once**. Others see and hear you |
| C2 | Deny the camera, then turn it on in the meeting | A clear message. After allowing it in Settings → Apps → OneInsure Connect → Permissions, it works |
| C3 | Mute/unmute and camera on/off several times | Works every time, with no "being used by another app" message |
| C4 | Chat, raise hand, participants list, polls (if switched on) | As on the website |
| C5 | Rotate the phone during the meeting | The call continues. The layout fits |
| C6 | Press the phone's Back button in the meeting | "Leave the meeting?" appears. **Stay** keeps you in |
| C7 | Lock the screen for 30 s, then unlock | The call is still running |

## D. Background (the app keeps the call going)

| # | Steps | Expected |
|---|---|---|
| D1 | In a meeting, press Home and open WhatsApp for about 1 minute | A notification "In a OneInsure Connect meeting" shows. **Others still hear you.** Your video pauses |
| D2 | Tap that notification | Back in the meeting. Your video resumes |
| D3 | Leave the meeting | The notification disappears |
| D4 | In a meeting, swipe the app away from recent apps | You leave the meeting. No notification stays behind |

## E. Presenting the phone screen (new)

| # | Steps | Expected |
|---|---|---|
| E1 | In a meeting, tap **More (⋯) → Present** | Android asks "Start recording or casting with OneInsure Connect?" (on Android 14+ you can pick "A single app" or "Entire screen") |
| E2 | Tap **Start now** | A notification "You are presenting your screen" with **Stop presenting**. In the meeting, a bar "You're presenting your phone screen · Stop" |
| E3 | Others in the meeting (on a computer and on a phone) | They see your phone screen with "**your name** is presenting". The participant count does **not** go up |
| E4 | Open other apps (Gallery, a PDF, WhatsApp) while presenting | Others see whatever is on your screen, readable |
| E5 | Tap **Stop** in the meeting bar | Presenting stops for everyone. The notification goes |
| E6 | Present again and tap **Stop presenting** in the notification | Same as E5 |
| E7 | Present again and stop it from Android's quick settings (the cast/recording tile) | Presenting stops. The meeting goes on |
| E8 | Tap Present and then **Cancel** at Android's question | Nothing is shared. No error message |
| E9 | Present, then the host removes you from the meeting | Your phone screen disappears for everyone at once |
| E10 | Present, then the host ends the meeting | Everything stops. No notification stays behind |
| E11 | Present on mobile data (Wi-Fi off) | Others can still read the screen. It may be a little less sharp on a weak signal |
| E12 | A meeting that is being **recorded**: present the phone screen, then check the recording afterwards | The recording shows the phone screen as "**name** is presenting". There is no extra person tile |
| E13 | A customer/guest (personal link or meeting link) presents from the app | Same as E1 to E3 |

## F. Files and other screens

| # | Steps | Expected |
|---|---|---|
| F1 | Download a report (CSV) or minutes (PDF) | "Saved to Downloads: …" and the file opens from Downloads |
| F2 | Play a recording | It plays. Fullscreen works |
| F3 | Open a shared screen in fullscreen (viewer toolbar → Fullscreen) | Fullscreen. Back exits it |

## G. Update

| # | Steps | Expected |
|---|---|---|
| G1 | (When version 1.0.1 is published) open the app | "Update available" → **Download** opens the new APK. Installing it keeps you signed in |

Send the filled checklist back with the phone models. Any Fail is fixed and re-tested before the app is rolled out widely.
