import { http } from './http'
import { query, type Paged } from './types'

// Customers (meeting participants without a login): /api/v1/customers (customer.meetings.view). Addressed by `id`.

/** List row: e-mail and mobile arrive masked. */
export type CustomerListItem = {
  id: string
  customerRef: string
  fullName: string
  email: string | null
  mobile: string | null
  policyNumber: string | null
  referenceNumber: string | null
  assignedEmployeeId: string | null
  assignedEmployeeName: string | null
  isActive: boolean
}

/** Full record: unmasked contact details, notes and the number of meetings. */
export type Customer = CustomerListItem & { notes: string | null; meetingCount: number }

export type CustomerInput = {
  customerRef: string
  fullName: string
  email?: string | null
  mobile?: string | null
  policyNumber?: string | null
  referenceNumber?: string | null
  assignedEmployeeId?: string | null
  notes?: string | null
}

export type CustomerQuery = { search?: string; assignedToMe?: boolean; includeInactive?: boolean; page?: number; pageSize?: number }

const one = (id: string) => `/customers/${encodeURIComponent(id)}`

export const customersApi = {
  list: (q: CustomerQuery) => http<Paged<CustomerListItem>>(`/customers${query({ ...q, assignedToMe: q.assignedToMe || undefined, includeInactive: q.includeInactive || undefined })}`),
  get: (id: string) => http<Customer>(one(id)),
  create: (body: CustomerInput) => http<{ id: string }>('/customers', { method: 'POST', body }),
  /** Full replace. */
  update: (id: string, body: CustomerInput) => http<void>(one(id), { method: 'PUT', body }),
}
