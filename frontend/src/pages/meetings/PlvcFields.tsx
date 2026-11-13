import { Plus, X } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/Field'

/** One participant row: name and e-mail entered separately (Customer – PLVC meetings, 12 Nov 2026). */
export type ParticipantRow = { key: number; name: string; email: string }

export const MAX_PARTICIPANTS = 20
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const PRARAMBH_RE = /^[0-9]{1,30}$/

export const newParticipant = (key: number): ParticipantRow => ({ key, name: '', email: '' })

/**
 * Client-side checks mirroring the API (Plvc.cs): Prarambh Main ID required, digits only; at least one participant;
 * name and a valid e-mail on every row; no e-mail twice. Returns field → message (empty = valid).
 */
export function validatePlvc(prarambh: string, rows: ParticipantRow[]): Record<string, string> {
  const errors: Record<string, string> = {}
  const id = prarambh.trim()
  if (!id) errors.prarambhMainId = 'Prarambh Main ID is required for a Customer – PLVC meeting.'
  else if (!PRARAMBH_RE.test(id)) errors.prarambhMainId = 'Prarambh Main ID must contain digits only (0–9), at most 30 digits.'
  const filled = rows.filter((r) => r.name.trim() || r.email.trim())
  if (filled.length === 0) errors.participants = 'Add at least one participant (name and e-mail).'
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    if (!r.name.trim() && !r.email.trim() && rows.length > 1) return // an empty extra row is ignored
    if (!r.name.trim()) errors[`participants[${i}].name`] = 'Enter the participant name.'
    const email = r.email.trim().toLowerCase()
    if (!email) errors[`participants[${i}].email`] = 'Enter the e-mail address.'
    else if (!EMAIL_RE.test(email)) errors[`participants[${i}].email`] = 'Enter a valid e-mail address.'
    else if (seen.has(email)) errors[`participants[${i}].email`] = 'This participant is listed twice.'
    else seen.add(email)
  })
  return errors
}

/** Rows to send: trimmed, empty extra rows dropped. */
export const participantsPayload = (rows: ParticipantRow[]) =>
  rows.filter((r) => r.name.trim() || r.email.trim()).map((r) => ({ name: r.name.trim(), email: r.email.trim() }))

/** Prarambh Main ID box - only rendered for Customer – PLVC. Digits only (non-digits are stripped as you type). */
export function PrarambhField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <TextField
      label="Prarambh Main ID"
      aria-required="true"
      inputMode="numeric"
      autoComplete="off"
      maxLength={30}
      value={value}
      placeholder="e.g. 123456789"
      onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      error={error}
      hint={error ? undefined : 'Digits only. Used to identify this PLVC meeting and its recording.'}
      className="sm:max-w-[260px]"
      data-testid="prarambh-main-id"
    />
  )
}

/**
 * "Participants" for Customer – PLVC (replaces "Add customer"): name + e-mail rows with add (+) and remove (×), like
 * "Add guest". The first participant becomes the meeting's customer record (reused if that e-mail already exists).
 */
export function ParticipantRows({ rows, onChange, errors, nextKey, hint }: {
  rows: ParticipantRow[]
  onChange: (rows: ParticipantRow[]) => void
  errors: Record<string, string | undefined>
  nextKey: () => number
  hint?: string
}) {
  const update = (key: number, k: 'name' | 'email', v: string) => onChange(rows.map((x) => (x.key === key ? { ...x, [k]: v } : x)))
  return (
    <div className="flex flex-col gap-2" data-testid="plvc-participants">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink">Participants</p>
        <Button size="sm" variant="subtle" leftIcon={<Plus className="size-3.5" />} disabled={rows.length >= MAX_PARTICIPANTS}
          onClick={() => onChange([...rows, newParticipant(nextKey())])} data-testid="participant-add">
          Add participant
        </Button>
      </div>
      {errors.participants && <p role="alert" className="text-[12.5px] font-medium text-danger">{errors.participants}</p>}
      <ul className="flex flex-col gap-2.5">
        {rows.map((r, i) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-line p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:border-0 sm:p-0" data-testid="participant-row">
            <div className="col-span-1 grid grid-cols-1 gap-2 sm:col-span-2 sm:grid-cols-2">
              <TextField label={i === 0 ? 'Participant / customer name' : `Participant ${i + 1} name`} value={r.name} maxLength={200} autoComplete="off"
                onChange={(e) => update(r.key, 'name', e.target.value)} error={errors[`participants[${i}].name`]} data-testid="participant-name" />
              <TextField label="E-mail ID" type="email" value={r.email} autoComplete="off" inputMode="email"
                onChange={(e) => update(r.key, 'email', e.target.value)} error={errors[`participants[${i}].email`]} data-testid="participant-email" />
            </div>
            <Button variant="ghost" className="mt-[26px]" aria-label={`Remove participant ${i + 1}`} disabled={rows.length === 1}
              leftIcon={<X className="size-4" />} onClick={() => onChange(rows.filter((x) => x.key !== r.key))} data-testid="participant-remove" />
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-secondary">{hint ?? 'The first participant is the customer. Everyone gets a personal join link.'}</p>
    </div>
  )
}
