import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, PenTool, Shapes, Sparkles, Vote, X } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { ReactionPicker, type ReactionKind } from './Reactions'

/**
 * One toolbar button for all the optional features (reactions, polls, whiteboard, background effects), so the existing toolbar
 * is not crowded. Shown only when at least one of them is switched on. Rendered through a portal into the room element (the
 * toolbar's backdrop-filter would otherwise trap a fixed-position popover, see MoreSheet in MeetingRoom.tsx).
 */
export function ToolsButton({
  reactions,
  onReact,
  polls,
  pollsAttention,
  whiteboard,
  effects,
}: {
  reactions: boolean
  onReact: (k: ReactionKind) => void
  polls?: () => void
  pollsAttention?: boolean
  whiteboard?: { label: string; onClick: () => void }
  effects?: () => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!box.current?.contains(t) && !t.closest('[data-testid="ctl-tools"]')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const target = (typeof document !== 'undefined' && document.querySelector<HTMLElement>('.oic-room')) || document.body
  const item = (label: string, icon: ReactNode, onClick: () => void, testId: string, badge?: boolean) => (
    <button
      type="button"
      onClick={() => {
        setOpen(false)
        onClick()
      }}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13.5px] font-medium text-white hover:bg-white/[0.08]"
      data-testid={testId}
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-white/[0.08]">{icon}</span>
      <span className="flex-1">{label}</span>
      {badge && <span className="size-2 rounded-full bg-cyan-400" aria-label="New" />}
      <ChevronRight className="size-4 text-white/40" aria-hidden />
    </button>
  )

  return (
    <>
      <button
        type="button"
        className="oic-ctl"
        data-on={open || undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title="Reactions and tools"
        aria-label="Reactions and tools"
        data-testid="ctl-tools"
      >
        <Sparkles className="size-5" />
        {pollsAttention && <span className="oic-ctl-badge" aria-label="New poll">!</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={box}
            role="dialog"
            aria-label="Reactions and tools"
            className="oic-panel fixed bottom-[84px] left-1/2 z-40 w-[min(360px,calc(100vw-16px))] -translate-x-1/2 rounded-2xl p-2 shadow-2xl [@media(max-height:500px)]:bottom-16"
            data-testid="tools-menu"
          >
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-white/50">Reactions & tools</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex size-7 items-center justify-center rounded-md text-white/60 hover:bg-white/10">
                <X className="size-4" />
              </button>
            </div>
            {reactions && (
              <div className={cn('px-1 pb-2', (polls || whiteboard || effects) && 'mb-1 border-b border-white/[0.08]')}>
                <ReactionPicker
                  onPick={(k) => {
                    onReact(k)
                  }}
                />
              </div>
            )}
            {polls && item('Polls', <Vote className="size-4" />, polls, 'tools-polls', pollsAttention)}
            {whiteboard && item(whiteboard.label, <PenTool className="size-4" />, whiteboard.onClick, 'tools-whiteboard')}
            {effects && item('Background & audio', <Shapes className="size-4" />, effects, 'tools-effects')}
          </div>,
          target,
        )}
    </>
  )
}
