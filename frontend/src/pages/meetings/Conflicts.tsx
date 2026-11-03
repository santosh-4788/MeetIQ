import { useEffect, useState } from 'react'
import { CalendarX2, TriangleAlert } from 'lucide-react'
import type { Conflict } from '../../api/meetings'
import { errorMessage, fieldErrors } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Alert, Badge } from '../../components/ui/Feedback'
import { TextAreaField } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { formatRange } from '../../lib/format'
import { conflictLabel } from './meta'

/** Conflicts grouped by person: "Busy in another meeting · Sat, 31 Oct, 2:00 pm – 3:00 pm". No titles or leave reasons (the API never sends them). */
export function ConflictList({ conflicts, tz, nameFor }: { conflicts: Conflict[]; tz: string; nameFor?: (c: Conflict) => string }) {
  const byPerson = new Map<string, Conflict[]>()
  for (const c of conflicts) byPerson.set(c.employeeId, [...(byPerson.get(c.employeeId) ?? []), c])
  return (
    <ul className="flex flex-col gap-2">
      {[...byPerson.entries()].map(([id, list]) => {
        const name = nameFor?.(list[0]) ?? list[0].employeeName
        return (
          <li key={id} className="flex gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
            <Avatar name={list[0].employeeName} size={30} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink">{name}</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {list.map((c, i) => (
                  <li key={i} className="text-[12.5px] text-ink-secondary">
                    <span className={c.type === 'OUTSIDE_WORKING_HOURS' ? 'font-medium text-warning-ink' : 'font-medium text-danger'}>{conflictLabel[c.type] ?? c.type}</span>
                    {c.type !== 'OUTSIDE_WORKING_HOURS' && <> · {formatRange(c.startUtc, c.endUtc, tz)}</>}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Shown when a booking call returns 409 CONFLICT. People with `meetings.override.conflict` may book anyway with a
 * mandatory reason (stored and audited); everyone else changes the time or the participants.
 */
export function ConflictDialog({
  conflicts,
  tz,
  canOverride,
  onClose,
  onOverride,
}: {
  conflicts: Conflict[] | null
  tz: string
  canOverride: boolean
  onClose: () => void
  onOverride: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = !!conflicts

  useEffect(() => {
    if (!open) return
    setReason('')
    setReasonError(undefined)
    setError(null)
  }, [open])

  async function override() {
    if (!reason.trim()) {
      setReasonError('Give a reason for booking despite the conflict.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onOverride(reason.trim())
    } catch (e) {
      setReasonError(fieldErrors(e).overrideReason)
      setError(errorMessage(e, 'The meeting could not be booked.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Participants are not available"
      description="Someone is busy, on leave or has blocked this time."
      size="md"
      dismissible={!busy}
      footer={
        <>
          <Button variant={canOverride ? 'secondary' : 'primary'} onClick={onClose} disabled={busy} data-autofocus>
            Change time or participants
          </Button>
          {canOverride && (
            <Button variant="danger" loading={busy} leftIcon={<TriangleAlert className="size-4" />} onClick={() => void override()}>
              Book anyway
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
            <CalendarX2 className="size-5" />
          </span>
          <p className="text-[13.5px] leading-[22px] text-ink-secondary">
            The meeting was <strong className="text-ink">not saved</strong>. {canOverride ? 'Choose another time, or book anyway with a reason (the override is recorded in the audit log).' : 'Choose another time or change the participants.'}
          </p>
        </div>
        {conflicts && <ConflictList conflicts={conflicts} tz={tz} />}
        {canOverride && (
          <TextAreaField
            label="Reason for overriding the conflict"
            value={reason}
            onChange={(e) => (setReason(e.target.value), setReasonError(undefined))}
            error={reasonError}
            maxLength={500}
            rows={3}
            hint={<>Required. <Badge tone="warning">Audited</Badge></>}
          />
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  )
}
