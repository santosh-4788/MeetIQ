import { FlaskConical } from 'lucide-react'
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../dev/demoAuth'

/** Only rendered when DEMO_MODE is on (dev builds). Lists fictitious demo identities for UI review. */
export function DemoCredentials({ onPick }: { onPick: (login: string, password: string) => void }) {
  return (
    <div className="mt-4 rounded-lg border border-dashed border-warning/50 bg-warning-soft/60 p-4 text-[12.5px] text-warning-ink">
      <p className="flex items-center gap-1.5 font-semibold">
        <FlaskConical className="size-4" /> Demo mode — sample identities (not real accounts)
      </p>
      <ul className="mt-2 space-y-1">
        {DEMO_ACCOUNTS.map((a) => (
          <li key={a.login}>
            <button type="button" className="font-mono font-semibold break-all underline-offset-2 hover:underline" onClick={() => onPick(a.login, DEMO_PASSWORD)}>
              {a.login}
            </button>{' '}
            <span className="opacity-80">— {a.note}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 opacity-80">
        Password: <span className="font-mono font-semibold">{DEMO_PASSWORD}</span> · any other password shows the invalid-login flow.
      </p>
    </div>
  )
}
