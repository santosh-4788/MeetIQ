import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, MonitorUp, ShieldCheck, Smartphone } from 'lucide-react'
import { AuthCard, AuthHeading } from '../layouts/AuthLayout'
import { inAndroidApp } from './room/androidBridge'

/** Published next to the APK on our own server (frontend/public/app/android.json). */
type AppInfo = { versionCode: number; versionName: string; url: string; sizeMb?: number; sha256?: string; minAndroid?: string; released?: string }

/**
 * /get-app (public): the OneInsure Connect Android app, downloaded from our own server (no store, no paid service).
 * The app adds what phone browsers cannot do: presenting the phone screen, and keeping the call going while another app
 * is open. iPhones keep using the browser (presenting works there from iOS 27.2).
 */
export function AppDownloadPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}app/android.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: AppInfo) => setInfo(j))
      .catch(() => setFailed(true))
  }, [])
  const iphone = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  const step = 'flex gap-3 text-[13.5px] leading-[21px] text-ink-secondary'
  const num = 'flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[12px] font-bold text-brand-600'

  return (
    <AuthCard wide>
      <AuthHeading icon={<Smartphone className="size-6" />} title="OneInsure Connect for Android"
        description="Join meetings from your phone and present your phone screen - which phone browsers cannot do." />
      {inAndroidApp() ? (
        <p className="rounded-md bg-success-soft px-3.5 py-3 text-[13.5px] text-success" data-testid="app-already">You are using the app{info ? ` (latest version ${info.versionName})` : ''}.</p>
      ) : failed ? (
        <p className="rounded-md bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-ink">The download is not available right now. Please try again later.</p>
      ) : (
        <a href={info?.url ?? '#'} aria-disabled={!info} data-testid="app-download"
          className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-brand-600 text-[15px] font-semibold text-white shadow-[0_8px_20px_-8px_rgb(37_99_235/0.7)] hover:bg-brand-700 aria-disabled:pointer-events-none aria-disabled:opacity-60">
          <Download className="size-5" /> Download for Android{info ? ` · ${info.versionName}${info.sizeMb ? ` · ${info.sizeMb} MB` : ''}` : ''}
        </a>
      )}

      <ol className="mt-5 flex flex-col gap-3">
        <li className={step}><span className={num}>1</span>Open this page on your Android phone (Android {info?.minAndroid ?? '8'} or newer) and tap Download.</li>
        <li className={step}><span className={num}>2</span>Open the downloaded file. If asked, allow your browser to "install unknown apps" (Settings → Apps → Chrome → Install unknown apps), then tap Install.</li>
        <li className={step}><span className={num}>3</span>Open OneInsure Connect and sign in, or open a meeting link - it opens in the app.</li>
      </ol>

      <div className="mt-5 flex flex-col gap-2.5 rounded-md border border-line bg-surface-muted p-3.5 text-[12.5px] leading-5 text-ink-secondary">
        <p className="flex gap-2"><MonitorUp className="mt-0.5 size-4 shrink-0 text-brand-600" /><span className="min-w-0">In a meeting, tap More (⋯) → Present, then Start now. A notification shows while your screen is shared; tap Stop there or in the meeting.</span></p>
        <p className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-600" />
          <span className="min-w-0">Downloaded only from oneinsure.com. The app opens only OneInsure Connect pages and sends your screen only to our own server.
            {info?.sha256 ? <> File check (SHA-256): <code className="break-all text-[11px]">{info.sha256}</code></> : null}</span>
        </p>
      </div>

      {iphone && (
        <p className="mt-4 text-[12.5px] leading-5 text-ink-secondary" data-testid="app-iphone">
          iPhone: no app is needed - use Safari or Chrome. Presenting works from iOS 27.2 (More → Present).
        </p>
      )}
      <p className="mt-4 text-center text-[13px]"><Link to="/login" className="font-semibold text-brand-600 hover:underline">Back to sign in</Link></p>
    </AuthCard>
  )
}
