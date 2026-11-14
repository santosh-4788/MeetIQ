# Whiteboard (13 Nov 2026)

**Status:** built and tested locally. **Not deployed.** Off by default (Administration → Meeting features → Whiteboard).

## What participants get
- **Tools:**
  - pen, highlighter (see-through), eraser (removes the item touched);
  - line, arrow, rectangle, circle;
  - text and sticky notes;
  - 6 colours and 3 thicknesses;
  - undo/redo of your own changes;
  - clear board, with confirmation; clearing can also be undone.
- **Downloads:** PNG and PDF, for everyone in the meeting. The PDF is a single landscape page, about 30 KB.
- **Opening and closing:**
  - The host or a co-host opens it from **Tools → Open whiteboard**; it then replaces the video area for everyone. Audio continues.
  - Anyone can press **X / "Hide whiteboard"** to go back to the video for themselves only.
  - **Close for all** (host) removes it for everyone.
- **Who may draw** (host menu): *Only hosts* (default), *Everyone*, or *Selected people* (a tick-list of participants). Everyone else sees "View only".
- **Late joiners and reconnects** load the latest saved board.
- **Insurance examples:** explaining products, benefits, premium calculations, coverage and comparisons. The sticky note in the test reads "Premium: ₹12,000 / year".

## How it works
| Part | Detail |
|---|---|
| Drawing engine | Our own canvas code (`frontend/src/pages/room/features/Whiteboard.tsx`). No third-party whiteboard service or library. Excalidraw was evaluated and rejected: 12 known vulnerabilities in its dependencies; see `OPEN_SOURCE_LICENCE_REVIEW.md`. |
| Coordinates | A fixed 1600 × 900 board, scaled to each screen, so every participant sees the same layout on desktop and phone. |
| Live sync | Each change is a small message over the meeting's own LiveKit connection (topic `oic.wb`). Pen strokes stream while they are drawn. Very long strokes are split so each message stays well under the data-packet limit. |
| Permission check | The **server** announces the open/closed state and who may draw (topic `oic.wb-state`, sent by the API, so it cannot be faked by a participant). Browsers ignore drawing messages from anyone not allowed to draw. |
| Saving | Whoever draws saves the whole board to `mtg.MeetingWhiteboards.SceneJson`, debounced by about 1.2 s and capped at 2 MB. The API checks that the meeting is in progress, the board is open, and the caller may draw. |
| Audit | `WHITEBOARD_OPENED`, `WHITEBOARD_CLOSED`, `WHITEBOARD_ACCESS_CHANGED`, with the host as actor. |

## API (employees: session; customers/guests: invitation token)
- `GET /api/v1/meetings/{id}/room/whiteboard` and `GET /api/v1/join/{token}/whiteboard`: state, scene, version, `canDraw`, `canManage`.
- `POST /api/v1/meetings/{id}/room/whiteboard/state` (hosts only): `{ open?, drawMode?: HOSTS|EVERYONE|SELECTED, allowed?: [identity] }`.
- `PUT /api/v1/meetings/{id}/room/whiteboard/scene` and `PUT /api/v1/join/{token}/whiteboard/scene`: `{ baseVersion, scene }`.

## Known limits
- Pictures cannot be pasted onto the board.
- Undo/redo covers your own changes only.
- On a phone the board is small in portrait; turning the phone sideways helps.
- When two people draw at the same moment, both strokes appear live. The saved copy is the latest full board from whoever saved last, and each drawer's board already contains the other's strokes.

## Tests actually run
`tests/e2e/room/meeting-features.mjs`:
- **MF-06:** host opens; the employee is view-only and their drag changes nothing; the host's rectangle appears at the employee (2,438 inked pixels); the host grants Everyone; the employee's stroke appears at the host; a sticky note with ₹ text is saved (scene v3); PNG 44,720 B and PDF 29,002 B downloaded with valid file headers; audit rows present.
- **MF-07:** a guest on a 390 px phone joins late and sees the saved board; no horizontal overflow; "Close for all" removes it everywhere.

## Rollback
Switch the feature off: the board disappears and saved boards are kept. For full removal, see `ROLLBACK_PLAN.md`.
