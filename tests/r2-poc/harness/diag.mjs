import fs from 'node:fs'
import path from 'node:path'
import { ensureLiveKit, joinParticipant, startRecorder, rooms, sleep, log, closeParticipantBrowser } from './lib.mjs'
await ensureLiveKit()
const room = `diag-${Date.now().toString(36)}`
await rooms.createRoom({ name: room, emptyTimeout: 60 })
const a = await joinParticipant(room, 0, 'A')
const b = await joinParticipant(room, 1, 'B')
const rec = startRecorder({ room, title: 'diag' })
await rec.waitStarted()
for (let i = 0; i < 6; i++) {
  await sleep(4000)
  let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(rec.jobDir, 'status.json'), 'utf8')) } catch {}
  const pf = await Promise.all([a, b].map(async p => ({ ...(await p.call('stats')), transport: await p.transport() })))
  log('recorder trackFrames', JSON.stringify(st.page?.trackFrames), 'pushed', st.page?.framesPushed, 'dropped', st.page?.framesDropped, 'participants', JSON.stringify(pf))
}
await rooms.deleteRoom(room); await rec.waitExit(); await closeParticipantBrowser()
