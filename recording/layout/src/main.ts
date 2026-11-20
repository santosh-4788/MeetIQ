/**
 * OneInsure Connect — R2 recorder composite page (proof of concept).
 *
 * Runs inside headless Chromium controlled by the OneInsure.Connect.Recorder host.
 * It joins the LiveKit room as a hidden, subscribe-only participant, draws every
 * participant (and any screen share) onto a canvas, mixes all remote audio with
 * WebAudio, records canvas + audio with MediaRecorder, and hands timesliced chunks
 * to the host through Playwright bindings. The host owns files, FFmpeg and status.
 */
import {
  ConnectionState, DisconnectReason, Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent, Track,
  type SimulationScenario,
} from 'livekit-client'
// The meeting room's own whiteboard drawing code, so the recording shows the board exactly as participants see it.
import { BOARD_H, BOARD_W, applyOpTo, mayDrawRole, parseScene, renderBoard, type Op, type Shape } from '../../../frontend/src/pages/room/features/whiteboardRender'

type RecorderConfig = {
  url: string
  token: string
  meetingTitle: string
  timeZone: string
  width: number
  height: number
  fps: number
  videoBitsPerSecond: number
  audioBitsPerSecond: number
  timesliceMs: number
  /** 'vp8' (transcoded to H.264 by FFmpeg) or 'h264' (remuxed, if the browser can encode it). */
  videoCodec: 'vp8' | 'h264'
  /** 'generator' pushes a VideoFrame per draw; 'capture' uses canvas.captureStream(). */
  captureMode?: 'generator' | 'capture'
}

declare global {
  interface Window {
    __OIC_REC__: RecorderConfig
    oicChunk: (seq: number, base64: string) => Promise<void>
    oicEvent: (json: string) => Promise<void>
    oicControl: {
      start: () => Promise<{ mimeType: string; width: number; height: number }>
      stop: () => Promise<void>
      status: () => RecorderStatus
      simulate: (scenario: SimulationScenario) => Promise<void>
    }
  }
}

type RecorderStatus = {
  roomState: string
  recorderState: string
  participants: number
  videoTracks: number
  audioTracks: number
  framesDrawn: number
  chunksSent: number
  bytesSent: number
  pendingChunks: number
  lastChunkAtMs: number
  mimeType: string
  trackFrames: Record<string, number>
  framesPushed: number
  framesDropped: number
  avgDrawMs: number
  avgPushMs: number
}

const cfg = window.__OIC_REC__
const canvas = document.getElementById('stage') as HTMLCanvasElement
// Locked once, a few seconds in, by decideCanvasSize() below: group calls (3+) always stay landscape; a one-to-one
// call switches to a portrait canvas if either camera is portrait. MediaRecorder cannot change the resolution of a
// stream already in progress, so once start() locks this, it never changes again for the life of the recording.
let activeWidth = cfg.width
let activeHeight = cfg.height
canvas.width = activeWidth
canvas.height = activeHeight
const ctx = canvas.getContext('2d', { alpha: false })!
const mediaHost = document.getElementById('media')!

const emit = (type: string, data: Record<string, unknown> = {}) => {
  void window.oicEvent(JSON.stringify({ type, atUtc: new Date().toISOString(), ...data })).catch(() => {})
}

// ---------------------------------------------------------------------------
// Room

const room = new Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false })

// Decoded frames are pulled straight from each track (WebCodecs). <video> elements are NOT used:
// Chromium pauses muted autoplay videos that are off-screen, which froze the composite.
declare const MediaStreamTrackGenerator: new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }
type FrameSource = { frame: VideoFrame | null; reader: ReadableStreamDefaultReader<VideoFrame>; frames: number }
const videoEls = new Map<string, FrameSource>() // key: trackSid
const audioNodes = new Map<string, { el: HTMLMediaElement; source: MediaStreamAudioSourceNode }>()
let speaking = new Set<string>()

const audioCtx = new AudioContext({ sampleRate: 48000 })
const audioDest = audioCtx.createMediaStreamDestination()
// A silent constant source keeps the audio track continuous when nobody is publishing audio,
// so MediaRecorder timestamps never stall.
const keepAlive = audioCtx.createConstantSource()
keepAlive.offset.value = 0
keepAlive.connect(audioDest)
keepAlive.start()

