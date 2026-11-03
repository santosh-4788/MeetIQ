import { useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle, Search, X } from 'lucide-react'
import { employeesApi, type EmployeeLookup } from '../api/employees'
import { useDebounced } from '../lib/useLoader'
import { cn } from '../lib/cn'
import { Avatar } from './ui/Avatar'

export type PickedEmployee = { id: string; displayName: string; employeeCode?: string }

/**
 * Employee search (combobox) over GET /employees/lookup: top 20 active employees by name or code.
 * With `value` it shows the selection as a removable chip; with `clearOnSelect` it is an "add" box (team members).
 */
export function EmployeePicker({
  label,
  value,
  onChange,
  excludeIds = [],
  error,
  hint,
  placeholder = 'Search by name or employee code',
  clearOnSelect,
  disabled,
}: {
  label: string
  value?: PickedEmployee | null
  onChange: (e: PickedEmployee | null, full?: EmployeeLookup) => void
  excludeIds?: string[]
  error?: string
  hint?: string
  placeholder?: string
  clearOnSelect?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const listId = `${id}-list`
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<EmployeeLookup[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const term = useDebounced(q, 250)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setLoadError(null)
    employeesApi
      .lookup(term)
      .then((r) => alive && (setItems(r), setActive(0)))
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : 'Search failed.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [term, open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const shown = items.filter((i) => !excludeIds.includes(i.id))

  const pick = (e: EmployeeLookup) => {
    onChange({ id: e.id, displayName: e.displayName, employeeCode: e.employeeCode }, e)
    setQ('')
    setOpen(false)
    if (clearOnSelect) input.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && open && shown[active]) {
      e.preventDefault()
      pick(shown[active])
    } else if (e.key === 'Escape' && open) {
      // Close the list without closing a surrounding dialog.
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      setOpen(false)
    }
  }

  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div ref={box} className="relative flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      {value && !clearOnSelect ? (
        <div className={cn('flex h-11 items-center gap-2.5 rounded-sm border bg-surface pr-1.5 pl-2.5', error ? 'border-danger/70' : 'border-line')}>
          <Avatar name={value.displayName} size={26} />
          <span className="min-w-0 flex-1 truncate text-sm text-ink">
            {value.displayName}
            {value.employeeCode && <span className="ml-1.5 text-[12px] text-ink-secondary">{value.employeeCode}</span>}
          </span>
          <button
            id={id}
            type="button"
            disabled={disabled}
            onClick={() => {
              onChange(null)
              window.setTimeout(() => input.current?.focus(), 0)
            }}
            aria-label={`Remove ${value.displayName}`}
            className="flex size-8 items-center justify-center rounded-sm text-ink-muted hover:bg-navy-900/5 hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <div
          className={cn(
            'group flex h-11 items-center rounded-sm border bg-surface transition-[border-color,box-shadow] duration-150',
            error ? 'border-danger/70' : 'border-line hover:border-line-strong focus-within:border-brand-500 focus-within:shadow-focus',
          )}
        >
          <Search className="ml-3 size-4 shrink-0 text-ink-muted group-focus-within:text-brand-500" aria-hidden />
          <input
            ref={input}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && shown[active] ? `${listId}-${shown[active].id}` : undefined}
            aria-invalid={!!error || undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            disabled={disabled}
            value={q}
            placeholder={placeholder}
            onChange={(e) => (setQ(e.target.value), setOpen(true))}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            className="h-full w-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-muted [&:focus-visible]:shadow-none"
          />
          {loading && <LoaderCircle className="mr-3 size-4 animate-spin text-ink-muted" aria-hidden />}
        </div>
      )}
      {open && (
        <ul id={listId} role="listbox" aria-label={`${label} results`} className="scrollbar-thin absolute top-full right-0 left-0 z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-overlay">
          {loadError ? (
            <li className="flex items-center gap-2 px-3 py-3 text-[13px] text-danger">
              <CircleAlert className="size-4 shrink-0" /> {loadError}
            </li>
          ) : !loading && shown.length === 0 ? (
            <li className="px-3 py-3 text-center text-[13px] text-ink-secondary">No matching active employees</li>
          ) : (
            shown.map((e, i) => (
              <li
                key={e.id}
                id={`${listId}-${e.id}`}
                role="option"
                aria-selected={i === active}
                onPointerDown={(ev) => ev.preventDefault()}
                onClick={() => pick(e)}
                onPointerEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2', i === active && 'bg-canvas')}
              >
                <Avatar name={e.displayName} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{e.displayName}</span>
                  <span className="block truncate text-[11.5px] text-ink-secondary">
                    {e.employeeCode} · {e.designation} · {e.department}
                  </span>
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
