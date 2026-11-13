import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { KeyRound, Plus, RefreshCw, RotateCw, Send, ShieldOff } from 'lucide-react'
import { integrationsApi, type ApiKeyInfo, type DeliveryItem, type Integration, type RequestLogItem } from '../../api/integrations'
import { errorMessage } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { ActiveBadge, table } from '../../components/ui/Data'
import { Alert, Badge, EmptyState, Skeleton } from '../../components/ui/Feedback'
import { Checkbox, TextField } from '../../components/ui/Field'
import { Switch, TextAreaField } from '../../components/ui/Form'
import { ConfirmDialog, Dialog } from '../../components/ui/Overlay'
import { CopyButton, ShownOnceNotice } from '../../components/ui/Secret'
import { useToast } from '../../components/ui/Toast'
import { formatDateTime } from '../../lib/format'

const SCOPE_HELP: Record<string, string> = {
  'meeting.create': 'Create instant meetings', 'meeting.schedule': 'Create scheduled meetings', 'meeting.read': 'Read / list meetings',
  'meeting.cancel': 'Cancel meetings', 'meeting.json.read': 'Completion report (JSON)', 'recording.read': 'Recording metadata',
  'recording.download': 'Download recordings', 'webhook.manage': 'Manage the webhook', 'meeting.plvc.unidentified': 'Create unidentified PLVC meetings (no Prarambh ID)',
}
const when = (utc: string | null) => (utc ? formatDateTime(utc) : '—')

/** One-time secret display (API key or webhook secret): copy now, never shown again. */
function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid="shown-once-secret">
      <ShownOnceNotice>Copy this {label} now. It is shown only once — only a hash (or encrypted copy) is kept and it cannot be displayed again.</ShownOnceNotice>
      <div className="flex gap-2">
        <input readOnly value={value} className="h-10 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 font-mono text-[12.5px] text-ink" onFocus={(e) => e.target.select()} data-testid="secret-value" aria-label={label} />
        <CopyButton text={value} size="md" />
      </div>
    </div>
  )
}

export function IntegrationsPanel() {
  const [data, setData] = useState<{ items: Integration[]; scopes: string[]; events: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const load = useCallback(() => {
    integrationsApi.list().then(setData).catch((e) => setError(errorMessage(e, 'Integrations could not be loaded.')))
  }, [])
  useEffect(load, [load])

  if (error) return <Alert tone="danger">{error}</Alert>
  if (!data) return <Skeleton className="h-60" />
  return (
    <div className="flex flex-col gap-4" data-testid="integrations-panel">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[16px] font-bold text-ink">Integrations</h2>
            <p className="text-[13px] text-ink-secondary">One per external portal. Each has its own Integration ID, API keys, scopes, rate limit and webhook.</p>
          </div>
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="integration-new">New integration</Button>
        </div>
        {data.items.length === 0 ? (
          <div className="p-6"><EmptyState icon={<KeyRound className="size-6" />} title="No integrations yet" description="Create one for each portal that should create meetings through the API." /></div>
        ) : (
          <div className={table.wrap}>
            <table className={table.table}>
              <thead><tr>{['Integration', 'Integration ID', 'Status', 'Scopes', 'Keys', 'Meetings', 'Last used'].map((h) => <th key={h} className={table.th}>{h}</th>)}</tr></thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id} className={`${table.row} cursor-pointer`} onClick={() => setSelected(i.id)} data-testid="integration-row">
                    <td className={table.td}><span className="font-semibold">{i.name}</span><span className="block text-[12px] text-ink-secondary">{i.portalName}</span></td>
                    <td className={`${table.td} font-mono text-[12.5px]`}>{i.integrationId}</td>
                    <td className={table.td}><ActiveBadge active={i.isActive} /></td>
                    <td className={table.td}>{i.scopes.length} of {data.scopes.length}</td>
                    <td className={table.td}>{i.activeKeys}</td>
                    <td className={table.td}>{i.meetings}</td>
                    <td className={table.td}>{when(i.lastUsedUtc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <CreateDialog scopes={data.scopes} onClose={(changed) => { setCreating(false); if (changed) load() }} />}
      {selected && <IntegrationDetail id={selected} scopes={data.scopes} events={data.events} onClose={() => { setSelected(null); load() }} />}
    </div>
  )
}

function ScopeBoxes({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <legend className="mb-2 text-[13px] font-semibold text-ink">Permissions (scopes)</legend>
      {all.map((s) => (
        <Checkbox key={s} checked={value.includes(s)} onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))}
          label={<span><span className="font-mono text-[12.5px]">{s}</span> <span className="text-ink-secondary">— {SCOPE_HELP[s] ?? ''}</span></span>} data-testid={`scope-${s}`} />
      ))}
    </fieldset>
  )
}

