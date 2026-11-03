import { useEffect, useState, type FormEvent } from 'react'
import { customersApi, type Customer, type CustomerInput } from '../../api/customers'
import { errorMessage, fieldErrors } from '../../api/types'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Button } from '../../components/ui/Button'
import { Alert, ErrorState, Skeleton } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { TextAreaField } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'

type Form = { customerRef: string; fullName: string; email: string; mobile: string; policyNumber: string; referenceNumber: string; notes: string }
const empty: Form = { customerRef: '', fullName: '', email: '', mobile: '', policyNumber: '', referenceNumber: '', notes: '' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export type SavedCustomer = { id: string; fullName: string; customerRef: string }

/**
 * Add / edit a customer. `customerId` undefined = closed, null = add, id = edit (the full, unmasked record is loaded).
 * Used on the Customers tab and inline from the Schedule Meeting form.
 */
export function CustomerDialog({ customerId, onClose }: { customerId: string | null | undefined; onClose: (saved?: SavedCustomer) => void }) {
  const open = customerId !== undefined
  const editing = !!customerId
  const [form, setForm] = useState<Form>(empty)
  const [assigned, setAssigned] = useState<PickedEmployee | null>(null)
  const [loaded, setLoaded] = useState<Customer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setError(null)
    setLoadError(null)
    setLoaded(null)
    if (!customerId) {
      setForm(empty)
      setAssigned(null)
      return
    }
    let alive = true
    customersApi
      .get(customerId)
      .then((c) => {
        if (!alive) return
        setLoaded(c)
        setForm({
          customerRef: c.customerRef,
          fullName: c.fullName,
          email: c.email ?? '',
          mobile: c.mobile ?? '',
          policyNumber: c.policyNumber ?? '',
          referenceNumber: c.referenceNumber ?? '',
          notes: c.notes ?? '',
        })
        setAssigned(c.assignedEmployeeId ? { id: c.assignedEmployeeId, displayName: c.assignedEmployeeName ?? 'Assigned employee' } : null)
      })
      .catch((e: unknown) => alive && setLoadError(errorMessage(e, 'Unable to load the customer.')))
    return () => {
      alive = false
    }
  }, [open, customerId, attempt])

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  function validate() {
    const v: Record<string, string> = {}
    if (!form.customerRef.trim()) v.customerRef = 'Customer reference is required.'
    else if (!/^[A-Z0-9][A-Z0-9_/-]{0,49}$/.test(form.customerRef.trim())) v.customerRef = "Use letters, digits, '-', '_' and '/' only."
    if (!form.fullName.trim()) v.fullName = 'Full name is required.'
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) v.email = 'Enter a valid e-mail address.'
    if (form.mobile.trim() && !/^\+?\d{7,15}$/.test(form.mobile.trim())) v.mobile = 'Enter a valid mobile number (digits, optional leading +).'
    if (!form.email.trim() && !form.mobile.trim()) v.email = 'Enter an e-mail address or a mobile number.'
    return v
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = validate()
    setErrors(v)
    if (Object.keys(v).length) return
    const opt = (s: string) => s.trim() || null
    const body: CustomerInput = {
      customerRef: form.customerRef.trim().toUpperCase(),
      fullName: form.fullName.trim(),
      email: opt(form.email),
      mobile: opt(form.mobile),
      policyNumber: opt(form.policyNumber),
      referenceNumber: opt(form.referenceNumber),
      assignedEmployeeId: assigned?.id ?? null,
      notes: opt(form.notes),
    }
    setBusy(true)
    setError(null)
    try {
      const id = customerId ? (await customersApi.update(customerId, body), customerId) : (await customersApi.create(body)).id
      onClose({ id, fullName: body.fullName, customerRef: body.customerRef })
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err, 'The customer could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => onClose()}
      title={editing ? 'Edit customer' : 'Add customer'}
      description={editing ? loaded ? `${loaded.fullName} · ${loaded.customerRef}` : 'Loading…' : 'Customers join meetings through a personal, expiring link. They have no login.'}
      size="lg"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose()} disabled={busy}>Cancel</Button>
          <Button type="submit" form="customer-form" loading={busy} disabled={editing && !loaded}>{editing ? 'Save changes' : 'Add customer'}</Button>
        </>
      }
    >
      {loadError ? (
        <ErrorState title="Unable to load the customer" description={loadError} onRetry={() => setAttempt((a) => a + 1)} />
      ) : editing && !loaded ? (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading customer">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      ) : (
        <form id="customer-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Customer reference"
              value={form.customerRef}
              onChange={(e) => set('customerRef')({ target: { value: e.target.value.toUpperCase() } })}
              error={errors.customerRef}
              hint="Unique. Letters, digits, - _ /"
              maxLength={50}
              autoComplete="off"
              data-autofocus
            />
            <TextField label="Full name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} maxLength={200} autoComplete="off" />
            <TextField label="E-mail" type="email" value={form.email} onChange={set('email')} error={errors.email} autoComplete="off" hint="Needed for the meeting invitation link." />
            <TextField label="Mobile" type="tel" value={form.mobile} onChange={set('mobile')} error={errors.mobile} autoComplete="off" placeholder="+919876543210" hint="E-mail or mobile is required." />
            <TextField label="Policy number (optional)" value={form.policyNumber} onChange={set('policyNumber')} error={errors.policyNumber} maxLength={50} autoComplete="off" />
            <TextField label="Reference number (optional)" value={form.referenceNumber} onChange={set('referenceNumber')} error={errors.referenceNumber} maxLength={50} autoComplete="off" />
          </div>
          <EmployeePicker label="Assigned employee (optional)" value={assigned} onChange={(p) => (setAssigned(p), setErrors((x) => ({ ...x, assignedEmployeeId: '' })))} error={errors.assignedEmployeeId || undefined} />
          <TextAreaField label="Notes (optional)" value={form.notes} onChange={set('notes')} error={errors.notes} maxLength={1000} rows={3} />
        </form>
      )}
    </Dialog>
  )
}
