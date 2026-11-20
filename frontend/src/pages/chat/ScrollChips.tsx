import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'

/**
 * One line of filter chips that scrolls sideways (swipe, trackpad, mouse wheel, or the ‹ › buttons). The buttons and a
 * soft fade appear only on the side where more chips are hidden, so nothing looks cut off by mistake.
 */
export function ScrollChips({ children, label, className, testId }: { children: ReactNode; label: string; className?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 })
  }, [])
  useEffect(() => {
    measure()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const c of Array.from(el.children)) ro.observe(c)
    // A vertical mouse wheel scrolls the chips sideways (computers without a trackpad).
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [measure, children])
  const by = (dx: number) => ref.current?.scrollBy({ left: dx, behavior: 'smooth' })
  const fade = edges.left && edges.right
    ? 'linear-gradient(to right, transparent 0, #000 36px, #000 calc(100% - 36px), transparent 100%)'
    : edges.right
      ? 'linear-gradient(to right, #000 calc(100% - 36px), transparent 100%)'
      : edges.left
        ? 'linear-gradient(to right, transparent 0, #000 36px)'
        : undefined
  return (
    <div className={cn('relative', className)}>
      <div
        ref={ref}
        onScroll={measure}
        role="tablist"
        aria-label={label}
        className="scrollbar-none flex gap-1.5 overflow-x-auto scroll-smooth py-0.5"
        style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
        data-testid={testId}
      >
        {children}
      </div>
      {edges.left && (
        <button type="button" onClick={() => by(-180)} aria-label="Show previous filters" className="absolute top-1/2 left-0 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[var(--ios-blue)] shadow-[0_1px_4px_rgb(0_0_0/0.2)] active:scale-95" data-testid="chips-prev">
          <ChevronLeft className="size-4" strokeWidth={2.5} />
        </button>
      )}
      {edges.right && (
        <button type="button" onClick={() => by(180)} aria-label="Show more filters" className="absolute top-1/2 right-0 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[var(--ios-blue)] shadow-[0_1px_4px_rgb(0_0_0/0.2)] active:scale-95" data-testid="chips-next">
          <ChevronRight className="size-4" strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
