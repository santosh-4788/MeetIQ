import { useEffect, useId, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle, Search, UserPlus, X } from 'lucide-react'
import { customersApi, type CustomerListItem } from '../../api/customers'
import { Avatar } from '../../components/ui/Avatar'
import { cn } from '../../lib/cn'
import { useDebounced } from '../../lib/useLoader'

export type PickedCustomer = { id: string; fullName: string; customerRef: string; policyNumber?: string | null }

/** Customer search (combobox) over GET /customers, same look and keyboard behaviour as EmployeePicker, plus "Add new customer". */
export function CustomerPicker({
  label,
  value,
  onChange,
  onAddNew,
  error,
  hint,
}: {
  label: string
  value: PickedCustomer | null
  onChange: (c: PickedCustomer | null) => void
  onAddNew: () => void
  error?: string
  hint?: string
}) {
  const id = useId()
  const listId = `${id}-list`
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<CustomerListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const term = useDebounced(q.trim(), 250)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setLoadError(null)
    customersApi
      .list({ search: term, pageSize: 10 })
      .then((r) => alive && (setItems(r.items), setActive(0)))
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

  const pick = (c: CustomerListItem) => {
    onChange({ id: c.id, fullName: c.fullName, customerRef: c.customerRef, policyNumber: c.policyNumber })
    setQ('')
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && open && items[active]) {
      e.preventDefault()
      pick(items[active])
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      setOpen(false)
    }
  }

  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div ref={box} className="relative flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-semibold text-ink">
          {label}
        </label>
        <button type="button" onClick={onAddNew} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline">
          <UserPlus className="size-3.5" aria-hidden /> Add new customer
        </button>
      </div>
      {value ? (
        <div className={cn('flex h-11 items-center gap-2.5 rounded-sm border bg-surface pr-1.5 pl-2.5', error ? 'border-danger/70' : 'border-line')}>
          <Avatar name={value.fullName} size={26} />
          <span className="min-w-0 flex-1 truncate text-sm text-ink">
            {value.fullName}
            <span className="ml-1.5 text-[12px] text-ink-secondary">{value.customerRef}</span>
          </span>
          <button
            id={id}
            type="button"
            onClick={() => {
              onChange(null)
              window.setTimeout(() => input.current?.focus(), 0)
            }}
            aria-label={`Remove ${value.fullName}`}
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
            aria-activedescendant={open && items[active] ? `${listId}-${items[active].id}` : undefined}
            aria-invalid={!!error || undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            value={q}
            placeholder="Search name, reference or policy number"
            onChange={(e) => (setQ(e.target.value), setOpen(true))}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            className="h-full w-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-muted [&:focus-visible]:shadow-none"
          />
          {loading && <LoaderCircle className="mr-3 size-4 animate-spin text-ink-muted" aria-hidden />}
        </div>
      )}
      {open && !value && (
        <ul id={listId} role="listbox" aria-label={`${label} results`} className="scrollbar-thin absolute top-[72px] right-0 left-0 z-10 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-overlay">
          {loadError ? (
            <li className="flex items-center gap-2 px-3 py-3 text-[13px] text-danger">
              <CircleAlert className="size-4 shrink-0" /> {loadError}
            </li>
          ) : !loading && items.length === 0 ? (
            <li className="px-3 py-3 text-center text-[13px] text-ink-secondary">No matching customers. Use “Add new customer”.</li>
          ) : (
            items.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${c.id}`}
                role="option"
                aria-selected={i === active}
                onPointerDown={(ev) => ev.preventDefault()}
                onClick={() => pick(c)}
                onPointerEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2', i === active && 'bg-canvas')}
              >
                <Avatar name={c.fullName} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{c.fullName}</span>
                  <span className="block truncate text-[11.5px] text-ink-secondary">
                    {c.customerRef}
                    {c.policyNumber && ` · Policy ${c.policyNumber}`}
                    {c.email && ` · ${c.email}`}
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
