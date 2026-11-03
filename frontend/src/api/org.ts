import { http } from './http'
import { query } from './types'

// Organisation masters: /api/v1/org. Read: any signed-in user; write: org.manage. Masters are addressed by `code` (immutable).

type Master = { code: string; name: string; isActive: boolean }

export type Department = Master & { parentCode: string | null; headEmployeeId: string | null; headName: string | null; employeeCount: number }
export type Designation = Master & { level: number | null; employeeCount: number }
export type Branch = Master & { city: string | null; state: string | null; timeZoneId: string | null; address: string | null; employeeCount: number }
export type Team = Master & {
  departmentCode: string
  departmentName: string
  teamLeaderId: string | null
  teamLeaderName: string | null
  memberCount: number
}
export type TeamMember = { id: string; employeeCode: string; displayName: string; designation: string }

export type DepartmentInput = { code: string; name: string; parentCode?: string | null; headEmployeeId?: string | null }
export type DesignationInput = { code: string; name: string; level?: number | null }
export type BranchInput = { code: string; name: string; city?: string | null; state?: string | null; timeZoneId?: string | null; address?: string | null }
export type TeamInput = { code: string; name: string; departmentCode: string; teamLeaderId?: string | null }

export type OrgResources = {
  departments: { item: Department; input: DepartmentInput }
  designations: { item: Designation; input: DesignationInput }
  branches: { item: Branch; input: BranchInput }
  teams: { item: Team; input: TeamInput }
}
export type OrgKind = keyof OrgResources

const path = (kind: OrgKind, code?: string) => `/org/${kind}${code ? `/${encodeURIComponent(code)}` : ''}`

export const orgApi = {
  list: <K extends OrgKind>(kind: K, includeInactive = false) =>
    http<OrgResources[K]['item'][]>(`${path(kind)}${query({ includeInactive: includeInactive || undefined })}`),
  create: <K extends OrgKind>(kind: K, body: OrgResources[K]['input']) => http<{ code: string }>(path(kind), { method: 'POST', body }),
  update: <K extends OrgKind>(kind: K, code: string, body: OrgResources[K]['input']) => http<void>(path(kind, code), { method: 'PUT', body }),
  setActive: (kind: OrgKind, code: string, active: boolean) =>
    http<void>(`${path(kind, code)}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' }),
  teamMembers: (code: string) => http<TeamMember[]>(`${path('teams', code)}/members`),
  setTeamMembers: (code: string, employeeIds: string[]) => http<void>(`${path('teams', code)}/members`, { method: 'PUT', body: { employeeIds } }),
}
