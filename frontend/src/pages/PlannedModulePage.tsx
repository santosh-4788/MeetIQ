import { useLocation } from 'react-router-dom'
import { ArrowLeft, Construction, Video } from 'lucide-react'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Feedback'
import { ButtonLink } from '../components/ui/Button'
import { allNavItems } from '../layouts/navigation'

const extraPages: Record<string, { label: string; phase: number; planned: string[] }> = {
  '/room': {
    label: 'Video Meeting Room',
    phase: 4,
    planned: ['Pre-join camera/microphone check', 'Active speaker and grid layouts', 'Mic, camera, screen share, chat, participants, full screen', 'Waiting room with admit/reject', 'Host controls and recording/consent indicators', 'Network quality and automatic reconnection'],
  },
}

/**
 * Honest placeholder for modules scheduled in later phases. It states what is NOT built yet
 * instead of showing fake, non-functional UI.
 */
export function PlannedModulePage() {
  const { pathname } = useLocation()
  const nav = allNavItems.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
  const extra = Object.entries(extraPages).find(([p]) => pathname.startsWith(p))?.[1]
  // Built modules (no `phase`) reach this page only for an unknown sub-path: that is "not found", not "planned".
  const page = extra ?? (nav?.phase ? { label: nav.label, phase: nav.phase, planned: nav.planned ?? [] } : null)
  const Icon = nav?.icon ?? Video

  return (
    <Card className="mx-auto max-w-3xl overflow-hidden">
      <div className="relative bg-gradient-canvas px-6 pt-8 pb-6 sm:px-10">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-brand-500 text-white shadow-raised">
            <Icon className="size-6" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] leading-8 font-bold text-ink">{page?.label ?? 'Page not found'}</h1>
              {page && <Badge tone="warning" dot>Not yet implemented</Badge>}
            </div>
            <p className="mt-1 text-[13.5px] text-ink-secondary">
              {page
                ? `This module is scheduled for Phase ${page.phase} of the delivery roadmap. It is not available yet; the current release covers sign-in security, the employee and organisation masters (Phase 2) and meeting scheduling, calendar and notifications (Phase 3).`
                : 'The page you requested does not exist.'}
            </p>
          </div>
        </div>
      </div>
      {page && page.planned.length > 0 && (
        <div className="px-6 py-6 sm:px-10">
          <p className="eyebrow mb-3 flex items-center gap-1.5 text-ink-muted">
            <Construction className="size-3.5" /> Planned scope
          </p>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {page.planned.map((p) => (
              <li key={p} className="flex items-start gap-2.5 rounded-md border border-line bg-surface-muted px-3.5 py-2.5 text-[13px] text-ink">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-brand-500" />
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border-t border-line px-6 py-4 sm:px-10">
        <ButtonLink to="/dashboard" variant="secondary" size="sm" leftIcon={<ArrowLeft className="size-4" />}>
          Back to dashboard
        </ButtonLink>
      </div>
    </Card>
  )
}
