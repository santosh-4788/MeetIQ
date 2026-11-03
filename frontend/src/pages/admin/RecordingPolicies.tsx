import { useEffect, useState } from 'react'
import { CircleCheck, CircleX, Clapperboard, HeartPulse, Pencil, RotateCw, ShieldAlert } from 'lucide-react'
import {
  approvalLabel, recordingAdminApi, type ApprovalStatus, type ConsentMode, type ExpiryAction, type PolicyInput, type RecordingPolicy, type Requirement,
} from '../../api/recordings'
import { errorMessage, fieldErrors } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Alert, Badge, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { Checkbox, TextField } from '../../components/ui/Field'
import { SelectField, Switch, TextAreaField } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { formatDateTime } from '../../lib/format'
import { useLoader } from '../../lib/useLoader'
import { dbCategoryLabel, isCustomerCategory } from '../meetings/meta'
import type { DbMeetingCategory } from '../../api/meetings'

const requirementLabel: Record<Requirement, string> = { DISABLED: 'Disabled', OPTIONAL: 'Optional (host starts it)', MANDATORY: 'Mandatory (starts automatically)' }
const expiryLabel: Record<ExpiryAction, string> = { REVIEW_ONLY: 'Review only (flag for review)', ARCHIVE: 'Archive (move to archive location)', DELETE: 'Delete (file deleted, record kept)' }

/**
 * Administration → Recording policies. Four separate policies; every legal/compliance value is entered here (nothing is invented by the
 * software). A policy that is not confirmed (status pending, or no policy reference) carries a "Not confirmed" banner.
 */