room
  .on(RoomEvent.ParticipantConnected, (p) => emit('participant_joined', { identity: p.identity, name: p.name }))
  .on(RoomEvent.ParticipantDisconnected, (p) => emit('participant_left', { identity: p.identity, name: p.name }))
  .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
  .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
  .on(RoomEvent.ActiveSpeakersChanged, (ps: Participant[]) => (speaking = new Set(ps.map((p) => p.identity))))
  .on(RoomEvent.Reconnecting, () => emit('reconnecting'))
  .on(RoomEvent.SignalReconnecting, () => emit('signal_reconnecting'))
  .on(RoomEvent.Reconnected, () => emit('reconnected'))
  .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    const ended = reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED
    emit(ended ? 'room_ended' : 'disconnected', { reason: reason === undefined ? 'unknown' : DisconnectReason[reason] })
    void stopRecording()
  })
  .on(RoomEvent.DataReceived, onData)

// ---------------------------------------------------------------------------
// Whiteboard and polls (15 Nov 2026). Topics and trust rules are the meeting room's own: open/close, who may draw, the saved
// drawing and poll results come only from the server (no sending participant); strokes come from participants and are used
// only when that participant may draw. The server sends the state from before the recorder joined (RoomFeatureEndpoints).

const TOPIC_WB = 'oic.wb'
const TOPIC_WB_STATE = 'oic.wb-state'
const TOPIC_REC_SCENE = 'oic.rec-scene'
const TOPIC_POLL = 'oic.poll'
const SCENE_WAIT_MS = 5000 // board opened but no saved drawing arrived: start from what has been drawn live
const POLL_RESULT_MS = 15_000 // a closed poll's final result stays on screen this long

const board = { open: false, drawMode: 'EVERYONE', allowed: [] as string[], shapes: [] as Shape[], loaded: false, pending: [] as Op[], openedAt: 0, dirty: true, waitTimer: 0 }
const sceneParts = new Map<string, { parts: number; got: (string | undefined)[]; n: number }>()
type PollView = { id: string; question: string; closed: boolean; yes: number; no: number; total: number; closedAt: number }
let poll: PollView | null = null
const shareStartedAt = new Map<string, number>() // identity -> when their screen share arrived (the newer of share/board is shown)
const decoder = new TextDecoder()

/** Android app phone screen (19 Nov 2026): a screen-only connection "<identity>.screen" (metadata role SCREEN). Its screen is
 *  recorded as "<name> is presenting"; it is never drawn as a person tile nor counted as a participant. */
function isScreenCompanion(p: Participant) {
  return p.identity.endsWith('.screen') || roleOf(p) === 'SCREEN'
}
const realPeople = () => [...room.remoteParticipants.values()].filter((p) => !isScreenCompanion(p))

function roleOf(p: Participant) {
  try {
    return (JSON.parse(p.metadata || '{}') as { role?: string }).role ?? 'ATTENDEE'
  } catch {
    return 'ATTENDEE'
  }
}

function onData(payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) {
  if (topic !== TOPIC_WB && topic !== TOPIC_WB_STATE && topic !== TOPIC_REC_SCENE && topic !== TOPIC_POLL) return
  let d: unknown
  try {
    d = JSON.parse(decoder.decode(payload))
  } catch {
    return
  }
  if (topic === TOPIC_WB_STATE && !participant) setBoardState(d as { isOpen?: boolean; drawMode?: string; allowed?: unknown })
  else if (topic === TOPIC_REC_SCENE && !participant) onScenePart(d as { id?: string; part?: number; parts?: number; data?: string })
  else if (topic === TOPIC_WB && participant && board.open && mayDrawRole(roleOf(participant), participant.identity, board)) {
    if (board.loaded) applyBoardOp(d as Op)
    else board.pending.push(d as Op)
  } else if (topic === TOPIC_POLL && !participant) {
    const p = (d as { poll?: Omit<PollView, 'closedAt'> | null }).poll
    if (p && typeof p.question === 'string') setPoll(p)
  }
}

function applyBoardOp(op: Op) {
  board.shapes = applyOpTo(board.shapes, op)
  board.dirty = true
}

