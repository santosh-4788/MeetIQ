// JS mirror of src/styles/theme.css for places CSS variables can't reach (charts, motion).
// Keep both files in sync.

export const colors = {
  navy900: '#102A43',
  brand700: '#2463D3',
  brand500: '#3B82F6',
  brand400: '#6FA8F0',
  brand200: '#B5D1F8',
  cyan400: '#22D3EE',
  teal500: '#14B8A6',
  canvas: '#F4F7FB',
  line: '#E3E9F2',
  ink: '#172B4D',
  inkSecondary: '#64748B',
  inkMuted: '#94A3B8',
  success: '#16B879',
  warning: '#F5A623',
  danger: '#F04452',
  info: '#3B82F6',
} as const

export const meetingCategoryColors = {
  internal: '#3B82F6',
  customer: '#14B8A6',
  training: '#7C3AED',
  review: '#F5A623',
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
