import { http } from './http'

/** Organisation → System → API Documentation → Integrations (permission integrations.manage). */
export type Integration = {
  id: string
  integrationId: string
  name: string
  portalName: string
  description: string | null
  isActive: boolean
  rateLimitPerMinute: number
  defaultHost: { id: string; name: string } | null
  lastUsedUtc: string | null
  createdUtc: string
  scopes: string[]
  activeKeys: number
  meetings: number
  webhook: { url: string; active: boolean; events: string[] } | null
}
export type ApiKeyInfo = {
  id: string
  prefix: string
  createdUtc: string
  createdBy: string | null
  revokedUtc: string | null
  revokedReason: string | null
  lastUsedUtc: string | null
  lastUsedIp: string | null
  active: boolean
}
export type IntegrationInput = { name?: string; portalName?: string; description?: string | null; scopes?: string[]; rateLimitPerMinute?: number; isActive?: boolean }
export type RequestLogItem = { utc: string; method: string; path: string; status: number; durationMs: number; ip: string | null; error: string | null }
export type DeliveryItem = {
  id: number
  eventId: string
  eventType: string
  status: 'PENDING' | 'DELIVERED' | 'FAILED'
  attempts: number
  createdUtc: string
  lastAttemptUtc: string | null
  lastStatusCode: number | null
  lastError: string | null
  deliveredUtc: string | null
  nextAttemptUtc: string | null
}

const base = '/admin/integrations'
export const integrationsApi = {
  list: () => http<{ items: Integration[]; scopes: string[]; events: string[] }>(base),
  get: (id: string) => http<{ integration: Integration; keys: ApiKeyInfo[] }>(`${base}/${id}`),
  create: (body: IntegrationInput) => http<{ integration: Integration; apiKey: string; keyNotice: string }>(base, { method: 'POST', body }),
  update: (id: string, body: IntegrationInput) => http<{ integration: Integration }>(`${base}/${id}`, { method: 'PUT', body }),
  newKey: (id: string) => http<{ apiKey: string; prefix: string }>(`${base}/${id}/keys`, { method: 'POST' }),
  rotateKey: (id: string) => http<{ apiKey: string; prefix: string; revokedKeys: number }>(`${base}/${id}/keys/rotate`, { method: 'POST' }),
  revokeKey: (id: string, keyId: string, reason: string) => http<void>(`${base}/${id}/keys/${keyId}/revoke`, { method: 'POST', body: { reason } }),
  logs: (id: string, page = 1) => http<{ total: number; page: number; items: RequestLogItem[] }>(`${base}/${id}/logs?page=${page}`),
  deliveries: (id: string) => http<{ items: DeliveryItem[] }>(`${base}/${id}/webhook/deliveries`),
  saveWebhook: (id: string, body: { url: string; events: string[]; active: boolean; rotateSecret?: boolean }) =>
    http<{ url: string; events: string[]; active: boolean; secret: string | null }>(`${base}/${id}/webhook`, { method: 'PUT', body }),
  testWebhook: (id: string) => http<{ eventId: string }>(`${base}/${id}/webhook/test`, { method: 'POST' }),
  retryDelivery: (deliveryId: number) => http<void>(`${base}/webhook/deliveries/${deliveryId}/retry`, { method: 'POST' }),
}

/** The external API, as the browser reaches it (same origin, under the app's base path). */
export const EXT_API_BASE = `${import.meta.env.BASE_URL}api/ext/v1`
export const OPENAPI_URL = `${import.meta.env.BASE_URL}api/ext/openapi/ext-v1.json`
export const absoluteUrl = (path: string) => `${window.location.origin}${path}`
