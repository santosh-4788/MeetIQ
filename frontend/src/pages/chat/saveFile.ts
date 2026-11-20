import type { MouseEvent } from 'react'
import { fileUrl } from '../../api/chat'

/**
 * Chat attachment downloads on iPhone / iPad (20 Nov 2026 fix).
 * Safari saves an "attachment" link only in the normal browser; from the Home Screen app (standalone) and some
 * in-app browsers nothing is saved. On iOS we therefore fetch the file ourselves and open the iOS share sheet
 * ("Save to Files", "Open in Excel"...). Everywhere else (computers, Android Chrome, the Android app) the plain
 * link stays: the browser or the app's download manager saves it.
 * The file never leaves the device: fetch → memory → the share sheet the person chooses.
 */
export const isIOS = () =>
  typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

const ready = new Map<string, File>()

async function load(id: string, name: string) {
  const cached = ready.get(id)
  if (cached) return cached
  const res = await fetch(fileUrl(id), { credentials: 'same-origin' })
  if (!res.ok) throw new Error(res.status === 409 ? 'The file is still being checked for viruses. Try again in a moment.' : 'The file could not be downloaded.')
  const blob = await res.blob()
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
  if (file.size <= 50 * 1024 * 1024) ready.set(id, file)
  return file
}

function saveWithLink(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** onClick for a download link. Does nothing (normal link) unless the device is an iPhone/iPad. */
export function iosDownload(id: string, name: string, notify: { success: (t: string) => void; error: (t: string) => void }) {
  return async (e: MouseEvent<HTMLAnchorElement>) => {
    if (!isIOS()) return
    e.preventDefault()
    let file: File
    try {
      file = await load(id, name)
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'The file could not be downloaded.')
      return
    }
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          // A large file took too long, so iOS no longer counts it as a tap. It is ready now: the next tap opens the sheet at once.
          notify.success(`${name} is ready. Tap download again to save or open it.`)
          return
        }
      }
    }
    saveWithLink(file)
  }
}
