import { useRef, useState } from 'react'
import { CircleCheck, Download, FileSpreadsheet, FileUp, RotateCcw } from 'lucide-react'
import { employeesApi, type ImportAction, type ImportResult } from '../../api/employees'
import { Button } from '../../components/ui/Button'
import { table } from '../../components/ui/Data'
import { Alert, Badge, type BadgeTone } from '../../components/ui/Feedback'
import { Switch } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { downloadTextFile } from '../../components/ui/Secret'
import { cn } from '../../lib/cn'

const MAX_BYTES = 2 * 1024 * 1024
const actionMeta: Record<ImportAction, { label: string; tone: BadgeTone }> = {
  CREATE: { label: 'Create', tone: 'success' },
  UPDATE: { label: 'Update', tone: 'info' },
  ERROR: { label: 'Error', tone: 'danger' },
}

/**
 * CSV import: template → choose file (read in the browser) → dry run with a per-row report →
 * apply only when no row has errors (the server applies all-or-nothing).
 */
export function EmployeeImportDialog({ open, onClose }: { open: boolean; onClose: (applied: boolean) => void }) {
  const [file, setFile] = useState<{ name: string; size: number; csv: string } | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [busy, setBusy] = useState<'template' | 'check' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  function reset() {
    setFile(null)
    setResult(null)
    setErrorsOnly(false)
    setError(null)
    if (input.current) input.current.value = ''
  }

  function close() {
    const applied = !!result?.applied
    reset()
    onClose(applied)
  }

  async function downloadTemplate() {
    setBusy('template')
    setError(null)
    try {
      downloadTextFile('employee-import-template.csv', await employeesApi.importTemplate(), 'text/csv;charset=utf-8')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The template could not be downloaded.')
    } finally {
      setBusy(null)
    }
  }

  async function choose(f: File | undefined) {
    setResult(null)
    setError(null)
    if (!f) return setFile(null)
    if (f.size > MAX_BYTES) {
      setFile(null)
      setError('The file is larger than 2 MB. Split it into smaller files (at most 5,000 rows each).')
      return
    }
    try {
      setFile({ name: f.name, size: f.size, csv: await f.text() })
      // Allow re-choosing the same (corrected) file: the change event only fires when the value changes.
      if (input.current) input.current.value = ''
    } catch {
      setError('The file could not be read.')
    }
  }

  async function run(dryRun: boolean) {
    if (!file) return
    setBusy(dryRun ? 'check' : 'apply')
    setError(null)
    try {
      const r = await employeesApi.importCsv(file.csv, dryRun)
      setResult(r)
      setErrorsOnly(r.summary.failed > 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import could not be processed.')
    } finally {
      setBusy(null)
    }
  }

  const rows = result ? (errorsOnly ? result.rows.filter((r) => r.action === 'ERROR') : result.rows) : []
  const canApply = !!result && !result.applied && result.summary.failed === 0 && result.summary.total > 0

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import employees from CSV"
      description="Rows are matched by employee code: new codes are created, existing ones updated."
      size="xl"
      dismissible={!busy}
      footer={
        result?.applied ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button>
            {result && result.summary.failed === 0 ? (
              <Button onClick={() => void run(false)} loading={busy === 'apply'} disabled={!canApply || !!busy} leftIcon={<CircleCheck className="size-4" />}>
                Apply import
              </Button>
            ) : (
              <Button onClick={() => void run(true)} loading={busy === 'check'} disabled={!file || !!busy} leftIcon={<FileSpreadsheet className="size-4" />}>
                Check file
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}

        {!result?.applied && (
          <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <li className="flex flex-col gap-2 rounded-md border border-line bg-surface-muted p-4">
              <p className="text-[13px] font-semibold text-ink">1. Get the template</p>
              <p className="text-[12.5px] text-ink-secondary">Codes for department, designation and branch must already exist. Dates as yyyy-MM-dd.</p>
              <Button variant="secondary" size="sm" className="mt-auto self-start" leftIcon={<Download className="size-4" />} onClick={() => void downloadTemplate()} loading={busy === 'template'}>
                Download template
              </Button>
            </li>
            <li className="flex flex-col gap-2 rounded-md border border-line bg-surface-muted p-4">
              <p className="text-[13px] font-semibold text-ink">2. Choose the file</p>
              <p className="text-[12.5px] text-ink-secondary">CSV, up to 2 MB and 5,000 rows.</p>
              <input ref={input} id="employee-import-file" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void choose(e.target.files?.[0])} />
              <label
                htmlFor="employee-import-file"
                className="mt-auto inline-flex h-8 cursor-pointer items-center gap-1.5 self-start rounded-sm border border-line bg-surface px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-muted focus-within:shadow-focus"
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
              >
                <FileUp className="size-4" /> {file ? 'Choose another file' : 'Choose CSV file'}
              </label>
            </li>
            <li className="flex flex-col gap-2 rounded-md border border-line bg-surface-muted p-4">
              <p className="text-[13px] font-semibold text-ink">3. Check, then apply</p>
              <p className="text-[12.5px] text-ink-secondary">"Check file" is a dry run: nothing is saved. Apply is possible only when every row is valid.</p>
            </li>
          </ol>
        )}

        {file && !result?.applied && (
          <div className="flex items-center gap-3 rounded-md border border-line px-4 py-3">
            <FileSpreadsheet className="size-5 shrink-0 text-brand-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-ink">{file.name}</p>
              <p className="text-[12px] text-ink-secondary">{(file.size / 1024).toLocaleString('en-IN', { maximumFractionDigits: 1 })} KB</p>
            </div>
            <Button variant="ghost" size="sm" leftIcon={<RotateCcw className="size-3.5" />} onClick={reset} disabled={!!busy}>
              Clear
            </Button>
          </div>
        )}

        {result && (
          <>
            {result.applied ? (
              <Alert tone="success" title="Import applied">
                {result.summary.created.toLocaleString('en-IN')} employees created and {result.summary.updated.toLocaleString('en-IN')} updated.
              </Alert>
            ) : result.summary.failed > 0 ? (
              <Alert tone="danger" title={`${result.summary.failed.toLocaleString('en-IN')} row${result.summary.failed === 1 ? '' : 's'} with errors`}>
                Nothing has been saved. Correct the rows below in your file, choose it again and re-check.
              </Alert>
            ) : result.summary.total === 0 ? (
              <Alert tone="warning">The file has no data rows.</Alert>
            ) : (
              <Alert tone="success" title="Every row is valid">
                Dry run only: nothing has been saved yet. Select "Apply import" to save these changes.
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Rows', value: result.summary.total, cls: 'text-ink' },
                { label: 'To create', value: result.summary.created, cls: 'text-success' },
                { label: 'To update', value: result.summary.updated, cls: 'text-info' },
                { label: 'Errors', value: result.summary.failed, cls: result.summary.failed ? 'text-danger' : 'text-ink' },
              ].map((s) => (
                <div key={s.label} className="rounded-md border border-line px-4 py-3">
                  <p className="text-[12px] text-ink-secondary">{s.label}</p>
                  <p className={cn('text-[22px] leading-8 font-bold tabular-nums', s.cls)}>{s.value.toLocaleString('en-IN')}</p>
                </div>
              ))}
            </div>

            {result.rows.length > 0 && (
              <div className="rounded-md border border-line">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
                  <p className="text-[13px] font-semibold text-ink">Row report</p>
                  {result.summary.failed > 0 && <Switch checked={errorsOnly} onChange={setErrorsOnly} label="Errors only" />}
                </div>
                <div className={cn(table.wrap, 'max-h-[40dvh]')}>
                  <table className={cn(table.table, 'min-w-[560px]')}>
                    <thead className="sticky top-0">
                      <tr>
                        <th className={cn(table.th, 'w-16')}>Row</th>
                        <th className={table.th}>Employee code</th>
                        <th className={table.th}>Result</th>
                        <th className={table.th}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.row} className={table.row}>
                          <td className={cn(table.td, 'tabular-nums text-ink-secondary')}>{r.row}</td>
                          <td className={cn(table.td, 'font-medium')}>{r.employeeCode ?? '—'}</td>
                          <td className={table.td}>
                            <Badge tone={actionMeta[r.action].tone}>{actionMeta[r.action].label}</Badge>
                          </td>
                          <td className={table.td}>
                            {Object.keys(r.errors ?? {}).length ? (
                              <ul className="flex flex-col gap-0.5 text-[12.5px] text-danger">
                                {Object.entries(r.errors).map(([field, msg]) => (
                                  <li key={field}>
                                    <span className="font-semibold">{field}:</span> {msg}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
