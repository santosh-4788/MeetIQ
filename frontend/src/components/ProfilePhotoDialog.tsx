import { useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus, Trash2 } from 'lucide-react'
import { errorMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { PHOTO_MAX_MB, PHOTO_TYPES, preparePhoto, removeMyPhoto, uploadMyPhoto, usePhoto } from '../lib/photos'
import { Avatar } from './ui/Avatar'
import { Button } from './ui/Button'
import { Dialog } from './ui/Overlay'
import { useToast } from './ui/Toast'

/**
 * Change my own profile picture (24 Nov 2026): choose a JPG, PNG or WEBP picture, see the round preview (the middle square,
 * shrunk to 256 px in the browser), save it; or remove the current one. Everyone online sees the new picture at once.
 */
export function ProfilePhotoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const toast = useToast()
  const current = usePhoto(user?.id)
  const input = useRef<HTMLInputElement>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (open) return
    setBlob(null)
    setError(null)
    setProgress(0)
  }, [open])
  useEffect(() => {
    if (!blob) return setPreview(null)
    const u = URL.createObjectURL(blob)
    setPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])

  if (!user) return null

  const pick = async (f: File | undefined) => {
    setError(null)
    if (!f) return
    if (!PHOTO_TYPES.includes(f.type)) return setError('Use a JPG, PNG or WEBP picture.')
    if (f.size > PHOTO_MAX_MB * 1024 * 1024) return setError(`The picture is too large (${PHOTO_MAX_MB} MB at most).`)
    try {
      setBlob(await preparePhoto(f))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This picture could not be read.')
    }
  }
  const save = async () => {
    if (!blob) return
    setBusy(true)
    try {
      await uploadMyPhoto(blob, setProgress)
      toast.success('Profile picture updated')
      onClose()
    } catch (e) {
      setError(errorMessage(e, 'The picture could not be saved. Try again.'))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      await removeMyPhoto(user.id)
      toast.success('Profile picture removed')
      onClose()
    } catch (e) {
      setError(errorMessage(e, 'The picture could not be removed. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Profile picture"
      description="Colleagues see it in chat, calls, meetings and lists."
      size="sm"
      dismissible={!busy}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          {current && !blob ? (
            <Button variant="secondary" onClick={() => void remove()} disabled={busy} data-testid="photo-remove">
              <Trash2 className="size-4" /> Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button onClick={() => void save()} disabled={!blob || busy} loading={busy && !!blob} data-testid="photo-save">Save</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4 py-2" data-testid="photo-dialog">
        <button type="button" onClick={() => input.current?.click()} className="group relative rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500" aria-label="Choose a picture" disabled={busy}>
          {preview ? (
            <img src={preview} alt="New profile picture" className="size-[132px] rounded-full object-cover shadow-md ring-4 ring-brand-100" data-testid="photo-preview" />
          ) : (
            <Avatar name={user.displayName} userId={user.id} size={132} className="shadow-md ring-4 ring-brand-100" />
          )}
          <span className="absolute right-1 bottom-1 flex size-9 items-center justify-center rounded-full bg-brand-500 text-white shadow ring-2 ring-white group-hover:bg-brand-600">
            <Camera className="size-[18px]" />
          </span>
        </button>
        <input ref={input} type="file" accept={PHOTO_TYPES.join(',')} className="hidden" onChange={(e) => (void pick(e.target.files?.[0]), (e.target.value = ''))} data-testid="photo-input" />
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={busy} data-testid="photo-choose">
          <ImagePlus className="size-4" /> {current || blob ? 'Choose another picture' : 'Choose a picture'}
        </Button>
        <p className="text-center text-[12.5px] text-ink-muted">JPG, PNG or WEBP, up to {PHOTO_MAX_MB} MB. The middle square is used and made small, so it loads fast.</p>
        {busy && blob && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${Math.max(5, progress * 100)}%` }} />
          </div>
        )}
        {error && <p className="w-full rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert" data-testid="photo-error">{error}</p>}
      </div>
    </Dialog>
  )
}
