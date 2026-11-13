import { lazy, Suspense, useState, type ReactNode } from 'react'
import { BookOpen, Code2, Download, KeyRound, Lock } from 'lucide-react'
import { absoluteUrl, EXT_API_BASE, OPENAPI_URL } from '../../api/integrations'
import { PageHeader, Tabs, tabPanelProps } from '../../components/ui/Data'
import { Skeleton } from '../../components/ui/Feedback'
import { CopyButton } from '../../components/ui/Secret'
import { buttonClass } from '../../components/ui/Button'
import { useAuth } from '../../auth/AuthContext'
import { ApiGuide } from './ApiGuide'
import { IntegrationsPanel } from './IntegrationsPanel'

const SwaggerPanel = lazy(() => import('./SwaggerPanel'))

type Tab = 'guide' | 'reference' | 'integrations'

/**
 * Organisation → System → API Documentation. Visible only with api.docs.view (Admin and Super Admin; anyone else when an administrator
 * adds the "API Documentation Viewer" role - V025). The guide is complete on its own; the Swagger tab is generated from the API itself.
 * Creating integrations and API keys stays with integrations.manage.
 */
export function ApiDocsPage() {
  const { can } = useAuth()
  const canManageKeys = can('integrations.manage')
  const [tab, setTab] = useState<Tab>('guide')
  const baseUrl = absoluteUrl(EXT_API_BASE)
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'guide', label: 'Integration guide', icon: <BookOpen className="size-4" /> },
    { id: 'reference', label: 'API reference (Swagger)', icon: <Code2 className="size-4" /> },
    ...(canManageKeys ? [{ id: 'integrations' as Tab, label: 'Integrations & API keys', icon: <KeyRound className="size-4" /> }] : []),
  ]
  return (
    <div className="flex flex-col gap-5" data-testid="api-docs-page">
      <PageHeader
        title="API Documentation"
        description="Everything another portal needs to create OneInsure Connect meetings, share the links, follow the meeting and collect the report and recordings — from its own interface."
        actions={
          <>
            <a className={buttonClass({ variant: 'secondary' })} href={OPENAPI_URL} download="oneinsure-connect-openapi-v1.json" data-testid="download-openapi">
              <Download className="size-4" /> Download OpenAPI (JSON)
            </a>
            <CopyButton text={baseUrl} label="Copy base URL" size="md" />
          </>
        }
      />
      <p className="-mt-2 inline-flex items-center gap-1.5 text-[12px] text-ink-secondary" data-testid="api-docs-access">
        <Lock className="size-3.5" aria-hidden />
        Visible only to administrators and to people given the <strong className="text-ink">API Documentation Viewer</strong> role (Administration → Users &amp; roles).
        {!canManageKeys && ' API keys are issued by an administrator.'}
      </p>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="API documentation" idPrefix="apidocs" />
      <div {...tabPanelProps('apidocs', tab)}>
        {tab === 'guide' && <ApiGuide baseUrl={baseUrl} openApiUrl={absoluteUrl(OPENAPI_URL)} canManageKeys={canManageKeys} onOpenKeys={() => setTab('integrations')} />}
        {tab === 'reference' && (
          <Suspense fallback={<Skeleton className="h-96" />}>
            <SwaggerPanel url={OPENAPI_URL} />
          </Suspense>
        )}
        {tab === 'integrations' && canManageKeys && <IntegrationsPanel />}
      </div>
    </div>
  )
}
