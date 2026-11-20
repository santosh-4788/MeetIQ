// The Android app's page bridge (window.OicAndroid), without any meeting-room code: safe to import from any page.
// (20 Nov 2026: split out of androidApp.ts so the public download page no longer pulls the video library into the main bundle.)

export type Bridge = {
  postMessage: (data: string) => void
  addEventListener?: (type: 'message', fn: (e: { data: string }) => void) => void
  onmessage?: ((e: { data: string }) => void) | null
}

export const bridge = (): Bridge | null => {
  if (typeof window === 'undefined') return null
  const b = (window as unknown as { OicAndroid?: Bridge }).OicAndroid
  return b && typeof b.postMessage === 'function' ? b : null
}

/** True inside the OneInsure Connect Android app. */
export const inAndroidApp = () => bridge() !== null
