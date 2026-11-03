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
      start: () => Promise<{ mimeType: string }>
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
canvas.width = cfg.width
canvas.height = cfg.height
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

function onTrackSubscribed(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
  emit('track_subscribed', { identity: p.identity, kind: track.kind, source: pub.source })
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

function drawCover(el: VideoFrame, r: Rect, contain = false) {
  const vw = el.displayWidth, vh = el.displayHeight
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
  if (v) drawCover(v, r)
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

function draw() {
  const t0 = performance.now()
  const W = cfg.width, H = cfg.height
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, W, H)
  const top = 44, pad = 12
  const stage: Rect = { x: pad, y: top, w: W - pad * 2, h: H - top - 34 }
  const people = [...room.remoteParticipants.values()].sort((a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0))
  const sharer = people.find((p) => videoFor(p, Track.Source.ScreenShare))

  if (sharer) {
    const stripW = Math.round(stage.w * 0.22)
    const main: Rect = { x: stage.x, y: stage.y, w: stage.w - stripW - 10, h: stage.h }
    ctx.fillStyle = '#000'
    ctx.fillRect(main.x, main.y, main.w, main.h)
    drawCover(videoFor(sharer, Track.Source.ScreenShare)!, main, true)
    ctx.fillStyle = C.label
    ctx.fillRect(main.x, main.y, 260, 26)
    ctx.fillStyle = C.text
    ctx.font = '600 13px "Segoe UI", sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${sharer.name || sharer.identity} is presenting`, main.x + 10, main.y + 13)
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

async function start() {
  await room.connect(cfg.url, cfg.token, { autoSubscribe: true })
  emit('connected', { room: room.name, participants: room.remoteParticipants.size })
  if (audioCtx.state !== 'running') await audioCtx.resume()

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
  emit('recording_started', { mimeType, width: cfg.width, height: cfg.height, fps: cfg.fps })
  return { mimeType }
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
