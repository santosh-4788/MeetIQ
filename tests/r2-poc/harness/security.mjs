import fs from 'node:fs'
import path from 'node:path'
import { ensureLiveKit, joinParticipant, startRecorder, rooms, sleep, closeParticipantBrowser, recorderListeningPorts, ROOT } from './lib.mjs'
await ensureLiveKit()
const room = `sec-${Date.now().toString(36)}`
await rooms.createRoom({ name: room, emptyTimeout: 60 })
const a = await joinParticipant(room, 0, 'Ananya Rao')
const b = await joinParticipant(room, 1, 'Customer Name Sharma')
const rec = startRecorder({ room, title: 'PLVC POL123456 Customer Name Sharma' })
await rec.waitStarted()
await sleep(8000)
const seenByA = (await a.call('status')).remoteIds
const all = await rooms.listParticipants(room)
const r = all.find((p) => p.identity.startsWith('oic-recorder-'))
const ports = await recorderListeningPorts()
await rooms.deleteRoom(room)
await rec.waitExit()
await closeParticipantBrowser()
const res = rec.result()
const fileName = res?.file ? path.basename(res.file) : ''
const checks = {
  recorderPresentInRoom: !!r,
  recorderHiddenFromParticipants: !seenByA.some((id) => id.startsWith('oic-recorder-')),
  grantHidden: r?.permission?.hidden === true,
  grantRecorder: r?.permission?.recorder === true,
  grantCannotPublish: r?.permission?.canPublish === false,
  grantCannotPublishData: r?.permission?.canPublishData === false,
  recorderPublishedTracks: r?.tracks?.length ?? -1,
  recorderListeningSockets: ports,
  outputFileName: fileName,
  fileNameContainsNoMeetingData: !/POL123456|Sharma|PLVC/i.test(fileName),
  status: res?.status,
}
console.log(JSON.stringify(checks, null, 2))
fs.writeFileSync(path.join(ROOT, 'tests/r2-poc/results/security.json'), JSON.stringify(checks, null, 2))