function finishBoardLoad(shapes: Shape[] | null) {
  window.clearTimeout(board.waitTimer)
  if (shapes) {
    // Already showing live strokes (the saved drawing came late): keep those the saved copy does not have yet.
    const ids = new Set(shapes.map((s) => s.id))
    board.shapes = board.loaded ? [...shapes, ...board.shapes.filter((s) => !ids.has(s.id))] : shapes
  }
  board.loaded = true
  board.pending.splice(0).forEach(applyBoardOp)
  board.dirty = true
}

function setBoardState(d: { isOpen?: boolean; drawMode?: string; allowed?: unknown }) {
  const wasOpen = board.open
  board.open = !!d.isOpen
  board.drawMode = typeof d.drawMode === 'string' ? d.drawMode : board.drawMode
  board.allowed = Array.isArray(d.allowed) ? d.allowed.filter((x): x is string => typeof x === 'string') : []
  if (board.open && !wasOpen) {
    board.openedAt = performance.now()
    board.shapes = []
    board.pending = []
    board.loaded = false
    board.waitTimer = window.setTimeout(() => finishBoardLoad(null), SCENE_WAIT_MS)
  } else if (!board.open && wasOpen) {
    window.clearTimeout(board.waitTimer)
    board.shapes = []
    board.pending = []
    board.loaded = false
  }
  board.dirty = true
  if (board.open !== wasOpen) emit('whiteboard', { open: board.open })
}

function onScenePart(d: { id?: string; part?: number; parts?: number; data?: string }) {
  if (typeof d.id !== 'string' || typeof d.part !== 'number' || typeof d.parts !== 'number' || d.parts < 1 || d.parts > 500 || d.part < 0 || d.part >= d.parts) return
  const s = sceneParts.get(d.id) ?? { parts: d.parts, got: new Array<string | undefined>(d.parts), n: 0 }
  sceneParts.set(d.id, s)
  if (s.got[d.part] === undefined) {
    s.got[d.part] = typeof d.data === 'string' ? d.data : ''
    s.n++
  }
  if (s.n < s.parts) return
  sceneParts.delete(d.id)
  if (board.open) finishBoardLoad(parseScene(s.got.join('')))
}

function setPoll(p: Omit<PollView, 'closedAt'>) {
  const seenOpen = poll?.id === p.id && !poll.closed
  // A poll that was already closed before the recorder saw it open (e.g. the snapshot on joining) is not shown again.
  const closedAt = p.closed ? (seenOpen ? performance.now() : poll?.id === p.id ? poll.closedAt : 0) : 0
  poll = { id: p.id, question: p.question, closed: !!p.closed, yes: p.yes | 0, no: p.no | 0, total: p.total | 0, closedAt }
  emit('poll', { id: p.id, closed: poll.closed, total: poll.total })
}

function onTrackSubscribed(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
  emit('track_subscribed', { identity: p.identity, kind: track.kind, source: pub.source })
  if (pub.source === Track.Source.ScreenShare) shareStartedAt.set(p.identity, performance.now())
  if (track.kind === Track.Kind.Video) {
    const reader = new MediaStreamTrackProcessor({ track: track.mediaStreamTrack }).readable.getReader()
    const src: FrameSource = { frame: null, reader, frames: 0 }
    videoEls.get(pub.trackSid)?.reader.cancel().catch(() => {})
    videoEls.set(pub.trackSid, src)
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          src.frame?.close() // hold only the newest frame so the decoder pool never starves
          src.frame = value
          src.frames++
        }
      } catch {
        /* track ended */
      } finally {
        src.frame?.close()
        src.frame = null
      }
    })()
  } else if (track.kind === Track.Kind.Audio) {
    // Chromium only feeds remote WebRTC audio into WebAudio while the stream is attached to a media element.
    const el = track.attach()
    el.muted = true
    mediaHost.appendChild(el)
    const source = audioCtx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]))
    source.connect(audioDest)
    audioNodes.set(pub.trackSid, { el, source })
  }
}

function onTrackUnsubscribed(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
  emit('track_unsubscribed', { identity: p.identity, kind: track.kind, source: pub.source })
  track.detach().forEach((el) => el.remove())
  const v = videoEls.get(pub.trackSid)
  if (v) {
    v.reader.cancel().catch(() => {})
    videoEls.delete(pub.trackSid)
  }
  const a = audioNodes.get(pub.trackSid)
  if (a) {
    a.source.disconnect()
    audioNodes.delete(pub.trackSid)
  }
}

