import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useLocalParticipant, useRoomContext } from '@livekit/components-react'
import { usePeople } from '../androidApp'
import { RoomEvent, type Participant, type RemoteParticipant } from 'livekit-client'
import {
  ArrowUpRight, Circle, Download, Eraser, FileDown, Highlighter, Minus, PenLine, Redo2, Square, StickyNote, Trash2, Type, Undo2, Users, X,
} from 'lucide-react'
import type { BoardState, DrawMode, FeatureCalls } from '../../../api/roomFeatures'
import { errorMessage } from '../../../api/types'
import { ConfirmDialog } from '../../../components/ui/Overlay'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { participantRole } from '../roomUi'
import { BOARD_H, BOARD_W, MAX_PTS, applyOpTo, mayDrawRole, parseScene, renderBoard as render, type Op, type Pt, type Shape, type TextShape } from './whiteboardRender'

// Collaborative whiteboard (13 Nov 2026) - our own small canvas board, no third-party service or library.
// Live strokes travel browser-to-browser over the meeting's own LiveKit connection (topic oic.wb); whoever draws also saves
// the whole board to the server (debounced) so late joiners and reconnects load the latest state. Who may draw is decided by
// the host and announced BY THE SERVER (topic oic.wb-state) - receivers ignore strokes from anyone not allowed to draw.

export const TOPIC_WB = 'oic.wb'
export const TOPIC_WB_STATE = 'oic.wb-state'
const W = BOARD_W
const H = BOARD_H
const CHUNK = 12_000

type Tool = 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'note'

const COLORS = ['#111827', '#2563EB', '#DC2626', '#16A34A', '#F59E0B', '#9333EA']
const SIZES = [3, 6, 12]
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

/** Server-side state (open? who draws?) for the whole room. */
export function useWhiteboardState(calls: FeatureCalls['whiteboard'] | undefined, enabled: boolean) {
  const room = useRoomContext()
  const [state, setState] = useState<BoardState>({ isOpen: false, drawMode: 'EVERYONE', allowed: [] })
  const refresh = useCallback(() => {
    if (!calls || !enabled) return
    calls.get().then((b) => setState({ isOpen: b.isOpen, drawMode: b.drawMode, allowed: b.allowed })).catch(() => undefined)
  }, [calls, enabled])
  useEffect(() => {
    if (!enabled) return
    refresh()
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC_WB_STATE || participant) return // trusted only from the server
      try {
        const d = JSON.parse(decoder.decode(payload)) as BoardState
        setState({ isOpen: !!d.isOpen, drawMode: d.drawMode, allowed: Array.isArray(d.allowed) ? d.allowed : [] })
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    room.on(RoomEvent.Reconnected, refresh)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.Reconnected, refresh)
    }
  }, [enabled, refresh, room])
  return { state, refresh }
}

function mayDraw(p: Participant, s: BoardState) {
  return mayDrawRole(participantRole(p).role, p.identity, s)
}

// ---- Drawing -----------------------------------------------------------------------------------------------------------

function distToSeg(p: Pt, a: Pt, b: Pt) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function hit(s: Shape, p: Pt, r = 12): boolean {
  if (s.kind === 'pen' || s.kind === 'highlighter') return s.pts.some((q, i) => (i ? distToSeg(p, s.pts[i - 1], q) : Math.hypot(p[0] - q[0], p[1] - q[1])) < r + s.size)
  if (s.kind === 'line' || s.kind === 'arrow') return distToSeg(p, s.a, s.b) < r + s.size
  if (s.kind === 'rect' || s.kind === 'ellipse') {
    const [x1, x2] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])]
    const [y1, y2] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])]
    return p[0] > x1 - r && p[0] < x2 + r && p[1] > y1 - r && p[1] < y2 + r
  }
  const t = s as TextShape
  return p[0] > t.a[0] - r && p[0] < t.a[0] + (t.kind === 'note' ? 260 : 300) && p[1] > t.a[1] - r && p[1] < t.a[1] + (t.kind === 'note' ? 160 : 40)
}

// ---- Component ---------------------------------------------------------------------------------------------------------