function CreateDialog({ scopes, onClose }: { scopes: string[]; onClose: (changed: boolean) => void }) {
  const [name, setName] = useState('')
  const [portal, setPortal] = useState('')
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<string[]>(['meeting.create', 'meeting.read', 'meeting.json.read', 'recording.read'])
  const [rate, setRate] = useState(60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ key: string; code: string } | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await integrationsApi.create({ name: name.trim(), portalName: portal.trim(), description: description.trim() || null, scopes: picked, rateLimitPerMinute: rate })
      setCreated({ key: r.apiKey, code: r.integration.integrationId })
    } catch (err) {
      setError(errorMessage(err, 'The integration could not be created.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={() => onClose(!!created)} title={created ? 'Integration created' : 'New integration'} size="md"
      footer={created ? <Button onClick={() => onClose(true)}>Done</Button> : <>
        <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" form="integration-create" loading={busy} data-testid="integration-create">Create and issue API key</Button>
      </>}>
      {created ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13.5px] text-ink">Integration ID <span className="font-mono font-semibold" data-testid="new-integration-code">{created.code}</span>. Give the portal this API key over a secure channel:</p>
          <Secret label="API key" value={created.key} />
        </div>
      ) : (
        <form id="integration-create" onSubmit={submit} className="flex flex-col gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <TextField label="Integration name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required data-testid="integration-name" />
          <TextField label="Portal / application name" value={portal} onChange={(e) => setPortal(e.target.value)} maxLength={200} required data-testid="integration-portal" />
          <TextAreaField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} />
          <ScopeBoxes all={scopes} value={picked} onChange={setPicked} />
          <TextField label="Rate limit (requests per minute)" type="number" min={1} max={6000} value={rate} onChange={(e) => setRate(Number(e.target.value) || 60)} className="sm:max-w-[240px]" />
        </form>
      )}
    </Dialog>
  )
}