// ---------------------------------------------------------------------------
// Composite drawing

const C = { bg: '#0B1E31', tile: '#17385A', label: 'rgba(11,30,49,0.72)', text: '#FFFFFF', cyan: '#20C4D8', red: '#DC2626', muted: '#94A3B8' }
const palette = ['#2878E5', '#0EA5A4', '#7C3AED', '#1769AA', '#DB2777', '#EA580C', '#16A34A']
let framesDrawn = 0
let framesPushed = 0
let framesDropped = 0
// The composite is pushed frame-by-frame into a generated track, so recording does not depend on
// compositor paint scheduling (canvas.captureStream() can be throttled by headless Chromium).
const compositeGen = new MediaStreamTrackGenerator({ kind: 'video' })
const compositeWriter = compositeGen.writable.getWriter()
let drawMsTotal = 0
let pushMsTotal = 0
function pushComposite() {
  if (cfg.captureMode === 'capture') return
  const t0 = performance.now()
  if (compositeWriter.desiredSize !== null && compositeWriter.desiredSize <= 0) {
    framesDropped++
    return
  }
  framesPushed++
  void compositeWriter.write(new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) })).catch(() => {})
  pushMsTotal += performance.now() - t0
}
let recordStartMs = 0

type Rect = { x: number; y: number; w: number; h: number }

function videoFor(p: RemoteParticipant, source: Track.Source) {
  const pub = p.getTrackPublication(source)
  if (!pub || !pub.isSubscribed || pub.isMuted || !pub.trackSid) return undefined
  const f = videoEls.get(pub.trackSid)?.frame
  return f && f.displayWidth > 0 ? f : undefined
}

function drawCover(el: VideoFrame | HTMLCanvasElement, r: Rect, contain = false) {
  const vw = el instanceof HTMLCanvasElement ? el.width : el.displayWidth
  const vh = el instanceof HTMLCanvasElement ? el.height : el.displayHeight
  const vr = vw / vh
  const rr = r.w / r.h
  let sw = vw, sh = vh, sx = 0, sy = 0
  let dx = r.x, dy = r.y, dw = r.w, dh = r.h
  if (contain) {
    if (vr > rr) { dh = r.w / vr; dy = r.y + (r.h - dh) / 2 } else { dw = r.h * vr; dx = r.x + (r.w - dw) / 2 }
  } else if (vr > rr) { sw = sh * rr; sx = (vw - sw) / 2 } else { sh = sw / rr; sy = (vh - sh) / 2 }
  ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh)
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

function colorFor(id: string) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

function drawTile(p: RemoteParticipant, r: Rect, small = false) {
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, 10)
  ctx.clip()
  ctx.fillStyle = C.tile
  ctx.fillRect(r.x, r.y, r.w, r.h)
  const v = videoFor(p, Track.Source.Camera)
  const name = p.name || p.identity
  // Contain, never cover: show the complete participant video with no cropping or stretching, letterboxed to
  // fit the tile. A frame's own displayWidth/displayHeight is read fresh every draw, so a participant rotating
  // their phone mid-call is picked up automatically on the next frame with no extra handling needed here.
  if (v) drawCover(v, r, true)
  else {
    const rad = Math.min(r.w, r.h) * 0.16
    ctx.fillStyle = colorFor(p.identity)
    ctx.beginPath()
    ctx.arc(r.x + r.w / 2, r.y + r.h / 2, rad, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = C.text
    ctx.font = `600 ${Math.round(rad * 0.8)}px "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initials(name), r.x + r.w / 2, r.y + r.h / 2)
  }
  // Name label + mic state
  const micPub = p.getTrackPublication(Track.Source.Microphone)
  const micOff = !micPub || micPub.isMuted
  const fs = small ? 12 : 15
  ctx.font = `600 ${fs}px "Segoe UI", sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const label = micOff ? `${name}  ·  muted` : name
  const lw = Math.min(ctx.measureText(label).width + 20, r.w - 16)
  ctx.fillStyle = C.label
  ctx.beginPath()
  ctx.roundRect(r.x + 8, r.y + r.h - fs - 20, lw, fs + 12, 6)
  ctx.fill()
  ctx.fillStyle = micOff ? '#FCA5A5' : C.text
  ctx.fillText(label, r.x + 18, r.y + r.h - fs / 2 - 14, lw - 20)
  ctx.restore()
  if (speaking.has(p.identity)) {
    ctx.strokeStyle = C.cyan
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.roundRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3, 9)
    ctx.stroke()
  }
}

