import { useEffect, useState } from 'react'
import { meetingsApi, type AvailabilityResult, type Conflict } from '../../api/meetings'
import { errorMessage } from '../../api/types'
import { useDebounced } from '../../lib/useLoader'

export type AvailabilityState = {
  /** The signed-in user's own result (create form only: the API checks "me" when no ids are given). */
  me: AvailabilityResult | null
  /** Result for the listed employees. */
  others: AvailabilityResult | null
  conflicts: Conflict[]
  warnings: Conflict[]
  checking: boolean
  error: string | null
}

const key = (c: Conflict) => `${c.employeeId}|${c.type}|${c.startUtc}|${c.endUtc}`
const dedupe = (xs: Conflict[]) => [...new Map(xs.map((c) => [key(c), c])).values()]

/**
 * Live availability for the schedule / edit form: POST /meetings/availability, debounced, re-run whenever the
 * participants or the time change. Out-of-date responses are ignored.
 */
export function useAvailability({ employeeIds, startUtc, endUtc, includeMe, excludeMeetingId, enabled }: {
  employeeIds: string[]
  startUtc: string | null
  endUtc: string | null
  includeMe: boolean
  excludeMeetingId?: string
  enabled: boolean
}): AvailabilityState {
  const current = JSON.stringify({ ids: [...employeeIds].sort(), startUtc, endUtc, includeMe, excludeMeetingId, enabled })
  const request = useDebounced(current, 500)
  const [state, setState] = useState<AvailabilityState>({ me: null, others: null, conflicts: [], warnings: [], checking: false, error: null })

  useEffect(() => {
    const r = JSON.parse(request) as { ids: string[]; startUtc: string | null; endUtc: string | null; includeMe: boolean; excludeMeetingId?: string; enabled: boolean }
    if (!r.enabled || !r.startUtc || !r.endUtc || (!r.includeMe && r.ids.length === 0)) {
      setState({ me: null, others: null, conflicts: [], warnings: [], checking: false, error: null })
      return
    }
    let alive = true
    setState((s) => ({ ...s, checking: true, error: null }))
    const base = { startUtc: r.startUtc, endUtc: r.endUtc, excludeMeetingId: r.excludeMeetingId }
    Promise.all([
      r.includeMe ? meetingsApi.availability({ ...base, employeeIds: [] }) : Promise.resolve(null),
      r.ids.length ? meetingsApi.availability({ ...base, employeeIds: r.ids }) : Promise.resolve(null),
    ])
      .then(([me, others]) => {
        if (!alive) return
        setState({
          me,
          others,
          conflicts: dedupe([...(me?.conflicts ?? []), ...(others?.conflicts ?? [])]),
          warnings: dedupe([...(me?.warnings ?? []), ...(others?.warnings ?? [])]),
          checking: false,
          error: null,
        })
      })
      .catch((e: unknown) => alive && setState({ me: null, others: null, conflicts: [], warnings: [], checking: false, error: errorMessage(e, 'Availability could not be checked.') }))
    return () => {
      alive = false
    }
  }, [request])

  // While the debounce is pending the shown result is already out of date.
  const active = enabled && !!startUtc && !!endUtc && (includeMe || employeeIds.length > 0)
  return { ...state, checking: state.checking || (active && current !== request) }
}
