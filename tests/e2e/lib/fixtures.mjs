// Small state helpers shared by scenarios (so each scenario can also run on its own).
import { signedIn } from './api.mjs'
import { PASSWORD, USERS } from './config.mjs'
import { q, scalar } from './db.mjs'

/** Links the bootstrap SuperAdmin to employee E2E-0001 through the API if scenario 05 has not done it through the UI. */
export async function ensureSuperAdminLinked() {
  if (scalar(`SELECT COUNT(*) AS n FROM auth.Users WHERE Email = ${q(USERS.superadmin.email)} AND EmployeeId IS NOT NULL`)) return
  const sa = await signedIn(USERS.superadmin.email, PASSWORD)
  const userId = scalar(`SELECT PublicId AS id FROM auth.Users WHERE Email = ${q(USERS.superadmin.email)}`)
  const empId = scalar(`SELECT PublicId AS id FROM org.Employees WHERE EmployeeCode = ${q(USERS.superadmin.code)}`)
  await sa.ok('PUT', `/admin/users/${userId}/employee`, { employeeId: empId })
}