function gridRects(n: number, area: Rect, gap = 10): Rect[] {
  if (n === 0) return []
  // A portrait canvas only ever happens for a one-to-one call (n <= 2 - see decideCanvasSize), where a side-by-side
  // column layout would squeeze each tile into a sliver. Stack top/bottom instead so each tile stays a sane shape.
  if (area.h > area.w && n <= 2) {
    const th = (area.h - gap * (n - 1)) / n
    return Array.from({ length: n }, (_, i) => ({ x: area.x, y: area.y + i * (th + gap), w: area.w, h: th }))
  }
  const cols = n === 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4
  const rows = Math.ceil(n / cols)
  // Keep tiles 16:9 inside the area.
  let tw = (area.w - gap * (cols - 1)) / cols
  let th = tw * 9 / 16
  if (th * rows + gap * (rows - 1) > area.h) {
    th = (area.h - gap * (rows - 1)) / rows
    tw = th * 16 / 9
  }
  const totalH = th * rows + gap * (rows - 1)
  const rects: Rect[] = []
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols)
    const inRow = row === rows - 1 ? n - row * cols : cols
    const rowW = tw * inRow + gap * (inRow - 1)
    const col = i - row * cols
    rects.push({ x: area.x + (area.w - rowW) / 2 + col * (tw + gap), y: area.y + (area.h - totalH) / 2 + row * (th + gap), w: tw, h: th })
  }
  return rects
}

const clockFmt = new Intl.DateTimeFormat('en-IN', { timeZone: cfg.timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function hhmmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':')
}

// The whiteboard is painted into its own canvas only when it changes, then scaled into the composite like a screen share.
const boardCanvas = document.createElement('canvas')
boardCanvas.width = 1280
boardCanvas.height = Math.round((1280 * BOARD_H) / BOARD_W)
const boardCtx = boardCanvas.getContext('2d')!

function boardImage() {
  if (board.dirty) {
    renderBoard(boardCtx, board.shapes, boardCanvas.width / BOARD_W)
    board.dirty = false
  }
  return boardCanvas
}

/** What fills the main area: a screen share or the open whiteboard - whichever started more recently - or nothing. */
function mainContent(people: RemoteParticipant[]): { image: VideoFrame | HTMLCanvasElement; label: string } | null {
  const sharer = people.find((p) => videoFor(p, Track.Source.ScreenShare))
  if (sharer && (!board.open || (shareStartedAt.get(sharer.identity) ?? 0) >= board.openedAt))
    return { image: videoFor(sharer, Track.Source.ScreenShare)!, label: `${sharer.name || sharer.identity} is presenting` }
  if (board.open) return { image: boardImage(), label: 'Whiteboard' }
  return null
}

function drawMain(content: { image: VideoFrame | HTMLCanvasElement; label: string }, main: Rect) {
  ctx.fillStyle = '#000'
  ctx.fillRect(main.x, main.y, main.w, main.h)
  drawCover(content.image, main, true)
  ctx.font = '600 13px "Segoe UI", sans-serif'
  const lw = Math.min(ctx.measureText(content.label).width + 20, main.w)
  ctx.fillStyle = C.label
  ctx.fillRect(main.x, main.y, Math.max(lw, Math.min(260, main.w)), 26)
  ctx.fillStyle = C.text
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(content.label, main.x + 10, main.y + 13, main.w - 20)
}

