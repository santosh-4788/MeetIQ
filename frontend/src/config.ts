// Demo mode can never be on in a production build, whatever the env file says.
export const DEMO_MODE = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true'

export const APP_NAME = 'OneInsure Connect'
export const APP_TAGLINE = 'Connect. Collaborate. Grow.'
export const APP_VERSION = '0.7.0'
// import.meta.env.BASE_URL follows vite.config.ts's `base` ('/meet/' in production, '/' in dev).
export const API_BASE = `${import.meta.env.BASE_URL}api/v1`

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata'


export const SUPPORT = {
  email: 'support@oneinsure.com',
  hours: 'Mon–Sat, 9:30 AM – 6:30 PM IST',
} as const
