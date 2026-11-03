// Demo mode can never be on in a production build, whatever the env file says.
export const DEMO_MODE = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true'

export const APP_NAME = 'OneInsure Connect'
export const APP_TAGLINE = 'Connect. Collaborate. Grow.'
export const APP_VERSION = '0.7.0'
export const API_BASE = '/api/v1'

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata'

// Client-side idle limit; the server enforces its own session expiry independently.
export const SESSION_IDLE_MINUTES = 30

export const SUPPORT = {
  email: 'it.support@oneinsure.com',
  hours: 'Mon–Sat, 9:30 AM – 6:30 PM IST',
} as const