/** The current poll as a card (top right of the main area, so it never covers a camera tile): question and live Yes/No counts; the final result for a while after it closes. */
function drawPoll(area: Rect) {
  if (!poll || (poll.closed && (!poll.closedAt || performance.now() - poll.closedAt > POLL_RESULT_MS))) return
  const cw = Math.min(360, Math.round(area.w * 0.46))
  const x = area.x + area.w - cw - 10
  const y = area.y + 34 // below the "Whiteboard" / "is presenting" label row
  ctx.font = '600 15px "Segoe UI", sans-serif'
  const words = poll.question.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const t = line ? `${line} ${word}` : word
    if (ctx.measureText(t).width > cw - 28 && line) {
      lines.push(line)
      line = word
    } else line = t
  }
  if (line) lines.push(line)
  if (lines.length > 3) lines.splice(3, lines.length - 3, `${lines[2].slice(0, Math.max(0, lines[2].length - 1))}…`)
  const ch = 40 + lines.length * 20 + 2 * 26 + 26
  ctx.save()
  ctx.fillStyle = 'rgba(11,30,49,0.92)'
  ctx.strokeStyle = poll.closed ? 'rgba(148,163,184,0.6)' : C.cyan
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(x, y, cw, ch, 12)
  ctx.fill()
  ctx.stroke()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = '700 12px "Segoe UI", sans-serif'
  ctx.fillStyle = poll.closed ? C.muted : C.cyan
  ctx.fillText(poll.closed ? 'POLL · FINAL RESULT' : 'POLL · LIVE', x + 14, y + 18)
  ctx.font = '600 15px "Segoe UI", sans-serif'
  ctx.fillStyle = C.text
  lines.forEach((l, i) => ctx.fillText(l, x + 14, y + 42 + i * 20, cw - 28))
  const pct = (n: number) => (poll!.total ? Math.round((n / poll!.total) * 100) : 0)
  ;([['Yes', poll.yes, '#34D399'], ['No', poll.no, '#FB7185']] as const).forEach(([label, n, color], i) => {
    const by = y + 42 + lines.length * 20 + 4 + i * 26
    ctx.font = '600 13px "Segoe UI", sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.fillText(label, x + 14, by)
    const bx = x + 50, bw = cw - 50 - 86
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath()
    ctx.roundRect(bx, by - 5, bw, 10, 5)
    ctx.fill()
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(bx, by - 5, Math.max(pct(n) ? 6 : 0, (bw * pct(n)) / 100), 10, 5)
    ctx.fill()
    ctx.fillStyle = C.text
    ctx.textAlign = 'right'
    ctx.fillText(`${n} · ${pct(n)}%`, x + cw - 14, by)
    ctx.textAlign = 'left'
  })
  ctx.font = '500 12px "Segoe UI", sans-serif'
  ctx.fillStyle = C.muted
  ctx.fillText(`${poll.total} answer${poll.total === 1 ? '' : 's'}`, x + 14, y + ch - 16)
  ctx.restore()
}

function draw() {
  const t0 = performance.now()
  const W = activeWidth, H = activeHeight
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)
  const top = 44, pad = 12
  const stage: Rect = { x: pad, y: top, w: W - pad * 2, h: H - top - 34 }
  const everyone = [...room.remoteParticipants.values()].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
  const people = everyone.filter((p) => !isScreenCompanion(p))
  const content = mainContent(everyone) // a phone screen (screen-only connection) is shown like any presentation
  let pollArea: Rect = stage

  if (content && H > W) {
    // Portrait canvas (a 1:1 call locked portrait because a phone camera was portrait, before anyone presented): a
    // side strip left the 16:9 screen at ~3/4 of an already narrow width. Give the screen the full width at the top and
    // put the cameras side by side underneath.
    const shareH = Math.round(stage.w * 9 / 16)
    const main: Rect = { x: stage.x, y: stage.y, w: stage.w, h: shareH }
    drawMain(content, main)
    pollArea = main
    const below: Rect = { x: stage.x, y: main.y + main.h + 10, w: stage.w, h: stage.h - main.h - 10 }
    const n = Math.max(people.length, 1)
    const tw = (below.w - 10 * (n - 1)) / n
    people.forEach((p, i) => drawTile(p, { x: below.x + i * (tw + 10), y: below.y, w: tw, h: below.h }, true))
  } else if (content) {
    const stripW = Math.round(stage.w * 0.22)
    const main: Rect = { x: stage.x, y: stage.y, w: stage.w - stripW - 10, h: stage.h }
    drawMain(content, main)
    pollArea = main
    const strip: Rect = { x: main.x + main.w + 10, y: stage.y, w: stripW, h: stage.h }
    const th = Math.min((strip.h - 8 * (people.length - 1)) / Math.max(people.length, 1), strip.w * 9 / 16)
    people.forEach((p, i) => drawTile(p, { x: strip.x, y: strip.y + i * (th + 8), w: strip.w, h: th }, true))
  } else if (people.length === 0) {
    ctx.fillStyle = C.muted
    ctx.font = '500 20px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Waiting for participants…', W / 2, H / 2)
  } else {
    gridRects(people.length, stage).forEach((r, i) => drawTile(people[i], r))
  }
  drawPoll(pollArea)

  // Header: product + meeting title (left), REC + elapsed (right)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = '700 15px "Segoe UI", sans-serif'
  ctx.fillStyle = C.text
  ctx.fillText('OneInsure', pad, 22)
  const ow = ctx.measureText('OneInsure ').width
  ctx.fillStyle = C.cyan
  ctx.fillText('Connect', pad + ow, 22)
  ctx.fillStyle = C.muted
  ctx.font = '500 14px "Segoe UI", sans-serif'
  ctx.fillText(`|  ${cfg.meetingTitle}`, pad + ow + ctx.measureText('Connect  ').width + 6, 22, W * 0.55)
  if (recordStartMs) {
    const blink = Math.floor(performance.now() / 600) % 2 === 0
    ctx.fillStyle = blink ? C.red : 'rgba(220,38,38,0.4)'
    ctx.beginPath()
    ctx.arc(W - 128, 22, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = C.text
    ctx.font = '700 14px "Segoe UI", sans-serif'
    ctx.fillText(`REC ${hhmmss(Date.now() - recordStartMs)}`, W - 114, 22)
  }
  // Footer: wall-clock timestamp (evidence) + connection state
  ctx.font = '500 13px "Segoe UI", sans-serif'
  ctx.fillStyle = C.muted
  ctx.textAlign = 'right'
  ctx.fillText(`${clockFmt.format(new Date())} ${cfg.timeZone === 'Asia/Kolkata' ? 'IST' : cfg.timeZone}`, W - pad, H - 16)
  if (room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting) {
    ctx.textAlign = 'left'
    ctx.fillStyle = '#F59E0B'
    ctx.fillText('Recorder reconnecting…', pad, H - 16)
  }
  framesDrawn++
  drawMsTotal += performance.now() - t0
  pushComposite()
}

