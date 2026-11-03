# R2 Windows-Native Recorder: Proof-of-Concept Report (INTERIM)

**Status: IN PROGRESS. NOT production-ready.** Update 31 Oct 2026 (mains power): 6 of 7 scenarios (T01, T03–T07) meet every criterion on the laptop. **T02 (6 participants) FAILS.** T08 soak, T09 concurrency and the Windows Server 2019 runs are still outstanding.
**Report date:** 31 Oct 2026 (day 1 of a ≤ 2-week trial)
**Test machine:** developer laptop: Intel i5-1235U (10 cores / 12 threads), 16 GB RAM, Windows 11 Pro, Edge 156, LiveKit 1.13.11 (native Windows), .NET 10.0.403, FFmpeg 7.1.1.
**⚠ Performance caveat:** day-1 numbers were taken **on battery** and are void. The 31 Oct scenario run (`tests/r2-poc/results/2026-10-31T02-00-35`) was **on mains power** (PowerOnline checked at start and end). These are still laptop numbers. The reference **Windows Server 2019** host has not yet been provided by IT.

## 1. What was built

| Component | Location | Separate from media server? |
|---|---|---|
| Recorder host (.NET 10 console → Windows Service later) | `backend/src/OneInsure.Connect.Recorder` | Yes. Talks to LiveKit only as a client |
| Composite layout page (headless Chromium) | `recording/layout` | Yes |
| Recording policy gate (shared domain library) | `backend/src/OneInsure.Connect.Domain/Recording` | n/a |
| LiveKit server (media infrastructure) | `video-server/` (native Windows binary, checksum-verified) | Separate process / server |
| Test harness (synthetic participants, fault injection, media analysis) | `tests/r2-poc/` | n/a |

**Flow:**

1. The policy gate runs first.
2. A short-lived recorder token is issued: hidden, subscribe-only, no publish, no data.
3. Headless Chromium joins the room. It composites the grid or screen-share layout with a REC timer and an IST timestamp, mixes all audio, and records VP8/Opus WebM in 2-second chunks. Every chunk is flushed to the spool immediately.
4. A supervisor detects stalls, crashes and disconnects, and restarts into a new segment while the meeting is live.
5. FFmpeg builds an H.264/AAC MP4 with faststart.
6. Verification checks codecs, resolution, duration against wall-clock time, a full decode with zero errors, moov-before-mdat, and a SHA-256.
7. The file is marked **COMPLETED only when verification passes**.

## 2. Test matrix and status

