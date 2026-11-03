import { useEffect, useState, type FormEvent } from 'react'
import { employeesApi, type Employee, type EmployeeInput } from '../../api/employees'
import { fieldErrors } from '../../api/types'
import { EmployeePicker, type PickedEmployee } from '../../components/EmployeePicker'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Feedback'
import { TextField } from '../../components/ui/Field'
import { SelectField } from '../../components/ui/Form'
import { Dialog } from '../../components/ui/Overlay'
import { toYmd } from '../../lib/format'
import { selectable, type Masters } from './useMasters'

type Form = {
  employeeCode: string
  firstName: string
  lastName: string
  displayName: string
  officialEmail: string
  mobile: string
  departmentCode: string
  designationCode: string
  branchCode: string
  dateOfJoining: string
}

const empty: Form = {
  employeeCode: '', firstName: '', lastName: '', displayName: '', officialEmail: '', mobile: '',
  departmentCode: '', designationCode: '', branchCode: '', dateOfJoining: '',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function toForm(e: Employee): Form {
  return {
    employeeCode: e.employeeCode,
    firstName: e.firstName ?? '',
    lastName: e.lastName ?? '',
    displayName: e.displayName ?? '',
    officialEmail: e.officialEmail ?? '',
    mobile: e.mobile ?? '',
    departmentCode: e.departmentCode ?? '',
    designationCode: e.designationCode ?? '',
    branchCode: e.branchCode ?? '',
    dateOfJoining: toYmd(e.dateOfJoining),
  }
}

/** Add / edit drawer. `employee` null = closed, 'new' = add. The employee code is editable only when adding. */
export function EmployeeFormDrawer({ employee, masters, onClose }: { employee: Employee | 'new' | null; masters: Masters | null; onClose: (savedId?: string) => void }) {
  const editing = employee && employee !== 'new' ? employee : null
  const [form, setForm] = useState<Form>(empty)
  const [manager, setManager] = useState<PickedEmployee | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!employee) return
    setForm(editing ? toForm(editing) : empty)
    setManager(editing?.reportingManagerId ? { id: editing.reportingManagerId, displayName: editing.reportingManagerName ?? 'Reporting manager' } : null)
    setErrors({})
    setError(null)
  }, [employee, editing])

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setErrors((x) => ({ ...x, [k]: '' }))
  }

  function validate() {
    const v: Record<string, string> = {}
    if (!form.employeeCode.trim()) v.employeeCode = 'Employee code is required.'
    if (!form.firstName.trim()) v.firstName = 'First name is required.'
    if (!form.officialEmail.trim()) v.officialEmail = 'Official e-mail is required.'
    else if (!EMAIL_RE.test(form.officialEmail.trim())) v.officialEmail = 'Enter a valid official e-mail.'
    if (form.mobile.trim() && !/^\+?\d{7,15}$/.test(form.mobile.trim())) v.mobile = 'Enter a valid mobile number (digits, optional leading +).'
    if (!form.departmentCode) v.departmentCode = 'Choose a department.'
    if (!form.designationCode) v.designationCode = 'Choose a designation.'
    return v
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = validate()
    setErrors(v)
    if (Object.keys(v).length) return
    const opt = (s: string) => s.trim() || null
    const body: EmployeeInput = {
      employeeCode: form.employeeCode.trim(),
      firstName: form.firstName.trim(),
      lastName: opt(form.lastName),
      displayName: opt(form.displayName),
      officialEmail: form.officialEmail.trim(),
      mobile: opt(form.mobile),
      departmentCode: form.departmentCode,
      designationCode: form.designationCode,
      branchCode: opt(form.branchCode),
      reportingManagerId: manager?.id ?? null,
      dateOfJoining: opt(form.dateOfJoining),
    }
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        await employeesApi.update(editing.id, body)
        onClose(editing.id)
      } else {
        onClose((await employeesApi.create(body)).id)
      }
    } catch (err) {
      const fe = fieldErrors(err)
      setErrors(fe)
      setError(err instanceof Error ? err.message : 'The employee could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const m = masters ?? { departments: [], designations: [], branches: [] }

  return (
    <Dialog
      open={!!employee}
      onClose={() => onClose()}
      variant="drawer"
      title={editing ? 'Edit employee' : 'Add employee'}
      description={editing ? `${editing.displayName} · ${editing.employeeCode}` : 'New entry in the employee master.'}
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose()} disabled={busy}>Cancel</Button>
          <Button type="submit" form="employee-form" loading={busy}>{editing ? 'Save changes' : 'Add employee'}</Button>
        </>
      }
    >
      <form id="employee-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!masters && <Alert tone="warning">Departments, designations and branches could not be loaded. Close this panel and try again.</Alert>}
        <TextField
          label="Employee code"
          value={form.employeeCode}
          onChange={(e) => set('employeeCode')({ target: { value: e.target.value.toUpperCase() } })}
          error={errors.employeeCode}
          disabled={!!editing}
          hint={editing ? 'The employee code cannot be changed.' : 'Letters, digits, - _ /. Cannot be changed later.'}
          autoComplete="off"
          data-autofocus={!editing || undefined}
          maxLength={20}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="First name" value={form.firstName} onChange={set('firstName')} error={errors.firstName} autoComplete="off" data-autofocus={editing ? true : undefined} />
          <TextField label="Last name (optional)" value={form.lastName} onChange={set('lastName')} error={errors.lastName} autoComplete="off" />
        </div>
        <TextField label="Display name (optional)" value={form.displayName} onChange={set('displayName')} error={errors.displayName} hint="Defaults to first and last name." autoComplete="off" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Official e-mail" type="email" value={form.officialEmail} onChange={set('officialEmail')} error={errors.officialEmail} autoComplete="off" placeholder="name@oneinsure.com" />
          <TextField label="Mobile (optional)" type="tel" value={form.mobile} onChange={set('mobile')} error={errors.mobile} autoComplete="off" placeholder="+919876543210" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Department" value={form.departmentCode} onChange={set('departmentCode')} error={errors.departmentCode}>
            <option value="">Select department</option>
            {selectable(m.departments, editing?.departmentCode).map((d) => (
              <option key={d.code} value={d.code}>{d.name}{d.isActive ? '' : ' (inactive)'}</option>
            ))}
          </SelectField>
          <SelectField label="Designation" value={form.designationCode} onChange={set('designationCode')} error={errors.designationCode}>
            <option value="">Select designation</option>
            {selectable(m.designations, editing?.designationCode).map((d) => (
              <option key={d.code} value={d.code}>{d.name}{d.isActive ? '' : ' (inactive)'}</option>
            ))}
          </SelectField>
          <SelectField label="Branch (optional)" value={form.branchCode} onChange={set('branchCode')} error={errors.branchCode}>
            <option value="">No branch</option>
            {selectable(m.branches, editing?.branchCode).map((b) => (
              <option key={b.code} value={b.code}>{b.name}{b.city ? `, ${b.city}` : ''}{b.isActive ? '' : ' (inactive)'}</option>
            ))}
          </SelectField>
          <TextField label="Date of joining (optional)" type="date" value={form.dateOfJoining} onChange={set('dateOfJoining')} error={errors.dateOfJoining} />
        </div>
        <EmployeePicker
          label="Reporting manager (optional)"
          value={manager}
          onChange={(p) => (setManager(p), setErrors((x) => ({ ...x, reportingManagerId: '' })))}
          excludeIds={editing ? [editing.id] : []}
          error={errors.reportingManagerId || undefined}
        />
      </form>
    </Dialog>
  )
}
