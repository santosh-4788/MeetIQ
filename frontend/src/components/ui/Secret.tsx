import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Download, KeyRound, ShieldAlert } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button } from './Button'

// One-time secrets (one-time passwords, recovery codes) live only in component state: they are
// never written to localStorage/sessionStorage and never logged.

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for non-secure contexts (e.g. http://intranet-host): a hidden textarea + execCommand.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

export function CopyButton({ text, label = 'Copy', size = 'sm', variant = 'secondary', className }: { text: string; label?: string; size?: 'sm' | 'md'; variant?: 'secondary' | 'subtle'; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  async function copy() {
    setState((await writeClipboard(text)) ? 'copied' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 2000)
  }
  return (
    <Button variant={variant} size={size} className={className} onClick={() => void copy()} leftIcon={state === 'copied' ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}>
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}</span>
    </Button>
  )
}

/** Saves text as a local file (e.g. recovery codes, CSV template) without any server round trip. */
export function downloadTextFile(filename: string, text: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function DownloadButton({ filename, text, label = 'Download .txt' }: { filename: string; text: string; label?: string }) {
  return (
    <Button variant="secondary" size="sm" leftIcon={<Download className="size-4" />} onClick={() => downloadTextFile(filename, text)}>
      {label}
    </Button>
  )
}

/** "Shown once" warning box used next to one-time passwords and recovery codes. */
export function ShownOnceNotice({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex gap-3 rounded-md border border-warning/30 bg-warning-soft px-3.5 py-3 text-[13px] text-warning-ink">
      <ShieldAlert className="mt-0.5 size-[18px] shrink-0 text-warning" aria-hidden />
      <div className="leading-5">{children}</div>
    </div>
  )
}

/** A one-time password: monospace value + copy button + "shown once" warning. */
export function OneTimePassword({ value, account }: { value: string; account?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <ShownOnceNotice>
        <strong className="font-semibold">This password is shown only once.</strong> Copy it now and hand it to the user through a secure channel. They must change it at their first sign-in.
      </ShownOnceNotice>
      <div className="rounded-md border border-line bg-surface-muted p-4">
        {account && <p className="mb-2 text-[12.5px] text-ink-secondary">Account: <span className="font-semibold text-ink">{account}</span></p>}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex min-w-0 items-center gap-2">
            <KeyRound className="size-4 shrink-0 text-brand-500" aria-hidden />
            <code className="break-all font-mono text-[16px] font-semibold tracking-wide text-ink select-all" aria-label="One-time password">
              {value}
            </code>
          </p>
          <CopyButton text={value} label="Copy password" />
        </div>
      </div>
    </div>
  )
}

/** The 10 recovery codes in a two-column grid with copy and download. */
export function RecoveryCodeList({ codes, className }: { codes: string[]; className?: string }) {
  const text = [
    'OneInsure Connect: two-factor authentication recovery codes',
    `Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
    'Each code can be used once. Keep them somewhere safe.',
    '',
    ...codes,
    '',
  ].join('\r\n')
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <ol className="grid grid-cols-1 gap-2 rounded-md border border-line bg-surface-muted p-4 min-[400px]:grid-cols-2" aria-label="Recovery codes">
        {codes.map((c, i) => (
          <li key={c} className="flex items-center gap-2 font-mono text-[14px] font-semibold tracking-wide text-ink tabular-nums">
            <span className="w-5 text-right text-[11.5px] font-medium text-ink-muted">{i + 1}.</span>
            <span className="select-all">{c}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <CopyButton text={codes.join('\n')} label="Copy codes" />
        <DownloadButton filename="oneinsure-connect-recovery-codes.txt" text={text} />
      </div>
    </div>
  )
}