| # | Mandatory test (your list) | Status | Result / evidence |
|---|---|---|---|
| 1 | One-to-one meetings | ✅ PASS (laptop) | T01, 3 min, mute/unmute: 24.8 fps, A/V −46/86 ms, no gaps or freezes, verified MP4, Edge play/seek OK (31 Oct, mains power) |
| 2 | Multiple participants | ❌ **FAIL** | T02 (6 participants): A/V p95 **199 ms** (limit 150), continuity gaps 4–17 s and freezes 2.0–2.8 s while participants joined. Suspected CPU contention (6 synthetic browsers and the recorder on one laptop; joins ran ~10 s late). Re-run with participants on a second machine |
| 3 | Audio and video quality | 🟡 Mostly PASS | On mains power: **24.2–25 fps** in all scenarios (on battery: 9–10). A/V within limits in 6/7 scenarios (median −22 to −74 ms, p95 60–120 ms); T02 exceeds |
| 4 | Screen sharing | ✅ PASS (laptop) | T03: 25 fps, A/V −29/69 ms, no gaps or freezes |
| 5 | Participant join and leave | 🟡 Partial | T04 joins and rejoins PASS; T02 FAIL (see #2) |
| 6 | Temporary disconnection/reconnection | ✅ PASS (laptop) | T04 participant resume/full reconnect/hard drop + rejoin, T05 recorder signal/full reconnect, T06 SFU outage + restart: all PASS |
| 7 | Recording continuity | ✅ PASS (laptop) | T07: recorder browser killed → 1 restart → new segment → single verified MP4, gaps within the fault allowance |
| 8 | MP4 integrity and playback | ✅ Edge PASS | 7/7 verified MP4s play, seek and reach the end in Edge (after fixing a harness defect: no HTTP range support). Firefox/Safari/iOS not available on this PC |
| 9 | CPU and RAM consumption | 🟡 Laptop only | Recorder browser 0.43–1.09 cores avg, 1.9–2.2 GB RAM peak per recording. Server (WS2019) measurement pending |
| 10 | Concurrent recording sessions | ⏳ Not run | T09 ready (`--rooms N`) |
| 11 | Recording consent and security | ✅ **PASS** | Policy gate: **15/15 unit tests, 4/4 end-to-end refusals** (recorder never joins). Security: recorder **hidden** from participants, grants `hidden`/`recorder`, **cannot publish media or data**, 0 published tracks, **no listening sockets**, output filename contains **no customer/policy/title data** |

## 3. Pass criteria (applied by `tests/r2-poc/harness/run.mjs`)

A test passes only if **all** of these hold:

- Verified COMPLETED MP4.
- Encoded composite ≥ 20 fps.
- A/V offset |median| ≤ 80 ms and p95 ≤ 150 ms (flash/beep method).
- No continuity gap > 2.6 s or freeze > 2.5 s outside deliberate fault windows (≤ 10–40 s allowed during injected faults).
- Duration within tolerance.
- Plays and seeks in Edge.

## 4. Defects found and fixed during the PoC (day 1)

| # | Finding | Fix |
|---|---|---|
| 1 | **Chromium Local Network Access** blocks the recorder page from reaching LiveKit on a loopback/private IP | Recorder grants `local-network-access` to its own internal origin only |
| 2 | LiveKit ICE excluded loopback; when allowed, it advertised **every interface** (hotspot IPv6, Hyper-V vEthernet), and browsers chose a path with 1.5–2.4 s RTT | Pin ICE to the intended IP (`rtc.ips.includes`). **Production must pin to the media NIC.** Added to the network document |
| 3 | Off-screen muted `<video>` elements are paused by Chromium → frozen tiles | Frames read directly from tracks (WebCodecs `MediaStreamTrackProcessor`) |
| 4 | `canvas.captureStream()` depends on compositor paints, which headless Chromium throttles | Frames pushed explicitly (`MediaStreamTrackGenerator`) |
| 5 | Chunk transfer bug: the data-URL codec list contains a comma | Fixed parsing |
| 6 | Expected duration computed from chunk arrival, not recorder start/stop | Uses page-reported start/stop |
| 7 | `ffmpeg` on PATH is a Chocolatey shim (hides FFmpeg CPU) | Explicit FFmpeg path in configuration |
| 8 | .NET 10 runtime not found (user-profile install) | Production: install the .NET 10 runtime or publish self-contained |
| 9 | **MediaRecorder H.264 output fails full-decode verification** (12–38 errors) | H.264 remux path **rejected**; VP8 → FFmpeg transcode retained |

## 5. Windows-specific findings

- LiveKit runs natively on Windows, but logs **"Windows detected, capacity management is unavailable"**. The SFU cannot reject new joins when the CPU is saturated, so the **application must enforce room/participant limits itself**.
- The browser receives **no third-party STUN/TURN servers** (`iceServers: []`). No external service is contacted.
- LiveKit's RTC TCP port binds to all interfaces. Host firewall rules and IP pinning are required (see the network document).

## 6. Open risk to watch

The main open risk is the **composite frame rate**. If, on mains power and on the server, the recorder still encodes below 20 fps at 720p, the options are (in order):

1. 720p at 15 fps for 1:1 PLVC.
2. Hardware-accelerated encode (GPU on the server).
3. R3: per-track recording with an FFmpeg composite afterwards (Windows-native).

If none meets the criteria, I will **stop and provide the technical comparison** you asked for, including R1. I will not introduce Linux.

## 7. Next steps (remaining trial)

1. Re-run the benchmark and T01–T07 on mains power on this laptop.
2. Run T08 (30-minute soak) and T09 (1/3/5 concurrent rooms).
3. **Needs IT:** a Windows Server 2019 test VM/host (suggest ≥ 8 vCPU, 16 GB) to repeat everything on the target OS.
4. Final report with PASS/FAIL per mandatory test and a production-readiness recommendation.

## 8. How to reproduce

```powershell
powershell -File video-server\start-dev.ps1                 # LiveKit (loopback)
cd recording\layout; npm install; npm run build
cd backend; $env:DOTNET_ROOT="$env:USERPROFILE\.dotnet"; dotnet build -c Release
cd tests\r2-poc; npm install; npx vite build participant
node harness\run.mjs T01 T02 T03 T04 T05 T06 T07
node harness\run.mjs T09 --rooms 3
```
