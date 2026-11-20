import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The API is served by ASP.NET Core under /api on the same origin in production (IIS).
// In development, requests are proxied to the local API. OIC_API_TARGET points the proxy at another
// API instance (e.g. the isolated E2E API on https://localhost:7190); default: the developer API.
// (Read via globalThis: the project does not ship Node type definitions.)
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const apiTarget = env.OIC_API_TARGET || 'https://localhost:7180'
// Extra public host names allowed to reach the dev server (e.g. an ngrok tunnel used for testing).
// More can be added without editing this file: OIC_ALLOWED_HOSTS="a.example,b.example".
const allowedHosts = ['startling-affair-constrict.ngrok-free.dev', ...(env.OIC_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)]

export default defineConfig(({ command }) => ({
  // Production build is served under https://www.oneinsure.com/meet/ (IIS sub-application);
  // dev server keeps serving from the origin root.
  base: command === 'build' ? '/meet/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    allowedHosts,
    proxy: {
      // '^/api/' (not '/api'): a plain prefix would also proxy the app's own /api-docs page to the API.
      // ws: the Chat live channel (/api/v1/hubs/chat) is a WebSocket under /api (in production IIS proxies it the same way).
      '^/api/': { target: apiTarget, changeOrigin: true, secure: false, ws: true },
      '/hubs': { target: apiTarget, ws: true, secure: false },
      // LiveKit signalling through the site's own host/port (API setting LiveKit:PublicUrl = "/"), so browsers on
      // other machines reach the video server via the same HTTPS address; only the media ports need the firewall.
      '/rtc': { target: env.OIC_LIVEKIT_TARGET || 'http://127.0.0.1:7880', ws: true, changeOrigin: true },
    },
    host: '0.0.0.0',
  },
}))