function IntegrationDetail({ id, scopes, events, onClose }: { id: string; scopes: string[]; events: string[]; onClose: () => void }) {
  const toast = useToast()
  const [d, setD] = useState<{ integration: Integration; keys: ApiKeyInfo[] } | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [rate, setRate] = useState(60)
  const [active, setActive] = useState(true)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null)
  const [reason, setReason] = useState('')
  const [hookUrl, setHookUrl] = useState('')
  const [hookEvents, setHookEvents] = useState<string[]>(events)
  const [hookActive, setHookActive] = useState(true)
  const [logs, setLogs] = useState<RequestLogItem[] | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(() => {
    integrationsApi.get(id).then((r) => {
      setD(r)
      setPicked(r.integration.scopes)
      setRate(r.integration.rateLimitPerMinute)
      setActive(r.integration.isActive)
      setHookUrl(r.integration.webhook?.url ?? '')
      if (r.integration.webhook) { setHookEvents(r.integration.webhook.events); setHookActive(r.integration.webhook.active) }
    }).catch((e) => toast.error(errorMessage(e, 'Could not load the integration.')))
    integrationsApi.logs(id).then((r) => setLogs(r.items)).catch(() => setLogs([]))
    integrationsApi.deliveries(id).then((r) => setDeliveries(r.items)).catch(() => setDeliveries([]))
  }, [id, toast])
  useEffect(reload, [reload])

  async function run(fn: () => Promise<void>, ok?: string) {
    setBusy(true)
    try { await fn(); if (ok) toast.success(ok); reload() } catch (e) { toast.error(errorMessage(e, 'The change was not saved.')) } finally { setBusy(false) }
  }
  if (!d) return <Dialog open onClose={onClose} title="Integration" size="lg"><Skeleton className="h-60" /></Dialog>
  const i = d.integration
  return (
    <Dialog open onClose={onClose} title={`${i.name} · ${i.integrationId}`} description={i.portalName} size="lg" variant="drawer">
      <div className="flex flex-col gap-6" data-testid="integration-detail">
        {secret && <Secret label={secret.label} value={secret.value} />}

        <section className="flex flex-col gap-3">
          <h3 className="text-[14px] font-bold text-ink">Access</h3>
          <Switch checked={active} onChange={setActive} label={active ? 'Active — API keys work' : 'Deactivated — every key is refused'} />
          <ScopeBoxes all={scopes} value={picked} onChange={setPicked} />
          <TextField label="Rate limit (requests per minute)" type="number" min={1} max={6000} value={rate} onChange={(e) => setRate(Number(e.target.value) || 60)} className="sm:max-w-[240px]" />
          <div><Button loading={busy} onClick={() => run(async () => { await integrationsApi.update(id, { scopes: picked, rateLimitPerMinute: rate, isActive: active }) }, 'Integration saved.')} data-testid="integration-save">Save access</Button></div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[14px] font-bold text-ink">API keys</h3>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" leftIcon={<Plus className="size-3.5" />} disabled={busy}
                onClick={() => run(async () => { const r = await integrationsApi.newKey(id); setSecret({ label: 'API key', value: r.apiKey }) })}>Add key</Button>
              <Button size="sm" variant="secondary" leftIcon={<RotateCw className="size-3.5" />} disabled={busy} data-testid="key-rotate"
                onClick={() => run(async () => { const r = await integrationsApi.rotateKey(id); setSecret({ label: 'API key', value: r.apiKey }) }, 'New key issued; the previous keys are revoked.')}>Rotate (revoke old)</Button>
            </div>
          </div>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead><tr>{['Key', 'Created', 'Last used', 'Status', ''].map((h) => <th key={h} className={table.th}>{h}</th>)}</tr></thead>
              <tbody>
                {d.keys.map((k) => (
                  <tr key={k.id} className={table.row}>
                    <td className={`${table.td} font-mono text-[12.5px]`}>{k.prefix}</td>
                    <td className={table.td}>{when(k.createdUtc)}<span className="block text-[12px] text-ink-secondary">{k.createdBy}</span></td>
                    <td className={table.td}>{when(k.lastUsedUtc)}<span className="block text-[12px] text-ink-secondary">{k.lastUsedIp}</span></td>
                    <td className={table.td}>{k.active ? <Badge tone="success" dot>Active</Badge> : <Badge tone="neutral">Revoked{k.revokedReason ? ` — ${k.revokedReason}` : ''}</Badge>}</td>
                    <td className={table.td}>{k.active && <Button size="sm" variant="ghost" leftIcon={<ShieldOff className="size-3.5" />} onClick={() => { setReason(''); setRevoking(k) }} data-testid="key-revoke">Revoke</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-[14px] font-bold text-ink">Webhook</h3>
          <TextField label="Endpoint URL (https)" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://portal.example.com/oneinsure/webhook" data-testid="webhook-url" />
          <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-[13px] font-semibold text-ink">Events</legend>
            {events.map((ev) => (
              <Checkbox key={ev} checked={hookEvents.includes(ev)} onChange={(e) => setHookEvents(e.target.checked ? [...hookEvents, ev] : hookEvents.filter((x) => x !== ev))} label={<span className="font-mono text-[12.5px]">{ev}</span>} />
            ))}
          </fieldset>
          <Switch checked={hookActive} onChange={setHookActive} label="Deliver events" />
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => run(async () => {
              const r = await integrationsApi.saveWebhook(id, { url: hookUrl.trim(), events: hookEvents, active: hookActive })
              if (r.secret) setSecret({ label: 'webhook signing secret', value: r.secret })
            }, 'Webhook saved.')} data-testid="webhook-save">Save webhook</Button>
            {i.webhook && <Button variant="secondary" disabled={busy} onClick={() => run(async () => {
              const r = await integrationsApi.saveWebhook(id, { url: hookUrl.trim(), events: hookEvents, active: hookActive, rotateSecret: true })
              if (r.secret) setSecret({ label: 'webhook signing secret', value: r.secret })
            }, 'Signing secret rotated.')}>Rotate secret</Button>}
            {i.webhook && <Button variant="secondary" leftIcon={<Send className="size-4" />} disabled={busy} onClick={() => run(async () => { await integrationsApi.testWebhook(id) }, 'Test event queued.')}>Send test event</Button>}
          </div>
          <DeliveryTable items={deliveries} onRetry={(did) => run(async () => { await integrationsApi.retryDelivery(did) }, 'Delivery queued again.')} />
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-bold text-ink">Recent API requests</h3>
            <Button size="sm" variant="ghost" leftIcon={<RefreshCw className="size-3.5" />} onClick={reload}>Refresh</Button>
          </div>
          {!logs ? <Skeleton className="h-24" /> : logs.length === 0 ? <p className="text-[13px] text-ink-secondary">No requests yet.</p> : (
            <div className={table.wrap}>
              <table className={table.table} data-testid="request-log">
                <thead><tr>{['Time', 'Request', 'Status', 'ms', 'IP'].map((h) => <th key={h} className={table.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {logs.map((l, n) => (
                    <tr key={n} className={table.row}>
                      <td className={table.td}>{when(l.utc)}</td>
                      <td className={`${table.td} font-mono text-[12px]`}>{l.method} {l.path}</td>
                      <td className={table.td}><Badge tone={l.status < 300 ? 'success' : l.status < 500 ? 'warning' : 'danger'}>{l.status}{l.error ? ` ${l.error}` : ''}</Badge></td>
                      <td className={table.td}>{l.durationMs}</td>
                      <td className={table.td}>{l.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <ConfirmDialog open={!!revoking} onClose={() => setRevoking(null)} title="Revoke this API key?" confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!reason.trim()) { toast.error('Enter the reason.'); return }
          await run(async () => { await integrationsApi.revokeKey(id, revoking!.id, reason.trim()) }, 'Key revoked. It stops working immediately.')
          setRevoking(null)
        }}>
        <p className="mb-3">Requests with <span className="font-mono">{revoking?.prefix}</span> are refused immediately. This cannot be undone.</p>
        <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} data-testid="revoke-reason" />
      </ConfirmDialog>
    </Dialog>
  )
}

function DeliveryTable({ items, onRetry }: { items: DeliveryItem[] | null; onRetry: (id: number) => void }) {
  if (!items) return <Skeleton className="h-24" />
  if (items.length === 0) return <p className="text-[13px] text-ink-secondary">No webhook deliveries yet.</p>
  return (
    <div className={table.wrap}>
      <table className={table.table} data-testid="delivery-log">
        <thead><tr>{['Created', 'Event', 'Status', 'Attempts', 'Last result', ''].map((h) => <th key={h} className={table.th}>{h}</th>)}</tr></thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} className={table.row}>
              <td className={table.td}>{when(d.createdUtc)}</td>
              <td className={`${table.td} font-mono text-[12px]`}>{d.eventType}</td>
              <td className={table.td}><Badge tone={d.status === 'DELIVERED' ? 'success' : d.status === 'FAILED' ? 'danger' : 'warning'}>{d.status}</Badge></td>
              <td className={table.td}>{d.attempts}</td>
              <td className={table.td}>{d.lastStatusCode ?? ''} {d.lastError ?? ''}{d.nextAttemptUtc ? <span className="block text-[12px] text-ink-secondary">Next try {when(d.nextAttemptUtc)}</span> : null}</td>
              <td className={table.td}>{d.status === 'FAILED' && <Button size="sm" variant="ghost" onClick={() => onRetry(d.id)}>Retry</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
