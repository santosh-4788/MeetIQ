import { Component, type ErrorInfo, type ReactNode } from 'react'

/** A lazily loaded page chunk could not be downloaded (typically: the site was redeployed while this tab still had the old
    build's file names, or a mobile network dropped the request). Reloading fetches the new build and fixes it. */
export function isChunkLoadError(e: unknown) {
  const m = String((e as { message?: unknown })?.message ?? e)
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch dynamically|ChunkLoadError|Unable to preload CSS/i.test(m)
}

const RELOAD_KEY = 'oic:chunk-reload'
/** Reload once per page for a chunk error (never loops: a second failure within a minute shows the error card instead). */
export function reloadOnceForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    /* storage blocked: still try one reload */
  }
  window.location.reload()
  return true
}

type Props = { children: ReactNode; /** Shown instead of the children after an error. */ fallback?: (reset: () => void, error: unknown) => ReactNode }

/**
 * Catches render errors below it so one failing page never leaves the whole app as a blank white screen (the cause of the
 * "Start instant meeting → blank page, works after refresh" report: the room page is a separate download, and a failed
 * download or a render exception unmounted the entire React tree, since nothing caught it).
 */
export class ErrorBoundary extends Component<Props, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Page error', error, info.componentStack)
    if (isChunkLoadError(error)) reloadOnceForChunkError()
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error == null) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.reset, this.state.error)
    return <PageErrorCard onRetry={() => window.location.reload()} />
  }
}

export function PageErrorCard({ onRetry, dark }: { onRetry: () => void; dark?: boolean }) {
  return (
    <div className={`flex min-h-[60vh] items-center justify-center px-4 ${dark ? 'text-white' : 'text-ink'}`} role="alert" data-testid="page-error">
      <div className={`w-full max-w-[420px] rounded-2xl p-6 text-center ${dark ? 'bg-white/10' : 'border border-line bg-surface shadow-sm'}`}>
        <h1 className="text-[18px] font-bold">This page did not load properly</h1>
        <p className={`mt-2 text-[14px] leading-[22px] ${dark ? 'text-white/70' : 'text-ink-secondary'}`}>
          Usually a dropped connection or a just-updated site. Your meeting, if you started one, has been kept — reloading opens it again.
        </p>
        <button type="button" onClick={onRetry} className="mt-5 inline-flex h-10 items-center rounded-lg bg-brand-600 px-5 text-[14px] font-semibold text-white hover:bg-brand-700" data-testid="page-error-retry">
          Reload
        </button>
      </div>
    </div>
  )
}
