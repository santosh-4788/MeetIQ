import { defineConfig } from 'vite'

// Built as static files and served to Chromium by the recorder through Playwright request
// interception, so the recorder never opens a listening port.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
})
