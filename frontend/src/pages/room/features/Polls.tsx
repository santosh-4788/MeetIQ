import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useRoomContext } from '@livekit/components-react'
import { RoomEvent, type RemoteParticipant } from 'livekit-client'
import { CheckCircle2, LoaderCircle, Lock, Vote } from 'lucide-react'
import type { FeatureCalls, Poll, PollAnswer } from '../../../api/roomFeatures'
import { errorMessage } from '../../../api/types'
import { useToast } from '../../../components/ui/Toast'
import { cn } from '../../../lib/cn'
import { PanelHeader } from '../RoomPanels'

/** Server -> room: { type: 'poll-changed' } (RoomFeatureEndpoints.PollTopic). Only server-sent messages are trusted. */
export const TOPIC_POLL = 'oic.poll'

const SUGGESTIONS = ['Have you understood the policy benefits?', 'Is the premium amount clear?', 'Shall we proceed with the next step?']

/** Polls state for the whole room (also drives the "new poll" badge while the panel is closed). */
export function usePolls(calls: FeatureCalls['polls'] | undefined, enabled: boolean, open: boolean) {
  const room = useRoomContext()
  const [items, setItems] = useState<Poll[]>([])
  const [canCreate, setCanCreate] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seen, setSeen] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!calls || !enabled) return
    calls
      .list()
      .then((r) => {
        setItems(r.items)
        setCanCreate(r.canCreate)
        setError(null)
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Polls could not be loaded.')))
      .finally(() => setLoaded(true))
  }, [calls, enabled])

  useEffect(() => {
    if (!enabled) return
    refresh()
    const onData = (_p: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      // Server messages have no sending participant; anything a participant publishes on this topic is ignored.
      if (topic === TOPIC_POLL && !participant) refresh()
    }
    room.on(RoomEvent.DataReceived, onData)
    // Reconnected after a network drop: catch up on polls started or closed meanwhile.
    room.on(RoomEvent.Reconnected, refresh)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
      room.off(RoomEvent.Reconnected, refresh)
    }
  }, [enabled, refresh, room])

  const openPoll = items.find((p) => !p.closed) ?? null
  useEffect(() => {
    if (open && openPoll) setSeen(openPoll.id)
  }, [open, openPoll])
  // A new open poll this participant has not answered (and has not looked at) - shown as a badge on the toolbar.
  const attention = !!openPoll && !openPoll.myAnswer && !canCreate && seen !== openPoll.id

  return { items, canCreate, loaded, error, refresh, openPoll, attention }
}

export function PollsPanel({
  calls,
  polls,
  onClose,
}: {
  calls: FeatureCalls['polls']
  polls: ReturnType<typeof usePolls>
  onClose: () => void
}) {
  const toast = useToast()
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)

  async function create(e?: FormEvent) {
    e?.preventDefault()
    const q = question.trim()
    if (!q || !calls.create) return
    setBusy(true)
    try {
      await calls.create(q)
      setQuestion('')
      polls.refresh()
    } catch (err) {
      toast.error(errorMessage(err, 'The poll could not be started.'))
    } finally {
      setBusy(false)
    }
  }

  async function close(id: string) {
    if (!calls.close) return
    try {
      await calls.close(id)
      polls.refresh()
    } catch (err) {
      toast.error(errorMessage(err, 'The poll could not be closed.'))
    }
  }

  async function vote(id: string, answer: PollAnswer) {
    try {
      await calls.vote(id, answer)
      polls.refresh()
    } catch (err) {
      toast.error(errorMessage(err, 'Your answer could not be saved.'))
      polls.refresh()
    }
  }

  return (
    <>
      <PanelHeader title="Polls" subtitle={polls.canCreate ? 'Ask a quick Yes/No question.' : 'Answer the host’s questions.'} onClose={onClose} />
      <div className="oic-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" data-testid="polls-panel">
        {polls.canCreate && !polls.openPoll && (
          <form onSubmit={create} className="flex flex-col gap-2 rounded-xl bg-white/[0.05] p-3">
            <label htmlFor="oic-poll-q" className="text-[12.5px] font-semibold text-white/80">New Yes/No question</label>
            <textarea
              id="oic-poll-q"
              className="oic-input min-h-[60px] resize-none"
              maxLength={300}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. Have you understood the policy benefits?"
              data-testid="poll-question"
            />
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => setQuestion(s)} className="rounded-full bg-white/[0.08] px-2.5 py-1 text-[11.5px] text-white/75 hover:bg-white/[0.14]">
                  {s}
                </button>
              ))}
            </div>
            <button type="submit" disabled={busy || !question.trim()} className="mt-1 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-brand-500 px-3 text-[13px] font-semibold text-white hover:bg-brand-600 disabled:opacity-50" data-testid="poll-start">
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Vote className="size-4" />} Start poll
            </button>
            <p className="text-[11.5px] leading-4 text-white/50">Results are for discussion only. A poll answer is never treated as a customer decision or a policy approval.</p>
          </form>
        )}
        {!polls.loaded && <p className="m-auto text-[13px] text-white/50">Loading…</p>}
        {polls.error && <p className="rounded-md bg-white/5 px-3 py-2 text-[12px] text-white/60">{polls.error}</p>}
        {polls.loaded && polls.items.length === 0 && !polls.canCreate && <p className="m-auto text-center text-[13px] text-white/50">No polls yet.</p>}
        {polls.items.map((p) => (
          <PollCard key={p.id} poll={p} host={polls.canCreate} onVote={vote} onClose={close} />
        ))}
      </div>
    </>
  )
}

