# AI privacy and processing rules (13 Nov 2026)

**Status:** rules that any future AI feature must follow. **No AI processing exists in the application today.**

| Rule | How it will be enforced |
|---|---|
| Off by default; the host activates it explicitly | Feature switch (like `app.FeatureSettings`), plus a per-meeting activation by the host or organiser, audited. |
| Participant notice before any processing | Shown in the room, using the same mechanism as the recording notice. The wording must be approved by Compliance, not invented. |
| Existing recording consent is not bypassed | Transcription from a recording is allowed only where that recording was lawfully made under its policy. |
| No external or cloud AI | Only local engines (whisper.cpp, llama.cpp) on company servers. No audio, transcript or summary leaves the server. Browser speech APIs that send audio to a cloud are not used. |
| Data isolation | Each job is tied to one meeting ID. Its input is read only from that meeting's recording or transcript, never from other meetings. Output is stored against the same meeting, with source references (timestamps). |
| Private messages excluded | `mtg.PrivateMessages` is never an AI input unless a separate approved policy says otherwise. |
| Access | Existing roles: the meeting owner and host, plus administrators with view-all. Customers see minutes only when an authorised employee shares an approved version. |
| No fabricated content | Output labelled "AI Generated – Pending Human Review". Missing facts written as "Not specified – Please review." No commitments, tasks or customer messages are created automatically. |
| Retention and legal hold | Follow the approved recording retention once Compliance sets it. Legal hold is respected. No automatic deletion until a rule is approved (matching the current recording behaviour). |
| Storage paths and credentials | Never shown in the UI or API responses (same rule as recordings). |
