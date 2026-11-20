import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { VideoTrack, useConnectionQualityIndicator, useLocalParticipant, type TrackReference } from '@livekit/components-react'
import { ConnectionQuality } from 'livekit-client'
import { ChevronRight, Maximize, Minimize, PanelLeftClose, PanelLeftOpen, Scan, SlidersHorizontal, ZoomIn, ZoomOut } from 'lucide-react'
import { useToast } from '../../components/ui/Toast'

/**
 * Screen-share viewer (18 Nov 2026, "Screen Sharing Quality, Fullscreen and Remote Control Enhancement" - Phase 2).
 *
 * Root causes found in Phase 1 (measured on the test site with the screenshot's window size, 1460x745):
 *  - Blurry text: the room uses LiveKit adaptive stream, which asks the server for the simulcast layer matching the size of
 *    the <video> element. A 1920x1080 share shown ~1163x545 received the 960x540 layer and was stretched. With the same
 *    element made window-sized the 1920x1080 layer arrived within 2.5 s.
 *  - "Expand" did nothing: the icon was LiveKit's FocusToggle (pin), and the share is already the pinned/focused tile.
 *
 * What this does, viewer side only (the presenter's capture, the room connection, recording and permissions are untouched):
 *  - Quality: the <video> element's layout box is the share's full size (Auto/Maximum) and it is scaled down with a CSS
 *    transform to the size actually shown, so adaptive stream requests the full layer and the browser downsamples a sharp
 *    picture. Standard (and Auto on a poor connection) keeps the old behaviour (box = shown size -> smaller layer). The
 *    video server still lowers the layer by itself when the viewer's bandwidth cannot carry it.
 *  - Zoom: Fit / zoom in / zoom out / Actual size (1 shared pixel = 1 screen pixel), drag or scroll to move when zoomed.
 *  - Participants strip: hide / show (state in ScreenStageContext, owned by Stage).
 *  - Fullscreen: the whole meeting page (controls, dialogs and toasts stay usable), via the Fullscreen API from the click;
 *    Esc or the button exits. If the browser refuses, nothing claims fullscreen and the participants strip is hidden instead.
 */

export type ScreenQuality = 'auto' | 'standard' | 'max'
const QUALITY_KEY = 'oic.screenQuality'
const QUALITY_LABEL: Record<ScreenQuality, string> = { auto: 'Auto', standard: 'Standard', max: 'Maximum' }

