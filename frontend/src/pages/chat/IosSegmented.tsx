import { useId } from 'react'
import { MotionConfig, motion } from 'motion/react'

/** iOS segmented control with the sliding white thumb (motion layout animation; still when "reduce motion" is on). */
export function IosSegmented<T extends string>({
  value, options, onChange, label, testIdPrefix,
}: {
  value: T
  options: { key: T; label: string }[]
  onChange: (v: T) => void
  label: string
  testIdPrefix?: string
}) {
  const id = useId()
  return (
    <MotionConfig reducedMotion="user">
      <div className="ios-seg" role="tablist" aria-label={label}>
        {options.map((o) => {
          const on = value === o.key
          return (
            <button key={o.key} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.key)} data-testid={testIdPrefix ? testIdPrefix + o.key : undefined}>
              {on && <motion.span layoutId={`seg-${id}`} className="ios-seg-thumb" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              <span className="relative">{o.label}</span>
            </button>
          )
        })}
      </div>
    </MotionConfig>
  )
}
