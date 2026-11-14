# Background effects, noise suppression and camera switching (13 Nov 2026)

**Status:** built and tested locally. **Not deployed.** Each part has its own switch in Administration → Meeting features (`BACKGROUND_EFFECTS`, `NOISE_SUPPRESSION`, `CAMERA_FLIP`); all are off by default.

## Background blur and backgrounds
- **Where:** Settings panel (or Tools → Background & audio) → **Background**:
  - None, Blur or *Your picture*;
  - four bundled backgrounds: Modern office, OneInsure blue, Neutral grey, Soft studio. These are our own SVG drawings, so there's no licence issue.
- **Processing:** entirely in the participant's browser (WebGL), with the MediaPipe selfie segmenter through `@livekit/track-processors`. The camera picture is never uploaded for processing. The engine files are **self-hosted** under `/meet/mediapipe/`; test MF-08 checks that all three MediaPipe downloads come from our own server.
- **Your picture** stays in the browser (an object URL). It is never uploaded. JPG, PNG or WebP up to 8 MB.
- **Effect on others:** the participant's **published** camera track carries the effect, so others see it. Recordings show the same picture as other participants see.
- **Fallbacks:**
  - A browser without WebGL2 sees "This browser or device can't run background effects".
  - If the effect fails to start, the original camera picture is used automatically, with a message.
  - Nothing is forced on anyone; the default is None.
- **Camera turned off and on:** the chosen effect is applied again automatically.
- **Code:** `frontend/src/pages/room/features/MediaEffects.tsx`.
- **IIS:** `web.config` gains MIME types for `.wasm` and `.tflite` (needed on deployment).

## Noise suppression
- **Today (unchanged):** every microphone uses the browser's WebRTC echo cancellation, noise suppression and automatic gain control.
- **New switch** ("Background noise suppression"): lets a participant turn noise suppression and auto-gain **off** (for music, or a very quiet room) and back on. Echo cancellation always stays on.
- **How:** the microphone track is restarted in place with the new settings. The call continues; there is no reconnect. If the restart fails, the previous setting is restored, with a message.
- **RNNoise** ("advanced" machine-learning suppression, BSD-3) was **not** added. The browser's own processing is already active, and adding RNNoise would mean an extra audio worklet on every device. It can be evaluated later if real-device tests show a need.

## Camera switching
- Changing camera from the Settings panel's Camera list **already existed** (no change).
- **New:** a **Switch camera** button that cycles through the device's cameras (front/rear on phones, laptop/USB on computers). It uses LiveKit `switchActiveDevice`: the track is replaced in place and the meeting, recording and everyone's view continue. It appears only when the device has 2 or more cameras.

## Tests actually run
- **MF-08 (PASS):**
  - the employee chose Blur, then OneInsure blue, with no error;
  - the employee's own tile shows the blurred picture;
  - the host kept receiving the employee's video;
  - 3 MediaPipe requests, all to the app's own origin.
- **MF-09 (PASS):** with noise suppression off, then on again, the host kept receiving the employee's audio (about 37 KB per 3 s each time).
- **MF-10 (NOT TESTED):** the headless test browser has only one fake camera, so the button is correctly hidden. Needs a real phone or a PC with two cameras.
- **Not tested at all:** real laptop microphones, headsets, Android and iPhone. Real-device UAT is needed.