function readQuality(): ScreenQuality {
  try {
    const v = localStorage.getItem(QUALITY_KEY)
    return v === 'standard' || v === 'max' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

/** Shared by Stage (layout) and the screen tile (toolbar). */
export const ScreenStageContext = createContext<{
  thumbsHidden: boolean
  setThumbsHidden: (v: boolean) => void
  /** The strip's state before fullscreen, restored on exit. Kept by Stage: the screen tile can be re-created meanwhile. */
  beforeFullscreen: RefObject<boolean | null>
} | null>(null)

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenEnabled?: boolean }
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
const fsDoc = () => document as FsDoc
const fullscreenNow = () => !!(document.fullscreenElement ?? fsDoc().webkitFullscreenElement)
const fullscreenSupported = () => !!(document.fullscreenEnabled || fsDoc().webkitFullscreenEnabled)

export function useFullscreenState() {
  const [on, setOn] = useState(fullscreenNow)
  useEffect(() => {
    const sync = () => setOn(fullscreenNow())
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])
  return on
}

export function ScreenShareView({ trackRef, videoRef }: { trackRef: TrackReference; videoRef: RefObject<HTMLVideoElement | null> }) {
  const toast = useToast()
  const stage = useContext(ScreenStageContext)
  // Auto follows THIS viewer's connection (what has to carry the picture); the presenter's is shown on the tile's chip.
  const { localParticipant } = useLocalParticipant()
  const { quality: link } = useConnectionQualityIndicator({ participant: localParticipant })
  const box = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [quality, setQualityState] = useState<ScreenQuality>(readQuality)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const fullscreen = useFullscreenState()

  // A new share (or a different presenter) starts at "Fit".
  const sid = trackRef.publication.trackSid
  useEffect(() => setZoom('fit'), [sid])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The share's real size: the published dimensions (what the presenter sends), refined by the decoded frame's aspect.
  const pubDims = trackRef.publication.dimensions
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const read = () => v.videoWidth > 0 && setNatural({ w: v.videoWidth, h: v.videoHeight })
    read()
    v.addEventListener('resize', read)
    v.addEventListener('loadedmetadata', read)
    return () => {
      v.removeEventListener('resize', read)
      v.removeEventListener('loadedmetadata', read)
    }
  }, [videoRef, sid])
  const src = (() => {
    const p = pubDims && pubDims.width > 0 && pubDims.height > 0 ? { w: pubDims.width, h: pubDims.height } : null
    if (p && natural) return { w: p.w, h: Math.round((p.w * natural.h) / natural.w) } // published size, decoded aspect
    return p ?? natural ?? { w: 1920, h: 1080 }
  })()

  const fit = area.w > 0 && area.h > 0 ? Math.min(area.w / src.w, area.h / src.h) : 1
  const scale = zoom === 'fit' ? fit : zoom
  const shownW = Math.max(1, Math.round(src.w * scale))
  const shownH = Math.max(1, Math.round(src.h * scale))

  // Auto: full resolution unless this viewer's connection is poor/lost (then the smaller layer, as before).
  const wantFull = quality === 'max' || (quality === 'auto' && link !== ConnectionQuality.Poor && link !== ConnectionQuality.Lost)
  const layoutW = wantFull ? Math.max(shownW, src.w) : shownW
  const layoutH = wantFull ? Math.max(shownH, src.h) : shownH
  const shrink = shownW / layoutW

  const setQuality = (q: ScreenQuality) => {
    setQualityState(q)
    try {
      localStorage.setItem(QUALITY_KEY, q)
    } catch {
      /* per-viewer convenience only */
    }
  }

  const step = (dir: 1 | -1) => {
    const cur = zoom === 'fit' ? fit : zoom
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001)
    if (next === undefined) return
    // Zooming out below "fit" returns to fit (no point in a smaller picture with empty space around it).
    setZoom(dir < 0 && next <= fit ? 'fit' : next)
  }

  const toggleFullscreen = useCallback(async () => {
    if (fullscreenNow()) {
      try {
        await (document.exitFullscreen ? document.exitFullscreen() : fsDoc().webkitExitFullscreen?.())
      } catch {
        /* already left */
      }
      return
    }
    const root = document.documentElement as FsEl
    // The strip is hidden first (restored by Stage when fullscreen ends), so fullscreen never shows a half-updated layout.
    if (stage) {
      if (stage.beforeFullscreen.current === null) stage.beforeFullscreen.current = stage.thumbsHidden
      stage.setThumbsHidden(true)
    }
    try {
      if (!fullscreenSupported()) throw new Error('unsupported')
      await (root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen?.())
      if (!fullscreenNow()) throw new Error('refused')
    } catch {
      // Never claim fullscreen when the browser refused it (phones, iframes, policy). The screen keeps the extra room
      // (participants hidden; "Show participants" brings them back).
      if (stage) stage.beforeFullscreen.current = null
      toast.error('This browser did not allow fullscreen. The shared screen is expanded inside the page instead (participants hidden).')
    }
  }, [stage, toast])

  // 18 Nov 2026 (bugs docx): "don't show this option continuously - hide after a few seconds; expand only if the user wants".
  // The toolbar is a single small button by default; opening it shows the controls, which fold away again after 5 s without
  // use (not while the mouse is over them). Every device behaves the same.
  const [toolsOpen, setToolsOpen] = useState(false)
  const idle = useRef<number | undefined>(undefined)
  const hovering = useRef(false)
  const armClose = useCallback(() => {
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(() => {
      if (hovering.current) armClose()
      else setToolsOpen(false)
    }, 5000)
  }, [])
  const openTools = () => {
    setToolsOpen(true)
    armClose()
  }
  useEffect(() => () => window.clearTimeout(idle.current), [])
  useEffect(() => setToolsOpen(false), [sid])
  // Page fullscreen is not offered where the browser cannot do it (iPhone Safari): no button that can only fail.
  const canFullscreen = fullscreenSupported() || fullscreen

  // Drag to move a zoomed picture (mouse/pen; touch scrolls natively).
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null)
  const zoomed = shownW > area.w + 1 || shownH > area.h + 1

  const ctl = 'inline-flex size-9 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-40 [@media(pointer:coarse)]:size-10'
  const linkLabel = link === ConnectionQuality.Excellent ? 'Excellent' : link === ConnectionQuality.Good ? 'Good' : link === ConnectionQuality.Poor ? 'Poor' : link === ConnectionQuality.Lost ? 'Lost' : 'Unknown'

  return (
    <>
      <div
        ref={box}
        className="oic-screen-view absolute inset-0"
        data-testid="screen-view"
        data-zoomed={zoomed || undefined}
        data-quality={quality}
        data-full-layer={wantFull || undefined}
        onPointerDown={(e) => {
          if (!zoomed || e.pointerType === 'touch' || e.button !== 0) return
          const el = box.current!
          drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }
          el.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          box.current!.scrollLeft = d.l - (e.clientX - d.x)
          box.current!.scrollTop = d.t - (e.clientY - d.y)
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={(e) => {
          if (!e.ctrlKey) return // plain wheel scrolls a zoomed picture; Ctrl + wheel zooms
          e.preventDefault()
          step(e.deltaY < 0 ? 1 : -1)
        }}
      >
        <div className="oic-screen-canvas" style={{ width: Math.max(shownW, area.w), height: Math.max(shownH, area.h) }}>
          <div className="oic-screen-frame" style={{ width: shownW, height: shownH }}>
            <VideoTrack
              ref={videoRef}
              trackRef={trackRef}
              data-testid="video-screen"
              style={{ width: layoutW, height: layoutH, transform: shrink < 0.9999 ? `scale(${shrink})` : undefined }}
            />
          </div>
        </div>
      </div>
      {!toolsOpen ? (
        <button type="button" className="oic-screen-tools-toggle" onClick={openTools} title="View options: quality, zoom, fullscreen"
          aria-label="Show view options (quality, zoom, fullscreen)" aria-expanded={false} data-testid="screen-tools-toggle">
          <SlidersHorizontal className="size-4" />
        </button>
      ) : (
      <div className="oic-screen-tools" role="toolbar" aria-label="Shared screen view" data-testid="screen-tools"
        onPointerDown={armClose} onKeyDown={armClose} onChange={armClose}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') hovering.current = true }}
        onPointerLeave={() => { hovering.current = false; armClose() }}>
        <label className="sr-only" htmlFor={`sq-${sid}`}>Picture quality</label>
        <select
          id={`sq-${sid}`}
          value={quality}
          onChange={(e) => setQuality(e.target.value as ScreenQuality)}
          className="h-9 cursor-pointer rounded-full bg-white/10 px-2.5 text-[12px] font-semibold text-white outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-cyan-400 [@media(pointer:coarse)]:h-10"
          title="Picture quality. Auto: full resolution unless your connection is poor."
          data-testid="screen-quality"
        >
          {(Object.keys(QUALITY_LABEL) as ScreenQuality[]).map((q) => (
            <option key={q} value={q} className="text-ink">{QUALITY_LABEL[q]}</option>
          ))}
        </select>
        <span className="oic-screen-sep" aria-hidden />
        <button type="button" className={ctl} onClick={() => step(-1)} disabled={zoom === 'fit'} title="Zoom out" aria-label="Zoom out" data-testid="screen-zoom-out">
          <ZoomOut className="size-4" />
        </button>
        <span className="min-w-[44px] text-center text-[12px] font-semibold tabular-nums text-white/85" data-testid="screen-zoom-level" aria-live="polite">
          {zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}
        </span>
        <button type="button" className={ctl} onClick={() => step(1)} disabled={scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001} title="Zoom in (Ctrl + mouse wheel)" aria-label="Zoom in" data-testid="screen-zoom-in">
          <ZoomIn className="size-4" />
        </button>
        <button type="button" className={ctl} onClick={() => setZoom('fit')} disabled={zoom === 'fit'} title="Fit to screen" aria-label="Fit to screen" data-testid="screen-fit">
          <Scan className="size-4" />
        </button>
        <button type="button" className={`${ctl} w-auto px-2.5 text-[12px] font-semibold`} onClick={() => setZoom(1)} disabled={zoom === 1} title="Actual size (1 shared pixel = 1 screen pixel)" aria-label="Actual size" data-testid="screen-actual">
          1:1
        </button>
        {stage && (
          <>
            <span className="oic-screen-sep" aria-hidden />
            <button type="button" className={ctl} onClick={() => stage.setThumbsHidden(!stage.thumbsHidden)}
              title={stage.thumbsHidden ? 'Show participants' : 'Hide participants'} aria-label={stage.thumbsHidden ? 'Show participants' : 'Hide participants'}
              aria-pressed={stage.thumbsHidden} data-testid="screen-thumbs">
              {stage.thumbsHidden ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </>
        )}
        {canFullscreen && (
          <button type="button" className={ctl} onClick={() => void toggleFullscreen()} title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-pressed={fullscreen} data-testid="screen-fullscreen">
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </button>
        )}
        <span className="sr-only" data-testid="screen-link">Your connection: {linkLabel}</span>
        <span className="oic-screen-sep" aria-hidden />
        <button type="button" className={ctl} onClick={() => { hovering.current = false; setToolsOpen(false) }} title="Hide view options" aria-label="Hide view options" data-testid="screen-tools-close">
          <ChevronRight className="size-4" />
        </button>
      </div>
      )}
    </>
  )
}
