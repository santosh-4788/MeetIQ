// Compares recorder capture modes and codecs on the current machine.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureLiveKit, joinParticipant, startRecorder, rooms, sleep, log, closeParticipantBrowser, startSampler, FFMPEG_DIR, ROOT } from './lib.mjs'

const variants = (process.argv[2] ?? 'generator:vp8,capture:vp8,generator:h264,capture:h264').split(',').map((v) => v.split(':'))
const seconds = +(process.argv[3] ?? 40)
const outDir = path.join(ROOT, 'tests/r2-poc/results/bench')
fs.mkdirSync(outDir, { recursive: true })
await ensureLiveKit()
const results = []
for (const [mode, codec] of variants) {
  const room = `bench-${mode}-${codec}-${Date.now().toString(36)}`
  await rooms.createRoom({ name: room, emptyTimeout: 60 })
  const ps = [await joinParticipant(room, 0, 'Ananya Rao'), await joinParticipant(room, 1, 'Customer Test')]
  const sampler = startSampler(outDir, room)
  const rec = startRecorder({ room, title: `bench ${mode}/${codec}`, env: { OIC_Recorder__Layout__CaptureMode: mode, OIC_Recorder__Layout__VideoCodec: codec } })
  await rec.waitStarted()
  await sleep(seconds * 1000)
  let st = {}
  try { st = JSON.parse(fs.readFileSync(path.join(rec.jobDir, 'status.json'), 'utf8')).page ?? {} } catch {}
  const senders = await Promise.all(ps.map((p) => p.call('stats')))
  await rooms.deleteRoom(room)
  await rec.waitExit()
  const resources = await sampler.stop()
  await closeParticipantBrowser()
  const r = rec.result()
  const seg = path.join(rec.jobDir, 'segment-00.webm')
  let webmFrames = 0, webmSpan = 0
  if (fs.existsSync(seg)) {
    const pts = execFileSync(path.join(FFMPEG_DIR, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', seg]).toString().trim().split(/\r?\n/).map(Number)
    webmFrames = pts.length
    webmSpan = pts.at(-1) - pts[0]
  }
  const row = {
    mode, codec, mime: st.mimeType, status: r?.status, failures: r?.verification?.Failures,
    encodedFps: webmSpan ? +(webmFrames / webmSpan).toFixed(1) : 0,
    mediaSeconds: +webmSpan.toFixed(1), wallSeconds: r?.verification?.ExpectedSeconds,
    framesDrawn: st.framesDrawn, framesPushed: st.framesPushed, framesDropped: st.framesDropped, avgDrawMs: st.avgDrawMs, avgPushMs: st.avgPushMs,
    senderFps: senders.map((s) => s.sender?.[0]?.fps), ffmpegWall: r?.ffmpeg?.WallSeconds, ffmpegCpu: r?.ffmpeg?.CpuSeconds,
    recorderBrowser: resources.roles['recorder-browser'], participants: resources.roles['participant-browser'],
  }
  log(JSON.stringify(row))
  results.push(row)
}
fs.writeFileSync(path.join(outDir, `bench-${Date.now()}.json`), JSON.stringify(results, null, 2))