export function WhiteboardStage({
  calls,
  state,
  meetingCode,
  onHide,
}: {
  calls: FeatureCalls['whiteboard']
  state: BoardState
  meetingCode: string
  onHide: () => void
}) {
  const room = useRoomContext()
  const toast = useToast()
  const { localParticipant } = useLocalParticipant()
  const participants = usePeople()
  const me = localParticipant.identity
  const role = participantRole(localParticipant).role
  const isHost = role === 'HOST' || role === 'COHOST'
  const canDraw = mayDraw(localParticipant, state)

  const [shapes, setShapes] = useState<Shape[]>([])
  const shapesRef = useRef<Shape[]>([])
  shapesRef.current = shapes
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0])
  const [size, setSize] = useState(SIZES[0])
  const [preview, setPreview] = useState<Shape | null>(null)
  const [textAt, setTextAt] = useState<{ a: Pt; kind: 'text' | 'note'; value: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const undo = useRef<Op[][]>([])
  const redo = useRef<Op[][]>([])
  const loaded = useRef(false)
  const pending = useRef<{ op: Op; from: Participant }[]>([])
  const version = useRef(0)
  const saveTimer = useRef(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 800, h: 450 })
  const drawing = useRef<{ id: string; start: Pt; sent: number } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  // ---- apply operations (local or remote) ----
  const applyOp = useCallback((op: Op) => {
    setShapes((cur) => applyOpTo(cur, op))
  }, [])

  const save = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      calls
        .saveScene(version.current, JSON.stringify({ v: 1, shapes: shapesRef.current }))
        .then((r) => (version.current = r.version))
        .catch((e: unknown) => toast.error(errorMessage(e, 'The whiteboard could not be saved. Your drawing stays on screen.')))
    }, 1200)
  }, [calls, toast])

  const publish = useCallback(
    (ops: Op[]) => {
      // Large operations (restore after "Clear" undo) are split so each message stays small.
      const out: Op[] = []
      for (const op of ops) {
        if (op.op === 'addMany' && JSON.stringify(op).length > CHUNK) {
          let batch: Shape[] = []
          for (const s of op.shapes) {
            batch.push(s)
            if (JSON.stringify(batch).length > CHUNK) {
              out.push({ op: 'addMany', shapes: batch.slice(0, -1) })
              batch = [s]
            }
          }
          if (batch.length) out.push({ op: 'addMany', shapes: batch })
        } else out.push(op)
      }
      for (const op of out) void room.localParticipant.publishData(encoder.encode(JSON.stringify(op)), { reliable: true, topic: TOPIC_WB }).catch(() => undefined)
    },
    [room],
  )

  /** A local, undoable change: applied, sent to the room and saved. */
  const commit = useCallback(
    (ops: Op[], inverse: Op[]) => {
      ops.forEach(applyOp)
      publish(ops)
      undo.current.push(inverse)
      redo.current = []
      save()
    },
    [applyOp, publish, save],
  )

  // ---- load + live updates ----
  useEffect(() => {
    let alive = true
    loaded.current = false
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC_WB || !participant) return
      if (!mayDraw(participant, stateRef.current)) return // not allowed to draw: ignored
      try {
        const op = JSON.parse(decoder.decode(payload)) as Op
        if (!loaded.current) pending.current.push({ op, from: participant })
        else applyOp(op)
      } catch {
        /* ignore */
      }
    }
    room.on(RoomEvent.DataReceived, onData)
    const load = () =>
      calls
        .get()
        .then((b) => {
          if (!alive) return
          version.current = b.version
          const initial = parseScene(b.scene)
          setShapes(initial)
          loaded.current = true
          pending.current.splice(0).forEach((p) => applyOp(p.op))
        })
        .catch((e: unknown) => {
          loaded.current = true
          toast.error(errorMessage(e, 'The whiteboard could not be loaded.'))
        })
    void load()
    room.on(RoomEvent.Reconnected, load)
    return () => {
      alive = false
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.Reconnected, load)
      window.clearTimeout(saveTimer.current)
    }
  }, [calls, room, applyOp, toast])

  // ---- sizing + painting ----
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const w = Math.max(200, Math.min(r.width, (r.height * W) / H))
      setBox({ w, h: (w * H) / W })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(box.w * dpr)
    c.height = Math.round(box.h * dpr)
    const ctx = c.getContext('2d')
    if (ctx) render(ctx, shapes, (box.w * dpr) / W, preview)
  }, [shapes, preview, box])

  const toBoard = (e: RPointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)]
  }

  const eraseAt = (p: Pt) => {
    const gone = shapesRef.current.filter((s) => hit(s, p))
    if (gone.length) commit([{ op: 'remove', ids: gone.map((s) => s.id) }], [{ op: 'addMany', shapes: gone }])
  }

  function onDown(e: RPointerEvent<HTMLCanvasElement>) {
    if (!canDraw || textAt) return
    const p = toBoard(e)
    if (tool === 'text' || tool === 'note') {
      // Keep the browser from moving focus to the page on this click: the new text box (autofocused) would lose focus
      // at once and close empty.
      e.preventDefault()
      setTextAt({ a: p, kind: tool, value: '' })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (tool === 'eraser') {
      drawing.current = { id: '', start: p, sent: 0 }
      eraseAt(p)
      return
    }
    const id = rid()
    drawing.current = { id, start: p, sent: 0 }
    if (tool === 'pen' || tool === 'highlighter') showPreview({ id, by: me, kind: tool, color, size, pts: [p] })
    else showPreview({ id, by: me, kind: tool, color, size, a: p, b: p })
  }

  // The shape being drawn lives in a ref (side effects such as sending must never run inside a React state updater).
  const previewRef = useRef<Shape | null>(null)
  const showPreview = (s: Shape | null) => {
    previewRef.current = s
    setPreview(s)
  }

  function onMove(e: RPointerEvent<HTMLCanvasElement>) {
    const d = drawing.current
    if (!d) return
    const p = toBoard(e)
    if (tool === 'eraser') return eraseAt(p)
    const s = previewRef.current
    if (!s) return
    if (s.kind === 'pen' || s.kind === 'highlighter') {
      const last = s.pts[s.pts.length - 1]
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) return
      const next = { ...s, pts: [...s.pts, p] }
      // Live for others: the stroke streams while it is drawn (first as "add", then small "append" messages).
      if (next.pts.length - d.sent >= 6) {
        publish([d.sent === 0 ? { op: 'add', s: next } : { op: 'append', id: next.id, pts: next.pts.slice(d.sent) }])
        d.sent = next.pts.length
      }
      if (next.pts.length >= MAX_PTS) {
        finishStroke(next)
        const id = rid()
        drawing.current = { id, start: p, sent: 0 }
        showPreview({ ...next, id, pts: [p] })
        return
      }
      showPreview(next)
    } else showPreview({ ...s, b: p } as Shape)
  }

  function finishStroke(s: Shape) {
    const d = drawing.current
    applyOp({ op: 'add', s })
    if (s.kind === 'pen' || s.kind === 'highlighter') {
      if (d && d.sent > 0) publish([{ op: 'append', id: s.id, pts: s.pts.slice(d.sent) }])
      else publish([{ op: 'add', s }])
    } else publish([{ op: 'add', s }])
    undo.current.push([{ op: 'remove', ids: [s.id] }])
    redo.current = []
    save()
  }

  function onUp() {
    const d = drawing.current
    if (!d) return
    if (tool === 'eraser') {
      drawing.current = null
      return
    }
    const s = previewRef.current
    if (s) {
      const tiny = (s.kind === 'line' || s.kind === 'arrow' || s.kind === 'rect' || s.kind === 'ellipse') && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) < 4
      if (!tiny) finishStroke(s)
    }
    drawing.current = null
    showPreview(null)
  }

  function commitText() {
    if (!textAt) return
    const value = textAt.value.trim().slice(0, 500)
    setTextAt(null)
    if (!value) return
    const s: Shape = { id: rid(), by: me, kind: textAt.kind, color, size, a: textAt.a, text: value }
    commit([{ op: 'add', s }], [{ op: 'remove', ids: [s.id] }])
  }

  // Undo/redo work on this participant's own changes; each step is replayed to everyone like any other change.
  const doUndo = () => {
    const inv = undo.current.pop()
    if (!inv) return
    const fwd = invert(inv, shapesRef.current)
    inv.forEach(applyOp)
    publish(inv)
    redo.current.push(fwd)
    save()
  }
  const doRedo = () => {
    const ops = redo.current.pop()
    if (!ops) return
    const back = invert(ops, shapesRef.current)
    ops.forEach(applyOp)
    publish(ops)
    undo.current.push(back)
    save()
  }

  function invert(ops: Op[], cur: Shape[]): Op[] {
    const out: Op[] = []
    for (const op of ops) {
      if (op.op === 'remove') out.push({ op: 'addMany', shapes: cur.filter((s) => op.ids.includes(s.id)) })
      else if (op.op === 'addMany') out.push({ op: 'remove', ids: op.shapes.map((s) => s.id) })
      else if (op.op === 'add') out.push({ op: 'remove', ids: [op.s.id] })
      else if (op.op === 'clear') out.push({ op: 'addMany', shapes: cur })
    }
    return out
  }

  function clearBoard() {
    const all = shapesRef.current
    commit([{ op: 'clear' }], [{ op: 'addMany', shapes: all }])
  }

  // ---- export ----
  function snapshot() {
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    render(c.getContext('2d')!, shapesRef.current, 1)
    return c
  }
  const fileBase = `whiteboard-${meetingCode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`
  function exportPng() {
    snapshot().toBlob((b) => {
      if (!b) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(b)
      a.download = `${fileBase}.png`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }, 'image/png')
  }
  async function exportPdf() {
    try {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [W, H], hotfixes: ['px_scaling'] })
      // JPEG keeps the PDF small (a PNG is stored uncompressed by jsPDF: ~4 MB for one page).
      pdf.addImage(snapshot().toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, H)
      pdf.save(`${fileBase}.pdf`)
    } catch {
      toast.error('The PDF could not be created.')
    }
  }

  // ---- host controls ----
  async function setAccess(mode: DrawMode, allowed?: string[]) {
    try {
      await calls.setState?.({ drawMode: mode, ...(allowed ? { allowed } : {}) })
    } catch (e) {
      toast.error(errorMessage(e, 'Drawing access could not be changed.'))
    }
  }
  async function closeBoard() {
    try {
      await calls.setState?.({ open: false })
    } catch (e) {
      toast.error(errorMessage(e, 'The whiteboard could not be closed.'))
    }
  }

  const others = useMemo(() => participants.filter((p) => p.identity !== me && !['HOST', 'COHOST'].includes(participantRole(p).role)), [participants, me])
  const tools: { t: Tool; label: string; icon: React.ReactNode }[] = [
    { t: 'pen', label: 'Pen', icon: <PenLine className="size-4" /> },
    { t: 'highlighter', label: 'Highlighter', icon: <Highlighter className="size-4" /> },
    { t: 'eraser', label: 'Eraser', icon: <Eraser className="size-4" /> },
    { t: 'line', label: 'Line', icon: <Minus className="size-4" /> },
    { t: 'arrow', label: 'Arrow', icon: <ArrowUpRight className="size-4" /> },
    { t: 'rect', label: 'Rectangle', icon: <Square className="size-4" /> },
    { t: 'ellipse', label: 'Circle', icon: <Circle className="size-4" /> },
    { t: 'text', label: 'Text', icon: <Type className="size-4" /> },
    { t: 'note', label: 'Sticky note', icon: <StickyNote className="size-4" /> },
  ]
  const btn = 'flex size-8 shrink-0 items-center justify-center rounded-md text-slate-700 hover:bg-slate-200 disabled:opacity-40'

  return (
    <div className="flex h-full flex-col gap-2" data-testid="whiteboard">
      <div className="flex flex-wrap items-center gap-1 rounded-xl bg-white/95 px-2 py-1.5 text-slate-800 shadow-lg">
        {canDraw ? (
          <>
            {tools.map((x) => (
              <button key={x.t} type="button" className={cn(btn, tool === x.t && 'bg-brand-500/15 text-brand-700 ring-1 ring-brand-500/40')} onClick={() => setTool(x.t)} title={x.label} aria-label={x.label} aria-pressed={tool === x.t} data-testid={`wb-tool-${x.t}`}>
                {x.icon}
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden />
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Colour ${c}`} aria-pressed={color === c} className={cn('size-6 shrink-0 rounded-full ring-offset-1', color === c && 'ring-2 ring-slate-500')} style={{ background: c }} />
            ))}
            <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden />
            {SIZES.map((s) => (
              <button key={s} type="button" onClick={() => setSize(s)} aria-label={`Thickness ${s}`} aria-pressed={size === s} className={cn(btn, size === s && 'bg-slate-200')}>
                <span className="rounded-full bg-slate-700" style={{ width: s + 3, height: s + 3 }} />
              </button>
            ))}
            <span className="mx-1 h-6 w-px bg-slate-300" aria-hidden />
            <button type="button" className={btn} onClick={doUndo} title="Undo" aria-label="Undo" data-testid="wb-undo"><Undo2 className="size-4" /></button>
            <button type="button" className={btn} onClick={doRedo} title="Redo" aria-label="Redo" data-testid="wb-redo"><Redo2 className="size-4" /></button>
            <button type="button" className={btn} onClick={() => setConfirmClear(true)} title="Clear board" aria-label="Clear board" data-testid="wb-clear"><Trash2 className="size-4" /></button>
          </>
        ) : (
          <span className="px-2 text-[12.5px] font-medium text-slate-600" data-testid="wb-view-only">View only - the host controls who can draw</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className={btn} onClick={exportPng} title="Download PNG" aria-label="Download PNG" data-testid="wb-png"><Download className="size-4" /></button>
          <button type="button" className={btn} onClick={() => void exportPdf()} title="Download PDF" aria-label="Download PDF" data-testid="wb-pdf"><FileDown className="size-4" /></button>
          {isHost && calls.setState && (
            <span className="relative">
              <button type="button" className={cn(btn, 'w-auto gap-1 px-2 text-[12px] font-semibold')} onClick={() => setAccessOpen((v) => !v)} aria-expanded={accessOpen} data-testid="wb-access">
                <Users className="size-4" /> {state.drawMode === 'HOSTS' ? 'Hosts draw' : state.drawMode === 'EVERYONE' ? 'Everyone draws' : `${state.allowed.length} can draw`}
              </button>
              {accessOpen && (
                <div className="absolute right-0 top-10 z-30 w-64 rounded-xl bg-white p-2 text-[13px] shadow-xl ring-1 ring-slate-200" data-testid="wb-access-menu">
                  {(['HOSTS', 'EVERYONE', 'SELECTED'] as const).map((m) => (
                    <label key={m} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-100">
                      <input type="radio" name="wb-mode" checked={state.drawMode === m} onChange={() => void setAccess(m)} data-testid={`wb-mode-${m.toLowerCase()}`} />
                      {m === 'HOSTS' ? 'Only hosts can draw' : m === 'EVERYONE' ? 'Everyone can draw' : 'Selected people can draw'}
                    </label>
                  ))}
                  {state.drawMode === 'SELECTED' && (
                    <div className="mt-1 max-h-48 overflow-y-auto border-t border-slate-200 pt-1">
                      {others.length === 0 && <p className="px-2 py-1.5 text-slate-500">Nobody else to choose.</p>}
                      {others.map((p) => (
                        <label key={p.identity} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-100">
                          <input
                            type="checkbox"
                            checked={state.allowed.includes(p.identity)}
                            onChange={(e) => void setAccess('SELECTED', e.target.checked ? [...state.allowed, p.identity] : state.allowed.filter((x) => x !== p.identity))}
                            data-testid="wb-allow"
                          />
                          <span className="truncate">{p.name || p.identity}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </span>
          )}
          {isHost && calls.setState && (
            <button type="button" className={cn(btn, 'w-auto px-2 text-[12px] font-semibold text-rose-700')} onClick={() => void closeBoard()} data-testid="wb-close">Close for all</button>
          )}
          <button type="button" className={btn} onClick={onHide} title="Show the video" aria-label="Show the video" data-testid="wb-hide"><X className="size-4" /></button>
        </span>
      </div>
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative" style={{ width: box.w, height: box.h }}>
          <canvas
            ref={canvasRef}
            className={cn('size-full touch-none rounded-lg shadow-xl', canDraw ? (tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair') : 'cursor-default')}
            style={{ width: box.w, height: box.h }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            aria-label="Whiteboard"
            data-testid="wb-canvas"
          />
          {textAt && (
            <textarea
              autoFocus
              className={cn('absolute z-10 resize-none rounded-md border-2 border-brand-500 p-2 text-[14px] text-slate-900 outline-none', textAt.kind === 'note' ? 'bg-amber-200' : 'bg-white')}
              style={{ left: (textAt.a[0] / W) * box.w, top: (textAt.a[1] / H) * box.h, width: textAt.kind === 'note' ? 180 : 260, height: 90 }}
              value={textAt.value}
              placeholder={textAt.kind === 'note' ? 'Sticky note…' : 'Type text…'}
              onChange={(e) => setTextAt({ ...textAt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitText()
                } else if (e.key === 'Escape') setTextAt(null)
              }}
              onBlur={commitText}
              data-testid="wb-text-input"
            />
          )}
        </div>
      </div>
      <ConfirmDialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear the whiteboard for everyone?" confirmLabel="Clear board" onConfirm={async () => clearBoard()}>
        <p>Everything on the board is removed for all participants. You can undo this.</p>
      </ConfirmDialog>
    </div>
  )
}
