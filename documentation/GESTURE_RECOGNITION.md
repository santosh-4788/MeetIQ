# Gesture recognition: plan (13 Nov 2026)

**Status:** **NOT BUILT** (experimental; planned after the other features are accepted).

## Feasibility
**Feasible and free:**
- MediaPipe Gesture Recognizer (Apache-2.0) runs in the participant's browser with the same self-hosted `tasks-vision` runtime already used for background blur.
- No video is uploaded and there is no server cost.

## Planned behaviour
- **Switch:** its own feature switch (`GESTURES`), off by default, plus a per-participant opt-in that is visibly marked "Gesture detection on".
- **Gestures and what they trigger:**
  - Raised hand → the existing Raise hand;
  - thumbs up / thumbs down → the matching reaction;
  - applause → the Applause reaction.
- **Safeguards:**
  - A gesture must be held for about 1 s and is ignored for a few seconds afterwards, to limit false positives.
  - Never changes microphone, camera or permissions.
- **Fallback:** the manual Raise hand and reaction buttons stay. It can be switched off at once, by the participant or by the administrator (emergency switch).
- **Cost to the device:** one more video-analysis model on the participant's device, so it is not recommended on low-end phones. The device is detected and the feature is offered only where it runs smoothly.