// ---------------------------------------------------------------------------
// Recording

let recorder: MediaRecorder | null = null
let seq = 0
let chunksSent = 0
let bytesSent = 0
let pending = 0
let lastChunkAtMs = 0
let chain: Promise<void> = Promise.resolve()
let mimeType = ''
let drawTimer = 0
let stopping: Promise<void> | null = null

function pickMime() {
  const wanted = cfg.videoCodec === 'h264' ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus'] : ['video/webm;codecs=vp8,opus']
  const m = wanted.find((t) => MediaRecorder.isTypeSupported(t))
  if (!m) throw new Error('No supported MediaRecorder WebM type')
  return m
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    // The data URL looks like "data:video/webm;codecs=vp8,opus;base64,<data>" — the codec list contains a comma.
    r.onload = () => {
      const s = r.result as string
      resolve(s.slice(s.indexOf(';base64,') + ';base64,'.length))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// Upper bound only: the wait ends as soon as every participant whose camera is ON has delivered a frame (participants
// with the camera off have nothing to wait for). Was a flat 4000 ms whenever anyone had the camera off - measured as
// the single largest fixed delay in recorder start-up.
const ORIENTATION_DETECT_MS = 1500
const ORIENTATION_POLL_MS = 200
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Device-adaptive canvas size: a one-to-one call (<=2 real participants) records portrait (height x width, i.e. the
 * configured landscape canvas rotated) only if every participant's camera is portrait (12 Nov 2026: was "either camera",
 * which recorded a desktop's screen share in a phone-shaped frame); a group call
 * (3+) always stays the configured landscape size - no detection needed there. Give cameras a few seconds to
 * publish before deciding, since a camera that hasn't reported a frame yet reads as "unknown", not "landscape".
 * This runs once, before the recorder starts, and never re-evaluates once the canvas is locked.
 */
async function decideCanvasSize() {
  const deadline = performance.now() + ORIENTATION_DETECT_MS
  for (;;) {
    if (realPeople().length > 2) return // group call: keep the configured landscape size
    const everyone = [...room.remoteParticipants.values()]
    const people = everyone.filter((p) => !isScreenCompanion(p))
    const frames = people.map((p) => videoFor(p, Track.Source.Camera)).filter((f): f is VideoFrame => !!f)
    const cameraOn = people.filter((p) => { const pub = p.getTrackPublication(Track.Source.Camera); return !!pub && !pub.isMuted }).length
    const allReported = frames.length >= cameraOn
    if (allReported || performance.now() >= deadline) {
      if (realPeople().length > 2) return // someone joined mid-wait, making this a group call after all
      // Portrait only when EVERY participant is on a portrait camera (in practice: everyone on a phone). A desktop/laptop
      // participant - landscape camera, or camera off - can present at any moment, and MediaRecorder cannot change the
      // canvas size later, so a desktop + phone call that locked portrait recorded the desktop's screen share squeezed
      // into a phone-shaped frame. Already presenting at lock time: landscape as well.
      const presenting = board.open || everyone.some((p) => videoFor(p, Track.Source.ScreenShare))
      const portraitFrames = frames.filter((f) => f.displayHeight > f.displayWidth).length
      if (!presenting && people.length > 0 && portraitFrames === people.length) applyCanvasSize(cfg.height, cfg.width)
      return
    }
    await sleep(ORIENTATION_POLL_MS)
  }
}

function applyCanvasSize(w: number, h: number) {
  activeWidth = w
  activeHeight = h
  canvas.width = w
  canvas.height = h
}

async function start() {
  await room.connect(cfg.url, cfg.token, { autoSubscribe: true })
  emit('connected', { room: room.name, participants: room.remoteParticipants.size })
  if (audioCtx.state !== 'running') await audioCtx.resume()

  await decideCanvasSize()
  emit('canvas_locked', { width: activeWidth, height: activeHeight, participants: room.remoteParticipants.size })

  drawTimer = window.setInterval(draw, 1000 / cfg.fps)
  draw()
  const videoTrack = cfg.captureMode === 'capture' ? canvas.captureStream(cfg.fps).getVideoTracks()[0] : compositeGen
  const stream = new MediaStream([videoTrack, audioDest.stream.getAudioTracks()[0]])
  mimeType = pickMime()
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: cfg.videoBitsPerSecond, audioBitsPerSecond: cfg.audioBitsPerSecond })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    const n = seq++
    pending++
    // Serialise chunk delivery so the host always appends in order.
    chain = chain.then(async () => {
      const b64 = await blobToBase64(e.data)
      await window.oicChunk(n, b64)
      chunksSent++
      bytesSent += e.data.size
      lastChunkAtMs = Date.now()
    }).catch((err) => emit('recorder_error', { message: `chunk ${n}: ${String(err)}` })).finally(() => pending--)
  }
  recorder.onerror = (e) => emit('recorder_error', { message: String((e as unknown as { error?: Error }).error ?? e) })
  recorder.start(cfg.timesliceMs)
  recordStartMs = Date.now()
  emit('recording_started', { mimeType, width: activeWidth, height: activeHeight, fps: cfg.fps })
  return { mimeType, width: activeWidth, height: activeHeight }
}

