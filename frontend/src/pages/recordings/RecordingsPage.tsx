import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, CircleCheck, Clapperboard, Download, FileClock, Gavel, Lock, LockOpen, Play, RotateCw, ShieldCheck, Trash2, UsersRound,
} from 'lucide-react'
import { orgApi } from '../../api/org'
import {
  formatBytes, formatSeconds, recordingStatusLabel, recordingsApi, type AccessEntry, type DeletionRequest, type RecordingDetail, type RecordingItem, type RecordingStatus,
} from '../../api/recordings'
import { errorMessage } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { PageHeader, Pagination, Tabs, tabPanelProps, table } from '../../components/ui/Data'
import { Alert, Badge, EmptyState, ErrorState, Skeleton, type BadgeTone } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { FilterSelect, SearchField, TextAreaField } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { useToast } from '../../components/ui/Toast'
import { DEFAULT_TIME_ZONE } from '../../config'
import { cn } from '../../lib/cn'
import { formatDateTime, zonedToUtc } from '../../lib/format'
import { useDebounced, useLoader } from '../../lib/useLoader'
import { CategoryBadge } from '../meetings/meta'
import { PlannedModulePage } from '../PlannedModulePage'

const PAGE_SIZE = 25

const statusTone: Record<RecordingStatus, BadgeTone> = {
  PENDING: 'info', RECORDING: 'live', PROCESSING: 'info', VERIFYING: 'info', COMPLETED: 'success', FAILED: 'danger', PURGED: 'neutral',
}

export function RecordingStatusBadge({ status }: { status: RecordingStatus }) {
  return <Badge tone={statusTone[status]} dot>{recordingStatusLabel[status]}</Badge>
}

/** /recordings and /recordings/:id */
export function RecordingsRoutes() {
  return (
    <Routes>
      <Route index element={<RecordingLibrary />} />
      <Route path=":id" element={<RecordingDetailPage />} />
      <Route path="*" element={<PlannedModulePage />} />
    </Routes>
  )
}

type Tab = 'recordings' | 'employees' | 'retention'

