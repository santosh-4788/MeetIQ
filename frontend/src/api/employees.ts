import { http } from './http'
import { query, type Paged } from './types'

// Employee master: /api/v1/employees (employees.manage, except lookup). Employees are addressed by `id` (GUID).

export type Employee = {
  id: string
  employeeCode: string
  firstName: string
  lastName: string | null
  displayName: string
  officialEmail: string
  mobile: string | null
  departmentCode: string
  department: string
  designationCode: string
  designation: string
  branchCode: string | null
  branch: string | null
  reportingManagerId: string | null
  reportingManagerName: string | null
  dateOfJoining: string | null
  isActive: boolean
  hasUserAccount: boolean
}

export type EmployeeLookup = { id: string; employeeCode: string; displayName: string; department: string; designation: string }

export type EmployeeDetail = {
  employee: Employee
  teams: { code: string; name: string }[]
  /** `roles` arrives as a comma-separated list of role codes. */
  userAccount: { id: string; email: string; isActive: boolean; mfaEnabled: boolean; lastLoginUtc: string | null; roles: string | string[] | null } | null
  /** No linked account, but an account with the employee's official e-mail exists (it can be linked). */
  matchingAccount?: { id: string; email: string; isActive: boolean; linkedEmployeeName: string | null } | null
  /** Number of active direct reports. */
  directReports: number
}

export type EmployeeInput = {
  employeeCode: string
  firstName: string
  lastName?: string | null
  displayName?: string | null
  officialEmail: string
  mobile?: string | null
  departmentCode: string
  designationCode: string
  branchCode?: string | null
  reportingManagerId?: string | null
  /** yyyy-MM-dd */
  dateOfJoining?: string | null
}

export type EmployeeStatus = 'active' | 'inactive' | 'all'
export type EmployeeSort = 'name' | 'code' | 'joined' | 'department'
export type EmployeeQuery = {
  search?: string
  department?: string
  designation?: string
  branch?: string
  status?: EmployeeStatus
  sort?: EmployeeSort
  page?: number
  pageSize?: number
}

export type ImportAction = 'CREATE' | 'UPDATE' | 'ERROR'
export type ImportResult = {
  applied: boolean
  dryRun: boolean
  summary: { total: number; created: number; updated: number; failed: number }
  rows: { row: number; employeeCode: string | null; action: ImportAction; errors: Record<string, string> }[]
}

const one = (id: string) => `/employees/${encodeURIComponent(id)}`

export const employeesApi = {
  list: (q: EmployeeQuery) => http<Paged<Employee>>(`/employees${query(q)}`),
  lookup: (search: string) => http<EmployeeLookup[]>(`/employees/lookup${query({ search: search.trim() })}`),
  get: (id: string) => http<EmployeeDetail>(one(id)),
  create: (body: EmployeeInput) => http<{ id: string }>('/employees', { method: 'POST', body }),
  update: (id: string, body: EmployeeInput) => http<void>(one(id), { method: 'PUT', body }),
  setActive: (id: string, active: boolean) => http<void>(`${one(id)}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' }),
  importTemplate: () => http<string>('/employees/import/template', { text: true }),
  importCsv: (csv: string, dryRun: boolean) => http<ImportResult>('/employees/import', { method: 'POST', body: { csv, dryRun } }),
}
