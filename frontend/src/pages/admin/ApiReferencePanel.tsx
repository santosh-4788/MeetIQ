import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { Badge, ErrorState, Skeleton, type BadgeTone } from '../../components/ui/Feedback'
import { SearchField, TextAreaField } from '../../components/ui/Form'
import { PasswordField, TextField } from '../../components/ui/Field'
import { Button } from '../../components/ui/Button'
import { CopyButton } from '../../components/ui/Secret'
import { cn } from '../../lib/cn'

/**
 * Built-in, dependency-free API reference over the server's generated OpenAPI document (replaces swagger-ui-dist).
 * Lists every operation with its parameters, request body, responses and schemas, and lets the reader try a call with an API key.
 * The key lives only in this component's state: it is never stored and is sent only to this site's own /api/ext endpoints.
 */

type Json = Record<string, unknown>
type Schema = Json & { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; required?: string[]; oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[]; enum?: unknown[]; format?: string; description?: string }
type Parameter = { name: string; in: 'path' | 'query' | 'header' | 'cookie'; required?: boolean; description?: string; schema?: Schema }
type Media = Record<string, { schema?: Schema; example?: unknown }>
type Operation = { summary?: string; description?: string; operationId?: string; tags?: string[]; parameters?: Parameter[]; requestBody?: { required?: boolean; content?: Media }; responses?: Record<string, { description?: string; content?: Media }> }
type OpenApiDoc = { openapi: string; info?: { title?: string; version?: string; description?: string }; paths: Record<string, Record<string, Operation> & { parameters?: Parameter[] }>; components?: { schemas?: Record<string, Schema> } }

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const METHOD_TONE: Record<string, BadgeTone> = { get: 'info', post: 'success', put: 'warning', patch: 'warning', delete: 'danger' }

export default function ApiReferencePanel({ url }: { url: string }) {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [filter, setFilter] = useState('')
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetch(url, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'You are not allowed to read the API document.' : `The API document could not be loaded (HTTP ${res.status}).`)
        return (await res.json()) as OpenApiDoc
      })
      .then((d) => !cancelled && setDoc(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'The API document could not be loaded.'))
    return () => {
      cancelled = true
    }
  }, [url, reload])

  const groups = useMemo(() => {
    if (!doc) return []
    const q = filter.trim().toLowerCase()
    const byTag = new Map<string, { method: string; path: string; op: Operation; shared: Parameter[] }[]>()
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of METHODS) {
        const op = item[method] as Operation | undefined
        if (!op) continue
        if (q && ![method, path, op.summary, op.description, op.operationId, ...(op.tags ?? [])].some((s) => s?.toLowerCase().includes(q))) continue
        const tag = op.tags?.[0] ?? 'Endpoints'
        if (!byTag.has(tag)) byTag.set(tag, [])
        byTag.get(tag)!.push({ method, path, op, shared: item.parameters ?? [] })
      }
    }
    return [...byTag.entries()]
  }, [doc, filter])

  if (error) return <ErrorState title="API reference unavailable" description={error} onRetry={() => setReload((n) => n + 1)} />
  if (!doc) return <Skeleton className="h-96" />

  const count = groups.reduce((n, [, ops]) => n + ops.length, 0)
  return (
    <div className="flex flex-col gap-4" data-testid="api-reference">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-[15px] font-bold text-ink">{doc.info?.title ?? 'API reference'}</h2>
          {doc.info?.version && <Badge>v{doc.info.version}</Badge>}
          <Badge tone="brand">OpenAPI {doc.openapi}</Badge>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <PasswordField
            label="API key (for “Try it”)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="oic_live_…"
            autoComplete="new-password"
            spellCheck={false}
            hint="Kept in memory only, never saved, sent only to this site's own API, and cleared when you leave this tab."
            data-testid="api-reference-key"
          />
          <SearchField value={filter} onChange={setFilter} placeholder="Filter endpoints" aria-label="Filter endpoints" className="self-end" />
        </div>
      </Card>
      {count === 0 && <p className="text-[13px] text-ink-secondary">No endpoint matches “{filter}”.</p>}
      {groups.map(([tag, ops]) => (
        <section key={tag} className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold tracking-wide text-ink-secondary uppercase">{tag}</h3>
          {ops.map(({ method, path, op, shared }) => (
            <OperationCard key={`${method} ${path}`} doc={doc} method={method} path={path} op={op} shared={shared} apiKey={apiKey} />
          ))}
        </section>
      ))}
    </div>
  )
}

