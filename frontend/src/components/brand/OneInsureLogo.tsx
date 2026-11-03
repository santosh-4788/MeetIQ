import { cn } from '../../lib/cn'

/** Official OneInsure corporate logo (parent brand, from oneinsure.com). Do not recolour or crop. */
export function OneInsureLogo({ height = 24, className }: { height?: number; className?: string }) {
  return (
    <img
      src="/brand/oneinsure-logo.png"
      alt="OneInsure"
      height={height}
      style={{ height, width: 'auto' }}
      className={cn('select-none', className)}
      draggable={false}
    />
  )
}

/** "A OneInsure platform" lock-up used on the login panel and sidebar footer. */
export function ParentBrand({ tone = 'light', compact = false }: { tone?: 'light' | 'dark'; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      {!compact && (
        <span className={cn('text-[11px] font-medium', tone === 'light' ? 'text-white/55' : 'text-ink-muted')}>A platform by</span>
      )}
      <OneInsureLogo height={compact ? 18 : 22} />
    </span>
  )
}
