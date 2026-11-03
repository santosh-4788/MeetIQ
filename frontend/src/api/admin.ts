import { http } from './http'
import { query, type Paged } from './types'

// Users & roles: /api/v1/admin (users.manage; permission matrix edits need roles.manage).

export type AdminUser = {
  id: string
  email: string
  displayName: string
  employeeCode: string | null
  employeeId: string | null
  department: string | null
  roles: string[]
  isActive: boolean
  isLocked: boolean
  mfaEnabled: boolean
  mustChangePassword: boolean
  lastLoginUtc: string | null
}

export type UserStatus = 'active' | 'inactive' | 'locked' | 'all'
export type Role = { code: string; name: string; description: string | null; isSystem: boolean; userCount: number; permissions: string[] }
export type Permission = { code: string; module: string; description: string | null }
/** The one-time password is shown once and never stored. */
export type CreatedUser = { id: string; email: string; oneTimePassword: string }

const user = (id: string) => `/admin/users/${encodeURIComponent(id)}`

export const adminApi = {
  users: (q: { search?: string; status?: UserStatus; page?: number; pageSize?: number }) => http<Paged<AdminUser>>(`/admin/users${query(q)}`),
  createUser: (body: { email?: string; employeeId?: string; roles: string[] }) => http<CreatedUser>('/admin/users', { method: 'POST', body }),
  setRoles: (id: string, roles: string[]) => http<void>(`${user(id)}/roles`, { method: 'PUT', body: { roles } }),
  resetPassword: (id: string) => http<{ oneTimePassword: string }>(`${user(id)}/reset-password`, { method: 'POST' }),
  unlock: (id: string) => http<void>(`${user(id)}/unlock`, { method: 'POST' }),
  resetMfa: (id: string) => http<void>(`${user(id)}/reset-mfa`, { method: 'POST' }),
  setActive: (id: string, active: boolean) => http<void>(`${user(id)}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' }),
  /** Links the account to an employee record, changes the link, or removes it (null). */
  linkEmployee: (id: string, employeeId: string | null) => http<void>(`${user(id)}/employee`, { method: 'PUT', body: { employeeId } }),
  roles: () => http<Role[]>('/admin/roles'),
  permissions: () => http<Permission[]>('/admin/permissions'),
  setRolePermissions: (code: string, permissions: string[]) =>
    http<void>(`/admin/roles/${encodeURIComponent(code)}/permissions`, { method: 'PUT', body: { permissions } }),
}
