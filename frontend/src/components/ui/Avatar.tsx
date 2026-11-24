import { useState } from 'react'
import { cn } from '../../lib/cn'
import { usePhoto } from '../../lib/photos'

const palette = ['#2878E5', '#0EA5A4', '#7C3AED', '#1769AA', '#DB2777', '#EA580C', '#16A34A', '#102A43']

export function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

function colorFor(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

/**
 * Initials in a colour, or a picture. userId (24 Nov 2026): the person's profile picture when they have one (lib/photos);
 * a picture that fails to load falls back to the initials.
 */
export function Avatar({ name, src, userId, size = 32, className, ring }: { name: string; src?: string; userId?: string | null; size?: number; className?: string; ring?: boolean }) {
  const photo = usePhoto(userId)
  const [broken, setBroken] = useState<string | null>(null)
  const shown = src ?? photo
  const img = shown && broken !== shown ? shown : undefined
  return (
    <span
      title={name}
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white', ring && 'ring-2 ring-surface', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: img ? '#e5e7eb' : colorFor(name) }}
      data-photo={img ? 'yes' : undefined}
    >
      {img ? <img src={img} alt="" className="size-full object-cover" onError={() => setBroken(img)} draggable={false} /> : initials(name)}
    </span>
  )
}

export function AvatarStack({ names, max = 4, size = 28 }: { names: string[]; max?: number; size?: number }) {
  const shown = names.slice(0, max)
  const rest = names.length - shown.length
  return (
    <span className="flex -space-x-2">
      {shown.map((n) => (
        <Avatar key={n} name={n} size={size} ring />
      ))}
      {rest > 0 && (
        <span
          className="inline-flex items-center justify-center rounded-full bg-canvas text-[11px] font-semibold text-ink-secondary ring-2 ring-surface"
          style={{ width: size, height: size }}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}