function RecordingLibrary() {
  const { user } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'recordings')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [department, setDepartment] = useState('')
  const [customerRef, setCustomerRef] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const employee = params.get('employee') ?? ''
  const employeeName = params.get('employeeName') ?? ''
  const term = useDebounced(search.trim(), 300)
  const cref = useDebounced(customerRef.trim(), 300)
  const filters = {
    search: term || undefined, status: status || undefined, category: category || undefined, department: department || undefined, customerRef: cref || undefined,
    employee: employee || undefined, from: from ? zonedToUtc(from, '00:00', tz).toISOString() : undefined, to: to ? zonedToUtc(to, '23:59', tz).toISOString() : undefined,
  }
  const key = JSON.stringify(filters)
  useEffect(() => setPage(1), [key])
  const departments = useLoader(() => orgApi.list('departments'), [], '')
  const list = useLoader(() => (tab === 'recordings' ? recordingsApi.list({ ...filters, page, pageSize: PAGE_SIZE }) : Promise.resolve(null)), [key, page, tab], 'Unable to load recordings.')
  const byEmployee = useLoader(() => (tab === 'employees' ? recordingsApi.byEmployee(filters) : Promise.resolve(null)), [key, tab], 'Unable to load the summary.')
  const retention = useLoader(() => recordingsApi.retention(), [], '')
  const showRetention = !!retention.data && (retention.data.review.length > 0 || retention.data.deletions.length > 0 || retention.data.canApproveFor.length > 0)

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'recordings', label: 'Recordings', icon: <Clapperboard className="size-4" /> },
    { id: 'employees', label: 'By employee', icon: <UsersRound className="size-4" /> },
  ]
  if (showRetention) tabs.push({ id: 'retention', label: 'Retention', icon: <FileClock className="size-4" /> })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Recording Library" description="Verified meeting recordings you are allowed to see. Every view, playback and download is logged." />
      <Tabs tabs={tabs} value={tab} onChange={(t) => (setTab(t), setParams((p) => (p.set('tab', t), p)))} label="Recording library views" idPrefix="rec" />
      {tab !== 'retention' && (
        <Card>
          <div className="grid gap-2.5 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
            <SearchField value={search} onChange={setSearch} placeholder="Meeting, code or employee" aria-label="Search recordings" />
            <FilterSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses (except deleted)</option>
              {(Object.keys(recordingStatusLabel) as RecordingStatus[]).map((s) => <option key={s} value={s}>{recordingStatusLabel[s]}</option>)}
            </FilterSelect>
            <FilterSelect aria-label="Meeting category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              <option value="CUSTOMER">Customer meetings</option>
              <option value="INTERNAL">Internal meetings</option>
              <option value="TRAINING">Training</option>
              <option value="REVIEW">Review</option>
              <option value="MANAGEMENT">Management</option>
            </FilterSelect>
            <FilterSelect aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">All departments</option>
              {(departments.data ?? []).map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </FilterSelect>
            <SearchField value={customerRef} onChange={setCustomerRef} placeholder="Customer, reference or policy no." aria-label="Customer reference" />
            <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            {employee && (
              <div className="flex items-end">
                <Button variant="secondary" size="sm" onClick={() => setParams((p) => (p.delete('employee'), p.delete('employeeName'), p))}>
                  Employee: {employeeName || 'selected'} ✕
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === 'recordings' && (
        <Card {...tabPanelProps('rec', 'recordings')}>
          {list.error ? (
            <ErrorState title="Unable to load recordings" description={list.error} onRetry={list.reload} />
          ) : !list.data ? (
            <div className="flex flex-col gap-3 p-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
          ) : list.data.items.length === 0 ? (
            <EmptyState icon={<Clapperboard className="size-6" />} title="No recordings" description="Recordings of meetings you may see appear here once they are verified." />
          ) : (
            <div className={cn(list.loading && 'opacity-60')}>
              <div className={table.wrap}>
                <table className={table.table} data-testid="recordings-table">
                  <thead>
                    <tr>
                      <th className={table.th}>Meeting</th>
                      <th className={table.th}>Owner</th>
                      <th className={table.th}>Recorded</th>
                      <th className={table.th}>Duration</th>
                      <th className={table.th}>Status</th>
                      <th className={table.th}><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((r) => <Row key={r.id} r={r} tz={tz} />)}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} disabled={list.loading} />
            </div>
          )}
        </Card>
      )}

      {tab === 'employees' && (
        <Card {...tabPanelProps('rec', 'employees')}>
          <CardHeader title="Recordings by employee" subtitle="Owner = the employee who created the meeting." />
          {byEmployee.error ? (
            <ErrorState description={byEmployee.error} onRetry={byEmployee.reload} />
          ) : !byEmployee.data ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : byEmployee.data.length === 0 ? (
            <EmptyState title="No recordings" />
          ) : (
            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th className={table.th}>Employee</th><th className={table.th}>Department</th><th className={table.th}>Recordings</th>
                    <th className={table.th}>Completed</th><th className={table.th}>Failed</th><th className={table.th}>Total length</th><th className={table.th}>Latest</th>
                  </tr>
                </thead>
                <tbody>
                  {byEmployee.data.map((e) => (
                    <tr key={e.employee.id} className={table.row}>
                      <td className={table.td}>
                        <button type="button" className="font-semibold text-brand-700 hover:underline"
                          onClick={() => { setParams((p) => (p.set('employee', e.employee.id), p.set('employeeName', e.employee.name), p.set('tab', 'recordings'), p)); setTab('recordings') }}>
                          {e.employee.name}
                        </button>
                        <span className="ml-1.5 text-[12px] text-ink-secondary">{e.employee.employeeCode}</span>
                      </td>
                      <td className={table.td}>{e.employee.department ?? '—'}</td>
                      <td className={table.td}>{e.recordings}</td>
                      <td className={table.td}>{e.completed}</td>
                      <td className={table.td}>{e.failed}</td>
                      <td className={table.td}>{formatSeconds(e.totalSeconds)}</td>
                      <td className={table.td}>{formatDateTime(e.lastUtc, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'retention' && retention.data && <RetentionPanel data={retention.data} tz={tz} reload={retention.reload} />}
    </div>
  )
}

function Row({ r, tz }: { r: RecordingItem; tz: string }) {
  return (
    <tr className={table.row} data-testid="recording-row" data-id={r.id}>
      <td className={table.td}>
        <Link to={`/recordings/${r.id}`} className="font-semibold text-ink hover:text-brand-700 hover:underline">{r.meeting.title}</Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
          <span className="font-mono">{r.meeting.meetingCode}</span>
          <CategoryBadge group={r.meeting.categoryGroup} />
          {r.customer && <span>· {r.customer.name}{r.customer.reference ? ` (${r.customer.reference})` : ''}</span>}
          {r.legalHold && <Badge tone="warning"><Gavel className="size-3" /> Legal hold</Badge>}
        </div>
      </td>
      <td className={table.td}>
        {r.owner.name}
        <div className="text-[12px] text-ink-secondary">{[r.owner.employeeCode, r.owner.department].filter(Boolean).join(' · ')}</div>
      </td>
      <td className={cn(table.td, 'whitespace-nowrap')}>{formatDateTime(r.startedUtc ?? r.createdUtc, tz)}</td>
      <td className={table.td}>{formatSeconds(r.durationSeconds)}</td>
      <td className={table.td}><RecordingStatusBadge status={r.status} /></td>
      <td className={cn(table.td, 'text-right')}>
        <Link to={`/recordings/${r.id}`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-700 hover:underline">
          {r.canPlay ? <><Play className="size-3.5" /> Play</> : 'Details'}
        </Link>
      </td>
    </tr>
  )
}

function RetentionPanel({ data, tz, reload }: { data: { review: RecordingItem[]; deletions: DeletionRequest[]; canApproveFor: string[] }; tz: string; reload: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  async function decide(d: DeletionRequest, approve: boolean) {
    setBusy(d.id)
    try {
      if (approve) {
        const r = await recordingsApi.approveDeletion(d.id)
        toast.success(r.status === 'EXECUTED' ? 'Approved: the recording file was deleted (record kept).' : r.status === 'CANCELLED' ? 'Cancelled: the recording is under legal hold.' : 'Approved. A second approver is required.')
      } else {
        await recordingsApi.rejectDeletion(d.id)
        toast.success('Deletion rejected.')
      }
      reload()
    } catch (e) {
      toast.error(errorMessage(e, 'The decision could not be saved.'))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-5" {...tabPanelProps('rec', 'retention')}>
      <Card>
        <CardHeader title="Deletion requests" subtitle="Created when a policy's retention expires with the action Delete. Dual approval = two different approvers." />
        {data.deletions.length === 0 ? <EmptyState title="No deletion requests" /> : (
          <ul className="divide-y divide-line">
            {data.deletions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13px]">
                <div className="min-w-0">
                  <Link to={`/recordings/${d.recordingId}`} className="font-semibold text-ink hover:underline">{d.meetingTitle}</Link>
                  <span className="ml-1.5 font-mono text-[12px] text-ink-secondary">{d.meetingCode}</span>
                  <p className="text-[12px] text-ink-secondary">{d.reason} · owner {d.owner} · requested {formatDateTime(d.requestedUtc, tz)}</p>
                  <p className="text-[12px] text-ink-secondary">
                    Approvals: {[d.firstApprover, d.secondApprover].filter(Boolean).join(', ') || 'none'} ({d.requiredApprovals} required){d.notes ? ` · ${d.notes}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={d.status === 'PENDING' ? 'warning' : d.status === 'EXECUTED' ? 'neutral' : 'info'}>{d.status}</Badge>
                  {d.canDecide && (
                    <>
                      <Button size="sm" variant="danger" leftIcon={<Trash2 className="size-4" />} loading={busy === d.id} onClick={() => void decide(d, true)}>Approve deletion</Button>
                      <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => void decide(d, false)}>Reject</Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Retention review" subtitle="Recordings whose retention period expired under a policy with the action Review only." />
        {data.review.length === 0 ? <EmptyState title="Nothing to review" /> : (
          <div className={table.wrap}>
            <table className={table.table}><tbody>{data.review.map((r) => <Row key={r.id} r={r} tz={tz} />)}</tbody></table>
          </div>
        )}
      </Card>
    </div>
  )
}

// ---- Detail ----------------------------------------------------------------------------------------------------------

function RecordingDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const tz = user?.timeZone ?? DEFAULT_TIME_ZONE
  const detail = useLoader(() => recordingsApi.get(id), [id], 'Unable to load the recording.')
  const back = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeft className="size-4" />} onClick={() => navigate('/recordings')}>Recording Library</Button>
  )
  if (detail.error)
    return <div className="flex flex-col gap-4">{back}<Card><ErrorState title="Recording not available" description={detail.error} /></Card></div>
  if (!detail.data) return <div className="flex flex-col gap-4">{back}<Skeleton className="h-96 w-full" /></div>
  const d = detail.data
  const r = d.recording
  return (
    <div className="flex flex-col gap-5" data-testid="recording-detail">
      <div>{back}</div>
      <PageHeader
        title={r.meeting.title}
        description={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{r.meeting.meetingCode}</span><CategoryBadge group={r.meeting.categoryGroup} /><RecordingStatusBadge status={r.status} />{r.legalHold && <Badge tone="warning"><Gavel className="size-3" /> Legal hold</Badge>}</span>}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-5">
          {r.status === 'COMPLETED' ? <Player d={d} /> : (
            <Alert tone={r.status === 'FAILED' ? 'danger' : 'info'} title={recordingStatusLabel[r.status]}>
              {r.status === 'FAILED' ? d.failureReason : r.status === 'PURGED' ? 'The file was deleted under the retention policy. This record and its history are kept.' : 'The recording is not ready yet.'}
            </Alert>
          )}
          <Card>
            <CardHeader title="Verification" subtitle="A recording is COMPLETED only after these checks passed on the stored file." action={d.verifiedUtc ? <ShieldCheck className="size-5 text-success" aria-hidden /> : undefined} />
            <dl className="grid gap-x-6 gap-y-2.5 px-5 pb-5 text-[13px] sm:grid-cols-2">
              <Info label="Verified">{formatDateTime(d.verifiedUtc, tz)}</Info>
              <Info label="Duration">{formatSeconds(r.durationSeconds)}</Info>
              <Info label="File size">{formatBytes(r.fileSizeBytes)}</Info>
              <Info label="Format">{d.container ? `${d.container.toUpperCase()} · ${d.videoCodec}/${d.audioCodec} · ${d.width}×${d.height}` : '—'}</Info>
              <Info label="SHA-256" wide><span className="font-mono text-[12px] break-all" data-testid="sha256">{d.sha256 ?? '—'}</span></Info>
              {d.verification && 'checks' in d.verification && (
                <Info label="Checks" wide>
                  <ul className="flex flex-wrap gap-1.5">
                    {(d.verification.checks as string[]).map((c) => <li key={c}><Badge tone="success"><CircleCheck className="size-3" /> {c}</Badge></li>)}
                  </ul>
                </Info>
              )}
            </dl>
          </Card>
          {d.canSeeAccessHistory && d.accessHistory && <AccessHistory items={d.accessHistory} tz={tz} />}
        </div>
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Details" />
            <dl className="flex flex-col gap-2.5 px-5 pb-5 text-[13px]">
              <Info label="Owner (meeting creator)">{r.owner.name}{r.owner.employeeCode ? ` · ${r.owner.employeeCode}` : ''}</Info>
              <Info label="Department">{r.owner.department ?? '—'}</Info>
              {r.customer && <Info label="Customer">{r.customer.name}{r.customer.reference ? ` (${r.customer.reference})` : ''}</Info>}
              <Info label="Recorded">{formatDateTime(r.startedUtc, tz)} – {formatDateTime(r.endedUtc, tz)}</Info>
              <Info label="Started by">{d.startedBy ?? 'Automatically (mandatory policy)'}</Info>
              {d.stopReason && <Info label="Stopped">{d.stopReason}</Info>}
              <Info label="Policy">{r.policy?.title ?? '—'}{d.policyVersion ? ` v${d.policyVersion}` : ''}</Info>
              <Info label="Retain until">{r.retainUntilUtc ? formatDateTime(r.retainUntilUtc, tz) : 'Retention not set'}</Info>
              <Info label="Storage">{r.storageTier === 'ARCHIVE' ? `Archive (${formatDateTime(d.archivedUtc, tz)})` : 'Recording library'}</Info>
              <Info label="Meeting"><Link to={`/meetings/${r.meeting.id}`} className="text-brand-700 hover:underline">Open meeting</Link></Info>
            </dl>
          </Card>
          <Actions d={d} reload={detail.reload} />
          <Card>
            <CardHeader title="Consent and notice" subtitle="Append-only decisions stored with the wording version." />
            {d.consents.length === 0 ? <p className="px-5 pb-5 text-[13px] text-ink-secondary">No decisions recorded.</p> : (
              <ul className="flex flex-col gap-2 px-5 pb-5 text-[13px]">
                {d.consents.map((c, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span>{c.name} <span className="text-[12px] text-ink-secondary">({c.participantType.toLowerCase()})</span></span>
                    <span className="text-right text-[12px] text-ink-secondary">
                      <Badge tone={c.decision === 'GRANTED' ? 'success' : 'warning'}>{c.decision}</Badge> v{c.noticeVersion} · {formatDateTime(c.decisionUtc, tz)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function Info({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <dt className="text-[12px] font-medium text-ink-secondary">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  )
}

/** Plays through a short-lived signed URL; when it expires mid-playback a fresh one is fetched and playback resumes where it was. */
function Player({ d }: { d: RecordingDetail }) {
  const r = d.recording
  const toast = useToast()
  const video = useRef<HTMLVideoElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resume = useRef<{ t: number; play: boolean } | null>(null)
  const refreshes = useRef(0)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const link = await recordingsApi.play(r.id)
      setSrc(link.url)
    } catch (e) {
      setError(errorMessage(e, 'The recording could not be opened.'))
    } finally {
      setBusy(false)
    }
  }, [r.id])

  async function download() {
    try {
      const link = await recordingsApi.download(r.id)
      window.location.assign(link.url)
    } catch (e) {
      toast.error(errorMessage(e, 'The download could not be started.'))
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-video w-full bg-navy-950">
        {src ? (
          <video
            ref={video}
            src={src}
            controls
            playsInline
            className="size-full"
            data-testid="recording-player"
            controlsList={r.canDownload ? undefined : 'nodownload'}
            onContextMenu={(e) => !r.canDownload && e.preventDefault()}
            onLoadedMetadata={() => {
              const v = video.current
              if (v && resume.current) {
                v.currentTime = resume.current.t
                if (resume.current.play) void v.play().catch(() => undefined)
                resume.current = null
              }
            }}
            onError={() => {
              // Most likely the signed link expired: get a new one (at most a few times) and continue.
              const v = video.current
              if (refreshes.current >= 3) return setError('Playback stopped. Reload the page to continue.')
              refreshes.current++
              resume.current = { t: v?.currentTime ?? 0, play: !!v && !v.paused }
              void load()
            }}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 text-white">
            {r.canPlay ? (
              <Button leftIcon={<Play className="size-4" />} loading={busy} onClick={() => void load()} data-testid="play">Play recording</Button>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-white/80"><Lock className="size-4" /> The recording policy does not allow you to play this recording.</p>
            )}
            {error && <p className="text-[13px] text-[#FCA5A5]">{error}</p>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[12.5px] text-ink-secondary">
        <span>Links are personal and expire after a few minutes. Every playback and download is logged.</span>
        {r.canDownload ? (
          <Button size="sm" variant="secondary" leftIcon={<Download className="size-4" />} onClick={() => void download()} data-testid="download">Download MP4</Button>
        ) : (
          <span className="inline-flex items-center gap-1"><Lock className="size-3.5" /> Download not permitted</span>
        )}
      </div>
    </Card>
  )
}

function Actions({ d, reload }: { d: RecordingDetail; reload: () => void }) {
  const toast = useToast()
  const [holdOpen, setHoldOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const r = d.recording
  if (!d.canSetLegalHold && !d.canRetry) return null

  async function setHold() {
    setBusy(true)
    setError(null)
    try {
      await recordingsApi.setLegalHold(r.id, !r.legalHold, reason)
      toast.success(r.legalHold ? 'Legal hold released.' : 'Legal hold placed.')
      setHoldOpen(false)
      reload()
    } catch (e) {
      setError(errorMessage(e, 'The legal hold could not be changed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader title="Actions" />
      <div className="flex flex-wrap gap-2 px-5 pb-5">
        {d.canSetLegalHold && (
          <Button size="sm" variant="secondary" leftIcon={r.legalHold ? <LockOpen className="size-4" /> : <Gavel className="size-4" />} onClick={() => (setReason(''), setHoldOpen(true))}>
            {r.legalHold ? 'Release legal hold' : 'Place legal hold'}
          </Button>
        )}
        {d.canRetry && (
          <Button size="sm" variant="secondary" leftIcon={<RotateCw className="size-4" />}
            onClick={() => void recordingsApi.retry(r.id).then(() => (toast.success('Processing retried.'), reload())).catch((e) => toast.error(errorMessage(e, 'Retry failed.')))}>
            Retry processing
          </Button>
        )}
      </div>
      <Dialog
        open={holdOpen}
        onClose={() => setHoldOpen(false)}
        title={r.legalHold ? 'Release legal hold?' : 'Place legal hold?'}
        description={r.legalHold ? 'Retention rules apply to this recording again.' : 'The recording is excluded from retention deletion and archiving until the hold is released.'}
        size="sm"
        dismissible={!busy}
        footer={<><Button variant="secondary" onClick={() => setHoldOpen(false)} disabled={busy}>Cancel</Button><Button onClick={() => void setHold()} loading={busy} disabled={!reason.trim()}>Confirm</Button></>}
      >
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        <TextAreaField label="Reason (audited)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} />
      </Dialog>
    </Card>
  )
}

function AccessHistory({ items, tz }: { items: AccessEntry[]; tz: string }) {
  const tone: Record<AccessEntry['action'], BadgeTone> = { VIEW_DETAILS: 'neutral', PLAY: 'info', DOWNLOAD: 'brand', DENIED: 'danger' }
  return (
    <Card>
      <CardHeader title="Access history" subtitle="Append-only log of views, playbacks, downloads and refusals (visible to auditors)." />
      <div className={table.wrap}>
        <table className={table.table} data-testid="access-history">
          <thead><tr><th className={table.th}>When</th><th className={table.th}>User</th><th className={table.th}>Action</th><th className={table.th}>IP address</th><th className={table.th}>Link expired</th></tr></thead>
          <tbody>
            {items.map((h, i) => (
              <tr key={i} className={table.row}>
                <td className={cn(table.td, 'whitespace-nowrap')}>{formatDateTime(h.utc, tz)}</td>
                <td className={table.td}>{h.user}</td>
                <td className={table.td}><Badge tone={tone[h.action]}>{h.action.replace('_', ' ')}</Badge></td>
                <td className={cn(table.td, 'font-mono text-[12px]')}>{h.ipAddress ?? '—'}</td>
                <td className={table.td}>{h.linkExpiresUtc ? formatDateTime(h.linkExpiresUtc, tz) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