export function RecordingPoliciesCard() {
  const { can } = useAuth()
  const canEdit = can('recordings.policy.manage')
  const toast = useToast()
  const data = useLoader(() => recordingAdminApi.policies(), [], 'Unable to load the recording policies.')
  const [editing, setEditing] = useState<RecordingPolicy | null>(null)

  return (
    <Card>
      <CardHeader
        title="Recording policies"
        subtitle={canEdit ? 'Consent wording, retention and access for each kind of recording. Every change is audited.' : 'Read-only: editing needs the "recordings.policy.manage" permission.'}
        action={<Clapperboard className="size-5 text-ink-muted" aria-hidden />}
      />
      {data.error ? (
        <ErrorState title="Unable to load recording policies" description={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <div className="flex flex-col gap-3 px-5 pb-5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : (
        <div className="flex flex-col gap-3 px-5 pb-5" data-testid="recording-policies">
          {data.data.items.map((p) => (
            <article key={p.code} className="rounded-md border border-line p-4" data-testid={`policy-${p.code}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold text-ink">{p.title}</h3>
                  <p className="mt-0.5 text-[12.5px] text-ink-secondary">{p.appliesTo}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone={p.confirmed ? 'success' : 'warning'} dot>{approvalLabel[p.approvalStatus]}</Badge>
                    <Badge tone={p.isEnabled && p.requirement !== 'DISABLED' ? 'brand' : 'neutral'}>{p.isEnabled ? requirementLabel[p.requirement] : 'Switched off'}</Badge>
                    <Badge>{p.consentMode === 'CONSENT_REQUIRED' ? 'Consent required' : 'Notification only'}</Badge>
                    <Badge>{p.retentionDays ? `Retention ${p.retentionDays} days · ${expiryLabel[p.expiryAction].split(' (')[0]}` : 'Retention not set'}</Badge>
                    {p.configurationOnly && <Badge tone="info">Configuration only (no telephony integration)</Badge>}
                  </div>
                </div>
                {canEdit && (
                  <Button size="sm" variant="secondary" leftIcon={<Pencil className="size-4" />} onClick={() => setEditing(p)} aria-label={`Edit ${p.title}`}>
                    Edit
                  </Button>
                )}
              </div>
              {!p.confirmed && (
                <Alert tone="warning" title="Not confirmed — values pending internal confirmation" className="mt-3">
                  <ul className="list-disc pl-4">{p.pending.map((x) => <li key={x}>{x}</li>)}</ul>
                </Alert>
              )}
              <p className="mt-2 text-[12px] text-ink-muted">
                {p.policyName ? `${p.policyName}${p.policyVersion ? ` v${p.policyVersion}` : ''}` : 'Policy name not entered'}
                {p.policyReference ? ` · Ref. ${p.policyReference}` : ''} · Wording version {p.noticeVersion}
                {p.modifiedUtc ? ` · Last changed ${formatDateTime(p.modifiedUtc)}${p.modifiedBy ? ` by ${p.modifiedBy}` : ''}` : ''}
              </p>
            </article>
          ))}
          <CategoryMapping
            canEdit={canEdit}
            categories={data.data.categories}
            policies={data.data.items.filter((p) => !p.configurationOnly)}
            onSaved={() => {
              toast.success('Category mapping saved.')
              data.reload()
            }}
          />
        </div>
      )}
      {editing && data.data && (
        <PolicyDialog
          policy={editing}
          roles={data.data.roles}
          onClose={(saved) => {
            setEditing(null)
            if (saved) {
              toast.success('Recording policy saved.')
              data.reload()
            }
          }}
        />
      )}
    </Card>
  )
}

function CategoryMapping({ canEdit, categories, policies, onSaved }: {
  canEdit: boolean
  categories: { category: string; policyCode: string }[]
  policies: RecordingPolicy[]
  onSaved: () => void
}) {
  const [map, setMap] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setMap(Object.fromEntries(categories.map((c) => [c.category, c.policyCode]))), [categories])
  const dirty = categories.some((c) => map[c.category] !== c.policyCode)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await recordingAdminApi.setCategories(Object.entries(map).map(([category, policyCode]) => ({ category, policyCode })))
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'The mapping could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-md border border-line p-4">
      <h3 className="text-[14px] font-semibold text-ink">Meeting categories → policy</h3>
      <p className="mt-0.5 text-[12.5px] text-ink-secondary">Which policy applies to each meeting category. Customer categories always use the customer meetings policy.</p>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => (
          <SelectField
            key={c.category}
            label={dbCategoryLabel[c.category as DbMeetingCategory] ?? c.category}
            value={map[c.category] ?? c.policyCode}
            disabled={!canEdit || isCustomerCategory(c.category)}
            onChange={(e) => setMap((m) => ({ ...m, [c.category]: e.target.value }))}
          >
            {policies.filter((p) => isCustomerCategory(c.category) === (p.code === 'CUSTOMER_MEETING')).map((p) => (
              <option key={p.code} value={p.code}>{p.title}</option>
            ))}
          </SelectField>
        ))}
      </div>
      {canEdit && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!dirty} loading={busy} onClick={() => void save()}>Save mapping</Button>
        </div>
      )}
    </section>
  )
}

function toInput(p: RecordingPolicy): PolicyInput {
  return {
    policyName: p.policyName, policyVersion: p.policyVersion, effectiveFrom: p.effectiveFrom, approvalStatus: p.approvalStatus, policyReference: p.policyReference,
    approvedBy: p.approvedBy, approvedOn: p.approvedOn, isEnabled: p.isEnabled, requirement: p.requirement, consentMode: p.consentMode, noticeText: p.noticeText,
    noticeVersion: p.noticeVersion, consentFromAll: p.consentFromAll, stopOnWithdrawal: p.stopOnWithdrawal, retentionDays: p.retentionDays, expiryAction: p.expiryAction,
    archiveLocation: p.archiveLocation, legalHoldEnabled: p.legalHoldEnabled, dualApprovalForDeletion: p.dualApprovalForDeletion,
    deletionApproverRoles: p.deletionApproverRoles, playbackRoles: p.playbackRoles, downloadRoles: p.downloadRoles, ownerCanPlay: p.ownerCanPlay,
    ownerCanDownload: p.ownerCanDownload, teamLeaderCanPlay: p.teamLeaderCanPlay, departmentHeadCanPlay: p.departmentHeadCanPlay,
    signedUrlTtlSeconds: p.signedUrlTtlSeconds, rowVersion: p.rowVersion,
  }
}

function PolicyDialog({ policy, roles, onClose }: { policy: RecordingPolicy; roles: { code: string; name: string }[]; onClose: (saved: boolean) => void }) {
  const [f, setF] = useState<PolicyInput>(() => toInput(policy))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof PolicyInput>(k: K, v: PolicyInput[K]) => setF((x) => ({ ...x, [k]: v }))
  const text = (k: keyof PolicyInput) => ({
    value: (f[k] as string | null) ?? '',
    onChange: (e: { target: { value: string } }) => set(k, (e.target.value || null) as never),
    error: errors[k],
  })
  const placeholderWording = f.noticeText.toUpperCase().includes('[PLACEHOLDER') || f.noticeVersion.toUpperCase().startsWith('PLACEHOLDER')

  async function save() {
    setBusy(true)
    setError(null)
    setErrors({})
    try {
      await recordingAdminApi.update(policy.code, f)
      onClose(true)
    } catch (e) {
      setErrors(fieldErrors(e))
      setError(errorMessage(e, 'The policy could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  const roleBoxes = (k: 'playbackRoles' | 'downloadRoles' | 'deletionApproverRoles', label: string, hint: string) => (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-[13px] font-semibold text-ink">{label}</legend>
      <p className="text-[12px] text-ink-secondary">{hint}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {roles.map((r) => (
          <Checkbox
            key={r.code}
            label={r.name}
            checked={f[k].includes(r.code)}
            onChange={(e) => set(k, e.target.checked ? [...f[k], r.code] : f[k].filter((x) => x !== r.code))}
          />
        ))}
      </div>
      {errors[k] && <p className="text-[12.5px] font-medium text-danger">{errors[k]}</p>}
    </fieldset>
  )

  return (
    <Dialog
      open
      onClose={() => onClose(false)}
      title={`Edit: ${policy.title}`}
      description="Enter the values from the existing OneInsure recording policy. Do not invent wording, retention or roles."
      size="xl"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} loading={busy}>Save policy</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5" data-testid="policy-dialog">
        {error && <Alert tone="danger">{error}</Alert>}
        {policy.configurationOnly && (
          <Alert tone="info">OneInsure Connect has no telephony integration yet: this policy is stored for later use and is not applied to any meeting.</Alert>
        )}
        <section className="grid gap-4 sm:grid-cols-2">
          <h3 className="text-[13px] font-bold tracking-wide text-ink-secondary uppercase sm:col-span-2">Policy document</h3>
          <TextField label="Policy name" {...text('policyName')} />
          <TextField label="Policy version" {...text('policyVersion')} />
          <TextField label="Effective from" type="date" {...text('effectiveFrom')} />
          <SelectField label="Approval status" value={f.approvalStatus} onChange={(e) => set('approvalStatus', e.target.value as ApprovalStatus)} error={errors.approvalStatus}
            hint="Existing business policy / Approved need the reference and real values (no placeholders).">
            {(Object.keys(approvalLabel) as ApprovalStatus[]).map((s) => <option key={s} value={s}>{approvalLabel[s]}</option>)}
          </SelectField>
          <TextField label="Policy reference" {...text('policyReference')} hint="Document number / name of the existing policy" />
          <TextField label="Approved by" {...text('approvedBy')} />
          <TextField label="Approved on" type="date" {...text('approvedOn')} />
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <h3 className="text-[13px] font-bold tracking-wide text-ink-secondary uppercase sm:col-span-2">Recording and consent</h3>
          <Switch label="Recording enabled for this policy" checked={f.isEnabled} onChange={(v) => set('isEnabled', v)} className="sm:col-span-2" />
          <SelectField label="Requirement" value={f.requirement} onChange={(e) => set('requirement', e.target.value as Requirement)}>
            {(Object.keys(requirementLabel) as Requirement[]).map((r) => <option key={r} value={r}>{requirementLabel[r]}</option>)}
          </SelectField>
          <SelectField label="Consent / notification mode" value={f.consentMode} onChange={(e) => set('consentMode', e.target.value as ConsentMode)}>
            <option value="CONSENT_REQUIRED">Consent required (Accept / Decline)</option>
            <option value="NOTIFICATION_ONLY">Notification only (acknowledge)</option>
          </SelectField>
          <TextAreaField label="Consent / notification wording (shown to every participant)" rows={4} className="sm:col-span-2" value={f.noticeText}
            onChange={(e) => set('noticeText', e.target.value)} error={errors.noticeText}
            hint={placeholderWording ? 'Placeholder wording: participants see it flagged as not confirmed.' : 'Shown verbatim; its version is stored with every decision.'} />
          <TextField label="Wording version" value={f.noticeVersion} onChange={(e) => set('noticeVersion', e.target.value)} error={errors.noticeVersion} />
          <div className="flex flex-col gap-2 pt-6">
            <Switch label="Consent from all participants required" checked={f.consentFromAll} onChange={(v) => set('consentFromAll', v)} />
            <Switch label="Stop recording when consent is withdrawn" checked={f.stopOnWithdrawal} onChange={(v) => set('stopOnWithdrawal', v)} />
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <h3 className="text-[13px] font-bold tracking-wide text-ink-secondary uppercase sm:col-span-2">Retention</h3>
          <TextField label="Retention (days)" type="number" min={1} value={f.retentionDays ?? ''} error={errors.retentionDays}
            onChange={(e) => set('retentionDays', e.target.value === '' ? null : Number(e.target.value))} hint="Empty = not set: recordings are never deleted or archived automatically." />
          <SelectField label="Action at expiry" value={f.expiryAction} onChange={(e) => set('expiryAction', e.target.value as ExpiryAction)}>
            {(Object.keys(expiryLabel) as ExpiryAction[]).map((a) => <option key={a} value={a}>{expiryLabel[a]}</option>)}
          </SelectField>
          <TextField label="Archive location" {...text('archiveLocation')} hint="Absolute folder, e.g. D:\RecordingArchive" />
          <div className="flex flex-col gap-2 pt-6">
            <Switch label="Legal hold allowed" checked={f.legalHoldEnabled} onChange={(v) => set('legalHoldEnabled', v)} />
            <Switch label="Deletion needs two approvers" checked={f.dualApprovalForDeletion} onChange={(v) => set('dualApprovalForDeletion', v)} />
          </div>
          <div className="sm:col-span-2">{roleBoxes('deletionApproverRoles', 'Deletion approver roles', 'Who may approve a deletion at retention expiry.')}</div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <h3 className="text-[13px] font-bold tracking-wide text-ink-secondary uppercase sm:col-span-2">Access</h3>
          <div className="flex flex-col gap-2">
            <Switch label="Owner (meeting creator) can play" checked={f.ownerCanPlay} onChange={(v) => set('ownerCanPlay', v)} />
            <Switch label="Owner can download" checked={f.ownerCanDownload} onChange={(v) => set('ownerCanDownload', v)} />
          </div>
          <div className="flex flex-col gap-2">
            <Switch label="Team leader can play team recordings" checked={f.teamLeaderCanPlay} onChange={(v) => set('teamLeaderCanPlay', v)} />
            <Switch label="Department head can play department recordings" checked={f.departmentHeadCanPlay} onChange={(v) => set('departmentHeadCanPlay', v)} />
          </div>
          <div className="sm:col-span-2">{roleBoxes('playbackRoles', 'Playback roles', 'Roles that can see and play every recording under this policy.')}</div>
          <div className="sm:col-span-2">{roleBoxes('downloadRoles', 'Download roles', 'Roles that can download recordings under this policy (they must also be able to see them).')}</div>
          <TextField label="Signed link lifetime (seconds)" type="number" min={30} max={3600} value={f.signedUrlTtlSeconds} error={errors.signedUrlTtlSeconds}
            onChange={(e) => set('signedUrlTtlSeconds', Number(e.target.value))} hint="30–3600. Playback and download links expire after this." />
        </section>
      </div>
    </Dialog>
  )
}

/** Recorder availability for administrators (FFmpeg, Edge, recorder executable, storage folders, LiveKit keys). */
export function RecorderHealthCard() {
  const health = useLoader(() => recordingAdminApi.health(), [], 'Unable to check the recorder.')
  const h = health.data
  return (
    <Card>
      <CardHeader
        title="Recorder status"
        subtitle={h?.recorder ?? 'R2 recorder (proof of concept)'}
        action={<Button size="sm" variant="ghost" leftIcon={<RotateCw className="size-4" />} onClick={health.reload} loading={health.loading}>Check</Button>}
      />
      {health.error ? (
        <ErrorState title="Unable to check the recorder" description={health.error} onRetry={health.reload} />
      ) : !h ? (
        <div className="px-5 pb-5"><Skeleton className="h-32 w-full" /></div>
      ) : (
        <div className="flex flex-col gap-3 px-5 pb-5" data-testid="recorder-health">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={h.available ? 'success' : 'danger'} dot>{h.available ? 'Available' : 'Not available'}</Badge>
            <Badge>Environment: {h.environment}</Badge>
            <Badge tone="info"><HeartPulse className="size-3" /> {h.activeJobs} active · {h.queuedJobs} queued</Badge>
            {h.failedLast24h > 0 && <Badge tone="warning"><ShieldAlert className="size-3" /> {h.failedLast24h} failed (24 h)</Badge>}
          </div>
          <ul className="divide-y divide-line rounded-md border border-line">
            {h.items.map((i) => (
              <li key={i.name} className="flex items-start gap-2.5 px-3.5 py-2.5 text-[13px]">
                {i.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="OK" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Problem" />}
                <div className="min-w-0">
                  <p className="font-medium text-ink">{i.name}</p>
                  <p className="break-all text-[12px] text-ink-secondary">{i.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
