# Open-source licence review: optional meeting features (13 Nov 2026)

**Scope:** what was added, or evaluated, for the "Advanced AI & collaboration" request.

**How it was checked:** each licence was read from the installed `package.json` / LICENSE, or from the publisher's model card. Nothing below needs a payment, an account or a subscription.

## 1. Added to the application (built and tested locally, not deployed)

| Component | Version | Licence | Commercial use | Where it runs | Notes |
|---|---|---|---|---|---|
| `@livekit/track-processors` | 0.8.2 (published 12 Oct 2026) | Apache-2.0 | Yes | Participant's browser | Background blur and image. Loaded only when a participant picks an effect. |
| `@mediapipe/tasks-vision` (dependency of the above) | 0.10.14 | Apache-2.0 | Yes | Participant's browser | The WASM runtime is **self-hosted** at `/meet/mediapipe/wasm/` (copied from the npm package). |
| MediaPipe *selfie segmenter* model `selfie_segmenter.tflite` (float16) | "latest", SHA-256 `191ac952…658b`, 249,537 bytes | Apache-2.0 (MediaPipe model card) | Yes | Participant's browser | Downloaded once from `storage.googleapis.com/mediapipe-models/…` and **self-hosted** at `/meet/mediapipe/`. No CDN is contacted during a meeting (the browser test MF-08 checks this). |
| `jspdf` | 4.2.1 | MIT | Yes | Participant's browser | Whiteboard PDF export. Loaded only when "Download PDF" is clicked. |
| `jspdf` dependencies: `@babel/runtime`, `core-js`, `fflate`, `fast-png`, `canvg`, `html2canvas` | as installed | MIT | Yes | Browser | |
| `dompurify` (optional dependency of jspdf) | 3.4.17 | MPL-2.0 **or** Apache-2.0 | Yes (we use it under Apache-2.0) | Browser | Not called by our code. |
| Four background pictures (`/meet/backgrounds/*.svg`) | — | Own work (drawn for this project) | Yes | Browser | No stock images, so no image-licence question. |
| Whiteboard | — | Own code | — | Browser and API | See §3 for why no whiteboard library is used. |

`npm audit --omit=dev` after adding these: **0 vulnerabilities**.

## 2. Evaluated but NOT used

| Component | Licence | Why not used |
|---|---|---|
| Excalidraw (`@excalidraw/excalidraw` 0.18.1) | MIT | Installed, then removed. It brought **12 known vulnerabilities (9 high)** through its dependencies: mermaid, langium/chevrotain, lodash-es and nanoid. A small whiteboard of our own covers the requested tools with no extra dependencies. |
| tldraw | Own licence: a licence key is required for production use | Not free for production. |
| Browser Web Speech API (live captions) | — | In Chrome/Edge the audio goes to the browser maker's cloud service. That breaks "no external cloud AI processing". |

## 3. Evaluated for the AI parts: NOT installed, decision needed

These have not been downloaded, installed or benchmarked. The local benchmark (downloading the binaries and models into a scratch folder and running them on this shared server at low priority) was **stopped by the session's safety check** before it ran, and needs your explicit approval.

| Component | Licence (as published) | Commercial use | Notes to verify before use |
|---|---|---|---|
| whisper.cpp (speech-to-text engine) | MIT | Yes | Windows CPU builds exist. This server's CPU (Xeon E5-2670, 2012) supports **AVX but not AVX2**, so speed must be measured, not assumed. |
| OpenAI Whisper model weights (ggml conversions) | MIT | Yes | Hindi is supported. Accuracy on Hindi-English mixed speech must be measured on real recordings. |
| llama.cpp (local language-model runtime) | MIT | Yes | Portable zip, no service needed. |
| Ollama | MIT | Yes | Installs a background app/service, so llama.cpp (portable) is preferred on a shared server. |
| Qwen2.5-7B-Instruct | Apache-2.0 | Yes | **Trap:** some Qwen2.5 sizes (for example 3B) use the "Qwen Research" licence, which does **not** allow commercial use. Check the exact model card. |
| Microsoft Phi-4-mini-instruct | MIT | Yes | Small model; candidate if 7B is too slow on this CPU. |
| Meta Llama 3.x | Llama Community Licence | Conditional (attribution; 700M-MAU limit) | Usable, but not OSI open source. |
| Google Gemma | Gemma Terms of Use | Conditional (use restrictions) | Read the terms before choosing. |
| MediaPipe Gesture Recognizer (model + `tasks-vision`) | Apache-2.0 | Yes | Same self-hosting approach as background blur. Planned after the other features are accepted. |
| RNNoise (advanced noise suppression) | BSD-3-Clause | Yes | Not added. The browser's own WebRTC noise suppression is used and can be switched off and on. |
