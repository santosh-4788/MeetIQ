// JS mirror of src/styles/theme.css for places CSS variables can't reach (charts, motion).
// Keep both files in sync.

export const colors = {
  navy900: '#102A43',
  brand700: '#1769AA',
  brand500: '#2878E5',
  brand200: '#B5D1F8',
  cyan400: '#20C4D8',
  canvas: '#F4F7FB',
  line: '#E3E9F2',
  ink: '#172B4D',
  inkSecondary: '#64748B',
  inkMuted: '#94A3B8',
  success: '#16A34A',
  warning: '#F59E0B',
  danger: '#DC2626',
  info: '#0284C7',
} as const

export const meetingCategoryColors = {
  internal: '#2878E5',
  customer: '#0EA5A4',
  training: '#7C3AED',
  review: '#F59E0B',
  management: '#102A43',
} as const

export const motionTokens = {
  fast: 0.15,
  base: 0.22,
  slow: 0.4,
  easeOut: [0.22, 1, 0.36, 1] as [number, number, number, number],
  stagger: 0.04,
} as const

export const chartTheme = {
  grid: colors.line,
  axis: colors.inkMuted,
  tooltipBorder: colors.line,
  fontSize: 12,
} as const