function stopRecording() {
  if (stopping) return stopping
  stopping = new Promise<void>((resolve) => {
    if (!recorder || recorder.state === 'inactive') return resolve()
    recorder.onstop = () => {
      chain.then(() => {
        window.clearInterval(drawTimer)
        emit('recording_stopped', { chunks: chunksSent, bytes: bytesSent })
        resolve()
      })
    }
    recorder.stop()
  })
  return stopping
}

window.oicControl = {
  start,
  stop: async () => {
    await stopRecording()
    if (room.state !== ConnectionState.Disconnected) await room.disconnect()
  },
  status: () => ({
    roomState: room.state,
    recorderState: recorder?.state ?? 'none',
    participants: room.remoteParticipants.size,
    videoTracks: videoEls.size,
    audioTracks: audioNodes.size,
    framesDrawn,
    chunksSent,
    bytesSent,
    pendingChunks: pending,
    lastChunkAtMs,
    mimeType,
    framesPushed,
    framesDropped,
    avgDrawMs: framesDrawn ? +(drawMsTotal / framesDrawn).toFixed(2) : 0,
    avgPushMs: framesPushed ? +(pushMsTotal / framesPushed).toFixed(2) : 0,
    trackFrames: Object.fromEntries([...videoEls.entries()].map(([sid, v]) => [sid, v.frames])),
  }),
  simulate: (scenario) => room.simulateScenario(scenario),
}
