// LAN test mode: the normal dev config plus HTTPS on all interfaces, so colleagues on the office network can open
// https://<this-laptop-ip>:5173 and use camera/microphone (browsers allow them only on secure pages).
// Started by scripts/lan/start-lan.ps1, which provides the certificate (git-ignored) through environment variables.
import { readFileSync } from 'node:fs'
import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.ts'

const pfx = process.env.OIC_HTTPS_PFX
if (!pfx) throw new Error('OIC_HTTPS_PFX is not set. Start LAN mode with scripts/lan/start-lan.ps1.')
const lanHosts = (process.env.OIC_LAN_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)

export default mergeConfig(base, defineConfig({
  server: {
    host: '0.0.0.0',
    strictPort: true,
    https: { pfx: readFileSync(pfx), passphrase: process.env.OIC_HTTPS_PASSPHRASE },
    allowedHosts: lanHosts,
  },
}))
