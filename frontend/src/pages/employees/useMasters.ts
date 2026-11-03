import { orgApi, type Branch, type Department, type Designation } from '../../api/org'
import { useLoader } from '../../lib/useLoader'

export type Masters = { departments: Department[]; designations: Designation[]; branches: Branch[] }

/** Departments, designations and branches (inactive included, so existing assignments still resolve) for filters and forms. */
export function useMasters() {
  return useLoader<Masters>(
    async () => {
      const [departments, designations, branches] = await Promise.all([
        orgApi.list('departments', true),
        orgApi.list('designations', true),
        orgApi.list('branches', true),
      ])
      return { departments, designations, branches }
    },
    [],
    'Unable to load departments, designations and branches.',
  )
}

/** Active options, plus the currently selected one even if it has since been deactivated. */
export function selectable<T extends { code: string; isActive: boolean }>(items: T[], current?: string | null) {
  return items.filter((i) => i.isActive || i.code === current)
}
