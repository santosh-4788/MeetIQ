import { useEffect, useState } from 'react'
import { UserMinus, Users } from 'lucide-react'
import { orgApi, type Team, type TeamMember } from '../../api/org'
import { EmployeePicker } from '../../components/EmployeePicker'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { Alert, Badge, EmptyState, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { useLoader } from '../../lib/useLoader'

/** Edits a team's members locally, then saves the whole list (PUT /org/teams/{code}/members; the server keeps history). */
export function TeamMembersDialog({ team, onClose }: { team: Team | null; onClose: (saved: boolean) => void }) {
  const toast = useToast()
  const { data, error, loading, reload } = useLoader<TeamMember[] | null>(
    () => (team ? orgApi.teamMembers(team.code) : Promise.resolve(null)),
    [team?.code],
    'Unable to load the team members.',
  )
  const [members, setMembers] = useState<TeamMember[]>([])
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (data) setMembers(data)
    setSaveError(null)
  }, [data])

  const original = new Set((data ?? []).map((m) => m.id))
  const dirty = members.length !== original.size || members.some((m) => !original.has(m.id))

  async function save() {
    if (!team) return
    setBusy(true)
    setSaveError(null)
    try {
      await orgApi.setTeamMembers(team.code, members.map((m) => m.id))
      toast.success(`Members of ${team.name} saved.`)
      onClose(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'The members could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!team}
      onClose={() => onClose(false)}
      variant="drawer"
      title={team ? `${team.name}: members` : 'Team members'}
      description={team ? `${team.departmentName}${team.teamLeaderName ? ` · Leader: ${team.teamLeaderName}` : ''}` : undefined}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} loading={busy} disabled={!dirty || !data}>Save members</Button>
        </>
      }
    >
      {error ? (
        <ErrorState title="Unable to load members" description={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {saveError && <Alert tone="danger">{saveError}</Alert>}
          <EmployeePicker
            label="Add member"
            clearOnSelect
            excludeIds={members.map((m) => m.id)}
            onChange={(_, full) =>
              full && setMembers((ms) => [...ms, { id: full.id, employeeCode: full.employeeCode, displayName: full.displayName, designation: full.designation }])
            }
          />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-semibold text-ink">
                Members <span className="font-medium text-ink-secondary tabular-nums">({members.length})</span>
              </p>
              {dirty && <Badge tone="warning" dot>Unsaved changes</Badge>}
            </div>
            {members.length === 0 ? (
              <div className="rounded-md border border-dashed border-line-strong">
                <EmptyState icon={<Users className="size-6" />} title="No members" description="Search for employees above to add them to this team." />
              </div>
            ) : (
              <ul className="flex flex-col rounded-md border border-line">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
                    <Avatar name={m.displayName} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold text-ink">
                        {m.displayName}
                        {!original.has(m.id) && <Badge tone="success" className="ml-2 align-middle">New</Badge>}
                      </p>
                      <p className="truncate text-[12px] text-ink-secondary">{m.employeeCode} · {m.designation}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:bg-danger-soft hover:text-danger"
                      leftIcon={<UserMinus className="size-3.5" />}
                      onClick={() => setMembers((ms) => ms.filter((x) => x.id !== m.id))}
                      aria-label={`Remove ${m.displayName}`}
                    >
                      <span className="hidden sm:inline">Remove</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  )
}
