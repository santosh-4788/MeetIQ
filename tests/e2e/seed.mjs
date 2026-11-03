// Seeds the LOCAL E2E database through the isolated API (plus a few SQL fix-ups for states the API cannot create,
// such as meetings in the past). Idempotent enough to re-run on a fresh database only: recreate the database first.
import { pathToFileURL } from 'node:url'
import { ApiClient, signedIn } from './lib/api.mjs'
import { PASSWORD, USERS } from './lib/config.mjs'
import { exec, q, query, scalar } from './lib/db.mjs'

const log = (...a) => console.log('[seed]', ...a)

/** UTC ISO string for an IST wall-clock time `days` from today. */
export function ist(days, hh, mm = 0) {
  const now = new Date(Date.now() + 330 * 60_000) // shift to IST "wall clock"
  const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, hh, mm) - 330 * 60_000
  return new Date(d).toISOString()
}

async function main() {
  if (scalar('SELECT COUNT(*) AS n FROM org.Employees') > 0) {
    log('Employees already exist: the database was seeded before. Recreate it for a clean run (see README).')
    return
  }
  // After the database was dropped and recreated, the API's pooled connections are broken: the first calls fail and
  // clear the pool. Wait until the health check succeeds.
  for (let i = 0; i < 10; i++) {
    const h = await new ApiClient().get('/health').catch(() => ({ status: 0 }))
    if (h.status === 200) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  const sa = await signedIn(USERS.superadmin.email, PASSWORD)

  // ---- Organisation masters ----
  for (const d of [
    { code: 'OPS', name: 'Operations' },
    { code: 'SALES', name: 'Sales' },
    { code: 'HR', name: 'Human Resources' },
    { code: 'IT', name: 'Information Technology' },
    { code: 'EMPTY', name: 'Unused Department' },
  ])
    await sa.ok('POST', '/org/departments', d)
  for (const d of [
    { code: 'MGR', name: 'Manager', level: 3 },
    { code: 'TL', name: 'Team Lead', level: 2 },
    { code: 'EXEC', name: 'Executive', level: 1 },
  ])
    await sa.ok('POST', '/org/designations', d)
  for (const b of [
    { code: 'MUM', name: 'Mumbai HO', city: 'Mumbai', state: 'Maharashtra', timeZoneId: 'Asia/Kolkata' },
    { code: 'DEL', name: 'Delhi Branch', city: 'New Delhi', state: 'Delhi', timeZoneId: 'Asia/Kolkata' },
  ])
    await sa.ok('POST', '/org/branches', b)
  log('masters created')

  // ---- Employees ----
  const emp = {}
  const people = [
    ['superadmin', 'Sunita', 'Rao', 'IT', 'MGR', 'MUM'],
    ['admin', 'Arjun', 'Mehta', 'IT', 'MGR', 'MUM'],
    ['priya', 'Priya', 'Sharma', 'OPS', 'TL', 'MUM'],
    ['rahul', 'Rahul', 'Verma', 'OPS', 'EXEC', 'DEL'],
    ['meera', 'Meera', 'Iyer', 'OPS', 'EXEC', 'MUM', 'E2E-0005', 'meera.iyer@e2e.oneinsure.test'],
    ['hr', 'Vikram', 'Shah', 'HR', 'MGR', 'MUM'],
    ['mfa', 'Kavya', 'Nair', 'SALES', 'EXEC', 'DEL'],
    ['lockme', 'Lokesh', 'Kumar', 'SALES', 'EXEC', 'DEL'],
    ['reset', 'Ritu', 'Desai', 'SALES', 'EXEC', 'MUM'],
  ]
  for (const [key, first, last, dept, desig, branch, code, email] of people) {
    const u = USERS[key]
    const r = await sa.ok('POST', '/employees', {
      employeeCode: code ?? u.code, firstName: first, lastName: last, officialEmail: email ?? u.email,
      mobile: '98200' + String(10000 + Object.keys(emp).length).slice(-5), departmentCode: dept, designationCode: desig, branchCode: branch, dateOfJoining: '2024-04-01',
    })
    emp[key] = r.id
  }
  // Rahul reports to Priya (used by the reporting-loop test).
  const rahul = (await sa.ok('GET', `/employees/${emp.rahul}`)).employee
  await sa.ok('PUT', `/employees/${emp.rahul}`, {
    employeeCode: rahul.employeeCode, firstName: rahul.firstName, lastName: rahul.lastName, officialEmail: rahul.officialEmail, mobile: rahul.mobile,
    departmentCode: 'OPS', designationCode: 'EXEC', branchCode: 'DEL', reportingManagerId: emp.priya, dateOfJoining: '2024-04-01',
  })
  // The bootstrap SuperAdmin stays UNLINKED from its employee record (as after a real setup-admin): scenario 05 links it
  // through the UI (Employee detail → "Link existing account"); other scenarios call ensureSuperAdminLinked().
  log('employees created')

  // Bulk employees through the CSV import API (paging needs > 25 rows).
  const rows = ['EmployeeCode,FirstName,LastName,DisplayName,OfficialEmail,Mobile,DepartmentCode,DesignationCode,BranchCode,ReportingManagerCode,DateOfJoining']
  const firsts = ['Aarav', 'Diya', 'Ishaan', 'Ananya', 'Kabir', 'Saanvi', 'Vihaan', 'Aditi', 'Reyansh', 'Myra', 'Arnav', 'Kiara', 'Dhruv', 'Anika', 'Rohan', 'Tara', 'Yash', 'Nisha', 'Kunal', 'Pooja', 'Sameer', 'Lata']
  firsts.forEach((f, i) => {
    const n = String(1001 + i)
    rows.push(`E2E-${n},${f},Bulk${i + 1},,${f.toLowerCase()}.bulk${i + 1}@e2e.oneinsure.test,,${i % 2 ? 'SALES' : 'OPS'},EXEC,${i % 3 ? 'MUM' : 'DEL'},E2E-0003,2025-0${(i % 9) + 1}-15`)
  })
  const imp = await sa.ok('POST', '/employees/import', { csv: rows.join('\r\n'), dryRun: false })
  if (!imp.applied) throw new Error('bulk import failed: ' + JSON.stringify(imp.summary))
  log('bulk employees imported', imp.summary)

  // Team
  await sa.ok('POST', '/org/teams', { code: 'OPS-T1', name: 'Ops Squad One', departmentCode: 'OPS', teamLeaderId: emp.priya })
  await sa.ok('PUT', '/org/teams/OPS-T1/members', { employeeIds: [emp.priya, emp.rahul, emp.meera] })

  // ---- Users ----
  async function createUser(key, employeeId, email) {
    const u = USERS[key]
    const r = await sa.ok('POST', '/admin/users', { email: employeeId ? null : email ?? u.email, employeeId, roles: u.roles.length ? u.roles : ['Employee'] })
    const c = new ApiClient()
    await c.login(r.email, r.oneTimePassword)
    await c.ok('POST', '/auth/change-password', { currentPassword: r.oneTimePassword, newPassword: PASSWORD })
    return r.id
  }
  for (const key of ['admin', 'priya', 'rahul', 'hr', 'mfa', 'lockme', 'reset']) await createUser(key, emp[key])
  await createUser('nolink', null)
  await createUser('noroles', null)
  exec(`DELETE ur FROM auth.UserRoles ur JOIN auth.Users u ON u.UserId = ur.UserId WHERE u.Email = ${q(USERS.noroles.email)}`)
  log('users created')

  // ---- Customers ----
  const c1 = await sa.ok('POST', '/customers', { customerRef: 'CUST-E2E-001', fullName: 'Anil Kapoor', email: 'anil.kapoor@example.test', policyNumber: 'POL-778899', assignedEmployeeId: emp.priya })
  await sa.ok('POST', '/customers', { customerRef: 'CUST-E2E-002', fullName: 'Sneha Joshi', mobile: '9876543210', policyNumber: 'POL-112233' })
  log('customers created')

  // ---- Meetings ----
  const priya = await signedIn(USERS.priya.email, PASSWORD)
  const admin = await signedIn(USERS.admin.email, PASSWORD)
  const base = { timeZoneId: 'Asia/Kolkata', recordingPolicy: 'NONE', waitingRoomEnabled: true }
  const m1 = await priya.ok('POST', '/meetings', { ...base, title: 'E2E Weekly Ops Sync', agenda: 'Review the queue', category: 'GROUP', startUtc: ist(1, 10), endUtc: ist(1, 11), employeeIds: [emp.rahul, emp.meera] })
  await priya.ok('POST', '/meetings', { ...base, title: 'E2E Draft Planning', category: 'TEAM', startUtc: ist(2, 15), endUtc: ist(2, 16), employeeIds: [emp.rahul], status: 'DRAFT' })
  const m3 = await priya.ok('POST', '/meetings', { ...base, title: 'E2E Cancelled Review', category: 'REVIEW', startUtc: ist(3, 12), endUtc: ist(3, 13), employeeIds: [emp.rahul] })
  await priya.ok('POST', `/meetings/${m3.id}/cancel`, { reason: 'Seed: cancelled for testing' })
  const m4 = await priya.ok('POST', '/meetings', { ...base, title: 'E2E Past Retro', category: 'TEAM', startUtc: ist(5, 16), endUtc: ist(5, 17), employeeIds: [emp.rahul] })
  exec(`UPDATE mtg.Meetings SET ScheduledStartUtc = DATEADD(DAY, -7, ScheduledStartUtc), ScheduledEndUtc = DATEADD(DAY, -7, ScheduledEndUtc), [Status] = 'COMPLETED',
          ActualStartUtc = DATEADD(DAY, -7, ScheduledStartUtc), ActualEndUtc = DATEADD(DAY, -7, ScheduledEndUtc) WHERE PublicId = '${m4.id}';
        UPDATE mtg.MeetingReminders SET [Status] = 'CANCELLED' WHERE MeetingId = (SELECT MeetingId FROM mtg.Meetings WHERE PublicId = '${m4.id}')`)
  await priya.ok('POST', '/meetings', { ...base, title: 'E2E Customer Policy Verification', category: 'CUSTOMER_PLVC', startUtc: ist(2, 11), endUtc: ist(2, 11, 30), customerId: c1.id, purpose: 'Policy verification', recordingPolicy: 'OPTIONAL' })
  await admin.ok('POST', '/meetings', { ...base, title: 'E2E Admin Briefing', category: 'MANAGEMENT', startUtc: ist(1, 14), endUtc: ist(1, 15), employeeIds: [emp.priya] })
  log('meetings created')

  // ---- Availability: Rahul on leave on day +4 ----
  const rahulC = await signedIn(USERS.rahul.email, PASSWORD)
  await rahulC.ok('POST', '/account/availability', { type: 'LEAVE', startUtc: ist(4, 0), endUtc: ist(5, 0), reason: 'Family function' })
  log('availability created')

  console.log(JSON.stringify({ employees: emp, meeting: m1.id }, null, 2))
  log('done. Counts:', query('SELECT (SELECT COUNT(*) FROM org.Employees) AS employees, (SELECT COUNT(*) FROM auth.Users) AS users, (SELECT COUNT(*) FROM mtg.Meetings) AS meetings')[0])
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => (console.error(e), process.exit(1)))