function OperationCard({ doc, method, path, op, shared, apiKey }: { doc: OpenApiDoc; method: string; path: string; op: Operation; shared: Parameter[]; apiKey: string }) {
  const [open, setOpen] = useState(false)
  const params = mergeParams(shared, op.parameters ?? [])
  const body = firstMedia(op.requestBody?.content)
  return (
    <Card className="overflow-hidden p-0" as="article">
      <div data-testid="api-operation" data-method={method} data-path={path}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-navy-900/[0.03]">
          <Badge tone={METHOD_TONE[method] ?? 'neutral'} className="w-16 justify-center uppercase">{method}</Badge>
          <span className="min-w-0 flex-1">
            <code className="block font-mono text-[13px] font-semibold break-all text-ink">{path}</code>
            {op.summary && <span className="block text-[12.5px] text-ink-secondary">{op.summary}</span>}
          </span>
          <ChevronDown className={cn('size-4 shrink-0 text-ink-secondary transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {open && (
          <div className="flex flex-col gap-4 border-t border-navy-900/10 px-4 py-4">
            {op.description && <p className="text-[13px] whitespace-pre-line text-ink-secondary">{op.description}</p>}
            {params.length > 0 && (
              <Block title="Parameters">
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full text-left text-[12.5px]">
                    <thead className="text-ink-secondary">
                      <tr><th className="py-1 pr-3 font-semibold">Name</th><th className="py-1 pr-3 font-semibold">In</th><th className="py-1 pr-3 font-semibold">Type</th><th className="py-1 font-semibold">Description</th></tr>
                    </thead>
                    <tbody>
                      {params.map((p) => (
                        <tr key={`${p.in}:${p.name}`} className="border-t border-navy-900/5 align-top">
                          <td className="py-1.5 pr-3 font-mono text-ink">{p.name}{p.required && <span className="text-danger" title="required"> *</span>}</td>
                          <td className="py-1.5 pr-3 text-ink-secondary">{p.in}</td>
                          <td className="py-1.5 pr-3 font-mono text-ink-secondary">{typeLabel(doc, p.schema)}</td>
                          <td className="py-1.5 text-ink-secondary">{p.description ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Block>
            )}
            {body && (
              <Block title={`Request body (${body.type})${op.requestBody?.required ? ' – required' : ''}`}>
                <SchemaView doc={doc} schema={body.schema} />
              </Block>
            )}
            {op.responses && (
              <Block title="Responses">
                <div className="flex flex-col gap-2">
                  {Object.entries(op.responses).map(([code, r]) => {
                    const m = firstMedia(r.content)
                    return (
                      <details key={code} className="rounded-md border border-navy-900/10 px-3 py-2">
                        <summary className="cursor-pointer text-[12.5px]">
                          <Badge tone={code.startsWith('2') ? 'success' : code.startsWith('4') ? 'warning' : code.startsWith('5') ? 'danger' : 'neutral'}>{code}</Badge>{' '}
                          <span className="text-ink-secondary">{r.description}</span>
                          {m && <span className="ml-2 font-mono text-[11.5px] text-ink-secondary">{m.type}</span>}
                        </summary>
                        {m?.schema && <div className="mt-2"><SchemaView doc={doc} schema={m.schema} /></div>}
                      </details>
                    )
                  })}
                </div>
              </Block>
            )}
            <TryIt doc={doc} method={method} path={path} params={params} body={body} apiKey={apiKey} />
          </div>
        )}
      </div>
    </Card>
  )
}

function TryIt({ doc, method, path, params, body, apiKey }: { doc: OpenApiDoc; method: string; path: string; params: Parameter[]; body: { type: string; schema?: Schema; example?: unknown } | null; apiKey: string }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [bodyText, setBodyText] = useState(() => (body ? JSON.stringify(body.example ?? exampleFor(doc, body.schema), null, 2) : ''))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ status: number; statusText: string; ms: number; contentType: string; text: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const missing = params.filter((p) => p.required && !values[`${p.in}:${p.name}`]?.trim()).map((p) => p.name)
  const requestPath = buildPath(path, params, values)
  const fullUrl = `${window.location.origin}${import.meta.env.BASE_URL}${requestPath.replace(/^\//, '')}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  for (const p of params) if (p.in === 'header' && values[`header:${p.name}`]?.trim()) headers[p.name] = values[`header:${p.name}`].trim()
  const sendsBody = !!body && method !== 'get' && bodyText.trim() !== ''
  if (sendsBody) headers['Content-Type'] = body!.type

  const curl = [
    `curl -X ${method.toUpperCase()} "${fullUrl}"`,
    ...Object.entries(headers).map(([k, v]) => `  -H "${k}: ${k === 'Authorization' ? 'Bearer <API key>' : v}"`),
    ...(sendsBody ? [`  -d '${bodyText.replace(/'/g, "'\\''")}'`] : []),
  ].join(' \\\n')

  async function send() {
    setBusy(true)
    setFailure(null)
    setResult(null)
    if (!isOwnExternalApi(fullUrl)) {
      setFailure('Blocked: requests can only go to this site’s own external API.')
      setBusy(false)
      return
    }
    const started = performance.now()
    try {
      // Security: the API key goes only to this site's /api/ext endpoints; the signed-in session cookie is never sent (credentials: 'omit');
      // no redirects are followed (the key cannot be carried elsewhere); nothing is cached and no referrer is sent.
      const res = await fetch(fullUrl, {
        method: method.toUpperCase(),
        headers,
        body: sendsBody ? bodyText : undefined,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
      const contentType = res.headers.get('content-type') ?? ''
      let text: string
      if (/json|text|xml/.test(contentType) || contentType === '') {
        text = await res.text()
        if (contentType.includes('json')) {
          try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* show as sent */ }
        }
      } else {
        const blob = await res.blob()
        text = `<${contentType}, ${blob.size.toLocaleString()} bytes - binary content not shown>`
      }
      setResult({ status: res.status, statusText: res.statusText, ms: Math.round(performance.now() - started), contentType, text })
    } catch {
      setFailure('The request could not be sent. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Block title="Try it">
      <div className="flex flex-col gap-3" data-testid="api-try-it">
        {params.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {params.map((p) => (
              <TextField
                key={`${p.in}:${p.name}`}
                label={`${p.name}${p.required ? ' *' : ''} (${p.in})`}
                value={values[`${p.in}:${p.name}`] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [`${p.in}:${p.name}`]: e.target.value }))}
                placeholder={typeLabel(doc, p.schema)}
              />
            ))}
          </div>
        )}
        {body && method !== 'get' && (
          <TextAreaField label={`Body (${body.type})`} value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={Math.min(18, Math.max(4, bodyText.split('\n').length))} className="font-mono text-[12.5px]" spellCheck={false} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={send} disabled={busy || missing.length > 0} data-testid="api-try-send">
            <Play className="size-4" /> {busy ? 'Sending…' : 'Send request'}
          </Button>
          {!apiKey && <span className="text-[12px] text-ink-secondary">Without an API key the API answers 401.</span>}
          {missing.length > 0 && <span className="text-[12px] text-warning-ink">Required: {missing.join(', ')}</span>}
        </div>
        <Pre label="curl">{curl}</Pre>
        {failure && <p className="text-[12.5px] text-danger">{failure}</p>}
        {result && (
          <div className="flex flex-col gap-1.5" data-testid="api-try-result">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <Badge tone={result.status < 300 ? 'success' : result.status < 500 ? 'warning' : 'danger'}>{result.status} {result.statusText}</Badge>
              <span className="text-ink-secondary">{result.ms} ms</span>
              {result.contentType && <span className="font-mono text-ink-secondary">{result.contentType}</span>}
            </div>
            <Pre label="response">{result.text || '(empty body)'}</Pre>
          </div>
        )}
      </div>
    </Block>
  )
}

function SchemaView({ doc, schema, depth = 0, seen = [] }: { doc: OpenApiDoc; schema?: Schema; depth?: number; seen?: string[] }) {
  if (!schema) return null
  const ref = schema.$ref ?? unwrapNullable(schema)?.$ref
  const name = ref?.split('/').pop()
  if (ref && seen.includes(ref)) return <span className="font-mono text-[12px] text-ink-secondary">{name} (recursive)</span>
  const s = resolve(doc, schema)
  const nextSeen = ref ? [...seen, ref] : seen
  const props = s.properties ? Object.entries(s.properties) : []
  const items = s.items ? resolve(doc, s.items) : null
  return (
    <div className={cn('text-[12.5px]', depth === 0 && 'scrollbar-thin overflow-x-auto rounded-md bg-navy-900/[0.03] p-3')}>
      {depth === 0 && <div className="mb-1 font-mono font-semibold text-ink">{name ?? typeLabel(doc, schema)}</div>}
      {s.description && <p className="mb-1 text-ink-secondary">{s.description}</p>}
      {props.length > 0 && (
        <ul className="flex flex-col gap-1 border-l border-navy-900/10 pl-3">
          {props.map(([key, child]) => {
            const c = resolve(doc, child)
            const nested = (c.properties && Object.keys(c.properties).length > 0) || (c.items && resolve(doc, c.items).properties)
            return (
              <li key={key}>
                <span className="font-mono text-ink">{key}</span>
                {s.required?.includes(key) && <span className="text-danger" title="required"> *</span>}
                <span className="ml-2 font-mono text-ink-secondary">{typeLabel(doc, child)}</span>
                {c.enum && <span className="ml-2 text-ink-secondary">one of: {c.enum.map(String).join(', ')}</span>}
                {c.description && <span className="block text-ink-secondary">{c.description}</span>}
                {nested && depth < 6 && <SchemaView doc={doc} schema={child} depth={depth + 1} seen={nextSeen} />}
              </li>
            )
          })}
        </ul>
      )}
      {props.length === 0 && items?.properties && depth < 6 && <SchemaView doc={doc} schema={s.items} depth={depth + 1} seen={nextSeen} />}
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[12px] font-semibold tracking-wide text-ink-secondary uppercase">{title}</h4>
      {children}
    </div>
  )
}

function Pre({ label, children }: { label: string; children: string }) {
  return (
    <div className="relative">
      <span className="absolute top-2 left-3 text-[10.5px] font-semibold tracking-wide text-white/40 uppercase">{label}</span>
      <pre className="scrollbar-thin max-h-96 overflow-auto rounded-md bg-[#0f1b2d] p-4 pt-7 pr-24 text-[12.5px] leading-5 text-[#e6edf7]"><code>{children}</code></pre>
      <CopyButton text={children} className="absolute top-2 right-2" />
    </div>
  )
}

// ---- OpenAPI helpers -------------------------------------------------------------------------------------------------

function mergeParams(shared: Parameter[], own: Parameter[]) {
  const map = new Map<string, Parameter>()
  for (const p of [...shared, ...own]) map.set(`${p.in}:${p.name}`, p)
  return [...map.values()].filter((p) => p.in !== 'cookie')
}

function firstMedia(content?: Media) {
  if (!content) return null
  const type = Object.keys(content).find((t) => t.includes('json')) ?? Object.keys(content)[0]
  return type ? { type, schema: content[type].schema, example: content[type].example } : null
}

/** `oneOf: [{type:null}, X]` (how .NET marks nullable references) → X. */
function unwrapNullable(s: Schema): Schema | undefined {
  const alts = s.oneOf ?? s.anyOf
  if (!alts) return undefined
  const nonNull = alts.filter((a) => a.type !== 'null')
  return nonNull.length === 1 ? nonNull[0] : undefined
}

function resolve(doc: OpenApiDoc, s: Schema, hops = 0): Schema {
  if (hops > 10) return s
  if (s.$ref) {
    const target = s.$ref.startsWith('#/components/schemas/') ? doc.components?.schemas?.[s.$ref.slice('#/components/schemas/'.length)] : undefined
    return target ? resolve(doc, target, hops + 1) : s
  }
  const inner = unwrapNullable(s)
  if (inner) return resolve(doc, inner, hops + 1)
  if (s.allOf?.length) return s.allOf.reduce<Schema>((acc, part) => {
    const r = resolve(doc, part, hops + 1)
    return { ...acc, ...r, properties: { ...acc.properties, ...r.properties }, required: [...(acc.required ?? []), ...(r.required ?? [])] }
  }, {})
  return s
}

function typeLabel(doc: OpenApiDoc, schema?: Schema): string {
  if (!schema) return 'any'
  const ref = schema.$ref ?? unwrapNullable(schema)?.$ref
  if (ref) return ref.split('/').pop()!
  const s = resolve(doc, schema)
  const types = (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []).filter((t) => t !== 'null')
  // .NET emits integers as ["integer","string"] with a numeric pattern - show the meaningful one.
  const main = types.includes('integer') ? 'integer' : types.includes('number') ? 'number' : types[0]
  if (main === 'array') return `${s.items ? typeLabel(doc, s.items) : 'any'}[]`
  if (!main) return s.properties ? 'object' : 'any'
  return s.format && main !== 'integer' ? `${main} (${s.format})` : main
}

function exampleFor(doc: OpenApiDoc, schema?: Schema, depth = 0): unknown {
  if (!schema || depth > 6) return null
  const s = resolve(doc, schema)
  if (s.example !== undefined) return s.example
  if (s.enum?.length) return s.enum[0]
  const t = typeLabel(doc, s)
  if (s.properties) return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, exampleFor(doc, v, depth + 1)]))
  if (t.endsWith('[]')) return s.items ? [exampleFor(doc, s.items, depth + 1)] : []
  if (t === 'integer' || t === 'number') return 0
  if (t === 'boolean') return false
  if (t.includes('date-time')) return new Date().toISOString()
  if (t.startsWith('string')) return 'string'
  return null
}

/**
 * True only for this site's own external API: same origin and under <base>/api/ext/. The URL parser has already resolved
 * "." / ".." (also "%2e") segments, and path parameters are encodeURIComponent-ed, so a typed value cannot step outside it.
 */
function isOwnExternalApi(href: string) {
  try {
    const u = new URL(href)
    return u.origin === window.location.origin && u.pathname.startsWith(`${import.meta.env.BASE_URL}api/ext/`)
  } catch {
    return false
  }
}

function buildPath(path: string, params: Parameter[], values: Record<string, string>) {
  let out = path.replace(/\{([^}]+)\}/g, (m, name: string) => {
    const v = values[`path:${name}`]?.trim()
    return v ? encodeURIComponent(v) : m
  })
  const qs = new URLSearchParams()
  for (const p of params) if (p.in === 'query' && values[`query:${p.name}`]?.trim()) qs.set(p.name, values[`query:${p.name}`].trim())
  const q = qs.toString()
  if (q) out += `?${q}`
  return out
}
