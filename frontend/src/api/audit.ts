import { http } from './http'
import { query, type Paged } from './types'

// Audit log viewer: /api/v1/admin/audit (audit.view — ComplianceAuditor, Admin, SuperAdmin). Read-only.

export type AuditEntry = {
  id: number
  utc: string
  actorType: 'USER' | 'CUSTOMER' | 'SYSTEM'
  actorName: string | null
  actorEmail: string | null
  action: string
  entityType: string
  entityId: string | null
  summary: string | null
  ipAddress: string | null
  isPrivileged: boolean
  oldValuesJson: string | null
  newValuesJson: string | null
}

export type AuditFilters = { actions: string[]; entityTypes: string[] }

export const auditApi = {
  list: (q: { from?: string; to?: string; action?: string; entityType?: string; search?: string; privilegedOnly?: boolean; page?: number; pageSize?: number }) =>
    http<Paged<AuditEntry>>(`/admin/audit${query(q)}`),
  filters: () => http<AuditFilters>('/admin/audit/filters'),
}
