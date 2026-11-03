/**
 * Synthetic meeting participant for the R2 recorder PoC.
 * Publishes a canvas "camera" and a WebAudio "microphone". Every 2 s of wall-clock time the camera
 * flashes white and the microphone beeps at the same instant, so A/V sync and continuity can be
 * measured objectively from the recorder's MP4. An optional synthetic screen share is available.
 */
import { LocalVideoTrack, LocalAudioTrack, Room, RoomEvent, Track, type SimulationScenario } from 'livekit-client'

type Cfg = { url: string; token: string; name: string; color: string; beepHz: number }
declare global {
  interface Window {
    __P__: Cfg
    p: Record<string, (...a: never[]) => unknown>
  }
}

const cfg = window.__P__
const PERIOD = 2000
const FLASH_MS = 120
const BEEP_MS = 100

// Frames are pushed explicitly (WebCodecs) instead of canvas.captureStream(): captureStream depends on
// compositor paints, which headless Chromium throttles for background tabs.
declare const MediaStreamTrackGenerator: new (init: { kind: 'video' }) => MediaStreamVideoTrack & { writable: WritableStream<VideoFrame> }
type MediaStreamVideoTrack = MediaStreamTrack
function frameTrack(canvas: HTMLCanvasElement) {
  const gen = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = gen.writable.getWriter()
  const push = () => {
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return
    void writer.write(new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) })).catch(() => {})
  }
  return { track: gen as MediaStreamTrack, push }
}

// --- Camera ---------------------------------------------------------------
const cam = document.getElementById('cam') as HTMLCanvasElement
const cx = cam.getContext('2d')!
const camOut = frameTrack(cam)
let frame = 0
setInterval(() => {
  const now = Date.now()
  frame++
  if (now % PERIOD < FLASH_MS) {
    cx.fillStyle = '#FFFFFF'
    cx.fillRect(0, 0, 640, 360)
    camOut.push()
    return
  }
  cx.fillStyle = cfg.color
  cx.fillRect(0, 0, 640, 360)
  cx.fillStyle = 'rgba(255,255,255,0.85)'
  cx.fillRect(((now / 8) % 700) - 60, 300, 60, 18) // moving bar: proves the video is live
  cx.fillStyle = '#FFFFFF'
  cx.font = 'bold 34px Segoe UI, sans-serif'
  cx.fillText(cfg.name, 24, 60)
  cx.font = '22px Consolas, monospace'
  cx.fillText(new Date(now).toISOString().slice(11, 23), 24, 110)
  cx.fillText(`frame ${frame}`, 24, 145)
  camOut.push()
}, 40)

// --- Microphone: beeps aligned to the same wall-clock instants -------------
const ac = new AudioContext({ sampleRate: 48000 })
const osc = ac.createOscillator()
osc.frequency.value = cfg.beepHz
const gain = ac.createGain()
gain.gain.value = 0
const micDest = ac.createMediaStreamDestination()
osc.connect(gain).connect(micDest)
osc.start()
let scheduledUntil = 0
function scheduleBeeps() {
  const nowMs = Date.now()
  const nowAc = ac.currentTime
  for (let b = Math.ceil(nowMs / PERIOD) * PERIOD; b < nowMs + 6000; b += PERIOD) {
    if (b <= scheduledUntil) continue
    const t = nowAc + (b - nowMs) / 1000
    gain.gain.setValueAtTime(0.6, t)
    gain.gain.setValueAtTime(0, t + BEEP_MS / 1000)
    scheduledUntil = b
  }
}
setInterval(scheduleBeeps, 1000)

// --- Screen share ---------------------------------------------------------
const scr = document.getElementById('screen') as HTMLCanvasElement
const sx = scr.getContext('2d')!
const scrOut = frameTrack(scr)
setInterval(() => {
  const now = Date.now()
  sx.fillStyle = '#F4F7FB'
  sx.fillRect(0, 0, 1280, 720)
  sx.fillStyle = '#102A43'
  sx.font = 'bold 54px Segoe UI, sans-serif'
  sx.fillText(`Shared slide — ${cfg.name}`, 60, 120)
  sx.font = '32px Segoe UI, sans-serif'
  sx.fillStyle = '#334155'
  ;['• Policy summary', '• Premium schedule', '• Nominee details', '• Verification checklist'].forEach((l, i) => sx.fillText(l, 80, 230 + i * 60))
  sx.fillStyle = '#2878E5'
  sx.fillRect(60, 560, ((now / 10) % 1160), 16)
  sx.fillStyle = '#64748B'
  sx.font = '26px Consolas, monospace'
  sx.fillText(new Date(now).toISOString(), 60, 650)
  scrOut.push()
}, 100)

// --- Room -----------------------------------------------------------------
const room = new Room({ adaptiveStream: false, dynacast: false })
const events: string[] = []
room.on(RoomEvent.Reconnecting, () => events.push('reconnecting')).on(RoomEvent.Reconnected, () => events.push('reconnected')).on(RoomEvent.Disconnected, () => events.push('disconnected'))
let screenTrack: LocalVideoTrack | null = null

window.p = {
  connect: async () => {
    await room.connect(cfg.url, cfg.token)
    if (ac.state !== 'running') await ac.resume()
    scheduleBeeps()
    const v = new LocalVideoTrack(camOut.track, undefined, true)
    await room.localParticipant.publishTrack(v, { source: Track.Source.Camera, simulcast: false, videoCodec: 'vp8', videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 25 } })
    const a = new LocalAudioTrack(micDest.stream.getAudioTracks()[0], undefined, true)
    await room.localParticipant.publishTrack(a, { source: Track.Source.Microphone, dtx: false, red: false })
    return room.localParticipant.identity
  },
  startScreen: async () => {
    screenTrack = new LocalVideoTrack(scrOut.track, undefined, true)
    await room.localParticipant.publishTrack(screenTrack, { source: Track.Source.ScreenShare, simulcast: false, videoCodec: 'vp8' })
  },
  stopScreen: async () => {
    if (screenTrack) await room.localParticipant.unpublishTrack(screenTrack)
    screenTrack = null
  },
  muteMic: async (m: boolean) => {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone)
    if (pub?.track) await (m ? pub.mute() : pub.unmute())
  },
  simulate: (s: SimulationScenario) => room.simulateScenario(s),
  disconnect: () => room.disconnect(),
  stats: async () => {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera)
    const st = pub?.videoTrack ? await (pub.videoTrack as LocalVideoTrack).getSenderStats() : []
    return { drawFrame: frame, sender: st.map((x) => ({ fps: x.framesPerSecond, sent: x.framesSent, w: x.frameWidth, kbps: Math.round((x.targetBitrate ?? 0) / 1000), limit: x.qualityLimitationReason, enc: x.encoderImplementation })) }
  },
  status: () => ({ state: room.state, remote: room.remoteParticipants.size, remoteIds: [...room.remoteParticipants.keys()], events }),
}
