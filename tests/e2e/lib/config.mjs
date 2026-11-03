// Isolated E2E environment. Never point these at a shared server or the developer API (7180 / 5173).
export const WEB = process.env.E2E_WEB ?? 'http://127.0.0.1:5174'
export const API = process.env.E2E_API ?? 'https://localhost:7190'
export const DB_SERVER = '(localdb)\\MSSQLLocalDB'
export const DB_NAME = process.env.E2E_DB ?? 'OneInsureVideoMeetingDB_E2E'
export const EDGE = process.env.E2E_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
export const HEADLESS = process.env.E2E_HEADED !== '1'

if (!/_E2E$/.test(DB_NAME)) throw new Error('E2E tests only run against a database whose name ends in _E2E.')
if (/:7180|:5173/.test(WEB + API)) throw new Error('E2E tests must not use the developer API (7180) or web server (5173).')

// Test password used for every seeded account (meets the password policy; never used outside this local database).
export const PASSWORD = 'E2e!Strong#Pass2026'
export const NEW_PASSWORD = 'E2e!Changed#Pass2027'

export const USERS = {
  superadmin: { email: 'superadmin@e2e.oneinsure.test', code: 'E2E-0001', name: 'Sunita Rao', roles: ['SuperAdmin'] },
  admin: { email: 'arjun.admin@e2e.oneinsure.test', code: 'E2E-0002', name: 'Arjun Mehta', roles: ['Admin'] },
  priya: { email: 'priya.sharma@e2e.oneinsure.test', code: 'E2E-0003', name: 'Priya Sharma', roles: ['Employee'] },
  rahul: { email: 'rahul.verma@e2e.oneinsure.test', code: 'E2E-0004', name: 'Rahul Verma', roles: ['Employee'] },
  hr: { email: 'vikram.hr@e2e.oneinsure.test', code: 'E2E-0006', name: 'Vikram Shah', roles: ['HRMaster'] },
  nolink: { email: 'nolink.user@e2e.oneinsure.test', code: null, name: null, roles: ['Employee'] },
  noroles: { email: 'noroles.user@e2e.oneinsure.test', code: null, name: null, roles: [] },
  mfa: { email: 'kavya.mfa@e2e.oneinsure.test', code: 'E2E-0007', name: 'Kavya Nair', roles: ['Employee'] },
  lockme: { email: 'lock.me@e2e.oneinsure.test', code: 'E2E-0008', name: 'Lokesh Kumar', roles: ['Employee'] },
  reset: { email: 'reset.me@e2e.oneinsure.test', code: 'E2E-0009', name: 'Ritu Desai', roles: ['Employee'] },
}