function PollCard({ poll, host, onVote, onClose }: { poll: Poll; host: boolean; onVote: (id: string, a: PollAnswer) => void; onClose: (id: string) => void }) {
  const r = poll.results
  const pct = (n: number) => (r && r.total ? Math.round((n / r.total) * 100) : 0)
  return (
    <article className={cn('flex flex-col gap-3 rounded-xl p-3', poll.closed ? 'bg-white/[0.03]' : 'bg-white/[0.07] ring-1 ring-cyan-400/30')} data-testid="poll-card">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13.5px] font-semibold leading-5">{poll.question}</p>
        {poll.closed && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/65">
            <Lock className="size-3" aria-hidden /> Closed
          </span>
        )}
      </div>
      {!poll.closed && !host && !poll.myAnswer && (
        <div className="grid grid-cols-2 gap-2">
          {(['YES', 'NO'] as const).map((a) => (
            <button key={a} type="button" onClick={() => onVote(poll.id, a)} className="h-10 rounded-lg bg-white/[0.1] text-[14px] font-semibold hover:bg-white/[0.18]" data-testid={`poll-vote-${a.toLowerCase()}`}>
              {a === 'YES' ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      )}
      {poll.myAnswer && (
        <p className="inline-flex items-center gap-1.5 text-[12.5px] text-emerald-300" data-testid="poll-my-answer">
          <CheckCircle2 className="size-4" aria-hidden /> You answered {poll.myAnswer === 'YES' ? 'Yes' : 'No'}
        </p>
      )}
      {r && (
        <div className="flex flex-col gap-1.5" data-testid="poll-results">
          {([['Yes', r.yes], ['No', r.no]] as const).map(([label, n]) => (
            <div key={label} className="flex items-center gap-2 text-[12.5px]">
              <span className="w-8 text-white/70">{label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className={cn('h-full rounded-full', label === 'Yes' ? 'bg-emerald-400' : 'bg-rose-400')} style={{ width: `${pct(n)}%` }} />
              </div>
              <span className="w-14 text-right tabular-nums text-white/80">{n} · {pct(n)}%</span>
            </div>
          ))}
          <span className="text-[11.5px] text-white/50">{r.total} answer{r.total === 1 ? '' : 's'}{!poll.closed && host ? ' · live' : ''}</span>
        </div>
      )}
      {!poll.closed && !host && poll.myAnswer && <p className="text-[11.5px] text-white/50">Results are shown when the host closes the poll.</p>}
      {host && !poll.closed && (
        <button type="button" onClick={() => onClose(poll.id)} className="h-9 rounded-lg bg-white/[0.1] text-[13px] font-semibold hover:bg-white/[0.18]" data-testid="poll-close">
          Close poll and show results
        </button>
      )}
    </article>
  )
}
