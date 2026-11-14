# Resource benchmark: server inspection for the optional features (13 Nov 2026)

These are measured facts only. Anything not measured is marked **NOT MEASURED**, with the reason.

## Server (measured 13 Nov 2026, about 22:40 IST, read-only commands)

| Item | Value |
|---|---|
| CPU | 2 × Intel Xeon E5-2670 @ 2.60 GHz (Sandy Bridge, 2012). 8 cores / 16 logical processors each, 32 logical in total. |
| CPU instruction sets relevant to AI | **AVX: yes. AVX2 / FMA / F16C: no.** Modern AI runtimes use AVX2 builds by default, so they run slower here, or need an AVX-only build. |
| GPU | None ("Microsoft Basic Display Adapter", 0 MB VRAM). |
| RAM | 128 GB total, about 49.8 GB free at the time. |
| Disk free | C: 174 GB, E: 188 GB, F: 157 GB, Y: 2.6 TB, Z: 274 GB. |
| CPU load (3 samples, 2 s apart) | 22.5 %, 47.2 %, 12.9 % (the two CPUs reported 13 % and 51 %). |
| Shared with | About 70 live IIS websites, the live MeetIQ API and LiveKit. |

## What this means

| Feature | Where it runs | Server cost | Assessment |
|---|---|---|---|
| Reactions, polls, private messages, whiteboard | Browser, plus small API calls | A few SQL rows per action. Whiteboard: one save every few seconds while someone draws, up to 2 MB per board. | Negligible. |
| Background blur / image | Participant's browser (WebGL) | None | Uses the participant's device. Low-end phones may get a less smooth picture, and the participant can choose "None". |
| Noise-suppression switch | Participant's browser | None | |
| Post-meeting transcription (whisper.cpp) | Server CPU | **NOT MEASURED** | The benchmark (download whisper.cpp plus a model into a scratch folder and run it at below-normal priority) was stopped by the session's safety check and needs your approval. Without AVX2 and without a GPU, expect slower than typical published figures. It must be measured before any promise is made. |
| Live captions | Server CPU, in real time | **NOT MEASURED** | Same dependency. Live captions are the most demanding case: if the measured real-time factor isn't comfortably below 1 at low priority, captions should be post-meeting only. |
| Summary / minutes (local language model) | Server CPU | **NOT MEASURED** | Large models on an AVX-only CPU are likely to take minutes per meeting. It must run after the meeting, one job at a time, at low priority, so live calls and the 70 sites are never affected. |

## Recommended next measurement (needs your approval)

1. Download portable whisper.cpp and llama.cpp builds plus the models into a scratch folder. Nothing is installed system-wide and no service is created.
2. Run each test at **BelowNormal priority with 8 threads**, only while total CPU is under 70 %:
   - whisper `base` and `small` on English and Hindi samples;
   - one 7B and one small language model.
3. Record:
   - real-time factor, peak RAM and output quality;
   - the observed CPU impact on the shared server.
4. Delete the large model files afterwards.
