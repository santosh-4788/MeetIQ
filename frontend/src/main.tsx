import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource-variable/inter'
import './styles/theme.css'
import App from './App'
import { ErrorBoundary, reloadOnceForChunkError } from './components/ErrorBoundary'

// Vite reports a failed lazy-chunk download here (old file names after a redeploy, or a dropped mobile request).
// Reload once to pick up the current build instead of rendering a blank screen.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadOnceForChunkError()) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
)
