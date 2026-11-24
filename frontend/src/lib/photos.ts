import { useSyncExternalStore } from 'react'
import { API_BASE } from '../config'
import { http } from '../api/http'
import { uploadFile } from '../api/chat'

// Profile pictures (24 Nov 2026): one small list of who has a picture (user id -> version), loaded once per tab and kept
// fresh by the "photo.changed" push, so every avatar that knows a person's user id OR employee id can show the picture.

type Entry = { uid: string; emp: string | null; v: string }
const versions = new Map<string, Entry>() // key: user id and employee id (lower case)
const listeners = new Set<() => void>()
let tick = 0
let loading: Promise<void> | null = null
// Live changes, kept briefly: a list answer that was asked for before a change arrived must not undo it.
const recent: { id: string; emp: string | null | undefined; v: string | null; at: number }[] = []

const emit = () => {
  tick++
  listeners.forEach((l) => l())
}

export function loadPhotos(force = false) {
  if (loading && !force) return loading
  const asked = Date.now()
  loading = http<{ id: string; emp: string | null; v: string }[]>('/people/photos').then(
    (rows) => {
      versions.clear()
      for (const r of rows) put(r.id, r.emp, r.v)
      for (const c of recent) if (c.at >= asked) apply(c.id, c.emp, c.v)
      emit()
    },
    () => {
      loading = null // try again next time
    },
  )
  return loading
}

function put(id: string, emp: string | null | undefined, v: string) {
  const e: Entry = { uid: id, emp: emp ?? null, v }
  versions.set(id.toLowerCase(), e)
  if (emp) versions.set(emp.toLowerCase(), e)
}

/** A push or my own upload: one person's picture changed (v = null: removed). */
export function setPhoto(id: string, emp: string | null | undefined, v: string | null) {
  recent.push({ id, emp, v, at: Date.now() })
  if (recent.length > 50) recent.shift()
  apply(id, emp, v)
  emit()
}

function apply(id: string, emp: string | null | undefined, v: string | null) {
  const old = versions.get(id.toLowerCase())
  versions.delete(id.toLowerCase())
  if (old?.emp) versions.delete(old.emp.toLowerCase())
  if (emp) versions.delete(emp.toLowerCase())
  if (v) put(id, emp ?? old?.emp, v)
}

export function photoUrl(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  const e = versions.get(id.toLowerCase())
  return e ? `${API_BASE}/people/${e.uid}/photo?v=${e.v}` : undefined
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Re-renders when any picture changes; returns the picture address for this person (or undefined). */
export function usePhoto(id: string | null | undefined) {
  useSyncExternalStore(subscribe, () => tick)
  return photoUrl(id)
}

/** Crops the middle square and shrinks it to 256 px (JPEG): small, and without the camera's hidden data (location etc.). */
export async function preparePhoto(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('This picture could not be read. Use a JPG, PNG or WEBP picture.'))
      i.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const size = Math.min(256, side)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot prepare the picture.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be prepared.'))), 'image/jpeg', 0.88))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const PHOTO_MAX_MB = 10 // before shrinking; the server accepts at most 2 MB after it

export async function uploadMyPhoto(blob: Blob, onProgress?: (f: number) => void) {
  const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })
  const r = (await uploadFile('/account/photo', file, {}, onProgress)) as unknown as { id: string; emp: string; v: string }
  setPhoto(r.id, r.emp, r.v)
  return r
}

export async function removeMyPhoto(myId: string) {
  await http<void>('/account/photo', { method: 'DELETE' })
  setPhoto(myId, null, null)
}
