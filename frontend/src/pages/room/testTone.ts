/** A short, synthesised two-tone chime for "Test speaker" - no network request, no bundled audio asset. */
function renderChime(): Promise<AudioBuffer> {
  const sampleRate = 44100
  const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * 0.7), sampleRate)
  const notes: [number, number][] = [
    [880, 0],
    [1174.66, 0.18],
  ]
  for (const [freq, start] of notes) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(0.28, start + 0.04)
    gain.gain.linearRampToValueAtTime(0, start + 0.32)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + 0.34)
  }
  return ctx.startRendering()
}

function wavFromBuffer(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const bytesPerSample = 2
  const dataSize = buffer.length * numCh * bytesPerSample
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numCh, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numCh * bytesPerSample, true)
  view.setUint16(32, numCh * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([out], { type: 'audio/wav' })
}

/**
 * Plays a short chime through `deviceId` (or the system default when omitted), independent of the meeting's own
 * audio - testing it never touches the call. Throws if the browser cannot route to a specific output device.
 */
export async function playTestTone(deviceId?: string) {
  const buffer = await renderChime()
  const blob = wavFromBuffer(buffer)
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  try {
    if (deviceId && deviceId !== 'default' && typeof audio.setSinkId === 'function') {
      await audio.setSinkId(deviceId)
    }
    await audio.play()
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve()
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
