import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn, Video } from 'lucide-react'
import { http } from '../../api/http'
import { meetingsApi, type DbMeetingCategory, type RecordingPolicy } from '../../api/meetings'
import { errorMessage } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SelectField, Switch } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { dbCategoryLabel, INTERNAL_CATEGORIES, recordingLabel } from './meta'

/** Passed to the room page (router state): pre-join defaults and "show the invite link" for a meeting just started. */
export type RoomEntryState = { video?: boolean; invite?: boolean }

type RecordingOption = { category: string; policyTitle: string; enabled: boolean }

const LENGTHS = [15, 30, 45, 60, 90, 120]

/** "New meeting": starts an instant meeting (no calendar, no e-mails) and opens the pre-join screen. */
export function NewMeetingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<DbMeetingCategory>('GROUP')
  const [minutes, setMinutes] = useState(60)
  const [video, setVideo] = useState(true)
  const [audioOnly, setAudioOnly] = useState(false)
  const [waitingRoom, setWaitingRoom] = useState(true)
  const [recording, setRecording] = useState<RecordingPolicy>('NONE')
  const [options, setOptions] = useState<RecordingOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    let alive = true
    http<RecordingOption[]>('/meetings/recording-options').then((o) => alive && setOptions(o)).catch(() => alive && setOptions([]))
    return () => {
      alive = false
    }
  }, [open])

  const option = options?.find((o) => o.category === category)
  const recordingOff = !option?.enabled
  useEffect(() => {
    if (recordingOff) setRecording('NONE')
  }, [recordingOff])

  async function start(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await meetingsApi.instant({ title: title.trim() || undefined, category, durationMinutes: minutes, audioOnly, waitingRoomEnabled: waitingRoom, recordingPolicy: recording })
      const state: RoomEntryState = { video: video && !audioOnly, invite: true }
      navigate(`/meetings/${r.id}/room`, { state })
    } catch (err) {
      setError(errorMessage(err, 'The meeting could not be started.'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Start a meeting now"
      description="No scheduling needed. You get a link to share; everyone who uses it waits until you let them in."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="new-meeting" loading={busy} leftIcon={<Video className="size-4" />} data-testid="start-instant">Start meeting</Button>
        </>
      }
    >
      <form id="new-meeting" onSubmit={start} className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <TextField label="Title (optional)" value={title} maxLength={200} placeholder={`${user?.displayName ?? 'My'}'s meeting`} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Type" value={category} onChange={(e) => setCategory(e.target.value as DbMeetingCategory)}>
            {INTERNAL_CATEGORIES.map((c) => <option key={c} value={c}>{dbCategoryLabel[c]}</option>)}
          </SelectField>
          <SelectField label="Length" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} hint="You can end it earlier.">
            {LENGTHS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
          </SelectField>
        </div>
        <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-muted p-3.5">
          <Switch checked={video && !audioOnly} disabled={audioOnly} onChange={setVideo} label="Start with my camera on" />
          <Switch checked={audioOnly} onChange={setAudioOnly} label="Audio-only meeting (nobody can turn on a camera)" />
          <Switch checked={waitingRoom} onChange={setWaitingRoom} label="Waiting room for invited colleagues too" />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-semibold text-ink">Recording</legend>
          <div className="flex flex-wrap gap-4">
            {(['NONE', 'OPTIONAL', 'REQUIRED'] as RecordingPolicy[]).map((p) => (
              <label key={p} className="inline-flex items-center gap-2 text-[13px] text-ink-secondary">
                <input type="radio" name="instant-recording" value={p} checked={recording === p} disabled={p !== 'NONE' && recordingOff} onChange={() => setRecording(p)} />
                {recordingLabel[p]}
              </label>
            ))}
          </div>
          <p className="text-[12px] text-ink-secondary">
            {options === null ? 'Checking the recording policy…'
              : recordingOff ? `Recording is switched off for this meeting type${option ? ` ("${option.policyTitle}")` : ''}. An administrator can turn it on in Administration → Recording policies.`
              : `Recording follows the "${option!.policyTitle}" policy.`}
          </p>
        </fieldset>
      </form>
    </Dialog>
  )
}

/** Where a pasted link or typed code leads (null = treat as a meeting code). */
export function routeForJoinInput(raw: string): string | null {
  const text = raw.trim()
  const m = /\/(m|join)\/([A-Za-z0-9_-]{16,200})/.exec(text)
  if (m) return `/${m[1]}/${m[2]}`
  const id = /\/meetings\/([0-9a-fA-F-]{36})/.exec(text)
  if (id) return `/meetings/${id[1]}/room`
  return null
}

/** "Join meeting": paste a link or type a meeting code (codes open only meetings you can already see). */
export function JoinMeetingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  async function join(e: FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if (!text) {
      setError('Paste the meeting link or type the meeting code.')
      return
    }
    const route = routeForJoinInput(text)
    if (route) {
      navigate(route)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await meetingsApi.byCode(text.replace(/\s+/g, ''))
      navigate(`/meetings/${r.id}/room`)
    } catch (err) {
      setError(errorMessage(err, 'No meeting was found for this code.'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Join a meeting"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="join-meeting" loading={busy} leftIcon={<LogIn className="size-4" />}>Join</Button>
        </>
      }
    >
      <form id="join-meeting" onSubmit={join} className="flex flex-col gap-3">
        <TextField
          label="Meeting link or code"
          value={value}
          autoFocus
          placeholder="https://…/m/…  or  OIC-261102-AB12"
          onChange={(e) => setValue(e.target.value)}
          error={error ?? undefined}
          data-testid="join-input"
        />
        <p className="text-[12px] text-ink-secondary">A code opens meetings you are invited to. For other meetings, use the link the host shared.</p>
      </form>
    </Dialog>
  )
}
