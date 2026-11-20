// Whiteboard shapes and drawing - shared by the meeting room (Whiteboard.tsx) and the recorder page
// (recording/layout/src/main.ts), so a recording shows the board exactly as participants see it.
// Plain TypeScript with DOM types only: no React, no imports.

export const BOARD_W = 1600
export const BOARD_H = 900
export const MAX_PTS = 800 // a longer stroke continues as a new one, so every message stays well under LiveKit's data packet size

export type Pt = [number, number]
export type Shape =
  | { id: string; by: string; kind: 'pen' | 'highlighter'; color: string; size: number; pts: Pt[] }
  | { id: string; by: string; kind: 'line' | 'arrow' | 'rect' | 'ellipse'; color: string; size: number; a: Pt; b: Pt }
  | { id: string; by: string; kind: 'text' | 'note'; color: string; size: number; a: Pt; text: string }
export type TextShape = Extract<Shape, { kind: 'text' | 'note' }>
export type Op =
  | { op: 'add'; s: Shape }
  | { op: 'append'; id: string; pts: Pt[] }
  | { op: 'addMany'; shapes: Shape[] }
  | { op: 'remove'; ids: string[] }
  | { op: 'clear' }

export function isShape(x: unknown): x is Shape {
  const s = x as Shape
  return !!s && typeof s.id === 'string' && typeof s.kind === 'string' && typeof s.color === 'string'
}

/** One operation (local or received) applied to a list of shapes. Pure: returns a new list. */
export function applyOpTo(cur: Shape[], op: Op): Shape[] {
  switch (op.op) {
    case 'add':
      return isShape(op.s) ? [...cur.filter((x) => x.id !== op.s.id), op.s] : cur
    case 'addMany':
      return [...cur.filter((x) => !op.shapes.some((s) => s.id === x.id)), ...op.shapes.filter(isShape)]
    case 'append':
      return cur.map((x) => (x.id === op.id && (x.kind === 'pen' || x.kind === 'highlighter') ? { ...x, pts: [...x.pts, ...op.pts].slice(0, MAX_PTS + 50) } : x))
    case 'remove':
      return cur.filter((x) => !op.ids.includes(x.id))
    case 'clear':
      return []
    default:
      return cur
  }
}

/** Shapes from a saved scene ({ v: 1, shapes }); an unreadable scene gives an empty board. */
export function parseScene(scene: string | null | undefined): Shape[] {
  try {
    const parsed = scene ? (JSON.parse(scene) as { shapes?: unknown[] }) : null
    return (parsed?.shapes ?? []).filter(isShape)
  } catch {
    return []
  }
}

export function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  if (s.kind === 'pen' || s.kind === 'highlighter') {
    ctx.globalAlpha = s.kind === 'highlighter' ? 0.32 : 1
    ctx.lineWidth = s.kind === 'highlighter' ? s.size * 3.5 : s.size
    ctx.beginPath()
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1])
    ctx.stroke()
  } else if (s.kind === 'line' || s.kind === 'arrow') {
    ctx.lineWidth = s.size
    ctx.beginPath()
    ctx.moveTo(...s.a)
    ctx.lineTo(...s.b)
    ctx.stroke()
    if (s.kind === 'arrow') {
      const ang = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0])
      const len = 14 + s.size * 2.5
      ctx.beginPath()
      ctx.moveTo(...s.b)
      ctx.lineTo(s.b[0] - len * Math.cos(ang - 0.45), s.b[1] - len * Math.sin(ang - 0.45))
      ctx.moveTo(...s.b)
      ctx.lineTo(s.b[0] - len * Math.cos(ang + 0.45), s.b[1] - len * Math.sin(ang + 0.45))
      ctx.stroke()
    }
  } else if (s.kind === 'rect') {
    ctx.lineWidth = s.size
    ctx.strokeRect(Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.abs(s.b[0] - s.a[0]), Math.abs(s.b[1] - s.a[1]))
  } else if (s.kind === 'ellipse') {
    ctx.lineWidth = s.size
    ctx.beginPath()
    ctx.ellipse((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, Math.abs(s.b[0] - s.a[0]) / 2, Math.abs(s.b[1] - s.a[1]) / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    drawText(ctx, s as TextShape)
  }
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, s: TextShape) {
  const fontSize = s.kind === 'note' ? 22 : 16 + s.size * 2.5
  ctx.font = `600 ${fontSize}px Inter, "Segoe UI", system-ui, sans-serif`
  const lines = wrap(ctx, s.text, s.kind === 'note' ? 236 : 900)
  if (s.kind === 'note') {
    const h = Math.max(150, 30 + lines.length * (fontSize + 6))
    ctx.fillStyle = '#FDE68A'
    ctx.shadowColor = 'rgba(0,0,0,.18)'
    ctx.shadowBlur = 10
    ctx.shadowOffsetY = 4
    ctx.fillRect(s.a[0], s.a[1], 260, h)
    ctx.shadowColor = 'transparent'
    ctx.fillStyle = '#1F2937'
  }
  ctx.textBaseline = 'top'
  lines.forEach((l, i) => ctx.fillText(l, s.a[0] + (s.kind === 'note' ? 12 : 0), s.a[1] + (s.kind === 'note' ? 14 : 0) + i * (fontSize + 6)))
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word
      if (ctx.measureText(t).width > max && line) {
        out.push(line)
        line = word
      } else line = t
    }
    out.push(line)
  }
  return out
}

/** Paints the whole board (white background, then every shape) at the given scale (canvas pixels per board unit). */
export function renderBoard(ctx: CanvasRenderingContext2D, shapes: Shape[], scale: number, preview?: Shape | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  for (const s of shapes) drawShape(ctx, s)
  if (preview) drawShape(ctx, preview)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/** Who may draw (same rule as the server's CanDraw): host/co-host always; others per the board's draw mode. */
export function mayDrawRole(role: string, identity: string, s: { drawMode: string; allowed: string[] }) {
  return role === 'HOST' || role === 'COHOST' || s.drawMode === 'EVERYONE' || (s.drawMode === 'SELECTED' && s.allowed.includes(identity))
}
