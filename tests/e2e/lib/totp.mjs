// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) computed from the base32 setup key, like an authenticator app.
import { createHmac } from 'node:crypto'

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = s.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const i = alphabet.indexOf(ch)
    if (i < 0) throw new Error(`Invalid base32 character ${ch}`)
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totp(secret, at = Date.now(), stepOffset = 0) {
  const counter = Math.floor(at / 1000 / 30) + stepOffset
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const o = h[h.length - 1] & 0x0f
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1_000_000).padStart(6, '0')
}

/** Waits until at least `minSeconds` remain in the current 30-second window (avoids codes expiring mid-test). */
export async function freshTotp(secret, minSeconds = 8) {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30)
  if (left < minSeconds) await new Promise((r) => setTimeout(r, (left + 1) * 1000))
  return totp(secret)
}

/** A code from the next window: used when the current one was already consumed (replay protection). */
export async function nextTotp(secret) {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30)
  await new Promise((r) => setTimeout(r, (left + 1) * 1000))
  return totp(secret)
}
