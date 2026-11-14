# AI meeting assistant: Phase 1 assessment and plan (13 Nov 2026)

**Status:** **NOT BUILT.** Nothing is installed or switched on, and no audio is processed. This document covers what was inspected and the plan that awaits approval.

## Why it is not built yet
1. **Feasibility on this server is unknown.**
   - The server has no GPU and a 2012 CPU without AVX2 (see `RESOURCE_BENCHMARK.md`).
   - Its CPU is shared with about 70 live websites and the live meeting service.
   - Local speech-to-text and a local language model must be **measured** here before anything is promised.
   - The benchmark (portable binaries in a scratch folder, below-normal priority) was stopped by the session's safety check and needs your explicit approval.
2. **Policy.** Transcribing meetings is processing of personal data, and of customer data in PLVC meetings. The request itself requires a participant notice and an approved policy. No approved transcription/AI wording or retention rule exists yet; it must come from the business or Compliance, not be invented.

## Existing architecture the assistant would reuse (inspected)
- **R2 recorder** produces verified MP4 files (H.264/AAC) for recorded meetings. That makes **post-meeting transcription from the recording** the lowest-risk path: no extra load during the call, and it reuses consent that has already been collected.
- **SQL job pattern:** `rec.RecordingJobs`-style persistent jobs with workers (recorder, reminders, webhooks) already exist. A similar `app.AiJobs` table (Queued / Processing / Completed / Failed / Cancelled, retries, idempotent by meeting and job type) fits the same pattern.
- **LiveKit:** live captions would need a server-side participant ("agent") subscribing to audio. That is new, and the CPU-heaviest option.

## Proposed design (for approval, not implemented)

| Area | Proposal |
|---|---|
| States | Available → Added → Active ⇄ Paused → Stopped → Processing → Completed / Failed. Every change is audited. |
| Controls | Host/organiser only: add, activate, pause, resume, stop, remove, view status, view the summary and minutes. |
| Notice | Shown to all participants when activated (wording from Compliance). It must not bypass recording consent. |
| Transcription | whisper.cpp (MIT) after the meeting, from the recording's audio (extracted with FFmpeg to 16 kHz WAV). English and Hindi. Mixed Hindi-English only "where technically possible", measured on real samples. Unclear audio is marked `[unclear]`. Speakers are labelled Speaker 1/2 unless reliable. |
| Summary and minutes | A local language model through llama.cpp (portable), run as a background job: one at a time, below-normal priority, off-hours if needed. The prompt forces "use only the transcript", and "Not specified – Please review." for missing owners or dates. Every output is labelled **"AI Generated – Pending Human Review"**. |
| Review workflow | Preview → Edit → Save draft → Approve (authorised user only) → share by e-mail or download PDF/DOCX, with version history. Nothing is sent to customers automatically. |
| Exclusions | Private messages are never sent to AI. No automatic actions (no tasks, record changes or e-mails). |
| Resource limits | Concurrency 1, a CPU priority cap, a queue length limit, and deferral while meetings or recordings are active. An emergency switch, like the one already built for the collaboration features. |

## What is needed from you to continue
1. Approval to run the local benchmark (see `RESOURCE_BENCHMARK.md`).
2. The approved participant notice wording for AI transcription and summaries, and a retention period for transcripts and minutes (Compliance).
3. A decision on scope:
   - post-meeting only (recommended on this hardware), or
   - live captions as well (only if the benchmark shows real-time headroom).

Related: `AI_PRIVACY_AND_PROCESSING.md`, `TRANSCRIPTION_AND_MOM.md`.
